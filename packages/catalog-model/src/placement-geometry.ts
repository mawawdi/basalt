import { z } from "zod";
import { HASH_SCHEMA, contentHash, deepFreezeJson, stableJson } from "@basalt/contracts";

const vector = z
  .object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() })
  .strict();
export const ASSET_PLACEMENT_GEOMETRY_SCHEMA = z
  .object({
    kind: z.literal("AssetPlacementGeometry"),
    assetHash: HASH_SCHEMA,
    sourceContentHash: HASH_SCHEMA,
    geometryHash: HASH_SCHEMA,
    method: z.literal("triangle_height_bands"),
    bands: z
      .array(
        z
          .object({ min: vector, max: vector })
          .strict()
          .refine(
            ({ min, max }) => min.x < max.x && min.y < max.y && min.z < max.z,
            "Placement bands require positive volume",
          ),
      )
      .min(1)
      .max(64),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    const { hash, ...material } = value;
    if (contentHash(stableJson(material)) !== hash)
      context.addIssue({
        code: "custom",
        path: ["hash"],
        message: "Placement geometry hash mismatch",
      });
  });
export type AssetPlacementGeometry = z.output<typeof ASSET_PLACEMENT_GEOMETRY_SCHEMA>;

/** Measurements are produced from verified source bytes, never from agent-supplied proxies. */
export function sealAssetPlacementGeometry(
  input: Omit<AssetPlacementGeometry, "kind" | "method" | "hash">,
): AssetPlacementGeometry {
  const material = {
    kind: "AssetPlacementGeometry" as const,
    method: "triangle_height_bands" as const,
    ...input,
  };
  return deepFreezeJson(
    ASSET_PLACEMENT_GEOMETRY_SCHEMA.parse({ ...material, hash: contentHash(stableJson(material)) }),
  );
}
