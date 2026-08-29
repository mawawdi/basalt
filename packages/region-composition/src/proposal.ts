import { contentHash, stableJson } from "../../contracts/src/index.js";
import {
  DEFAULT_SPATIAL_ADMISSION_POLICY,
  assertBoundedSpatialJson,
  compareSpatialStrings,
} from "../../spatial-core/src/primitives.js";
import { assertCropSimilarity, assertPerspectiveCameraCalibration } from "./camera.js";
import {
  REGION_COMPOSITION_PROPOSAL_ABI,
  REGION_COMPOSITION_PROPOSAL_SCHEMA,
  type ImageBounds,
  type ImagePoint,
  type RegionCompositionProposal,
  type RegionViewCell,
  type RegionalPlan,
} from "./contracts.js";
import { assertRegionalPlan } from "./planning.js";
import { assertRegionViewCell } from "./view-cell.js";

export interface RegionCompositionProposalInput {
  readonly regionalPlan: RegionalPlan;
  readonly regionViewCell: RegionViewCell;
  readonly contextRenderHash: string;
  readonly compositionIndex: number;
  readonly image: RegionCompositionProposal["image"];
  readonly cropSimilarity: RegionCompositionProposal["cropSimilarity"];
  readonly producerLineage: RegionCompositionProposal["producerLineage"];
  readonly segmentationLineage: RegionCompositionProposal["segmentationLineage"];
  readonly rightsEvidenceHashes: readonly string[];
  readonly instanceMasks: readonly RegionCompositionProposal["instanceMasks"][number][];
  readonly targets: readonly RegionCompositionProposal["targets"][number][];
  readonly unmatchedGeneratedContent: readonly RegionCompositionProposal["unmatchedGeneratedContent"][number][];
}

/** Seal generated pixels as advisory evidence bound to one selected regional foundation. */
export function createRegionCompositionProposal(
  input: RegionCompositionProposalInput,
): RegionCompositionProposal {
  assertRegionalPlan(input.regionalPlan);
  assertRegionViewCell(input.regionViewCell, input.regionalPlan);
  const decision = selectedDecision(input.regionalPlan, input.regionViewCell.regionId);
  const instanceMasks = input.instanceMasks
    .map((mask) => ({
      ...structuredClone(mask),
      rayAnchors: [...mask.rayAnchors].sort(
        (left, right) => left.priority - right.priority || compareSpatialStrings(left.id, right.id),
      ),
    }))
    .sort((left, right) => compareSpatialStrings(left.id, right.id));
  const targets = input.targets
    .map((target) => ({
      ...structuredClone(target),
      placementSurfaceIds: [...target.placementSurfaceIds].sort(compareSpatialStrings),
      maskIds: [...target.maskIds].sort(compareSpatialStrings),
    }))
    .sort((left, right) => compareSpatialStrings(left.id, right.id));
  const unmatchedGeneratedContent = input.unmatchedGeneratedContent
    .map((entry) => ({
      ...structuredClone(entry),
      maskIds: [...entry.maskIds].sort(compareSpatialStrings),
    }))
    .sort((left, right) => compareSpatialStrings(left.id, right.id));
  const material = {
    kind: "RegionCompositionProposal" as const,
    abi: REGION_COMPOSITION_PROPOSAL_ABI,
    regionalPlanHash: input.regionalPlan.hash,
    worldPlanHash: input.regionalPlan.worldPlanHash,
    surfaceIndexHash: input.regionalPlan.surfaceIndexHash,
    globalFoundationHash: input.regionalPlan.globalFoundationHash,
    regionId: input.regionViewCell.regionId,
    regionFoundationHash: decision.regionFoundationHash,
    regionViewCellHash: input.regionViewCell.hash,
    styleContractHash: decision.appearanceContractHash,
    contextRenderHash: input.contextRenderHash,
    compositionIndex: input.compositionIndex,
    authority: "advisory_pixels_only_typed_world_plan_and_relation_solver_are_final" as const,
    image: structuredClone(input.image),
    cameraCalibration: structuredClone(input.regionViewCell.compositionCamera),
    cropSimilarity: structuredClone(input.cropSimilarity),
    producerLineage: structuredClone(input.producerLineage),
    segmentationLineage: structuredClone(input.segmentationLineage),
    rightsEvidenceHashes: [...input.rightsEvidenceHashes].sort(compareSpatialStrings),
    instanceMasks,
    targets,
    unmatchedGeneratedContent,
  };
  assertBoundedSpatialJson(material, DEFAULT_SPATIAL_ADMISSION_POLICY);
  const hash = contentHash(stableJson(material));
  const proposal = REGION_COMPOSITION_PROPOSAL_SCHEMA.parse({
    ...material,
    id: `region_composition_${hash.slice(0, 24)}`,
    hash,
  });
  assertRegionCompositionProposal(proposal, input.regionalPlan, input.regionViewCell);
  return proposal;
}

export function assertRegionCompositionProposal(
  value: unknown,
  regionalPlan?: RegionalPlan,
  regionViewCell?: RegionViewCell,
): asserts value is RegionCompositionProposal {
  assertBoundedSpatialJson(value, DEFAULT_SPATIAL_ADMISSION_POLICY);
  const proposal = REGION_COMPOSITION_PROPOSAL_SCHEMA.parse(value);
  const { id, hash, ...material } = proposal;
  const expected = contentHash(stableJson(material));
  if (hash !== expected || id !== `region_composition_${expected.slice(0, 24)}`)
    throw new Error("Region composition proposal identity mismatch");
  assertPerspectiveCameraCalibration(proposal.cameraCalibration);
  assertCropSimilarity(proposal.cropSimilarity, proposal.cameraCalibration);
  if (
    proposal.image.width !== proposal.cropSimilarity.outputSize.width ||
    proposal.image.height !== proposal.cropSimilarity.outputSize.height
  )
    throw new Error("Region composition pixels do not match the calibrated crop");
  if (proposal.segmentationLineage.sourceImageHash !== proposal.image.artifact.artifactHash)
    throw new Error("Segmentation lineage does not bind the proposal pixels");
  assertCanonicalUnique(proposal.rightsEvidenceHashes, "Composition rights evidence hashes");
  assertCanonicalUnique(
    proposal.instanceMasks.map((mask) => mask.id),
    "Composition mask IDs",
  );
  assertCanonicalUnique(
    proposal.targets.map((target) => target.id),
    "Composition target IDs",
  );
  assertCanonicalUnique(
    proposal.unmatchedGeneratedContent.map((entry) => entry.id),
    "Unmatched-content IDs",
  );

  const maskIds = new Set(proposal.instanceMasks.map((mask) => mask.id));
  for (const mask of proposal.instanceMasks)
    validateMask(mask, proposal.image.width, proposal.image.height);
  const owners = new Map<string, string>();
  for (const target of proposal.targets) {
    assertCanonicalUnique(target.maskIds, `Target mask IDs for ${target.id}`);
    assertCanonicalUnique(target.placementSurfaceIds, `Target surfaces for ${target.id}`);
    claimMasks(target.maskIds, `target:${target.id}`, maskIds, owners);
  }
  for (const entry of proposal.unmatchedGeneratedContent) {
    assertCanonicalUnique(entry.maskIds, `Unmatched mask IDs for ${entry.id}`);
    claimMasks(entry.maskIds, `unmatched:${entry.id}`, maskIds, owners);
  }
  if (owners.size !== maskIds.size)
    throw new Error("Every composition mask must belong to one target or unmatched-content entry");

  if (regionalPlan) {
    assertRegionalPlan(regionalPlan);
    const decision = selectedDecision(regionalPlan, proposal.regionId);
    if (
      proposal.regionalPlanHash !== regionalPlan.hash ||
      proposal.worldPlanHash !== regionalPlan.worldPlanHash ||
      proposal.surfaceIndexHash !== regionalPlan.surfaceIndexHash ||
      proposal.globalFoundationHash !== regionalPlan.globalFoundationHash ||
      proposal.regionFoundationHash !== decision.regionFoundationHash ||
      proposal.styleContractHash !== decision.appearanceContractHash
    )
      throw new Error("Region composition proposal does not bind the selected regional plan");
    const requirementIds = new Set(decision.requirementIds);
    const constraintHashes = new Set(decision.placementConstraintHashes);
    const surfaceIds = new Set(decision.placementSurfaceIds);
    for (const target of proposal.targets) {
      if (!requirementIds.has(target.requirementId))
        throw new Error(`Composition target references an unavailable requirement: ${target.id}`);
      if (!constraintHashes.has(target.placementConstraintHash))
        throw new Error(
          `Composition target references an unavailable placement constraint: ${target.id}`,
        );
      for (const surfaceId of target.placementSurfaceIds)
        if (!surfaceIds.has(surfaceId))
          throw new Error(`Composition target references an unavailable surface: ${surfaceId}`);
    }
  }
  if (regionViewCell) {
    if (!regionalPlan)
      throw new Error("Region-view proposal validation requires the selected regional plan");
    assertRegionViewCell(regionViewCell, regionalPlan);
    if (
      proposal.regionViewCellHash !== regionViewCell.hash ||
      proposal.regionId !== regionViewCell.regionId ||
      stableJson(proposal.cameraCalibration) !== stableJson(regionViewCell.compositionCamera)
    )
      throw new Error("Region composition proposal does not bind the retained region view cell");
  }
}

export function compositionTarget(
  proposal: RegionCompositionProposal,
  targetId: string,
): RegionCompositionProposal["targets"][number] {
  assertRegionCompositionProposal(proposal);
  const target = proposal.targets.find((entry) => entry.id === targetId);
  if (!target) throw new Error(`Region composition target does not exist: ${targetId}`);
  return target;
}

export function unionCompositionMaskBounds(
  proposal: RegionCompositionProposal,
  maskIds: readonly string[],
): ImageBounds {
  assertRegionCompositionProposal(proposal);
  assertCanonicalUnique(maskIds, "Mask-union IDs");
  const requested = new Set(maskIds);
  const masks = proposal.instanceMasks.filter((mask) => requested.has(mask.id));
  if (masks.length !== requested.size || masks.length === 0)
    throw new Error("Mask union must reference existing composition masks");
  const minimumX = Math.min(...masks.map((mask) => mask.bounds.x));
  const minimumY = Math.min(...masks.map((mask) => mask.bounds.y));
  const maximumX = Math.max(...masks.map((mask) => mask.bounds.x + mask.bounds.width));
  const maximumY = Math.max(...masks.map((mask) => mask.bounds.y + mask.bounds.height));
  return {
    x: minimumX,
    y: minimumY,
    width: maximumX - minimumX,
    height: maximumY - minimumY,
  };
}

function selectedDecision(
  regionalPlan: RegionalPlan,
  regionId: string,
): RegionalPlan["decisions"][number] {
  const decision = regionalPlan.decisions.find((entry) => entry.regionId === regionId);
  if (!decision || decision.disposition !== "selected" || !decision.cameraCalibrationHash)
    throw new Error(`Region is not selected with a retained camera: ${regionId}`);
  return decision;
}

function validateMask(
  mask: RegionCompositionProposal["instanceMasks"][number],
  width: number,
  height: number,
): void {
  if (mask.width !== width || mask.height !== height)
    throw new Error(`Composition mask dimensions do not match proposal pixels: ${mask.id}`);
  if (mask.bounds.x + mask.bounds.width > width || mask.bounds.y + mask.bounds.height > height)
    throw new Error(`Composition mask bounds exceed proposal pixels: ${mask.id}`);
  if (mask.coveredPixels > mask.bounds.width * mask.bounds.height)
    throw new Error(`Composition mask coverage exceeds its bounds: ${mask.id}`);
  assertPointInside(mask.centroid, mask.bounds, `Mask centroid ${mask.id}`);
  assertCanonicalUnique(
    mask.rayAnchors.map((anchor) => anchor.id),
    `Mask ray-anchor IDs for ${mask.id}`,
    false,
  );
  if (mask.rayAnchors.some((anchor, index) => anchor.priority !== index))
    throw new Error(`Mask ray-anchor priorities must be contiguous: ${mask.id}`);
  for (const anchor of mask.rayAnchors)
    assertPointInside(anchor.pixel, mask.bounds, `Mask ray anchor ${anchor.id}`);
}

function assertPointInside(point: ImagePoint, bounds: ImageBounds, label: string): void {
  if (
    point.x < bounds.x ||
    point.x > bounds.x + bounds.width ||
    point.y < bounds.y ||
    point.y > bounds.y + bounds.height
  )
    throw new Error(`${label} lies outside its exact mask bounds`);
}

function claimMasks(
  claimed: readonly string[],
  owner: string,
  available: ReadonlySet<string>,
  owners: Map<string, string>,
): void {
  for (const maskId of claimed) {
    if (!available.has(maskId))
      throw new Error(`Composition owner references missing mask: ${maskId}`);
    const previous = owners.get(maskId);
    if (previous) throw new Error(`Composition mask has more than one semantic owner: ${maskId}`);
    owners.set(maskId, owner);
  }
}

function assertCanonicalUnique(
  values: readonly string[],
  label: string,
  requireSorted = true,
): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} must be unique`);
  if (requireSorted && stableJson([...values].sort(compareSpatialStrings)) !== stableJson(values))
    throw new Error(`${label} must be canonical`);
}
