import { z } from "zod";
import {
  ASCII_ID_SCHEMA,
  HASH_SCHEMA,
  compareCanonicalStrings,
  contentHash,
  deepFreezeJson,
  stableJson,
} from "@basalt/contracts";
import {
  CATALOG_DISPOSITION_SCHEMA,
  CATALOG_ENTRY_DECLARATION_SCHEMA,
  CATALOG_SNAPSHOT_SCHEMA,
  STYLE_PROFILE_DECLARATION_SCHEMA,
  TRUSTED_SOURCE_MANIFEST_SCHEMA,
  sealStyleProfile,
  type CatalogDisposition,
  type CatalogEntryDeclaration,
  type CatalogSnapshot,
  type StyleProfileDeclaration,
  type TrustedSourceManifest,
} from "@basalt/catalog-model";
import {
  SEMANTIC_ADMITTED_ASSERTION_BUNDLE_SCHEMA,
  type SemanticAssertionBundle,
} from "@basalt/semantic-kernel";
import {
  CATALOG_COHORT_AUDIT_SCHEMA,
  CATALOG_COHORT_DECISION_SCHEMA,
  type CatalogCohortAudit,
  type CatalogCohortDecision,
} from "./admission.js";
import { CATALOG_ADMISSION_POLICY_SCHEMA, type CatalogAdmissionPolicy } from "./triage.js";

export const RETAINED_CATALOG_EVIDENCE_SCHEMA = z
  .object({
    kind: ASCII_ID_SCHEMA,
    relativePath: z.string().regex(/^registry\/evidence\/[a-f0-9]{64}\.json$/u),
    artifactHash: HASH_SCHEMA,
    bytesHash: HASH_SCHEMA,
    bytes: z
      .number()
      .int()
      .positive()
      .max(512 * 1024 * 1024),
  })
  .strict();
export type RetainedCatalogEvidence = z.output<typeof RETAINED_CATALOG_EVIDENCE_SCHEMA>;

/**
 * The one replaceable, tracked catalog root. This is a snapshot/transaction
 * boundary, not a history stream: Git supplies history, while content hashes
 * supply identity and provenance.
 */
export const CATALOG_AUTHORITY_COMMIT_SCHEMA = z
  .object({
    kind: z.literal("CatalogAuthorityCommit"),
    status: z.enum(["eligible", "incomplete"]),
    sourceManifest: TRUSTED_SOURCE_MANIFEST_SCHEMA,
    sourceManifestHash: HASH_SCHEMA,
    semanticModuleHash: HASH_SCHEMA,
    semanticLexiconHash: HASH_SCHEMA,
    measurementSetHash: HASH_SCHEMA,
    snapshot: CATALOG_SNAPSHOT_SCHEMA,
    styleProfiles: z.array(STYLE_PROFILE_DECLARATION_SCHEMA).min(1).max(4096),
    declarations: z.array(CATALOG_ENTRY_DECLARATION_SCHEMA).max(65_536),
    assertions: z.array(SEMANTIC_ADMITTED_ASSERTION_BUNDLE_SCHEMA).max(100_000),
    dispositions: z.array(CATALOG_DISPOSITION_SCHEMA).max(100_000),
    admissionPolicy: CATALOG_ADMISSION_POLICY_SCHEMA,
    cohortDecisions: z.array(CATALOG_COHORT_DECISION_SCHEMA).max(100_000),
    audits: z.array(CATALOG_COHORT_AUDIT_SCHEMA).max(100_000),
    retainedEvidence: z.array(RETAINED_CATALOG_EVIDENCE_SCHEMA).max(100_000),
    sourcePayloadPolicy: z.literal("external_content_addressed"),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyHash(value, context);
    canonicalIssue(value.styleProfiles, (entry) => entry.handle, "commit style profiles", context);
    canonicalIssue(value.declarations, (entry) => entry.handle, "commit declarations", context);
    canonicalIssue(value.assertions, (entry) => entry.hash, "commit assertions", context);
    canonicalIssue(
      value.dispositions,
      (entry) => entry.sourceContentHash,
      "commit dispositions",
      context,
    );
    canonicalIssue(value.cohortDecisions, (entry) => entry.hash, "commit decisions", context);
    canonicalIssue(value.audits, (entry) => entry.hash, "commit audits", context);
    canonicalIssue(
      value.retainedEvidence,
      (entry) => entry.relativePath,
      "retained catalog evidence",
      context,
    );
    if (contentHash(stableJson(value.sourceManifest)) !== value.sourceManifestHash)
      context.addIssue({
        code: "custom",
        path: ["sourceManifestHash"],
        message: "Source manifest hash mismatch",
      });
    if (value.status !== value.snapshot.status)
      context.addIssue({ code: "custom", path: ["status"], message: "Commit status mismatch" });
    if (value.dispositions.length !== value.snapshot.sourceIdentityCount)
      context.addIssue({
        code: "custom",
        path: ["dispositions"],
        message: "Committed disposition count does not match the snapshot",
      });
    if (contentHash(stableJson(value.dispositions)) !== value.snapshot.dispositionsHash)
      context.addIssue({
        code: "custom",
        path: ["dispositions"],
        message: "Committed dispositions do not bind the snapshot",
      });
    const declarationHashes = new Map(
      value.declarations.map((entry) => [entry.handle, contentHash(stableJson(entry))] as const),
    );
    for (const entry of value.snapshot.entries)
      if (declarationHashes.get(entry.handle) !== entry.declarationHash)
        context.addIssue({
          code: "custom",
          path: ["declarations"],
          message: `Snapshot entry ${entry.handle} lacks its exact declaration`,
        });
    const assertionHashes = new Set(value.assertions.map((entry) => entry.hash));
    for (const entry of value.snapshot.entries)
      if (
        entry.kind !== "collection" &&
        entry.memberAssets.some((member) => !assertionHashes.has(member.assertionBundleHash))
      )
        context.addIssue({
          code: "custom",
          path: ["assertions"],
          message: `Snapshot entry ${entry.handle} lacks exact admitted assertions`,
        });
    const styles = new Map(
      value.styleProfiles.map((entry) => [entry.handle, sealStyleProfile(entry)]),
    );
    for (const style of value.snapshot.styleProfiles)
      if (styles.get(style.handle)?.hash !== style.hash)
        context.addIssue({
          code: "custom",
          path: ["styleProfiles"],
          message: `Snapshot style ${style.handle} lacks its exact declaration`,
        });
    const evidenceKinds = value.retainedEvidence.map((entry) => entry.kind);
    if (new Set(evidenceKinds).size !== evidenceKinds.length)
      context.addIssue({
        code: "custom",
        path: ["retainedEvidence"],
        message: "A catalog commit may retain only one current artifact of each evidence kind",
      });
    const measurementEvidence = value.retainedEvidence.find(
      (entry) => entry.kind === "CatalogMeasurementSet",
    );
    if (!measurementEvidence || measurementEvidence.artifactHash !== value.measurementSetHash)
      context.addIssue({
        code: "custom",
        path: ["retainedEvidence"],
        message: "The exact catalog measurement set must be retained in Git",
      });
    const retainedKinds = new Set(evidenceKinds);
    const dependencies = [
      ["CatalogHypothesisRequestSet", ["CatalogSourceNameHintSet"]],
      ["CatalogHypothesisPanel", ["CatalogHypothesisRequestSet", "CatalogHypothesisReceiptSet"]],
      ["CatalogVisualEmbeddingSet", ["CatalogVisualReviewIndex"]],
      [
        "CatalogAdmissionCohortSet",
        ["CatalogHypothesisPanel", "CatalogVisualEmbeddingSet", "CatalogMeasurementSet"],
      ],
      [
        "CatalogReviewPlan",
        ["CatalogAdmissionCohortSet", "CatalogHypothesisPanel", "CatalogVisualEmbeddingSet"],
      ],
    ] as const;
    for (const [kind, requirements] of dependencies)
      if (retainedKinds.has(kind))
        for (const requirement of requirements)
          if (!retainedKinds.has(requirement))
            context.addIssue({
              code: "custom",
              path: ["retainedEvidence"],
              message: `${kind} requires retained ${requirement} evidence`,
            });
  });
export type CatalogAuthorityCommit = z.output<typeof CATALOG_AUTHORITY_COMMIT_SCHEMA>;

export function sealCatalogAuthorityCommit(input: {
  readonly sourceManifest: TrustedSourceManifest;
  readonly semanticModuleHash: string;
  readonly semanticLexiconHash: string;
  readonly measurementSetHash: string;
  readonly snapshot: CatalogSnapshot;
  readonly styleProfiles: readonly StyleProfileDeclaration[];
  readonly declarations: readonly CatalogEntryDeclaration[];
  readonly assertions: readonly Extract<SemanticAssertionBundle, { authority: "admitted" }>[];
  readonly dispositions: readonly CatalogDisposition[];
  readonly admissionPolicy: CatalogAdmissionPolicy;
  readonly cohortDecisions: readonly CatalogCohortDecision[];
  readonly audits: readonly CatalogCohortAudit[];
  readonly retainedEvidence: readonly RetainedCatalogEvidence[];
}): CatalogAuthorityCommit {
  const sourceManifest = TRUSTED_SOURCE_MANIFEST_SCHEMA.parse(input.sourceManifest);
  const material = {
    kind: "CatalogAuthorityCommit" as const,
    status: input.snapshot.status === "eligible" ? ("eligible" as const) : ("incomplete" as const),
    sourceManifest,
    sourceManifestHash: contentHash(stableJson(sourceManifest)),
    semanticModuleHash: HASH_SCHEMA.parse(input.semanticModuleHash),
    semanticLexiconHash: HASH_SCHEMA.parse(input.semanticLexiconHash),
    measurementSetHash: HASH_SCHEMA.parse(input.measurementSetHash),
    snapshot: CATALOG_SNAPSHOT_SCHEMA.parse(input.snapshot),
    styleProfiles: canonical(input.styleProfiles, (entry) => entry.handle, "commit style profiles"),
    declarations: canonical(input.declarations, (entry) => entry.handle, "commit declarations"),
    assertions: canonical(input.assertions, (entry) => entry.hash, "commit assertions"),
    dispositions: canonical(
      input.dispositions,
      (entry) => entry.sourceContentHash,
      "commit dispositions",
    ),
    admissionPolicy: CATALOG_ADMISSION_POLICY_SCHEMA.parse(input.admissionPolicy),
    cohortDecisions: canonical(input.cohortDecisions, (entry) => entry.hash, "commit decisions"),
    audits: canonical(input.audits, (entry) => entry.hash, "commit audits"),
    retainedEvidence: canonical(
      input.retainedEvidence,
      (entry) => entry.relativePath,
      "retained catalog evidence",
    ),
    sourcePayloadPolicy: "external_content_addressed" as const,
  };
  return deepFreezeJson(
    CATALOG_AUTHORITY_COMMIT_SCHEMA.parse({
      ...material,
      hash: contentHash(stableJson(material)),
    }),
  ) as CatalogAuthorityCommit;
}

function canonical<T>(values: readonly T[], key: (value: T) => string, label: string): T[] {
  const result = [...values].sort((left, right) => compareCanonicalStrings(key(left), key(right)));
  if (new Set(result.map(key)).size !== result.length) throw new Error(`${label} must be unique`);
  return result;
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
