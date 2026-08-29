import { contentHash, stableJson } from "../../contracts/src/index.js";
import {
  DEFAULT_SPATIAL_ADMISSION_POLICY,
  assertBoundedSpatialJson,
  compareSpatialStrings,
} from "../../spatial-core/src/primitives.js";
import { PlacementSurfaceIndex, type WorldVector3 } from "../../world-planning/src/index.js";
import {
  assertPerspectiveCameraCalibration,
  calibratedWorldRayFromCropPixel,
  mapCropPixelToSource,
  projectWorldPoint,
} from "./camera.js";
import {
  PREPARED_ASSET_PROJECTION_CALIBRATION_ABI,
  PREPARED_ASSET_PROJECTION_CALIBRATION_SCHEMA,
  REGION_COMPOSITION_PLACEMENT_CANDIDATES_ABI,
  REGION_COMPOSITION_PLACEMENT_CANDIDATES_SCHEMA,
  type CanonicalQuaternion,
  type ImageBounds,
  type PreparedAssetProjectionCalibration,
  type RegionCompositionPlacementCandidates,
  type RegionCompositionProposal,
} from "./contracts.js";
import {
  assertRegionCompositionProposal,
  compositionTarget,
  unionCompositionMaskBounds,
} from "./proposal.js";

export interface PreparedAssetProjectionSubject {
  readonly hash: string;
  readonly bounds: PreparedAssetProjectionCalibration["preparedAssetBounds"];
  readonly transformOwnership: "canonical_identity_nodes";
}

export interface PreparedAssetProjectionInput {
  readonly proposal: RegionCompositionProposal;
  readonly targetId: string;
  readonly preparedAsset: PreparedAssetProjectionSubject;
  readonly projectionCamera: PreparedAssetProjectionCalibration["projectionCamera"];
  readonly projectionImage: PreparedAssetProjectionCalibration["projectionImage"];
  readonly silhouetteMask: PreparedAssetProjectionCalibration["silhouetteMask"];
  readonly candidateMaskBounds: ImageBounds;
  readonly candidateMaskCentroid: PreparedAssetProjectionCalibration["candidateMaskCentroid"];
  readonly assetToProjectionCameraRotation: CanonicalQuaternion;
  readonly renderUniformScale: number;
  readonly assetCenterDepth: number;
  readonly fit: PreparedAssetProjectionCalibration["fit"];
}

/** Bind one fixed-view silhouette measurement to exact prepared bytes and proposal masks. */
export function createPreparedAssetProjectionCalibration(
  input: PreparedAssetProjectionInput,
): PreparedAssetProjectionCalibration {
  assertRegionCompositionProposal(input.proposal);
  assertPerspectiveCameraCalibration(input.projectionCamera);
  const target = compositionTarget(input.proposal, input.targetId);
  const targetMaskBounds = unionCompositionMaskBounds(input.proposal, target.maskIds);
  const targetSpanPixels = apparentSpan(targetMaskBounds);
  const candidateSpanPixels = apparentSpan(input.candidateMaskBounds);
  const rotation = canonicalQuaternion(input.assetToProjectionCameraRotation);
  const material = {
    kind: "PreparedAssetProjectionCalibration" as const,
    abi: PREPARED_ASSET_PROJECTION_CALIBRATION_ABI,
    proposalHash: input.proposal.hash,
    targetId: target.id,
    preparedAssetHash: input.preparedAsset.hash,
    preparedAssetBounds: structuredClone(input.preparedAsset.bounds),
    preparedAssetTransformOwnership: input.preparedAsset.transformOwnership,
    targetMaskIds: [...target.maskIds],
    targetImageSize: {
      width: input.proposal.image.width,
      height: input.proposal.image.height,
    },
    targetMaskBounds,
    projectionCamera: structuredClone(input.projectionCamera),
    projectionImage: structuredClone(input.projectionImage),
    silhouetteMask: structuredClone(input.silhouetteMask),
    candidateMaskBounds: structuredClone(input.candidateMaskBounds),
    candidateMaskCentroid: structuredClone(input.candidateMaskCentroid),
    assetToProjectionCameraRotation: rotation,
    renderUniformScale: canonicalNumber(input.renderUniformScale),
    assetCenterDepth: canonicalNumber(input.assetCenterDepth),
    apparentTransfer: {
      targetSpanPixels,
      candidateSpanPixels,
      targetToCandidateRatio: canonicalNumber(targetSpanPixels / candidateSpanPixels),
      spanMetric: "geometric_mean_width_height" as const,
    },
    fit: structuredClone(input.fit),
    transformApplication:
      "projection_rotation_and_render_scale_are_measured_once_and_are_not_baked_into_prepared_nodes" as const,
    localStatus: "eligible" as const,
  };
  assertBoundedSpatialJson(material, DEFAULT_SPATIAL_ADMISSION_POLICY);
  const hash = contentHash(stableJson(material));
  const calibration = PREPARED_ASSET_PROJECTION_CALIBRATION_SCHEMA.parse({
    ...material,
    id: `prepared_projection_${hash.slice(0, 24)}`,
    hash,
  });
  assertPreparedAssetProjectionCalibration(calibration, input.proposal, input.preparedAsset);
  return calibration;
}

export function assertPreparedAssetProjectionCalibration(
  value: unknown,
  proposal?: RegionCompositionProposal,
  preparedAsset?: PreparedAssetProjectionSubject,
): asserts value is PreparedAssetProjectionCalibration {
  assertBoundedSpatialJson(value, DEFAULT_SPATIAL_ADMISSION_POLICY);
  const calibration = PREPARED_ASSET_PROJECTION_CALIBRATION_SCHEMA.parse(value);
  const { id, hash, ...material } = calibration;
  const expected = contentHash(stableJson(material));
  if (hash !== expected || id !== `prepared_projection_${expected.slice(0, 24)}`)
    throw new Error("Prepared-asset projection calibration identity mismatch");
  assertPerspectiveCameraCalibration(calibration.projectionCamera);
  if (
    calibration.projectionImage.width !== calibration.projectionCamera.width ||
    calibration.projectionImage.height !== calibration.projectionCamera.height ||
    calibration.silhouetteMask.width !== calibration.projectionCamera.width ||
    calibration.silhouetteMask.height !== calibration.projectionCamera.height
  )
    throw new Error("Prepared projection pixels do not match the projection camera");
  assertImageBounds(
    calibration.targetMaskBounds,
    calibration.targetImageSize.width,
    calibration.targetImageSize.height,
    "Proposal target mask",
  );
  assertImageBounds(
    calibration.candidateMaskBounds,
    calibration.projectionCamera.width,
    calibration.projectionCamera.height,
    "Prepared silhouette",
  );
  assertPointInside(
    calibration.candidateMaskCentroid,
    calibration.candidateMaskBounds,
    "Prepared silhouette centroid",
  );
  const targetSpan = apparentSpan(calibration.targetMaskBounds);
  const candidateSpan = apparentSpan(calibration.candidateMaskBounds);
  if (
    Math.abs(calibration.apparentTransfer.targetSpanPixels - targetSpan) > 1e-9 ||
    Math.abs(calibration.apparentTransfer.candidateSpanPixels - candidateSpan) > 1e-9 ||
    Math.abs(calibration.apparentTransfer.targetToCandidateRatio - targetSpan / candidateSpan) >
      1e-9
  )
    throw new Error("Prepared projection apparent-scale transfer is inconsistent");
  canonicalQuaternion(calibration.assetToProjectionCameraRotation);
  assertCanonicalUnique(calibration.targetMaskIds, "Prepared projection target mask IDs");

  if (proposal) {
    assertRegionCompositionProposal(proposal);
    const target = compositionTarget(proposal, calibration.targetId);
    if (
      calibration.proposalHash !== proposal.hash ||
      stableJson(calibration.targetMaskIds) !== stableJson(target.maskIds) ||
      calibration.targetImageSize.width !== proposal.image.width ||
      calibration.targetImageSize.height !== proposal.image.height ||
      stableJson(calibration.targetMaskBounds) !==
        stableJson(unionCompositionMaskBounds(proposal, target.maskIds))
    )
      throw new Error("Prepared projection calibration does not bind the proposal target");
  }
  if (
    preparedAsset &&
    (calibration.preparedAssetHash !== preparedAsset.hash ||
      stableJson(calibration.preparedAssetBounds) !== stableJson(preparedAsset.bounds) ||
      calibration.preparedAssetTransformOwnership !== preparedAsset.transformOwnership)
  )
    throw new Error("Prepared projection calibration does not bind the prepared asset");
}

/**
 * Transfer the chosen 2D view to exact surface-ray hits. These are ordered
 * visual seeds only; typed physical relations remain the admission authority.
 */
export function deriveRegionCompositionPlacementCandidates(input: {
  readonly proposal: RegionCompositionProposal;
  readonly projectionCalibration: PreparedAssetProjectionCalibration;
  readonly surfaces: PlacementSurfaceIndex;
}): RegionCompositionPlacementCandidates {
  assertRegionCompositionProposal(input.proposal);
  assertPreparedAssetProjectionCalibration(input.projectionCalibration, input.proposal);
  if (input.surfaces.hash !== input.proposal.surfaceIndexHash)
    throw new Error("Composition placement surfaces do not match the rendered world foundation");
  const target = compositionTarget(input.proposal, input.projectionCalibration.targetId);
  const maskById = new Map(input.proposal.instanceMasks.map((mask) => [mask.id, mask]));
  const visualRotation = composeCameraRelativeRotation(
    input.proposal.cameraCalibration.cameraToWorld,
    input.projectionCalibration.assetToProjectionCameraRotation,
  );
  const candidates: Array<RegionCompositionPlacementCandidates["candidates"][number]> = [];
  const failures: Array<RegionCompositionPlacementCandidates["failures"][number]> = [];

  for (const maskId of target.maskIds) {
    const mask = maskById.get(maskId)!;
    for (const anchor of mask.rayAnchors) {
      const ray = calibratedWorldRayFromCropPixel(
        input.proposal.cameraCalibration,
        input.proposal.cropSimilarity,
        anchor.pixel,
      );
      const sourcePixel = mapCropPixelToSource(input.proposal.cropSimilarity, anchor.pixel);
      for (const surfaceId of target.placementSurfaceIds) {
        const hit = input.surfaces.raycast({
          origin: ray.origin,
          direction: ray.direction,
          surfaceIds: [surfaceId],
          minimumDistance: ray.minimumDistance,
          maximumDistance: ray.maximumDistance,
        });
        if (!hit) {
          failures.push({
            maskId,
            rayAnchorId: anchor.id,
            surfaceId,
            code: "no_surface_hit",
          });
          continue;
        }
        const targetCameraDepth = projectWorldPoint(
          input.proposal.cameraCalibration,
          hit.sample.position,
        ).depth;
        const targetFocalPixels = input.proposal.cropSimilarity.effectiveFocalPixels;
        const projectionFocalPixels = input.projectionCalibration.projectionCamera.intrinsics[0];
        const apparentScaleRatio =
          input.projectionCalibration.apparentTransfer.targetToCandidateRatio;
        const uniformScale = canonicalNumber(
          (input.projectionCalibration.renderUniformScale *
            apparentScaleRatio *
            targetCameraDepth *
            projectionFocalPixels) /
            (input.projectionCalibration.assetCenterDepth * targetFocalPixels),
        );
        const hitMaterial = {
          surfaceId: hit.surfaceId,
          triangleIndex: hit.triangleIndex,
          distance: canonicalNumber(hit.distance),
          barycentricWeights: hit.barycentricWeights.map(canonicalNumber) as [
            number,
            number,
            number,
          ],
          position: canonicalVector(hit.sample.position),
          normal: canonicalVector(hit.sample.normal),
          cameraDepth: canonicalNumber(targetCameraDepth),
        };
        const candidateMaterial = {
          maskId,
          rayAnchorId: anchor.id,
          anchorRole: anchor.role,
          cropPixel: canonicalPoint(anchor.pixel),
          sourcePixel: canonicalPoint(sourcePixel),
          ray: {
            origin: canonicalVector(ray.origin),
            direction: canonicalVector(ray.direction),
            nearPoint: canonicalVector(ray.nearPoint),
            farPoint: canonicalVector(ray.farPoint),
            minimumDistance: canonicalNumber(ray.minimumDistance),
            maximumDistance: canonicalNumber(ray.maximumDistance),
          },
          hit: hitMaterial,
          suggestedTransform: {
            position: hitMaterial.position,
            rotation: visualRotation,
            uniformScale,
          },
          scaleTransfer: {
            targetFocalPixels: canonicalNumber(targetFocalPixels),
            projectionFocalPixels: canonicalNumber(projectionFocalPixels),
            targetCameraDepth: canonicalNumber(targetCameraDepth),
            projectionCameraDepth: canonicalNumber(input.projectionCalibration.assetCenterDepth),
            apparentScaleRatio: canonicalNumber(apparentScaleRatio),
            renderUniformScale: canonicalNumber(input.projectionCalibration.renderUniformScale),
            formula:
              "render_scale*apparent_ratio*target_depth*projection_focal/(projection_depth*target_focal)" as const,
          },
          authority: "advisory_seed_requires_typed_relation_solver_revalidation" as const,
        };
        const candidateHash = contentHash(stableJson(candidateMaterial));
        candidates.push({
          id: `composition_candidate_${candidateHash.slice(0, 24)}`,
          rank: -1,
          ...candidateMaterial,
        });
      }
    }
  }
  candidates.forEach((candidate, rank) => {
    candidate.rank = rank;
  });
  const material = {
    kind: "RegionCompositionPlacementCandidates" as const,
    abi: REGION_COMPOSITION_PLACEMENT_CANDIDATES_ABI,
    proposalHash: input.proposal.hash,
    worldPlanHash: input.proposal.worldPlanHash,
    projectionCalibrationHash: input.projectionCalibration.hash,
    targetId: target.id,
    preparedAssetHash: input.projectionCalibration.preparedAssetHash,
    surfaceIndexHash: input.surfaces.hash,
    targetMaskIds: [...target.maskIds],
    authority: "candidate_order_only_typed_relation_solver_is_final" as const,
    candidates,
    failures,
    status: candidates.length > 0 ? ("eligible" as const) : ("incomplete" as const),
  };
  assertBoundedSpatialJson(material, DEFAULT_SPATIAL_ADMISSION_POLICY);
  const hash = contentHash(stableJson(material));
  const result = REGION_COMPOSITION_PLACEMENT_CANDIDATES_SCHEMA.parse({
    ...material,
    id: `composition_placements_${hash.slice(0, 24)}`,
    hash,
  });
  assertRegionCompositionPlacementCandidates(
    result,
    input.proposal,
    input.projectionCalibration,
    input.surfaces,
  );
  return result;
}

export function assertRegionCompositionPlacementCandidates(
  value: unknown,
  proposal?: RegionCompositionProposal,
  projectionCalibration?: PreparedAssetProjectionCalibration,
  surfaces?: PlacementSurfaceIndex,
): asserts value is RegionCompositionPlacementCandidates {
  assertBoundedSpatialJson(value, DEFAULT_SPATIAL_ADMISSION_POLICY);
  const result = REGION_COMPOSITION_PLACEMENT_CANDIDATES_SCHEMA.parse(value);
  const { id, hash, ...material } = result;
  const expected = contentHash(stableJson(material));
  if (hash !== expected || id !== `composition_placements_${expected.slice(0, 24)}`)
    throw new Error("Region composition placement-candidate identity mismatch");
  if (result.candidates.some((candidate, rank) => candidate.rank !== rank))
    throw new Error("Region composition placement ranks must be contiguous");
  if (result.candidates.length > 0 !== (result.status === "eligible"))
    throw new Error("Region composition placement status is inconsistent");
  assertCanonicalUnique(result.targetMaskIds, "Composition placement target masks");
  assertCanonicalUnique(
    result.candidates.map((candidate) => candidate.id),
    "Composition placement candidate IDs",
    false,
  );
  assertCanonicalUnique(
    result.failures.map(
      (failure) => `${failure.maskId}:${failure.rayAnchorId}:${failure.surfaceId}`,
    ),
    "Composition placement failure keys",
    false,
  );
  for (const candidate of result.candidates) {
    const { id: candidateId, rank: _rank, ...candidateMaterial } = candidate;
    const candidateHash = contentHash(stableJson(candidateMaterial));
    if (candidateId !== `composition_candidate_${candidateHash.slice(0, 24)}`)
      throw new Error(`Composition placement candidate identity mismatch: ${candidateId}`);
    canonicalQuaternion(candidate.suggestedTransform.rotation);
    assertUnitVector(candidate.ray.direction, "Composition placement ray");
    if (!(candidate.ray.minimumDistance < candidate.ray.maximumDistance))
      throw new Error(`Composition placement ray clipping range is invalid: ${candidate.id}`);
    if (
      candidate.hit.distance < candidate.ray.minimumDistance - 1e-9 ||
      candidate.hit.distance > candidate.ray.maximumDistance + 1e-9
    )
      throw new Error(
        `Composition placement hit lies outside the rendered clip range: ${candidate.id}`,
      );
    assertUnitVector(candidate.hit.normal, "Composition placement surface normal");
    const weights = candidate.hit.barycentricWeights;
    if (
      weights.some((weight) => weight < -1e-8 || weight > 1 + 1e-8) ||
      Math.abs(weights[0] + weights[1] + weights[2] - 1) > 1e-8
    )
      throw new Error(`Composition placement barycentric weights are invalid: ${candidate.id}`);
    const transfer = candidate.scaleTransfer;
    const expectedScale =
      (transfer.renderUniformScale *
        transfer.apparentScaleRatio *
        transfer.targetCameraDepth *
        transfer.projectionFocalPixels) /
      (transfer.projectionCameraDepth * transfer.targetFocalPixels);
    if (Math.abs(candidate.suggestedTransform.uniformScale - expectedScale) > 1e-9)
      throw new Error(`Composition placement scale transfer is inconsistent: ${candidate.id}`);
    if (stableJson(candidate.suggestedTransform.position) !== stableJson(candidate.hit.position))
      throw new Error(`Composition placement support point is inconsistent: ${candidate.id}`);
  }
  if (proposal) {
    assertRegionCompositionProposal(proposal);
    const target = compositionTarget(proposal, result.targetId);
    if (
      result.proposalHash !== proposal.hash ||
      result.worldPlanHash !== proposal.worldPlanHash ||
      result.surfaceIndexHash !== proposal.surfaceIndexHash ||
      stableJson(result.targetMaskIds) !== stableJson(target.maskIds)
    )
      throw new Error("Region composition placements do not bind the proposal target");
    const maskById = new Map(proposal.instanceMasks.map((mask) => [mask.id, mask]));
    const expectedRotation = projectionCalibration
      ? composeCameraRelativeRotation(
          proposal.cameraCalibration.cameraToWorld,
          projectionCalibration.assetToProjectionCameraRotation,
        )
      : undefined;
    for (const candidate of result.candidates) {
      const mask = maskById.get(candidate.maskId);
      const anchor = mask?.rayAnchors.find((entry) => entry.id === candidate.rayAnchorId);
      if (
        !target.maskIds.includes(candidate.maskId) ||
        !anchor ||
        !target.placementSurfaceIds.includes(candidate.hit.surfaceId) ||
        anchor.role !== candidate.anchorRole
      )
        throw new Error(
          `Composition placement does not bind a target mask anchor: ${candidate.id}`,
        );
      const expectedRay = calibratedWorldRayFromCropPixel(
        proposal.cameraCalibration,
        proposal.cropSimilarity,
        anchor.pixel,
      );
      const expectedSourcePixel = mapCropPixelToSource(proposal.cropSimilarity, anchor.pixel);
      assertVectorClose(candidate.cropPixel, anchor.pixel, "Placement crop pixel");
      assertVectorClose(candidate.sourcePixel, expectedSourcePixel, "Placement source pixel");
      assertVectorClose(candidate.ray.origin, expectedRay.origin, "Placement ray origin");
      assertVectorClose(candidate.ray.direction, expectedRay.direction, "Placement ray direction");
      assertVectorClose(candidate.ray.nearPoint, expectedRay.nearPoint, "Placement ray near point");
      assertVectorClose(candidate.ray.farPoint, expectedRay.farPoint, "Placement ray far point");
      if (
        Math.abs(candidate.ray.minimumDistance - expectedRay.minimumDistance) > 1e-9 ||
        Math.abs(candidate.ray.maximumDistance - expectedRay.maximumDistance) > 1e-9
      )
        throw new Error(`Composition placement ray clip metadata mismatch: ${candidate.id}`);
      if (
        expectedRotation &&
        !quaternionClose(candidate.suggestedTransform.rotation, expectedRotation)
      )
        throw new Error(
          `Composition placement rotation does not bind the calibrated view: ${candidate.id}`,
        );
    }
    for (const failure of result.failures) {
      const mask = maskById.get(failure.maskId);
      if (
        !target.maskIds.includes(failure.maskId) ||
        !mask?.rayAnchors.some((anchor) => anchor.id === failure.rayAnchorId) ||
        !target.placementSurfaceIds.includes(failure.surfaceId)
      )
        throw new Error("Composition placement failure does not bind a target mask anchor");
    }
  }
  if (projectionCalibration) {
    assertPreparedAssetProjectionCalibration(projectionCalibration, proposal);
    if (
      result.projectionCalibrationHash !== projectionCalibration.hash ||
      result.preparedAssetHash !== projectionCalibration.preparedAssetHash ||
      result.targetId !== projectionCalibration.targetId
    )
      throw new Error("Region composition placements do not bind the projection calibration");
  }
  if (surfaces) {
    if (!proposal || !projectionCalibration)
      throw new Error("Surface replay requires the proposal and projection calibration");
    if (result.surfaceIndexHash !== surfaces.hash)
      throw new Error("Composition placement surface identity mismatch");
    assertPlacementSurfaceReplay(result, proposal, surfaces);
  }
}

function assertPlacementSurfaceReplay(
  result: RegionCompositionPlacementCandidates,
  proposal: RegionCompositionProposal,
  surfaces: PlacementSurfaceIndex,
): void {
  const target = compositionTarget(proposal, result.targetId);
  const masks = new Map(proposal.instanceMasks.map((mask) => [mask.id, mask]));
  const expectedCandidates: string[] = [];
  const expectedFailures: string[] = [];
  const candidateByKey = new Map(
    result.candidates.map((candidate) => [
      `${candidate.maskId}:${candidate.rayAnchorId}:${candidate.hit.surfaceId}`,
      candidate,
    ]),
  );
  for (const maskId of target.maskIds) {
    const mask = masks.get(maskId)!;
    for (const anchor of mask.rayAnchors) {
      const ray = calibratedWorldRayFromCropPixel(
        proposal.cameraCalibration,
        proposal.cropSimilarity,
        anchor.pixel,
      );
      for (const surfaceId of target.placementSurfaceIds) {
        const key = `${maskId}:${anchor.id}:${surfaceId}`;
        const hit = surfaces.raycast({
          origin: ray.origin,
          direction: ray.direction,
          surfaceIds: [surfaceId],
          minimumDistance: ray.minimumDistance,
          maximumDistance: ray.maximumDistance,
        });
        if (!hit) {
          expectedFailures.push(key);
          continue;
        }
        expectedCandidates.push(key);
        const candidate = candidateByKey.get(key);
        if (!candidate) throw new Error(`Composition placement omitted exact ray hit: ${key}`);
        const cameraDepth = projectWorldPoint(
          proposal.cameraCalibration,
          hit.sample.position,
        ).depth;
        if (
          candidate.hit.triangleIndex !== hit.triangleIndex ||
          Math.abs(candidate.hit.distance - hit.distance) > 1e-9 ||
          Math.abs(candidate.hit.cameraDepth - cameraDepth) > 1e-9
        )
          throw new Error(`Composition placement ray-hit metadata mismatch: ${candidate.id}`);
        assertVectorClose(candidate.hit.position, hit.sample.position, "Placement hit position");
        assertVectorClose(candidate.hit.normal, hit.sample.normal, "Placement hit normal");
        assertVectorClose(
          candidate.hit.barycentricWeights,
          hit.barycentricWeights,
          "Placement hit barycentric weights",
        );
      }
    }
  }
  const actualCandidates = result.candidates.map(
    (candidate) => `${candidate.maskId}:${candidate.rayAnchorId}:${candidate.hit.surfaceId}`,
  );
  const actualFailures = result.failures.map(
    (failure) => `${failure.maskId}:${failure.rayAnchorId}:${failure.surfaceId}`,
  );
  if (
    stableJson(actualCandidates) !== stableJson(expectedCandidates) ||
    stableJson(actualFailures) !== stableJson(expectedFailures)
  )
    throw new Error("Composition placement ordering or ray-hit accounting mismatch");
}

function apparentSpan(bounds: ImageBounds): number {
  return canonicalNumber(Math.sqrt(bounds.width * bounds.height));
}

function assertImageBounds(
  bounds: ImageBounds,
  width: number,
  height: number,
  label: string,
): void {
  if (bounds.x + bounds.width > width || bounds.y + bounds.height > height)
    throw new Error(`${label} bounds exceed its image`);
}

function assertPointInside(
  point: { readonly x: number; readonly y: number },
  bounds: ImageBounds,
  label: string,
): void {
  if (
    point.x < bounds.x ||
    point.x > bounds.x + bounds.width ||
    point.y < bounds.y ||
    point.y > bounds.y + bounds.height
  )
    throw new Error(`${label} lies outside its bounds`);
}

function canonicalQuaternion(input: CanonicalQuaternion): CanonicalQuaternion {
  const length = Math.hypot(input.x, input.y, input.z, input.w);
  if (!(length > 1e-12) || !Number.isFinite(length))
    throw new Error("Projection quaternion is invalid");
  let output = {
    x: canonicalNumber(input.x / length),
    y: canonicalNumber(input.y / length),
    z: canonicalNumber(input.z / length),
    w: canonicalNumber(input.w / length),
  };
  if (
    output.w < 0 ||
    (output.w === 0 &&
      (output.z < 0 || (output.z === 0 && (output.y < 0 || (output.y === 0 && output.x < 0)))))
  )
    output = { x: -output.x, y: -output.y, z: -output.z, w: -output.w };
  return output;
}

function composeCameraRelativeRotation(
  cameraToWorld: readonly number[],
  assetToCamera: CanonicalQuaternion,
): CanonicalQuaternion {
  const asset = quaternionMatrix(assetToCamera);
  const camera = [
    cameraToWorld[0]!,
    cameraToWorld[1]!,
    cameraToWorld[2]!,
    cameraToWorld[4]!,
    cameraToWorld[5]!,
    cameraToWorld[6]!,
    cameraToWorld[8]!,
    cameraToWorld[9]!,
    cameraToWorld[10]!,
  ];
  return matrixQuaternion(multiplyRotation(camera, asset));
}

function quaternionMatrix(value: CanonicalQuaternion): number[] {
  const { x, y, z, w } = value;
  return [
    1 - 2 * (y * y + z * z),
    2 * (x * y - z * w),
    2 * (x * z + y * w),
    2 * (x * y + z * w),
    1 - 2 * (x * x + z * z),
    2 * (y * z - x * w),
    2 * (x * z - y * w),
    2 * (y * z + x * w),
    1 - 2 * (x * x + y * y),
  ];
}

function multiplyRotation(left: readonly number[], right: readonly number[]): number[] {
  const output = new Array<number>(9).fill(0);
  for (let row = 0; row < 3; row += 1)
    for (let column = 0; column < 3; column += 1)
      for (let inner = 0; inner < 3; inner += 1)
        output[row * 3 + column]! += left[row * 3 + inner]! * right[inner * 3 + column]!;
  return output.map(canonicalNumber);
}

function matrixQuaternion(matrix: readonly number[]): CanonicalQuaternion {
  const trace = matrix[0]! + matrix[4]! + matrix[8]!;
  let quaternion: CanonicalQuaternion;
  if (trace > 0) {
    const scale = Math.sqrt(trace + 1) * 2;
    quaternion = {
      w: scale / 4,
      x: (matrix[7]! - matrix[5]!) / scale,
      y: (matrix[2]! - matrix[6]!) / scale,
      z: (matrix[3]! - matrix[1]!) / scale,
    };
  } else if (matrix[0]! > matrix[4]! && matrix[0]! > matrix[8]!) {
    const scale = Math.sqrt(1 + matrix[0]! - matrix[4]! - matrix[8]!) * 2;
    quaternion = {
      w: (matrix[7]! - matrix[5]!) / scale,
      x: scale / 4,
      y: (matrix[1]! + matrix[3]!) / scale,
      z: (matrix[2]! + matrix[6]!) / scale,
    };
  } else if (matrix[4]! > matrix[8]!) {
    const scale = Math.sqrt(1 + matrix[4]! - matrix[0]! - matrix[8]!) * 2;
    quaternion = {
      w: (matrix[2]! - matrix[6]!) / scale,
      x: (matrix[1]! + matrix[3]!) / scale,
      y: scale / 4,
      z: (matrix[5]! + matrix[7]!) / scale,
    };
  } else {
    const scale = Math.sqrt(1 + matrix[8]! - matrix[0]! - matrix[4]!) * 2;
    quaternion = {
      w: (matrix[3]! - matrix[1]!) / scale,
      x: (matrix[2]! + matrix[6]!) / scale,
      y: (matrix[5]! + matrix[7]!) / scale,
      z: scale / 4,
    };
  }
  return canonicalQuaternion(quaternion);
}

function assertUnitVector(value: WorldVector3, label: string): void {
  if (Math.abs(Math.hypot(value.x, value.y, value.z) - 1) > 1e-8)
    throw new Error(`${label} must be normalized`);
}

type NumericVector =
  readonly number[] | { readonly x: number; readonly y: number; readonly z?: number };

function assertVectorClose(actual: NumericVector, expected: NumericVector, label: string): void {
  const actualValues = vectorValues(actual);
  const expectedValues = vectorValues(expected);
  if (
    actualValues.length !== expectedValues.length ||
    actualValues.some((value, index) => Math.abs(value - expectedValues[index]!) > 1e-9)
  )
    throw new Error(`${label} mismatch`);
}

function vectorValues(value: NumericVector): readonly number[] {
  return "x" in value ? [value.x, value.y, ...(value.z === undefined ? [] : [value.z])] : value;
}

function quaternionClose(left: CanonicalQuaternion, right: CanonicalQuaternion): boolean {
  return (
    Math.abs(left.x - right.x) <= 1e-9 &&
    Math.abs(left.y - right.y) <= 1e-9 &&
    Math.abs(left.z - right.z) <= 1e-9 &&
    Math.abs(left.w - right.w) <= 1e-9
  );
}

function canonicalVector(value: WorldVector3): WorldVector3 {
  return { x: canonicalNumber(value.x), y: canonicalNumber(value.y), z: canonicalNumber(value.z) };
}

function canonicalPoint(value: { readonly x: number; readonly y: number }) {
  return { x: canonicalNumber(value.x), y: canonicalNumber(value.y) };
}

function canonicalNumber(value: number): number {
  if (!Number.isFinite(value)) throw new Error("Composition calibration value must be finite");
  return Object.is(value, -0) || Math.abs(value) < 1e-15 ? 0 : value;
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
