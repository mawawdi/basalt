import { z } from "zod";
import { HASH_SCHEMA } from "@basalt/contracts";
import { CATALOG_SOURCE_ROLE_HINT_SCHEMA } from "./metadata.js";
import {
  canonicalValues,
  requireCanonicalValues,
  sealArtifact,
  verifyArtifactHash,
} from "./artifact.js";

export const CATALOG_SMOKE_SPLITS = ["development", "holdout", "selection"] as const;
export const CATALOG_SMOKE_SPLIT_SCHEMA = z.enum(CATALOG_SMOKE_SPLITS);

export const CATALOG_SMOKE_STRATA = [
  "aggregate_or_collision",
  "attachment_or_small_prop",
  "material_or_name_failure",
  "organic_or_environment",
  "out_of_kernel",
  "standalone_object",
  "structural_or_route",
  "style_contrast",
] as const;
export const CATALOG_SMOKE_STRATUM_SCHEMA = z.enum(CATALOG_SMOKE_STRATA);

const SMOKE_ASSET_SCHEMA = z
  .object({
    sourceContentHash: HASH_SCHEMA,
    leakageGroupHash: HASH_SCHEMA,
    split: CATALOG_SMOKE_SPLIT_SCHEMA,
    stratum: CATALOG_SMOKE_STRATUM_SCHEMA,
    acceptablePrimaryNouns: z.array(z.string().trim().min(1).max(160)).min(1).max(16),
    acceptableStyleTerms: z.array(z.string().trim().min(1).max(160)).min(1).max(16),
    acceptableSourceRoles: z.array(CATALOG_SOURCE_ROLE_HINT_SCHEMA).min(1).max(5),
    misleadingName: z.boolean(),
    outsideSemanticKernel: z.boolean(),
    visibleDefects: z.array(z.string().trim().min(1).max(160)).max(16),
  })
  .strict()
  .superRefine((value, context) => {
    for (const [label, values] of [
      ["acceptable primary nouns", value.acceptablePrimaryNouns],
      ["acceptable style terms", value.acceptableStyleTerms],
      ["acceptable source roles", value.acceptableSourceRoles],
      ["visible defects", value.visibleDefects],
    ] as const)
      requireCanonicalValues(values, String, label, context);
  });

const SMOKE_QUERY_SCHEMA = z
  .object({
    queryId: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u),
    split: CATALOG_SMOKE_SPLIT_SCHEMA,
    text: z.string().trim().min(1).max(512),
    styleTerms: z.array(z.string().trim().min(1).max(160)).max(16),
    relevantSourceContentHashes: z.array(HASH_SCHEMA).min(1).max(32),
  })
  .strict()
  .superRefine((value, context) => {
    requireCanonicalValues(value.styleTerms, String, "smoke query style terms", context);
    requireCanonicalValues(
      value.relevantSourceContentHashes,
      String,
      "smoke query relevant assets",
      context,
    );
  });

const SMOKE_VALIDATION_CASE_SCHEMA = z
  .object({
    caseId: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u),
    queryText: z.string().trim().min(1).max(512),
    sourceContentHash: HASH_SCHEMA,
    expectedVerdict: z.enum(["match", "mismatch"]),
  })
  .strict();

/**
 * A bounded integration fixture. Passing it proves schema, orchestration, and
 * deterministic retrieval plumbing only; it can never authorize corpus work.
 */
export const CATALOG_SEARCH_SMOKE_FIXTURE_SCHEMA = z
  .object({
    kind: z.literal("CatalogSearchSmokeFixture"),
    authority: z.literal("smoke_only"),
    assets: z.array(SMOKE_ASSET_SCHEMA).length(32),
    queries: z.array(SMOKE_QUERY_SCHEMA).length(48),
    validationCases: z.array(SMOKE_VALIDATION_CASE_SCHEMA).length(64),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(
      value.assets,
      (entry) => entry.sourceContentHash,
      "smoke assets",
      context,
    );
    requireCanonicalValues(value.queries, (entry) => entry.queryId, "smoke queries", context);
    requireCanonicalValues(
      value.validationCases,
      (entry) => entry.caseId,
      "smoke validation cases",
      context,
    );
    for (const split of CATALOG_SMOKE_SPLITS) {
      const expected = split === "development" ? 16 : 8;
      if (value.assets.filter((entry) => entry.split === split).length !== expected)
        context.addIssue({
          code: "custom",
          path: ["assets"],
          message: `Smoke fixture requires ${expected} ${split} assets`,
        });
    }
    for (const stratum of CATALOG_SMOKE_STRATA)
      if (value.assets.filter((entry) => entry.stratum === stratum).length !== 4)
        context.addIssue({
          code: "custom",
          path: ["assets"],
          message: `Smoke fixture requires four ${stratum} assets`,
        });
    const groupSplits = new Map<string, string>();
    for (const asset of value.assets) {
      const existing = groupSplits.get(asset.leakageGroupHash);
      if (existing && existing !== asset.split)
        context.addIssue({
          code: "custom",
          path: ["assets"],
          message: `Leakage group ${asset.leakageGroupHash} crosses smoke splits`,
        });
      groupSplits.set(asset.leakageGroupHash, asset.split);
    }
  });
export type CatalogSearchSmokeFixture = z.output<typeof CATALOG_SEARCH_SMOKE_FIXTURE_SCHEMA>;

export function sealCatalogSearchSmokeFixture(
  input: Omit<CatalogSearchSmokeFixture, "kind" | "authority" | "hash">,
): CatalogSearchSmokeFixture {
  return sealArtifact(CATALOG_SEARCH_SMOKE_FIXTURE_SCHEMA, {
    kind: "CatalogSearchSmokeFixture" as const,
    authority: "smoke_only" as const,
    assets: canonicalValues(
      input.assets.map((asset) => ({
        ...asset,
        acceptablePrimaryNouns: canonicalValues(
          asset.acceptablePrimaryNouns,
          String,
          "acceptable primary nouns",
        ),
        acceptableStyleTerms: canonicalValues(
          asset.acceptableStyleTerms,
          String,
          "acceptable style terms",
        ),
        acceptableSourceRoles: canonicalValues(
          asset.acceptableSourceRoles,
          String,
          "acceptable source roles",
        ),
        visibleDefects: canonicalValues(asset.visibleDefects, String, "visible defects"),
      })),
      (entry) => entry.sourceContentHash,
      "smoke assets",
    ),
    queries: canonicalValues(
      input.queries.map((query) => ({
        ...query,
        styleTerms: canonicalValues(query.styleTerms, String, "smoke query style terms"),
        relevantSourceContentHashes: canonicalValues(
          query.relevantSourceContentHashes,
          String,
          "smoke query relevant assets",
        ),
      })),
      (entry) => entry.queryId,
      "smoke queries",
    ),
    validationCases: canonicalValues(
      input.validationCases,
      (entry) => entry.caseId,
      "smoke validation cases",
    ),
  });
}
