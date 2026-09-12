import { z } from "zod";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import {
  worldRegionContainsPoint,
  type WorldRegion,
  type WorldVector3,
} from "../../world-planning/src/contracts.js";
import { isPointInRouteCorridor } from "../../world-planning/src/roads.js";
import { PlacementSurfaceIndex } from "../../world-planning/src/surfaces.js";
import { createMurmurHash3Random } from "../../spatial-core/src/primitives.js";
import { compareWorldStrings } from "./primitives.js";

const finite = z.number().finite();
const positive = finite.positive();
const vector3 = z.object({ x: finite, y: finite, z: finite }).strict();
const coordinate = z.object({ u: finite, v: finite }).strict();
const proposalId = z.string().min(1).max(64);

/** Model-authored distributions expand to poses only inside this compiler. */
export const WORLD_PLACEMENT_DISTRIBUTION_SCHEMA = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("single"), id: proposalId, surfaceId: proposalId, at: coordinate })
    .strict(),
  z
    .object({
      kind: z.literal("along_path"),
      id: proposalId,
      surfaceId: proposalId,
      points: z.array(coordinate).min(2).max(512),
      count: z.number().int().min(1).max(4096),
    })
    .strict(),
  z
    .object({
      kind: z.literal("surface_grid"),
      id: proposalId,
      surfaceId: proposalId,
      origin: coordinate,
      columns: z.number().int().positive().max(4096),
      rows: z.number().int().positive().max(4096),
      spacingU: positive,
      spacingV: positive,
    })
    .strict(),
  z
    .object({
      kind: z.literal("poisson_scatter"),
      id: proposalId,
      surfaceId: proposalId,
      boundary: z.array(coordinate).min(3).max(256),
      count: z.number().int().positive().max(4096),
      minimumSeparation: positive,
      seed: z.number().int().min(0).max(0xffff_ffff),
    })
    .strict(),
  z
    .object({
      kind: z.literal("cluster"),
      id: proposalId,
      surfaceId: proposalId,
      center: coordinate,
      radius: positive,
      count: z.number().int().positive().max(4096),
      minimumSeparation: finite.nonnegative(),
      seed: z.number().int().min(0).max(0xffff_ffff),
    })
    .strict(),
]);
export type WorldPlacementDistribution = z.infer<typeof WORLD_PLACEMENT_DISTRIBUTION_SCHEMA>;

export const WORLD_SPATIAL_RELATION_SCHEMA = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("on_surface"),
      proposalIds: z.array(proposalId).min(1),
      surfaceId: proposalId,
      offset: finite,
    })
    .strict(),
  z.object({ kind: z.literal("align_upright"), proposalIds: z.array(proposalId).min(1) }).strict(),
  z
    .object({
      kind: z.literal("align_to_normal"),
      proposalIds: z.array(proposalId).min(1),
      maximumTiltDegrees: finite.min(0).max(180),
    })
    .strict(),
  z
    .object({
      kind: z.literal("face_target"),
      proposalIds: z.array(proposalId).min(1),
      target: vector3,
    })
    .strict(),
  z
    .object({
      kind: z.literal("inside_region"),
      proposalIds: z.array(proposalId).min(1),
      regionId: proposalId,
      clearance: finite.nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("support"),
      proposalIds: z.array(proposalId).min(1),
      surfaceId: proposalId,
      tolerance: finite.nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("embed"),
      proposalIds: z.array(proposalId).min(1),
      depth: finite.nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("maintain_clearance"),
      proposalIds: z.array(proposalId).min(1),
      routeId: proposalId,
      clearance: finite.nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("attach_socket"),
      proposalIds: z.array(proposalId).min(1),
      socketId: proposalId,
    })
    .strict(),
  z
    .object({
      kind: z.literal("interlock_clearance"),
      proposalIds: z.array(proposalId).min(1),
      maximumPenetrationDepth: finite.nonnegative(),
    })
    .strict(),
]);
export type WorldSpatialRelation = z.infer<typeof WORLD_SPATIAL_RELATION_SCHEMA>;

export interface WorldSocketPose {
  readonly id: string;
  readonly position: WorldVector3;
  readonly rotation: Quaternion;
}
export type Quaternion = readonly [number, number, number, number];
export interface SolvedWorldPlacement {
  readonly id: string;
  readonly proposalId: string;
  readonly ordinal: number;
  readonly surfaceId: string;
  readonly position: WorldVector3;
  readonly normal: WorldVector3;
  readonly rotation: Quaternion;
  readonly hash: string;
}

export interface SolveWorldRelationsInput {
  readonly distributions: readonly WorldPlacementDistribution[];
  readonly relations: readonly WorldSpatialRelation[];
  readonly surfaces: PlacementSurfaceIndex;
  readonly regions: readonly WorldRegion[];
  readonly routes?: readonly { id: string; points: readonly WorldVector3[]; width: number }[];
  readonly sockets?: ReadonlyMap<string, WorldSocketPose>;
}

/** Expand family-level distributions and solve all declared spatial relations deterministically. */
export function solveWorldRelations(
  input: SolveWorldRelationsInput,
): readonly SolvedWorldPlacement[] {
  const distributions = input.distributions.map((value) =>
    WORLD_PLACEMENT_DISTRIBUTION_SCHEMA.parse(value),
  );
  const relations = input.relations.map((value) => WORLD_SPATIAL_RELATION_SCHEMA.parse(value));
  const ids = new Set(distributions.map((value) => value.id));
  for (const relation of relations)
    for (const id of relation.proposalIds)
      if (!ids.has(id)) throw new Error(`Unknown placement proposal: ${id}`);
  const result: SolvedWorldPlacement[] = [];
  for (const distribution of distributions.sort((a, b) => compareWorldStrings(a.id, b.id))) {
    const poses = expandDistribution(distribution);
    const scoped = relations.filter((relation) => relation.proposalIds.includes(distribution.id));
    for (const [ordinal, pose] of poses.entries()) {
      const surface = input.surfaces.sample(distribution.surfaceId, pose);
      const onSurface = scoped.find((relation) => relation.kind === "on_surface");
      if (onSurface && onSurface.surfaceId !== distribution.surfaceId)
        throw new Error(`Surface authority disagrees for ${distribution.id}`);
      const socket = scoped.find((relation) => relation.kind === "attach_socket");
      let position: WorldVector3 = { ...surface.position };
      let rotation = alignToNormal(surface.normal, poseYaw(distribution, ordinal));
      if (socket) {
        const target = input.sockets?.get(socket.socketId);
        if (!target) throw new Error(`Unknown placement socket: ${socket.socketId}`);
        position = { ...target.position };
        rotation = target.rotation;
      }
      const face = scoped.find((relation) => relation.kind === "face_target");
      if (face && !socket) rotation = faceTarget(position, face.target, surface.normal);
      if (scoped.some((relation) => relation.kind === "align_upright") && !socket)
        rotation = yawOnly(rotation);
      const offset = onSurface?.offset ?? 0;
      const embed = scoped.find((relation) => relation.kind === "embed");
      const normalOffset = offset - (embed?.kind === "embed" ? embed.depth : 0);
      position = {
        x: position.x + surface.normal.x * normalOffset,
        y: position.y + surface.normal.y * normalOffset,
        z: position.z + surface.normal.z * normalOffset,
      };
      validateRelations(
        position,
        surface.normal,
        surface.position,
        normalOffset,
        scoped,
        input,
        distribution.surfaceId,
      );
      const material = {
        proposalId: distribution.id,
        ordinal,
        surfaceId: distribution.surfaceId,
        position,
        normal: surface.normal,
        rotation,
      };
      result.push({
        ...material,
        id: `placement_${contentHash(stableJson(material)).slice(0, 24)}`,
        hash: contentHash(stableJson(material)),
      });
    }
  }
  return result.sort((a, b) => compareWorldStrings(a.id, b.id));
}

function expandDistribution(value: WorldPlacementDistribution): Array<{ u: number; v: number }> {
  if (value.kind === "single") return [{ ...value.at }];
  if (value.kind === "surface_grid")
    return Array.from({ length: value.rows * value.columns }, (_, index) => ({
      u: value.origin.u + (index % value.columns) * value.spacingU,
      v: value.origin.v + Math.floor(index / value.columns) * value.spacingV,
    }));
  if (value.kind === "along_path")
    return Array.from({ length: value.count }, (_, index) => {
      const t = value.count === 1 ? 0 : index / (value.count - 1);
      const segment = t * (value.points.length - 1);
      const first = Math.min(value.points.length - 2, Math.floor(segment));
      const local = segment - first;
      return {
        u: value.points[first]!.u + (value.points[first + 1]!.u - value.points[first]!.u) * local,
        v: value.points[first]!.v + (value.points[first + 1]!.v - value.points[first]!.v) * local,
      };
    });
  const rng = createMurmurHash3Random(value.seed);
  const points: Array<{ u: number; v: number }> = [];
  const bounds =
    value.kind === "cluster"
      ? {
          minU: value.center.u - value.radius,
          maxU: value.center.u + value.radius,
          minV: value.center.v - value.radius,
          maxV: value.center.v + value.radius,
        }
      : {
          minU: Math.min(...value.boundary.map((point) => point.u)),
          maxU: Math.max(...value.boundary.map((point) => point.u)),
          minV: Math.min(...value.boundary.map((point) => point.v)),
          maxV: Math.max(...value.boundary.map((point) => point.v)),
        };
  for (let attempt = 0; points.length < value.count && attempt < value.count * 64; attempt += 1) {
    const candidate = {
      u: bounds.minU + rng() * (bounds.maxU - bounds.minU),
      v: bounds.minV + rng() * (bounds.maxV - bounds.minV),
    };
    if (
      value.kind === "cluster" &&
      Math.hypot(candidate.u - value.center.u, candidate.v - value.center.v) > value.radius
    )
      continue;
    if (value.kind === "poisson_scatter" && !insidePolygon(candidate, value.boundary)) continue;
    if (
      points.every(
        (point) =>
          Math.hypot(point.u - candidate.u, point.v - candidate.v) >=
          (value.kind === "cluster" ? value.minimumSeparation : value.minimumSeparation),
      )
    )
      points.push(candidate);
  }
  return points;
}

function validateRelations(
  position: WorldVector3,
  normal: WorldVector3,
  surfacePosition: WorldVector3,
  normalOffset: number,
  relations: readonly WorldSpatialRelation[],
  input: SolveWorldRelationsInput,
  surfaceId: string,
): void {
  for (const relation of relations) {
    if (relation.kind === "inside_region") {
      const region = input.regions.find((candidate) => candidate.id === relation.regionId);
      if (!region || !worldRegionContainsPoint(region, position))
        throw new Error(`Placement is outside region: ${relation.regionId}`);
    } else if (relation.kind === "maintain_clearance") {
      const route = input.routes?.find((candidate) => candidate.id === relation.routeId);
      if (route && isPointInRouteCorridor(route.points, route.width, position, relation.clearance))
        throw new Error(`Placement violates route clearance: ${relation.routeId}`);
    } else if (relation.kind === "on_surface" && relation.surfaceId !== surfaceId)
      throw new Error(`Placement surface mismatch: ${relation.surfaceId}`);
    else if (relation.kind === "support") {
      if (relation.surfaceId !== surfaceId)
        throw new Error(`Support surface mismatch: ${relation.surfaceId}`);
      const axial =
        (position.x - surfacePosition.x) * normal.x +
        (position.y - surfacePosition.y) * normal.y +
        (position.z - surfacePosition.z) * normal.z;
      if (Math.abs(axial - normalOffset) > relation.tolerance + 1e-6)
        throw new Error("Placement leaves its support plane");
    } else if (
      relation.kind === "align_to_normal" &&
      tiltDegrees(normal) > relation.maximumTiltDegrees + 1e-6
    )
      throw new Error("Surface tilt exceeds alignment tolerance");
  }
}

function alignToNormal(normal: WorldVector3, yaw: number): Quaternion {
  const n = normalize(normal);
  const tilt = Math.acos(Math.max(-1, Math.min(1, n.y)));
  const axis = normalize({ x: n.z, y: 0, z: -n.x });
  return multiplyQuaternion(axisAngle(axis, tilt), [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)]);
}

/**
 * Align to the surface normal with yaw spin, capping the tilt at the given
 * maximum. The capped normal keeps the true tilt axis; only its magnitude is
 * clamped, so cover follows gentle relief and stays near-upright on steeps.
 */
export function alignToNormalCapped(
  normal: WorldVector3,
  yaw: number,
  maximumTiltDegrees: number,
): Quaternion {
  if (!Number.isFinite(maximumTiltDegrees) || maximumTiltDegrees < 0)
    throw new Error("Maximum tilt must be a non-negative finite number");
  const n = normalize(normal);
  const tilt = Math.acos(Math.max(-1, Math.min(1, n.y)));
  const capped = Math.min(tilt, (maximumTiltDegrees * Math.PI) / 180);
  const axis = normalize({ x: n.z, y: 0, z: -n.x });
  return multiplyQuaternion(axisAngle(axis, capped), [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)]);
}
function yawOnly(rotation: Quaternion): Quaternion {
  const yaw = Math.atan2(
    2 * (rotation[3] * rotation[1] + rotation[0] * rotation[2]),
    1 - 2 * (rotation[1] ** 2 + rotation[2] ** 2),
  );
  return [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
}
function faceTarget(
  position: WorldVector3,
  target: WorldVector3,
  normal: WorldVector3,
): Quaternion {
  const dx = target.x - position.x,
    dz = target.z - position.z;
  return alignToNormal(normal, Math.atan2(dx, dz));
}
function axisAngle(axis: WorldVector3, angle: number): Quaternion {
  const s = Math.sin(angle / 2);
  return [axis.x * s, axis.y * s, axis.z * s, Math.cos(angle / 2)];
}
function multiplyQuaternion(a: Quaternion, b: Quaternion): Quaternion {
  const [ax, ay, az, aw] = a,
    [bx, by, bz, bw] = b;
  const result: Quaternion = [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
  const length = Math.hypot(...result);
  return result.map((value) => value / (length || 1)) as unknown as Quaternion;
}
function poseYaw(value: WorldPlacementDistribution, ordinal: number): number {
  return (ordinal * 0.6180339887498949 + value.id.length * 0.013) * Math.PI * 2;
}
function normalize(value: WorldVector3): WorldVector3 {
  const length = Math.hypot(value.x, value.y, value.z) || 1;
  return { x: value.x / length, y: value.y / length, z: value.z / length };
}
export function tiltDegrees(value: WorldVector3): number {
  return (Math.acos(Math.max(-1, Math.min(1, normalize(value).y))) * 180) / Math.PI;
}

/**
 * Pairwise interlock check: no two placement footprints may penetrate deeper
 * than the allowance. Radii are contact radii in the same units as positions.
 */
export function validateInterlockClearance(
  placements: readonly { position: WorldVector3; radius: number }[],
  maximumPenetrationDepth: number,
): void {
  if (!Number.isFinite(maximumPenetrationDepth) || maximumPenetrationDepth < 0)
    throw new Error("Maximum penetration depth must be a non-negative finite number");
  for (let left = 0; left < placements.length; left += 1) {
    const a = placements[left]!;
    if (!Number.isFinite(a.radius) || a.radius < 0)
      throw new Error("Interlock radius must be a non-negative finite number");
    for (let right = left + 1; right < placements.length; right += 1) {
      const b = placements[right]!;
      if (!Number.isFinite(b.radius) || b.radius < 0)
        throw new Error("Interlock radius must be a non-negative finite number");
      const distance = Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z);
      if (distance + maximumPenetrationDepth < a.radius + b.radius)
        throw new Error("Placement footprints interlock beyond the allowance");
    }
  }
}
function insidePolygon(
  point: { u: number; v: number },
  polygon: readonly { u: number; v: number }[],
): boolean {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const a = polygon[index]!,
      b = polygon[previous]!;
    if (
      a.v > point.v !== b.v > point.v &&
      point.u < ((b.u - a.u) * (point.v - a.v)) / (b.v - a.v) + a.u
    )
      inside = !inside;
  }
  return inside;
}
