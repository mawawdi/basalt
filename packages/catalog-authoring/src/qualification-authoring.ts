import { z } from "zod";
import { HASH_SCHEMA, stableJson } from "@basalt/contracts";
import { CATALOG_MEASUREMENT_SET_SCHEMA, type CatalogMeasurementSet } from "@basalt/catalog-model";
import {
  ASSET_METRIC_PROMPT_SUMMARY_SCHEMA,
  CATALOG_COMPLETENESS_HINT_SCHEMA,
  CATALOG_SOURCE_ROLE_HINT_SCHEMA,
  CATALOG_VISUAL_COMPOSITION_SCHEMA,
} from "./metadata.js";
import { CATALOG_REVIEW_VIEW_ID_SCHEMA } from "./render.js";
import {
  CATALOG_SOURCE_NAME_HINT_SET_SCHEMA,
  sourceFilenameObservationsIdentifyCollisionCompanion,
  type CatalogSourceNameHintSet,
} from "./source-name-hints.js";
import {
  canonicalValues,
  requireCanonicalValues,
  sealArtifact,
  verifyArtifactHash,
} from "./artifact.js";
import {
  CATALOG_SEARCH_QUERY_SCHEMA,
  CATALOG_SEARCH_RESULT_SET_SCHEMA,
  sealCatalogSearchQuery,
  type CatalogSearchQuery,
  type CatalogSearchResultSet,
} from "./search.js";
import {
  CATALOG_SEARCH_VALIDATION_REQUEST_SCHEMA,
  CATALOG_VALIDATION_RECEIPT_SCHEMA,
  CATALOG_VALIDATION_VERDICT_SCHEMA,
  CATALOG_VISUAL_VALIDATION_JSON_SCHEMA_HASH,
  type CatalogValidationReceipt,
} from "./validation.js";

export const CATALOG_QUALIFICATION_SELECTION_TAGS = [
  "assembly_component",
  "attachment",
  "complete",
  "component_like",
  "environment_realizer",
  "intentionally_partial",
  "multi_object_aggregate",
  "route_component",
  "semantic_boundary",
  "single_object",
  "source_name_mismatch",
  "standalone",
  "style_contrast",
  "vegetation",
] as const;

export const CATALOG_QUALIFICATION_SELECTION_TAG_SCHEMA = z.union([
  CATALOG_VISUAL_COMPOSITION_SCHEMA.exclude(["collision_proxy_like"]),
  CATALOG_SOURCE_ROLE_HINT_SCHEMA,
  CATALOG_COMPLETENESS_HINT_SCHEMA,
  z.enum(["semantic_boundary", "source_name_mismatch", "style_contrast", "vegetation"]),
]);

const REVIEW_EVIDENCE_AUDIT_FINDING_SCHEMA = z
  .object({
    sourceContentHash: HASH_SCHEMA,
    filenameHintHash: HASH_SCHEMA,
    finding: z.literal("explicit_non_renderable_collision_companion"),
    appearanceReviewDisposition: z.literal("excluded"),
    measuredPartRoles: z.array(z.enum(["collision_proxy", "render_interactive", "render_static"])),
    materialCount: z.number().int().nonnegative(),
    pbrChannels: z
      .array(
        z.enum(["base_color", "emissive", "metallic_roughness", "normal", "occlusion", "opacity"]),
      )
      .max(6),
    diagnostics: z.array(z.string().trim().min(1).max(2_048)).min(1),
  })
  .strict()
  .superRefine((value, context) => {
    requireCanonicalValues(value.measuredPartRoles, String, "measured part roles", context);
    requireCanonicalValues(value.pbrChannels, String, "measured PBR channels", context);
    requireCanonicalValues(value.diagnostics, String, "review-evidence diagnostics", context);
  });

export const CATALOG_REVIEW_EVIDENCE_AUDIT_SCHEMA = z
  .object({
    kind: z.literal("CatalogReviewEvidenceAudit"),
    status: z.enum(["eligible", "incomplete"]),
    sourceManifestHash: HASH_SCHEMA,
    measurementSetHash: HASH_SCHEMA,
    sourceNameHintSetHash: HASH_SCHEMA,
    auditedSourceCount: z.number().int().positive(),
    collisionSuffixPolicy: z.literal("explicit_suffix_marks_non_renderable_companion_only"),
    findings: z.array(REVIEW_EVIDENCE_AUDIT_FINDING_SCHEMA),
    appearanceAuthority: z.literal(false),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(
      value.findings,
      (entry) => entry.sourceContentHash,
      "review-evidence audit findings",
      context,
    );
    const expectedStatus = value.findings.some((entry) =>
      entry.measuredPartRoles.some((role) => role !== "collision_proxy"),
    )
      ? "incomplete"
      : "eligible";
    if (value.status !== expectedStatus)
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Review-evidence audit status does not match collision-role findings",
      });
  });
export type CatalogReviewEvidenceAudit = z.output<typeof CATALOG_REVIEW_EVIDENCE_AUDIT_SCHEMA>;

export function buildCatalogReviewEvidenceAudit(input: {
  readonly sourceManifestHash: string;
  readonly measurements: CatalogMeasurementSet;
  readonly sourceNameHints: CatalogSourceNameHintSet;
}): CatalogReviewEvidenceAudit {
  const measurements = CATALOG_MEASUREMENT_SET_SCHEMA.parse(input.measurements);
  const sourceNameHints = CATALOG_SOURCE_NAME_HINT_SET_SCHEMA.parse(input.sourceNameHints);
  const measurementBySource = new Map(
    measurements.assets.map((entry) => [entry.source.contentHash, entry] as const),
  );
  const findings = sourceNameHints.items.flatMap((hint) => {
    const observations = hint.observations.map((entry) => entry.originalFilename);
    if (!sourceFilenameObservationsIdentifyCollisionCompanion(observations)) return [];
    const measurement = measurementBySource.get(hint.sourceContentHash);
    if (!measurement)
      throw new Error(`Collision companion lacks measurement: ${hint.sourceContentHash}`);
    const measuredPartRoles = [...new Set(measurement.parts.map((part) => part.role))].sort();
    const pbrChannels = [
      ...new Set(measurement.materials.flatMap((material) => material.pbrChannels)),
    ].sort();
    const diagnostics = [
      "The explicit _Collision suffix identifies a non-renderable collision companion; appearance renders cannot establish its visual material.",
      ...(measuredPartRoles.some((role) => role !== "collision_proxy")
        ? ["Measurement currently classifies one or more collision-companion parts as renderable."]
        : []),
      ...(measurement.materials.length > 0
        ? [
            "Source appearance materials are retained only as diagnostic input and must not make this companion renderable.",
          ]
        : []),
    ].sort();
    return [
      {
        sourceContentHash: hint.sourceContentHash,
        filenameHintHash: hint.hash,
        finding: "explicit_non_renderable_collision_companion" as const,
        appearanceReviewDisposition: "excluded" as const,
        measuredPartRoles,
        materialCount: measurement.materials.length,
        pbrChannels,
        diagnostics,
      },
    ];
  });
  const status = findings.some((entry) =>
    entry.measuredPartRoles.some((role) => role !== "collision_proxy"),
  )
    ? "incomplete"
    : "eligible";
  return sealArtifact(CATALOG_REVIEW_EVIDENCE_AUDIT_SCHEMA, {
    kind: "CatalogReviewEvidenceAudit" as const,
    status,
    sourceManifestHash: HASH_SCHEMA.parse(input.sourceManifestHash),
    measurementSetHash: measurements.hash,
    sourceNameHintSetHash: sourceNameHints.hash,
    auditedSourceCount: sourceNameHints.items.length,
    collisionSuffixPolicy: "explicit_suffix_marks_non_renderable_companion_only" as const,
    findings: canonicalValues(
      findings,
      (entry) => entry.sourceContentHash,
      "review-evidence audit findings",
    ),
    appearanceAuthority: false as const,
  });
}

const GENERIC_DESCRIPTION_KEYS = new Set([
  "3d asset",
  "asset",
  "attachment",
  "component",
  "environment object",
  "model",
  "modular piece",
  "object",
  "object aggregate",
  "piece",
  "stylized asset",
  "stylized object",
  "stylized object aggregate",
  "thing",
]);

function descriptionKey(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

export function isGenericCatalogDescription(value: string): boolean {
  return GENERIC_DESCRIPTION_KEYS.has(descriptionKey(value));
}

const UNCERTAINTY_REASON_SCHEMA = z.string().trim().min(16).max(2_048);

export const CATALOG_VISIBLE_DESCRIPTION_ASSESSMENT_SCHEMA = z
  .object({
    status: z.enum(["concrete", "uncertain", "unreviewable"]),
    text: z.string().trim().min(3).max(320).nullable(),
    uncertaintyReason: UNCERTAINTY_REASON_SCHEMA.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.text !== null && isGenericCatalogDescription(value.text))
      context.addIssue({
        code: "custom",
        path: ["text"],
        message: "A completed description cannot be a generic placeholder",
      });
    if (value.status === "concrete" && (value.text === null || value.uncertaintyReason !== null))
      context.addIssue({
        code: "custom",
        message: "A concrete visible description requires text and cannot carry uncertainty",
      });
    if (value.status === "uncertain" && (value.text === null || value.uncertaintyReason === null))
      context.addIssue({
        code: "custom",
        message: "An uncertain visible description requires broad text and an uncertainty reason",
      });
    if (
      value.status === "unreviewable" &&
      (value.text !== null || value.uncertaintyReason === null)
    )
      context.addIssue({
        code: "custom",
        message: "Unreviewable evidence requires a reason and cannot assert a description",
      });
  });

const DESCRIPTION_REVIEW_VIEW_SCHEMA = z
  .object({
    viewId: CATALOG_REVIEW_VIEW_ID_SCHEMA,
    rgbHash: HASH_SCHEMA,
    rgbRelativePath: z
      .string()
      .regex(
        /^\.basalt\/catalog\/review\/previews\/[a-f0-9]{64}\/(?:low|high)_[0-9]{2}-rgb\.png$/u,
      ),
  })
  .strict();

const DESCRIPTION_REVIEW_EVIDENCE_SCHEMA = z
  .object({
    renderEvidenceHash: HASH_SCHEMA,
    contactSheetRelativePath: z
      .string()
      .regex(/^\.basalt\/catalog\/review\/previews\/[a-f0-9]{64}\/contact-sheet\.png$/u),
    rgbViews: z.array(DESCRIPTION_REVIEW_VIEW_SCHEMA).length(12),
    metricSummary: ASSET_METRIC_PROMPT_SUMMARY_SCHEMA,
  })
  .strict()
  .superRefine((value, context) =>
    requireCanonicalValues(
      value.rgbViews,
      (entry) => entry.viewId,
      "description review views",
      context,
    ),
  );

export const CATALOG_DESCRIPTION_EVIDENCE_DEFECTS = [
  "material_projection_failure",
  "missing_or_incomplete_views",
  "non_renderable_collision_companion",
  "render_bounds_failure",
  "unreadable_scale_or_framing",
] as const;

export const CATALOG_DESCRIPTION_EVIDENCE_USABILITY_SCHEMA = z
  .object({
    status: z.enum(["usable", "defective"]),
    defectKinds: z.array(z.enum(CATALOG_DESCRIPTION_EVIDENCE_DEFECTS)),
    note: z.string().trim().min(16).max(2_048).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    requireCanonicalValues(value.defectKinds, String, "description evidence defects", context);
    if (value.status === "usable" && (value.defectKinds.length !== 0 || value.note !== null))
      context.addIssue({
        code: "custom",
        message: "Usable review evidence cannot carry defect claims",
      });
    if (value.status === "defective" && (value.defectKinds.length === 0 || value.note === null))
      context.addIssue({
        code: "custom",
        message: "Defective review evidence requires a typed defect and note",
      });
  });

const DESCRIPTION_PROPOSAL_ASSET_SCHEMA = z
  .object({
    sourceContentHash: HASH_SCHEMA,
    sourceRelativePath: z
      .string()
      .regex(/^registry\/source-assets\/sha256\/[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]{64}\.glb$/u),
    leakageGroupHash: HASH_SCHEMA,
    split: z.literal("development"),
    selectionTags: z.array(CATALOG_QUALIFICATION_SELECTION_TAG_SCHEMA).min(1),
    evidenceUsability: CATALOG_DESCRIPTION_EVIDENCE_USABILITY_SCHEMA,
    visibleDescription: CATALOG_VISIBLE_DESCRIPTION_ASSESSMENT_SCHEMA,
    evidence: DESCRIPTION_REVIEW_EVIDENCE_SCHEMA,
    filenameHint: z
      .object({
        artifactHash: HASH_SCHEMA,
        authority: z.literal("none"),
        observations: z.array(z.string().trim().min(1).max(4_096)).min(1),
      })
      .strict()
      .superRefine((value, context) =>
        requireCanonicalValues(value.observations, String, "filename-hint observations", context),
      ),
  })
  .strict()
  .superRefine((value, context) => {
    requireCanonicalValues(value.selectionTags, String, "qualification selection tags", context);
    if (
      (value.evidenceUsability.status === "defective") !==
      (value.visibleDescription.status === "unreviewable")
    )
      context.addIssue({
        code: "custom",
        message:
          "Defective evidence must leave the description unreviewable; usable evidence must make it reviewable",
      });
    if (!value.sourceRelativePath.endsWith(`/${value.sourceContentHash}.glb`))
      context.addIssue({
        code: "custom",
        path: ["sourceRelativePath"],
        message: "Description review source path must bind the exact source identity",
      });
    if (value.evidence.metricSummary.sourceContentHash !== value.sourceContentHash)
      context.addIssue({
        code: "custom",
        path: ["evidence", "metricSummary"],
        message: "Metric summary binds another source",
      });
    if (!value.evidence.contactSheetRelativePath.includes(value.sourceContentHash))
      context.addIssue({
        code: "custom",
        path: ["evidence", "contactSheetRelativePath"],
        message: "Contact sheet binds another source",
      });
    if (
      value.evidence.rgbViews.some(
        (view) => !view.rgbRelativePath.includes(value.sourceContentHash),
      )
    )
      context.addIssue({
        code: "custom",
        path: ["evidence", "rgbViews"],
        message: "One or more RGB views bind another source",
      });
  });

export const CATALOG_QUALIFICATION_DESCRIPTION_PROPOSAL_SCHEMA = z
  .object({
    kind: z.literal("CatalogQualificationDescriptionProposal"),
    stage: z.literal("description_review"),
    split: z.literal("development"),
    sourceManifestHash: HASH_SCHEMA,
    measurementSetHash: HASH_SCHEMA,
    visualReviewIndexHash: HASH_SCHEMA,
    reviewEvidenceAuditHash: HASH_SCHEMA,
    leakageAnalysisHash: HASH_SCHEMA,
    calibrationSplitHash: HASH_SCHEMA,
    selectionMethod: z.literal("explicit_varied_development_pilot"),
    proposalMethod: z.literal("unscored_visual_evidence_assist"),
    proposalAuthority: z.literal("none"),
    evaluationUse: z.literal("review_assistance_only"),
    queryAuthoringStatus: z.literal("blocked_pending_description_review"),
    qualificationExecutionAuthorized: z.literal(false),
    assets: z.array(DESCRIPTION_PROPOSAL_ASSET_SCHEMA).length(24),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(
      value.assets,
      (entry) => entry.sourceContentHash,
      "description proposal assets",
      context,
    );
    const selectionTags = new Set(value.assets.flatMap((entry) => entry.selectionTags));
    for (const selectionTag of CATALOG_QUALIFICATION_SELECTION_TAGS)
      if (!selectionTags.has(selectionTag))
        context.addIssue({
          code: "custom",
          path: ["assets"],
          message: `Development pilot lacks ${selectionTag} selection-tag coverage`,
        });
  });
export type CatalogQualificationDescriptionProposal = z.output<
  typeof CATALOG_QUALIFICATION_DESCRIPTION_PROPOSAL_SCHEMA
>;

const DESCRIPTION_DECISION_ASSET_SCHEMA = z
  .object({
    sourceContentHash: HASH_SCHEMA,
    reviewAction: z.enum(["accurate", "edited", "unsure", "image_problem"]),
    evidenceUsability: CATALOG_DESCRIPTION_EVIDENCE_USABILITY_SCHEMA,
    visibleDescription: CATALOG_VISIBLE_DESCRIPTION_ASSESSMENT_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.evidenceUsability.status === "defective") !==
      (value.visibleDescription.status === "unreviewable")
    )
      context.addIssue({
        code: "custom",
        message:
          "Defective evidence must leave the description unreviewable; usable evidence must make it reviewable",
      });
  });

export const CATALOG_QUALIFICATION_DESCRIPTION_DECISION_SCHEMA = z
  .object({
    kind: z.literal("CatalogQualificationDescriptionDecision"),
    proposalHash: HASH_SCHEMA,
    reviewer: z
      .object({
        authority: z.literal("creator"),
        reviewerId: z.string().trim().min(1).max(160),
      })
      .strict(),
    reviewMethod: z.literal("independent_visible_description_review"),
    reviewerStatement: z.string().trim().min(32).max(2_048),
    reviewedAt: z.string().datetime({ offset: true }),
    coverage: z.literal("complete"),
    assets: z.array(DESCRIPTION_DECISION_ASSET_SCHEMA).length(24),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(
      value.assets,
      (entry) => entry.sourceContentHash,
      "description decision assets",
      context,
    );
  });
export type CatalogQualificationDescriptionDecision = z.output<
  typeof CATALOG_QUALIFICATION_DESCRIPTION_DECISION_SCHEMA
>;

const REVIEWED_DESCRIPTION_ASSET_SCHEMA = z
  .object({
    sourceContentHash: HASH_SCHEMA,
    evidenceUsability: CATALOG_DESCRIPTION_EVIDENCE_USABILITY_SCHEMA,
    visibleDescription: CATALOG_VISIBLE_DESCRIPTION_ASSESSMENT_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.evidenceUsability.status === "defective") !==
      (value.visibleDescription.status === "unreviewable")
    )
      context.addIssue({
        code: "custom",
        message:
          "Defective evidence must leave the description unreviewable; usable evidence must make it reviewable",
      });
  });

export const CATALOG_QUALIFICATION_DESCRIPTION_SET_SCHEMA = z
  .object({
    kind: z.literal("CatalogQualificationDescriptionSet"),
    stage: z.literal("description_review"),
    status: z.literal("creator_reviewed"),
    proposalHash: HASH_SCHEMA,
    decisionArtifactHash: HASH_SCHEMA,
    reviewer: z
      .object({
        authority: z.literal("creator"),
        reviewerId: z.string().trim().min(1).max(160),
      })
      .strict(),
    reviewedAt: z.string().datetime({ offset: true }),
    assets: z.array(REVIEWED_DESCRIPTION_ASSET_SCHEMA).length(24),
    nextStage: z.literal("query_authoring"),
    visualProposalGenerationScored: z.literal(false),
    qualificationExecutionAuthorized: z.literal(false),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(
      value.assets,
      (entry) => entry.sourceContentHash,
      "reviewed description assets",
      context,
    );
  });
export type CatalogQualificationDescriptionSet = z.output<
  typeof CATALOG_QUALIFICATION_DESCRIPTION_SET_SCHEMA
>;

function canonicalProposalAsset(asset: z.input<typeof DESCRIPTION_PROPOSAL_ASSET_SCHEMA>) {
  return {
    ...asset,
    selectionTags: canonicalValues(asset.selectionTags, String, "qualification selection tags"),
    evidence: {
      ...asset.evidence,
      rgbViews: canonicalValues(
        asset.evidence.rgbViews,
        (entry) => entry.viewId,
        "description review views",
      ),
    },
    filenameHint: {
      ...asset.filenameHint,
      observations: canonicalValues(
        asset.filenameHint.observations,
        String,
        "filename-hint observations",
      ),
    },
  };
}

export function sealCatalogQualificationDescriptionProposal(
  input: Omit<
    CatalogQualificationDescriptionProposal,
    | "kind"
    | "stage"
    | "split"
    | "selectionMethod"
    | "proposalMethod"
    | "proposalAuthority"
    | "evaluationUse"
    | "queryAuthoringStatus"
    | "qualificationExecutionAuthorized"
    | "hash"
  >,
): CatalogQualificationDescriptionProposal {
  return sealArtifact(CATALOG_QUALIFICATION_DESCRIPTION_PROPOSAL_SCHEMA, {
    kind: "CatalogQualificationDescriptionProposal" as const,
    stage: "description_review" as const,
    split: "development" as const,
    selectionMethod: "explicit_varied_development_pilot" as const,
    proposalMethod: "unscored_visual_evidence_assist" as const,
    proposalAuthority: "none" as const,
    evaluationUse: "review_assistance_only" as const,
    queryAuthoringStatus: "blocked_pending_description_review" as const,
    qualificationExecutionAuthorized: false as const,
    ...input,
    assets: canonicalValues(
      input.assets.map(canonicalProposalAsset),
      (entry) => entry.sourceContentHash,
      "description proposal assets",
    ),
  });
}

export function sealCatalogQualificationDescriptionDecision(
  input: Omit<CatalogQualificationDescriptionDecision, "kind" | "hash">,
): CatalogQualificationDescriptionDecision {
  return sealArtifact(CATALOG_QUALIFICATION_DESCRIPTION_DECISION_SCHEMA, {
    kind: "CatalogQualificationDescriptionDecision" as const,
    ...input,
    assets: canonicalValues(
      input.assets,
      (entry) => entry.sourceContentHash,
      "description decision assets",
    ),
  });
}

function reviewedAssetMaterial(
  decision: CatalogQualificationDescriptionDecision,
): CatalogQualificationDescriptionSet["assets"] {
  return decision.assets.map(({ sourceContentHash, evidenceUsability, visibleDescription }) => ({
    sourceContentHash,
    evidenceUsability,
    visibleDescription,
  }));
}

export function validateCatalogQualificationDescriptionDecision(input: {
  readonly proposal: CatalogQualificationDescriptionProposal;
  readonly decision: CatalogQualificationDescriptionDecision;
}): void {
  const proposal = CATALOG_QUALIFICATION_DESCRIPTION_PROPOSAL_SCHEMA.parse(input.proposal);
  const decision = CATALOG_QUALIFICATION_DESCRIPTION_DECISION_SCHEMA.parse(input.decision);
  if (decision.proposalHash !== proposal.hash)
    throw new Error("Description decision does not bind the exact proposal artifact");
  if (
    stableJson(decision.assets.map((entry) => entry.sourceContentHash)) !==
    stableJson(proposal.assets.map((entry) => entry.sourceContentHash))
  )
    throw new Error("Description decision must cover the exact proposed asset identities");
  const proposals = new Map(
    proposal.assets.map((entry) => [entry.sourceContentHash, entry] as const),
  );
  for (const decisionAsset of decision.assets) {
    const proposalAsset = proposals.get(decisionAsset.sourceContentHash)!;
    const unchanged =
      stableJson(decisionAsset.evidenceUsability) === stableJson(proposalAsset.evidenceUsability) &&
      stableJson(decisionAsset.visibleDescription) === stableJson(proposalAsset.visibleDescription);
    const validAction =
      (decisionAsset.reviewAction === "accurate" && unchanged) ||
      (decisionAsset.reviewAction === "edited" &&
        decisionAsset.evidenceUsability.status === "usable" &&
        decisionAsset.visibleDescription.status === "concrete" &&
        !unchanged) ||
      (decisionAsset.reviewAction === "unsure" &&
        decisionAsset.evidenceUsability.status === "usable" &&
        decisionAsset.visibleDescription.status === "uncertain") ||
      (decisionAsset.reviewAction === "image_problem" &&
        decisionAsset.evidenceUsability.status === "defective" &&
        decisionAsset.visibleDescription.status === "unreviewable");
    if (!validAction)
      throw new Error(
        `Description review action does not match the description decision for ${decisionAsset.sourceContentHash}`,
      );
  }
}

export function sealCreatorReviewedCatalogQualificationDescriptionSet(input: {
  readonly proposal: CatalogQualificationDescriptionProposal;
  readonly decision: CatalogQualificationDescriptionDecision;
}): CatalogQualificationDescriptionSet {
  const proposal = CATALOG_QUALIFICATION_DESCRIPTION_PROPOSAL_SCHEMA.parse(input.proposal);
  const decision = CATALOG_QUALIFICATION_DESCRIPTION_DECISION_SCHEMA.parse(input.decision);
  validateCatalogQualificationDescriptionDecision({ proposal, decision });
  return sealArtifact(CATALOG_QUALIFICATION_DESCRIPTION_SET_SCHEMA, {
    kind: "CatalogQualificationDescriptionSet" as const,
    stage: "description_review" as const,
    status: "creator_reviewed" as const,
    proposalHash: proposal.hash,
    decisionArtifactHash: decision.hash,
    reviewer: decision.reviewer,
    reviewedAt: decision.reviewedAt,
    assets: reviewedAssetMaterial(decision),
    nextStage: "query_authoring" as const,
    visualProposalGenerationScored: false as const,
    qualificationExecutionAuthorized: false as const,
  });
}

export function requireCreatorReviewedCatalogQualificationDescriptions(input: {
  readonly proposal: CatalogQualificationDescriptionProposal;
  readonly decision: CatalogQualificationDescriptionDecision;
  readonly descriptions: CatalogQualificationDescriptionSet;
}): void {
  const proposal = CATALOG_QUALIFICATION_DESCRIPTION_PROPOSAL_SCHEMA.parse(input.proposal);
  const decision = CATALOG_QUALIFICATION_DESCRIPTION_DECISION_SCHEMA.parse(input.decision);
  const descriptions = CATALOG_QUALIFICATION_DESCRIPTION_SET_SCHEMA.parse(input.descriptions);
  validateCatalogQualificationDescriptionDecision({ proposal, decision });
  if (
    descriptions.proposalHash !== proposal.hash ||
    descriptions.decisionArtifactHash !== decision.hash ||
    descriptions.reviewer.reviewerId !== decision.reviewer.reviewerId ||
    descriptions.reviewedAt !== decision.reviewedAt ||
    stableJson(descriptions.assets) !== stableJson(reviewedAssetMaterial(decision))
  )
    throw new Error("Reviewed description set does not match the exact creator decision contents");
}

export const CATALOG_QUALIFICATION_QUERY_COVERAGE_TAGS = [
  "aggregate_request",
  "appearance",
  "close_alternative",
  "metric_limit",
  "no_match_probe",
  "style",
  "unobservable_property",
  "whole_component_boundary",
] as const;

export const CATALOG_QUALIFICATION_QUERY_COVERAGE_TAG_SCHEMA = z.enum(
  CATALOG_QUALIFICATION_QUERY_COVERAGE_TAGS,
);

const DEVELOPMENT_QUERY_SCHEMA = z
  .object({
    queryId: z.string().regex(/^[a-z][a-z0-9_]{0,95}$/u),
    request: CATALOG_SEARCH_QUERY_SCHEMA,
    coverageTags: z
      .array(CATALOG_QUALIFICATION_QUERY_COVERAGE_TAG_SCHEMA)
      .min(1)
      .max(CATALOG_QUALIFICATION_QUERY_COVERAGE_TAGS.length),
    authoringNote: z.string().trim().min(16).max(512),
  })
  .strict()
  .superRefine((value, context) => {
    requireCanonicalValues(
      value.coverageTags,
      String,
      "qualification query coverage tags",
      context,
    );
    if (value.request.rankingMode !== "automatic" || value.request.referenceSourceContentHash)
      context.addIssue({
        code: "custom",
        path: ["request"],
        message:
          "Development requests must remain channel-neutral and cannot use a reference asset",
      });
  });

export const CATALOG_QUALIFICATION_DEVELOPMENT_QUERY_SET_SCHEMA = z
  .object({
    kind: z.literal("CatalogQualificationDevelopmentQuerySet"),
    stage: z.literal("query_authoring"),
    split: z.literal("development"),
    status: z.literal("authored_pending_candidate_pooling"),
    descriptionSetHash: HASH_SCHEMA,
    descriptionDecisionArtifactHash: HASH_SCHEMA,
    measurementSetHash: HASH_SCHEMA,
    visualReviewIndexHash: HASH_SCHEMA,
    author: z
      .object({
        authority: z.literal("none"),
        authorId: z.literal("codex_agent"),
      })
      .strict(),
    authoringMethod: z.literal("explicit_realistic_requests"),
    answerKeyAuthority: z.literal("none"),
    poolingPlan: z
      .object({
        retrievalChannels: z
          .array(z.enum(["basename_only", "hybrid", "image_text_only", "metadata_only"]))
          .length(4),
        resultDepthPerChannel: z.number().int().min(5).safe(),
        backgroundPopulation: z.literal("full_measured_basename_searchable_corpus"),
        poolConstruction: z.literal("canonical_union_with_unscored_manual_recall_seeds"),
        unjudgedPolicy: z.literal("unknown_not_negative"),
      })
      .strict()
      .superRefine((value, context) =>
        requireCanonicalValues(
          value.retrievalChannels,
          String,
          "qualification pooling retrieval channels",
          context,
        ),
      ),
    queries: z.array(DEVELOPMENT_QUERY_SCHEMA).min(12),
    nextStage: z.literal("candidate_pooling"),
    qualificationExecutionAuthorized: z.literal(false),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(
      value.queries,
      (entry) => entry.queryId,
      "development qualification queries",
      context,
    );
    const requestHashes = value.queries.map((entry) => entry.request.hash);
    if (new Set(requestHashes).size !== requestHashes.length)
      context.addIssue({
        code: "custom",
        path: ["queries"],
        message: "Development qualification requests must be distinct",
      });
    const normalizedTexts = value.queries.map((entry) =>
      entry.request.text.normalize("NFKC").toLowerCase(),
    );
    if (new Set(normalizedTexts).size !== normalizedTexts.length)
      context.addIssue({
        code: "custom",
        path: ["queries"],
        message: "Development qualification request text must be distinct",
      });
    const coveredTags = new Set(value.queries.flatMap((entry) => entry.coverageTags));
    for (const tag of CATALOG_QUALIFICATION_QUERY_COVERAGE_TAGS)
      if (!coveredTags.has(tag))
        context.addIssue({
          code: "custom",
          path: ["queries"],
          message: `Development qualification queries lack ${tag} coverage`,
        });
    const taggedCount = (tag: (typeof CATALOG_QUALIFICATION_QUERY_COVERAGE_TAGS)[number]) =>
      value.queries.filter((entry) => entry.coverageTags.includes(tag)).length;
    if (taggedCount("metric_limit") < 6)
      context.addIssue({
        code: "custom",
        path: ["queries"],
        message: "Development qualification requires at least six metric-limit requests",
      });
    if (taggedCount("no_match_probe") < 2)
      context.addIssue({
        code: "custom",
        path: ["queries"],
        message: "Development qualification requires at least two no-match probes",
      });
    if (taggedCount("unobservable_property") < 3)
      context.addIssue({
        code: "custom",
        path: ["queries"],
        message: "Development qualification requires at least three evidence-boundary requests",
      });
    if (
      value.queries.some(
        (entry) =>
          entry.coverageTags.includes("metric_limit") &&
          entry.request.constraints.maximumSizeMeters === undefined,
      )
    )
      context.addIssue({
        code: "custom",
        path: ["queries"],
        message: "Metric-limit requests must carry executable maximum-size constraints",
      });
  });
export type CatalogQualificationDevelopmentQuerySet = z.output<
  typeof CATALOG_QUALIFICATION_DEVELOPMENT_QUERY_SET_SCHEMA
>;

function canonicalDevelopmentQuery(query: z.input<typeof DEVELOPMENT_QUERY_SCHEMA>) {
  return {
    ...query,
    coverageTags: canonicalValues(query.coverageTags, String, "qualification query coverage tags"),
  };
}

export function sealCatalogQualificationDevelopmentQuerySet(
  input: Omit<
    CatalogQualificationDevelopmentQuerySet,
    | "kind"
    | "stage"
    | "split"
    | "status"
    | "author"
    | "authoringMethod"
    | "answerKeyAuthority"
    | "nextStage"
    | "qualificationExecutionAuthorized"
    | "hash"
  >,
): CatalogQualificationDevelopmentQuerySet {
  return sealArtifact(CATALOG_QUALIFICATION_DEVELOPMENT_QUERY_SET_SCHEMA, {
    kind: "CatalogQualificationDevelopmentQuerySet" as const,
    stage: "query_authoring" as const,
    split: "development" as const,
    status: "authored_pending_candidate_pooling" as const,
    author: { authority: "none" as const, authorId: "codex_agent" as const },
    authoringMethod: "explicit_realistic_requests" as const,
    answerKeyAuthority: "none" as const,
    ...input,
    poolingPlan: {
      ...input.poolingPlan,
      retrievalChannels: canonicalValues(
        input.poolingPlan.retrievalChannels,
        String,
        "qualification pooling retrieval channels",
      ),
    },
    queries: canonicalValues(
      input.queries.map(canonicalDevelopmentQuery),
      (entry) => entry.queryId,
      "development qualification queries",
    ),
    nextStage: "candidate_pooling" as const,
    qualificationExecutionAuthorized: false as const,
  });
}

export function requireCatalogQualificationDevelopmentQueryPrerequisites(input: {
  readonly proposal: CatalogQualificationDescriptionProposal;
  readonly decision: CatalogQualificationDescriptionDecision;
  readonly descriptions: CatalogQualificationDescriptionSet;
  readonly queries: CatalogQualificationDevelopmentQuerySet;
}): void {
  requireCreatorReviewedCatalogQualificationDescriptions(input);
  const queries = CATALOG_QUALIFICATION_DEVELOPMENT_QUERY_SET_SCHEMA.parse(input.queries);
  if (
    queries.descriptionSetHash !== input.descriptions.hash ||
    queries.descriptionDecisionArtifactHash !== input.decision.hash ||
    queries.measurementSetHash !== input.proposal.measurementSetHash ||
    queries.visualReviewIndexHash !== input.proposal.visualReviewIndexHash
  )
    throw new Error(
      "Development query set does not bind the exact reviewed descriptions and evidence",
    );
}

export type CatalogQualificationDevelopmentQuery = {
  readonly queryId: string;
  readonly request: CatalogSearchQuery;
  readonly coverageTags: readonly (typeof CATALOG_QUALIFICATION_QUERY_COVERAGE_TAGS)[number][];
  readonly authoringNote: string;
};

export const CATALOG_QUALIFICATION_POOLING_CHANNELS = [
  "basename_only",
  "hybrid",
  "image_text_only",
  "metadata_only",
] as const;
export const CATALOG_QUALIFICATION_POOLING_CHANNEL_SCHEMA = z.enum(
  CATALOG_QUALIFICATION_POOLING_CHANNELS,
);

const DEVELOPMENT_POOL_RETRIEVAL_SCHEMA = z
  .object({
    channel: CATALOG_QUALIFICATION_POOLING_CHANNEL_SCHEMA,
    executedQueryHash: HASH_SCHEMA,
    resultSetHash: HASH_SCHEMA,
    rankedSourceContentHashes: z.array(HASH_SCHEMA),
  })
  .strict();

const DEVELOPMENT_POOL_APPEARANCE_SCHEMA = z
  .object({
    channel: CATALOG_QUALIFICATION_POOLING_CHANNEL_SCHEMA,
    rank: z.number().int().positive().safe(),
    resultSetHash: HASH_SCHEMA,
  })
  .strict();

const DEVELOPMENT_POOL_CANDIDATE_SCHEMA = z
  .object({
    sourceContentHash: HASH_SCHEMA,
    population: z.enum(["reviewed_cohort", "background"]),
    measurementHash: HASH_SCHEMA,
    renderEvidenceHash: HASH_SCHEMA,
    retrievedBy: z.array(DEVELOPMENT_POOL_APPEARANCE_SCHEMA).max(4),
    includedByManualRecallSeed: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    requireCanonicalValues(
      value.retrievedBy,
      (entry) => entry.channel,
      "candidate retrieval appearances",
      context,
    );
    if (value.retrievedBy.length === 0 && !value.includedByManualRecallSeed)
      context.addIssue({
        code: "custom",
        path: ["retrievedBy"],
        message: "A pooled candidate must be retrieved or explicitly added as a recall seed",
      });
  });

const DEVELOPMENT_MANUAL_RECALL_SEED_SCHEMA = z
  .object({
    sourceContentHash: HASH_SCHEMA,
    reason: z.string().trim().min(16).max(512),
  })
  .strict();

const DEVELOPMENT_QUERY_POOL_SCHEMA = z
  .object({
    queryId: z.string().regex(/^[a-z][a-z0-9_]{0,95}$/u),
    requestHash: HASH_SCHEMA,
    retrievals: z.array(DEVELOPMENT_POOL_RETRIEVAL_SCHEMA).length(4),
    manualRecallSeeds: z.array(DEVELOPMENT_MANUAL_RECALL_SEED_SCHEMA),
    candidates: z.array(DEVELOPMENT_POOL_CANDIDATE_SCHEMA).min(1),
  })
  .strict()
  .superRefine((value, context) => {
    requireCanonicalValues(value.retrievals, (entry) => entry.channel, "pool retrievals", context);
    requireCanonicalValues(
      value.manualRecallSeeds,
      (entry) => entry.sourceContentHash,
      "manual recall seeds",
      context,
    );
    requireCanonicalValues(
      value.candidates,
      (entry) => entry.sourceContentHash,
      "pooled candidates",
      context,
    );
    if (
      stableJson(value.retrievals.map((entry) => entry.channel)) !==
      stableJson([...CATALOG_QUALIFICATION_POOLING_CHANNELS].sort())
    )
      context.addIssue({
        code: "custom",
        path: ["retrievals"],
        message: "Every development query must bind all four pooling channels",
      });
    const manualSources = new Set(value.manualRecallSeeds.map((entry) => entry.sourceContentHash));
    const expectedSources = canonicalValues(
      [
        ...new Set([
          ...value.retrievals.flatMap((entry) => entry.rankedSourceContentHashes),
          ...manualSources,
        ]),
      ],
      String,
      "pooled candidate union",
    );
    if (
      stableJson(value.candidates.map((entry) => entry.sourceContentHash)) !==
      stableJson(expectedSources)
    )
      context.addIssue({
        code: "custom",
        path: ["candidates"],
        message: "Pooled candidates must exactly equal the retrieval and manual-seed union",
      });
    for (const candidate of value.candidates) {
      const expectedAppearances = value.retrievals.flatMap((retrieval) => {
        const rank = retrieval.rankedSourceContentHashes.indexOf(candidate.sourceContentHash) + 1;
        return rank > 0
          ? [{ channel: retrieval.channel, rank, resultSetHash: retrieval.resultSetHash }]
          : [];
      });
      if (stableJson(candidate.retrievedBy) !== stableJson(expectedAppearances))
        context.addIssue({
          code: "custom",
          path: ["candidates"],
          message: `Candidate ${candidate.sourceContentHash} has inconsistent retrieval appearances`,
        });
      if (candidate.includedByManualRecallSeed !== manualSources.has(candidate.sourceContentHash))
        context.addIssue({
          code: "custom",
          path: ["candidates"],
          message: `Candidate ${candidate.sourceContentHash} has inconsistent recall-seed provenance`,
        });
    }
  });

export const CATALOG_QUALIFICATION_DEVELOPMENT_CANDIDATE_POOL_SCHEMA = z
  .object({
    kind: z.literal("CatalogQualificationDevelopmentCandidatePool"),
    stage: z.literal("candidate_pooling"),
    split: z.literal("development"),
    status: z.literal("pooled_pending_independent_review"),
    querySetHash: HASH_SCHEMA,
    descriptionSetHash: HASH_SCHEMA,
    sourceManifestHash: HASH_SCHEMA,
    measurementSetHash: HASH_SCHEMA,
    visualReviewIndexHash: HASH_SCHEMA,
    sourceNameHintSetHash: HASH_SCHEMA,
    searchPolicyHash: HASH_SCHEMA,
    metadataWriter: z
      .object({
        modelId: z.string().trim().min(1).max(160),
        modelCommitHash: z.string().regex(/^[a-f0-9]{40,64}$/u),
        viewSet: z.literal("canonical_twelve"),
        evidenceMode: z.literal("visual_only"),
        requestSetHash: HASH_SCHEMA,
        metadataSetHash: HASH_SCHEMA,
      })
      .strict(),
    imageTextRetriever: z
      .object({
        modelId: z.string().trim().min(1).max(160),
        modelCommitHash: z.string().regex(/^[a-f0-9]{40,64}$/u),
        embeddingSetHash: HASH_SCHEMA,
        embeddingMatrixHash: HASH_SCHEMA,
      })
      .strict(),
    indexHash: HASH_SCHEMA,
    resultDepthPerChannel: z.number().int().min(5).safe(),
    queryPools: z.array(DEVELOPMENT_QUERY_POOL_SCHEMA).min(12),
    pooledPairCount: z.number().int().positive(),
    reviewedCohortCandidateCount: z.number().int().nonnegative(),
    backgroundCandidateCount: z.number().int().positive(),
    answerKeyAuthority: z.literal("none"),
    unjudgedPolicy: z.literal("unknown_not_negative"),
    nextStage: z.literal("independent_query_asset_review"),
    qualificationExecutionAuthorized: z.literal(false),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(value.queryPools, (entry) => entry.queryId, "query pools", context);
    const candidates = value.queryPools.flatMap((entry) => entry.candidates);
    if (value.pooledPairCount !== candidates.length)
      context.addIssue({
        code: "custom",
        path: ["pooledPairCount"],
        message: "Pooled pair count does not match query-candidate pairs",
      });
    const uniqueCohort = new Set(
      candidates
        .filter((entry) => entry.population === "reviewed_cohort")
        .map((entry) => entry.sourceContentHash),
    );
    const uniqueBackground = new Set(
      candidates
        .filter((entry) => entry.population === "background")
        .map((entry) => entry.sourceContentHash),
    );
    if (value.reviewedCohortCandidateCount !== uniqueCohort.size)
      context.addIssue({
        code: "custom",
        path: ["reviewedCohortCandidateCount"],
        message: "Reviewed-cohort candidate count mismatch",
      });
    if (value.backgroundCandidateCount !== uniqueBackground.size)
      context.addIssue({
        code: "custom",
        path: ["backgroundCandidateCount"],
        message: "Background candidate count mismatch",
      });
  });
export type CatalogQualificationDevelopmentCandidatePool = z.output<
  typeof CATALOG_QUALIFICATION_DEVELOPMENT_CANDIDATE_POOL_SCHEMA
>;

export function developmentPoolingQuery(
  request: CatalogSearchQuery,
  channel: (typeof CATALOG_QUALIFICATION_POOLING_CHANNELS)[number],
  resultDepth: number,
): CatalogSearchQuery {
  return sealCatalogSearchQuery({
    text: request.text,
    styleTerms: request.styleTerms,
    rankingMode: channel,
    constraints: request.constraints,
    limit: resultDepth,
    validationLimit: 0,
  });
}

export function sealCatalogQualificationDevelopmentCandidatePool(
  input: Omit<
    CatalogQualificationDevelopmentCandidatePool,
    | "kind"
    | "stage"
    | "split"
    | "status"
    | "pooledPairCount"
    | "reviewedCohortCandidateCount"
    | "backgroundCandidateCount"
    | "answerKeyAuthority"
    | "unjudgedPolicy"
    | "nextStage"
    | "qualificationExecutionAuthorized"
    | "hash"
  >,
): CatalogQualificationDevelopmentCandidatePool {
  const queryPools = canonicalValues(
    input.queryPools.map((pool) => ({
      ...pool,
      retrievals: canonicalValues(pool.retrievals, (entry) => entry.channel, "pool retrievals"),
      manualRecallSeeds: canonicalValues(
        pool.manualRecallSeeds,
        (entry) => entry.sourceContentHash,
        "manual recall seeds",
      ),
      candidates: canonicalValues(
        pool.candidates.map((candidate) => ({
          ...candidate,
          retrievedBy: canonicalValues(
            candidate.retrievedBy,
            (entry) => entry.channel,
            "candidate retrieval appearances",
          ),
        })),
        (entry) => entry.sourceContentHash,
        "pooled candidates",
      ),
    })),
    (entry) => entry.queryId,
    "query pools",
  );
  const candidates = queryPools.flatMap((entry) => entry.candidates);
  const reviewedCohortCandidateCount = new Set(
    candidates
      .filter((entry) => entry.population === "reviewed_cohort")
      .map((entry) => entry.sourceContentHash),
  ).size;
  const backgroundCandidateCount = new Set(
    candidates
      .filter((entry) => entry.population === "background")
      .map((entry) => entry.sourceContentHash),
  ).size;
  return sealArtifact(CATALOG_QUALIFICATION_DEVELOPMENT_CANDIDATE_POOL_SCHEMA, {
    kind: "CatalogQualificationDevelopmentCandidatePool" as const,
    stage: "candidate_pooling" as const,
    split: "development" as const,
    status: "pooled_pending_independent_review" as const,
    ...input,
    queryPools,
    pooledPairCount: candidates.length,
    reviewedCohortCandidateCount,
    backgroundCandidateCount,
    answerKeyAuthority: "none" as const,
    unjudgedPolicy: "unknown_not_negative" as const,
    nextStage: "independent_query_asset_review" as const,
    qualificationExecutionAuthorized: false as const,
  });
}

export function requireCatalogQualificationDevelopmentCandidatePool(input: {
  readonly queries: CatalogQualificationDevelopmentQuerySet;
  readonly pool: CatalogQualificationDevelopmentCandidatePool;
  readonly resultSets: readonly CatalogSearchResultSet[];
}): void {
  const queries = CATALOG_QUALIFICATION_DEVELOPMENT_QUERY_SET_SCHEMA.parse(input.queries);
  const pool = CATALOG_QUALIFICATION_DEVELOPMENT_CANDIDATE_POOL_SCHEMA.parse(input.pool);
  if (
    pool.querySetHash !== queries.hash ||
    pool.descriptionSetHash !== queries.descriptionSetHash ||
    pool.measurementSetHash !== queries.measurementSetHash ||
    pool.visualReviewIndexHash !== queries.visualReviewIndexHash ||
    pool.resultDepthPerChannel !== queries.poolingPlan.resultDepthPerChannel
  )
    throw new Error("Development candidate pool does not bind the exact authored queries");
  const resultSets = new Map(
    input.resultSets.map((entry) => {
      const parsed = CATALOG_SEARCH_RESULT_SET_SCHEMA.parse(entry);
      return [parsed.hash, parsed] as const;
    }),
  );
  if (resultSets.size !== input.resultSets.length)
    throw new Error("Development candidate pool result sets are duplicated");
  const queryById = new Map(queries.queries.map((entry) => [entry.queryId, entry] as const));
  if (pool.queryPools.length !== queryById.size)
    throw new Error("Development candidate pool does not cover every authored query");
  for (const queryPool of pool.queryPools) {
    const authored = queryById.get(queryPool.queryId);
    if (!authored || queryPool.requestHash !== authored.request.hash)
      throw new Error(`Development candidate pool contains unknown query ${queryPool.queryId}`);
    for (const retrieval of queryPool.retrievals) {
      const result = resultSets.get(retrieval.resultSetHash);
      const expectedQuery = developmentPoolingQuery(
        authored.request,
        retrieval.channel,
        pool.resultDepthPerChannel,
      );
      if (
        !result ||
        result.status !== "eligible" ||
        result.indexHash !== pool.indexHash ||
        result.query.hash !== expectedQuery.hash ||
        retrieval.executedQueryHash !== expectedQuery.hash ||
        stableJson(retrieval.rankedSourceContentHashes) !==
          stableJson(result.results.map((entry) => entry.sourceContentHash))
      )
        throw new Error(
          `Development candidate pool retrieval ${queryPool.queryId}/${retrieval.channel} is stale`,
        );
    }
  }
}

export const CATALOG_QUALIFICATION_RELEVANCE_VERDICTS = [
  "irrelevant",
  "relevant",
  "unknown",
] as const;
export const CATALOG_QUALIFICATION_RELEVANCE_VERDICT_SCHEMA = z.enum(
  CATALOG_QUALIFICATION_RELEVANCE_VERDICTS,
);

const DEVELOPMENT_RELEVANCE_JUDGMENT_SCHEMA = z
  .object({
    sourceContentHash: HASH_SCHEMA,
    measurementHash: HASH_SCHEMA,
    renderEvidenceHash: HASH_SCHEMA,
    verdict: CATALOG_QUALIFICATION_RELEVANCE_VERDICT_SCHEMA,
    note: z.string().trim().min(8).max(1_024).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.verdict === "unknown" && (value.note?.length ?? 0) < 16)
      context.addIssue({
        code: "custom",
        path: ["note"],
        message: "Unknown relevance requires a reason of at least 16 characters",
      });
  });

const DEVELOPMENT_RELEVANCE_QUERY_DECISION_SCHEMA = z
  .object({
    queryId: z.string().regex(/^[a-z][a-z0-9_]{0,95}$/u),
    requestHash: HASH_SCHEMA,
    requestDisposition: z.enum(["accepted", "rejected_for_reauthoring"]),
    requestIssue: z.string().trim().min(16).max(1_024).nullable(),
    judgments: z.array(DEVELOPMENT_RELEVANCE_JUDGMENT_SCHEMA),
  })
  .strict()
  .superRefine((value, context) => {
    requireCanonicalValues(
      value.judgments,
      (entry) => entry.sourceContentHash,
      "query relevance judgments",
      context,
    );
    if (value.requestDisposition === "accepted" && value.requestIssue !== null)
      context.addIssue({
        code: "custom",
        path: ["requestIssue"],
        message: "An accepted request cannot carry a rewrite issue",
      });
    if (
      value.requestDisposition === "rejected_for_reauthoring" &&
      (value.requestIssue === null || value.judgments.length !== 0)
    )
      context.addIssue({
        code: "custom",
        message:
          "A rejected request requires an issue and cannot carry relevance judgments from its stale pool",
      });
  });

export const CATALOG_QUALIFICATION_DEVELOPMENT_RELEVANCE_DECISION_SCHEMA = z
  .object({
    kind: z.literal("CatalogQualificationDevelopmentRelevanceDecision"),
    stage: z.literal("independent_query_asset_review"),
    status: z.enum(["changes_requested", "reviewed"]),
    candidatePoolHash: HASH_SCHEMA,
    querySetHash: HASH_SCHEMA,
    reviewer: z
      .object({
        authority: z.enum(["creator", "delegated_ai"]),
        reviewerId: z.string().trim().min(1).max(160),
      })
      .strict(),
    reviewMethod: z.literal("independent_query_asset_relevance_review"),
    reviewerStatement: z.string().trim().min(32).max(2_048),
    reviewedAt: z.string().datetime({ offset: true }),
    coverage: z.literal("complete"),
    queries: z.array(DEVELOPMENT_RELEVANCE_QUERY_DECISION_SCHEMA).min(12),
    relevanceJudgmentAuthority: z.enum(["creator", "delegated_ai"]),
    validatorVerdictsReviewed: z.literal(false),
    nextStage: z.enum(["query_reauthoring", "validator_execution_and_review"]),
    qualificationExecutionAuthorized: z.literal(false),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(
      value.queries,
      (entry) => entry.queryId,
      "relevance decision queries",
      context,
    );
    const changesRequested = value.queries.some(
      (entry) => entry.requestDisposition === "rejected_for_reauthoring",
    );
    const expectedStatus = changesRequested ? "changes_requested" : "reviewed";
    const expectedNextStage = changesRequested
      ? "query_reauthoring"
      : "validator_execution_and_review";
    if (value.status !== expectedStatus)
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Relevance decision status does not match its request dispositions",
      });
    if (value.relevanceJudgmentAuthority !== value.reviewer.authority)
      context.addIssue({
        code: "custom",
        path: ["relevanceJudgmentAuthority"],
        message: "Relevance judgment authority must identify the actual reviewer authority",
      });
    if (value.nextStage !== expectedNextStage)
      context.addIssue({
        code: "custom",
        path: ["nextStage"],
        message: "Relevance decision next stage does not match its request dispositions",
      });
  });
export type CatalogQualificationDevelopmentRelevanceDecision = z.output<
  typeof CATALOG_QUALIFICATION_DEVELOPMENT_RELEVANCE_DECISION_SCHEMA
>;

export function sealCatalogQualificationDevelopmentRelevanceDecision(
  input: Omit<
    CatalogQualificationDevelopmentRelevanceDecision,
    | "kind"
    | "stage"
    | "status"
    | "relevanceJudgmentAuthority"
    | "validatorVerdictsReviewed"
    | "nextStage"
    | "qualificationExecutionAuthorized"
    | "hash"
  >,
): CatalogQualificationDevelopmentRelevanceDecision {
  const queries = canonicalValues(
    input.queries.map((query) => ({
      ...query,
      judgments: canonicalValues(
        query.judgments,
        (entry) => entry.sourceContentHash,
        "query relevance judgments",
      ),
    })),
    (entry) => entry.queryId,
    "relevance decision queries",
  );
  const changesRequested = queries.some(
    (entry) => entry.requestDisposition === "rejected_for_reauthoring",
  );
  return sealArtifact(CATALOG_QUALIFICATION_DEVELOPMENT_RELEVANCE_DECISION_SCHEMA, {
    kind: "CatalogQualificationDevelopmentRelevanceDecision" as const,
    stage: "independent_query_asset_review" as const,
    status: changesRequested ? ("changes_requested" as const) : ("reviewed" as const),
    ...input,
    queries,
    relevanceJudgmentAuthority: input.reviewer.authority,
    validatorVerdictsReviewed: false as const,
    nextStage: changesRequested
      ? ("query_reauthoring" as const)
      : ("validator_execution_and_review" as const),
    qualificationExecutionAuthorized: false as const,
  });
}

export function requireCatalogQualificationDevelopmentRelevanceDecision(input: {
  readonly queries: CatalogQualificationDevelopmentQuerySet;
  readonly pool: CatalogQualificationDevelopmentCandidatePool;
  readonly decision: CatalogQualificationDevelopmentRelevanceDecision;
}): void {
  const queries = CATALOG_QUALIFICATION_DEVELOPMENT_QUERY_SET_SCHEMA.parse(input.queries);
  const pool = CATALOG_QUALIFICATION_DEVELOPMENT_CANDIDATE_POOL_SCHEMA.parse(input.pool);
  const decision = CATALOG_QUALIFICATION_DEVELOPMENT_RELEVANCE_DECISION_SCHEMA.parse(
    input.decision,
  );
  if (decision.querySetHash !== queries.hash || decision.candidatePoolHash !== pool.hash)
    throw new Error("Relevance decision does not bind the exact query set and candidate pool");
  const authoredById = new Map(queries.queries.map((entry) => [entry.queryId, entry] as const));
  const poolById = new Map(pool.queryPools.map((entry) => [entry.queryId, entry] as const));
  if (decision.queries.length !== authoredById.size || decision.queries.length !== poolById.size)
    throw new Error("Relevance decision does not cover every pooled query");
  for (const reviewed of decision.queries) {
    const authored = authoredById.get(reviewed.queryId);
    const queryPool = poolById.get(reviewed.queryId);
    if (
      !authored ||
      !queryPool ||
      reviewed.requestHash !== authored.request.hash ||
      reviewed.requestHash !== queryPool.requestHash
    )
      throw new Error(`Relevance decision contains stale query ${reviewed.queryId}`);
    if (reviewed.requestDisposition === "rejected_for_reauthoring") continue;
    if (reviewed.judgments.length !== queryPool.candidates.length)
      throw new Error(`Relevance decision has incomplete candidates for ${reviewed.queryId}`);
    for (const [index, candidate] of queryPool.candidates.entries()) {
      const judgment = reviewed.judgments[index];
      if (
        !judgment ||
        judgment.sourceContentHash !== candidate.sourceContentHash ||
        judgment.measurementHash !== candidate.measurementHash ||
        judgment.renderEvidenceHash !== candidate.renderEvidenceHash
      )
        throw new Error(
          `Relevance decision does not match pooled candidate evidence for ${reviewed.queryId}`,
        );
    }
  }
}

export const CATALOG_QUALIFICATION_DEVELOPMENT_VALIDATOR_CASE_SELECTION_REASONS = [
  "reviewed_relevant",
  "reviewed_unknown",
  "top_ranked_irrelevant",
] as const;

const DEVELOPMENT_VALIDATOR_CASE_SCHEMA = z
  .object({
    caseId: z.string().regex(/^[a-z][a-z0-9_]{0,191}$/u),
    queryId: z.string().regex(/^[a-z][a-z0-9_]{0,95}$/u),
    requestHash: HASH_SCHEMA,
    sourceContentHash: HASH_SCHEMA,
    measurementHash: HASH_SCHEMA,
    renderEvidenceHash: HASH_SCHEMA,
    reviewedRelevance: CATALOG_QUALIFICATION_RELEVANCE_VERDICT_SCHEMA,
    selectionReason: z.enum(CATALOG_QUALIFICATION_DEVELOPMENT_VALIDATOR_CASE_SELECTION_REASONS),
    proposedVerdict: CATALOG_VALIDATION_VERDICT_SCHEMA,
    validationRequest: CATALOG_SEARCH_VALIDATION_REQUEST_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    const expectedSelectionReason =
      value.reviewedRelevance === "relevant"
        ? "reviewed_relevant"
        : value.reviewedRelevance === "unknown"
          ? "reviewed_unknown"
          : "top_ranked_irrelevant";
    if (value.selectionReason !== expectedSelectionReason)
      context.addIssue({
        code: "custom",
        path: ["selectionReason"],
        message: "Validator case selection reason does not match reviewed relevance",
      });
    if (value.proposedVerdict !== validatorVerdictForRelevance(value.reviewedRelevance))
      context.addIssue({
        code: "custom",
        path: ["proposedVerdict"],
        message: "Validator verdict proposal does not match the reviewed-relevance mapping",
      });
    if (
      value.validationRequest.query.hash !== value.requestHash ||
      value.validationRequest.candidate.sourceContentHash !== value.sourceContentHash ||
      value.validationRequest.candidate.measurementHash !== value.measurementHash ||
      value.validationRequest.candidate.renderEvidenceHash !== value.renderEvidenceHash
    )
      context.addIssue({
        code: "custom",
        path: ["validationRequest"],
        message: "Validator request does not bind the case query and candidate evidence",
      });
  });

export const CATALOG_QUALIFICATION_DEVELOPMENT_VALIDATOR_CASE_SET_SCHEMA = z
  .object({
    kind: z.literal("CatalogQualificationDevelopmentValidatorCaseSet"),
    stage: z.literal("validator_case_authoring"),
    split: z.literal("development"),
    status: z.literal("pending_independent_verdict_review"),
    querySetHash: HASH_SCHEMA,
    candidatePoolHash: HASH_SCHEMA,
    relevanceDecisionHash: HASH_SCHEMA,
    measurementSetHash: HASH_SCHEMA,
    visualReviewIndexHash: HASH_SCHEMA,
    validationPromptTemplateHash: HASH_SCHEMA,
    validationSchemaHash: HASH_SCHEMA,
    preprocessingImplementationHash: HASH_SCHEMA,
    selectionPolicy: z
      .object({
        includeAllReviewedRelevant: z.literal(true),
        includeAllReviewedUnknown: z.literal(true),
        hardNegativePerAcceptedQuery: z.literal(1),
        hardNegativeSelection: z.literal(
          "best_rank_then_channel_coverage_then_rank_sum_then_source_hash",
        ),
      })
      .strict(),
    cases: z.array(DEVELOPMENT_VALIDATOR_CASE_SCHEMA).min(24),
    caseCount: z.number().int().min(24).safe(),
    proposedVerdictCounts: z
      .object({
        match: z.number().int().nonnegative(),
        mismatch: z.number().int().nonnegative(),
        uncertain: z.number().int().nonnegative(),
      })
      .strict(),
    proposedVerdictAuthority: z.literal("derived_hypothesis"),
    validatorVerdictsReviewed: z.literal(false),
    nextStage: z.literal("independent_validator_verdict_review"),
    qualificationExecutionAuthorized: z.literal(false),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(value.cases, (entry) => entry.caseId, "validator cases", context);
    if (value.validationSchemaHash !== CATALOG_VISUAL_VALIDATION_JSON_SCHEMA_HASH)
      context.addIssue({
        code: "custom",
        path: ["validationSchemaHash"],
        message: "Validator case set binds a different validation schema",
      });
    if (value.caseCount !== value.cases.length)
      context.addIssue({
        code: "custom",
        path: ["caseCount"],
        message: "Validator case count does not match its cases",
      });
    const counts = countValidatorVerdicts(value.cases.map((entry) => entry.proposedVerdict));
    if (stableJson(value.proposedVerdictCounts) !== stableJson(counts))
      context.addIssue({
        code: "custom",
        path: ["proposedVerdictCounts"],
        message: "Validator proposal counts do not match its cases",
      });
  });
export type CatalogQualificationDevelopmentValidatorCaseSet = z.output<
  typeof CATALOG_QUALIFICATION_DEVELOPMENT_VALIDATOR_CASE_SET_SCHEMA
>;

export type CatalogQualificationDevelopmentValidatorPairSelection = Readonly<{
  caseId: string;
  queryId: string;
  requestHash: string;
  sourceContentHash: string;
  measurementHash: string;
  renderEvidenceHash: string;
  reviewedRelevance: z.output<typeof CATALOG_QUALIFICATION_RELEVANCE_VERDICT_SCHEMA>;
  selectionReason: (typeof CATALOG_QUALIFICATION_DEVELOPMENT_VALIDATOR_CASE_SELECTION_REASONS)[number];
  proposedVerdict: z.output<typeof CATALOG_VALIDATION_VERDICT_SCHEMA>;
}>;

export function selectCatalogQualificationDevelopmentValidatorPairs(input: {
  readonly pool: CatalogQualificationDevelopmentCandidatePool;
  readonly relevanceDecision: CatalogQualificationDevelopmentRelevanceDecision;
}): CatalogQualificationDevelopmentValidatorPairSelection[] {
  const pool = CATALOG_QUALIFICATION_DEVELOPMENT_CANDIDATE_POOL_SCHEMA.parse(input.pool);
  const decision = CATALOG_QUALIFICATION_DEVELOPMENT_RELEVANCE_DECISION_SCHEMA.parse(
    input.relevanceDecision,
  );
  if (decision.status !== "reviewed")
    throw new Error("Validator cases require accepted development requests");
  const poolByQuery = new Map(pool.queryPools.map((entry) => [entry.queryId, entry] as const));
  const selections: CatalogQualificationDevelopmentValidatorPairSelection[] = [];
  for (const reviewed of decision.queries) {
    const queryPool = poolByQuery.get(reviewed.queryId);
    if (!queryPool || reviewed.requestDisposition !== "accepted")
      throw new Error(`Validator case selection lacks accepted query ${reviewed.queryId}`);
    const candidateBySource = new Map(
      queryPool.candidates.map((candidate) => [candidate.sourceContentHash, candidate] as const),
    );
    for (const judgment of reviewed.judgments.filter(
      (entry) => entry.verdict === "relevant" || entry.verdict === "unknown",
    ))
      selections.push(
        developmentValidatorPairSelection(
          reviewed.queryId,
          reviewed.requestHash,
          judgment,
          judgment.verdict === "relevant" ? "reviewed_relevant" : "reviewed_unknown",
        ),
      );
    const hardNegative = [...reviewed.judgments]
      .filter((entry) => entry.verdict === "irrelevant")
      .sort((left, right) =>
        compareHardNegativeCandidates(
          candidateBySource.get(left.sourceContentHash),
          candidateBySource.get(right.sourceContentHash),
        ),
      )[0];
    if (!hardNegative)
      throw new Error(`Accepted query has no reviewed hard negative: ${reviewed.queryId}`);
    selections.push(
      developmentValidatorPairSelection(
        reviewed.queryId,
        reviewed.requestHash,
        hardNegative,
        "top_ranked_irrelevant",
      ),
    );
  }
  return canonicalValues(selections, (entry) => entry.caseId, "validator pair selections");
}

export function sealCatalogQualificationDevelopmentValidatorCaseSet(
  input: Omit<
    CatalogQualificationDevelopmentValidatorCaseSet,
    | "kind"
    | "stage"
    | "split"
    | "status"
    | "selectionPolicy"
    | "caseCount"
    | "proposedVerdictCounts"
    | "proposedVerdictAuthority"
    | "validatorVerdictsReviewed"
    | "nextStage"
    | "qualificationExecutionAuthorized"
    | "hash"
  >,
): CatalogQualificationDevelopmentValidatorCaseSet {
  const cases = canonicalValues(input.cases, (entry) => entry.caseId, "validator cases");
  return sealArtifact(CATALOG_QUALIFICATION_DEVELOPMENT_VALIDATOR_CASE_SET_SCHEMA, {
    kind: "CatalogQualificationDevelopmentValidatorCaseSet" as const,
    stage: "validator_case_authoring" as const,
    split: "development" as const,
    status: "pending_independent_verdict_review" as const,
    ...input,
    selectionPolicy: {
      includeAllReviewedRelevant: true as const,
      includeAllReviewedUnknown: true as const,
      hardNegativePerAcceptedQuery: 1 as const,
      hardNegativeSelection:
        "best_rank_then_channel_coverage_then_rank_sum_then_source_hash" as const,
    },
    cases,
    caseCount: cases.length,
    proposedVerdictCounts: countValidatorVerdicts(cases.map((entry) => entry.proposedVerdict)),
    proposedVerdictAuthority: "derived_hypothesis" as const,
    validatorVerdictsReviewed: false as const,
    nextStage: "independent_validator_verdict_review" as const,
    qualificationExecutionAuthorized: false as const,
  });
}

export function requireCatalogQualificationDevelopmentValidatorCaseSet(input: {
  readonly queries: CatalogQualificationDevelopmentQuerySet;
  readonly pool: CatalogQualificationDevelopmentCandidatePool;
  readonly relevanceDecision: CatalogQualificationDevelopmentRelevanceDecision;
  readonly caseSet: CatalogQualificationDevelopmentValidatorCaseSet;
}): void {
  const queries = CATALOG_QUALIFICATION_DEVELOPMENT_QUERY_SET_SCHEMA.parse(input.queries);
  const pool = CATALOG_QUALIFICATION_DEVELOPMENT_CANDIDATE_POOL_SCHEMA.parse(input.pool);
  const relevanceDecision = CATALOG_QUALIFICATION_DEVELOPMENT_RELEVANCE_DECISION_SCHEMA.parse(
    input.relevanceDecision,
  );
  const caseSet = CATALOG_QUALIFICATION_DEVELOPMENT_VALIDATOR_CASE_SET_SCHEMA.parse(input.caseSet);
  requireCatalogQualificationDevelopmentRelevanceDecision({
    queries,
    pool,
    decision: relevanceDecision,
  });
  if (
    caseSet.querySetHash !== queries.hash ||
    caseSet.candidatePoolHash !== pool.hash ||
    caseSet.relevanceDecisionHash !== relevanceDecision.hash ||
    caseSet.measurementSetHash !== pool.measurementSetHash ||
    caseSet.visualReviewIndexHash !== pool.visualReviewIndexHash
  )
    throw new Error("Validator case set does not bind the exact reviewed development evidence");
  const queryById = new Map(queries.queries.map((entry) => [entry.queryId, entry] as const));
  const expected = selectCatalogQualificationDevelopmentValidatorPairs({
    pool,
    relevanceDecision,
  });
  if (caseSet.cases.length !== expected.length)
    throw new Error("Validator case set does not cover the deterministic development selection");
  const expectedById = new Map(expected.map((entry) => [entry.caseId, entry] as const));
  for (const actual of caseSet.cases) {
    const selected = expectedById.get(actual.caseId);
    const authored = queryById.get(actual.queryId);
    if (
      !selected ||
      !authored ||
      stableJson({
        caseId: actual.caseId,
        queryId: actual.queryId,
        requestHash: actual.requestHash,
        sourceContentHash: actual.sourceContentHash,
        measurementHash: actual.measurementHash,
        renderEvidenceHash: actual.renderEvidenceHash,
        reviewedRelevance: actual.reviewedRelevance,
        selectionReason: actual.selectionReason,
        proposedVerdict: actual.proposedVerdict,
      }) !== stableJson(selected) ||
      stableJson(actual.validationRequest.query) !== stableJson(authored.request) ||
      actual.validationRequest.promptTemplateHash !== caseSet.validationPromptTemplateHash ||
      actual.validationRequest.outputSchemaHash !== caseSet.validationSchemaHash ||
      actual.validationRequest.preprocessingImplementationHash !==
        caseSet.preprocessingImplementationHash
    )
      throw new Error(
        `Validator case is stale or outside the reviewed selection: ${actual.caseId}`,
      );
  }
}

const DEVELOPMENT_VALIDATOR_CASE_DECISION_SCHEMA = z
  .object({
    caseId: z.string().regex(/^[a-z][a-z0-9_]{0,191}$/u),
    validationRequestHash: HASH_SCHEMA,
    reviewAction: z.enum(["confirmed", "revised", "rejected"]),
    expectedVerdict: CATALOG_VALIDATION_VERDICT_SCHEMA.nullable(),
    note: z.string().trim().min(8).max(1_024).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.reviewAction === "confirmed" && value.expectedVerdict === null)
      context.addIssue({
        code: "custom",
        path: ["expectedVerdict"],
        message: "A confirmed validator case requires its expected verdict",
      });
    if (
      value.reviewAction === "revised" &&
      (value.expectedVerdict === null || (value.note?.length ?? 0) < 16)
    )
      context.addIssue({
        code: "custom",
        message:
          "A revised validator case requires a verdict and a reason of at least 16 characters",
      });
    if (
      value.reviewAction === "rejected" &&
      (value.expectedVerdict !== null || (value.note?.length ?? 0) < 16)
    )
      context.addIssue({
        code: "custom",
        message:
          "A rejected validator case requires no verdict and a reason of at least 16 characters",
      });
  });

export const CATALOG_QUALIFICATION_DEVELOPMENT_VALIDATOR_DECISION_SCHEMA = z
  .object({
    kind: z.literal("CatalogQualificationDevelopmentValidatorDecision"),
    stage: z.literal("independent_validator_verdict_review"),
    status: z.enum(["changes_requested", "reviewed"]),
    caseSetHash: HASH_SCHEMA,
    relevanceDecisionHash: HASH_SCHEMA,
    reviewer: z
      .object({
        authority: z.enum(["creator", "delegated_ai"]),
        reviewerId: z.string().trim().min(1).max(160),
      })
      .strict(),
    reviewMethod: z.literal("independent_validator_verdict_review"),
    reviewerStatement: z.string().trim().min(32).max(2_048),
    reviewedAt: z.string().datetime({ offset: true }),
    coverage: z.literal("complete"),
    cases: z.array(DEVELOPMENT_VALIDATOR_CASE_DECISION_SCHEMA).min(24),
    validatorVerdictAuthority: z.enum(["creator", "delegated_ai"]),
    nextStage: z.enum(["validator_case_reauthoring", "validator_execution"]),
    qualificationExecutionAuthorized: z.literal(false),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(
      value.cases,
      (entry) => entry.caseId,
      "validator verdict decisions",
      context,
    );
    const changesRequested = value.cases.some((entry) => entry.reviewAction === "rejected");
    if (value.status !== (changesRequested ? "changes_requested" : "reviewed"))
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Validator decision status does not match its case dispositions",
      });
    if (
      value.nextStage !== (changesRequested ? "validator_case_reauthoring" : "validator_execution")
    )
      context.addIssue({
        code: "custom",
        path: ["nextStage"],
        message: "Validator decision next stage does not match its case dispositions",
      });
    if (value.validatorVerdictAuthority !== value.reviewer.authority)
      context.addIssue({
        code: "custom",
        path: ["validatorVerdictAuthority"],
        message: "Validator verdict authority must identify the actual reviewer authority",
      });
  });
export type CatalogQualificationDevelopmentValidatorDecision = z.output<
  typeof CATALOG_QUALIFICATION_DEVELOPMENT_VALIDATOR_DECISION_SCHEMA
>;

export function sealCatalogQualificationDevelopmentValidatorDecision(
  input: Omit<
    CatalogQualificationDevelopmentValidatorDecision,
    | "kind"
    | "stage"
    | "status"
    | "validatorVerdictAuthority"
    | "nextStage"
    | "qualificationExecutionAuthorized"
    | "hash"
  >,
): CatalogQualificationDevelopmentValidatorDecision {
  const cases = canonicalValues(
    input.cases,
    (entry) => entry.caseId,
    "validator verdict decisions",
  );
  const changesRequested = cases.some((entry) => entry.reviewAction === "rejected");
  return sealArtifact(CATALOG_QUALIFICATION_DEVELOPMENT_VALIDATOR_DECISION_SCHEMA, {
    kind: "CatalogQualificationDevelopmentValidatorDecision" as const,
    stage: "independent_validator_verdict_review" as const,
    status: changesRequested ? ("changes_requested" as const) : ("reviewed" as const),
    ...input,
    cases,
    validatorVerdictAuthority: input.reviewer.authority,
    nextStage: changesRequested
      ? ("validator_case_reauthoring" as const)
      : ("validator_execution" as const),
    qualificationExecutionAuthorized: false as const,
  });
}

export function requireCatalogQualificationDevelopmentValidatorDecision(input: {
  readonly caseSet: CatalogQualificationDevelopmentValidatorCaseSet;
  readonly decision: CatalogQualificationDevelopmentValidatorDecision;
}): void {
  const caseSet = CATALOG_QUALIFICATION_DEVELOPMENT_VALIDATOR_CASE_SET_SCHEMA.parse(input.caseSet);
  const decision = CATALOG_QUALIFICATION_DEVELOPMENT_VALIDATOR_DECISION_SCHEMA.parse(
    input.decision,
  );
  if (
    decision.caseSetHash !== caseSet.hash ||
    decision.relevanceDecisionHash !== caseSet.relevanceDecisionHash ||
    decision.cases.length !== caseSet.cases.length
  )
    throw new Error("Validator decision does not bind the exact authored case set");
  const casesById = new Map(caseSet.cases.map((entry) => [entry.caseId, entry] as const));
  for (const reviewed of decision.cases) {
    const authored = casesById.get(reviewed.caseId);
    if (!authored || reviewed.validationRequestHash !== authored.validationRequest.hash)
      throw new Error(`Validator decision contains a stale case: ${reviewed.caseId}`);
    if (
      reviewed.reviewAction === "confirmed" &&
      reviewed.expectedVerdict !== authored.proposedVerdict
    )
      throw new Error(`Confirmed validator verdict differs from its proposal: ${reviewed.caseId}`);
    if (
      reviewed.reviewAction === "revised" &&
      reviewed.expectedVerdict === authored.proposedVerdict
    )
      throw new Error(`Revised validator verdict did not change its proposal: ${reviewed.caseId}`);
  }
}

const DEVELOPMENT_VALIDATOR_VERDICT_SCHEMA = z
  .object({
    caseId: z.string().regex(/^[a-z][a-z0-9_]{0,191}$/u),
    validationRequestHash: HASH_SCHEMA,
    expectedVerdict: CATALOG_VALIDATION_VERDICT_SCHEMA,
  })
  .strict();

export const CATALOG_QUALIFICATION_DEVELOPMENT_VALIDATOR_VERDICT_SET_SCHEMA = z
  .object({
    kind: z.literal("CatalogQualificationDevelopmentValidatorVerdictSet"),
    stage: z.literal("validator_verdict_finalization"),
    split: z.literal("development"),
    status: z.literal("reviewed"),
    caseSetHash: HASH_SCHEMA,
    relevanceDecisionHash: HASH_SCHEMA,
    decisionArtifactHash: HASH_SCHEMA,
    verdictAuthority: z.enum(["creator", "delegated_ai"]),
    cases: z.array(DEVELOPMENT_VALIDATOR_VERDICT_SCHEMA).min(24),
    verdictCounts: z
      .object({
        match: z.number().int().nonnegative(),
        mismatch: z.number().int().nonnegative(),
        uncertain: z.number().int().nonnegative(),
      })
      .strict(),
    nextStage: z.literal("validator_execution"),
    qualificationExecutionAuthorized: z.literal(false),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(
      value.cases,
      (entry) => entry.caseId,
      "reviewed validator verdicts",
      context,
    );
    if (
      stableJson(value.verdictCounts) !==
      stableJson(countValidatorVerdicts(value.cases.map((entry) => entry.expectedVerdict)))
    )
      context.addIssue({
        code: "custom",
        path: ["verdictCounts"],
        message: "Reviewed validator verdict counts do not match its cases",
      });
  });
export type CatalogQualificationDevelopmentValidatorVerdictSet = z.output<
  typeof CATALOG_QUALIFICATION_DEVELOPMENT_VALIDATOR_VERDICT_SET_SCHEMA
>;

export function sealReviewedCatalogQualificationDevelopmentValidatorVerdictSet(input: {
  readonly caseSet: CatalogQualificationDevelopmentValidatorCaseSet;
  readonly decision: CatalogQualificationDevelopmentValidatorDecision;
}): CatalogQualificationDevelopmentValidatorVerdictSet {
  const caseSet = CATALOG_QUALIFICATION_DEVELOPMENT_VALIDATOR_CASE_SET_SCHEMA.parse(input.caseSet);
  const decision = CATALOG_QUALIFICATION_DEVELOPMENT_VALIDATOR_DECISION_SCHEMA.parse(
    input.decision,
  );
  requireCatalogQualificationDevelopmentValidatorDecision({ caseSet, decision });
  if (decision.status !== "reviewed")
    throw new Error("Rejected validator cases must be reauthored before finalization");
  const cases = decision.cases.map((entry) => {
    if (entry.expectedVerdict === null)
      throw new Error(`Reviewed validator case lacks a verdict: ${entry.caseId}`);
    return {
      caseId: entry.caseId,
      validationRequestHash: entry.validationRequestHash,
      expectedVerdict: entry.expectedVerdict,
    };
  });
  return sealArtifact(CATALOG_QUALIFICATION_DEVELOPMENT_VALIDATOR_VERDICT_SET_SCHEMA, {
    kind: "CatalogQualificationDevelopmentValidatorVerdictSet" as const,
    stage: "validator_verdict_finalization" as const,
    split: "development" as const,
    status: "reviewed" as const,
    caseSetHash: caseSet.hash,
    relevanceDecisionHash: caseSet.relevanceDecisionHash,
    decisionArtifactHash: decision.hash,
    verdictAuthority: decision.validatorVerdictAuthority,
    cases: canonicalValues(cases, (entry) => entry.caseId, "reviewed validator verdicts"),
    verdictCounts: countValidatorVerdicts(cases.map((entry) => entry.expectedVerdict)),
    nextStage: "validator_execution" as const,
    qualificationExecutionAuthorized: false as const,
  });
}

export function requireReviewedCatalogQualificationDevelopmentValidatorVerdictSet(input: {
  readonly caseSet: CatalogQualificationDevelopmentValidatorCaseSet;
  readonly decision: CatalogQualificationDevelopmentValidatorDecision;
  readonly verdictSet: CatalogQualificationDevelopmentValidatorVerdictSet;
}): void {
  const caseSet = CATALOG_QUALIFICATION_DEVELOPMENT_VALIDATOR_CASE_SET_SCHEMA.parse(input.caseSet);
  const decision = CATALOG_QUALIFICATION_DEVELOPMENT_VALIDATOR_DECISION_SCHEMA.parse(
    input.decision,
  );
  const verdictSet = CATALOG_QUALIFICATION_DEVELOPMENT_VALIDATOR_VERDICT_SET_SCHEMA.parse(
    input.verdictSet,
  );
  requireCatalogQualificationDevelopmentValidatorDecision({ caseSet, decision });
  const expected = sealReviewedCatalogQualificationDevelopmentValidatorVerdictSet({
    caseSet,
    decision,
  });
  if (stableJson(verdictSet) !== stableJson(expected))
    throw new Error("Validator verdict set does not match the exact reviewed decision contents");
}

const DEVELOPMENT_VALIDATOR_MODEL_SCHEMA = z
  .object({
    modelId: z.string().regex(/^[a-z][a-z0-9_]{2,127}$/u),
    modelCommitHash: z.string().regex(/^[a-f0-9]{40,64}$/u),
  })
  .strict();

const DEVELOPMENT_VALIDATOR_RUN_SCHEMA = z
  .object({
    caseId: z.string().regex(/^[a-z][a-z0-9_]{0,191}$/u),
    validationRequestHash: HASH_SCHEMA,
    sourceContentHash: HASH_SCHEMA,
    expectedVerdict: CATALOG_VALIDATION_VERDICT_SCHEMA,
    validatorModelId: z.string().regex(/^[a-z][a-z0-9_]{2,127}$/u),
    validatorModelCommitHash: z.string().regex(/^[a-f0-9]{40,64}$/u),
    validationReceiptHash: HASH_SCHEMA,
    actualVerdict: CATALOG_VALIDATION_VERDICT_SCHEMA,
    gpuMilliseconds: z.number().int().nonnegative(),
  })
  .strict();

const DEVELOPMENT_VALIDATOR_CONFUSION_ROW_SCHEMA = z
  .object({
    match: z.number().int().nonnegative(),
    mismatch: z.number().int().nonnegative(),
    uncertain: z.number().int().nonnegative(),
  })
  .strict();

const DEVELOPMENT_VALIDATOR_METRICS_SCHEMA = z
  .object({
    modelId: z.string().regex(/^[a-z][a-z0-9_]{2,127}$/u),
    modelCommitHash: z.string().regex(/^[a-f0-9]{40,64}$/u),
    caseCount: z.number().int().positive(),
    exactVerdictCount: z.number().int().nonnegative(),
    exactVerdictMillionths: z.number().int().min(0).max(1_000_000),
    actualVerdictCounts: DEVELOPMENT_VALIDATOR_CONFUSION_ROW_SCHEMA,
    confusion: z
      .object({
        match: DEVELOPMENT_VALIDATOR_CONFUSION_ROW_SCHEMA,
        mismatch: DEVELOPMENT_VALIDATOR_CONFUSION_ROW_SCHEMA,
        uncertain: DEVELOPMENT_VALIDATOR_CONFUSION_ROW_SCHEMA,
      })
      .strict(),
    falseMatchCount: z.number().int().nonnegative(),
    hardNegativeFalseMatchCount: z.number().int().nonnegative(),
    reviewedUnknownFalseMatchCount: z.number().int().nonnegative(),
    gpuMilliseconds: z.number().int().nonnegative(),
  })
  .strict();

export const CATALOG_QUALIFICATION_DEVELOPMENT_VALIDATOR_COMPARISON_SCHEMA = z
  .object({
    kind: z.literal("CatalogQualificationDevelopmentValidatorComparison"),
    stage: z.literal("validator_execution"),
    split: z.literal("development"),
    status: z.literal("completed"),
    caseSetHash: HASH_SCHEMA,
    verdictSetHash: HASH_SCHEMA,
    verdictAuthority: z.enum(["creator", "delegated_ai"]),
    reviewIndependence: z.literal("same_reviewer_for_relevance_and_validator_verdicts"),
    modelDeclarationsHash: HASH_SCHEMA,
    modelRolePolicyHash: HASH_SCHEMA,
    validationPromptTemplateHash: HASH_SCHEMA,
    validationSchemaHash: HASH_SCHEMA,
    preprocessingImplementationHash: HASH_SCHEMA,
    workerImplementationHash: HASH_SCHEMA,
    models: z.array(DEVELOPMENT_VALIDATOR_MODEL_SCHEMA).min(2),
    runs: z.array(DEVELOPMENT_VALIDATOR_RUN_SCHEMA).min(48),
    metrics: z.array(DEVELOPMENT_VALIDATOR_METRICS_SCHEMA).min(2),
    promotionAuthorized: z.literal(false),
    nextStage: z.literal("independent_reaudit_or_holdout_authoring"),
    qualificationExecutionAuthorized: z.literal(false),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(value.models, (entry) => entry.modelId, "validator models", context);
    requireCanonicalValues(
      value.runs,
      (entry) => `${entry.validatorModelId}:${entry.caseId}`,
      "development validator runs",
      context,
    );
    requireCanonicalValues(
      value.metrics,
      (entry) => entry.modelId,
      "development validator metrics",
      context,
    );
  });
export type CatalogQualificationDevelopmentValidatorComparison = z.output<
  typeof CATALOG_QUALIFICATION_DEVELOPMENT_VALIDATOR_COMPARISON_SCHEMA
>;

export function sealCatalogQualificationDevelopmentValidatorComparison(input: {
  readonly caseSet: CatalogQualificationDevelopmentValidatorCaseSet;
  readonly verdictSet: CatalogQualificationDevelopmentValidatorVerdictSet;
  readonly modelDeclarationsHash: string;
  readonly modelRolePolicyHash: string;
  readonly workerImplementationHash: string;
  readonly models: readonly z.output<typeof DEVELOPMENT_VALIDATOR_MODEL_SCHEMA>[];
  readonly receipts: readonly CatalogValidationReceipt[];
}): CatalogQualificationDevelopmentValidatorComparison {
  const caseSet = CATALOG_QUALIFICATION_DEVELOPMENT_VALIDATOR_CASE_SET_SCHEMA.parse(input.caseSet);
  const verdictSet = CATALOG_QUALIFICATION_DEVELOPMENT_VALIDATOR_VERDICT_SET_SCHEMA.parse(
    input.verdictSet,
  );
  if (verdictSet.caseSetHash !== caseSet.hash || verdictSet.status !== "reviewed")
    throw new Error("Validator comparison requires the exact reviewed development verdict set");
  const models = canonicalValues(input.models, (entry) => entry.modelId, "validator models");
  if (models.length < 2) throw new Error("Validator comparison requires at least two models");
  const receipts = input.receipts.map((entry) => CATALOG_VALIDATION_RECEIPT_SCHEMA.parse(entry));
  const receiptByExecution = new Map<string, CatalogValidationReceipt>();
  for (const receipt of receipts) {
    const key = `${receipt.modelId}:${receipt.requestHash}`;
    if (receiptByExecution.has(key))
      throw new Error(`Validator comparison contains duplicate execution evidence: ${key}`);
    receiptByExecution.set(key, receipt);
  }
  const verdictByCase = new Map(verdictSet.cases.map((entry) => [entry.caseId, entry] as const));
  const runs = models.flatMap((model) =>
    caseSet.cases.map((authored) => {
      const expected = verdictByCase.get(authored.caseId);
      const receipt = receiptByExecution.get(`${model.modelId}:${authored.validationRequest.hash}`);
      if (!expected || expected.validationRequestHash !== authored.validationRequest.hash)
        throw new Error(`Validator comparison lacks a reviewed verdict for ${authored.caseId}`);
      if (
        !receipt ||
        receipt.status !== "eligible" ||
        !receipt.validation ||
        receipt.requestHash !== authored.validationRequest.hash ||
        receipt.sourceContentHash !== authored.sourceContentHash ||
        receipt.modelId !== model.modelId ||
        receipt.modelCommitHash !== model.modelCommitHash ||
        receipt.workerImplementationHash !== input.workerImplementationHash
      )
        throw new Error(
          `Validator comparison lacks exact eligible execution evidence for ${model.modelId}/${authored.caseId}`,
        );
      return {
        caseId: authored.caseId,
        validationRequestHash: authored.validationRequest.hash,
        sourceContentHash: authored.sourceContentHash,
        expectedVerdict: expected.expectedVerdict,
        validatorModelId: model.modelId,
        validatorModelCommitHash: model.modelCommitHash,
        validationReceiptHash: receipt.hash,
        actualVerdict: receipt.validation.verdict,
        gpuMilliseconds: receipt.resourceUsage.gpuMilliseconds,
      };
    }),
  );
  if (receipts.length !== runs.length)
    throw new Error(
      "Validator comparison contains execution evidence outside its exact case matrix",
    );
  const metrics = models.map((model) =>
    developmentValidatorMetrics(
      model,
      runs.filter((entry) => entry.validatorModelId === model.modelId),
      caseSet,
    ),
  );
  return sealArtifact(CATALOG_QUALIFICATION_DEVELOPMENT_VALIDATOR_COMPARISON_SCHEMA, {
    kind: "CatalogQualificationDevelopmentValidatorComparison" as const,
    stage: "validator_execution" as const,
    split: "development" as const,
    status: "completed" as const,
    caseSetHash: caseSet.hash,
    verdictSetHash: verdictSet.hash,
    verdictAuthority: verdictSet.verdictAuthority,
    reviewIndependence: "same_reviewer_for_relevance_and_validator_verdicts" as const,
    modelDeclarationsHash: input.modelDeclarationsHash,
    modelRolePolicyHash: input.modelRolePolicyHash,
    validationPromptTemplateHash: caseSet.validationPromptTemplateHash,
    validationSchemaHash: caseSet.validationSchemaHash,
    preprocessingImplementationHash: caseSet.preprocessingImplementationHash,
    workerImplementationHash: input.workerImplementationHash,
    models,
    runs: canonicalValues(
      runs,
      (entry) => `${entry.validatorModelId}:${entry.caseId}`,
      "development validator runs",
    ),
    metrics: canonicalValues(metrics, (entry) => entry.modelId, "development validator metrics"),
    promotionAuthorized: false as const,
    nextStage: "independent_reaudit_or_holdout_authoring" as const,
    qualificationExecutionAuthorized: false as const,
  });
}

export function requireCatalogQualificationDevelopmentValidatorComparison(input: {
  readonly caseSet: CatalogQualificationDevelopmentValidatorCaseSet;
  readonly verdictSet: CatalogQualificationDevelopmentValidatorVerdictSet;
  readonly comparison: CatalogQualificationDevelopmentValidatorComparison;
  readonly receipts: readonly CatalogValidationReceipt[];
}): void {
  const comparison = CATALOG_QUALIFICATION_DEVELOPMENT_VALIDATOR_COMPARISON_SCHEMA.parse(
    input.comparison,
  );
  const expected = sealCatalogQualificationDevelopmentValidatorComparison({
    caseSet: input.caseSet,
    verdictSet: input.verdictSet,
    modelDeclarationsHash: comparison.modelDeclarationsHash,
    modelRolePolicyHash: comparison.modelRolePolicyHash,
    workerImplementationHash: comparison.workerImplementationHash,
    models: comparison.models,
    receipts: input.receipts,
  });
  if (stableJson(comparison) !== stableJson(expected))
    throw new Error("Validator comparison does not match its exact reviewed labels and receipts");
}

function developmentValidatorMetrics(
  model: z.output<typeof DEVELOPMENT_VALIDATOR_MODEL_SCHEMA>,
  runs: readonly z.output<typeof DEVELOPMENT_VALIDATOR_RUN_SCHEMA>[],
  caseSet: CatalogQualificationDevelopmentValidatorCaseSet,
): z.output<typeof DEVELOPMENT_VALIDATOR_METRICS_SCHEMA> {
  const selectionByCase = new Map(
    caseSet.cases.map((entry) => [entry.caseId, entry.selectionReason] as const),
  );
  const row = () => ({ match: 0, mismatch: 0, uncertain: 0 });
  const confusion = { match: row(), mismatch: row(), uncertain: row() };
  let exactVerdictCount = 0;
  let hardNegativeFalseMatchCount = 0;
  let reviewedUnknownFalseMatchCount = 0;
  for (const run of runs) {
    confusion[run.expectedVerdict][run.actualVerdict] += 1;
    if (run.actualVerdict === run.expectedVerdict) exactVerdictCount += 1;
    if (
      run.actualVerdict === "match" &&
      selectionByCase.get(run.caseId) === "top_ranked_irrelevant"
    )
      hardNegativeFalseMatchCount += 1;
    if (run.actualVerdict === "match" && selectionByCase.get(run.caseId) === "reviewed_unknown")
      reviewedUnknownFalseMatchCount += 1;
  }
  return {
    modelId: model.modelId,
    modelCommitHash: model.modelCommitHash,
    caseCount: runs.length,
    exactVerdictCount,
    exactVerdictMillionths: Math.round((exactVerdictCount / Math.max(1, runs.length)) * 1_000_000),
    actualVerdictCounts: countValidatorVerdicts(runs.map((entry) => entry.actualVerdict)),
    confusion,
    falseMatchCount: runs.filter(
      (entry) => entry.actualVerdict === "match" && entry.expectedVerdict !== "match",
    ).length,
    hardNegativeFalseMatchCount,
    reviewedUnknownFalseMatchCount,
    gpuMilliseconds: runs.reduce((sum, entry) => sum + entry.gpuMilliseconds, 0),
  };
}

function developmentValidatorPairSelection(
  queryId: string,
  requestHash: string,
  judgment: CatalogQualificationDevelopmentRelevanceDecision["queries"][number]["judgments"][number],
  selectionReason: CatalogQualificationDevelopmentValidatorPairSelection["selectionReason"],
): CatalogQualificationDevelopmentValidatorPairSelection {
  return {
    caseId: `${queryId}_${judgment.sourceContentHash}`,
    queryId,
    requestHash,
    sourceContentHash: judgment.sourceContentHash,
    measurementHash: judgment.measurementHash,
    renderEvidenceHash: judgment.renderEvidenceHash,
    reviewedRelevance: judgment.verdict,
    selectionReason,
    proposedVerdict: validatorVerdictForRelevance(judgment.verdict),
  };
}

function compareHardNegativeCandidates(
  left:
    | CatalogQualificationDevelopmentCandidatePool["queryPools"][number]["candidates"][number]
    | undefined,
  right:
    | CatalogQualificationDevelopmentCandidatePool["queryPools"][number]["candidates"][number]
    | undefined,
): number {
  if (!left || !right) throw new Error("Reviewed judgment is absent from its candidate pool");
  const leftBestRank = Math.min(...left.retrievedBy.map((entry) => entry.rank));
  const rightBestRank = Math.min(...right.retrievedBy.map((entry) => entry.rank));
  const leftRankSum = left.retrievedBy.reduce((sum, entry) => sum + entry.rank, 0);
  const rightRankSum = right.retrievedBy.reduce((sum, entry) => sum + entry.rank, 0);
  return (
    leftBestRank - rightBestRank ||
    right.retrievedBy.length - left.retrievedBy.length ||
    leftRankSum - rightRankSum ||
    left.sourceContentHash.localeCompare(right.sourceContentHash)
  );
}

function validatorVerdictForRelevance(
  relevance: z.output<typeof CATALOG_QUALIFICATION_RELEVANCE_VERDICT_SCHEMA>,
): z.output<typeof CATALOG_VALIDATION_VERDICT_SCHEMA> {
  if (relevance === "relevant") return "match";
  if (relevance === "unknown") return "uncertain";
  return "mismatch";
}

function countValidatorVerdicts(
  verdicts: readonly z.output<typeof CATALOG_VALIDATION_VERDICT_SCHEMA>[],
): { match: number; mismatch: number; uncertain: number } {
  return {
    match: verdicts.filter((entry) => entry === "match").length,
    mismatch: verdicts.filter((entry) => entry === "mismatch").length,
    uncertain: verdicts.filter((entry) => entry === "uncertain").length,
  };
}
