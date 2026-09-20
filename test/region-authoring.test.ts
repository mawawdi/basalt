import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentHash, stableJson } from "@basalt/contracts";
import { sealAssetPlacementGeometry } from "@basalt/catalog-model";
import {
  realizeRegionDraft,
  sealRegionEditProposal,
  sealRegionEditRequest,
  sealPopulationPlacementConstraints,
  sealSpatialWorldPlan,
  validateRegionEditTargets,
  REGION_AUTHORING_PROFILE_SCHEMA,
  REGION_EDIT_REQUEST_DRAFT_SCHEMA,
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
  regionEditEvidenceCameras,
  regionEditTargetEvidence,
  expandRegionEditProposal,
  regionEditEffect,
  regionPlantingAssessment,
  regionLandscapeEvidence,
  partitionLinkedTextRequests,
  runRegionAuthoring,
  type RegionRunOptions,
} from "@basalt/cli/world-authoring";
import {
  createOpenRouterPlanner,
  WorldPlannerResponseError,
  type WorldPlanner,
} from "@basalt/cli/world-planner";
import { worldFixture } from "./helpers/world-fixture.js";
import { TEST_WORLD_EXECUTION_POLICY } from "./helpers/execution-policy.js";
import { loadSemanticRegistry } from "./helpers/semantic-registry.js";

const LANDSCAPE_POLICY = { columns: 32, rows: 32, tileColumns: 4, tileRows: 4 } as const;
const hardClearing = (
  bounds: RegionAuthoringProfile["basePlan"]["boundsMeters"],
  falloffMeters: number,
) => ({
  mask: {
    polygon: [
      { x: bounds.min.x, z: bounds.min.z },
      { x: bounds.max.x, z: bounds.min.z },
      { x: bounds.max.x, z: bounds.max.z },
      { x: bounds.min.x, z: bounds.max.z },
    ],
    edgeProfile: { kind: "hard" as const },
  },
  verticalRangeMeters: { minimum: bounds.min.y, maximum: bounds.max.y },
  falloffMeters,
});
const EXECUTION_POLICY = {
  policyId: "TestRegionExecution",
  origin: "Automated test fixture",
  maximumSemanticAttempts: 2,
  maximumMalformedReviewRetries: 1,
  refinementIterationAllocation: 1,
  requestTimeoutMilliseconds: 10_000,
  previewTimeoutMilliseconds: 10_000,
  reviewImageBatchSize: 4,
  placementGeometryCacheMaximumBytes: 16777216,
  workspace: {
    maximumArtifactBytes: 134217728,
    maximumPreviewImageBytes: 16777216,
    maximumEnvironmentFileBytes: 131072,
  },
  transport: {
    origin: "Explicit test transport allocation",
    maximumOutputTokensPerRequest: 4096,
    outputTokenAllocations: {
      layout: 4096,
      planting: 4096,
      editExtraction: 2048,
      editProposal: 2048,
      visualReview: 1024,
      visualSynthesis: 1024,
    },
    maximumTextRequestBytes: 1048576,
    maximumResponseBytes: 1048576,
    providerSort: "throughput",
    maximumTransientRetries: 1,
    maximumRetryDelayMilliseconds: 1000,
    retryableHttpStatuses: [402, 429, 502, 503, 504],
  },
  preview: {
    policyId: "TestPreviewExecution",
    origin: "Explicit deterministic preview allocation for tests",
    maximumTerrainVertices: 100000,
    terrainSampleSpacingMeters: 2,
    imageWidthPixels: 1920,
    imageHeightPixels: 1200,
    deviceScaleFactor: 1,
  },
  vegetation: {
    policyId: "TestRegionVegetationExecution",
    origin: "Explicit deterministic test-run allocation with resumable candidate checkpoints",
    candidateBatchSize: 256,
    mergeFanIn: 4,
    candidateRunDirectory: ".basalt/test-runtime/region-authoring-vegetation-runs",
  },
  population: {
    policyId: "RegionAuthoringTestPopulationExecution",
    origin: "Explicit deterministic region-authoring test allocation",
    minimumCandidateAttempts: 256,
    candidateAttemptsPerTarget: 32,
    pointPlacementCandidateAttempts: 64,
  },
  assembly: {
    policyId: "TestRegionAssemblyExecution",
    origin: "Explicit deterministic region-authoring constraint-solver allocation",
    maximumDecisions: 10_000,
    maximumBacktracks: 10_000,
  },
  construction: {
    policyId: "TestRegionConstructionExecution",
    origin: "Explicit deterministic test-run allocation",
    maximumConstructedElements: 10_000,
  },
  landscapeEvidence: LANDSCAPE_POLICY,
} as const;

test("linked model work partitions by serialized bytes without changing logical source text", () => {
  const source = Array.from(
    { length: 80 },
    (_, index) => `Objective ${index} densifies habitat ${index}. `,
  ).join("");
  const batches = partitionLinkedTextRequests(
    source,
    (candidate) => Buffer.byteLength(stableJson({ candidate }), "utf8") <= 320,
  );
  assert.ok(batches.length > 1);
  assert.equal(batches.join(""), source);
  assert.equal(
    batches.every((candidate) => Buffer.byteLength(stableJson({ candidate }), "utf8") <= 320),
    true,
  );
});

test("compound region edits exceed former intent caps and can share one semantic operation", () => {
  const sourceSpans = Array.from(
    { length: 40 },
    (_, index) => `densify woodland objective ${index}`,
  );
  const prompt = sourceSpans.join("; ");
  const objectives = sourceSpans.map((sourceText, index) => ({
    objectiveId: `DensityObjective_${index}`,
    sourceText,
    kind: "vegetation_density" as const,
    direction: "increase" as const,
    spatialTarget: { kind: "whole_areas" as const, areaIds: ["NorthernWoodland"] },
    layers: ["canopy" as const, "understory" as const],
  }));
  const request = sealRegionEditRequest({
    prompt,
    basePlanHash: "a".repeat(64),
    baseWorldBuildHash: "b".repeat(64),
    draft: {
      objectives,
      preservation: {
        exactIntentIds: [],
        exactRouteIds: [],
        preservePopulationOutsideRegenerationMasks: true,
      },
      unresolvedRequirements: [],
    },
  });
  const proposal = sealRegionEditProposal({
    request,
    providerId: "Test",
    providerImplementationHash: contentHash("compound-edit-test"),
    draft: {
      rationale: "One area-level change implements every repeated creator objective.",
      operations: [
        {
          kind: "vegetation_density",
          objectiveIds: objectives.map((objective) => objective.objectiveId),
          areaId: "NorthernWoodland",
          layers: ["canopy", "understory"],
          populationDensityMultiplier: 1.4,
        },
      ],
    },
  });
  assert.equal(request.objectives.length, 40);
  assert.equal(proposal.operations.length, 1);
  assert.equal(proposal.operations[0]!.objectiveIds.length, 40);
  assert.throws(() =>
    regionEditResponseSchema(request.objectives).parse({
      rationale: "An unrelated operation must be impossible at the transport boundary.",
      operations: [
        {
          kind: "terrain_material",
          objectiveIds: [objectives[0]!.objectiveId],
          terrainPlanId: "Terrain",
          operationIndex: 0,
          materialId: "Ground",
          polygon: [
            { x: 0, z: 0 },
            { x: 1, z: 0 },
            { x: 0, z: 1 },
          ],
        },
      ],
    }),
  );
});

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
    placementPadBlendWidthMeters: 1,
    evidenceCameraFieldOfViewDegrees: 58,
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
    plantingPolicy: {
      candidateTrialsPerSpacingCell: 4,
      spacingFactors: { minimum: 0.7, maximum: 1.2 },
      canopyResponses: {
        neutral: { open: 1, covered: 1 },
        sheltered: { open: 0.15, covered: 1 },
        open: { open: 1, covered: 0.25 },
      },
      maximumSlopeDegrees: 30,
      maximumSupportReliefMeters: 0.35,
      groundEmbedMeters: 0.025,
      routeClearanceHeightMeters: 3,
      minimumSeparationMeters: 0.02,
    },
    palette: [
      {
        requirementId: f.requirement.requirementId,
        description: "Measured fixture asset",
        descriptionStatus: "authored",
        descriptionEvidenceHashes: [contentHash("fixture-description")],
        renderEvidenceHashes: [contentHash("fixture-render")],
        styleProfile: {
          handle: "test_style",
          hash: contentHash("fixture-style"),
          shapeLanguage: "Measured fixture silhouette",
          materialLanguage: "Measured fixture material",
          silhouetteHierarchy: [{ level: "primary", guidance: "Keep the asset legible" }],
        },
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

test("policy-driven single-placement search resolves nearby conflicts without moving beyond its tolerance or changing yaw", async () => {
  const { f, semanticModule, profile, draft } = await fixture();
  draft.placements = [
    { ...draft.placements[0]!, placementId: "First", yawDegrees: 90 },
    { ...draft.placements[0]!, placementId: "Second", yawDegrees: 90 },
  ];
  const compile = (executionPolicy = TEST_WORLD_EXECUTION_POLICY) =>
    compileBasaltWorld({
      semanticModule,
      catalogSnapshot: f.snapshot,
      catalogAssets: [f.asset],
      spatialPlan: realizeRegionDraft(profile, draft),
      executionPolicy,
    });
  assert.equal(compile().status, "incomplete", "An exact overlapping placement remains impossible");
  profile.placementToleranceMeters = 3;
  const exhausted = compile({
    ...TEST_WORLD_EXECUTION_POLICY,
    population: {
      ...TEST_WORLD_EXECUTION_POLICY.population!,
      policyId: "SingleCandidateTestPolicy",
      origin: "Regression fixture intentionally allocates only the authored location",
      pointPlacementCandidateAttempts: 1,
    },
  });
  assert.equal(exhausted.status, "incomplete");
  assert.match(exhausted.micro.diagnostics.join(";"), /SingleCandidateTestPolicy exhausted 1/);
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
  assert.ok(routed.instances.every((i) => i.boundsMeters.max.z <= 9 || i.boundsMeters.min.z >= 11));
});

test("region drafts retain larger authored palettes, wider valid routes, and all requested cameras", async () => {
  const { profile, draft } = await fixture();
  profile.routeTemplate.bendRadiusMeters = 8;
  draft.placements = [];
  draft.routeNodes = [
    { nodeId: "West", position: { x: 2, z: 10 } },
    { nodeId: "East", position: { x: 18, z: 10 } },
  ];
  draft.routes = [
    {
      routeId: "BroadPromenade",
      startNodeId: "West",
      endNodeId: "East",
      waypoints: [],
      widthMeters: 12,
    },
  ];
  draft.vegetationAreas = [
    {
      areaId: "BotanicalField",
      habitatFieldId: "SharedBotanicalHabitat",
      boundary: [
        { x: 1, z: 1 },
        { x: 19, z: 1 },
        { x: 19, z: 19 },
        { x: 1, z: 19 },
      ],
      patchScaleMeters: 8,
      edgeFadeMeters: 1,
      minimumDensity: 0.1,
      patchContrast: 1,
      clearings: [],
      palette: Array.from({ length: 40 }, (_, index) => ({
        plantId: `Plant_${index}`,
        requirementId: profile.palette[0]!.requirementId,
        layer: "ground_cover" as const,
        maximumCount: 1,
        spacingMeters: 1,
        weight: 1,
        placementOrder: "standard" as const,
        canopyPreference: "neutral" as const,
      })),
    },
  ];
  draft.cameras = Array.from({ length: 7 }, (_, index) => ({
    cameraId: `Coverage_${index}`,
    positionMeters: { x: 2 + index * 2, y: 10, z: 2 },
    lookAtMeters: { x: 10, y: 0, z: 10 },
  }));

  const plan = realizeRegionDraft(profile, draft);
  assert.equal(plan.routes[0]!.widthMeters, 12);
  assert.equal(plan.cameras.length, 7);
  assert.equal(
    plan.realizationIntents.filter((intent) => intent.kind === "surface_scatter").length,
    40,
  );
});

test("a requested vegetation edit executes on valid geometry and preserves static placements and foundation", async () => {
  const { f, semanticModule, profile, draft } = await fixture();
  draft.vegetationAreas = [
    {
      areaId: "Plants",
      habitatFieldId: "PlantsHabitat",
      boundary: [
        { x: 1, z: 1 },
        { x: 8, z: 1 },
        { x: 8, z: 8 },
        { x: 1, z: 8 },
      ],
      patchScaleMeters: 8,
      edgeFadeMeters: 1,
      minimumDensity: 0.1,
      patchContrast: 1,
      clearings: [],
      palette: [
        {
          plantId: "Low",
          requirementId: f.requirement.requirementId,
          layer: "ground_cover",
          maximumCount: 20,
          spacingMeters: 4,
          weight: 1,
          placementOrder: "standard",
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
    executionPolicy: TEST_WORLD_EXECUTION_POLICY,
  };
  const world = compileBasaltWorld({ ...authority, spatialPlan: plan });
  assert.equal(world.status, "eligible");
  const policy = regionEditPolicy(plan, profile, 1),
    id = "Plants_Low";
  const responseSchema = regionEditResponseSchema();
  assert.throws(() => responseSchema.parse({ rationale: "Missing operations", operations: [] }));
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
        spacingMeters: { minimum: 1.5, maximum: 3 },
        maximumCount: 30,
      },
      {
        kind: "vegetation_clearings",
        intentId: id,
        clearings: [hardClearing({ min: { x: 3, y: -1, z: 3 }, max: { x: 5, y: 5, z: 5 } }, 1)],
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
  assert.throws(() => applyWorldChangeProposal(result.plan, proposal, policy), /stale plan/);
  const { kind: _policyKind, policyHash: _policyHash, ...policyBody } = policy;
  const protectedPolicy = sealRefinementPolicy({ ...policyBody, protectedIntentIds: [id] });
  assert.throws(() => applyWorldChangeProposal(plan, proposal, protectedPolicy), /whitelisted/);
});

test("successive regional edits flatten placement evidence, replay cold, and reject stale locks", async () => {
  const { f, semanticModule, profile, draft } = await fixture();
  draft.placements = [];
  const area = (areaId: string, minimumX: number, maximumX: number) => ({
    areaId,
    habitatFieldId: "SharedWoodlandHabitat",
    boundary: [
      { x: minimumX, z: 2 },
      { x: maximumX, z: 2 },
      { x: maximumX, z: 18 },
      { x: minimumX, z: 18 },
    ],
    patchScaleMeters: 8,
    edgeFadeMeters: 1,
    minimumDensity: 0.1,
    patchContrast: 1,
    clearings: [],
    palette: [
      {
        plantId: "Canopy",
        requirementId: f.requirement.requirementId,
        layer: "canopy" as const,
        maximumCount: 12,
        spacingMeters: 4,
        weight: 1,
        placementOrder: "anchor" as const,
        canopyPreference: "neutral" as const,
      },
    ],
  });
  draft.vegetationAreas = [area("WestWood", 2, 18), area("EastWood", 22, 38)];
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
    executionPolicy: TEST_WORLD_EXECUTION_POLICY,
  };
  const initialPlan = realizeRegionDraft(profile, draft);
  const initialWorld = compileBasaltWorld({ ...authority, spatialPlan: initialPlan });
  assert.equal(initialWorld.status, "eligible", initialWorld.micro.diagnostics.join(";"));

  const edit = (plan: typeof initialPlan, world: typeof initialWorld, areaId: string) => {
    const prompt = `Increase canopy density in ${areaId}`;
    const objectiveId = `Densify_${areaId}`;
    const request = sealRegionEditRequest({
      prompt,
      basePlanHash: plan.planHash,
      baseWorldBuildHash: world.worldBuildHash,
      draft: {
        objectives: [
          {
            objectiveId,
            sourceText: prompt,
            kind: "vegetation_density",
            direction: "increase",
            spatialTarget: { kind: "whole_areas", areaIds: [areaId] },
            layers: ["canopy"],
          },
        ],
        preservation: {
          exactIntentIds: [],
          exactRouteIds: [],
          preservePopulationOutsideRegenerationMasks: true,
        },
        unresolvedRequirements: [],
      },
    });
    const proposal = sealRegionEditProposal({
      request,
      providerId: "Test",
      providerImplementationHash: contentHash("successive-edit-test"),
      draft: {
        rationale: `Densify ${areaId}`,
        operations: [
          {
            kind: "vegetation_density",
            objectiveIds: [objectiveId],
            areaId,
            layers: ["canopy"],
            populationDensityMultiplier: 1.5,
          },
        ],
      },
    });
    const expanded = expandRegionEditProposal({
      request,
      proposal,
      plan,
      world,
      catalogSnapshotHash: f.snapshot.hash,
    });
    const changed = applyWorldChangeProposal(
      plan,
      sealWorldChangeProposal({
        basePlanHash: plan.planHash,
        baseWorldBuildHash: world.worldBuildHash,
        providerId: "Test",
        providerImplementationHash: contentHash("successive-edit-test"),
        rationale: proposal.rationale,
        changes: expanded.changes,
      }),
      regionEditPolicy(plan, profile, 1),
    );
    const {
      kind: _kind,
      coordinateSystem: _coordinateSystem,
      planHash: _planHash,
      populationPlacementConstraints: _oldConstraints,
      ...body
    } = changed;
    const nextPlan = sealSpatialWorldPlan({
      ...body,
      populationPlacementConstraints: expanded.constraints,
    });
    const nextWorld = compileBasaltWorld({ ...authority, spatialPlan: nextPlan });
    assert.equal(nextWorld.status, "eligible", nextWorld.micro.diagnostics.join(";"));
    return { plan: nextPlan, world: nextWorld, constraints: expanded.constraints };
  };

  const first = edit(initialPlan, initialWorld, "WestWood");
  const second = edit(first.plan, first.world, "EastWood");
  assert.equal(second.constraints.sourceWorldBuildHash, first.world.worldBuildHash);
  assert.notEqual(second.constraints.hash, first.constraints.hash);
  const physical = (world: typeof initialWorld, intentId: string) =>
    world.instances
      .filter((instance) => instance.intentId === intentId)
      .map((instance) => ({
        intentId: instance.intentId,
        entryHandle: instance.entryHandle,
        memberId: instance.memberId,
        assetHash: instance.assetHash,
        transformMeters: instance.transformMeters,
      }))
      .sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
  assert.deepEqual(
    physical(second.world, "WestWood_Canopy"),
    physical(first.world, "WestWood_Canopy"),
  );
  assert.equal(
    compileBasaltWorld({ ...authority, spatialPlan: second.plan }).worldBuildHash,
    second.world.worldBuildHash,
    "The flattened current constraint snapshot must replay from a cold compile",
  );

  const stale = sealPopulationPlacementConstraints({
    sourceWorldBuildHash: second.constraints.sourceWorldBuildHash,
    catalogSnapshotHash: contentHash("stale-catalog"),
    retainedPlacements: second.constraints.retainedPlacements.map(
      ({ lockId: _lockId, physicalHash: _physicalHash, ...placement }) => placement,
    ),
    regenerationMasks: second.constraints.regenerationMasks,
  });
  const {
    kind: _kind,
    coordinateSystem: _coordinateSystem,
    planHash: _planHash,
    populationPlacementConstraints: _currentConstraints,
    ...secondBody
  } = second.plan;
  const stalePlan = sealSpatialWorldPlan({
    ...secondBody,
    populationPlacementConstraints: stale,
  });
  const staleWorld = compileBasaltWorld({ ...authority, spatialPlan: stalePlan });
  assert.equal(staleWorld.status, "incomplete");
  assert.match(staleWorld.micro.diagnostics.join(";"), /retained placement evidence is stale/u);
});

test("semantic edit targets resolve directional habitat and verified place anchors", async () => {
  const { f, semanticModule, profile, draft } = await fixture();
  draft.vegetationAreas = [
    {
      areaId: "Woodland",
      habitatFieldId: "ContinuousWoodlandHabitat",
      boundary: [
        { x: 2, z: 2 },
        { x: 18, z: 2 },
        { x: 18, z: 18 },
        { x: 2, z: 18 },
      ],
      patchScaleMeters: 8,
      edgeFadeMeters: 1,
      minimumDensity: 0.1,
      patchContrast: 1,
      clearings: [
        {
          ...hardClearing({ min: { x: 8, y: -2, z: 8 }, max: { x: 12, y: 12, z: 12 } }, 1),
          layers: ["canopy"],
        },
      ],
      palette: [
        {
          plantId: "Canopy",
          requirementId: f.requirement.requirementId,
          layer: "canopy",
          maximumCount: 20,
          spacingMeters: 3,
          weight: 1,
          placementOrder: "anchor",
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
  const world = compileBasaltWorld({
    semanticModule,
    catalogSnapshot: f.snapshot,
    catalogAssets: [f.asset],
    placementGeometry: [geometry],
    spatialPlan: plan,
    executionPolicy: TEST_WORLD_EXECUTION_POLICY,
  });
  assert.equal(world.status, "eligible", world.micro.diagnostics.join(";"));
  const prompt = "Make the northern woodland denser and widen the clearing around Anchor.";
  const request = sealRegionEditRequest({
    prompt,
    basePlanHash: plan.planHash,
    baseWorldBuildHash: world.worldBuildHash,
    draft: {
      objectives: [
        {
          objectiveId: "DensifyNorth",
          sourceText: "northern woodland denser",
          kind: "vegetation_density",
          direction: "increase",
          spatialTarget: {
            kind: "directional_areas",
            areaIds: ["Woodland"],
            direction: "north",
          },
          layers: ["canopy"],
        },
        {
          objectiveId: "WidenAnchorClearing",
          sourceText: "widen the clearing around Anchor",
          kind: "vegetation_clearing",
          change: "expand",
          transitionRequirement: "unspecified",
          spatialTarget: {
            kind: "around_intents",
            areaIds: ["Woodland"],
            intentIds: ["Anchor"],
          },
          layers: ["canopy"],
        },
      ],
      preservation: {
        exactIntentIds: ["Anchor"],
        exactRouteIds: [],
        preservePopulationOutsideRegenerationMasks: true,
      },
      unresolvedRequirements: [],
    },
  });
  const evidence = regionEditTargetEvidence(request.objectives, plan, world);
  const evidenceCameras = regionEditEvidenceCameras(request, plan, world, 58);
  assert.equal(evidenceCameras.length, plan.cameras.length + request.objectives.length);
  assert.equal(
    new Set(evidenceCameras.map((camera) => camera.cameraId)).size,
    evidenceCameras.length,
  );
  assert.deepEqual(evidence.find((entry) => entry.objectiveId === "DensifyNorth")!.boundsMeters, {
    min: { x: 2, y: plan.boundsMeters.min.y, z: 10 },
    max: { x: 18, y: plan.boundsMeters.max.y, z: 18 },
  });
  assert.deepEqual(
    evidence.find((entry) => entry.objectiveId === "WidenAnchorClearing")!.baselineClearingBounds,
    { min: { x: 8, y: -2, z: 8 }, max: { x: 12, y: 12, z: 12 } },
  );
  const proposal = sealRegionEditProposal({
    request,
    providerId: "Test",
    providerImplementationHash: contentHash("semantic-target-test"),
    draft: {
      rationale: "Regenerate the north and expand the existing anchor clearing.",
      operations: [
        {
          kind: "vegetation_density",
          objectiveIds: ["DensifyNorth"],
          areaId: "Woodland",
          layers: ["canopy"],
          populationDensityMultiplier: 1.5,
        },
        {
          kind: "vegetation_clearing",
          objectiveIds: ["WidenAnchorClearing"],
          areaId: "Woodland",
          layers: ["canopy"],
          ...hardClearing({ min: { x: 7, y: -2, z: 7 }, max: { x: 13, y: 12, z: 13 } }, 2),
        },
      ],
    },
  });
  const expanded = expandRegionEditProposal({
    request,
    proposal,
    plan,
    world,
    catalogSnapshotHash: f.snapshot.hash,
  });
  assert.equal(expanded.constraints.regenerationMasks.length, 2);
  assert.equal(
    expanded.constraints.regenerationMasks.find((mask) => mask.objectiveId === "DensifyNorth")!
      .boundsMeters.min.z,
    10,
  );
  assert.ok(
    expanded.constraints.retainedPlacements.every(({ transformMeters }) => {
      const { x, z } = transformMeters.position;
      return z < 7 || z > 13 || x < 7 || x > 13;
    }),
    "The expanded clearing must regenerate only its authored footprint while distant placements stay locked",
  );

  const zeroPrompt = "Remove canopy near Anchor and widen the clearing around Anchor.";
  const zeroRequest = sealRegionEditRequest({
    prompt: zeroPrompt,
    basePlanHash: plan.planHash,
    baseWorldBuildHash: world.worldBuildHash,
    draft: {
      objectives: [
        {
          objectiveId: "RemoveNorthernCanopy",
          sourceText: "Remove canopy near Anchor",
          kind: "vegetation_density",
          direction: "decrease",
          spatialTarget: {
            kind: "around_intents",
            areaIds: ["Woodland"],
            intentIds: ["Anchor"],
          },
          layers: ["canopy"],
        },
        {
          objectiveId: "WidenZeroDensityClearing",
          sourceText: "widen the clearing around Anchor",
          kind: "vegetation_clearing",
          change: "expand",
          transitionRequirement: "unspecified",
          spatialTarget: {
            kind: "around_intents",
            areaIds: ["Woodland"],
            intentIds: ["Anchor"],
          },
          layers: ["canopy"],
        },
      ],
      preservation: {
        exactIntentIds: [],
        exactRouteIds: [],
        preservePopulationOutsideRegenerationMasks: true,
      },
      unresolvedRequirements: [],
    },
  });
  const zeroProposal = sealRegionEditProposal({
    request: zeroRequest,
    providerId: "Test",
    providerImplementationHash: contentHash("zero-density-target-test"),
    draft: {
      rationale: "Exclude canopy candidates only inside the requested northern target.",
      operations: [
        {
          kind: "vegetation_density",
          objectiveIds: ["RemoveNorthernCanopy"],
          areaId: "Woodland",
          layers: ["canopy"],
          populationDensityMultiplier: 0,
        },
        {
          kind: "vegetation_clearing",
          objectiveIds: ["WidenZeroDensityClearing"],
          areaId: "Woodland",
          layers: ["canopy"],
          ...hardClearing({ min: { x: 7, y: -2, z: 7 }, max: { x: 13, y: 12, z: 13 } }, 2),
        },
      ],
    },
  });
  const zeroExpanded = expandRegionEditProposal({
    request: zeroRequest,
    proposal: zeroProposal,
    plan,
    world,
    catalogSnapshotHash: f.snapshot.hash,
  });
  assert.equal(zeroExpanded.changes.length, 1);
  assert.ok(zeroExpanded.changes.every((change) => change.kind === "vegetation_clearings"));
  assert.deepEqual(
    zeroExpanded.constraints.regenerationMasks.find(
      (mask) => mask.objectiveId === "RemoveNorthernCanopy",
    )!.boundsMeters,
    {
      min: { x: 7, y: -2, z: 7 },
      max: { x: 13, y: 12, z: 13 },
    },
  );
});

test("spacing-based planting establishes canopy and fails closed when the requested plants cannot be placed", async () => {
  const { f, semanticModule, profile, draft } = await fixture();
  draft.placements = [];
  draft.vegetationAreas = [
    {
      areaId: "Grove",
      habitatFieldId: "GroveHabitat",
      boundary: [
        { x: 2, z: 2 },
        { x: 18, z: 2 },
        { x: 18, z: 18 },
        { x: 2, z: 18 },
      ],
      patchScaleMeters: 8,
      edgeFadeMeters: 1,
      minimumDensity: 0.1,
      patchContrast: 1,
      clearings: [],
      palette: [
        {
          plantId: "Canopy",
          requirementId: f.requirement.requirementId,
          layer: "canopy",
          maximumCount: 80,
          spacingMeters: 2.5,
          weight: 1,
          placementOrder: "anchor",
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
      executionPolicy: TEST_WORLD_EXECUTION_POLICY,
    });
  const world = compile();
  assert.equal(world.status, "eligible", world.micro.diagnostics.join(";"));
  assert.ok(
    world.instances.length >= 4,
    "Spacing-driven planting should establish several plants, above the required presence of one",
  );
  assert.equal(world.worldBuildHash, compile().worldBuildHash);
  const plan = realizeRegionDraft(profile, draft);
  const landscape = regionLandscapeEvidence(plan, world, LANDSCAPE_POLICY);
  const coverage = landscape.layers.find((l) => l.layer === "canopy")!.sampledBoundsCoverage;
  assert.ok(coverage > 0 && coverage < 1);
  const doubled = regionLandscapeEvidence(
    plan,
    {
      ...world,
      instances: [...world.instances, ...world.instances],
    },
    LANDSCAPE_POLICY,
  );
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
  draft.vegetationAreas[0]!.palette.push({
    plantId: "LowCover",
    requirementId: f.requirement.requirementId,
    layer: "ground_cover",
    maximumCount: 40,
    spacingMeters: 2,
    weight: 1,
    placementOrder: "standard",
    canopyPreference: "neutral",
  });
  draft.vegetationAreas[0]!.clearings = [
    {
      ...hardClearing(profile.basePlan.boundsMeters, 0),
      layers: ["canopy"],
    },
  ];
  const blocked = compile();
  assert.equal(
    blocked.status,
    "eligible",
    "An absent requested layer is a composition failure, not invalid physical geometry",
  );
  assert.equal(
    blocked.instances.some((instance) => instance.intentId === "Grove_Canopy"),
    false,
  );
  assert.ok(
    blocked.instances.some((instance) => instance.intentId === "Grove_LowCover"),
    "A canopy-only clearing must retain the ground-cover layer",
  );
  const clearedPlan = realizeRegionDraft(profile, draft);
  const effectFor = (direction: "increase" | "decrease") => {
    const request = sealRegionEditRequest({
      prompt: `${direction} canopy density`,
      basePlanHash: clearedPlan.planHash,
      baseWorldBuildHash: blocked.worldBuildHash,
      draft: {
        objectives: [
          {
            objectiveId: `${direction}_canopy`,
            sourceText: `${direction} canopy density`,
            kind: "vegetation_density",
            direction,
            spatialTarget: { kind: "whole_areas", areaIds: ["Grove"] },
            layers: ["canopy"],
          },
        ],
        preservation: {
          exactIntentIds: [],
          exactRouteIds: [],
          preservePopulationOutsideRegenerationMasks: true,
        },
        unresolvedRequirements: [],
      },
    });
    const proposal = sealRegionEditProposal({
      request,
      providerId: "Test",
      providerImplementationHash: contentHash(`${direction}-empty-canopy`),
      draft: {
        rationale: "Exercise objective verification at an empty-density boundary.",
        operations: [
          {
            kind: "vegetation_density",
            objectiveIds: [`${direction}_canopy`],
            areaId: "Grove",
            layers: ["canopy"],
            populationDensityMultiplier: direction === "increase" ? 1.5 : 0,
          },
        ],
      },
    });
    const expanded = expandRegionEditProposal({
      request,
      proposal,
      plan: clearedPlan,
      world: blocked,
      catalogSnapshotHash: f.snapshot.hash,
    });
    return regionEditEffect({
      request,
      proposal,
      constraints: expanded.constraints,
      beforePlan: clearedPlan,
      before: blocked,
      afterPlan: clearedPlan,
      after: blocked,
      changes: expanded.changes,
    });
  };
  const alreadySparse = effectFor("decrease");
  assert.equal(alreadySparse.status, "eligible");
  assert.equal(alreadySparse.checks[0]!.satisfaction, "already_satisfied");
  const ineffectiveIncrease = effectFor("increase");
  assert.equal(ineffectiveIncrease.status, "incomplete");
  assert.equal(ineffectiveIncrease.checks[0]!.satisfaction, "not_satisfied");

  const missingLayerRequest = sealRegionEditRequest({
    prompt: "decrease understory density",
    basePlanHash: clearedPlan.planHash,
    baseWorldBuildHash: blocked.worldBuildHash,
    draft: {
      objectives: [
        {
          objectiveId: "decrease_missing_understory",
          sourceText: "decrease understory density",
          kind: "vegetation_density",
          direction: "decrease",
          spatialTarget: { kind: "whole_areas", areaIds: ["Grove"] },
          layers: ["understory"],
        },
      ],
      preservation: {
        exactIntentIds: [],
        exactRouteIds: [],
        preservePopulationOutsideRegenerationMasks: true,
      },
      unresolvedRequirements: [],
    },
  });
  validateRegionEditTargets(missingLayerRequest, clearedPlan);
  const missingLayerProposal = sealRegionEditProposal({
    request: missingLayerRequest,
    providerId: "Test",
    providerImplementationHash: contentHash("missing-understory-decrease"),
    draft: {
      rationale: "The requested layer is already absent and remains subject to verification.",
      operations: [
        {
          kind: "vegetation_density",
          objectiveIds: ["decrease_missing_understory"],
          areaId: "Grove",
          layers: ["understory"],
          populationDensityMultiplier: 0,
        },
      ],
    },
  });
  const missingLayerExpansion = expandRegionEditProposal({
    request: missingLayerRequest,
    proposal: missingLayerProposal,
    plan: clearedPlan,
    world: blocked,
    catalogSnapshotHash: f.snapshot.hash,
  });
  assert.deepEqual(missingLayerExpansion.changes, []);
  assert.deepEqual(missingLayerExpansion.constraints.regenerationMasks, []);
  const missingLayerEffect = regionEditEffect({
    request: missingLayerRequest,
    proposal: missingLayerProposal,
    constraints: missingLayerExpansion.constraints,
    beforePlan: clearedPlan,
    before: blocked,
    afterPlan: clearedPlan,
    after: blocked,
    changes: missingLayerExpansion.changes,
  });
  assert.equal(missingLayerEffect.status, "eligible");
  assert.equal(missingLayerEffect.checks[0]!.satisfaction, "already_satisfied");

  const missingIncreaseRequest = sealRegionEditRequest({
    prompt: "increase understory density",
    basePlanHash: clearedPlan.planHash,
    baseWorldBuildHash: blocked.worldBuildHash,
    draft: {
      objectives: [
        {
          objectiveId: "increase_missing_understory",
          sourceText: "increase understory density",
          kind: "vegetation_density",
          direction: "increase",
          spatialTarget: { kind: "whole_areas", areaIds: ["Grove"] },
          layers: ["understory"],
        },
      ],
      preservation: missingLayerRequest.preservation,
      unresolvedRequirements: [],
    },
  });
  assert.throws(
    () => validateRegionEditTargets(missingIncreaseRequest, clearedPlan),
    /unavailable Grove\/understory/,
  );

  assert.equal(
    REGION_EDIT_REQUEST_DRAFT_SCHEMA.safeParse({
      objectives: [
        {
          objectiveId: "unbound_transition",
          sourceText: "create an understory clearing",
          kind: "vegetation_clearing",
          change: "create",
          spatialTarget: { kind: "whole_areas", areaIds: ["Grove"] },
          layers: ["understory"],
        },
      ],
      preservation: missingLayerRequest.preservation,
      unresolvedRequirements: [],
    }).success,
    false,
  );

  const softClearingRequest = sealRegionEditRequest({
    prompt: "create a soft understory clearing",
    basePlanHash: clearedPlan.planHash,
    baseWorldBuildHash: blocked.worldBuildHash,
    draft: {
      objectives: [
        {
          objectiveId: "soft_missing_understory",
          sourceText: "create a soft understory clearing",
          kind: "vegetation_clearing",
          change: "create",
          transitionRequirement: "soft",
          spatialTarget: { kind: "whole_areas", areaIds: ["Grove"] },
          layers: ["understory"],
        },
      ],
      preservation: {
        exactIntentIds: [],
        exactRouteIds: [],
        preservePopulationOutsideRegenerationMasks: true,
      },
      unresolvedRequirements: [],
    },
  });
  validateRegionEditTargets(softClearingRequest, clearedPlan);
  assert.throws(
    () =>
      sealRegionEditProposal({
        request: softClearingRequest,
        providerId: "Test",
        providerImplementationHash: contentHash("hard-edge-proposal"),
        draft: {
          rationale: "A hard edge cannot satisfy a requested soft transition.",
          operations: [
            {
              kind: "vegetation_clearing",
              objectiveIds: ["soft_missing_understory"],
              areaId: "Grove",
              layers: ["understory"],
              ...hardClearing(clearedPlan.boundsMeters, 0),
            },
          ],
        },
      }),
    /soft transition/,
  );
  const layerClearingLandscape = regionLandscapeEvidence(clearedPlan, blocked, LANDSCAPE_POLICY);
  assert.ok(layerClearingLandscape.fractionOutsideVegetationBounds > 0);
  assert.ok(layerClearingLandscape.fractionOutsideVegetationBounds < 1);
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
      mask: {
        edgeProfile: { kind: "hard" },
        polygon: [
          { x: 1, z: 1 },
          { x: 5, z: 1 },
          { x: 5, z: 5 },
          { x: 1, z: 5 },
        ],
      },
    },
  ];
  const plan = realizeRegionDraft(profile, draft),
    policy = regionEditPolicy(plan, profile, 1);
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
    ...EXECUTION_POLICY.transport,
    reasoningEffort: "low",
    fetch: transport,
  });
  const response = await planner.complete({
    system: "Propose JSON",
    prompt: "Prompt",
    schema: { type: "object" },
    images: [{ hash: contentHash("image"), dataUrl: "data:image/png;base64,AA==" }],
    maxOutputTokens: EXECUTION_POLICY.transport.outputTokenAllocations.layout,
    signal: AbortSignal.timeout(1000),
  });
  assert.deepEqual(response.output, { answer: 1 });
  assert.equal(body!.model, "chosen/model");
  assert.equal(body!.tools, undefined);
  assert.equal(body!.stream, false);
  assert.equal(body!.max_tokens, EXECUTION_POLICY.transport.outputTokenAllocations.layout);
  assert.deepEqual(body!.provider, { require_parameters: true, sort: "throughput" });
  assert.deepEqual(body!.reasoning, { effort: "low" });
  assert.ok(!response.raw.includes("not-a-real-key"));
  const truncated = createOpenRouterPlanner({
    apiKey: "key",
    model: "chosen/model",
    ...EXECUTION_POLICY.transport,
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
        maxOutputTokens: EXECUTION_POLICY.transport.outputTokenAllocations.visualReview,
        signal: AbortSignal.timeout(1000),
      }),
    /did not complete/,
  );
});

test("OpenRouter retries policy-admitted transient HTTP failures against the same request", async () => {
  let requests = 0;
  const planner = createOpenRouterPlanner({
    apiKey: "not-a-real-key",
    model: "chosen/model",
    ...EXECUTION_POLICY.transport,
    fetch: async () => {
      requests++;
      if (requests === 1)
        return new Response(
          JSON.stringify({ error: { message: "temporary", metadata: { reason: "busy" } } }),
          { status: 429, headers: { "Retry-After": "0" } },
        );
      return new Response(
        JSON.stringify({
          model: "chosen/model",
          usage: { total_tokens: 9 },
          choices: [{ finish_reason: "stop", message: { content: '{"answer":1}' } }],
        }),
      );
    },
  });
  const response = await planner.complete({
    system: "Propose JSON",
    prompt: "Prompt",
    schema: { type: "object" },
    images: [],
    maxOutputTokens: EXECUTION_POLICY.transport.outputTokenAllocations.visualReview,
    signal: AbortSignal.timeout(1000),
  });
  assert.equal(requests, 2);
  assert.deepEqual(response.output, { answer: 1 });
  assert.deepEqual(response.transportFailures, [
    {
      attempt: 1,
      status: 429,
      raw: '{"error":{"message":"temporary","metadata":{"reason":"busy"}}}',
      retryAfterMilliseconds: 0,
      retried: true,
    },
  ]);

  requests = 0;
  const noDelayEvidence = createOpenRouterPlanner({
    apiKey: "not-a-real-key",
    model: "chosen/model",
    ...EXECUTION_POLICY.transport,
    fetch: async () => {
      requests++;
      return new Response('{"error":{"message":"busy without retry evidence"}}', {
        status: 429,
      });
    },
  });
  await assert.rejects(
    () =>
      noDelayEvidence.complete({
        system: "Propose JSON",
        prompt: "Prompt",
        schema: { type: "object" },
        images: [],
        maxOutputTokens: EXECUTION_POLICY.transport.outputTokenAllocations.visualReview,
        signal: AbortSignal.timeout(1000),
      }),
    (error) =>
      error instanceof WorldPlannerResponseError &&
      error.receipt.transportFailures?.[0]?.retried === false,
  );
  assert.equal(requests, 1);
});

test("OpenRouter reports provider credit exhaustion with values and units", async () => {
  const planner = createOpenRouterPlanner({
    apiKey: "not-a-real-key",
    model: "chosen/model",
    ...EXECUTION_POLICY.transport,
    fetch: async () =>
      new Response(
        JSON.stringify({
          error: {
            message:
              "This request requires more credits. You requested up to 2048 tokens, but can only afford 1182.",
            metadata: { limit_source: "openrouter_credits" },
          },
        }),
        { status: 402 },
      ),
  });
  await assert.rejects(
    () =>
      planner.complete({
        system: "Propose JSON",
        prompt: "Prompt",
        schema: { type: "object" },
        images: [],
        maxOutputTokens: EXECUTION_POLICY.transport.outputTokenAllocations.editProposal,
        signal: AbortSignal.timeout(1000),
      }),
    (error) =>
      error instanceof WorldPlannerResponseError &&
      assert.deepEqual(error.receipt.resourceExhaustion, {
        kind: "resource_exhaustion",
        resource: "openrouter_credits",
        origin: "OpenRouter",
        unit: "output_tokens",
        requestedOutputTokens: 2048,
        availableOutputTokens: 1182,
        reason:
          "This request requires more credits. You requested up to 2048 tokens, but can only afford 1182.",
        resumable: true,
      }) === undefined,
  );
});

test("region authoring stops semantic retries when planner resources are exhausted", async () => {
  const { f, semanticModule, profile, draft } = await fixture();
  const root = await mkdtemp(join(tmpdir(), "basalt-resource-exhaustion-"));
  let calls = 0;
  const resourceExhaustion = {
    kind: "resource_exhaustion" as const,
    resource: "openrouter_credits",
    origin: "OpenRouter" as const,
    unit: "output_tokens" as const,
    requestedOutputTokens: 4096,
    availableOutputTokens: 1000,
    reason: "The provider allocation is exhausted",
    resumable: true as const,
  };
  try {
    const report = await runRegionAuthoring({
      root,
      output: "run",
      prompt: "A fixture anchor",
      generationSeed: draft.seed,
      authority: {
        semanticModule,
        catalog: { hash: contentHash("catalog"), snapshot: f.snapshot },
        measurements: { assets: [f.asset] },
      } as RegionRunOptions["authority"],
      profile,
      planner: {
        providerId: "Test",
        model: "offline",
        async complete() {
          calls++;
          throw new WorldPlannerResponseError("Planner resources exhausted", {
            raw: '{"error":{"code":402}}',
            usage: null,
            model: "offline",
            resourceExhaustion,
          });
        },
      },
      executionPolicy: EXECUTION_POLICY,
    });
    assert.equal(report.status, "incomplete");
    assert.equal(calls, 1);
    assert.equal(report.attempts.length, 1);
    assert.equal(report.attempts[0]!.stopReason, "resource_exhausted");
    assert.deepEqual(report.resourceExhaustions, [resourceExhaustion]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("planner deadlines survive stalled bodies and cancellation, and invalid HTTP JSON retains evidence", async () => {
  const controller = new AbortController();
  const planner = createOpenRouterPlanner({
    apiKey: "test-secret",
    model: "chosen/model",
    ...EXECUTION_POLICY.transport,
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
  const request = {
    system: "",
    prompt: "",
    schema: {},
    images: [],
    maxOutputTokens: EXECUTION_POLICY.transport.outputTokenAllocations.visualReview,
    signal: controller.signal,
  };
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
    ...EXECUTION_POLICY.transport,
    fetch: async () => new Response("invalid HTTP test-secret"),
  });
  await assert.rejects(
    () => malformed.complete({ ...request, signal: new AbortController().signal }),
    (error) =>
      error instanceof WorldPlannerResponseError && error.receipt.raw === "invalid HTTP [redacted]",
  );
});

test("orchestration retains failed attempts, separates layout from planting, and freezes edit objectives", async () => {
  const { f, semanticModule, profile, draft } = await fixture();
  draft.terrainOperations.push({
    kind: "paint",
    materialId: "Ground",
    mask: {
      edgeProfile: { kind: "hard" },
      polygon: [
        { x: 1, z: 1 },
        { x: 5, z: 1 },
        { x: 5, z: 5 },
        { x: 1, z: 5 },
      ],
    },
  });
  const root = await mkdtemp(join(tmpdir(), "basalt-authoring-"));
  const authority = {
    semanticModule,
    catalog: { hash: contentHash("catalog"), snapshot: f.snapshot },
    measurements: { assets: [f.asset] },
  } as RegionRunOptions["authority"];
  let calls = 0;
  const { vegetationAreas, ...layout } = draft;
  const planting = { vegetationAreas };
  const planner: WorldPlanner = {
    providerId: "Test",
    model: "offline",
    async complete(request) {
      assert.match(request.system, /exact output JSON Schema/);
      calls++;
      if (calls <= 2)
        assert.equal(
          (request.schema as { properties: { seed: { const: number } } }).properties.seed.const,
          draft.seed,
        );
      if (calls === 4) {
        const context = JSON.parse(request.prompt);
        assert.equal(context.compilerEvidence.status, "eligible");
        assert.equal(context.compilerEvidence.completeLocalEvidenceRetained, true);
        assert.equal(
          context.compilerEvidence.evidenceCompleteness,
          "complete_locally_summarized_for_transport",
        );
        assert.ok(Array.isArray(context.compilerEvidence.omittedEvidence));
      }
      const output =
        calls === 1
          ? { invalid: true }
          : calls === 2
            ? layout
            : calls === 3
              ? planting
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
                  repairs: [],
                };
      return { output, raw: JSON.stringify(output), usage: null, model: "offline" };
    },
  };
  try {
    const report = await runRegionAuthoring({
      root,
      output: "run",
      prompt: "A fixture anchor",
      generationSeed: draft.seed,
      authority,
      profile,
      planner,
      executionPolicy: EXECUTION_POLICY,
      capture: async () => ({
        images: [{ hash: contentHash("test-preview"), dataUrl: "data:image/png;base64,AA==" }],
        evidence: { testOnly: true },
      }),
    });
    assert.equal(report.status, "eligible", JSON.stringify(report.attempts));
    assert.equal(report.attempts[1]!.visualStatus, "eligible");
    assert.equal(report.modelCalls, 5);
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
          generationSeed: draft.seed,
          authority,
          profile: { ...profile, catalogSnapshotHash: contentHash("stale") },
          planner,
          executionPolicy: EXECUTION_POLICY,
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
        assert.equal(request.images.length, editCalls === 4 ? 2 : 0);
        if (editCalls === 2) {
          assert.match(request.system, /explicitly supports vegetation_clearing objectives/);
          const context = JSON.parse(request.prompt) as { previousExtraction: unknown };
          assert.notEqual(context.previousExtraction, null);
        }
        if (editCalls === 4) {
          assert.equal(request.images[0]!.hash, contentHash("before"));
          assert.equal(request.images[1]!.hash, contentHash("after"));
        }
        if (editCalls >= 4) {
          const context = JSON.parse(request.prompt) as {
            compilerEvidence: { staticInstances: unknown[]; routes: unknown[] };
            editEffect: {
              status: string;
              preservation: { exactRoutes: unknown[]; exactIntents: unknown[] };
            };
          };
          assert.equal(context.editEffect.status, "eligible");
          assert.ok(context.compilerEvidence.staticInstances.length > 0);
          assert.ok(Array.isArray(context.compilerEvidence.routes));
          assert.ok(Array.isArray(context.editEffect.preservation.exactRoutes));
          assert.ok(Array.isArray(context.editEffect.preservation.exactIntents));
        }
        const output =
          editCalls === 1
            ? {
                objectives: [],
                unresolvedRequirements: [
                  "The supported terrain-material edit was not recognized on the first pass",
                ],
              }
            : editCalls === 2
              ? {
                  objectives: [
                    {
                      objectiveId: "ReplaceGroundMaterial",
                      sourceText: "Change soil to grass",
                      kind: "terrain_material",
                      terrainPlanId: base.plan.terrainPlans[0]!.terrainPlanId,
                      operationIndex: 0,
                      requestedMaterialId: "Grass",
                    },
                  ],
                  unresolvedRequirements: [],
                }
              : editCalls === 3
                ? {
                    rationale: "Change only the requested ground material",
                    operations: [
                      {
                        kind: "terrain_material",
                        objectiveIds: ["ReplaceGroundMaterial"],
                        terrainPlanId: base.plan.terrainPlans[0]!.terrainPlanId,
                        operationIndex: 0,
                        materialId: "Grass",
                        polygon: paint.mask.polygon,
                      },
                    ],
                  }
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
      profile,
      planner: editPlanner,
      executionPolicy: EXECUTION_POLICY,
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
    assert.deepEqual(captured, ["before", "after"]);
    assert.equal(edited.modelCalls, 5);
    assert.equal(edited.attempts.length, 1);
    assert.equal((edited.attempts[0]!.editEffect as { status: string }).status, "eligible");
    await assert.rejects(
      () =>
        runRegionAuthoring({
          root,
          output: "run",
          prompt: "Again",
          generationSeed: draft.seed,
          authority,
          profile,
          planner,
          executionPolicy: EXECUTION_POLICY,
        }),
      /must be absent/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a planting-only failure reuses the sealed layout instead of moving valid structure", async () => {
  const { f, semanticModule, profile, draft } = await fixture();
  const { vegetationAreas, ...layout } = draft;
  const root = await mkdtemp(join(tmpdir(), "basalt-planting-retry-"));
  let calls = 0;
  const planner: WorldPlanner = {
    providerId: "Test",
    model: "offline",
    async complete(request) {
      calls++;
      const output =
        calls === 1
          ? layout
          : calls === 2
            ? { vegetationAreas: [{ invalid: true }] }
            : calls === 3
              ? { vegetationAreas }
              : {
                  checks: Object.fromEntries(
                    ["instruction_following", "composition", "grounding", "access"].map(
                      (criterion) => [
                        criterion,
                        { verdict: "pass", note: "Offline planting retry fixture only" },
                      ],
                    ),
                  ),
                  repairs: [],
                };
      if (calls === 3) {
        const context = JSON.parse(request.prompt) as { fixedLayout: unknown };
        assert.deepEqual(context.fixedLayout, layout);
        assert.match(request.system, /Compose land coverage after the structural layout/);
      }
      return { output, raw: JSON.stringify(output), usage: null, model: "offline" };
    },
  };
  try {
    const report = await runRegionAuthoring({
      root,
      output: "run",
      prompt: "A fixture anchor",
      generationSeed: draft.seed,
      authority: {
        semanticModule,
        catalog: { hash: contentHash("catalog"), snapshot: f.snapshot },
        measurements: { assets: [f.asset] },
      } as RegionRunOptions["authority"],
      profile,
      planner,
      executionPolicy: EXECUTION_POLICY,
      capture: async () => ({
        images: [{ hash: contentHash("planting-retry"), dataUrl: "data:image/png;base64,AA==" }],
        evidence: { testOnly: true },
      }),
    });
    assert.equal(report.status, "eligible", JSON.stringify(report.attempts));
    assert.equal(report.modelCalls, 5);
    assert.equal(report.attempts.length, 2);
    assert.equal(report.attempts[0]!.generationFailureStage, "planting");
    assert.deepEqual(report.attempts[1]!.layoutReuse, {
      sourceAttempt: 1,
      layoutHash: contentHash(stableJson(layout)),
      reason:
        "The preceding failure occurred while producing planting data; the verified layout was not regenerated.",
    });
    await assert.rejects(() => readFile(join(root, "run/attempts/2/layout-request.json")));
    assert.equal(
      JSON.parse(await readFile(join(root, "run/attempts/2/layout-reuse.json"), "utf8"))
        .sourceAttempt,
      1,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an invalid visual review retries the same compiled candidate without replanning", async () => {
  const { f, semanticModule, profile, draft } = await fixture();
  const { vegetationAreas, ...layout } = draft;
  const planting = { vegetationAreas };
  const root = await mkdtemp(join(tmpdir(), "basalt-review-retry-"));
  const captured: string[] = [];
  let planningCalls = 0,
    reviews = 0,
    syntheses = 0;
  const reviewContexts: Array<{
    suppliedImageHashes: string[];
    omittedImageHashes: string[];
  }> = [];
  let synthesisContext:
    { imageCoverage: { completeImageHashes: string[]; omissions: string[] } } | undefined;
  const planner: WorldPlanner = {
    providerId: "Test",
    model: "offline",
    async complete(request) {
      const reviewing = request.images.length > 0;
      const synthesizing = /Synthesize linked visual-review batches/u.test(request.system);
      let output: unknown;
      if (synthesizing) {
        syntheses++;
        synthesisContext = JSON.parse(request.prompt) as typeof synthesisContext;
        output = {
          checks: Object.fromEntries(
            ["instruction_following", "composition", "grounding", "access"].map((criterion) => [
              criterion,
              { verdict: "pass", note: "Offline synthesis fixture only" },
            ]),
          ),
          repairs: [],
        };
      } else if (!reviewing) {
        planningCalls++;
        output = planningCalls === 1 ? layout : planting;
      } else {
        reviews++;
        const context = JSON.parse(request.prompt) as {
          reviewBatch: { suppliedImageHashes: string[]; omittedImageHashes: string[] };
        };
        reviewContexts.push(context.reviewBatch);
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
      generationSeed: draft.seed,
      authority: {
        semanticModule,
        catalog: { hash: contentHash("catalog"), snapshot: f.snapshot },
        measurements: { assets: [f.asset] },
      } as RegionRunOptions["authority"],
      profile,
      planner,
      executionPolicy: EXECUTION_POLICY,
      capture: async ({ world }) => {
        captured.push(world.worldBuildHash);
        return {
          images: Array.from({ length: 6 }, (_, index) => ({
            hash: contentHash(`test-preview-${index}`),
            dataUrl: "data:image/png;base64,AA==",
          })),
          evidence: { testOnly: true, worldBuildHash: world.worldBuildHash },
        };
      },
    });
    assert.equal(report.status, "eligible", JSON.stringify(report.attempts));
    assert.equal(planningCalls, 2);
    assert.equal(reviews, 3);
    assert.equal(syntheses, 1);
    assert.equal(report.modelCalls, 6);
    assert.equal(report.attempts.length, 1);
    assert.deepEqual(captured, [report.worldBuildHash]);
    assert.deepEqual(
      reviewContexts[0]!.suppliedImageHashes,
      reviewContexts[1]!.suppliedImageHashes,
      "Malformed review retry must use the same captured batch",
    );
    const reviewedHashes = new Set([
      ...reviewContexts[1]!.suppliedImageHashes,
      ...reviewContexts[2]!.suppliedImageHashes,
    ]);
    assert.equal(reviewedHashes.size, 6);
    assert.equal(reviewContexts[1]!.omittedImageHashes.length, 2);
    assert.equal(reviewContexts[2]!.omittedImageHashes.length, 4);
    assert.equal(synthesisContext!.imageCoverage.completeImageHashes.length, 6);
    assert.deepEqual(synthesisContext!.imageCoverage.omissions, []);
    assert.equal(report.independentReview, false);
    assert.equal(report.engineVerified, false);
    assert.equal(report.creatorAccepted, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
