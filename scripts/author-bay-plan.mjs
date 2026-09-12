#!/usr/bin/env node
// Author the 4x4 coastal bay world plan: 16 partitions sharing one seed,
// one relief-op program, and one material-band program in world
// coordinates, so relief and bands are continuous across partition
// boundaries by construction. Pure and deterministic; validates its own
// output against WORLD_PLAN_SCHEMA before writing.
import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertRuntimeBuildCurrent } from "./runtime-build-manifest.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
await assertRuntimeBuildCurrent();
const planning = await import(
  pathToFileURL(resolve(repositoryRoot, "dist/packages/world-planning/src/index.js")).href
);
const { contentHash } = await import(
  pathToFileURL(resolve(repositoryRoot, "dist/packages/contracts/src/index.js")).href
);

const HALF = 120;
const PARTITION = 60;
const SEA_LEVEL_STUDS = -2;
const PLAN_SEED = 20260912;

const partitionBounds = (row, column) => ({
  x0: -HALF + column * PARTITION,
  x1: -HALF + (column + 1) * PARTITION,
  z0: -HALF + row * PARTITION,
  z1: -HALF + (row + 1) * PARTITION,
});

const rect = (x0, z0, x1, z1) => [
  { x: x0, z: z0 },
  { x: x1, z: z0 },
  { x: x1, z: z1 },
  { x: x0, z: z1 },
];

const sharedNoiseLayers = [
  {
    id: "bay_noise_low",
    kind: "value",
    frequency: 0.02,
    amplitude: 2,
    octaves: 3,
    lacunarity: 2,
    gain: 0.5,
    seedOffset: 0,
  },
  {
    id: "bay_noise_detail",
    kind: "ridged",
    frequency: 0.07,
    amplitude: 0.7,
    octaves: 2,
    lacunarity: 2,
    gain: 0.5,
    seedOffset: 101,
  },
];

// World-coordinate relief program, identical in all 16 plans.
const sharedOperations = [
  {
    id: "bay_slope",
    kind: "slope",
    directionDegrees: -90,
    risePerUnit: 0.06,
    origin: { x: 0, z: 120 },
  },
  {
    id: "bay_basin",
    kind: "basin",
    center: { x: 0, z: 75 },
    radius: 85,
    depth: 17,
    falloff: 1.5,
  },
  {
    id: "bay_channel",
    kind: "channel",
    points: [
      { x: 0, z: 55 },
      { x: 0, z: 120 },
    ],
    width: 30,
    depth: 7,
  },
  {
    id: "bay_peak_west",
    kind: "peak",
    center: { x: -95, z: -55 },
    radius: 60,
    height: 9,
    falloff: 2,
  },
  {
    id: "bay_peak_east",
    kind: "peak",
    center: { x: 95, z: -55 },
    radius: 60,
    height: 9,
    falloff: 2,
  },
  {
    id: "bay_dunes",
    kind: "dune",
    directionDegrees: 90,
    wavelength: 22,
    height: 1.1,
  },
  {
    id: "bay_spawn_pad",
    kind: "local_patch",
    center: { x: 0, z: -40 },
    radius: 14,
    falloff: 2,
    edit: { kind: "flatten", elevation: 9, strength: 1 },
  },
];

// First match wins: cliffs beat elevation, water floor beats beach.
const sharedBands = [
  { materialId: "bayCliff", aboveSlopeDegrees: 35 },
  { materialId: "bayFloor", belowElevationStuds: -2 },
  { materialId: "baySand", belowElevationStuds: 1.5 },
  { materialId: "bayDune", belowElevationStuds: 4.5 },
];

const surfaceIdFor = (row, column) => `bay_surface_${row}_${column}`;
const partitionIdFor = (row, column) => `bay_p_${row}_${column}`;
// Terrain zones share the world-partition namespace: the schema requires
// every terrain region id to name a world region.
const zoneIdFor = (row, column) => partitionIdFor(row, column);

function terrainPlan(row, column) {
  const { x0, x1, z0, z1 } = partitionBounds(row, column);
  // The pad names its own plan zone so the world-coordinate flatten
  // applies identically in every plan it touches (no seams).
  const operations = sharedOperations.map((operation) =>
    operation.id === "bay_spawn_pad"
      ? { ...operation, regionId: zoneIdFor(row, column) }
      : operation,
  );
  return {
    kind: "TerrainPlan",
    abi: "basalt-terrain-plan@1",
    id: `bay_terrain_${row}_${column}`,
    surfaceId: surfaceIdFor(row, column),
    seed: PLAN_SEED,
    bounds: { x: { minimum: x0, maximum: x1 }, z: { minimum: z0, maximum: z1 } },
    resolution: { columns: 31, rows: 31 },
    regions: [
      {
        regionId: zoneIdFor(row, column),
        footprint: rect(x0, z0, x1, z1),
        blendWidth: 8,
        baseElevation: 0,
        noiseLayers: sharedNoiseLayers,
        materialWeights: [{ materialId: "bayMeadow", weight: 1 }],
      },
    ],
    materialBands: sharedBands,
    operations,
    navigation: { maximumSlopeDegrees: 30 },
  };
}

// Split a world polyline at partition grid lines; joints are computed
// once and shared verbatim by both adjacent segments.
function splitRouteAtPartitions(points) {
  const cuts = [-60, 0, 60];
  const segments = [];
  let current = [points[0]];
  let currentKey = null;
  const keyFor = (point) => {
    const column = Math.min(3, Math.max(0, Math.floor((point.x + HALF) / PARTITION)));
    const row = Math.min(3, Math.max(0, Math.floor((point.z + HALF) / PARTITION)));
    return `${row}_${column}`;
  };
  const crossings = (a, b) => {
    const found = [];
    for (const line of cuts) {
      if ((a.x - line) * (b.x - line) < 0) {
        const t = (line - a.x) / (b.x - a.x);
        found.push({ t, point: { x: line, y: 0, z: a.z + (b.z - a.z) * t } });
      }
      if ((a.z - line) * (b.z - line) < 0) {
        const t = (line - a.z) / (b.z - a.z);
        found.push({ t, point: { x: a.x + (b.x - a.x) * t, y: 0, z: line } });
      }
    }
    return found.sort((left, right) => left.t - right.t);
  };
  for (let index = 0; index < points.length - 1; index += 1) {
    const a = points[index];
    const b = points[index + 1];
    const joints = crossings(a, b);
    const chain = [a, ...joints.map((joint) => joint.point), b];
    for (let link = 0; link < chain.length - 1; link += 1) {
      const from = chain[link];
      const to = chain[link + 1];
      const mid = { x: (from.x + to.x) / 2, z: (from.z + to.z) / 2 };
      const key = keyFor(mid);
      if (currentKey === null) currentKey = key;
      if (key !== currentKey) {
        segments.push({ key: currentKey, points: current });
        current = [from];
        currentKey = key;
      }
      current.push(to);
    }
  }
  segments.push({ key: currentKey, points: current });
  return segments;
}

function routeSegments(routeId, name, points, anchorIds) {
  return splitRouteAtPartitions(points).map((segment, index) => {
    const [row, column] = segment.key.split("_").map(Number);
    return {
      id: `${routeId}_${index}`,
      name: `${name} segment ${index}`,
      surfaceId: surfaceIdFor(row, column),
      regionIds: [partitionIdFor(row, column)],
      points: segment.points,
      width: 6,
      materialId: "asphalt",
      closed: false,
      maximumSlopeDegrees: 30,
      maximumStepHeight: 1,
      agentRadius: 1,
      agentHeight: 6,
      heightClearance: 8,
      reachableAnchorIds: anchorIds,
    };
  });
}

const coastRoad = [
  { x: -115, y: 0, z: 30 },
  { x: -80, y: 0, z: 22 },
  { x: -40, y: 0, z: 18 },
  { x: 0, y: 0, z: 16 },
  { x: 40, y: 0, z: 18 },
  { x: 80, y: 0, z: 22 },
  { x: 115, y: 0, z: 30 },
];
const northRoad = [
  { x: -100, y: 0, z: -100 },
  { x: -40, y: 0, z: -110 },
  { x: 40, y: 0, z: -110 },
  { x: 100, y: 0, z: -100 },
];

const regions = [];
const terrainPlans = [];
for (let row = 0; row < 4; row += 1)
  for (let column = 0; column < 4; column += 1) {
    const { x0, x1, z0, z1 } = partitionBounds(row, column);
    regions.push({
      id: partitionIdFor(row, column),
      name: `Bay partition ${row}-${column}`,
      purpose: "Compile, budget, and emit one coastal partition.",
      refinementPriority: 100,
      volume: {
        kind: "extruded_polygon",
        footprint: rect(x0, z0, x1, z1),
        verticalRange: { minimum: -20, maximum: 40 },
      },
      compositionMeasures: [
        {
          id: `bay_composition_${row}_${column}`,
          purpose: "Measure the partition surface.",
          surfaceId: surfaceIdFor(row, column),
          origin: { x: (x0 + x1) / 2, y: 0, z: (z0 + z1) / 2 },
          uAxis: { x: 1, y: 0, z: 0 },
          vAxis: { x: 0, y: 0, z: 1 },
          boundary: [
            { u: -30, v: -30 },
            { u: 30, v: -30 },
            { u: 30, v: 30 },
            { u: -30, v: 30 },
          ],
          densityTarget: 1,
          minimumNegativeSpace: 0,
        },
      ],
    });
    terrainPlans.push(terrainPlan(row, column));
  }

const routes = [
  ...routeSegments("bay_coast_road", "Bay coast road", coastRoad, ["baySpawn"]),
  ...routeSegments("bay_north_road", "Bay north road", northRoad, ["baySpawn"]),
];

const plan = {
  kind: "SpatialWorldPlan",
  abi: "basalt-world-plan@1",
  id: "bayScene",
  seed: PLAN_SEED,
  references: [
    {
      id: "baySceneBrief",
      artifactHash: contentHash("bay-scene-brief-v1"),
      mediaType: "text/plain",
      origin: "creator_supplied",
      producerQualificationHashes: [],
      rightsEvidenceHashes: [],
      roles: ["creator_brief"],
    },
  ],
  styleContractHash: contentHash("bay-style-v1"),
  styleOverlays: [],
  bounds: { center: { x: 0, y: 10, z: 0 }, size: { x: 240, y: 60, z: 240 } },
  regions,
  regionRelations: [],
  terrainPlans,
  constructedSurfaces: [],
  routes,
  anchors: [
    {
      id: "baySpawn",
      type: "spawn",
      bindingName: "baySceneSpawn",
      regionId: "bay_p_1_2",
      position: { x: 0, y: 9, z: -40 },
    },
  ],
  collisionProxies: [],
  cameras: [
    {
      id: "bayOverview",
      name: "Bay overview",
      purpose: "Show the full coastal bay.",
      regionIds: regions.map((region) => region.id),
      framingAssetIds: [],
      position: { x: 0, y: 150, z: 260 },
      lookAt: { x: 0, y: 0, z: 30 },
      up: { x: 0, y: 1, z: 0 },
      fieldOfViewDegrees: 55,
      nearClip: 0.1,
      farClip: 2000,
      width: 1280,
      height: 720,
      declaredState: "Overview",
      evidenceRole: "global_overview",
      readabilityIntent: { kind: "art_directed", rationale: "Bay readability." },
    },
    {
      id: "bayShore",
      name: "Bay shore",
      purpose: "Show the shoreline waterline.",
      regionIds: ["bay_p_2_1", "bay_p_2_2"],
      framingAssetIds: [],
      position: { x: -40, y: 12, z: 70 },
      lookAt: { x: 20, y: 0, z: 40 },
      up: { x: 0, y: 1, z: 0 },
      fieldOfViewDegrees: 55,
      nearClip: 0.1,
      farClip: 1000,
      width: 1280,
      height: 720,
      declaredState: "Overview",
      evidenceRole: "region_detail",
      readabilityIntent: { kind: "art_directed", rationale: "Shore readability." },
    },
  ],
  assetRequirements: [],
  tolerances: { support: 0.05, penetration: 0.05, clearance: 1 },
  creatorClaims: [
    { id: "baySceneClaim", statement: "Coastal bay", referenceIds: ["baySceneBrief"] },
  ],
  agentHypotheses: [],
  seaLevelStuds: SEA_LEVEL_STUDS,
  terrainAppearance: {
    water: {
      colorRgb: { r: 0.1, g: 0.5, b: 0.55 },
      transparency: 0.35,
      reflectance: 0.6,
      waveSizeStuds: 1.5,
      waveSpeedStuds: 3,
    },
    grass: { enabled: true, lengthStuds: 0.6 },
    materialTints: [
      { materialId: "bayMeadow", colorRgb: { r: 0.42, g: 0.66, b: 0.28 } },
      { materialId: "baySand", colorRgb: { r: 0.92, g: 0.82, b: 0.64 } },
      { materialId: "bayFloor", colorRgb: { r: 0.55, g: 0.6, b: 0.5 } },
      { materialId: "bayDune", colorRgb: { r: 0.9, g: 0.8, b: 0.62 } },
      { materialId: "bayCliff", colorRgb: { r: 0.45, g: 0.42, b: 0.4 } },
    ],
  },
};

const parsed = planning.WORLD_PLAN_SCHEMA.parse(plan);
const outputPath = resolve(repositoryRoot, "test/fixtures/bay-region.plan.json");
await writeFile(outputPath, `${JSON.stringify(parsed, null, 2)}\n`);
process.stdout.write(
  `Bay plan: ${parsed.regions.length} regions, ${parsed.terrainPlans.length} surfaces, ` +
    `${parsed.routes.length} route segments\n`,
);
