import { z } from "zod";
import {
  ASCII_ID_SCHEMA,
  HASH_SCHEMA,
  compareCanonicalStrings,
  stableJson,
} from "@basalt/contracts";
import {
  CATALOG_RIGHTS_SCHEMA,
  ENTRY_HANDLE_SCHEMA,
  MEMBER_ID_SCHEMA,
  PLACEMENT_SIGNATURE_SCHEMA,
  STYLE_PROFILE_DECLARATION_SCHEMA,
  STYLE_PROFILE_HANDLE_SCHEMA,
} from "@basalt/catalog-model";
import {
  CONCEPT_COMMITMENT_REFERENCE_SCHEMA,
  REALIZATION_FORM_SCHEMA,
} from "@basalt/semantic-kernel";
import {
  canonicalValues,
  requireCanonicalValues,
  sealArtifact,
  verifyArtifactHash,
} from "./artifact.js";
import { CATALOG_ADMISSION_RUBRIC_SCHEMA, type CatalogAdmissionRubric } from "./rubric.js";

const REVIEW_EVIDENCE_SCHEMA = z
  .object({
    measurementHash: HASH_SCHEMA,
    renderEvidenceHash: HASH_SCHEMA,
    contactSheetRelativePath: z
      .string()
      .regex(/^\.basalt\/catalog\/review\/previews\/[a-f0-9]{64}\/contact-sheet\.png$/u),
    rgbViewHashes: z.array(HASH_SCHEMA).min(4).max(16),
  })
  .strict()
  .superRefine((value, context) =>
    requireCanonicalValues(value.rgbViewHashes, String, "review RGB evidence", context),
  );

const REVIEW_METRIC_SUMMARY_SCHEMA = z
  .object({
    sourceFrame: z
      .object({
        handedness: z.literal("right_handed"),
        up: z.literal("+Y"),
        forward: z.literal("-Z"),
        unitsToMeters: z.number().finite().positive(),
      })
      .strict(),
    sizeMeters: z
      .object({
        x: z.number().finite().positive(),
        y: z.number().finite().positive(),
        z: z.number().finite().positive(),
      })
      .strict(),
    triangleCount: z.number().int().nonnegative(),
    sourceBytes: z.number().int().positive(),
    partCount: z.number().int().positive(),
    materialCount: z.number().int().nonnegative(),
    pbrChannels: z.array(z.string().trim().min(1).max(64)).max(16),
    primaryContact: z.enum(["bottom", "lateral_wall", "top_ceiling", "socket_only", "unknown"]),
    contactAreaSquareMeters: z.number().finite().nonnegative(),
    supportMeasurementMethod: z.enum(["planar_patch_fit", "lower_extrema", "refused"]),
    collisionMode: z.enum(["none", "companion", "part_obbs"]),
    socketCount: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((value, context) =>
    requireCanonicalValues(value.pbrChannels, String, "review PBR channels", context),
  );

const ADMISSION_PROPOSAL_SCHEMA = z
  .object({
    entryHandle: ENTRY_HANDLE_SCHEMA,
    memberId: MEMBER_ID_SCHEMA,
    denotation: CONCEPT_COMMITMENT_REFERENCE_SCHEMA,
    realizationForm: REALIZATION_FORM_SCHEMA,
    placement: PLACEMENT_SIGNATURE_SCHEMA,
    styleProfileHandle: STYLE_PROFILE_HANDLE_SCHEMA,
    singletonSubstitutionSet: z.literal(true),
  })
  .strict();

const CREATOR_REVIEW_CANDIDATE_SCHEMA = z
  .object({
    sourceContentHash: HASH_SCHEMA,
    sourceRelativePath: z
      .string()
      .regex(/^registry\/source-assets\/sha256\/[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]{64}\.glb$/u),
    assetId: z.string().regex(/^asset_[a-f0-9]{16,56}$/u),
    assetHash: HASH_SCHEMA,
    rights: CATALOG_RIGHTS_SCHEMA,
    evidence: REVIEW_EVIDENCE_SCHEMA,
    metricSummary: REVIEW_METRIC_SUMMARY_SCHEMA,
    proposal: ADMISSION_PROPOSAL_SCHEMA,
    criterionIds: z.array(ASCII_ID_SCHEMA).min(1).max(64),
    reviewStatus: z.literal("pending_creator_review"),
  })
  .strict()
  .superRefine((value, context) => {
    requireCanonicalValues(value.criterionIds, String, "review criterion IDs", context);
    if (!value.sourceRelativePath.endsWith(`/${value.sourceContentHash}.glb`))
      context.addIssue({
        code: "custom",
        path: ["sourceRelativePath"],
        message: "Review source path must bind the exact source content identity",
      });
  });

export const CATALOG_CREATOR_REVIEW_PACKET_SCHEMA = z
  .object({
    kind: z.literal("CatalogCreatorReviewPacket"),
    batchId: ASCII_ID_SCHEMA,
    purpose: z.literal("outdoor_catalog_admission"),
    sourceManifestHash: HASH_SCHEMA,
    measurementSetHash: HASH_SCHEMA,
    visualReviewIndexHash: HASH_SCHEMA,
    semanticModuleHash: HASH_SCHEMA,
    admissionPolicyHash: HASH_SCHEMA,
    admissionRubricHash: HASH_SCHEMA,
    proposedStyleProfile: STYLE_PROFILE_DECLARATION_SCHEMA,
    selectionRationale: z.string().trim().min(1).max(2_048),
    reviewProcedure: z.array(z.string().trim().min(1).max(2_048)).min(1).max(32),
    candidates: z.array(CREATOR_REVIEW_CANDIDATE_SCHEMA).min(1).max(128),
    reviewerAuthorityRequired: z.literal("creator"),
    compilerAuthority: z.literal(false),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(
      value.candidates,
      (entry) => entry.sourceContentHash,
      "creator review candidates",
      context,
    );
    if (
      value.candidates.some(
        (entry) => entry.proposal.styleProfileHandle !== value.proposedStyleProfile.handle,
      )
    )
      context.addIssue({
        code: "custom",
        path: ["candidates"],
        message: "Every admission proposal must bind the reviewed style profile",
      });
  });
export type CatalogCreatorReviewPacket = z.output<typeof CATALOG_CREATOR_REVIEW_PACKET_SCHEMA>;

const CRITERION_DECISION_SCHEMA = z
  .object({
    criterionId: ASCII_ID_SCHEMA,
    outcome: z.enum(["pass", "fail", "uncertain"]),
    evidenceHashes: z.array(HASH_SCHEMA).min(1).max(64),
    note: z.string().trim().min(1).max(2_048),
  })
  .strict()
  .superRefine((value, context) =>
    requireCanonicalValues(value.evidenceHashes, String, "criterion evidence", context),
  );

const SOURCE_REVIEW_DECISION_SCHEMA = z
  .object({
    sourceContentHash: HASH_SCHEMA,
    outcome: z.enum(["eligible", "incomplete", "rejected"]),
    proposalApproved: z.boolean(),
    criteria: z.array(CRITERION_DECISION_SCHEMA).min(1).max(64),
    note: z.string().trim().min(1).max(2_048),
  })
  .strict()
  .superRefine((value, context) => {
    requireCanonicalValues(
      value.criteria,
      (entry) => entry.criterionId,
      "source review criteria",
      context,
    );
    const allPass = value.criteria.every((entry) => entry.outcome === "pass");
    if (value.outcome === "eligible" && (!value.proposalApproved || !allPass))
      context.addIssue({
        code: "custom",
        path: ["outcome"],
        message: "Eligible review decisions require the exact proposal and every criterion to pass",
      });
    if (value.outcome === "rejected" && !value.criteria.some((entry) => entry.outcome === "fail"))
      context.addIssue({
        code: "custom",
        path: ["outcome"],
        message: "Rejected review decisions require at least one failed criterion",
      });
    if (
      value.outcome === "incomplete" &&
      !value.criteria.some((entry) => entry.outcome === "uncertain")
    )
      context.addIssue({
        code: "custom",
        path: ["outcome"],
        message: "Incomplete review decisions require at least one uncertain criterion",
      });
  });

export const CATALOG_CREATOR_REVIEW_DECISION_SCHEMA = z
  .object({
    kind: z.literal("CatalogCreatorReviewDecision"),
    packetHash: HASH_SCHEMA,
    reviewer: z
      .object({ authority: z.literal("creator"), reviewerId: z.string().trim().min(1).max(160) })
      .strict(),
    reviewMethod: z.literal("independent_visual_review"),
    reviewerStatement: z.string().trim().min(32).max(2_048),
    reviewedAt: z.string().datetime({ offset: true }),
    styleProfileDecision: z.enum(["approved", "rejected"]),
    decisions: z.array(SOURCE_REVIEW_DECISION_SCHEMA).min(1).max(128),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(
      value.decisions,
      (entry) => entry.sourceContentHash,
      "creator review decisions",
      context,
    );
    if (
      value.styleProfileDecision !== "approved" &&
      value.decisions.some((entry) => entry.outcome === "eligible")
    )
      context.addIssue({
        code: "custom",
        path: ["styleProfileDecision"],
        message: "Sources cannot be eligible when their bound style profile is rejected",
      });
  });
export type CatalogCreatorReviewDecision = z.output<typeof CATALOG_CREATOR_REVIEW_DECISION_SCHEMA>;

export const CATALOG_ACCEPTANCE_AUDIT_SCHEMA = z
  .object({
    kind: z.literal("CatalogAcceptanceAudit"),
    batchId: ASCII_ID_SCHEMA,
    reviewPacketHash: HASH_SCHEMA,
    reviewDecisionHash: HASH_SCHEMA,
    reviewer: z
      .object({ authority: z.literal("creator"), reviewerId: z.string().trim().min(1).max(160) })
      .strict(),
    admissionPolicyHash: HASH_SCHEMA,
    admissionRubricHash: HASH_SCHEMA,
    semanticModuleHash: HASH_SCHEMA,
    measurementSetHash: HASH_SCHEMA,
    visualReviewIndexHash: HASH_SCHEMA,
    sourceContentHash: HASH_SCHEMA,
    assetHash: HASH_SCHEMA,
    renderEvidenceHash: HASH_SCHEMA,
    assertionBundleHash: HASH_SCHEMA,
    entryHandle: ENTRY_HANDLE_SCHEMA,
    memberId: MEMBER_ID_SCHEMA,
    entryDeclarationHash: HASH_SCHEMA,
    styleProfileHandle: STYLE_PROFILE_HANDLE_SCHEMA,
    criteria: z.array(CRITERION_DECISION_SCHEMA).min(1).max(64),
    outcome: z.literal("eligible"),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(
      value.criteria,
      (entry) => entry.criterionId,
      "acceptance audit criteria",
      context,
    );
    if (value.criteria.some((entry) => entry.outcome !== "pass"))
      context.addIssue({
        code: "custom",
        path: ["criteria"],
        message: "Eligible acceptance audits require every criterion to pass",
      });
  });
export type CatalogAcceptanceAudit = z.output<typeof CATALOG_ACCEPTANCE_AUDIT_SCHEMA>;

export function sealCatalogCreatorReviewPacket(
  input: Omit<CatalogCreatorReviewPacket, "kind" | "compilerAuthority" | "hash">,
): CatalogCreatorReviewPacket {
  return sealArtifact(CATALOG_CREATOR_REVIEW_PACKET_SCHEMA, {
    kind: "CatalogCreatorReviewPacket" as const,
    ...input,
    candidates: canonicalValues(
      input.candidates,
      (entry) => entry.sourceContentHash,
      "creator review candidates",
    ),
    compilerAuthority: false as const,
  });
}

export function sealCatalogCreatorReviewDecision(
  input: Omit<CatalogCreatorReviewDecision, "kind" | "hash">,
): CatalogCreatorReviewDecision {
  return sealArtifact(CATALOG_CREATOR_REVIEW_DECISION_SCHEMA, {
    kind: "CatalogCreatorReviewDecision" as const,
    ...input,
    decisions: canonicalValues(
      input.decisions,
      (entry) => entry.sourceContentHash,
      "creator review decisions",
    ),
  });
}

export function sealCatalogAcceptanceAudit(
  input: Omit<CatalogAcceptanceAudit, "kind" | "outcome" | "hash">,
): CatalogAcceptanceAudit {
  return sealArtifact(CATALOG_ACCEPTANCE_AUDIT_SCHEMA, {
    kind: "CatalogAcceptanceAudit" as const,
    ...input,
    criteria: canonicalValues(
      input.criteria,
      (entry) => entry.criterionId,
      "acceptance audit criteria",
    ),
    outcome: "eligible" as const,
  });
}

export function validateCatalogCreatorReviewDecision(input: {
  readonly packet: CatalogCreatorReviewPacket;
  readonly decision: CatalogCreatorReviewDecision;
  readonly rubric: CatalogAdmissionRubric;
}): void {
  const packet = CATALOG_CREATOR_REVIEW_PACKET_SCHEMA.parse(input.packet);
  const decision = CATALOG_CREATOR_REVIEW_DECISION_SCHEMA.parse(input.decision);
  const rubric = CATALOG_ADMISSION_RUBRIC_SCHEMA.parse(input.rubric);
  if (decision.packetHash !== packet.hash) throw new Error("Creator decision binds another packet");
  if (packet.admissionRubricHash !== rubric.hash)
    throw new Error("Creator review packet binds another admission rubric");
  if (
    stableJson(decision.decisions.map((entry) => entry.sourceContentHash)) !==
    stableJson(packet.candidates.map((entry) => entry.sourceContentHash))
  )
    throw new Error("Creator decision must cover the exact packet candidate set");
  const requiredCriteria = rubric.criteria
    .filter((entry) => entry.subjectKind === "asset")
    .map((entry) => entry.criterionId)
    .sort(compareCanonicalStrings);
  const candidateBySource = new Map(
    packet.candidates.map((entry) => [entry.sourceContentHash, entry] as const),
  );
  for (const sourceDecision of decision.decisions) {
    const candidate = candidateBySource.get(sourceDecision.sourceContentHash)!;
    if (
      stableJson(sourceDecision.criteria.map((entry) => entry.criterionId)) !==
      stableJson(requiredCriteria)
    )
      throw new Error(
        `Creator decision has incomplete criteria for ${sourceDecision.sourceContentHash}`,
      );
    const permittedEvidence = new Set([
      candidate.assetHash,
      candidate.evidence.measurementHash,
      candidate.evidence.renderEvidenceHash,
      candidate.rights.evidenceHash,
      ...candidate.evidence.rgbViewHashes,
    ]);
    for (const criterion of sourceDecision.criteria)
      if (criterion.evidenceHashes.some((hash) => !permittedEvidence.has(hash)))
        throw new Error(
          `Creator decision cites evidence outside its packet for ${sourceDecision.sourceContentHash}`,
        );
  }
}
