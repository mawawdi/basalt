import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ImmutableBinaryArtifactStore,
  ImmutableJsonArtifactStore,
  type ArtifactReference,
  type BinaryArtifactReference,
} from "../../artifact-store/src/index.js";
import {
  inspectGlb,
  inspectGlbAssetContactPatches,
  inspectGlbCollisionSupportPatches,
  inspectTextureImage,
  selectBoundedPhysicalProxyPatches,
  splitGlbMeshParts,
  type GlbInspectionReport,
} from "../../asset-inspection/src/index.js";
import {
  ADAPTED_ASSET_CANDIDATE_SCHEMA,
  ASSET_REQUIREMENT_INTENT_SCHEMA,
  MAXIMUM_ASSET_CONTACT_PATCHES_PER_PART,
  MAXIMUM_COLLISION_SUPPORT_PATCHES_PER_PART,
  assertAdaptedAssetCandidateIdentity,
  assertAssetRequirementIntentIdentity,
  deriveMeasuredAssetSurfaceKinds,
  type AdaptedAssetCandidate,
  type AssetRequirementIntent,
  type AssetSourceCandidate,
} from "../../asset-factory/src/contracts.js";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import { compareSpatialStrings, hashSchema } from "../../spatial-core/src/primitives.js";
import {
  ASSET_FINISHER_PROFILE,
  ASSET_TEXTURE_CHANNELS,
  BINARY_ARTIFACT_SCHEMA,
  JSON_ARTIFACT_SCHEMA,
  PREPARED_ASSET_ABI,
  PREPARED_ASSET_PREVIEW_VIEWS,
  PREPARED_ASSET_SCHEMA,
  PREPARED_ASSET_TARGET_PROFILE,
  assertPreparedAssetSatisfiesOutputRequirements,
  sealPreparedAssetOutputAdmission,
  type AssetBounds,
  type AssetTransform,
  type AssetVector,
  type PreparedAsset,
  type PreparedAssetMesh,
  type PreparedAssetPart,
} from "./contracts.js";

const GEOMETRY_REPORT_ABI = "basalt-prepared-asset-geometry-report@3" as const;
const MATERIAL_REPORT_ABI = "basalt-prepared-asset-material-report@3" as const;
const PREVIEW_REPORT_ABI = "basalt-prepared-asset-preview-report@3" as const;
const FINISHING_REPORT_ABI = "basalt-prepared-asset-finishing-report@3" as const;
const LINEAGE_REPORT_ABI = "basalt-prepared-asset-lineage-report@3" as const;
const SIZE_MINIMUM_RATIO = 0.67;
const SIZE_TOLERANCE_STUDS = 1e-6;
const MAXIMUM_PREVIEW_PIXELS = 4096 * 4096;

export type RequiredTextureChannel = (typeof ASSET_TEXTURE_CHANNELS)[number];
export type PreparedAssetPreviewView = (typeof PREPARED_ASSET_PREVIEW_VIEWS)[number];

export interface PrepareAdaptedAssetInput {
  readonly store: ImmutableBinaryArtifactStore;
  readonly candidate: unknown;
  readonly intent: unknown;
  readonly previews: readonly {
    readonly view: PreparedAssetPreviewView;
    readonly artifact: BinaryArtifactReference;
  }[];
  readonly requiredTextureChannels: readonly RequiredTextureChannel[];
  readonly finisherWorkerHash: string;
  readonly finisherQualificationHash: string;
}

export interface PrepareAdaptedAssetResult {
  readonly manifest: PreparedAsset;
  readonly artifact: ArtifactReference;
}

const requiredTextureChannelsSchema = z
  .array(z.enum(ASSET_TEXTURE_CHANNELS))
  .min(1)
  .max(ASSET_TEXTURE_CHANNELS.length)
  .superRefine((value, context) => {
    if (!value.includes("base_color"))
      context.addIssue({
        code: "custom",
        message: "Required texture channels must include base_color",
      });
    if (stableJson(value) !== stableJson(canonicalTextureChannels(value)))
      context.addIssue({
        code: "custom",
        message: "Required texture channels must be unique and canonical",
      });
  });

const previewInputSchema = z
  .array(
    z
      .object({
        view: z.enum(PREPARED_ASSET_PREVIEW_VIEWS),
        artifact: BINARY_ARTIFACT_SCHEMA.extend({ mediaType: z.literal("image/png") }).strict(),
      })
      .strict(),
  )
  .length(PREPARED_ASSET_PREVIEW_VIEWS.length);

const artifactAuditSchema = z
  .object({
    purpose: z.string().min(1).max(512),
    locator: z.string().min(1).max(512),
    artifactHash: hashSchema,
    bytes: z.number().int().positive(),
    mediaType: z.string().min(3).max(160).optional(),
  })
  .strict();

export const PREPARED_ASSET_LINEAGE_REPORT_SCHEMA = z
  .object({
    kind: z.literal("PreparedAssetLineageReport"),
    abi: z.literal(LINEAGE_REPORT_ABI),
    candidate: ADAPTED_ASSET_CANDIDATE_SCHEMA,
    intent: ASSET_REQUIREMENT_INTENT_SCHEMA,
    origin: ADAPTED_ASSET_CANDIDATE_SCHEMA.shape.sourceCandidate.shape.lineage,
    artifactAudit: z.array(artifactAuditSchema).max(16_384),
    inputPreparedAssetHashes: z.array(hashSchema).max(512),
  })
  .strict();

export const PREPARED_ASSET_MATERIAL_REPORT_SCHEMA = z
  .object({
    kind: z.literal("PreparedAssetMaterialReport"),
    abi: z.literal(MATERIAL_REPORT_ABI),
    sourceCandidateHash: hashSchema,
    adaptedCandidateHash: hashSchema,
    intentHash: hashSchema,
    finishStyle: z.string().min(1).max(64),
    requiredTextureChannels: requiredTextureChannelsSchema,
    surfaceIntent: ASSET_REQUIREMENT_INTENT_SCHEMA.shape.declaration.shape.surfaceIntent,
    meshes: z.array(z.unknown()).max(512),
    renderParts: z.array(z.unknown()).max(512),
  })
  .strict();

interface ArtifactAudit {
  purpose: string;
  locator: string;
  artifactHash: string;
  bytes: number;
  mediaType?: string;
}

interface DependencyBinding {
  binding: AssetRequirementIntent["dependencies"][number];
  asset: PreparedAsset;
}

interface CandidateArtifactEvidence {
  audit: ArtifactAudit[];
  dependencies: DependencyBinding[];
  inputPreparedAssetHashes: string[];
}

interface PreparedMeshEvidence {
  mesh: PreparedAssetMesh;
  sourceArtifactAudit: ArtifactAudit;
  primitiveCount: number;
  materialSlots: Array<{
    name: string;
    appearanceHash: string;
    textureChannels: RequiredTextureChannel[];
    alphaMode: "OPAQUE" | "MASK" | "BLEND";
    alphaCutoff: number | null;
    opacityAuthority: "none" | "base_color_factor" | "base_color_texture_alpha";
    requiredChannelCoverage: RequiredTextureChannel[];
  }>;
  retainedTextureChannels: RequiredTextureChannel[];
  collisionSupportPatches: ReturnType<typeof inspectGlbCollisionSupportPatches>;
  assetContactPatches: ReturnType<typeof inspectGlbAssetContactPatches>;
  rendered: boolean;
}

/**
 * Turn one sealed producer candidate into a content-addressed, reload-verifiable
 * PreparedAsset. The finisher never repairs, rescales, invents a material, or
 * silently weakens host policy: a candidate either proves the exact contract or
 * is rejected.
 */
export async function prepareAdaptedAsset(
  input: PrepareAdaptedAssetInput,
): Promise<PrepareAdaptedAssetResult> {
  const candidate = ADAPTED_ASSET_CANDIDATE_SCHEMA.parse(input.candidate);
  const intent = ASSET_REQUIREMENT_INTENT_SCHEMA.parse(input.intent);
  assertAdaptedAssetCandidateIdentity(candidate);
  assertAssetRequirementIntentIdentity(intent);
  if (candidate.requirementHash !== intent.hash)
    throw new Error("Adapted asset candidate requirementHash differs from the sealed intent");

  const requiredTextureChannels = requiredTextureChannelsSchema.parse(
    input.requiredTextureChannels,
  );
  const finisherWorkerHash = hashSchema.parse(input.finisherWorkerHash);
  const finisherQualificationHash = hashSchema.parse(input.finisherQualificationHash);
  const previews = previewInputSchema.parse(input.previews);
  assertExactPreviewInventory(previews);

  const jsonStore = new ImmutableJsonArtifactStore(input.store.root);
  const sourceEvidence = await readCandidateEvidence(input.store, jsonStore, candidate, intent);
  const renderMeshIds = new Set(
    candidate.parts
      .filter((part) => part.role === "render_static" || part.role === "render_interactive")
      .map((part) => part.meshId),
  );
  if (renderMeshIds.size === 0) throw new Error("Prepared asset requires rendered geometry");

  const referencedMeshIds = new Set(candidate.parts.map((part) => part.meshId));
  for (const mesh of candidate.meshes)
    if (!referencedMeshIds.has(mesh.id))
      throw new Error(`Adapted asset candidate contains an unreferenced mesh: ${mesh.id}`);

  const meshEvidence = await Promise.all(
    candidate.meshes.map((mesh) =>
      prepareCandidateMesh(
        input.store,
        mesh,
        renderMeshIds.has(mesh.id),
        requiredTextureChannels,
        intent.declaration.surfacePlacement,
      ),
    ),
  );
  if (new Set(meshEvidence.map(({ mesh }) => mesh.nodeName)).size !== meshEvidence.length)
    throw new Error("Prepared mesh node names must be unique");

  const meshById = new Map(meshEvidence.map((entry) => [entry.mesh.id, entry] as const));
  const surfaceRoles = new Map(
    intent.declaration.surfaceIntent.materialRoles.map((role) => [role.id, role] as const),
  );
  const sourcePartsById = new Map(
    candidate.sourceCandidate.partDeclarations.map((part) => [part.id, part] as const),
  );
  const parts: PreparedAssetPart[] = candidate.parts.map((part) => {
    if (!surfaceRoles.has(part.materialRoleId))
      throw new Error(
        `Adapted asset part references an undeclared material role: ${part.id}/${part.materialRoleId}`,
      );
    if (
      part.role !== "collision_proxy" &&
      part.visualGeometry === "primitive" &&
      intent.declaration.geometryLanguage !== "explicit_primitive_aesthetic"
    )
      throw new Error(
        `Visible primitive geometry is prohibited without an explicit primitive aesthetic: ${part.id}`,
      );
    const contactMesh = meshById.get(
      part.collision.kind === "none" ? part.meshId : part.collision.meshId,
    );
    if (!contactMesh) throw new Error(`Adapted contact mesh is absent: ${part.id}`);
    if (part.collision.kind !== "none") {
      if (
        !samePhysicalProxyPatches(
          part.collision.supportPatches,
          contactMesh.collisionSupportPatches,
        )
      )
        throw new Error(
          `Adapted collision support patches differ from final mesh topology: ${part.id}`,
        );
    }
    const sourcePart = sourcePartsById.get(part.id);
    if (!sourcePart) throw new Error(`Adapted part lacks its source declaration: ${part.id}`);
    const surfacePlacement = intent.declaration.surfacePlacement;
    if (surfacePlacement.kind === "none") {
      if (part.support.kind !== "none" || part.surfaceKinds.length !== 0)
        throw new Error(`Adapted asset invents undeclared surface compatibility: ${part.id}`);
    } else if (contactMesh.assetContactPatches.length === 0) {
      if (part.support.kind !== "none" || part.surfaceKinds.length !== 0)
        throw new Error(`Adapted asset invents unmeasured surface compatibility: ${part.id}`);
    } else if (
      part.support.kind !== "surface_contact" ||
      part.support.mode !== surfacePlacement.mode ||
      !samePhysicalProxyPatches(part.support.contactPatches, contactMesh.assetContactPatches) ||
      stableJson(part.surfaceKinds) !== stableJson(deriveMeasuredAssetSurfaceKinds(part.support))
    )
      throw new Error(`Adapted surface compatibility lacks measured contact topology: ${part.id}`);
    return {
      id: part.id,
      name: part.name,
      semanticRole: part.semanticRole,
      role: part.role,
      visualGeometry: part.visualGeometry,
      meshId: part.meshId,
      placements: part.placements,
      pivot: part.pivot,
      sockets: part.sockets,
      support: part.support,
      collision: part.collision,
      surfaceKinds: part.surfaceKinds,
    };
  });

  assertRequiredAssetSurfaceCompatibility(intent, parts);

  const preparedMeshes = meshEvidence.map(({ mesh }) => mesh);
  const outputAdmission = sealPreparedAssetOutputAdmission(intent.declaration.outputRequirements);
  assertPreparedAssetSatisfiesOutputRequirements({
    requirements: outputAdmission.requirements,
    parts,
    meshes: preparedMeshes,
  });

  const aggregateBounds = aggregatePlacedBounds(parts, meshById);
  assertCanonicalSupportRoot(parts, meshById, aggregateBounds);
  const worldSize = multiplyVector(aggregateBounds.size, candidate.studsPerUnit);
  const sizeAdmission = admitExpectedSize(worldSize, intent.declaration.delivery.expectedBounds);
  const uniqueTriangles = meshEvidence.reduce((total, entry) => total + entry.mesh.triangles, 0);
  const renderedTriangles = parts.reduce((total, part) => {
    if (part.role === "collision_proxy") return total;
    return total + meshById.get(part.meshId)!.mesh.triangles * part.placements.length;
  }, 0);
  const instanceCount = parts.reduce((total, part) => total + part.placements.length, 0);
  const distinctMaterialHashes = new Set(
    meshEvidence.flatMap((entry) =>
      entry.mesh.materials.map((material) => material.appearanceHash),
    ),
  );
  const maximumTextureEdge = Math.max(
    0,
    ...meshEvidence.flatMap((entry) =>
      entry.mesh.textures.map((texture) => Math.max(texture.width, texture.height)),
    ),
  );
  enforceDeliveryBudgets({
    intent,
    uniqueTriangles,
    renderedTriangles,
    instanceCount,
    parts: parts.length,
    materials: distinctMaterialHashes.size,
    maximumTextureEdge,
  });

  const preparedPreviews = await inspectPreviews(input.store, previews);
  const rights = preparedRights(candidate.sourceCandidate);
  const artifactAudit = [
    ...sourceEvidence.audit,
    ...meshEvidence.map((entry) => entry.sourceArtifactAudit),
  ].sort(compareArtifactAudit);

  const geometryReport = {
    kind: "PreparedAssetGeometryReport" as const,
    abi: GEOMETRY_REPORT_ABI,
    sourceCandidateHash: candidate.sourceCandidate.hash,
    adaptedCandidateHash: candidate.hash,
    intentHash: intent.hash,
    coordinateFrame: candidate.coordinateFrame,
    canonicalAxes: candidate.canonicalAxes,
    transformOwnership: candidate.transformOwnership,
    canonicalRoot: candidate.canonicalRoot,
    studsPerUnit: candidate.studsPerUnit,
    aggregateBounds,
    sizeAdmission,
    counts: {
      uniqueTriangles,
      renderedTriangles,
      instanceCount,
      parts: parts.length,
      meshes: meshEvidence.length,
      distinctMaterials: distinctMaterialHashes.size,
      maximumTextureEdge,
    },
    deliveryLimits: intent.declaration.delivery,
    outputAdmission,
    meshes: preparedMeshes,
    parts,
  };
  const materialReport = PREPARED_ASSET_MATERIAL_REPORT_SCHEMA.parse({
    kind: "PreparedAssetMaterialReport",
    abi: MATERIAL_REPORT_ABI,
    sourceCandidateHash: candidate.sourceCandidate.hash,
    adaptedCandidateHash: candidate.hash,
    intentHash: intent.hash,
    finishStyle: intent.declaration.surfaceIntent.finishStyle,
    requiredTextureChannels,
    surfaceIntent: intent.declaration.surfaceIntent,
    meshes: meshEvidence.map((entry) => ({
      meshId: entry.mesh.id,
      nodeName: entry.mesh.nodeName,
      rendered: entry.rendered,
      primitiveCount: entry.primitiveCount,
      hasNormals: entry.mesh.hasNormals,
      hasUv0: entry.mesh.hasUv0,
      retainedTextureChannels: entry.retainedTextureChannels,
      materials: entry.materialSlots,
      textures: entry.mesh.textures,
    })),
    renderParts: candidate.parts
      .filter((part) => part.role !== "collision_proxy")
      .map((part) => ({
        partId: part.id,
        semanticRole: part.semanticRole,
        meshId: part.meshId,
        materialRoleId: part.materialRoleId,
        assignedMaterialRole: surfaceRoles.get(part.materialRoleId)!,
        requiredTextureChannels,
        materialCoverage: meshById.get(part.meshId)!.materialSlots.map((material) => ({
          name: material.name,
          appearanceHash: material.appearanceHash,
          coveredChannels: material.requiredChannelCoverage,
        })),
      })),
  });
  const previewReport = {
    kind: "PreparedAssetPreviewReport" as const,
    abi: PREVIEW_REPORT_ABI,
    sourceCandidateHash: candidate.sourceCandidate.hash,
    adaptedCandidateHash: candidate.hash,
    intentHash: intent.hash,
    views: preparedPreviews.report,
  };
  const lineageReport = PREPARED_ASSET_LINEAGE_REPORT_SCHEMA.parse({
    kind: "PreparedAssetLineageReport",
    abi: LINEAGE_REPORT_ABI,
    candidate,
    intent,
    origin: candidate.sourceCandidate.lineage,
    artifactAudit,
    inputPreparedAssetHashes: sourceEvidence.inputPreparedAssetHashes,
  });

  const [geometryReportArtifact, materialReportArtifact, previewReportArtifact, lineageArtifact] =
    await Promise.all([
      jsonStore.write(geometryReport),
      jsonStore.write(materialReport),
      jsonStore.write(previewReport),
      jsonStore.write(lineageReport),
    ]);
  const finishingReport = {
    kind: "PreparedAssetFinishingReport" as const,
    abi: FINISHING_REPORT_ABI,
    sourceCandidateHash: candidate.sourceCandidate.hash,
    adaptedCandidateHash: candidate.hash,
    intentHash: intent.hash,
    intentResolutionHash: intent.resolutionHash,
    targetProfile: PREPARED_ASSET_TARGET_PROFILE,
    profile: ASSET_FINISHER_PROFILE,
    finisherWorkerHash,
    finisherQualificationHash,
    requiredTextureChannels,
    sizeAdmission,
    outputAdmission,
    output: {
      id: candidate.id,
      bounds: aggregateBounds,
      uniqueTriangles,
      renderedTriangles,
      instanceCount,
      meshIds: meshEvidence.map((entry) => entry.mesh.id),
      partIds: parts.map((part) => part.id),
      previewViews: preparedPreviews.previews.map((preview) => preview.view),
    },
    reports: {
      geometryReportArtifact,
      materialReportArtifact,
      previewReportArtifact,
      lineageArtifact,
    },
  };
  const finishingReportArtifact = await jsonStore.write(finishingReport);

  const manifestMaterial = {
    kind: "PreparedAsset" as const,
    abi: PREPARED_ASSET_ABI,
    id: candidate.id,
    requirementHash: intent.hash,
    targetProfile: PREPARED_ASSET_TARGET_PROFILE,
    coordinateFrame: candidate.coordinateFrame,
    canonicalAxes: candidate.canonicalAxes,
    transformOwnership: candidate.transformOwnership,
    canonicalRoot: candidate.canonicalRoot,
    studsPerUnit: candidate.studsPerUnit,
    bounds: aggregateBounds,
    physicalScale: {
      class: intent.declaration.delivery.scaleClass,
      expectedBounds: intent.declaration.delivery.expectedBounds,
    },
    outputAdmission,
    geometry: {
      uniqueTriangles,
      renderedTriangles,
      instanceCount,
      meshes: preparedMeshes,
      parts,
    },
    previews: preparedPreviews.previews,
    rights,
    lineage: {
      origin: candidate.sourceCandidate.lineage.kind,
      sourceCandidateHash: candidate.sourceCandidate.hash,
      adaptedCandidateHash: candidate.hash,
      lineageArtifact,
      inputPreparedAssetHashes: sourceEvidence.inputPreparedAssetHashes,
    },
    preparation: {
      profile: ASSET_FINISHER_PROFILE,
      finisherWorkerHash,
      finisherQualificationHash,
      adapterId: candidate.adaptation.adapterId,
      adapterRevisionHash: candidate.adaptation.adapterRevisionHash,
      adapterQualificationHash: candidate.adaptation.adapterQualificationHash,
      postprocessorIdentityHash: candidate.adaptation.postprocessorIdentityHash,
      adaptationReportArtifact: candidate.adaptation.reportArtifact,
      geometryReportArtifact,
      materialReportArtifact,
      previewReportArtifact,
      finishingReportArtifact,
    },
    localStatus: "eligible" as const,
    nativeStatus: "incomplete" as const,
  };
  const manifest = PREPARED_ASSET_SCHEMA.parse({
    ...manifestMaterial,
    hash: contentHash(stableJson(manifestMaterial)),
  });
  const artifact = await jsonStore.write(manifest);

  const retainedReports = await Promise.all([
    jsonStore.read(geometryReportArtifact),
    jsonStore.read(materialReportArtifact),
    jsonStore.read(previewReportArtifact),
    jsonStore.read(lineageArtifact),
    jsonStore.read(finishingReportArtifact),
    jsonStore.read(artifact),
  ]);
  const expectedReports = [
    geometryReport,
    materialReport,
    previewReport,
    lineageReport,
    finishingReport,
    manifest,
  ];
  for (let index = 0; index < retainedReports.length; index += 1)
    if (stableJson(retainedReports[index]) !== stableJson(expectedReports[index]))
      throw new Error("Prepared asset output artifact differs from its canonical report");
  return { manifest, artifact };
}

function samePhysicalProxyPatches(
  measured: readonly unknown[],
  retained: readonly unknown[],
): boolean {
  if (measured.length !== retained.length) return false;
  const normalize = (value: unknown): unknown => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const record = value as Record<string, unknown>;
    if (!Array.isArray(record.polygon) || record.polygon.length !== 3) return value;
    const polygon = record.polygon;
    const rotations = [
      polygon,
      [...polygon.slice(1), polygon[0]],
      [...polygon.slice(2), ...polygon.slice(0, 2)],
    ];
    return {
      ...record,
      polygon: rotations.sort((left, right) =>
        compareSpatialStrings(stableJson(left), stableJson(right)),
      )[0],
    };
  };
  const numbers = (value: unknown): number[] => {
    if (typeof value === "number") return [value];
    if (Array.isArray(value)) return value.flatMap(numbers);
    if (value && typeof value === "object")
      return Object.keys(value)
        .sort(compareSpatialStrings)
        .flatMap((key) => numbers((value as Record<string, unknown>)[key]));
    return [];
  };
  const remaining = retained.map(normalize);
  for (const patch of measured.map(normalize)) {
    const expected = numbers(patch);
    const index = remaining.findIndex((candidate) => {
      const actual = numbers(candidate);
      return (
        expected.length === actual.length &&
        expected.every(
          (value, offset) =>
            Math.abs(value - actual[offset]!) <=
            1e-5 * Math.max(1, Math.abs(value), Math.abs(actual[offset]!)),
        )
      );
    });
    if (index < 0) return false;
    remaining.splice(index, 1);
  }
  return remaining.length === 0;
}

async function readCandidateEvidence(
  binaryStore: ImmutableBinaryArtifactStore,
  jsonStore: ImmutableJsonArtifactStore,
  candidate: AdaptedAssetCandidate,
  intent: AssetRequirementIntent,
): Promise<CandidateArtifactEvidence> {
  const sourceCandidate = candidate.sourceCandidate;
  const audit: ArtifactAudit[] = [];
  const [producer, adaptation] = await Promise.all([
    readJsonArtifact(
      jsonStore,
      sourceCandidate.producerReportArtifact,
      "sourceCandidate.producerReport",
    ),
    readJsonArtifact(
      jsonStore,
      candidate.adaptation.reportArtifact,
      "adaptedCandidate.adaptationReport",
    ),
  ]);
  audit.push(producer.audit, adaptation.audit);
  const sourceArtifacts = await Promise.all(
    sourceCandidate.sources.map((source) =>
      readBinaryArtifact(binaryStore, source.artifact, `sourceCandidate.geometry.${source.id}`),
    ),
  );
  audit.push(...sourceArtifacts.map((entry) => entry.audit));

  const dependencies = await Promise.all(
    intent.dependencies.map(async (binding) => {
      const retained = await readJsonArtifact(
        jsonStore,
        binding.manifestArtifact,
        `intent.dependency.${binding.id}.manifest`,
      );
      const asset = PREPARED_ASSET_SCHEMA.parse(retained.value);
      assertPreparedAssetIdentity(asset);
      if (asset.id !== binding.assetId || asset.hash !== binding.preparedAssetHash)
        throw new Error(`Prepared dependency binding differs from its manifest: ${binding.id}`);
      return { binding, asset, audit: retained.audit };
    }),
  );
  audit.push(...dependencies.map((entry) => entry.audit));

  const references = await Promise.all(
    intent.references.map(({ id, artifact }) =>
      readBinaryArtifact(binaryStore, artifact, `intent.reference.${id}`),
    ),
  );
  audit.push(...references.map((entry) => entry.audit));
  const referenceRights = await Promise.all(
    intent.references.map(({ id, rights }) =>
      readBinaryArtifact(binaryStore, rights.evidenceArtifact, `intent.reference.${id}.rights`),
    ),
  );
  for (const [index, retained] of referenceRights.entries()) {
    assertTextEvidence(retained.bytes, `reference rights ${intent.references[index]!.id}`);
    audit.push(retained.audit);
  }

  const rightsEvidence = await Promise.all(
    sourceCandidate.rights.map(async (claim) => {
      if (claim.usage === "research_only")
        throw new Error(`Research-only rights cannot enter a prepared asset: ${claim.id}`);
      if (claim.evidenceArtifact.mediaType !== "text/plain")
        throw new Error(`Rights evidence must be text/plain: ${claim.id}`);
      const retained = await readBinaryArtifact(
        binaryStore,
        claim.evidenceArtifact,
        `candidate.rights.${claim.id}.evidence`,
      );
      assertTextEvidence(retained.bytes, claim.id);
      return retained;
    }),
  );
  audit.push(...rightsEvidence.map((entry) => entry.audit));
  const rightsHashes = new Set(
    sourceCandidate.rights.map((claim) => claim.evidenceArtifact.artifactHash),
  );

  switch (sourceCandidate.lineage.kind) {
    case "retrieval": {
      const sourceArtifactHash = sourceCandidate.lineage.sourceArtifactHash;
      const [metadata, license] = await Promise.all([
        readJsonArtifact(
          jsonStore,
          sourceCandidate.lineage.metadataArtifact,
          "lineage.retrieval.metadata",
        ),
        readBinaryArtifact(
          binaryStore,
          sourceCandidate.lineage.licenseSnapshotArtifact,
          "lineage.retrieval.licenseSnapshot",
        ),
      ]);
      audit.push(metadata.audit, license.audit);
      assertTextEvidence(license.bytes, "retrieval license snapshot");
      if (!rightsHashes.has(sourceCandidate.lineage.licenseSnapshotArtifact.artifactHash))
        throw new Error("Retrieved license snapshot is not retained as rights evidence");
      if (
        !sourceCandidate.sources.some(
          (source) => source.artifact.artifactHash === sourceArtifactHash,
        )
      )
        throw new Error("Retrieved source hash does not identify a candidate mesh artifact");
      break;
    }
    case "neural_asset": {
      const [request, response, terms] = await Promise.all([
        readJsonArtifact(
          jsonStore,
          sourceCandidate.lineage.requestArtifact,
          "lineage.neuralAsset.request",
        ),
        readJsonArtifact(
          jsonStore,
          sourceCandidate.lineage.responseReceiptArtifact,
          "lineage.neuralAsset.responseReceipt",
        ),
        readBinaryArtifact(
          binaryStore,
          sourceCandidate.lineage.termsSnapshotArtifact,
          "lineage.neuralAsset.termsSnapshot",
        ),
      ]);
      audit.push(request.audit, response.audit, terms.audit);
      assertTextEvidence(terms.bytes, "neural terms snapshot");
      if (!rightsHashes.has(sourceCandidate.lineage.termsSnapshotArtifact.artifactHash))
        throw new Error("Neural terms snapshot is not retained as rights evidence");
      const referenceHashes = intent.references.map((entry) => entry.artifact.artifactHash).sort();
      if (
        stableJson(referenceHashes) !== stableJson(sourceCandidate.lineage.referenceArtifactHashes)
      )
        throw new Error("Neural reference hashes differ from the sealed intent references");
      break;
    }
    case "trusted_procedure": {
      const candidateSourceHashes = new Set(
        sourceCandidate.sources.map((source) => source.artifact.artifactHash),
      );
      for (const hash of sourceCandidate.lineage.sourceArtifactHashes)
        if (!candidateSourceHashes.has(hash))
          throw new Error(
            "Trusted procedure source hash is not a retained candidate mesh artifact",
          );
      break;
    }
  }

  const dependencyHashes = intent.dependencies.map((entry) => entry.preparedAssetHash).sort();
  const lineageInputHashes =
    sourceCandidate.lineage.kind === "trusted_procedure"
      ? sourceCandidate.lineage.inputPreparedAssetHashes
      : [];
  for (const hash of lineageInputHashes)
    if (!dependencyHashes.includes(hash))
      throw new Error("Candidate lineage names an input outside the sealed intent dependencies");
  for (const mesh of sourceCandidate.sources)
    if (
      mesh.kind === "prepared_mesh" &&
      !intent.dependencies.some((entry) => entry.preparedAssetHash === mesh.sourcePreparedAssetHash)
    )
      throw new Error(`Prepared mesh source is absent from intent dependencies: ${mesh.id}`);

  return {
    audit,
    dependencies: dependencies.map(({ binding, asset }) => ({ binding, asset })),
    inputPreparedAssetHashes: [...new Set([...dependencyHashes, ...lineageInputHashes])].sort(
      compareSpatialStrings,
    ),
  };
}

async function prepareCandidateMesh(
  store: ImmutableBinaryArtifactStore,
  candidateMesh: AdaptedAssetCandidate["meshes"][number],
  rendered: boolean,
  requiredTextureChannels: readonly RequiredTextureChannel[],
  surfacePlacement: AssetRequirementIntent["declaration"]["surfacePlacement"],
): Promise<PreparedMeshEvidence> {
  const source = await readBinaryArtifact(
    store,
    candidateMesh.artifact,
    `candidate.mesh.${candidateMesh.id}.source`,
  );
  const nodeName = candidateMesh.nodeName;

  const split = splitGlbMeshParts(source.bytes);
  const selected = split.filter((part) => part.node.name === nodeName);
  if (selected.length !== 1)
    throw new Error(
      `Candidate mesh must select exactly one GLB node: ${candidateMesh.id}/${nodeName}`,
    );
  const selectedPart = selected[0]!;
  assertIdentityNodeTransform(selectedPart.bytes, nodeName);
  const inspection = inspectGlb(selectedPart.bytes, {
    maximumBytes: Math.min(20 * 1024 * 1024, selectedPart.bytes.byteLength),
    maximumTriangles: 20_000,
    maximumTrianglesPerMesh: 20_000,
    maximumMaterials: 256,
    maximumTextures: 256,
    maximumTexturePixels: 4096 * 4096,
    expectedNodeNames: [nodeName],
  });
  const meshNode = inspection.nodes.filter((node) => node.meshIndex !== undefined);
  if (meshNode.length !== 1 || !meshNode[0]!.bounds)
    throw new Error(`Selected GLB node has no exact measured geometry: ${candidateMesh.id}`);
  const primitives = inspectPrimitiveBindings(selectedPart.bytes, nodeName);
  if (primitives.some((primitive) => primitive.materialIndex === undefined))
    throw new Error(`Asset mesh contains a primitive without material: ${candidateMesh.id}`);
  const hasNormals = primitives.every((primitive) => primitive.attributes.includes("NORMAL"));
  const hasUv0 = primitives.every((primitive) => primitive.attributes.includes("TEXCOORD_0"));
  const retainedTextureChannels = canonicalTextureChannels(
    inspection.materials.flatMap((material) => material.textureChannels),
  );
  if (rendered && !hasNormals)
    throw new Error(`Rendered asset mesh lacks NORMAL on every primitive: ${candidateMesh.id}`);
  if ((rendered || retainedTextureChannels.length > 0) && !hasUv0)
    throw new Error(`Textured asset mesh lacks TEXCOORD_0 on every primitive: ${candidateMesh.id}`);
  if (inspection.materials.length === 0)
    throw new Error(`Asset mesh has no retained materials: ${candidateMesh.id}`);

  const materialSlots = inspection.materials.map((material) => {
    const channels = material.textureChannels as RequiredTextureChannel[];
    const coverage = requiredTextureChannels.filter((channel) => channels.includes(channel));
    if (rendered && coverage.length !== requiredTextureChannels.length)
      throw new Error(
        `Rendered material lacks required texture channels: ${candidateMesh.id}/${material.name}`,
      );
    return {
      name: material.name,
      appearanceHash: material.appearanceHash,
      textureChannels: channels,
      alphaMode: material.properties.alphaMode,
      alphaCutoff: material.properties.alphaCutoff,
      opacityAuthority: material.properties.opacityAuthority,
      requiredChannelCoverage: coverage,
    };
  });
  const artifact = await store.write(selectedPart.bytes, "model/gltf-binary");
  const bounds = reportBounds(meshNode[0]!.bounds!);
  const mesh: PreparedAssetMesh = {
    id: candidateMesh.id,
    nodeName,
    nodeTransform: "identity",
    artifact: { ...artifact, mediaType: "model/gltf-binary" },
    bounds,
    triangles: inspection.triangleCount,
    hasNormals,
    hasUv0,
    materials: inspection.materials.map((material) => ({
      name: material.name,
      appearanceHash: material.appearanceHash,
      textureChannels: material.textureChannels,
      alphaMode: material.properties.alphaMode,
      alphaCutoff: material.properties.alphaCutoff,
      opacityAuthority: material.properties.opacityAuthority,
    })),
    textures: inspection.images.map(({ index: _index, mimeType, ...image }) => ({
      sha256: image.sha256,
      mediaType: mimeType,
      width: image.width,
      height: image.height,
      alphaChannel: image.alphaChannel,
    })),
  };
  return {
    mesh,
    sourceArtifactAudit: source.audit,
    primitiveCount: primitives.length,
    materialSlots,
    retainedTextureChannels,
    collisionSupportPatches: selectBoundedPhysicalProxyPatches(
      inspectGlbCollisionSupportPatches(selectedPart.bytes, nodeName),
      MAXIMUM_COLLISION_SUPPORT_PATCHES_PER_PART,
    ),
    assetContactPatches:
      surfacePlacement.kind === "none"
        ? []
        : selectBoundedPhysicalProxyPatches(
            inspectGlbAssetContactPatches(
              selectedPart.bytes,
              nodeName,
              surfacePlacement.outwardNormal,
            ),
            MAXIMUM_ASSET_CONTACT_PATCHES_PER_PART,
          ),
    rendered,
  };
}

function assertIdentityNodeTransform(bytes: Uint8Array, nodeName: string): void {
  const input = Buffer.from(bytes);
  const jsonLength = input.readUInt32LE(12);
  const document = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(input.subarray(20, 20 + jsonLength)).trim(),
  ) as {
    nodes?: Array<{
      name?: string;
      mesh?: number;
      matrix?: number[];
      translation?: number[];
      rotation?: number[];
      scale?: number[];
    }>;
  };
  const node = document.nodes?.find((entry) => entry.name === nodeName && entry.mesh !== undefined);
  if (!node) throw new Error(`GLB identity-node audit cannot find node: ${nodeName}`);
  const identityMatrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  if (
    (node.matrix !== undefined && stableJson(node.matrix) !== stableJson(identityMatrix)) ||
    (node.translation !== undefined && stableJson(node.translation) !== stableJson([0, 0, 0])) ||
    (node.rotation !== undefined && stableJson(node.rotation) !== stableJson([0, 0, 0, 1])) ||
    (node.scale !== undefined && stableJson(node.scale) !== stableJson([1, 1, 1]))
  )
    throw new Error(`Adapted GLB node transform is not identity: ${nodeName}`);
}

function inspectPrimitiveBindings(
  bytes: Uint8Array,
  nodeName: string,
): Array<{ attributes: string[]; materialIndex?: number }> {
  const input = Buffer.from(bytes);
  const jsonLength = input.readUInt32LE(12);
  const document = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(input.subarray(20, 20 + jsonLength)).trim(),
  ) as {
    nodes?: Array<{ name?: string; mesh?: number }>;
    meshes?: Array<{
      primitives?: Array<{ attributes?: Record<string, number>; material?: number }>;
    }>;
  };
  const node = document.nodes?.find((entry) => entry.name === nodeName && entry.mesh !== undefined);
  const mesh = node?.mesh === undefined ? undefined : document.meshes?.[node.mesh];
  if (!mesh?.primitives?.length)
    throw new Error(`GLB node has no primitive inventory: ${nodeName}`);
  return mesh.primitives.map((primitive) => ({
    attributes: Object.keys(primitive.attributes ?? {}).sort(),
    ...(primitive.material === undefined ? {} : { materialIndex: primitive.material }),
  }));
}

async function inspectPreviews(
  store: ImmutableBinaryArtifactStore,
  inputs: z.infer<typeof previewInputSchema>,
): Promise<{
  previews: PreparedAsset["previews"];
  report: Array<{
    view: PreparedAssetPreviewView;
    artifact: BinaryArtifactReference;
    width: number;
    height: number;
    sha256: string;
  }>;
}> {
  const ordered = PREPARED_ASSET_PREVIEW_VIEWS.map((view) =>
    inputs.find((item) => item.view === view)!,
  );
  const retained = await Promise.all(
    ordered.map(async ({ view, artifact }) => {
      const bytes = await store.read(artifact);
      const inspected = inspectTextureImage(bytes, "image/png", MAXIMUM_PREVIEW_PIXELS);
      if (inspected.sha256 !== artifact.artifactHash)
        throw new Error(`Preview inspection hash differs from retained bytes: ${view}`);
      return { view, artifact, ...inspected };
    }),
  );
  if (new Set(retained.map((entry) => entry.sha256)).size !== retained.length)
    throw new Error("Prepared preview views must retain three distinct PNG artifacts");
  return {
    previews: retained.map(({ view, artifact }) => ({
      id: previewId(view),
      view,
      artifact: { ...artifact, mediaType: "image/png" },
    })),
    report: retained,
  };
}

function assertExactPreviewInventory(inputs: z.infer<typeof previewInputSchema>): void {
  const actual = inputs.map(({ view }) => view).sort();
  const expected = [...PREPARED_ASSET_PREVIEW_VIEWS].sort();
  if (stableJson(actual) !== stableJson(expected))
    throw new Error("Finisher requires exactly one PNG for each of the three preview views");
}

function previewId(view: PreparedAssetPreviewView): string {
  switch (view) {
    case "hero_three_quarter":
      return "PreviewHeroThreeQuarter";
    case "opposite_three_quarter":
      return "PreviewOppositeThreeQuarter";
    case "top":
      return "PreviewTop";
  }
}

function preparedRights(candidate: AssetSourceCandidate): PreparedAsset["rights"] {
  const usage = candidate.rights.every((claim) => claim.usage === "creator_owned")
    ? "creator_owned"
    : "commercial_use_permitted";
  return {
    usage,
    claims: candidate.rights.map((claim) => {
      if (claim.usage === "research_only" || claim.evidenceArtifact.mediaType !== "text/plain")
        throw new Error(`Invalid prepared rights claim: ${claim.id}`);
      return {
        id: claim.id,
        sourceLabel: claim.sourceLabel,
        licenseId: claim.licenseId,
        usage: claim.usage,
        attribution: claim.attribution,
        evidenceArtifact: { ...claim.evidenceArtifact, mediaType: "text/plain" },
      };
    }),
  };
}

function assertRequiredAssetSurfaceCompatibility(
  intent: AssetRequirementIntent,
  parts: readonly PreparedAssetPart[],
): void {
  const requirement = intent.declaration.surfacePlacement;
  if (requirement.kind === "none") return;
  const contactParts = parts.filter(
    (part) =>
      part.role !== "collision_proxy" &&
      part.support.kind === "surface_contact" &&
      part.support.mode === requirement.mode &&
      part.surfaceKinds.length > 0,
  );
  if (contactParts.length === 0)
    throw new Error("Prepared asset has no measured required surface compatibility");
  const compatible = new Set(contactParts[0]!.surfaceKinds);
  for (const part of contactParts.slice(1))
    for (const kind of compatible) if (!part.surfaceKinds.includes(kind)) compatible.delete(kind);
  const unsupported = requirement.requiredSurfaceKinds.filter((kind) => !compatible.has(kind));
  if (unsupported.length > 0)
    throw new Error(
      `Prepared asset does not support required placement surfaces: ${unsupported.join(", ")}`,
    );
}

function enforceDeliveryBudgets(input: {
  intent: AssetRequirementIntent;
  uniqueTriangles: number;
  renderedTriangles: number;
  instanceCount: number;
  parts: number;
  materials: number;
  maximumTextureEdge: number;
}): void {
  const limits = input.intent.declaration.delivery;
  if (input.uniqueTriangles > limits.maximumUniqueTriangles)
    throw new Error("Prepared asset exceeds the unique triangle budget");
  if (input.renderedTriangles > limits.maximumRenderedTriangles)
    throw new Error("Prepared asset exceeds the rendered triangle budget");
  if (input.parts > limits.maximumParts) throw new Error("Prepared asset exceeds the part budget");
  if (input.materials > limits.maximumMaterials)
    throw new Error("Prepared asset exceeds the material budget");
  if (input.maximumTextureEdge > limits.maximumTextureEdge)
    throw new Error("Prepared asset exceeds the texture edge budget");
  if (input.instanceCount > 65_536)
    throw new Error("Prepared asset exceeds the prepared instance budget");
  if (input.renderedTriangles <= 0) throw new Error("Prepared asset has no rendered triangles");
}

function admitExpectedSize(worldSize: AssetVector, expectedBounds: AssetBounds) {
  const minimum = multiplyVector(expectedBounds.size, SIZE_MINIMUM_RATIO);
  const maximum = expectedBounds.size;
  for (const axis of ["x", "y", "z"] as const) {
    const measured = worldSize[axis];
    if (
      measured + SIZE_TOLERANCE_STUDS < minimum[axis] ||
      measured - SIZE_TOLERANCE_STUDS > maximum[axis]
    )
      throw new Error(
        `Prepared asset ${axis}-axis size is outside the 0.67x-1.0x expected envelope`,
      );
  }
  return {
    policy: {
      minimumRatio: SIZE_MINIMUM_RATIO,
      maximumRatio: 1,
      toleranceStuds: SIZE_TOLERANCE_STUDS,
      action: "reject_without_rescale" as const,
    },
    measuredWorldSizeStuds: worldSize,
    expectedBounds,
    admittedMinimumSizeStuds: minimum,
    admittedMaximumSizeStuds: maximum,
    ratios: {
      x: worldSize.x / expectedBounds.size.x,
      y: worldSize.y / expectedBounds.size.y,
      z: worldSize.z / expectedBounds.size.z,
    },
    status: "pass" as const,
  };
}

function aggregatePlacedBounds(
  parts: readonly PreparedAssetPart[],
  meshes: ReadonlyMap<string, PreparedMeshEvidence>,
): AssetBounds {
  let minimum: AssetVector | undefined;
  let maximum: AssetVector | undefined;
  for (const part of parts) {
    if (part.role === "collision_proxy") continue;
    const mesh = meshes.get(part.meshId)?.mesh;
    if (!mesh) throw new Error(`Prepared part references missing measured mesh: ${part.id}`);
    for (const placement of part.placements) {
      const bounds = transformedBounds(mesh.bounds, part.pivot, placement);
      const nextMinimum = subtractVector(bounds.center, multiplyVector(bounds.size, 0.5));
      const nextMaximum = addVector(bounds.center, multiplyVector(bounds.size, 0.5));
      minimum = minimum ? minimumVector(minimum, nextMinimum) : nextMinimum;
      maximum = maximum ? maximumVector(maximum, nextMaximum) : nextMaximum;
    }
  }
  if (!minimum || !maximum) throw new Error("Prepared asset has no placed geometry");
  return {
    center: multiplyVector(addVector(minimum, maximum), 0.5),
    size: subtractVector(maximum, minimum),
  };
}

const CANONICAL_SUPPORT_TOLERANCE = 1e-5;

function assertCanonicalSupportRoot(
  parts: readonly PreparedAssetPart[],
  meshes: ReadonlyMap<string, PreparedMeshEvidence>,
  aggregateBounds: AssetBounds,
): void {
  const groups = parts.flatMap((part) => {
    if (part.role === "collision_proxy") return [];
    if (
      part.support.kind !== "surface_contact" ||
      (part.support.mode !== "resting" && part.support.mode !== "embedded")
    )
      return [];
    return part.placements.map((placement) =>
      part.support.kind === "surface_contact"
        ? part.support.contactPatches.flatMap((patch) =>
            patch.polygon.map((point) => transformedPoint(point, part.pivot, placement)),
          )
        : [],
    );
  });
  let origin: AssetVector;
  if (groups.length > 0) {
    const minimumY = Math.min(...groups.flatMap((group) => group.map((point) => point.y)));
    const bottomGroups = groups.filter(
      (group) =>
        Math.min(...group.map((point) => point.y)) <= minimumY + CANONICAL_SUPPORT_TOLERANCE,
    );
    const points = bottomGroups.flat();
    origin = {
      x:
        (Math.min(...points.map((point) => point.x)) +
          Math.max(...points.map((point) => point.x))) /
        2,
      y: minimumY,
      z:
        (Math.min(...points.map((point) => point.z)) +
          Math.max(...points.map((point) => point.z))) /
        2,
    };
  } else {
    // Assets without a load-bearing declaration still receive a deterministic
    // bottom-center root. This keeps detached and suspended assets canonical
    // without inventing a support relation.
    origin = {
      x: aggregateBounds.center.x,
      y: aggregateBounds.center.y - aggregateBounds.size.y / 2,
      z: aggregateBounds.center.z,
    };
  }
  if (
    Math.abs(origin.x) > CANONICAL_SUPPORT_TOLERANCE ||
    Math.abs(origin.y) > CANONICAL_SUPPORT_TOLERANCE ||
    Math.abs(origin.z) > CANONICAL_SUPPORT_TOLERANCE
  )
    throw new Error(
      `Adapted asset root is not its canonical support origin: (${origin.x}, ${origin.y}, ${origin.z})`,
    );
  // Force every referenced mesh lookup while this remains an admission check,
  // so a future no-support path cannot accidentally validate detached metadata.
  for (const part of parts)
    if (!meshes.has(part.meshId))
      throw new Error(`Canonical support validation references a missing mesh: ${part.id}`);
}

function transformedPoint(
  point: AssetVector,
  pivot: AssetVector,
  transform: AssetTransform,
): AssetVector {
  const local = multiplyComponents(subtractVector(point, pivot), transform.scale);
  return cleanVector(
    addVector(transform.position, transformVector(eulerXyz(transform.rotation), local)),
  );
}

function transformedBounds(
  bounds: AssetBounds,
  pivot: AssetVector,
  transform: AssetTransform,
): AssetBounds {
  const rotation = eulerXyz(transform.rotation);
  const localCenter = multiplyComponents(subtractVector(bounds.center, pivot), transform.scale);
  const center = addVector(transform.position, transformVector(rotation, localCenter));
  const scaledSize = multiplyComponents(bounds.size, transform.scale);
  const half = {
    x:
      Math.abs(rotation[0]) * (scaledSize.x / 2) +
      Math.abs(rotation[1]) * (scaledSize.y / 2) +
      Math.abs(rotation[2]) * (scaledSize.z / 2),
    y:
      Math.abs(rotation[3]) * (scaledSize.x / 2) +
      Math.abs(rotation[4]) * (scaledSize.y / 2) +
      Math.abs(rotation[5]) * (scaledSize.z / 2),
    z:
      Math.abs(rotation[6]) * (scaledSize.x / 2) +
      Math.abs(rotation[7]) * (scaledSize.y / 2) +
      Math.abs(rotation[8]) * (scaledSize.z / 2),
  };
  return { center: cleanVector(center), size: cleanVector(multiplyVector(half, 2)) };
}

type Rotation = readonly [number, number, number, number, number, number, number, number, number];

function eulerXyz(rotation: AssetTransform["rotation"]): Rotation {
  const x = (rotation.xDegrees * Math.PI) / 180;
  const y = (rotation.yDegrees * Math.PI) / 180;
  const z = (rotation.zDegrees * Math.PI) / 180;
  const cx = Math.cos(x),
    sx = Math.sin(x);
  const cy = Math.cos(y),
    sy = Math.sin(y);
  const cz = Math.cos(z),
    sz = Math.sin(z);
  return [
    cy * cz,
    -cy * sz,
    sy,
    sx * sy * cz + cx * sz,
    -sx * sy * sz + cx * cz,
    -sx * cy,
    -cx * sy * cz + sx * sz,
    cx * sy * sz + sx * cz,
    cx * cy,
  ].map(cleanNumber) as unknown as Rotation;
}

function transformVector(rotation: Rotation, vector: AssetVector): AssetVector {
  return {
    x: rotation[0] * vector.x + rotation[1] * vector.y + rotation[2] * vector.z,
    y: rotation[3] * vector.x + rotation[4] * vector.y + rotation[5] * vector.z,
    z: rotation[6] * vector.x + rotation[7] * vector.y + rotation[8] * vector.z,
  };
}

function reportBounds(
  bounds: NonNullable<GlbInspectionReport["nodes"][number]["bounds"]>,
): AssetBounds {
  return {
    center: {
      x: cleanNumber((bounds.minimum[0] + bounds.maximum[0]) / 2),
      y: cleanNumber((bounds.minimum[1] + bounds.maximum[1]) / 2),
      z: cleanNumber((bounds.minimum[2] + bounds.maximum[2]) / 2),
    },
    size: {
      x: cleanNumber(bounds.maximum[0] - bounds.minimum[0]),
      y: cleanNumber(bounds.maximum[1] - bounds.minimum[1]),
      z: cleanNumber(bounds.maximum[2] - bounds.minimum[2]),
    },
  };
}

async function readJsonArtifact(
  store: ImmutableJsonArtifactStore,
  reference: ArtifactReference,
  purpose: string,
): Promise<{ value: unknown; audit: ArtifactAudit }> {
  JSON_ARTIFACT_SCHEMA.parse(reference);
  return { value: await store.read(reference), audit: auditRow(reference, purpose) };
}

async function readBinaryArtifact(
  store: ImmutableBinaryArtifactStore,
  reference: BinaryArtifactReference,
  purpose: string,
): Promise<{ bytes: Uint8Array; audit: ArtifactAudit }> {
  const parsed = BINARY_ARTIFACT_SCHEMA.parse(reference);
  const bytes = await store.read(parsed);
  if (createHash("sha256").update(bytes).digest("hex") !== parsed.artifactHash)
    throw new Error(`Artifact bytes differ from independently recomputed hash: ${purpose}`);
  return { bytes, audit: auditRow(parsed, purpose) };
}

function auditRow(
  reference: ArtifactReference | BinaryArtifactReference,
  purpose: string,
): ArtifactAudit {
  return {
    purpose,
    locator: reference.locator,
    artifactHash: reference.artifactHash,
    bytes: reference.bytes,
    ...(referenceHasMediaType(reference) ? { mediaType: reference.mediaType } : {}),
  };
}

function referenceHasMediaType(
  reference: ArtifactReference | BinaryArtifactReference,
): reference is BinaryArtifactReference {
  return "mediaType" in reference;
}

function assertPreparedAssetIdentity(asset: PreparedAsset): void {
  const { hash, ...material } = asset;
  if (contentHash(stableJson(material)) !== hash)
    throw new Error("Prepared dependency manifest identity is invalid");
}

function assertTextEvidence(bytes: Uint8Array, subject: string): void {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`Rights evidence is not valid UTF-8: ${subject}`);
  }
  if (text.includes("\0") || text.trim().length === 0)
    throw new Error(`Rights evidence is empty or contains NUL: ${subject}`);
}

function canonicalTextureChannels(
  values: readonly RequiredTextureChannel[],
): RequiredTextureChannel[] {
  const present = new Set(values);
  return ASSET_TEXTURE_CHANNELS.filter((channel) => present.has(channel));
}

function compareArtifactAudit(left: ArtifactAudit, right: ArtifactAudit): number {
  return (
    compareSpatialStrings(left.purpose, right.purpose) ||
    compareSpatialStrings(left.locator, right.locator)
  );
}

function cleanNumber(value: number): number {
  const result = Math.fround(Math.abs(value) < 1e-12 ? 0 : value);
  return Object.is(result, -0) ? 0 : result;
}

function cleanVector(value: AssetVector): AssetVector {
  return { x: cleanNumber(value.x), y: cleanNumber(value.y), z: cleanNumber(value.z) };
}

function addVector(left: AssetVector, right: AssetVector): AssetVector {
  return { x: left.x + right.x, y: left.y + right.y, z: left.z + right.z };
}

function subtractVector(left: AssetVector, right: AssetVector): AssetVector {
  return { x: left.x - right.x, y: left.y - right.y, z: left.z - right.z };
}

function multiplyVector(value: AssetVector, scalar: number): AssetVector {
  return { x: value.x * scalar, y: value.y * scalar, z: value.z * scalar };
}

function multiplyComponents(left: AssetVector, right: AssetVector): AssetVector {
  return { x: left.x * right.x, y: left.y * right.y, z: left.z * right.z };
}

function minimumVector(left: AssetVector, right: AssetVector): AssetVector {
  return {
    x: Math.min(left.x, right.x),
    y: Math.min(left.y, right.y),
    z: Math.min(left.z, right.z),
  };
}

function maximumVector(left: AssetVector, right: AssetVector): AssetVector {
  return {
    x: Math.max(left.x, right.x),
    y: Math.max(left.y, right.y),
    z: Math.max(left.z, right.z),
  };
}
