import {
  compareCanonicalStrings,
  contentAddressedEntityId,
  contentHash,
  stableJson,
} from "@basalt/contracts";
import {
  OccupancyIndex,
  sealOccupancyReservation,
  segmentPrimitiveVisibility,
  type SupportedVisibilityPrimitive,
} from "@basalt/spatial-core";
import {
  sampleTerrainFieldElevation,
  type ConstructedElement,
  type WorldBuild,
} from "@basalt/world-compiler";
import { worldRegionContainsPoint, type SpatialWorldPlan } from "@basalt/world-planning";
import {
  sealWorldObservationReport,
  type RefinementPolicy,
  type WorldDiagnosticRender,
  type WorldObservationReport,
} from "./contracts.js";

type Point = { readonly x: number; readonly y: number; readonly z: number };
type Bounds = { readonly min: Point; readonly max: Point };

export interface WorldVerifierExpectations {
  readonly dimensions: readonly {
    readonly structureId: string;
    readonly minimumMeters: Point;
    readonly maximumMeters: Point;
  }[];
  readonly access: readonly {
    readonly structureId: string;
    readonly routeId: string;
    readonly maximumConnectionDistanceMeters: number;
    readonly minimumWidthMeters: number;
    readonly maximumRiserHeightMeters: number;
    readonly maximumTreadDepthMeters: number;
    readonly minimumHeadroomMeters: number;
    readonly minimumApproachLengthMeters: number;
    readonly maximumApproachAngleDegrees: number;
  }[];
  readonly viewCorridors: readonly {
    readonly corridorId: string;
    readonly fromMeters: Point;
    readonly toMeters: Point;
    readonly ignoredElementIds: readonly string[];
  }[];
  readonly styles: readonly { readonly structureId: string; readonly styleProfileHash: string }[];
  readonly minimumNeighborClearanceMeters: number;
}

/**
 * Bounded geometric verification for the construction vocabulary supported today.
 * Diagnostic renders are retained as observations, while visual quality stays explicitly
 * unassessed until a creator or qualified model supplies separate evidence.
 */
export function verifyWorldBuild(input: {
  readonly plan: SpatialWorldPlan;
  readonly worldBuild: WorldBuild;
  readonly policy: RefinementPolicy;
  readonly expectations: WorldVerifierExpectations;
  readonly diagnosticRenders?: readonly WorldDiagnosticRender[];
  readonly visualAssessment?: WorldObservationReport["visualAssessment"];
}): WorldObservationReport {
  const checks: WorldObservationReport["checks"] = [];
  const structureById = new Map(
    input.worldBuild.meso.constructedStructures.map((entry) => [entry.structureId, entry] as const),
  );

  for (const expectation of input.expectations.dimensions) {
    const structure = structureById.get(expectation.structureId);
    const size = structure ? boundsSize(structure.boundsMeters) : undefined;
    const eligible =
      size !== undefined &&
      (["x", "y", "z"] as const).every(
        (axis) =>
          size[axis] >= expectation.minimumMeters[axis] &&
          size[axis] <= expectation.maximumMeters[axis],
      );
    checks.push(
      check(
        `Dimensions_${expectation.structureId}`,
        "requested_dimensions",
        expectation.structureId,
        eligible ? "eligible" : "incomplete",
        { expectation, size },
        eligible ? undefined : "Constructed dimensions are outside the requested range",
      ),
    );
  }

  for (const structure of input.worldBuild.meso.constructedStructures) {
    const region = input.plan.regions.find((entry) => entry.regionId === structure.regionId);
    const eligible = Boolean(
      region &&
      boundsCorners(structure.boundsMeters).every((entry) =>
        worldRegionContainsPoint(region, entry),
      ),
    );
    checks.push(
      check(
        `Containment_${structure.structureId}`,
        "containment",
        structure.structureId,
        eligible ? "eligible" : "incomplete",
        { bounds: structure.boundsMeters, regionId: structure.regionId },
        eligible ? undefined : "Constructed structure leaves its declared region",
      ),
    );
  }

  checks.push(neighborClearanceCheck(input));
  checks.push(...openingClearanceChecks(input.worldBuild));
  checks.push(...routeTerrainContactChecks(input.worldBuild));

  for (const expectation of input.expectations.access)
    checks.push(accessCheck(input.worldBuild, expectation));

  const allElements = input.worldBuild.meso.constructedStructures.flatMap(
    (entry) => entry.elements,
  );
  for (const corridor of input.expectations.viewCorridors) {
    const ignored = new Set(corridor.ignoredElementIds);
    const primitives: SupportedVisibilityPrimitive[] = [
      ...allElements.filter((entry) => !ignored.has(entry.elementId)).map(visibilityPrimitive),
      ...input.worldBuild.instances
        .filter((entry) => !ignored.has(entry.instanceId))
        .map((entry) => ({ kind: "unsupported" as const, bounds: entry.boundsMeters })),
    ];
    const visibility = segmentPrimitiveVisibility(
      corridor.fromMeters,
      corridor.toMeters,
      primitives,
    );
    checks.push(
      check(
        `View_${corridor.corridorId}`,
        "line_of_sight",
        corridor.corridorId,
        visibility === "clear" ? "eligible" : "incomplete",
        { ...corridor, visibility },
        visibility === "blocked"
          ? "Declared view corridor is occluded by supported geometry"
          : visibility === "unresolved"
            ? "Declared view corridor intersects geometry without an exact visibility primitive"
            : undefined,
      ),
    );
  }

  for (const expectation of input.expectations.styles) {
    const structure = structureById.get(expectation.structureId);
    const eligible = Boolean(
      structure &&
      structure.elements.every((entry) => entry.styleProfileHash === expectation.styleProfileHash),
    );
    checks.push(
      check(
        `Style_${expectation.structureId}`,
        "style_consistency",
        expectation.structureId,
        eligible ? "eligible" : "incomplete",
        expectation,
        eligible
          ? undefined
          : "Constructed elements do not reference the required style profile; this check does not assess visual harmony",
      ),
    );
  }

  const taskHashes = new Set(input.worldBuild.tasks.map((entry) => entry.taskHash));
  for (const taskHash of input.policy.protectedTaskHashes) {
    const eligible = taskHashes.has(taskHash);
    checks.push(
      check(
        `Protected_${taskHash.slice(0, 12)}`,
        "protected_hash",
        input.plan.planId,
        eligible ? "eligible" : "incomplete",
        { taskHash },
        eligible ? undefined : "Protected task hash is absent from the build",
      ),
    );
  }

  for (const kind of input.policy.requiredCheckKinds)
    if (!checks.some((entry) => entry.kind === kind))
      checks.push(
        check(
          `Missing_${kind}`,
          kind,
          input.plan.planId,
          "incomplete",
          { kind, reason: "missing_check" },
          `No ${kind} expectation was supplied`,
        ),
      );

  const visualAssessment = input.visualAssessment ?? {
    status: "unassessed" as const,
    assessor: "none" as const,
    evidenceHashes: [],
    diagnostics: ["Diagnostic renders are observations only; visual harmony has not been assessed"],
  };
  return sealWorldObservationReport({
    worldBuildHash: input.worldBuild.worldBuildHash,
    checks,
    diagnosticRenders: [...(input.diagnosticRenders ?? [])],
    visualAssessment,
    diagnostics: checks.flatMap((entry) => (entry.diagnostic ? [entry.diagnostic] : [])),
  });
}

function neighborClearanceCheck(input: {
  readonly plan: SpatialWorldPlan;
  readonly worldBuild: WorldBuild;
  readonly expectations: WorldVerifierExpectations;
}): WorldObservationReport["checks"][number] {
  const occupancy = new OccupancyIndex();
  let failure: string | undefined;
  try {
    for (const structure of input.worldBuild.meso.constructedStructures)
      occupancy.reserve(
        sealOccupancyReservation({
          sourceInstanceId: structure.structureId,
          surfaceId: structure.regionId,
          stratum: "constructed_structure",
          bounds: structure.boundsMeters,
        }),
        input.expectations.minimumNeighborClearanceMeters,
      );
    const measured = new Map(
      (input.worldBuild.micro.measuredOccupancy ?? []).map((reservation) => [
        reservation.sourceInstanceId,
        reservation,
      ]),
    );
    for (const instance of input.worldBuild.instances)
      occupancy.reserve(
        measured.get(instance.instanceId) ??
          sealOccupancyReservation({
            sourceInstanceId: instance.instanceId,
            surfaceId: instance.surfaceId ?? instance.regionId ?? "World",
            stratum: instance.sourceKind,
            bounds: instance.boundsMeters,
          }),
        input.expectations.minimumNeighborClearanceMeters,
      );
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  return check(
    "Occupancy_clearance",
    "occupancy_clearance",
    input.plan.planId,
    failure === undefined ? "eligible" : "incomplete",
    {
      reservationCount: occupancy.reservations().length,
      clearanceMeters: input.expectations.minimumNeighborClearanceMeters,
    },
    failure,
  );
}

function openingClearanceChecks(worldBuild: WorldBuild): WorldObservationReport["checks"] {
  const elements = worldBuild.meso.constructedStructures.flatMap((entry) => entry.elements);
  return worldBuild.meso.constructedStructures.flatMap((structure) =>
    structure.openings.map((opening) => {
      const ignored = new Set(opening.panelElementIds);
      const blockers = [
        ...elements
          .filter((entry) => !ignored.has(entry.elementId))
          .flatMap((entry) =>
            boundsOverlapStrict(opening.clearanceBoundsMeters, entry.boundsMeters)
              ? [entry.elementId]
              : [],
          ),
        ...worldBuild.instances.flatMap((entry) =>
          boundsOverlapStrict(opening.clearanceBoundsMeters, entry.boundsMeters)
            ? [entry.instanceId]
            : [],
        ),
      ].sort();
      return check(
        `Opening_${opening.openingId}`,
        "opening_clearance",
        opening.openingId,
        blockers.length === 0 ? "eligible" : "incomplete",
        { clearanceBoundsMeters: opening.clearanceBoundsMeters, blockers },
        blockers.length === 0
          ? undefined
          : `Opening usable space is obstructed by ${blockers.join(", ")}`,
      );
    }),
  );
}

function accessCheck(
  worldBuild: WorldBuild,
  expectation: WorldVerifierExpectations["access"][number],
): WorldObservationReport["checks"][number] {
  const structure = worldBuild.meso.constructedStructures.find(
    (entry) => entry.structureId === expectation.structureId,
  );
  const route = worldBuild.foundation.routeConstructions.find(
    (entry) => entry.routeId === expectation.routeId,
  );
  const path = structure?.accessPaths.find((entry) => entry.entryRouteId === expectation.routeId);
  const failures: string[] = [];
  if (!structure) failures.push("structure is missing");
  if (!route) failures.push("approach route is missing");
  if (!path) failures.push("declared stair access path is missing");
  if (structure && route && path) {
    const elementById = new Map(
      structure.elements.map((entry) => [entry.elementId, entry] as const),
    );
    const steps = path.stepElementIds.map((id) => elementById.get(id));
    const landing = elementById.get(path.landingElementId);
    if (steps.some((entry) => entry === undefined))
      failures.push("access path references a missing step");
    if (!landing) failures.push("access path references a missing landing");
    const routeDistance = Math.min(
      ...route.travelSegments.map((segment) =>
        pointBoundsDistance(path.entryMeters, segment.boundsMeters),
      ),
    );
    if (routeDistance > expectation.maximumConnectionDistanceMeters)
      failures.push("stair entry does not meet the approach route");
    const routeLength = route.travelSegments.at(-1)?.endStationMeters ?? 0;
    if (routeLength < expectation.minimumApproachLengthMeters)
      failures.push("approach route is shorter than the required usable approach");
    const closestSegment = [...route.travelSegments].sort(
      (left, right) =>
        pointBoundsDistance(path.entryMeters, left.boundsMeters) -
          pointBoundsDistance(path.entryMeters, right.boundsMeters) ||
        compareCanonicalStrings(left.segmentId, right.segmentId),
    )[0];
    if (closestSegment) {
      const start = midpoint(
        closestSegment.vertices[0]!.positionMeters,
        closestSegment.vertices[1]!.positionMeters,
      );
      const end = midpoint(
        closestSegment.vertices[2]!.positionMeters,
        closestSegment.vertices[3]!.positionMeters,
      );
      const routeDirection = horizontalUnit(subtract(end, start));
      const stairDirection = horizontalUnit(subtract(path.exitMeters, path.entryMeters));
      const cosine = Math.max(-1, Math.min(1, Math.abs(dot(routeDirection, stairDirection))));
      const approachAngleDegrees = (Math.acos(cosine) * 180) / Math.PI;
      if (approachAngleDegrees > expectation.maximumApproachAngleDegrees)
        failures.push("approach route does not align with the stair entry");
    }
    if (path.widthMeters < expectation.minimumWidthMeters)
      failures.push("stair width is below the required minimum");
    if (path.riserHeightMeters > expectation.maximumRiserHeightMeters)
      failures.push("stair riser exceeds the allowed maximum");
    if (path.treadDepthMeters > expectation.maximumTreadDepthMeters)
      failures.push("stair tread exceeds the allowed maximum");
    if (path.minimumHeadroomMeters < expectation.minimumHeadroomMeters)
      failures.push("declared stair headroom is below the required minimum");
    const presentSteps = steps.filter((entry): entry is ConstructedElement => Boolean(entry));
    if (presentSteps.length > 0) {
      if (
        pointBoundsDistance(path.entryMeters, presentSteps[0]!.boundsMeters) >
        Math.hypot(path.treadDepthMeters, path.riserHeightMeters) + 1e-6
      )
        failures.push("ground-to-first-step transition is discontinuous");
      for (let index = 1; index < presentSteps.length; index += 1) {
        const previous = presentSteps[index - 1]!;
        const current = presentSteps[index]!;
        if (
          Math.abs(current.boundsMeters.max.y - previous.boundsMeters.max.y) >
            expectation.maximumRiserHeightMeters + 1e-6 ||
          horizontalBoundsDistance(previous.boundsMeters, current.boundsMeters) >
            expectation.maximumTreadDepthMeters + 1e-6
        )
          failures.push(`step transition ${index - 1}->${index} is discontinuous`);
      }
      if (
        landing &&
        pointBoundsDistance(path.exitMeters, landing.boundsMeters) >
          expectation.maximumTreadDepthMeters + 1e-6
      )
        failures.push("last-step-to-landing transition is discontinuous");
      const stairIds = new Set(path.stepElementIds);
      const headroomBlockers = presentSteps.flatMap((step) => {
        const clearance = {
          min: { ...step.boundsMeters.min, y: step.boundsMeters.max.y },
          max: {
            ...step.boundsMeters.max,
            y: step.boundsMeters.max.y + expectation.minimumHeadroomMeters,
          },
        };
        return structure.elements.flatMap((candidate) =>
          !stairIds.has(candidate.elementId) &&
          candidate.elementId !== path.landingElementId &&
          boundsOverlapStrict(clearance, candidate.boundsMeters)
            ? [candidate.elementId]
            : [],
        );
      });
      if (headroomBlockers.length > 0)
        failures.push(
          `stair headroom is blocked by ${[...new Set(headroomBlockers)].sort().join(", ")}`,
        );
    }
  }
  return check(
    `Access_${expectation.structureId}`,
    "ground_access",
    expectation.structureId,
    failures.length === 0 ? "eligible" : "incomplete",
    { expectation, accessPathHash: path?.hash, failures },
    failures.length === 0
      ? undefined
      : `No continuous bounded route-to-platform path: ${failures.join("; ")}`,
  );
}

function routeTerrainContactChecks(worldBuild: WorldBuild): WorldObservationReport["checks"] {
  return worldBuild.foundation.routeConstructions.map((route) => {
    const field = worldBuild.foundation.terrainFields.find(
      (candidate) => candidate.surfaceId === route.surfaceId,
    );
    const surface = worldBuild.foundation.placementSurfaces.find(
      (candidate) => candidate.surfaceId === route.surfaceId,
    );
    const baseField = field
      ? worldBuild.foundation.baseTerrainFields.find(
          (candidate) => candidate.hash === field.baseTerrainFieldHash,
        )
      : undefined;
    const failures = [...route.diagnostics];
    if (route.status !== "eligible") failures.push(`route construction is ${route.status}`);
    if (!field && !surface) failures.push("route surface evidence is missing");
    if (field && !baseField) failures.push("route base-terrain evidence is missing");
    const probeSpacingMeters = field
      ? terrainFieldMinimumSpacing(baseField!) / 2
      : Math.max(0.01, route.widthMeters / 4);
    const probeBudget = 100_000;
    const probes: Point[] = [];
    for (const segment of route.travelSegments) {
      const segmentProbes = routeSurfaceProbes(
        segment.vertices.map((entry) => entry.positionMeters) as [Point, Point, Point, Point],
        probeSpacingMeters,
        probeBudget - probes.length,
      );
      if (!segmentProbes) {
        failures.push(`route surface probe budget ${probeBudget} would be exceeded`);
        break;
      }
      probes.push(...segmentProbes);
    }
    let minimumObservedClearanceMeters: number | null = null;
    let maximumObservedClearanceMeters: number | null = null;
    const requiredClearanceMeters =
      route.terrainTreatment.kind === "grade"
        ? route.terrainTreatment.surfaceRevealMeters
        : route.treatmentKind === "elevated"
          ? Math.min(
              ...route.profile.map(
                (station) =>
                  station.centerTopMeters.y -
                  route.thicknessMeters -
                  station.baseTerrainElevationMeters,
              ),
            )
          : 0;
    const maximumGroundedBodyGapMeters =
      route.terrainTreatment.kind === "grade"
        ? route.terrainTreatment.groundingToleranceMeters
        : null;
    if ((field || surface) && failures.length === 0)
      for (const probe of probes) {
        const terrainElevationMeters = field
          ? sampleTerrainFieldElevation(
              field,
              baseField!,
              worldBuild.foundation.routeConstructions,
              worldBuild.foundation.routeJunctions,
              probe.x,
              probe.z,
            )
          : surface!.bounds.max.y;
        const clearanceMeters = probe.y - terrainElevationMeters;
        minimumObservedClearanceMeters =
          minimumObservedClearanceMeters === null
            ? clearanceMeters
            : Math.min(minimumObservedClearanceMeters, clearanceMeters);
        maximumObservedClearanceMeters =
          maximumObservedClearanceMeters === null
            ? clearanceMeters
            : Math.max(maximumObservedClearanceMeters, clearanceMeters);
        if (clearanceMeters + 1e-6 < requiredClearanceMeters) {
          failures.push(
            `route surface clearance ${clearanceMeters.toFixed(6)}m is below ${requiredClearanceMeters.toFixed(6)}m`,
          );
          break;
        }
        const bodyGapMeters = Math.max(0, clearanceMeters - route.thicknessMeters);
        if (
          maximumGroundedBodyGapMeters !== null &&
          bodyGapMeters > maximumGroundedBodyGapMeters + 1e-6
        ) {
          failures.push(
            `grounded route body gap ${bodyGapMeters.toFixed(6)}m exceeds ${maximumGroundedBodyGapMeters.toFixed(6)}m`,
          );
          break;
        }
      }
    return check(
      `TerrainContact_${route.routeId}`,
      "terrain_contact",
      route.routeId,
      failures.length === 0 ? "eligible" : "incomplete",
      {
        routeConstructionHash: route.hash,
        baseTerrainFieldHash: route.baseTerrainFieldHash,
        finalTerrainFieldHash: field?.hash,
        requiredClearanceMeters,
        maximumGroundedBodyGapMeters,
        minimumObservedClearanceMeters,
        maximumObservedClearanceMeters,
        probeCount: probes.length,
        failures,
      },
      failures.length === 0
        ? undefined
        : `Route corridor construction is unresolved: ${failures.join("; ")}`,
    );
  });
}

function terrainFieldMinimumSpacing(
  field: WorldBuild["foundation"]["baseTerrainFields"][number],
): number {
  const axes = [
    [...new Set(field.samples.map((sample) => sample.xMeters))].sort((left, right) => left - right),
    [...new Set(field.samples.map((sample) => sample.zMeters))].sort((left, right) => left - right),
  ];
  const spacing = Math.min(
    ...axes.flatMap((coordinates) =>
      coordinates.slice(1).map((value, index) => value - coordinates[index]!),
    ),
  );
  if (!Number.isFinite(spacing) || spacing <= 0)
    throw new Error(`Terrain field ${field.terrainPlanId} has invalid sample spacing`);
  return spacing;
}

function routeSurfaceProbes(
  vertices: readonly [Point, Point, Point, Point],
  maximumSpacingMeters: number,
  maximumProbeCount: number,
): Point[] | undefined {
  if (!Number.isFinite(maximumSpacingMeters) || maximumSpacingMeters <= 0)
    throw new Error("Route surface probe spacing must be positive");
  const [startLeft, startRight, endLeft, endRight] = vertices;
  const longitudinalSections = Math.max(
    2,
    Math.ceil(
      Math.max(pointDistance(startLeft, endLeft), pointDistance(startRight, endRight)) /
        maximumSpacingMeters,
    ),
  );
  const lateralSections = Math.max(
    2,
    Math.ceil(
      Math.max(pointDistance(startLeft, startRight), pointDistance(endLeft, endRight)) /
        maximumSpacingMeters,
    ),
  );
  if ((longitudinalSections + 1) * (lateralSections + 1) > maximumProbeCount) return undefined;
  const result: Point[] = [];
  for (let longitudinal = 0; longitudinal <= longitudinalSections; longitudinal += 1) {
    const along = longitudinal / longitudinalSections;
    const left = lerpPoint(startLeft, endLeft, along);
    const right = lerpPoint(startRight, endRight, along);
    for (let lateral = 0; lateral <= lateralSections; lateral += 1)
      result.push(lerpPoint(left, right, lateral / lateralSections));
  }
  return result;
}

function visibilityPrimitive(element: ConstructedElement): SupportedVisibilityPrimitive {
  return element.geometry.kind === "box"
    ? { kind: "box", bounds: element.boundsMeters }
    : {
        kind: "vertical_cylinder",
        center: element.geometry.centerMeters,
        radius: element.geometry.radiusMeters,
        height: element.geometry.heightMeters,
      };
}

function check(
  checkLabel: string,
  kind: WorldObservationReport["checks"][number]["kind"],
  subjectId: string,
  status: WorldObservationReport["checks"][number]["status"],
  evidence: unknown,
  diagnostic?: string,
): WorldObservationReport["checks"][number] {
  const evidenceHash = contentHash(stableJson(evidence));
  return {
    checkId: contentAddressedEntityId("Check", {
      checkLabel,
      kind,
      subjectId,
      evidenceHash,
    }),
    kind,
    subjectId,
    status,
    evidenceHash,
    ...(diagnostic ? { diagnostic } : {}),
  };
}

function boundsSize(bounds: Bounds): Point {
  return {
    x: bounds.max.x - bounds.min.x,
    y: bounds.max.y - bounds.min.y,
    z: bounds.max.z - bounds.min.z,
  };
}

function boundsCorners(bounds: Bounds): Point[] {
  return [bounds.min.x, bounds.max.x].flatMap((x) =>
    [bounds.min.y, bounds.max.y].flatMap((y) =>
      [bounds.min.z, bounds.max.z].map((z) => ({ x, y, z })),
    ),
  );
}

function pointBoundsDistance(point: Point, bounds: Bounds): number {
  const axis = (value: number, minimum: number, maximum: number) =>
    value < minimum ? minimum - value : value > maximum ? value - maximum : 0;
  return Math.hypot(
    axis(point.x, bounds.min.x, bounds.max.x),
    axis(point.y, bounds.min.y, bounds.max.y),
    axis(point.z, bounds.min.z, bounds.max.z),
  );
}

function horizontalBoundsDistance(left: Bounds, right: Bounds): number {
  const axis = (leftMin: number, leftMax: number, rightMin: number, rightMax: number) =>
    leftMax < rightMin ? rightMin - leftMax : rightMax < leftMin ? leftMin - rightMax : 0;
  return Math.hypot(
    axis(left.min.x, left.max.x, right.min.x, right.max.x),
    axis(left.min.z, left.max.z, right.min.z, right.max.z),
  );
}

function boundsOverlapStrict(left: Bounds, right: Bounds): boolean {
  return (["x", "y", "z"] as const).every(
    (axis) =>
      Math.min(left.max[axis], right.max[axis]) - Math.max(left.min[axis], right.min[axis]) > 1e-9,
  );
}

function midpoint(left: Point, right: Point): Point {
  return lerpPoint(left, right, 0.5);
}

function lerpPoint(left: Point, right: Point, amount: number): Point {
  return {
    x: left.x + (right.x - left.x) * amount,
    y: left.y + (right.y - left.y) * amount,
    z: left.z + (right.z - left.z) * amount,
  };
}

function pointDistance(left: Point, right: Point): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

function subtract(left: Point, right: Point): Point {
  return { x: left.x - right.x, y: left.y - right.y, z: left.z - right.z };
}

function dot(left: Point, right: Point): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function horizontalUnit(value: Point): Point {
  const length = Math.hypot(value.x, value.z);
  if (length <= 1e-9) throw new Error("Access direction has no horizontal extent");
  return { x: value.x / length, y: 0, z: value.z / length };
}
