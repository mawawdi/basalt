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
import {
  CATALOG_AUTHORITY_COMMIT_SCHEMA,
  CATALOG_AUTHORED_METADATA_SET_MANIFEST_SCHEMA,
  CATALOG_AUTHORED_SEARCH_METADATA_SET_SCHEMA,
  CATALOG_VISUAL_REVIEW_INDEX_SCHEMA,
  type CatalogAuthoredSearchMetadataRecord,
} from "@basalt/catalog-authoring";
import { CATALOG_MEASUREMENT_SET_SCHEMA, resolveCatalogRequirements } from "@basalt/catalog-model";
import { type SemanticModule } from "@basalt/semantic-kernel";
import {
  REGION_AUTHORING_PROFILE_SCHEMA,
  REGION_EDIT_OBJECTIVE_SCHEMA,
  REGION_EDIT_REQUEST_DRAFT_SCHEMA,
  REGION_LAYOUT_DRAFT_SCHEMA,
  REGION_PLANTING_DRAFT_SCHEMA,
  SPATIAL_WORLD_PLAN_SCHEMA,
  composeRegionDraft,
  realizeRegionDraft,
  regionPlanningContext,
  sealRegionEditProposal,
  sealRegionEditRequest,
  sealSpatialWorldPlan,
  validateRegionEditTargets,
  type PopulationPlacementConstraints,
  type RegionEditProposal,
  type RegionEditProposalDraft,
  type RegionEditRequest,
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
  regionEditEvidenceCameras,
  regionEditTargetEvidence,
  expandRegionEditProposal,
  regionPopulationEvidence,
  regionPlantingAssessment,
  regionLandscapeEvidence,
} from "./region-feedback.js";
export {
  regionEditResponseSchema,
  regionEditEffect,
  regionEditEvidenceCameras,
  regionEditTargetEvidence,
  expandRegionEditProposal,
  regionPopulationEvidence,
  regionPlantingAssessment,
  regionLandscapeEvidence,
} from "./region-feedback.js";
import { prepareWorldPlacementGeometry } from "./world-placement-geometry.js";
import {
  createOpenRouterPlanner,
  WorldPlannerResponseError,
  type WorldPlanner,
  type WorldPlannerResourceExhaustion,
} from "./world-planner.js";

const read = async (root: string, path: string, maximumBytes: number) =>
  JSON.parse(
    Buffer.from(await readBoundedWorkspaceBytes(root, path, maximumBytes)).toString("utf8"),
  ) as unknown;
const write = (root: string, path: string, value: unknown, maximumBytes: number) =>
  writeCanonicalWorkspaceJson(root, path, value, { maxBytes: maximumBytes });
const execute = promisify(execFile);

export async function loadWorldAuthority(
  root: string,
  catalogPath: string,
  semanticModule: SemanticModule,
  maximumArtifactBytes: number,
) {
  const catalog = CATALOG_AUTHORITY_COMMIT_SCHEMA.parse(
    await read(root, catalogPath, maximumArtifactBytes),
  );
  const retained = catalog.retainedEvidence.find(
    (e) => e.kind === "CatalogMeasurementSet" && e.artifactHash === catalog.measurementSetHash,
  );
  if (!retained) throw new Error("Catalog does not retain its measurement set");
  const measurements = CATALOG_MEASUREMENT_SET_SCHEMA.parse(
    await read(root, retained.relativePath, maximumArtifactBytes),
  );
  if (measurements.hash !== catalog.measurementSetHash)
    throw new Error("Catalog measurement hash mismatch");
  const authoredMetadata: CatalogAuthoredSearchMetadataRecord[] = [];
  const manifestPath = ".basalt/catalog/metadata/authored-sets.json";
  try {
    const manifest = CATALOG_AUTHORED_METADATA_SET_MANIFEST_SCHEMA.parse(
      await read(root, manifestPath, maximumArtifactBytes),
    );
    for (const reference of manifest.sets) {
      const set = CATALOG_AUTHORED_SEARCH_METADATA_SET_SCHEMA.parse(
        await read(root, reference.relativePath, maximumArtifactBytes),
      );
      if (set.hash !== reference.setHash)
        throw new Error(`Authored metadata set hash mismatch: ${reference.relativePath}`);
      authoredMetadata.push(...set.records);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const retainedVisualReview = catalog.retainedEvidence.find(
    (entry) => entry.kind === "CatalogVisualReviewIndex",
  );
  const visualReview = retainedVisualReview
    ? CATALOG_VISUAL_REVIEW_INDEX_SCHEMA.parse(
        await read(root, retainedVisualReview.relativePath, maximumArtifactBytes),
      )
    : undefined;
  if (visualReview && visualReview.hash !== retainedVisualReview?.artifactHash)
    throw new Error("Catalog visual-review evidence hash mismatch");
  return { catalog, measurements, semanticModule, authoredMetadata, visualReview };
}
type Authority = Awaited<ReturnType<typeof loadWorldAuthority>>;

export const REGION_AUTHORING_SETTINGS_SCHEMA = z
  .object({
    policyId: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u),
    origin: z.string().trim().min(1),
    placementToleranceMeters: z.number().finite().nonnegative(),
    placementPadBlendWidthMeters: z.number().finite().nonnegative(),
    evidenceCameraFieldOfViewDegrees: z.number().finite().gt(0).lt(180),
    allowedTerrainMaterialIds: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u)).min(1),
    plantingPolicy: REGION_AUTHORING_PROFILE_SCHEMA.shape.plantingPolicy,
  })
  .strict();
export type RegionAuthoringSettings = z.output<typeof REGION_AUTHORING_SETTINGS_SCHEMA>;

export function prepareRegionAuthoringProfile(
  plan: SpatialWorldPlan,
  authority: Authority,
  settingsInput: RegionAuthoringSettings,
): RegionAuthoringProfile {
  const settings = REGION_AUTHORING_SETTINGS_SCHEMA.parse(settingsInput);
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
    const descriptions = assets.flatMap((asset) =>
      authority.authoredMetadata.flatMap((record) =>
        record.sourceContentHash === asset.source.contentHash &&
        record.metadata.caption.status === "observed"
          ? [{ caption: record.metadata.caption.value, evidenceHash: record.hash }]
          : [],
      ),
    );
    const captions = [...new Set(descriptions.map((entry) => entry.caption))];
    const sourceHashes = new Set(assets.map((asset) => asset.source.contentHash));
    const renderEvidenceHashes = [
      ...new Set(
        (authority.visualReview?.items ?? [])
          .filter((item) => sourceHashes.has(item.sourceContentHash))
          .map((item) => item.evidence.hash),
      ),
    ].sort();
    const style = authority.catalog.styleProfiles.find(
      (candidate) => candidate.handle === entry.styleProfileHandle,
    );
    const styleReference = authority.catalog.snapshot.styleProfiles.find(
      (candidate) => candidate.handle === entry.styleProfileHandle,
    );
    if (!style || !styleReference || styleReference.hash !== entry.styleProfileHash)
      throw new Error(`Catalog entry ${entry.handle} lacks its admitted style profile`);
    return {
      requirementId: requirement.requirementId,
      description:
        captions.join(" / ") ||
        `No retained authored visible description is available for catalog entry ${entry.handle}.`,
      descriptionStatus: captions.length ? ("authored" as const) : ("unavailable" as const),
      descriptionEvidenceHashes: [
        ...new Set(
          descriptions.flatMap((description) => [
            description.evidenceHash,
            ...authority.authoredMetadata
              .filter(
                (record) =>
                  sourceHashes.has(record.sourceContentHash) &&
                  record.metadata.caption.status === "observed" &&
                  record.metadata.caption.value === description.caption,
              )
              .map((record) => record.renderEvidenceHash),
          ]),
        ),
      ].sort(),
      renderEvidenceHashes,
      styleProfile: {
        handle: style.handle,
        hash: styleReference.hash,
        shapeLanguage: style.shapeLanguage,
        materialLanguage: style.materialLanguage,
        silhouetteHierarchy: style.silhouetteHierarchy,
      },
      boundsMeters: { min: point("min"), max: point("max") },
    };
  });
  const { kind: _kind, coordinateSystem: _coordinates, planHash: _hash, ...body } = plan;
  const basePlan = sealSpatialWorldPlan({
    ...body,
    planId: "EmptyRegion",
    seed: plan.seed,
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
    placementToleranceMeters: settings.placementToleranceMeters,
    placementPadBlendWidthMeters: settings.placementPadBlendWidthMeters,
    evidenceCameraFieldOfViewDegrees: settings.evidenceCameraFieldOfViewDegrees,
    palette,
    allowedTerrainMaterialIds: settings.allowedTerrainMaterialIds,
    plantingPolicy: settings.plantingPolicy,
  });
}

const visualCriterion = z
  .object({ verdict: z.enum(["pass", "fail", "uncertain"]), note: z.string().min(1) })
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
    repairs: z.array(z.string().min(1)),
  })
  .strict();

export function regionEditPolicy(
  plan: SpatialWorldPlan,
  profile: RegionAuthoringProfile,
  maximumIterations: number,
): RefinementPolicy {
  return sealRefinementPolicy({
    maximumIterations,
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
                allowedMaterialIds: profile.allowedTerrainMaterialIds,
                bounds: plan.boundsMeters,
              },
            ]
          : [],
      ),
    ),
  });
}

const PLANNING_RULES = `You propose an outdoor region for a deterministic world compiler. Return only the requested JSON. Never write code or invent assets. Use only the prepared requirement IDs and measured sizes. Match the user's prompt; list unsupported requests in unmetRequirements rather than substituting a different scene. The profile bounds fix this region's extent, but schema cardinalities are not creative limits. X/Z are ground coordinates in meters, Y is vertical, north is +Z. Compose destinations, clear entrances and a connected path network before planting. Declare shared routeNodes and connect routes using startNodeId/endNodeId; waypoints are interior bend controls only. A loop uses two routes between the same two nodes. All routes must form one connected graph. Leave enough room for the supplied bend radius and avoid shallow forks. A route requested to reach a destination must terminate beside that destination's complete measured footprint: keep the travel surface outside the footprint while leaving no unexplained open-ground gap. Keep buildings and wide tree roots on ample flat footing. Single placements may move within the profile's explicit placementToleranceMeters to resolve collisions; grids remain exact. footingElevationMeters creates a measured rectangular pad covering that tolerance; use null for assets that can follow the ground. A flattening pad is structural support, not automatically the visible material footprint. For terrain paint, use a hard edge only when a geometric edge is intentional. Natural soil, leaf-litter and ground-variation patches use an organic edge with authored world-space wavelength and displacement. Give every natural patch a tight, nonrectangular coarse envelope around the actual activity or habitat footprint; never paint an object bounding box or the whole flattening pad. A campsite surface should follow its usable arrangement and meet its route approach without becoming a rectangular lot. Grids rotate around their first cell; yaw is 0..359 and rotates both the grid offsets and each object. Positive yaw turns the local +X direction toward world -Z. Keep routes outside building footprints. Place fences as ordinary catalog objects only when their measured joins can work. Camera coordinates must make the requested destinations and approaches visible; include as many evidence views as coverage requires. For a tall landmark close view, aim near its measured vertical center and choose enough distance to keep its complete height and approach inside the frame; a ground-level lookAt point will crop its top. Preserve style coherence and open circulation. Report visible limitations honestly.`;
const COMPOSITION_RULES = `The palette is a menu, not a checklist: select only content relevant to the request. Compose arrangements from individual assets; a multi-object arrangement does not need a dedicated aggregate asset. Layout placements are for destinations, structures, props, vegetation explicitly named as a landmark, and intentionally ordered planting such as orchard rows. Natural woodland, meadow, grove, edge, canopy, understory and ground-cover vegetation belongs in vegetationAreas during the planting stage; do not enumerate background plants as layout placements. Use grids only for intentionally ordered planting. Put ordinary assumptions and approximate visual judgments in notes. unmetRequirements must be empty if the request can be expressed by the listed supportedComposition operations; do not label ordinary material choices or the fixed square extent as unavailable content. A soil request can use an appropriate allowed ground material without inventing a material ID. Follow supplied route constraints. Keep each route's controls in travel order with comfortably spaced gentle bends; avoid hairpins, repeated interior vertices and crossings without shared endpoints. A route may approach a landmark but must stay outside its complete measured footprint, including open-looking catalog models: an apparent hole is not a measured traversable portal. Every route must also stay outside the complete measured footprint of every placement and every cell of an ordered grid; placementToleranceMeters is a local collision-search allowance, not permission to draw a route through the nominal footprint. Place small props with footingElevationMeters null unless a level pad is necessary. Footing elevations are absolute meters, and neighboring pads must agree where they overlap. Leave enough measured clearance between props and focal objects. Do not delete required content merely to pass a verifier.`;
const REVIEW_RULES = `You are reviewing actual mesh previews of a requested game region. Judge all four criteria: instruction_following, composition, grounding, access. Inspect the supplied images, not just the plan. For edits the images are ordered as the BEFORE set followed by the AFTER set with matching cameras; compare them to establish the requested visual change. Deterministic compilerEvidence establishes the existence, catalog identity, measured transform and bounds of every listed static instance, plus exact route alignments and constructed travel surfaces; do not call listed content absent merely because a small object is hard to identify in one image. Images remain necessary for visibility, composition, grounding and experiential quality. Deterministic editEffect evidence may establish exact physical placement, route equality, and objective-count changes that images cannot prove; do not call those facts uncertain when their individual checks are eligible. A compiler pass is not visual quality and cannot establish aesthetics. Mark fail for obvious collisions, blocked approaches, floating or buried objects, stiff or incoherent planting, truly missing requested content, or required content that is present but visually unusable. Use uncertain whenever neither images nor typed evidence establish a requested condition, especially destination access; never mark such a condition pass while calling it unverified in the note. List only blocking corrections in repairs; use an empty repairs array when all required conditions pass. Do not include optional aesthetic suggestions. Acceptance is derived locally from four pass verdicts AND an empty repairs array. Do not claim engine verification. This is a same-model development review, not independent acceptance.`;
const REVIEW_BATCH_RULES = `${REVIEW_RULES}\nThis request contains one declared camera batch. Judge only what these images establish. Omitted images are reviewed in other linked batches; do not treat their omission as a scene defect. Mark a criterion uncertain when this batch cannot establish it, and describe the visible evidence precisely for final synthesis.`;
const REVIEW_SYNTHESIS_RULES = `Synthesize linked visual-review batches for one unchanged captured scene. No geometry changed between batches. Use the retained per-batch observations, exact image-hash coverage, and typed editEffect evidence to judge the complete request. Eligible editEffect checks establish exact protected physical placements, unchanged routes, retained placements, and measured objective-count changes; do not require a camera to re-prove those exact facts. They do not establish aesthetic quality. A criterion passes only when the collective evidence establishes it and no batch found a contradiction. An uncertain local batch does not veto evidence established by another camera or typed evidence, but unresolved collective uncertainty remains uncertain. Return only the requested JSON. Do not claim independent acceptance or engine verification.`;

const REGION_EDIT_EXTRACTION_BATCH_SCHEMA = z
  .object({
    objectives: z.array(REGION_EDIT_OBJECTIVE_SCHEMA),
    unresolvedRequirements: z.array(z.string().trim().min(1)),
  })
  .strict();

/** Partition linked model work by the serialized transport request, never by logical objective count. */
export function partitionLinkedTextRequests(
  source: string,
  fits: (candidate: string) => boolean,
): string[] {
  if (!source.length) throw new Error("Linked request source text must not be empty");
  if (fits(source)) return [source];
  const boundaries = [0];
  for (const match of source.matchAll(/(?:\n+|[.!?]+[\]})"']*\s+)/gu))
    boundaries.push(match.index + match[0].length);
  if (boundaries.at(-1) !== source.length) boundaries.push(source.length);
  const units = boundaries.slice(1).map((end, index) => source.slice(boundaries[index], end));
  const chunks: string[] = [];
  let pending = "";
  const append = (unit: string) => {
    if (pending && fits(pending + unit)) {
      pending += unit;
      return;
    }
    if (pending) chunks.push(pending);
    pending = "";
    if (fits(unit)) {
      pending = unit;
      return;
    }
    const characters = [...unit];
    let cursor = 0;
    while (cursor < characters.length) {
      let low = 1,
        high = characters.length - cursor,
        accepted = 0;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        if (fits(characters.slice(cursor, cursor + middle).join(""))) {
          accepted = middle;
          low = middle + 1;
        } else high = middle - 1;
      }
      if (!accepted)
        throw new Error("The execution policy cannot fit any source text in one model request");
      let length = accepted;
      if (cursor + accepted < characters.length) {
        const candidate = characters.slice(cursor, cursor + accepted).join("");
        const whitespace = Math.max(candidate.lastIndexOf(" "), candidate.lastIndexOf("\n"));
        if (whitespace >= 0) length = [...candidate.slice(0, whitespace + 1)].length;
      }
      chunks.push(characters.slice(cursor, cursor + length).join(""));
      cursor += length;
    }
  };
  for (const unit of units) append(unit);
  if (pending) chunks.push(pending);
  if (chunks.join("") !== source) throw new Error("Linked request partition changed source text");
  return chunks;
}

const LANDSCAPE_RULES = `Compose land coverage after the structural layout. Named planting areas are editing domains, while habitatFieldId identifies continuous vegetation structure across neighboring domains. Reuse a habitatFieldId where the same woodland or meadow crosses an edit boundary. Author wavelength, edge transition, density floor and contrast from the requested composition; they are not universal constants. Distinguish tree-free space from bare ground: an open meadow can retain ground cover while excluding canopy and understory. Every clearing explicitly names affected layers. Use full-layer exclusions only for paths, activity space and deliberately bare ground. When an activity-space terrain patch also excludes vegetation, reuse its complete horizontal mask so plants and material share one edge. Use organic masks for natural clearings and hard masks only where a deliberately geometric boundary is intended. Ground-cover caps must account for measured patch area; tiny accents do not replace broad cover. placementOrder controls competition, and measured projected size resolves order within each class. Choose a coherent height hierarchy from the measured catalog. Match density to the requested landscape; do not turn every natural scene into a uniform border around empty ground. The sampled landscape evidence is diagnostic rather than an aesthetic score. Inspect broad continuity and local clumping in the images.`;

interface RegionCapture {
  images: readonly { dataUrl: string; hash: string }[];
  evidence: unknown;
}

export interface RegionRunOptions {
  root: string;
  output: string;
  prompt: string;
  /** Creator/evaluation-owned seed for generation. Edits inherit the verified base plan seed. */
  generationSeed?: number;
  authority: Authority;
  planner: WorldPlanner;
  profile: RegionAuthoringProfile;
  base?: { plan: SpatialWorldPlan; world: WorldBuild };
  executionPolicy: RegionExecutionPolicy;
  onProgress?: (message: string) => void;
  capture?: (input: {
    folder: string;
    plan: SpatialWorldPlan;
    world: WorldBuild;
    cameras?: SpatialWorldPlan["cameras"];
    timeoutMilliseconds: number;
  }) => Promise<RegionCapture>;
}

export const REGION_EXECUTION_POLICY_SCHEMA = z
  .object({
    policyId: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u),
    origin: z.string().trim().min(1),
    maximumSemanticAttempts: z.number().int().positive().safe(),
    maximumMalformedReviewRetries: z.number().int().nonnegative().safe(),
    refinementIterationAllocation: z.number().int().positive().safe(),
    requestTimeoutMilliseconds: z.number().int().positive().safe(),
    previewTimeoutMilliseconds: z.number().int().positive().safe(),
    reviewImageBatchSize: z.number().int().positive().safe(),
    placementGeometryCacheMaximumBytes: z.number().int().positive().safe(),
    workspace: z
      .object({
        maximumArtifactBytes: z.number().int().positive().safe(),
        maximumPreviewImageBytes: z.number().int().positive().safe(),
        maximumEnvironmentFileBytes: z.number().int().positive().safe(),
      })
      .strict(),
    transport: z
      .object({
        origin: z.string().trim().min(1),
        maximumOutputTokensPerRequest: z.number().int().positive().safe(),
        outputTokenAllocations: z
          .object({
            layout: z.number().int().positive().safe(),
            planting: z.number().int().positive().safe(),
            editExtraction: z.number().int().positive().safe(),
            editProposal: z.number().int().positive().safe(),
            visualReview: z.number().int().positive().safe(),
            visualSynthesis: z.number().int().positive().safe(),
          })
          .strict(),
        maximumTextRequestBytes: z.number().int().positive().safe(),
        maximumResponseBytes: z.number().int().positive().safe(),
        providerSort: z.enum(["price", "throughput", "latency"]),
        maximumTransientRetries: z.number().int().nonnegative().safe(),
        maximumRetryDelayMilliseconds: z.number().int().nonnegative().safe(),
        retryableHttpStatuses: z
          .array(z.number().int().min(400).max(599))
          .superRefine((values, context) => {
            if (new Set(values).size !== values.length)
              context.addIssue({
                code: "custom",
                message: "Retryable HTTP statuses must be unique",
              });
          })
          .readonly(),
      })
      .strict()
      .superRefine((value, context) => {
        for (const [purpose, allocation] of Object.entries(value.outputTokenAllocations))
          if (allocation > value.maximumOutputTokensPerRequest)
            context.addIssue({
              code: "custom",
              path: ["outputTokenAllocations", purpose],
              message: "Purpose allocation exceeds the per-request transport ceiling",
            });
      }),
    preview: z
      .object({
        policyId: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u),
        origin: z.string().trim().min(1),
        maximumTerrainVertices: z.number().int().positive().safe(),
        terrainSampleSpacingMeters: z.number().finite().positive(),
        imageWidthPixels: z.number().int().positive().safe(),
        imageHeightPixels: z.number().int().positive().safe(),
        deviceScaleFactor: z.number().finite().positive(),
      })
      .strict(),
    vegetation: z
      .object({
        policyId: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u),
        origin: z.string().trim().min(1),
        candidateBatchSize: z.number().int().positive().safe(),
        mergeFanIn: z.number().int().min(2).safe(),
        candidateRunDirectory: z.string().trim().min(1),
        maximumCandidateEvaluations: z.number().int().positive().safe().optional(),
      })
      .strict(),
    population: z
      .object({
        policyId: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u),
        origin: z.string().trim().min(1),
        minimumCandidateAttempts: z.number().int().positive().safe(),
        candidateAttemptsPerTarget: z.number().int().positive().safe(),
        pointPlacementCandidateAttempts: z.number().int().positive().safe(),
      })
      .strict(),
    assembly: z
      .object({
        policyId: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u),
        origin: z.string().trim().min(1),
        maximumDecisions: z.number().int().positive().safe(),
        maximumBacktracks: z.number().int().nonnegative().safe(),
      })
      .strict(),
    construction: z
      .object({
        policyId: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u),
        origin: z.string().trim().min(1),
        maximumConstructedElements: z.number().int().positive().safe(),
      })
      .strict(),
    landscapeEvidence: z
      .object({
        columns: z.number().int().positive().safe(),
        rows: z.number().int().positive().safe(),
        tileColumns: z.number().int().positive().safe(),
        tileRows: z.number().int().positive().safe(),
      })
      .strict()
      .refine(
        (value) => value.columns % value.tileColumns === 0 && value.rows % value.tileRows === 0,
        "Landscape evidence dimensions must divide evenly into their diagnostic tiles",
      ),
  })
  .strict();
export type RegionExecutionPolicy = z.output<typeof REGION_EXECUTION_POLICY_SCHEMA>;
type PlannerPurpose = keyof RegionExecutionPolicy["transport"]["outputTokenAllocations"];

export async function runRegionAuthoring(options: RegionRunOptions) {
  const { root, output, prompt, authority, planner } = options;
  if (!prompt.trim()) throw new Error("Prompt must contain non-whitespace text");
  const profile = REGION_AUTHORING_PROFILE_SCHEMA.parse(options.profile);
  const executionPolicy = REGION_EXECUTION_POLICY_SCHEMA.parse(options.executionPolicy);
  if (options.base && options.generationSeed !== undefined)
    throw new Error("Edits inherit the verified base plan seed and cannot replace it");
  const generationSeed = options.base
    ? null
    : z.number().int().nonnegative().safe().parse(options.generationSeed);
  const layoutResponseSchema =
    generationSeed === null
      ? null
      : REGION_LAYOUT_DRAFT_SCHEMA.extend({ seed: z.literal(generationSeed) });
  const writeRun = (path: string, value: unknown) =>
    write(root, path, value, executionPolicy.workspace.maximumArtifactBytes);
  if (profile.catalogSnapshotHash !== authority.catalog.snapshot.hash)
    throw new Error("Authoring profile binds a stale catalog snapshot; prepare it again");
  try {
    await lstat(resolve(root, output));
    throw new Error("Output directory must be absent; retained runs cannot be overwritten");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const start = performance.now();
  const elapsed = () => (performance.now() - start) / 1000;
  const mode = options.base ? "edit" : "generate";
  const policy = options.base
    ? regionEditPolicy(options.base.plan, profile, executionPolicy.refinementIterationAllocation)
    : undefined;
  const manifest = {
    prompt,
    mode,
    provider: planner.providerId,
    model: planner.model,
    transportConfiguration: planner.configuration ?? null,
    executionPolicy,
    seed: options.base?.plan.seed ?? generationSeed,
    startedAt: new Date().toISOString(),
    catalogHash: authority.catalog.hash,
    profile,
    basePlanHash: options.base?.plan.planHash ?? null,
    baseWorldBuildHash: options.base?.world.worldBuildHash ?? null,
  };
  await writeRun(`${output}/request.json`, manifest);
  if (options.base) {
    await writeRun(`${output}/base-plan.json`, options.base.plan);
    await writeRun(`${output}/base-world.json`, options.base.world);
    await writeRun(`${output}/edit-policy.json`, policy);
  }
  const attempts: Array<Record<string, unknown>> = [];
  let feedback: unknown = null;
  let previousLayout: z.output<typeof REGION_LAYOUT_DRAFT_SCHEMA> | null = null;
  let previousLayoutAttempt: number | null = null;
  let reuseLayoutForNextAttempt = false;
  let previousPlanting: unknown = null;
  let previousProposal: unknown = null;
  let final: { plan: SpatialWorldPlan; world: WorldBuild } | undefined;
  let modelCalls = 0;
  let beforeCapture: RegionCapture | undefined;
  let repairCapture: RegionCapture | undefined;
  let editRequest: RegionEditRequest | undefined;
  let editEvidenceCameras: SpatialWorldPlan["cameras"] | undefined;
  const seenProposalHashes = new Set<string>();
  const seenFailureHashes = new Set<string>();
  const phasePerformance: Array<Record<string, unknown>> = [];
  const capture =
    options.capture ?? ((input) => captureRegionPreview(root, input, executionPolicy));
  const progress = (message: string) => options.onProgress?.(`${elapsed().toFixed(1)}s ${message}`);
  const buildModelRequest = (
    purpose: PlannerPurpose,
    schema: z.ZodType,
    system: string,
    context: unknown,
    images: readonly { dataUrl: string; hash: string }[],
  ) => {
    const jsonSchema = z.toJSONSchema(schema, { unrepresentable: "any" }) as Record<
      string,
      unknown
    >;
    return {
      system: `${system}\nWhen feedback is present, repair its concrete failures while preserving required user content. Do not repeat an unchanged invalid proposal. Compiler evidence describes what was actually placed; supplied repair images may show a partial, rejected scene.\nThe exact output JSON Schema follows. Use these field names and required values; do not invent a different JSON shape.\n${stableJson(jsonSchema)}`,
      prompt: stableJson(context),
      schema: jsonSchema,
      imageHashes: images.map((image) => image.hash),
      maxOutputTokens: executionPolicy.transport.outputTokenAllocations[purpose],
      purpose,
      transportConfiguration: planner.configuration ?? null,
    };
  };
  const call = async (
    folder: string,
    phase: string,
    purpose: PlannerPurpose,
    schema: z.ZodType,
    system: string,
    context: unknown,
    images: readonly { dataUrl: string; hash: string }[] = [],
  ) => {
    const request = buildModelRequest(purpose, schema, system, context, images);
    const requestBytes = Buffer.byteLength(stableJson(request), "utf8");
    if (requestBytes > executionPolicy.transport.maximumTextRequestBytes)
      throw new Error(
        `${executionPolicy.policyId} exhausted its ${executionPolicy.transport.maximumTextRequestBytes}-byte model text-request allocation with a ${requestBytes}-byte ${phase} request; the run is incomplete`,
      );
    await writeRun(`${folder}/${phase}-request.json`, request);
    modelCalls++;
    const before = elapsed();
    progress(`Requesting ${phase}`);
    let result;
    try {
      result = await planner.complete({
        ...request,
        images,
        signal: AbortSignal.timeout(executionPolicy.requestTimeoutMilliseconds),
      });
    } catch (error) {
      await writeRun(`${folder}/${phase}-failure.json`, {
        ...(error instanceof WorldPlannerResponseError
          ? error.receipt
          : { model: planner.model, usage: null }),
        provider: planner.providerId,
        upstreamProvider:
          error instanceof WorldPlannerResponseError
            ? (error.receipt.upstreamProvider ?? null)
            : null,
        transportConfiguration: planner.configuration ?? null,
        requestHash: contentHash(stableJson(request)),
        failure: String(error),
        elapsedSeconds: elapsed(),
        durationSeconds: elapsed() - before,
      });
      throw error;
    }
    await writeRun(`${folder}/${phase}-receipt.json`, {
      model: result.model,
      provider: planner.providerId,
      upstreamProvider: result.upstreamProvider ?? null,
      transportConfiguration: planner.configuration ?? null,
      usage: result.usage,
      raw: result.raw,
      output: result.output,
      transportFailures: result.transportFailures ?? [],
      requestHash: contentHash(stableJson(request)),
      elapsedSeconds: elapsed(),
      durationSeconds: elapsed() - before,
    });
    phasePerformance.push({
      phase,
      durationSeconds: elapsed() - before,
      model: result.model,
      provider: planner.providerId,
      upstreamProvider: result.upstreamProvider ?? null,
      transportConfiguration: planner.configuration ?? null,
      usage: result.usage,
      transportFailures: result.transportFailures ?? [],
    });
    return schema.parse(result.output) as unknown;
  };
  const reviewRegionEvidence = async (input: {
    folder: string;
    prompt: string;
    mode: "generate" | "edit";
    plan: SpatialWorldPlan;
    world: WorldBuild;
    captured: RegionCapture;
    beforeCapture?: RegionCapture;
    editEffect?: ReturnType<typeof regionEditEffect>;
  }): Promise<z.output<typeof visualResponse>> => {
    const vegetationIntentIds = new Set(
      input.plan.realizationIntents.flatMap((intent) =>
        intent.kind === "surface_scatter" && intent.vegetation ? [intent.intentId] : [],
      ),
    );
    const routeConstructions = input.world.foundation.routeConstructions.map((route, index) => {
      const boundsMeters = route.travelSegments.reduce<
        | {
            min: { x: number; y: number; z: number };
            max: { x: number; y: number; z: number };
          }
        | undefined
      >((bounds, segment) => {
        if (!bounds) return structuredClone(segment.boundsMeters);
        return {
          min: {
            x: Math.min(bounds.min.x, segment.boundsMeters.min.x),
            y: Math.min(bounds.min.y, segment.boundsMeters.min.y),
            z: Math.min(bounds.min.z, segment.boundsMeters.min.z),
          },
          max: {
            x: Math.max(bounds.max.x, segment.boundsMeters.max.x),
            y: Math.max(bounds.max.y, segment.boundsMeters.max.y),
            z: Math.max(bounds.max.z, segment.boundsMeters.max.z),
          },
        };
      }, undefined);
      return {
        routeId: route.routeId,
        status: route.status,
        routeConstructionHash: route.hash,
        widthMeters: route.widthMeters,
        maximumGradeRatio: route.maximumGradeRatio,
        maximumObservedGradeRatio: Math.max(
          0,
          ...route.travelSegments.map((segment) => Math.abs(segment.gradeRatio)),
        ),
        travelSurface: {
          segmentCount: route.travelSegments.length,
          hash: contentHash(stableJson(route.travelSegments)),
          boundsMeters: boundsMeters ?? null,
          localEvidenceReference: `${input.folder}/world-build.json#/foundation/routeConstructions/${index}/travelSegments`,
        },
      };
    });
    const compilerEvidence = {
      worldBuildHash: input.world.worldBuildHash,
      status: input.world.status,
      staticInstances: input.world.instances
        .filter((instance) => !vegetationIntentIds.has(instance.intentId))
        .map((instance) => ({
          intentId: instance.intentId,
          entryHandle: instance.entryHandle,
          assetHash: instance.assetHash,
          regionId: instance.regionId,
          surfaceId: instance.surfaceId,
          transformMeters: instance.transformMeters,
          boundsMeters: instance.boundsMeters,
        })),
      routes: input.plan.routes.map((route) => ({
        routeId: route.routeId,
        semanticEntityId: route.semanticEntityId,
        widthMeters: route.widthMeters,
        alignmentMeters: route.alignmentMeters,
        closed: route.closed,
      })),
      routeJunctions: input.plan.routeJunctions,
      routeConstructions,
      constructedStructures: input.world.meso.constructedStructures,
      constructedSurfaces: input.world.meso.constructedSurfaces,
      population: regionPopulationEvidence(input.plan, input.world),
      landscape: regionLandscapeEvidence(
        input.plan,
        input.world,
        executionPolicy.landscapeEvidence,
      ),
      evidenceCompleteness: "complete_locally_summarized_for_transport" as const,
      omittedEvidence: routeConstructions.map((route) => ({
        kind: "route_segment_vertices" as const,
        routeId: route.routeId,
        segmentCount: route.travelSurface.segmentCount,
        retainedHash: route.travelSurface.hash,
        localEvidenceReference: route.travelSurface.localEvidenceReference,
        reason:
          "Exact deterministic tessellation is retained locally; review receives its hash, total bounds, segment count, grade summary and authored alignment.",
      })),
      completeLocalEvidenceRetained: true as const,
    };
    const batches: Array<{
      images: readonly { dataUrl: string; hash: string }[];
      cameraIndexes: number[];
    }> = [];
    if (input.mode === "edit") {
      if (!input.beforeCapture) throw new Error("Edit review requires matched before evidence");
      if (input.beforeCapture.images.length !== input.captured.images.length)
        throw new Error("Edit review requires the same camera count before and after");
      if (executionPolicy.reviewImageBatchSize < 2)
        throw new Error("Edit review image batches must hold one matched before/after pair");
      const camerasPerBatch = Math.max(1, Math.floor(executionPolicy.reviewImageBatchSize / 2));
      for (let first = 0; first < input.captured.images.length; first += camerasPerBatch) {
        const after = input.captured.images.slice(first, first + camerasPerBatch);
        const before = input.beforeCapture.images.slice(first, first + camerasPerBatch);
        batches.push({
          images: [...before, ...after],
          cameraIndexes: after.map((_, index) => first + index),
        });
      }
    } else {
      for (
        let first = 0;
        first < input.captured.images.length;
        first += executionPolicy.reviewImageBatchSize
      ) {
        const images = input.captured.images.slice(
          first,
          first + executionPolicy.reviewImageBatchSize,
        );
        batches.push({
          images,
          cameraIndexes: images.map((_, index) => first + index),
        });
      }
    }
    const allImageHashes = [
      ...(input.beforeCapture?.images.map((image) => image.hash) ?? []),
      ...input.captured.images.map((image) => image.hash),
    ];
    const judgments: z.output<typeof visualResponse>[] = [];
    for (const [batchIndex, batch] of batches.entries()) {
      let judgment: z.output<typeof visualResponse> | undefined;
      let malformed: unknown;
      for (let retry = 0; retry <= executionPolicy.maximumMalformedReviewRetries; retry++) {
        try {
          judgment = visualResponse.parse(
            await call(
              input.folder,
              `review-${batchIndex + 1}-try-${retry + 1}`,
              "visualReview",
              visualResponse,
              REVIEW_BATCH_RULES,
              {
                prompt: input.prompt,
                mode: input.mode,
                reviewBatch: {
                  index: batchIndex + 1,
                  count: batches.length,
                  cameraIndexes: batch.cameraIndexes,
                  suppliedImageHashes: batch.images.map((image) => image.hash),
                  omittedImageHashes: allImageHashes.filter(
                    (hash) => !batch.images.some((image) => image.hash === hash),
                  ),
                },
                compilerEvidence,
                editRequest: editRequest ?? null,
                editEffect: input.editEffect ?? null,
                beforeEvidence: input.beforeCapture?.evidence ?? null,
                afterEvidence: input.captured.evidence,
              },
              batch.images,
            ),
          );
          break;
        } catch (error) {
          const isMalformed =
            error instanceof z.ZodError ||
            (error instanceof WorldPlannerResponseError &&
              /invalid JSON|did not complete one JSON response/u.test(error.message));
          if (!isMalformed || retry === executionPolicy.maximumMalformedReviewRetries) throw error;
          malformed = String(error);
        }
      }
      if (!judgment)
        throw new Error(`Review batch ${batchIndex + 1} remained malformed: ${String(malformed)}`);
      judgments.push(judgment);
    }
    let synthesis: z.output<typeof visualResponse> | undefined;
    let malformedSynthesis: unknown;
    for (let retry = 0; retry <= executionPolicy.maximumMalformedReviewRetries; retry++) {
      try {
        synthesis = visualResponse.parse(
          await call(
            input.folder,
            `review-synthesis-try-${retry + 1}`,
            "visualSynthesis",
            visualResponse,
            REVIEW_SYNTHESIS_RULES,
            {
              prompt: input.prompt,
              mode: input.mode,
              imageCoverage: {
                completeImageHashes: allImageHashes,
                batches: batches.map((batch, index) => ({
                  index: index + 1,
                  cameraIndexes: batch.cameraIndexes,
                  imageHashes: batch.images.map((image) => image.hash),
                })),
                omissions: [],
              },
              batchJudgments: judgments.map((judgment, index) => ({
                batch: index + 1,
                judgment,
              })),
              compilerEvidence,
              editRequest: editRequest ?? null,
              editEffect: input.editEffect ?? null,
            },
          ),
        );
        break;
      } catch (error) {
        const isMalformed =
          error instanceof z.ZodError ||
          (error instanceof WorldPlannerResponseError &&
            /invalid JSON|did not complete one JSON response/u.test(error.message));
        if (!isMalformed || retry === executionPolicy.maximumMalformedReviewRetries) throw error;
        malformedSynthesis = String(error);
      }
    }
    if (!synthesis)
      throw new Error(`Review synthesis remained malformed: ${String(malformedSynthesis)}`);
    return synthesis;
  };
  const compileInput = async (plan: SpatialWorldPlan) => ({
    semanticModule: authority.semanticModule,
    catalogSnapshot: authority.catalog.snapshot,
    catalogAssets: authority.measurements.assets,
    spatialPlan: plan,
    executionPolicy: {
      construction: executionPolicy.construction,
      vegetation: {
        policyId: executionPolicy.vegetation.policyId,
        origin: executionPolicy.vegetation.origin,
        candidateBatchSize: executionPolicy.vegetation.candidateBatchSize,
        mergeFanIn: executionPolicy.vegetation.mergeFanIn,
        candidateRunDirectory: executionPolicy.vegetation.candidateRunDirectory,
        ...(executionPolicy.vegetation.maximumCandidateEvaluations === undefined
          ? {}
          : {
              maximumCandidateEvaluations: executionPolicy.vegetation.maximumCandidateEvaluations,
            }),
      },
      population: executionPolicy.population,
      assembly: executionPolicy.assembly,
    },
    placementGeometry: await prepareWorldPlacementGeometry({
      root,
      plan,
      semanticModule: authority.semanticModule,
      snapshot: authority.catalog.snapshot,
      assets: authority.measurements.assets,
      sourceManifest: authority.catalog.sourceManifest,
      cacheMaximumBytes: executionPolicy.placementGeometryCacheMaximumBytes,
    }),
  });
  if (options.base) {
    const replay = compileBasaltWorld(await compileInput(options.base.plan));
    if (replay.worldBuildHash !== options.base.world.worldBuildHash || replay.status !== "eligible")
      throw new Error("Edit base does not replay against the current catalog and compiler");
    const beforeFolder = `${output}/before`;
    await writeRun(`${beforeFolder}/spatial-plan.json`, options.base.plan);
    await writeRun(`${beforeFolder}/world-build.json`, options.base.world);
    const extractionSystem =
      "Extract every distinct creator edit objective from this linked source-text batch. sourceText must copy an exact span from suppliedSourceText. Bind vegetation objectives to available area IDs. Include every creator-requested layer even when the supplied area currently has zero instances or no authored intent for that layer: a clearing or density decrease can already be satisfied at that lower bound, while a density increase still requires an authored layer. Express an entire area with whole_areas, a named compass portion such as northern woodland with directional_areas, and a place around verified objects with around_intents using every supplied anchor intent that identifies that place. An around_intents target does not require creator-supplied coordinates, and its vegetation area may be adjacent to the protected objects because clearings often sit between planted polygons. The schema explicitly supports vegetation_clearing objectives: use kind vegetation_clearing with change expand for a requested wider/larger/opened existing clearing, and change create for a new clearing. Every clearing must set transitionRequirement: soft or hard when the creator explicitly requests that boundary behavior, otherwise unspecified. Use vegetation_density only for a density increase or decrease that is distinct from creating or expanding a clearing. Bind terrain objectives to an existing paint operation and an allowed material. Report only genuinely unrepresentable requirements in unresolvedRequirements; never call a field absent when it appears in the supplied schema. A batch may contain no objective. Do not invent area or intent IDs, targets, or requirements, and do not assume another batch handled an objective visible here. Preservation is applied deterministically after extraction.";
    const extractionContext = regionEditContext(
      options.base.plan,
      options.base.world,
      policy!,
      executionPolicy.landscapeEvidence,
    );
    const extractionInput = (
      suppliedSourceText: string,
      index: number,
      count: number,
      previousExtraction: z.output<typeof REGION_EDIT_EXTRACTION_BATCH_SCHEMA> | null = null,
      previousFailure: string | null = null,
    ) => ({
      completePromptHash: contentHash(prompt),
      linkedBatch: { index, count },
      suppliedSourceText,
      context: extractionContext,
      imageEvidence: null,
      previousExtraction,
      repairInstruction: previousExtraction
        ? `The previous extraction failed deterministic validation: ${previousFailure}. Re-check every objective against the supplied area, layer, object, terrain-operation, and material evidence. Correct wrong supported kinds and references. Preserve only truly unsupported requirements as unresolved.`
        : null,
    });
    const extractionBatches = partitionLinkedTextRequests(
      prompt,
      (candidate) =>
        Buffer.byteLength(
          stableJson(
            buildModelRequest(
              "editExtraction",
              REGION_EDIT_EXTRACTION_BATCH_SCHEMA,
              extractionSystem,
              extractionInput(candidate, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
              [],
            ),
          ),
          "utf8",
        ) <= executionPolicy.transport.maximumTextRequestBytes,
    );
    const assembleEditRequest = (
      batches: readonly z.output<typeof REGION_EDIT_EXTRACTION_BATCH_SCHEMA>[],
    ) => {
      const objectiveByEvidence = new Map<string, z.output<typeof REGION_EDIT_OBJECTIVE_SCHEMA>>();
      const evidenceByObjectiveId = new Map<string, string>();
      for (const objective of batches.flatMap((batch) => batch.objectives)) {
        const { objectiveId: proposedId, ...evidence } = objective;
        const identity = stableJson(evidence);
        if (objectiveByEvidence.has(identity)) continue;
        const objectiveId =
          evidenceByObjectiveId.has(proposedId) &&
          evidenceByObjectiveId.get(proposedId) !== identity
            ? `EditObjective_${contentHash(identity).slice(0, 40)}`
            : proposedId;
        if (
          evidenceByObjectiveId.has(objectiveId) &&
          evidenceByObjectiveId.get(objectiveId) !== identity
        )
          throw new Error("Linked objective identity collision");
        evidenceByObjectiveId.set(objectiveId, identity);
        objectiveByEvidence.set(identity, { ...evidence, objectiveId });
      }
      const extracted = REGION_EDIT_REQUEST_DRAFT_SCHEMA.parse({
        objectives: [...objectiveByEvidence.values()],
        unresolvedRequirements: [
          ...new Set(batches.flatMap((batch) => batch.unresolvedRequirements)),
        ],
        preservation: {
          exactIntentIds: policy!.protectedIntentIds,
          exactRouteIds: options.base!.plan.routes.map((route) => route.routeId),
          preservePopulationOutsideRegenerationMasks: true,
        },
      });
      return sealRegionEditRequest({
        prompt,
        basePlanHash: options.base!.plan.planHash,
        baseWorldBuildHash: options.base!.world.worldBuildHash,
        draft: extracted,
      });
    };
    let previousExtractions: z.output<typeof REGION_EDIT_EXTRACTION_BATCH_SCHEMA>[] = [];
    let extractionFailure: string | null = null;
    let extractionResourceExhaustion: WorldPlannerResourceExhaustion | undefined;
    let previousExtractionStateHash: string | undefined;
    let rejectedEditRequest: RegionEditRequest | undefined;
    for (let attempt = 1; attempt <= executionPolicy.maximumSemanticAttempts; attempt++) {
      const extractedBatches: z.output<typeof REGION_EDIT_EXTRACTION_BATCH_SCHEMA>[] = [];
      try {
        for (const [index, suppliedSourceText] of extractionBatches.entries()) {
          const phaseBase =
            extractionBatches.length === 1 ? "extract" : `extract-batch-${index + 1}`;
          extractedBatches.push(
            REGION_EDIT_EXTRACTION_BATCH_SCHEMA.parse(
              await call(
                `${output}/edit-request`,
                attempt === 1 ? phaseBase : `${phaseBase}-repair-${attempt}`,
                "editExtraction",
                REGION_EDIT_EXTRACTION_BATCH_SCHEMA,
                extractionSystem,
                extractionInput(
                  suppliedSourceText,
                  index + 1,
                  extractionBatches.length,
                  previousExtractions[index] ?? null,
                  extractionFailure,
                ),
              ),
            ),
          );
        }
      } catch (error) {
        if (error instanceof WorldPlannerResponseError && error.receipt.resourceExhaustion) {
          extractionFailure = error.message;
          extractionResourceExhaustion = error.receipt.resourceExhaustion;
          break;
        }
        throw error;
      }
      try {
        const candidate = assembleEditRequest(extractedBatches);
        rejectedEditRequest = candidate;
        if (candidate.unresolvedRequirements.length)
          throw new Error(
            `Unresolved creator requirements: ${candidate.unresolvedRequirements.join("; ")}`,
          );
        validateRegionEditTargets(candidate, options.base.plan);
        editRequest = candidate;
        break;
      } catch (error) {
        extractionFailure =
          error instanceof z.ZodError
            ? JSON.stringify(error.issues)
            : String(error instanceof Error ? error.message : error);
        const stateHash = contentHash(stableJson({ extractedBatches, extractionFailure }));
        if (stateHash === previousExtractionStateHash) break;
        previousExtractionStateHash = stateHash;
        previousExtractions = extractedBatches;
      }
    }
    if (!editRequest) {
      if (rejectedEditRequest)
        await writeRun(`${output}/edit-request/rejected-request.json`, rejectedEditRequest);
      await writeRun(`${output}/edit-request/failure.json`, {
        status: "incomplete",
        failure: extractionFailure ?? "Edit objective extraction produced no result",
        attemptsAllocated: executionPolicy.maximumSemanticAttempts,
        policyId: executionPolicy.policyId,
        resourceExhaustion: extractionResourceExhaustion ?? null,
      });
      const report = {
        status: "incomplete" as const,
        mode,
        prompt,
        seed: options.base.plan.seed,
        worldBuildHash: null,
        elapsedSeconds: elapsed(),
        modelCalls,
        attempts: [],
        independentReview: false,
        creatorAccepted: false,
        engineVerified: false,
        executionPolicy,
        phasePerformance,
        beforeCapture: null,
        resourceExhaustions: extractionResourceExhaustion ? [extractionResourceExhaustion] : [],
      };
      await writeRun(`${output}/report.json`, report);
      return report;
    }
    await writeRun(`${output}/edit-request.json`, editRequest);
    editEvidenceCameras = regionEditEvidenceCameras(
      editRequest,
      options.base.plan,
      options.base.world,
      profile.evidenceCameraFieldOfViewDegrees,
    );
    progress("Capturing matched base evidence for every edit objective and protected route");
    beforeCapture = await capture({
      folder: beforeFolder,
      ...options.base,
      cameras: editEvidenceCameras,
      timeoutMilliseconds: executionPolicy.previewTimeoutMilliseconds,
    });
    if (!beforeCapture.images.length) throw new Error("Edit comparison requires before images");
  }
  let stopAfterAttempt = false;
  for (let attempt = 1; attempt <= executionPolicy.maximumSemanticAttempts; attempt++) {
    const folder = `${output}/attempts/${attempt}`;
    const event: Record<string, unknown> = { attempt, startedSeconds: elapsed() };
    let generationFailureStage: "layout" | "planting" | "downstream" | null = null;
    try {
      let plan: SpatialWorldPlan, world: WorldBuild;
      let appliedChanges: readonly WorldChange[] = [];
      let regionProposal: RegionEditProposal | undefined;
      let populationConstraints: PopulationPlacementConstraints | undefined;
      if (options.base) {
        const base = options.base;
        const proposalSystem =
          "Implement every objective in this linked request batch with grouped semantic operations. Address areas and layers rather than enumerating species intents. For density, author one nonnegative populationDensityMultiplier: greater than 1 increases density, between 0 and 1 decreases it, and 0 excludes the selected layers inside the resolved target while retaining them outside it. The deterministic compiler derives candidate density, spacing, count, or a target-local layer exclusion and applies the supplied resolved spatial targets. Clearing operations must stay inside a whole/directional target, or contain the verified anchor/baseline bounds for an around_intents target. An expand clearing must strictly contain and enlarge baselineClearingBounds. Author its horizontal mask and falloff in meters from the requested shape and transition; use an organic mask for a natural boundary and a hard mask only for an intentionally geometric edge. Ground material operations may replace only the requested existing paint target. Do not change routes, structures, props, terrain elevation, or content outside regeneration masks. The batches jointly implement one logical RegionEditRequest; there is no logical operation-count limit.";
        const proposalContext = (
          objectives: RegionEditRequest["objectives"],
        ): Record<string, unknown> => {
          const objectiveIds = new Set(objectives.map((objective) => objective.objectiveId));
          return {
            prompt,
            linkedRequest: {
              requestHash: editRequest!.hash,
              basePlanHash: editRequest!.basePlanHash,
              baseWorldBuildHash: editRequest!.baseWorldBuildHash,
              objectives,
              preservation: editRequest!.preservation,
            },
            context: regionEditContext(
              base.plan,
              base.world,
              policy!,
              executionPolicy.landscapeEvidence,
            ),
            resolvedSpatialTargets: regionEditTargetEvidence(objectives, base.plan, base.world),
            beforeImages: beforeCapture?.evidence,
            repairImages: repairCapture?.evidence ?? null,
            feedback,
            previousProposal:
              previousProposal && typeof previousProposal === "object"
                ? {
                    ...(previousProposal as Record<string, unknown>),
                    operations: Array.isArray(
                      (previousProposal as { operations?: unknown }).operations,
                    )
                      ? (
                          previousProposal as {
                            operations: Array<{ objectiveIds?: unknown }>;
                          }
                        ).operations.filter(
                          (operation) =>
                            Array.isArray(operation.objectiveIds) &&
                            operation.objectiveIds.some(
                              (objectiveId) =>
                                typeof objectiveId === "string" && objectiveIds.has(objectiveId),
                            ),
                        )
                      : [],
                  }
                : null,
          };
        };
        const fitsProposalRequest = (objectives: RegionEditRequest["objectives"]) =>
          Buffer.byteLength(
            stableJson(
              buildModelRequest(
                "editProposal",
                regionEditResponseSchema(objectives),
                proposalSystem,
                proposalContext(objectives),
                [],
              ),
            ),
            "utf8",
          ) <= executionPolicy.transport.maximumTextRequestBytes;
        const groupedObjectives = new Map<string, RegionEditRequest["objectives"][number][]>();
        for (const objective of editRequest!.objectives) {
          const key =
            objective.kind === "terrain_material"
              ? stableJson({
                  kind: objective.kind,
                  terrainPlanId: objective.terrainPlanId,
                  operationIndex: objective.operationIndex,
                  requestedMaterialId: objective.requestedMaterialId,
                })
              : stableJson({
                  kind: objective.kind,
                  spatialTarget: objective.spatialTarget,
                  layers: objective.layers,
                  ...(objective.kind === "vegetation_density"
                    ? { direction: objective.direction }
                    : { change: objective.change }),
                });
          groupedObjectives.set(key, [...(groupedObjectives.get(key) ?? []), objective]);
        }
        const objectiveBatches: RegionEditRequest["objectives"][] = [];
        let pending: RegionEditRequest["objectives"][number][] = [];
        const flushPending = () => {
          if (pending.length) objectiveBatches.push(pending);
          pending = [];
        };
        for (const group of groupedObjectives.values()) {
          if (fitsProposalRequest([...pending, ...group])) {
            pending.push(...group);
            continue;
          }
          flushPending();
          if (fitsProposalRequest(group)) {
            pending.push(...group);
            continue;
          }
          for (const objective of group) {
            if (!fitsProposalRequest([objective]))
              throw new Error(
                `${executionPolicy.policyId} cannot fit objective ${objective.objectiveId} in one model request; the run is incomplete`,
              );
            if (!fitsProposalRequest([...pending, objective])) flushPending();
            pending.push(objective);
          }
        }
        flushPending();
        const drafts: RegionEditProposalDraft[] = [];
        for (const [batchIndex, objectives] of objectiveBatches.entries()) {
          const responseSchema = regionEditResponseSchema(objectives);
          drafts.push(
            responseSchema.parse(
              await call(
                folder,
                objectiveBatches.length === 1 ? "proposal" : `proposal-batch-${batchIndex + 1}`,
                "editProposal",
                responseSchema,
                proposalSystem,
                proposalContext(objectives),
              ),
            ),
          );
        }
        const operations = new Map<string, (typeof drafts)[number]["operations"][number]>();
        for (const operation of drafts.flatMap((draft) => draft.operations)) {
          const identity =
            operation.kind === "terrain_material"
              ? `${operation.kind}:${operation.terrainPlanId}:${operation.operationIndex}`
              : `${operation.kind}:${operation.areaId}:${[...operation.layers].sort().join(",")}:${
                  operation.kind === "vegetation_clearing"
                    ? stableJson({
                        mask: operation.mask,
                        verticalRangeMeters: operation.verticalRangeMeters,
                      })
                    : "density"
                }`;
          const previous = operations.get(identity);
          if (!previous) {
            operations.set(identity, operation);
            continue;
          }
          const withoutObjectives = (value: typeof operation) => {
            const { objectiveIds: _objectiveIds, ...parameters } = value;
            return parameters;
          };
          if (stableJson(withoutObjectives(previous)) !== stableJson(withoutObjectives(operation)))
            throw new Error(`Linked edit batches proposed conflicting parameters for ${identity}`);
          operations.set(identity, {
            ...previous,
            objectiveIds: [...new Set([...previous.objectiveIds, ...operation.objectiveIds])],
          });
        }
        const proposed = regionEditResponseSchema().parse({
          operations: [...operations.values()],
          rationale: drafts.map((draft) => draft.rationale).join(" "),
        });
        previousProposal = proposed;
        regionProposal = sealRegionEditProposal({
          request: editRequest!,
          draft: proposed,
          providerId: planner.providerId,
          providerImplementationHash: contentHash(
            stableJson({ model: planner.model, configuration: planner.configuration ?? null }),
          ),
        });
        if (seenProposalHashes.has(regionProposal.hash)) {
          stopAfterAttempt = true;
          throw new Error("The planner repeated an unchanged unsuccessful edit proposal");
        }
        seenProposalHashes.add(regionProposal.hash);
        const expanded = expandRegionEditProposal({
          request: editRequest!,
          proposal: regionProposal,
          plan: base.plan,
          world: base.world,
          catalogSnapshotHash: authority.catalog.snapshot.hash,
        });
        appliedChanges = [...expanded.changes];
        populationConstraints = expanded.constraints;
        await writeRun(`${folder}/region-edit-proposal.json`, regionProposal);
        await writeRun(`${folder}/population-placement-constraints.json`, populationConstraints);
        const proposal = sealWorldChangeProposal({
          rationale: regionProposal.rationale,
          changes: [...appliedChanges],
          basePlanHash: base.plan.planHash,
          baseWorldBuildHash: base.world.worldBuildHash,
          providerId: planner.providerId,
          providerImplementationHash: regionProposal.providerImplementationHash,
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
          prepareNextPlan: ({ plan: changedPlan, previousWorldBuild }) => {
            if (previousWorldBuild.worldBuildHash !== populationConstraints!.sourceWorldBuildHash)
              throw new Error("Population constraints bind stale edit-source evidence");
            const {
              kind: _kind,
              coordinateSystem: _coordinateSystem,
              planHash: _planHash,
              populationPlacementConstraints: _oldConstraints,
              ...body
            } = changedPlan;
            return sealSpatialWorldPlan({
              ...body,
              populationPlacementConstraints: populationConstraints,
            });
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
        await writeRun(`${folder}/refinement.json`, result.run);
        await writeRun(`${folder}/observation.json`, result.observation);
        event.refinementExecution = result.run.iterations.map((iteration) => ({
          index: iteration.index,
          requestedTaskIds: iteration.seedTaskIds,
          affectedTaskIds: iteration.affectedTaskIds,
          executedTaskIds: iteration.executedTaskIds,
          reusedTaskIds: iteration.reusedTaskIds,
        }));
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
        let layout: z.output<typeof REGION_LAYOUT_DRAFT_SCHEMA>;
        if (reuseLayoutForNextAttempt && previousLayout) {
          layout = previousLayout;
          const reuseEvidence = {
            sourceAttempt: previousLayoutAttempt,
            layoutHash: contentHash(stableJson(layout)),
            reason:
              "The preceding failure occurred while producing planting data; the verified layout was not regenerated.",
          };
          event.layoutReuse = reuseEvidence;
          await writeRun(`${folder}/layout-reuse.json`, reuseEvidence);
        } else {
          generationFailureStage = "layout";
          layout = REGION_LAYOUT_DRAFT_SCHEMA.parse(
            await call(
              folder,
              "layout",
              "layout",
              layoutResponseSchema!,
              `${PLANNING_RULES}\n${COMPOSITION_RULES}\nDesign terrain, destinations, routes, activity space and evidence cameras. Do not design natural background vegetation in this stage; only retain explicitly requested landmark vegetation or ordered planting as placements.`,
              {
                prompt,
                declaredSeed: generationSeed,
                context: regionPlanningContext(profile),
                feedback,
                previousLayout,
                repairImages: repairCapture?.evidence ?? null,
              },
            ),
          );
          previousLayout = layout;
          previousLayoutAttempt = attempt;
        }
        generationFailureStage = "planting";
        const planting = REGION_PLANTING_DRAFT_SCHEMA.parse(
          await call(
            folder,
            "planting",
            "planting",
            REGION_PLANTING_DRAFT_SCHEMA,
            LANDSCAPE_RULES,
            {
              prompt,
              context: regionPlanningContext(profile),
              fixedLayout: layout,
              feedback,
              previousPlanting,
              repairImages: repairCapture?.evidence ?? null,
            },
          ),
        );
        previousPlanting = planting;
        reuseLayoutForNextAttempt = false;
        generationFailureStage = "downstream";
        const proposed = composeRegionDraft(layout, planting);
        const proposalHash = contentHash(stableJson(proposed));
        if (seenProposalHashes.has(proposalHash)) {
          stopAfterAttempt = true;
          throw new Error("The planner repeated an unchanged unsuccessful region proposal");
        }
        seenProposalHashes.add(proposalHash);
        plan = realizeRegionDraft(profile, proposed);
        world = compileBasaltWorld(await compileInput(plan));
      }
      await writeRun(`${folder}/spatial-plan.json`, plan);
      await writeRun(`${folder}/world-build.json`, world);
      event.worldBuildHash = world.worldBuildHash;
      event.compilerStatus = world.status;
      event.compileFinishedSeconds = elapsed();
      event.instances = world.instances.length;
      event.population = regionPopulationEvidence(plan, world);
      event.landscape = regionLandscapeEvidence(plan, world, executionPolicy.landscapeEvidence);
      const planting = regionPlantingAssessment(plan, world);
      event.planting = planting;
      progress(`Attempt ${attempt} compiled: ${world.status}, ${world.instances.length} instances`);
      if (
        world.status !== "eligible" ||
        event.refinementFailure ||
        planting.status === "incomplete"
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
            .map((i) => ({ intentId: i.intentId, boundsMeters: i.boundsMeters })),
          evidenceCompleteness: "complete",
        };
        if (world.foundation.status === "eligible") {
          try {
            repairCapture = await capture({
              folder,
              plan,
              world,
              ...(editEvidenceCameras ? { cameras: editEvidenceCameras } : {}),
              timeoutMilliseconds: executionPolicy.previewTimeoutMilliseconds,
            });
            event.capture = repairCapture.evidence;
          } catch (error) {
            event.captureFailure = String(error);
          }
        }
        throw new Error(
          [event.refinementFailure, ...worldBuildDiagnostics(world), ...planting.diagnostics]
            .filter(Boolean)
            .join("; ") || "World compilation incomplete",
        );
      }
      const captured = await capture({
        folder,
        plan,
        world,
        ...(editEvidenceCameras ? { cameras: editEvidenceCameras } : {}),
        timeoutMilliseconds: executionPolicy.previewTimeoutMilliseconds,
      });
      if (!captured.images.length)
        throw new Error("Visual review requires captured image evidence");
      event.firstPreviewSeconds = elapsed();
      event.capture = captured.evidence;
      repairCapture = captured;
      let verifiedEditEffect: ReturnType<typeof regionEditEffect> | undefined;
      if (options.base) {
        const effect = regionEditEffect({
          beforePlan: options.base.plan,
          before: options.base.world,
          afterPlan: plan,
          after: world,
          request: editRequest!,
          proposal: regionProposal!,
          constraints: populationConstraints!,
          changes: appliedChanges,
        });
        verifiedEditEffect = effect;
        event.editEffect = effect;
        await writeRun(`${folder}/edit-effects.json`, effect);
        if (effect.status !== "eligible") throw new Error(effect.diagnostics.join("; "));
      }
      let judgment: z.output<typeof visualResponse>;
      try {
        judgment = await reviewRegionEvidence({
          folder,
          prompt,
          mode,
          plan,
          world,
          captured,
          ...(beforeCapture ? { beforeCapture } : {}),
          ...(verifiedEditEffect ? { editEffect: verifiedEditEffect } : {}),
        });
      } catch (error) {
        stopAfterAttempt = true;
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
      await writeRun(`${folder}/visual-review.json`, {
        ...reviewed,
        worldBuildHash: world.worldBuildHash,
        imageHashes: captured.images.map((i) => i.hash),
        beforeWorldBuildHash: options.base?.world.worldBuildHash ?? null,
        beforeImageHashes: beforeCapture?.images.map((i) => i.hash) ?? [],
        authority: "model",
        independent: false,
        engineVerified: false,
      });
      event.visualStatus = reviewed.status;
      feedback = reviewed;
      repairCapture = captured;
      progress(`Attempt ${attempt} visual review: ${reviewed.status}`);
      if (reviewed.status === "eligible") {
        final = { plan, world };
        event.finishedSeconds = elapsed();
        attempts.push(event);
        await writeRun(`${folder}/event.json`, event);
        break;
      }
    } catch (error) {
      if (!options.base) {
        reuseLayoutForNextAttempt =
          generationFailureStage === "planting" && previousLayout !== null;
        event.generationFailureStage = generationFailureStage;
      }
      event.failure =
        error instanceof z.ZodError
          ? JSON.stringify(error.issues)
          : String(error instanceof Error ? error.message : error);
      if (error instanceof WorldPlannerResponseError && error.receipt.resourceExhaustion) {
        event.resourceExhaustion = error.receipt.resourceExhaustion;
        event.stopReason = "resource_exhausted";
        stopAfterAttempt = true;
      }
      const failureHash = contentHash(
        stableJson({
          failure: event.failure,
          compilerStatus: event.compilerStatus ?? null,
          compilerEvidence: event.compilerEvidence ?? null,
          planting: event.planting ?? null,
          editEffect: event.editEffect ?? null,
          visualStatus: event.visualStatus ?? null,
        }),
      );
      if (!stopAfterAttempt && seenFailureHashes.has(failureHash)) {
        stopAfterAttempt = true;
        event.stopReason = "unchanged_failure_state";
      }
      seenFailureHashes.add(failureHash);
      feedback = {
        failure: event.failure,
        compilerEvidence: event.compilerEvidence ?? null,
        population: event.population ?? null,
        editEffect: event.editEffect ?? null,
        planting: event.planting ?? null,
        landscape: event.landscape ?? null,
      };
      const progressPrefix = String(event.failure).slice(0, 1_500);
      progress(
        `Attempt ${attempt} incomplete: ${progressPrefix}${String(event.failure).length > progressPrefix.length ? " (full failure retained in the attempt event)" : ""}`,
      );
    }
    event.finishedSeconds = elapsed();
    attempts.push(event);
    await writeRun(`${folder}/event.json`, event);
    if (stopAfterAttempt) break;
  }
  if (final) {
    await writeRun(`${output}/spatial-plan.json`, final.plan);
    await writeRun(`${output}/world-build.json`, final.world);
  }
  const report = {
    status: final ? ("eligible" as const) : ("incomplete" as const),
    mode,
    prompt,
    seed: final?.plan.seed ?? options.base?.plan.seed ?? generationSeed,
    worldBuildHash: final?.world.worldBuildHash ?? null,
    elapsedSeconds: elapsed(),
    modelCalls,
    attempts,
    independentReview: false,
    creatorAccepted: false,
    engineVerified: false,
    executionPolicy,
    phasePerformance,
    beforeCapture: beforeCapture?.evidence ?? null,
    resourceExhaustions: attempts.flatMap((attempt) =>
      attempt.resourceExhaustion ? [attempt.resourceExhaustion] : [],
    ),
  };
  await writeRun(`${output}/report.json`, report);
  return report;
}

async function captureRegionPreview(
  root: string,
  input: {
    folder: string;
    plan: SpatialWorldPlan;
    world: WorldBuild;
    cameras?: SpatialWorldPlan["cameras"];
    timeoutMilliseconds: number;
  },
  policy: RegionExecutionPolicy,
) {
  const views = {
    worldBuildHash: input.world.worldBuildHash,
    cameras: input.cameras ?? input.plan.cameras,
  };
  if (!views.cameras.length)
    throw new Error("Region workflow requires at least one declared evidence camera");
  await write(root, `${input.folder}/views.json`, views, policy.workspace.maximumArtifactBytes);
  await write(
    root,
    `${input.folder}/execution-policy.json`,
    policy,
    policy.workspace.maximumArtifactBytes,
  );
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
      "--execution-policy",
      `${input.folder}/execution-policy.json`,
    ],
    {
      cwd: root,
      timeout: input.timeoutMilliseconds,
      maxBuffer: policy.transport.maximumResponseBytes,
    },
  );
  const capture = z
    .object({
      worldBuildHash: z.string(),
      images: z
        .array(z.object({ file: z.string().regex(/^[A-Za-z0-9_-]+\.png$/u), hash: z.string() }))
        .min(1),
    })
    .passthrough()
    .parse(
      await read(
        root,
        `${input.folder}/preview/capture.json`,
        policy.workspace.maximumArtifactBytes,
      ),
    );
  if (capture.worldBuildHash !== input.world.worldBuildHash)
    throw new Error("Preview belongs to another world");
  const images = [];
  for (const image of capture.images) {
    const bytes = await readBoundedWorkspaceBytes(
      root,
      `${input.folder}/preview/${image.file}`,
      policy.workspace.maximumPreviewImageBytes,
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
  const executionPolicy = REGION_EXECUTION_POLICY_SCHEMA.parse(
    await read(
      root,
      option("--execution-policy") ?? "registry/world-authoring/execution.json",
      Number.MAX_SAFE_INTEGER,
    ),
  );
  const authority = await loadWorldAuthority(
    root,
    option("--catalog") ?? "registry/catalog.json",
    semanticModule,
    executionPolicy.workspace.maximumArtifactBytes,
  );
  if (action === "profile") {
    if (!positional || positional.startsWith("--"))
      throw new Error("Supply the authority plan to prepare an empty region profile");
    const profile = prepareRegionAuthoringProfile(
      SPATIAL_WORLD_PLAN_SCHEMA.parse(
        await read(root, positional, executionPolicy.workspace.maximumArtifactBytes),
      ),
      authority,
      REGION_AUTHORING_SETTINGS_SCHEMA.parse(
        await read(
          root,
          option("--settings") ?? "registry/world-authoring/settings.json",
          executionPolicy.workspace.maximumArtifactBytes,
        ),
      ),
    );
    await write(root, output, profile, executionPolicy.workspace.maximumArtifactBytes);
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
        Buffer.from(
          await readBoundedWorkspaceBytes(
            root,
            ".env",
            executionPolicy.workspace.maximumEnvironmentFileBytes,
          ),
        ).toString("utf8"),
      ).OPENROUTER_API_KEY;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  if (!key) throw new Error("OPENROUTER_API_KEY is absent from the environment and .env");
  const reasoningEffort = z
    .enum(["none", "low", "high"])
    .parse(option("--reasoning-effort") ?? "low");
  const planner = createOpenRouterPlanner({
    apiKey: key,
    model,
    reasoningEffort,
    ...executionPolicy.transport,
  });
  const profilePath = option("--profile") ?? "registry/world-authoring/outdoor.json";
  const profile = REGION_AUTHORING_PROFILE_SCHEMA.parse(
    await read(root, profilePath, executionPolicy.workspace.maximumArtifactBytes),
  );
  const seedOption = option("--seed");
  if (action === "generate" && seedOption === undefined)
    throw new Error("Generation requires an explicit nonnegative safe-integer --seed");
  if (action === "edit" && seedOption !== undefined)
    throw new Error("Edit inherits its verified base seed; remove --seed");
  const generationSeed =
    action === "generate"
      ? z.coerce.number().int().nonnegative().safe().parse(seedOption)
      : undefined;
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
              await read(
                root,
                `${basePath}/spatial-plan.json`,
                executionPolicy.workspace.maximumArtifactBytes,
              ),
            ),
            world: WORLD_BUILD_SCHEMA.parse(
              await read(
                root,
                `${basePath}/world-build.json`,
                executionPolicy.workspace.maximumArtifactBytes,
              ),
            ),
          },
        }
      : {};
  const report = await runRegionAuthoring({
    root,
    output,
    prompt: positional,
    authority,
    planner,
    profile,
    executionPolicy,
    ...(generationSeed === undefined ? {} : { generationSeed }),
    ...configuration,
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
