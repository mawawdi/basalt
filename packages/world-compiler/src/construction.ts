import { contentHash, stableJson } from "@basalt/contracts";
import { sealOccupancyReservation, type OccupancyReservation } from "@basalt/spatial-core";
import {
  CONSTRUCTION_PROGRAM_SCHEMA,
  constructionParameterMap,
  resolveConstructionInteger,
  resolveConstructionScalar,
  type ConstructionOperation,
  type ConstructionProgram,
} from "@basalt/world-planning";
import {
  sealConstructedAttachmentArtifact,
  sealConstructedAccessPath,
  sealConstructedElement,
  sealConstructedOpeningArtifact,
  sealConstructedPortalArtifact,
  sealConstructedStructureArtifact,
  sealDeclarativeConstructedSurface,
  type ConstructedElement,
  type ConstructedOpeningArtifact,
  type ConstructedStructureArtifact,
} from "./world-build.js";

type Point = { readonly x: number; readonly y: number; readonly z: number };
type Bounds = { readonly min: Point; readonly max: Point };
type Primitive = Extract<ConstructionOperation, { kind: "box" | "cylinder" }>;

export interface ResolvedConstructionPlacement {
  readonly anchorPositionMeters: Point;
  readonly evidenceHash: string;
  readonly surfaceId?: string;
}

export function realizeConstructionProgram(
  programInput: ConstructionProgram,
  placement: ResolvedConstructionPlacement,
): ConstructedStructureArtifact {
  const program = CONSTRUCTION_PROGRAM_SCHEMA.parse(programInput);
  const parameters = constructionParameterMap(program);
  const operations = new Map(
    program.operations.map((entry) => [entry.operationId, entry] as const),
  );
  const openingByHost = new Map(
    program.operations
      .filter((entry) => entry.kind === "rectangular_opening")
      .map((entry) => [entry.hostOperationId, entry] as const),
  );
  const elements: ConstructedElement[] = [];
  const elementsByOperation = new Map<string, ConstructedElement[]>();
  const openings: ConstructedOpeningArtifact[] = [];
  const addElement = (operationId: string, element: ConstructedElement) => {
    elements.push(element);
    elementsByOperation.set(operationId, [
      ...(elementsByOperation.get(operationId) ?? []),
      element,
    ]);
  };

  for (const operation of program.operations) {
    if (operation.kind === "box" || operation.kind === "cylinder") {
      if (operation.templateOnly || openingByHost.has(operation.operationId)) continue;
      addElement(operation.operationId, realizePrimitive(program, placement, operation));
      continue;
    }
    if (operation.kind === "linear_repeat") {
      const source = operations.get(operation.sourceOperationId);
      if (!source || (source.kind !== "box" && source.kind !== "cylinder"))
        throw new Error(`Repeat ${operation.operationId} has no primitive template`);
      const count = resolveConstructionInteger(operation.count, parameters);
      if (!Number.isSafeInteger(count) || count < 1 || count > 65_536)
        throw new Error(`Repeat ${operation.operationId} count is outside its bounded range`);
      const step = rotateLocalVector(resolveVector(operation.stepMeters, program), program);
      for (let index = 0; index < count; index += 1)
        addElement(
          operation.operationId,
          realizePrimitive(program, placement, source, {
            operationId: operation.operationId,
            repetitionIndex: index,
            offset: scale(step, index),
            ...(operation.appearance ? { appearance: operation.appearance } : {}),
          }),
        );
      continue;
    }
    if (operation.kind === "rectangular_opening") {
      const host = operations.get(operation.hostOperationId);
      if (!host || host.kind !== "box")
        throw new Error(`Opening ${operation.operationId} has no box host`);
      const result = realizeOpening(program, placement, host, operation);
      for (const element of result.elements) addElement(operation.operationId, element);
      openings.push(result.opening);
      continue;
    }
    if (operation.kind === "stair_run") {
      for (const element of realizeStairs(program, placement, operation))
        addElement(operation.operationId, element);
    }
  }
  if (elements.length === 0)
    throw new Error(`Construction program ${program.programId} emits no geometry`);

  const surfaces = elements.flatMap((element) => surfacesForElement(program, element));
  const portals = openings.flatMap((opening) => {
    if (!opening.portalId) return [];
    return [
      sealConstructedPortalArtifact({
        portalId: opening.portalId,
        constructionProgramHash: program.programHash,
        openingHash: opening.hash,
        boundsMeters: opening.boundsMeters,
        clearanceMeters: opening.clearanceMeters,
      }),
    ];
  });
  const attachments = program.operations.flatMap((operation) => {
    if (operation.kind !== "surface_attachment") return [];
    const host = elementsByOperation.get(operation.hostOperationId)?.[0];
    const child = elementsByOperation.get(operation.childOperationId)?.[0];
    if (!host || !child)
      throw new Error(
        `Attachment ${operation.operationId} references geometry that was not emitted`,
      );
    const hostFace = rotateFace(operation.hostFace, program.localFrame.yawQuarterTurns);
    const childFace = rotateFace(operation.childFace, program.localFrame.yawQuarterTurns);
    if (oppositeFace(hostFace) !== childFace)
      throw new Error(`Attachment ${operation.operationId} faces are not opposed`);
    const measuredGapMeters = Math.abs(
      faceCoordinate(host.boundsMeters, hostFace) - faceCoordinate(child.boundsMeters, childFace),
    );
    const maximumGapMeters = resolveConstructionScalar(operation.maximumGapMeters, parameters);
    if (maximumGapMeters < 0 || measuredGapMeters > maximumGapMeters + 1e-9)
      throw new Error(`Attachment ${operation.operationId} exceeds its maximum surface gap`);
    if (!facesOverlap(host.boundsMeters, child.boundsMeters, hostFace))
      throw new Error(`Attachment ${operation.operationId} has no overlapping contact footprint`);
    return [
      sealConstructedAttachmentArtifact({
        constructionProgramHash: program.programHash,
        operationId: operation.operationId,
        hostElementId: host.elementId,
        childElementId: child.elementId,
        hostFace,
        childFace,
        measuredGapMeters,
        maximumGapMeters,
      }),
    ];
  });
  const accessPaths = program.operations.flatMap((operation) => {
    if (operation.kind !== "stair_run") return [];
    const steps = elementsByOperation.get(operation.operationId) ?? [];
    const landing = elementsByOperation.get(operation.landingOperationId)?.[0];
    if (steps.length === 0 || !landing)
      throw new Error(`Stair run ${operation.operationId} lacks steps or its declared landing`);
    const dimensions = resolvedStairDimensions(program, operation);
    const localDirection = directionVector(operation.direction);
    const direction = rotateLocalVector(localDirection, program);
    const localOrigin = resolveVector(operation.originMeters, program);
    const entryMeters = localPointToWorld(localOrigin, program, placement.anchorPositionMeters);
    const exitMeters = {
      x: entryMeters.x + direction.x * dimensions.run,
      y: entryMeters.y + dimensions.rise,
      z: entryMeters.z + direction.z * dimensions.run,
    };
    if (pointBoundsDistance(exitMeters, landing.boundsMeters) > dimensions.treadDepth + 1e-6)
      throw new Error(`Stair run ${operation.operationId} does not terminate at its landing`);
    return [
      sealConstructedAccessPath({
        constructionProgramHash: program.programHash,
        stairOperationId: operation.operationId,
        entryRouteId: operation.entryRouteId,
        landingElementId: landing.elementId,
        stepElementIds: steps.map((entry) => entry.elementId),
        entryMeters,
        exitMeters,
        widthMeters: dimensions.width,
        riserHeightMeters: dimensions.riserHeight,
        treadDepthMeters: dimensions.treadDepth,
        minimumHeadroomMeters: dimensions.minimumHeadroom,
      }),
    ];
  });
  const occupancyReservations = elements.map((element) =>
    sealOccupancyReservation({
      sourceInstanceId: element.elementId,
      surfaceId: program.programId,
      stratum: "constructed_geometry",
      bounds: element.boundsMeters,
    }),
  );
  return sealConstructedStructureArtifact({
    regionId: program.regionId,
    constructionProgramHash: program.programHash,
    semanticDependencyClosureHash: program.semanticDependencyClosureHash,
    resolvedAnchorMeters: placement.anchorPositionMeters,
    placementEvidenceHash: placement.evidenceHash,
    ...(placement.surfaceId ? { placementSurfaceId: placement.surfaceId } : {}),
    elements,
    surfaces,
    openings,
    portals,
    attachments,
    accessPaths,
    occupancyReservations,
    boundsMeters: mergeBounds(elements.map((entry) => entry.boundsMeters)),
    evidenceHashes: [
      program.programHash,
      placement.evidenceHash,
      ...elements.map((entry) => entry.hash),
      ...openings.map((entry) => entry.hash),
      ...portals.map((entry) => entry.hash),
      ...attachments.map((entry) => entry.hash),
      ...accessPaths.map((entry) => entry.hash),
      ...program.contributionEvidenceHashes,
    ],
  });
}

function realizePrimitive(
  program: ConstructionProgram,
  placement: ResolvedConstructionPlacement,
  primitive: Primitive,
  override: {
    readonly operationId?: string;
    readonly repetitionIndex?: number;
    readonly offset?: Point;
    readonly appearance?: ConstructionProgram["defaultAppearance"];
  } = {},
): ConstructedElement {
  const offset = override.offset ?? { x: 0, y: 0, z: 0 };
  const center = add(
    localPointToWorld(
      resolveVector(primitive.centerMeters, program),
      program,
      placement.anchorPositionMeters,
    ),
    offset,
  );
  const appearance = override.appearance ?? primitive.appearance ?? program.defaultAppearance;
  const operationId = override.operationId ?? primitive.operationId;
  if (primitive.kind === "box") {
    const size = rotateLocalSize(resolveVector(primitive.sizeMeters, program), program);
    requirePositiveVector(size, `box ${operationId}`);
    const geometry = { kind: "box" as const, centerMeters: center, sizeMeters: size };
    return sealConstructedElement({
      constructionProgramHash: program.programHash,
      operationId,
      ...(override.repetitionIndex === undefined
        ? {}
        : { repetitionIndex: override.repetitionIndex }),
      elementRole: "solid",
      geometry,
      boundsMeters: boxBounds(center, size),
      appearance,
      styleProfileHash: program.styleProfileHash,
      evidenceHashes: [program.programHash, contentHash(stableJson(primitive))],
    });
  }
  const radiusMeters = resolveConstructionScalar(
    primitive.radiusMeters,
    constructionParameterMap(program),
  );
  const heightMeters = resolveConstructionScalar(
    primitive.heightMeters,
    constructionParameterMap(program),
  );
  if (radiusMeters <= 0 || heightMeters <= 0)
    throw new Error(`cylinder ${operationId} requires positive dimensions`);
  const geometry = {
    kind: "cylinder" as const,
    centerMeters: center,
    radiusMeters,
    heightMeters,
    sides: primitive.sides,
  };
  return sealConstructedElement({
    constructionProgramHash: program.programHash,
    operationId,
    ...(override.repetitionIndex === undefined
      ? {}
      : { repetitionIndex: override.repetitionIndex }),
    elementRole: "solid",
    geometry,
    boundsMeters: boxBounds(center, { x: radiusMeters * 2, y: heightMeters, z: radiusMeters * 2 }),
    appearance,
    styleProfileHash: program.styleProfileHash,
    evidenceHashes: [program.programHash, contentHash(stableJson(primitive))],
  });
}

function realizeOpening(
  program: ConstructionProgram,
  placement: ResolvedConstructionPlacement,
  host: Extract<ConstructionOperation, { kind: "box" }>,
  operation: Extract<ConstructionOperation, { kind: "rectangular_opening" }>,
): {
  readonly elements: readonly ConstructedElement[];
  readonly opening: ConstructedOpeningArtifact;
} {
  const parameters = constructionParameterMap(program);
  const hostCenter = localPointToWorld(
    resolveVector(host.centerMeters, program),
    program,
    placement.anchorPositionMeters,
  );
  const localHostSize = resolveVector(host.sizeMeters, program);
  requirePositiveVector(localHostSize, `opening host ${host.operationId}`);
  const width = resolveConstructionScalar(operation.sizeMeters.width, parameters);
  const height = resolveConstructionScalar(operation.sizeMeters.height, parameters);
  const horizontal = resolveConstructionScalar(operation.centerOffsetMeters.horizontal, parameters);
  const vertical = resolveConstructionScalar(operation.centerOffsetMeters.vertical, parameters);
  const clearanceMeters = resolveConstructionScalar(operation.clearanceMeters, parameters);
  if (width <= 0 || height <= 0 || clearanceMeters < 0)
    throw new Error(`Opening ${operation.operationId} has invalid dimensions`);
  const hostWidth = operation.plane === "xy" ? localHostSize.x : localHostSize.z;
  if (
    horizontal - width / 2 <= -hostWidth / 2 ||
    horizontal + width / 2 >= hostWidth / 2 ||
    vertical - height / 2 <= -localHostSize.y / 2 ||
    vertical + height / 2 >= localHostSize.y / 2
  )
    throw new Error(`Opening ${operation.operationId} must lie strictly inside its host`);
  const left = horizontal - width / 2 + hostWidth / 2;
  const right = hostWidth / 2 - (horizontal + width / 2);
  const bottom = vertical - height / 2 + localHostSize.y / 2;
  const top = localHostSize.y / 2 - (vertical + height / 2);
  const panelSpecs =
    operation.plane === "xy"
      ? [
          {
            suffix: "left",
            center: { x: -localHostSize.x / 2 + left / 2, y: 0, z: 0 },
            size: { x: left, y: localHostSize.y, z: localHostSize.z },
          },
          {
            suffix: "right",
            center: { x: localHostSize.x / 2 - right / 2, y: 0, z: 0 },
            size: { x: right, y: localHostSize.y, z: localHostSize.z },
          },
          {
            suffix: "bottom",
            center: { x: horizontal, y: -localHostSize.y / 2 + bottom / 2, z: 0 },
            size: { x: width, y: bottom, z: localHostSize.z },
          },
          {
            suffix: "top",
            center: { x: horizontal, y: localHostSize.y / 2 - top / 2, z: 0 },
            size: { x: width, y: top, z: localHostSize.z },
          },
        ]
      : [
          {
            suffix: "left",
            center: { x: 0, y: 0, z: -localHostSize.z / 2 + left / 2 },
            size: { x: localHostSize.x, y: localHostSize.y, z: left },
          },
          {
            suffix: "right",
            center: { x: 0, y: 0, z: localHostSize.z / 2 - right / 2 },
            size: { x: localHostSize.x, y: localHostSize.y, z: right },
          },
          {
            suffix: "bottom",
            center: { x: 0, y: -localHostSize.y / 2 + bottom / 2, z: horizontal },
            size: { x: localHostSize.x, y: bottom, z: width },
          },
          {
            suffix: "top",
            center: { x: 0, y: localHostSize.y / 2 - top / 2, z: horizontal },
            size: { x: localHostSize.x, y: top, z: width },
          },
        ];
  const appearance = operation.appearance ?? host.appearance ?? program.defaultAppearance;
  const elements = panelSpecs.map((panel, repetitionIndex) => {
    const center = add(hostCenter, rotateLocalVector(panel.center, program));
    const panelSize = rotateLocalSize(panel.size, program);
    const geometry = { kind: "box" as const, centerMeters: center, sizeMeters: panelSize };
    return sealConstructedElement({
      constructionProgramHash: program.programHash,
      operationId: operation.operationId,
      repetitionIndex,
      elementRole: "opening_panel",
      geometry,
      boundsMeters: boxBounds(center, panelSize),
      appearance,
      styleProfileHash: program.styleProfileHash,
      evidenceHashes: [
        program.programHash,
        contentHash(stableJson({ host, operation, panel: panel.suffix })),
      ],
    });
  });
  const apertureCenter = add(
    hostCenter,
    rotateLocalVector(
      operation.plane === "xy"
        ? { x: horizontal, y: vertical, z: 0 }
        : { x: 0, y: vertical, z: horizontal },
      program,
    ),
  );
  const apertureSize = rotateLocalSize(
    operation.plane === "xy"
      ? { x: width, y: height, z: localHostSize.z }
      : { x: localHostSize.x, y: height, z: width },
    program,
  );
  const apertureBounds = boxBounds(apertureCenter, apertureSize);
  const localClearanceSize =
    operation.plane === "xy"
      ? { x: width, y: height, z: localHostSize.z + clearanceMeters * 2 }
      : { x: localHostSize.x + clearanceMeters * 2, y: height, z: width };
  const opening = sealConstructedOpeningArtifact({
    constructionProgramHash: program.programHash,
    operationId: operation.operationId,
    hostOperationId: host.operationId,
    panelElementIds: elements.map((entry) => entry.elementId),
    boundsMeters: apertureBounds,
    clearanceBoundsMeters: boxBounds(apertureCenter, rotateLocalSize(localClearanceSize, program)),
    ...(operation.portalId ? { portalId: operation.portalId } : {}),
    clearanceMeters,
  });
  return { elements, opening };
}

function realizeStairs(
  program: ConstructionProgram,
  placement: ResolvedConstructionPlacement,
  operation: Extract<ConstructionOperation, { kind: "stair_run" }>,
): readonly ConstructedElement[] {
  const origin = localPointToWorld(
    resolveVector(operation.originMeters, program),
    program,
    placement.anchorPositionMeters,
  );
  const dimensions = resolvedStairDimensions(program, operation);
  const { width, run, rise } = dimensions;
  if ([width, run, rise].some((value) => value <= 0))
    throw new Error(`Stair run ${operation.operationId} requires positive dimensions`);
  const count = dimensions.stepCount;
  if (count > 65_536) throw new Error(`Stair run ${operation.operationId} exceeds its step budget`);
  const tread = dimensions.treadDepth;
  const riser = dimensions.riserHeight;
  return Array.from({ length: count }, (_, index) => {
    const along = tread * (index + 0.5);
    const top = riser * (index + 1);
    const direction = rotateLocalVector(directionVector(operation.direction), program);
    const center = {
      x: origin.x + direction.x * along,
      y: origin.y + top - riser / 2,
      z: origin.z + direction.z * along,
    };
    const size =
      Math.abs(direction.x) > 0
        ? { x: tread, y: riser, z: width }
        : { x: width, y: riser, z: tread };
    const geometry = { kind: "box" as const, centerMeters: center, sizeMeters: size };
    return sealConstructedElement({
      constructionProgramHash: program.programHash,
      operationId: operation.operationId,
      repetitionIndex: index,
      elementRole: "stair_step",
      geometry,
      boundsMeters: boxBounds(center, size),
      appearance: operation.appearance ?? program.defaultAppearance,
      styleProfileHash: program.styleProfileHash,
      evidenceHashes: [program.programHash, contentHash(stableJson(operation))],
    });
  });
}

function surfacesForElement(program: ConstructionProgram, element: ConstructedElement) {
  if (element.geometry.kind !== "box") return [];
  const normals = [
    ["negative_x", { x: -1, y: 0, z: 0 }],
    ["negative_y", { x: 0, y: -1, z: 0 }],
    ["negative_z", { x: 0, y: 0, z: -1 }],
    ["positive_x", { x: 1, y: 0, z: 0 }],
    ["positive_y", { x: 0, y: 1, z: 0 }],
    ["positive_z", { x: 0, y: 0, z: 1 }],
  ] as const;
  return normals.map(([face, normal]) => {
    const bounds = faceBounds(element.boundsMeters, face);
    return sealDeclarativeConstructedSurface({
      constructionProgramHash: program.programHash,
      sourceElementId: element.elementId,
      face,
      boundsMeters: bounds,
      normal,
    });
  });
}

function resolvedStairDimensions(
  program: ConstructionProgram,
  operation: Extract<ConstructionOperation, { kind: "stair_run" }>,
) {
  const parameters = constructionParameterMap(program);
  const width = resolveConstructionScalar(operation.widthMeters, parameters);
  const run = resolveConstructionScalar(operation.runMeters, parameters);
  const rise = resolveConstructionScalar(operation.riseMeters, parameters);
  const maximumRiser = resolveConstructionScalar(operation.maximumRiserHeightMeters, parameters);
  const maximumTread = resolveConstructionScalar(operation.maximumTreadDepthMeters, parameters);
  const minimumHeadroom = resolveConstructionScalar(operation.minimumHeadroomMeters, parameters);
  if ([width, run, rise, maximumRiser, maximumTread, minimumHeadroom].some((value) => value <= 0))
    throw new Error(`Stair run ${operation.operationId} requires positive dimensions`);
  const stepCount = Math.max(Math.ceil(rise / maximumRiser), Math.ceil(run / maximumTread));
  return {
    width,
    run,
    rise,
    minimumHeadroom,
    stepCount,
    riserHeight: rise / stepCount,
    treadDepth: run / stepCount,
  };
}

function resolveVector(
  value: {
    readonly x: Parameters<typeof resolveConstructionScalar>[0];
    readonly y: Parameters<typeof resolveConstructionScalar>[0];
    readonly z: Parameters<typeof resolveConstructionScalar>[0];
  },
  program: ConstructionProgram,
): Point {
  const parameters = constructionParameterMap(program);
  return {
    x: resolveConstructionScalar(value.x, parameters),
    y: resolveConstructionScalar(value.y, parameters),
    z: resolveConstructionScalar(value.z, parameters),
  };
}

function boxBounds(center: Point, size: Point): Bounds {
  return {
    min: { x: center.x - size.x / 2, y: center.y - size.y / 2, z: center.z - size.z / 2 },
    max: { x: center.x + size.x / 2, y: center.y + size.y / 2, z: center.z + size.z / 2 },
  };
}

function localPointToWorld(
  point: Point,
  program: ConstructionProgram,
  anchorPositionMeters: Point,
): Point {
  return add(
    add(rotateLocalVector(point, program), program.localFrame.originOffsetMeters),
    anchorPositionMeters,
  );
}

function rotateLocalVector(point: Point, program: ConstructionProgram): Point {
  const turns = program.localFrame.yawQuarterTurns;
  if (turns === 0) return point;
  if (turns === 1) return { x: point.z, y: point.y, z: -point.x };
  if (turns === 2) return { x: -point.x, y: point.y, z: -point.z };
  return { x: -point.z, y: point.y, z: point.x };
}

function rotateLocalSize(size: Point, program: ConstructionProgram): Point {
  return program.localFrame.yawQuarterTurns % 2 === 0 ? size : { x: size.z, y: size.y, z: size.x };
}

function rotateFace(
  face: "negative_x" | "negative_y" | "negative_z" | "positive_x" | "positive_y" | "positive_z",
  turns: number,
): typeof face {
  if (face === "negative_y" || face === "positive_y" || turns === 0) return face;
  const cycle = ["positive_x", "negative_z", "negative_x", "positive_z"] as const;
  const index = cycle.indexOf(face as (typeof cycle)[number]);
  return cycle[(index + turns) % 4]!;
}

function oppositeFace(face: string): string {
  return face.startsWith("negative_")
    ? face.replace("negative_", "positive_")
    : face.replace("positive_", "negative_");
}

function faceCoordinate(bounds: Bounds, face: string): number {
  if (face === "negative_x") return bounds.min.x;
  if (face === "positive_x") return bounds.max.x;
  if (face === "negative_y") return bounds.min.y;
  if (face === "positive_y") return bounds.max.y;
  if (face === "negative_z") return bounds.min.z;
  return bounds.max.z;
}

function facesOverlap(host: Bounds, child: Bounds, face: string): boolean {
  const axes = face.endsWith("x")
    ? (["y", "z"] as const)
    : face.endsWith("y")
      ? (["x", "z"] as const)
      : (["x", "y"] as const);
  return axes.every(
    (axis) =>
      Math.min(host.max[axis], child.max[axis]) - Math.max(host.min[axis], child.min[axis]) > 1e-9,
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

function faceBounds(bounds: Bounds, face: string): Bounds {
  const result = { min: { ...bounds.min }, max: { ...bounds.max } };
  if (face === "negative_x") result.max.x = result.min.x;
  if (face === "positive_x") result.min.x = result.max.x;
  if (face === "negative_y") result.max.y = result.min.y;
  if (face === "positive_y") result.min.y = result.max.y;
  if (face === "negative_z") result.max.z = result.min.z;
  if (face === "positive_z") result.min.z = result.max.z;
  return result;
}

function mergeBounds(bounds: readonly Bounds[]): Bounds {
  return {
    min: {
      x: Math.min(...bounds.map((entry) => entry.min.x)),
      y: Math.min(...bounds.map((entry) => entry.min.y)),
      z: Math.min(...bounds.map((entry) => entry.min.z)),
    },
    max: {
      x: Math.max(...bounds.map((entry) => entry.max.x)),
      y: Math.max(...bounds.map((entry) => entry.max.y)),
      z: Math.max(...bounds.map((entry) => entry.max.z)),
    },
  };
}

function add(left: Point, right: Point): Point {
  return { x: left.x + right.x, y: left.y + right.y, z: left.z + right.z };
}

function scale(value: Point, factor: number): Point {
  return { x: value.x * factor, y: value.y * factor, z: value.z * factor };
}

function directionVector(direction: string): Point {
  if (direction === "positive_x") return { x: 1, y: 0, z: 0 };
  if (direction === "negative_x") return { x: -1, y: 0, z: 0 };
  if (direction === "positive_z") return { x: 0, y: 0, z: 1 };
  return { x: 0, y: 0, z: -1 };
}

function requirePositiveVector(value: Point, label: string): void {
  if (value.x <= 0 || value.y <= 0 || value.z <= 0)
    throw new Error(`${label} requires positive dimensions`);
}

export function constructedStructureReservations(
  structure: ConstructedStructureArtifact,
): readonly OccupancyReservation[] {
  return structure.occupancyReservations;
}
