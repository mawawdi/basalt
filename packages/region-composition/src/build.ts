import { z } from "zod";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import {
  DEFAULT_SPATIAL_ADMISSION_POLICY,
  assertBoundedSpatialJson,
  compareSpatialStrings,
  entityId,
  hashSchema,
} from "../../spatial-core/src/primitives.js";
import { assertRegionCompositionPlacementCandidates } from "./projection.js";
import { assertRegionCompositionProposal } from "./proposal.js";
import { assertRegionalPlan } from "./planning.js";
import type {
  RegionCompositionPlacementCandidates,
  RegionCompositionProposal,
  RegionalPlan,
} from "./contracts.js";

export const REGION_COMPOSITION_BUILD_ABI = "basalt-region-composition-build@1" as const;
export const REGION_COMPOSITION_FRESH_PROPOSAL_COUNT = 3 as const;

export const REGION_COMPOSITION_MODE_SCHEMA = z.enum(["disabled", "prefer", "required"]);
export type RegionCompositionMode = z.infer<typeof REGION_COMPOSITION_MODE_SCHEMA>;

const indexedProposal = z
  .object({ compositionIndex: z.number().int().min(0).max(2), proposalHash: hashSchema })
  .strict();

const proposalSet = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unavailable"), proposals: z.tuple([]) }).strict(),
  z
    .object({
      kind: z.literal("incomplete_fresh"),
      proposals: z.array(indexedProposal).min(1).max(2),
    })
    .strict(),
  z
    .object({
      kind: z.literal("fresh_three"),
      proposals: z.tuple([indexedProposal, indexedProposal, indexedProposal]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("accepted_exact_cache"),
      proposals: z.tuple([indexedProposal]),
      acceptedSelectionEvidenceHash: hashSchema,
    })
    .strict(),
]);

export const REGION_COMPOSITION_REGION_OUTCOME_SCHEMA = z
  .object({
    regionId: entityId,
    contextRenderHash: hashSchema.optional(),
    disposition: z.enum(["selected", "authored_alternative", "incomplete"]),
    proposalSet,
    selectedProposalHash: hashSchema.optional(),
    placementCandidateHashes: z.array(hashSchema).max(4096),
    resolvedTargetIds: z.array(entityId).max(4096),
    diagnostics: z
      .array(
        z.enum([
          "proposal_producer_unavailable",
          "context_render_unavailable",
          "proposal_set_incomplete",
          "proposal_selection_failed",
          "segmentation_failed",
          "projection_calibration_failed",
          "relation_solver_rejected",
          "authored_alternative_used",
        ]),
      )
      .max(8),
  })
  .strict();
export type RegionCompositionRegionOutcome = z.infer<
  typeof REGION_COMPOSITION_REGION_OUTCOME_SCHEMA
>;

const buildMaterial = z
  .object({
    kind: z.literal("RegionCompositionBuild"),
    abi: z.literal(REGION_COMPOSITION_BUILD_ABI),
    mode: REGION_COMPOSITION_MODE_SCHEMA,
    freshProposalCount: z.literal(REGION_COMPOSITION_FRESH_PROPOSAL_COUNT),
    regionalPlanHash: hashSchema,
    worldPlanHash: hashSchema,
    surfaceIndexHash: hashSchema,
    globalFoundationHash: hashSchema,
    styleContractHash: hashSchema,
    selectedRegionIds: z.array(entityId).max(256),
    outcomes: z.array(REGION_COMPOSITION_REGION_OUTCOME_SCHEMA).max(256),
    status: z.enum(["eligible", "incomplete"]),
  })
  .strict();

export const REGION_COMPOSITION_BUILD_SCHEMA = buildMaterial.safeExtend({
  id: entityId,
  hash: hashSchema,
});
export type RegionCompositionBuild = z.infer<typeof REGION_COMPOSITION_BUILD_SCHEMA>;

export interface RegionCompositionRegionResult {
  readonly regionId: string;
  readonly contextRenderHash?: string;
  readonly proposals: readonly RegionCompositionProposal[];
  readonly acceptedSelectionEvidenceHash?: string;
  readonly selectedProposalHash?: string;
  readonly placementCandidates: readonly RegionCompositionPlacementCandidates[];
  readonly resolvedTargetIds: readonly string[];
  readonly disposition: "selected" | "authored_alternative" | "incomplete";
  readonly diagnostics: readonly RegionCompositionRegionOutcome["diagnostics"][number][];
}

export interface RegionCompositionRegionEvidence {
  readonly regionId: string;
  readonly contextRenderHash?: string;
  readonly proposals: readonly RegionCompositionProposal[];
  readonly acceptedSelectionEvidenceHash?: string;
  readonly selectedProposalHash?: string;
  readonly placementCandidates: readonly RegionCompositionPlacementCandidates[];
  readonly resolvedTargetIds: readonly string[];
  readonly authoredAlternativeAvailable: boolean;
}

const pendingMode = z.enum(["prefer", "required"]);
export const REGION_COMPOSITION_SCENE_BINDING_SCHEMA = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("disabled"),
      mode: z.literal("disabled"),
      freshProposalCount: z.literal(REGION_COMPOSITION_FRESH_PROPOSAL_COUNT),
    })
    .strict(),
  z
    .object({
      state: z.literal("pending"),
      mode: pendingMode,
      freshProposalCount: z.literal(REGION_COMPOSITION_FRESH_PROPOSAL_COUNT),
    })
    .strict(),
  z
    .object({
      state: z.literal("bound"),
      mode: pendingMode,
      freshProposalCount: z.literal(REGION_COMPOSITION_FRESH_PROPOSAL_COUNT),
      build: REGION_COMPOSITION_BUILD_SCHEMA,
    })
    .strict(),
]);
export type RegionCompositionSceneBinding = z.infer<typeof REGION_COMPOSITION_SCENE_BINDING_SCHEMA>;

/**
 * Seal the exact advisory-composition outcome for one visual build. Fresh
 * exploration always means three alternatives. A single proposal is accepted
 * only when an exact earlier selection-evidence hash is retained.
 */
export function sealRegionCompositionBuild(input: {
  readonly mode: RegionCompositionMode;
  readonly regionalPlan: RegionalPlan;
  readonly regions: readonly RegionCompositionRegionResult[];
}): RegionCompositionBuild {
  assertRegionalPlan(input.regionalPlan);
  const selectedRegionIds = [...input.regionalPlan.selectedRegionIds];
  if (input.mode === "disabled" && input.regions.length !== 0)
    throw new Error("Disabled region composition cannot retain generated outcomes");
  if (input.mode !== "disabled") {
    const supplied = input.regions.map((entry) => entry.regionId).sort(compareSpatialStrings);
    if (stableJson(supplied) !== stableJson([...selectedRegionIds].sort(compareSpatialStrings)))
      throw new Error("Region composition outcomes must cover the exact selected regional plan");
  }
  const outcomes = input.regions
    .map((entry) => canonicalRegionOutcome(entry, input.mode, input.regionalPlan))
    .sort((left, right) => compareSpatialStrings(left.regionId, right.regionId));
  const status =
    outcomes.some((outcome) => outcome.disposition === "incomplete") ||
    (input.mode === "required" && outcomes.some((outcome) => outcome.disposition !== "selected"))
      ? ("incomplete" as const)
      : ("eligible" as const);
  const material = buildMaterial.parse({
    kind: "RegionCompositionBuild",
    abi: REGION_COMPOSITION_BUILD_ABI,
    mode: input.mode,
    freshProposalCount: REGION_COMPOSITION_FRESH_PROPOSAL_COUNT,
    regionalPlanHash: input.regionalPlan.hash,
    worldPlanHash: input.regionalPlan.worldPlanHash,
    surfaceIndexHash: input.regionalPlan.surfaceIndexHash,
    globalFoundationHash: input.regionalPlan.globalFoundationHash,
    styleContractHash: regionalStyleContractHash(input.regionalPlan),
    selectedRegionIds,
    outcomes,
    status,
  });
  const hash = contentHash(stableJson(material));
  const build = REGION_COMPOSITION_BUILD_SCHEMA.parse({
    ...material,
    id: `region_composition_build_${hash.slice(0, 24)}`,
    hash,
  });
  assertRegionCompositionBuild(build, input.regionalPlan);
  return build;
}

/**
 * Derive disposition and diagnostics from retained artifacts. Callers describe
 * only evidence and whether a complete authored placement exists; they cannot
 * promote missing pixels or placement candidates by declaring an outcome.
 */
export function deriveRegionCompositionBuild(input: {
  readonly mode: RegionCompositionMode;
  readonly regionalPlan: RegionalPlan;
  readonly regions: readonly RegionCompositionRegionEvidence[];
}): RegionCompositionBuild {
  if (input.mode === "disabled") {
    if (input.regions.length !== 0)
      throw new Error("Disabled region composition cannot receive regional evidence");
    return sealRegionCompositionBuild({
      mode: input.mode,
      regionalPlan: input.regionalPlan,
      regions: [],
    });
  }
  const mode = input.mode;
  return sealRegionCompositionBuild({
    mode,
    regionalPlan: input.regionalPlan,
    regions: input.regions.map((region) => derivedRegionResult(region, mode)),
  });
}

export function disabledRegionCompositionSceneBinding(): RegionCompositionSceneBinding {
  return REGION_COMPOSITION_SCENE_BINDING_SCHEMA.parse({
    state: "disabled",
    mode: "disabled",
    freshProposalCount: REGION_COMPOSITION_FRESH_PROPOSAL_COUNT,
  });
}

export function pendingRegionCompositionSceneBinding(
  mode: Exclude<RegionCompositionMode, "disabled">,
): RegionCompositionSceneBinding {
  return REGION_COMPOSITION_SCENE_BINDING_SCHEMA.parse({
    state: "pending",
    mode,
    freshProposalCount: REGION_COMPOSITION_FRESH_PROPOSAL_COUNT,
  });
}

export function regionCompositionSceneBinding(
  build: RegionCompositionBuild,
): RegionCompositionSceneBinding {
  assertRegionCompositionBuild(build);
  if (build.mode === "disabled") return disabledRegionCompositionSceneBinding();
  return REGION_COMPOSITION_SCENE_BINDING_SCHEMA.parse({
    state: "bound",
    mode: build.mode,
    freshProposalCount: REGION_COMPOSITION_FRESH_PROPOSAL_COUNT,
    build,
  });
}

export function assertRegionCompositionSceneBinding(
  value: unknown,
  scene?: {
    readonly sceneVariant: "proxy" | "resolved";
    readonly worldPlanHash: string;
    readonly surfaceIndexHash: string;
    readonly styleContractHash: string;
  },
): asserts value is RegionCompositionSceneBinding {
  const binding = REGION_COMPOSITION_SCENE_BINDING_SCHEMA.parse(value);
  if (binding.state === "bound") {
    assertRegionCompositionBuild(binding.build);
    if (binding.mode !== binding.build.mode)
      throw new Error("Region composition scene mode differs from its exact build");
  }
  if (!scene) return;
  if (scene.sceneVariant === "proxy" && binding.state === "bound")
    throw new Error("Proxy evidence cannot depend on a regional composition build");
  if (scene.sceneVariant === "resolved" && binding.state === "pending")
    throw new Error("Resolved scenes cannot retain pending region composition");
  if (
    binding.state === "bound" &&
    (binding.build.worldPlanHash !== scene.worldPlanHash ||
      binding.build.surfaceIndexHash !== scene.surfaceIndexHash ||
      binding.build.styleContractHash !== scene.styleContractHash)
  )
    throw new Error("Region composition build crosses the scene world authority");
}

export function assertRegionCompositionBuild(
  value: unknown,
  regionalPlan?: RegionalPlan,
): asserts value is RegionCompositionBuild {
  assertBoundedSpatialJson(value, DEFAULT_SPATIAL_ADMISSION_POLICY);
  const build = REGION_COMPOSITION_BUILD_SCHEMA.parse(value);
  const { id, hash, ...material } = build;
  const expected = contentHash(stableJson(material));
  if (hash !== expected || id !== `region_composition_build_${expected.slice(0, 24)}`)
    throw new Error("Region composition build identity mismatch");
  assertCanonicalUnique(build.selectedRegionIds, "Region composition selected regions");
  assertCanonicalUnique(
    build.outcomes.map((outcome) => outcome.regionId),
    "Region composition outcome regions",
  );
  if (build.mode === "disabled") {
    if (build.outcomes.length !== 0 || build.status !== "eligible")
      throw new Error("Disabled region composition must retain an empty eligible build");
  } else if (
    stableJson(build.outcomes.map((outcome) => outcome.regionId)) !==
    stableJson(build.selectedRegionIds)
  )
    throw new Error("Region composition outcomes do not cover selected regions");
  for (const outcome of build.outcomes) assertOutcomeSemantics(outcome, build.mode);
  const expectedStatus = build.outcomes.some((outcome) => outcome.disposition === "incomplete")
    ? "incomplete"
    : "eligible";
  if (build.status !== expectedStatus)
    throw new Error("Region composition build status disagrees with its outcomes");
  if (regionalPlan) {
    assertRegionalPlan(regionalPlan);
    if (
      build.regionalPlanHash !== regionalPlan.hash ||
      build.worldPlanHash !== regionalPlan.worldPlanHash ||
      build.surfaceIndexHash !== regionalPlan.surfaceIndexHash ||
      build.globalFoundationHash !== regionalPlan.globalFoundationHash ||
      build.styleContractHash !== regionalStyleContractHash(regionalPlan) ||
      stableJson(build.selectedRegionIds) !== stableJson(regionalPlan.selectedRegionIds)
    )
      throw new Error("Region composition build crosses its regional-plan authority");
  }
}

function canonicalRegionOutcome(
  input: RegionCompositionRegionResult,
  mode: RegionCompositionMode,
  regionalPlan: RegionalPlan,
): RegionCompositionRegionOutcome {
  if (mode === "disabled") throw new Error("Disabled composition has no regional outcomes");
  const decision = regionalPlan.decisions.find((entry) => entry.regionId === input.regionId);
  if (!decision || decision.disposition !== "selected")
    throw new Error(`Region composition outcome is outside R+: ${input.regionId}`);
  const proposals = [...input.proposals].sort(
    (left, right) => left.compositionIndex - right.compositionIndex,
  );
  if (proposals.length > 0 && input.contextRenderHash === undefined)
    throw new Error("Regional composition proposals require an exact context render");
  for (const proposal of proposals) {
    assertRegionCompositionProposal(proposal, regionalPlan);
    if (
      proposal.regionId !== input.regionId ||
      proposal.contextRenderHash !== input.contextRenderHash
    )
      throw new Error(`Region composition proposal crosses regional context: ${input.regionId}`);
  }
  const proposalHashes = new Set(proposals.map((proposal) => proposal.hash));
  if (proposalHashes.size !== proposals.length)
    throw new Error(`Region composition proposal set contains duplicates: ${input.regionId}`);
  if (new Set(proposals.map((proposal) => proposal.compositionIndex)).size !== proposals.length)
    throw new Error(`Region composition proposal indices contain duplicates: ${input.regionId}`);
  let proposalSet: RegionCompositionRegionOutcome["proposalSet"];
  if (proposals.length === 0) {
    if (input.acceptedSelectionEvidenceHash !== undefined)
      throw new Error("Unavailable proposal set cannot claim cached selection evidence");
    proposalSet = { kind: "unavailable", proposals: [] };
  } else if (input.acceptedSelectionEvidenceHash !== undefined) {
    if (proposals.length !== 1)
      throw new Error("An exact accepted cache must retain exactly one selected proposal");
    proposalSet = {
      kind: "accepted_exact_cache",
      proposals: [indexedProposalFrom(proposals[0]!)],
      acceptedSelectionEvidenceHash: input.acceptedSelectionEvidenceHash,
    };
  } else {
    if (proposals.length === REGION_COMPOSITION_FRESH_PROPOSAL_COUNT) {
      if (proposals.some((proposal, index) => proposal.compositionIndex !== index))
        throw new Error("Fresh regional exploration requires composition indices 0, 1, and 2");
      proposalSet = {
        kind: "fresh_three",
        proposals: proposals.map(indexedProposalFrom) as [
          ReturnType<typeof indexedProposalFrom>,
          ReturnType<typeof indexedProposalFrom>,
          ReturnType<typeof indexedProposalFrom>,
        ],
      };
    } else {
      if (proposals.length > 2)
        throw new Error("Fresh regional exploration requires composition indices 0, 1, and 2");
      proposalSet = {
        kind: "incomplete_fresh",
        proposals: proposals.map(indexedProposalFrom),
      };
    }
  }
  const selected = input.selectedProposalHash;
  if (input.disposition === "selected" && selected === undefined)
    throw new Error("Selected regional composition outcomes must name the selected proposal");
  if (selected !== undefined && !proposalHashes.has(selected))
    throw new Error("Selected regional composition proposal is absent from its proposal set");
  if (input.disposition === "authored_alternative" && mode !== "prefer")
    throw new Error("Only prefer mode may retain an authored placement alternative");
  const placementCandidates = [...input.placementCandidates].sort((left, right) =>
    compareSpatialStrings(left.targetId, right.targetId),
  );
  for (const candidate of placementCandidates) {
    assertRegionCompositionPlacementCandidates(candidate);
    if (selected === undefined || candidate.proposalHash !== selected)
      throw new Error("Placement candidates do not bind the selected composition proposal");
  }
  const candidateTargets = new Set(placementCandidates.map((candidate) => candidate.targetId));
  if (candidateTargets.size !== placementCandidates.length)
    throw new Error("Region composition placement targets must be unique");
  const resolvedTargetIds = [...input.resolvedTargetIds].sort(compareSpatialStrings);
  assertCanonicalUnique(resolvedTargetIds, "Resolved region-composition targets");
  if (resolvedTargetIds.some((targetId) => !candidateTargets.has(targetId)))
    throw new Error("Resolved composition target has no retained placement candidates");
  if (
    input.disposition === "selected" &&
    (placementCandidates.length === 0 || resolvedTargetIds.length !== placementCandidates.length)
  )
    throw new Error("Selected regional composition must resolve every retained target");
  const diagnostics = [...new Set(input.diagnostics)].sort(compareSpatialStrings);
  const outcome = REGION_COMPOSITION_REGION_OUTCOME_SCHEMA.parse({
    regionId: input.regionId,
    ...(input.contextRenderHash ? { contextRenderHash: input.contextRenderHash } : {}),
    disposition: input.disposition,
    proposalSet,
    ...(selected ? { selectedProposalHash: selected } : {}),
    placementCandidateHashes: placementCandidates
      .map((candidate) => candidate.hash)
      .sort(compareSpatialStrings),
    resolvedTargetIds,
    diagnostics,
  });
  assertOutcomeSemantics(outcome, mode);
  return outcome;
}

function indexedProposalFrom(proposal: RegionCompositionProposal) {
  return { compositionIndex: proposal.compositionIndex, proposalHash: proposal.hash };
}

function derivedRegionResult(
  input: RegionCompositionRegionEvidence,
  mode: Exclude<RegionCompositionMode, "disabled">,
): RegionCompositionRegionResult {
  const proposals = [...input.proposals].sort(
    (left, right) => left.compositionIndex - right.compositionIndex,
  );
  const retainedContextRenderHash = input.contextRenderHash ?? proposals[0]?.contextRenderHash;
  const diagnostics = new Set<RegionCompositionRegionOutcome["diagnostics"][number]>();
  if (input.contextRenderHash === undefined) diagnostics.add("context_render_unavailable");
  if (proposals.length === 0) diagnostics.add("proposal_producer_unavailable");
  else if (
    input.acceptedSelectionEvidenceHash === undefined &&
    proposals.length !== REGION_COMPOSITION_FRESH_PROPOSAL_COUNT
  )
    diagnostics.add("proposal_set_incomplete");
  const selectedProposal = input.selectedProposalHash
    ? proposals.find((proposal) => proposal.hash === input.selectedProposalHash)
    : undefined;
  if (input.selectedProposalHash !== undefined && !selectedProposal)
    throw new Error("Selected regional composition proposal is absent from retained evidence");
  const proposalSetComplete =
    (input.acceptedSelectionEvidenceHash !== undefined && proposals.length === 1) ||
    (input.acceptedSelectionEvidenceHash === undefined &&
      proposals.length === REGION_COMPOSITION_FRESH_PROPOSAL_COUNT);
  if (proposalSetComplete && !selectedProposal) diagnostics.add("proposal_selection_failed");

  const placementCandidates = [...input.placementCandidates];
  const candidateTargets = new Set(placementCandidates.map((candidate) => candidate.targetId));
  if (candidateTargets.size !== placementCandidates.length)
    throw new Error("Region composition evidence contains duplicate placement targets");
  const expectedTargets = new Set(selectedProposal?.targets.map((target) => target.id) ?? []);
  if (
    selectedProposal &&
    (placementCandidates.some(
      (candidate) =>
        candidate.proposalHash !== selectedProposal.hash ||
        candidate.status !== "eligible" ||
        !expectedTargets.has(candidate.targetId),
    ) ||
      placementCandidates.length !== expectedTargets.size)
  )
    diagnostics.add("projection_calibration_failed");
  const resolvedTargetIds = [...input.resolvedTargetIds].sort(compareSpatialStrings);
  assertCanonicalUnique(resolvedTargetIds, "Resolved region-composition targets");
  if (
    selectedProposal &&
    (resolvedTargetIds.length !== expectedTargets.size ||
      resolvedTargetIds.some((targetId) => !expectedTargets.has(targetId)))
  )
    diagnostics.add("relation_solver_rejected");

  const selected =
    input.contextRenderHash !== undefined &&
    proposalSetComplete &&
    selectedProposal !== undefined &&
    diagnostics.size === 0;
  const authoredAlternative = !selected && mode === "prefer" && input.authoredAlternativeAvailable;
  if (authoredAlternative) diagnostics.add("authored_alternative_used");
  return {
    regionId: input.regionId,
    ...(retainedContextRenderHash ? { contextRenderHash: retainedContextRenderHash } : {}),
    proposals,
    ...(input.acceptedSelectionEvidenceHash
      ? { acceptedSelectionEvidenceHash: input.acceptedSelectionEvidenceHash }
      : {}),
    ...(selectedProposal ? { selectedProposalHash: selectedProposal.hash } : {}),
    placementCandidates,
    resolvedTargetIds,
    disposition: selected
      ? "selected"
      : authoredAlternative
        ? "authored_alternative"
        : "incomplete",
    diagnostics: [...diagnostics].sort(compareSpatialStrings),
  };
}

function assertOutcomeSemantics(
  outcome: RegionCompositionRegionOutcome,
  mode: RegionCompositionMode,
): void {
  assertCanonicalUnique(outcome.placementCandidateHashes, "Composition placement candidates");
  assertCanonicalUnique(outcome.resolvedTargetIds, "Resolved composition targets");
  assertCanonicalUnique(outcome.diagnostics, "Region composition diagnostics");
  const proposals = outcome.proposalSet.proposals;
  if (new Set(proposals.map((proposal) => proposal.compositionIndex)).size !== proposals.length)
    throw new Error("Region composition proposal indices must be unique");
  if (outcome.proposalSet.kind === "fresh_three") {
    if (proposals.some((proposal, index) => proposal.compositionIndex !== index))
      throw new Error("Fresh region composition proposals must use indices 0, 1, and 2");
  }
  if (outcome.proposalSet.kind !== "unavailable" && outcome.contextRenderHash === undefined)
    throw new Error("Retained composition proposals require an exact context render");
  if (
    outcome.proposalSet.kind === "incomplete_fresh" &&
    !outcome.diagnostics.includes("proposal_set_incomplete")
  )
    throw new Error("Incomplete fresh proposals require an explicit diagnostic");
  const proposalHashes = new Set(proposals.map((proposal) => proposal.proposalHash));
  if (proposalHashes.size !== proposals.length)
    throw new Error("Region composition proposal hashes must be unique");
  if (
    outcome.disposition === "selected" &&
    (outcome.proposalSet.kind === "unavailable" ||
      outcome.proposalSet.kind === "incomplete_fresh" ||
      !outcome.selectedProposalHash ||
      !proposalHashes.has(outcome.selectedProposalHash) ||
      outcome.placementCandidateHashes.length === 0 ||
      outcome.resolvedTargetIds.length !== outcome.placementCandidateHashes.length ||
      outcome.diagnostics.length !== 0)
  )
    throw new Error("Selected region composition lacks exact complete placement evidence");
  if (outcome.disposition === "authored_alternative") {
    if (mode !== "prefer" || !outcome.diagnostics.includes("authored_alternative_used"))
      throw new Error("Authored regional alternative requires prefer mode and an explicit record");
  }
  if (outcome.disposition === "incomplete" && outcome.diagnostics.length === 0)
    throw new Error("Incomplete region composition requires a typed diagnostic");
}

function regionalStyleContractHash(plan: RegionalPlan): string {
  const hashes = [...new Set(plan.decisions.map((decision) => decision.appearanceContractHash))];
  if (hashes.length !== 1) throw new Error("Regional plan must bind one shared style contract");
  return hashes[0]!;
}

function assertCanonicalUnique(values: readonly string[], label: string): void {
  if (
    new Set(values).size !== values.length ||
    stableJson([...values].sort(compareSpatialStrings)) !== stableJson(values)
  )
    throw new Error(`${label} must be unique and canonical`);
}
