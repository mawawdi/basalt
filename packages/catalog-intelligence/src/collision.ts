import { compareSpatialStrings } from "../../spatial-core/src/primitives.js";
import { computeVoxelVolumeInclusion } from "../../asset-inspection/src/voxel.js";
import type { NormalizedMesh } from "../../asset-inspection/src/geometry.js";

export interface CollisionPairCandidate {
  readonly assetId: string;
  readonly sourcePath: string;
  readonly packageId?: string;
  readonly kind: "render" | "collision";
  readonly mesh: NormalizedMesh;
  readonly triangleCount?: number;
}

export interface CollisionPairingOptions {
  readonly voxelResolution?: number;
  readonly minimumVolumetricIoU?: number;
  readonly maximumTriangleRatio?: number;
  readonly maximumCollisionTriangles?: number;
  readonly maximumConvexComponents?: number;
}

export interface CollisionGateEvidence {
  readonly syntactic: boolean;
  readonly volumetric: boolean;
  readonly complexity: boolean;
  readonly watertight: boolean;
  readonly convex: boolean;
  readonly volumetricInclusion: number;
  readonly triangleRatio: number;
  readonly convexComponentCount: number;
}

export interface CollisionBinding {
  readonly renderAssetId: string;
  readonly collisionAssetId: string;
  readonly evidence: CollisionGateEvidence;
}

export interface CollisionPairDiagnostic {
  readonly collisionAssetId: string;
  readonly candidateRenderAssetIds: readonly string[];
  readonly reason: "unmatched" | "ambiguous" | "gate_failed";
  readonly evidence?: CollisionGateEvidence;
}

export interface CollisionPairingResult {
  readonly bindings: readonly CollisionBinding[];
  readonly renderCandidates: readonly CollisionPairCandidate[];
  readonly collisionCandidates: readonly CollisionPairCandidate[];
  readonly diagnostics: readonly CollisionPairDiagnostic[];
}

const DEFAULT_OPTIONS: Required<CollisionPairingOptions> = {
  voxelResolution: 128,
  minimumVolumetricIoU: 0.94,
  maximumTriangleRatio: 0.15,
  maximumCollisionTriangles: 2000,
  maximumConvexComponents: 8,
};

export function pairCollisionCompanions(
  input: readonly CollisionPairCandidate[],
  options: CollisionPairingOptions = {},
): CollisionPairingResult {
  const resolved = { ...DEFAULT_OPTIONS, ...options };
  const renderCandidates = input.filter((candidate) => candidate.kind === "render");
  const collisionCandidates = input.filter((candidate) => candidate.kind === "collision");
  const renderByStem = new Map<string, CollisionPairCandidate[]>();
  for (const render of renderCandidates) {
    const key = canonicalStem(render.sourcePath);
    const values = renderByStem.get(key) ?? [];
    values.push(render);
    renderByStem.set(key, values);
  }
  const usedRenderIds = new Set<string>();
  const bindings: CollisionBinding[] = [];
  const diagnostics: CollisionPairDiagnostic[] = [];
  for (const collision of [...collisionCandidates].sort((left, right) =>
    compareSpatialStrings(left.assetId, right.assetId),
  )) {
    const targetStem = companionTargetStem(collision.sourcePath);
    const exact = (renderByStem.get(targetStem) ?? []).filter(
      (candidate) =>
        candidate.packageId === collision.packageId && !usedRenderIds.has(candidate.assetId),
    );
    const samePackage = renderCandidates.filter(
      (candidate) =>
        candidate.packageId === collision.packageId && !usedRenderIds.has(candidate.assetId),
    );
    const candidates =
      exact.length > 0
        ? exact
        : samePackage.filter((candidate) => canonicalStem(candidate.sourcePath) === targetStem);
    if (candidates.length === 0) {
      diagnostics.push({
        collisionAssetId: collision.assetId,
        candidateRenderAssetIds: [],
        reason: "unmatched",
      });
      continue;
    }
    if (candidates.length > 1) {
      diagnostics.push({
        collisionAssetId: collision.assetId,
        candidateRenderAssetIds: candidates.map((candidate) => candidate.assetId).sort(),
        reason: "ambiguous",
      });
      continue;
    }
    const render = candidates[0]!;
    const renderTriangles = render.triangleCount ?? render.mesh.triangles.length;
    const collisionTriangles = collision.triangleCount ?? collision.mesh.triangles.length;
    const alignedCollision = alignCompanionToRender(render.mesh, collision.mesh);
    const volumetricInclusion = computeVoxelVolumeInclusion(
      render.mesh,
      alignedCollision,
      resolved.voxelResolution,
    );
    const triangleRatio = renderTriangles === 0 ? Infinity : collisionTriangles / renderTriangles;
    const watertight = isWatertight(alignedCollision);
    const convex = isConvex(alignedCollision);
    const convexComponentCount = connectedComponentCount(alignedCollision);
    const evidence: CollisionGateEvidence = {
      syntactic: isCollisionCompanionPath(collision.sourcePath),
      volumetric: volumetricInclusion >= resolved.minimumVolumetricIoU,
      complexity:
        triangleRatio <= resolved.maximumTriangleRatio &&
        collisionTriangles <= resolved.maximumCollisionTriangles,
      watertight,
      convex,
      volumetricInclusion,
      triangleRatio,
      convexComponentCount,
    };
    if (
      evidence.syntactic &&
      evidence.volumetric &&
      evidence.complexity &&
      evidence.watertight &&
      evidence.convex &&
      evidence.convexComponentCount <= resolved.maximumConvexComponents
    ) {
      usedRenderIds.add(render.assetId);
      bindings.push({
        renderAssetId: render.assetId,
        collisionAssetId: collision.assetId,
        evidence,
      });
    } else {
      diagnostics.push({
        collisionAssetId: collision.assetId,
        candidateRenderAssetIds: [render.assetId],
        reason: "gate_failed",
        evidence,
      });
    }
  }
  return {
    bindings: bindings.sort((left, right) =>
      compareSpatialStrings(left.renderAssetId, right.renderAssetId),
    ),
    renderCandidates: renderCandidates.filter((candidate) => !usedRenderIds.has(candidate.assetId)),
    collisionCandidates,
    diagnostics,
  };
}

export function isCollisionCompanionPath(sourcePath: string): boolean {
  return (
    /(?:_Collision|_COL)$/iu.test(stripExtension(sourcePath)) ||
    /(?:^|[/\\])(?:UCX|UBX)_/iu.test(sourcePath)
  );
}

function companionTargetStem(sourcePath: string): string {
  const stem = canonicalStem(sourcePath);
  return stem.replace(/(?:_Collision|_COL)$/iu, "").replace(/^(?:UCX|UBX)_/iu, "");
}

function canonicalStem(sourcePath: string): string {
  return stripExtension(sourcePath).split(/[\\/]/u).at(-1)!.toLocaleLowerCase();
}

function stripExtension(sourcePath: string): string {
  return sourcePath.replace(/\.[^.\\/]+$/u, "");
}

function isWatertight(mesh: NormalizedMesh): boolean {
  const edges = new Map<string, number>();
  for (const [a, b, c] of mesh.triangles) {
    for (const [left, right] of [
      [a, b],
      [b, c],
      [c, a],
    ] as const) {
      const key = left < right ? `${left}:${right}` : `${right}:${left}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  return edges.size > 0 && [...edges.values()].every((count) => count === 2);
}

function isConvex(mesh: NormalizedMesh): boolean {
  return triangleComponents(mesh).every((component) => isConvexComponent(mesh, component));
}

function connectedComponentCount(mesh: NormalizedMesh): number {
  return triangleComponents(mesh).length;
}

function triangleComponents(mesh: NormalizedMesh): readonly (readonly number[])[] {
  if (mesh.triangles.length === 0) return [];
  const parent = mesh.triangles.map((_, index) => index);
  const find = (value: number): number => {
    let root = value;
    while (parent[root] !== root) root = parent[root]!;
    while (parent[value] !== value) {
      const next = parent[value]!;
      parent[value] = root;
      value = next;
    }
    return root;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
  };
  const edgeOwner = new Map<string, number>();
  for (let index = 0; index < mesh.triangles.length; index += 1) {
    const triangle = mesh.triangles[index]!;
    for (const [left, right] of [
      [triangle[0], triangle[1]],
      [triangle[1], triangle[2]],
      [triangle[2], triangle[0]],
    ] as const) {
      const key = left < right ? `${left}:${right}` : `${right}:${left}`;
      const owner = edgeOwner.get(key);
      if (owner === undefined) edgeOwner.set(key, index);
      else union(owner, index);
    }
  }
  const components = new Map<number, number[]>();
  for (let index = 0; index < mesh.triangles.length; index += 1) {
    const root = find(index);
    const component = components.get(root) ?? [];
    component.push(index);
    components.set(root, component);
  }
  return [...components.values()];
}

function isConvexComponent(mesh: NormalizedMesh, triangleIndices: readonly number[]): boolean {
  const vertexIndices = new Set<number>();
  for (const triangleIndex of triangleIndices) {
    const triangle = mesh.triangles[triangleIndex];
    if (!triangle) return false;
    for (const vertexIndex of triangle) vertexIndices.add(vertexIndex);
  }
  const vertices = [...vertexIndices]
    .map((index) => mesh.vertices[index])
    .filter((point): point is NonNullable<typeof point> => point !== undefined);
  if (vertices.length === 0) return false;
  for (const triangleIndex of triangleIndices) {
    const triangle = mesh.triangles[triangleIndex]!;
    const a = mesh.vertices[triangle[0]];
    const b = mesh.vertices[triangle[1]];
    const c = mesh.vertices[triangle[2]];
    if (!a || !b || !c) return false;
    const normal = cross(subtract(b, a), subtract(c, a));
    let positive = false;
    let negative = false;
    for (const point of vertices) {
      const side = dot(normal, subtract(point, a));
      positive ||= side > 1e-7;
      negative ||= side < -1e-7;
      if (positive && negative) return false;
    }
  }
  return true;
}

function alignCompanionToRender(render: NormalizedMesh, collision: NormalizedMesh): NormalizedMesh {
  const renderBounds = meshBounds(render);
  const collisionBounds = meshBounds(collision);
  const renderSize = boundsSize(renderBounds);
  const collisionSize = boundsSize(collisionBounds);
  const denominator = collisionSize.reduce((sum, value) => sum + value * value, 0);
  if (denominator <= 1e-12) return collision;
  const scale =
    renderSize.reduce((sum, value, index) => sum + value * collisionSize[index]!, 0) / denominator;
  const renderCenter = boundsCenter(renderBounds);
  const collisionCenter = boundsCenter(collisionBounds);
  return {
    ...collision,
    vertices: collision.vertices.map((point) => ({
      x: (point.x - collisionCenter.x) * scale + renderCenter.x,
      y: (point.y - collisionCenter.y) * scale + renderCenter.y,
      z: (point.z - collisionCenter.z) * scale + renderCenter.z,
    })),
  };
}

function meshBounds(mesh: NormalizedMesh) {
  const minimum = { x: Infinity, y: Infinity, z: Infinity };
  const maximum = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const point of mesh.vertices) {
    minimum.x = Math.min(minimum.x, point.x);
    minimum.y = Math.min(minimum.y, point.y);
    minimum.z = Math.min(minimum.z, point.z);
    maximum.x = Math.max(maximum.x, point.x);
    maximum.y = Math.max(maximum.y, point.y);
    maximum.z = Math.max(maximum.z, point.z);
  }
  return { minimum, maximum };
}

function boundsSize(bounds: ReturnType<typeof meshBounds>) {
  return [
    bounds.maximum.x - bounds.minimum.x,
    bounds.maximum.y - bounds.minimum.y,
    bounds.maximum.z - bounds.minimum.z,
  ];
}

function boundsCenter(bounds: ReturnType<typeof meshBounds>) {
  return {
    x: (bounds.minimum.x + bounds.maximum.x) / 2,
    y: (bounds.minimum.y + bounds.maximum.y) / 2,
    z: (bounds.minimum.z + bounds.maximum.z) / 2,
  };
}

function subtract(
  left: { x: number; y: number; z: number },
  right: { x: number; y: number; z: number },
) {
  return { x: left.x - right.x, y: left.y - right.y, z: left.z - right.z };
}
function cross(
  left: { x: number; y: number; z: number },
  right: { x: number; y: number; z: number },
) {
  return {
    x: left.y * right.z - left.z * right.y,
    y: left.z * right.x - left.x * right.z,
    z: left.x * right.y - left.y * right.x,
  };
}
function dot(
  left: { x: number; y: number; z: number },
  right: { x: number; y: number; z: number },
) {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}
