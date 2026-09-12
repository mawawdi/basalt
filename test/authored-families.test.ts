import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAuthoredAssetFamilyRevision,
  buildMountSockets,
  findSupportEvidenceViolations,
  measureKindFamilyDiagnostics,
  parseAuthoredFamilyManifest,
  type KindEvidenceMember,
} from "../packages/catalog-intelligence/src/index.js";
import {
  catalogAssetRecordSchema,
  dequantizeQ32_32,
  quantizeQ32_32,
} from "../packages/basalt-types/src/index.js";

const hash = "a".repeat(64);

function record(assetId: string, sourceFileHash = hash) {
  return catalogAssetRecordSchema.parse({
    assetId,
    sourceFileHash,
    canonicalName: assetId,
    boundingBox: { min: { x: "0", y: "0", z: "0" }, max: { x: "1", y: "2", z: "1" } },
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
    merkleLeafHash: sourceFileHash,
  });
}

const manifest = {
  kind: "BasaltAuthoredFamilyManifest",
  abi: "basalt-authored-families@2",
  families: [
    {
      familyName: "palm_trees",
      handle: "foliage/canopy/stylized_low_poly/palm_trees",
      displayName: "Stylized Palm Trees",
      semanticRole: "foliage",
      styleTokens: ["stylized", "cel_shaded"],
      sharedTrimSheetAssetId: "shared_trim_sheet_pending",
      members: [
        { sourcePath: "pack/Tree_A.glb", variantName: "tall" },
        { sourcePath: "pack/Tree_B.glb", variantName: "curved" },
        { sourcePath: "pack/Tree_C.glb", variantName: "cluster" },
      ],
    },
  ],
} as const;

test("authored family manifests reject duplicate source membership", () => {
  assert.throws(
    () =>
      parseAuthoredFamilyManifest({
        ...manifest,
        families: [manifest.families[0], { ...manifest.families[0], familyName: "other_family" }],
      }),
    /multiple authored families/,
  );
});

test("authored family sealing is deterministic and content addressed", () => {
  const parsed = parseAuthoredFamilyManifest(manifest);
  const sourceDeclaration = parsed.families[0];
  assert.ok(sourceDeclaration);
  const declaration = {
    ...sourceDeclaration,
    status: "declared" as const,
    members: sourceDeclaration.members.map((member, index) => ({
      ...member,
      assetId: `asset_${index}`,
    })),
  };
  const assets = declaration.members.map((member) => record(member.assetId));
  const first = buildAuthoredAssetFamilyRevision(declaration, assets);
  const second = buildAuthoredAssetFamilyRevision(declaration, assets);
  assert.deepEqual(first, second);
  assert.equal(first.archetypes.length, 3);

  const changed = buildAuthoredAssetFamilyRevision(
    declaration,
    assets.map((asset, index) => (index === 2 ? record(asset.assetId, "b".repeat(64)) : asset)),
  );
  assert.notEqual(changed.familyId, first.familyId);
  assert.notEqual(changed.contentMerkleRoot, first.contentMerkleRoot);
});

function kindMember(
  assetId: string,
  partial: Partial<KindEvidenceMember> = {},
): KindEvidenceMember {
  return {
    assetId,
    variantName: assetId,
    boundsStuds: [3, 3, 3],
    triangleCount: 1000,
    submeshCount: 1,
    primaryContact: "bottom",
    hasManifoldTopology: true,
    topologicalGenus: 0,
    materialAppearanceHashes: ["common"],
    sourceFileHash: "f".repeat(64),
    ...partial,
  };
}

test("support gate flags members without support evidence", () => {
  const floating = kindMember("floating", { primaryContact: "unknown" });
  const violations = findSupportEvidenceViolations([floating]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.assetId, "floating");
  assert.match(violations[0]!.reason, /no measured support evidence/);
});

test("kind diagnostics record incoherent siblings without blocking", () => {
  const blade = kindMember("blade", { boundsStuds: [0.8, 3.2, 0.2] });
  const slab = kindMember("slab", { boundsStuds: [20, 1, 20] });
  const diagnostics = measureKindFamilyDiagnostics("geology/foundation/stylized_low_poly/mixed", [
    blade,
    slab,
  ]);
  assert.deepEqual(diagnostics.coherence.outlierVariants, ["slab"]);
  assert.equal(diagnostics.coherence.medoidAssetId, "blade");
  assert.deepEqual(findSupportEvidenceViolations([blade, slab]), []);
});

test("kind diagnostics cohere miniature and landscape variants of one shape", () => {
  const miniature = kindMember("miniature", { boundsStuds: [0.8, 1, 0.8] });
  const landscape = kindMember("landscape", { boundsStuds: [8, 10, 8] });
  const diagnostics = measureKindFamilyDiagnostics("foliage/canopy/stylized_low_poly/test_canopy", [
    miniature,
    landscape,
  ]);
  assert.deepEqual(diagnostics.coherence.outlierVariants, []);
});

test("kind diagnostics record treatment the members cannot realize", () => {
  const huge = kindMember("huge", { boundsStuds: [30, 30, 30] });
  const clutter = measureKindFamilyDiagnostics("props/clutter/rustic_iron/specks", [huge]);
  assert.equal(clutter.coverage.exceedsHectare, true);
  assert.ok(clutter.coverage.demandStuds2 > clutter.coverage.hectareStuds2);
  const foundation = measureKindFamilyDiagnostics("geology/foundation/stylized_low_poly/blocks", [
    huge,
  ]);
  assert.equal(foundation.coverage.exceedsHectare, false);
  assert.deepEqual(findSupportEvidenceViolations([huge]), []);
});

const trimBand = {
  bandId: "palm_columnar",
  semanticRoles: ["palm_trunk", "palm_frond"],
  uMin: 0,
  vMin: 0,
  uMax: 0.5,
  vMax: 1,
  tilingAxis: "v" as const,
  metricWidth: 5.2,
  metricHeight: 9.5,
};

test("authored declarations accept trim bands and mount socket opt-in", () => {
  const parsed = parseAuthoredFamilyManifest({
    ...manifest,
    families: [{ ...manifest.families[0], trimBands: [trimBand], mountSockets: true }],
  });
  assert.deepEqual(parsed.families[0]!.trimBands, [trimBand]);
  assert.equal(parsed.families[0]!.mountSockets, true);
});

test("authored declarations reject malformed trim bands", () => {
  assert.throws(
    () =>
      parseAuthoredFamilyManifest({
        ...manifest,
        families: [{ ...manifest.families[0], trimBands: [{ ...trimBand, uMin: 0.5, uMax: 0.5 }] }],
      }),
    /uMax must be strictly greater than uMin/,
  );
});

test("mount sockets follow the fitted support plane", () => {
  const [socket] = buildMountSockets({
    variantName: "Tall Palm!",
    supportPlaneFits: [
      {
        normalQ32_32: { x: "0", y: "4294967296", z: "0" },
        originQ32_32: { x: "4294967296", y: "0", z: "8589934592" },
        boundaryRadiusStuds: 0.5,
        inlierCount: 12,
        pointCount: 12,
      },
    ],
  });
  assert.equal(socket!.socketId, "mount_Tall_Palm__01");
  assert.equal(socket!.role, "mount");
  assert.equal(socket!.polarity, "Neutral");
  assert.deepEqual(socket!.localOrigin, { x: "4294967296", y: "0", z: "8589934592" });
  assert.deepEqual(socket!.normal, { x: "0", y: "4294967296", z: "0" });
  assert.deepEqual(socket!.upVector, { x: "0", y: "0", z: "4294967296" });
  assert.equal(dequantizeQ32_32(socket!.boundaryRadius), 0.5);
});

test("mount sockets index uniformly across feet", () => {
  const fit = {
    normalQ32_32: { x: "0", y: "4294967296", z: "0" },
    originQ32_32: { x: "0", y: "0", z: "0" },
    boundaryRadiusStuds: 1,
    inlierCount: 4,
    pointCount: 8,
  };
  const sockets = buildMountSockets({ variantName: "chair", supportPlaneFits: [fit, fit] });
  assert.deepEqual(
    sockets.map((socket) => socket.socketId),
    ["mount_chair_01", "mount_chair_02"],
  );
});

test("mount sockets project up onto tilted support planes", () => {
  const [socket] = buildMountSockets({
    variantName: "ramp",
    supportPlaneFits: [
      {
        normalQ32_32: {
          x: "0",
          y: quantizeQ32_32(Math.SQRT1_2),
          z: quantizeQ32_32(Math.SQRT1_2),
        },
        originQ32_32: { x: "0", y: "0", z: "0" },
        boundaryRadiusStuds: 1,
        inlierCount: 4,
        pointCount: 4,
      },
    ],
  });
  const up = {
    x: dequantizeQ32_32(socket!.upVector.x),
    y: dequantizeQ32_32(socket!.upVector.y),
    z: dequantizeQ32_32(socket!.upVector.z),
  };
  assert.ok(Math.abs(up.x - 0) < 1e-9);
  assert.ok(Math.abs(up.y + Math.SQRT1_2) < 1e-9);
  assert.ok(Math.abs(up.z - Math.SQRT1_2) < 1e-9);
});

test("mount sockets reject missing contact evidence", () => {
  const fit = {
    normalQ32_32: { x: "0", y: "4294967296", z: "0" },
    originQ32_32: { x: "0", y: "0", z: "0" },
    boundaryRadiusStuds: 0,
    inlierCount: 0,
    pointCount: 4,
  };
  assert.throws(
    () => buildMountSockets({ variantName: "floater", supportPlaneFits: [fit] }),
    /positively clipped/,
  );
  assert.throws(
    () =>
      buildMountSockets({
        variantName: "floater",
        supportPlaneFits: [
          {
            ...fit,
            boundaryRadiusStuds: 1,
            normalQ32_32: { x: "0", y: "0", z: "0" },
          },
        ],
      }),
    /nonzero.*normal/,
  );
});

function sealedDeclaration(enriched = false) {
  const parsed = parseAuthoredFamilyManifest(manifest);
  const source = parsed.families[0]!;
  return {
    ...source,
    ...(enriched ? { trimBands: [trimBand], mountSockets: true as const } : {}),
    status: "declared" as const,
    members: source.members.map((member, index) => ({
      ...member,
      assetId: `asset_${index}`,
    })),
  };
}

test("seal embeds trim mappings and mount sockets with grammar identity", () => {
  const declaration = sealedDeclaration(true);
  const assets = declaration.members.map((member) => record(member.assetId));
  const mapping = {
    assetId: "asset_0",
    bandId: "palm_columnar",
    materialClass: "foliage_card" as const,
    uMin: "0",
    uMax: "2147483648",
    vMin: "0",
    vMax: "4294967296",
    targetTexelDensityPxPerMeter: "2199023255552",
    maxDistortionEnergy: "1",
  };
  const fit = {
    normalQ32_32: { x: "0", y: "4294967296", z: "0" },
    originQ32_32: { x: "0", y: "0", z: "0" },
    boundaryRadiusStuds: 1,
    inlierCount: 4,
    pointCount: 4,
  };
  const revision = buildAuthoredAssetFamilyRevision(declaration, assets, {
    trimMappings: [mapping],
    mountContacts: {
      asset_0: { supportPlaneFits: [fit] },
      asset_1: { supportPlaneFits: [fit] },
      asset_2: { supportPlaneFits: [fit] },
    },
  });
  assert.deepEqual(revision.trimMappings, [mapping]);
  for (const archetype of revision.archetypes) assert.equal(archetype.registeredSockets.length, 1);
  assert.match(revision.socketGrammarHash ?? "", /^[a-f0-9]{64}$/u);
  const bare = buildAuthoredAssetFamilyRevision(sealedDeclaration(), assets);
  assert.notEqual(revision.familyId, bare.familyId);
  assert.notEqual(revision.materialTrimSheetHash, bare.materialTrimSheetHash);
});

test("seal without evidence keeps empty trim and socket state", () => {
  const declaration = sealedDeclaration();
  const assets = declaration.members.map((member) => record(member.assetId));
  const revision = buildAuthoredAssetFamilyRevision(declaration, assets);
  assert.deepEqual(revision.trimMappings, []);
  for (const archetype of revision.archetypes) assert.deepEqual(archetype.registeredSockets, []);
  assert.equal(revision.socketGrammarHash, undefined);
});

test("seal rejects trim mappings outside declared bands", () => {
  const declaration = sealedDeclaration(true);
  const assets = declaration.members.map((member) => record(member.assetId));
  assert.throws(
    () =>
      buildAuthoredAssetFamilyRevision(declaration, assets, {
        trimMappings: [
          {
            assetId: "asset_0",
            bandId: "unknown_band",
            materialClass: "stone" as const,
            uMin: "0",
            uMax: "2147483648",
            vMin: "0",
            vMax: "4294967296",
            targetTexelDensityPxPerMeter: "2199023255552",
            maxDistortionEnergy: "1",
          },
        ],
      }),
    /unknown trim band/,
  );
});

test("support gate passes coherent supported members under realizable treatment", () => {
  const members = [
    kindMember("cube_a", { boundsStuds: [3, 3, 3] }),
    kindMember("cube_b", { boundsStuds: [3.2, 2.8, 3.1] }),
  ];
  assert.deepEqual(findSupportEvidenceViolations(members), []);
  const diagnostics = measureKindFamilyDiagnostics("props/clutter/rustic_iron/specks", members);
  assert.deepEqual(diagnostics.coherence.outlierVariants, []);
  assert.equal(diagnostics.coverage.exceedsHectare, false);
});
