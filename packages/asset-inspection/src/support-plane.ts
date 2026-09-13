import { createMurmurHash3Random } from "@basalt/spatial-core";

export interface SupportPlanePoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface SupportPlanePatch {
  readonly polygon: readonly SupportPlanePoint[];
}

export interface SupportPlaneFit {
  readonly normal: SupportPlanePoint;
  readonly origin: SupportPlanePoint;
  readonly boundaryRadiusMeters: number;
  readonly inlierCount: number;
  readonly pointCount: number;
}

export type SupportPlaneRefusal =
  "no_patches" | "sparse_points" | "no_plane" | "degenerate_footprint";

export type SupportPlaneResult =
  | { readonly status: "fit"; readonly fits: ReadonlyArray<SupportPlaneFit> }
  | { readonly status: "refused"; readonly reason: SupportPlaneRefusal };

export const SUPPORT_PLANE_ITERATIONS = 192;
export const SUPPORT_PLANE_THRESHOLD_METERS = 0.001;
export const SUPPORT_PLANE_MIN_UP_COMPONENT = 0.5;
export const SUPPORT_PLANE_MAX_SAMPLE_POINTS = 4096;

/** Derives a deterministic uint32 seed from a content-addressed asset id. */
function sanitizeZero(value: number): number {
  return value === 0 ? 0 : value;
}

function sanitizePoint(point: SupportPlanePoint): SupportPlanePoint {
  return { x: sanitizeZero(point.x), y: sanitizeZero(point.y), z: sanitizeZero(point.z) };
}

/** Derives a deterministic uint32 seed from a content-addressed asset id. */
export function seedFromAssetId(assetId: string): number {
  const body = assetId.includes("_") ? assetId.slice(assetId.indexOf("_") + 1) : assetId;
  const hex = body
    .replace(/[^0-9a-f]/giu, "")
    .slice(0, 8)
    .padStart(8, "0");
  return Number.parseInt(hex, 16) >>> 0;
}

function subtract(a: SupportPlanePoint, b: SupportPlanePoint): SupportPlanePoint {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function cross(a: SupportPlanePoint, b: SupportPlanePoint): SupportPlanePoint {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function dot(a: SupportPlanePoint, b: SupportPlanePoint): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function magnitude(point: SupportPlanePoint): number {
  return Math.sqrt(dot(point, point));
}

function planeBasis(normal: SupportPlanePoint): {
  readonly u: SupportPlanePoint;
  readonly v: SupportPlanePoint;
} {
  const ax = Math.abs(normal.x);
  const ay = Math.abs(normal.y);
  const az = Math.abs(normal.z);
  const helper =
    ax <= ay && ax <= az
      ? { x: 1, y: 0, z: 0 }
      : ay <= az
        ? { x: 0, y: 1, z: 0 }
        : { x: 0, y: 0, z: 1 };
  const u0 = cross(normal, helper);
  const uLength = magnitude(u0);
  const u = { x: u0.x / uLength, y: u0.y / uLength, z: u0.z / uLength };
  const v0 = cross(normal, u);
  const vLength = magnitude(v0);
  return { u, v: { x: v0.x / vLength, y: v0.y / vLength, z: v0.z / vLength } };
}

function projectToPlane(
  point: SupportPlanePoint,
  origin: SupportPlanePoint,
  basis: { readonly u: SupportPlanePoint; readonly v: SupportPlanePoint },
): readonly [number, number] {
  const d = subtract(point, origin);
  return [dot(d, basis.u), dot(d, basis.v)];
}

function pointSegmentDistance2D(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const length2 = dx * dx + dy * dy;
  if (length2 === 0) return Math.sqrt((px - ax) * (px - ax) + (py - ay) * (py - ay));
  const t = Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / length2));
  return Math.sqrt(
    (px - ax - t * dx) * (px - ax - t * dx) + (py - ay - t * dy) * (py - ay - t * dy),
  );
}

function pointInPolygon2D(
  px: number,
  py: number,
  ring: ReadonlyArray<readonly [number, number]>,
): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (pointSegmentDistance2D(px, py, xi, yi, xj, yj) <= 1e-9) return true;
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

interface PlaneModel {
  readonly normal: SupportPlanePoint;
  readonly anchor: SupportPlanePoint;
  readonly inliers: ReadonlyArray<number>;
  readonly residual: number;
}

interface SupportPatchFact {
  readonly index: number;
  readonly area: number;
}

function patchArea(patch: SupportPlanePatch): number {
  if (patch.polygon.length < 3) return 0;
  const anchor = patch.polygon[0]!;
  let area = 0;
  for (let index = 1; index + 1 < patch.polygon.length; index += 1) {
    const raw = cross(
      subtract(patch.polygon[index]!, anchor),
      subtract(patch.polygon[index + 1]!, anchor),
    );
    area += magnitude(raw) / 2;
  }
  return area;
}

/**
 * Retains every disconnected contact component when the budget permits, then
 * samples each component at equal cumulative-area strata. Triangle density
 * and source ordering therefore cannot erase a small foot or overweight a
 * needlessly tessellated patch.
 */
function topologyAreaStratifiedPatches(
  patches: ReadonlyArray<SupportPlanePatch>,
  maximumPoints: number,
): SupportPlanePatch[] {
  const pointCount = patches.reduce((sum, patch) => sum + patch.polygon.length, 0);
  if (pointCount <= maximumPoints) return [...patches];
  const maximumPatches = Math.max(1, Math.floor(maximumPoints / 3));
  const facts = patches
    .map((patch, index): SupportPatchFact => ({ index, area: patchArea(patch) }))
    .filter((fact) => fact.area > 1e-12);
  if (facts.length <= maximumPatches) return facts.map((fact) => patches[fact.index]!);

  const parent = facts.map((_, index) => index);
  const find = (index: number): number => {
    let cursor = index;
    while (parent[cursor] !== cursor) {
      parent[cursor] = parent[parent[cursor]!]!;
      cursor = parent[cursor]!;
    }
    return cursor;
  };
  const join = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot === rightRoot) return;
    if (leftRoot < rightRoot) parent[rightRoot] = leftRoot;
    else parent[leftRoot] = rightRoot;
  };
  const pointOwner = new Map<string, number>();
  for (const [position, fact] of facts.entries()) {
    for (const point of patches[fact.index]!.polygon) {
      const key = `${point.x},${point.y},${point.z}`;
      const owner = pointOwner.get(key);
      if (owner === undefined) pointOwner.set(key, position);
      else join(position, owner);
    }
  }
  const groups = new Map<number, SupportPatchFact[]>();
  for (const [position, fact] of facts.entries()) {
    const root = find(position);
    const members = groups.get(root) ?? [];
    members.push(fact);
    groups.set(root, members);
  }
  const components = [...groups.values()]
    .map((members) => ({
      members: [...members].sort((left, right) => left.index - right.index),
      area: members.reduce((sum, member) => sum + member.area, 0),
      firstIndex: Math.min(...members.map((member) => member.index)),
      count: 0,
    }))
    .sort((left, right) => right.area - left.area || left.firstIndex - right.firstIndex)
    .slice(0, maximumPatches);
  for (const component of components) component.count = 1;
  const totalArea = components.reduce((sum, component) => sum + component.area, 0);
  let remaining = maximumPatches - components.length;
  while (remaining > 0) {
    const candidate = components
      .filter((component) => component.count < component.members.length)
      .sort((left, right) => {
        const leftDeficit = (left.area / totalArea) * maximumPatches - left.count;
        const rightDeficit = (right.area / totalArea) * maximumPatches - right.count;
        return rightDeficit - leftDeficit || left.firstIndex - right.firstIndex;
      })[0];
    if (!candidate) break;
    candidate.count += 1;
    remaining -= 1;
  }
  const selected: SupportPatchFact[] = [];
  for (const component of components) {
    const targetStep = component.area / component.count;
    let cumulative = 0;
    let target = 0;
    const chosen = new Map<number, SupportPatchFact>();
    for (const member of component.members) {
      cumulative += member.area;
      while (target < component.count && cumulative >= (target + 0.5) * targetStep) {
        chosen.set(member.index, member);
        target += 1;
      }
    }
    for (const member of [...component.members].sort(
      (left, right) => right.area - left.area || left.index - right.index,
    )) {
      if (chosen.size >= component.count) break;
      chosen.set(member.index, member);
    }
    selected.push(...chosen.values());
  }
  return selected
    .sort((left, right) => left.index - right.index)
    .map((fact) => patches[fact.index]!);
}

/**
 * Fits the support plane behind bottom-contact patches with seeded RANSAC and
 * clips one mount-socket footprint per connected contact component. Points
 * arrive in meters. Multi-foot assets earn one socket per foot; each footprint
 * clips to its own component boundary, and components without interior admit
 * no socket. Refusals carry machine-readable reasons. Deterministic: fixed
 * iteration budget, seeded draws, first-best wins, centroid-ordered sockets.
 */
export function fitSupportPlane(
  patches: ReadonlyArray<SupportPlanePatch>,
  seed: number,
): SupportPlaneResult {
  if (patches.length === 0) return { status: "refused", reason: "no_patches" };
  const flat: SupportPlanePoint[] = [];
  const flatProvenance: Array<{ readonly patch: number; readonly vertex: number }> = [];
  patches.forEach((patch, patchIndex) =>
    patch.polygon.forEach((point, vertexIndex) => {
      flat.push(point);
      flatProvenance.push({ patch: patchIndex, vertex: vertexIndex });
    }),
  );
  const sampledPatches = topologyAreaStratifiedPatches(patches, SUPPORT_PLANE_MAX_SAMPLE_POINTS);
  const points = sampledPatches.flatMap((patch) => [...patch.polygon]);
  if (points.length < 3) return { status: "refused", reason: "sparse_points" };
  const rng = createMurmurHash3Random(seed >>> 0);
  let best: PlaneModel | null = null;
  for (let iteration = 0; iteration < SUPPORT_PLANE_ITERATIONS; iteration += 1) {
    const picked: number[] = [];
    for (let draw = 0; draw < 3 && picked.length < 3; draw += 1) {
      const candidate = Math.min(points.length - 1, Math.floor(rng() * points.length));
      if (!picked.includes(candidate)) picked.push(candidate);
    }
    if (picked.length < 3) continue;
    const [a, b, c] = picked.map((index) => points[index]!) as [
      SupportPlanePoint,
      SupportPlanePoint,
      SupportPlanePoint,
    ];
    const raw = cross(subtract(b, a), subtract(c, a));
    const length = magnitude(raw);
    if (!(length > 1e-12)) continue;
    let normal = { x: raw.x / length, y: raw.y / length, z: raw.z / length };
    if (normal.y < 0) normal = { x: -normal.x, y: -normal.y, z: -normal.z };
    if (normal.y < SUPPORT_PLANE_MIN_UP_COMPONENT) continue;
    const inliers: number[] = [];
    let residual = 0;
    for (let index = 0; index < points.length; index += 1) {
      const distance = Math.abs(dot(subtract(points[index]!, a), normal));
      if (distance <= SUPPORT_PLANE_THRESHOLD_METERS) {
        inliers.push(index);
        residual += distance;
      }
    }
    if (
      best === null ||
      inliers.length > best.inliers.length ||
      (inliers.length === best.inliers.length && residual < best.residual)
    ) {
      best = { normal, anchor: a, inliers, residual };
    }
  }
  if (best === null || best.inliers.length < 3) return { status: "refused", reason: "no_plane" };
  // RANSAC runs on the bounded topology/area sample; clipping re-tests every contact vertex
  // against the winning plane so dense patches keep exact boundaries.
  const fullInliers: number[] = [];
  for (let index = 0; index < flat.length; index += 1) {
    if (
      Math.abs(dot(subtract(flat[index]!, best.anchor), best.normal)) <=
      SUPPORT_PLANE_THRESHOLD_METERS
    )
      fullInliers.push(index);
  }
  if (fullInliers.length < 3) return { status: "refused", reason: "no_plane" };
  const basis = planeBasis(best.normal);
  const frame = best.anchor;
  const inlierVerts = new Set(
    fullInliers.map((index) => {
      const p = flatProvenance[index]!;
      return `${p.patch}:${p.vertex}`;
    }),
  );
  const live: number[] = [];
  patches.forEach((patch, patchIndex) => {
    if (patch.polygon.some((_, vertexIndex) => inlierVerts.has(`${patchIndex}:${vertexIndex}`)))
      live.push(patchIndex);
  });
  if (live.length === 0) return { status: "refused", reason: "no_plane" };
  // Contact connectivity over inlier-shared vertices. Shared authored verts
  // are bit-identical after uniform scaling, so exact keys are sound.
  const parent = live.map((_, index) => index);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!;
      x = parent[x]!;
    }
    return x;
  };
  const keyOwner = new Map<string, number>();
  live.forEach((patchIndex, liveIndex) => {
    patches[patchIndex]!.polygon.forEach((point, vertexIndex) => {
      if (!inlierVerts.has(`${patchIndex}:${vertexIndex}`)) return;
      const key = `${point.x},${point.y},${point.z}`;
      const owner = keyOwner.get(key);
      if (owner === undefined) keyOwner.set(key, liveIndex);
      else parent[find(liveIndex)] = find(owner);
    });
  });
  const components = new Map<number, number[]>();
  live.forEach((patchIndex, liveIndex) => {
    const root = find(liveIndex);
    const group = components.get(root) ?? [];
    group.push(patchIndex);
    components.set(root, group);
  });
  // Boundary edges only: interior shared edges (triangulation diagonals)
  // never bound a footprint.
  const edgeKey = (a: SupportPlanePoint, b: SupportPlanePoint): string => {
    const ka = `${a.x},${a.y},${a.z}`;
    const kb = `${b.x},${b.y},${b.z}`;
    return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
  };
  const edgeUses = new Map<string, number>();
  for (const patchIndex of live) {
    const polygon = patches[patchIndex]!.polygon;
    for (let i = 0; i < polygon.length; i += 1) {
      const j = (i + 1) % polygon.length;
      if (!inlierVerts.has(`${patchIndex}:${i}`) || !inlierVerts.has(`${patchIndex}:${j}`))
        continue;
      const key = edgeKey(polygon[i]!, polygon[j]!);
      edgeUses.set(key, (edgeUses.get(key) ?? 0) + 1);
    }
  }
  const onPlane = (point: SupportPlanePoint): SupportPlanePoint => {
    const shift = dot(subtract(point, best.anchor), best.normal);
    return {
      x: point.x - best.normal.x * shift,
      y: point.y - best.normal.y * shift,
      z: point.z - best.normal.z * shift,
    };
  };
  const fits: SupportPlaneFit[] = [];
  for (const group of [...components.values()].sort((a, b) => a[0]! - b[0]!)) {
    const groupSet = new Set(group);
    const groupPoints: SupportPlanePoint[] = [];
    for (const flatIndex of fullInliers) {
      if (groupSet.has(flatProvenance[flatIndex]!.patch)) groupPoints.push(flat[flatIndex]!);
    }
    if (groupPoints.length < 3) continue;
    const centroid = { x: 0, y: 0, z: 0 };
    for (const point of groupPoints) {
      centroid.x += point.x / groupPoints.length;
      centroid.y += point.y / groupPoints.length;
      centroid.z += point.z / groupPoints.length;
    }
    const rings = group.map((patchIndex) =>
      patches[patchIndex]!.polygon.map((point) => projectToPlane(point, frame, basis)),
    );
    const segments: Array<readonly [readonly [number, number], readonly [number, number]]> = [];
    for (const patchIndex of group) {
      const polygon = patches[patchIndex]!.polygon;
      for (let i = 0; i < polygon.length; i += 1) {
        const j = (i + 1) % polygon.length;
        if ((edgeUses.get(edgeKey(polygon[i]!, polygon[j]!)) ?? 0) !== 1) continue;
        segments.push([
          projectToPlane(polygon[i]!, frame, basis),
          projectToPlane(polygon[j]!, frame, basis),
        ]);
      }
    }
    const clippedRadius = (cx: number, cy: number): number => {
      let radius = Number.POSITIVE_INFINITY;
      for (const [a2, b2] of segments)
        radius = Math.min(radius, pointSegmentDistance2D(cx, cy, a2[0], a2[1], b2[0], b2[1]));
      return radius;
    };
    const inside = (at: readonly [number, number]): boolean =>
      rings.some((ring) => ring.length >= 3 && pointInPolygon2D(at[0], at[1], ring));
    let center = onPlane(centroid);
    let at = projectToPlane(center, frame, basis);
    if (!inside(at)) {
      // Centroid outside its own component (rim band, C-foot): fall back to
      // the best interior polygon centroid.
      let candidate: {
        point: SupportPlanePoint;
        at: readonly [number, number];
        radius: number;
      } | null = null;
      for (const patchIndex of group) {
        const polygon = patches[patchIndex]!.polygon;
        const c3 = { x: 0, y: 0, z: 0 };
        for (const point of polygon) {
          c3.x += point.x / polygon.length;
          c3.y += point.y / polygon.length;
          c3.z += point.z / polygon.length;
        }
        const placed = onPlane(c3);
        const placedAt = projectToPlane(placed, frame, basis);
        if (!inside(placedAt)) continue;
        const radius = clippedRadius(placedAt[0], placedAt[1]);
        if (candidate === null || radius > candidate.radius)
          candidate = { point: placed, at: placedAt, radius };
      }
      if (candidate === null) continue;
      center = candidate.point;
      at = candidate.at;
    }
    const radius = clippedRadius(at[0], at[1]);
    if (!Number.isFinite(radius) || radius <= 0) continue;
    fits.push({
      normal: sanitizePoint(best.normal),
      origin: sanitizePoint(center),
      boundaryRadiusMeters: radius,
      inlierCount: groupPoints.length,
      pointCount: flat.length,
    });
  }
  if (fits.length === 0) return { status: "refused", reason: "degenerate_footprint" };
  fits.sort(
    (a, b) => a.origin.x - b.origin.x || a.origin.y - b.origin.y || a.origin.z - b.origin.z,
  );
  return { status: "fit", fits };
}
