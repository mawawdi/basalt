import { z } from "zod";
import {
  ASCII_ID_SCHEMA,
  COMPILATION_STATUS_SCHEMA,
  HASH_SCHEMA,
  compareCanonicalStrings,
} from "@basalt/contracts";
import type { SemanticModule } from "@basalt/semantic-kernel";
import { CATALOG_CALIBRATION_ROLE_SCHEMA } from "./calibration.js";
import {
  CATALOG_FACET_VALUE_SCHEMA,
  CATALOG_PREDICTION_FACET_SCHEMA,
  facetValueFromAssertion,
  facetValueKey,
  type CatalogFacetValue,
  type CatalogPredictionFacet,
} from "./facets.js";
import {
  CATALOG_HYPOTHESIS_RECEIPT_SET_SCHEMA,
  CATALOG_HYPOTHESIS_REQUEST_SET_SCHEMA,
  CATALOG_INFERENCE_ABLATION_SCHEMA,
  type AssetSemanticHypothesisReceipt,
  type CatalogHypothesisReceiptSet,
  type CatalogHypothesisRequestSet,
} from "./hypothesis.js";
import { CATALOG_ADMISSION_POLICY_SCHEMA, type CatalogAdmissionPolicy } from "./policy.js";
import {
  canonicalValues,
  requireCanonicalValues,
  sealArtifact,
  verifyArtifactHash,
} from "./artifact.js";

const REFERENCE_AUTHORITY_SCHEMA = z.enum(["human_curator", "research_proxy"]);

const REFERENCE_JUDGMENT_SCHEMA = z
  .object({
    sourceContentHash: HASH_SCHEMA,
    leakageGroupHash: HASH_SCHEMA,
    role: CATALOG_CALIBRATION_ROLE_SCHEMA,
    disposition: z.enum(["eligible", "incomplete", "rejected"]),
    values: z.array(CATALOG_FACET_VALUE_SCHEMA).max(256),
    evidenceHashes: z.array(HASH_SCHEMA).min(1).max(256),
    note: z.string().trim().min(1).max(4096),
  })
  .strict()
  .superRefine((value, context) => {
    requireCanonicalValues(value.values, facetValueKey, "reference facet values", context);
    requireCanonicalValues(value.evidenceHashes, String, "reference evidence", context);
  });

export const CATALOG_REFERENCE_JUDGMENT_SET_SCHEMA = z
  .object({
    kind: z.literal("CatalogReferenceJudgmentSet"),
    status: COMPILATION_STATUS_SCHEMA,
    pilotPlanHash: HASH_SCHEMA,
    rubricHash: HASH_SCHEMA,
    referenceAuthority: REFERENCE_AUTHORITY_SCHEMA,
    reviewerId: ASCII_ID_SCHEMA,
    judgments: z.array(REFERENCE_JUDGMENT_SCHEMA).max(100_000),
    missingSourceContentHashes: z.array(HASH_SCHEMA).max(100_000),
    diagnostics: z.array(z.string().trim().min(1).max(1024)).max(100_000),
    compilerAuthority: z.literal(false),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(
      value.judgments,
      (entry) => entry.sourceContentHash,
      "reference judgments",
      context,
    );
    requireCanonicalValues(
      value.missingSourceContentHashes,
      String,
      "missing reference judgments",
      context,
    );
    requireCanonicalValues(value.diagnostics, String, "reference diagnostics", context);
    const expected = value.missingSourceContentHashes.length === 0 ? "eligible" : "incomplete";
    if (value.status !== expected)
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Reference-judgment status mismatch",
      });
  });
export type CatalogReferenceJudgmentSet = z.output<typeof CATALOG_REFERENCE_JUDGMENT_SET_SCHEMA>;

export function sealCatalogReferenceJudgmentSet(
  input: Omit<CatalogReferenceJudgmentSet, "kind" | "status" | "compilerAuthority" | "hash">,
): CatalogReferenceJudgmentSet {
  const judgments = canonicalValues(
    input.judgments.map((judgment) => ({
      ...judgment,
      values: canonicalValues(judgment.values, facetValueKey, "reference facet values"),
      evidenceHashes: canonicalValues(judgment.evidenceHashes, String, "reference evidence"),
    })),
    (entry) => entry.sourceContentHash,
    "reference judgments",
  );
  const missing = canonicalValues(
    input.missingSourceContentHashes,
    String,
    "missing reference judgments",
  );
  return sealArtifact(CATALOG_REFERENCE_JUDGMENT_SET_SCHEMA, {
    kind: "CatalogReferenceJudgmentSet" as const,
    status: missing.length === 0 ? ("eligible" as const) : ("incomplete" as const),
    ...input,
    judgments,
    missingSourceContentHashes: missing,
    diagnostics: canonicalValues(input.diagnostics, String, "reference diagnostics"),
    compilerAuthority: false as const,
  });
}

export const CATALOG_FACET_CALIBRATION_SCHEMA = z
  .object({
    assertionKind: CATALOG_PREDICTION_FACET_SCHEMA,
    sampleCount: z.number().int().nonnegative().max(100_000),
    acceptedPredictionCount: z.number().int().nonnegative().max(100_000),
    correctPredictionCount: z.number().int().nonnegative().max(100_000),
    thresholdMillionths: z.number().int().min(0).max(1_000_000),
    empiricalPrecisionMillionths: z.number().int().min(0).max(1_000_000),
    precisionLowerBoundMillionths: z.number().int().min(0).max(1_000_000),
    empiricalCoverageMillionths: z.number().int().min(0).max(1_000_000),
    qualified: z.boolean(),
  })
  .strict();

export const CATALOG_ADAPTER_CALIBRATION_RECEIPT_SCHEMA = z
  .object({
    kind: z.literal("CatalogAdapterCalibrationReceipt"),
    status: COMPILATION_STATUS_SCHEMA,
    policyHash: HASH_SCHEMA,
    pilotPlanHash: HASH_SCHEMA,
    requestSetHash: HASH_SCHEMA,
    receiptSetHash: HASH_SCHEMA,
    referenceJudgmentSetHash: HASH_SCHEMA,
    referenceAuthority: REFERENCE_AUTHORITY_SCHEMA,
    adapterId: ASCII_ID_SCHEMA,
    adapterImplementationHash: HASH_SCHEMA,
    modelImplementationHash: HASH_SCHEMA,
    dependencyGroupId: ASCII_ID_SCHEMA,
    ablation: CATALOG_INFERENCE_ABLATION_SCHEMA,
    facets: z.array(CATALOG_FACET_CALIBRATION_SCHEMA).max(5),
    diagnostics: z.array(z.string().trim().min(1).max(1024)).max(10_000),
    compilerAuthority: z.literal(false),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(
      value.facets,
      (entry) => entry.assertionKind,
      "facet calibrations",
      context,
    );
    requireCanonicalValues(value.diagnostics, String, "calibration diagnostics", context);
    const expected =
      value.referenceAuthority === "human_curator" &&
      value.facets.length > 0 &&
      value.facets.every((facet) => facet.qualified)
        ? "eligible"
        : "incomplete";
    if (value.status !== expected)
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Calibration status mismatch",
      });
  });
export type CatalogAdapterCalibrationReceipt = z.output<
  typeof CATALOG_ADAPTER_CALIBRATION_RECEIPT_SCHEMA
>;

export const CATALOG_ADAPTER_CALIBRATION_SET_SCHEMA = z
  .object({
    kind: z.literal("CatalogAdapterCalibrationSet"),
    status: COMPILATION_STATUS_SCHEMA,
    policyHash: HASH_SCHEMA,
    pilotPlanHash: HASH_SCHEMA,
    requestSetHash: HASH_SCHEMA,
    receiptSetHash: HASH_SCHEMA,
    referenceJudgmentSetHash: HASH_SCHEMA,
    receipts: z.array(CATALOG_ADAPTER_CALIBRATION_RECEIPT_SCHEMA).max(1024),
    diagnostics: z.array(z.string().trim().min(1).max(1024)).max(10_000),
    compilerAuthority: z.literal(false),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(value.receipts, calibrationIdentity, "adapter calibrations", context);
    requireCanonicalValues(value.diagnostics, String, "adapter calibration diagnostics", context);
    const expected =
      value.receipts.length > 0 && value.receipts.every((receipt) => receipt.status === "eligible")
        ? "eligible"
        : "incomplete";
    if (value.status !== expected)
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Adapter-calibration-set status mismatch",
      });
  });
export type CatalogAdapterCalibrationSet = z.output<typeof CATALOG_ADAPTER_CALIBRATION_SET_SCHEMA>;

export function sealCatalogAdapterCalibrationSet(input: {
  readonly policyHash: string;
  readonly pilotPlanHash: string;
  readonly requestSetHash: string;
  readonly receiptSetHash: string;
  readonly referenceJudgmentSetHash: string;
  readonly receipts: readonly CatalogAdapterCalibrationReceipt[];
  readonly diagnostics?: readonly string[];
}): CatalogAdapterCalibrationSet {
  const receipts = canonicalValues(
    input.receipts.map((receipt) => CATALOG_ADAPTER_CALIBRATION_RECEIPT_SCHEMA.parse(receipt)),
    calibrationIdentity,
    "adapter calibrations",
  );
  const diagnostics = canonicalValues(
    [
      ...(input.diagnostics ?? []),
      ...(receipts.length === 0 ? ["No adapter calibrations were produced"] : []),
      ...receipts.flatMap((receipt) =>
        receipt.status === "eligible" ? [] : [`${calibrationIdentity(receipt)} is not qualified`],
      ),
    ],
    String,
    "adapter calibration diagnostics",
  );
  return sealArtifact(CATALOG_ADAPTER_CALIBRATION_SET_SCHEMA, {
    kind: "CatalogAdapterCalibrationSet" as const,
    status:
      receipts.length > 0 && receipts.every((receipt) => receipt.status === "eligible")
        ? ("eligible" as const)
        : ("incomplete" as const),
    policyHash: HASH_SCHEMA.parse(input.policyHash),
    pilotPlanHash: HASH_SCHEMA.parse(input.pilotPlanHash),
    requestSetHash: HASH_SCHEMA.parse(input.requestSetHash),
    receiptSetHash: HASH_SCHEMA.parse(input.receiptSetHash),
    referenceJudgmentSetHash: HASH_SCHEMA.parse(input.referenceJudgmentSetHash),
    receipts,
    diagnostics,
    compilerAuthority: false as const,
  });
}

export function calibrateCatalogAdapter(input: {
  readonly policy: CatalogAdmissionPolicy;
  readonly pilotPlanHash: string;
  readonly requests: CatalogHypothesisRequestSet;
  readonly receipts: CatalogHypothesisReceiptSet;
  readonly judgments: CatalogReferenceJudgmentSet;
  readonly adapterImplementationHash: string;
  readonly modelImplementationHash: string;
  readonly ablation: z.output<typeof CATALOG_INFERENCE_ABLATION_SCHEMA>;
}): CatalogAdapterCalibrationReceipt {
  const policy = CATALOG_ADMISSION_POLICY_SCHEMA.parse(input.policy);
  const requests = CATALOG_HYPOTHESIS_REQUEST_SET_SCHEMA.parse(input.requests);
  const receipts = CATALOG_HYPOTHESIS_RECEIPT_SET_SCHEMA.parse(input.receipts);
  const judgments = CATALOG_REFERENCE_JUDGMENT_SET_SCHEMA.parse(input.judgments);
  const relevant = receipts.receipts.filter(
    (receipt) =>
      receipt.adapterImplementationHash === input.adapterImplementationHash &&
      receipt.modelImplementationHash === input.modelImplementationHash &&
      receipt.ablation === input.ablation,
  );
  const identity = relevant[0];
  if (!identity) throw new Error("No hypothesis receipts match the requested adapter calibration");
  if (
    relevant.some(
      (receipt) =>
        receipt.adapterId !== identity.adapterId ||
        receipt.dependencyGroupId !== identity.dependencyGroupId,
    )
  )
    throw new Error("One calibration receipt cannot combine adapter or dependency identities");
  const judgmentsBySource = new Map(
    judgments.judgments
      .filter((judgment) => judgment.role === "calibration")
      .map((judgment) => [judgment.sourceContentHash, judgment] as const),
  );
  const facets = policy.prediction.requiredAssertionKinds.map((assertionKind) =>
    calibrateFacet(
      assertionKind,
      relevant,
      judgmentsBySource,
      policy.prediction.minimumCalibrationSamples,
      policy.prediction.minimumPrecisionLowerBoundMillionths,
      policy.prediction.calibrationConfidenceMillionths,
    ),
  );
  const diagnostics = [
    ...(judgments.referenceAuthority === "research_proxy"
      ? ["Research-proxy judgments can measure plumbing but cannot qualify an adapter"]
      : []),
    ...facets.flatMap((facet) =>
      facet.qualified
        ? []
        : [
            `${facet.assertionKind} failed calibration: n=${facet.sampleCount}, lower precision=${facet.precisionLowerBoundMillionths}`,
          ],
    ),
  ];
  const status =
    judgments.referenceAuthority === "human_curator" && facets.every((facet) => facet.qualified)
      ? ("eligible" as const)
      : ("incomplete" as const);
  return sealArtifact(CATALOG_ADAPTER_CALIBRATION_RECEIPT_SCHEMA, {
    kind: "CatalogAdapterCalibrationReceipt" as const,
    status,
    policyHash: policy.hash,
    pilotPlanHash: input.pilotPlanHash,
    requestSetHash: requests.hash,
    receiptSetHash: receipts.hash,
    referenceJudgmentSetHash: judgments.hash,
    referenceAuthority: judgments.referenceAuthority,
    adapterId: identity.adapterId,
    adapterImplementationHash: identity.adapterImplementationHash,
    modelImplementationHash: identity.modelImplementationHash,
    dependencyGroupId: identity.dependencyGroupId,
    ablation: identity.ablation,
    facets: canonicalValues(facets, (facet) => facet.assertionKind, "facet calibrations"),
    diagnostics: canonicalValues(diagnostics, String, "calibration diagnostics"),
    compilerAuthority: false as const,
  });
}

export const CATALOG_PREDICTION_CANDIDATE_SCHEMA = z
  .object({
    value: CATALOG_FACET_VALUE_SCHEMA,
    aggregateScoreMillionths: z.number().int().min(0).max(1_000_000),
    conservativePrecisionMillionths: z.number().int().min(0).max(1_000_000),
    dependencyGroupIds: z.array(ASCII_ID_SCHEMA).min(1).max(16),
    receiptHashes: z.array(HASH_SCHEMA).min(1).max(64),
    calibrationHashes: z.array(HASH_SCHEMA).min(1).max(64),
  })
  .strict()
  .superRefine((value, context) => {
    requireCanonicalValues(
      value.dependencyGroupIds,
      String,
      "candidate dependency groups",
      context,
    );
    requireCanonicalValues(value.receiptHashes, String, "candidate receipts", context);
    requireCanonicalValues(value.calibrationHashes, String, "candidate calibrations", context);
  });

export const CATALOG_FACET_PREDICTION_SCHEMA = z
  .object({
    assertionKind: CATALOG_PREDICTION_FACET_SCHEMA,
    outcome: z.enum(["singleton", "set", "unknown", "insufficient_calibration"]),
    candidates: z.array(CATALOG_PREDICTION_CANDIDATE_SCHEMA).max(64),
  })
  .strict()
  .superRefine((value, context) => {
    requireCanonicalValues(
      value.candidates,
      (entry) => facetValueKey(entry.value),
      "prediction candidates",
      context,
    );
    if (value.candidates.some((candidate) => candidate.value.assertionKind !== value.assertionKind))
      context.addIssue({
        code: "custom",
        path: ["candidates"],
        message: "Candidate facet mismatch",
      });
    const expected =
      value.outcome === "singleton"
        ? 1
        : value.outcome === "set"
          ? Math.max(2, value.candidates.length)
          : 0;
    if (
      (value.outcome === "singleton" && value.candidates.length !== expected) ||
      (value.outcome === "set" && value.candidates.length < 2) ||
      ((value.outcome === "unknown" || value.outcome === "insufficient_calibration") &&
        value.candidates.length !== 0)
    )
      context.addIssue({
        code: "custom",
        path: ["outcome"],
        message: "Facet outcome/cardinality mismatch",
      });
  });

export const CATALOG_SOURCE_PREDICTION_SCHEMA = z
  .object({
    sourceContentHash: HASH_SCHEMA,
    ablation: CATALOG_INFERENCE_ABLATION_SCHEMA,
    outcome: z.enum(["resolved", "ambiguous", "unknown", "shifted", "insufficient_calibration"]),
    noveltyScoreMillionths: z.number().int().min(0).max(1_000_000),
    facets: z.array(CATALOG_FACET_PREDICTION_SCHEMA).max(5),
    diagnostics: z.array(z.string().trim().min(1).max(1024)).max(256),
  })
  .strict()
  .superRefine((value, context) => {
    requireCanonicalValues(
      value.facets,
      (entry) => entry.assertionKind,
      "source prediction facets",
      context,
    );
    requireCanonicalValues(value.diagnostics, String, "source prediction diagnostics", context);
  });

export const CATALOG_CALIBRATED_PREDICTION_SET_SCHEMA = z
  .object({
    kind: z.literal("CatalogCalibratedPredictionSet"),
    status: COMPILATION_STATUS_SCHEMA,
    policyHash: HASH_SCHEMA,
    pilotPlanHash: HASH_SCHEMA,
    requestSetHash: HASH_SCHEMA,
    receiptSetHash: HASH_SCHEMA,
    calibrationHashes: z.array(HASH_SCHEMA).max(1024),
    predictions: z.array(CATALOG_SOURCE_PREDICTION_SCHEMA).max(500_000),
    unresolvedSourceContentHashes: z.array(HASH_SCHEMA).max(100_000),
    diagnostics: z.array(z.string().trim().min(1).max(1024)).max(100_000),
    compilerAuthority: z.literal(false),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(value.calibrationHashes, String, "prediction calibrations", context);
    requireCanonicalValues(
      value.predictions,
      (entry) => `${entry.sourceContentHash}:${entry.ablation}`,
      "source predictions",
      context,
    );
    requireCanonicalValues(
      value.unresolvedSourceContentHashes,
      String,
      "unresolved prediction sources",
      context,
    );
    requireCanonicalValues(value.diagnostics, String, "prediction diagnostics", context);
    const expected = value.unresolvedSourceContentHashes.length === 0 ? "eligible" : "incomplete";
    if (value.status !== expected)
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Prediction-set status mismatch",
      });
  });
export type CatalogCalibratedPredictionSet = z.output<
  typeof CATALOG_CALIBRATED_PREDICTION_SET_SCHEMA
>;

export function buildCatalogCalibratedPredictionSet(input: {
  readonly policy: CatalogAdmissionPolicy;
  readonly pilotPlanHash: string;
  readonly requests: CatalogHypothesisRequestSet;
  readonly receipts: CatalogHypothesisReceiptSet;
  readonly calibrations: readonly CatalogAdapterCalibrationReceipt[];
  readonly semanticModule: SemanticModule;
}): CatalogCalibratedPredictionSet {
  const policy = CATALOG_ADMISSION_POLICY_SCHEMA.parse(input.policy);
  const requests = CATALOG_HYPOTHESIS_REQUEST_SET_SCHEMA.parse(input.requests);
  const receiptSet = CATALOG_HYPOTHESIS_RECEIPT_SET_SCHEMA.parse(input.receipts);
  const calibrations = input.calibrations.map((entry) =>
    CATALOG_ADAPTER_CALIBRATION_RECEIPT_SCHEMA.parse(entry),
  );
  if (receiptSet.requestSetHash !== requests.hash)
    throw new Error("Prediction receipts bind a different request set");
  const calibrationsByImplementation = new Map(
    calibrations.map((entry) => [calibrationIdentity(entry), entry] as const),
  );
  const receiptsByRequest = groupBy(receiptSet.receipts, (receipt) => receipt.requestHash);
  const predictions = requests.requests.map((request) => {
    const receipts = receiptsByRequest.get(request.hash) ?? [];
    const novelty = receipts.reduce(
      (maximum, receipt) => Math.max(maximum, receipt.noveltyScoreMillionths),
      0,
    );
    const facetPredictions = policy.prediction.requiredAssertionKinds.map((assertionKind) =>
      predictFacet({
        assertionKind,
        receipts,
        calibrationsByImplementation,
        policy,
        semanticModule: input.semanticModule,
      }),
    );
    const shifted = novelty >= policy.prediction.noveltyThresholdMillionths;
    const insufficient = facetPredictions.some(
      (facet) => facet.outcome === "insufficient_calibration",
    );
    const unknown = facetPredictions.some((facet) => facet.outcome === "unknown");
    const ambiguous = facetPredictions.some((facet) => facet.outcome === "set");
    const outcome = shifted
      ? ("shifted" as const)
      : insufficient
        ? ("insufficient_calibration" as const)
        : unknown
          ? ("unknown" as const)
          : ambiguous
            ? ("ambiguous" as const)
            : ("resolved" as const);
    return {
      sourceContentHash: request.sourceContentHash,
      ablation: request.ablation,
      outcome,
      noveltyScoreMillionths: novelty,
      facets: facetPredictions,
      diagnostics:
        outcome === "resolved"
          ? []
          : [
              outcome === "shifted"
                ? "Evidence is outside the calibrated operating stratum"
                : outcome === "insufficient_calibration"
                  ? "One or more required facets lack qualified calibration"
                  : outcome === "unknown"
                    ? "One or more required facets abstained"
                    : "One or more required facets retain a prediction set",
            ],
    };
  });
  const unresolved = canonicalValues(
    [
      ...new Set(
        predictions
          .filter((entry) => entry.outcome !== "resolved")
          .map((entry) => entry.sourceContentHash),
      ),
    ],
    String,
    "unresolved prediction sources",
  );
  return sealArtifact(CATALOG_CALIBRATED_PREDICTION_SET_SCHEMA, {
    kind: "CatalogCalibratedPredictionSet" as const,
    status: unresolved.length === 0 ? ("eligible" as const) : ("incomplete" as const),
    policyHash: policy.hash,
    pilotPlanHash: input.pilotPlanHash,
    requestSetHash: requests.hash,
    receiptSetHash: receiptSet.hash,
    calibrationHashes: canonicalValues(
      calibrations.map((entry) => entry.hash),
      String,
      "prediction calibrations",
    ),
    predictions: canonicalValues(
      predictions,
      (entry) => `${entry.sourceContentHash}:${entry.ablation}`,
      "source predictions",
    ),
    unresolvedSourceContentHashes: unresolved,
    diagnostics:
      unresolved.length === 0 ? [] : [`${unresolved.length} pilot sources remain unresolved`],
    compilerAuthority: false as const,
  });
}

function calibrateFacet(
  assertionKind: CatalogPredictionFacet,
  receipts: readonly AssetSemanticHypothesisReceipt[],
  judgments: ReadonlyMap<string, z.output<typeof REFERENCE_JUDGMENT_SCHEMA>>,
  minimumSamples: number,
  minimumLowerBound: number,
  confidenceMillionths: number,
): z.output<typeof CATALOG_FACET_CALIBRATION_SCHEMA> {
  const observations = receipts.flatMap((receipt) => {
    const judgment = judgments.get(receipt.sourceContentHash);
    if (!judgment || judgment.disposition !== "eligible") return [];
    const expected = new Set(
      judgment.values.filter((value) => value.assertionKind === assertionKind).map(facetValueKey),
    );
    const top = receipt.facetScores
      .filter((score) => score.assertionKind === assertionKind)
      .sort(
        (left, right) =>
          right.scoreMillionths - left.scoreMillionths ||
          compareCanonicalStrings(left.valueKey, right.valueKey),
      )[0];
    return top
      ? [
          {
            score: top.scoreMillionths,
            correct: expected.has(top.valueKey),
            source: receipt.sourceContentHash,
          },
        ]
      : [];
  });
  const thresholds = [...new Set([0, ...observations.map((entry) => entry.score)])].sort(
    (left, right) => left - right,
  );
  let selected = summarizeThreshold(
    observations,
    thresholds[thresholds.length - 1] ?? 1_000_000,
    confidenceMillionths,
  );
  for (const threshold of thresholds) {
    const summary = summarizeThreshold(observations, threshold, confidenceMillionths);
    if (
      summary.acceptedPredictionCount >= minimumSamples &&
      summary.precisionLowerBoundMillionths >= minimumLowerBound
    ) {
      selected = summary;
      break;
    }
  }
  const qualified =
    selected.acceptedPredictionCount >= minimumSamples &&
    selected.precisionLowerBoundMillionths >= minimumLowerBound;
  return {
    assertionKind,
    sampleCount: new Set(
      receipts
        .filter((receipt) => judgments.has(receipt.sourceContentHash))
        .map((receipt) => receipt.sourceContentHash),
    ).size,
    ...selected,
    qualified,
  };
}

function summarizeThreshold(
  observations: readonly { score: number; correct: boolean }[],
  thresholdMillionths: number,
  confidenceMillionths: number,
) {
  const accepted = observations.filter((entry) => entry.score >= thresholdMillionths);
  const correct = accepted.filter((entry) => entry.correct).length;
  const precision = accepted.length === 0 ? 0 : Math.round((correct / accepted.length) * 1_000_000);
  const lower = wilsonLowerBound(correct, accepted.length, confidenceMillionths);
  const coveredSources = observations.length === 0 ? 0 : accepted.length / observations.length;
  return {
    acceptedPredictionCount: accepted.length,
    correctPredictionCount: correct,
    thresholdMillionths,
    empiricalPrecisionMillionths: precision,
    precisionLowerBoundMillionths: Math.round(lower * 1_000_000),
    empiricalCoverageMillionths: Math.round(coveredSources * 1_000_000),
  };
}

function predictFacet(input: {
  assertionKind: CatalogPredictionFacet;
  receipts: readonly AssetSemanticHypothesisReceipt[];
  calibrationsByImplementation: ReadonlyMap<string, CatalogAdapterCalibrationReceipt>;
  policy: CatalogAdmissionPolicy;
  semanticModule: SemanticModule;
}): z.output<typeof CATALOG_FACET_PREDICTION_SCHEMA> {
  const support = new Map<
    string,
    {
      value: CatalogFacetValue;
      scores: number[];
      precisions: number[];
      groups: Set<string>;
      receipts: Set<string>;
      calibrations: Set<string>;
    }
  >();
  let missingCalibration = false;
  for (const receipt of input.receipts) {
    const calibration = input.calibrationsByImplementation.get(calibrationIdentity(receipt));
    const facetCalibration = calibration?.facets.find(
      (facet) => facet.assertionKind === input.assertionKind,
    );
    if (!calibration || !facetCalibration) {
      missingCalibration = true;
      continue;
    }
    const assertions = new Map(
      receipt.assertions.assertions.flatMap((assertion) => {
        const value = facetValueFromAssertion(assertion);
        return value ? [[facetValueKey(value), value] as const] : [];
      }),
    );
    for (const rawScore of receipt.facetScores) {
      if (
        rawScore.assertionKind !== input.assertionKind ||
        rawScore.scoreMillionths < facetCalibration.thresholdMillionths
      )
        continue;
      const value = assertions.get(rawScore.valueKey);
      if (!value) continue;
      const record = support.get(rawScore.valueKey) ?? {
        value,
        scores: [],
        precisions: [],
        groups: new Set<string>(),
        receipts: new Set<string>(),
        calibrations: new Set<string>(),
      };
      const groupAlreadyCounted = record.groups.has(receipt.dependencyGroupId);
      if (!groupAlreadyCounted) {
        record.scores.push(rawScore.scoreMillionths);
        record.precisions.push(facetCalibration.precisionLowerBoundMillionths);
      }
      record.groups.add(receipt.dependencyGroupId);
      record.receipts.add(receipt.hash);
      record.calibrations.add(calibration.hash);
      support.set(rawScore.valueKey, record);
    }
  }
  let candidates = [...support.values()]
    .filter(
      (record) =>
        record.groups.size >= input.policy.prediction.minimumDependencyGroups &&
        Math.min(...record.precisions) >=
          input.policy.prediction.minimumPrecisionLowerBoundMillionths,
    )
    .map((record) => ({
      value: record.value,
      aggregateScoreMillionths: Math.round(
        record.scores.reduce((sum, score) => sum + score, 0) / record.scores.length,
      ),
      conservativePrecisionMillionths: Math.min(...record.precisions),
      dependencyGroupIds: [...record.groups].sort(compareCanonicalStrings),
      receiptHashes: [...record.receipts].sort(compareCanonicalStrings),
      calibrationHashes: [...record.calibrations].sort(compareCanonicalStrings),
    }));
  if (input.assertionKind === "denotation")
    candidates = removeSupportedAncestors(candidates, input.semanticModule);
  candidates.sort(
    (left, right) =>
      right.conservativePrecisionMillionths - left.conservativePrecisionMillionths ||
      right.aggregateScoreMillionths - left.aggregateScoreMillionths ||
      compareCanonicalStrings(facetValueKey(left.value), facetValueKey(right.value)),
  );
  candidates = candidates.slice(0, input.policy.prediction.maximumPredictionSetSize);
  if (candidates.length === 0)
    return {
      assertionKind: input.assertionKind,
      outcome: missingCalibration ? "insufficient_calibration" : "unknown",
      candidates: [],
    };
  return {
    assertionKind: input.assertionKind,
    outcome: candidates.length === 1 ? "singleton" : "set",
    candidates: canonicalValues(
      candidates,
      (entry) => facetValueKey(entry.value),
      "prediction candidates",
    ),
  };
}

function removeSupportedAncestors<T extends z.output<typeof CATALOG_PREDICTION_CANDIDATE_SCHEMA>>(
  candidates: readonly T[],
  module: SemanticModule,
): T[] {
  const concepts = new Map(module.concepts.map((concept) => [concept.conceptId, concept] as const));
  return candidates.filter((candidate) => {
    if (candidate.value.assertionKind !== "denotation") return true;
    const candidateConceptId = candidate.value.concept.conceptId;
    return !candidates.some((other) => {
      if (other === candidate || other.value.assertionKind !== "denotation") return false;
      return concepts
        .get(other.value.concept.conceptId)
        ?.ancestors.some((ancestor) => ancestor.conceptId === candidateConceptId);
    });
  });
}

function calibrationIdentity(
  value: AssetSemanticHypothesisReceipt | CatalogAdapterCalibrationReceipt,
): string {
  return `${value.adapterImplementationHash}:${value.modelImplementationHash}:${value.ablation}`;
}

function groupBy<T>(values: readonly T[], key: (value: T) => string): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const value of values) {
    const current = result.get(key(value)) ?? [];
    current.push(value);
    result.set(key(value), current);
  }
  return result;
}

function wilsonLowerBound(successes: number, trials: number, confidenceMillionths: number): number {
  if (trials === 0) return 0;
  const alpha = 1 - confidenceMillionths / 1_000_000;
  const zScore = inverseNormalCdf(1 - alpha);
  const proportion = successes / trials;
  const zSquared = zScore * zScore;
  const denominator = 1 + zSquared / trials;
  const center = proportion + zSquared / (2 * trials);
  const margin =
    zScore * Math.sqrt((proportion * (1 - proportion) + zSquared / (4 * trials)) / trials);
  return Math.max(0, (center - margin) / denominator);
}

// Peter J. Acklam's deterministic rational approximation.
function inverseNormalCdf(probability: number): number {
  if (!(probability > 0 && probability < 1))
    throw new Error("Normal quantile probability must lie strictly between zero and one");
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
    -3.066479806614716e1, 2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
    -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const lower = 0.02425;
  const upper = 1 - lower;
  if (probability < lower) {
    const q = Math.sqrt(-2 * Math.log(probability));
    return (
      (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
    );
  }
  if (probability > upper) {
    const q = Math.sqrt(-2 * Math.log(1 - probability));
    return -(
      (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
    );
  }
  const q = probability - 0.5;
  const r = q * q;
  return (
    ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) /
    (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1)
  );
}
