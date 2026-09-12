import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { contentHash, stableJson } from "../packages/contracts/src/index.js";
import {
  MAXIMUM_VOXEL_CELLS,
  compileWorldPlan,
  exportVoxelField,
} from "../packages/world-planning/src/index.js";
import {
  clearanceRadius,
  compileHierarchicalWorld,
  sealWorldAssetFamilyRegistry,
} from "../packages/world-compiler/src/index.js";
import { groundingEvidenceFixture } from "./helpers/grounding-evidence.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const planJson = JSON.parse(
  readFileSync(resolve(root, "test/fixtures/bay-region.plan.json"), "utf8"),
);

function partitions() {
  return compileWorldPlan(planJson).terrainFields;
}

test("Bay plan seals sixteen budgeted partitions", () => {
  const fields = partitions();
  assert.equal(fields.length, 16);
  assert.deepEqual(
    fields.map((field) => field.surfaceId).sort(),
    fields.map((field) => field.surfaceId),
  );
  let total = 0;
  for (const field of fields) {
    const exported = exportVoxelField(field, { seaLevelStuds: planJson.seaLevelStuds });
    const cells = exported.dimensions[0] * exported.dimensions[1] * exported.dimensions[2];
    assert.ok(cells <= MAXIMUM_VOXEL_CELLS, `${field.surfaceId} exceeds the voxel budget`);
    assert.ok(exported.dimensions[0] === 15 && exported.dimensions[2] === 15);
    total += cells;
  }
  assert.equal(total, 18675);
});

test("Bay plan compiles byte-identically across runs", () => {
  const first = compileWorldPlan(planJson);
  const second = compileWorldPlan(planJson);
  assert.equal(first.worldPlanHash, second.worldPlanHash);
  assert.equal(stableJson(first.terrainFields), stableJson(second.terrainFields));
  assert.equal(first.worldPlanHash.slice(0, 12), "43d2a014d906");
});

test("Bay material bands obey elevation and slope everywhere", () => {
  const seen = new Set<string>();
  for (const field of partitions())
    for (const sample of field.samples) {
      const [material] = Object.entries(sample.materialWeights).sort(
        ([leftId, left], [rightId, right]) => right - left || (leftId < rightId ? -1 : 1),
      )[0]!;
      seen.add(material);
      const h = sample.position.y;
      const slope = sample.slopeDegrees;
      if (material === "bayCliff") assert.ok(slope >= 35, `cliff on flat ground at ${h}`);
      else {
        assert.ok(slope < 35, `${material} on a cliff at ${h}`);
        if (material === "bayFloor") assert.ok(h < -2, `floor above sea at ${h}`);
        else if (material === "baySand") assert.ok(h >= -2 && h < 1.5, `sand out of band at ${h}`);
        else if (material === "bayDune") assert.ok(h >= 1.5 && h < 4.5, `dune out of band at ${h}`);
        else if (material === "bayMeadow") assert.ok(h >= 4.5, `meadow low at ${h}`);
        else assert.fail(`unknown band material ${material}`);
      }
    }
  assert.deepEqual([...seen].sort(), ["bayCliff", "bayDune", "bayFloor", "bayMeadow", "baySand"]);
});

test("Bay partition boundaries share bit-identical heights", () => {
  const bySurface = new Map(partitions().map((field) => [field.surfaceId, field]));
  const surfaceId = (row: number, column: number) => `bay_surface_${row}_${column}`;
  // Grids are 31x31 over 60 studs: step 2, edges shared between neighbors.
  // Roadbed carves extend across exact joints, so road crossings match too.
  for (let row = 0; row < 4; row += 1)
    for (let column = 0; column < 4; column += 1) {
      const field = bySurface.get(surfaceId(row, column))!;
      const at = (ix: number, iz: number) => field.samples[iz * 31 + ix]!.position;
      if (column < 3) {
        const east = bySurface.get(surfaceId(row, column + 1))!;
        for (let iz = 0; iz < 31; iz += 1)
          assert.equal(
            at(30, iz).y,
            east.samples[iz * 31 + 0]!.position.y,
            `east seam (${row},${column}) row ${iz}`,
          );
      }
      if (row < 3) {
        const south = bySurface.get(surfaceId(row + 1, column))!;
        for (let ix = 0; ix < 31; ix += 1)
          assert.equal(
            at(ix, 30).y,
            south.samples[0 * 31 + ix]!.position.y,
            `south seam (${row},${column}) column ${ix}`,
          );
      }
    }
});

function bayPopulation(terrainOnly = false) {
  const partitions = planJson.regions.map((region: { id: string }) => region.id);
  const routeIds = planJson.routes.map((route: { id: string }) => route.id);
  const scrubEvidence = groundingEvidenceFixture("BayScrub", 1);
  const canopyEvidence = groundingEvidenceFixture("BayCanopy", 1);
  return compileHierarchicalWorld({
    worldPlan: planJson,
    styleContractHash: contentHash("bay-style-test"),
    familyRegistry: sealWorldAssetFamilyRegistry([
      {
        familyId: "BayScrub",
        semanticTags: ["scrub"],
        styleTags: ["coherent"],
        roleTags: ["scatter"],
        variantCount: 1,
      },
      {
        familyId: "BayCanopy",
        semanticTags: ["canopy"],
        styleTags: ["coherent"],
        roleTags: ["cluster"],
        variantCount: 1,
      },
    ]),
    familyRequests: [
      {
        biomeId: "bay",
        semanticTags: ["scrub"],
        styleTags: ["coherent"],
        roleTags: ["scatter"],
        minimumFamilies: 1,
        maximumFamilies: 1,
        regionIds: partitions,
        surfaceKinds: ["terrain"],
        distribution: "poisson_scatter",
        maximumCount: 400,
        density: { minimum: 0, target: terrainOnly ? 0 : 0.3, maximum: terrainOnly ? 0 : 1 },
        variationSeed: 11,
        excludedRouteIds: routeIds,
        elevationBandStuds: { minimum: -1 },
        maximumSlopeDegrees: 10,
      },
      {
        biomeId: "bay",
        semanticTags: ["canopy"],
        styleTags: ["coherent"],
        roleTags: ["cluster"],
        minimumFamilies: 1,
        maximumFamilies: 1,
        regionIds: partitions,
        surfaceKinds: ["terrain"],
        distribution: "cluster",
        maximumCount: 200,
        density: { minimum: 0, target: terrainOnly ? 0 : 0.2, maximum: terrainOnly ? 0 : 1 },
        variationSeed: 23,
        excludedRouteIds: routeIds,
        elevationBandStuds: { minimum: 2 },
      },
    ],
    stage: "partition",
    population: {
      groundingEvidence: {
        ...scrubEvidence,
        evidence: [...scrubEvidence.evidence, ...canopyEvidence.evidence],
      },
    },
  });
}

function bayInstances(world: ReturnType<typeof bayPopulation>) {
  return world.microPopulation!.chunks.flatMap((chunk) => chunk.instances);
}

test("Bay population is deterministic across runs", () => {
  const first = bayPopulation();
  const second = bayPopulation();
  assert.equal(first.microPopulation!.hash, second.microPopulation!.hash);
  assert.deepEqual(bayInstances(first), bayInstances(second));
  assert.ok(first.microPopulation!.instanceCount > 50, "bay must place to prove its invariants");
});

test("Bay population covers every partition with pinned totals", () => {
  const world = bayPopulation();
  const instances = bayInstances(world);
  assert.equal(
    world.microPopulation!.hash,
    "a943615f296116a5ee26c1e147321032bb3b7ec64770d7957509c236a87b2b26",
  );
  assert.equal(world.microPopulation!.instanceCount, 109);
  const scrub = instances.filter((instance) => instance.familyId === "BayScrub");
  const canopy = instances.filter((instance) => instance.familyId === "BayCanopy");
  assert.equal(scrub.length, 65);
  assert.equal(canopy.length, 44);
  const surfaces = compileWorldPlan(planJson).surfaces;
  for (const surfaceId of surfaces.ids()) {
    const bounds = surfaces.coordinateBounds(surfaceId);
    const inside = instances.filter(
      (instance) =>
        instance.position.x >= bounds.u.minimum &&
        instance.position.x <= bounds.u.maximum &&
        instance.position.z >= bounds.v.minimum &&
        instance.position.z <= bounds.v.maximum,
    );
    assert.ok(inside.length >= 4, `${surfaceId} holds only ${inside.length} instances`);
  }
});

test("Bay emission assigns every surface to a covering chunk tile", () => {
  for (const terrainOnly of [false, true]) {
    const world = bayPopulation(terrainOnly);
    if (terrainOnly) assert.equal(world.microPopulation!.instanceCount, 0);
    const surfaces = compileWorldPlan(planJson).surfaces;
    const emission = world.partitionEmission!;
    const assigned = new Set(emission.chunks.flatMap((chunk) => chunk.surfaceIds));
    for (const surfaceId of surfaces.ids())
      assert.ok(
        assigned.has(surfaceId),
        `${surfaceId} is never written (terrainOnly=${terrainOnly})`,
      );
    // Each assignment must be tile-honest: the surface overlaps the chunk's
    // own 128-stud tile, not merely the chunk's content bounds.
    for (const chunk of emission.chunks) {
      const [xText, zText] = chunk.chunkId.replace(/^chunk_/, "").split("_");
      const tile = {
        minimum: { x: Number(xText) * 128, z: Number(zText) * 128 },
        maximum: { x: Number(xText) * 128 + 128, z: Number(zText) * 128 + 128 },
      };
      for (const surfaceId of chunk.surfaceIds) {
        const bounds = surfaces.coordinateBounds(surfaceId);
        assert.ok(
          bounds.u.maximum >= tile.minimum.x &&
            bounds.u.minimum <= tile.maximum.x &&
            bounds.v.maximum >= tile.minimum.z &&
            bounds.v.minimum <= tile.maximum.z,
          `${surfaceId} does not touch ${chunk.chunkId}`,
        );
      }
    }
  }
});

test("Bay population holds world-space spacing", () => {
  const instances = bayInstances(bayPopulation());
  for (let left = 0; left < instances.length; left += 1)
    for (let right = left + 1; right < instances.length; right += 1) {
      const a = instances[left]!;
      const b = instances[right]!;
      const minimum =
        clearanceRadius(a.footprint.contactRadiusStuds, a.scale) +
        clearanceRadius(b.footprint.contactRadiusStuds, b.scale);
      const distance = Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z);
      assert.ok(
        distance + 1e-9 >= minimum,
        `spacing violation between ${a.id} and ${b.id} (${distance} < ${minimum})`,
      );
    }
});

test("Bay population honors setback bands, slope caps, and corridors", () => {
  const world = bayPopulation();
  const instances = bayInstances(world);
  const surfaces = compileWorldPlan(planJson).surfaces;
  const links: Array<[{ x: number; z: number }, { x: number; z: number }]> = [];
  for (const route of planJson.routes)
    for (let index = 0; index < route.points.length - 1; index += 1)
      links.push([route.points[index], route.points[index + 1]]);
  const corridorDistance = (x: number, z: number) => {
    let best = Number.POSITIVE_INFINITY;
    for (const [a, b] of links) {
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const t = Math.min(1, Math.max(0, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz)));
      best = Math.min(best, Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t)));
    }
    return best;
  };
  const surfaceIds = world.foundation.terrainSurfaceIds;
  const containing = (x: number, z: number) =>
    surfaceIds.filter((surfaceId) => {
      const bounds = surfaces.coordinateBounds(surfaceId);
      return (
        x >= bounds.u.minimum &&
        x <= bounds.u.maximum &&
        z >= bounds.v.minimum &&
        z <= bounds.v.maximum
      );
    });
  for (const instance of instances) {
    const floor = instance.familyId === "BayScrub" ? -1 : 2;
    assert.ok(
      instance.footprint.restYStuds >= floor,
      `${instance.id} rests below its setback at ${instance.footprint.restYStuds}`,
    );
    assert.ok(
      corridorDistance(instance.position.x, instance.position.z) >= 3,
      `${instance.id} sits in a road corridor`,
    );
    if (instance.familyId === "BayScrub") {
      // Placement-side slope is authoritative; the minimum over containing
      // surfaces bounds it (normals differ one-sided at seams).
      const slopes = containing(instance.position.x, instance.position.z).map(
        (surfaceId) =>
          surfaces.sample(surfaceId, { u: instance.position.x, v: instance.position.z })
            .slopeDegrees,
      );
      assert.ok(slopes.length > 0);
      assert.ok(Math.min(...slopes) <= 10, `${instance.id} exceeds its slope cap`);
    }
  }
  // Vacuity guards: the bay must offer water, cliffs, and roads to refuse.
  const slopes = partitions().flatMap((field) =>
    field.samples.map((sample) => sample.slopeDegrees),
  );
  assert.ok(Math.max(...slopes) > 10, "bay needs steep ground to prove the slope cap");
  const heights = partitions().flatMap((field) => field.samples.map((sample) => sample.position.y));
  assert.ok(Math.min(...heights) < -1, "bay needs water to prove the setback");
});

test("Bay route segments share exact joints", () => {
  const segments = new Map<
    string,
    Array<{ id: string; points: Array<{ x: number; y: number; z: number }> }>
  >();
  for (const route of planJson.routes) {
    const prefix = route.id.replace(/_\d+$/, "");
    if (!segments.has(prefix)) segments.set(prefix, []);
    segments.get(prefix)!.push(route);
  }
  assert.deepEqual([...segments.keys()].sort(), ["bay_coast_road", "bay_north_road"]);
  for (const [prefix, runs] of segments) {
    const ordinal = (id: string) => Number(id.slice(prefix.length + 1));
    runs.sort((left, right) => ordinal(left.id) - ordinal(right.id));
    assert.ok(runs.length > 1, `${prefix} spans partitions`);
    for (let index = 0; index < runs.length - 1; index += 1) {
      const joint = runs[index]!.points[runs[index]!.points.length - 1]!;
      assert.deepEqual(joint, runs[index + 1]!.points[0], `${prefix} joint ${index}`);
    }
  }
});
