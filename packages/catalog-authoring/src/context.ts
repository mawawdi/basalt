import { z } from "zod";
import { CATALOG_ASSET_ARTIFACT_SCHEMA, type CatalogAssetArtifact } from "@basalt/catalog-model";
import {
  COMPILATION_STATUS_SCHEMA,
  HASH_SCHEMA,
  compareCanonicalStrings,
  contentHash,
  dequantizeQ32_32,
  deepFreezeJson,
  stableJson,
} from "@basalt/contracts";
import {
  ASSET_METRIC_PROMPT_SUMMARY_SCHEMA,
  ASSET_SEARCH_METADATA_RECEIPT_SCHEMA,
  CATALOG_SELECTED_RGB_VIEW_SCHEMA,
  CATALOG_SOURCE_ROLE_HINT_SCHEMA,
  catalogObservation,
  metricVectorFromFixed,
  sealAssetMetricPromptSummary,
  type AssetSearchMetadataReceipt,
} from "./metadata.js";
import {
  CATALOG_SOURCE_NAME_HINT_SET_SCHEMA,
  type CatalogSourceNameHintSet,
} from "./source-name-hints.js";
import {
  canonicalValues,
  requireCanonicalValues,
  sealArtifact,
  verifyArtifactHash,
} from "./artifact.js";

const TERM_SCHEMA = z.string().trim().min(1).max(160);
const CONTEXT_GROUPING_EVIDENCE_SCHEMA = z.enum([
  "attributed_assembly",
  "basename_stem",
  "bounded_retrieval",
  "metric_interface",
]);

const CONTEXT_TRANSFORM_SCHEMA = z
  .object({
    positionMeters: z.object({ x: z.number(), y: z.number(), z: z.number() }).strict(),
    rotation: z
      .tuple([z.number(), z.number(), z.number(), z.number()])
      .refine(
        (value) => Math.abs(Math.hypot(...value) - 1) <= 1e-6,
        "Context rotations must be normalized",
      ),
    scale: z.number().finite().positive(),
  })
  .strict();

const ATTRIBUTED_ASSEMBLY_MEMBER_SCHEMA = z
  .object({
    sourceContentHash: HASH_SCHEMA,
    parentSourceContentHash: HASH_SCHEMA.optional(),
    transformMeters: CONTEXT_TRANSFORM_SCHEMA.optional(),
    authoredRoleTerms: z.array(TERM_SCHEMA).max(32),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.parentSourceContentHash === value.sourceContentHash)
      context.addIssue({
        code: "custom",
        path: ["parentSourceContentHash"],
        message: "An assembly-context member cannot parent itself",
      });
    requireCanonicalValues(value.authoredRoleTerms, String, "authored role terms", context);
  });

/** Attributed source context is evidence, never a filename or pack-level semantic shortcut. */
export const ATTRIBUTED_ASSEMBLY_CONTEXT_EVIDENCE_SCHEMA = z
  .object({
    evidenceId: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u),
    evidenceKind: z.enum([
      "authored_role_declaration",
      "demonstrated_assembly",
      "source_prefab",
      "supporting_documentation",
    ]),
    evidenceHash: HASH_SCHEMA,
    attribution: z
      .object({
        sourceKind: z.enum(["creator", "source_manifest", "vendor_document"]),
        sourceIdentityHash: HASH_SCHEMA,
      })
      .strict(),
    documentationContentHash: HASH_SCHEMA.optional(),
    members: z.array(ATTRIBUTED_ASSEMBLY_MEMBER_SCHEMA).min(1).max(256),
  })
  .strict()
  .superRefine((value, context) => {
    requireCanonicalValues(
      value.members,
      (entry) => entry.sourceContentHash,
      "attributed assembly members",
      context,
    );
    const memberIds = new Set(value.members.map((entry) => entry.sourceContentHash));
    for (const [index, member] of value.members.entries())
      if (member.parentSourceContentHash && !memberIds.has(member.parentSourceContentHash))
        context.addIssue({
          code: "custom",
          path: ["members", index, "parentSourceContentHash"],
          message: "Assembly-context parents must be present in the same evidence record",
        });
  });
export type AttributedAssemblyContextEvidence = z.output<
  typeof ATTRIBUTED_ASSEMBLY_CONTEXT_EVIDENCE_SCHEMA
>;

const PART_CONTEXT_EVIDENCE_SCHEMA = z
  .object({
    partId: z.string().trim().min(1).max(128),
    role: z.enum(["collision_proxy", "render_interactive", "render_static"]),
    boundsMeters: z
      .object({
        min: z.object({ x: z.number(), y: z.number(), z: z.number() }).strict(),
        max: z.object({ x: z.number(), y: z.number(), z: z.number() }).strict(),
      })
      .strict(),
    triangleCount: z.number().int().nonnegative(),
  })
  .strict();

const SOCKET_CONTEXT_EVIDENCE_SCHEMA = z
  .object({
    socketId: z.string().trim().min(1).max(128),
    localOriginMeters: z.object({ x: z.number(), y: z.number(), z: z.number() }).strict(),
    normal: z.object({ x: z.number(), y: z.number(), z: z.number() }).strict(),
    up: z.object({ x: z.number(), y: z.number(), z: z.number() }).strict(),
    boundaryRadiusMeters: z.number().finite().nonnegative(),
    evidenceHash: HASH_SCHEMA,
  })
  .strict();

export const ASSET_CONTEXT_CANDIDATE_SCHEMA = z
  .object({
    sourceContentHash: HASH_SCHEMA,
    measurementHash: HASH_SCHEMA,
    metricSummary: ASSET_METRIC_PROMPT_SUMMARY_SCHEMA,
    renderEvidenceHash: HASH_SCHEMA,
    contactSheetContentHash: HASH_SCHEMA,
    sourceNameHintHash: HASH_SCHEMA.optional(),
    metadataReceiptHash: HASH_SCHEMA.optional(),
    selectedRgbViews: z.array(CATALOG_SELECTED_RGB_VIEW_SCHEMA).min(4).max(12),
    parts: z.array(PART_CONTEXT_EVIDENCE_SCHEMA).max(4_096),
    sockets: z.array(SOCKET_CONTEXT_EVIDENCE_SCHEMA).max(4_096),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.metricSummary.sourceContentHash !== value.sourceContentHash ||
      value.metricSummary.measurementHash !== value.measurementHash
    )
      context.addIssue({
        code: "custom",
        path: ["metricSummary"],
        message: "Context metric summary does not bind the candidate",
      });
    requireCanonicalValues(value.parts, (entry) => entry.partId, "context parts", context);
    requireCanonicalValues(value.sockets, (entry) => entry.socketId, "context sockets", context);
    requireCanonicalValues(
      value.selectedRgbViews,
      (entry) => entry.viewId,
      "context RGB views",
      context,
    );
  });
export type AssetContextCandidate = z.output<typeof ASSET_CONTEXT_CANDIDATE_SCHEMA>;

export const ASSET_CONTEXT_HYPOTHESIS_REQUEST_SCHEMA = z
  .object({
    kind: z.literal("AssetContextHypothesisRequest"),
    groupingEvidence: z.array(CONTEXT_GROUPING_EVIDENCE_SCHEMA).min(1).max(4),
    candidates: z.array(ASSET_CONTEXT_CANDIDATE_SCHEMA).min(2).max(32),
    attributedAssemblyEvidence: z.array(ATTRIBUTED_ASSEMBLY_CONTEXT_EVIDENCE_SCHEMA).max(64),
    promptTemplateHash: HASH_SCHEMA,
    outputSchemaHash: HASH_SCHEMA,
    compilerAuthority: z.literal(false),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(value.groupingEvidence, String, "context grouping evidence", context);
    requireCanonicalValues(
      value.candidates,
      (entry) => entry.sourceContentHash,
      "context candidates",
      context,
    );
    requireCanonicalValues(
      value.attributedAssemblyEvidence,
      (entry) => entry.evidenceId,
      "attributed assembly evidence",
      context,
    );
    const candidates = new Set(value.candidates.map((entry) => entry.sourceContentHash));
    for (const evidence of value.attributedAssemblyEvidence)
      for (const member of evidence.members)
        if (!candidates.has(member.sourceContentHash))
          context.addIssue({
            code: "custom",
            path: ["attributedAssemblyEvidence"],
            message: `Assembly evidence ${evidence.evidenceId} references an asset outside the bounded candidate group`,
          });
    if (
      value.groupingEvidence.includes("attributed_assembly") !==
      value.attributedAssemblyEvidence.length > 0
    )
      context.addIssue({
        code: "custom",
        path: ["groupingEvidence"],
        message: "Attributed-assembly grouping must bind attributed assembly evidence",
      });
    if (value.outputSchemaHash !== ASSET_CONTEXT_HYPOTHESIS_JSON_SCHEMA_HASH)
      context.addIssue({
        code: "custom",
        path: ["outputSchemaHash"],
        message: "Context request binds a different output schema",
      });
  });
export type AssetContextHypothesisRequest = z.output<
  typeof ASSET_CONTEXT_HYPOTHESIS_REQUEST_SCHEMA
>;

export const ASSET_CONTEXT_PROPOSAL_GROUP_SCHEMA = z
  .object({
    kind: z.literal("AssetContextProposalGroup"),
    groupId: HASH_SCHEMA,
    groupingEvidence: z.array(CONTEXT_GROUPING_EVIDENCE_SCHEMA).min(1).max(3),
    sourceContentHashes: z.array(HASH_SCHEMA).min(2).max(32),
    compilerAuthority: z.literal(false),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(value.groupingEvidence, String, "proposal grouping evidence", context);
    requireCanonicalValues(value.sourceContentHashes, String, "proposal group sources", context);
    const expectedGroupId = contentHash(stableJson(value.sourceContentHashes));
    if (value.groupId !== expectedGroupId)
      context.addIssue({
        code: "custom",
        path: ["groupId"],
        message: "Context proposal group ID differs from its exact membership",
      });
  });
export type AssetContextProposalGroup = z.output<typeof ASSET_CONTEXT_PROPOSAL_GROUP_SCHEMA>;

export const CATALOG_CONTEXT_REQUEST_SET_SCHEMA = z
  .object({
    kind: z.literal("CatalogContextRequestSet"),
    status: COMPILATION_STATUS_SCHEMA,
    measurementSetHash: HASH_SCHEMA,
    visualReviewIndexHash: HASH_SCHEMA,
    sourceNameHintSetHash: HASH_SCHEMA,
    promptTemplateHash: HASH_SCHEMA,
    requests: z.array(ASSET_CONTEXT_HYPOTHESIS_REQUEST_SCHEMA).max(100_000),
    diagnostics: z.array(z.string().trim().min(1).max(2_048)).max(100_000),
    compilerAuthority: z.literal(false),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(value.requests, (entry) => entry.hash, "context requests", context);
    requireCanonicalValues(value.diagnostics, String, "context request diagnostics", context);
    const expected = value.diagnostics.length === 0 ? "eligible" : "incomplete";
    if (value.status !== expected)
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Context request-set status differs from its diagnostics",
      });
  });
export type CatalogContextRequestSet = z.output<typeof CATALOG_CONTEXT_REQUEST_SET_SCHEMA>;

export const CATALOG_CONTEXT_RECEIPT_SET_SCHEMA = z
  .object({
    kind: z.literal("CatalogContextReceiptSet"),
    status: COMPILATION_STATUS_SCHEMA,
    requestSetHash: HASH_SCHEMA,
    receipts: z.array(z.lazy(() => ASSET_CONTEXT_HYPOTHESIS_RECEIPT_SCHEMA)).max(100_000),
    missingRequestHashes: z.array(HASH_SCHEMA).max(100_000),
    diagnostics: z.array(z.string().trim().min(1).max(2_048)).max(100_000),
    compilerAuthority: z.literal(false),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(
      value.receipts,
      (entry) => entry.requestHash,
      "context receipts",
      context,
    );
    requireCanonicalValues(value.missingRequestHashes, String, "missing context requests", context);
    requireCanonicalValues(value.diagnostics, String, "context receipt diagnostics", context);
    const expected = value.receipts.some((entry) => entry.status === "rejected")
      ? "rejected"
      : value.missingRequestHashes.length > 0 ||
          value.receipts.some((entry) => entry.status === "incomplete")
        ? "incomplete"
        : "eligible";
    if (value.status !== expected)
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Context receipt-set status differs from its evidence",
      });
  });
export type CatalogContextReceiptSet = z.output<typeof CATALOG_CONTEXT_RECEIPT_SET_SCHEMA>;

const CONTEXT_ASSET_HYPOTHESIS_SCHEMA = z
  .object({
    sourceContentHash: HASH_SCHEMA,
    sourceRole: catalogObservation(CATALOG_SOURCE_ROLE_HINT_SCHEMA),
    componentRoleTerms: catalogObservation(z.array(TERM_SCHEMA).max(32)),
    likelyMateSourceHashes: catalogObservation(z.array(HASH_SCHEMA).max(31)),
    notes: catalogObservation(z.array(TERM_SCHEMA).max(32)),
    supportingEvidenceHashes: z.array(HASH_SCHEMA).max(64),
  })
  .strict()
  .superRefine((value, context) => {
    for (const observation of [value.componentRoleTerms, value.likelyMateSourceHashes, value.notes])
      if (observation.status === "observed")
        requireCanonicalValues(observation.value, String, "context hypothesis values", context);
    requireCanonicalValues(
      value.supportingEvidenceHashes,
      String,
      "context hypothesis evidence",
      context,
    );
    const hasObservedClaim = [
      value.sourceRole,
      value.componentRoleTerms,
      value.likelyMateSourceHashes,
      value.notes,
    ].some((entry) => entry.status === "observed");
    if (hasObservedClaim && value.supportingEvidenceHashes.length === 0)
      context.addIssue({
        code: "custom",
        path: ["supportingEvidenceHashes"],
        message: "Observed context claims require attributed or measured evidence",
      });
  });

const CONTEXT_RELATION_SCHEMA = z
  .object({
    kind: z.enum(["collision_companion_of", "mates_with", "part_of", "visual_alternative_to"]),
    subjectSourceContentHash: HASH_SCHEMA,
    objectSourceContentHash: HASH_SCHEMA,
    rationale: z.string().trim().min(1).max(512),
    supportingEvidenceHashes: z.array(HASH_SCHEMA).min(1).max(64),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.subjectSourceContentHash === value.objectSourceContentHash)
      context.addIssue({ code: "custom", message: "Context relations require distinct assets" });
    requireCanonicalValues(
      value.supportingEvidenceHashes,
      String,
      "context relation evidence",
      context,
    );
  });

export const ASSET_CONTEXT_HYPOTHESIS_OUTPUT_SCHEMA = z
  .object({
    assets: z.array(CONTEXT_ASSET_HYPOTHESIS_SCHEMA).min(2).max(32),
    relations: z.array(CONTEXT_RELATION_SCHEMA).max(496),
    groupNotes: catalogObservation(z.array(TERM_SCHEMA).max(64)),
  })
  .strict()
  .superRefine((value, context) => {
    requireCanonicalValues(
      value.assets,
      (entry) => entry.sourceContentHash,
      "context asset hypotheses",
      context,
    );
    requireCanonicalValues(
      value.relations,
      (entry) => `${entry.kind}:${entry.subjectSourceContentHash}:${entry.objectSourceContentHash}`,
      "context relations",
      context,
    );
    if (value.groupNotes.status === "observed")
      requireCanonicalValues(value.groupNotes.value, String, "context group notes", context);
  });

export const ASSET_CONTEXT_HYPOTHESIS_JSON_SCHEMA = deepFreezeJson(
  z.toJSONSchema(ASSET_CONTEXT_HYPOTHESIS_OUTPUT_SCHEMA, { target: "draft-7" }),
);
export const ASSET_CONTEXT_HYPOTHESIS_JSON_SCHEMA_HASH = contentHash(
  stableJson(ASSET_CONTEXT_HYPOTHESIS_JSON_SCHEMA),
);

export const ASSET_CONTEXT_HYPOTHESIS_RECEIPT_SCHEMA = z
  .object({
    kind: z.literal("AssetContextHypothesisReceipt"),
    status: COMPILATION_STATUS_SCHEMA,
    requestHash: HASH_SCHEMA,
    adapterId: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u),
    adapterImplementationHash: HASH_SCHEMA,
    workerImplementationHash: HASH_SCHEMA,
    runtimeImplementationHash: HASH_SCHEMA,
    modelId: z.string().trim().min(1).max(256),
    modelCommitHash: z.string().regex(/^[a-f0-9]{40,64}$/u),
    promptHash: HASH_SCHEMA,
    rawOutputHash: HASH_SCHEMA.optional(),
    hypothesis: ASSET_CONTEXT_HYPOTHESIS_OUTPUT_SCHEMA.optional(),
    diagnostics: z.array(z.string().trim().min(1).max(2_048)).max(256),
    resourceUsage: z
      .object({
        inputImageCount: z.number().int().nonnegative().max(32),
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
    requireCanonicalValues(value.diagnostics, String, "context diagnostics", context);
    if (value.status === "eligible" && (!value.hypothesis || value.diagnostics.length > 0))
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Eligible context receipts require one hypothesis and no diagnostics",
      });
    if (value.status !== "eligible" && (value.hypothesis || value.diagnostics.length === 0))
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Failed context receipts require diagnostics and no hypothesis",
      });
  });
export type AssetContextHypothesisReceipt = z.output<
  typeof ASSET_CONTEXT_HYPOTHESIS_RECEIPT_SCHEMA
>;

export const CONSTRUCTION_ELIGIBILITY_ASSESSMENT_SCHEMA = z
  .object({
    kind: z.literal("ConstructionEligibilityAssessment"),
    status: COMPILATION_STATUS_SCHEMA,
    sourceContentHash: HASH_SCHEMA,
    measurementHash: HASH_SCHEMA,
    metadataReceiptHash: HASH_SCHEMA.optional(),
    contextReceiptHash: HASH_SCHEMA.optional(),
    candidateKind: z
      .enum([
        "aggregate_candidate",
        "attachment_candidate",
        "collision_evidence_candidate",
        "component_candidate",
        "environment_candidate",
        "route_component_candidate",
        "standalone_candidate",
      ])
      .optional(),
    reasons: z.array(z.string().trim().min(1).max(512)).min(1).max(64),
    compilerAuthority: z.literal(false),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(value.reasons, String, "construction eligibility reasons", context);
    if ((value.status === "eligible") !== (value.candidateKind !== undefined))
      context.addIssue({
        code: "custom",
        path: ["candidateKind"],
        message: "Only eligible construction assessments expose a candidate kind",
      });
  });
export type ConstructionEligibilityAssessment = z.output<
  typeof CONSTRUCTION_ELIGIBILITY_ASSESSMENT_SCHEMA
>;

export const CONSTRUCTION_ELIGIBILITY_SET_SCHEMA = z
  .object({
    kind: z.literal("ConstructionEligibilitySet"),
    status: COMPILATION_STATUS_SCHEMA,
    measurementSetHash: HASH_SCHEMA,
    metadataSetHash: HASH_SCHEMA.optional(),
    contextReceiptSetHash: HASH_SCHEMA.optional(),
    assessments: z.array(CONSTRUCTION_ELIGIBILITY_ASSESSMENT_SCHEMA).max(100_000),
    diagnostics: z.array(z.string().trim().min(1).max(2_048)).max(100_000),
    compilerAuthority: z.literal(false),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(
      value.assessments,
      (entry) => entry.sourceContentHash,
      "construction eligibility assessments",
      context,
    );
    requireCanonicalValues(
      value.diagnostics,
      String,
      "construction eligibility diagnostics",
      context,
    );
    const expected = value.assessments.some((entry) => entry.status === "rejected")
      ? "rejected"
      : value.diagnostics.length > 0 ||
          value.assessments.some((entry) => entry.status === "incomplete")
        ? "incomplete"
        : "eligible";
    if (value.status !== expected)
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Construction eligibility-set status differs from its assessments",
      });
  });
export type ConstructionEligibilitySet = z.output<typeof CONSTRUCTION_ELIGIBILITY_SET_SCHEMA>;

export function createAssetContextCandidate(input: {
  readonly asset: CatalogAssetArtifact;
  readonly renderEvidenceHash: string;
  readonly contactSheetContentHash: string;
  readonly selectedRgbViews: AssetContextCandidate["selectedRgbViews"];
  readonly sourceNameHintHash?: string;
  readonly metadataReceiptHash?: string;
}): AssetContextCandidate {
  const asset = CATALOG_ASSET_ARTIFACT_SCHEMA.parse(input.asset);
  return ASSET_CONTEXT_CANDIDATE_SCHEMA.parse({
    sourceContentHash: asset.source.contentHash,
    measurementHash: asset.hash,
    metricSummary: sealAssetMetricPromptSummary(asset),
    renderEvidenceHash: input.renderEvidenceHash,
    contactSheetContentHash: input.contactSheetContentHash,
    ...(input.sourceNameHintHash ? { sourceNameHintHash: input.sourceNameHintHash } : {}),
    ...(input.metadataReceiptHash ? { metadataReceiptHash: input.metadataReceiptHash } : {}),
    selectedRgbViews: canonicalValues(
      input.selectedRgbViews,
      (entry) => entry.viewId,
      "context RGB views",
    ),
    parts: asset.parts
      .map((part) => ({
        partId: part.partId,
        role: part.role,
        boundsMeters: {
          min: metricVectorFromFixed(part.bounds.min),
          max: metricVectorFromFixed(part.bounds.max),
        },
        triangleCount: part.triangleCount,
      }))
      .sort((left, right) => compareCanonicalStrings(left.partId, right.partId)),
    sockets: asset.sockets
      .map((socket) => ({
        socketId: socket.socketId,
        localOriginMeters: metricVectorFromFixed(socket.localOriginMeters),
        normal: metricVectorFromFixed(socket.normal),
        up: metricVectorFromFixed(socket.up),
        boundaryRadiusMeters: dequantizeQ32_32(socket.boundaryRadiusMeters),
        evidenceHash: socket.evidenceHash,
      }))
      .sort((left, right) => compareCanonicalStrings(left.socketId, right.socketId)),
  });
}

export function sealAssetContextHypothesisRequest(
  input: Omit<
    AssetContextHypothesisRequest,
    "kind" | "outputSchemaHash" | "compilerAuthority" | "hash"
  >,
): AssetContextHypothesisRequest {
  return sealArtifact(ASSET_CONTEXT_HYPOTHESIS_REQUEST_SCHEMA, {
    kind: "AssetContextHypothesisRequest" as const,
    ...input,
    groupingEvidence: canonicalValues(input.groupingEvidence, String, "context grouping evidence"),
    candidates: canonicalValues(
      input.candidates,
      (entry) => entry.sourceContentHash,
      "context candidates",
    ),
    attributedAssemblyEvidence: canonicalValues(
      input.attributedAssemblyEvidence,
      (entry) => entry.evidenceId,
      "attributed assembly evidence",
    ),
    outputSchemaHash: ASSET_CONTEXT_HYPOTHESIS_JSON_SCHEMA_HASH,
    compilerAuthority: false as const,
  });
}

export function sealAssetContextHypothesisReceipt(
  input: Omit<AssetContextHypothesisReceipt, "kind" | "compilerAuthority" | "hash">,
): AssetContextHypothesisReceipt {
  const hypothesis = input.hypothesis
    ? ASSET_CONTEXT_HYPOTHESIS_OUTPUT_SCHEMA.parse({
        ...input.hypothesis,
        assets: canonicalValues(
          input.hypothesis.assets.map((entry) => ({
            ...entry,
            supportingEvidenceHashes: canonicalValues(
              entry.supportingEvidenceHashes,
              String,
              "context hypothesis evidence",
            ),
          })),
          (entry) => entry.sourceContentHash,
          "context asset hypotheses",
        ),
        relations: canonicalValues(
          input.hypothesis.relations.map((entry) => ({
            ...entry,
            supportingEvidenceHashes: canonicalValues(
              entry.supportingEvidenceHashes,
              String,
              "context relation evidence",
            ),
          })),
          (entry) =>
            `${entry.kind}:${entry.subjectSourceContentHash}:${entry.objectSourceContentHash}`,
          "context relations",
        ),
      })
    : undefined;
  return sealArtifact(ASSET_CONTEXT_HYPOTHESIS_RECEIPT_SCHEMA, {
    kind: "AssetContextHypothesisReceipt" as const,
    ...input,
    ...(hypothesis ? { hypothesis } : {}),
    diagnostics: canonicalValues(input.diagnostics, String, "context diagnostics"),
    compilerAuthority: false as const,
  });
}

export function proposeAssetContextGroups(input: {
  readonly candidates: readonly AssetContextCandidate[];
  readonly sourceNames: CatalogSourceNameHintSet;
  readonly retrievalNeighbors?: readonly {
    readonly sourceContentHash: string;
    readonly neighborSourceContentHashes: readonly string[];
  }[];
}): readonly AssetContextProposalGroup[] {
  const candidates = canonicalValues(
    input.candidates.map((entry) => ASSET_CONTEXT_CANDIDATE_SCHEMA.parse(entry)),
    (entry) => entry.sourceContentHash,
    "context grouping candidates",
  );
  const candidateBySource = new Map(
    candidates.map((entry) => [entry.sourceContentHash, entry] as const),
  );
  const sourceNames = CATALOG_SOURCE_NAME_HINT_SET_SCHEMA.parse(input.sourceNames);
  const buckets = new Map<
    string,
    { sources: Set<string>; evidence: Set<z.output<typeof CONTEXT_GROUPING_EVIDENCE_SCHEMA>> }
  >();
  for (const hint of sourceNames.items) {
    if (!candidateBySource.has(hint.sourceContentHash)) continue;
    for (const observation of hint.observations) {
      const key = contextStemKey(observation.tokens);
      if (!key) continue;
      const bucket = buckets.get(`name:${key}`) ?? {
        sources: new Set<string>(),
        evidence: new Set<z.output<typeof CONTEXT_GROUPING_EVIDENCE_SCHEMA>>(),
      };
      bucket.sources.add(hint.sourceContentHash);
      bucket.evidence.add("basename_stem");
      buckets.set(`name:${key}`, bucket);
    }
  }
  for (const relation of input.retrievalNeighbors ?? []) {
    if (!candidateBySource.has(relation.sourceContentHash)) continue;
    const neighbors = canonicalValues(
      relation.neighborSourceContentHashes.filter(
        (entry) => entry !== relation.sourceContentHash && candidateBySource.has(entry),
      ),
      String,
      "context retrieval neighbors",
    ).slice(0, 31);
    if (neighbors.length === 0) continue;
    const sources = canonicalValues(
      [relation.sourceContentHash, ...neighbors],
      String,
      "context retrieval group",
    );
    buckets.set(`retrieval:${contentHash(stableJson(sources))}`, {
      sources: new Set(sources),
      evidence: new Set(["bounded_retrieval"]),
    });
  }
  const unique = new Map<string, AssetContextProposalGroup>();
  for (const bucket of buckets.values()) {
    const sources = [...bucket.sources].sort(compareCanonicalStrings);
    if (sources.length < 2) continue;
    for (let offset = 0; offset < sources.length; offset += 32) {
      const bounded = sources.slice(offset, offset + 32);
      if (bounded.length < 2) continue;
      if (contextGroupHasMetricOrInterfaceEvidence(bounded, candidateBySource))
        bucket.evidence.add("metric_interface");
      const groupId = contentHash(stableJson(bounded));
      const group = sealArtifact(ASSET_CONTEXT_PROPOSAL_GROUP_SCHEMA, {
        kind: "AssetContextProposalGroup" as const,
        groupId,
        groupingEvidence: canonicalValues(
          [...bucket.evidence],
          String,
          "proposal grouping evidence",
        ),
        sourceContentHashes: bounded,
        compilerAuthority: false as const,
      });
      unique.set(groupId, group);
    }
  }
  return [...unique.values()].sort((left, right) =>
    compareCanonicalStrings(left.groupId, right.groupId),
  );
}

export function sealCatalogContextRequestSet(input: {
  readonly measurementSetHash: string;
  readonly visualReviewIndexHash: string;
  readonly sourceNameHintSetHash: string;
  readonly promptTemplateHash: string;
  readonly requests: readonly AssetContextHypothesisRequest[];
  readonly diagnostics?: readonly string[];
}): CatalogContextRequestSet {
  const diagnostics = canonicalValues(
    input.diagnostics ?? [],
    String,
    "context request diagnostics",
  );
  return sealArtifact(CATALOG_CONTEXT_REQUEST_SET_SCHEMA, {
    kind: "CatalogContextRequestSet" as const,
    status: diagnostics.length === 0 ? ("eligible" as const) : ("incomplete" as const),
    measurementSetHash: input.measurementSetHash,
    visualReviewIndexHash: input.visualReviewIndexHash,
    sourceNameHintSetHash: input.sourceNameHintSetHash,
    promptTemplateHash: input.promptTemplateHash,
    requests: canonicalValues(input.requests, (entry) => entry.hash, "context requests"),
    diagnostics,
    compilerAuthority: false as const,
  });
}

export function sealCatalogContextReceiptSet(input: {
  readonly requestSet: CatalogContextRequestSet;
  readonly receipts: readonly AssetContextHypothesisReceipt[];
  readonly diagnostics?: readonly string[];
}): CatalogContextReceiptSet {
  const requestSet = CATALOG_CONTEXT_REQUEST_SET_SCHEMA.parse(input.requestSet);
  const receipts = canonicalValues(
    input.receipts,
    (entry) => entry.requestHash,
    "context receipts",
  );
  const present = new Set(receipts.map((entry) => entry.requestHash));
  const requestByHash = new Map(requestSet.requests.map((entry) => [entry.hash, entry] as const));
  for (const receipt of receipts) {
    const request = requestByHash.get(receipt.requestHash);
    if (!request) throw new Error(`Context receipt binds unknown request ${receipt.requestHash}`);
    if (receipt.status === "eligible" && !contextReceiptMatchesRequest(request, receipt))
      throw new Error(
        `Context receipt contains claims outside request evidence ${receipt.requestHash}`,
      );
  }
  const missingRequestHashes = requestSet.requests
    .map((entry) => entry.hash)
    .filter((entry) => !present.has(entry));
  const diagnostics = canonicalValues(
    [
      ...(input.diagnostics ?? []),
      ...(missingRequestHashes.length > 0
        ? [`${missingRequestHashes.length} context requests have no receipt`]
        : []),
    ],
    String,
    "context receipt diagnostics",
  );
  const status = receipts.some((entry) => entry.status === "rejected")
    ? ("rejected" as const)
    : missingRequestHashes.length > 0 || receipts.some((entry) => entry.status === "incomplete")
      ? ("incomplete" as const)
      : ("eligible" as const);
  return sealArtifact(CATALOG_CONTEXT_RECEIPT_SET_SCHEMA, {
    kind: "CatalogContextReceiptSet" as const,
    status,
    requestSetHash: requestSet.hash,
    receipts,
    missingRequestHashes,
    diagnostics,
    compilerAuthority: false as const,
  });
}

export function contextReceiptMatchesRequest(
  requestInput: AssetContextHypothesisRequest,
  receiptInput: AssetContextHypothesisReceipt,
): boolean {
  const request = ASSET_CONTEXT_HYPOTHESIS_REQUEST_SCHEMA.parse(requestInput);
  const receipt = ASSET_CONTEXT_HYPOTHESIS_RECEIPT_SCHEMA.parse(receiptInput);
  if (receipt.requestHash !== request.hash || !receipt.hypothesis) return false;
  const candidates = new Set(request.candidates.map((entry) => entry.sourceContentHash));
  const evidence = new Set([
    ...request.candidates.flatMap((entry) => [
      entry.sourceContentHash,
      entry.measurementHash,
      entry.renderEvidenceHash,
      entry.contactSheetContentHash,
      ...entry.sockets.map((socket) => socket.evidenceHash),
    ]),
    ...request.attributedAssemblyEvidence.flatMap((entry) => [
      entry.evidenceHash,
      entry.attribution.sourceIdentityHash,
      ...(entry.documentationContentHash ? [entry.documentationContentHash] : []),
    ]),
  ]);
  if (receipt.hypothesis.assets.some((entry) => !candidates.has(entry.sourceContentHash)))
    return false;
  if (
    receipt.hypothesis.relations.some(
      (entry) =>
        !candidates.has(entry.subjectSourceContentHash) ||
        !candidates.has(entry.objectSourceContentHash),
    )
  )
    return false;
  return [...receipt.hypothesis.assets, ...receipt.hypothesis.relations].every((entry) =>
    entry.supportingEvidenceHashes.every((hash) => evidence.has(hash)),
  );
}

export function assessConstructionEligibility(input: {
  readonly asset: CatalogAssetArtifact;
  readonly metadata?: AssetSearchMetadataReceipt;
  readonly context?: AssetContextHypothesisReceipt;
}): ConstructionEligibilityAssessment {
  const asset = CATALOG_ASSET_ARTIFACT_SCHEMA.parse(input.asset);
  const metadata = input.metadata
    ? ASSET_SEARCH_METADATA_RECEIPT_SCHEMA.parse(input.metadata)
    : undefined;
  const context = input.context
    ? ASSET_CONTEXT_HYPOTHESIS_RECEIPT_SCHEMA.parse(input.context)
    : undefined;
  if (metadata && metadata.sourceContentHash !== asset.source.contentHash)
    return sealAssessment(asset, metadata, context, "rejected", undefined, [
      "metadata binds another source",
    ]);
  const contextual = context?.hypothesis?.assets.find(
    (entry) => entry.sourceContentHash === asset.source.contentHash,
  );
  const role =
    contextual?.sourceRole.status === "observed"
      ? contextual.sourceRole.value
      : metadata?.metadata?.sourceRoleHint.status === "observed"
        ? metadata.metadata.sourceRoleHint.value
        : undefined;
  const composition =
    metadata?.metadata?.visualComposition.status === "observed"
      ? metadata.metadata.visualComposition.value
      : undefined;
  const visibleDamage =
    metadata?.metadata?.visibleDamage.status === "observed"
      ? metadata.metadata.visibleDamage.value
      : undefined;
  if (visibleDamage === "visibly_damaged")
    return sealAssessment(asset, metadata, context, "incomplete", undefined, [
      "visual evidence identifies damage that requires an authored suitability decision",
    ]);
  if (!role && !composition)
    return sealAssessment(asset, metadata, context, "incomplete", undefined, [
      "source role and visual composition are unresolved",
    ]);
  const candidateKind =
    composition === "collision_proxy_like"
      ? "collision_evidence_candidate"
      : composition === "multi_object_aggregate"
        ? "aggregate_candidate"
        : role === "assembly_component"
          ? "component_candidate"
          : role === "attachment"
            ? "attachment_candidate"
            : role === "route_component"
              ? "route_component_candidate"
              : role === "environment_realizer"
                ? "environment_candidate"
                : role === "standalone"
                  ? "standalone_candidate"
                  : undefined;
  return candidateKind
    ? sealAssessment(asset, metadata, context, "eligible", candidateKind, [
        "measured and hypothesis evidence supports bounded author review",
      ])
    : sealAssessment(asset, metadata, context, "incomplete", undefined, [
        "candidate kind remains ambiguous",
      ]);
}

export function sealConstructionEligibilitySet(input: {
  readonly measurementSetHash: string;
  readonly metadataSetHash?: string;
  readonly contextReceiptSetHash?: string;
  readonly assessments: readonly ConstructionEligibilityAssessment[];
  readonly diagnostics?: readonly string[];
}): ConstructionEligibilitySet {
  const assessments = canonicalValues(
    input.assessments,
    (entry) => entry.sourceContentHash,
    "construction eligibility assessments",
  );
  const diagnostics = canonicalValues(
    input.diagnostics ?? [],
    String,
    "construction eligibility diagnostics",
  );
  const status = assessments.some((entry) => entry.status === "rejected")
    ? ("rejected" as const)
    : diagnostics.length > 0 || assessments.some((entry) => entry.status === "incomplete")
      ? ("incomplete" as const)
      : ("eligible" as const);
  return sealArtifact(CONSTRUCTION_ELIGIBILITY_SET_SCHEMA, {
    kind: "ConstructionEligibilitySet" as const,
    status,
    measurementSetHash: input.measurementSetHash,
    ...(input.metadataSetHash ? { metadataSetHash: input.metadataSetHash } : {}),
    ...(input.contextReceiptSetHash ? { contextReceiptSetHash: input.contextReceiptSetHash } : {}),
    assessments,
    diagnostics,
    compilerAuthority: false as const,
  });
}

function sealAssessment(
  asset: CatalogAssetArtifact,
  metadata: AssetSearchMetadataReceipt | undefined,
  context: AssetContextHypothesisReceipt | undefined,
  status: "eligible" | "incomplete" | "rejected",
  candidateKind: ConstructionEligibilityAssessment["candidateKind"],
  reasons: readonly string[],
): ConstructionEligibilityAssessment {
  return sealArtifact(CONSTRUCTION_ELIGIBILITY_ASSESSMENT_SCHEMA, {
    kind: "ConstructionEligibilityAssessment" as const,
    status,
    sourceContentHash: asset.source.contentHash,
    measurementHash: asset.hash,
    ...(metadata ? { metadataReceiptHash: metadata.hash } : {}),
    ...(context ? { contextReceiptHash: context.hash } : {}),
    ...(candidateKind ? { candidateKind } : {}),
    reasons: canonicalValues(reasons, String, "construction eligibility reasons"),
    compilerAuthority: false as const,
  });
}

function contextStemKey(tokens: readonly string[]): string | undefined {
  const ignored = new Set(["asset", "fbx", "glb", "low", "mesh", "model", "poly", "prop", "sm"]);
  const meaningful = tokens.filter((entry) => !ignored.has(entry) && !/^[0-9]+$/u.test(entry));
  if (meaningful.length === 0) return undefined;
  return meaningful.slice(0, Math.min(3, meaningful.length)).join("_");
}

function contextGroupHasMetricOrInterfaceEvidence(
  sourceHashes: readonly string[],
  candidates: ReadonlyMap<string, AssetContextCandidate>,
): boolean {
  const selected = sourceHashes.map((entry) => candidates.get(entry)!);
  if (selected.some((entry) => entry.sockets.length > 0)) return true;
  const longest = selected.map((entry) =>
    Math.max(
      entry.metricSummary.sizeMeters.x,
      entry.metricSummary.sizeMeters.y,
      entry.metricSummary.sizeMeters.z,
    ),
  );
  const positive = longest.filter((entry) => entry > 0);
  return positive.length === longest.length && Math.max(...positive) / Math.min(...positive) <= 20;
}
