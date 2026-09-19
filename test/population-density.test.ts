import assert from "node:assert/strict";
import test from "node:test";
import { POPULATION_DENSITY_FIELD_SCHEMA } from "@basalt/catalog-model";
import { compileBasaltWorld, populationDensityAt } from "@basalt/world-compiler";
import { sealSpatialWorldPlan } from "@basalt/world-planning";
import { loadSemanticRegistry } from "./helpers/semantic-registry.js";
import { worldFixture } from "./helpers/world-fixture.js";

test("density fields have smooth edges, shared spatial patches, and explicit bounds", () => {
  const field = {
    seed: 72,
    edgeFadeMeters: 4,
    wavelengthMeters: 8,
    minimumDensity: 0.08,
    patchContrast: 2,
  };
  const values = Array.from({ length: 40 }, (_, x) => populationDensityAt(field, x, 3, 8));
  assert.ok(Math.max(...values) - Math.min(...values) > 0.1);
  assert.equal(populationDensityAt(field, 3, 4, 0), 0);
  assert.ok(populationDensityAt(field, 3, 4, 0.5) < populationDensityAt(field, 3, 4, 4));
  assert.ok(
    Math.abs(
      populationDensityAt(field, 8 - 1e-6, 3, 8) - populationDensityAt(field, 8 + 1e-6, 3, 8),
    ) < 1e-6,
  );
  assert.deepEqual(
    values,
    Array.from({ length: 40 }, (_, x) => populationDensityAt({ ...field }, x, 3, 8)),
  );
  assert.notDeepEqual(
    values,
    Array.from({ length: 40 }, (_, x) => populationDensityAt({ ...field, seed: 73 }, x, 3, 8)),
  );
  assert.throws(() => POPULATION_DENSITY_FIELD_SCHEMA.parse({ ...field, minimumDensity: 2 }));
  assert.throws(() => POPULATION_DENSITY_FIELD_SCHEMA.parse({ ...field, wavelengthMeters: 0 }));
});

test("density affects candidate admission without relaxing occupancy, route clearance, or minimum counts", async () => {
  const semanticModule = await loadSemanticRegistry();
  const fixture = await worldFixture(semanticModule);
  const { kind: _kind, coordinateSystem: _coordinates, planHash: _hash, ...body } = fixture.plan;
  const intent = {
    kind: "cluster" as const,
    intentId: "FeatheredStand",
    requirementId: fixture.requirement.requirementId,
    priority: 10,
    regionId: "MainRegion",
    surfaceId: "GroundSurface",
    center: { u: 10, v: 11 },
    radiusMeters: 6,
    minimumCount: 6,
    targetCount: 6,
    minimumSeparationMeters: 0.1,
    densityField: {
      seed: 72,
      edgeFadeMeters: 4,
      wavelengthMeters: 5,
      minimumDensity: 0.1,
      patchContrast: 2,
    },
  };
  const compile = (densityField: typeof intent.densityField) =>
    compileBasaltWorld({
      semanticModule,
      catalogSnapshot: fixture.snapshot,
      catalogAssets: [fixture.asset],
      spatialPlan: sealSpatialWorldPlan({
        ...body,
        realizationIntents: [{ ...intent, densityField }],
      }),
    });
  const first = compile(intent.densityField);
  assert.equal(first.status, "eligible", first.diagnostics.join("; "));
  assert.equal(first.instances.length, 6);
  assert.equal(first.worldBuildHash, compile(intent.densityField).worldBuildHash);
  for (const instance of first.instances) {
    assert.ok(instance.boundsMeters.min.z >= 2.5);
    assert.ok(instance.boundsMeters.min.x >= 0 && instance.boundsMeters.max.x <= 20);
  }
  const empty = compile({
    ...intent.densityField,
    edgeFadeMeters: 10_000,
    minimumDensity: 0,
    patchContrast: 8,
  });
  assert.equal(empty.status, "incomplete");
  assert.equal(empty.instances.length, 0);
  assert.ok(empty.diagnostics.some((d) => d.includes("no valid spatial targets")));
});
