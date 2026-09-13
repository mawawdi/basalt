import assert from "node:assert/strict";
import test from "node:test";
import {
  CATALOG_REQUIREMENT_SCHEMA,
  resolveCatalogRequirements,
  sealCatalogAssetArtifact,
  sealCatalogSnapshot,
} from "@basalt/catalog-model";
import { contentHash, quantizeQ32_32 } from "@basalt/contracts";
import { catalogFixture } from "./helpers/catalog-fixture.js";
import { loadSemanticRegistry } from "./helpers/semantic-registry.js";
import {
  createSemanticDependencyClosure,
  sealSemanticAssertionBundle,
} from "@basalt/semantic-kernel";

test("catalog sealing preserves genuine substitution and exact evidence", async () => {
  const module = await loadSemanticRegistry();
  const fixture = await catalogFixture(module);
  assert.equal(fixture.snapshot.status, "eligible");
  assert.equal(fixture.snapshot.entries[0]?.kind, "substitution_set");
  assert.equal(fixture.snapshot.entries[0]?.memberAssets[0]?.assetHash, fixture.asset.hash);
  assert.throws(
    () =>
      sealCatalogSnapshot({
        semanticModule: module,
        semanticAssertions: [fixture.assertions],
        styleProfiles: [],
        assets: [fixture.asset],
        declarations: [],
        dispositions: [],
        sourceContentHashes: [fixture.asset.source.contentHash],
      }),
    /disposition/u,
  );
});

test("catalog measurement cannot disguise deformable rest-pose evidence as static geometry", async () => {
  const module = await loadSemanticRegistry();
  const fixture = await catalogFixture(module);
  const { kind: _kind, assetId: _assetId, hash: _hash, ...material } = fixture.asset;
  assert.throws(
    () =>
      sealCatalogAssetArtifact({
        ...material,
        deformation: {
          mode: "static",
          measuredPose: "rest_pose",
          animationCount: 0,
          skinCount: 1,
        },
      }),
    /Static geometry cannot carry animation, skin, or rest-pose evidence/u,
  );
});

test("resolver filters substitution members before deterministic weighted selection", async () => {
  const module = await loadSemanticRegistry();
  const fixture = await catalogFixture(module);
  const {
    kind: _kind,
    assetId: _assetId,
    hash: _hash,
    source: originalSource,
    ...assetMaterial
  } = fixture.asset;
  const oversized = sealCatalogAssetArtifact({
    ...assetMaterial,
    source: {
      ...originalSource,
      contentHash: contentHash("catalog-fixture-oversized-source"),
      rights: {
        ...originalSource.rights,
        commercialUsePermitted: false,
        evidenceHash: contentHash("catalog-fixture-oversized-rights"),
      },
      sourceArtifact: {
        artifactHash: contentHash("catalog-fixture-oversized-bytes"),
        bytes: 8192,
        mediaType: "model/gltf-binary",
      },
    },
    bounds: {
      min: { x: quantizeQ32_32(-2), y: quantizeQ32_32(0), z: quantizeQ32_32(-2) },
      max: { x: quantizeQ32_32(2), y: quantizeQ32_32(2), z: quantizeQ32_32(2) },
    },
    parts: assetMaterial.parts.map((part) => ({
      ...part,
      bounds: {
        min: { x: quantizeQ32_32(-2), y: quantizeQ32_32(0), z: quantizeQ32_32(-2) },
        max: { x: quantizeQ32_32(2), y: quantizeQ32_32(2), z: quantizeQ32_32(2) },
      },
    })),
  });
  const oversizedAssertions = sealSemanticAssertionBundle({
    authority: "admitted",
    assertions: fixture.assertions.assertions.map((assertion) => ({
      ...assertion,
      subject: { kind: "catalog_asset" as const, id: oversized.assetId },
    })),
  });
  const declaration = {
    ...fixture.declaration,
    members: [
      fixture.declaration.members[0]!,
      {
        memberId: "tree_oversized",
        assetHash: oversized.hash,
        assertionBundleHash: oversizedAssertions.hash,
        selectionWeight: 1_000_000,
        socketBindings: [],
      },
    ],
  };
  const snapshot = sealCatalogSnapshot({
    semanticModule: module,
    semanticAssertions: [fixture.assertions, oversizedAssertions],
    styleProfiles: [fixture.styleProfile],
    assets: [fixture.asset, oversized],
    declarations: [declaration],
    dispositions: [
      {
        sourceContentHash: fixture.asset.source.contentHash,
        status: "eligible",
        usage: {
          kind: "entry_member",
          entryHandle: declaration.handle,
          memberId: "tree_a",
        },
      },
      {
        sourceContentHash: oversized.source.contentHash,
        status: "eligible",
        usage: {
          kind: "entry_member",
          entryHandle: declaration.handle,
          memberId: "tree_oversized",
        },
      },
    ],
    sourceContentHashes: [fixture.asset.source.contentHash, oversized.source.contentHash],
  });
  const resolution = resolveCatalogRequirements({
    semanticModule: module,
    snapshot,
    requirements: [fixture.requirement],
  });
  assert.equal(resolution.status, "eligible");
  assert.equal(resolution.bindings[0]?.memberId, "tree_a");
  assert.deepEqual(resolution.bindings[0]?.explanation.rankedCandidates[0]?.eligibleMemberIds, [
    "tree_a",
  ]);
  assert.deepEqual(resolution.bindings[0]?.explanation.rankedCandidates[0]?.rejectedMembers, [
    {
      memberId: "tree_oversized",
      reasons: ["metric_bounds_x", "metric_bounds_z", "commercial_rights", "source_byte_budget"],
    },
  ]);
});

test("hypothesis assertions cannot enter a sealed catalog", async () => {
  const module = await loadSemanticRegistry();
  const fixture = await catalogFixture(module);
  const hypothesis = sealSemanticAssertionBundle({
    authority: "hypothesis",
    hypothesisSourceHash: "a".repeat(64),
    assertions: [],
    abstentions: ["No authoritative classification was admitted"],
  });
  assert.throws(
    () =>
      sealCatalogSnapshot({
        semanticModule: module,
        semanticAssertions: [hypothesis] as never,
        styleProfiles: [],
        assets: [fixture.asset],
        declarations: [],
        dispositions: [
          {
            sourceContentHash: fixture.asset.source.contentHash,
            status: "incomplete",
            reason: "Hypothesis awaits review",
          },
        ],
        sourceContentHashes: [fixture.asset.source.contentHash],
      }),
    /invalid input|authority/iu,
  );
});

test("resolver hard-filters, emits typed required gaps, and is input-order independent", async () => {
  const module = await loadSemanticRegistry();
  const fixture = await catalogFixture(module);
  const first = resolveCatalogRequirements({
    semanticModule: module,
    snapshot: fixture.snapshot,
    requirements: [fixture.requirement],
  });
  const second = resolveCatalogRequirements({
    semanticModule: module,
    snapshot: fixture.snapshot,
    requirements: [CATALOG_REQUIREMENT_SCHEMA.parse({ ...fixture.requirement })],
  });
  assert.equal(first.hash, second.hash);
  assert.equal(first.status, "eligible");
  assert.equal(first.bindings[0]?.entryHandle, "tree_whole_ground");

  const impossible = resolveCatalogRequirements({
    semanticModule: module,
    snapshot: fixture.snapshot,
    requirements: [
      {
        ...fixture.requirement,
        acceptedEntryKinds: ["attachment_set"],
      },
    ],
  });
  assert.equal(impossible.status, "incomplete");
  assert.equal(impossible.gaps[0]?.kind, "catalog_gap");
  assert.deepEqual(impossible.gaps[0]?.rejectedCandidates[0]?.reasons, ["entry_kind"]);

  const optional = resolveCatalogRequirements({
    semanticModule: module,
    snapshot: fixture.snapshot,
    requirements: [
      { ...fixture.requirement, acceptedEntryKinds: ["attachment_set"], required: false },
    ],
  });
  assert.equal(optional.status, "eligible");
  assert.equal(optional.gaps.length, 1);

  const affordanceId = String(module.affordances[0]!.affordanceId);
  const evidenceClosure = createSemanticDependencyClosure({
    module,
    conceptIds: [fixture.requirement.semantic.denotation.conceptId],
    definitionIds: ["whole", affordanceId],
  });
  const missingEvidence = resolveCatalogRequirements({
    semanticModule: module,
    snapshot: fixture.snapshot,
    requirements: [
      {
        ...fixture.requirement,
        semantic: {
          ...fixture.requirement.semantic,
          affordances: [{ affordanceId, minimumEvidence: "simulated" }],
          dependencyClosureHash: evidenceClosure.hash,
        },
      },
    ],
  });
  assert.equal(missingEvidence.status, "incomplete");
  assert.equal(missingEvidence.gaps[0]?.kind, "evidence_gap");
  assert.deepEqual(missingEvidence.gaps[0]?.rejectedCandidates[0]?.reasons, [
    "affordance_evidence",
  ]);
});

test("collision companions require an exact eligible owner binding", async () => {
  const module = await loadSemanticRegistry();
  const fixture = await catalogFixture(module);
  const {
    kind: _kind,
    assetId: _assetId,
    hash: _hash,
    source: originalSource,
    ...companionMaterial
  } = fixture.asset;
  const companion = sealCatalogAssetArtifact({
    ...companionMaterial,
    source: {
      ...originalSource,
      contentHash: contentHash("catalog-fixture-collision-source"),
      sourceArtifact: {
        artifactHash: contentHash("catalog-fixture-collision-bytes"),
        bytes: 512,
        mediaType: "model/gltf-binary",
      },
    },
    parts: companionMaterial.parts.map((part) => ({ ...part, role: "collision_proxy" as const })),
  });
  const dispositions = [
    {
      sourceContentHash: fixture.asset.source.contentHash,
      status: "eligible" as const,
      usage: {
        kind: "entry_member" as const,
        entryHandle: fixture.declaration.handle,
        memberId: "tree_a",
      },
    },
    {
      sourceContentHash: companion.source.contentHash,
      status: "eligible" as const,
      usage: {
        kind: "collision_companion" as const,
        ownerSourceContentHash: fixture.asset.source.contentHash,
      },
    },
  ];
  assert.throws(
    () =>
      sealCatalogSnapshot({
        semanticModule: module,
        semanticAssertions: [fixture.assertions],
        styleProfiles: [fixture.styleProfile],
        assets: [fixture.asset, companion],
        declarations: [fixture.declaration],
        dispositions,
        sourceContentHashes: [fixture.asset.source.contentHash, companion.source.contentHash],
      }),
    /collision companion .* exact eligible owner binding/iu,
  );

  const {
    kind: _ownerKind,
    assetId: _ownerAssetId,
    hash: _ownerHash,
    ...ownerMaterial
  } = fixture.asset;
  const owner = sealCatalogAssetArtifact({
    ...ownerMaterial,
    collision: {
      mode: "companion",
      companionAssetHashes: [companion.hash],
      orientedBounds: [],
      evidenceHash: contentHash("catalog-fixture-companion-binding"),
    },
  });
  const declaration = {
    ...fixture.declaration,
    members: fixture.declaration.members.map((member) => ({ ...member, assetHash: owner.hash })),
  };
  const accepted = sealCatalogSnapshot({
    semanticModule: module,
    semanticAssertions: [fixture.assertions],
    styleProfiles: [fixture.styleProfile],
    assets: [owner, companion],
    declarations: [declaration],
    dispositions,
    sourceContentHashes: [owner.source.contentHash, companion.source.contentHash],
  });
  assert.equal(accepted.status, "eligible");
});
