export interface JointPlaneVertex {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface JointPlaneMesh {
  readonly vertices: ReadonlyArray<JointPlaneVertex>;
  readonly triangles: ReadonlyArray<readonly [number, number, number]>;
}

export interface JointPlaneFit {
  readonly normal: JointPlaneVertex;
  readonly origin: JointPlaneVertex;
  readonly boundaryRadiusMeters: number;
  /** Angle between the fitted normal and the nearest world axis, in degrees. */
  readonly axisAlignmentDegrees: number;
  readonly faceAreaSquareMeters: number;
  readonly inlierCount: number;
  readonly pointCount: number;
}

export type JointPlaneRefusal = "no_triangles" | "no_planar_faces" | "degenerate_faces";

export type JointPlaneResult =
  | { readonly status: "fit"; readonly fits: ReadonlyArray<JointPlaneFit> }
  | { readonly status: "refused"; readonly reason: JointPlaneRefusal };

export const JOINT_PLANE_NORMAL_DEGREES = 3;
export const JOINT_PLANE_DISTANCE_METERS = 0.01;
export const JOINT_PLANE_MIN_FACE_AREA_SQUARE_METERS = 1;
export const JOINT_PLANE_MIN_BOUNDARY_RADIUS_METERS = 0.2;
export const JOINT_PLANE_MAX_SAMPLE_TRIANGLES = 8192;

function sanitizeZero(value: number): number {
  return value === 0 ? 0 : value;
}

function sanitizePoint(point: JointPlaneVertex): JointPlaneVertex {
  return { x: sanitizeZero(point.x), y: sanitizeZero(point.y), z: sanitizeZero(point.z) };
}

function subtract(
  a: JointPlaneVertex,
  b: JointPlaneVertex,
): { readonly x: number; readonly y: number; readonly z: number } {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function cross(
  a: { readonly x: number; readonly y: number; readonly z: number },
  b: { readonly x: number; readonly y: number; readonly z: number },
): { readonly x: number; readonly y: number; readonly z: number } {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function dot(
  a: { readonly x: number; readonly y: number; readonly z: number },
  b: { readonly x: number; readonly y: number; readonly z: number },
): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function planeBasis(normal: { readonly x: number; readonly y: number; readonly z: number }): {
  readonly u: { readonly x: number; readonly y: number; readonly z: number };
  readonly v: { readonly x: number; readonly y: number; readonly z: number };
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
  const uLength = Math.sqrt(dot(u0, u0));
  const u = { x: u0.x / uLength, y: u0.y / uLength, z: u0.z / uLength };
  const v0 = cross(normal, u);
  const vLength = Math.sqrt(dot(v0, v0));
  return { u, v: { x: v0.x / vLength, y: v0.y / vLength, z: v0.z / vLength } };
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

interface TriangleFact {
  readonly index: number;
  readonly normal: { readonly x: number; readonly y: number; readonly z: number };
  readonly centroid: { readonly x: number; readonly y: number; readonly z: number };
  readonly area: number;
}

/**
 * Decomposes a meter-space mesh into planar joint faces for modular assembly.
 * Triangles cluster greedily in area order by normal agreement (winding
 * ignored) and coplanarity; each surviving cluster refits an area-weighted
 * plane, clips an inscribed contact disc against its boundary edges, and
 * records its axis alignment. Each cluster splits into vertex-connected
 * components first (disjoint coplanar patches are separate faces, never one
 * face straddling a seam). Each face casts both ways along its normal: the
 * normal follows the escaping ray, faces blocked both ways are interior
 * rather than joints, and doubly open plates orient away from the mesh
 * centroid. Winding is never trusted. Deterministic: topology components,
 * surface-area strata, area then origin ordering, no RNG. Refusals carry
 * machine-readable reasons.
 */
export function fitJointPlanes(mesh: JointPlaneMesh): JointPlaneResult {
  if (mesh.triangles.length === 0 || mesh.vertices.length < 3)
    return { status: "refused", reason: "no_triangles" };
  const meshCentroid = { x: 0, y: 0, z: 0 };
  for (const vertex of mesh.vertices) {
    meshCentroid.x += vertex.x / mesh.vertices.length;
    meshCentroid.y += vertex.y / mesh.vertices.length;
    meshCentroid.z += vertex.z / mesh.vertices.length;
  }
  const facts: TriangleFact[] = [];
  mesh.triangles.forEach(([a, b, c], index) => {
    const pa = mesh.vertices[a];
    const pb = mesh.vertices[b];
    const pc = mesh.vertices[c];
    if (pa === undefined || pb === undefined || pc === undefined) return;
    const raw = cross(subtract(pb, pa), subtract(pc, pa));
    const length = Math.sqrt(dot(raw, raw));
    const area = length / 2;
    if (!(area > 1e-12)) return;
    facts.push({
      index,
      normal: { x: raw.x / length, y: raw.y / length, z: raw.z / length },
      centroid: {
        x: (pa.x + pb.x + pc.x) / 3,
        y: (pa.y + pb.y + pc.y) / 3,
        z: (pa.z + pb.z + pc.z) / 3,
      },
      area,
    });
  });
  // Preserve disconnected topology and surface-area representation instead
  // of sampling by triangle index, which over-represents densely tessellated
  // patches and can entirely skip small disconnected components.
  const sampled = topologyAreaStratifiedSample(mesh, facts, JOINT_PLANE_MAX_SAMPLE_TRIANGLES);
  const seeds = [...sampled].sort(
    (left, right) => right.area - left.area || left.index - right.index,
  );
  const normalCosine = Math.cos((JOINT_PLANE_NORMAL_DEGREES * Math.PI) / 180);
  const passesGate = (fact: TriangleFact, seed: TriangleFact): boolean =>
    Math.abs(dot(fact.normal, seed.normal)) >= normalCosine &&
    Math.abs(dot(subtract(fact.centroid, seed.centroid), seed.normal)) <=
      JOINT_PLANE_DISTANCE_METERS;
  const claimed = new Set<number>();
  const clusterSeeds: TriangleFact[] = [];
  for (const seed of seeds) {
    if (claimed.has(seed.index)) continue;
    const cluster: number[] = [];
    let clusterArea = 0;
    for (const fact of sampled) {
      if (claimed.has(fact.index) || !passesGate(fact, seed)) continue;
      cluster.push(fact.index);
      clusterArea += fact.area;
    }
    // Undersized clusters release their triangles: a later seed with a
    // better plane may still claim them into a real face.
    if (clusterArea < JOINT_PLANE_MIN_FACE_AREA_SQUARE_METERS) continue;
    for (const index of cluster) claimed.add(index);
    clusterSeeds.push(seed);
  }
  if (clusterSeeds.length === 0) return { status: "refused", reason: "no_planar_faces" };
  // Clustering runs on the bounded stratified sample; membership re-tests every mesh
  // triangle against the winning seed planes so dense meshes keep exact
  // areas and boundaries. First seed wins ties.
  const clusterMembers: TriangleFact[][] = clusterSeeds.map(() => []);
  for (const fact of facts) {
    const owner = clusterSeeds.findIndex((seed) => passesGate(fact, seed));
    if (owner >= 0) clusterMembers[owner]!.push(fact);
  }
  const fits: JointPlaneFit[] = [];
  for (let cluster = 0; cluster < clusterSeeds.length; cluster += 1) {
    const candidates = clusterMembers[cluster]!;
    if (candidates.length === 0) continue;
    // Vertex-connected components over shared corner indices. Disjoint
    // coplanar patches (stepped walls, repeated panels) fit separately so
    // no face centroid lands on an interior seam.
    const parent = candidates.map((_, position) => position);
    const find = (x: number): number => {
      while (parent[x] !== x) {
        parent[x] = parent[parent[x]!]!;
        x = parent[x]!;
      }
      return x;
    };
    const cornerOwner = new Map<number, number>();
    candidates.forEach((fact, position) => {
      const triangle = mesh.triangles[fact.index]!;
      for (const corner of triangle) {
        const owner = cornerOwner.get(corner);
        if (owner === undefined) cornerOwner.set(corner, position);
        else parent[find(position)] = find(owner);
      }
    });
    const components = new Map<number, TriangleFact[]>();
    candidates.forEach((fact, position) => {
      const root = find(position);
      const group = components.get(root) ?? [];
      group.push(fact);
      components.set(root, group);
    });
    const orderedComponents = [...components.values()].sort(
      (left, right) => left[0]!.index - right[0]!.index,
    );
    for (const members of orderedComponents) {
      const face = fitComponent(mesh, members);
      if (face === undefined) continue;
      const oriented = orientJointFace(mesh, meshCentroid, members, face);
      if (oriented !== undefined) fits.push(oriented);
    }
  }
  if (fits.length === 0) return { status: "refused", reason: "degenerate_faces" };
  fits.sort(
    (left, right) =>
      right.faceAreaSquareMeters - left.faceAreaSquareMeters ||
      left.origin.x - right.origin.x ||
      left.origin.y - right.origin.y ||
      left.origin.z - right.origin.z,
  );
  return { status: "fit", fits };
}

function topologyAreaStratifiedSample(
  mesh: JointPlaneMesh,
  facts: readonly TriangleFact[],
  maximum: number,
): TriangleFact[] {
  if (facts.length <= maximum) return [...facts];
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
  const cornerOwner = new Map<number, number>();
  for (const [position, fact] of facts.entries()) {
    for (const corner of mesh.triangles[fact.index]!) {
      const owner = cornerOwner.get(corner);
      if (owner === undefined) cornerOwner.set(corner, position);
      else join(position, owner);
    }
  }
  const byRoot = new Map<number, TriangleFact[]>();
  for (const [position, fact] of facts.entries()) {
    const root = find(position);
    const group = byRoot.get(root) ?? [];
    group.push(fact);
    byRoot.set(root, group);
  }
  const components = [...byRoot.values()]
    .map((members) => ({
      members: [...members].sort((left, right) => left.index - right.index),
      area: members.reduce((sum, member) => sum + member.area, 0),
      firstIndex: members.reduce(
        (minimum, member) => Math.min(minimum, member.index),
        Number.POSITIVE_INFINITY,
      ),
      count: 0,
    }))
    .sort((left, right) => right.area - left.area || left.firstIndex - right.firstIndex)
    .slice(0, maximum);
  for (const component of components) component.count = 1;
  const totalArea = components.reduce((sum, component) => sum + component.area, 0);
  let remaining = maximum - components.length;
  while (remaining > 0) {
    const candidate = components
      .filter((component) => component.count < component.members.length)
      .sort((left, right) => {
        const leftDeficit = (left.area / totalArea) * maximum - left.count;
        const rightDeficit = (right.area / totalArea) * maximum - right.count;
        return rightDeficit - leftDeficit || left.firstIndex - right.firstIndex;
      })[0];
    if (!candidate) break;
    candidate.count += 1;
    remaining -= 1;
  }
  const sampled: TriangleFact[] = [];
  for (const component of components) {
    const selected = new Map<number, TriangleFact>();
    const targetStep = component.area / component.count;
    let cumulative = 0;
    let targetIndex = 0;
    for (const member of component.members) {
      cumulative += member.area;
      while (targetIndex < component.count && cumulative >= (targetIndex + 0.5) * targetStep) {
        selected.set(member.index, member);
        targetIndex += 1;
      }
    }
    if (selected.size < component.count) {
      const remainingMembers = component.members
        .filter((member) => !selected.has(member.index))
        .sort((left, right) => right.area - left.area || left.index - right.index);
      for (const member of remainingMembers) {
        if (selected.size >= component.count) break;
        selected.set(member.index, member);
      }
    }
    sampled.push(...selected.values());
  }
  return sampled.sort((left, right) => left.index - right.index);
}

function fitComponent(
  mesh: JointPlaneMesh,
  members: ReadonlyArray<TriangleFact>,
): JointPlaneFit | undefined {
  const seedNormal = members[0]!.normal;
  const averaged = { x: 0, y: 0, z: 0 };
  let totalArea = 0;
  const centroidWeighted = { x: 0, y: 0, z: 0 };
  for (const member of members) {
    const sign = dot(member.normal, seedNormal) >= 0 ? 1 : -1;
    averaged.x += sign * member.normal.x * member.area;
    averaged.y += sign * member.normal.y * member.area;
    averaged.z += sign * member.normal.z * member.area;
    totalArea += member.area;
  }
  if (totalArea < JOINT_PLANE_MIN_FACE_AREA_SQUARE_METERS) return undefined;
  const averagedLength = Math.sqrt(dot(averaged, averaged));
  if (!(averagedLength > 1e-12)) return undefined;
  const normal = {
    x: averaged.x / averagedLength,
    y: averaged.y / averagedLength,
    z: averaged.z / averagedLength,
  };
  for (const member of members) {
    const weight = member.area / totalArea;
    centroidWeighted.x += member.centroid.x * weight;
    centroidWeighted.y += member.centroid.y * weight;
    centroidWeighted.z += member.centroid.z * weight;
  }
  const basis = planeBasis(normal);
  const project = (point: JointPlaneVertex): readonly [number, number] => {
    const d = subtract(point, centroidWeighted);
    return [dot(d, basis.u), dot(d, basis.v)];
  };
  // Boundary edges only, keyed by shared vertex index: interior shared
  // edges (triangulation diagonals) never bound a face.
  const edgeUses = new Map<string, number>();
  const edgeEndpoints = new Map<string, readonly [JointPlaneVertex, JointPlaneVertex]>();
  for (const member of members) {
    const triangle = mesh.triangles[member.index]!;
    const corners = [triangle[0], triangle[1], triangle[2]] as const;
    for (let edge = 0; edge < 3; edge += 1) {
      const a = corners[edge]!;
      const b = corners[(edge + 1) % 3]!;
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      edgeUses.set(key, (edgeUses.get(key) ?? 0) + 1);
      if (!edgeEndpoints.has(key)) edgeEndpoints.set(key, [mesh.vertices[a]!, mesh.vertices[b]!]);
    }
  }
  const [cu, cv] = project(centroidWeighted);
  let radius = Number.POSITIVE_INFINITY;
  for (const [key, uses] of edgeUses) {
    if (uses !== 1) continue;
    const [pa, pb] = edgeEndpoints.get(key)!;
    const [aux, auy] = project(pa);
    const [bux, buy] = project(pb);
    radius = Math.min(radius, pointSegmentDistance2D(cu, cv, aux, auy, bux, buy));
  }
  if (!Number.isFinite(radius) || radius < JOINT_PLANE_MIN_BOUNDARY_RADIUS_METERS) return undefined;
  const dominantAxis = Math.max(Math.abs(normal.x), Math.abs(normal.y), Math.abs(normal.z));
  return {
    normal: sanitizePoint(normal),
    // The refit plane passes through the area-weighted centroid by
    // construction, so the centroid is already on the plane.
    origin: sanitizePoint(centroidWeighted),
    boundaryRadiusMeters: radius,
    axisAlignmentDegrees: (Math.acos(Math.max(-1, Math.min(1, dominantAxis))) * 180) / Math.PI,
    faceAreaSquareMeters: totalArea,
    inlierCount: members.length,
    pointCount: mesh.triangles.length,
  };
}

/**
 * A joint face must be reachable from outside, so its normal follows the
 * escaping ray: cast from the origin both ways and orient along the side
 * nothing blocks. Courtyard walls orient into the courtyard, not the wing.
 * Faces blocked both ways are interior, not joints. Faces open both ways
 * are non-volumetric plates; they orient away from the mesh centroid.
 * Coplanar grazes at the origin (t near 0) never count; only strictly
 * forward geometry occludes.
 */
function orientJointFace(
  mesh: JointPlaneMesh,
  meshCentroid: JointPlaneVertex,
  members: ReadonlyArray<TriangleFact>,
  face: JointPlaneFit,
): JointPlaneFit | undefined {
  const forwardBlocked = rayBlocked(mesh, members, face.origin, face.normal);
  const backwardBlocked = rayBlocked(mesh, members, face.origin, {
    x: -face.normal.x,
    y: -face.normal.y,
    z: -face.normal.z,
  });
  if (forwardBlocked && backwardBlocked) return undefined;
  if (!forwardBlocked && backwardBlocked) return face;
  if (forwardBlocked && !backwardBlocked)
    return {
      ...face,
      normal: sanitizePoint({ x: -face.normal.x, y: -face.normal.y, z: -face.normal.z }),
    };
  if (dot(subtract(face.origin, meshCentroid), face.normal) < 0)
    return {
      ...face,
      normal: sanitizePoint({ x: -face.normal.x, y: -face.normal.y, z: -face.normal.z }),
    };
  return face;
}

function rayBlocked(
  mesh: JointPlaneMesh,
  members: ReadonlyArray<TriangleFact>,
  origin: JointPlaneVertex,
  direction: { readonly x: number; readonly y: number; readonly z: number },
): boolean {
  const memberIndices = new Set(members.map((member) => member.index));
  for (let index = 0; index < mesh.triangles.length; index += 1) {
    if (memberIndices.has(index)) continue;
    const triangle = mesh.triangles[index]!;
    const a = mesh.vertices[triangle[0]];
    const b = mesh.vertices[triangle[1]];
    const c = mesh.vertices[triangle[2]];
    if (a === undefined || b === undefined || c === undefined) continue;
    const edge1 = subtract(b, a);
    const edge2 = subtract(c, a);
    const h = cross(direction, edge2);
    const determinant = dot(edge1, h);
    if (Math.abs(determinant) < 1e-12) continue;
    const inverse = 1 / determinant;
    const s = subtract(origin, a);
    const u = dot(s, h) * inverse;
    if (u < -1e-9 || u > 1 + 1e-9) continue;
    const q = cross(s, edge1);
    const v = dot(direction, q) * inverse;
    if (v < -1e-9 || u + v > 1 + 1e-9) continue;
    const t = dot(edge2, q) * inverse;
    if (t > 1e-6) return true;
  }
  return false;
}
