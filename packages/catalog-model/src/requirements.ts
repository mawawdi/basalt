import { z } from "zod";
import {
  COMPILATION_STATUS_SCHEMA,
  HASH_SCHEMA,
  compareCanonicalStrings,
  contentAddressedEntityId,
  contentHash,
  deepFreezeJson,
  stableJson,
} from "@basalt/contracts";
import {
  SEMANTIC_REQUIREMENT_SCHEMA,
  createSemanticDependencyClosure,
  evidenceSatisfies,
  semanticAncestorDistance,
  type SemanticModule,
} from "@basalt/semantic-kernel";
import {
  CATALOG_ENTRY_KIND_SCHEMA,
  ENTRY_HANDLE_SCHEMA,
  INTERFACE_ID_SCHEMA,
  POSITIVE_Q32_SCHEMA,
  STYLE_PROFILE_HANDLE_SCHEMA,
  SUPPORT_MODE_SCHEMA,
} from "./primitives.js";
import type { CatalogSnapshot, SealedRuntimeCatalogEntry } from "./entries.js";

export const CATALOG_REQUIREMENT_SCHEMA = z
  .object({
    requirementId: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u),
    allowedEntryHandles: z.array(ENTRY_HANDLE_SCHEMA).min(1).max(128).optional(),
    semantic: SEMANTIC_REQUIREMENT_SCHEMA,
    acceptedEntryKinds: z
      .array(CATALOG_ENTRY_KIND_SCHEMA.exclude(["collection"]))
      .min(1)
      .max(5),
    styleProfileHandles: z.array(STYLE_PROFILE_HANDLE_SCHEMA).max(32),
    placement: z
      .object({
        requiredSupport: SUPPORT_MODE_SCHEMA.optional(),
        requiredInterfaceIds: z.array(INTERFACE_ID_SCHEMA).max(128),
      })
      .strict(),
    metricBounds: z
      .object({
        maximumSizeMeters: z
          .object({ x: POSITIVE_Q32_SCHEMA, y: POSITIVE_Q32_SCHEMA, z: POSITIVE_Q32_SCHEMA })
          .strict()
          .optional(),
      })
      .strict(),
    rights: z
      .object({ commercialUseRequired: z.boolean(), redistributionRequired: z.boolean() })
      .strict(),
    budget: z
      .object({
        maximumTriangles: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        maximumSourceBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        maximumInstances: z.number().int().positive().max(1_000_000),
      })
      .strict(),
    required: z.boolean(),
  })
  .strict();
export type CatalogRequirement = z.output<typeof CATALOG_REQUIREMENT_SCHEMA>;

const intentBase = {
  intentId: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u),
  requirementId: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u),
  priority: z.number().int().min(-1_000_000).max(1_000_000),
};
const point2 = z.object({ u: z.number().finite(), v: z.number().finite() }).strict();
const count = z.number().int().positive().max(65_536);

export const REALIZATION_INTENT_SCHEMA = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("single"),
        ...intentBase,
        regionId: z.string().min(1).max(64),
        surfaceId: z.string().min(1).max(64),
        at: point2,
        yawDegrees: z.number().finite().min(0).lt(360).optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("surface_scatter"),
        ...intentBase,
        regionId: z.string().min(1).max(64),
        surfaceId: z.string().min(1).max(64),
        boundary: z.array(point2).min(3).max(512),
        minimumCount: z.number().int().nonnegative(),
        targetCount: count,
        minimumSeparationMeters: z.number().finite().nonnegative(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("cluster"),
        ...intentBase,
        regionId: z.string().min(1).max(64),
        surfaceId: z.string().min(1).max(64),
        center: point2,
        radiusMeters: z.number().finite().positive(),
        minimumCount: z.number().int().nonnegative(),
        targetCount: count,
        minimumSeparationMeters: z.number().finite().nonnegative(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("along_route"),
        ...intentBase,
        regionId: z.string().min(1).max(64),
        routeId: z.string().min(1).max(64),
        count,
        lateralOffsetMeters: z.number().finite(),
        minimumSeparationMeters: z.number().finite().nonnegative(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("surface_grid"),
        ...intentBase,
        regionId: z.string().min(1).max(64),
        surfaceId: z.string().min(1).max(64),
        origin: point2,
        columns: z.number().int().positive().max(4096),
        rows: z.number().int().positive().max(4096),
        spacingUMeters: z.number().finite().positive(),
        spacingVMeters: z.number().finite().positive(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("socket_attachment"),
        ...intentBase,
        host: z
          .object({ instanceId: z.string().min(1).max(64), socketId: z.string().min(1).max(128) })
          .strict(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("wall_attachment"),
        ...intentBase,
        regionId: z.string().min(1).max(64),
        surfaceId: z.string().min(1).max(64),
        at: point2,
        normalOffsetMeters: z.number().finite(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("route_network"),
        ...intentBase,
        routeIds: z.array(z.string().min(1).max(64)).min(1).max(4096),
      })
      .strict(),
    z
      .object({
        kind: z.literal("assembly"),
        ...intentBase,
        regionId: z.string().min(1).max(64),
        lotPolicyId: z.string().min(1).max(64),
        programId: z.string().min(1).max(64),
      })
      .strict(),
    z
      .object({
        kind: z.literal("environment_layer"),
        ...intentBase,
        regionIds: z.array(z.string().min(1).max(64)).min(1).max(256),
        mode: z.enum(["sky", "atmosphere", "water_surface", "overhead", "far_field"]),
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    if (
      (value.kind === "surface_scatter" || value.kind === "cluster") &&
      value.minimumCount > value.targetCount
    )
      context.addIssue({
        code: "custom",
        path: ["minimumCount"],
        message: "Minimum count cannot exceed target count",
      });
    if (value.kind === "surface_scatter") {
      const area =
        value.boundary.reduce((sum, point, index) => {
          const next = value.boundary[(index + 1) % value.boundary.length]!;
          return sum + point.u * next.v - next.u * point.v;
        }, 0) / 2;
      if (Math.abs(area) <= 1e-9)
        context.addIssue({
          code: "custom",
          path: ["boundary"],
          message: "Scatter boundary has zero area",
        });
    }
  });
export type RealizationIntent = z.output<typeof REALIZATION_INTENT_SCHEMA>;

const rejectedMemberSchema = z
  .object({
    memberId: z.string().min(1).max(128),
    reasons: z.array(z.string().min(1).max(256)).min(1).max(16),
  })
  .strict();
const rejectedCandidateSchema = z
  .object({
    entryHandle: ENTRY_HANDLE_SCHEMA,
    reasons: z.array(z.string().min(1).max(256)).min(1).max(32),
    rejectedMembers: z.array(rejectedMemberSchema).max(4096),
  })
  .strict();
const rankedCandidateSchema = z
  .object({
    entryHandle: ENTRY_HANDLE_SCHEMA,
    entryHash: HASH_SCHEMA,
    semanticAncestorDistance: z.number().int().nonnegative(),
    stylePreferenceRank: z.number().int().nonnegative(),
    boundsSlackQ32: z.string().regex(/^[0-9]+$/u),
    triangleCount: z.number().int().nonnegative(),
    sourceBytes: z.number().int().nonnegative(),
    eligibleMemberIds: z.array(z.string().min(1).max(128)).max(4096),
    rejectedMembers: z.array(rejectedMemberSchema).max(4096),
    rank: z.number().int().nonnegative(),
  })
  .strict();

export const RESOLVED_CATALOG_BINDING_SCHEMA = z
  .object({
    requirementId: z.string().min(1).max(64),
    requirementHash: HASH_SCHEMA,
    semanticDependencyClosureHash: HASH_SCHEMA,
    catalogSnapshotHash: HASH_SCHEMA,
    entryHandle: ENTRY_HANDLE_SCHEMA,
    entryHash: HASH_SCHEMA,
    memberId: z.string().min(1).max(128).optional(),
    assetHash: HASH_SCHEMA.optional(),
    assertionBundleHash: HASH_SCHEMA.optional(),
    evidenceHashes: z.array(HASH_SCHEMA).max(8192),
    semanticDistance: z.number().int().nonnegative(),
    rank: z.number().int().nonnegative(),
    explanation: z
      .object({
        hardFilterOrder: z.tuple([
          z.literal("entry_selection"),
          z.literal("entry_kind"),
          z.literal("semantic_commitment"),
          z.literal("realization_form"),
          z.literal("state"),
          z.literal("surface_treatment"),
          z.literal("affordance_evidence"),
          z.literal("placement"),
          z.literal("style_profile"),
          z.literal("metric_bounds"),
          z.literal("commercial_rights"),
          z.literal("redistribution_rights"),
          z.literal("triangle_budget"),
          z.literal("source_byte_budget"),
        ]),
        rankingOrder: z.tuple([
          z.literal("semantic_ancestor_distance"),
          z.literal("style_fit"),
          z.literal("bounds_slack"),
          z.literal("triangle_cost"),
          z.literal("source_byte_cost"),
          z.literal("entry_hash"),
        ]),
        rankedCandidates: z.array(rankedCandidateSchema).min(1).max(4096),
        rejectedCandidates: z.array(rejectedCandidateSchema).max(4096),
      })
      .strict(),
  })
  .strict();
export type ResolvedCatalogBinding = z.output<typeof RESOLVED_CATALOG_BINDING_SCHEMA>;

const gapBase = {
  requirementId: z.string().min(1).max(64),
  requirementHash: HASH_SCHEMA,
  required: z.boolean(),
  reason: z.string().min(1).max(1024),
  rejectedCandidates: z.array(rejectedCandidateSchema).max(4096),
};
export const SEMANTIC_GAP_SCHEMA = z
  .object({ kind: z.literal("semantic_gap"), ...gapBase })
  .strict();
export const EVIDENCE_GAP_SCHEMA = z
  .object({ kind: z.literal("evidence_gap"), ...gapBase })
  .strict();
export const CATALOG_GAP_SCHEMA = z.object({ kind: z.literal("catalog_gap"), ...gapBase }).strict();
export const RESOLUTION_GAP_SCHEMA = z.discriminatedUnion("kind", [
  SEMANTIC_GAP_SCHEMA,
  EVIDENCE_GAP_SCHEMA,
  CATALOG_GAP_SCHEMA,
]);
export type SemanticGap = z.output<typeof SEMANTIC_GAP_SCHEMA>;
export type EvidenceGap = z.output<typeof EVIDENCE_GAP_SCHEMA>;
export type CatalogGap = z.output<typeof CATALOG_GAP_SCHEMA>;
export type ResolutionGap = z.output<typeof RESOLUTION_GAP_SCHEMA>;

export const CATALOG_RESOLUTION_PLAN_SCHEMA = z
  .object({
    kind: z.literal("CatalogResolutionPlan"),
    id: z.string().min(1).max(64),
    status: COMPILATION_STATUS_SCHEMA,
    semanticKernelHash: HASH_SCHEMA,
    catalogSnapshotHash: HASH_SCHEMA,
    requirementsHash: HASH_SCHEMA,
    bindings: z.array(RESOLVED_CATALOG_BINDING_SCHEMA).max(8192),
    gaps: z.array(RESOLUTION_GAP_SCHEMA).max(8192),
    diagnostics: z.array(z.string().min(1).max(1024)).max(8192),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    const { hash: _hash, id: _id, ...material } = value;
    if (contentHash(stableJson(material)) !== value.hash)
      context.addIssue({
        code: "custom",
        path: ["hash"],
        message: "Catalog resolution hash mismatch",
      });
    if (contentAddressedEntityId("catalog_resolution", material) !== value.id)
      context.addIssue({ code: "custom", path: ["id"], message: "Catalog resolution ID mismatch" });
  });
export type CatalogResolutionPlan = z.output<typeof CATALOG_RESOLUTION_PLAN_SCHEMA>;

export function resolveCatalogRequirements(input: {
  readonly semanticModule: SemanticModule;
  readonly snapshot: CatalogSnapshot;
  readonly requirements: readonly CatalogRequirement[];
}): CatalogResolutionPlan {
  const requirements = input.requirements
    .map((entry) => CATALOG_REQUIREMENT_SCHEMA.parse(entry))
    .sort((a, b) => compareCanonicalStrings(a.requirementId, b.requirementId));
  if (new Set(requirements.map((entry) => entry.requirementId)).size !== requirements.length)
    throw new Error("Catalog requirement IDs must be unique");
  const bindings: ResolvedCatalogBinding[] = [];
  const gaps: ResolutionGap[] = [];
  const diagnostics: string[] = [];
  if (input.snapshot.semanticKernelHash !== input.semanticModule.kernel.hash)
    diagnostics.push("Catalog snapshot and semantic kernel do not match");

  for (const requirement of requirements) {
    const requirementHash = contentHash(stableJson(requirement));
    const expectedClosure = createSemanticDependencyClosure({
      module: input.semanticModule,
      conceptIds: [requirement.semantic.denotation.conceptId],
      definitionIds: [
        ...requirement.semantic.realizationForms,
        ...requirement.semantic.affordances.map((entry) => entry.affordanceId),
        ...requirement.semantic.states.flatMap((entry) => [
          entry.stateDimensionId,
          entry.stateValueId,
        ]),
        ...requirement.semantic.surfaceTreatmentIds,
      ],
    });
    if (expectedClosure.hash !== requirement.semantic.dependencyClosureHash) {
      gaps.push({
        kind: "semantic_gap",
        requirementId: requirement.requirementId,
        requirementHash,
        required: requirement.required,
        reason: "Requirement semantic closure does not match its exact commitments",
        rejectedCandidates: [],
      });
      continue;
    }
    const rejectedCandidates: Array<{
      entryHandle: string;
      reasons: string[];
      rejectedMembers: Array<{ memberId: string; reasons: string[] }>;
    }> = [];
    const candidates: Array<{
      entry: SealedRuntimeCatalogEntry;
      semanticDistance: number;
      styleRank: number;
      boundsSlack: bigint;
      triangleCount: number;
      sourceBytes: number;
      eligibleMembers: SealedRuntimeCatalogEntry["memberAssets"];
      rejectedMembers: Array<{ memberId: string; reasons: string[] }>;
    }> = [];
    for (const candidate of input.snapshot.entries) {
      if (candidate.kind === "collection") continue;
      const reasons: string[] = [];
      if (
        requirement.allowedEntryHandles &&
        !requirement.allowedEntryHandles.includes(candidate.handle)
      )
        reasons.push("entry_selection");
      if (!requirement.acceptedEntryKinds.includes(candidate.kind)) reasons.push("entry_kind");
      const distance = semanticAncestorDistance(
        input.semanticModule,
        candidate.semantic.denotation.conceptId,
        requirement.semantic.denotation,
      );
      if (distance === undefined) reasons.push("semantic_commitment");
      if (!requirement.semantic.realizationForms.includes(candidate.semantic.realizationForm))
        reasons.push("realization_form");
      if (
        requirement.semantic.states.some(
          (required) =>
            !candidate.semantic.fixedStates.some(
              (observed) =>
                observed.stateDimensionId === required.stateDimensionId &&
                observed.stateValueId === required.stateValueId,
            ),
        )
      )
        reasons.push("state");
      if (
        requirement.semantic.surfaceTreatmentIds.some(
          (id) => !candidate.semantic.surfaceTreatmentIds.includes(id),
        )
      )
        reasons.push("surface_treatment");
      if (
        requirement.semantic.affordances.some((required) => {
          const observed = candidate.semantic.affordances.find(
            (entry) => entry.affordanceId === required.affordanceId,
          );
          return !observed || !evidenceSatisfies(observed.evidenceLevel, required.minimumEvidence);
        })
      ) {
        reasons.push("affordance_evidence");
      }
      if (
        requirement.placement.requiredSupport &&
        candidate.placement.support !== requirement.placement.requiredSupport
      )
        reasons.push("placement");
      if (
        requirement.placement.requiredInterfaceIds.some(
          (id) => !candidate.placement.interfaces.some((entry) => entry.interfaceId === id),
        )
      )
        reasons.push("placement");
      const styleRank =
        requirement.styleProfileHandles.length === 0
          ? 0
          : requirement.styleProfileHandles.indexOf(candidate.styleProfileHandle);
      if (styleRank < 0) reasons.push("style_profile");
      const memberOutcomes = candidate.memberAssets.map((member) => ({
        member,
        ...memberConstraintOutcome(member, requirement),
      }));
      const eligibleMemberOutcomes = memberOutcomes.filter(
        (outcome) => outcome.reasons.length === 0,
      );
      const rejectedMembers = memberOutcomes
        .filter((outcome) => outcome.reasons.length > 0)
        .map((outcome) => ({ memberId: outcome.member.memberId, reasons: outcome.reasons }));
      let boundsSlack = 0n;
      let triangleCount = candidate.triangleCount;
      let sourceBytes = candidate.sourceBytes;
      if (candidate.memberAssets.length > 0) {
        if (eligibleMemberOutcomes.length === 0) reasons.push("member_constraints");
        else {
          boundsSlack = eligibleMemberOutcomes.reduce(
            (best, outcome) => (outcome.boundsSlack < best ? outcome.boundsSlack : best),
            eligibleMemberOutcomes[0]!.boundsSlack,
          );
          triangleCount = Math.max(
            ...eligibleMemberOutcomes.map((outcome) => outcome.member.triangleCount),
          );
          sourceBytes = Math.max(
            ...eligibleMemberOutcomes.map((outcome) => outcome.member.sourceBytes),
          );
        }
      } else {
        const aggregate = aggregateConstraintOutcome(candidate, requirement);
        reasons.push(...aggregate.reasons);
        boundsSlack = aggregate.boundsSlack;
      }
      if (reasons.length > 0)
        rejectedCandidates.push({
          entryHandle: candidate.handle,
          reasons: [...new Set(reasons)],
          rejectedMembers,
        });
      else
        candidates.push({
          entry: candidate,
          semanticDistance: distance!,
          styleRank,
          boundsSlack,
          triangleCount,
          sourceBytes,
          eligibleMembers: eligibleMemberOutcomes.map((outcome) => outcome.member),
          rejectedMembers,
        });
    }
    candidates.sort(
      (a, b) =>
        a.semanticDistance - b.semanticDistance ||
        a.styleRank - b.styleRank ||
        compareBigInt(a.boundsSlack, b.boundsSlack) ||
        a.triangleCount - b.triangleCount ||
        a.sourceBytes - b.sourceBytes ||
        compareCanonicalStrings(a.entry.entryHash, b.entry.entryHash),
    );
    if (candidates.length === 0) {
      const evidenceOnlyFailure =
        rejectedCandidates.length > 0 &&
        rejectedCandidates.every(
          (candidate) =>
            candidate.reasons.length > 0 &&
            candidate.reasons.every((reason) => reason === "affordance_evidence"),
        );
      gaps.push({
        kind: evidenceOnlyFailure ? "evidence_gap" : "catalog_gap",
        requirementId: requirement.requirementId,
        requirementHash,
        required: requirement.required,
        reason: evidenceOnlyFailure
          ? "Semantically suitable entries lack required evidence"
          : "No catalog entry satisfies every hard constraint",
        rejectedCandidates: rejectedCandidates.sort((a, b) =>
          compareCanonicalStrings(a.entryHandle, b.entryHandle),
        ),
      });
      continue;
    }
    const winner = candidates[0]!;
    const member = chooseMember(winner.entry, requirementHash, winner.eligibleMembers);
    bindings.push({
      requirementId: requirement.requirementId,
      requirementHash,
      semanticDependencyClosureHash: requirement.semantic.dependencyClosureHash,
      catalogSnapshotHash: input.snapshot.hash,
      entryHandle: winner.entry.handle,
      entryHash: winner.entry.entryHash,
      ...(member
        ? {
            memberId: member.memberId,
            assetHash: member.assetHash,
            assertionBundleHash: member.assertionBundleHash,
          }
        : {}),
      evidenceHashes: winner.entry.evidenceHashes,
      semanticDistance: winner.semanticDistance,
      rank: 0,
      explanation: {
        hardFilterOrder: [
          "entry_selection",
          "entry_kind",
          "semantic_commitment",
          "realization_form",
          "state",
          "surface_treatment",
          "affordance_evidence",
          "placement",
          "style_profile",
          "metric_bounds",
          "commercial_rights",
          "redistribution_rights",
          "triangle_budget",
          "source_byte_budget",
        ],
        rankingOrder: [
          "semantic_ancestor_distance",
          "style_fit",
          "bounds_slack",
          "triangle_cost",
          "source_byte_cost",
          "entry_hash",
        ],
        rankedCandidates: candidates.map((candidate, rank) => ({
          entryHandle: candidate.entry.handle,
          entryHash: candidate.entry.entryHash,
          semanticAncestorDistance: candidate.semanticDistance,
          stylePreferenceRank: candidate.styleRank,
          boundsSlackQ32: candidate.boundsSlack.toString(),
          triangleCount: candidate.triangleCount,
          sourceBytes: candidate.sourceBytes,
          eligibleMemberIds: candidate.eligibleMembers.map((member) => member.memberId),
          rejectedMembers: candidate.rejectedMembers,
          rank,
        })),
        rejectedCandidates: rejectedCandidates.sort((a, b) =>
          compareCanonicalStrings(a.entryHandle, b.entryHandle),
        ),
      },
    });
  }
  const requiredGap = gaps.some((entry) => entry.required);
  const status = diagnostics.length > 0 ? "rejected" : requiredGap ? "incomplete" : "eligible";
  diagnostics.push(...gaps.map((entry) => `${entry.kind}:${entry.requirementId}:${entry.reason}`));
  const material = {
    kind: "CatalogResolutionPlan" as const,
    status,
    semanticKernelHash: input.semanticModule.kernel.hash,
    catalogSnapshotHash: input.snapshot.hash,
    requirementsHash: contentHash(stableJson(requirements)),
    bindings,
    gaps,
    diagnostics,
  };
  return deepFreezeJson(
    CATALOG_RESOLUTION_PLAN_SCHEMA.parse({
      ...material,
      id: contentAddressedEntityId("catalog_resolution", material),
      hash: contentHash(stableJson(material)),
    }),
  ) as CatalogResolutionPlan;
}

function memberConstraintOutcome(
  member: SealedRuntimeCatalogEntry["memberAssets"][number],
  requirement: CatalogRequirement,
): { reasons: string[]; boundsSlack: bigint } {
  const reasons: string[] = [];
  const boundsSlack = metricConstraintOutcome(member.bounds, requirement, reasons);
  if (requirement.rights.commercialUseRequired && !member.rights.commercialUsePermitted)
    reasons.push("commercial_rights");
  if (requirement.rights.redistributionRequired && !member.rights.redistributionPermitted)
    reasons.push("redistribution_rights");
  if (member.triangleCount > requirement.budget.maximumTriangles) reasons.push("triangle_budget");
  if (member.sourceBytes > requirement.budget.maximumSourceBytes)
    reasons.push("source_byte_budget");
  return { reasons, boundsSlack };
}

function aggregateConstraintOutcome(
  entry: SealedRuntimeCatalogEntry,
  requirement: CatalogRequirement,
): { reasons: string[]; boundsSlack: bigint } {
  const reasons: string[] = [];
  let boundsSlack = 0n;
  if (entry.metricEnvelope)
    boundsSlack = metricConstraintOutcome(entry.metricEnvelope, requirement, reasons);
  else if (requirement.metricBounds.maximumSizeMeters) reasons.push("metric_bounds");
  if (requirement.rights.commercialUseRequired && !entry.rights.commercialUsePermitted)
    reasons.push("commercial_rights");
  if (requirement.rights.redistributionRequired && !entry.rights.redistributionPermitted)
    reasons.push("redistribution_rights");
  if (entry.triangleCount > requirement.budget.maximumTriangles) reasons.push("triangle_budget");
  if (entry.sourceBytes > requirement.budget.maximumSourceBytes) reasons.push("source_byte_budget");
  return { reasons, boundsSlack };
}

function metricConstraintOutcome(
  bounds: {
    readonly min: { readonly x: string; readonly y: string; readonly z: string };
    readonly max: { readonly x: string; readonly y: string; readonly z: string };
  },
  requirement: CatalogRequirement,
  reasons: string[],
): bigint {
  const maximum = requirement.metricBounds.maximumSizeMeters;
  if (!maximum) return 0n;
  let slack = 0n;
  for (const axis of ["x", "y", "z"] as const) {
    const size = BigInt(bounds.max[axis]) - BigInt(bounds.min[axis]);
    const allowed = BigInt(maximum[axis]);
    if (size > allowed) reasons.push(`metric_bounds_${axis}`);
    else slack += allowed - size;
  }
  return slack;
}

function chooseMember(
  entry: SealedRuntimeCatalogEntry,
  seedHash: string,
  eligibleMembers: SealedRuntimeCatalogEntry["memberAssets"],
) {
  if (entry.kind === "assembly_kit" || entry.kind === "route_kit") return undefined;
  if (eligibleMembers.length === 0) return undefined;
  const total = eligibleMembers.reduce((sum, member) => sum + member.selectionWeight, 0);
  let cursor = Number(
    BigInt(`0x${contentHash(`${seedHash}:${entry.entryHash}`).slice(0, 12)}`) % BigInt(total),
  );
  for (const member of eligibleMembers) {
    if (cursor < member.selectionWeight) return member;
    cursor -= member.selectionWeight;
  }
  return eligibleMembers.at(-1)!;
}

function compareBigInt(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
