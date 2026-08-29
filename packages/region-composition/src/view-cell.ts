import { contentHash, stableJson } from "../../contracts/src/index.js";
import {
  DEFAULT_SPATIAL_ADMISSION_POLICY,
  assertBoundedSpatialJson,
  compareSpatialStrings,
} from "../../spatial-core/src/primitives.js";
import { PlacementSurfaceIndex } from "../../world-planning/src/index.js";
import { assertPerspectiveCameraCalibration } from "./camera.js";
import {
  REGION_VIEW_CELL_ABI,
  REGION_VIEW_CELL_SCHEMA,
  type PerspectiveCameraCalibration,
  type RegionViewCell,
  type RegionalPlan,
} from "./contracts.js";
import { assertRegionalPlan } from "./planning.js";

export interface RegionViewCellInput {
  readonly regionalPlan: RegionalPlan;
  readonly surfaces: PlacementSurfaceIndex;
  readonly regionId: string;
  readonly ordinal: number;
  readonly coverageReason: RegionViewCell["coverageReason"];
  readonly compositionCamera: PerspectiveCameraCalibration;
  readonly validationCameras: readonly PerspectiveCameraCalibration[];
  readonly visibleSurfaceIds: readonly string[];
  readonly requirementIds: readonly string[];
  readonly rationale: string;
}

/**
 * Retain the exact calibrated cameras and substrate coverage for one regional
 * composition view. Pixels produced from this cell are evidence only.
 */
export function createRegionViewCell(input: RegionViewCellInput): RegionViewCell {
  assertRegionalPlan(input.regionalPlan);
  if (input.surfaces.hash !== input.regionalPlan.surfaceIndexHash)
    throw new Error("Region view cell surfaces do not match the regional foundation");
  const decision = selectedDecision(input.regionalPlan, input.regionId);
  assertPerspectiveCameraCalibration(input.compositionCamera);
  for (const camera of input.validationCameras) assertPerspectiveCameraCalibration(camera);

  const visibleSurfaceIds = canonicalUnique(input.visibleSurfaceIds, "Region-view surface IDs");
  for (const surfaceId of visibleSurfaceIds)
    if (!input.surfaces.has(surfaceId))
      throw new Error(`Region view cell references an unavailable surface: ${surfaceId}`);
  const requirementIds = canonicalUnique(input.requirementIds, "Region-view requirement IDs");
  const availableRequirements = new Set(decision.requirementIds);
  for (const requirementId of requirementIds)
    if (!availableRequirements.has(requirementId))
      throw new Error(`Region view cell references an unavailable requirement: ${requirementId}`);

  if (input.ordinal === 0 && input.compositionCamera.hash !== decision.cameraCalibrationHash)
    throw new Error("Primary region view cell must retain the regional-plan camera");

  const validationCameras = [...input.validationCameras].sort(
    (left, right) =>
      compareSpatialStrings(left.cameraId, right.cameraId) ||
      compareSpatialStrings(left.hash, right.hash),
  );
  const material = {
    kind: "RegionViewCell" as const,
    abi: REGION_VIEW_CELL_ABI,
    regionalPlanHash: input.regionalPlan.hash,
    worldPlanHash: input.regionalPlan.worldPlanHash,
    surfaceIndexHash: input.regionalPlan.surfaceIndexHash,
    globalFoundationHash: input.regionalPlan.globalFoundationHash,
    regionId: decision.regionId,
    regionFoundationHash: decision.regionFoundationHash,
    styleContractHash: decision.appearanceContractHash,
    ordinal: input.ordinal,
    coverageReason: input.coverageReason,
    compositionCamera: structuredClone(input.compositionCamera),
    validationCameras: validationCameras.map((camera) => structuredClone(camera)),
    visibleSurfaceIds,
    requirementIds,
    rationale: input.rationale.trim(),
    authority:
      "retained_camera_calibrations_bind_every_render_and_composition_pixels_remain_advisory" as const,
    assetExecutorRequired: false as const,
  };
  assertBoundedSpatialJson(material, DEFAULT_SPATIAL_ADMISSION_POLICY);
  const hash = contentHash(stableJson(material));
  const cell = REGION_VIEW_CELL_SCHEMA.parse({
    ...material,
    id: `region_view_cell_${hash.slice(0, 24)}`,
    hash,
  });
  assertRegionViewCell(cell, input.regionalPlan, input.surfaces);
  return cell;
}

export function assertRegionViewCell(
  value: unknown,
  regionalPlan?: RegionalPlan,
  surfaces?: PlacementSurfaceIndex,
): asserts value is RegionViewCell {
  assertBoundedSpatialJson(value, DEFAULT_SPATIAL_ADMISSION_POLICY);
  const cell = REGION_VIEW_CELL_SCHEMA.parse(value);
  const { id, hash, ...material } = cell;
  const expected = contentHash(stableJson(material));
  if (hash !== expected || id !== `region_view_cell_${expected.slice(0, 24)}`)
    throw new Error("Region view cell identity mismatch");
  assertPerspectiveCameraCalibration(cell.compositionCamera);
  for (const camera of cell.validationCameras) assertPerspectiveCameraCalibration(camera);
  assertCanonicalUnique(
    cell.validationCameras.map((camera) => camera.cameraId),
    "Region-view validation camera IDs",
  );
  assertCanonicalUnique(cell.visibleSurfaceIds, "Region-view surface IDs");
  assertCanonicalUnique(cell.requirementIds, "Region-view requirement IDs");

  if (regionalPlan) {
    assertRegionalPlan(regionalPlan);
    const decision = selectedDecision(regionalPlan, cell.regionId);
    if (
      cell.regionalPlanHash !== regionalPlan.hash ||
      cell.worldPlanHash !== regionalPlan.worldPlanHash ||
      cell.surfaceIndexHash !== regionalPlan.surfaceIndexHash ||
      cell.globalFoundationHash !== regionalPlan.globalFoundationHash ||
      cell.regionFoundationHash !== decision.regionFoundationHash ||
      cell.styleContractHash !== decision.appearanceContractHash
    )
      throw new Error("Region view cell does not bind the selected regional plan");
    if (cell.ordinal === 0 && cell.compositionCamera.hash !== decision.cameraCalibrationHash)
      throw new Error("Primary region view cell does not bind the retained regional camera");
    const requirements = new Set(decision.requirementIds);
    for (const requirementId of cell.requirementIds)
      if (!requirements.has(requirementId))
        throw new Error(`Region view cell references an unavailable requirement: ${requirementId}`);
  }
  if (surfaces) {
    if (cell.surfaceIndexHash !== surfaces.hash)
      throw new Error("Region view cell does not bind the supplied surface index");
    for (const surfaceId of cell.visibleSurfaceIds)
      if (!surfaces.has(surfaceId))
        throw new Error(`Region view cell references an unavailable surface: ${surfaceId}`);
  }
}

/** Validate the complete one-to-four-cell coverage for a selected region. */
export function assertRegionViewCellSet(
  cells: readonly unknown[],
  regionalPlan: RegionalPlan,
  surfaces: PlacementSurfaceIndex,
  regionId: string,
): asserts cells is readonly RegionViewCell[] {
  assertRegionalPlan(regionalPlan);
  const decision = selectedDecision(regionalPlan, regionId);
  if (cells.length < 1 || cells.length > 4)
    throw new Error("A selected region requires one through four view cells");
  const parsed = cells.map((value) => {
    assertRegionViewCell(value, regionalPlan, surfaces);
    return value;
  });
  if (parsed.some((cell) => cell.regionId !== regionId))
    throw new Error("A region-view cell set may cover only one selected region");
  if (parsed.some((cell, ordinal) => cell.ordinal !== ordinal))
    throw new Error("Region-view cell ordinals must be contiguous and canonical");
  assertCanonicalUnique(
    parsed.map((cell) => cell.compositionCamera.hash),
    "Region-view composition cameras",
    false,
  );

  const coveredRequirements = [...new Set(parsed.flatMap((cell) => cell.requirementIds))].sort(
    compareSpatialStrings,
  );
  if (stableJson(coveredRequirements) !== stableJson(decision.requirementIds))
    throw new Error("Region-view cells must cover every selected requirement");

  const visibleSurfaces = new Set(parsed.flatMap((cell) => cell.visibleSurfaceIds));
  for (const surfaceId of decision.placementSurfaceIds)
    if (!visibleSurfaces.has(surfaceId))
      throw new Error(`Region-view cells do not expose required surface: ${surfaceId}`);
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

function canonicalUnique(values: readonly string[], label: string): string[] {
  if (new Set(values).size !== values.length) throw new Error(`${label} must be unique`);
  return [...values].sort(compareSpatialStrings);
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
