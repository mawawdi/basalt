import assert from "node:assert/strict";
import test from "node:test";
import {
  adaptSealedCatalogToRegistry,
  compileResolvedFamilyPopulationPlans,
  densityEnvelopeFromPerHectare,
  resolveCanonicalAssetFamilies,
  resolveWorldAssetFamilies,
  sealWorldAssetFamilyRegistry,
} from "../packages/world-compiler/src/index.js";
import { buildAuthoredAssetFamilyRevision } from "../packages/catalog-intelligence/src/family-revisions.js";
import { buildFamilyCard } from "../packages/catalog-intelligence/src/family-cards.js";
import {
  catalogAssetRecordSchema,
  type CatalogAssetRecord,
} from "../packages/basalt-types/src/index.js";
import type { CatalogAssetEnvelope } from "../packages/catalog-intelligence/src/contracts.js";

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
    minimumFamilies: 2,
    maximumFamilies: 2,
  };
  const first = resolveWorldAssetFamilies({ registry, requests: [request] });
  const second = resolveWorldAssetFamilies({
    registry,
    requests: [{ ...request, roleTags: [...request.roleTags] }],
  });
  assert.deepEqual(first, second);
  assert.deepEqual(first[0], ["FamilyStone", "FamilyDistant"]);
});

test("family resolver keeps same-biome requests independent", () => {
  const registry = sealWorldAssetFamilyRegistry([
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
  ]);
  const requests = [
    {
      biomeId: "bay",
      semanticTags: ["scrub"],
      styleTags: ["coherent"],
      roleTags: ["scatter"],
      minimumFamilies: 1,
      maximumFamilies: 1,
    },
    {
      biomeId: "bay",
      semanticTags: ["canopy"],
      styleTags: ["coherent"],
      roleTags: ["cluster"],
      minimumFamilies: 1,
      maximumFamilies: 1,
    },
  ];
  assert.deepEqual(resolveWorldAssetFamilies({ registry, requests }), [
    ["BayScrub"],
    ["BayCanopy"],
  ]);
  const plans = compileResolvedFamilyPopulationPlans({
    registry,
    requests: requests.map((request) => ({ ...request, regionIds: ["bay"] })),
  });
  assert.deepEqual(
    plans.map((plan) => plan.familyId),
    ["BayCanopy", "BayScrub"],
  );
});

test("family resolver fails closed when named semantic terms match nothing", () => {
  const registry = sealWorldAssetFamilyRegistry([
    {
      familyId: "FamilyStone",
      semanticTags: ["stone"],
      styleTags: ["rough"],
      roleTags: ["wall"],
      variantCount: 2,
    },
  ]);
  assert.throws(
    () =>
      resolveWorldAssetFamilies({
        registry,
        requests: [
          {
            biomeId: "RegionA",
            regionIds: ["RegionA"],
            semanticTags: ["glass"],
            styleTags: ["rough"],
            roleTags: ["wall"],
            minimumFamilies: 1,
            maximumFamilies: 1,
          },
        ],
      }),
    /refusing unrelated fallback/,
  );
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

const admissionHash = "c".repeat(64);

function admissionRecord(
  assetId: string,
  admissionStatus: CatalogAssetRecord["admissionStatus"],
): CatalogAssetRecord {
  return catalogAssetRecordSchema.parse({
    assetId,
    sourceFileHash: admissionHash,
    canonicalName: assetId,
    boundingBox: {
      min: { x: "0", y: "0", z: "0" },
      max: { x: "8589934592", y: "8589934592", z: "8589934592" },
    },
    pivotOffsetFromBottomCenter: { x: "0", y: "0", z: "0" },
    triangleCount: 12,
    vertexCount: 8,
    submeshCount: 1,
    materialSlotCount: 1,
    textures: [],
    collisionProxy: { type: "None" },
    topologicalGenus: 0,
    semanticTags: [],
    isManifold: true,
    admissionStatus,
    merkleLeafHash: admissionHash,
  });
}

function admissionEnvelope(record: CatalogAssetRecord): CatalogAssetEnvelope {
  return {
    kind: "CatalogAssetEnvelope",
    abi: "basalt-catalog-intelligence@2",
    record,
    source: {
      kind: "creator_owned",
      packageId: "test-pack",
      relativePath: `registry/${record.assetId}.glb`,
      contentHash: admissionHash,
      licenseId: "test-license",
      commercialUsePermitted: true,
      redistributionPermitted: true,
      attribution: "test",
    },
    measurement: {
      status: "measured",
      boundsStuds: [2, 2, 2],
      boundsMinimumQ32_32: { x: "0", y: "0", z: "0" },
      boundsMaximumQ32_32: { x: "8589934592", y: "8589934592", z: "8589934592" },
      pivotOffsetQ32_32: { x: "0", y: "0", z: "0" },
      triangleCount: 12,
      vertexCount: 8,
      submeshCount: 1,
      materialSlotCount: 1,
      texturePixelCount: 1024,
      supportedSurfaceKinds: ["terrain"],
      primaryContact: "bottom",
      bottomContactAreaStuds2: 4,
      supportPlaneFits: [],
      supportPlaneRefusal: "no_patches",
      jointPlaneFits: [],
      jointPlaneRefusal: null,
      surfaceAreaStuds2: 24,
      texelDensityPixelsPerStud: 8,
      topologicalGenus: 0,
      hasManifoldTopology: true,
      geometryEvidenceStatus: "validated",
      materialAppearanceHashes: [],
      pbrChannels: ["base_color"],
      renderable: true,
      collision: {
        status: "none",
        syntacticGate: false,
        volumetricGate: false,
        complexityGate: false,
        watertight: false,
        convex: false,
        convexComponentCount: 0,
      },
      normalizedPivot: "bottom_center_obb",
      textureEvidence: "embedded",
      textureFacts: [],
    },
  };
}

function admissionDeclaration(familyName: string, assetId: string) {
  return {
    familyName,
    handle: `props/clutter/stylized_low_poly/${familyName}`,
    displayName: familyName,
    semanticRole: "props",
    styleTokens: ["stylized"],
    sharedTrimSheetAssetId: "shared_trim_sheet_pending",
    members: [{ assetId, sourcePath: `registry/${assetId}.glb`, variantName: "only" }],
    status: "declared" as const,
  };
}

test("canonical resolution excludes families with unadmitted members", () => {
  const qualified = admissionRecord("asset_qualified", "locally_qualified");
  const incomplete = admissionRecord("asset_incomplete", "incomplete");
  const qualifiedRevision = buildAuthoredAssetFamilyRevision(
    admissionDeclaration("qualified_things", qualified.assetId),
    [qualified],
  );
  const incompleteRevision = buildAuthoredAssetFamilyRevision(
    admissionDeclaration("incomplete_things", incomplete.assetId),
    [incomplete],
  );
  const found = resolveCanonicalAssetFamilies({
    revisions: [qualifiedRevision, incompleteRevision],
    cards: [buildFamilyCard(qualifiedRevision), buildFamilyCard(incompleteRevision)],
    assets: [admissionEnvelope(qualified), admissionEnvelope(incomplete)],
    request: {},
  });
  assert.deepEqual(
    found.map((candidate) => candidate.revision.familyId),
    [qualifiedRevision.familyId],
  );
});

test("catalog adapter tags sealed families from handles and drops unadmitted ones", () => {
  const qualified = admissionRecord("asset_adapted", "locally_qualified");
  const incomplete = admissionRecord("asset_skipped", "incomplete");
  const qualifiedRevision = buildAuthoredAssetFamilyRevision(
    admissionDeclaration("adapted_things", qualified.assetId),
    [qualified],
  );
  const incompleteRevision = buildAuthoredAssetFamilyRevision(
    admissionDeclaration("skipped_things", incomplete.assetId),
    [incomplete],
  );
  const input = {
    revisions: [qualifiedRevision, incompleteRevision],
    cards: [buildFamilyCard(qualifiedRevision), buildFamilyCard(incompleteRevision)],
    assets: [admissionEnvelope(qualified), admissionEnvelope(incomplete)],
  };
  const first = adaptSealedCatalogToRegistry(input);
  const second = adaptSealedCatalogToRegistry(input);
  assert.equal(first.hash, second.hash);
  assert.equal(first.families.length, 1);
  assert.equal(first.families[0]?.familyId, qualifiedRevision.familyId);
  assert.deepEqual(first.families[0]?.semanticTags, ["adapted_things", "props"]);
  assert.deepEqual(first.families[0]?.styleTags, ["stylized_low_poly"]);
  assert.deepEqual(first.families[0]?.roleTags, ["clutter"]);
  assert.equal(first.families[0]?.variantCount, 1);
});

test("per-hectare conversion matches the population area normalization", () => {
  // 500/ha over a 3600-stud² pad: floor(3600/256 × 1.00352) = 14 instances.
  const envelope = densityEnvelopeFromPerHectare(500);
  assert.equal(envelope.minimum, 0);
  assert.equal(envelope.maximum, envelope.target);
  assert.ok(Math.abs(envelope.target - 1.00352) < 1e-9);
  const empty = densityEnvelopeFromPerHectare(0);
  assert.deepEqual(empty, { minimum: 0, target: 0, maximum: 0 });
  assert.throws(() => densityEnvelopeFromPerHectare(-1), /non-negative/);
  assert.throws(() => densityEnvelopeFromPerHectare(Number.NaN), /non-negative/);
});

test("population lowering divides role-total density across resolved families", () => {
  const registry = sealWorldAssetFamilyRegistry([
    {
      familyId: "FamilyStone",
      semanticTags: ["masonry"],
      styleTags: ["weathered"],
      roleTags: ["wall"],
      variantCount: 4,
    },
    {
      familyId: "FamilyBrick",
      semanticTags: ["masonry"],
      styleTags: ["weathered"],
      roleTags: ["wall"],
      variantCount: 2,
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
        minimumFamilies: 2,
        maximumFamilies: 2,
        maximumCount: 10,
        minimumCount: 2,
        density: { minimum: 0, target: 1.5, maximum: 1.5 },
      },
    ],
  });
  assert.equal(plans.length, 2);
  for (const plan of plans) {
    assert.equal(plan.density.target, 0.75);
    assert.equal(plan.density.maximum, 0.75);
    assert.equal(plan.minimumCount, 1);
  }
});
