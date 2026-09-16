import { z } from "zod";
import {
  HASH_SCHEMA,
  compareCanonicalStrings,
  contentAddressedEntityId,
  contentHash,
  deepFreezeJson,
  stableJson,
} from "@basalt/contracts";
import { SPATIAL_AABB_SCHEMA, SPATIAL_VECTOR3_SCHEMA } from "@basalt/spatial-core";
import {
  ASSEMBLY_ARTIFACT_SCHEMA,
  COMPILED_WORLD_FOUNDATION_SCHEMA,
  CONSTRUCTED_STRUCTURE_ARTIFACT_SCHEMA,
  CONSTRUCTED_SURFACE_SCHEMA,
  PORTAL_ARTIFACT_SCHEMA,
  PROCEDURAL_STAIR_ARTIFACT_SCHEMA,
  ROOM_ARTIFACT_SCHEMA,
  WORLD_VISUAL_ENVIRONMENT_SCHEMA,
  WORLD_BUILD_SCHEMA,
  type WorldBuild,
} from "@basalt/world-compiler";
import { ROBLOX_STUD_METERS } from "./constants.js";
import { ROBLOX_GLTF_UPLOAD_ADAPTATION_POLICY_HASH } from "./glb-upload.js";
import {
  ROBLOX_TERRAIN_CONTACT_OBSERVATION_TOLERANCE_METERS,
  ROBLOX_TERRAIN_SURFACE_QUANTIZATION_ALLOWANCE_METERS,
} from "./terrain.js";

const entityId = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u);
const diagnosticEntityId = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/u);
const quaternion = z.tuple([
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
]);
const observedArtifact = z
  .object({
    artifactKind: z.enum([
      "terrain_field",
      "route_construction",
      "route_junction",
      "assembly",
      "constructed_element",
      "constructed_opening",
      "constructed_portal",
      "constructed_structure",
      "constructed_surface",
      "portal",
      "room",
      "procedural_stair",
    ]),
    artifactId: entityId,
    realizedHash: HASH_SCHEMA,
  })
  .strict();
const materialPartPathSegment = z
  .object({ name: z.string().min(1).max(100), siblingOrdinal: z.number().int().nonnegative() })
  .strict();
const colorRgb = z
  .object({
    red: z.number().int().min(0).max(255),
    green: z.number().int().min(0).max(255),
    blue: z.number().int().min(0).max(255),
  })
  .strict();
const MICROMETER_COMPONENT_SCHEMA = z.number().int().safe();
const MICROMETER_VECTOR_SCHEMA = z
  .object({
    x: MICROMETER_COMPONENT_SCHEMA,
    y: MICROMETER_COMPONENT_SCHEMA,
    z: MICROMETER_COMPONENT_SCHEMA,
  })
  .strict();
const MICROMETER_SIZE_SCHEMA = MICROMETER_VECTOR_SCHEMA.refine(
  (value) => value.x > 0 && value.y > 0 && value.z > 0,
  "Observed constructed geometry must have positive extents",
);
const MICROMETER_AABB_SCHEMA = z
  .object({ min: MICROMETER_VECTOR_SCHEMA, max: MICROMETER_VECTOR_SCHEMA })
  .strict()
  .refine(
    ({ min, max }) => min.x < max.x && min.y < max.y && min.z < max.z,
    "Observed clearance bounds must have positive extents",
  );

/**
 * Actual Roblox geometry observations, canonicalized through Roblox's float32
 * stud representation and then quantized to micrometers for exact readback.
 */
export const ROBLOX_CONSTRUCTED_ELEMENT_OBSERVATION_SCHEMA = z
  .object({
    elementId: entityId,
    geometryKind: z.enum(["box", "cylinder"]),
    centerMicrometers: MICROMETER_VECTOR_SCHEMA,
    sizeMicrometers: MICROMETER_SIZE_SCHEMA,
    materialId: entityId,
    baseColorSrgb: colorRgb,
    anchored: z.literal(true),
    canCollide: z.literal(true),
  })
  .strict();
export type RobloxConstructedElementObservation = z.output<
  typeof ROBLOX_CONSTRUCTED_ELEMENT_OBSERVATION_SCHEMA
>;

/** Actual clearance query for one constructed opening. */
export const ROBLOX_CONSTRUCTED_OPENING_OBSERVATION_SCHEMA = z
  .object({
    openingId: entityId,
    clearanceBoundsMicrometers: MICROMETER_AABB_SCHEMA,
    blockingPartIds: z.array(z.string().trim().min(1).max(1024)).max(256),
  })
  .strict()
  .superRefine((value, context) => {
    const canonical = [...new Set(value.blockingPartIds)].sort(compareCanonicalStrings);
    if (stableJson(canonical) !== stableJson(value.blockingPartIds))
      context.addIssue({
        code: "custom",
        path: ["blockingPartIds"],
        message: "Opening blockers must be unique and canonically ordered",
      });
  });
export type RobloxConstructedOpeningObservation = z.output<
  typeof ROBLOX_CONSTRUCTED_OPENING_OBSERVATION_SCHEMA
>;

const routeTerrainTraceFields = {
  phase: z.enum(["foundation", "readback"]),
  requiredSurfaceRevealMeters: z.number().finite().nonnegative(),
  authoredGroundingToleranceMeters: z.number().finite().nonnegative(),
  terrainQuantizationAllowanceMeters: z.literal(
    ROBLOX_TERRAIN_SURFACE_QUANTIZATION_ALLOWANCE_METERS,
  ),
  observationToleranceMeters: z.literal(ROBLOX_TERRAIN_CONTACT_OBSERVATION_TOLERANCE_METERS),
  maximumPermittedBodyGapMeters: z.number().finite().nonnegative(),
  minimumSurfaceClearanceMeters: z.number().finite(),
  maximumSurfaceClearanceMeters: z.number().finite(),
  maximumBodyGapMeters: z.number().finite().nonnegative(),
  maximumGroundingBottomClearanceMeters: z.number().finite(),
  groundingDepthMeters: z.number().finite().nonnegative(),
  minimumAtMeters: SPATIAL_VECTOR3_SCHEMA,
  maximumAtMeters: SPATIAL_VECTOR3_SCHEMA,
  maximumBodyGapAtMeters: SPATIAL_VECTOR3_SCHEMA,
};

/**
 * Bounded engine observations retained for diagnosis. These do not participate
 * in the observed-world-state hash; exact route geometry and artifact identity
 * remain the authoritative readback contract.
 */
export const ROBLOX_TRACE_EVENT_SCHEMA = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("route_terrain"),
        routeId: diagnosticEntityId,
        segmentId: diagnosticEntityId,
        ...routeTerrainTraceFields,
        startAdjustmentMeters: z.number().finite().nonnegative(),
        finishAdjustmentMeters: z.number().finite().nonnegative(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("route_junction_terrain"),
        junctionId: diagnosticEntityId,
        ...routeTerrainTraceFields,
        adjustmentMeters: z.number().finite().nonnegative(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("trace_truncated"),
        droppedEventCount: z.number().int().positive(),
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    if (value.kind === "trace_truncated") return;
    const expectedMaximum =
      value.authoredGroundingToleranceMeters +
      value.terrainQuantizationAllowanceMeters +
      value.observationToleranceMeters;
    if (Math.abs(value.maximumPermittedBodyGapMeters - expectedMaximum) > 1e-12)
      context.addIssue({
        code: "custom",
        path: ["maximumPermittedBodyGapMeters"],
        message: "Maximum permitted body gap does not match its explicit policy components",
      });
  });
export type RobloxTraceEvent = z.output<typeof ROBLOX_TRACE_EVENT_SCHEMA>;

export const ROBLOX_IMPORT_STAGE_SCHEMA = z.enum([
  "preflight",
  "foundation",
  "meso",
  "micro",
  "readback",
  "commit",
]);
const surfaceAppearanceExpectation = z
  .object({
    colorMap: z.string().max(1024),
    metalnessMap: z.string().max(1024),
    normalMap: z.string().max(1024),
    roughnessMap: z.string().max(1024),
    alphaMode: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/u),
  })
  .strict();
export const ROBLOX_MATERIAL_EXPECTATION_SCHEMA = z
  .object({
    partPath: z.array(materialPartPathSegment).min(1).max(128),
    className: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/u),
    material: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/u),
    color: colorRgb,
    transparency: z.number().finite().min(0).max(1),
    reflectance: z.number().finite().min(0).max(1),
    meshTextureId: z.string().max(1024).optional(),
    surfaceAppearance: surfaceAppearanceExpectation.optional(),
  })
  .strict();
export type RobloxMaterialExpectation = z.output<typeof ROBLOX_MATERIAL_EXPECTATION_SCHEMA>;

const robloxUploadFailure = z
  .object({
    code: z.number().int().nullable(),
    message: z.string().trim().min(1).max(1024),
  })
  .strict();

const robloxUploadArtifact = z
  .object({
    locator: z.string().regex(/^binary-artifacts\/[a-f0-9]{64}\.bin$/u),
    artifactHash: HASH_SCHEMA,
    bytes: z
      .number()
      .int()
      .positive()
      .max(20 * 1024 * 1024),
    mediaType: z.literal("model/gltf-binary"),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.locator !== `binary-artifacts/${value.artifactHash}.bin`)
      context.addIssue({
        code: "custom",
        message: "Upload artifact locator does not match its hash",
      });
  });

const robloxUploadAdaptation = z
  .object({
    policyHash: z.literal(ROBLOX_GLTF_UPLOAD_ADAPTATION_POLICY_HASH),
    strippedSecondaryVertexColorSemantics: z
      .array(z.string().regex(/^COLOR_[1-9][0-9]*$/u))
      .max(32),
    strippedPrimitiveAttributeCount: z.number().int().nonnegative().max(100_000),
    preservedPrimaryVertexColorPrimitiveCount: z.number().int().nonnegative().max(100_000),
  })
  .strict()
  .superRefine((value, context) => {
    const semantics = value.strippedSecondaryVertexColorSemantics;
    if (stableJson(semantics) !== stableJson([...new Set(semantics)].sort(compareCanonicalStrings)))
      context.addIssue({ code: "custom", message: "Stripped color semantics are not canonical" });
    if ((value.strippedPrimitiveAttributeCount === 0) !== (semantics.length === 0))
      context.addIssue({ code: "custom", message: "Stripped color summary is inconsistent" });
  });

/**
 * Durable Open Cloud publication state for one exact source-derived Roblox
 * payload. Upload receipts establish the Roblox asset ID, but never engine
 * verification or catalog admission.
 */
export const ROBLOX_ASSET_UPLOAD_SCHEMA = z
  .object({
    kind: z.literal("RobloxAssetUpload"),
    status: z.enum(["pending_operation", "pending_moderation", "eligible", "rejected", "failed"]),
    creator: z.object({ userId: z.number().int().positive().safe() }).strict(),
    sourceContentHash: HASH_SCHEMA,
    sourceArtifactHash: HASH_SCHEMA,
    sourceRelativePath: z
      .string()
      .trim()
      .min(1)
      .max(1024)
      .refine(
        (value) =>
          !value.startsWith("/") &&
          !value.includes("\\") &&
          !value.split("/").some((segment) => segment === ".."),
        "Roblox upload source paths must be relative and traversal-free",
      ),
    sourceBytes: z
      .number()
      .int()
      .positive()
      .max(20 * 1024 * 1024),
    uploadArtifact: robloxUploadArtifact,
    adaptation: robloxUploadAdaptation,
    assetType: z.literal("Model"),
    displayName: z.string().trim().min(1).max(50),
    description: z.string().trim().min(1).max(1000),
    expectedPrice: z.literal(0),
    requestHash: HASH_SCHEMA,
    operationPath: z
      .string()
      .regex(/^operations\/[A-Za-z0-9_-]{1,256}$/u)
      .nullable(),
    robloxAssetId: z.number().int().positive().safe().nullable(),
    revisionId: z.string().regex(/^\d+$/u).nullable(),
    moderationState: z.string().trim().min(1).max(128).nullable(),
    startedAt: z.string().datetime({ offset: true }),
    completedAt: z.string().datetime({ offset: true }).nullable(),
    failure: robloxUploadFailure.nullable(),
    uploadHash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyHash(value, "uploadHash", context);
    if (robloxAssetUploadRequestHash(value) !== value.requestHash)
      context.addIssue({
        code: "custom",
        path: ["requestHash"],
        message: "Upload request hash mismatch",
      });
    const hasPublishedAsset = value.robloxAssetId !== null;
    const isOperationPending = value.status === "pending_operation";
    const isFailed = value.status === "failed";
    if (
      isOperationPending &&
      (value.operationPath === null ||
        hasPublishedAsset ||
        value.completedAt !== null ||
        value.moderationState !== null ||
        value.failure !== null)
    )
      context.addIssue({ code: "custom", message: "Pending upload state is inconsistent" });
    if (
      isFailed &&
      (hasPublishedAsset ||
        value.completedAt === null ||
        value.moderationState !== null ||
        value.failure === null)
    )
      context.addIssue({ code: "custom", message: "Failed upload state is inconsistent" });
    if (
      !isOperationPending &&
      !isFailed &&
      (!hasPublishedAsset ||
        value.operationPath === null ||
        value.completedAt === null ||
        value.moderationState === null ||
        value.failure !== null)
    )
      context.addIssue({ code: "custom", message: "Completed upload state is inconsistent" });
    if (value.status === "eligible" && !/approved/iu.test(value.moderationState ?? ""))
      context.addIssue({ code: "custom", message: "Eligible uploads require approved moderation" });
    if (value.status === "rejected" && !/rejected/iu.test(value.moderationState ?? ""))
      context.addIssue({ code: "custom", message: "Rejected uploads require rejected moderation" });
    if (
      value.status === "pending_moderation" &&
      /(approved|rejected)/iu.test(value.moderationState ?? "")
    )
      context.addIssue({ code: "custom", message: "Pending moderation state is terminal" });
  });
export type RobloxAssetUpload = z.output<typeof ROBLOX_ASSET_UPLOAD_SCHEMA>;

export function robloxAssetUploadRequestHash(
  value: Pick<
    RobloxAssetUpload,
    | "creator"
    | "sourceArtifactHash"
    | "uploadArtifact"
    | "adaptation"
    | "assetType"
    | "displayName"
    | "description"
    | "expectedPrice"
  >,
): string {
  return contentHash(
    stableJson({
      sourceArtifactHash: value.sourceArtifactHash,
      uploadArtifact: {
        artifactHash: value.uploadArtifact.artifactHash,
        bytes: value.uploadArtifact.bytes,
        mediaType: value.uploadArtifact.mediaType,
      },
      adaptationPolicyHash: value.adaptation.policyHash,
      assetType: value.assetType,
      displayName: value.displayName,
      description: value.description,
      creationContext: { creator: value.creator, expectedPrice: value.expectedPrice },
    }),
  );
}

export const ROBLOX_ASSET_UPLOAD_LEDGER_SCHEMA = z
  .object({
    kind: z.literal("RobloxAssetUploadLedger"),
    creator: z.object({ userId: z.number().int().positive().safe() }).strict(),
    uploads: z.array(ROBLOX_ASSET_UPLOAD_SCHEMA).max(100_000),
    ledgerHash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyHash(value, "ledgerHash", context);
    requireCanonicalIds(
      value.uploads,
      (entry) => entry.sourceArtifactHash,
      "Roblox asset uploads",
      context,
    );
    if (value.uploads.some((entry) => entry.creator.userId !== value.creator.userId))
      context.addIssue({ code: "custom", message: "Upload ledger mixes creator identities" });
  });
export type RobloxAssetUploadLedger = z.output<typeof ROBLOX_ASSET_UPLOAD_LEDGER_SCHEMA>;

export function sealRobloxAssetUpload(
  input: Omit<RobloxAssetUpload, "kind" | "uploadHash">,
): RobloxAssetUpload {
  const material = { kind: "RobloxAssetUpload" as const, ...input };
  return deepFreezeJson(
    ROBLOX_ASSET_UPLOAD_SCHEMA.parse({
      ...material,
      uploadHash: contentHash(stableJson(material)),
    }),
  );
}

export function sealRobloxAssetUploadLedger(
  input: Omit<RobloxAssetUploadLedger, "kind" | "ledgerHash">,
): RobloxAssetUploadLedger {
  const material = {
    kind: "RobloxAssetUploadLedger" as const,
    creator: input.creator,
    uploads: [...input.uploads].sort((left, right) =>
      compareCanonicalStrings(left.sourceArtifactHash, right.sourceArtifactHash),
    ),
  };
  return deepFreezeJson(
    ROBLOX_ASSET_UPLOAD_LEDGER_SCHEMA.parse({
      ...material,
      ledgerHash: contentHash(stableJson(material)),
    }),
  );
}

export const ROBLOX_SCENE_INSTANCE_SCHEMA = z
  .object({
    instanceId: entityId,
    assetHash: HASH_SCHEMA,
    sourceArtifactHash: HASH_SCHEMA.optional(),
    uploadArtifactHash: HASH_SCHEMA.optional(),
    robloxAssetId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    transformMeters: z
      .object({
        position: SPATIAL_VECTOR3_SCHEMA,
        rotation: quaternion,
        scale: z.number().finite().positive(),
      })
      .strict(),
    sourceBoundsMeters: SPATIAL_AABB_SCHEMA,
    boundsMeters: SPATIAL_AABB_SCHEMA,
    materialExpectations: z.array(ROBLOX_MATERIAL_EXPECTATION_SCHEMA).max(100_000),
    evidenceHashes: z.array(HASH_SCHEMA).max(8192),
  })
  .strict()
  .superRefine((value, context) => {
    const hasBinding = value.robloxAssetId !== undefined;
    if (
      hasBinding !== (value.sourceArtifactHash !== undefined) ||
      hasBinding !== (value.uploadArtifactHash !== undefined)
    )
      context.addIssue({
        code: "custom",
        message: "Roblox instance binding lineage is incomplete",
      });
    if ((value.robloxAssetId !== undefined) !== value.materialExpectations.length > 0)
      context.addIssue({
        code: "custom",
        path: ["materialExpectations"],
        message: "A bound Roblox asset requires complete material expectations",
      });
    validateMaterialExpectationPaths(value.materialExpectations, context);
  });

export const ROBLOX_IMPORT_TRANSACTION_SCHEMA = z
  .object({
    kind: z.literal("RobloxImportTransaction"),
    transactionId: entityId,
    sessionHash: HASH_SCHEMA,
    worldBuildHash: HASH_SCHEMA,
    sequence: z.number().int().nonnegative(),
    stage: ROBLOX_IMPORT_STAGE_SCHEMA,
    expectedObservedWorldStateHash: HASH_SCHEMA,
    visualEnvironment: WORLD_VISUAL_ENVIRONMENT_SCHEMA.optional(),
    foundation: z
      .object({
        worldBoundsMeters: SPATIAL_AABB_SCHEMA,
        baseTerrainFields: COMPILED_WORLD_FOUNDATION_SCHEMA.shape.baseTerrainFields,
        terrainFields: COMPILED_WORLD_FOUNDATION_SCHEMA.shape.terrainFields,
        routeConstructions: COMPILED_WORLD_FOUNDATION_SCHEMA.shape.routeConstructions,
        routeJunctions: COMPILED_WORLD_FOUNDATION_SCHEMA.shape.routeJunctions,
      })
      .strict()
      .optional(),
    meso: z
      .object({
        assemblies: z.array(ASSEMBLY_ARTIFACT_SCHEMA).max(65_536),
        constructedStructures: z.array(CONSTRUCTED_STRUCTURE_ARTIFACT_SCHEMA).max(65_536),
        constructedSurfaces: z.array(CONSTRUCTED_SURFACE_SCHEMA).max(65_536),
        portals: z.array(PORTAL_ARTIFACT_SCHEMA).max(65_536),
        rooms: z.array(ROOM_ARTIFACT_SCHEMA).max(65_536),
        proceduralStairs: z.array(PROCEDURAL_STAIR_ARTIFACT_SCHEMA).max(65_536),
      })
      .strict()
      .optional(),
    instances: z.array(ROBLOX_SCENE_INSTANCE_SCHEMA).max(100_000),
    expectedInstanceHashes: z
      .array(z.object({ instanceId: entityId, hash: HASH_SCHEMA }).strict())
      .max(100_000),
    expectedArtifactHashes: z.array(observedArtifact).max(262_144),
    expectedConstructedElements: z
      .array(ROBLOX_CONSTRUCTED_ELEMENT_OBSERVATION_SCHEMA)
      .max(100_000),
    expectedConstructedOpenings: z.array(ROBLOX_CONSTRUCTED_OPENING_OBSERVATION_SCHEMA).max(65_536),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyHash(value, "hash", context);
    if ((value.stage === "foundation") !== (value.foundation !== undefined))
      context.addIssue({
        code: "custom",
        path: ["foundation"],
        message: "Only the foundation transaction carries foundation data",
      });
    if ((value.stage === "meso") !== (value.meso !== undefined))
      context.addIssue({
        code: "custom",
        path: ["meso"],
        message: "Only the meso transaction carries structural data",
      });
    if ((value.stage === "commit") !== (value.visualEnvironment !== undefined))
      context.addIssue({
        code: "custom",
        path: ["visualEnvironment"],
        message: "Only the commit transaction carries the visual environment",
      });
    if (
      new Set(value.expectedInstanceHashes.map((entry) => entry.instanceId)).size !==
      value.expectedInstanceHashes.length
    )
      context.addIssue({ code: "custom", message: "Expected instance identities must be unique" });
    const artifactKeys = value.expectedArtifactHashes.map(
      (entry) => `${entry.artifactKind}:${entry.artifactId}`,
    );
    if (new Set(artifactKeys).size !== artifactKeys.length)
      context.addIssue({
        code: "custom",
        message: "Expected structural artifact identities must be unique",
      });
    requireCanonicalIds(
      value.expectedConstructedElements,
      (entry) => entry.elementId,
      "expected constructed elements",
      context,
    );
    requireCanonicalIds(
      value.expectedConstructedOpenings,
      (entry) => entry.openingId,
      "expected constructed openings",
      context,
    );
    const carriesGeometry = value.stage === "readback";
    if (
      !carriesGeometry &&
      (value.expectedConstructedElements.length > 0 || value.expectedConstructedOpenings.length > 0)
    )
      context.addIssue({
        code: "custom",
        message: "Only the readback transaction carries constructed geometry expectations",
      });
  });
export type RobloxImportTransaction = z.output<typeof ROBLOX_IMPORT_TRANSACTION_SCHEMA>;

export const ROBLOX_IMPORT_MANIFEST_SCHEMA = z
  .object({
    kind: z.literal("RobloxImportManifest"),
    sessionHash: HASH_SCHEMA,
    worldBuildHash: HASH_SCHEMA,
    worldStatus: z.enum(["eligible", "incomplete"]),
    loweringGaps: z
      .array(
        z
          .object({
            kind: z.enum([
              "asset_binding",
              "constructed_geometry",
              "route_construction",
              "terrain_construction",
            ]),
            subjectHash: HASH_SCHEMA,
            reason: z.string().trim().min(1).max(1024),
          })
          .strict(),
      )
      .max(100_000),
    transactions: z.array(ROBLOX_IMPORT_TRANSACTION_SCHEMA).min(4).max(100_000),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyHash(value, "hash", context);
    const expectedStages = ["preflight", "foundation", "meso", "micro", "readback", "commit"];
    if (stableJson(value.transactions.map((entry) => entry.stage)) !== stableJson(expectedStages))
      context.addIssue({
        code: "custom",
        message: "Roblox import stages must form the canonical sequence",
      });
    for (const [index, transaction] of value.transactions.entries())
      if (
        transaction.sequence !== index ||
        transaction.sessionHash !== value.sessionHash ||
        transaction.worldBuildHash !== value.worldBuildHash
      )
        context.addIssue({ code: "custom", message: "Roblox transaction lineage is inconsistent" });
  });
export type RobloxImportManifest = z.output<typeof ROBLOX_IMPORT_MANIFEST_SCHEMA>;

export const ROBLOX_ASSET_BINDING_SCHEMA = z
  .object({
    assetHash: HASH_SCHEMA,
    robloxAssetId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    sourceArtifactHash: HASH_SCHEMA,
    uploadArtifactHash: HASH_SCHEMA,
    publicationEvidenceHash: HASH_SCHEMA,
    materialExpectations: z.array(ROBLOX_MATERIAL_EXPECTATION_SCHEMA).min(1).max(100_000),
    bindingHash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyHash(value, "bindingHash", context);
    validateMaterialExpectationPaths(value.materialExpectations, context);
  });
export type RobloxAssetBinding = z.output<typeof ROBLOX_ASSET_BINDING_SCHEMA>;

export function sealRobloxAssetBinding(
  input: Omit<RobloxAssetBinding, "bindingHash">,
): RobloxAssetBinding {
  const material = {
    ...input,
    materialExpectations: [...input.materialExpectations].sort((left, right) =>
      compareCanonicalStrings(stableJson(left.partPath), stableJson(right.partPath)),
    ),
  };
  return deepFreezeJson(
    ROBLOX_ASSET_BINDING_SCHEMA.parse({
      ...material,
      bindingHash: contentHash(stableJson(material)),
    }),
  );
}

export const ROBLOX_READBACK_SCHEMA = z
  .object({
    kind: z.literal("RobloxReadback"),
    sessionHash: HASH_SCHEMA,
    worldBuildHash: HASH_SCHEMA,
    transactionId: entityId,
    status: z.enum(["complete", "incomplete"]),
    instances: z
      .array(z.object({ instanceId: entityId, realizedHash: HASH_SCHEMA }).strict())
      .max(100_000),
    artifacts: z.array(observedArtifact).max(262_144),
    constructedElements: z.array(ROBLOX_CONSTRUCTED_ELEMENT_OBSERVATION_SCHEMA).max(100_000),
    constructedOpenings: z.array(ROBLOX_CONSTRUCTED_OPENING_OBSERVATION_SCHEMA).max(65_536),
    traceEvents: z.array(ROBLOX_TRACE_EVENT_SCHEMA).max(4_096),
    diagnostics: z.array(z.string().min(1).max(1024)).max(4096),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === "complete" && value.diagnostics.length > 0)
      context.addIssue({
        code: "custom",
        path: ["diagnostics"],
        message: "Complete readback cannot contain diagnostics",
      });
    if (value.status === "incomplete" && value.diagnostics.length === 0)
      context.addIssue({
        code: "custom",
        path: ["diagnostics"],
        message: "Incomplete readback requires a diagnostic",
      });
    requireCanonicalIds(
      value.constructedElements,
      (entry) => entry.elementId,
      "observed constructed elements",
      context,
    );
    requireCanonicalIds(
      value.constructedOpenings,
      (entry) => entry.openingId,
      "observed constructed openings",
      context,
    );
  });
export type RobloxReadback = z.output<typeof ROBLOX_READBACK_SCHEMA>;

export const ROBLOX_IMPORT_REPORT_RECORD_SCHEMA = z
  .object({
    transactionId: entityId,
    stage: ROBLOX_IMPORT_STAGE_SCHEMA,
    status: z.enum(["complete", "incomplete"]),
    readbackHash: HASH_SCHEMA,
    observedWorldStateHash: HASH_SCHEMA.optional(),
    instanceCount: z.number().int().nonnegative(),
    artifactCount: z.number().int().nonnegative(),
    constructedElementCount: z.number().int().nonnegative(),
    constructedOpeningCount: z.number().int().nonnegative(),
    diagnosticCount: z.number().int().nonnegative(),
    traceEventCount: z.number().int().nonnegative(),
  })
  .strict();

/** Durable, token-free status and diagnostic evidence for the latest import. */
export const ROBLOX_IMPORT_REPORT_SCHEMA = z
  .object({
    kind: z.literal("RobloxImportReport"),
    sessionHash: HASH_SCHEMA,
    worldBuildHash: HASH_SCHEMA,
    state: z.enum(["idle", "pending", "complete", "incomplete"]),
    stage: z.union([ROBLOX_IMPORT_STAGE_SCHEMA, z.literal("complete")]),
    progress: z
      .object({ complete: z.number().int().nonnegative(), total: z.number().int().positive() })
      .strict(),
    records: z.array(ROBLOX_IMPORT_REPORT_RECORD_SCHEMA).max(65_536),
    diagnostics: z.array(z.string().min(1).max(1_024)).max(4_096),
    traceEvents: z.array(ROBLOX_TRACE_EVENT_SCHEMA).max(8_192),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => verifyHash(value, "hash", context));
export type RobloxImportReport = z.output<typeof ROBLOX_IMPORT_REPORT_SCHEMA>;

export function createRobloxImportManifest(
  worldBuildInput: WorldBuild,
  assetBindingsInput: readonly RobloxAssetBinding[] = [],
): RobloxImportManifest {
  const worldBuild = WORLD_BUILD_SCHEMA.parse(worldBuildInput);
  if (worldBuild.status === "rejected") throw new Error("Rejected worlds cannot be imported");
  const assetBindings = assetBindingsInput.map((entry) => ROBLOX_ASSET_BINDING_SCHEMA.parse(entry));
  const bindingByAsset = new Map(assetBindings.map((entry) => [entry.assetHash, entry]));
  if (bindingByAsset.size !== assetBindings.length)
    throw new Error("Roblox asset bindings must be unique by asset hash");
  const sessionHash = contentHash(
    stableJson({ worldBuildHash: worldBuild.worldBuildHash, adapter: "roblox" }),
  );
  const instances = worldBuild.instances.map((instance) => {
    const binding = bindingByAsset.get(instance.assetHash);
    return {
      instanceId: instance.instanceId,
      assetHash: instance.assetHash,
      ...(binding
        ? {
            sourceArtifactHash: binding.sourceArtifactHash,
            uploadArtifactHash: binding.uploadArtifactHash,
            robloxAssetId: binding.robloxAssetId,
          }
        : {}),
      transformMeters: instance.transformMeters,
      sourceBoundsMeters: instance.sourceBoundsMeters,
      boundsMeters: instance.boundsMeters,
      materialExpectations: binding?.materialExpectations ?? [],
      evidenceHashes: binding
        ? [...new Set([...instance.evidenceHashes, binding.bindingHash])].sort(
            compareCanonicalStrings,
          )
        : instance.evidenceHashes,
    };
  });
  const loweringGaps: z.output<typeof ROBLOX_IMPORT_MANIFEST_SCHEMA>["loweringGaps"] = [
    ...new Set(
      instances
        .filter((entry) => entry.robloxAssetId === undefined)
        .map((entry) => entry.assetHash),
    ),
  ]
    .sort(compareCanonicalStrings)
    .map((assetHash) => ({
      kind: "asset_binding" as const,
      subjectHash: assetHash,
      reason: "No admitted Roblox asset binding exists",
    }));
  loweringGaps.push(
    ...worldBuild.foundation.routeConstructions
      .filter((route) => route.status !== "eligible")
      .map((route) => ({
        kind: "route_construction" as const,
        subjectHash: route.hash,
        reason: route.diagnostics.join("; "),
      })),
  );
  if (worldBuild.foundation.status !== "eligible")
    loweringGaps.push({
      kind: "terrain_construction",
      subjectHash: worldBuild.foundation.foundationHash,
      reason:
        worldBuild.foundation.diagnostics.join("; ").slice(0, 1024) ||
        "World foundation is incomplete",
    });
  const foundationArtifacts = foundationObservations(worldBuild);
  const structuralArtifacts = structuralObservations(worldBuild);
  const constructedElements = constructedElementObservations(worldBuild);
  const constructedOpenings = constructedOpeningObservations(worldBuild);
  const mesoPayload = {
    assemblies: worldBuild.meso.assemblies,
    constructedStructures: worldBuild.meso.constructedStructures,
    constructedSurfaces: worldBuild.meso.constructedSurfaces,
    portals: worldBuild.meso.portals,
    rooms: worldBuild.meso.rooms,
    proceduralStairs: worldBuild.meso.proceduralStairs,
  };
  const stages = [
    { stage: "preflight" as const, instances: [] },
    {
      stage: "foundation" as const,
      instances: [],
      foundation: {
        worldBoundsMeters: worldBuild.foundation.boundsMeters,
        baseTerrainFields: worldBuild.foundation.baseTerrainFields,
        terrainFields: worldBuild.foundation.terrainFields,
        routeConstructions: worldBuild.foundation.routeConstructions,
        routeJunctions: worldBuild.foundation.routeJunctions,
      },
      expectedArtifacts: foundationArtifacts,
    },
    {
      stage: "meso" as const,
      instances: instancesFor(worldBuild.meso.instances, instances),
      meso: mesoPayload,
      expectedArtifacts: structuralArtifacts,
    },
    { stage: "micro" as const, instances: instancesFor(worldBuild.micro.instances, instances) },
    {
      stage: "readback" as const,
      instances: [],
      expectedInstances: instances,
      expectedArtifacts: [...foundationArtifacts, ...structuralArtifacts],
      expectedConstructedElements: constructedElements,
      expectedConstructedOpenings: constructedOpenings,
    },
    {
      stage: "commit" as const,
      instances: [],
      visualEnvironment: worldBuild.visualEnvironment,
    },
  ];
  const transactions = stages.map((stage, sequence) => {
    const expectedInstanceHashes = (stage.expectedInstances ?? stage.instances)
      .map((entry) => ({ instanceId: entry.instanceId, hash: contentHash(stableJson(entry)) }))
      .sort((a, b) => compareCanonicalStrings(a.instanceId, b.instanceId));
    const expectedArtifactHashes = [...(stage.expectedArtifacts ?? [])].sort((left, right) =>
      compareCanonicalStrings(
        `${left.artifactKind}:${left.artifactId}`,
        `${right.artifactKind}:${right.artifactId}`,
      ),
    );
    const expectedConstructedElements = [...(stage.expectedConstructedElements ?? [])].sort(
      (left, right) => compareCanonicalStrings(left.elementId, right.elementId),
    );
    const expectedConstructedOpenings = [...(stage.expectedConstructedOpenings ?? [])].sort(
      (left, right) => compareCanonicalStrings(left.openingId, right.openingId),
    );
    const expectedObservedWorldStateHash = observedWorldStateHash({
      worldBuildHash: worldBuild.worldBuildHash,
      stage: stage.stage,
      instances: expectedInstanceHashes.map((entry) => ({
        instanceId: entry.instanceId,
        realizedHash: entry.hash,
      })),
      artifacts: expectedArtifactHashes,
      constructedElements: expectedConstructedElements,
      constructedOpenings: expectedConstructedOpenings,
    });
    const transactionMaterial = {
      kind: "RobloxImportTransaction" as const,
      transactionId: contentAddressedEntityId("Transaction", {
        sessionHash,
        sequence,
        stage: stage.stage,
      }),
      sessionHash,
      worldBuildHash: worldBuild.worldBuildHash,
      sequence,
      stage: stage.stage,
      expectedObservedWorldStateHash,
      ...(stage.foundation ? { foundation: stage.foundation } : {}),
      ...(stage.meso ? { meso: stage.meso } : {}),
      ...(stage.visualEnvironment ? { visualEnvironment: stage.visualEnvironment } : {}),
      instances: stage.instances,
      expectedInstanceHashes,
      expectedArtifactHashes,
      expectedConstructedElements,
      expectedConstructedOpenings,
    };
    return deepFreezeJson(
      ROBLOX_IMPORT_TRANSACTION_SCHEMA.parse({
        ...transactionMaterial,
        hash: contentHash(stableJson(transactionMaterial)),
      }),
    );
  });
  const material = {
    kind: "RobloxImportManifest" as const,
    sessionHash,
    worldBuildHash: worldBuild.worldBuildHash,
    worldStatus:
      worldBuild.status === "incomplete" || loweringGaps.length > 0
        ? ("incomplete" as const)
        : ("eligible" as const),
    loweringGaps,
    transactions,
  };
  return deepFreezeJson(
    ROBLOX_IMPORT_MANIFEST_SCHEMA.parse({ ...material, hash: contentHash(stableJson(material)) }),
  );
}

export function verifyRobloxReadback(
  transaction: RobloxImportTransaction,
  readbackInput: unknown,
): readonly string[] {
  const readback = ROBLOX_READBACK_SCHEMA.parse(readbackInput);
  const diagnostics = [...verifyRobloxReadbackEnvelope(transaction, readback)];
  const observed = new Map(
    readback.instances.map((entry) => [entry.instanceId, entry.realizedHash]),
  );
  if (observed.size !== readback.instances.length)
    diagnostics.push("Readback repeats instance observations");
  for (const expected of transaction.expectedInstanceHashes)
    if (observed.get(expected.instanceId) !== expected.hash)
      diagnostics.push(`Instance ${expected.instanceId} did not match its exact realization hash`);
  for (const observedInstanceId of observed.keys())
    if (
      !transaction.expectedInstanceHashes.some((entry) => entry.instanceId === observedInstanceId)
    )
      diagnostics.push(`Unexpected instance observation ${observedInstanceId}`);
  const observedArtifacts = new Map(
    readback.artifacts.map((entry) => [
      `${entry.artifactKind}:${entry.artifactId}`,
      entry.realizedHash,
    ]),
  );
  if (observedArtifacts.size !== readback.artifacts.length)
    diagnostics.push("Readback repeats structural artifact observations");
  for (const expected of transaction.expectedArtifactHashes)
    if (
      observedArtifacts.get(`${expected.artifactKind}:${expected.artifactId}`) !==
      expected.realizedHash
    )
      diagnostics.push(
        `${expected.artifactKind} ${expected.artifactId} did not match its exact realization hash`,
      );
  for (const observedArtifactId of observedArtifacts.keys())
    if (
      !transaction.expectedArtifactHashes.some(
        (entry) => `${entry.artifactKind}:${entry.artifactId}` === observedArtifactId,
      )
    )
      diagnostics.push(`Unexpected artifact observation ${observedArtifactId}`);
  compareConstructedElementObservations(
    transaction.expectedConstructedElements,
    readback.constructedElements,
    diagnostics,
  );
  compareConstructedOpeningObservations(
    transaction.expectedConstructedOpenings,
    readback.constructedOpenings,
    diagnostics,
  );
  if (
    computeRobloxObservedWorldStateHash(transaction, readback) !==
    transaction.expectedObservedWorldStateHash
  )
    diagnostics.push("Observed world-state hash mismatch");
  return diagnostics.sort(compareCanonicalStrings);
}

/** Validate a failed stage's identity without demanding outputs it could not produce. */
export function verifyRobloxReadbackEnvelope(
  transaction: RobloxImportTransaction,
  readback: RobloxReadback,
): readonly string[] {
  const diagnostics: string[] = [];
  if (readback.sessionHash !== transaction.sessionHash) diagnostics.push("Session hash mismatch");
  if (readback.worldBuildHash !== transaction.worldBuildHash)
    diagnostics.push("World build hash mismatch");
  if (readback.transactionId !== transaction.transactionId)
    diagnostics.push("Transaction ID mismatch");
  const expectedTracePhase =
    transaction.stage === "foundation" || transaction.stage === "readback"
      ? transaction.stage
      : undefined;
  for (const trace of readback.traceEvents) {
    if (trace.kind === "trace_truncated") continue;
    if (expectedTracePhase === undefined)
      diagnostics.push(`Transaction stage ${transaction.stage} cannot emit terrain trace events`);
    else if (trace.phase !== expectedTracePhase)
      diagnostics.push(
        `Terrain trace phase ${trace.phase} does not match transaction stage ${transaction.stage}`,
      );
  }
  return diagnostics.sort(compareCanonicalStrings);
}

export function computeRobloxObservedWorldStateHash(
  transaction: RobloxImportTransaction,
  readbackInput: RobloxReadback,
): string {
  const readback = ROBLOX_READBACK_SCHEMA.parse(readbackInput);
  return observedWorldStateHash({
    worldBuildHash: transaction.worldBuildHash,
    stage: transaction.stage,
    instances: readback.instances,
    artifacts: readback.artifacts,
    constructedElements: readback.constructedElements,
    constructedOpenings: readback.constructedOpenings,
  });
}

/** Generic meters become Roblox studs only here, at the adapter boundary. */
export function metersToRobloxStuds(meters: number): number {
  if (!Number.isFinite(meters)) throw new Error("Roblox lowering requires a finite meter value");
  return meters / ROBLOX_STUD_METERS;
}

/** Roblox observations return to the engine-neutral metric frame only here. */
export function robloxStudsToMeters(studs: number): number {
  if (!Number.isFinite(studs)) throw new Error("Roblox readback requires a finite stud value");
  return studs * ROBLOX_STUD_METERS;
}

function instancesFor(
  selected: readonly { instanceId: string }[],
  all: readonly z.output<typeof ROBLOX_SCENE_INSTANCE_SCHEMA>[],
) {
  const wanted = new Set(selected.map((entry) => entry.instanceId));
  return all.filter((entry) => wanted.has(entry.instanceId));
}

function structuralObservations(worldBuild: WorldBuild) {
  return [
    ...worldBuild.meso.assemblies.map((entry) => ({
      artifactKind: "assembly" as const,
      artifactId: entry.assemblyId,
      realizedHash: entry.hash,
    })),
    ...worldBuild.meso.constructedStructures.flatMap((structure) => [
      {
        artifactKind: "constructed_structure" as const,
        artifactId: structure.structureId,
        realizedHash: structure.hash,
      },
      ...structure.elements.map((entry) => ({
        artifactKind: "constructed_element" as const,
        artifactId: entry.elementId,
        realizedHash: entry.hash,
      })),
      ...structure.openings.map((entry) => ({
        artifactKind: "constructed_opening" as const,
        artifactId: entry.openingId,
        realizedHash: entry.hash,
      })),
      ...structure.portals.map((entry) => ({
        artifactKind: "constructed_portal" as const,
        artifactId: entry.portalId,
        realizedHash: entry.hash,
      })),
    ]),
    ...worldBuild.meso.constructedSurfaces.map((entry) => ({
      artifactKind: "constructed_surface" as const,
      artifactId: entry.surfaceId,
      realizedHash: entry.hash,
    })),
    ...worldBuild.meso.portals.map((entry) => ({
      artifactKind: "portal" as const,
      artifactId: entry.portalId,
      realizedHash: entry.hash,
    })),
    ...worldBuild.meso.rooms.map((entry) => ({
      artifactKind: "room" as const,
      artifactId: entry.roomId,
      realizedHash: entry.hash,
    })),
    ...worldBuild.meso.proceduralStairs.map((entry) => ({
      artifactKind: "procedural_stair" as const,
      artifactId: entry.stairId,
      realizedHash: entry.hash,
    })),
  ].sort((left, right) =>
    compareCanonicalStrings(
      `${left.artifactKind}:${left.artifactId}`,
      `${right.artifactKind}:${right.artifactId}`,
    ),
  );
}

function constructedElementObservations(
  worldBuild: WorldBuild,
): readonly RobloxConstructedElementObservation[] {
  return worldBuild.meso.constructedStructures
    .flatMap((structure) =>
      structure.elements.map((element) => ({
        elementId: element.elementId,
        geometryKind: element.geometry.kind,
        centerMicrometers: metricVectorToRobloxReadbackMicrometers(element.geometry.centerMeters),
        sizeMicrometers: metricVectorToRobloxReadbackMicrometers(
          element.geometry.kind === "box"
            ? element.geometry.sizeMeters
            : {
                x: element.geometry.radiusMeters * 2,
                y: element.geometry.heightMeters,
                z: element.geometry.radiusMeters * 2,
              },
        ),
        materialId: element.appearance.materialId,
        baseColorSrgb: element.appearance.baseColorSrgb,
        anchored: true as const,
        canCollide: true as const,
      })),
    )
    .sort((left, right) => compareCanonicalStrings(left.elementId, right.elementId));
}

function constructedOpeningObservations(
  worldBuild: WorldBuild,
): readonly RobloxConstructedOpeningObservation[] {
  return worldBuild.meso.constructedStructures
    .flatMap((structure) =>
      structure.openings.map((opening) => ({
        openingId: opening.openingId,
        clearanceBoundsMicrometers: metricAabbToRobloxReadbackMicrometers(
          opening.clearanceBoundsMeters,
        ),
        blockingPartIds: [],
      })),
    )
    .sort((left, right) => compareCanonicalStrings(left.openingId, right.openingId));
}

function metricVectorToRobloxReadbackMicrometers(value: {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}) {
  return {
    x: metersToRobloxReadbackMicrometers(value.x),
    y: metersToRobloxReadbackMicrometers(value.y),
    z: metersToRobloxReadbackMicrometers(value.z),
  };
}

/** Canonical observation of a meter value after Roblox stores it as float32 studs. */
export function metersToRobloxReadbackMicrometers(value: number): number {
  if (!Number.isFinite(value)) throw new Error("Roblox readback requires a finite meter value");
  return robloxStoredStudsToMicrometers(Math.fround(value / ROBLOX_STUD_METERS));
}

function robloxStoredStudsToMicrometers(studs: number): number {
  const scaled = studs * ROBLOX_STUD_METERS * 1_000_000;
  const micrometers = scaled >= 0 ? Math.floor(scaled + 0.5) : Math.ceil(scaled - 0.5);
  if (!Number.isSafeInteger(micrometers))
    throw new Error("Roblox metric observation exceeds the canonical micrometer range");
  return micrometers;
}

function metricAabbToRobloxReadbackMicrometers(bounds: {
  readonly min: { readonly x: number; readonly y: number; readonly z: number };
  readonly max: { readonly x: number; readonly y: number; readonly z: number };
}) {
  const min = { x: 0, y: 0, z: 0 };
  const max = { x: 0, y: 0, z: 0 };
  for (const axis of ["x", "y", "z"] as const) {
    const centerStuds = Math.fround((bounds.min[axis] + bounds.max[axis]) / 2 / ROBLOX_STUD_METERS);
    const sizeStuds = Math.fround((bounds.max[axis] - bounds.min[axis]) / ROBLOX_STUD_METERS);
    const halfSizeStuds = Math.fround(sizeStuds / 2);
    min[axis] = robloxStoredStudsToMicrometers(Math.fround(centerStuds - halfSizeStuds));
    max[axis] = robloxStoredStudsToMicrometers(Math.fround(centerStuds + halfSizeStuds));
  }
  return { min, max };
}

function compareConstructedElementObservations(
  expected: readonly RobloxConstructedElementObservation[],
  actual: readonly RobloxConstructedElementObservation[],
  diagnostics: string[],
): void {
  const expectedById = new Map(expected.map((entry) => [entry.elementId, entry] as const));
  const actualById = new Map(actual.map((entry) => [entry.elementId, entry] as const));
  for (const [elementId, expectation] of expectedById) {
    const observation = actualById.get(elementId);
    if (!observation)
      diagnostics.push(`Constructed element ${elementId} has no actual geometry observation`);
    else if (stableJson(observation) !== stableJson(expectation))
      diagnostics.push(
        `Constructed element ${elementId} geometry or properties drifted: ${describeConstructedElementDrift(expectation, observation)}`,
      );
  }
  for (const elementId of actualById.keys())
    if (!expectedById.has(elementId))
      diagnostics.push(`Unexpected constructed element observation ${elementId}`);
}

function describeConstructedElementDrift(
  expected: RobloxConstructedElementObservation,
  actual: RobloxConstructedElementObservation,
): string {
  const changes: string[] = [];
  if (expected.geometryKind !== actual.geometryKind)
    changes.push(`geometryKind expected ${expected.geometryKind}, observed ${actual.geometryKind}`);
  for (const field of ["centerMicrometers", "sizeMicrometers"] as const)
    for (const axis of ["x", "y", "z"] as const)
      if (expected[field][axis] !== actual[field][axis])
        changes.push(
          `${field}.${axis} expected ${expected[field][axis]}, observed ${actual[field][axis]}`,
        );
  if (expected.materialId !== actual.materialId)
    changes.push(`materialId expected ${expected.materialId}, observed ${actual.materialId}`);
  for (const channel of ["red", "green", "blue"] as const)
    if (expected.baseColorSrgb[channel] !== actual.baseColorSrgb[channel])
      changes.push(
        `baseColorSrgb.${channel} expected ${expected.baseColorSrgb[channel]}, observed ${actual.baseColorSrgb[channel]}`,
      );
  if (expected.anchored !== actual.anchored)
    changes.push(`anchored expected ${expected.anchored}, observed ${actual.anchored}`);
  if (expected.canCollide !== actual.canCollide)
    changes.push(`canCollide expected ${expected.canCollide}, observed ${actual.canCollide}`);
  return changes.join("; ") || "canonical observations differ";
}

function compareConstructedOpeningObservations(
  expected: readonly RobloxConstructedOpeningObservation[],
  actual: readonly RobloxConstructedOpeningObservation[],
  diagnostics: string[],
): void {
  const expectedById = new Map(expected.map((entry) => [entry.openingId, entry] as const));
  const actualById = new Map(actual.map((entry) => [entry.openingId, entry] as const));
  for (const [openingId, expectation] of expectedById) {
    const observation = actualById.get(openingId);
    if (!observation)
      diagnostics.push(`Constructed opening ${openingId} has no clearance observation`);
    else {
      if (
        stableJson(observation.clearanceBoundsMicrometers) !==
        stableJson(expectation.clearanceBoundsMicrometers)
      )
        diagnostics.push(`Constructed opening ${openingId} clearance bounds drifted`);
      if (observation.blockingPartIds.length > 0)
        diagnostics.push(`Constructed opening ${openingId} is blocked by actual geometry`);
    }
  }
  for (const openingId of actualById.keys())
    if (!expectedById.has(openingId))
      diagnostics.push(`Unexpected constructed opening observation ${openingId}`);
}

function foundationObservations(worldBuild: WorldBuild) {
  return [
    ...worldBuild.foundation.terrainFields.map((entry) => ({
      artifactKind: "terrain_field" as const,
      artifactId: entry.terrainPlanId,
      realizedHash: entry.hash,
    })),
    ...worldBuild.foundation.routeConstructions.map((entry) => ({
      artifactKind: "route_construction" as const,
      artifactId: entry.routeId,
      realizedHash: entry.hash,
    })),
    ...worldBuild.foundation.routeJunctions.map((entry) => ({
      artifactKind: "route_junction" as const,
      artifactId: entry.junctionId,
      realizedHash: entry.hash,
    })),
  ];
}

function observedWorldStateHash(input: {
  readonly worldBuildHash: string;
  readonly stage: RobloxImportTransaction["stage"];
  readonly instances: readonly { readonly instanceId: string; readonly realizedHash: string }[];
  readonly artifacts: readonly z.output<typeof observedArtifact>[];
  readonly constructedElements: readonly RobloxConstructedElementObservation[];
  readonly constructedOpenings: readonly RobloxConstructedOpeningObservation[];
}): string {
  return contentHash(
    stableJson({
      worldBuildHash: input.worldBuildHash,
      stage: input.stage,
      instances: [...input.instances].sort((left, right) =>
        compareCanonicalStrings(left.instanceId, right.instanceId),
      ),
      artifacts: [...input.artifacts].sort((left, right) =>
        compareCanonicalStrings(
          `${left.artifactKind}:${left.artifactId}`,
          `${right.artifactKind}:${right.artifactId}`,
        ),
      ),
      constructedElements: [...input.constructedElements].sort((left, right) =>
        compareCanonicalStrings(left.elementId, right.elementId),
      ),
      constructedOpenings: [...input.constructedOpenings].sort((left, right) =>
        compareCanonicalStrings(left.openingId, right.openingId),
      ),
    }),
  );
}

function verifyHash(value: Record<string, unknown>, field: string, context: z.RefinementCtx): void {
  const material = { ...value };
  delete material[field];
  if (contentHash(stableJson(material)) !== value[field])
    context.addIssue({ code: "custom", path: [field], message: "Artifact hash mismatch" });
}

function validateMaterialExpectationPaths(
  expectations: readonly RobloxMaterialExpectation[],
  context: z.RefinementCtx,
): void {
  const paths = expectations.map((entry) => stableJson(entry.partPath));
  if (new Set(paths).size !== paths.length)
    context.addIssue({
      code: "custom",
      path: ["materialExpectations"],
      message: "Roblox material expectation paths must be unique",
    });
}

function requireCanonicalIds<T>(
  values: readonly T[],
  identify: (value: T) => string,
  label: string,
  context: z.RefinementCtx,
): void {
  const ids = values.map(identify);
  if (
    new Set(ids).size !== ids.length ||
    stableJson(ids) !== stableJson([...ids].sort(compareCanonicalStrings))
  )
    context.addIssue({
      code: "custom",
      message: `${label} must have unique IDs in canonical order`,
    });
}
