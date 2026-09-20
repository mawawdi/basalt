import { z } from "zod";
import { HASH_SCHEMA } from "@basalt/contracts";
import { CATALOG_METADATA_VIEW_SET_SCHEMA } from "./metadata.js";
import {
  CATALOG_MODEL_DECLARATIONS_SCHEMA,
  type CatalogModelDeclarations,
} from "./worker-contracts.js";
import { canonicalValues, sealArtifact, verifyArtifactHash } from "./artifact.js";

export const CATALOG_MODEL_ROLES = ["metadata_writer", "requirement_validator"] as const;
export const CATALOG_MODEL_ROLE_SCHEMA = z.enum(CATALOG_MODEL_ROLES);

const ROLE_BINDING_SCHEMA = z
  .object({
    modelId: z.string().regex(/^[a-z][a-z0-9_]{2,127}$/u),
    viewSet: CATALOG_METADATA_VIEW_SET_SCHEMA,
  })
  .strict();

export const CATALOG_MODEL_ROLE_POLICY_SCHEMA = z
  .object({
    kind: z.literal("CatalogModelRolePolicy"),
    metadataWriter: ROLE_BINDING_SCHEMA,
    requirementValidator: ROLE_BINDING_SCHEMA.extend({
      viewSet: z.literal("canonical_twelve"),
    }).strict(),
    challengers: z.array(
      z
        .object({
          role: CATALOG_MODEL_ROLE_SCHEMA,
          modelId: z.string().regex(/^[a-z][a-z0-9_]{2,127}$/u),
        })
        .strict(),
    ),
    qualificationReportHash: HASH_SCHEMA.optional(),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    const keys = value.challengers.map((entry) => `${entry.role}:${entry.modelId}`);
    if (new Set(keys).size !== keys.length)
      context.addIssue({
        code: "custom",
        path: ["challengers"],
        message: "Model-role challengers must be unique",
      });
  });
export type CatalogModelRolePolicy = z.output<typeof CATALOG_MODEL_ROLE_POLICY_SCHEMA>;

export function sealCatalogModelRolePolicy(
  input: Omit<CatalogModelRolePolicy, "kind" | "hash">,
): CatalogModelRolePolicy {
  return sealArtifact(CATALOG_MODEL_ROLE_POLICY_SCHEMA, {
    kind: "CatalogModelRolePolicy" as const,
    ...input,
    challengers: canonicalValues(
      input.challengers,
      (entry) => `${entry.role}:${entry.modelId}`,
      "model-role challengers",
    ),
  });
}

export function validateCatalogModelRolePolicy(
  policyInput: CatalogModelRolePolicy,
  declarationsInput: CatalogModelDeclarations,
): void {
  const policy = CATALOG_MODEL_ROLE_POLICY_SCHEMA.parse(policyInput);
  const declarations = CATALOG_MODEL_DECLARATIONS_SCHEMA.parse(declarationsInput);
  const byId = new Map(declarations.models.map((entry) => [entry.modelId, entry] as const));
  for (const [role, modelId] of [
    ["metadata_writer", policy.metadataWriter.modelId],
    ["requirement_validator", policy.requirementValidator.modelId],
    ...policy.challengers.map((entry) => [entry.role, entry.modelId] as const),
  ] as const) {
    const model = byId.get(modelId);
    if (!model) throw new Error(`Catalog model policy references unavailable model ${modelId}`);
    if (!model.capabilities.includes(role))
      throw new Error(`Catalog model ${modelId} does not provide ${role}`);
  }
}
