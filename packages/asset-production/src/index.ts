import { z } from "zod";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import { hashSchema } from "../../spatial-core/src/primitives.js";

/** Blender is invoked only for one asset at a time, never for a whole map. */
export const BASALT_ASSET_FINISHING_ABI = "basalt-asset-finishing@1" as const;
export const ASSET_FINISHING_PROFILE_SCHEMA = z
  .object({
    kind: z.literal("BasaltAssetFinishingProfile"),
    abi: z.literal(BASALT_ASSET_FINISHING_ABI),
    workerId: z.string().min(1).max(160),
    workerRevisionHash: hashSchema,
    operations: z
      .array(
        z.enum([
          "bake_transforms",
          "repair_normals",
          "atlas_uv",
          "bake_pbr",
          "weld_sockets",
          "build_physical_proxy",
          "render_asset_previews",
        ]),
      )
      .min(1)
      .max(16),
    wholeSceneRendering: z.literal(false),
    maxPreviewPixels: z.number().int().positive().max(4_194_304),
    profileHash: hashSchema,
  })
  .strict();
export type AssetFinishingProfile = z.infer<typeof ASSET_FINISHING_PROFILE_SCHEMA>;

export function sealAssetFinishingProfile(
  input: Omit<AssetFinishingProfile, "kind" | "abi" | "profileHash">,
): AssetFinishingProfile {
  const material = {
    kind: "BasaltAssetFinishingProfile",
    abi: BASALT_ASSET_FINISHING_ABI,
    ...input,
  } as const;
  return ASSET_FINISHING_PROFILE_SCHEMA.parse({
    ...material,
    profileHash: contentHash(stableJson(material)),
  });
}
