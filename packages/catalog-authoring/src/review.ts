import { z } from "zod";
import {
  ASCII_ID_SCHEMA,
  COMPILATION_STATUS_SCHEMA,
  HASH_SCHEMA,
  compareCanonicalStrings,
  contentHash,
} from "@basalt/contracts";
import { CATALOG_REVIEW_SUBJECT_KIND_SCHEMA, type CatalogAdmissionRubric } from "./rubric.js";
import { CATALOG_ADMISSION_POLICY_SCHEMA, type CatalogAdmissionPolicy } from "./policy.js";
import {
  CATALOG_CALIBRATED_PREDICTION_SET_SCHEMA,
  type CatalogCalibratedPredictionSet,
} from "./prediction.js";
import { CATALOG_FEATURE_SET_SCHEMA, type CatalogFeatureSet } from "./features.js";
import {
  CATALOG_SUBSTITUTION_PROPOSAL_SET_SCHEMA,
  type CatalogSubstitutionProposalSet,
} from "./substitution.js";
import {
  canonicalValues,
  requireCanonicalValues,
  sealArtifact,
  verifyArtifactHash,
} from "./artifact.js";

export const CATALOG_DISCOVERY_REASON_SCHEMA = z.enum([
  "medoid",
  "visual_outlier",
  "view_disagreement",
  "semantic_boundary",
  "novelty",
  "substitution_boundary",
  "missing_evidence",
]);

const DISCOVERY_ITEM_SCHEMA = z
  .object({
    subjectKind: CATALOG_REVIEW_SUBJECT_KIND_SCHEMA,
    subjectId: z.string().trim().min(1).max(512),
    sourceContentHashes: z.array(HASH_SCHEMA).min(1).max(2),
    reasons: z.array(CATALOG_DISCOVERY_REASON_SCHEMA).min(1).max(7),
    evidenceHashes: z.array(HASH_SCHEMA).min(1).max(64),
    priorityMillionths: z.number().int().min(0).max(1_000_000),
  })
  .strict()
  .superRefine((value, context) => {
    requireCanonicalValues(value.sourceContentHashes, String, "discovery sources", context);
    requireCanonicalValues(value.reasons, String, "discovery reasons", context);
    requireCanonicalValues(value.evidenceHashes, String, "discovery evidence", context);
    if (value.subjectKind === "asset" && value.sourceContentHashes.length !== 1)
      context.addIssue({
        code: "custom",
        path: ["sourceContentHashes"],
        message: "Asset review requires one source",
      });
    if (value.subjectKind === "pair" && value.sourceContentHashes.length !== 2)
      context.addIssue({
        code: "custom",
        path: ["sourceContentHashes"],
        message: "Pair review requires two sources",
      });
  });

export const CATALOG_DISCOVERY_REVIEW_PLAN_SCHEMA = z
  .object({
    kind: z.literal("CatalogDiscoveryReviewPlan"),
    status: COMPILATION_STATUS_SCHEMA,
    pilotPlanHash: HASH_SCHEMA,
    policyHash: HASH_SCHEMA,
    rubricHash: HASH_SCHEMA,
    predictionSetHash: HASH_SCHEMA,
    featureSetHash: HASH_SCHEMA,
    substitutionProposalSetHash: HASH_SCHEMA,
    samplingPurpose: z.literal("failure_discovery_not_acceptance_estimation"),
    items: z.array(DISCOVERY_ITEM_SCHEMA).max(100_000),
    diagnostics: z.array(z.string().trim().min(1).max(1024)).max(100_000),
    compilerAuthority: z.literal(false),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(value.items, discoveryIdentity, "discovery items", context);
    requireCanonicalValues(value.diagnostics, String, "discovery diagnostics", context);
  });
export type CatalogDiscoveryReviewPlan = z.output<typeof CATALOG_DISCOVERY_REVIEW_PLAN_SCHEMA>;

export function buildCatalogDiscoveryReviewPlan(input: {
  readonly pilotPlanHash: string;
  readonly policy: CatalogAdmissionPolicy;
  readonly rubric: CatalogAdmissionRubric;
  readonly predictions: CatalogCalibratedPredictionSet;
  readonly features: CatalogFeatureSet;
  readonly substitutions: CatalogSubstitutionProposalSet;
}): CatalogDiscoveryReviewPlan {
  const policy = CATALOG_ADMISSION_POLICY_SCHEMA.parse(input.policy);
  const predictions = CATALOG_CALIBRATED_PREDICTION_SET_SCHEMA.parse(input.predictions);
  const features = CATALOG_FEATURE_SET_SCHEMA.parse(input.features);
  const substitutions = CATALOG_SUBSTITUTION_PROPOSAL_SET_SCHEMA.parse(input.substitutions);
  const featuresBySource = groupBy(features.receipts, (entry) => entry.sourceContentHash);
  const items: z.output<typeof DISCOVERY_ITEM_SCHEMA>[] = [];
  for (const prediction of predictions.predictions.filter(
    (entry) => entry.ablation === "combined",
  )) {
    const sourceFeatures = featuresBySource.get(prediction.sourceContentHash) ?? [];
    const maximumViewDisagreement = sourceFeatures.reduce(
      (maximum, entry) => Math.max(maximum, entry.maximumViewDisagreementMillionths),
      0,
    );
    const reasons: z.output<typeof CATALOG_DISCOVERY_REASON_SCHEMA>[] = [];
    if (prediction.outcome === "shifted") reasons.push("novelty");
    else if (prediction.outcome === "ambiguous") reasons.push("semantic_boundary");
    else if (prediction.outcome !== "resolved") reasons.push("missing_evidence");
    if (maximumViewDisagreement >= 300_000) reasons.push("view_disagreement");
    if (reasons.length === 0) continue;
    items.push({
      subjectKind: "asset",
      subjectId: prediction.sourceContentHash,
      sourceContentHashes: [prediction.sourceContentHash],
      reasons: canonicalValues(reasons, String, "discovery reasons"),
      evidenceHashes: canonicalValues(
        [predictions.hash, ...sourceFeatures.map((entry) => entry.hash)],
        String,
        "discovery evidence",
      ),
      priorityMillionths: Math.max(prediction.noveltyScoreMillionths, maximumViewDisagreement),
    });
  }
  for (const receipt of substitutions.compatibilityReceipts.filter(
    (entry) => entry.outcome === "uncertain",
  ))
    items.push({
      subjectKind: "pair",
      subjectId: `${receipt.leftSourceContentHash}:${receipt.rightSourceContentHash}`,
      sourceContentHashes: [receipt.leftSourceContentHash, receipt.rightSourceContentHash],
      reasons: ["substitution_boundary"],
      evidenceHashes: [receipt.hash],
      priorityMillionths: 1_000_000,
    });
  return sealArtifact(CATALOG_DISCOVERY_REVIEW_PLAN_SCHEMA, {
    kind: "CatalogDiscoveryReviewPlan" as const,
    status: items.length === 0 ? ("eligible" as const) : ("incomplete" as const),
    pilotPlanHash: input.pilotPlanHash,
    policyHash: policy.hash,
    rubricHash: input.rubric.hash,
    predictionSetHash: predictions.hash,
    featureSetHash: features.hash,
    substitutionProposalSetHash: substitutions.hash,
    samplingPurpose: "failure_discovery_not_acceptance_estimation" as const,
    items: canonicalValues(items, discoveryIdentity, "discovery items"),
    diagnostics:
      items.length === 0
        ? []
        : [`${items.length} deliberately biased subjects require discovery review`],
    compilerAuthority: false as const,
  });
}

const ACCEPTANCE_SAMPLE_SCHEMA = z
  .object({
    subjectKind: CATALOG_REVIEW_SUBJECT_KIND_SCHEMA,
    subjectId: z.string().trim().min(1).max(512),
  })
  .strict();

const ACCEPTANCE_STRATUM_PLAN_SCHEMA = z
  .object({
    riskId: ASCII_ID_SCHEMA,
    stratumId: ASCII_ID_SCHEMA,
    subjectKind: CATALOG_REVIEW_SUBJECT_KIND_SCHEMA,
    populationCount: z.number().int().nonnegative().max(10_000_000),
    maximumDefectRateMillionths: z.number().int().positive().max(1_000_000),
    confidenceMillionths: z.number().int().positive().max(999_999),
    acceptanceNumber: z.number().int().nonnegative().max(100),
    designDefectCount: z.number().int().nonnegative().max(10_000_000),
    sampleCount: z.number().int().nonnegative().max(10_000_000),
    acceptanceProbabilityAtDesignRateMillionths: z.number().int().min(0).max(1_000_000),
    samples: z.array(ACCEPTANCE_SAMPLE_SCHEMA).max(10_000_000),
  })
  .strict()
  .superRefine((value, context) => {
    requireCanonicalValues(value.samples, auditSubjectIdentity, "audit samples", context);
    if (value.samples.length !== value.sampleCount)
      context.addIssue({
        code: "custom",
        path: ["sampleCount"],
        message: "Audit sample count mismatch",
      });
  });

export const CATALOG_ACCEPTANCE_AUDIT_PLAN_SCHEMA = z
  .object({
    kind: z.literal("CatalogAcceptanceAuditPlan"),
    status: COMPILATION_STATUS_SCHEMA,
    pilotPlanHash: HASH_SCHEMA,
    policyHash: HASH_SCHEMA,
    rubricHash: HASH_SCHEMA,
    populationHash: HASH_SCHEMA,
    randomizationHash: HASH_SCHEMA,
    strata: z.array(ACCEPTANCE_STRATUM_PLAN_SCHEMA).max(128),
    diagnostics: z.array(z.string().trim().min(1).max(1024)).max(100_000),
    compilerAuthority: z.literal(false),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(value.strata, (entry) => entry.riskId, "audit strata", context);
    requireCanonicalValues(value.diagnostics, String, "audit diagnostics", context);
    const expected = value.diagnostics.length === 0 ? "eligible" : "incomplete";
    if (value.status !== expected)
      context.addIssue({ code: "custom", path: ["status"], message: "Audit-plan status mismatch" });
  });
export type CatalogAcceptanceAuditPlan = z.output<typeof CATALOG_ACCEPTANCE_AUDIT_PLAN_SCHEMA>;

export function buildCatalogAcceptanceAuditPlan(input: {
  readonly pilotPlanHash: string;
  readonly policy: CatalogAdmissionPolicy;
  readonly rubric: CatalogAdmissionRubric;
  readonly randomizationHash: string;
  readonly populations: Readonly<
    Record<string, readonly z.output<typeof ACCEPTANCE_SAMPLE_SCHEMA>[]>
  >;
}): CatalogAcceptanceAuditPlan {
  const policy = CATALOG_ADMISSION_POLICY_SCHEMA.parse(input.policy);
  const diagnostics: string[] = [];
  const canonicalPopulations = policy.riskTargets.map((target) => {
    const population = canonicalValues(
      input.populations[target.riskId] ?? [],
      auditSubjectIdentity,
      `audit population ${target.riskId}`,
    );
    if (population.some((entry) => entry.subjectKind !== target.subjectKind))
      throw new Error(`Audit population ${target.riskId} contains the wrong subject kind`);
    if (population.length === 0)
      diagnostics.push(`Risk target ${target.riskId} has no qualified population to audit`);
    return { target, population };
  });
  const populationHash = contentHash(
    JSON.stringify(
      canonicalPopulations.map(({ target, population }) => ({ riskId: target.riskId, population })),
    ),
  );
  const strata = canonicalPopulations.map(({ target, population }) => {
    const designDefectCount = Math.min(
      population.length,
      Math.max(1, Math.ceil((target.maximumDefectRateMillionths / 1_000_000) * population.length)),
    );
    const design = exactAcceptanceSampleSize({
      populationCount: population.length,
      designDefectCount,
      acceptanceNumber: target.acceptanceNumber,
      confidenceMillionths: target.confidenceMillionths,
    });
    const ranked = [...population].sort((left, right) =>
      compareCanonicalStrings(
        contentHash(`${input.randomizationHash}:${target.riskId}:${auditSubjectIdentity(left)}`),
        contentHash(`${input.randomizationHash}:${target.riskId}:${auditSubjectIdentity(right)}`),
      ),
    );
    return {
      riskId: target.riskId,
      stratumId: target.stratumId,
      subjectKind: target.subjectKind,
      populationCount: population.length,
      maximumDefectRateMillionths: target.maximumDefectRateMillionths,
      confidenceMillionths: target.confidenceMillionths,
      acceptanceNumber: target.acceptanceNumber,
      designDefectCount: population.length === 0 ? 0 : designDefectCount,
      sampleCount: design.sampleCount,
      acceptanceProbabilityAtDesignRateMillionths: design.acceptanceProbabilityMillionths,
      samples: canonicalValues(
        ranked.slice(0, design.sampleCount),
        auditSubjectIdentity,
        `audit samples ${target.riskId}`,
      ),
    };
  });
  return sealArtifact(CATALOG_ACCEPTANCE_AUDIT_PLAN_SCHEMA, {
    kind: "CatalogAcceptanceAuditPlan" as const,
    status: diagnostics.length === 0 ? ("eligible" as const) : ("incomplete" as const),
    pilotPlanHash: input.pilotPlanHash,
    policyHash: policy.hash,
    rubricHash: input.rubric.hash,
    populationHash,
    randomizationHash: HASH_SCHEMA.parse(input.randomizationHash),
    strata: canonicalValues(strata, (entry) => entry.riskId, "audit strata"),
    diagnostics: canonicalValues(diagnostics, String, "audit diagnostics"),
    compilerAuthority: false as const,
  });
}

const AUDIT_FINDING_SCHEMA = z
  .object({
    subjectKind: CATALOG_REVIEW_SUBJECT_KIND_SCHEMA,
    subjectId: z.string().trim().min(1).max(512),
    outcome: z.enum(["conforms", "defect"]),
    defectId: ASCII_ID_SCHEMA.optional(),
    note: z.string().trim().min(1).max(2048),
    evidenceHashes: z.array(HASH_SCHEMA).min(1).max(64),
  })
  .strict()
  .superRefine((value, context) => {
    requireCanonicalValues(value.evidenceHashes, String, "audit finding evidence", context);
    if ((value.outcome === "defect") !== (value.defectId !== undefined))
      context.addIssue({
        code: "custom",
        path: ["defectId"],
        message: "Defects require one defect ID; conforming findings forbid it",
      });
  });

export const CATALOG_ACCEPTANCE_AUDIT_RECEIPT_SCHEMA = z
  .object({
    kind: z.literal("CatalogAcceptanceAuditReceipt"),
    status: COMPILATION_STATUS_SCHEMA,
    auditPlanHash: HASH_SCHEMA,
    riskId: ASCII_ID_SCHEMA,
    reviewerId: ASCII_ID_SCHEMA,
    referenceAuthority: z.literal("human_curator"),
    findings: z.array(AUDIT_FINDING_SCHEMA).max(10_000_000),
    defectCount: z.number().int().nonnegative().max(10_000_000),
    acceptanceNumber: z.number().int().nonnegative().max(100),
    outcome: z.enum(["passed", "failed", "incomplete"]),
    diagnostics: z.array(z.string().trim().min(1).max(1024)).max(100_000),
    compilerAuthority: z.literal(false),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(value.findings, auditFindingIdentity, "audit findings", context);
    requireCanonicalValues(value.diagnostics, String, "audit receipt diagnostics", context);
    if (value.defectCount !== value.findings.filter((entry) => entry.outcome === "defect").length)
      context.addIssue({
        code: "custom",
        path: ["defectCount"],
        message: "Audit defect count mismatch",
      });
  });
export type CatalogAcceptanceAuditReceipt = z.output<
  typeof CATALOG_ACCEPTANCE_AUDIT_RECEIPT_SCHEMA
>;

export function sealCatalogAcceptanceAuditReceipt(input: {
  readonly plan: CatalogAcceptanceAuditPlan;
  readonly riskId: string;
  readonly reviewerId: string;
  readonly findings: readonly z.output<typeof AUDIT_FINDING_SCHEMA>[];
}): CatalogAcceptanceAuditReceipt {
  const plan = CATALOG_ACCEPTANCE_AUDIT_PLAN_SCHEMA.parse(input.plan);
  const stratum = plan.strata.find((entry) => entry.riskId === input.riskId);
  if (!stratum) throw new Error(`Unknown audit risk ${input.riskId}`);
  const findings = canonicalValues(input.findings, auditFindingIdentity, "audit findings");
  const expected = canonicalValues(
    stratum.samples,
    auditSubjectIdentity,
    "expected audit samples",
  ).map(auditSubjectIdentity);
  const actual = findings.map(auditFindingIdentity);
  const complete =
    expected.length === actual.length && expected.every((entry, index) => entry === actual[index]);
  const defectCount = findings.filter((entry) => entry.outcome === "defect").length;
  const outcome = !complete
    ? "incomplete"
    : defectCount <= stratum.acceptanceNumber
      ? "passed"
      : "failed";
  return sealArtifact(CATALOG_ACCEPTANCE_AUDIT_RECEIPT_SCHEMA, {
    kind: "CatalogAcceptanceAuditReceipt" as const,
    status:
      outcome === "passed"
        ? ("eligible" as const)
        : outcome === "failed"
          ? ("rejected" as const)
          : ("incomplete" as const),
    auditPlanHash: plan.hash,
    riskId: stratum.riskId,
    reviewerId: input.reviewerId,
    referenceAuthority: "human_curator" as const,
    findings,
    defectCount,
    acceptanceNumber: stratum.acceptanceNumber,
    outcome,
    diagnostics: complete ? [] : ["Audit findings do not cover the exact probability sample"],
    compilerAuthority: false as const,
  });
}

/**
 * Exact hypergeometric acceptance design for a finite population. The returned
 * sample is the smallest n whose chance of accepting a population at the design
 * defect count is at most 1-confidence.
 */
export function exactAcceptanceSampleSize(input: {
  readonly populationCount: number;
  readonly designDefectCount: number;
  readonly acceptanceNumber: number;
  readonly confidenceMillionths: number;
}): { sampleCount: number; acceptanceProbabilityMillionths: number } {
  const { populationCount: population, designDefectCount: defects, acceptanceNumber } = input;
  if (population === 0) return { sampleCount: 0, acceptanceProbabilityMillionths: 0 };
  if (
    !Number.isInteger(population) ||
    !Number.isInteger(defects) ||
    defects < 0 ||
    defects > population
  )
    throw new Error("Invalid finite audit population");
  const maximumAcceptanceProbability = 1 - input.confidenceMillionths / 1_000_000;
  for (let sampleCount = 0; sampleCount <= population; sampleCount += 1) {
    const probability = hypergeometricCdf(population, defects, sampleCount, acceptanceNumber);
    if (probability <= maximumAcceptanceProbability + Number.EPSILON)
      return {
        sampleCount,
        acceptanceProbabilityMillionths: Math.round(probability * 1_000_000),
      };
  }
  return { sampleCount: population, acceptanceProbabilityMillionths: 0 };
}

function hypergeometricCdf(
  population: number,
  defects: number,
  sampleCount: number,
  acceptanceNumber: number,
): number {
  let total = 0;
  const maximum = Math.min(acceptanceNumber, defects, sampleCount);
  const minimum = Math.max(0, sampleCount - (population - defects));
  for (let observed = minimum; observed <= maximum; observed += 1)
    total += Math.exp(
      logChoose(defects, observed) +
        logChoose(population - defects, sampleCount - observed) -
        logChoose(population, sampleCount),
    );
  return Math.min(1, total);
}

function logChoose(total: number, selected: number): number {
  if (selected < 0 || selected > total) return Number.NEGATIVE_INFINITY;
  const count = Math.min(selected, total - selected);
  let result = 0;
  for (let index = 1; index <= count; index += 1)
    result += Math.log(total - count + index) - Math.log(index);
  return result;
}

function discoveryIdentity(item: z.output<typeof DISCOVERY_ITEM_SCHEMA>): string {
  return `${item.subjectKind}:${item.subjectId}`;
}

function auditSubjectIdentity(item: z.output<typeof ACCEPTANCE_SAMPLE_SCHEMA>): string {
  return `${item.subjectKind}:${item.subjectId}`;
}

function auditFindingIdentity(item: z.output<typeof AUDIT_FINDING_SCHEMA>): string {
  return `${item.subjectKind}:${item.subjectId}`;
}

function groupBy<T>(values: readonly T[], key: (value: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const group = groups.get(key(value)) ?? [];
    group.push(value);
    groups.set(key(value), group);
  }
  return groups;
}
