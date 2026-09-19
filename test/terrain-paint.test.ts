import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateTerrainElevation,
  evaluateTerrainMaterial,
  sealSpatialWorldPlan,
  type TerrainPlan,
} from "@basalt/world-planning";
import {
  compileBasaltWorld,
  sampleTerrainFieldSurface,
  sealBaseTerrainFieldArtifact,
} from "@basalt/world-compiler";
import { loadSemanticRegistry } from "./helpers/semantic-registry.js";
import { worldFixture } from "./helpers/world-fixture.js";

test("terrain paint binds sampled materials while leaving heights and route geometry intact", async () => {
  const semanticModule = await loadSemanticRegistry();
  const fixture = await worldFixture(semanticModule);
  const source = fixture.plan.terrainPlans[0]!;
  const polygon = [
    { x: 0, z: 0 },
    { x: 30, z: 0 },
    { x: 30, z: 30 },
    { x: 0, z: 30 },
  ];
  const painted: TerrainPlan = {
    ...source,
    operations: [
      ...source.operations,
      { kind: "paint", polygon, materialId: "LeafyGrass" },
      {
        kind: "paint",
        polygon: [
          { x: 2, z: 2 },
          { x: 4, z: 2 },
          { x: 4, z: 4 },
          { x: 2, z: 4 },
        ],
        materialId: "Ground",
      },
    ],
  };
  assert.equal(evaluateTerrainMaterial(painted, 1, 1), "LeafyGrass");
  assert.equal(evaluateTerrainMaterial(painted, 3, 3), "Ground");
  assert.equal(evaluateTerrainMaterial(painted, 40, 40), source.materialId);
  assert.equal(
    evaluateTerrainMaterial(painted, 0, 0),
    "LeafyGrass",
    "Boundary has a deterministic material",
  );
  assert.throws(() => evaluateTerrainMaterial(painted, NaN, 0), /finite/u);
  for (const [x, z] of [
    [1, 1],
    [3, 3],
    [20, 15],
    [40, 40],
  ])
    assert.equal(
      evaluateTerrainElevation(painted, x!, z!),
      evaluateTerrainElevation(source, x!, z!),
    );
  assert.notEqual(
    sealBaseTerrainFieldArtifact(source).hash,
    sealBaseTerrainFieldArtifact(painted).hash,
  );
  const plan = structuredClone(fixture.plan);
  plan.terrainPlans[0] = painted;
  const { kind: _kind, coordinateSystem: _coordinates, planHash: _hash, ...body } = plan;
  const input = {
    semanticModule,
    catalogSnapshot: fixture.snapshot,
    catalogAssets: [fixture.asset],
    spatialPlan: fixture.plan,
  };
  const before = compileBasaltWorld(input);
  const after = compileBasaltWorld({ ...input, spatialPlan: sealSpatialWorldPlan(body) });
  assert.equal(after.status, before.status);
  for (const [index, route] of after.foundation.routeConstructions.entries()) {
    assert.deepEqual(
      route.travelSegments,
      before.foundation.routeConstructions[index]!.travelSegments,
    );
    if (!route.materialMask || route.terrainTreatment.kind !== "grade") continue;
    const station = route.profile[Math.floor(route.profile.length / 2)]!;
    const surface = sampleTerrainFieldSurface(
      after.foundation.terrainFields[0]!,
      after.foundation.baseTerrainFields[0]!,
      after.foundation.routeConstructions,
      after.foundation.routeJunctions,
      station.centerTopMeters.x,
      station.centerTopMeters.z,
    );
    assert.equal(
      surface.materialId,
      route.materialMask.terrainMaterialId,
      "Route treatment must override ground paint",
    );
  }
});
