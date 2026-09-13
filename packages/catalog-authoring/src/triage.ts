import { z } from "zod";
import {
  COMPILATION_STATUS_SCHEMA,
  HASH_SCHEMA,
  compareCanonicalStrings,
  contentHash,
  deepFreezeJson,
  dequantizeQ32_32,
  stableJson,
} from "@basalt/contracts";
import {
  CATALOG_ENTRY_KIND_SCHEMA,
  STYLE_PROFILE_HANDLE_SCHEMA,
  type CatalogAssetArtifact,
  type CatalogEntryKind,
  type CatalogMeasurementSet,
} from "@basalt/catalog-model";
import {
  AFFORDANCE_ID_SCHEMA,
  CONCEPT_COMMITMENT_REFERENCE_SCHEMA,
  REALIZATION_FORM_SCHEMA,
  STATE_DIMENSION_ID_SCHEMA,
  STATE_VALUE_ID_SCHEMA,
  SURFACE_TREATMENT_ID_SCHEMA,
} from "@basalt/semantic-kernel";
import type {
  AssetSemanticHypothesisReceipt,
  CatalogHypothesisReceiptSet,
  CatalogHypothesisRequestSet,
} from "./index.js";

const SUPPORT_EVIDENCE_SCHEMA = z.enum([
  "bottom",
  "lateral_wall",
  "top_ceiling",
  "socket_only",
  "unknown",
]);
const REVIEW_REASON_SCHEMA = z.enum([
  "visual_medoid",
  "visual_outlier",
  "metric_outlier",
  "semantic_boundary",
  "deterministic_audit",
]);

const canonical = <T>(values: readonly T[], key: (value: T) => string, label: string): T[] => {
  const result = [...values].sort((left, right) => compareCanonicalStrings(key(left), key(right)));
  if (new Set(result.map(key)).size !== result.length) throw new Error(`${label} must be unique`);
  return result;
};

const HYPOTHESIS_SIGNATURE_SCHEMA = z
  .object({
    concepts: z.array(CONCEPT_COMMITMENT_REFERENCE_SCHEMA).max(32),
    realizationForms: z.array(REALIZATION_FORM_SCHEMA).max(6),
    states: z
      .array(
        z
          .object({
            stateDimensionId: STATE_DIMENSION_ID_SCHEMA,
            stateValueId: STATE_VALUE_ID_SCHEMA,
          })
          .strict(),
      )
      .max(32),
    affordanceIds: z.array(AFFORDANCE_ID_SCHEMA).max(64),
    surfaceTreatmentIds: z.array(SURFACE_TREATMENT_ID_SCHEMA).max(64),
  })
  .strict();
export type CatalogHypothesisSignature = z.output<typeof HYPOTHESIS_SIGNATURE_SCHEMA>;

export const CATALOG_ADMISSION_POLICY_SCHEMA = z
  .object({
    kind: z.literal("CatalogAdmissionPolicy"),
    policyId: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u),
    minimumIndependentHypotheses: z.number().int().min(2).max(16),
    consensus: z
      .object({
        numerator: z.number().int().positive().max(1000),
        denominator: z.number().int().positive().max(1000),
      })
      .strict(),
    minimumVisualSimilarity: z
      .object({
        numerator: z.number().int().positive().max(10_000),
        denominator: z.number().int().positive().max(10_000),
      })
      .strict(),
    reviewSampling: z
      .object({
        minimumPerCohort: z.number().int().positive().max(64),
        deterministicAuditPermille: z.number().int().min(0).max(1000),
        maximumAuditPerCohort: z.number().int().nonnegative().max(256),
      })
      .strict(),
    automaticallyAdmissibleEntryKinds: z.array(CATALOG_ENTRY_KIND_SCHEMA).max(6),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyHash(value, context);
    if (value.consensus.numerator > value.consensus.denominator)
      context.addIssue({
        code: "custom",
        path: ["consensus"],
        message: "Consensus cannot exceed one",
      });
    if (value.minimumVisualSimilarity.numerator > value.minimumVisualSimilarity.denominator)
      context.addIssue({
        code: "custom",
        path: ["minimumVisualSimilarity"],
        message: "Visual similarity cannot exceed one",
      });
    canonicalIssue(
      value.automaticallyAdmissibleEntryKinds,
      String,
      "automatically admissible entry kinds",
      context,
    );
  });
export type CatalogAdmissionPolicy = z.output<typeof CATALOG_ADMISSION_POLICY_SCHEMA>;

export function sealCatalogAdmissionPolicy(
  input: Omit<CatalogAdmissionPolicy, "kind" | "hash">,
): CatalogAdmissionPolicy {
  return seal(CATALOG_ADMISSION_POLICY_SCHEMA, {
    kind: "CatalogAdmissionPolicy" as const,
    ...input,
    automaticallyAdmissibleEntryKinds: canonical(
      input.automaticallyAdmissibleEntryKinds,
      String,
      "automatically admissible entry kinds",
    ),
  });
}

export const DEFAULT_CATALOG_ADMISSION_POLICY = sealCatalogAdmissionPolicy({
  policyId: "sampled_panel_admission",
  minimumIndependentHypotheses: 2,
  consensus: { numerator: 2, denominator: 3 },
  minimumVisualSimilarity: { numerator: 9, denominator: 10 },
  reviewSampling: {
    minimumPerCohort: 3,
    deterministicAuditPermille: 20,
    maximumAuditPerCohort: 8,
  },
  automaticallyAdmissibleEntryKinds: ["substitution_set"],
});

const PANEL_VOTE_GROUP_SCHEMA = z
  .object({
    signature: HYPOTHESIS_SIGNATURE_SCHEMA,
    signatureHash: HASH_SCHEMA,
    receiptHashes: z.array(HASH_SCHEMA).min(1).max(16),
  })
  .strict();

export const CATALOG_HYPOTHESIS_PANEL_ITEM_SCHEMA = z
  .object({
    kind: z.literal("CatalogHypothesisPanelItem"),
    requestHash: HASH_SCHEMA,
    sourceContentHash: HASH_SCHEMA,
    outcome: z.enum(["consensus", "disputed", "abstained", "insufficient_receipts"]),
    independentImplementationHashes: z.array(HASH_SCHEMA).max(16),
    voteGroups: z.array(PANEL_VOTE_GROUP_SCHEMA).max(16),
    consensusSignature: HYPOTHESIS_SIGNATURE_SCHEMA.optional(),
    diagnostics: z.array(z.string().trim().min(1).max(1024)).max(128),
    compilerAuthority: z.literal(false),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyHash(value, context);
    canonicalIssue(value.independentImplementationHashes, String, "panel implementations", context);
    canonicalIssue(value.voteGroups, (entry) => entry.signatureHash, "panel vote groups", context);
    if ((value.outcome === "consensus") !== (value.consensusSignature !== undefined))
      context.addIssue({
        code: "custom",
        path: ["consensusSignature"],
        message: "Only a consensus outcome may carry a consensus signature",
      });
  });
export type CatalogHypothesisPanelItem = z.output<typeof CATALOG_HYPOTHESIS_PANEL_ITEM_SCHEMA>;

export const CATALOG_HYPOTHESIS_PANEL_SCHEMA = z
  .object({
    kind: z.literal("CatalogHypothesisPanel"),
    status: COMPILATION_STATUS_SCHEMA,
    policyHash: HASH_SCHEMA,
    requestSetHash: HASH_SCHEMA,
    receiptSetHash: HASH_SCHEMA,
    items: z.array(CATALOG_HYPOTHESIS_PANEL_ITEM_SCHEMA).max(100_000),
    unresolvedSourceContentHashes: z.array(HASH_SCHEMA).max(100_000),
    diagnostics: z.array(z.string().trim().min(1).max(1024)).max(100_000),
    compilerAuthority: z.literal(false),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyHash(value, context);
    canonicalIssue(value.items, (entry) => entry.sourceContentHash, "panel items", context);
    canonicalIssue(
      value.unresolvedSourceContentHashes,
      String,
      "unresolved panel sources",
      context,
    );
    const expected = value.unresolvedSourceContentHashes.length === 0 ? "eligible" : "incomplete";
    if (value.status !== expected)
      context.addIssue({ code: "custom", path: ["status"], message: "Panel status mismatch" });
  });
export type CatalogHypothesisPanel = z.output<typeof CATALOG_HYPOTHESIS_PANEL_SCHEMA>;

export function buildCatalogHypothesisPanel(input: {
  readonly policy: CatalogAdmissionPolicy;
  readonly requests: CatalogHypothesisRequestSet;
  readonly receipts: CatalogHypothesisReceiptSet;
}): CatalogHypothesisPanel {
  const policy = CATALOG_ADMISSION_POLICY_SCHEMA.parse(input.policy);
  if (input.receipts.requestSetHash !== input.requests.hash)
    throw new Error("Hypothesis receipts bind a different request set");
  const receiptsByRequest = groupBy(input.receipts.receipts, (receipt) => receipt.requestHash);
  const items = input.requests.requests.map((request) => {
    const receipts = receiptsByRequest.get(request.hash) ?? [];
    for (const receipt of receipts) validateReceiptBinding(request, receipt);
    const implementations = canonical(
      receipts.map((receipt) =>
        contentHash(
          stableJson({
            adapterHash: receipt.adapterHash,
            modelImplementationHash: receipt.modelImplementationHash,
          }),
        ),
      ),
      String,
      "panel implementations",
    );
    const votes = new Map<
      string,
      { signature: CatalogHypothesisSignature; receiptHashes: string[] }
    >();
    for (const receipt of receipts) {
      const signature = hypothesisSignature(receipt);
      if (!isCompleteSignature(signature)) continue;
      const signatureHash = contentHash(stableJson(signature));
      const vote = votes.get(signatureHash) ?? { signature, receiptHashes: [] };
      vote.receiptHashes.push(receipt.hash);
      votes.set(signatureHash, vote);
    }
    const voteGroups = [...votes]
      .map(([signatureHash, value]) => ({
        signature: value.signature,
        signatureHash,
        receiptHashes: canonical(value.receiptHashes, String, "vote receipt hashes"),
      }))
      .sort((left, right) => compareCanonicalStrings(left.signatureHash, right.signatureHash));
    const ranked = [...voteGroups].sort(
      (left, right) =>
        right.receiptHashes.length - left.receiptHashes.length ||
        compareCanonicalStrings(left.signatureHash, right.signatureHash),
    );
    const winner = ranked[0];
    const enoughImplementations = implementations.length >= policy.minimumIndependentHypotheses;
    const enoughVotes =
      !!winner &&
      winner.receiptHashes.length * policy.consensus.denominator >=
        implementations.length * policy.consensus.numerator;
    const tied =
      !!winner &&
      ranked[1] !== undefined &&
      ranked[1].receiptHashes.length === winner.receiptHashes.length;
    const outcome: CatalogHypothesisPanelItem["outcome"] = !enoughImplementations
      ? "insufficient_receipts"
      : voteGroups.length === 0
        ? "abstained"
        : enoughVotes && !tied
          ? "consensus"
          : "disputed";
    const material = {
      kind: "CatalogHypothesisPanelItem" as const,
      requestHash: request.hash,
      sourceContentHash: request.sourceContentHash,
      outcome,
      independentImplementationHashes: implementations,
      voteGroups,
      ...(outcome === "consensus" ? { consensusSignature: winner!.signature } : {}),
      diagnostics:
        outcome === "consensus"
          ? []
          : [
              outcome === "insufficient_receipts"
                ? `Requires ${policy.minimumIndependentHypotheses} independent hypothesis implementations`
                : outcome === "abstained"
                  ? "Every supplied hypothesis abstained from denotation or realization form"
                  : "Independent hypotheses did not reach the configured exact-signature consensus",
            ],
      compilerAuthority: false as const,
    };
    return seal(CATALOG_HYPOTHESIS_PANEL_ITEM_SCHEMA, material);
  });
  const unresolved = items
    .filter((item) => item.outcome !== "consensus")
    .map((item) => item.sourceContentHash);
  return seal(CATALOG_HYPOTHESIS_PANEL_SCHEMA, {
    kind: "CatalogHypothesisPanel" as const,
    status: unresolved.length === 0 ? "eligible" : "incomplete",
    policyHash: policy.hash,
    requestSetHash: input.requests.hash,
    receiptSetHash: input.receipts.hash,
    items: canonical(items, (item) => item.sourceContentHash, "panel items"),
    unresolvedSourceContentHashes: canonical(unresolved, String, "unresolved panel sources"),
    diagnostics:
      unresolved.length === 0
        ? []
        : [`${unresolved.length} assets require more evidence or adjudication`],
    compilerAuthority: false as const,
  });
}

export const CATALOG_VISUAL_EMBEDDING_RECEIPT_SCHEMA = z
  .object({
    kind: z.literal("CatalogVisualEmbeddingReceipt"),
    sourceContentHash: HASH_SCHEMA,
    renderEvidenceHash: HASH_SCHEMA,
    embeddingImplementationHash: HASH_SCHEMA,
    values: z.array(z.number().int().min(-32_767).max(32_767)).min(8).max(2048),
    compilerAuthority: z.literal(false),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyHash(value, context);
    if (value.values.every((entry) => entry === 0))
      context.addIssue({ code: "custom", path: ["values"], message: "Embedding cannot be zero" });
  });
export type CatalogVisualEmbeddingReceipt = z.output<
  typeof CATALOG_VISUAL_EMBEDDING_RECEIPT_SCHEMA
>;

export const CATALOG_VISUAL_EMBEDDING_SET_SCHEMA = z
  .object({
    kind: z.literal("CatalogVisualEmbeddingSet"),
    status: COMPILATION_STATUS_SCHEMA,
    visualReviewIndexHash: HASH_SCHEMA,
    embeddingImplementationHash: HASH_SCHEMA,
    vectorLength: z.number().int().min(8).max(2048),
    receipts: z.array(CATALOG_VISUAL_EMBEDDING_RECEIPT_SCHEMA).max(100_000),
    missingSourceContentHashes: z.array(HASH_SCHEMA).max(100_000),
    diagnostics: z.array(z.string().trim().min(1).max(1024)).max(100_000),
    compilerAuthority: z.literal(false),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyHash(value, context);
    canonicalIssue(
      value.receipts,
      (entry) => entry.sourceContentHash,
      "visual embeddings",
      context,
    );
    canonicalIssue(value.missingSourceContentHashes, String, "missing visual embeddings", context);
    for (const [index, receipt] of value.receipts.entries()) {
      if (receipt.embeddingImplementationHash !== value.embeddingImplementationHash)
        context.addIssue({
          code: "custom",
          path: ["receipts", index, "embeddingImplementationHash"],
          message: "Embedding implementation mismatch",
        });
      if (receipt.values.length !== value.vectorLength)
        context.addIssue({
          code: "custom",
          path: ["receipts", index, "values"],
          message: "Embedding dimension mismatch",
        });
    }
    const expected = value.missingSourceContentHashes.length === 0 ? "eligible" : "incomplete";
    if (value.status !== expected)
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Embedding-set status mismatch",
      });
  });
export type CatalogVisualEmbeddingSet = z.output<typeof CATALOG_VISUAL_EMBEDDING_SET_SCHEMA>;

export function sealCatalogVisualEmbeddingReceipt(
  input: Omit<CatalogVisualEmbeddingReceipt, "kind" | "compilerAuthority" | "hash">,
): CatalogVisualEmbeddingReceipt {
  return seal(CATALOG_VISUAL_EMBEDDING_RECEIPT_SCHEMA, {
    kind: "CatalogVisualEmbeddingReceipt" as const,
    ...input,
    compilerAuthority: false as const,
  });
}

export function sealCatalogVisualEmbeddingSet(input: {
  readonly visualReviewIndexHash: string;
  readonly embeddingImplementationHash: string;
  readonly expectedSourceContentHashes: readonly string[];
  readonly receipts: readonly CatalogVisualEmbeddingReceipt[];
}): CatalogVisualEmbeddingSet {
  const receipts = canonical(
    input.receipts,
    (entry) => entry.sourceContentHash,
    "visual embeddings",
  );
  const vectorLength = receipts[0]?.values.length ?? 8;
  const present = new Set(receipts.map((entry) => entry.sourceContentHash));
  const missing = canonical(
    input.expectedSourceContentHashes.filter((entry) => !present.has(entry)),
    String,
    "missing visual embeddings",
  );
  return seal(CATALOG_VISUAL_EMBEDDING_SET_SCHEMA, {
    kind: "CatalogVisualEmbeddingSet" as const,
    status: missing.length === 0 ? "eligible" : "incomplete",
    visualReviewIndexHash: input.visualReviewIndexHash,
    embeddingImplementationHash: input.embeddingImplementationHash,
    vectorLength,
    receipts,
    missingSourceContentHashes: missing,
    diagnostics: missing.length === 0 ? [] : [`${missing.length} assets lack visual embeddings`],
    compilerAuthority: false as const,
  });
}

const PHYSICAL_SIGNATURE_SCHEMA = z
  .object({
    dimensionBuckets: z
      .object({ x: z.number().int(), y: z.number().int(), z: z.number().int() })
      .strict(),
    pbrChannels: z.array(z.string().regex(/^[a-z_]+$/u)).max(16),
    supportKind: SUPPORT_EVIDENCE_SCHEMA,
    socketCardinality: z.enum(["none", "one", "many"]),
  })
  .strict();

export const CATALOG_ADMISSION_COHORT_SCHEMA = z
  .object({
    kind: z.literal("CatalogAdmissionCohort"),
    cohortId: z.string().regex(/^cohort_[a-f0-9]{32}$/u),
    semanticSignature: HYPOTHESIS_SIGNATURE_SCHEMA,
    physicalSignature: PHYSICAL_SIGNATURE_SCHEMA,
    styleProfileHandle: STYLE_PROFILE_HANDLE_SCHEMA,
    proposedEntryKinds: z.array(CATALOG_ENTRY_KIND_SCHEMA).max(6),
    sourceContentHashes: z.array(HASH_SCHEMA).min(1).max(100_000),
    panelItemHashes: z.array(HASH_SCHEMA).min(1).max(100_000),
    visualEmbeddingReceiptHashes: z.array(HASH_SCHEMA).min(1).max(100_000),
    compilerAuthority: z.literal(false),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyHash(value, context);
    canonicalIssue(value.sourceContentHashes, String, "cohort sources", context);
    canonicalIssue(value.panelItemHashes, String, "cohort panel items", context);
    canonicalIssue(value.visualEmbeddingReceiptHashes, String, "cohort visual evidence", context);
    canonicalIssue(value.proposedEntryKinds, String, "cohort entry kinds", context);
    if (
      value.sourceContentHashes.length !== value.panelItemHashes.length ||
      value.sourceContentHashes.length !== value.visualEmbeddingReceiptHashes.length
    )
      context.addIssue({ code: "custom", message: "Cohort evidence cardinality mismatch" });
    const { hash: _hash, cohortId: _cohortId, ...identity } = value;
    const expected = `cohort_${contentHash(stableJson(identity)).slice(0, 32)}`;
    if (expected !== value.cohortId)
      context.addIssue({ code: "custom", path: ["cohortId"], message: "Cohort ID mismatch" });
  });
export type CatalogAdmissionCohort = z.output<typeof CATALOG_ADMISSION_COHORT_SCHEMA>;

export const CATALOG_ADMISSION_COHORT_SET_SCHEMA = z
  .object({
    kind: z.literal("CatalogAdmissionCohortSet"),
    status: COMPILATION_STATUS_SCHEMA,
    policyHash: HASH_SCHEMA,
    panelHash: HASH_SCHEMA,
    measurementSetHash: HASH_SCHEMA,
    visualEmbeddingSetHash: HASH_SCHEMA,
    cohorts: z.array(CATALOG_ADMISSION_COHORT_SCHEMA).max(100_000),
    unresolvedSourceContentHashes: z.array(HASH_SCHEMA).max(100_000),
    diagnostics: z.array(z.string().trim().min(1).max(1024)).max(100_000),
    compilerAuthority: z.literal(false),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyHash(value, context);
    canonicalIssue(value.cohorts, (entry) => entry.cohortId, "admission cohorts", context);
    canonicalIssue(
      value.unresolvedSourceContentHashes,
      String,
      "unresolved cohort sources",
      context,
    );
    const seen = value.cohorts.flatMap((cohort) => cohort.sourceContentHashes);
    if (new Set(seen).size !== seen.length)
      context.addIssue({ code: "custom", message: "A source cannot belong to multiple cohorts" });
    const expected = value.unresolvedSourceContentHashes.length === 0 ? "eligible" : "incomplete";
    if (value.status !== expected)
      context.addIssue({ code: "custom", path: ["status"], message: "Cohort-set status mismatch" });
  });
export type CatalogAdmissionCohortSet = z.output<typeof CATALOG_ADMISSION_COHORT_SET_SCHEMA>;

export function buildCatalogAdmissionCohorts(input: {
  readonly policy: CatalogAdmissionPolicy;
  readonly panel: CatalogHypothesisPanel;
  readonly measurements: CatalogMeasurementSet;
  readonly visualEmbeddings: CatalogVisualEmbeddingSet;
  readonly styleProfileHandle: string;
}): CatalogAdmissionCohortSet {
  const policy = CATALOG_ADMISSION_POLICY_SCHEMA.parse(input.policy);
  if (input.panel.policyHash !== policy.hash)
    throw new Error("Panel uses a different admission policy");
  const assets = new Map(
    input.measurements.assets.map((asset) => [asset.source.contentHash, asset] as const),
  );
  const embeddings = new Map(
    input.visualEmbeddings.receipts.map((entry) => [entry.sourceContentHash, entry] as const),
  );
  const unresolved = new Set(input.panel.unresolvedSourceContentHashes);
  const baseGroups = new Map<
    string,
    Array<{
      source: string;
      panel: CatalogHypothesisPanelItem;
      asset: CatalogAssetArtifact;
      embedding: CatalogVisualEmbeddingReceipt;
      semantic: CatalogHypothesisSignature;
      physical: z.output<typeof PHYSICAL_SIGNATURE_SCHEMA>;
    }>
  >();
  for (const panelItem of input.panel.items) {
    if (panelItem.outcome !== "consensus" || !panelItem.consensusSignature) continue;
    const asset = assets.get(panelItem.sourceContentHash);
    const embedding = embeddings.get(panelItem.sourceContentHash);
    if (!asset || !embedding) {
      unresolved.add(panelItem.sourceContentHash);
      continue;
    }
    const physical = physicalSignature(asset);
    const key = stableJson({ semantic: panelItem.consensusSignature, physical });
    const group = baseGroups.get(key) ?? [];
    group.push({
      source: panelItem.sourceContentHash,
      panel: panelItem,
      asset,
      embedding,
      semantic: panelItem.consensusSignature,
      physical,
    });
    baseGroups.set(key, group);
  }
  const cohorts: CatalogAdmissionCohort[] = [];
  for (const group of [...baseGroups.values()].sort((left, right) =>
    compareCanonicalStrings(left[0]!.source, right[0]!.source),
  )) {
    const visualGroups: (typeof group)[] = [];
    for (const item of [...group].sort((a, b) => compareCanonicalStrings(a.source, b.source))) {
      const target = visualGroups.find((candidate) =>
        candidate.every((member) =>
          cosineAtLeast(
            item.embedding.values,
            member.embedding.values,
            policy.minimumVisualSimilarity.numerator,
            policy.minimumVisualSimilarity.denominator,
          ),
        ),
      );
      if (target) target.push(item);
      else visualGroups.push([item]);
    }
    for (const visualGroup of visualGroups) {
      const first = visualGroup[0]!;
      const identity = {
        kind: "CatalogAdmissionCohort" as const,
        semanticSignature: first.semantic,
        physicalSignature: first.physical,
        styleProfileHandle: STYLE_PROFILE_HANDLE_SCHEMA.parse(input.styleProfileHandle),
        proposedEntryKinds: proposedEntryKinds(first.semantic.realizationForms),
        sourceContentHashes: visualGroup.map((item) => item.source).sort(compareCanonicalStrings),
        panelItemHashes: visualGroup.map((item) => item.panel.hash).sort(compareCanonicalStrings),
        visualEmbeddingReceiptHashes: visualGroup
          .map((item) => item.embedding.hash)
          .sort(compareCanonicalStrings),
        compilerAuthority: false as const,
      };
      cohorts.push(
        seal(CATALOG_ADMISSION_COHORT_SCHEMA, {
          ...identity,
          cohortId: `cohort_${contentHash(stableJson(identity)).slice(0, 32)}`,
        }),
      );
    }
  }
  const covered = new Set(cohorts.flatMap((cohort) => cohort.sourceContentHashes));
  for (const asset of input.measurements.assets)
    if (!covered.has(asset.source.contentHash)) unresolved.add(asset.source.contentHash);
  const unresolvedSources = [...unresolved].sort(compareCanonicalStrings);
  return seal(CATALOG_ADMISSION_COHORT_SET_SCHEMA, {
    kind: "CatalogAdmissionCohortSet" as const,
    status: unresolvedSources.length === 0 ? "eligible" : "incomplete",
    policyHash: policy.hash,
    panelHash: input.panel.hash,
    measurementSetHash: input.measurements.hash,
    visualEmbeddingSetHash: input.visualEmbeddings.hash,
    cohorts: canonical(cohorts, (cohort) => cohort.cohortId, "admission cohorts"),
    unresolvedSourceContentHashes: unresolvedSources,
    diagnostics:
      unresolvedSources.length === 0
        ? []
        : [`${unresolvedSources.length} measured assets are not in an evidence-complete cohort`],
    compilerAuthority: false as const,
  });
}

const REVIEW_SELECTION_SCHEMA = z
  .object({
    sourceContentHash: HASH_SCHEMA,
    reasons: z.array(REVIEW_REASON_SCHEMA).min(1).max(5),
  })
  .strict();

export const CATALOG_COHORT_REVIEW_SELECTION_SCHEMA = z
  .object({
    cohortId: z.string().regex(/^cohort_[a-f0-9]{32}$/u),
    cohortHash: HASH_SCHEMA,
    cohortSize: z.number().int().positive().max(100_000),
    selected: z.array(REVIEW_SELECTION_SCHEMA).min(1).max(512),
  })
  .strict();

export const CATALOG_REVIEW_PLAN_SCHEMA = z
  .object({
    kind: z.literal("CatalogReviewPlan"),
    status: COMPILATION_STATUS_SCHEMA,
    policyHash: HASH_SCHEMA,
    cohortSetHash: HASH_SCHEMA,
    panelHash: HASH_SCHEMA,
    measurementSetHash: HASH_SCHEMA,
    visualEmbeddingSetHash: HASH_SCHEMA,
    cohortSelections: z.array(CATALOG_COHORT_REVIEW_SELECTION_SCHEMA).max(100_000),
    exceptionSourceContentHashes: z.array(HASH_SCHEMA).max(100_000),
    selectedSourceCount: z.number().int().nonnegative().max(100_000),
    representedSourceCount: z.number().int().nonnegative().max(100_000),
    diagnostics: z.array(z.string().trim().min(1).max(1024)).max(100_000),
    compilerAuthority: z.literal(false),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyHash(value, context);
    canonicalIssue(value.cohortSelections, (entry) => entry.cohortId, "review selections", context);
    canonicalIssue(value.exceptionSourceContentHashes, String, "review exceptions", context);
    const selected = new Set(
      value.cohortSelections.flatMap((selection) =>
        selection.selected.map((entry) => entry.sourceContentHash),
      ),
    );
    if (selected.size !== value.selectedSourceCount)
      context.addIssue({
        code: "custom",
        path: ["selectedSourceCount"],
        message: "Review count mismatch",
      });
    const expected = value.exceptionSourceContentHashes.length === 0 ? "eligible" : "incomplete";
    if (value.status !== expected)
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Review-plan status mismatch",
      });
  });
export type CatalogReviewPlan = z.output<typeof CATALOG_REVIEW_PLAN_SCHEMA>;

export function buildCatalogReviewPlan(input: {
  readonly policy: CatalogAdmissionPolicy;
  readonly panel: CatalogHypothesisPanel;
  readonly cohorts: CatalogAdmissionCohortSet;
  readonly measurements: CatalogMeasurementSet;
  readonly visualEmbeddings: CatalogVisualEmbeddingSet;
}): CatalogReviewPlan {
  const policy = CATALOG_ADMISSION_POLICY_SCHEMA.parse(input.policy);
  if (
    input.panel.policyHash !== policy.hash ||
    input.cohorts.policyHash !== policy.hash ||
    input.cohorts.panelHash !== input.panel.hash ||
    input.cohorts.measurementSetHash !== input.measurements.hash ||
    input.cohorts.visualEmbeddingSetHash !== input.visualEmbeddings.hash
  )
    throw new Error("Review inputs do not bind one coherent evidence graph");
  const assets = new Map(
    input.measurements.assets.map((asset) => [asset.source.contentHash, asset] as const),
  );
  const embeddings = new Map(
    input.visualEmbeddings.receipts.map((entry) => [entry.sourceContentHash, entry] as const),
  );
  const cohortVisualCentroids = new Map(
    input.cohorts.cohorts.map(
      (cohort) =>
        [
          cohort.cohortId,
          centroid(cohort.sourceContentHashes.map((source) => required(embeddings, source).values)),
        ] as const,
    ),
  );
  const boundaryGroups = groupBy(input.cohorts.cohorts, (cohort) =>
    stableJson({
      semanticSignature: cohort.semanticSignature,
      physicalSignature: cohort.physicalSignature,
    }),
  );
  const selections = input.cohorts.cohorts.map((cohort) => {
    const reasons = new Map<string, Set<z.output<typeof REVIEW_REASON_SCHEMA>>>();
    const add = (source: string | undefined, reason: z.output<typeof REVIEW_REASON_SCHEMA>) => {
      if (!source) return;
      const current = reasons.get(source) ?? new Set();
      current.add(reason);
      reasons.set(source, current);
    };
    const sources = cohort.sourceContentHashes;
    const visualCenter = required(cohortVisualCentroids, cohort.cohortId);
    const visualMedoid = closestToVector(
      sources,
      visualCenter,
      (source) => required(embeddings, source).values,
    );
    add(visualMedoid, "visual_medoid");
    add(
      farthestFromVector(sources, visualCenter, (source) => required(embeddings, source).values),
      "visual_outlier",
    );
    const metricCenter = centroid(sources.map((source) => metricVector(required(assets, source))));
    add(
      farthestFromVector(sources, metricCenter, (source) => metricVector(required(assets, source))),
      "metric_outlier",
    );
    const siblings =
      boundaryGroups
        .get(
          stableJson({
            semanticSignature: cohort.semanticSignature,
            physicalSignature: cohort.physicalSignature,
          }),
        )
        ?.filter((candidate) => candidate.cohortId !== cohort.cohortId) ?? [];
    if (siblings.length > 0) {
      const nearestSibling = [...siblings].sort(
        (left, right) =>
          vectorDistance(visualCenter, required(cohortVisualCentroids, left.cohortId)) -
            vectorDistance(visualCenter, required(cohortVisualCentroids, right.cohortId)) ||
          compareCanonicalStrings(left.cohortId, right.cohortId),
      )[0]!;
      add(
        closestToVector(
          sources,
          required(cohortVisualCentroids, nearestSibling.cohortId),
          (source) => required(embeddings, source).values,
        ),
        "semantic_boundary",
      );
    }
    const auditCount = Math.min(
      policy.reviewSampling.maximumAuditPerCohort,
      Math.ceil((sources.length * policy.reviewSampling.deterministicAuditPermille) / 1000),
    );
    const rankedAudit = [...sources].sort((left, right) =>
      compareCanonicalStrings(
        contentHash(`${policy.hash}:${cohort.hash}:${left}`),
        contentHash(`${policy.hash}:${cohort.hash}:${right}`),
      ),
    );
    for (const source of rankedAudit.slice(0, auditCount)) add(source, "deterministic_audit");
    for (const source of sources) {
      if (reasons.size >= Math.min(policy.reviewSampling.minimumPerCohort, sources.length)) break;
      add(source, "deterministic_audit");
    }
    return {
      cohortId: cohort.cohortId,
      cohortHash: cohort.hash,
      cohortSize: sources.length,
      selected: [...reasons]
        .map(([sourceContentHash, reasonSet]) => ({
          sourceContentHash,
          reasons: [...reasonSet].sort(compareCanonicalStrings),
        }))
        .sort((left, right) =>
          compareCanonicalStrings(left.sourceContentHash, right.sourceContentHash),
        ),
    };
  });
  const selectedSourceCount = new Set(
    selections.flatMap((selection) => selection.selected.map((entry) => entry.sourceContentHash)),
  ).size;
  const representedSourceCount = input.cohorts.cohorts.reduce(
    (sum, cohort) => sum + cohort.sourceContentHashes.length,
    0,
  );
  const exceptions = input.cohorts.unresolvedSourceContentHashes;
  return seal(CATALOG_REVIEW_PLAN_SCHEMA, {
    kind: "CatalogReviewPlan" as const,
    status: exceptions.length === 0 ? "eligible" : "incomplete",
    policyHash: policy.hash,
    cohortSetHash: input.cohorts.hash,
    panelHash: input.panel.hash,
    measurementSetHash: input.measurements.hash,
    visualEmbeddingSetHash: input.visualEmbeddings.hash,
    cohortSelections: canonical(selections, (selection) => selection.cohortId, "review selections"),
    exceptionSourceContentHashes: exceptions,
    selectedSourceCount,
    representedSourceCount,
    diagnostics:
      exceptions.length === 0
        ? []
        : [`${exceptions.length} assets require exception review or additional evidence`],
    compilerAuthority: false as const,
  });
}

export function hypothesisSignature(
  receipt: AssetSemanticHypothesisReceipt,
): CatalogHypothesisSignature {
  const assertions = receipt.assertions.assertions;
  return HYPOTHESIS_SIGNATURE_SCHEMA.parse({
    concepts: canonical(
      assertions.flatMap((assertion) =>
        assertion.assertionKind === "denotation" ? [assertion.concept] : [],
      ),
      (entry) => `${entry.conceptId}:${entry.commitmentHash}`,
      "hypothesized concepts",
    ),
    realizationForms: canonical(
      assertions.flatMap((assertion) =>
        assertion.assertionKind === "realization_form" ? [assertion.realizationForm] : [],
      ),
      String,
      "hypothesized realization forms",
    ),
    states: canonical(
      assertions.flatMap((assertion) =>
        assertion.assertionKind === "state"
          ? [
              {
                stateDimensionId: assertion.stateDimensionId,
                stateValueId: assertion.stateValueId,
              },
            ]
          : [],
      ),
      (entry) => `${entry.stateDimensionId}:${entry.stateValueId}`,
      "hypothesized states",
    ),
    affordanceIds: canonical(
      assertions.flatMap((assertion) =>
        assertion.assertionKind === "affordance" ? [assertion.affordanceId] : [],
      ),
      String,
      "hypothesized affordances",
    ),
    surfaceTreatmentIds: canonical(
      assertions.flatMap((assertion) =>
        assertion.assertionKind === "surface_treatment" ? [assertion.surfaceTreatmentId] : [],
      ),
      String,
      "hypothesized surface treatments",
    ),
  });
}

function validateReceiptBinding(
  request: CatalogHypothesisRequestSet["requests"][number],
  receipt: AssetSemanticHypothesisReceipt,
): void {
  if (
    receipt.sourceContentHash !== request.sourceContentHash ||
    receipt.measurementHash !== request.measurementHash ||
    receipt.renderEvidenceHash !== request.renderEvidenceHash ||
    receipt.sourceNameHintHash !== request.sourceNameHintHash ||
    receipt.semanticModuleHash !== request.semanticModuleHash ||
    receipt.semanticLexiconHash !== request.semanticLexiconHash
  )
    throw new Error(`Hypothesis receipt does not bind its exact request: ${receipt.hash}`);
}

function isCompleteSignature(signature: CatalogHypothesisSignature): boolean {
  return signature.concepts.length > 0 && signature.realizationForms.length > 0;
}

function physicalSignature(
  asset: CatalogAssetArtifact,
): z.output<typeof PHYSICAL_SIGNATURE_SCHEMA> {
  const dimension = (axis: "x" | "y" | "z") =>
    dequantizeQ32_32(asset.bounds.max[axis]) - dequantizeQ32_32(asset.bounds.min[axis]);
  const bucket = (value: number) =>
    value > 0 ? Math.round(Math.log2(value) * 2) : Number.MIN_SAFE_INTEGER;
  return {
    dimensionBuckets: {
      x: bucket(dimension("x")),
      y: bucket(dimension("y")),
      z: bucket(dimension("z")),
    },
    pbrChannels: [...new Set(asset.materials.flatMap((material) => material.pbrChannels))].sort(
      compareCanonicalStrings,
    ),
    supportKind: asset.support.primaryContact,
    socketCardinality:
      asset.sockets.length === 0 ? "none" : asset.sockets.length === 1 ? "one" : "many",
  };
}

function proposedEntryKinds(realizationForms: readonly string[]): CatalogEntryKind[] {
  const result = new Set<CatalogEntryKind>();
  for (const form of realizationForms) {
    if (form === "whole" || form === "aggregate") result.add("substitution_set");
    if (form === "component" || form === "assembly") result.add("assembly_kit");
    if (form === "surface") {
      result.add("attachment_set");
      result.add("route_kit");
    }
    if (form === "field_or_effect") result.add("environment_realizer");
  }
  return [...result].sort(compareCanonicalStrings);
}

/** Exact integer comparison of cosine similarity against a positive rational threshold. */
function cosineAtLeast(
  left: readonly number[],
  right: readonly number[],
  numerator: number,
  denominator: number,
): boolean {
  if (left.length !== right.length) throw new Error("Visual embeddings have different dimensions");
  let dot = 0n;
  let leftNorm = 0n;
  let rightNorm = 0n;
  for (let index = 0; index < left.length; index += 1) {
    const a = BigInt(left[index]!);
    const b = BigInt(right[index]!);
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (dot <= 0n || leftNorm === 0n || rightNorm === 0n) return false;
  const scaledDot = dot * BigInt(denominator);
  return scaledDot * scaledDot >= BigInt(numerator) ** 2n * leftNorm * rightNorm;
}

function metricVector(asset: CatalogAssetArtifact): number[] {
  const size = (axis: "x" | "y" | "z") =>
    dequantizeQ32_32(asset.bounds.max[axis]) - dequantizeQ32_32(asset.bounds.min[axis]);
  const log = (value: number) => (value > 0 ? Math.log2(value) : -32);
  const triangles = asset.parts.reduce((sum, part) => sum + part.triangleCount, 0);
  return [
    log(size("x")),
    log(size("y")),
    log(size("z")),
    log(triangles + 1),
    log(asset.parts.length + 1),
    log(asset.materials.length + 1),
    log(asset.sockets.length + 1),
  ];
}

function vectorDistance(left: readonly number[], right: readonly number[]): number {
  return left.reduce((sum, value, index) => sum + Math.abs(value - right[index]!), 0);
}

function centroid(vectors: readonly (readonly number[])[]): number[] {
  if (vectors.length === 0) throw new Error("Cannot compute an empty centroid");
  const dimension = vectors[0]!.length;
  if (vectors.some((vector) => vector.length !== dimension))
    throw new Error("Centroid vectors have different dimensions");
  return Array.from(
    { length: dimension },
    (_, index) => vectors.reduce((sum, vector) => sum + vector[index]!, 0) / vectors.length,
  );
}

function closestToVector(
  sources: readonly string[],
  target: readonly number[],
  vector: (source: string) => readonly number[],
): string {
  return [...sources].sort(
    (left, right) =>
      vectorDistance(vector(left), target) - vectorDistance(vector(right), target) ||
      compareCanonicalStrings(left, right),
  )[0]!;
}

function farthestFromVector(
  sources: readonly string[],
  target: readonly number[],
  vector: (source: string) => readonly number[],
): string {
  return [...sources].sort(
    (left, right) =>
      vectorDistance(vector(right), target) - vectorDistance(vector(left), target) ||
      compareCanonicalStrings(left, right),
  )[0]!;
}

function groupBy<T>(values: readonly T[], key: (value: T) => string): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const value of values) {
    const group = result.get(key(value)) ?? [];
    group.push(value);
    result.set(key(value), group);
  }
  return result;
}

function required<T>(values: ReadonlyMap<string, T>, key: string): T {
  const value = values.get(key);
  if (!value) throw new Error(`Missing exact evidence for ${key}`);
  return value;
}

function seal<T extends z.ZodTypeAny>(schema: T, material: object): z.output<T> {
  return deepFreezeJson(
    schema.parse({ ...material, hash: contentHash(stableJson(material)) }),
  ) as z.output<T>;
}

function verifyHash(value: Record<string, unknown>, context: z.RefinementCtx): void {
  const material = { ...value };
  delete material.hash;
  if (contentHash(stableJson(material)) !== value.hash)
    context.addIssue({ code: "custom", path: ["hash"], message: "Artifact hash mismatch" });
}

function canonicalIssue<T>(
  values: readonly T[],
  key: (value: T) => string,
  label: string,
  context: z.RefinementCtx,
): void {
  const keys = values.map(key);
  if (
    new Set(keys).size !== keys.length ||
    stableJson([...keys].sort(compareCanonicalStrings)) !== stableJson(keys)
  )
    context.addIssue({ code: "custom", message: `${label} must be unique and canonical` });
}
