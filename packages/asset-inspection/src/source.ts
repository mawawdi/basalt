import {
  IDENTITY_MATRIX,
  type GeometryVector3,
  type Matrix4x4,
  type NormalizedMesh,
  multiplyMatrices,
  transformNormal,
  transformPoint,
} from "./geometry.js";

export interface RawSceneNode {
  readonly name?: string;
  readonly parentIndex?: number;
  readonly children?: readonly number[];
  readonly meshIndex?: number;
  readonly matrix?: Matrix4x4;
  readonly translation?: readonly [number, number, number];
  readonly rotation?: readonly [number, number, number, number];
  readonly scale?: readonly [number, number, number];
}

export interface RawMesh {
  readonly vertices: readonly GeometryVector3[];
  readonly triangles: readonly (readonly [number, number, number])[];
  readonly normals?: readonly GeometryVector3[];
  readonly uv0?: readonly (readonly [number, number])[];
  readonly materialIndices?: readonly number[];
}

export interface RawAssetSource {
  readonly nodes: readonly RawSceneNode[];
  readonly meshes: readonly RawMesh[];
  readonly unitScaleMeters?: number;
}

export interface NormalizationPolicy {
  readonly targetStudMeters?: number;
  readonly pivotPolicy?: "bottom_center_obb" | "volumetric_center";
}

export interface NormalizedAsset {
  readonly meshes: readonly NormalizedMesh[];
  readonly nodeWorldMatrices: readonly Matrix4x4[];
  readonly metersPerSourceUnit: number;
  readonly studsPerSourceUnit: number;
  readonly pivotPolicy: "bottom_center_obb" | "volumetric_center";
}

export function accumulateNodeWorldMatrices(nodes: readonly RawSceneNode[]): readonly Matrix4x4[] {
  const parents = nodes.map((node, index) => node.parentIndex ?? findParent(nodes, index));
  const result: Matrix4x4[] = Array.from({ length: nodes.length }, () => IDENTITY_MATRIX);
  const visiting = new Set<number>();
  const visited = new Set<number>();
  const resolve = (index: number): Matrix4x4 => {
    if (visited.has(index)) return result[index]!;
    if (visiting.has(index)) throw new Error("Scene graph contains a transform cycle");
    const node = nodes[index];
    if (!node) throw new Error(`Scene graph references missing node ${index}`);
    visiting.add(index);
    const local = node.matrix ?? composeTrs(node);
    const parent = parents[index] === undefined ? IDENTITY_MATRIX : resolve(parents[index]!);
    const world = multiplyMatrices(parent, local);
    result[index] = world;
    visiting.delete(index);
    visited.add(index);
    return world;
  };
  for (let index = 0; index < nodes.length; index += 1) resolve(index);
  return result;
}

export function normalizeSource(
  source: RawAssetSource,
  policy: NormalizationPolicy = {},
): NormalizedAsset {
  const targetStudMeters = policy.targetStudMeters ?? 0.28;
  const metersPerSourceUnit = source.unitScaleMeters ?? 1;
  if (!Number.isFinite(metersPerSourceUnit) || metersPerSourceUnit <= 0)
    throw new Error("Source unit scale must be finite and positive");
  if (!Number.isFinite(targetStudMeters) || targetStudMeters <= 0)
    throw new Error("Target stud size must be finite and positive");
  const nodeWorldMatrices = accumulateNodeWorldMatrices(source.nodes);
  const unscaledMeshes = source.nodes.flatMap((node, index) => {
    if (node.meshIndex === undefined) return [];
    const mesh = source.meshes[node.meshIndex];
    if (!mesh) throw new Error(`Scene node ${index} references missing mesh ${node.meshIndex}`);
    const world = nodeWorldMatrices[index]!;
    return [{ mesh, world }];
  });
  // Direct unit conversion. Source geometry keeps its authored size: rescaling
  // every asset toward avatar height destroys the metric truth that role
  // bounds, budgets, and placement depend on.
  const conversion = metersPerSourceUnit / targetStudMeters;
  const meshes = unscaledMeshes.map(({ mesh, world }): NormalizedMesh => ({
    vertices: mesh.vertices.map((point) => {
      const transformed = transformPoint(world, point);
      return {
        x: transformed.x * conversion,
        y: transformed.y * conversion,
        z: -transformed.z * conversion,
      };
    }),
    triangles: mesh.triangles,
    ...(mesh.normals
      ? {
          normals: mesh.normals.map((normal) => {
            const transformed = transformNormal(world, normal);
            return { x: transformed.x, y: transformed.y, z: -transformed.z };
          }),
        }
      : {}),
    ...(mesh.uv0 ? { uv0: mesh.uv0 } : {}),
    ...(mesh.materialIndices ? { materialIndices: mesh.materialIndices } : {}),
  }));
  return {
    meshes,
    nodeWorldMatrices,
    metersPerSourceUnit,
    studsPerSourceUnit: conversion,
    pivotPolicy: policy.pivotPolicy ?? "bottom_center_obb",
  };
}

function findParent(nodes: readonly RawSceneNode[], childIndex: number): number | undefined {
  for (let index = 0; index < nodes.length; index += 1)
    if (nodes[index]?.children?.includes(childIndex)) return index;
  return undefined;
}

function composeTrs(node: RawSceneNode): Matrix4x4 {
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  return [
    (1 - 2 * (y * y + z * z)) * sx,
    2 * (x * y + z * w) * sx,
    2 * (x * z - y * w) * sx,
    0,
    2 * (x * y - z * w) * sy,
    (1 - 2 * (x * x + z * z)) * sy,
    2 * (y * z + x * w) * sy,
    0,
    2 * (x * z + y * w) * sz,
    2 * (y * z - x * w) * sz,
    (1 - 2 * (x * x + y * y)) * sz,
    0,
    tx,
    ty,
    tz,
    1,
  ];
}
