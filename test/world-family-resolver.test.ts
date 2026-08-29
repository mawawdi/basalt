import assert from "node:assert/strict";
import test from "node:test";
import {
  compileResolvedFamilyPopulationPlans,
  resolveWorldAssetFamilies,
  sealWorldAssetFamilyRegistry,
} from "../packages/world-compiler/src/index.js";

test("family resolver builds one inverted index and returns a bounded deterministic set", () => {
  const registry = sealWorldAssetFamilyRegistry([
    {
      familyId: "FamilyStone",
      semanticTags: ["masonry"],
      styleTags: ["weathered"],
      roleTags: ["wall"],
      variantCount: 4,
    },
    {
      familyId: "FamilyWood",
      semanticTags: ["timber"],
      styleTags: ["weathered"],
      roleTags: ["wall"],
      variantCount: 8,
    },
    {
      familyId: "FamilyMetal",
      semanticTags: ["metal"],
      styleTags: ["clean"],
      roleTags: ["wall"],
      variantCount: 12,
    },
    {
      familyId: "FamilyDistant",
      semanticTags: ["masonry"],
      styleTags: ["weathered"],
      roleTags: ["ornament"],
      variantCount: 1,
    },
  ]);
  const request = {
    biomeId: "RegionA",
    semanticTags: ["masonry"],
    styleTags: ["weathered"],
    roleTags: ["wall"],
    minimumFamilies: 3,
    maximumFamilies: 3,
  };
  const first = resolveWorldAssetFamilies({ registry, requests: [request] });
  const second = resolveWorldAssetFamilies({
    registry,
    requests: [{ ...request, roleTags: [...request.roleTags] }],
  });
  assert.deepEqual(first, second);
  assert.equal(first.RegionA?.length, 3);
  assert.equal(first.RegionA?.[0], "FamilyStone");
});

test("family resolver fails closed when the registry cannot satisfy a coherent request", () => {
  const registry = sealWorldAssetFamilyRegistry([
    {
      familyId: "FamilyStone",
      semanticTags: ["masonry"],
      styleTags: ["weathered"],
      roleTags: ["wall"],
      variantCount: 4,
    },
  ]);
  assert.throws(
    () =>
      resolveWorldAssetFamilies({
        registry,
        requests: [
          {
            biomeId: "RegionA",
            semanticTags: ["masonry"],
            styleTags: ["weathered"],
            roleTags: ["wall"],
            minimumFamilies: 2,
            maximumFamilies: 3,
          },
        ],
      }),
    /refusing unrelated fallback families/,
  );
});

test("family population lowering merges repeated families before instance emission", () => {
  const registry = sealWorldAssetFamilyRegistry([
    {
      familyId: "FamilyStone",
      semanticTags: ["masonry"],
      styleTags: ["weathered"],
      roleTags: ["wall"],
      variantCount: 4,
    },
  ]);
  const plans = compileResolvedFamilyPopulationPlans({
    registry,
    requests: [
      {
        biomeId: "RegionA",
        regionIds: ["RegionA"],
        semanticTags: ["masonry"],
        styleTags: ["weathered"],
        roleTags: ["wall"],
        minimumFamilies: 1,
        maximumFamilies: 1,
        maximumCount: 10,
        density: { minimum: 0.1, target: 0.4, maximum: 0.8 },
        variationSeed: 10,
      },
      {
        biomeId: "RegionB",
        regionIds: ["RegionB"],
        semanticTags: ["masonry"],
        styleTags: ["weathered"],
        roleTags: ["wall"],
        minimumFamilies: 1,
        maximumFamilies: 1,
        maximumCount: 6,
        density: { minimum: 0.2, target: 0.5, maximum: 0.9 },
        variationSeed: 20,
      },
    ],
  });
  assert.equal(plans.length, 1);
  assert.deepEqual(plans[0]?.regionIds, ["RegionA", "RegionB"]);
  assert.equal(plans[0]?.maximumCount, 16);
  assert.equal(plans[0]?.density.target, 0.5);
});
