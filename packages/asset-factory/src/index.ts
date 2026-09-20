import { z } from "zod";
import {
  COMPILATION_STATUS_SCHEMA,
  HASH_SCHEMA,
  contentAddressedEntityId,
  contentHash,
  deepFreezeJson,
  stableJson,
} from "@basalt/contracts";
import { CATALOG_REQUIREMENT_SCHEMA, SEALED_STYLE_PROFILE_SCHEMA } from "@basalt/catalog-model";
import { ASSET_FULFILLMENT_JOB_SCHEMA } from "./fulfillment.js";

export * from "./fulfillment.js";

const artifactReference = z
  .object({
    artifactHash: HASH_SCHEMA,
    bytes: z.number().int().positive().safe(),
    mediaType: z.string().regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/u),
  })
  .strict();

export const ASSET_FACTORY_REQUEST_SCHEMA = z
  .object({
    kind: z.literal("AssetFactoryRequest"),
    id: z.string().regex(/^factory_request_[a-f0-9]{16,56}$/u),
    fulfillmentPlanHash: HASH_SCHEMA,
    job: ASSET_FULFILLMENT_JOB_SCHEMA,
    requirement: CATALOG_REQUIREMENT_SCHEMA,
    styleProfile: SEALED_STYLE_PROFILE_SCHEMA,
    measurableConstraints: z
      .object({
        maximumTriangles: z.number().int().positive().safe(),
        maximumSourceBytes: z.number().int().positive().safe(),
        outputMediaType: z.literal("model/gltf-binary"),
        requireSupportEvidence: z.boolean(),
        requireCollisionEvidence: z.boolean(),
        requiredSocketCount: z.number().int().nonnegative().safe(),
      })
      .strict(),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.job.semanticDependencyClosureHash !== value.requirement.semantic.dependencyClosureHash
    )
      context.addIssue({ code: "custom", message: "Factory job and requirement semantics differ" });
    if (value.job.styleProfileHash !== value.styleProfile.hash)
      context.addIssue({ code: "custom", message: "Factory job and style profile differ" });
    if (
      value.measurableConstraints.maximumTriangles > value.requirement.budget.maximumTriangles ||
      value.measurableConstraints.maximumSourceBytes > value.requirement.budget.maximumSourceBytes
    )
      context.addIssue({
        code: "custom",
        path: ["measurableConstraints"],
        message: "Factory constraints cannot exceed requirement budgets",
      });
    const { id: _id, hash: _hash, ...material } = value;
    if (contentAddressedEntityId("factory_request", material) !== value.id)
      context.addIssue({ code: "custom", path: ["id"], message: "Factory request ID mismatch" });
    if (contentHash(stableJson(material)) !== value.hash)
      context.addIssue({
        code: "custom",
        path: ["hash"],
        message: "Factory request hash mismatch",
      });
  });
export type AssetFactoryRequest = z.output<typeof ASSET_FACTORY_REQUEST_SCHEMA>;

export const ASSET_FACTORY_CANDIDATE_SCHEMA = z
  .object({
    kind: z.literal("AssetFactoryCandidate"),
    requestHash: HASH_SCHEMA,
    status: COMPILATION_STATUS_SCHEMA,
    finishedSourceArtifact: artifactReference
      .refine((value) => value.mediaType === "model/gltf-binary", "Factory output must be GLB")
      .optional(),
    neuralGenerationReceiptHash: HASH_SCHEMA,
    finishingEvidenceHashes: z.array(HASH_SCHEMA),
    lineageEvidenceHashes: z.array(HASH_SCHEMA),
    diagnostics: z.array(z.string().trim().min(1).max(1024)),
    admissionAuthority: z.literal("measurement_and_catalog_seal_required"),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.status === "eligible") !== (value.finishedSourceArtifact !== undefined))
      context.addIssue({
        code: "custom",
        message: "Only an eligible factory candidate has source bytes",
      });
    for (const [name, values] of [
      ["finishingEvidenceHashes", value.finishingEvidenceHashes],
      ["lineageEvidenceHashes", value.lineageEvidenceHashes],
    ] as const) {
      const canonical = [...values].sort();
      if (
        new Set(canonical).size !== canonical.length ||
        stableJson(canonical) !== stableJson(values)
      )
        context.addIssue({
          code: "custom",
          path: [name],
          message: `${name} must be canonical and unique`,
        });
    }
    const { hash: _hash, ...material } = value;
    if (contentHash(stableJson(material)) !== value.hash)
      context.addIssue({
        code: "custom",
        path: ["hash"],
        message: "Factory candidate hash mismatch",
      });
  });
export type AssetFactoryCandidate = z.output<typeof ASSET_FACTORY_CANDIDATE_SCHEMA>;

export function sealAssetFactoryRequest(
  input: Omit<AssetFactoryRequest, "kind" | "id" | "hash">,
): AssetFactoryRequest {
  const material = {
    kind: "AssetFactoryRequest" as const,
    ...input,
  };
  return deepFreezeJson(
    ASSET_FACTORY_REQUEST_SCHEMA.parse({
      ...material,
      id: contentAddressedEntityId("factory_request", material),
      hash: contentHash(stableJson(material)),
    }),
  ) as AssetFactoryRequest;
}

export function sealAssetFactoryCandidate(
  input: Omit<AssetFactoryCandidate, "kind" | "admissionAuthority" | "hash">,
): AssetFactoryCandidate {
  const material = {
    kind: "AssetFactoryCandidate" as const,
    ...input,
    finishingEvidenceHashes: [...input.finishingEvidenceHashes].sort(),
    lineageEvidenceHashes: [...input.lineageEvidenceHashes].sort(),
    admissionAuthority: "measurement_and_catalog_seal_required" as const,
  };
  return deepFreezeJson(
    ASSET_FACTORY_CANDIDATE_SCHEMA.parse({ ...material, hash: contentHash(stableJson(material)) }),
  ) as AssetFactoryCandidate;
}
