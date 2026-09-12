import { z } from "zod";
import {
  aabbFixedSchema,
  Q32_32_SCHEMA,
  q32Vector3Schema,
  type AABBFixed,
  type Q32_32,
  type Vector3Fixed,
} from "./fixed.js";

export const BASALT_CATALOG_TYPES_ABI = "basalt-catalog-types@1" as const;
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);

export const collisionProxySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("None") }).strict(),
  z.object({ type: z.literal("Box") }).strict(),
  z
    .object({ type: z.literal("SingleConvexHull"), vertexCount: z.number().int().nonnegative() })
    .strict(),
  z
    .object({
      type: z.literal("CompoundConvexHulls"),
      hullCount: z.number().int().positive(),
      maxTriangles: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      type: z.literal("PreciseMeshHACD"),
      decompositionResolution: z.number().int().positive(),
    })
    .strict(),
]);
export type CollisionProxy = z.infer<typeof collisionProxySchema>;

export const textureFactsSchema = z
  .object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    format: z.enum(["BC7", "ASTC_4x4", "PNG_PBR"]),
    texelDensityPxPerMeter: Q32_32_SCHEMA,
    channelHash: hashSchema,
  })
  .strict();
export type TextureFacts = z.infer<typeof textureFactsSchema>;

export const catalogAssetRecordSchema = z
  .object({
    assetId: z.string().min(1).max(128),
    sourceFileHash: hashSchema,
    canonicalName: z.string().trim().min(1).max(256),
    boundingBox: aabbFixedSchema,
    pivotOffsetFromBottomCenter: q32Vector3Schema,
    triangleCount: z.number().int().nonnegative(),
    vertexCount: z.number().int().nonnegative(),
    submeshCount: z.number().int().nonnegative(),
    materialSlotCount: z.number().int().nonnegative(),
    textures: z.array(textureFactsSchema).max(512),
    collisionProxy: collisionProxySchema,
    topologicalGenus: z.number().int(),
    semanticTags: z.array(z.string().trim().min(1).max(128)).max(128),
    isManifold: z.boolean(),
    admissionStatus: z.enum(["pending", "locally_qualified", "incomplete", "quarantined"]),
    merkleLeafHash: hashSchema,
  })
  .strict();
export type CatalogAssetRecord = z.infer<typeof catalogAssetRecordSchema>;

export type { AABBFixed, Q32_32, Vector3Fixed };
