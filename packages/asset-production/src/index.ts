import { z } from "zod";
import { HASH_SCHEMA, contentHash, stableJson } from "@basalt/contracts";

/** Blender is invoked only for one asset at a time, never for a whole map. */
export const ASSET_FINISHING_PROFILE_SCHEMA = z
  .object({
    kind: z.literal("BasaltAssetFinishingProfile"),
    workerId: z.string().min(1).max(160),
    workerImplementationHash: HASH_SCHEMA,
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
    profileHash: HASH_SCHEMA,
  })
  .strict();
export type AssetFinishingProfile = z.infer<typeof ASSET_FINISHING_PROFILE_SCHEMA>;

export function sealAssetFinishingProfile(
  input: Omit<AssetFinishingProfile, "kind" | "profileHash">,
): AssetFinishingProfile {
  const material = {
    kind: "BasaltAssetFinishingProfile",
    ...input,
  } as const;
  return ASSET_FINISHING_PROFILE_SCHEMA.parse({
    ...material,
    profileHash: contentHash(stableJson(material)),
  });
}
