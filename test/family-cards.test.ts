import test from "node:test";
import assert from "node:assert/strict";
import { buildAuthoredAssetFamilyRevision } from "../packages/catalog-intelligence/src/family-revisions.js";
import { buildFamilyCard } from "../packages/catalog-intelligence/src/family-cards.js";
import {
  catalogAssetRecordSchema,
  ROLE_CLEARANCE_DEFAULTS,
} from "../packages/basalt-types/src/index.js";

const hash = "b".repeat(64);

function record(assetId: string, max: { x: string; y: string; z: string }) {
  return catalogAssetRecordSchema.parse({
    assetId,
    sourceFileHash: hash,
    canonicalName: assetId,
    boundingBox: { min: { x: "0", y: "0", z: "0" }, max },
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
    admissionStatus: "pending",
    merkleLeafHash: hash,
  });
}

// Q32.32 for 2.0 and 4.0 studs: 2 * 2^32 = 8589934592, 4 * 2^32 = 17179869184.
const tall = record("asset_tall", { x: "8589934592", y: "8589934592", z: "8589934592" });
const short = record("asset_short", {
  x: "17179869184",
  y: "17179869184",
  z: "17179869184",
});

const declaration = {
  familyName: "test_canopy",
  handle: "foliage/canopy/stylized_low_poly/test_canopy",
  displayName: "Test Canopy",
  semanticRole: "foliage",
  styleTokens: ["stylized"],
  sharedTrimSheetAssetId: "shared_trim_sheet_pending",
  members: [
    { assetId: "asset_tall", sourcePath: "pack/Tall.glb", variantName: "tall" },
    { assetId: "asset_short", sourcePath: "pack/Short.glb", variantName: "short" },
  ],
  status: "declared" as const,
};

function evidence() {
  return {
    surfaceTypes: ["terrain", "terrain_grass"],
    memberBounds: {
      asset_tall: tall.boundingBox,
      asset_short: short.boundingBox,
    },
  };
}

test("family cards carry per-archetype measured bounds", () => {
  const revision = buildAuthoredAssetFamilyRevision(declaration, [tall, short]);
  const card = buildFamilyCard(revision, evidence());
  const bounds = new Map(card.archetypes.map((entry) => [entry.token, entry.bounds]));
  assert.deepEqual(bounds.get("tall"), [2, 2, 2]);
  assert.deepEqual(bounds.get("short"), [4, 4, 4]);
});

test("family cards bind role clearance, surfaces, density, and mass", () => {
  const revision = buildAuthoredAssetFamilyRevision(declaration, [tall, short]);
  const card = buildFamilyCard(revision, evidence());
  assert.deepEqual(card.affinities.surfaces, ["terrain", "terrain_grass"]);
  assert.equal(card.affinities.clearance_rad, ROLE_CLEARANCE_DEFAULTS.canopy);
  assert.ok(card.density.min_per_hectare >= 0);
  assert.ok(card.density.max_per_hectare > card.density.min_per_hectare);
  const masses = new Map(card.archetypes.map((entry) => [entry.token, entry.mass]));
  assert.ok(masses.get("tall")! > 0);
  assert.ok(masses.get("short")! > masses.get("tall")!);
});

test("family cards fall back to composite bounds without member evidence", () => {
  const revision = buildAuthoredAssetFamilyRevision(declaration, [tall, short]);
  const card = buildFamilyCard(revision);
  for (const entry of card.archetypes) assert.deepEqual(entry.bounds, [4, 4, 4]);
  assert.deepEqual(card.affinities.surfaces, []);
});
