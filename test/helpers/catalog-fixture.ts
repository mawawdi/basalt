import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  sealCatalogAssetArtifact,
  sealCatalogSnapshot,
  sealStyleProfile,
  STYLE_PROFILE_DECLARATION_SCHEMA,
  type CatalogAssetArtifact,
  type CatalogEntryDeclaration,
  type CatalogRequirement,
  type CatalogSnapshot,
  type SealedStyleProfile,
} from "@basalt/catalog-model";
import { contentHash, quantizeQ32_32, stableJson } from "@basalt/contracts";
import {
  createSemanticDependencyClosure,
  sealSemanticAssertionBundle,
  type SemanticAssertionBundle,
  type SemanticModule,
} from "@basalt/semantic-kernel";

const evidenceHash = contentHash("catalog-fixture-evidence");

export async function catalogFixture(module: SemanticModule): Promise<{
  asset: CatalogAssetArtifact;
  snapshot: CatalogSnapshot;
  requirement: CatalogRequirement;
  assertions: Extract<SemanticAssertionBundle, { authority: "admitted" }>;
  declaration: Extract<CatalogEntryDeclaration, { kind: "substitution_set" }>;
  styleProfile: SealedStyleProfile;
}> {
  const asset = sealCatalogAssetArtifact({
    source: {
      contentHash: contentHash("catalog-fixture-source"),
      rights: {
        licenseId: "fixture-license",
        commercialUsePermitted: true,
        redistributionPermitted: true,
        attribution: "Synthetic test fixture",
        evidenceHash: contentHash("catalog-fixture-rights"),
      },
      sourceArtifact: {
        artifactHash: contentHash("catalog-fixture-bytes"),
        bytes: 1024,
        mediaType: "model/gltf-binary",
      },
    },
    geometryHash: contentHash("catalog-fixture-geometry"),
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
      canonicalRoot: transform(),
    },
    bounds: { min: vector(-0.5, 0, -0.5), max: vector(0.5, 2, 0.5) },
    parts: [
      {
        partId: "trunk_and_canopy",
        geometryHash: contentHash("catalog-fixture-part"),
        role: "render_static",
        transform: transform(),
        bounds: { min: vector(-0.5, 0, -0.5), max: vector(0.5, 2, 0.5) },
        triangleCount: 128,
        materialHashes: [contentHash("catalog-fixture-material")],
      },
    ],
    materials: [
      {
        appearanceHash: contentHash("catalog-fixture-material"),
        payloadHashes: [],
        pbrChannels: ["base_color", "metallic_roughness"],
      },
    ],
    support: {
      primaryContact: "bottom",
      contactAreaSquareMeters: q(1),
      measurementMethod: "planar_patch_fit",
      evidenceHash,
    },
    collision: {
      mode: "part_obbs",
      companionAssetHashes: [],
      orientedBounds: [
        {
          center: vector(0, 1, 0),
          halfSize: vector(0.5, 1, 0.5),
          rotation: [0, 0, 0, 1],
        },
      ],
      evidenceHash,
    },
    sockets: [],
    socketMeasurementRefusal: "This independently placed tree exposes no authored interfaces.",
    measurementEvidenceHashes: [evidenceHash],
  });
  const concept = module.concepts.find((entry) => entry.conceptId === "bsc_000003")!;
  const closure = createSemanticDependencyClosure({
    module,
    conceptIds: [concept.conceptId],
    definitionIds: ["whole"],
  });
  const assertions = sealSemanticAssertionBundle({
    authority: "admitted",
    assertions: [
      {
        assertionKind: "denotation",
        subject: { kind: "catalog_asset", id: asset.assetId },
        concept: { conceptId: concept.conceptId, commitmentHash: concept.commitmentHash },
        evidence: { level: "declared", evidenceHashes: [evidenceHash] },
      },
      {
        assertionKind: "realization_form",
        subject: { kind: "catalog_asset", id: asset.assetId },
        realizationForm: "whole",
        evidence: { level: "measured", evidenceHashes: [evidenceHash] },
      },
    ],
  });
  const styleDeclaration = STYLE_PROFILE_DECLARATION_SCHEMA.parse(
    JSON.parse(await readFile(resolve("registry/style-profiles.json"), "utf8"))[0],
  );
  const styleProfile = sealStyleProfile(styleDeclaration);
  const declaration: Extract<CatalogEntryDeclaration, { kind: "substitution_set" }> = {
    kind: "substitution_set",
    handle: "tree_whole_ground",
    semantic: {
      denotation: { conceptId: concept.conceptId, commitmentHash: concept.commitmentHash },
      realizationForm: "whole",
      fixedStates: [],
      affordances: [],
      surfaceTreatmentIds: [],
      dependencyClosureHash: closure.hash,
    },
    placement: { support: "ground", contact: "bottom", interfaces: [] },
    styleProfileHandle: "neutral",
    evidenceHashes: [evidenceHash],
    members: [
      {
        memberId: "tree_a",
        assetHash: asset.hash,
        assertionBundleHash: assertions.hash,
        selectionWeight: 3,
        socketBindings: [],
      },
    ],
  };
  const snapshot = sealCatalogSnapshot({
    semanticModule: module,
    semanticAssertions: [assertions],
    styleProfiles: [styleProfile],
    assets: [asset],
    declarations: [declaration],
    dispositions: [
      {
        sourceContentHash: asset.source.contentHash,
        status: "eligible",
        usage: { kind: "entry_member", entryHandle: "tree_whole_ground", memberId: "tree_a" },
      },
    ],
    sourceContentHashes: [asset.source.contentHash],
  });
  const requirement: CatalogRequirement = {
    requirementId: "Trees",
    semantic: {
      denotation: {
        conceptId: concept.conceptId,
        commitmentHash: concept.commitmentHash,
        matchMode: "exact",
      },
      realizationForms: ["whole"],
      affordances: [],
      states: [],
      surfaceTreatmentIds: [],
      dependencyClosureHash: closure.hash,
    },
    acceptedEntryKinds: ["substitution_set"],
    styleProfileHandles: ["neutral"],
    placement: { requiredSupport: "ground", requiredInterfaceIds: [] },
    metricBounds: { maximumSizeMeters: vector(2, 3, 2) },
    rights: { commercialUseRequired: true, redistributionRequired: true },
    budget: {
      maximumTriangles: 1000,
      maximumSourceBytes: 4096,
      maximumInstances: 100,
    },
    required: true,
  };
  return { asset, snapshot, requirement, assertions, declaration, styleProfile };
}

function q(value: number): string {
  return quantizeQ32_32(value);
}

function vector(x: number, y: number, z: number) {
  return { x: q(x), y: q(y), z: q(z) };
}

function transform() {
  return {
    position: vector(0, 0, 0),
    rotationQuaternion: [q(0), q(0), q(0), q(1)] as [string, string, string, string],
    uniformScale: q(1),
  };
}

export const fixtureEvidenceHash = evidenceHash;
export const fixtureHash = (value: unknown): string => contentHash(stableJson(value));
