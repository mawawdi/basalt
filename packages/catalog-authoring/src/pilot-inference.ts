import { z } from "zod";
import { ASCII_ID_SCHEMA, HASH_SCHEMA, contentHash, stableJson } from "@basalt/contracts";
import {
  SEMANTIC_HYPOTHESIS_ASSERTION_SCHEMA,
  sealSemanticAssertionBundle,
} from "@basalt/semantic-kernel";
import { CATALOG_FACET_VALUE_SCHEMA, facetValueKey, type CatalogFacetValue } from "./facets.js";
import {
  CATALOG_FEATURE_CHANNEL_SCHEMA,
  CATALOG_PER_VIEW_FEATURE_SCHEMA,
  CATALOG_QUANTIZED_FEATURE_VECTOR_SCHEMA,
  sealCatalogFeatureReceipt,
  sealCatalogFeatureSet,
  type CatalogFeatureSet,
} from "./features.js";
import {
  CATALOG_HYPOTHESIS_REQUEST_SET_SCHEMA,
  sealAssetSemanticHypothesisReceipt,
  sealCatalogHypothesisReceiptSet,
  type CatalogHypothesisReceiptSet,
  type CatalogHypothesisRequestSet,
} from "./hypothesis.js";
import {
  CATALOG_QUALIFICATION_PILOT_PLAN_SCHEMA,
  type CatalogQualificationPilotPlan,
} from "./pilot.js";
import { requireCanonicalValues } from "./artifact.js";

const PILOT_MODEL_SCHEMA = z
  .object({
    modelId: ASCII_ID_SCHEMA,
    source: z.enum(["huggingface", "basalt"]),
    repository: z.string().trim().min(1).max(256),
    revision: z.string().regex(/^[a-f0-9]{40,64}$/u),
    implementationHash: HASH_SCHEMA,
    purpose: z.enum(["multiview_semantics_and_appearance", "multiview_shape", "source_name_hint"]),
  })
  .strict();

const RAW_FACET_SCORE_SCHEMA = z
  .object({
    value: CATALOG_FACET_VALUE_SCHEMA,
    scoreMillionths: z.number().int().min(0).max(1_000_000),
  })
  .strict();

const RAW_HYPOTHESIS_CHANNEL_SCHEMA = z
  .object({
    evidenceSource: z.enum(["visual", "name"]),
    adapterId: ASCII_ID_SCHEMA,
    adapterImplementationHash: HASH_SCHEMA,
    modelImplementationHash: HASH_SCHEMA,
    dependencyGroupId: ASCII_ID_SCHEMA,
    promptHash: HASH_SCHEMA,
    rawOutputHash: HASH_SCHEMA,
    normalizationImplementationHash: HASH_SCHEMA,
    scoreNormalization: z.enum(["softmax_per_facet", "lexical_similarity"]),
    facetScores: z.array(RAW_FACET_SCORE_SCHEMA).max(4096),
    noveltyScoreMillionths: z.number().int().min(0).max(1_000_000),
    diagnostics: z.array(z.string().trim().min(1).max(1024)).max(256),
  })
  .strict()
  .superRefine((value, context) => {
    requireCanonicalValues(
      value.facetScores,
      (entry) => facetValueKey(entry.value),
      "raw pilot facet scores",
      context,
    );
    requireCanonicalValues(value.diagnostics, String, "raw pilot diagnostics", context);
  });

const RAW_FEATURE_SCHEMA = z
  .object({
    channel: CATALOG_FEATURE_CHANNEL_SCHEMA,
    modelImplementationHash: HASH_SCHEMA,
    preprocessingImplementationHash: HASH_SCHEMA,
    aggregationImplementationHash: HASH_SCHEMA,
    perView: z.array(CATALOG_PER_VIEW_FEATURE_SCHEMA).length(12),
    aggregate: CATALOG_QUANTIZED_FEATURE_VECTOR_SCHEMA,
    maximumViewDisagreementMillionths: z.number().int().min(0).max(2_000_000),
  })
  .strict();

const PILOT_WORKER_ITEM_SCHEMA = z
  .object({
    sourceContentHash: HASH_SCHEMA,
    renderEvidenceHash: HASH_SCHEMA,
    hypotheses: z.array(RAW_HYPOTHESIS_CHANNEL_SCHEMA).length(2),
    features: z.array(RAW_FEATURE_SCHEMA).min(2).max(3),
  })
  .strict()
  .superRefine((value, context) => {
    requireCanonicalValues(
      value.hypotheses,
      (entry) => entry.evidenceSource,
      "pilot hypotheses",
      context,
    );
    requireCanonicalValues(value.features, (entry) => entry.channel, "pilot features", context);
  });

export const CATALOG_PILOT_WORKER_OUTPUT_SCHEMA = z
  .object({
    kind: z.literal("CatalogPilotWorkerOutput"),
    pilotPlanHash: HASH_SCHEMA,
    jobHash: HASH_SCHEMA,
    models: z.array(PILOT_MODEL_SCHEMA).length(3),
    items: z.array(PILOT_WORKER_ITEM_SCHEMA).max(100_000),
    diagnostics: z.array(z.string().trim().min(1).max(2048)).max(100_000),
    resultHash: HASH_SCHEMA,
    execution: z
      .object({
        executor: z.enum(["local", "modal"]),
        device: z.string().trim().min(1).max(64),
        accelerator: z.string().trim().min(1).max(64),
        elapsedMilliseconds: z.number().int().nonnegative(),
        peakResidentBytes: z.number().int().nonnegative(),
        processedSourceCount: z.number().int().nonnegative().max(100_000),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    requireCanonicalValues(value.models, (entry) => entry.modelId, "pilot models", context);
    requireCanonicalValues(
      value.items,
      (entry) => entry.sourceContentHash,
      "pilot outputs",
      context,
    );
    requireCanonicalValues(value.diagnostics, String, "pilot worker diagnostics", context);
    const { execution: _execution, resultHash: _resultHash, ...material } = value;
    if (contentHash(stableJson(material)) !== value.resultHash)
      context.addIssue({
        code: "custom",
        path: ["resultHash"],
        message: "Pilot result hash mismatch",
      });
    if (value.execution.processedSourceCount !== value.items.length)
      context.addIssue({
        code: "custom",
        path: ["execution", "processedSourceCount"],
        message: "Processed source count mismatch",
      });
  });
export type CatalogPilotWorkerOutput = z.output<typeof CATALOG_PILOT_WORKER_OUTPUT_SCHEMA>;

export function materializeCatalogPilotInference(input: {
  readonly plan: CatalogQualificationPilotPlan;
  readonly requests: CatalogHypothesisRequestSet;
  readonly workerOutput: CatalogPilotWorkerOutput;
}): {
  readonly receipts: CatalogHypothesisReceiptSet;
  readonly features: CatalogFeatureSet;
} {
  const plan = CATALOG_QUALIFICATION_PILOT_PLAN_SCHEMA.parse(input.plan);
  const requests = CATALOG_HYPOTHESIS_REQUEST_SET_SCHEMA.parse(input.requests);
  const output = CATALOG_PILOT_WORKER_OUTPUT_SCHEMA.parse(input.workerOutput);
  if (output.pilotPlanHash !== plan.hash) throw new Error("Pilot worker output binds another plan");
  const outputBySource = new Map(output.items.map((entry) => [entry.sourceContentHash, entry]));
  const hypothesisReceipts = requests.requests.flatMap((request) => {
    const workerItem = outputBySource.get(request.sourceContentHash);
    if (!workerItem) return [];
    const allowedSources: ReadonlySet<string> = new Set(
      request.ablation === "visual_only"
        ? ["visual"]
        : request.ablation === "name_only"
          ? ["name"]
          : ["name", "visual"],
    );
    return workerItem.hypotheses
      .filter((entry) => allowedSources.has(entry.evidenceSource))
      .map((hypothesis) => {
        const subject = {
          kind: "catalog_asset" as const,
          id: `asset_${request.sourceContentHash.slice(0, 32)}`,
        };
        const assertions = hypothesis.facetScores.map((score) =>
          hypothesisAssertion(score.value, score.scoreMillionths / 1_000_000, subject),
        );
        const assertionBundle = sealSemanticAssertionBundle({
          authority: "hypothesis" as const,
          hypothesisSourceHash: request.hash,
          assertions,
          abstentions: hypothesis.diagnostics,
        });
        return sealAssetSemanticHypothesisReceipt({
          requestHash: request.hash,
          sourceContentHash: request.sourceContentHash,
          measurementHash: request.measurementHash,
          renderEvidenceHash: request.renderEvidenceHash,
          sourceNameHintHash: request.sourceNameHintHash,
          semanticModuleHash: request.semanticModuleHash,
          semanticLexiconHash: request.semanticLexiconHash,
          ablation: request.ablation,
          adapterId: hypothesis.adapterId,
          adapterImplementationHash: hypothesis.adapterImplementationHash,
          modelImplementationHash: hypothesis.modelImplementationHash,
          dependencyGroupId: hypothesis.dependencyGroupId,
          promptHash: hypothesis.promptHash,
          rawOutputHash: hypothesis.rawOutputHash,
          normalizationImplementationHash: hypothesis.normalizationImplementationHash,
          inference: {
            seed: 0,
            scoreNormalization: hypothesis.scoreNormalization,
            maximumCandidatesPerFacet: maximumCandidatesPerFacet(hypothesis.facetScores),
          },
          assertions: assertionBundle,
          facetScores: hypothesis.facetScores.map((entry) => ({
            assertionKind: entry.value.assertionKind,
            valueKey: facetValueKey(entry.value),
            scoreMillionths: entry.scoreMillionths,
          })),
          noveltyScoreMillionths: hypothesis.noveltyScoreMillionths,
          diagnostics: hypothesis.diagnostics,
          workload: {
            inputArtifactCount: hypothesis.evidenceSource === "visual" ? 12 : 1,
            renderedViewCount: hypothesis.evidenceSource === "visual" ? 12 : 0,
            candidateValueCount: hypothesis.facetScores.length,
          },
        });
      });
  });
  const presentRequestHashes = new Set(hypothesisReceipts.map((entry) => entry.requestHash));
  const receipts = sealCatalogHypothesisReceiptSet({
    status: requests.requests.every((request) => presentRequestHashes.has(request.hash))
      ? "eligible"
      : "incomplete",
    requestSetHash: requests.hash,
    receipts: hypothesisReceipts,
    missingRequestHashes: requests.requests
      .filter((request) => !presentRequestHashes.has(request.hash))
      .map((request) => request.hash),
    diagnostics: output.diagnostics,
  });
  const featureReceipts = output.items.flatMap((item) =>
    item.features.map((feature) =>
      sealCatalogFeatureReceipt({
        sourceContentHash: item.sourceContentHash,
        renderEvidenceHash: item.renderEvidenceHash,
        channel: feature.channel,
        modelImplementationHash: feature.modelImplementationHash,
        preprocessingImplementationHash: feature.preprocessingImplementationHash,
        aggregationImplementationHash: feature.aggregationImplementationHash,
        perView: feature.perView,
        aggregate: feature.aggregate,
        maximumViewDisagreementMillionths: feature.maximumViewDisagreementMillionths,
      }),
    ),
  );
  const expected = plan.selectedSourceContentHashes.flatMap((sourceContentHash) =>
    ["appearance", "shape"].map((channel) => ({
      sourceContentHash,
      channel: CATALOG_FEATURE_CHANNEL_SCHEMA.parse(channel),
    })),
  );
  const features = sealCatalogFeatureSet({
    pilotPlanHash: plan.hash,
    visualReviewIndexHash: plan.visualReviewIndexHash,
    expected,
    receipts: featureReceipts,
    diagnostics: output.diagnostics,
  });
  return { receipts, features };
}

function hypothesisAssertion(
  value: CatalogFacetValue,
  confidence: number,
  subject: { readonly kind: "catalog_asset"; readonly id: string },
): z.output<typeof SEMANTIC_HYPOTHESIS_ASSERTION_SCHEMA> {
  switch (value.assertionKind) {
    case "denotation":
      return { assertionKind: "denotation", subject, concept: value.concept, confidence };
    case "realization_form":
      return {
        assertionKind: "realization_form",
        subject,
        realizationForm: value.realizationForm,
        confidence,
      };
    case "state":
      return {
        assertionKind: "state",
        subject,
        stateDimensionId: value.stateDimensionId,
        stateValueId: value.stateValueId,
        confidence,
      };
    case "affordance":
      return { assertionKind: "affordance", subject, affordanceId: value.affordanceId, confidence };
    case "surface_treatment":
      return {
        assertionKind: "surface_treatment",
        subject,
        surfaceTreatmentId: value.surfaceTreatmentId,
        confidence,
      };
  }
}

function maximumCandidatesPerFacet(scores: readonly { value: CatalogFacetValue }[]): number {
  const counts = new Map<string, number>();
  for (const score of scores)
    counts.set(score.value.assertionKind, (counts.get(score.value.assertionKind) ?? 0) + 1);
  return Math.max(1, ...counts.values());
}
