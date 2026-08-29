import { z } from "zod";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import { entityId, hashSchema } from "../../spatial-core/src/primitives.js";
import {
  ASSET_CANONICAL_ROOT_SCHEMA,
  ASSET_COLLISION_METADATA_SCHEMA,
  ASSET_OUTPUT_REQUIREMENTS_SCHEMA,
  ASSET_SCALE_CLASSES,
  ASSET_SUPPORT_GEOMETRY_SCHEMA,
  MAXIMUM_ASSET_CONTACT_PATCHES_PER_CANDIDATE,
  MAXIMUM_COLLISION_SUPPORT_PATCHES_PER_CANDIDATE,
  deriveMeasuredAssetSurfaceKinds,
  type AssetOutputRequirements,
} from "../../asset-factory/src/contracts.js";
import {
  PLACEMENT_SURFACE_KINDS,
  PLACEMENT_SURFACE_KIND_SCHEMA,
} from "../../world-planning/src/contracts.js";

export const PREPARED_ASSET_ABI = "basalt-prepared-asset@4" as const;
export const PREPARED_ASSET_TARGET_PROFILE = "basalt-roblox-environment@2" as const;
export const ASSET_FINISHER_PROFILE = "basalt-asset-finisher@4" as const;

export const ASSET_VECTOR_SCHEMA = z
  .object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() })
  .strict();
export const ASSET_TRANSFORM_SCHEMA = z
  .object({
    position: ASSET_VECTOR_SCHEMA,
    rotation: z
      .object({
        xDegrees: z.number().finite(),
        yDegrees: z.number().finite(),
        zDegrees: z.number().finite(),
      })
      .strict(),
    scale: ASSET_VECTOR_SCHEMA.refine(
      ({ x, y, z }) => x > 0 && y > 0 && z > 0 && x <= 100 && y <= 100 && z <= 100,
      "Prepared transform scale must be positive and bounded",
    ),
  })
  .strict();
export const ASSET_BOUNDS_SCHEMA = z
  .object({ center: ASSET_VECTOR_SCHEMA, size: ASSET_VECTOR_SCHEMA })
  .strict()
  .refine((value) => value.size.x > 0 && value.size.y > 0 && value.size.z > 0, {
    message: "Asset bounds must have positive size on every axis",
  });

export const BINARY_ARTIFACT_SCHEMA = z
  .object({
    locator: z.string().regex(/^binary-artifacts\/[a-f0-9]{64}\.bin$/u),
    artifactHash: hashSchema,
    bytes: z
      .number()
      .int()
      .positive()
      .max(256 * 1024 * 1024),
    mediaType: z.string().min(3).max(160),
  })
  .strict();
export const JSON_ARTIFACT_SCHEMA = z
  .object({
    locator: z.string().regex(/^artifacts\/[a-f0-9]{64}\.json$/u),
    artifactHash: hashSchema,
    bytes: z
      .number()
      .int()
      .positive()
      .max(16 * 1024 * 1024),
  })
  .strict();

export const ASSET_TEXTURE_CHANNELS = [
  "base_color",
  "metallic_roughness",
  "normal",
  "occlusion",
  "opacity",
  "emissive",
] as const;

const preparedMaterial = z
  .object({
    name: z.string().trim().min(1).max(256),
    appearanceHash: hashSchema,
    textureChannels: z.array(z.enum(ASSET_TEXTURE_CHANNELS)).max(ASSET_TEXTURE_CHANNELS.length),
    alphaMode: z.enum(["OPAQUE", "MASK", "BLEND"]),
    alphaCutoff: z.number().finite().min(0).max(1).nullable(),
    opacityAuthority: z.enum(["none", "base_color_factor", "base_color_texture_alpha"]),
  })
  .strict()
  .refine(
    (value) => canonicalChannels(value.textureChannels) === stableJson(value.textureChannels),
    "Material texture channels must be unique and canonical",
  )
  .superRefine((value, context) => {
    const texturedOpacity = value.textureChannels.includes("opacity");
    if (
      value.alphaMode === "OPAQUE" &&
      (value.alphaCutoff !== null || value.opacityAuthority !== "none" || texturedOpacity)
    )
      context.addIssue({ code: "custom", message: "Opaque material cannot claim opacity" });
    if (
      value.alphaMode === "MASK" &&
      (value.alphaCutoff === null ||
        value.opacityAuthority !== "base_color_texture_alpha" ||
        !texturedOpacity)
    )
      context.addIssue({
        code: "custom",
        message: "Masked material requires cutoff and final base-color texture alpha authority",
      });
    if (
      value.alphaMode === "BLEND" &&
      (value.alphaCutoff !== null || value.opacityAuthority === "none")
    )
      context.addIssue({
        code: "custom",
        message: "Blended material requires one final alpha authority and no cutoff",
      });
    if (value.opacityAuthority === "base_color_texture_alpha" && !texturedOpacity)
      context.addIssue({
        code: "custom",
        message: "Texture alpha authority requires inspected opacity-channel evidence",
      });
    if (value.opacityAuthority === "base_color_factor" && texturedOpacity)
      context.addIssue({
        code: "custom",
        message: "Factor alpha authority cannot also claim texture opacity",
      });
  });

const preparedTexture = z
  .object({
    sha256: hashSchema,
    mediaType: z.enum(["image/png", "image/jpeg"]),
    width: z.number().int().positive().max(4096),
    height: z.number().int().positive().max(4096),
    alphaChannel: z.enum(["present", "absent"]),
  })
  .strict();

export const PREPARED_ASSET_MESH_SCHEMA = z
  .object({
    id: entityId,
    nodeName: z.string().trim().min(1).max(256),
    nodeTransform: z.literal("identity"),
    artifact: BINARY_ARTIFACT_SCHEMA.extend({ mediaType: z.literal("model/gltf-binary") }).strict(),
    bounds: ASSET_BOUNDS_SCHEMA,
    triangles: z.number().int().positive().max(20_000),
    hasNormals: z.boolean(),
    hasUv0: z.boolean(),
    materials: z.array(preparedMaterial).min(1).max(256),
    textures: z.array(preparedTexture).max(256),
  })
  .strict();

export const PREPARED_ASSET_PART_ROLES = [
  "render_static",
  "render_interactive",
  "collision_proxy",
] as const;

const preparedSocket = z
  .object({
    id: entityId,
    type: z.string().trim().min(1).max(80),
    localTransform: ASSET_TRANSFORM_SCHEMA,
  })
  .strict();

export const PREPARED_ASSET_PART_SCHEMA = z
  .object({
    id: entityId,
    name: z.string().trim().min(1).max(160),
    semanticRole: z.string().trim().min(1).max(160),
    role: z.enum(PREPARED_ASSET_PART_ROLES),
    visualGeometry: z.enum(["detailed_mesh", "primitive"]),
    meshId: entityId,
    placements: z.array(ASSET_TRANSFORM_SCHEMA).min(1).max(4096),
    pivot: ASSET_VECTOR_SCHEMA,
    sockets: z.array(preparedSocket).max(64),
    support: ASSET_SUPPORT_GEOMETRY_SCHEMA,
    collision: ASSET_COLLISION_METADATA_SCHEMA,
    surfaceKinds: z.array(PLACEMENT_SURFACE_KIND_SCHEMA).max(PLACEMENT_SURFACE_KINDS.length),
  })
  .strict()
  .superRefine((value, context) => {
    unique(
      value.sockets.map((socket) => socket.id),
      "Part socket IDs",
      context,
    );
    if (canonical(value.surfaceKinds) !== stableJson(value.surfaceKinds))
      context.addIssue({ code: "custom", message: "Surface kinds must be unique and canonical" });
    if (
      stableJson(value.surfaceKinds) !== stableJson(deriveMeasuredAssetSurfaceKinds(value.support))
    )
      context.addIssue({
        code: "custom",
        path: ["surfaceKinds"],
        message: "Prepared surface compatibility must derive from retained support",
      });
  });

export const PREPARED_ASSET_PREVIEW_VIEWS = [
  "hero_three_quarter",
  "opposite_three_quarter",
  "top",
] as const;
const preparedPreview = z
  .object({
    id: entityId,
    view: z.enum(PREPARED_ASSET_PREVIEW_VIEWS),
    artifact: BINARY_ARTIFACT_SCHEMA.extend({ mediaType: z.literal("image/png") }).strict(),
  })
  .strict();

const rightsClaim = z
  .object({
    id: entityId,
    sourceLabel: z.string().trim().min(1).max(256),
    licenseId: z.string().trim().min(1).max(256),
    usage: z.enum(["creator_owned", "commercial_use_permitted"]),
    attribution: z.string().max(2048),
    evidenceArtifact: BINARY_ARTIFACT_SCHEMA.extend({
      mediaType: z.literal("text/plain"),
    }).strict(),
  })
  .strict();

export const PREPARED_ASSET_OUTPUT_ADMISSION_SCHEMA = z
  .object({
    requirements: ASSET_OUTPUT_REQUIREMENTS_SCHEMA,
    requirementsHash: hashSchema,
    status: z.literal("pass"),
  })
  .strict()
  .superRefine((value, context) => {
    if (contentHash(stableJson(value.requirements)) !== value.requirementsHash)
      context.addIssue({
        code: "custom",
        path: ["requirementsHash"],
        message: "Prepared output requirement identity mismatch",
      });
  });

export const PREPARED_ASSET_SCHEMA = z
  .object({
    kind: z.literal("PreparedAsset"),
    abi: z.literal(PREPARED_ASSET_ABI),
    id: entityId,
    requirementHash: hashSchema,
    targetProfile: z.literal(PREPARED_ASSET_TARGET_PROFILE),
    coordinateFrame: z.literal("gltf-y-up-asset-units"),
    canonicalAxes: z
      .object({
        handedness: z.literal("right_handed"),
        up: z.literal("+Y"),
        forward: z.literal("-Z"),
      })
      .strict(),
    transformOwnership: z.literal("canonical_identity_nodes"),
    canonicalRoot: ASSET_CANONICAL_ROOT_SCHEMA,
    studsPerUnit: z.number().finite().positive().max(10_000),
    bounds: ASSET_BOUNDS_SCHEMA,
    physicalScale: z
      .object({
        class: z.enum(ASSET_SCALE_CLASSES),
        expectedBounds: ASSET_BOUNDS_SCHEMA,
      })
      .strict(),
    outputAdmission: PREPARED_ASSET_OUTPUT_ADMISSION_SCHEMA,
    geometry: z
      .object({
        uniqueTriangles: z.number().int().positive().max(2_000_000),
        renderedTriangles: z.number().int().positive().max(20_000_000),
        instanceCount: z.number().int().positive().max(65_536),
        meshes: z.array(PREPARED_ASSET_MESH_SCHEMA).min(1).max(512),
        parts: z.array(PREPARED_ASSET_PART_SCHEMA).min(1).max(512),
      })
      .strict(),
    previews: z.array(preparedPreview).length(PREPARED_ASSET_PREVIEW_VIEWS.length),
    rights: z
      .object({
        usage: z.enum(["creator_owned", "commercial_use_permitted"]),
        claims: z.array(rightsClaim).min(1).max(512),
      })
      .strict(),
    lineage: z
      .object({
        origin: z.enum(["trusted_procedure", "retrieval", "neural_asset"]),
        sourceCandidateHash: hashSchema,
        adaptedCandidateHash: hashSchema,
        lineageArtifact: JSON_ARTIFACT_SCHEMA,
        inputPreparedAssetHashes: z.array(hashSchema).max(512),
      })
      .strict(),
    preparation: z
      .object({
        profile: z.literal(ASSET_FINISHER_PROFILE),
        finisherWorkerHash: hashSchema,
        finisherQualificationHash: hashSchema,
        adapterId: entityId,
        adapterRevisionHash: hashSchema,
        adapterQualificationHash: hashSchema,
        postprocessorIdentityHash: hashSchema,
        adaptationReportArtifact: JSON_ARTIFACT_SCHEMA,
        geometryReportArtifact: JSON_ARTIFACT_SCHEMA,
        materialReportArtifact: JSON_ARTIFACT_SCHEMA,
        previewReportArtifact: JSON_ARTIFACT_SCHEMA,
        finishingReportArtifact: JSON_ARTIFACT_SCHEMA,
      })
      .strict(),
    localStatus: z.literal("eligible"),
    nativeStatus: z.literal("incomplete"),
    hash: hashSchema,
  })
  .strict()
  .superRefine((value, context) => {
    unique(
      value.geometry.meshes.map((mesh) => mesh.id),
      "Prepared mesh IDs",
      context,
    );
    unique(
      value.geometry.meshes.map((mesh) => mesh.nodeName),
      "Prepared mesh node names",
      context,
    );
    unique(
      value.geometry.parts.map((part) => part.id),
      "Prepared part IDs",
      context,
    );
    unique(
      value.previews.map((preview) => preview.id),
      "Prepared preview IDs",
      context,
    );
    unique(
      value.rights.claims.map((claim) => claim.id),
      "Rights claim IDs",
      context,
    );
    if (
      canonical(value.previews.map((preview) => preview.view)) !==
      canonical(PREPARED_ASSET_PREVIEW_VIEWS)
    )
      context.addIssue({
        code: "custom",
        message: "Prepared asset requires all three preview views",
      });
    const meshes = new Set(value.geometry.meshes.map((mesh) => mesh.id));
    const collisionSupportPatchCount = value.geometry.parts.reduce(
      (total, part) =>
        total + (part.collision.kind === "none" ? 0 : part.collision.supportPatches.length),
      0,
    );
    if (collisionSupportPatchCount > MAXIMUM_COLLISION_SUPPORT_PATCHES_PER_CANDIDATE)
      context.addIssue({
        code: "custom",
        message: "Prepared collision support patches exceed the asset budget",
      });
    const contactPatchCount = value.geometry.parts.reduce(
      (total, part) =>
        total + (part.support.kind === "surface_contact" ? part.support.contactPatches.length : 0),
      0,
    );
    if (contactPatchCount > MAXIMUM_ASSET_CONTACT_PATCHES_PER_CANDIDATE)
      context.addIssue({
        code: "custom",
        message: "Prepared contact patches exceed the asset budget",
      });
    for (const part of value.geometry.parts)
      if (!meshes.has(part.meshId))
        context.addIssue({
          code: "custom",
          message: `Prepared part references missing mesh: ${part.id}`,
        });
      else if (part.collision.kind !== "none" && !meshes.has(part.collision.meshId))
        context.addIssue({
          code: "custom",
          message: `Prepared part collision references missing mesh: ${part.id}`,
        });
    for (const defect of preparedOutputAdmissionDefects(
      value.outputAdmission.requirements,
      value.geometry.parts,
      value.geometry.meshes,
    ))
      context.addIssue({
        code: "custom",
        path: ["outputAdmission"],
        message: defect,
      });
    if (
      canonical(value.lineage.inputPreparedAssetHashes) !==
      stableJson(value.lineage.inputPreparedAssetHashes)
    )
      context.addIssue({
        code: "custom",
        message: "Prepared input hashes must be unique and canonical",
      });
  });

export type AssetVector = z.infer<typeof ASSET_VECTOR_SCHEMA>;
export type AssetTransform = z.infer<typeof ASSET_TRANSFORM_SCHEMA>;
export type AssetBounds = z.infer<typeof ASSET_BOUNDS_SCHEMA>;
export type PreparedAsset = z.infer<typeof PREPARED_ASSET_SCHEMA>;
export type PreparedAssetMesh = z.infer<typeof PREPARED_ASSET_MESH_SCHEMA>;
export type PreparedAssetPart = z.infer<typeof PREPARED_ASSET_PART_SCHEMA>;

export function sealPreparedAssetOutputAdmission(
  requirements: AssetOutputRequirements,
): z.infer<typeof PREPARED_ASSET_OUTPUT_ADMISSION_SCHEMA> {
  const parsed = ASSET_OUTPUT_REQUIREMENTS_SCHEMA.parse(requirements);
  return PREPARED_ASSET_OUTPUT_ADMISSION_SCHEMA.parse({
    requirements: parsed,
    requirementsHash: contentHash(stableJson(parsed)),
    status: "pass",
  });
}

export function assertPreparedAssetSatisfiesOutputRequirements(input: {
  readonly requirements: AssetOutputRequirements;
  readonly parts: readonly PreparedAssetPart[];
  readonly meshes: readonly PreparedAssetMesh[];
}): void {
  const defects = preparedOutputAdmissionDefects(input.requirements, input.parts, input.meshes);
  if (defects.length > 0) throw new Error(defects.join("; "));
}

function preparedOutputAdmissionDefects(
  requirements: AssetOutputRequirements,
  parts: readonly PreparedAssetPart[],
  meshes: readonly PreparedAssetMesh[],
): string[] {
  const defects: string[] = [];
  const partById = new Map(parts.map((part) => [part.id, part] as const));
  const meshById = new Map(meshes.map((mesh) => [mesh.id, mesh] as const));
  const presentRoles = new Set(parts.map((part) => part.role));
  for (const role of requirements.roles)
    if (!presentRoles.has(role)) defects.push(`Prepared asset lacks required output role: ${role}`);

  for (const requirement of requirements.semanticParts) {
    const part = partById.get(requirement.id);
    if (!part) {
      defects.push(`Prepared asset lacks required semantic part: ${requirement.id}`);
      continue;
    }
    if (
      part.name !== requirement.name ||
      part.semanticRole !== requirement.semanticRole ||
      part.role !== requirement.role
    )
      defects.push(`Prepared semantic part differs from its exact requirement: ${requirement.id}`);
    if (
      requirement.pivot.kind === "required" &&
      ![part.pivot.x, part.pivot.y, part.pivot.z].every(Number.isFinite)
    )
      defects.push(`Prepared semantic part lacks a finite functional pivot: ${requirement.id}`);
    const sockets = new Map(part.sockets.map((socket) => [socket.id, socket] as const));
    for (const requiredSocket of requirement.sockets) {
      const socket = sockets.get(requiredSocket.id);
      if (!socket || socket.type !== requiredSocket.type)
        defects.push(
          `Prepared semantic part lacks required socket: ${requirement.id}/${requiredSocket.id}`,
        );
    }
  }

  if (requirements.articulation.kind === "required")
    for (const partId of requirements.articulation.partIds) {
      const part = partById.get(partId);
      if (!part || part.role !== "render_interactive")
        defects.push(`Prepared asset lacks required articulated part: ${partId}`);
    }

  const transparentPartIds = new Set(
    parts.flatMap((part) => {
      if (part.role === "collision_proxy") return [];
      const mesh = meshById.get(part.meshId);
      return mesh?.materials.some((material) => material.alphaMode !== "OPAQUE") ? [part.id] : [];
    }),
  );
  if (requirements.transparency.kind === "required")
    for (const partId of requirements.transparency.partIds)
      if (!transparentPartIds.has(partId))
        defects.push(`Prepared asset lacks required transparent material evidence: ${partId}`);
  if (requirements.transparency.kind === "forbidden" && transparentPartIds.size > 0)
    defects.push("Prepared asset contains forbidden transparent material evidence");

  if (requirements.collision.kind === "required")
    for (const partId of requirements.collision.partIds) {
      const part = partById.get(partId);
      if (!part || part.collision.kind === "none")
        defects.push(`Prepared asset lacks required collision evidence: ${partId}`);
    }

  for (const operation of requirements.editOperations) {
    const part = partById.get(operation.partId);
    if (!part) {
      defects.push(`Prepared asset cannot perform edit on absent part: ${operation.partId}`);
      continue;
    }
    if (
      operation.kind === "attach_to_socket" &&
      !part.sockets.some((socket) => socket.id === operation.socketId)
    )
      defects.push(
        `Prepared asset cannot perform socket edit: ${operation.partId}/${operation.socketId}`,
      );
    if (operation.kind === "replace_part_material" && !meshById.get(part.meshId)?.materials.length)
      defects.push(`Prepared asset cannot perform material edit: ${operation.partId}`);
    if (
      operation.kind === "rotate_part" &&
      ![part.pivot.x, part.pivot.y, part.pivot.z].every(Number.isFinite)
    )
      defects.push(`Prepared asset cannot perform pivoted rotation: ${operation.partId}`);
  }
  return defects;
}

function canonical(values: readonly string[]): string {
  return stableJson([...new Set(values)].sort());
}

function canonicalChannels(values: readonly (typeof ASSET_TEXTURE_CHANNELS)[number][]): string {
  const present = new Set(values);
  return stableJson(ASSET_TEXTURE_CHANNELS.filter((channel) => present.has(channel)));
}

function unique(values: readonly string[], subject: string, context: z.RefinementCtx): void {
  if (new Set(values).size !== values.length)
    context.addIssue({ code: "custom", message: `${subject} must be unique` });
}
