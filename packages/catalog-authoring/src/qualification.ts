import { z } from "zod";
import { COMPILATION_STATUS_SCHEMA, HASH_SCHEMA } from "@basalt/contracts";
import {
  CATALOG_ADAPTER_CALIBRATION_RECEIPT_SCHEMA,
  CATALOG_CALIBRATED_PREDICTION_SET_SCHEMA,
  CATALOG_REFERENCE_JUDGMENT_SET_SCHEMA,
  type CatalogAdapterCalibrationReceipt,
  type CatalogCalibratedPredictionSet,
  type CatalogReferenceJudgmentSet,
} from "./prediction.js";
import {
  CATALOG_ACCEPTANCE_AUDIT_PLAN_SCHEMA,
  CATALOG_ACCEPTANCE_AUDIT_RECEIPT_SCHEMA,
  type CatalogAcceptanceAuditPlan,
  type CatalogAcceptanceAuditReceipt,
} from "./review.js";
import {
  CATALOG_SUBSTITUTION_PROPOSAL_SET_SCHEMA,
  type CatalogSubstitutionProposalSet,
} from "./substitution.js";
import { CATALOG_ADMISSION_POLICY_SCHEMA, type CatalogAdmissionPolicy } from "./policy.js";
import { CATALOG_PREDICTION_FACET_SCHEMA, facetValueKey } from "./facets.js";
import {
  CATALOG_INFERENCE_ABLATION_SCHEMA,
  type CatalogHypothesisReceiptSet,
} from "./hypothesis.js";
import {
  canonicalValues,
  requireCanonicalValues,
  sealArtifact,
  verifyArtifactHash,
} from "./artifact.js";

const EVALUATION_METRIC_SCHEMA = z
  .object({
    ablation: CATALOG_INFERENCE_ABLATION_SCHEMA,
    assertionKind: CATALOG_PREDICTION_FACET_SCHEMA,
    referenceCount: z.number().int().nonnegative().max(100_000),
    resolvedCount: z.number().int().nonnegative().max(100_000),
    correctResolvedCount: z.number().int().nonnegative().max(100_000),
    exactPrecisionMillionths: z.number().int().min(0).max(1_000_000),
    coverageMillionths: z.number().int().min(0).max(1_000_000),
    meanPredictionSetSizeMillionths: z.number().int().nonnegative().max(64_000_000),
  })
  .strict();

export const CATALOG_QUALIFICATION_RECEIPT_SCHEMA = z
  .object({
    kind: z.literal("CatalogQualificationReceipt"),
    status: COMPILATION_STATUS_SCHEMA,
    policyHash: HASH_SCHEMA,
    pilotPlanHash: HASH_SCHEMA,
    rubricHash: HASH_SCHEMA,
    requestSetHash: HASH_SCHEMA,
    receiptSetHash: HASH_SCHEMA,
    referenceJudgmentSetHash: HASH_SCHEMA,
    calibrationHashes: z.array(HASH_SCHEMA).max(1024),
    predictionSetHash: HASH_SCHEMA,
    substitutionProposalSetHash: HASH_SCHEMA,
    auditPlanHash: HASH_SCHEMA,
    auditReceiptHashes: z.array(HASH_SCHEMA).max(128),
    evaluationMetrics: z.array(EVALUATION_METRIC_SCHEMA).max(15),
    qualificationScope: z.literal("low_risk_static_single_part_single_material_bottom_contact"),
    authorityBasis: z.enum(["none", "policy_qualified"]),
    diagnostics: z.array(z.string().trim().min(1).max(2048)).max(100_000),
    compilerAuthority: z.literal(false),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(value.calibrationHashes, String, "qualification calibrations", context);
    requireCanonicalValues(value.auditReceiptHashes, String, "qualification audits", context);
    requireCanonicalValues(
      value.evaluationMetrics,
      (entry) => `${entry.ablation}:${entry.assertionKind}`,
      "qualification metrics",
      context,
    );
    requireCanonicalValues(value.diagnostics, String, "qualification diagnostics", context);
    if ((value.status === "eligible") !== (value.authorityBasis === "policy_qualified"))
      context.addIssue({
        code: "custom",
        path: ["authorityBasis"],
        message: "Only an eligible qualification receipt may claim policy qualification",
      });
  });
export type CatalogQualificationReceipt = z.output<typeof CATALOG_QUALIFICATION_RECEIPT_SCHEMA>;

export function buildCatalogQualificationReceipt(input: {
  readonly policy: CatalogAdmissionPolicy;
  readonly pilotPlanHash: string;
  readonly rubricHash: string;
  readonly receipts: CatalogHypothesisReceiptSet;
  readonly references: CatalogReferenceJudgmentSet;
  readonly calibrations: readonly CatalogAdapterCalibrationReceipt[];
  readonly predictions: CatalogCalibratedPredictionSet;
  readonly substitutions: CatalogSubstitutionProposalSet;
  readonly auditPlan: CatalogAcceptanceAuditPlan;
  readonly auditReceipts: readonly CatalogAcceptanceAuditReceipt[];
}): CatalogQualificationReceipt {
  const policy = CATALOG_ADMISSION_POLICY_SCHEMA.parse(input.policy);
  const references = CATALOG_REFERENCE_JUDGMENT_SET_SCHEMA.parse(input.references);
  const calibrations = input.calibrations.map((entry) =>
    CATALOG_ADAPTER_CALIBRATION_RECEIPT_SCHEMA.parse(entry),
  );
  const predictions = CATALOG_CALIBRATED_PREDICTION_SET_SCHEMA.parse(input.predictions);
  const substitutions = CATALOG_SUBSTITUTION_PROPOSAL_SET_SCHEMA.parse(input.substitutions);
  const auditPlan = CATALOG_ACCEPTANCE_AUDIT_PLAN_SCHEMA.parse(input.auditPlan);
  const audits = input.auditReceipts.map((entry) =>
    CATALOG_ACCEPTANCE_AUDIT_RECEIPT_SCHEMA.parse(entry),
  );
  const diagnostics: string[] = [];
  if (references.referenceAuthority !== "human_curator" || references.status !== "eligible")
    diagnostics.push("A complete human-curator reference set is required for qualification");
  if (calibrations.length === 0 || calibrations.some((entry) => entry.status !== "eligible"))
    diagnostics.push("Every deployed inference source requires eligible held-out calibration");
  if (predictions.status !== "eligible")
    diagnostics.push("The locked evaluation population contains unresolved calibrated predictions");
  if (substitutions.status !== "eligible")
    diagnostics.push(
      "The locked evaluation population lacks complete pairwise substitution evidence",
    );
  if (auditPlan.status !== "eligible") diagnostics.push("The acceptance-audit plan is incomplete");
  const expectedRisks = new Set(auditPlan.strata.map((entry) => entry.riskId));
  const suppliedRisks = new Set(audits.map((entry) => entry.riskId));
  if (
    expectedRisks.size !== suppliedRisks.size ||
    [...expectedRisks].some((riskId) => !suppliedRisks.has(riskId)) ||
    audits.some((entry) => entry.outcome !== "passed")
  )
    diagnostics.push("Every risk stratum requires an exact, passing human acceptance audit");
  const metrics = computeEvaluationMetrics(predictions, references);
  const uniqueDiagnostics = canonicalValues(diagnostics, String, "qualification diagnostics");
  return sealArtifact(CATALOG_QUALIFICATION_RECEIPT_SCHEMA, {
    kind: "CatalogQualificationReceipt" as const,
    status: uniqueDiagnostics.length === 0 ? ("eligible" as const) : ("incomplete" as const),
    policyHash: policy.hash,
    pilotPlanHash: input.pilotPlanHash,
    rubricHash: input.rubricHash,
    requestSetHash: input.receipts.requestSetHash,
    receiptSetHash: input.receipts.hash,
    referenceJudgmentSetHash: references.hash,
    calibrationHashes: canonicalValues(
      calibrations.map((entry) => entry.hash),
      String,
      "qualification calibrations",
    ),
    predictionSetHash: predictions.hash,
    substitutionProposalSetHash: substitutions.hash,
    auditPlanHash: auditPlan.hash,
    auditReceiptHashes: canonicalValues(
      audits.map((entry) => entry.hash),
      String,
      "qualification audits",
    ),
    evaluationMetrics: canonicalValues(
      metrics,
      (entry) => `${entry.ablation}:${entry.assertionKind}`,
      "qualification metrics",
    ),
    qualificationScope: "low_risk_static_single_part_single_material_bottom_contact" as const,
    authorityBasis:
      uniqueDiagnostics.length === 0 ? ("policy_qualified" as const) : ("none" as const),
    diagnostics: uniqueDiagnostics,
    compilerAuthority: false as const,
  });
}

function computeEvaluationMetrics(
  predictions: CatalogCalibratedPredictionSet,
  references: CatalogReferenceJudgmentSet,
): z.output<typeof EVALUATION_METRIC_SCHEMA>[] {
  const evaluation = new Map(
    references.judgments
      .filter((entry) => entry.role === "evaluation" && entry.disposition === "eligible")
      .map((entry) => [entry.sourceContentHash, entry] as const),
  );
  const result: z.output<typeof EVALUATION_METRIC_SCHEMA>[] = [];
  for (const ablation of CATALOG_INFERENCE_ABLATION_SCHEMA.options)
    for (const assertionKind of CATALOG_PREDICTION_FACET_SCHEMA.options) {
      const relevant = predictions.predictions.filter(
        (entry) => entry.ablation === ablation && evaluation.has(entry.sourceContentHash),
      );
      let resolved = 0;
      let correct = 0;
      let totalSetSize = 0;
      for (const prediction of relevant) {
        const facet = prediction.facets.find((entry) => entry.assertionKind === assertionKind);
        if (!facet) continue;
        totalSetSize += facet.candidates.length;
        if (facet.outcome !== "singleton") continue;
        resolved += 1;
        const expected = new Set(
          evaluation
            .get(prediction.sourceContentHash)!
            .values.filter((entry) => entry.assertionKind === assertionKind)
            .map(facetValueKey),
        );
        if (expected.has(facetValueKey(facet.candidates[0]!.value))) correct += 1;
      }
      result.push({
        ablation,
        assertionKind,
        referenceCount: relevant.length,
        resolvedCount: resolved,
        correctResolvedCount: correct,
        exactPrecisionMillionths: resolved === 0 ? 0 : Math.round((correct / resolved) * 1_000_000),
        coverageMillionths:
          relevant.length === 0 ? 0 : Math.round((resolved / relevant.length) * 1_000_000),
        meanPredictionSetSizeMillionths:
          relevant.length === 0 ? 0 : Math.round((totalSetSize / relevant.length) * 1_000_000),
      });
    }
  return result;
}
