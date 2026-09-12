import test from "node:test";
import assert from "node:assert/strict";
import {
  computeHotspotDistortionEnergy,
  selectHotspotTrimBand,
} from "../packages/asset-factory/src/index.js";
import { buildAuthoredAssetFamilyRevision } from "../packages/catalog-intelligence/src/family-revisions.js";
import { TRIM_BAND_SCHEMA, catalogAssetRecordSchema } from "../packages/basalt-types/src/index.js";
import { contentHash } from "../packages/contracts/src/index.js";

test("Hotspot mapping uses canonical energy and rejects high distortion", () => {
  const band = {
    bandId: "stone_band",
    semanticRoles: ["stone"],
    uMin: 0,
    vMin: 0,
    uMax: 1,
    vMax: 1,
    tilingAxis: "v" as const,
    metricWidth: 2,
    metricHeight: 2,
  };
  assert.equal(
    computeHotspotDistortionEnergy(
      { assetId: "testAsset", aspectRatio: 1, surfaceArea: 4 },
      band,
      0,
    ),
    0,
  );
  const mapping = selectHotspotTrimBand(
    { assetId: "testAsset", aspectRatio: 1, surfaceArea: 4, semanticRole: "stone" },
    [band],
  );
  assert.equal(mapping?.targetTexelDensityPxPerMeter, "2199023255552");
  assert.equal(mapping?.assetId, "testAsset");
  assert.equal(
    selectHotspotTrimBand({ assetId: "testAsset", aspectRatio: 100, surfaceArea: 4 }, [band]),
    undefined,
  );
});

test("Hotspot mapping recognizes trunk and frond material synonyms", () => {
  const band = {
    bandId: "palm_band",
    semanticRoles: ["palm_trunk", "palm_frond"],
    uMin: 0,
    vMin: 0,
    uMax: 0.5,
    vMax: 1,
    tilingAxis: "v" as const,
    metricWidth: 2,
    metricHeight: 2,
  };
  const mapping = selectHotspotTrimBand({ assetId: "testAsset", aspectRatio: 1, surfaceArea: 4 }, [
    band,
  ]);
  assert.equal(mapping?.materialClass, "foliage_card");
  const trunk = selectHotspotTrimBand({ assetId: "testAsset", aspectRatio: 1, surfaceArea: 4 }, [
    { ...band, bandId: "trunk_band", semanticRoles: ["palm_trunk"] },
  ]);
  assert.equal(trunk?.materialClass, "wood");
});

test("Trim bands validate UV order and tiling axis", () => {
  const band = {
    bandId: "trim_band_001",
    semanticRoles: ["stone"],
    uMin: 0,
    vMin: 0,
    uMax: 1,
    vMax: 0.5,
    tilingAxis: "v",
    metricWidth: 2,
    metricHeight: 2,
  };
  assert.equal(TRIM_BAND_SCHEMA.parse(band).bandId, "trim_band_001");
  assert.throws(() => TRIM_BAND_SCHEMA.parse({ ...band, uMin: 1, uMax: 1 }));
  assert.throws(() => TRIM_BAND_SCHEMA.parse({ ...band, tilingAxis: "diagonal" }));
});

test("Banded declarations replace the pending trim hash", () => {
  const hash = "d".repeat(64);
  const record = catalogAssetRecordSchema.parse({
    assetId: "asset_trimmed",
    sourceFileHash: hash,
    canonicalName: "asset_trimmed",
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
    admissionStatus: "locally_qualified",
    merkleLeafHash: hash,
  });
  const members = [
    { assetId: "asset_trimmed", sourcePath: "registry/asset_trimmed.glb", variantName: "only" },
  ];
  const pending = buildAuthoredAssetFamilyRevision(
    {
      familyName: "trimmed_things",
      handle: "props/clutter/stylized_low_poly/trimmed_things",
      displayName: "Trimmed Things",
      semanticRole: "props",
      styleTokens: ["stylized"],
      sharedTrimSheetAssetId: "shared_trim_sheet_pending",
      members,
      status: "declared",
    },
    [record],
  );
  assert.equal(pending.materialTrimSheetHash, contentHash("shared_trim_sheet_pending"));
  const banded = buildAuthoredAssetFamilyRevision(
    {
      familyName: "trimmed_things",
      handle: "props/clutter/stylized_low_poly/trimmed_things",
      displayName: "Trimmed Things",
      semanticRole: "props",
      styleTokens: ["stylized"],
      sharedTrimSheetAssetId: "shared_trim_sheet_starter",
      members,
      status: "declared",
      trimBands: [
        {
          bandId: "trim_band_001",
          semanticRoles: ["stone"],
          uMin: 0,
          vMin: 0,
          uMax: 1,
          vMax: 1,
          tilingAxis: "v",
          metricWidth: 2,
          metricHeight: 2,
        },
      ],
    },
    [record],
  );
  assert.notEqual(banded.materialTrimSheetHash, contentHash("shared_trim_sheet_pending"));
});
