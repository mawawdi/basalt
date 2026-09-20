import { createHash } from "node:crypto";
import { dequantizeQ32_32 } from "@basalt/contracts";
import {
  sealAssetPlacementGeometry,
  type AssetPlacementGeometry,
  type CatalogAssetArtifact,
} from "@basalt/catalog-model";
import { catalogGeometryHash } from "./catalog-measurement.js";
import { inspectGlbMeshes } from "./glb.js";
import type { GeometryVector3, NormalizedMesh } from "./geometry.js";

/** Conservative packing envelopes, distinct from engine collision or semantic admission. */
export function measureAssetPlacementGeometry(
  bytes: Uint8Array,
  asset: CatalogAssetArtifact,
): AssetPlacementGeometry {
  if (createHash("sha256").update(bytes).digest("hex") !== asset.source.contentHash)
    throw new Error("Placement geometry source hash mismatch");
  if (
    asset.deformation.mode !== "static" ||
    asset.coordinateFrame.up !== "+Y" ||
    asset.coordinateFrame.handedness !== "right_handed"
  )
    throw new Error("Placement geometry requires static canonical Y-up geometry");
  const scale = dequantizeQ32_32(asset.coordinateFrame.unitsToMeters);
  const vertices: GeometryVector3[] = [];
  const triangles: Array<readonly [number, number, number]> = [];
  for (const mesh of inspectGlbMeshes(bytes)) {
    const offset = vertices.length;
    for (const v of mesh.vertices)
      vertices.push({ x: v.x * scale, y: v.y * scale, z: v.z * scale });
    for (const t of mesh.triangles) triangles.push([t[0] + offset, t[1] + offset, t[2] + offset]);
  }
  const mesh = { vertices, triangles };
  if (catalogGeometryHash(mesh) !== asset.geometryHash)
    throw new Error("Placement geometry differs from admitted measurement");
  for (const vertex of vertices)
    for (const axis of ["x", "y", "z"] as const)
      if (
        vertex[axis] < dequantizeQ32_32(asset.bounds.min[axis]) - 1e-6 ||
        vertex[axis] > dequantizeQ32_32(asset.bounds.max[axis]) + 1e-6
      )
        throw new Error("Placement geometry exceeds measured canonical bounds");
  return sealAssetPlacementGeometry({
    assetHash: asset.hash,
    sourceContentHash: asset.source.contentHash,
    geometryHash: asset.geometryHash,
    bands: measureTriangleHeightBands(mesh),
  });
}

/** Clip triangles, not just vertices: long branches and faces crossing a band remain occupied. */
export function measureTriangleHeightBands(mesh: NormalizedMesh): AssetPlacementGeometry["bands"] {
  if (mesh.vertices.length === 0 || mesh.triangles.length === 0)
    throw new Error("Placement geometry is empty");
  let minimumY = Infinity,
    maximumY = -Infinity;
  for (const vertex of mesh.vertices) {
    if (![vertex.x, vertex.y, vertex.z].every(Number.isFinite))
      throw new Error("Nonfinite placement geometry");
    minimumY = Math.min(minimumY, vertex.y);
    maximumY = Math.max(maximumY, vertex.y);
  }
  const count = Math.max(1, Math.ceil((maximumY - minimumY) / 0.35));
  if (!Number.isSafeInteger(count))
    throw new Error("Placement band count exceeds exact integer representation");
  const height = Math.max(1e-6, maximumY - minimumY) / count;
  const measured = Array.from({ length: count }, () => ({
    min: { x: Infinity, y: Infinity, z: Infinity },
    max: { x: -Infinity, y: -Infinity, z: -Infinity },
  }));
  for (const triangle of mesh.triangles) {
    const points = triangle.map((index) => mesh.vertices[index]);
    if (points.some((point) => point === undefined)) throw new Error("Invalid placement triangle");
    const trianglePoints = points as GeometryVector3[];
    const triangleMinimumY = Math.min(...trianglePoints.map((point) => point.y));
    const triangleMaximumY = Math.max(...trianglePoints.map((point) => point.y));
    const firstBand = Math.max(
      0,
      Math.min(count - 1, Math.floor((triangleMinimumY - minimumY) / height)),
    );
    const lastBand = Math.max(
      firstBand,
      Math.min(count - 1, Math.floor((triangleMaximumY - minimumY) / height)),
    );
    for (let index = firstBand; index <= lastBand; index++) {
      const low = minimumY + index * height;
      const high = minimumY + (index + 1) * height;
      const clipped = clipY(clipY(trianglePoints, low, true), high, false);
      for (const point of clipped)
        for (const axis of ["x", "y", "z"] as const) {
          measured[index]!.min[axis] = Math.min(measured[index]!.min[axis], point[axis]);
          measured[index]!.max[axis] = Math.max(measured[index]!.max[axis], point[axis]);
        }
    }
  }
  const result: AssetPlacementGeometry["bands"] = [];
  for (const band of measured)
    if (Number.isFinite(band.min.x)) {
      for (const axis of ["x", "y", "z"] as const) {
        band.min[axis] -= 1e-6;
        band.max[axis] += 1e-6;
      }
      result.push(band);
    }
  if (result.length === 0) throw new Error("Placement geometry has no bounded triangles");
  return result;
}

function clipY(
  points: readonly GeometryVector3[],
  boundary: number,
  keepAbove: boolean,
): GeometryVector3[] {
  const result: GeometryVector3[] = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!,
      b = points[(i + 1) % points.length]!;
    const insideA = keepAbove ? a.y >= boundary : a.y <= boundary;
    const insideB = keepAbove ? b.y >= boundary : b.y <= boundary;
    if (insideA) result.push(a);
    if (insideA !== insideB) {
      const t = (boundary - a.y) / (b.y - a.y);
      result.push({ x: a.x + t * (b.x - a.x), y: boundary, z: a.z + t * (b.z - a.z) });
    }
  }
  return result;
}
