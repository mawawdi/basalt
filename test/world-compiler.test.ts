import assert from "node:assert/strict";
import test from "node:test";
import { contentHash, stableJson } from "@basalt/contracts";
import {
  createSemanticDependencyClosure,
  sealSemanticAssertionBundle,
} from "@basalt/semantic-kernel";
import {
  compileBasaltWorld,
  sampleTerrainFieldElevation,
  sealCompilationTaskResult,
} from "@basalt/world-compiler";
import {
  sealSpatialWorldPlan,
  SPATIAL_WORLD_PLAN_SCHEMA,
  worldFoundationInputHash,
} from "@basalt/world-planning";
import { loadSemanticRegistry } from "./helpers/semantic-registry.js";
import { worldFixture } from "./helpers/world-fixture.js";

test("foundation, resolution, and realization are deterministic and keep the plan immutable", async () => {
  const module = await loadSemanticRegistry();
  const fixture = await worldFixture(module);
  const before = JSON.stringify(fixture.plan);
  const input = {
    semanticModule: module,
    catalogSnapshot: fixture.snapshot,
    catalogAssets: [fixture.asset],
    spatialPlan: fixture.plan,
  };
  const first = compileBasaltWorld(input);
  const second = compileBasaltWorld(input);
  assert.equal(first.worldBuildHash, second.worldBuildHash);
  assert.equal(first.status, "eligible");
  assert.equal(first.foundation.foundationInputHash, worldFoundationInputHash(fixture.plan));
  assert.equal(first.foundation.baseTerrainFields[0]?.samples.length, 9);
  assert.ok((first.foundation.routeConstructions[0]?.travelSegments.length ?? 0) > 1);
  const terrain = first.foundation.terrainFields[0]!;
  const baseTerrain = first.foundation.baseTerrainFields[0]!;
  const route = first.foundation.routeConstructions[0]!;
  assert.equal(route.baseTerrainFieldHash, first.foundation.baseTerrainFields[0]!.hash);
  assert.ok(terrain.routeConstructionHashes.includes(route.hash));
  assert.equal(route.treatmentKind, "follow_surface");
  for (const vertex of route.travelSegments.flatMap((segment) => segment.vertices))
    assert.ok(
      vertex.positionMeters.y -
        sampleTerrainFieldElevation(
          terrain,
          baseTerrain,
          first.foundation.routeConstructions,
          first.foundation.routeJunctions,
          vertex.positionMeters.x,
          vertex.positionMeters.z,
        ) >=
        0.08 - 1e-9,
    );
  for (const segment of route.travelSegments) {
    const [a, b, c, d] = segment.vertices.map((entry) => entry.positionMeters);
    for (const along of [0.25, 0.5, 0.75])
      for (const across of [0, 0.25, 0.5, 0.75, 1]) {
        const left = interpolate(a!, c!, along);
        const right = interpolate(b!, d!, along);
        const probe = interpolate(left, right, across);
        assert.ok(
          probe.y -
            sampleTerrainFieldElevation(
              terrain,
              baseTerrain,
              first.foundation.routeConstructions,
              first.foundation.routeJunctions,
              probe.x,
              probe.z,
            ) >=
            0.08 - 1e-9,
          `route travel surface lacks its constructed terrain reveal at ${JSON.stringify(probe)}`,
        );
      }
  }
  assert.equal(first.instances.length, 1);
  assert.equal(first.instances[0]?.entryHandle, "tree_whole_ground");
  assert.equal(JSON.stringify(fixture.plan), before);
});

function interpolate(
  left: { readonly x: number; readonly y: number; readonly z: number },
  right: { readonly x: number; readonly y: number; readonly z: number },
  amount: number,
) {
  return {
    x: left.x + (right.x - left.x) * amount,
    y: left.y + (right.y - left.y) * amount,
    z: left.z + (right.z - left.z) * amount,
  };
}

test("scatter and cluster rotate candidates independently while preserving bounds and replay", async () => {
  const module = await loadSemanticRegistry();
  const fixture = await worldFixture(module);
  const { kind: _kind, coordinateSystem: _coordinates, planHash: _hash, ...body } = fixture.plan;
  for (const placement of [
    { kind: "cluster" as const, center: { u: 10, v: 11 }, radiusMeters: 6 },
    {
      kind: "surface_scatter" as const,
      boundary: [
        { u: 4, v: 5 },
        { u: 16, v: 5 },
        { u: 16, v: 17 },
        { u: 4, v: 17 },
      ],
    },
  ]) {
    const spatialPlan = sealSpatialWorldPlan({
      ...body,
      realizationIntents: [
        {
          ...placement,
          intentId: "PlantGroup",
          requirementId: fixture.requirement.requirementId,
          priority: 10,
          regionId: "MainRegion",
          surfaceId: "GroundSurface",
          minimumCount: 6,
          targetCount: 6,
          minimumSeparationMeters: 0.1,
        },
      ],
    });
    const input = {
      semanticModule: module,
      catalogSnapshot: fixture.snapshot,
      catalogAssets: [fixture.asset],
      spatialPlan,
    };
    const world = compileBasaltWorld(input);
    assert.equal(world.status, "eligible", world.diagnostics.join("; "));
    assert.equal(world.instances.length, 6);
    assert.equal(
      new Set(world.instances.map((item) => JSON.stringify(item.transformMeters.rotation))).size,
      6,
    );
    assert.equal(compileBasaltWorld(input).worldBuildHash, world.worldBuildHash);
    for (const instance of world.instances) {
      const { x, z } = instance.transformMeters.position;
      if (placement.kind === "cluster") assert.ok(Math.hypot(x - 10, z - 11) <= 6);
      else assert.ok(x >= 4 && x <= 16 && z >= 5 && z <= 17);
      assert.ok(instance.boundsMeters.min.x >= 0 && instance.boundsMeters.max.x <= 20);
      assert.ok(instance.boundsMeters.min.z >= 0 && instance.boundsMeters.max.z <= 20);
    }
  }
});

test("ground population keeps full footprints outside route clearance and reports blocked grids", async () => {
  const module = await loadSemanticRegistry();
  const fixture = await worldFixture(module);
  const { kind: _kind, coordinateSystem: _coordinates, planHash: _hash, ...body } = fixture.plan;
  const common = {
    intentId: "PathsidePlants",
    requirementId: fixture.requirement.requirementId,
    priority: 10,
    regionId: "MainRegion",
    surfaceId: "GroundSurface",
  };
  const compile = (spatialPlan: typeof fixture.plan) =>
    compileBasaltWorld({
      semanticModule: module,
      catalogSnapshot: fixture.snapshot,
      catalogAssets: [fixture.asset],
      spatialPlan,
    });
  const planted = compile(
    sealSpatialWorldPlan({
      ...body,
      realizationIntents: [
        {
          ...common,
          kind: "cluster",
          center: { u: 10, v: 4 },
          radiusMeters: 3,
          minimumCount: 6,
          targetCount: 6,
          minimumSeparationMeters: 0.1,
        },
      ],
    }),
  );
  assert.equal(planted.status, "eligible", planted.diagnostics.join("; "));
  assert.equal(planted.instances.length, 6);
  for (const instance of planted.instances) assert.ok(instance.boundsMeters.min.z >= 2.5);
  const blocked = compile(
    sealSpatialWorldPlan({
      ...body,
      realizationIntents: [
        {
          ...common,
          kind: "surface_grid",
          origin: { u: 10, v: 2.8 },
          columns: 1,
          rows: 1,
          spacingUMeters: 1,
          spacingVMeters: 1,
        },
      ],
    }),
  );
  assert.equal(blocked.status, "incomplete");
  assert.equal(blocked.instances.length, 0);
  assert.ok(
    blocked.micro.diagnostics.some((entry) => entry.includes("1 route clearance conflicts")),
  );
});

test("ground placement aligns measured bottoms for sources whose pivots lie above or below the mesh", async () => {
  const module = await loadSemanticRegistry();
  for (const verticalOffset of [-1.75, 3.25]) {
    const fixture = await worldFixture(module, verticalOffset);
    const world = compileBasaltWorld({
      semanticModule: module,
      catalogSnapshot: fixture.snapshot,
      catalogAssets: [fixture.asset],
      spatialPlan: fixture.plan,
    });
    assert.equal(world.status, "eligible", world.diagnostics.join("; "));
    const instance = world.instances[0]!;
    const ground = sampleTerrainFieldElevation(
      world.foundation.terrainFields[0]!,
      world.foundation.baseTerrainFields[0]!,
      world.foundation.routeConstructions,
      world.foundation.routeJunctions,
      instance.transformMeters.position.x,
      instance.transformMeters.position.z,
    );
    assert.ok(Math.abs(instance.boundsMeters.min.y - ground) < 1e-9);
    assert.ok(Math.abs(instance.boundsMeters.max.y - ground - 2) < 1e-9);
    assert.ok(Math.abs(instance.transformMeters.position.y - ground + verticalOffset) < 1e-9);
  }
});

test("compilation task identity names inputs while result hashes include outcomes", () => {
  const input = {
    subjectId: "MainRegion",
    scope: "region" as const,
    stage: "micro" as const,
    dependencyTaskIds: [],
    inputHashes: [contentHash("task-input")],
    policyHash: contentHash("task-policy"),
    resourceUse: { wallMilliseconds: 0, decisions: 0, backtracks: 0 },
  };
  const first = sealCompilationTaskResult({
    ...input,
    outputHashes: [contentHash("first-output")],
    status: "eligible",
    diagnostics: [],
  });
  const second = sealCompilationTaskResult({
    ...input,
    outputHashes: [],
    status: "incomplete",
    diagnostics: ["No solver result"],
  });
  assert.equal(first.taskId, second.taskId);
  assert.notEqual(first.taskHash, second.taskHash);
});

test("invalid spatial references are rejected instead of coerced", async () => {
  const module = await loadSemanticRegistry();
  const fixture = await worldFixture(module);
  assert.throws(
    () =>
      SPATIAL_WORLD_PLAN_SCHEMA.parse({
        ...fixture.plan,
        routes: [{ ...fixture.plan.routes[0]!, surfaceId: "MissingSurface" }],
      }),
    /unknown surface|hash mismatch/iu,
  );
});

test("semantic hypotheses cannot enter a sealed spatial plan", async () => {
  const module = await loadSemanticRegistry();
  const fixture = await worldFixture(module);
  const {
    kind: _kind,
    coordinateSystem: _coordinateSystem,
    planHash: _planHash,
    ...input
  } = fixture.plan;
  const hypothesis = sealSemanticAssertionBundle({
    authority: "hypothesis",
    hypothesisSourceHash: contentHash("world-plan-hypothesis"),
    assertions: [],
    abstentions: ["Awaiting admission"],
  });
  assert.throws(
    () =>
      sealSpatialWorldPlan({
        ...input,
        admittedAssertions: [hypothesis] as never,
      }),
    /invalid input|authority/iu,
  );
});

test("a planned relation bundle must exist and bind an exact subject relation", async () => {
  const module = await loadSemanticRegistry();
  const fixture = await worldFixture(module);
  assert.throws(
    () =>
      SPATIAL_WORLD_PLAN_SCHEMA.parse({
        ...fixture.plan,
        semanticEntities: fixture.plan.semanticEntities.map((entity, index) =>
          index === 0 ? { ...entity, relationAssertionBundleHash: "f".repeat(64) } : entity,
        ),
      }),
    /lacks its relation assertions|hash mismatch/iu,
  );
});

test("changing one region invalidates only that region task and world ancestors", async () => {
  const module = await loadSemanticRegistry();
  const fixture = await worldFixture(module);
  const regionConcept = module.concepts.find((entry) => entry.conceptId === "bsc_000316")!;
  const secondAssertions = sealSemanticAssertionBundle({
    authority: "admitted",
    assertions: [
      {
        assertionKind: "denotation",
        subject: { kind: "planned_entity", id: "RegionEntityB" },
        concept: {
          conceptId: regionConcept.conceptId,
          commitmentHash: regionConcept.commitmentHash,
        },
        evidence: {
          level: "declared",
          evidenceHashes: [contentHash("RegionEntityB:declared")],
        },
      },
    ],
  });
  assert.equal(secondAssertions.authority, "admitted");
  const {
    kind: _kind,
    coordinateSystem: _coordinateSystem,
    planHash: _planHash,
    ...base
  } = fixture.plan;
  const secondRegion = {
    regionId: "SecondaryRegion",
    semanticEntityId: "RegionEntityB",
    volume: {
      kind: "box" as const,
      bounds: { min: { x: 0, y: -2, z: 10 }, max: { x: 10, y: 12, z: 20 } },
    },
    refinementPriority: 0,
  };
  const firstPlan = sealSpatialWorldPlan({
    ...base,
    semanticEntities: [
      ...base.semanticEntities,
      {
        entityId: "RegionEntityB",
        upperSort: "space",
        semanticDependencyClosureHash: base.semanticEntities.find(
          (entry) => entry.entityId === "RegionEntity",
        )!.semanticDependencyClosureHash,
        admittedAssertionBundleHash: secondAssertions.hash,
      },
    ],
    admittedAssertions: [...base.admittedAssertions, secondAssertions],
    regions: [...base.regions, secondRegion],
  });
  const compile = (spatialPlan: typeof firstPlan) =>
    compileBasaltWorld({
      semanticModule: module,
      catalogSnapshot: fixture.snapshot,
      catalogAssets: [fixture.asset],
      spatialPlan,
    });
  const first = compile(firstPlan);
  const changedPlan = sealSpatialWorldPlan({
    ...base,
    semanticEntities: firstPlan.semanticEntities,
    admittedAssertions: firstPlan.admittedAssertions,
    regions: firstPlan.regions.map((region) =>
      region.regionId === "MainRegion" ? { ...region, refinementPriority: 1 } : region,
    ),
  });
  const changed = compile(changedPlan);
  const taskFor = (build: typeof first, region: (typeof firstPlan.regions)[number]) =>
    build.tasks.find(
      (task) =>
        task.scope === "region" &&
        task.stage === "foundation" &&
        task.inputHashes.includes(contentHash(stableJson(region))),
    )!;
  assert.equal(
    taskFor(first, secondRegion).taskHash,
    taskFor(changed, secondRegion).taskHash,
    "unrelated region task must remain byte-identical",
  );
  assert.notEqual(
    taskFor(
      first,
      firstPlan.regions.find((region) => region.regionId === "MainRegion")!,
    ).taskHash,
    taskFor(
      changed,
      changedPlan.regions.find((region) => region.regionId === "MainRegion")!,
    ).taskHash,
  );
  assert.notEqual(first.worldBuildHash, changed.worldBuildHash);
});

test("lake and road plans preserve space, substance, and boundary decomposition", async () => {
  const module = await loadSemanticRegistry();
  const fixture = await worldFixture(module);
  const concept = (conceptId: string) =>
    module.concepts.find((entry) => entry.conceptId === conceptId)!;
  const lake = concept("bsc_000311");
  const water = concept("bsc_000202");
  const waterSurface = concept("bsc_000411");
  const roadCorridor = concept("bsc_000306");
  const assertions = sealSemanticAssertionBundle({
    authority: "admitted",
    assertions: [
      ...[
        { entityId: "LakeSpace", commitment: lake },
        { entityId: "LakeWater", commitment: water },
        { entityId: "LakeBoundary", commitment: waterSurface },
        { entityId: "RoadSpace", commitment: roadCorridor },
      ].map(({ entityId, commitment }) => ({
        assertionKind: "denotation" as const,
        subject: { kind: "planned_entity" as const, id: entityId },
        concept: {
          conceptId: commitment.conceptId,
          commitmentHash: commitment.commitmentHash,
        },
        evidence: {
          level: "declared" as const,
          evidenceHashes: [contentHash(`${entityId}:declared`)],
        },
      })),
      {
        assertionKind: "relation" as const,
        subject: { kind: "planned_entity" as const, id: "LakeWater" },
        relationId: "bre_000004",
        object: { kind: "planned_entity" as const, id: "LakeSpace" },
        evidence: {
          level: "declared" as const,
          evidenceHashes: [contentHash("lake:contains-water")],
        },
      },
      {
        assertionKind: "relation" as const,
        subject: { kind: "planned_entity" as const, id: "LakeSpace" },
        relationId: "bre_000005",
        object: { kind: "planned_entity" as const, id: "LakeBoundary" },
        evidence: {
          level: "declared" as const,
          evidenceHashes: [contentHash("lake:bounded-by-water-surface")],
        },
      },
      {
        assertionKind: "relation" as const,
        subject: { kind: "planned_entity" as const, id: "RoadSpace" },
        relationId: "bre_000003",
        object: { kind: "planned_entity" as const, id: "RegionEntity" },
        evidence: {
          level: "declared" as const,
          evidenceHashes: [contentHash("road:located-in-region")],
        },
      },
    ],
  });
  const closure = (commitment: typeof lake, relationIds: readonly string[]) =>
    createSemanticDependencyClosure({
      module,
      conceptIds: [commitment.conceptId],
      definitionIds: relationIds,
    });
  const {
    kind: _kind,
    coordinateSystem: _coordinateSystem,
    planHash: _planHash,
    ...base
  } = fixture.plan;
  const plan = sealSpatialWorldPlan({
    ...base,
    semanticEntities: [
      ...base.semanticEntities,
      {
        entityId: "LakeSpace",
        upperSort: "space",
        regionId: "MainRegion",
        semanticDependencyClosureHash: closure(lake, ["bre_000005"]).hash,
        admittedAssertionBundleHash: assertions.hash,
        relationAssertionBundleHash: assertions.hash,
      },
      {
        entityId: "LakeWater",
        upperSort: "substance",
        regionId: "MainRegion",
        semanticDependencyClosureHash: closure(water, ["bre_000004"]).hash,
        admittedAssertionBundleHash: assertions.hash,
        relationAssertionBundleHash: assertions.hash,
      },
      {
        entityId: "LakeBoundary",
        upperSort: "boundary",
        regionId: "MainRegion",
        semanticDependencyClosureHash: closure(waterSurface, []).hash,
        admittedAssertionBundleHash: assertions.hash,
      },
      {
        entityId: "RoadSpace",
        upperSort: "space",
        regionId: "MainRegion",
        semanticDependencyClosureHash: closure(roadCorridor, ["bre_000003"]).hash,
        admittedAssertionBundleHash: assertions.hash,
        relationAssertionBundleHash: assertions.hash,
      },
    ],
    admittedAssertions: [...base.admittedAssertions, assertions],
    placementSurfaces: [
      ...base.placementSurfaces,
      {
        surfaceId: "LakeSurface",
        regionId: "MainRegion",
        kind: "water",
        bounds: { min: { x: 6, y: 0.5, z: 6 }, max: { x: 14, y: 0.5, z: 14 } },
        normal: { x: 0, y: 1, z: 0 },
        sourceHash: contentHash("lake-water-boundary"),
      },
    ],
    routes: base.routes.map((route) => ({ ...route, semanticEntityId: "RoadSpace" })),
  });
  const build = compileBasaltWorld({
    semanticModule: module,
    catalogSnapshot: fixture.snapshot,
    catalogAssets: [fixture.asset],
    spatialPlan: plan,
  });
  assert.equal(build.foundation.foundationInputHash, worldFoundationInputHash(plan));
  assert.equal(build.foundation.placementSurfaces.at(-1)?.kind, "water");
  assert.equal(build.foundation.routeConstructions[0]?.routeId, "MainRoute");
  assert.ok(build.semanticClosureHashes.includes(closure(lake, ["bre_000005"]).hash));
});
