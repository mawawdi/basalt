import test from "node:test";
import assert from "node:assert/strict";
import { contentHash } from "../packages/contracts/src/index.js";
import { createMurmurHash3Random } from "../packages/spatial-core/src/index.js";
import { quantizeQ32_32 } from "../packages/basalt-types/src/index.js";
import {
  ASSEMBLY_RECIPE_ABI,
  assertAssemblyRecipeIdentity,
  isNeuralAssetEligibleForBounds,
  sealAssemblyRecipe,
} from "../packages/asset-factory/src/index.js";
import {
  compileBasaltWorldFoundation,
  solveWorldRelations,
} from "../packages/world-compiler/src/index.js";
import {
  bindTerrainStyleOverlay,
  compileWorldPlan,
  WORLD_STYLE_OVERLAY_SCHEMA,
} from "../packages/world-planning/src/index.js";
import { productionWorldPlanFixture } from "./helpers/production-world-fixtures.js";

test("neural geometry is reserved for sub-8-stud focal inserts", () => {
  assert.equal(
    isNeuralAssetEligibleForBounds({
      acquisitionContext: "micro_scatter",
      boundsSize: { x: 1, y: 1, z: 1 },
    }),
    false,
  );
  assert.equal(
    isNeuralAssetEligibleForBounds({
      acquisitionContext: "focal_insert",
      boundsSize: { x: 8.01, y: 1, z: 1 },
    }),
    false,
  );
  assert.equal(
    isNeuralAssetEligibleForBounds({
      acquisitionContext: "focal_insert",
      boundsSize: { x: 8, y: 7.5, z: 2 },
    }),
    true,
  );
});

test("spatial keys and seeded populations use stable fixed-point primitives", () => {
  assert.equal(quantizeQ32_32(1.25), "5368709120");
  const first = createMurmurHash3Random(42);
  const second = createMurmurHash3Random(42);
  assert.deepEqual([first(), first(), first()], [second(), second(), second()]);
  assert.throws(() => quantizeQ32_32(Number.POSITIVE_INFINITY));
});

test("seasonal style overlays preserve the compiled terrain field hash", () => {
  const plan = productionWorldPlanFixture({
    sceneId: "seasonalScene",
    regionId: "seasonalRegion",
    surfaceId: "seasonalSurface",
    routeId: "seasonalRoute",
    anchorId: "seasonalAnchor",
    cameraId: "seasonalCamera",
    materialId: "seasonalMaterial",
    name: "Seasonal overlay fixture",
  });
  const compiled = compileWorldPlan(plan);
  const terrainField = compiled.terrainFields[0]!;
  const overlay = WORLD_STYLE_OVERLAY_SCHEMA.parse({
    kind: "WorldStyleOverlay",
    id: "autumnOverlay",
    terrainFieldHash: terrainField.hash,
    season: "Autumn",
    materialPalette: [
      { materialId: "seasonalMaterial", paletteEntryId: "autumnPalette", weight: 1 },
    ],
    foliageFamilyIds: ["autumnFoliage"],
    atmosphericLighting: {
      lightingIntent: "low warm sun",
      atmosphereIntent: "clear amber air",
      exposure: 0,
    },
  });
  const binding = bindTerrainStyleOverlay({ terrainField, overlay });
  assert.equal(binding.terrainField.hash, terrainField.hash);
  assert.equal(binding.terrainField.planHash, terrainField.planHash);
  const winter = WORLD_STYLE_OVERLAY_SCHEMA.parse({
    ...overlay,
    id: "winterOverlay",
    season: "Winter",
    materialPalette: [
      { materialId: "seasonalMaterial", paletteEntryId: "winterPalette", weight: 1 },
    ],
    foliageFamilyIds: ["winterFoliage"],
    atmosphericLighting: {
      lightingIntent: "cool overcast",
      atmosphereIntent: "crisp snow air",
      exposure: -0.25,
    },
  });
  const winterBinding = bindTerrainStyleOverlay({ terrainField, overlay: winter });
  assert.equal(winterBinding.terrainField.hash, terrainField.hash);
  assert.equal(winterBinding.terrainField.planHash, terrainField.planHash);
  assert.notEqual(binding.hash, winterBinding.hash);
});

test("macro landmarks use a typed shell and socketed focal components", () => {
  const recipe = sealAssemblyRecipe({
    kind: "AssemblyRecipe",
    abi: ASSEMBLY_RECIPE_ABI,
    id: "landmarkAssembly",
    styleContractHash: contentHash("style"),
    kitId: "landmarkKit",
    lotId: "lot_district_p_0_0_1_00",
    shell: { archetypeId: "shellModule", repetition: 12, trimSheetRequired: true },
    socketedComponents: [
      {
        componentId: "crestInsert",
        archetypeId: "crestArchetype",
        socketId: "crestSocket",
        semanticRole: "focal ornament",
        position: { x: 0, y: 12, z: 0 },
        rotationStepsY90: 0,
      },
    ],
  });
  assertAssemblyRecipeIdentity(recipe);
  assert.equal(recipe.shell?.trimSheetRequired, true);
  assert.equal(recipe.socketedComponents[0]!.socketId, "crestSocket");
});

test("family distributions resolve through the shared surface relation solver", () => {
  const plan = productionWorldPlanFixture({
    sceneId: "relationScene",
    regionId: "relationRegion",
    surfaceId: "relationSurface",
    routeId: "relationRoute",
    anchorId: "relationAnchor",
    cameraId: "relationCamera",
    materialId: "relationMaterial",
    name: "Relation fixture",
  });
  const foundation = compileBasaltWorldFoundation(plan);
  const solved = solveWorldRelations({
    surfaces: foundation.worldPlan.surfaces,
    regions: foundation.worldPlan.plan.regions,
    distributions: [
      {
        kind: "single",
        id: "relationPlacement",
        surfaceId: "relationSurface",
        at: { u: 0, v: 12 },
      },
    ],
    relations: [
      {
        kind: "on_surface",
        proposalIds: ["relationPlacement"],
        surfaceId: "relationSurface",
        offset: 0,
      },
      { kind: "align_to_normal", proposalIds: ["relationPlacement"], maximumTiltDegrees: 30 },
      {
        kind: "inside_region",
        proposalIds: ["relationPlacement"],
        regionId: "relationRegion",
        clearance: 0,
      },
      {
        kind: "support",
        proposalIds: ["relationPlacement"],
        surfaceId: "relationSurface",
        tolerance: 0.05,
      },
    ],
  });
  assert.equal(solved.length, 1);
  assert.equal(solved[0]!.surfaceId, "relationSurface");
  assert.equal(solved[0]!.position.y, 0);
});

test("route clearance uses the shared segment corridor, not sparse points", () => {
  const plan = productionWorldPlanFixture({
    sceneId: "clearanceScene",
    regionId: "clearanceRegion",
    surfaceId: "clearanceSurface",
    routeId: "clearanceRoute",
    anchorId: "clearanceAnchor",
    cameraId: "clearanceCamera",
    materialId: "clearanceMaterial",
    name: "Clearance fixture",
  });
  const foundation = compileBasaltWorldFoundation(plan);
  const routes = foundation.worldPlan.plan.routes.map((route) => ({
    id: route.id,
    points: route.points,
    width: route.width,
  }));
  const relations = [
    {
      kind: "maintain_clearance" as const,
      proposalIds: ["clearancePlacement"],
      routeId: "clearanceRoute",
      clearance: 0,
    },
  ];
  assert.throws(
    () =>
      solveWorldRelations({
        surfaces: foundation.worldPlan.surfaces,
        regions: foundation.worldPlan.plan.regions,
        routes,
        distributions: [
          {
            kind: "single" as const,
            id: "clearancePlacement",
            surfaceId: "clearanceSurface",
            at: { u: 0, v: 0 },
          },
        ],
        relations,
      }),
    /route clearance/,
  );
  const solved = solveWorldRelations({
    surfaces: foundation.worldPlan.surfaces,
    regions: foundation.worldPlan.plan.regions,
    routes,
    distributions: [
      {
        kind: "single" as const,
        id: "clearancePlacement",
        surfaceId: "clearanceSurface",
        at: { u: 0, v: 12 },
      },
    ],
    relations,
  });
  assert.equal(solved.length, 1);
});
