import assert from "node:assert/strict";
import test from "node:test";
import { sealSpatialWorldPlan } from "@basalt/world-planning";
import {
  createLocalRefinementCompiler,
  createRouteAlternativeProvider,
  observeWorldBuild,
  runBoundedRefinement,
  sealRefinementObservationExecution,
  sealRefinementPolicy,
  sealWorldObservationReport,
  verifyWorldBuild,
} from "@basalt/world-refinement";
import { loadSemanticRegistry } from "./helpers/semantic-registry.js";
import { worldFixture } from "./helpers/world-fixture.js";

test("bounded route alternatives repair an overlap while preserving tolerances and unrelated inputs", async () => {
  const semanticModule = await loadSemanticRegistry(),
    fixture = await worldFixture(semanticModule);
  const { kind: _kind, coordinateSystem: _coordinates, planHash: _hash, ...body } = fixture.plan;
  const lower = fixture.plan.routes[0]!;
  const upper = {
    ...lower,
    routeId: "UpperRoute",
    terrainPriority: 1,
    elevationControls: lower.elevationControls.map((c) => ({
      ...c,
      controlId: `Upper${c.controlId}`,
      surfaceElevation: { kind: "terrain_clearance" as const, clearanceMeters: 1.08 },
    })),
  };
  const plan = sealSpatialWorldPlan({ ...body, routes: [lower, upper] });
  const compiler = createLocalRefinementCompiler({
    semanticModule,
    catalogSnapshot: fixture.snapshot,
    catalogAssets: [fixture.asset],
  });
  const initial = await compiler.compile({ plan, requestedTaskIds: [] });
  assert.equal(initial.worldBuild.status, "incomplete");
  assert.ok(
    initial.worldBuild.foundation.diagnostics.some((d) =>
      d.startsWith("route:UpperRoute:terrain_contact"),
    ),
  );
  const expectations = {
    dimensions: [],
    access: [],
    viewCorridors: [],
    styles: [],
    minimumNeighborClearanceMeters: 0,
  };
  for (const alternatives of [
    [],
    [
      {
        alternativeId: "Separate",
        alignmentMeters: upper.alignmentMeters.map((p) => ({ ...p, z: p.z + 6 })),
      },
    ],
  ]) {
    const policy = sealRefinementPolicy({
      maximumIterations: 2,
      constructionParameters: [],
      routeAlternatives: alternatives.length ? [{ routeId: upper.routeId, alternatives }] : [],
      vegetation: [],
      terrainPaint: [],
      protectedIntentIds: [],
      protectedTaskHashes: [],
      requiredCheckKinds: ["terrain_contact"],
    });
    let currentPlan = plan;
    const result = await runBoundedRefinement({
      initialPlan: plan,
      policy,
      provider: createRouteAlternativeProvider(),
      compiler: {
        compile(input) {
          currentPlan = input.plan;
          return compiler.compile(input);
        },
      },
      observe: (input) =>
        observeWorldBuild({
          ...input,
          plan: currentPlan,
          policy,
          expectations,
          cameras: [
            {
              cameraId: "Overview",
              purpose: "overview",
              positionMeters: { x: 25, y: 20, z: -5 },
              lookAtMeters: { x: 10, y: 0, z: 10 },
              up: { x: 0, y: 1, z: 0 },
              verticalFieldOfViewDegrees: 60,
              widthPixels: 32,
              heightPixels: 32,
            },
          ],
        }),
    });
    if (alternatives.length) {
      assert.equal(result.run.status, "eligible", result.observation.diagnostics.join("; "));
      assert.equal(result.run.iterations.length, 1);
      assert.deepEqual(
        result.plan.routes.find((r) => r.routeId === lower.routeId),
        lower,
      );
      assert.deepEqual(
        result.plan.routes.find((r) => r.routeId === upper.routeId)!.construction,
        upper.construction,
      );
      assert.deepEqual(
        result.worldBuild.foundation.baseTerrainFields,
        initial.worldBuild.foundation.baseTerrainFields,
      );
    } else {
      assert.equal(result.run.status, "incomplete");
      assert.equal(result.run.iterations.length, 0);
      assert.ok(result.run.diagnostics.includes("No admissible refinement proposal remains"));
    }
  }
});

test("refinement retains compiler incompleteness and stops on an observation rejection", async () => {
  const semanticModule = await loadSemanticRegistry();
  const fixture = await worldFixture(semanticModule);
  const { kind: _kind, coordinateSystem: _coordinates, planHash: _hash, ...body } = fixture.plan;
  const plan = sealSpatialWorldPlan({
    ...body,
    realizationIntents: [
      {
        kind: "single",
        intentId: "Outside",
        requirementId: fixture.requirement.requirementId,
        priority: 10,
        regionId: "MainRegion",
        surfaceId: "GroundSurface",
        at: { u: 100, v: 100 },
      },
    ],
  });
  const policy = sealRefinementPolicy({
    maximumIterations: 1,
    constructionParameters: [],
    routeAlternatives: [],
    vegetation: [],
    terrainPaint: [],
    protectedIntentIds: [],
    protectedTaskHashes: [],
    requiredCheckKinds: ["terrain_contact"],
  });
  for (const status of ["eligible", "rejected"] as const) {
    let proposals = 0;
    const result = await runBoundedRefinement({
      initialPlan: plan,
      policy,
      compiler: createLocalRefinementCompiler({
        semanticModule,
        catalogSnapshot: fixture.snapshot,
        catalogAssets: [fixture.asset],
      }),
      provider: {
        async propose() {
          proposals += 1;
          return undefined;
        },
      },
      observe: ({ worldBuild, affectedTaskIds }) => {
        // A deliberately narrow observer cannot override an unrelated compiler failure.
        const report = sealWorldObservationReport({
          worldBuildHash: worldBuild.worldBuildHash,
          checks: [
            {
              checkId: "ObservedRoute",
              kind: "terrain_contact",
              subjectId: plan.routes[0]!.routeId,
              status,
              evidenceHash: worldBuild.foundation.foundationHash,
            },
          ],
          diagnosticRenders: [],
          visualAssessment: {
            status: "unassessed",
            assessor: "none",
            evidenceHashes: [],
            diagnostics: [],
          },
          diagnostics: [],
        });
        return {
          report,
          execution: sealRefinementObservationExecution({
            worldBuildHash: worldBuild.worldBuildHash,
            affectedTaskIds: [...affectedTaskIds],
            executedCheckIds: report.checks.map((c) => c.checkId),
            executedCameraIds: [],
            reportHash: report.hash,
          }),
        };
      },
    });
    assert.equal(result.worldBuild.status, "incomplete");
    assert.equal(result.run.status, status === "rejected" ? "rejected" : "incomplete");
    assert.equal(result.run.iterations.length, 0);
    assert.equal(proposals, status === "rejected" ? 0 : 1);
  }
});

test("refinement measures the exposed route body gap consistently with the compiler", async () => {
  const semanticModule = await loadSemanticRegistry(),
    fixture = await worldFixture(semanticModule);
  const { kind: _kind, coordinateSystem: _coordinates, planHash: _hash, ...body } = fixture.plan;
  const route = fixture.plan.routes[0]!;
  const plan = sealSpatialWorldPlan({
    ...body,
    routes: [
      route,
      {
        ...route,
        routeId: "UpperRoute",
        terrainPriority: 1,
        elevationControls: route.elevationControls.map((c) => ({
          ...c,
          controlId: `Upper${c.controlId}`,
          surfaceElevation: { kind: "terrain_clearance" as const, clearanceMeters: 0.18 },
        })),
      },
    ],
  });
  const compiler = createLocalRefinementCompiler({
    semanticModule,
    catalogSnapshot: fixture.snapshot,
    catalogAssets: [fixture.asset],
  });
  const { worldBuild } = await compiler.compile({ plan, requestedTaskIds: [] });
  assert.equal(worldBuild.status, "eligible");
  const policy = sealRefinementPolicy({
    maximumIterations: 1,
    constructionParameters: [],
    routeAlternatives: [],
    vegetation: [],
    terrainPaint: [],
    protectedIntentIds: [],
    protectedTaskHashes: [],
    requiredCheckKinds: ["terrain_contact"],
  });
  const observation = verifyWorldBuild({
    plan,
    worldBuild,
    policy,
    expectations: {
      dimensions: [],
      access: [],
      viewCorridors: [],
      styles: [],
      minimumNeighborClearanceMeters: 0,
    },
  });
  assert.equal(observation.geometricStatus, "eligible", observation.diagnostics.join("; "));
});
