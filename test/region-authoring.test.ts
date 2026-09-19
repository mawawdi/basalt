import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentHash, stableJson } from "@basalt/contracts";
import { sealAssetPlacementGeometry } from "@basalt/catalog-model";
import {
  realizeRegionDraft,
  sealSpatialWorldPlan,
  REGION_AUTHORING_PROFILE_SCHEMA,
  SPATIAL_WORLD_PLAN_SCHEMA,
  type RegionDraft,
  type RegionAuthoringProfile,
} from "@basalt/world-planning";
import { compileBasaltWorld, WORLD_BUILD_SCHEMA } from "@basalt/world-compiler";
import {
  applyWorldChangeProposal,
  createLocalRefinementCompiler,
  observeWorldBuild,
  runBoundedRefinement,
  sealRefinementPolicy,
  sealWorldChangeProposal,
} from "@basalt/world-refinement";
import {
  regionEditPolicy,
  regionEditResponseSchema,
  regionEditEffect,
  regionPlantingAssessment,
  regionLandscapeEvidence,
  runRegionAuthoring,
  type RegionRunOptions,
} from "@basalt/cli/world-authoring";
import {
  createOpenRouterPlanner,
  WorldPlannerResponseError,
  type WorldPlanner,
} from "@basalt/cli/world-planner";
import { worldFixture } from "./helpers/world-fixture.js";
import { loadSemanticRegistry } from "./helpers/semantic-registry.js";

async function fixture() {
  const semanticModule = await loadSemanticRegistry(),
    f = await worldFixture(semanticModule);
  const { kind: _kind, coordinateSystem: _coordinates, planHash: _hash, ...body } = f.plan;
  const route = f.plan.routes[0]!;
  const basePlan = sealSpatialWorldPlan({
    ...body,
    realizationIntents: [],
    routes: [],
    routeJunctions: [],
    cameras: [],
    terrainPlans: f.plan.terrainPlans.map((t) => ({ ...t, operations: [] })),
  });
  const profile: RegionAuthoringProfile = REGION_AUTHORING_PROFILE_SCHEMA.parse({
    profileId: "TestRegion",
    catalogSnapshotHash: f.snapshot.hash,
    placementToleranceMeters: 0,
    basePlan,
    routeTemplate: route,
    junctionTemplate: {
      junctionId: "JunctionTemplate",
      kind: "intersection",
      positionMeters: { x: 1, z: 1 },
      participants: [
        { routeId: "A", endpoint: "start" },
        { routeId: "B", endpoint: "end" },
      ],
      radiusMeters: 1,
      maximumSnapDistanceMeters: 0.01,
      surfaceElevation: { kind: "terrain_clearance", clearanceMeters: 0.08 },
      appearance: route.appearance,
      terrainMaterialId: "Ground",
    },
    allowedTerrainMaterialIds: ["Grass", "Ground"],
    palette: [
      {
        requirementId: f.requirement.requirementId,
        description: "Measured fixture asset",
        boundsMeters: { min: { x: -0.5, y: 0, z: -0.5 }, max: { x: 0.5, y: 1, z: 0.5 } },
      },
    ],
  });
  const draft: RegionDraft = {
    planId: "AuthoredRegion",
    seed: 7,
    unmetRequirements: [],
    notes: [],
    terrainOperations: [],
    routes: [],
    routeNodes: [],
    vegetationAreas: [],
    placements: [
      {
        placementId: "Anchor",
        requirementId: f.requirement.requirementId,
        x: 10,
        z: 10,
        yawDegrees: 0,
        columns: 1,
        rows: 1,
        spacingXMeters: 0,
        spacingZMeters: 0,
        footingElevationMeters: 0,
      },
    ],
    cameras: [
      {
        cameraId: "Overview",
        positionMeters: { x: 30, y: 25, z: -10 },
        lookAtMeters: { x: 10, y: 0, z: 10 },
      },
      {
        cameraId: "Approach",
        positionMeters: { x: 10, y: 3, z: 5 },
        lookAtMeters: { x: 10, y: 1, z: 10 },
      },
    ],
  };
  return { f, semanticModule, profile, draft };
}

test("compact region proposals preserve prepared authority and reject invented assets or example layouts", async () => {
  const { profile, draft } = await fixture();
  const before = stableJson(profile);
  const plan = realizeRegionDraft(profile, draft);
  assert.equal(plan.realizationIntents.length, 1);
  assert.equal(plan.terrainPlans[0]!.operations[0]!.kind, "flatten");
  assert.equal(stableJson(profile), before);
  assert.equal(plan.planHash, realizeRegionDraft(profile, draft).planHash);
  assert.throws(
    () =>
      realizeRegionDraft(profile, { ...draft, unmetRequirements: ["No admitted requested asset"] }),
    /Unsupported/,
  );
  assert.throws(
    () =>
      realizeRegionDraft(profile, {
        ...draft,
        placements: [{ ...draft.placements[0], requirementId: "Invented" }],
      }),
    /prepared palette/,
  );
  assert.throws(
    () => REGION_AUTHORING_PROFILE_SCHEMA.parse({ ...profile, basePlan: plan }),
    /empty terrain region/,
  );
});

test("draft expansion handles unused grid axes and sizes junctions to participating paths", async () => {
  const { profile, draft } = await fixture();
  draft.notes = ["A composed row uses ordinary catalog assets"];
  draft.placements = [
    {
      ...draft.placements[0]!,
      x: 3,
      z: 3,
      columns: 3,
      rows: 1,
      spacingXMeters: 2,
      spacingZMeters: 0,
    },
  ];
  draft.routes = [
    {
      routeId: "East",
      startNodeId: "Hub",
      endNodeId: "EastEnd",
      waypoints: [],
      widthMeters: 2,
    },
    {
      routeId: "North",
      startNodeId: "Hub",
      endNodeId: "NorthEnd",
      waypoints: [],
      widthMeters: 1.6,
    },
  ];
  draft.routeNodes = [
    { nodeId: "Hub", position: { x: 10, z: 10 } },
    { nodeId: "EastEnd", position: { x: 15, z: 10 } },
    { nodeId: "NorthEnd", position: { x: 10, z: 15 } },
  ];
  const plan = realizeRegionDraft(profile, draft);
  const row = plan.realizationIntents[0]!;
  assert.equal(row.kind, "surface_grid");
  if (row.kind !== "surface_grid") throw new Error("Fixture needs a row");
  assert.equal(row.spacingUMeters, 2);
  assert.equal(row.spacingVMeters, 1);
  assert.equal(plan.routeJunctions[0]!.radiusMeters, 0.8);
  const disconnected = structuredClone(draft);
  disconnected.routeNodes.push({ nodeId: "Separate", position: { x: 5, z: 5 } });
  disconnected.routes[1]!.startNodeId = "Separate";
  assert.throws(() => realizeRegionDraft(profile, disconnected), /disconnected/);
  assert.equal(plan.planHash, realizeRegionDraft(profile, { ...draft, notes: [] }).planHash);
  draft.placements = [{ ...draft.placements[0]!, columns: 2, yawDegrees: 90 }];
  const rotated = realizeRegionDraft(profile, draft);
  assert.equal(rotated.realizationIntents.length, 2);
  for (const [index, cell] of rotated.realizationIntents.entries()) {
    assert.equal(cell.kind, "single");
    if (cell.kind !== "single") throw new Error("Rotated grids lower to individual placements");
    assert.equal(cell.at.u, 3);
    assert.equal(cell.at.v, 3 - index * 2);
    assert.equal(cell.yawDegrees, 90);
  }
  profile.palette[0]!.boundsMeters.min.x += 1;
  profile.palette[0]!.boundsMeters.max.x += 1;
  const offsetFooting = realizeRegionDraft(profile, draft).terrainPlans[0]!.operations.at(-1)!;
  assert.equal(offsetFooting.kind, "flatten");
  if (offsetFooting.kind !== "flatten") throw new Error("Fixture requires a footing");
  assert.ok(
    Math.abs(Math.min(...offsetFooting.polygon.map((p) => p.z)) + 0.9) < 1e-9,
    "Footings must include the rotated source pivot offset, not assume centered geometry",
  );
});

test("bounded single-placement search resolves nearby conflicts without moving beyond its tolerance or changing yaw", async () => {
  const { f, semanticModule, profile, draft } = await fixture();
  draft.placements = [
    { ...draft.placements[0]!, placementId: "First", yawDegrees: 90 },
    { ...draft.placements[0]!, placementId: "Second", yawDegrees: 90 },
  ];
  const compile = () =>
    compileBasaltWorld({
      semanticModule,
      catalogSnapshot: f.snapshot,
      catalogAssets: [f.asset],
      spatialPlan: realizeRegionDraft(profile, draft),
    });
  assert.equal(compile().status, "incomplete", "An exact overlapping placement remains impossible");
  profile.placementToleranceMeters = 3;
  const world = compile();
  assert.equal(world.status, "eligible", world.micro.diagnostics.join(";"));
  assert.equal(world.instances.length, 2);
  assert.equal(world.worldBuildHash, compile().worldBuildHash);
  for (const i of world.instances) {
    const p = i.transformMeters.position;
    assert.ok(Math.hypot(p.x - 10, p.z - 10) <= 3 + 1e-9);
    assert.ok(Math.abs(i.transformMeters.rotation[1] - Math.sin(Math.PI / 4)) < 1e-9);
  }
  draft.routeNodes = [
    { nodeId: "West", position: { x: 2, z: 10 } },
    { nodeId: "East", position: { x: 18, z: 10 } },
  ];
  draft.routes = [
    { routeId: "Crossing", startNodeId: "West", endNodeId: "East", waypoints: [], widthMeters: 2 },
  ];
  const routed = compile();
  assert.equal(routed.status, "eligible", routed.micro.diagnostics.join(";"));
  assert.ok(
    routed.instances.every((i) => i.boundsMeters.max.z <= 8.5 || i.boundsMeters.min.z >= 11.5),
  );
});

test("a requested vegetation edit executes on valid geometry and preserves static placements and foundation", async () => {
  const { f, semanticModule, profile, draft } = await fixture();
  draft.vegetationAreas = [
    {
      areaId: "Plants",
      boundary: [
        { x: 1, z: 1 },
        { x: 8, z: 1 },
        { x: 8, z: 8 },
        { x: 1, z: 8 },
      ],
      patchScaleMeters: 8,
      clearings: [],
      palette: [
        {
          plantId: "Low",
          requirementId: f.requirement.requirementId,
          layer: "ground_cover",
          maximumCount: 20,
          spacingMeters: 4,
          weight: 1,
          canopyPreference: "neutral",
        },
      ],
    },
  ];
  const plan = realizeRegionDraft(profile, draft);
  const geometry = sealAssetPlacementGeometry({
    assetHash: f.asset.hash,
    sourceContentHash: f.asset.source.contentHash,
    geometryHash: f.asset.geometryHash,
    bands: [{ min: { x: -0.5, y: 0, z: -0.5 }, max: { x: 0.5, y: 2, z: 0.5 } }],
  });
  const authority = {
    semanticModule,
    catalogSnapshot: f.snapshot,
    catalogAssets: [f.asset],
    placementGeometry: [geometry],
  };
  const world = compileBasaltWorld({ ...authority, spatialPlan: plan });
  assert.equal(world.status, "eligible");
  const policy = regionEditPolicy(plan),
    id = "Plants_Low";
  const responseSchema = regionEditResponseSchema(policy);
  assert.throws(
    () =>
      responseSchema.parse({
        rationale: "Invented clearing target",
        changes: [{ kind: "vegetation_clearings", intentId: "NewClearing", clearings: [] }],
      }),
    /Plants_Low/,
  );
  const proposal = sealWorldChangeProposal({
    basePlanHash: plan.planHash,
    baseWorldBuildHash: world.worldBuildHash,
    providerId: "Test",
    providerImplementationHash: contentHash("test"),
    rationale: "Densify the requested area and clear its center",
    changes: [
      {
        kind: "vegetation_density",
        intentId: id,
        candidateDensityPerSquareMeter: 0.2,
        maximumCount: 30,
      },
      {
        kind: "vegetation_clearings",
        intentId: id,
        clearings: [
          {
            boundsMeters: { min: { x: 3, y: -1, z: 3 }, max: { x: 5, y: 5, z: 5 } },
            falloffMeters: 1,
          },
        ],
      },
    ],
  });
  let current = plan;
  const compiler = createLocalRefinementCompiler(authority);
  const result = await runBoundedRefinement({
    initialPlan: plan,
    initialProposal: proposal,
    policy,
    compiler: {
      compile(input) {
        current = input.plan;
        return compiler.compile(input);
      },
    },
    provider: {
      async propose() {
        throw new Error("Unexpected second proposal");
      },
    },
    observe: (input) =>
      observeWorldBuild({
        ...input,
        plan: current,
        policy,
        cameras: [],
        expectations: {
          dimensions: [],
          access: [],
          viewCorridors: [],
          styles: [],
          minimumNeighborClearanceMeters: 0,
        },
      }),
  });
  assert.equal(result.run.status, "eligible", result.run.diagnostics.join(";"));
  assert.equal(result.run.iterations.length, 1);
  assert.deepEqual(result.worldBuild.foundation, world.foundation);
  assert.deepEqual(
    result.worldBuild.instances.filter((i) => i.intentId === "Anchor"),
    world.instances.filter((i) => i.intentId === "Anchor"),
  );
  assert.equal(
    result.run.iterations[0]!.affectedTaskIds.length,
    2,
    "Only world population and output tasks are affected",
  );
  const {
    kind: _proposalKind,
    hash: _proposalHash,
    compilerAuthority: _authority,
    ...proposalBody
  } = proposal;
  const invalid = sealWorldChangeProposal({
    ...proposalBody,
    changes: [
      {
        kind: "vegetation_density",
        intentId: id,
        candidateDensityPerSquareMeter: 99,
        maximumCount: 30,
      },
    ],
  });
  assert.throws(() => applyWorldChangeProposal(plan, invalid, policy), /policy bound/);
  assert.throws(() => applyWorldChangeProposal(result.plan, proposal, policy), /stale plan/);
  const { kind: _policyKind, policyHash: _policyHash, ...policyBody } = policy;
  const protectedPolicy = sealRefinementPolicy({ ...policyBody, protectedIntentIds: [id] });
  assert.throws(() => applyWorldChangeProposal(plan, proposal, protectedPolicy), /whitelisted/);
  const noEffect = regionEditEffect({
    beforePlan: plan,
    before: world,
    afterPlan: plan,
    after: world,
    changes: [
      {
        kind: "vegetation_density",
        intentId: id,
        candidateDensityPerSquareMeter: 0.5,
        maximumCount: 30,
      },
    ],
  });
  assert.equal(noEffect.status, "incomplete");
  assert.ok(noEffect.diagnostics.some((d) => d.includes("no realized placements")));
});

test("spacing-based planting establishes canopy and fails closed when the requested plants cannot be placed", async () => {
  const { f, semanticModule, profile, draft } = await fixture();
  draft.placements = [];
  draft.vegetationAreas = [
    {
      areaId: "Grove",
      boundary: [
        { x: 2, z: 2 },
        { x: 18, z: 2 },
        { x: 18, z: 18 },
        { x: 2, z: 18 },
      ],
      patchScaleMeters: 8,
      clearings: [],
      palette: [
        {
          plantId: "Canopy",
          requirementId: f.requirement.requirementId,
          layer: "canopy",
          maximumCount: 80,
          spacingMeters: 2.5,
          weight: 1,
          canopyPreference: "neutral",
        },
      ],
    },
  ];
  const geometry = sealAssetPlacementGeometry({
    assetHash: f.asset.hash,
    sourceContentHash: f.asset.source.contentHash,
    geometryHash: f.asset.geometryHash,
    bands: [{ min: { x: -0.5, y: 0, z: -0.5 }, max: { x: 0.5, y: 2, z: 0.5 } }],
  });
  const compile = () =>
    compileBasaltWorld({
      semanticModule,
      catalogSnapshot: f.snapshot,
      catalogAssets: [f.asset],
      placementGeometry: [geometry],
      spatialPlan: realizeRegionDraft(profile, draft),
    });
  const world = compile();
  assert.equal(world.status, "eligible", world.micro.diagnostics.join(";"));
  assert.ok(
    world.instances.length >= 4,
    "Spacing-driven planting should establish several plants, above the required presence of one",
  );
  assert.equal(world.worldBuildHash, compile().worldBuildHash);
  const plan = realizeRegionDraft(profile, draft);
  const landscape = regionLandscapeEvidence(plan, world);
  const coverage = landscape.layers.find((l) => l.layer === "canopy")!.sampledBoundsCoverage;
  assert.ok(coverage > 0 && coverage < 1);
  const doubled = regionLandscapeEvidence(plan, {
    ...world,
    instances: [...world.instances, ...world.instances],
  });
  assert.equal(
    doubled.layers.find((l) => l.layer === "canopy")!.sampledBoundsCoverage,
    coverage,
    "Overlapping instances increase the count but cannot double coverage",
  );
  assert.equal(doubled.fractionOutsideVegetationBounds, landscape.fractionOutsideVegetationBounds);
  assert.equal(landscape.layers.find((l) => l.layer === "ground_cover")!.sampledBoundsCoverage, 0);
  const plant = draft.vegetationAreas[0]!.palette[0]!;
  plant.canopyPreference = "sheltered";
  assert.throws(() => realizeRegionDraft(profile, draft), /Canopy must establish itself/);
  plant.canopyPreference = "neutral";
  draft.vegetationAreas[0]!.clearings = [
    { boundsMeters: profile.basePlan.boundsMeters, falloffMeters: 0 },
  ];
  const blocked = compile();
  assert.equal(
    blocked.status,
    "eligible",
    "An empty grove is a composition failure, not invalid physical geometry",
  );
  assert.equal(blocked.instances.length, 0);
  assert.equal(
    regionLandscapeEvidence(realizeRegionDraft(profile, draft), blocked)
      .fractionOutsideVegetationBounds,
    1,
  );
  const assessment = regionPlantingAssessment(realizeRegionDraft(profile, draft), blocked);
  assert.equal(assessment.status, "incomplete");
  assert.match(assessment.diagnostics[0]!, /canopy layer is empty/);
});

test("ground edits are restricted to existing paint operations and approved materials", async () => {
  const { profile, draft } = await fixture();
  draft.terrainOperations = [
    {
      kind: "paint",
      materialId: "Ground",
      polygon: [
        { x: 1, z: 1 },
        { x: 5, z: 1 },
        { x: 5, z: 5 },
        { x: 1, z: 5 },
      ],
    },
  ];
  const plan = realizeRegionDraft(profile, draft),
    policy = regionEditPolicy(plan);
  const make = (operationIndex: number, materialId: string) =>
    sealWorldChangeProposal({
      basePlanHash: plan.planHash,
      baseWorldBuildHash: contentHash("world"),
      providerId: "Test",
      providerImplementationHash: contentHash("test"),
      rationale: "Change ground material",
      changes: [
        {
          kind: "terrain_paint",
          terrainPlanId: plan.terrainPlans[0]!.terrainPlanId,
          operationIndex,
          materialId,
          polygon: [
            { x: 1, z: 1 },
            { x: 5, z: 1 },
            { x: 5, z: 5 },
            { x: 1, z: 5 },
          ],
        },
      ],
    });
  const edited = applyWorldChangeProposal(plan, make(0, "Grass"), policy);
  assert.equal(edited.terrainPlans[0]!.operations[0]!.kind, "paint");
  assert.deepEqual(
    edited.terrainPlans[0]!.operations.slice(1),
    plan.terrainPlans[0]!.operations.slice(1),
  );
  assert.throws(() => applyWorldChangeProposal(plan, make(1, "Grass"), policy), /whitelisted/);
  assert.throws(() => applyWorldChangeProposal(plan, make(0, "Unknown"), policy), /policy bound/);
});

test("OpenRouter transport pins the model, schema and image input without tool execution", async () => {
  let body: Record<string, unknown> | undefined;
  const transport: typeof fetch = async (_url, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        model: "chosen/model",
        usage: { total_tokens: 12 },
        choices: [{ finish_reason: "stop", message: { content: '{"answer":1}' } }],
      }),
      { status: 200 },
    );
  };
  const planner = createOpenRouterPlanner({
    apiKey: "not-a-real-key",
    model: "chosen/model",
    reasoningEffort: "low",
    fetch: transport,
  });
  const response = await planner.complete({
    system: "Propose JSON",
    prompt: "Prompt",
    schema: { type: "object" },
    images: [{ hash: contentHash("image"), dataUrl: "data:image/png;base64,AA==" }],
    signal: AbortSignal.timeout(1000),
  });
  assert.deepEqual(response.output, { answer: 1 });
  assert.equal(body!.model, "chosen/model");
  assert.equal(body!.tools, undefined);
  assert.equal(body!.stream, false);
  assert.equal(body!.max_tokens, 24576);
  assert.deepEqual(body!.provider, { require_parameters: true, sort: "throughput" });
  assert.deepEqual(body!.reasoning, { effort: "low" });
  assert.ok(!response.raw.includes("not-a-real-key"));
  const truncated = createOpenRouterPlanner({
    apiKey: "key",
    model: "chosen/model",
    fetch: async () =>
      new Response(
        JSON.stringify({ choices: [{ finish_reason: "length", message: { content: "{}" } }] }),
      ),
  });
  await assert.rejects(
    () =>
      truncated.complete({
        system: "",
        prompt: "",
        schema: {},
        images: [],
        signal: AbortSignal.timeout(1000),
      }),
    /did not complete/,
  );
});

test("planner deadlines survive stalled bodies and cancellation, and invalid HTTP JSON retains evidence", async () => {
  const controller = new AbortController();
  const planner = createOpenRouterPlanner({
    apiKey: "test-secret",
    model: "chosen/model",
    reasoningEffort: "none",
    fetch: async (_url, init) => {
      assert.deepEqual(JSON.parse(String(init?.body)).reasoning, { enabled: false });
      return new Response(
        new ReadableStream({
          pull: () => new Promise(() => {}),
          cancel: () => new Promise(() => {}),
        }),
      );
    },
  });
  const request = { system: "", prompt: "", schema: {}, images: [], signal: controller.signal };
  const pending = planner.complete(request);
  const timer = setTimeout(() => controller.abort(new Error("Test deadline")), 10);
  try {
    await assert.rejects(() => pending, /Test deadline/);
  } finally {
    clearTimeout(timer);
  }
  const malformed = createOpenRouterPlanner({
    apiKey: "test-secret",
    model: "chosen/model",
    fetch: async () => new Response("invalid HTTP test-secret"),
  });
  await assert.rejects(
    () => malformed.complete({ ...request, signal: new AbortController().signal }),
    (error) =>
      error instanceof WorldPlannerResponseError && error.receipt.raw === "invalid HTTP [redacted]",
  );
});

test("bounded orchestration retains a failed proposal and requires image-bound review", async () => {
  const { f, semanticModule, profile, draft } = await fixture();
  draft.terrainOperations.push({
    kind: "paint",
    materialId: "Ground",
    polygon: [
      { x: 1, z: 1 },
      { x: 5, z: 1 },
      { x: 5, z: 5 },
      { x: 1, z: 5 },
    ],
  });
  const root = await mkdtemp(join(tmpdir(), "basalt-authoring-"));
  const authority = {
    semanticModule,
    catalog: { hash: contentHash("catalog"), snapshot: f.snapshot },
    measurements: { assets: [f.asset] },
  } as RegionRunOptions["authority"];
  let calls = 0;
  const planner: WorldPlanner = {
    providerId: "Test",
    model: "offline",
    async complete(request) {
      assert.match(request.system, /exact output JSON Schema/);
      calls++;
      if (calls === 3) {
        const context = JSON.parse(request.prompt);
        assert.equal(context.compiler.status, "eligible");
        assert.equal(context.priorFeedback, undefined);
        assert.equal(context.feedback, undefined);
      }
      const output =
        calls === 1
          ? { invalid: true }
          : calls === 2
            ? draft
            : {
                checks: Object.fromEntries(
                  ["instruction_following", "composition", "grounding", "access"].map(
                    (criterion) => [
                      criterion,
                      {
                        verdict: "pass",
                        note: "Offline orchestration fixture only",
                      },
                    ],
                  ),
                ),
                repairs: ["The requested destination approach still needs verification"],
              };
      return { output, raw: JSON.stringify(output), usage: null, model: "offline" };
    },
  };
  try {
    const report = await runRegionAuthoring({
      root,
      output: "run",
      prompt: "A fixture anchor",
      authority,
      profile,
      planner,
      maximumAttempts: 2,
      capture: async () => ({
        images: [{ hash: contentHash("test-preview"), dataUrl: "data:image/png;base64,AA==" }],
        evidence: { testOnly: true },
      }),
    });
    assert.equal(
      report.status,
      "incomplete",
      "Blocking repairs cannot accompany acceptance even when every model verdict says pass",
    );
    assert.equal(report.attempts[1]!.visualStatus, "incomplete");
    assert.equal(report.modelCalls, 3);
    assert.equal(report.attempts.length, 2);
    assert.ok(report.attempts[0]!.failure);
    assert.equal(report.engineVerified, false);
    assert.equal(report.creatorAccepted, false);
    await assert.rejects(
      () =>
        runRegionAuthoring({
          root,
          output: "stale",
          prompt: "Again",
          authority,
          profile: { ...profile, catalogSnapshotHash: contentHash("stale") },
          planner,
        }),
      /stale catalog/,
    );
    const base = {
      plan: SPATIAL_WORLD_PLAN_SCHEMA.parse(
        JSON.parse(await readFile(join(root, "run/spatial-plan.json"), "utf8")),
      ),
      world: WORLD_BUILD_SCHEMA.parse(
        JSON.parse(await readFile(join(root, "run/world-build.json"), "utf8")),
      ),
    };
    const captured: string[] = [];
    const paint = draft.terrainOperations[0]!;
    assert.equal(paint.kind, "paint");
    if (paint.kind !== "paint") throw new Error("Fixture needs a paint operation");
    let editCalls = 0;
    const editPlanner: WorldPlanner = {
      providerId: "Test",
      model: "offline",
      async complete(request) {
        editCalls++;
        assert.equal(request.images.length, editCalls === 1 ? 1 : 2);
        if (editCalls === 2) {
          assert.equal(request.images[0]!.hash, contentHash("before"));
          assert.equal(request.images[1]!.hash, contentHash("after"));
        }
        const output =
          editCalls === 1
            ? {
                rationale: "Change only the requested ground material",
                changes: [
                  {
                    kind: "terrain_paint",
                    terrainPlanId: base.plan.terrainPlans[0]!.terrainPlanId,
                    operationIndex: 0,
                    materialId: "Grass",
                    polygon: paint.polygon,
                  },
                ],
              }
            : editCalls === 2
              ? { checks: {}, repairs: [] }
              : {
                  checks: Object.fromEntries(
                    ["instruction_following", "composition", "grounding", "access"].map(
                      (criterion) => [
                        criterion,
                        {
                          verdict: "pass",
                          note: "Offline before/after fixture only",
                        },
                      ],
                    ),
                  ),
                  repairs: [],
                };
        return { output, raw: JSON.stringify(output), usage: null, model: "offline" };
      },
    };
    const edited = await runRegionAuthoring({
      root,
      output: "edit",
      prompt: "Change soil to grass",
      authority,
      base,
      planner: editPlanner,
      maximumAttempts: 2,
      capture: async ({ folder }) => {
        const label = folder.endsWith("/before") ? "before" : "after";
        captured.push(label);
        return {
          images: [{ hash: contentHash(label), dataUrl: "data:image/png;base64,AA==" }],
          evidence: { label },
        };
      },
    });
    assert.equal(edited.status, "eligible", JSON.stringify(edited.attempts));
    assert.deepEqual(captured, ["before", "after", "after"]);
    assert.equal(edited.modelCalls, 3);
    assert.equal(edited.attempts[1]!.reusedWorldBuildHash, edited.attempts[0]!.worldBuildHash);
    assert.deepEqual(edited.attempts[1]!.editEffect, edited.attempts[0]!.editEffect);
    await assert.rejects(
      () =>
        runRegionAuthoring({ root, output: "run", prompt: "Again", authority, profile, planner }),
      /must be absent/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an invalid visual review retries the same compiled candidate without replanning", async () => {
  const { f, semanticModule, profile, draft } = await fixture();
  const root = await mkdtemp(join(tmpdir(), "basalt-review-retry-"));
  const captured: string[] = [];
  let proposals = 0,
    reviews = 0;
  const planner: WorldPlanner = {
    providerId: "Test",
    model: "offline",
    async complete(request) {
      const reviewing = request.images.length > 0;
      let output: unknown;
      if (!reviewing) {
        proposals++;
        output = draft;
      } else {
        reviews++;
        output = {
          checks:
            reviews === 1
              ? {}
              : Object.fromEntries(
                  ["instruction_following", "composition", "grounding", "access"].map(
                    (criterion) => [
                      criterion,
                      { verdict: "pass", note: "Offline retry fixture only" },
                    ],
                  ),
                ),
          repairs: [],
        };
      }
      return { output, raw: JSON.stringify(output), usage: null, model: "offline" };
    },
  };
  try {
    const report = await runRegionAuthoring({
      root,
      output: "run",
      prompt: "A fixture anchor",
      authority: {
        semanticModule,
        catalog: { hash: contentHash("catalog"), snapshot: f.snapshot },
        measurements: { assets: [f.asset] },
      } as RegionRunOptions["authority"],
      profile,
      planner,
      maximumAttempts: 2,
      capture: async ({ world }) => {
        captured.push(world.worldBuildHash);
        return {
          images: [{ hash: contentHash("test-preview"), dataUrl: "data:image/png;base64,AA==" }],
          evidence: { testOnly: true, worldBuildHash: world.worldBuildHash },
        };
      },
    });
    assert.equal(report.status, "eligible", JSON.stringify(report.attempts));
    assert.equal(proposals, 1);
    assert.equal(reviews, 2);
    assert.equal(report.modelCalls, 3);
    assert.ok(report.attempts[0]!.failure);
    assert.deepEqual(captured, [report.worldBuildHash, report.worldBuildHash]);
    assert.equal(report.attempts[1]!.reusedWorldBuildHash, report.worldBuildHash);
    assert.equal(report.independentReview, false);
    assert.equal(report.engineVerified, false);
    assert.equal(report.creatorAccepted, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
