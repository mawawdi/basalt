import { z } from "zod";
import {
  ASCII_ID_SCHEMA,
  HASH_SCHEMA,
  compareCanonicalStrings,
  contentHash,
  deepFreezeJson,
  stableJson,
  type CompilationStatus,
} from "@basalt/contracts";
import {
  CATALOG_DISPOSITION_SCHEMA,
  CATALOG_ENTRY_DECLARATION_SCHEMA,
  ENTRY_HANDLE_SCHEMA,
  MEMBER_ID_SCHEMA,
  STYLE_PROFILE_HANDLE_SCHEMA,
  type CatalogDisposition,
  type CatalogEntryDeclaration,
  type CatalogMeasurementSet,
} from "@basalt/catalog-model";
import {
  SEMANTIC_ADMITTED_ASSERTION_BUNDLE_SCHEMA,
  createSemanticDependencyClosure,
  sealSemanticAssertionBundle,
  type SemanticAssertionBundle,
  type SemanticModule,
} from "@basalt/semantic-kernel";
import type { CatalogHypothesisReceiptSet } from "./index.js";
import {
  CATALOG_ADMISSION_COHORT_SET_SCHEMA,
  CATALOG_ADMISSION_POLICY_SCHEMA,
  CATALOG_HYPOTHESIS_PANEL_SCHEMA,
  CATALOG_REVIEW_PLAN_SCHEMA,
  type CatalogAdmissionCohort,
  type CatalogAdmissionCohortSet,
  type CatalogAdmissionPolicy,
  type CatalogHypothesisPanel,
  type CatalogReviewPlan,
} from "./triage.js";

const REVIEW_FINDING_SCHEMA = z.enum(["conforms", "does_not_conform", "uncertain"]);
const REVIEWED_SAMPLE_SCHEMA = z
  .object({
    sourceContentHash: HASH_SCHEMA,
    finding: REVIEW_FINDING_SCHEMA,
    note: z.string().trim().min(1).max(2048),
  })
  .strict();

const ADMISSION_ACTION_SCHEMA = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("admit_substitution_set"),
      entryHandle: ENTRY_HANDLE_SCHEMA,
      styleProfileHandle: STYLE_PROFILE_HANDLE_SCHEMA,
      selectionWeight: z.number().int().positive().max(0x7fff_ffff),
    })
    .strict(),
  z
    .object({
      kind: z.literal("reject"),
      reason: z.string().trim().min(1).max(1024),
    })
    .strict(),
  z
    .object({
      kind: z.literal("remain_incomplete"),
      reason: z.string().trim().min(1).max(1024),
    })
    .strict(),
]);

export const CATALOG_COHORT_DECISION_SCHEMA = z
  .object({
    kind: z.literal("CatalogCohortDecision"),
    policyHash: HASH_SCHEMA,
    cohortId: z.string().regex(/^cohort_[a-f0-9]{32}$/u),
    cohortHash: HASH_SCHEMA,
    reviewPlanHash: HASH_SCHEMA,
    authorityId: ASCII_ID_SCHEMA,
    reviewedSamples: z.array(REVIEWED_SAMPLE_SCHEMA).max(512),
    action: ADMISSION_ACTION_SCHEMA,
    rationale: z.string().trim().min(1).max(4096),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyHash(value, context);
    canonicalIssue(
      value.reviewedSamples,
      (entry) => entry.sourceContentHash,
      "reviewed samples",
      context,
    );
    if (
      value.action.kind === "admit_substitution_set" &&
      value.reviewedSamples.some((entry) => entry.finding !== "conforms")
    )
      context.addIssue({
        code: "custom",
        path: ["reviewedSamples"],
        message: "Admission cannot contain a non-conforming or uncertain reviewed sample",
      });
  });
export type CatalogCohortDecision = z.output<typeof CATALOG_COHORT_DECISION_SCHEMA>;

export function sealCatalogCohortDecision(
  input: Omit<CatalogCohortDecision, "kind" | "hash">,
): CatalogCohortDecision {
  return seal(CATALOG_COHORT_DECISION_SCHEMA, {
    kind: "CatalogCohortDecision" as const,
    ...input,
    reviewedSamples: canonical(
      input.reviewedSamples,
      (entry) => entry.sourceContentHash,
      "reviewed samples",
    ),
  });
}

const AUDIT_SAMPLE_SCHEMA = z
  .object({
    sourceContentHash: HASH_SCHEMA,
    finding: z.enum(["conforms", "violation"]),
    diagnostic: z.string().trim().min(1).max(2048),
  })
  .strict();

export const CATALOG_COHORT_AUDIT_SCHEMA = z
  .object({
    kind: z.literal("CatalogCohortAudit"),
    policyHash: HASH_SCHEMA,
    cohortHash: HASH_SCHEMA,
    decisionHash: HASH_SCHEMA,
    auditorId: ASCII_ID_SCHEMA,
    outcome: z.enum(["passed", "failed"]),
    samples: z.array(AUDIT_SAMPLE_SCHEMA).min(1).max(1024),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyHash(value, context);
    canonicalIssue(value.samples, (entry) => entry.sourceContentHash, "audit samples", context);
    const expected = value.samples.every((entry) => entry.finding === "conforms")
      ? "passed"
      : "failed";
    if (value.outcome !== expected)
      context.addIssue({ code: "custom", path: ["outcome"], message: "Audit outcome mismatch" });
  });
export type CatalogCohortAudit = z.output<typeof CATALOG_COHORT_AUDIT_SCHEMA>;

export function sealCatalogCohortAudit(
  input: Omit<CatalogCohortAudit, "kind" | "outcome" | "hash">,
): CatalogCohortAudit {
  const samples = canonical(input.samples, (entry) => entry.sourceContentHash, "audit samples");
  return seal(CATALOG_COHORT_AUDIT_SCHEMA, {
    kind: "CatalogCohortAudit" as const,
    ...input,
    outcome: samples.every((entry) => entry.finding === "conforms")
      ? ("passed" as const)
      : ("failed" as const),
    samples,
  });
}

export interface CatalogAdmissionResult {
  readonly status: CompilationStatus;
  readonly declarations: readonly CatalogEntryDeclaration[];
  readonly assertions: readonly Extract<SemanticAssertionBundle, { authority: "admitted" }>[];
  readonly dispositions: readonly CatalogDisposition[];
  readonly appliedDecisionHashes: readonly string[];
  readonly diagnostics: readonly string[];
}

/**
 * Materialize explicit cohort decisions into compiler authority. Model output is
 * never copied directly: the curator decision is the declared evidence source,
 * and every admitted member keeps the exact panel and measurement lineage.
 */
export function applyCatalogAdmissionDecisions(input: {
  readonly policy: CatalogAdmissionPolicy;
  readonly module: SemanticModule;
  readonly measurements: CatalogMeasurementSet;
  readonly receipts: CatalogHypothesisReceiptSet;
  readonly panel: CatalogHypothesisPanel;
  readonly cohorts: CatalogAdmissionCohortSet;
  readonly reviewPlan: CatalogReviewPlan;
  readonly decisions: readonly CatalogCohortDecision[];
  readonly audits: readonly CatalogCohortAudit[];
  readonly existingDeclarations: readonly CatalogEntryDeclaration[];
  readonly existingAssertions: readonly Extract<
    SemanticAssertionBundle,
    { authority: "admitted" }
  >[];
  readonly existingDispositions: readonly CatalogDisposition[];
}): CatalogAdmissionResult {
  const policy = CATALOG_ADMISSION_POLICY_SCHEMA.parse(input.policy);
  CATALOG_HYPOTHESIS_PANEL_SCHEMA.parse(input.panel);
  CATALOG_ADMISSION_COHORT_SET_SCHEMA.parse(input.cohorts);
  CATALOG_REVIEW_PLAN_SCHEMA.parse(input.reviewPlan);
  if (
    input.panel.policyHash !== policy.hash ||
    input.cohorts.policyHash !== policy.hash ||
    input.reviewPlan.policyHash !== policy.hash ||
    input.cohorts.panelHash !== input.panel.hash ||
    input.reviewPlan.cohortSetHash !== input.cohorts.hash ||
    input.reviewPlan.panelHash !== input.panel.hash ||
    input.receipts.hash !== input.panel.receiptSetHash
  )
    throw new Error("Admission inputs do not bind one coherent evidence graph");

  const assets = new Map(
    input.measurements.assets.map((asset) => [asset.source.contentHash, asset] as const),
  );
  const panelItems = new Map(
    input.panel.items.map((item) => [item.sourceContentHash, item] as const),
  );
  const receiptsBySource = groupBy(input.receipts.receipts, (receipt) => receipt.sourceContentHash);
  const cohorts = new Map(
    input.cohorts.cohorts.map((cohort) => [cohort.cohortId, cohort] as const),
  );
  const selections = new Map(
    input.reviewPlan.cohortSelections.map((selection) => [selection.cohortId, selection] as const),
  );
  const decisions = canonical(
    input.decisions.map((decision) => CATALOG_COHORT_DECISION_SCHEMA.parse(decision)),
    (decision) => decision.cohortId,
    "cohort decisions",
  );
  const auditsByDecision = groupBy(
    input.audits.map((audit) => CATALOG_COHORT_AUDIT_SCHEMA.parse(audit)),
    (audit) => audit.decisionHash,
  );
  const declarations = new Map(
    input.existingDeclarations.map((entry) => {
      const parsed = CATALOG_ENTRY_DECLARATION_SCHEMA.parse(entry);
      return [parsed.handle, parsed] as const;
    }),
  );
  const assertions = new Map(
    input.existingAssertions.map((entry) => {
      const parsed = SEMANTIC_ADMITTED_ASSERTION_BUNDLE_SCHEMA.parse(entry);
      return [parsed.hash, parsed] as const;
    }),
  );
  const dispositions = new Map(
    input.existingDispositions.map((entry) => {
      const parsed = CATALOG_DISPOSITION_SCHEMA.parse(entry);
      return [parsed.sourceContentHash, parsed] as const;
    }),
  );
  const diagnostics: string[] = [];
  const applied: string[] = [];

  for (const decision of decisions) {
    const cohort = cohorts.get(decision.cohortId);
    if (!cohort || cohort.hash !== decision.cohortHash)
      throw new Error(`Decision binds an unavailable cohort: ${decision.cohortId}`);
    if (decision.policyHash !== policy.hash || decision.reviewPlanHash !== input.reviewPlan.hash)
      throw new Error(`Decision uses stale policy or review evidence: ${decision.hash}`);
    const selection = selections.get(cohort.cohortId);
    if (!selection || selection.cohortHash !== cohort.hash)
      throw new Error(`Review plan lacks the exact cohort: ${cohort.cohortId}`);
    const failedAudit = (auditsByDecision.get(decision.hash) ?? []).find(
      (audit) => audit.outcome === "failed",
    );
    if (failedAudit) {
      diagnostics.push(`Decision ${decision.hash} is blocked by failed audit ${failedAudit.hash}`);
      continue;
    }

    if (decision.action.kind === "reject") {
      for (const sourceContentHash of cohort.sourceContentHashes)
        dispositions.set(sourceContentHash, {
          sourceContentHash,
          status: "rejected",
          reason: decision.action.reason,
        });
      applied.push(decision.hash);
      continue;
    }
    if (decision.action.kind === "remain_incomplete") {
      for (const sourceContentHash of cohort.sourceContentHashes)
        dispositions.set(sourceContentHash, {
          sourceContentHash,
          status: "incomplete",
          reason: decision.action.reason,
        });
      applied.push(decision.hash);
      continue;
    }

    const blockReason = automaticAdmissionBlockReason(policy, cohort, selection, decision);
    if (blockReason) {
      diagnostics.push(`${cohort.cohortId}: ${blockReason}`);
      continue;
    }
    const placement = placementFor(cohort);
    if (!placement) {
      diagnostics.push(
        `${cohort.cohortId}: support evidence is insufficient for substitution-set admission`,
      );
      continue;
    }
    const concept = cohort.semanticSignature.concepts[0]!;
    const realizationForm = cohort.semanticSignature.realizationForms[0]!;
    const definitionIds = [
      realizationForm,
      ...cohort.semanticSignature.affordanceIds,
      ...cohort.semanticSignature.surfaceTreatmentIds,
      ...cohort.semanticSignature.states.flatMap((state) => [
        state.stateDimensionId,
        state.stateValueId,
      ]),
    ];
    const closure = createSemanticDependencyClosure({
      module: input.module,
      conceptIds: [concept.conceptId],
      definitionIds,
    });
    const members: Extract<CatalogEntryDeclaration, { kind: "substitution_set" }>["members"] = [];
    const entryEvidence = new Set<string>([decision.hash, cohort.hash]);
    for (const sourceContentHash of cohort.sourceContentHashes) {
      const asset = required(assets, sourceContentHash, "measured catalog asset");
      const panelItem = required(panelItems, sourceContentHash, "panel item");
      const sourceReceipts = receiptsBySource.get(sourceContentHash) ?? [];
      const evidenceHashes = [
        decision.hash,
        cohort.hash,
        panelItem.hash,
        asset.hash,
        ...sourceReceipts.flatMap((receipt) => [receipt.hash, receipt.renderEvidenceHash]),
      ].sort(compareCanonicalStrings);
      const evidence = { level: "declared" as const, evidenceHashes: [...new Set(evidenceHashes)] };
      const subject = { kind: "catalog_asset" as const, id: asset.assetId };
      const bundle = sealSemanticAssertionBundle({
        authority: "admitted",
        assertions: [
          { assertionKind: "denotation", subject, concept, evidence },
          { assertionKind: "realization_form", subject, realizationForm, evidence },
          ...cohort.semanticSignature.states.map((state) => ({
            assertionKind: "state" as const,
            subject,
            ...state,
            evidence,
          })),
          ...cohort.semanticSignature.affordanceIds.map((affordanceId) => ({
            assertionKind: "affordance" as const,
            subject,
            affordanceId,
            evidence,
          })),
          ...cohort.semanticSignature.surfaceTreatmentIds.map((surfaceTreatmentId) => ({
            assertionKind: "surface_treatment" as const,
            subject,
            surfaceTreatmentId,
            evidence,
          })),
        ],
      });
      assertions.set(bundle.hash, bundle);
      const memberId = MEMBER_ID_SCHEMA.parse(`member_${sourceContentHash}`);
      members.push({
        memberId,
        assetHash: asset.hash,
        assertionBundleHash: bundle.hash,
        selectionWeight: decision.action.selectionWeight,
        socketBindings: [],
      });
      dispositions.set(sourceContentHash, {
        sourceContentHash,
        status: "eligible",
        usage: { kind: "entry_member", entryHandle: decision.action.entryHandle, memberId },
      });
      for (const hash of evidenceHashes) entryEvidence.add(hash);
    }
    const semantic = {
      denotation: concept,
      realizationForm,
      fixedStates: cohort.semanticSignature.states,
      affordances: cohort.semanticSignature.affordanceIds.map((affordanceId) => ({
        affordanceId,
        evidenceLevel: "declared" as const,
      })),
      surfaceTreatmentIds: cohort.semanticSignature.surfaceTreatmentIds,
      dependencyClosureHash: closure.hash,
    };
    const existing = declarations.get(decision.action.entryHandle);
    if (existing) {
      if (
        existing.kind !== "substitution_set" ||
        stableJson(existing.semantic) !== stableJson(semantic) ||
        stableJson(existing.placement) !== stableJson(placement) ||
        existing.styleProfileHandle !== decision.action.styleProfileHandle
      )
        throw new Error(
          `Entry handle ${decision.action.entryHandle} already names an incompatible declaration`,
        );
      const mergedMembers = canonical(
        [...existing.members, ...members].filter(
          (member, index, all) =>
            all.findIndex((candidate) => candidate.memberId === member.memberId) === index,
        ),
        (member) => member.memberId,
        "substitution members",
      );
      declarations.set(
        existing.handle,
        CATALOG_ENTRY_DECLARATION_SCHEMA.parse({
          ...existing,
          evidenceHashes: [...new Set([...existing.evidenceHashes, ...entryEvidence])].sort(
            compareCanonicalStrings,
          ),
          members: mergedMembers,
        }),
      );
    } else {
      declarations.set(
        decision.action.entryHandle,
        CATALOG_ENTRY_DECLARATION_SCHEMA.parse({
          kind: "substitution_set",
          handle: decision.action.entryHandle,
          semantic,
          placement,
          styleProfileHandle: decision.action.styleProfileHandle,
          evidenceHashes: [...entryEvidence].sort(compareCanonicalStrings),
          members: canonical(members, (member) => member.memberId, "substitution members"),
        }),
      );
    }
    applied.push(decision.hash);
  }

  const resultDispositions = [...dispositions.values()].sort((left, right) =>
    compareCanonicalStrings(left.sourceContentHash, right.sourceContentHash),
  );
  const status: CompilationStatus =
    diagnostics.length > 0 || resultDispositions.some((entry) => entry.status === "incomplete")
      ? "incomplete"
      : "eligible";
  return deepFreezeJson({
    status,
    declarations: [...declarations.values()].sort((left, right) =>
      compareCanonicalStrings(left.handle, right.handle),
    ),
    assertions: [...assertions.values()].sort((left, right) =>
      compareCanonicalStrings(left.hash, right.hash),
    ),
    dispositions: resultDispositions,
    appliedDecisionHashes: applied.sort(compareCanonicalStrings),
    diagnostics: diagnostics.sort(compareCanonicalStrings),
  });
}

function automaticAdmissionBlockReason(
  policy: CatalogAdmissionPolicy,
  cohort: CatalogAdmissionCohort,
  selection: CatalogReviewPlan["cohortSelections"][number],
  decision: CatalogCohortDecision,
): string | undefined {
  if (!policy.automaticallyAdmissibleEntryKinds.includes("substitution_set"))
    return "policy does not permit cohort materialization as a substitution set";
  if (!cohort.proposedEntryKinds.includes("substitution_set"))
    return "cohort realization is not independently substitutable";
  if (cohort.semanticSignature.concepts.length !== 1)
    return "substitution sets require exactly one denotation";
  if (cohort.semanticSignature.realizationForms.length !== 1)
    return "substitution sets require exactly one realization form";
  if (
    cohort.semanticSignature.realizationForms[0] !== "whole" &&
    cohort.semanticSignature.realizationForms[0] !== "aggregate"
  )
    return "only whole or aggregate realizations may enter a substitution set";
  const states = cohort.semanticSignature.states.map((state) => state.stateDimensionId);
  if (new Set(states).size !== states.length) return "cohort contains conflicting state values";
  const reviewed = new Map(
    decision.reviewedSamples.map((sample) => [sample.sourceContentHash, sample] as const),
  );
  for (const requiredSample of selection.selected) {
    const sample = reviewed.get(requiredSample.sourceContentHash);
    if (!sample || sample.finding !== "conforms")
      return `required review sample ${requiredSample.sourceContentHash} was not confirmed`;
  }
  return undefined;
}

function placementFor(cohort: CatalogAdmissionCohort) {
  const support = cohort.physicalSignature.supportKind;
  if (support === "bottom")
    return { support: "ground" as const, contact: "bottom" as const, interfaces: [] };
  if (support === "lateral_wall")
    return { support: "wall" as const, contact: "lateral_wall" as const, interfaces: [] };
  if (support === "top_ceiling")
    return { support: "ceiling" as const, contact: "top_ceiling" as const, interfaces: [] };
  return undefined;
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

function required<T>(values: ReadonlyMap<string, T>, key: string, label: string): T {
  const value = values.get(key);
  if (!value) throw new Error(`Missing ${label}: ${key}`);
  return value;
}

function canonical<T>(values: readonly T[], key: (value: T) => string, label: string): T[] {
  const result = [...values].sort((left, right) => compareCanonicalStrings(key(left), key(right)));
  if (new Set(result.map(key)).size !== result.length) throw new Error(`${label} must be unique`);
  return result;
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
