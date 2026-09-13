import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  CATALOG_ADMISSION_RUBRIC_SCHEMA,
  CATALOG_ASSET_EVIDENCE_SET_SCHEMA,
  CATALOG_CALIBRATION_SPLIT_SCHEMA,
  CATALOG_EVIDENCE_CHANNELS,
  CATALOG_LEAKAGE_GROUPING_POLICY_SCHEMA,
  CATALOG_LEAKAGE_ANALYSIS_SCHEMA,
  CATALOG_MINIMUM_EVIDENCE_KINDS_BY_CHANNEL,
  CATALOG_NEAR_DUPLICATE_SEARCH_SCHEMA,
  CATALOG_SOURCE_NAME_HINT_SET_SCHEMA,
  analyzeCatalogLeakage,
  buildCatalogSourceNameHintSet,
  buildCatalogLeakageGroups,
  normalizeSourceFilename,
  sealCatalogAssetEvidenceSet,
  sealCatalogCalibrationSplit,
  sealCatalogEvidenceChannelReceipt,
  sealCatalogLeakageAnalysis,
  sealCatalogNearDuplicateSearch,
  validateCatalogCalibrationSplit,
  type CatalogCalibrationAssignment,
} from "@basalt/catalog-authoring";
import {
  TRUSTED_SOURCE_MANIFEST_SCHEMA,
  sealCatalogAssetArtifact,
  sealCatalogMeasurementSet,
  sealSourceProvenanceLedger,
  sealSourceProvenanceRecord,
  sourceAssetRelativePath,
  sourceRightsEvidenceHash,
  validateSourceAuthority,
  type TrustedSourceManifest,
} from "@basalt/catalog-model";
import { contentHash, quantizeQ32_32, stableJson } from "@basalt/contracts";

test("canonical sources deduplicate origin paths without making provenance a compiler input", () => {
  const authority = sourceAuthority(1);
  const originalManifest = stableJson(authority.manifest);
  const additionalOrigin = sealSourceProvenanceRecord({
    sourceContentHash: authority.manifest.assets[0]!.contentHash,
    originId: "another_origin",
    archivePaths: ["registry/source-archives/another.unitypackage"],
    originalPath: "Assets/Models/duplicate.fbx",
    sourceKind: "licensed",
    metersPerSourceUnit: 1,
    rights: rightsMaterial(),
  });
  const expandedLedger = sealSourceProvenanceLedger([
    ...authority.provenance.records,
    additionalOrigin,
  ]);
  const result = validateSourceAuthority({
    manifest: authority.manifest,
    provenance: expandedLedger,
  });
  assert.equal(result.status, "eligible");
  assert.equal(stableJson(authority.manifest), originalManifest);
  assert.equal(
    authority.manifest.assets[0]!.rights.evidenceHash,
    sourceRightsEvidenceHash(additionalOrigin),
  );
  assert.equal(Object.hasOwn(authority.manifest.assets[0]!, "originId"), false);
  assert.equal(Object.hasOwn(authority.manifest, "provenanceLedgerHash"), false);
});

test("original filenames become source-neutral weak hints without pack authority", () => {
  const authority = sourceAuthority(1);
  const source = authority.provenance.records[0]!;
  const alias = sealSourceProvenanceRecord({
    sourceContentHash: source.sourceContentHash,
    originId: "unrelated_origin",
    archivePaths: ["registry/source-archives/unrelated.unitypackage"],
    originalPath: "Another/Pack/SM_Prop_Windfarm_Blades_01--abcdef123456.glb",
    sourceKind: source.sourceKind,
    metersPerSourceUnit: source.metersPerSourceUnit,
    rights: source.rights,
  });
  const first = buildCatalogSourceNameHintSet({
    sourceManifest: authority.manifest,
    provenance: sealSourceProvenanceLedger([source, alias]),
  });
  const { hash: _aliasHash, ...aliasMaterial } = alias;
  const renamedOrigin = sealSourceProvenanceRecord({
    ...aliasMaterial,
    originId: "different_origin",
    archivePaths: ["registry/source-archives/different.unitypackage"],
  });
  const second = buildCatalogSourceNameHintSet({
    sourceManifest: authority.manifest,
    provenance: sealSourceProvenanceLedger([source, renamedOrigin]),
  });
  const hint = first.items[0]!;
  const normalizedAlias = hint.observations.find((entry) =>
    entry.originalFilename.startsWith("SM_"),
  );

  assert.equal(first.hash, second.hash);
  assert.equal(first.compilerAuthority, false);
  assert.equal(hint.interpretation, "multiple_normalized_names");
  assert.deepEqual(normalizedAlias?.tokens, ["sm", "prop", "windfarm", "blades", "01"]);
  assert.equal(normalizedAlias?.normalizedStem, "sm prop windfarm blades 01");
  assert.equal(CATALOG_SOURCE_NAME_HINT_SET_SCHEMA.parse(first).hash, first.hash);
  assert.equal(JSON.stringify(first).includes("originId"), false);
  assert.equal(JSON.stringify(first).includes("archivePaths"), false);
  assert.equal(JSON.stringify(first).includes("originalPath"), false);
  assert.deepEqual(normalizeSourceFilename("WallCorner12.glb").tokens, ["wall", "corner", "12"]);
});

test("source authority rejects non-canonical pool paths and mismatched rights evidence", () => {
  const authority = sourceAuthority(1);
  assert.throws(
    () =>
      TRUSTED_SOURCE_MANIFEST_SCHEMA.parse({
        ...authority.manifest,
        assets: [
          {
            ...authority.manifest.assets[0],
            relativePath: "registry/source-assets/by-pack/tree.glb",
          },
        ],
      }),
    /canonical source identity/iu,
  );
  const wrong = {
    ...authority.manifest,
    assets: [
      {
        ...authority.manifest.assets[0]!,
        rights: {
          ...authority.manifest.assets[0]!.rights,
          evidenceHash: contentHash("missing-provenance"),
        },
      },
    ],
  };
  assert.equal(
    validateSourceAuthority({ manifest: wrong, provenance: authority.provenance }).status,
    "rejected",
  );
  const provenanceMaterial = authority.provenance.records[0]!;
  const conflictingRecord = sealSourceProvenanceRecord({
    sourceContentHash: provenanceMaterial.sourceContentHash,
    originId: "conflicting_origin",
    archivePaths: ["registry/source-archives/conflicting.unitypackage"],
    originalPath: "Assets/Models/conflicting.fbx",
    sourceKind: provenanceMaterial.sourceKind,
    metersPerSourceUnit: provenanceMaterial.metersPerSourceUnit,
    rights: { ...rightsMaterial(), redistributionPermitted: false },
  });
  const conflictingProvenance = sealSourceProvenanceLedger([
    ...authority.provenance.records,
    conflictingRecord,
  ]);
  assert.equal(
    validateSourceAuthority({
      manifest: authority.manifest,
      provenance: conflictingProvenance,
    }).status,
    "rejected",
  );
});

test("orthogonal evidence remains source-neutral and fails closed when a channel is missing", () => {
  const sourceContentHash = contentHash("evidence-source");
  const sourceManifestHash = contentHash("evidence-manifest");
  const channels = CATALOG_EVIDENCE_CHANNELS.map((channel) =>
    sealCatalogEvidenceChannelReceipt({
      channel,
      status: "eligible",
      references: CATALOG_MINIMUM_EVIDENCE_KINDS_BY_CHANNEL[channel].map((evidenceKind) => ({
        evidenceKind,
        artifactHash: contentHash(`${channel}:${evidenceKind}:artifact`),
        implementationHash: contentHash(`${channel}:${evidenceKind}:implementation`),
        inputHashes: [sourceContentHash],
      })),
      diagnostics: [],
    }),
  );
  const eligible = sealCatalogAssetEvidenceSet({
    sourceContentHash,
    sourceManifestHash,
    channels,
  });
  assert.equal(eligible.status, "eligible");
  assert.equal(CATALOG_ASSET_EVIDENCE_SET_SCHEMA.parse(eligible).hash, eligible.hash);
  assert.throws(
    () => CATALOG_ASSET_EVIDENCE_SET_SCHEMA.parse({ ...eligible, sourcePackageId: "nature" }),
    /unrecognized key/iu,
  );

  const incompleteShape = sealCatalogEvidenceChannelReceipt({
    channel: "shape",
    status: "incomplete",
    references: channels
      .find((entry) => entry.channel === "shape")!
      .references.filter((entry) => entry.evidenceKind !== "surface_normal_render_set"),
    diagnostics: ["surface normal evidence is missing"],
  });
  const incomplete = sealCatalogAssetEvidenceSet({
    sourceContentHash,
    sourceManifestHash,
    channels: channels.map((channel) => (channel.channel === "shape" ? incompleteShape : channel)),
  });
  assert.equal(incomplete.status, "incomplete");
});

test("calibration splits physical leakage groups, never source origins", async () => {
  const authority = sourceAuthority(4);
  const policy = CATALOG_LEAKAGE_GROUPING_POLICY_SCHEMA.parse(
    JSON.parse(await readFile("registry/leakage-grouping-policy.json", "utf8")),
  );
  const sources = authority.manifest.assets.map((asset) => asset.contentHash);
  const analysis = sealCatalogLeakageAnalysis({
    sourceManifestHash: contentHash(stableJson(authority.manifest)),
    measurementSetHash: contentHash("fixture-measurements"),
    groupingPolicyHash: policy.hash,
    nearDuplicateSearchHash: contentHash("fixture-near-duplicate-search"),
    implementationHash: contentHash("fixture-leakage-analyzer"),
    coverage: {
      exactContentIdentity: true,
      canonicalGeometryIdentity: true,
      geometryContainment: true,
      sharedMaterialPayload: true,
      nearDuplicateShape: true,
    },
    relations: [
      {
        leftSourceContentHash: sources[0]!,
        rightSourceContentHash: sources[1]!,
        relationKind: "near_duplicate_shape",
        evidenceHash: contentHash("fixture-near-duplicate-evidence"),
      },
    ],
    diagnostics: [],
  });
  const groups = buildCatalogLeakageGroups(authority.manifest, analysis, policy);
  assert.equal(groups.length, 3);
  const paired = groups.find((group) => group.sourceContentHashes.length === 2)!;
  const singletons = groups.filter((group) => group.sourceContentHashes.length === 1);
  const assignments: CatalogCalibrationAssignment[] = [
    { groupHash: paired.hash, role: "development" },
    { groupHash: singletons[0]!.hash, role: "calibration" },
    { groupHash: singletons[1]!.hash, role: "evaluation" },
  ];
  const seal = (reverse: boolean) =>
    sealCatalogCalibrationSplit({
      sourceManifest: authority.manifest,
      groupingPolicy: policy,
      leakageAnalysis: analysis,
      assignments: reverse ? [...assignments].reverse() : assignments,
      targets: [
        { role: "development", targetPermille: 600 },
        { role: "calibration", targetPermille: 200 },
        { role: "evaluation", targetPermille: 200 },
      ],
    });
  const split = seal(false);
  assert.equal(split.status, "eligible");
  assert.equal(split.hash, seal(true).hash);
  assert.equal(
    validateCatalogCalibrationSplit({
      split,
      sourceManifest: authority.manifest,
      groupingPolicy: policy,
      leakageAnalysis: analysis,
    }).status,
    "eligible",
  );
  assert.equal(JSON.stringify(split).includes("origin"), false);

  const unknownSourceAnalysis = sealCatalogLeakageAnalysis({
    sourceManifestHash: analysis.sourceManifestHash,
    measurementSetHash: analysis.measurementSetHash,
    groupingPolicyHash: analysis.groupingPolicyHash,
    nearDuplicateSearchHash: analysis.nearDuplicateSearchHash,
    implementationHash: analysis.implementationHash,
    coverage: analysis.coverage,
    relations: [
      {
        leftSourceContentHash: sources[0]!,
        rightSourceContentHash: contentHash("unknown-source"),
        relationKind: "near_duplicate_shape",
        evidenceHash: contentHash("invalid-near-duplicate-evidence"),
      },
    ],
    diagnostics: [],
  });
  assert.throws(
    () => buildCatalogLeakageGroups(authority.manifest, unknownSourceAnalysis, policy),
    /unknown source/iu,
  );
});

test("physical leakage analysis groups identity evidence while retaining material context", async () => {
  const authority = sourceAuthority(4);
  const policy = CATALOG_LEAKAGE_GROUPING_POLICY_SCHEMA.parse(
    JSON.parse(await readFile("registry/leakage-grouping-policy.json", "utf8")),
  );
  const sharedGeometry = contentHash("shared-geometry");
  const sharedMaterial = contentHash("shared-material");
  const assets = authority.manifest.assets.map((source, index) =>
    measuredAsset(
      source,
      index < 2 ? sharedGeometry : contentHash(`geometry-${index}`),
      index === 1 || index === 2 ? sharedMaterial : contentHash(`material-${index}`),
    ),
  );
  const measurements = sealCatalogMeasurementSet({
    sourceManifestHash: contentHash(stableJson(authority.manifest)),
    assets,
    diagnostics: [],
  });
  const incomplete = analyzeCatalogLeakage({
    sourceManifest: authority.manifest,
    measurements,
    groupingPolicy: policy,
    nearDuplicateSearch: sealCatalogNearDuplicateSearch({
      sourceManifestHash: contentHash(stableJson(authority.manifest)),
      visualReviewIndexHash: contentHash("fixture-render-index"),
      implementationHash: contentHash("fixture-near-duplicate-search"),
      descriptorSetHash: contentHash("fixture-partial-descriptors"),
      similarityThreshold: policy.nearDuplicateSimilarity,
      searchedSourceContentHashes: [],
      comparedPairCount: 0,
      relations: [],
      diagnostics: [
        {
          code: "fixture_search_pending",
          message: "Fixture deliberately has no shape descriptors",
          gateStatus: "incomplete",
          path: ["searchedSourceContentHashes"],
          evidenceHashes: [],
        },
      ],
    }),
  });
  assert.equal(incomplete.status, "incomplete");
  assert.equal(incomplete.coverage.nearDuplicateShape, false);

  const complete = analyzeCatalogLeakage({
    sourceManifest: authority.manifest,
    measurements,
    groupingPolicy: policy,
    nearDuplicateSearch: sealCatalogNearDuplicateSearch({
      sourceManifestHash: contentHash(stableJson(authority.manifest)),
      visualReviewIndexHash: contentHash("fixture-render-index"),
      implementationHash: contentHash("fixture-near-duplicate-search"),
      descriptorSetHash: contentHash("fixture-complete-descriptors"),
      similarityThreshold: policy.nearDuplicateSimilarity,
      searchedSourceContentHashes: authority.manifest.assets.map((asset) => asset.contentHash),
      comparedPairCount: 6,
      relations: [],
      diagnostics: [],
    }),
  });
  assert.equal(complete.status, "eligible");
  const groups = buildCatalogLeakageGroups(authority.manifest, complete, policy);
  assert.deepEqual(
    groups.map((group) => group.sourceContentHashes.length).sort((left, right) => right - left),
    [2, 1, 1],
  );
  assert.equal(
    complete.relations.some((relation) => relation.relationKind === "shared_material_payload"),
    true,
  );
  assert.equal(JSON.stringify(complete).includes("originId"), false);
});

test("tracked admission authority is source-neutral and bound to the current corpus", async () => {
  const manifest = TRUSTED_SOURCE_MANIFEST_SCHEMA.parse(
    JSON.parse(await readFile("registry/source-manifest.json", "utf8")),
  );
  const rubric = CATALOG_ADMISSION_RUBRIC_SCHEMA.parse(
    JSON.parse(await readFile("registry/admission-rubric.json", "utf8")),
  );
  const policy = CATALOG_LEAKAGE_GROUPING_POLICY_SCHEMA.parse(
    JSON.parse(await readFile("registry/leakage-grouping-policy.json", "utf8")),
  );
  const split = CATALOG_CALIBRATION_SPLIT_SCHEMA.parse(
    JSON.parse(await readFile("registry/calibration-split.json", "utf8")),
  );
  const analysis = CATALOG_LEAKAGE_ANALYSIS_SCHEMA.parse(
    JSON.parse(await readFile("registry/leakage-analysis.json", "utf8")),
  );
  const nearDuplicateSearch = CATALOG_NEAR_DUPLICATE_SEARCH_SCHEMA.parse(
    JSON.parse(await readFile("registry/near-duplicate-search.json", "utf8")),
  );
  const result = validateCatalogCalibrationSplit({
    split,
    sourceManifest: manifest,
    groupingPolicy: policy,
    leakageAnalysis: analysis,
  });
  assert.equal(rubric.evidenceChannels.length, 7);
  assert.equal(result.status, "eligible");
  assert.equal(nearDuplicateSearch.searchedSourceContentHashes.length, manifest.assets.length);
  assert.equal(
    nearDuplicateSearch.comparedPairCount,
    (manifest.assets.length * (manifest.assets.length - 1)) / 2,
  );
  assert.equal(
    split.groups.reduce((sum, group) => sum + group.sourceContentHashes.length, 0),
    manifest.assets.length,
  );
  assert.equal(
    split.groups.some((group) =>
      group.evidence.some((evidence) => evidence.relationKind === "shared_material_payload"),
    ),
    false,
  );
  assert.equal(
    analysis.relations.some((relation) => relation.relationKind === "shared_material_payload"),
    true,
  );
  assert.equal(JSON.stringify({ rubric, policy, split }).includes("packageId"), false);
});

function sourceAuthority(count: number) {
  const records = Array.from({ length: count }, (_, index) => {
    const sourceContentHash = contentHash(`canonical-source-${index}`);
    return sealSourceProvenanceRecord({
      sourceContentHash,
      originId: `fixture_origin_${index}`,
      archivePaths: [`registry/source-archives/fixture-${index}.unitypackage`],
      originalPath: `Assets/Models/fixture-${index}.fbx`,
      sourceKind: "creator_owned",
      metersPerSourceUnit: 1,
      rights: rightsMaterial(),
    });
  });
  const provenance = sealSourceProvenanceLedger(records);
  const manifest: TrustedSourceManifest = TRUSTED_SOURCE_MANIFEST_SCHEMA.parse({
    kind: "TrustedSourceManifest",
    rightsNotice: "registry/rights-note.md",
    assetRoot: "registry/source-assets/sha256",
    assets: records
      .map((record) => ({
        contentHash: record.sourceContentHash,
        relativePath: sourceAssetRelativePath(record.sourceContentHash),
        metersPerSourceUnit: record.metersPerSourceUnit,
        rights: { ...record.rights, evidenceHash: sourceRightsEvidenceHash(record) },
      }))
      .sort((left, right) =>
        left.contentHash < right.contentHash ? -1 : left.contentHash > right.contentHash ? 1 : 0,
      ),
  });
  assert.equal(validateSourceAuthority({ manifest, provenance }).status, "eligible");
  return { manifest, provenance };
}

function rightsMaterial() {
  return {
    licenseId: "fixture-license",
    commercialUsePermitted: true,
    redistributionPermitted: true,
    attribution: "Synthetic test fixture",
  };
}

function measuredAsset(
  source: TrustedSourceManifest["assets"][number],
  geometryHash: string,
  materialHash: string,
) {
  const q = quantizeQ32_32;
  const vector = (x: number, y: number, z: number) => ({ x: q(x), y: q(y), z: q(z) });
  const identity = {
    position: vector(0, 0, 0),
    rotationQuaternion: [q(0), q(0), q(0), q(1)] as [string, string, string, string],
    uniformScale: q(1),
  };
  return sealCatalogAssetArtifact({
    source: {
      contentHash: source.contentHash,
      rights: source.rights,
      sourceArtifact: {
        artifactHash: source.contentHash,
        bytes: 128,
        mediaType: "model/gltf-binary",
      },
    },
    geometryHash,
    deformation: {
      mode: "static",
      measuredPose: "static",
      animationCount: 0,
      skinCount: 0,
    },
    coordinateFrame: {
      handedness: "right_handed",
      up: "+Y",
      forward: "-Z",
      unitsToMeters: q(1),
      canonicalRoot: identity,
    },
    bounds: { min: vector(0, 0, 0), max: vector(1, 1, 1) },
    parts: [
      {
        partId: "whole",
        geometryHash,
        role: "render_static",
        transform: identity,
        bounds: { min: vector(0, 0, 0), max: vector(1, 1, 1) },
        triangleCount: 12,
        materialHashes: [materialHash],
      },
    ],
    materials: [
      {
        appearanceHash: contentHash(`appearance:${source.contentHash}`),
        payloadHashes: [materialHash],
        pbrChannels: ["base_color"],
      },
    ],
    support: {
      primaryContact: "unknown",
      contactAreaSquareMeters: q(0),
      refusalReason: "Synthetic fixture has no measured support surface",
    },
    collision: { mode: "none", companionAssetHashes: [], orientedBounds: [] },
    sockets: [],
    socketMeasurementRefusal: "Synthetic fixture has no measured interface",
    measurementEvidenceHashes: [contentHash(`measurement:${source.contentHash}`)],
  });
}
