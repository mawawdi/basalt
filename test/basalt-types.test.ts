import test from "node:test";
import assert from "node:assert/strict";
import {
  computeFamilyMerkleId,
  dequantizeQ32_32,
  familyCardSchema,
  parseQ32_32,
  parseFamilyHandle,
  quantizeQ32_32,
  serializePaletteMenu,
  serializeQ32_32,
  worldPlanSchema,
} from "../packages/basalt-types/src/index.js";

test("Q32.32 uses canonical signed integer strings", () => {
  const encoded = quantizeQ32_32(1.5);
  assert.equal(encoded, "6442450944");
  assert.equal(dequantizeQ32_32(encoded), 1.5);
  assert.equal(serializeQ32_32(parseQ32_32(encoded)), encoded);
  assert.throws(() => parseQ32_32("-0"));
  assert.throws(() => parseQ32_32("01"));
  assert.throws(() => parseQ32_32("1.5"));
  assert.throws(() => quantizeQ32_32(Number.NaN));
});

test("taxonomy handles are strict and expose planning segments", () => {
  const parsed = parseFamilyHandle("@creator/foliage/canopy/stylized_low_poly/palm_trees#tall");
  assert.equal(parsed.vendor, "creator");
  assert.equal(parsed.spatialRole, "canopy");
  assert.equal(parsed.variantToken, "tall");
  assert.throws(() => parseFamilyHandle("props/unknown/stylized_low_poly/barrels"));
});

test("family Merkle IDs and compact palette cards are deterministic", () => {
  const input = {
    handle: "props/clutter/stylized_low_poly/barrels",
    geometryHashes: ["b".repeat(64), "a".repeat(64)],
    materialTrimHash: "c".repeat(64),
    physicsCompanionHash: "d".repeat(64),
  };
  const fid = computeFamilyMerkleId(input);
  const card = familyCardSchema.parse({
    handle: input.handle,
    fid,
    roles: ["clutter"],
    archetypes: [{ token: "barrel_01", bounds: [1, 2, 1], mass: 1 }],
    affinities: { surfaces: ["floor"], max_slope_deg: 30, clearance_rad: 0.2 },
    density: { min_per_hectare: 1, max_per_hectare: 4 },
    sockets: null,
  });
  const first = serializePaletteMenu([card]);
  const second = serializePaletteMenu([card]);
  assert.equal(first, second);
  assert.ok(first.length < 300);
});

test("WorldPlan enforces exploit membership and the 8-stud explore rule", () => {
  const fid = computeFamilyMerkleId({
    handle: "props/clutter/stylized_low_poly/barrels",
    geometryHashes: ["a".repeat(64)],
    materialTrimHash: "b".repeat(64),
    physicsCompanionHash: "c".repeat(64),
  });
  const card = {
    handle: "props/clutter/stylized_low_poly/barrels",
    fid,
    roles: ["clutter"],
    archetypes: [{ token: "barrel_01", bounds: [1, 2, 1], mass: 1 }],
    affinities: { surfaces: ["floor"], max_slope_deg: 30, clearance_rad: 0.2 },
    density: { min_per_hectare: 1, max_per_hectare: 4 },
    sockets: null,
  } as const;
  assert.doesNotThrow(() =>
    worldPlanSchema.parse({
      world_id: "starter",
      style_contract: {
        style_motif: "stylized_low_poly",
        edge_fidelity: "faceted",
        palette_tokens: ["sand"],
        texel_density_target: 512,
      },
      palette_menu: [card],
      exploit_bindings: [{ region_id: "shore", assigned_fid: fid, target_density_per_hectare: 4 }],
      explore_requirements: [
        {
          requirement_id: "new_grass",
          suggested_handle: "foliage/groundcover/stylized_low_poly/grass",
          spatial_role: "groundcover",
          bounding_envelope_studs: [2, 0.5, 2],
          target_texel_density: 512,
          min_archetype_count: 3,
          surface_affinity: "soil",
        },
      ],
    }),
  );
  assert.throws(() =>
    worldPlanSchema.parse({
      world_id: "starter",
      style_contract: {
        style_motif: "x",
        edge_fidelity: "sharp",
        palette_tokens: [],
        texel_density_target: 1,
      },
      palette_menu: [card],
      exploit_bindings: [],
      explore_requirements: [
        {
          requirement_id: "too_large",
          suggested_handle: "foliage/groundcover/stylized_low_poly/grass",
          spatial_role: "groundcover",
          bounding_envelope_studs: [9, 1, 1],
          target_texel_density: 1,
          min_archetype_count: 3,
          surface_affinity: "soil",
        },
      ],
    }),
  );
});
