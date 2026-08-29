import { z } from "zod";
import {
  ASSET_BINARY_ARTIFACT_REFERENCE_SCHEMA,
  ASSET_BOUNDS_SCHEMA,
} from "../../asset-factory/src/contracts.js";
import { entityId, hashSchema } from "../../spatial-core/src/primitives.js";

export const REGIONAL_PLANNING_INVENTORY_ABI = "basalt-regional-planning-inventory@1" as const;
export const REGIONAL_PLAN_ABI = "basalt-regional-plan@1" as const;
export const PERSPECTIVE_CAMERA_CALIBRATION_ABI =
  "basalt-perspective-camera-calibration@1" as const;
export const CROP_SIMILARITY_ABI = "basalt-crop-similarity@1" as const;
export const REGION_VIEW_CELL_ABI = "basalt-region-view-cell@1" as const;
export const REGION_COMPOSITION_PROPOSAL_ABI = "basalt-region-composition-proposal@2" as const;
export const PREPARED_ASSET_PROJECTION_CALIBRATION_ABI =
  "basalt-prepared-asset-projection-calibration@1" as const;
export const REGION_COMPOSITION_PLACEMENT_CANDIDATES_ABI =
  "basalt-region-composition-placement-candidates@2" as const;

const finite = z.number().finite();
const vector2 = z.object({ x: finite, y: finite }).strict();
const vector3 = z.object({ x: finite, y: finite, z: finite }).strict();
const quaternion = z
  .object({ x: finite, y: finite, z: finite, w: finite })
  .strict()
  .refine(
    (value) => Math.abs(Math.hypot(value.x, value.y, value.z, value.w) - 1) <= 1e-8,
    "Quaternion must be normalized",
  )
  .refine(
    (value) =>
      value.w > 0 ||
      (value.w === 0 &&
        (value.z > 0 || (value.z === 0 && (value.y > 0 || (value.y === 0 && value.x >= 0))))),
    "Quaternion sign must be canonical",
  );
const matrix3 = z.tuple([finite, finite, finite, finite, finite, finite, finite, finite, finite]);
const matrix4 = z.tuple([
  finite,
  finite,
  finite,
  finite,
  finite,
  finite,
  finite,
  finite,
  finite,
  finite,
  finite,
  finite,
  finite,
  finite,
  finite,
  finite,
]);

export const REGIONAL_PLACEMENT_AUTHORITY_SCHEMA = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("surface"), surfaceIds: z.array(entityId).min(1).max(256) }).strict(),
  z.object({ kind: z.literal("world_anchor"), anchorId: entityId }).strict(),
  z
    .object({
      kind: z.literal("asset_socket"),
      targetDeclarationId: entityId,
      socketType: z.string().trim().min(1).max(160),
    })
    .strict(),
]);

const regionalRequirement = z
  .object({
    requirementId: entityId,
    declarationId: entityId,
    requirementHash: hashSchema,
    placementConstraintHash: hashSchema,
    primaryRegionId: entityId,
    regionIds: z.array(entityId).min(1).max(64),
    required: z.boolean(),
    state: z.enum(["absent", "prepared", "placed"]),
    placementAuthority: REGIONAL_PLACEMENT_AUTHORITY_SCHEMA,
  })
  .strict();

export const REGIONAL_PLANNING_INVENTORY_SCHEMA = z
  .object({
    kind: z.literal("RegionalPlanningInventory"),
    abi: z.literal(REGIONAL_PLANNING_INVENTORY_ABI),
    id: entityId,
    hash: hashSchema,
    worldPlanHash: hashSchema,
    surfaceIndexHash: hashSchema,
    globalFoundationHash: hashSchema,
    styleContractHash: hashSchema,
    requirements: z.array(regionalRequirement).max(8192),
  })
  .strict();

const regionalBlocker = z.enum([
  "dependency_cycle",
  "missing_region_camera",
  "surface_region_mismatch",
]);

const regionalDecision = z
  .object({
    regionId: entityId,
    disposition: z.enum(["selected", "complete", "deferred", "blocked"]),
    rank: z.number().int().nonnegative().optional(),
    refinementPriority: z.number().int().min(0).max(1_000_000),
    functionalRole: z.string().trim().min(1).max(1024),
    requirementIds: z.array(entityId).max(8192),
    placementConstraintHashes: z.array(hashSchema).max(8192),
    placementSurfaceIds: z.array(entityId).max(1024),
    appearanceContractHash: hashSchema,
    regionFoundationHash: hashSchema,
    cameraId: entityId.optional(),
    cameraCalibrationHash: hashSchema.optional(),
    blockedBy: z.array(regionalBlocker).max(3),
    assetExecutorRequired: z.literal(false),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.disposition === "selected") !== (value.rank !== undefined))
      context.addIssue({ code: "custom", message: "Only selected regions have a rank" });
    if ((value.cameraId !== undefined) !== (value.cameraCalibrationHash !== undefined))
      context.addIssue({ code: "custom", message: "Regional camera identity must be complete" });
    if ((value.disposition === "blocked") !== value.blockedBy.length > 0)
      context.addIssue({ code: "custom", message: "Blocked regions require exact blockers" });
  });

export const REGIONAL_PLAN_SCHEMA = z
  .object({
    kind: z.literal("RegionalPlan"),
    abi: z.literal(REGIONAL_PLAN_ABI),
    id: entityId,
    hash: hashSchema,
    worldPlanHash: hashSchema,
    surfaceIndexHash: hashSchema,
    globalFoundationHash: hashSchema,
    inventoryHash: hashSchema,
    selectionPolicy: z
      .object({
        maximumRegions: z.number().int().min(1).max(256),
        includeOptionalRequirements: z.boolean(),
      })
      .strict(),
    selectedRegionIds: z.array(entityId).max(256),
    decisions: z.array(regionalDecision).min(1).max(256),
    status: z.enum(["eligible", "incomplete"]),
  })
  .strict();

export const PERSPECTIVE_CAMERA_CALIBRATION_SCHEMA = z
  .object({
    kind: z.literal("PerspectiveCameraCalibration"),
    abi: z.literal(PERSPECTIVE_CAMERA_CALIBRATION_ABI),
    id: entityId,
    hash: hashSchema,
    cameraId: entityId,
    sourceCameraHash: hashSchema,
    width: z.number().int().min(1).max(8192),
    height: z.number().int().min(1).max(8192),
    verticalFieldOfViewDegrees: finite.min(1).max(120),
    nearClip: finite.positive(),
    farClip: finite.positive(),
    coordinateConvention: z.literal("pixel_boundary_top_left_x_right_y_down_camera_z_forward"),
    intrinsics: matrix3,
    worldToCamera: matrix4,
    cameraToWorld: matrix4,
  })
  .strict()
  .refine((value) => value.nearClip < value.farClip, "Camera clipping range must be ordered");

export const CROP_SIMILARITY_SCHEMA = z
  .object({
    kind: z.literal("CropSimilarity"),
    abi: z.literal(CROP_SIMILARITY_ABI),
    id: entityId,
    hash: hashSchema,
    cameraCalibrationHash: hashSchema,
    sourceSize: z
      .object({ width: z.number().int().positive(), height: z.number().int().positive() })
      .strict(),
    outputSize: z
      .object({ width: z.number().int().positive(), height: z.number().int().positive() })
      .strict(),
    scale: finite.positive(),
    rotationRadians: finite,
    translation: vector2,
    sourceToCrop: matrix3,
    cropToSource: matrix3,
    derivedIntrinsics: matrix3,
    effectiveFocalPixels: finite.positive(),
  })
  .strict();

export const REGION_VIEW_CELL_SCHEMA = z
  .object({
    kind: z.literal("RegionViewCell"),
    abi: z.literal(REGION_VIEW_CELL_ABI),
    id: entityId,
    hash: hashSchema,
    regionalPlanHash: hashSchema,
    worldPlanHash: hashSchema,
    surfaceIndexHash: hashSchema,
    globalFoundationHash: hashSchema,
    regionId: entityId,
    regionFoundationHash: hashSchema,
    styleContractHash: hashSchema,
    ordinal: z.number().int().min(0).max(3),
    coverageReason: z.enum(["primary_composition", "occluded_surface", "vertical_layer"]),
    compositionCamera: PERSPECTIVE_CAMERA_CALIBRATION_SCHEMA,
    validationCameras: z.array(PERSPECTIVE_CAMERA_CALIBRATION_SCHEMA).max(8),
    visibleSurfaceIds: z.array(entityId).max(1024),
    requirementIds: z.array(entityId).min(1).max(8192),
    rationale: z.string().trim().min(1).max(2048),
    authority: z.literal(
      "retained_camera_calibrations_bind_every_render_and_composition_pixels_remain_advisory",
    ),
    assetExecutorRequired: z.literal(false),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.ordinal === 0) !== (value.coverageReason === "primary_composition"))
      context.addIssue({
        code: "custom",
        message: "Only the primary region view cell may use primary-composition coverage",
      });
    const cameraHashes = [
      value.compositionCamera.hash,
      ...value.validationCameras.map((camera) => camera.hash),
    ];
    if (new Set(cameraHashes).size !== cameraHashes.length)
      context.addIssue({ code: "custom", message: "Region-view cameras must be unique" });
  });

const pngArtifact = ASSET_BINARY_ARTIFACT_REFERENCE_SCHEMA.safeExtend({
  mediaType: z.literal("image/png"),
}).strict();

const imageBounds = z
  .object({
    x: z.number().int().nonnegative().max(8191),
    y: z.number().int().nonnegative().max(8191),
    width: z.number().int().positive().max(8192),
    height: z.number().int().positive().max(8192),
  })
  .strict();

const compositionImage = z
  .object({
    artifact: pngArtifact,
    width: z.number().int().positive().max(8192),
    height: z.number().int().positive().max(8192),
    colorSpace: z.literal("srgb"),
    alphaMode: z.enum(["opaque", "straight"]),
  })
  .strict();

const proposalProducerLineage = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("qualified_generated"),
      producerId: entityId,
      modelId: z.string().trim().min(1).max(512),
      modelRevisionHash: hashSchema,
      producerQualificationHash: hashSchema,
      dependencyInventoryHash: hashSchema,
      requestHash: hashSchema,
      responseReceiptHash: hashSchema,
      seed: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    })
    .strict(),
  z
    .object({
      kind: z.literal("creator_supplied"),
      producerId: entityId,
      ingestReceiptHash: hashSchema,
    })
    .strict(),
]);

const segmentationLineage = z
  .object({
    kind: z.literal("qualified_segmentation"),
    segmenterId: entityId,
    modelId: z.string().trim().min(1).max(512),
    modelRevisionHash: hashSchema,
    qualificationHash: hashSchema,
    dependencyInventoryHash: hashSchema,
    requestHash: hashSchema,
    responseReceiptHash: hashSchema,
    sourceImageHash: hashSchema,
    randomness: z.literal("disabled"),
  })
  .strict();

const maskRayAnchor = z
  .object({
    id: entityId,
    priority: z.number().int().nonnegative().max(255),
    role: z.enum(["support", "center", "attachment"]),
    pixel: vector2,
  })
  .strict();

const compositionInstanceMask = z
  .object({
    id: entityId,
    artifact: pngArtifact,
    width: z.number().int().positive().max(8192),
    height: z.number().int().positive().max(8192),
    coordinateConvention: z.literal("crop_pixel_boundary_top_left_x_right_y_down"),
    bounds: imageBounds,
    centroid: vector2,
    coveredPixels: z
      .number()
      .int()
      .positive()
      .max(8192 * 8192),
    rayAnchors: z.array(maskRayAnchor).min(1).max(32),
  })
  .strict();

const compositionTarget = z
  .object({
    id: entityId,
    requirementId: entityId,
    semanticRole: z.string().trim().min(1).max(1024),
    placementConstraintHash: hashSchema,
    placementSurfaceIds: z.array(entityId).min(1).max(1024),
    maskIds: z.array(entityId).min(1).max(128),
  })
  .strict();

const unmatchedGeneratedContent = z
  .object({
    id: entityId,
    description: z.string().trim().min(1).max(2048),
    maskIds: z.array(entityId).min(1).max(128),
    disposition: z.literal("advisory_only_no_requirement_authority"),
  })
  .strict();

export const REGION_COMPOSITION_PROPOSAL_SCHEMA = z
  .object({
    kind: z.literal("RegionCompositionProposal"),
    abi: z.literal(REGION_COMPOSITION_PROPOSAL_ABI),
    id: entityId,
    hash: hashSchema,
    regionalPlanHash: hashSchema,
    worldPlanHash: hashSchema,
    surfaceIndexHash: hashSchema,
    globalFoundationHash: hashSchema,
    regionId: entityId,
    regionFoundationHash: hashSchema,
    regionViewCellHash: hashSchema,
    styleContractHash: hashSchema,
    contextRenderHash: hashSchema,
    compositionIndex: z.number().int().nonnegative().max(255),
    authority: z.literal("advisory_pixels_only_typed_world_plan_and_relation_solver_are_final"),
    image: compositionImage,
    cameraCalibration: PERSPECTIVE_CAMERA_CALIBRATION_SCHEMA,
    cropSimilarity: CROP_SIMILARITY_SCHEMA,
    producerLineage: proposalProducerLineage,
    segmentationLineage,
    rightsEvidenceHashes: z.array(hashSchema).min(1).max(64),
    instanceMasks: z.array(compositionInstanceMask).min(1).max(2048),
    targets: z.array(compositionTarget).min(1).max(2048),
    unmatchedGeneratedContent: z.array(unmatchedGeneratedContent).max(2048),
  })
  .strict();

export const PREPARED_ASSET_PROJECTION_CALIBRATION_SCHEMA = z
  .object({
    kind: z.literal("PreparedAssetProjectionCalibration"),
    abi: z.literal(PREPARED_ASSET_PROJECTION_CALIBRATION_ABI),
    id: entityId,
    hash: hashSchema,
    proposalHash: hashSchema,
    targetId: entityId,
    preparedAssetHash: hashSchema,
    preparedAssetBounds: ASSET_BOUNDS_SCHEMA,
    preparedAssetTransformOwnership: z.literal("canonical_identity_nodes"),
    targetMaskIds: z.array(entityId).min(1).max(128),
    targetImageSize: z
      .object({
        width: z.number().int().positive().max(8192),
        height: z.number().int().positive().max(8192),
      })
      .strict(),
    targetMaskBounds: imageBounds,
    projectionCamera: PERSPECTIVE_CAMERA_CALIBRATION_SCHEMA,
    projectionImage: compositionImage,
    silhouetteMask: z
      .object({
        artifact: pngArtifact,
        width: z.number().int().positive().max(8192),
        height: z.number().int().positive().max(8192),
        colorSpace: z.literal("linear"),
        alphaMode: z.literal("opaque"),
      })
      .strict(),
    candidateMaskBounds: imageBounds,
    candidateMaskCentroid: vector2,
    assetToProjectionCameraRotation: quaternion,
    renderUniformScale: finite.positive(),
    assetCenterDepth: finite.positive(),
    apparentTransfer: z
      .object({
        targetSpanPixels: finite.positive(),
        candidateSpanPixels: finite.positive(),
        targetToCandidateRatio: finite.positive(),
        spanMetric: z.literal("geometric_mean_width_height"),
      })
      .strict(),
    fit: z
      .object({
        maskIntersectionOverUnion: finite.min(0).max(1),
        silhouetteCoverage: finite.min(0).max(1),
        centroidErrorPixels: finite.nonnegative(),
        aspectLogError: finite.nonnegative(),
      })
      .strict(),
    transformApplication: z.literal(
      "projection_rotation_and_render_scale_are_measured_once_and_are_not_baked_into_prepared_nodes",
    ),
    localStatus: z.literal("eligible"),
  })
  .strict();

const placementRayHit = z
  .object({
    surfaceId: entityId,
    triangleIndex: z.number().int().nonnegative(),
    distance: finite.nonnegative(),
    barycentricWeights: z.tuple([finite, finite, finite]),
    position: vector3,
    normal: vector3,
    cameraDepth: finite.positive(),
  })
  .strict();

const compositionPlacementCandidate = z
  .object({
    id: entityId,
    rank: z.number().int().nonnegative().max(4095),
    maskId: entityId,
    rayAnchorId: entityId,
    anchorRole: z.enum(["support", "center", "attachment"]),
    cropPixel: vector2,
    sourcePixel: vector2,
    ray: z
      .object({
        origin: vector3,
        direction: vector3,
        nearPoint: vector3,
        farPoint: vector3,
        minimumDistance: finite.nonnegative(),
        maximumDistance: finite.positive(),
      })
      .strict()
      .refine(
        (value) => value.minimumDistance < value.maximumDistance,
        "Calibrated ray clipping range must be ordered",
      ),
    hit: placementRayHit,
    suggestedTransform: z
      .object({
        position: vector3,
        rotation: quaternion,
        uniformScale: finite.positive(),
      })
      .strict(),
    scaleTransfer: z
      .object({
        targetFocalPixels: finite.positive(),
        projectionFocalPixels: finite.positive(),
        targetCameraDepth: finite.positive(),
        projectionCameraDepth: finite.positive(),
        apparentScaleRatio: finite.positive(),
        renderUniformScale: finite.positive(),
        formula: z.literal(
          "render_scale*apparent_ratio*target_depth*projection_focal/(projection_depth*target_focal)",
        ),
      })
      .strict(),
    authority: z.literal("advisory_seed_requires_typed_relation_solver_revalidation"),
  })
  .strict();

const compositionPlacementFailure = z
  .object({
    maskId: entityId,
    rayAnchorId: entityId,
    surfaceId: entityId,
    code: z.literal("no_surface_hit"),
  })
  .strict();

export const REGION_COMPOSITION_PLACEMENT_CANDIDATES_SCHEMA = z
  .object({
    kind: z.literal("RegionCompositionPlacementCandidates"),
    abi: z.literal(REGION_COMPOSITION_PLACEMENT_CANDIDATES_ABI),
    id: entityId,
    hash: hashSchema,
    proposalHash: hashSchema,
    worldPlanHash: hashSchema,
    projectionCalibrationHash: hashSchema,
    targetId: entityId,
    preparedAssetHash: hashSchema,
    surfaceIndexHash: hashSchema,
    targetMaskIds: z.array(entityId).min(1).max(128),
    authority: z.literal("candidate_order_only_typed_relation_solver_is_final"),
    candidates: z.array(compositionPlacementCandidate).max(4096),
    failures: z.array(compositionPlacementFailure).max(4096),
    status: z.enum(["eligible", "incomplete"]),
  })
  .strict();

export type RegionalPlacementAuthority = z.infer<typeof REGIONAL_PLACEMENT_AUTHORITY_SCHEMA>;
export type RegionalPlanningInventory = z.infer<typeof REGIONAL_PLANNING_INVENTORY_SCHEMA>;
export type RegionalPlan = z.infer<typeof REGIONAL_PLAN_SCHEMA>;
export type PerspectiveCameraCalibration = z.infer<typeof PERSPECTIVE_CAMERA_CALIBRATION_SCHEMA>;
export type CropSimilarity = z.infer<typeof CROP_SIMILARITY_SCHEMA>;
export type RegionViewCell = z.infer<typeof REGION_VIEW_CELL_SCHEMA>;
export type RegionCompositionProposal = z.infer<typeof REGION_COMPOSITION_PROPOSAL_SCHEMA>;
export type PreparedAssetProjectionCalibration = z.infer<
  typeof PREPARED_ASSET_PROJECTION_CALIBRATION_SCHEMA
>;
export type RegionCompositionPlacementCandidates = z.infer<
  typeof REGION_COMPOSITION_PLACEMENT_CANDIDATES_SCHEMA
>;
export type Matrix3 = z.infer<typeof matrix3>;
export type Matrix4 = z.infer<typeof matrix4>;
export type ImagePoint = z.infer<typeof vector2>;
export type ImageBounds = z.infer<typeof imageBounds>;
export type CanonicalQuaternion = z.infer<typeof quaternion>;
