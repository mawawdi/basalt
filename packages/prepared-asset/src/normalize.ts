import { quantizeQ32_32, type Vector3Fixed } from "../../basalt-types/src/index.js";
import {
  normalizeSource,
  type NormalizationPolicy,
  type NormalizedAsset,
  type RawAssetSource,
} from "../../asset-inspection/src/source.js";
import type { NormalizedMesh } from "../../asset-inspection/src/geometry.js";

interface MutableVector3 {
  x: number;
  y: number;
  z: number;
}

export function normalizeSceneGraph(
  source: RawAssetSource,
  policy: NormalizationPolicy = {},
): NormalizedAsset {
  return normalizeSource(source, policy);
}

export function rebaseAssetPivot(
  mesh: NormalizedMesh,
  policy: "bottom_center_obb" | "volumetric_center",
): { mesh: NormalizedMesh; pivotOffset: Vector3Fixed } {
  if (mesh.vertices.length === 0) throw new Error("Cannot rebase an empty mesh");
  const bounds = mesh.vertices.reduce(
    (current, vertex) => ({
      minimum: {
        x: Math.min(current.minimum.x, vertex.x),
        y: Math.min(current.minimum.y, vertex.y),
        z: Math.min(current.minimum.z, vertex.z),
      },
      maximum: {
        x: Math.max(current.maximum.x, vertex.x),
        y: Math.max(current.maximum.y, vertex.y),
        z: Math.max(current.maximum.z, vertex.z),
      },
    }),
    {
      minimum: { x: Infinity, y: Infinity, z: Infinity },
      maximum: { x: -Infinity, y: -Infinity, z: -Infinity },
    },
  );
  const pivot: MutableVector3 =
    policy === "bottom_center_obb"
      ? {
          x: (bounds.minimum.x + bounds.maximum.x) / 2,
          y: bounds.minimum.y,
          z: (bounds.minimum.z + bounds.maximum.z) / 2,
        }
      : mesh.vertices.reduce(
          (sum, vertex) => ({ x: sum.x + vertex.x, y: sum.y + vertex.y, z: sum.z + vertex.z }),
          { x: 0, y: 0, z: 0 },
        );
  if (policy === "volumetric_center") {
    pivot.x /= mesh.vertices.length;
    pivot.y /= mesh.vertices.length;
    pivot.z /= mesh.vertices.length;
  }
  const rebased = {
    ...mesh,
    vertices: mesh.vertices.map((vertex) => ({
      x: vertex.x - pivot.x,
      y: vertex.y - pivot.y,
      z: vertex.z - pivot.z,
    })),
  };
  return {
    mesh: rebased,
    pivotOffset: {
      x: quantizeQ32_32(pivot.x),
      y: quantizeQ32_32(pivot.y),
      z: quantizeQ32_32(pivot.z),
    },
  };
}
