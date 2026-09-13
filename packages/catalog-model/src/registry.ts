import { z } from "zod";
import { HASH_SCHEMA, compareCanonicalStrings } from "@basalt/contracts";

export const TRUSTED_SOURCE_MANIFEST_SCHEMA = z
  .object({
    kind: z.literal("TrustedSourceManifest"),
    rightsNotice: z.string().min(1).max(4096),
    packages: z
      .array(
        z
          .object({
            packageId: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/u),
            archivePaths: z.array(z.string().min(1).max(4096)).max(64),
            assetRoots: z.array(z.string().min(1).max(4096)).min(1).max(64),
            sourceKind: z.enum(["creator_owned", "licensed", "generated"]),
            licenseId: z.string().min(1).max(160),
            commercialUsePermitted: z.boolean(),
            redistributionPermitted: z.boolean(),
            attribution: z.string().max(2048),
            files: z
              .array(
                z
                  .object({
                    relativePath: z.string().min(1).max(4096),
                    sha256: HASH_SCHEMA,
                    metersPerSourceUnit: z.number().finite().positive(),
                  })
                  .strict(),
              )
              .max(100_000),
          })
          .strict(),
      )
      .min(1)
      .max(4096),
  })
  .strict()
  .superRefine((value, context) => {
    const paths = value.packages.flatMap((entry) =>
      entry.files.map((file) => `${entry.packageId}:${file.relativePath}`),
    );
    if (new Set(paths).size !== paths.length)
      context.addIssue({ code: "custom", message: "Source paths must be unique" });
    const packageIds = value.packages.map((entry) => entry.packageId);
    if (new Set(packageIds).size !== packageIds.length)
      context.addIssue({ code: "custom", message: "Source package IDs must be unique" });
    if (
      packageIds.some(
        (id, index) => index > 0 && compareCanonicalStrings(packageIds[index - 1]!, id) >= 0,
      )
    )
      context.addIssue({ code: "custom", message: "Source packages must use canonical order" });
  });
export type TrustedSourceManifest = z.output<typeof TRUSTED_SOURCE_MANIFEST_SCHEMA>;
