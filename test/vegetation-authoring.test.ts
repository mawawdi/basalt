import assert from "node:assert/strict";
import test from "node:test";
import { createVegetationIntents, type VegetationArea } from "@basalt/world-planning";

test("community authoring wires canopy lineage without supplying placements or coupling to a catalog", () => {
  const area: VegetationArea = {
    areaId: "Slope",
    habitatFieldId: "SharedSlopeHabitat",
    regionId: "Region",
    surfaceId: "Surface",
    boundary: [
      { u: 0, v: 0 },
      { u: 20, v: 0 },
      { u: 20, v: 20 },
      { u: 0, v: 20 },
    ],
    densityField: {
      fieldId: "SharedSlopeHabitat",
      seed: 42,
      edgeFadeMeters: 3,
      wavelengthMeters: 12,
      minimumDensity: 0.1,
      patchContrast: 2,
    },
    canopyIntentIds: ["AuthoredTree"],
    clearings: [],
    maximumSlopeDegrees: 25,
    maximumSupportReliefMeters: 0.3,
    groundEmbedMeters: 0.02,
    routeClearanceHeightMeters: 3,
    minimumSeparationMeters: 0.02,
    palette: [
      {
        plantId: "Tree",
        requirementId: "UnresolvedTree",
        layer: "canopy",
        priority: 200,
        maximumCount: 12,
        minimumCount: 0,
        candidateDensityPerSquareMeter: 0.05,
        spacingMeters: { minimum: 2, maximum: 5 },
        canopyResponse: { open: 1, covered: 1 },
      },
      {
        plantId: "Fern",
        requirementId: "UnresolvedFern",
        layer: "understory",
        priority: 100,
        maximumCount: 60,
        minimumCount: 2,
        candidateDensityPerSquareMeter: 0.3,
        spacingMeters: { minimum: 0.5, maximum: 1.5 },
        canopyResponse: { open: 0.02, covered: 1 },
      },
    ],
  };
  const intents = createVegetationIntents(area);
  assert.deepEqual(intents[0]!.vegetation!.canopyIntentIds, []);
  assert.deepEqual(intents[1]!.vegetation!.canopyIntentIds, ["AuthoredTree", "Slope_Tree"]);
  assert.equal(intents[1]!.minimumCount, 2);
  assert.ok(Object.isFrozen(intents[0]!.vegetation));
  area.boundary[0]!.u = 5;
  assert.equal(
    intents[0]!.boundary[0]!.u,
    0,
    "Expansion must not retain mutable source references",
  );
  assert.throws(
    () => createVegetationIntents({ ...area, palette: [area.palette[0]!, area.palette[0]!] }),
    /unique/u,
  );
  assert.throws(() => createVegetationIntents({ ...area, palette: [] }), /palette/u);
  assert.throws(() => createVegetationIntents({ ...area, areaId: "invalid space" }));
  assert.doesNotThrow(() => createVegetationIntents({ ...area, maximumSupportReliefMeters: 2 }));
});
