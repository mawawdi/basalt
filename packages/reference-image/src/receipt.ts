import { z } from "zod";
import {
  COMPILATION_STATUS_SCHEMA,
  HASH_SCHEMA,
  compareCanonicalStrings,
  contentHash,
  deepFreezeJson,
  stableJson,
} from "@basalt/contracts";

export const REFERENCE_IMAGE_OUTPUT_SCHEMA = z
  .object({
    artifactHash: HASH_SCHEMA,
    bytes: z
      .number()
      .int()
      .positive()
      .max(512 * 1024 * 1024),
    mediaType: z.enum(["image/png", "image/webp"]),
    role: z.enum(["reference", "mask", "depth", "diagnostic"]),
  })
  .strict();

export const REFERENCE_IMAGE_RECEIPT_SCHEMA = z
  .object({
    kind: z.literal("ReferenceImageReceipt"),
    requestHash: HASH_SCHEMA,
    status: COMPILATION_STATUS_SCHEMA,
    adapterId: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u),
    modelImplementationHash: HASH_SCHEMA,
    outputs: z.array(REFERENCE_IMAGE_OUTPUT_SCHEMA),
    resourceUse: z
      .object({
        wallMilliseconds: z.number().int().nonnegative(),
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
      })
      .strict(),
    diagnostics: z.array(z.string().trim().min(1).max(2048)),
    compilerAuthority: z.literal(false),
    receiptHash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.status === "eligible") !== value.outputs.length > 0)
      context.addIssue({ code: "custom", message: "Only eligible receipts contain outputs" });
    const { receiptHash: _receiptHash, ...material } = value;
    if (contentHash(stableJson(material)) !== value.receiptHash)
      context.addIssue({ code: "custom", path: ["receiptHash"], message: "Receipt hash mismatch" });
  });
export type ReferenceImageReceipt = z.output<typeof REFERENCE_IMAGE_RECEIPT_SCHEMA>;

export function sealReferenceImageReceipt(
  input: Omit<ReferenceImageReceipt, "kind" | "compilerAuthority" | "receiptHash">,
): ReferenceImageReceipt {
  const material = {
    kind: "ReferenceImageReceipt" as const,
    ...input,
    outputs: [...input.outputs].sort((left, right) =>
      compareCanonicalStrings(left.artifactHash, right.artifactHash),
    ),
    diagnostics: [...input.diagnostics].sort(compareCanonicalStrings),
    compilerAuthority: false as const,
  };
  return deepFreezeJson(
    REFERENCE_IMAGE_RECEIPT_SCHEMA.parse({
      ...material,
      receiptHash: contentHash(stableJson(material)),
    }),
  );
}
