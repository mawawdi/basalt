import { z } from "zod";
import {
  CATALOG_ASSET_ARTIFACT_SCHEMA,
  CATALOG_REQUIREMENT_SCHEMA,
  type CatalogAssetArtifact,
  type CatalogRequirement,
} from "@basalt/catalog-model";
import {
  COMPILATION_STATUS_SCHEMA,
  HASH_SCHEMA,
  contentHash,
  deepFreezeJson,
  stableJson,
} from "@basalt/contracts";
import {
  SEMANTIC_DEPENDENCY_CLOSURE_SCHEMA,
  type SemanticDependencyClosure,
} from "@basalt/semantic-kernel";
import {
  ASSET_METRIC_PROMPT_SUMMARY_SCHEMA,
  ASSET_SEARCH_METADATA_RECEIPT_SCHEMA,
  CATALOG_SELECTED_RGB_VIEW_SCHEMA,
  sealAssetMetricPromptSummary,
  type AssetSearchMetadataReceipt,
} from "./metadata.js";
import {
  CATALOG_SEARCH_QUERY_SCHEMA,
  CATALOG_SEARCH_RESULT_SET_SCHEMA,
  type CatalogSearchQuery,
  type CatalogSearchResultSet,
} from "./search.js";
import {
  canonicalValues,
  requireCanonicalValues,
  sealArtifact,
  verifyArtifactHash,
} from "./artifact.js";
import {
  CATALOG_CANDIDATE_DECISION_POLICY_SCHEMA,
  type CatalogCandidateDecisionPolicy,
} from "./policy.js";

export const CATALOG_VALIDATION_VERDICTS = ["match", "mismatch", "uncertain"] as const;
export const CATALOG_VALIDATION_VERDICT_SCHEMA = z.enum(CATALOG_VALIDATION_VERDICTS);

export const CATALOG_VISUAL_VALIDATION_SCHEMA = z
  .object({
    verdict: CATALOG_VALIDATION_VERDICT_SCHEMA,
    observedObjectType: z.discriminatedUnion("status", [
      z
        .object({ status: z.literal("observed"), value: z.string().trim().min(1).max(160) })
        .strict(),
      z
        .object({ status: z.literal("abstained"), reason: z.string().trim().min(1).max(512) })
        .strict(),
    ]),
    reasons: z.array(z.string().trim().min(1).max(512)).min(1).max(32),
    mismatchedConstraints: z.array(z.string().trim().min(1).max(160)).max(32),
    visibleLimitations: z.array(z.string().trim().min(1).max(512)).max(32),
  })
  .strict();
export type CatalogVisualValidation = z.output<typeof CATALOG_VISUAL_VALIDATION_SCHEMA>;

const CANDIDATE_EVIDENCE_SCHEMA = z
  .object({
    sourceContentHash: HASH_SCHEMA,
    metadataReceiptHash: HASH_SCHEMA.optional(),
    measurementHash: HASH_SCHEMA,
    renderEvidenceHash: HASH_SCHEMA,
    metricSummary: ASSET_METRIC_PROMPT_SUMMARY_SCHEMA,
    selectedRgbViews: z.array(CATALOG_SELECTED_RGB_VIEW_SCHEMA).length(12),
  })
  .strict()
  .superRefine((value, context) => {
    requireCanonicalValues(
      value.selectedRgbViews,
      (entry) => entry.viewId,
      "validation RGB views",
      context,
    );
    if (
      value.metricSummary.sourceContentHash !== value.sourceContentHash ||
      value.metricSummary.measurementHash !== value.measurementHash
    )
      context.addIssue({
        code: "custom",
        path: ["metricSummary"],
        message: "Validation metric summary does not bind candidate evidence",
      });
  });

const REQUEST_COMMON = {
  candidate: CANDIDATE_EVIDENCE_SCHEMA,
  promptTemplateHash: HASH_SCHEMA,
  outputSchemaHash: HASH_SCHEMA,
  preprocessingImplementationHash: HASH_SCHEMA,
  hash: HASH_SCHEMA,
};

export const CATALOG_SEARCH_VALIDATION_REQUEST_SCHEMA = z
  .object({
    kind: z.literal("CatalogSearchValidationRequest"),
    query: CATALOG_SEARCH_QUERY_SCHEMA,
    ...REQUEST_COMMON,
  })
  .strict()
  .superRefine((value, context) => validateRequest(value, context));
export type CatalogSearchValidationRequest = z.output<
  typeof CATALOG_SEARCH_VALIDATION_REQUEST_SCHEMA
>;

export const CATALOG_REQUIREMENT_VALIDATION_REQUEST_SCHEMA = z
  .object({
    kind: z.literal("CatalogRequirementValidationRequest"),
    requirement: CATALOG_REQUIREMENT_SCHEMA,
    requirementHash: HASH_SCHEMA,
    semanticClosure: SEMANTIC_DEPENDENCY_CLOSURE_SCHEMA,
    ...REQUEST_COMMON,
  })
  .strict()
  .superRefine((value, context) => {
    validateRequest(value, context);
    if (contentHash(stableJson(value.requirement)) !== value.requirementHash)
      context.addIssue({
        code: "custom",
        path: ["requirementHash"],
        message: "Requirement hash mismatch",
      });
    if (value.requirement.semantic.dependencyClosureHash !== value.semanticClosure.hash)
      context.addIssue({
        code: "custom",
        path: ["semanticClosure"],
        message: "Requirement does not bind the supplied semantic closure",
      });
  });
export type CatalogRequirementValidationRequest = z.output<
  typeof CATALOG_REQUIREMENT_VALIDATION_REQUEST_SCHEMA
>;

export const CATALOG_VALIDATION_REQUEST_SCHEMA = z.discriminatedUnion("kind", [
  CATALOG_SEARCH_VALIDATION_REQUEST_SCHEMA,
  CATALOG_REQUIREMENT_VALIDATION_REQUEST_SCHEMA,
]);
export type CatalogValidationRequest = z.output<typeof CATALOG_VALIDATION_REQUEST_SCHEMA>;

const MODEL_COMMIT_SCHEMA = z.string().regex(/^[a-f0-9]{40,64}$/u);
export const CATALOG_VALIDATION_RECEIPT_SCHEMA = z
  .object({
    kind: z.literal("CatalogValidationReceipt"),
    status: COMPILATION_STATUS_SCHEMA,
    requestHash: HASH_SCHEMA,
    requestKind: z.enum(["CatalogRequirementValidationRequest", "CatalogSearchValidationRequest"]),
    sourceContentHash: HASH_SCHEMA,
    adapterId: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u),
    adapterImplementationHash: HASH_SCHEMA,
    workerImplementationHash: HASH_SCHEMA,
    runtimeImplementationHash: HASH_SCHEMA,
    modelId: z.string().trim().min(1).max(256),
    modelCommitHash: MODEL_COMMIT_SCHEMA,
    promptHash: HASH_SCHEMA,
    rawOutputHash: HASH_SCHEMA.optional(),
    validation: CATALOG_VISUAL_VALIDATION_SCHEMA.optional(),
    diagnostics: z.array(z.string().trim().min(1).max(2_048)).max(256),
    resourceUsage: z
      .object({
        inputImageCount: z.number().int().nonnegative().max(12),
        inputPixels: z.number().int().nonnegative().max(100_000_000),
        inputTokens: z.number().int().nonnegative().max(10_000_000),
        outputTokens: z.number().int().nonnegative().max(10_000_000),
        elapsedMilliseconds: z.number().int().nonnegative().max(86_400_000),
        peakResidentBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        gpuMilliseconds: z.number().int().nonnegative().max(86_400_000),
      })
      .strict(),
    compilerAuthority: z.literal(false),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(value.diagnostics, String, "validation diagnostics", context);
    if (value.validation) {
      requireCanonicalValues(value.validation.reasons, String, "validation reasons", context);
      requireCanonicalValues(
        value.validation.mismatchedConstraints,
        String,
        "validation mismatches",
        context,
      );
      requireCanonicalValues(
        value.validation.visibleLimitations,
        String,
        "validation limitations",
        context,
      );
    }
    if (value.status === "eligible" && (!value.validation || value.diagnostics.length > 0))
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Eligible validation receipts require a verdict and no diagnostics",
      });
    if (value.status !== "eligible" && (value.validation || value.diagnostics.length === 0))
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Failed validation receipts require diagnostics and no verdict",
      });
  });
export type CatalogValidationReceipt = z.output<typeof CATALOG_VALIDATION_RECEIPT_SCHEMA>;

const DECISION_CANDIDATE_SCHEMA = z
  .object({
    sourceContentHash: HASH_SCHEMA,
    fusedRank: z.number().int().positive().max(100),
    validation: z.enum(["match", "mismatch", "not_requested", "pending", "uncertain"]),
    validationReceiptHash: HASH_SCHEMA.optional(),
  })
  .strict();

export const CATALOG_CANDIDATE_DECISION_SCHEMA = z
  .object({
    kind: z.literal("CatalogCandidateDecision"),
    outcome: z.enum(["evidence_insufficient", "no_suitable_match", "suitable_match"]),
    queryHash: HASH_SCHEMA,
    resultSetHash: HASH_SCHEMA,
    policyHash: HASH_SCHEMA,
    selectedSourceContentHash: HASH_SCHEMA.optional(),
    consideredCandidates: z.array(DECISION_CANDIDATE_SCHEMA).max(8),
    reasons: z.array(z.string().trim().min(1).max(512)).min(1).max(32),
    compilerAuthority: z.literal(false),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(
      value.consideredCandidates,
      (entry) => String(entry.fusedRank).padStart(3, "0"),
      "decision candidates",
      context,
    );
    requireCanonicalValues(value.reasons, String, "decision reasons", context);
    const matching = value.consideredCandidates.filter((entry) => entry.validation === "match");
    if (
      (value.outcome === "suitable_match") !==
      (value.selectedSourceContentHash !== undefined && matching.length > 0)
    )
      context.addIssue({ code: "custom", message: "Suitable-match decision is inconsistent" });
    if (
      value.selectedSourceContentHash &&
      !matching.some((entry) => entry.sourceContentHash === value.selectedSourceContentHash)
    )
      context.addIssue({
        code: "custom",
        message: "Selected candidate was not validated as a match",
      });
  });
export type CatalogCandidateDecision = z.output<typeof CATALOG_CANDIDATE_DECISION_SCHEMA>;

export const CATALOG_VISUAL_VALIDATION_JSON_SCHEMA = deepFreezeJson(
  z.toJSONSchema(CATALOG_VISUAL_VALIDATION_SCHEMA, { target: "draft-7" }),
);
export const CATALOG_VISUAL_VALIDATION_JSON_SCHEMA_HASH = contentHash(
  stableJson(CATALOG_VISUAL_VALIDATION_JSON_SCHEMA),
);

export function sealCatalogSearchValidationRequest(input: {
  readonly query: CatalogSearchQuery;
  readonly candidate: z.output<typeof CANDIDATE_EVIDENCE_SCHEMA>;
  readonly promptTemplateHash: string;
  readonly preprocessingImplementationHash: string;
}): CatalogSearchValidationRequest {
  return sealArtifact(CATALOG_SEARCH_VALIDATION_REQUEST_SCHEMA, {
    kind: "CatalogSearchValidationRequest" as const,
    query: CATALOG_SEARCH_QUERY_SCHEMA.parse(input.query),
    candidate: canonicalCandidate(input.candidate),
    promptTemplateHash: input.promptTemplateHash,
    outputSchemaHash: CATALOG_VISUAL_VALIDATION_JSON_SCHEMA_HASH,
    preprocessingImplementationHash: input.preprocessingImplementationHash,
  });
}

export function sealCatalogRequirementValidationRequest(input: {
  readonly requirement: CatalogRequirement;
  readonly semanticClosure: SemanticDependencyClosure;
  readonly candidate: z.output<typeof CANDIDATE_EVIDENCE_SCHEMA>;
  readonly promptTemplateHash: string;
  readonly preprocessingImplementationHash: string;
}): CatalogRequirementValidationRequest {
  const requirement = CATALOG_REQUIREMENT_SCHEMA.parse(input.requirement);
  return sealArtifact(CATALOG_REQUIREMENT_VALIDATION_REQUEST_SCHEMA, {
    kind: "CatalogRequirementValidationRequest" as const,
    requirement,
    requirementHash: contentHash(stableJson(requirement)),
    semanticClosure: SEMANTIC_DEPENDENCY_CLOSURE_SCHEMA.parse(input.semanticClosure),
    candidate: canonicalCandidate(input.candidate),
    promptTemplateHash: input.promptTemplateHash,
    outputSchemaHash: CATALOG_VISUAL_VALIDATION_JSON_SCHEMA_HASH,
    preprocessingImplementationHash: input.preprocessingImplementationHash,
  });
}

export function sealCatalogValidationReceipt(input: {
  readonly request: CatalogValidationRequest;
  readonly status: "eligible" | "incomplete" | "rejected";
  readonly adapterId: string;
  readonly adapterImplementationHash: string;
  readonly workerImplementationHash: string;
  readonly runtimeImplementationHash: string;
  readonly modelId: string;
  readonly modelCommitHash: string;
  readonly promptHash: string;
  readonly rawOutputHash?: string;
  readonly validation?: z.input<typeof CATALOG_VISUAL_VALIDATION_SCHEMA>;
  readonly diagnostics: readonly string[];
  readonly resourceUsage: CatalogValidationReceipt["resourceUsage"];
}): CatalogValidationReceipt {
  const request = CATALOG_VALIDATION_REQUEST_SCHEMA.parse(input.request);
  const parsedValidation = input.validation
    ? CATALOG_VISUAL_VALIDATION_SCHEMA.parse(input.validation)
    : undefined;
  const validation = parsedValidation
    ? CATALOG_VISUAL_VALIDATION_SCHEMA.parse({
        ...parsedValidation,
        reasons: canonicalValues(
          [...new Set(parsedValidation.reasons)],
          String,
          "validation reasons",
        ),
        mismatchedConstraints: canonicalValues(
          [...new Set(parsedValidation.mismatchedConstraints)],
          String,
          "validation mismatches",
        ),
        visibleLimitations: canonicalValues(
          [...new Set(parsedValidation.visibleLimitations)],
          String,
          "validation limitations",
        ),
      })
    : undefined;
  return sealArtifact(CATALOG_VALIDATION_RECEIPT_SCHEMA, {
    kind: "CatalogValidationReceipt" as const,
    status: input.status,
    requestHash: request.hash,
    requestKind: request.kind,
    sourceContentHash: request.candidate.sourceContentHash,
    adapterId: input.adapterId,
    adapterImplementationHash: input.adapterImplementationHash,
    workerImplementationHash: input.workerImplementationHash,
    runtimeImplementationHash: input.runtimeImplementationHash,
    modelId: input.modelId,
    modelCommitHash: input.modelCommitHash,
    promptHash: input.promptHash,
    ...(input.rawOutputHash ? { rawOutputHash: input.rawOutputHash } : {}),
    ...(validation ? { validation } : {}),
    diagnostics: canonicalValues(input.diagnostics, String, "validation diagnostics"),
    resourceUsage: input.resourceUsage,
    compilerAuthority: false as const,
  });
}

/** Validation evidence is reusable only under the exact model and worker implementation. */
export function validationReceiptMatchesExecution(
  receipt: CatalogValidationReceipt,
  execution: {
    readonly modelId: string;
    readonly modelCommitHash: string;
    readonly workerImplementationHash: string;
  },
): boolean {
  return (
    receipt.modelId === execution.modelId &&
    receipt.modelCommitHash === execution.modelCommitHash &&
    receipt.workerImplementationHash === execution.workerImplementationHash
  );
}

export function annotateCatalogSearchResults(input: {
  readonly results: CatalogSearchResultSet;
  readonly receipts: readonly CatalogValidationReceipt[];
}): CatalogSearchResultSet {
  const results = CATALOG_SEARCH_RESULT_SET_SCHEMA.parse(input.results);
  const receipts = new Map(
    input.receipts.map((entry) => {
      const receipt = CATALOG_VALIDATION_RECEIPT_SCHEMA.parse(entry);
      return [receipt.sourceContentHash, receipt] as const;
    }),
  );
  const diagnostics = [...results.diagnostics];
  const annotated = results.results.map((result) => {
    if (result.validation !== "pending") return result;
    const receipt = receipts.get(result.sourceContentHash);
    if (!receipt || receipt.status !== "eligible" || !receipt.validation) {
      diagnostics.push(
        `Pending validation for ${result.sourceContentHash} has no eligible receipt`,
      );
      return result;
    }
    return {
      ...result,
      validation: receipt.validation.verdict,
      validationReceiptHash: receipt.hash,
    };
  });
  return sealArtifact(CATALOG_SEARCH_RESULT_SET_SCHEMA, {
    kind: "CatalogSearchResultSet" as const,
    status: diagnostics.length === 0 ? ("eligible" as const) : ("incomplete" as const),
    query: results.query,
    indexHash: results.indexHash,
    ...(results.queryEmbeddingReceiptHash
      ? { queryEmbeddingReceiptHash: results.queryEmbeddingReceiptHash }
      : {}),
    results: annotated,
    filteredCandidates: results.filteredCandidates,
    diagnostics: canonicalValues(diagnostics, String, "search diagnostics"),
    compilerAuthority: false as const,
  });
}

/** Requirement-specific acceptance is the only stage allowed to conclude no suitable match. */
export function decideCatalogSearchOutcome(input: {
  readonly results: CatalogSearchResultSet;
  readonly policy: CatalogCandidateDecisionPolicy;
}): CatalogCandidateDecision {
  const results = CATALOG_SEARCH_RESULT_SET_SCHEMA.parse(input.results);
  const policy = CATALOG_CANDIDATE_DECISION_POLICY_SCHEMA.parse(input.policy);
  const consideredCandidates = results.results
    .filter((entry) => entry.fusedRank <= results.query.validationLimit)
    .map((entry) => ({
      sourceContentHash: entry.sourceContentHash,
      fusedRank: entry.fusedRank,
      validation: entry.validation,
      ...(entry.validationReceiptHash
        ? { validationReceiptHash: entry.validationReceiptHash }
        : {}),
    }));
  const matches = consideredCandidates.filter((entry) => entry.validation === "match");
  const fullyValidated = consideredCandidates.filter((entry) =>
    ["match", "mismatch", "uncertain"].includes(entry.validation),
  );
  const hasUncertainty = consideredCandidates.some((entry) =>
    ["not_requested", "pending", "uncertain"].includes(entry.validation),
  );
  let outcome: CatalogCandidateDecision["outcome"];
  let selectedSourceContentHash: string | undefined;
  let reasons: string[];
  if (matches.length >= policy.minimumMatchCount) {
    outcome = "suitable_match";
    selectedSourceContentHash = matches[0]!.sourceContentHash;
    reasons = ["At least one ranked candidate satisfied requirement-specific validation"];
  } else if (
    fullyValidated.length >= policy.minimumValidatedCandidates &&
    !hasUncertainty &&
    fullyValidated.every((entry) => entry.validation === "mismatch")
  ) {
    outcome = policy.allMismatchOutcome;
    reasons = ["Every candidate in the frozen validation budget was an explicit mismatch"];
  } else {
    outcome = policy.uncertainOutcome;
    reasons = [
      "The validation budget lacks enough conclusive evidence to accept or reject the retrieved pool",
    ];
  }
  return sealArtifact(CATALOG_CANDIDATE_DECISION_SCHEMA, {
    kind: "CatalogCandidateDecision" as const,
    outcome,
    queryHash: results.query.hash,
    resultSetHash: results.hash,
    policyHash: policy.hash,
    ...(selectedSourceContentHash ? { selectedSourceContentHash } : {}),
    consideredCandidates,
    reasons: canonicalValues(reasons, String, "decision reasons"),
    compilerAuthority: false as const,
  });
}

export function deterministicRequirementChecks(input: {
  readonly requirement: CatalogRequirement;
  readonly asset: CatalogAssetArtifact;
}): readonly string[] {
  const requirement = CATALOG_REQUIREMENT_SCHEMA.parse(input.requirement);
  const asset = CATALOG_ASSET_ARTIFACT_SCHEMA.parse(input.asset);
  const failures: string[] = [];
  const triangles = asset.parts.reduce((sum, part) => sum + part.triangleCount, 0);
  const sourceBytes = asset.source.sourceArtifact?.bytes ?? 0;
  if (triangles > requirement.budget.maximumTriangles) failures.push("triangle_budget");
  if (sourceBytes > requirement.budget.maximumSourceBytes) failures.push("source_byte_budget");
  if (requirement.rights.commercialUseRequired && !asset.source.rights.commercialUsePermitted)
    failures.push("commercial_rights");
  if (requirement.rights.redistributionRequired && !asset.source.rights.redistributionPermitted)
    failures.push("redistribution_rights");
  if (requirement.metricBounds.maximumSizeMeters)
    for (const axis of ["x", "y", "z"] as const) {
      const size = BigInt(asset.bounds.max[axis]) - BigInt(asset.bounds.min[axis]);
      if (size > BigInt(requirement.metricBounds.maximumSizeMeters[axis]))
        failures.push(`size_${axis}`);
    }
  return [...new Set(failures)].sort();
}

function canonicalCandidate(input: z.output<typeof CANDIDATE_EVIDENCE_SCHEMA>) {
  return CANDIDATE_EVIDENCE_SCHEMA.parse({
    ...input,
    selectedRgbViews: canonicalValues(
      input.selectedRgbViews,
      (entry) => entry.viewId,
      "validation RGB views",
    ),
  });
}

function validateRequest(
  value: {
    readonly candidate: z.output<typeof CANDIDATE_EVIDENCE_SCHEMA>;
    readonly outputSchemaHash: string;
    readonly hash: string;
  },
  context: z.RefinementCtx,
): void {
  verifyArtifactHash(value as Record<string, unknown>, context);
  if (value.outputSchemaHash !== CATALOG_VISUAL_VALIDATION_JSON_SCHEMA_HASH)
    context.addIssue({
      code: "custom",
      path: ["outputSchemaHash"],
      message: "Validation request binds a different output schema",
    });
}

export function validateCandidateBindings(input: {
  readonly request: CatalogValidationRequest;
  readonly metadata?: AssetSearchMetadataReceipt;
  readonly asset: CatalogAssetArtifact;
}): void {
  const request = CATALOG_VALIDATION_REQUEST_SCHEMA.parse(input.request);
  const metadata = input.metadata
    ? ASSET_SEARCH_METADATA_RECEIPT_SCHEMA.parse(input.metadata)
    : undefined;
  const asset = CATALOG_ASSET_ARTIFACT_SCHEMA.parse(input.asset);
  if (
    request.candidate.sourceContentHash !== asset.source.contentHash ||
    request.candidate.measurementHash !== asset.hash ||
    request.candidate.metricSummary.hash !== sealAssetMetricPromptSummary(asset).hash ||
    (metadata !== undefined &&
      (request.candidate.sourceContentHash !== metadata.sourceContentHash ||
        request.candidate.metadataReceiptHash !== metadata.hash ||
        request.candidate.renderEvidenceHash !== metadata.renderEvidenceHash)) ||
    (metadata === undefined && request.candidate.metadataReceiptHash !== undefined)
  )
    throw new Error("Validation candidate evidence does not bind one exact asset");
}
