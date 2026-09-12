#!/usr/bin/env node
// Author the 2x2 district baseline plan: four gentle buildable partitions,
// one rectangular road loop split at partition lines, and no water. The
// spike runs this through today's scatter pipeline to inventory precisely
// what breaks for urban regions. Pure and deterministic; validates its own
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

const HALF = 60;
const PARTITION = 60;
const GRID = 2;
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

const gentleNoise = [
  {
    id: "district_noise_low",
    kind: "value",
    frequency: 0.03,
    amplitude: 0.4,
    octaves: 2,
    lacunarity: 2,
    gain: 0.5,
    seedOffset: 0,
  },
];

const surfaceIdFor = (row, column) => `district_surface_${row}_${column}`;
const partitionIdFor = (row, column) => `district_p_${row}_${column}`;

function terrainPlan(row, column) {
  const { x0, x1, z0, z1 } = partitionBounds(row, column);
  return {
    kind: "TerrainPlan",
    abi: "basalt-terrain-plan@1",
    id: `district_terrain_${row}_${column}`,
    surfaceId: surfaceIdFor(row, column),
    seed: PLAN_SEED,
    bounds: { x: { minimum: x0, maximum: x1 }, z: { minimum: z0, maximum: z1 } },
    resolution: { columns: 31, rows: 31 },
    regions: [
      {
        regionId: partitionIdFor(row, column),
        footprint: rect(x0, z0, x1, z1),
        blendWidth: 8,
        baseElevation: 0,
        noiseLayers: gentleNoise,
        materialWeights: [{ materialId: "districtGround", weight: 1 }],
      },
    ],
    materialBands: [],
    operations: [],
    navigation: { maximumSlopeDegrees: 30 },
  };
}

// Split a world polyline at partition grid lines; joints are computed
// once and shared verbatim by both adjacent segments.
function splitRouteAtPartitions(points) {
  const cuts = [0];
  const segments = [];
  let current = [points[0]];
  let currentKey = null;
  const keyFor = (point) => {
    const column = Math.min(GRID - 1, Math.max(0, Math.floor((point.x + HALF) / PARTITION)));
    const row = Math.min(GRID - 1, Math.max(0, Math.floor((point.z + HALF) / PARTITION)));
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

const ringRoad = [
  { x: -45, y: 0, z: -45 },
  { x: 45, y: 0, z: -45 },
  { x: 45, y: 0, z: 45 },
  { x: -45, y: 0, z: 45 },
  { x: -45, y: 0, z: -45 },
];

const regions = [];
const terrainPlans = [];
const zoneFor = (row, column) =>
  row === 0 && column === 0
    ? "residential"
    : row === 0 && column === 1
      ? "commercial"
      : row === 1 && column === 0
        ? "civic"
        : "residential";
for (let row = 0; row < GRID; row += 1)
  for (let column = 0; column < GRID; column += 1) {
    const { x0, x1, z0, z1 } = partitionBounds(row, column);
    regions.push({
      id: partitionIdFor(row, column),
      name: `District block ${row}-${column}`,
      purpose: "Compile, budget, and emit one district block.",
      zoneTag: zoneFor(row, column),
      refinementPriority: 100,
      volume: {
        kind: "extruded_polygon",
        footprint: rect(x0, z0, x1, z1),
        verticalRange: { minimum: -10, maximum: 20 },
      },
      compositionMeasures: [
        {
          id: `district_composition_${row}_${column}`,
          purpose: "Measure the block surface.",
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
  ...routeSegments("district_ring_road", "District ring road", ringRoad, ["districtSpawn"]),
];

const plan = {
  kind: "SpatialWorldPlan",
  abi: "basalt-world-plan@1",
  id: "districtScene",
  seed: PLAN_SEED,
  references: [
    {
      id: "districtSceneBrief",
      artifactHash: contentHash("district-scene-brief-v1"),
      mediaType: "text/plain",
      origin: "creator_supplied",
      producerQualificationHashes: [],
      rightsEvidenceHashes: [],
      roles: ["creator_brief"],
    },
  ],
  styleContractHash: contentHash("district-style-v1"),
  styleOverlays: [],
  bounds: { center: { x: 0, y: 5, z: 0 }, size: { x: 120, y: 30, z: 120 } },
  regions,
  regionRelations: [],
  terrainPlans,
  constructedSurfaces: [],
  routes,
  anchors: [
    {
      id: "districtSpawn",
      type: "spawn",
      bindingName: "districtSceneSpawn",
      regionId: "district_p_0_0",
      position: { x: 0, y: 1, z: 0 },
    },
  ],
  collisionProxies: [],
  cameras: [
    {
      id: "districtOverview",
      name: "District overview",
      purpose: "Show the full district.",
      regionIds: regions.map((region) => region.id),
      framingAssetIds: [],
      position: { x: 0, y: 120, z: 140 },
      lookAt: { x: 0, y: 0, z: 0 },
      up: { x: 0, y: 1, z: 0 },
      fieldOfViewDegrees: 55,
      nearClip: 0.1,
      farClip: 2000,
      width: 1280,
      height: 720,
      declaredState: "Overview",
      evidenceRole: "global_overview",
      readabilityIntent: { kind: "art_directed", rationale: "District readability." },
    },
  ],
  assetRequirements: [],
  tolerances: { support: 0.05, penetration: 0.05, clearance: 1 },
  creatorClaims: [
    { id: "districtSceneClaim", statement: "District spike", referenceIds: ["districtSceneBrief"] },
  ],
  agentHypotheses: [],
  seaLevelStuds: SEA_LEVEL_STUDS,
  terrainAppearance: {
    grass: { enabled: true, lengthStuds: 0.6 },
    materialTints: [{ materialId: "districtGround", colorRgb: { r: 0.55, g: 0.58, b: 0.5 } }],
  },
};

const parsed = planning.WORLD_PLAN_SCHEMA.parse(plan);
const outputPath = resolve(repositoryRoot, "test/fixtures/district-region.plan.json");
await writeFile(outputPath, `${JSON.stringify(parsed, null, 2)}\n`);
process.stdout.write(
  `District plan: ${parsed.regions.length} regions, ${parsed.terrainPlans.length} surfaces, ` +
    `${parsed.routes.length} route segments\n`,
);
