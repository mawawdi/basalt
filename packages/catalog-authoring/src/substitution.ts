import { z } from "zod";
import { COMPILATION_STATUS_SCHEMA, HASH_SCHEMA } from "@basalt/contracts";
import {
  CATALOG_SUBSTITUTION_PROPOSAL_POLICY_SCHEMA,
  type CatalogSubstitutionProposalPolicy,
} from "./policy.js";
import { CATALOG_SEARCH_RESULT_SET_SCHEMA, type CatalogSearchResultSet } from "./search.js";
import {
  canonicalValues,
  requireCanonicalValues,
  sealArtifact,
  verifyArtifactHash,
} from "./artifact.js";

const CANDIDATE_SCHEMA = z
  .object({
    sourceContentHash: HASH_SCHEMA,
    metadataReceiptHash: HASH_SCHEMA,
    measurementHash: HASH_SCHEMA,
    imageTextSimilarityMillionths: z.number().int().min(-1_000_000).max(1_000_000),
    shapeSimilarityMillionths: z.number().int().min(-1_000_000).max(1_000_000),
    axisRatioMillionths: z.number().int().min(1_000_000).max(100_000_000),
    semanticAdmissionAvailable: z.boolean(),
    placementEvidenceAvailable: z.boolean(),
    outcome: z.enum(["candidate", "incompatible", "incomplete"]),
    reasons: z.array(z.string().trim().min(1).max(256)).max(16),
  })
  .strict()
  .superRefine((value, context) => {
    requireCanonicalValues(value.reasons, String, "substitution candidate reasons", context);
    if (value.outcome === "candidate" && value.reasons.length > 0)
      context.addIssue({
        code: "custom",
        path: ["reasons"],
        message: "Candidate outcome forbids reasons",
      });
    if (value.outcome !== "candidate" && value.reasons.length === 0)
      context.addIssue({
        code: "custom",
        path: ["reasons"],
        message: "Non-candidates require reasons",
      });
  });
export type CatalogSubstitutionCandidate = z.output<typeof CANDIDATE_SCHEMA>;

export const CATALOG_SUBSTITUTION_PROPOSAL_SET_SCHEMA = z
  .object({
    kind: z.literal("CatalogSubstitutionProposalSet"),
    status: COMPILATION_STATUS_SCHEMA,
    searchResultSetHash: HASH_SCHEMA,
    policyHash: HASH_SCHEMA,
    candidates: z.array(CANDIDATE_SCHEMA).max(32),
    diagnostics: z.array(z.string().trim().min(1).max(1_024)).max(128),
    compilerAuthority: z.literal(false),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(
      value.candidates,
      (entry) => entry.sourceContentHash,
      "substitution candidates",
      context,
    );
    requireCanonicalValues(value.diagnostics, String, "substitution diagnostics", context);
    if (value.candidates.length > 32)
      context.addIssue({
        code: "custom",
        path: ["candidates"],
        message: "Substitution proposals are bounded to 32 candidates",
      });
    const expected = value.diagnostics.length === 0 ? "eligible" : "incomplete";
    if (value.status !== expected)
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Substitution proposal status mismatch",
      });
  });
export type CatalogSubstitutionProposalSet = z.output<
  typeof CATALOG_SUBSTITUTION_PROPOSAL_SET_SCHEMA
>;

export function buildCatalogSubstitutionProposalSet(input: {
  readonly searchResults: CatalogSearchResultSet;
  readonly policy: CatalogSubstitutionProposalPolicy;
  readonly evidence: readonly Omit<CatalogSubstitutionCandidate, "outcome" | "reasons">[];
}): CatalogSubstitutionProposalSet {
  const searchResults = CATALOG_SEARCH_RESULT_SET_SCHEMA.parse(input.searchResults);
  const policy = CATALOG_SUBSTITUTION_PROPOSAL_POLICY_SCHEMA.parse(input.policy);
  if (input.evidence.length > policy.maximumCandidatePoolSize)
    throw new Error(
      `Substitution proposal exceeds its ${policy.maximumCandidatePoolSize}-candidate bound`,
    );
  const searched = new Set(searchResults.results.map((entry) => entry.sourceContentHash));
  const candidates = input.evidence.map((entry) => {
    if (!searched.has(entry.sourceContentHash))
      throw new Error(
        `Substitution evidence references unsearched source ${entry.sourceContentHash}`,
      );
    const incompatible: string[] = [];
    const incomplete: string[] = [];
    if (entry.imageTextSimilarityMillionths < policy.minimumImageTextSimilarityMillionths)
      incompatible.push("image_text_similarity");
    if (entry.shapeSimilarityMillionths < policy.minimumShapeSimilarityMillionths)
      incompatible.push("shape_similarity");
    if (entry.axisRatioMillionths > policy.maximumAxisRatioMillionths)
      incompatible.push("metric_envelope");
    if (!entry.semanticAdmissionAvailable) incomplete.push("semantic_admission");
    if (!entry.placementEvidenceAvailable) incomplete.push("placement_evidence");
    const reasons = canonicalValues(
      incompatible.length > 0 ? incompatible : incomplete,
      String,
      "substitution candidate reasons",
    );
    return {
      ...entry,
      outcome:
        incompatible.length > 0
          ? ("incompatible" as const)
          : incomplete.length > 0
            ? ("incomplete" as const)
            : ("candidate" as const),
      reasons,
    };
  });
  const diagnostics = candidates.some((entry) => entry.outcome === "incomplete")
    ? ["Substitution candidates lack authoritative semantic or placement evidence"]
    : [];
  return sealArtifact(CATALOG_SUBSTITUTION_PROPOSAL_SET_SCHEMA, {
    kind: "CatalogSubstitutionProposalSet" as const,
    status: diagnostics.length === 0 ? ("eligible" as const) : ("incomplete" as const),
    searchResultSetHash: searchResults.hash,
    policyHash: policy.hash,
    candidates: canonicalValues(
      candidates,
      (entry) => entry.sourceContentHash,
      "substitution candidates",
    ),
    diagnostics,
    compilerAuthority: false as const,
  });
}
