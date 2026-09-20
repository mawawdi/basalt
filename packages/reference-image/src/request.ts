import { z } from "zod";
import {
  HASH_SCHEMA,
  contentAddressedEntityId,
  contentHash,
  deepFreezeJson,
  stableJson,
} from "@basalt/contracts";

const imageConstraintSchema = z
  .object({
    widthPixels: z.number().int().positive().max(8192),
    heightPixels: z.number().int().positive().max(8192),
    alpha: z.enum(["forbidden", "permitted", "required"]),
    colorSpace: z.literal("srgb"),
  })
  .strict();

export const REFERENCE_IMAGE_REQUEST_SCHEMA = z
  .object({
    kind: z.literal("ReferenceImageRequest"),
    requestId: z.string().regex(/^ReferenceImageRequest_[a-f0-9]{42}$/u),
    artDirectionHash: HASH_SCHEMA,
    semanticDependencyClosureHash: HASH_SCHEMA,
    prompt: z.string().trim().min(1).max(16_384),
    negativeConstraints: z.array(z.string().trim().min(1).max(1024)),
    inputArtifactHashes: z.array(HASH_SCHEMA),
    image: imageConstraintSchema,
    requestHash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    const { requestId: _requestId, requestHash: _requestHash, ...material } = value;
    if (contentAddressedEntityId("ReferenceImageRequest", material) !== value.requestId)
      context.addIssue({ code: "custom", path: ["requestId"], message: "Request ID mismatch" });
    if (contentHash(stableJson(material)) !== value.requestHash)
      context.addIssue({ code: "custom", path: ["requestHash"], message: "Request hash mismatch" });
  });
export type ReferenceImageRequest = z.output<typeof REFERENCE_IMAGE_REQUEST_SCHEMA>;

export function sealReferenceImageRequest(
  input: Omit<ReferenceImageRequest, "kind" | "requestId" | "requestHash">,
): ReferenceImageRequest {
  const material = {
    kind: "ReferenceImageRequest" as const,
    ...input,
    negativeConstraints: [...input.negativeConstraints].sort(),
    inputArtifactHashes: [...input.inputArtifactHashes].sort(),
  };
  return deepFreezeJson(
    REFERENCE_IMAGE_REQUEST_SCHEMA.parse({
      ...material,
      requestId: contentAddressedEntityId("ReferenceImageRequest", material),
      requestHash: contentHash(stableJson(material)),
    }),
  );
}
