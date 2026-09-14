const EPSILON = 1e-9;

export interface HorizontalPoint {
  readonly x: number;
  readonly z: number;
}

export interface HorizontalLinePrimitive {
  readonly kind: "line";
  readonly sourceSpanIndex: number;
  readonly start: HorizontalPoint;
  readonly end: HorizontalPoint;
  readonly lengthMeters: number;
}

export interface HorizontalArcPrimitive {
  readonly kind: "arc";
  readonly sourceSpanIndex: number;
  readonly sourceVertexIndex: number;
  readonly center: HorizontalPoint;
  readonly radiusMeters: number;
  readonly startAngleRadians: number;
  readonly sweepRadians: number;
  readonly lengthMeters: number;
}

export type HorizontalAlignmentPrimitive = HorizontalLinePrimitive | HorizontalArcPrimitive;

export interface ResolvedHorizontalBend {
  readonly sourceVertexIndex: number;
  readonly center: HorizontalPoint;
  readonly radiusMeters: number;
  readonly turnDirection: "left" | "right";
  readonly start: HorizontalPoint;
  readonly end: HorizontalPoint;
  readonly startStationMeters: number;
  readonly endStationMeters: number;
}

export interface ResolvedHorizontalAlignment {
  readonly primitives: readonly HorizontalAlignmentPrimitive[];
  readonly bends: readonly ResolvedHorizontalBend[];
  readonly totalLengthMeters: number;
}

export interface HorizontalAlignmentInput {
  readonly routeId: string;
  readonly points: readonly HorizontalPoint[];
  readonly bendRadiusMeters: number;
  readonly closed: boolean;
}

interface CornerGeometry {
  readonly sourceVertexIndex: number;
  readonly center: HorizontalPoint;
  readonly tangentIn: HorizontalPoint;
  readonly tangentOut: HorizontalPoint;
  readonly radiusMeters: number;
  readonly startAngleRadians: number;
  readonly sweepRadians: number;
  readonly trimMeters: number;
  readonly turnDirection: "left" | "right";
}

/**
 * Resolve an authored control polyline into tangent line and circular-arc
 * primitives. The radius is a construction constraint: the resolver refuses
 * short spans and reversals rather than shrinking a bend silently.
 */
export function resolveHorizontalAlignment(
  input: HorizontalAlignmentInput,
): ResolvedHorizontalAlignment {
  if (!Number.isFinite(input.bendRadiusMeters) || input.bendRadiusMeters <= 0)
    throw new Error(`Route ${input.routeId} requires a positive bend radius`);
  const points = input.closed ? input.points.slice(0, -1) : [...input.points];
  if (points.length < (input.closed ? 3 : 2))
    throw new Error(`Route ${input.routeId} has too few alignment vertices`);

  const corners = new Map<number, CornerGeometry>();
  const firstCorner = input.closed ? 0 : 1;
  const lastCorner = input.closed ? points.length - 1 : points.length - 2;
  for (let index = firstCorner; index <= lastCorner; index += 1) {
    const previous = points[(index - 1 + points.length) % points.length]!;
    const current = points[index]!;
    const next = points[(index + 1) % points.length]!;
    const incoming = normalized(current.x - previous.x, current.z - previous.z);
    const outgoing = normalized(next.x - current.x, next.z - current.z);
    const dot = clamp(incoming.x * outgoing.x + incoming.z * outgoing.z, -1, 1);
    const cross = incoming.x * outgoing.z - incoming.z * outgoing.x;
    const deflection = Math.acos(dot);
    if (deflection <= 1e-8) continue;
    if (Math.abs(cross) <= 1e-9 || Math.PI - deflection <= 1e-8)
      throw new Error(`Route ${input.routeId} reverses direction at vertex ${index.toString()}`);
    const trimMeters = input.bendRadiusMeters * Math.tan(deflection / 2);
    if (!Number.isFinite(trimMeters))
      throw new Error(`Route ${input.routeId} has an unbounded bend at vertex ${index.toString()}`);
    const tangentIn = {
      x: current.x - incoming.x * trimMeters,
      z: current.z - incoming.z * trimMeters,
    };
    const tangentOut = {
      x: current.x + outgoing.x * trimMeters,
      z: current.z + outgoing.z * trimMeters,
    };
    const turnDirection = cross > 0 ? "left" : "right";
    const side = turnDirection === "left" ? 1 : -1;
    const center = {
      x: tangentIn.x - incoming.z * input.bendRadiusMeters * side,
      z: tangentIn.z + incoming.x * input.bendRadiusMeters * side,
    };
    const startAngleRadians = Math.atan2(tangentIn.z - center.z, tangentIn.x - center.x);
    const endAngleRadians = Math.atan2(tangentOut.z - center.z, tangentOut.x - center.x);
    const sweepRadians = directedSweep(startAngleRadians, endAngleRadians, side);
    if (Math.abs(Math.abs(sweepRadians) - deflection) > 1e-7)
      throw new Error(`Route ${input.routeId} could not resolve bend ${index.toString()}`);
    corners.set(index, {
      sourceVertexIndex: index,
      center,
      tangentIn,
      tangentOut,
      radiusMeters: input.bendRadiusMeters,
      startAngleRadians,
      sweepRadians,
      trimMeters,
      turnDirection,
    });
  }

  const edgeCount = input.closed ? points.length : points.length - 1;
  for (let edgeIndex = 0; edgeIndex < edgeCount; edgeIndex += 1) {
    const nextIndex = (edgeIndex + 1) % points.length;
    const lengthMeters = distance(points[edgeIndex]!, points[nextIndex]!);
    const required =
      (corners.get(edgeIndex)?.trimMeters ?? 0) + (corners.get(nextIndex)?.trimMeters ?? 0);
    if (required >= lengthMeters - EPSILON)
      throw new Error(
        `Route ${input.routeId} bend radius ${input.bendRadiusMeters.toFixed(6)}m does not fit span ${edgeIndex.toString()}`,
      );
  }

  const primitives: HorizontalAlignmentPrimitive[] = [];
  const bends: ResolvedHorizontalBend[] = [];
  let stationMeters = 0;
  for (let edgeIndex = 0; edgeIndex < edgeCount; edgeIndex += 1) {
    const nextIndex = (edgeIndex + 1) % points.length;
    const start = corners.get(edgeIndex)?.tangentOut ?? points[edgeIndex]!;
    const end = corners.get(nextIndex)?.tangentIn ?? points[nextIndex]!;
    const lengthMeters = distance(start, end);
    if (lengthMeters > EPSILON) {
      primitives.push({ kind: "line", sourceSpanIndex: edgeIndex, start, end, lengthMeters });
      stationMeters += lengthMeters;
    }
    const corner = corners.get(nextIndex);
    if (!corner) continue;
    const arcLengthMeters = Math.abs(corner.sweepRadians) * corner.radiusMeters;
    const startStationMeters = stationMeters;
    primitives.push({
      kind: "arc",
      sourceSpanIndex: edgeIndex,
      sourceVertexIndex: corner.sourceVertexIndex,
      center: corner.center,
      radiusMeters: corner.radiusMeters,
      startAngleRadians: corner.startAngleRadians,
      sweepRadians: corner.sweepRadians,
      lengthMeters: arcLengthMeters,
    });
    stationMeters += arcLengthMeters;
    bends.push({
      sourceVertexIndex: corner.sourceVertexIndex,
      center: corner.center,
      radiusMeters: corner.radiusMeters,
      turnDirection: corner.turnDirection,
      start: corner.tangentIn,
      end: corner.tangentOut,
      startStationMeters,
      endStationMeters: stationMeters,
    });
  }
  if (primitives.length === 0 || stationMeters <= EPSILON)
    throw new Error(`Route ${input.routeId} has no resolved horizontal extent`);
  return { primitives, bends, totalLengthMeters: stationMeters };
}

export function sampleHorizontalPrimitive(
  primitive: HorizontalAlignmentPrimitive,
  amount: number,
): { readonly position: HorizontalPoint; readonly tangent: HorizontalPoint } {
  const bounded = clamp(amount, 0, 1);
  if (primitive.kind === "line") {
    const tangent = normalized(
      primitive.end.x - primitive.start.x,
      primitive.end.z - primitive.start.z,
    );
    return {
      position: interpolate(primitive.start, primitive.end, bounded),
      tangent,
    };
  }
  const angle = primitive.startAngleRadians + primitive.sweepRadians * bounded;
  const direction = Math.sign(primitive.sweepRadians);
  return {
    position: {
      x: primitive.center.x + Math.cos(angle) * primitive.radiusMeters,
      z: primitive.center.z + Math.sin(angle) * primitive.radiusMeters,
    },
    tangent: { x: -Math.sin(angle) * direction, z: Math.cos(angle) * direction },
  };
}

function directedSweep(start: number, end: number, direction: 1 | -1): number {
  let sweep = end - start;
  if (direction > 0) {
    while (sweep < 0) sweep += Math.PI * 2;
    while (sweep >= Math.PI * 2) sweep -= Math.PI * 2;
  } else {
    while (sweep > 0) sweep -= Math.PI * 2;
    while (sweep <= -Math.PI * 2) sweep += Math.PI * 2;
  }
  return sweep;
}

function normalized(x: number, z: number): HorizontalPoint {
  const length = Math.hypot(x, z);
  if (length <= EPSILON) throw new Error("Route alignment contains a degenerate direction");
  return { x: x / length, z: z / length };
}

function distance(left: HorizontalPoint, right: HorizontalPoint): number {
  return Math.hypot(right.x - left.x, right.z - left.z);
}

function interpolate(
  start: HorizontalPoint,
  end: HorizontalPoint,
  amount: number,
): HorizontalPoint {
  return {
    x: start.x + (end.x - start.x) * amount,
    z: start.z + (end.z - start.z) * amount,
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
