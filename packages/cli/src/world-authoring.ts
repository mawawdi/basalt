import { z } from "zod";
import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";
import { readBoundedWorkspaceBytes, writeCanonicalWorkspaceJson } from "@basalt/artifact-store";
import { contentHash, stableJson, dequantizeQ32_32 } from "@basalt/contracts";
import { CATALOG_AUTHORITY_COMMIT_SCHEMA } from "@basalt/catalog-authoring";
import { CATALOG_MEASUREMENT_SET_SCHEMA, resolveCatalogRequirements } from "@basalt/catalog-model";
import { type SemanticModule } from "@basalt/semantic-kernel";
import {
  REGION_AUTHORING_PROFILE_SCHEMA,
  REGION_DRAFT_SCHEMA,
  SPATIAL_WORLD_PLAN_SCHEMA,
  realizeRegionDraft,
  regionPlanningContext,
  sealSpatialWorldPlan,
  type RegionAuthoringProfile,
  type SpatialWorldPlan,
} from "@basalt/world-planning";
import {
  compileBasaltWorld,
  WORLD_BUILD_SCHEMA,
  worldBuildDiagnostics,
  type WorldBuild,
} from "@basalt/world-compiler";
import {
  createLocalRefinementCompiler,
  observeWorldBuild,
  runBoundedRefinement,
  sealRefinementPolicy,
  sealWorldChangeProposal,
  type RefinementPolicy,
  type WorldChange,
} from "@basalt/world-refinement";
import {
  regionEditResponseSchema,
  regionEditContext,
  regionEditEffect,
  regionPopulationEvidence,
  regionPlantingAssessment,
  regionLandscapeEvidence,
} from "./region-feedback.js";
export {
  regionEditResponseSchema,
  regionEditEffect,
  regionPopulationEvidence,
  regionPlantingAssessment,
  regionLandscapeEvidence,
} from "./region-feedback.js";
import { prepareWorldPlacementGeometry } from "./world-placement-geometry.js";
import {
  createOpenRouterPlanner,
  WorldPlannerResponseError,
  type WorldPlanner,
} from "./world-planner.js";

const MAX_BYTES = 128 * 1024 * 1024;
const read = async (root: string, path: string) =>
  JSON.parse(
    Buffer.from(await readBoundedWorkspaceBytes(root, path, MAX_BYTES)).toString("utf8"),
  ) as unknown;
const write = (root: string, path: string, value: unknown) =>
  writeCanonicalWorkspaceJson(root, path, value, { maxBytes: MAX_BYTES });
const execute = promisify(execFile);

export async function loadWorldAuthority(
  root: string,
  catalogPath: string,
  semanticModule: SemanticModule,
) {
  const catalog = CATALOG_AUTHORITY_COMMIT_SCHEMA.parse(await read(root, catalogPath));
  const retained = catalog.retainedEvidence.find(
    (e) => e.kind === "CatalogMeasurementSet" && e.artifactHash === catalog.measurementSetHash,
  );
  if (!retained) throw new Error("Catalog does not retain its measurement set");
  const measurements = CATALOG_MEASUREMENT_SET_SCHEMA.parse(
    await read(root, retained.relativePath),
  );
  if (measurements.hash !== catalog.measurementSetHash)
    throw new Error("Catalog measurement hash mismatch");
  return { catalog, measurements, semanticModule };
}
type Authority = Awaited<ReturnType<typeof loadWorldAuthority>>;

export function prepareRegionAuthoringProfile(
  plan: SpatialWorldPlan,
  authority: Authority,
): RegionAuthoringProfile {
  if (
    plan.regions.length !== 1 ||
    plan.terrainPlans.length !== 1 ||
    !plan.routes[0] ||
    !plan.routeJunctions[0]
  )
    throw new Error(
      "Profile preparation requires one terrain region with a route and junction template",
    );
  const resolution = resolveCatalogRequirements({
    semanticModule: authority.semanticModule,
    snapshot: authority.catalog.snapshot,
    requirements: plan.catalogRequirements,
  });
  if (resolution.status !== "eligible")
    throw new Error("Profile requirements do not resolve against the current catalog");
  const palette = plan.catalogRequirements.map((requirement) => {
    const binding = resolution.bindings.find((b) => b.requirementId === requirement.requirementId)!;
    const entry = authority.catalog.snapshot.entries.find((e) => e.handle === binding.entryHandle)!;
    if (entry.kind !== "substitution_set")
      throw new Error("Outdoor authoring currently requires measured substitution entries");
    const assets = entry.memberAssets.map((m) =>
      authority.measurements.assets.find((a) => a.hash === m.assetHash)!,
    );
    if (assets.some((a) => !a)) throw new Error("Profile asset is missing measurement evidence");
    const point = (side: "min" | "max") => ({
      x: Math[side](...assets.map((a) => dequantizeQ32_32(a.bounds[side].x))),
      y: Math[side](...assets.map((a) => dequantizeQ32_32(a.bounds[side].y))),
      z: Math[side](...assets.map((a) => dequantizeQ32_32(a.bounds[side].z))),
    });
    return {
      requirementId: requirement.requirementId,
      description: entry.handle.replaceAll("_", " "),
      boundsMeters: { min: point("min"), max: point("max") },
    };
  });
  const { kind: _kind, coordinateSystem: _coordinates, planHash: _hash, ...body } = plan;
  const basePlan = sealSpatialWorldPlan({
    ...body,
    planId: "EmptyRegion",
    seed: 1,
    realizationIntents: [],
    routes: [],
    routeJunctions: [],
    constructionPrograms: [],
    structuralPrograms: [],
    lotPolicies: [],
    cameras: [],
    terrainPlans: plan.terrainPlans.map((t) => ({ ...t, operations: [] })),
  });
  return REGION_AUTHORING_PROFILE_SCHEMA.parse({
    profileId: "OutdoorRegion",
    catalogSnapshotHash: authority.catalog.snapshot.hash,
    basePlan,
    routeTemplate: plan.routes[0],
    junctionTemplate: plan.routeJunctions[0],
    placementToleranceMeters: 3,
    palette,
    allowedTerrainMaterialIds: ["Grass", "Ground", "LeafyGrass", "Mud"],
  });
}

const visualCriterion = z
  .object({ verdict: z.enum(["pass", "fail", "uncertain"]), note: z.string().min(1).max(1024) })
  .strict();
const visualResponse = z
  .object({
    checks: z
      .object({
        instruction_following: visualCriterion,
        composition: visualCriterion,
        grounding: visualCriterion,
        access: visualCriterion,
      })
      .strict(),
    repairs: z.array(z.string().min(1).max(512)).max(8),
  })
  .strict();

export function regionEditPolicy(plan: SpatialWorldPlan): RefinementPolicy {
  return sealRefinementPolicy({
    maximumIterations: 1,
    constructionParameters: [],
    routeAlternatives: [],
    protectedTaskHashes: [],
    requiredCheckKinds: ["occupancy_clearance"],
    protectedIntentIds: plan.realizationIntents
      .filter((i) => !(i.kind === "surface_scatter" && i.vegetation))
      .map((i) => i.intentId),
    vegetation: plan.realizationIntents.flatMap((i) =>
      i.kind === "surface_scatter" && i.vegetation
        ? [
            {
              intentId: i.intentId,
              minimumDensity: Math.max(0.001, i.vegetation.candidateDensityPerSquareMeter / 4),
              maximumDensity: Math.min(4, i.vegetation.candidateDensityPerSquareMeter * 2),
              maximumCount: Math.min(4096, i.targetCount * 2),
              clearingBounds: plan.boundsMeters,
            },
          ]
        : [],
    ),
    terrainPaint: plan.terrainPlans.flatMap((t) =>
      t.operations.flatMap((o, index) =>
        o.kind === "paint"
          ? [
              {
                terrainPlanId: t.terrainPlanId,
                operationIndex: index,
                allowedMaterialIds: ["Grass", "Ground", "LeafyGrass", "Mud"],
                bounds: plan.boundsMeters,
              },
            ]
          : [],
      ),
    ),
  });
}

const PLANNING_RULES = `You propose a bounded outdoor region for a deterministic world compiler. Return only the requested JSON. Never write code or invent assets. Use only the prepared requirement IDs and measured sizes. Match the user's prompt; list unsupported requests in unmetRequirements rather than substituting a different scene. The profile bounds fix the supported region extent. X/Z are ground coordinates in meters, Y is vertical, north is +Z. Compose destinations, clear entrances and a connected path network before planting. Declare shared routeNodes and connect routes using startNodeId/endNodeId; waypoints are interior bend controls only. A loop uses two routes between the same two nodes. All routes must form one connected graph. Leave at least twice the bend radius between neighboring bend controls and avoid shallow forks. Keep buildings and wide tree roots on ample flat footing. Single placements may move within the profile's explicit placementToleranceMeters to resolve collisions; grids remain exact. footingElevationMeters creates a measured rectangular pad covering that tolerance; use null for assets that can follow the ground. Grids rotate around their first cell; yaw is 0..359 and rotates both the grid offsets and each object. Positive yaw turns the local +X direction toward world -Z. Keep routes outside building footprints. Place fences as ordinary catalog objects only when their measured joins can work. Use named local planting domains so edits can target part of the landscape; neighboring domains may overlap and should preserve habitat continuity. Coordinate canopy, understory and ground_cover in each area. You author desired spacing, species weights and instance caps; the compiler derives finite sampling effort and coherent patches. Canopy always has neutral canopyPreference. Typical center spacing: trees 2.5-5 meters subject to measured crown geometry, shrubs 0.8-1.8, small ground plants 0.3-0.8; large aggregate assets need larger spacing. Each requested planting layer must establish visible plants; individual species compete, and maximumCount is only a cap. Select a manageable palette with meaningful visible presence; avoid demanding many giant trees in a tiny grove. Preserve irregular edges, understory and ground cover around the destination clearings, not isolated token plants. Paint ground sparingly in irregular patches; do not confuse material with elevation. At least two cameras must include a full overview and a close approach. Camera coordinates must make the actual requested destinations visible. Preserve style coherence and open circulation. Report visible limitations honestly.`;
const COMPOSITION_RULES = `The palette is a menu, not a checklist: select only content relevant to the request. Compose arrangements from individual assets; a multi-object arrangement does not need a dedicated aggregate asset. Use vegetationAreas for natural woodland and grids only for intentionally ordered planting. Put ordinary assumptions and approximate visual judgments in notes. unmetRequirements must be empty if the request can be expressed by the listed supportedComposition operations; do not label ordinary material choices or the fixed square extent as unavailable content. A soil request can use an appropriate allowed ground material without inventing a material ID. Follow supplied route constraints. Keep each route's controls in travel order with comfortably spaced gentle bends; avoid hairpins, repeated interior vertices and crossings without shared endpoints. A route may approach a landmark but must stay outside its complete measured footprint, including open-looking catalog models: an apparent hole is not a measured traversable portal. Place small props with footingElevationMeters null unless a level pad is necessary. Footing elevations are absolute meters, and neighboring pads must agree where they overlap. Leave enough measured clearance between props and focal objects. Do not delete required content merely to pass a verifier.`;
const REVIEW_RULES = `You are reviewing actual mesh previews of a requested game region. Judge all four criteria: instruction_following, composition, grounding, access. Inspect the supplied images, not just the plan. For edits the images are ordered as the BEFORE set followed by the AFTER set with matching cameras; compare them to establish the requested change and preservation. A compiler pass is not visual quality. Mark fail for obvious collisions, blocked approaches, floating or buried objects, stiff or incoherent planting, or missing requested content. Use uncertain whenever an image cannot establish a requested condition, especially destination access; never mark such a condition pass while calling it unverified in the note. List only blocking corrections in repairs; use an empty repairs array when all required conditions pass. Do not include optional aesthetic suggestions. Acceptance is derived locally from four pass verdicts AND an empty repairs array. Do not claim engine verification. This is a same-model development review, not independent acceptance.`;

const LANDSCAPE_RULES = `Compose land coverage before choosing plant counts. Named planting areas are editing domains, not isolated islands or separate perimeter flower beds. Use connected, overlapping domains with soft transitions where the requested habitat continues. Distinguish tree-free space from bare ground: an open meadow normally retains low grass and sparse flower colonies while excluding tall trees and dense shrubs. Author its ground-cover area separately, with no blanket clearing that removes the meadow itself. Use full-layer exclusions only for paths, usable activity space and deliberately bare ground. Ground-cover caps must account for measured patch area; hundreds of tiny flowers are not a replacement for broad grass cover. Broad ground-cover patches are placed before smaller accents, so reserve a restrained share for flowers instead of selecting every colorful asset. Choose related species with a plausible height hierarchy, using a few large trees as anchors and medium trees for the stand. Match density to the requested landscape; do not turn every natural scene into a uniform ring around an empty lawn. The sampled landscape evidence reports projected render bounds and empty domains, not aesthetic correctness. Inspect both broad continuity and local clumping in images. Camera overviews must include the complete region and destinations; close views must reveal the requested props and their route approaches.`;

interface RegionCapture {
  images: readonly { dataUrl: string; hash: string }[];
  evidence: unknown;
}

export interface RegionRunOptions {
  root: string;
  output: string;
  prompt: string;
  authority: Authority;
  planner: WorldPlanner;
  profile?: RegionAuthoringProfile;
  base?: { plan: SpatialWorldPlan; world: WorldBuild };
  maximumAttempts?: number;
  budgetSeconds?: number;
  onProgress?: (message: string) => void;
  capture?: (input: {
    folder: string;
    plan: SpatialWorldPlan;
    world: WorldBuild;
    remainingMilliseconds: number;
  }) => Promise<RegionCapture>;
}

export async function runRegionAuthoring(options: RegionRunOptions) {
  const { root, output, prompt, authority, planner } = options;
  if (!prompt.trim() || prompt.length > 16000)
    throw new Error("Prompt must contain 1–16000 characters");
  if (Boolean(options.profile) === Boolean(options.base))
    throw new Error("Supply exactly one authoring profile or base build");
  if (options.profile && options.profile.catalogSnapshotHash !== authority.catalog.snapshot.hash)
    throw new Error("Authoring profile binds a stale catalog snapshot; prepare it again");
  const max = options.maximumAttempts ?? 3,
    budget = options.budgetSeconds ?? 300;
  if (
    !Number.isInteger(max) ||
    max < 1 ||
    max > 3 ||
    !Number.isFinite(budget) ||
    budget < 10 ||
    budget > 600
  )
    throw new Error("Invalid bounded generation budget");
  try {
    await lstat(resolve(root, output));
    throw new Error("Output directory must be absent; retained runs cannot be overwritten");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const start = performance.now();
  const elapsed = () => (performance.now() - start) / 1000;
  const remaining = () => {
    const ms = budget * 1000 - (performance.now() - start);
    if (ms <= 0) throw new Error("Generation time budget exhausted");
    return Math.ceil(ms);
  };
  const mode = options.base ? "edit" : "generate";
  const policy = options.base ? regionEditPolicy(options.base.plan) : undefined;
  const manifest = {
    prompt,
    mode,
    provider: planner.providerId,
    model: planner.model,
    transportConfiguration: planner.configuration ?? null,
    budgetSeconds: budget,
    maximumAttempts: max,
    maximumModelCallSeconds: 150,
    startedAt: new Date().toISOString(),
    catalogHash: authority.catalog.hash,
    profile: options.profile ?? null,
    basePlanHash: options.base?.plan.planHash ?? null,
    baseWorldBuildHash: options.base?.world.worldBuildHash ?? null,
  };
  await write(root, `${output}/request.json`, manifest);
  if (options.base) {
    await write(root, `${output}/base-plan.json`, options.base.plan);
    await write(root, `${output}/base-world.json`, options.base.world);
    await write(root, `${output}/edit-policy.json`, policy);
  }
  const attempts: Array<Record<string, unknown>> = [];
  let feedback: unknown = null;
  let previousProposal: unknown = null;
  let final:
    { plan: SpatialWorldPlan; world: WorldBuild; status: "eligible" | "incomplete" } | undefined;
  let modelCalls = 0;
  let beforeCapture: RegionCapture | undefined;
  let repairCapture: RegionCapture | undefined;
  let reviewCandidate:
    { plan: SpatialWorldPlan; world: WorldBuild; changes: readonly WorldChange[] } | undefined;
  const capture = options.capture ?? ((input) => captureRegionPreview(root, input));
  const progress = (message: string) => options.onProgress?.(`${elapsed().toFixed(1)}s ${message}`);
  const call = async (
    folder: string,
    phase: string,
    schema: z.ZodType,
    system: string,
    context: unknown,
    images: readonly { dataUrl: string; hash: string }[] = [],
  ) => {
    const jsonSchema = z.toJSONSchema(schema, { unrepresentable: "any" }) as Record<
      string,
      unknown
    >;
    const request = {
      system: `${system}\nWhen feedback is present, repair its concrete failures while preserving required user content. Do not repeat an unchanged invalid proposal. Compiler evidence describes what was actually placed; supplied repair images may show a partial, rejected scene.\nThe exact output JSON Schema follows. Use these field names and required values; do not invent a different JSON shape.\n${stableJson(jsonSchema)}`,
      prompt: stableJson(context),
      schema: jsonSchema,
      imageHashes: images.map((i) => i.hash),
      transportConfiguration: planner.configuration ?? null,
    };
    await write(root, `${folder}/${phase}-request.json`, request);
    modelCalls++;
    const before = elapsed();
    progress(`Requesting ${phase}`);
    let result;
    try {
      result = await planner.complete({
        ...request,
        images,
        signal: AbortSignal.timeout(Math.min(150000, remaining())),
      });
    } catch (error) {
      await write(root, `${folder}/${phase}-failure.json`, {
        ...(error instanceof WorldPlannerResponseError
          ? error.receipt
          : { model: planner.model, usage: null }),
        provider: planner.providerId,
        requestHash: contentHash(stableJson(request)),
        failure: String(error),
        elapsedSeconds: elapsed(),
        durationSeconds: elapsed() - before,
      });
      throw error;
    }
    await write(root, `${folder}/${phase}-receipt.json`, {
      model: result.model,
      provider: planner.providerId,
      usage: result.usage,
      raw: result.raw,
      output: result.output,
      requestHash: contentHash(stableJson(request)),
      elapsedSeconds: elapsed(),
      durationSeconds: elapsed() - before,
    });
    return schema.parse(result.output) as unknown;
  };
  const compileInput = async (plan: SpatialWorldPlan) => ({
    semanticModule: authority.semanticModule,
    catalogSnapshot: authority.catalog.snapshot,
    catalogAssets: authority.measurements.assets,
    spatialPlan: plan,
    placementGeometry: await prepareWorldPlacementGeometry({
      root,
      plan,
      semanticModule: authority.semanticModule,
      snapshot: authority.catalog.snapshot,
      assets: authority.measurements.assets,
      sourceManifest: authority.catalog.sourceManifest,
    }),
  });
  if (options.base) {
    const replay = compileBasaltWorld(await compileInput(options.base.plan));
    if (replay.worldBuildHash !== options.base.world.worldBuildHash || replay.status !== "eligible")
      throw new Error("Edit base does not replay against the current catalog and compiler");
  }
  for (let attempt = 1; attempt <= max; attempt++) {
    const folder = `${output}/attempts/${attempt}`;
    const event: Record<string, unknown> = { attempt, startedSeconds: elapsed() };
    try {
      remaining();
      if (options.base && !beforeCapture) {
        const beforeFolder = `${output}/before`;
        await write(root, `${beforeFolder}/spatial-plan.json`, options.base.plan);
        await write(root, `${beforeFolder}/world-build.json`, options.base.world);
        progress("Capturing the base world for edit comparison");
        beforeCapture = await capture({
          folder: beforeFolder,
          ...options.base,
          remainingMilliseconds: remaining(),
        });
        if (!beforeCapture.images.length) throw new Error("Edit comparison requires before images");
      }
      let plan: SpatialWorldPlan, world: WorldBuild;
      let appliedChanges: readonly WorldChange[] = [];
      if (reviewCandidate) {
        ({ plan, world, changes: appliedChanges } = reviewCandidate);
        event.reusedWorldBuildHash = world.worldBuildHash;
        reviewCandidate = undefined;
        progress("Retrying invalid review without changing the compiled scene");
      } else if (options.base) {
        const base = options.base;
        const editResponse = regionEditResponseSchema(policy!);
        const proposed = editResponse.parse(
          await call(
            folder,
            "proposal",
            editResponse,
            "Propose only the requested world edit as whitelisted typed changes. Preserve all other content. Copy an exact existing intentId from vegetationTargets for EACH vegetation change. A clearing has no new ID: apply its bounds to every existing vegetation target that intersects the requested clearing. A vegetation_clearings change ADDS exclusions; it cannot remove existing clearings. Ground material edits replace existing paint operations only. Never change routes, assets, buildings, terrain elevation or cultivated rows. Use observed placedCount, not maximumCount, to understand actual density. Respect each target's numeric limits. Respond to repair feedback by changing the ineffective controls; do not repeat a failed edit. Images show the base world first, followed by the most recent attempted edit when supplied.",
            {
              prompt,
              context: regionEditContext(base.plan, base.world, policy!),
              beforeImages: beforeCapture?.evidence,
              repairImages: repairCapture?.evidence ?? null,
              feedback,
              previousProposal,
            },
            [...beforeCapture!.images, ...(repairCapture?.images ?? [])],
          ),
        );
        previousProposal = proposed;
        appliedChanges = proposed.changes;
        const proposal = sealWorldChangeProposal({
          ...proposed,
          basePlanHash: base.plan.planHash,
          baseWorldBuildHash: base.world.worldBuildHash,
          providerId: planner.providerId,
          providerImplementationHash: contentHash("basalt-typed-world-edit"),
        });
        const prepared = await compileInput(base.plan);
        let observedPlan = base.plan;
        const compiler = createLocalRefinementCompiler(prepared);
        const result = await runBoundedRefinement({
          initialPlan: base.plan,
          initialProposal: proposal,
          policy: policy!,
          provider: {
            async propose() {
              return undefined;
            },
          },
          compiler: {
            compile(input) {
              observedPlan = input.plan;
              return compiler.compile(input);
            },
          },
          observe: (input) =>
            observeWorldBuild({
              ...input,
              plan: observedPlan,
              policy: policy!,
              expectations: {
                dimensions: [],
                access: [],
                viewCorridors: [],
                styles: [],
                minimumNeighborClearanceMeters: 0,
              },
              cameras: [],
            }),
        });
        await write(root, `${folder}/refinement.json`, result.run);
        await write(root, `${folder}/observation.json`, result.observation);
        if (result.run.status !== "eligible")
          event.refinementFailure =
            [
              ...worldBuildDiagnostics(result.worldBuild),
              ...result.observation.diagnostics,
              ...result.run.diagnostics,
            ].join("; ") || "Edit did not pass geometric verification";
        plan = result.plan;
        world = result.worldBuild;
        if (
          stableJson(base.world.foundation.routeConstructions.map((r) => r.travelSegments)) !==
          stableJson(world.foundation.routeConstructions.map((r) => r.travelSegments))
        )
          throw new Error("Protected route geometry changed");
      } else {
        const proposed = await call(
          folder,
          "proposal",
          REGION_DRAFT_SCHEMA,
          `${PLANNING_RULES}\n${COMPOSITION_RULES}\n${LANDSCAPE_RULES}`,
          {
            prompt,
            context: regionPlanningContext(options.profile!),
            feedback,
            previousProposal,
            repairImages: repairCapture?.evidence ?? null,
          },
          repairCapture?.images ?? [],
        );
        previousProposal = proposed;
        plan = realizeRegionDraft(options.profile!, proposed);
        world = compileBasaltWorld(await compileInput(plan));
      }
      await write(root, `${folder}/spatial-plan.json`, plan);
      await write(root, `${folder}/world-build.json`, world);
      event.worldBuildHash = world.worldBuildHash;
      event.compilerStatus = world.status;
      event.compileFinishedSeconds = elapsed();
      event.instances = world.instances.length;
      event.population = regionPopulationEvidence(plan, world);
      event.landscape = regionLandscapeEvidence(plan, world);
      const planting = options.profile ? regionPlantingAssessment(plan, world) : undefined;
      event.planting = planting ?? null;
      progress(`Attempt ${attempt} compiled: ${world.status}, ${world.instances.length} instances`);
      if (world.status === "eligible" && !event.refinementFailure)
        final = { plan, world, status: "incomplete" };
      if (
        world.status !== "eligible" ||
        event.refinementFailure ||
        planting?.status === "incomplete"
      ) {
        const vegetationIds = new Set(
          plan.realizationIntents
            .filter((i) => i.kind === "surface_scatter" && i.vegetation)
            .map((i) => i.intentId),
        );
        event.compilerEvidence = {
          worldBuildHash: world.worldBuildHash,
          status: world.status,
          realizedStaticBounds: world.instances
            .filter((i) => !vegetationIds.has(i.intentId))
            .slice(0, 256)
            .map((i) => ({ intentId: i.intentId, boundsMeters: i.boundsMeters })),
        };
        if (world.foundation.status === "eligible") {
          try {
            repairCapture = await capture({
              folder,
              plan,
              world,
              remainingMilliseconds: remaining(),
            });
            event.capture = repairCapture.evidence;
          } catch (error) {
            event.captureFailure = String(error);
          }
        }
        throw new Error(
          [
            event.refinementFailure,
            ...worldBuildDiagnostics(world),
            ...(planting?.diagnostics ?? []),
          ]
            .filter(Boolean)
            .join("; ") || "World compilation incomplete",
        );
      }
      final = { plan, world, status: "incomplete" };
      const captured = await capture({ folder, plan, world, remainingMilliseconds: remaining() });
      if (!captured.images.length)
        throw new Error("Visual review requires captured image evidence");
      event.firstPreviewSeconds = elapsed();
      event.capture = captured.evidence;
      repairCapture = captured;
      if (options.base) {
        const effect = regionEditEffect({
          beforePlan: options.base.plan,
          before: options.base.world,
          afterPlan: plan,
          after: world,
          changes: appliedChanges,
        });
        event.editEffect = effect;
        await write(root, `${folder}/edit-effects.json`, effect);
        if (effect.status !== "eligible") throw new Error(effect.diagnostics.join("; "));
      }
      let judgment: z.output<typeof visualResponse>;
      try {
        judgment = visualResponse.parse(
          await call(
            folder,
            "review",
            visualResponse,
            `${REVIEW_RULES}\n${LANDSCAPE_RULES}\nFor a natural landscape, fail composition when large unintended bare domains, uniformly spaced decorative borders, abrupt species blocks or tiny-accent overload dominate the image. Total instance count is not a density or quality score. Evaluate against the requested landscape; deliberate lawns, formal gardens and bare courtyards are valid when requested.`,
            {
              prompt,
              mode,
              worldBuildHash: world.worldBuildHash,
              images: captured.evidence,
              before: options.base
                ? {
                    worldBuildHash: options.base.world.worldBuildHash,
                    images: beforeCapture!.evidence,
                    imageCount: beforeCapture!.images.length,
                    landscape: regionLandscapeEvidence(options.base.plan, options.base.world),
                  }
                : null,
              imageOrder:
                "Before images first when present, then after images; matching camera order",
              compiler: {
                status: world.status,
                instances: world.instances.length,
                diagnostics: worldBuildDiagnostics(world),
              },
              population: event.population,
              landscape: event.landscape,
              editEffect: event.editEffect ?? null,
            },
            [...(beforeCapture?.images ?? []), ...captured.images],
          ),
        );
      } catch (error) {
        // Invalid/missing review evidence is not a request to regenerate the world.
        // The next bounded attempt recaptures and reviews this same verified candidate.
        reviewCandidate = { plan, world, changes: appliedChanges };
        throw error;
      }
      const reviewed = {
        ...judgment,
        status:
          Object.values(judgment.checks).every((c) => c.verdict === "pass") &&
          judgment.repairs.length === 0
            ? ("eligible" as const)
            : ("incomplete" as const),
      };
      await write(root, `${folder}/visual-review.json`, {
        ...reviewed,
        worldBuildHash: world.worldBuildHash,
        imageHashes: captured.images.map((i) => i.hash),
        beforeWorldBuildHash: options.base?.world.worldBuildHash ?? null,
        beforeImageHashes: beforeCapture?.images.map((i) => i.hash) ?? [],
        authority: "model",
        independent: false,
        engineVerified: false,
      });
      final.status = reviewed.status;
      event.visualStatus = reviewed.status;
      feedback = reviewed;
      repairCapture = captured;
      progress(`Attempt ${attempt} visual review: ${reviewed.status}`);
      if (reviewed.status === "eligible") {
        event.finishedSeconds = elapsed();
        attempts.push(event);
        await write(root, `${folder}/event.json`, event);
        break;
      }
    } catch (error) {
      event.failure = (
        error instanceof z.ZodError
          ? JSON.stringify(error.issues)
          : String(error instanceof Error ? error.message : error)
      ).slice(0, 8000);
      feedback = {
        failure: event.failure,
        compilerEvidence: event.compilerEvidence ?? null,
        population: event.population ?? null,
        editEffect: event.editEffect ?? null,
        planting: event.planting ?? null,
        landscape: event.landscape ?? null,
      };
      progress(`Attempt ${attempt} incomplete: ${String(event.failure).slice(0, 1500)}`);
    }
    event.finishedSeconds = elapsed();
    attempts.push(event);
    await write(root, `${folder}/event.json`, event);
    if (elapsed() >= budget) break;
  }
  if (final) {
    await write(root, `${output}/spatial-plan.json`, final.plan);
    await write(root, `${output}/world-build.json`, final.world);
  }
  const report = {
    status: final?.status ?? "incomplete",
    mode,
    prompt,
    worldBuildHash: final?.world.worldBuildHash ?? null,
    elapsedSeconds: elapsed(),
    modelCalls,
    attempts,
    independentReview: false,
    creatorAccepted: false,
    engineVerified: false,
    budgetSeconds: budget,
    beforeCapture: beforeCapture?.evidence ?? null,
  };
  await write(root, `${output}/report.json`, report);
  return report;
}

async function captureRegionPreview(
  root: string,
  input: {
    folder: string;
    plan: SpatialWorldPlan;
    world: WorldBuild;
    remainingMilliseconds: number;
  },
) {
  const views = { worldBuildHash: input.world.worldBuildHash, cameras: input.plan.cameras };
  if (views.cameras.length < 2 || views.cameras.length > 4)
    throw new Error("Region workflow requires two to four declared evidence cameras");
  await write(root, `${input.folder}/views.json`, views);
  await execute(
    process.execPath,
    [
      "scripts/preview-world.mjs",
      "--world",
      `${input.folder}/world-build.json`,
      "--views",
      `${input.folder}/views.json`,
      "--capture",
      `${input.folder}/preview`,
    ],
    { cwd: root, timeout: input.remainingMilliseconds, maxBuffer: 1024 * 1024 },
  );
  const capture = z
    .object({
      worldBuildHash: z.string(),
      images: z
        .array(z.object({ file: z.string().regex(/^[A-Za-z0-9_-]+\.png$/u), hash: z.string() }))
        .min(2)
        .max(4),
    })
    .passthrough()
    .parse(await read(root, `${input.folder}/preview/capture.json`));
  if (capture.worldBuildHash !== input.world.worldBuildHash)
    throw new Error("Preview belongs to another world");
  const images = [];
  for (const image of capture.images) {
    const bytes = await readBoundedWorkspaceBytes(
      root,
      `${input.folder}/preview/${image.file}`,
      16 * 1024 * 1024,
    );
    if (createHash("sha256").update(bytes).digest("hex") !== image.hash)
      throw new Error("Preview image hash mismatch");
    images.push({
      dataUrl: `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`,
      hash: image.hash,
    });
  }
  return { images, evidence: capture };
}

export async function runWorldAuthoringCommand(
  root: string,
  action: string,
  args: string[],
  semanticModule: SemanticModule,
) {
  const positional = args[0];
  const option = (name: string) => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    const value = args[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing ${name}`);
    return value;
  };
  const output = option("--output");
  if (!output) throw new Error("An explicit --output directory or profile file is required");
  const authority = await loadWorldAuthority(
    root,
    option("--catalog") ?? "registry/catalog.json",
    semanticModule,
  );
  if (action === "profile") {
    if (!positional || positional.startsWith("--"))
      throw new Error("Supply the authority plan to prepare an empty region profile");
    const profile = prepareRegionAuthoringProfile(
      SPATIAL_WORLD_PLAN_SCHEMA.parse(await read(root, positional)),
      authority,
    );
    await write(root, output, profile);
    console.log(JSON.stringify({ status: "eligible", output, palette: profile.palette.length }));
    return;
  }
  if (!positional || positional.startsWith("--")) throw new Error("Supply the creator prompt");
  const model = option("--model");
  if (!model) throw new Error("Select an explicit --model OpenRouter ID");
  let key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    try {
      key = parseEnv(
        Buffer.from(await readBoundedWorkspaceBytes(root, ".env", 128 * 1024)).toString("utf8"),
      ).OPENROUTER_API_KEY;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  if (!key) throw new Error("OPENROUTER_API_KEY is absent from the environment and .env");
  const reasoningEffort = z
    .enum(["none", "low", "high"])
    .parse(option("--reasoning-effort") ?? "low");
  const planner = createOpenRouterPlanner({ apiKey: key, model, reasoningEffort });
  const profilePath = option("--profile") ?? "registry/world-authoring/outdoor.json";
  const basePath = option("--from");
  if (action === "edit" && !basePath)
    throw new Error(
      "Edit needs --from <directory containing spatial-plan.json and world-build.json>",
    );
  const configuration =
    action === "edit"
      ? {
          base: {
            plan: SPATIAL_WORLD_PLAN_SCHEMA.parse(
              await read(root, `${basePath}/spatial-plan.json`),
            ),
            world: WORLD_BUILD_SCHEMA.parse(await read(root, `${basePath}/world-build.json`)),
          },
        }
      : { profile: REGION_AUTHORING_PROFILE_SCHEMA.parse(await read(root, profilePath)) };
  const report = await runRegionAuthoring({
    root,
    output,
    prompt: positional,
    authority,
    planner,
    ...configuration,
    budgetSeconds: Number(option("--budget-seconds") ?? 300),
    onProgress: (message) => console.error(message),
  });
  console.log(
    JSON.stringify({
      status: report.status,
      output,
      worldBuildHash: report.worldBuildHash,
      elapsedSeconds: report.elapsedSeconds,
      modelCalls: report.modelCalls,
    }),
  );
}
