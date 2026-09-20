import {
  sealCatalogAssetArtifact,
  type CatalogAssetArtifact,
  type CatalogRights,
} from "@basalt/catalog-model";
import { contentHash, quantizeQ32_32, stableJson } from "@basalt/contracts";
import type { NormalizedMesh } from "./geometry.js";
import { inspectGlb, inspectGlbMeshes } from "./glb.js";
import { fitJointPlanes } from "./joint-planes.js";
import { fitSupportPlane, seedFromAssetId, type SupportPlanePatch } from "./support-plane.js";

export interface CatalogGlbSource {
  readonly contentHash: string;
  readonly rights: CatalogRights;
  readonly metersPerSourceUnit: number;
  readonly sourcePurpose: "collision_companion" | "renderable";
}

export type CatalogBottomSupportMeasurement =
  | {
      readonly status: "measured";
      readonly measurementMethod: "planar_patch_fit" | "lower_extrema";
      readonly contactAreaSquareMeters: number;
      readonly evidenceHash: string;
    }
  | { readonly status: "refused"; readonly reason: string };

/** Measure GLB bytes without making any semantic admission decision. */
export function measureCatalogGlb(
  bytes: Uint8Array,
  source: CatalogGlbSource,
): CatalogAssetArtifact {
  const report = inspectGlb(bytes, {
    maximumBytes: bytes.byteLength,
    maximumTriangles: Number.MAX_SAFE_INTEGER,
    maximumTrianglesPerMesh: Number.MAX_SAFE_INTEGER,
    maximumNodes: Number.MAX_SAFE_INTEGER,
    maximumMaterials: Number.MAX_SAFE_INTEGER,
    maximumTextures: Number.MAX_SAFE_INTEGER,
    assetUnitsToMeters: source.metersPerSourceUnit,
    allowDeformableGeometry: true,
  });
  const meshNodes = report.nodes.filter(
    (node) => node.meshIndex !== undefined && node.bounds !== undefined,
  );
  if (meshNodes.length === 0) throw new Error("Source GLB contains no bounded mesh nodes");
  const scale = source.metersPerSourceUnit;
  const minimum = {
    x: Math.min(...meshNodes.map((node) => node.bounds!.minimum[0])) * scale,
    y: Math.min(...meshNodes.map((node) => node.bounds!.minimum[1])) * scale,
    z: Math.min(...meshNodes.map((node) => node.bounds!.minimum[2])) * scale,
  };
  const maximum = {
    x: Math.max(...meshNodes.map((node) => node.bounds!.maximum[0])) * scale,
    y: Math.max(...meshNodes.map((node) => node.bounds!.maximum[1])) * scale,
    z: Math.max(...meshNodes.map((node) => node.bounds!.maximum[2])) * scale,
  };
  const measuredMeshes = inspectGlbMeshes(bytes).map((mesh) =>
    scaleMesh(mesh, source.metersPerSourceUnit),
  );
  if (measuredMeshes.length !== meshNodes.length)
    throw new Error("Measured mesh inventory does not match bounded mesh nodes");
  const geometry = combineMeshes(measuredMeshes);
  const deformable = report.deformationMode !== "static";
  const collisionCompanion = source.sourcePurpose === "collision_companion";
  const supportMeasurement = deformable
    ? ({
        status: "refused",
        reason: "Support is pose-dependent for animated or skinned geometry",
      } as const)
    : measureCatalogBottomSupport(geometry, source.contentHash);
  const jointResult = deformable
    ? ({
        status: "refused",
        reason: "Interfaces are pose-dependent for animated or skinned geometry",
      } as const)
    : fitJointPlanes(geometry);
  const socketEvidence =
    jointResult.status === "fit"
      ? contentHash(stableJson({ policy: MEASUREMENT_POLICY_HASH, result: jointResult }))
      : undefined;
  const sockets =
    jointResult.status === "fit"
      ? jointResult.fits.map((fit, index) => {
          const up = socketUp(fit.normal);
          const evidenceHash = contentHash(stableJson({ policy: MEASUREMENT_POLICY_HASH, fit }));
          return {
            socketId: `geometric_${index.toString(16).padStart(4, "0")}_${evidenceHash.slice(0, 12)}`,
            localOriginMeters: fixedVector(fit.origin),
            normal: fixedVector(fit.normal),
            up: fixedVector(up),
            boundaryRadiusMeters: quantizeQ32_32(fit.boundaryRadiusMeters),
            evidenceHash,
          };
        })
      : [];
  const collisionOrientedBounds = collisionCompanion
    ? meshNodes.map((node) => collisionBounds(node.bounds!, scale))
    : [];
  const collisionEvidenceHash = collisionCompanion
    ? contentHash(
        stableJson({
          policy: MEASUREMENT_POLICY_HASH,
          sourcePurpose: source.sourcePurpose,
          orientedBounds: collisionOrientedBounds,
        }),
      )
    : undefined;
  const measurementEvidenceHashes = [
    report.hash,
    supportMeasurement.status === "measured" ? supportMeasurement.evidenceHash : undefined,
    socketEvidence,
    collisionEvidenceHash,
  ]
    .filter((hash): hash is string => hash !== undefined)
    .sort();
  return sealCatalogAssetArtifact({
    source: {
      contentHash: source.contentHash,
      rights: source.rights,
      sourceArtifact: {
        artifactHash: source.contentHash,
        bytes: report.byteLength,
        mediaType: "model/gltf-binary",
      },
    },
    geometryHash: catalogGeometryHash(geometry),
    deformation: {
      mode: report.deformationMode,
      measuredPose: report.measuredPose,
      animationCount: report.animationCount,
      skinCount: report.skinCount,
    },
    coordinateFrame: {
      handedness: "right_handed",
      up: "+Y",
      forward: "-Z",
      unitsToMeters: quantizeQ32_32(scale),
      canonicalRoot: identityTransform(),
    },
    bounds: { min: fixedVector(minimum), max: fixedVector(maximum) },
    parts: meshNodes.map((node, index) => ({
      partId: `part_${index.toString(16).padStart(8, "0")}`,
      geometryHash: catalogGeometryHash(measuredMeshes[index]!),
      role: collisionCompanion
        ? ("collision_proxy" as const)
        : deformable
          ? ("render_interactive" as const)
          : ("render_static" as const),
      transform: identityTransform(),
      bounds: {
        min: fixedVector({
          x: node.bounds!.minimum[0] * scale,
          y: node.bounds!.minimum[1] * scale,
          z: node.bounds!.minimum[2] * scale,
        }),
        max: fixedVector({
          x: node.bounds!.maximum[0] * scale,
          y: node.bounds!.maximum[1] * scale,
          z: node.bounds!.maximum[2] * scale,
        }),
      },
      triangleCount: node.triangleCount,
      materialHashes: (node.materialNames ?? [])
        .map((name) => report.materials.find((material) => material.name === name)?.appearanceHash)
        .filter((hash): hash is string => hash !== undefined)
        .sort(),
    })),
    materials: report.materials.map((material) => ({
      appearanceHash: material.appearanceHash,
      payloadHashes: material.texturePayloadHashes,
      pbrChannels: material.pbrChannels.filter(
        (
          channel,
        ): channel is
          "base_color" | "metallic_roughness" | "normal" | "occlusion" | "opacity" | "emissive" =>
          channel !== "specular",
      ),
    })),
    support: {
      primaryContact: supportMeasurement.status === "measured" ? "bottom" : "unknown",
      contactAreaSquareMeters:
        supportMeasurement.status === "measured"
          ? quantizeQ32_32(supportMeasurement.contactAreaSquareMeters)
          : "0",
      measurementMethod:
        supportMeasurement.status === "measured" ? supportMeasurement.measurementMethod : "refused",
      ...(supportMeasurement.status === "measured"
        ? { evidenceHash: supportMeasurement.evidenceHash }
        : {}),
      ...(supportMeasurement.status === "refused"
        ? {
            refusalReason: `Geometric bottom-contact measurement refused: ${supportMeasurement.reason}`,
          }
        : {}),
    },
    collision: collisionCompanion
      ? {
          mode: "part_obbs",
          companionAssetHashes: [],
          orientedBounds: collisionOrientedBounds,
          evidenceHash: collisionEvidenceHash!,
        }
      : { mode: "none", companionAssetHashes: [], orientedBounds: [] },
    sockets,
    ...(jointResult.status === "refused"
      ? { socketMeasurementRefusal: `Geometric interface fit refused: ${jointResult.reason}` }
      : sockets.length === 0
        ? { socketMeasurementRefusal: "Geometric interface fit produced no bounded candidates" }
        : {}),
    measurementEvidenceHashes,
  });
}

const MEASUREMENT_POLICY_HASH = contentHash(
  stableJson({
    coordinateSystem: "right_handed_y_up_meters",
    collisionCompanions: "explicit_source_role_with_per_part_axis_aligned_obbs",
    support: "planar_bottom_patch_fit_then_lower_extrema_alignment",
    interfaces: "exterior_planar_component_fit",
    interfaceLimit: 4096,
  }),
);

function collisionBounds(
  bounds: { readonly minimum: readonly number[]; readonly maximum: readonly number[] },
  scale: number,
) {
  const minimum = bounds.minimum.map((value) => value * scale);
  const maximum = bounds.maximum.map((value) => value * scale);
  return {
    center: {
      x: quantizeQ32_32((minimum[0]! + maximum[0]!) / 2),
      y: quantizeQ32_32((minimum[1]! + maximum[1]!) / 2),
      z: quantizeQ32_32((minimum[2]! + maximum[2]!) / 2),
    },
    halfSize: {
      x: quantizeQ32_32((maximum[0]! - minimum[0]!) / 2),
      y: quantizeQ32_32((maximum[1]! - minimum[1]!) / 2),
      z: quantizeQ32_32((maximum[2]! - minimum[2]!) / 2),
    },
    rotation: [0, 0, 0, 1] as [number, number, number, number],
  };
}

/**
 * Measures geometric bottom placement without treating a planar mounting face as a
 * prerequisite. Exact coplanar faces retain their fitted contact area. Otherwise the
 * canonical lower extrema prove only Y-up bottom alignment and deliberately report zero
 * planar area. Intended placement remains creator-authored catalog authority.
 */
export function measureCatalogBottomSupport(
  mesh: NormalizedMesh,
  assetId: string,
): CatalogBottomSupportMeasurement {
  if (mesh.vertices.length === 0 || mesh.triangles.length === 0)
    return { status: "refused", reason: "no_geometry" };
  const exactPatches = bottomContactPatches(mesh);
  const planar = fitSupportPlane(exactPatches, seedFromAssetId(assetId));
  if (planar.status === "fit") {
    const contactAreaSquareMeters = planar.fits.reduce(
      (sum, fit) => sum + Math.PI * fit.boundaryRadiusMeters ** 2,
      0,
    );
    return {
      status: "measured",
      measurementMethod: "planar_patch_fit",
      contactAreaSquareMeters,
      evidenceHash: contentHash(
        stableJson({
          policy: MEASUREMENT_POLICY_HASH,
          method: "planar_patch_fit",
          result: planar,
        }),
      ),
    };
  }

  const minimumY = Math.min(...mesh.vertices.map((vertex) => vertex.y));
  const maximumY = Math.max(...mesh.vertices.map((vertex) => vertex.y));
  const tolerance = Math.max(1e-6, (maximumY - minimumY) * 1e-5);
  const lowerExtrema = mesh.vertices
    .filter((vertex) => vertex.y <= minimumY + tolerance)
    .map((vertex) => fixedVector(vertex));
  const canonicalExtrema = [
    ...new Map(
      lowerExtrema.map((point) => [`${point.x},${point.y},${point.z}`, point] as const),
    ).values(),
  ].sort(compareFixedVectors);
  if (canonicalExtrema.length === 0) return { status: "refused", reason: "no_lower_extrema" };
  return {
    status: "measured",
    measurementMethod: "lower_extrema",
    contactAreaSquareMeters: 0,
    evidenceHash: contentHash(
      stableJson({
        policy: MEASUREMENT_POLICY_HASH,
        method: "lower_extrema",
        minimumY: quantizeQ32_32(minimumY),
        toleranceMeters: quantizeQ32_32(tolerance),
        planarFitRefusal: planar.reason,
        extremaCount: canonicalExtrema.length,
        extremaHash: contentHash(stableJson(canonicalExtrema)),
      }),
    ),
  };
}

function scaleMesh(mesh: NormalizedMesh, scale: number): NormalizedMesh {
  return {
    vertices: mesh.vertices.map((vertex) => ({
      x: vertex.x * scale,
      y: vertex.y * scale,
      z: vertex.z * scale,
    })),
    triangles: mesh.triangles,
  };
}

function combineMeshes(meshes: readonly NormalizedMesh[]): NormalizedMesh {
  const vertices: Array<{ x: number; y: number; z: number }> = [];
  const triangles: Array<readonly [number, number, number]> = [];
  for (const mesh of meshes) {
    const offset = vertices.length;
    vertices.push(...mesh.vertices);
    triangles.push(
      ...mesh.triangles.map(([a, b, c]) => [a + offset, b + offset, c + offset] as const),
    );
  }
  if (vertices.length === 0 || triangles.length === 0)
    throw new Error("Source GLB contains no measurable triangle geometry");
  return { vertices, triangles };
}

/** Hash exact measured geometry independently of source bytes, names, materials,
 * node ordering metadata, and translation. Near-duplicate matching remains a
 * separate evidence channel; this digest intentionally proves only identical
 * normalized triangle serialization. */
export function catalogGeometryHash(mesh: NormalizedMesh): string {
  const minimum = {
    x: Number.POSITIVE_INFINITY,
    y: Number.POSITIVE_INFINITY,
    z: Number.POSITIVE_INFINITY,
  };
  for (const vertex of mesh.vertices) {
    minimum.x = Math.min(minimum.x, vertex.x);
    minimum.y = Math.min(minimum.y, vertex.y);
    minimum.z = Math.min(minimum.z, vertex.z);
  }
  const fixedVertices = mesh.vertices.map((vertex) => {
    const fixed = {
      x: quantizeQ32_32(vertex.x - minimum.x),
      y: quantizeQ32_32(vertex.y - minimum.y),
      z: quantizeQ32_32(vertex.z - minimum.z),
    };
    return { fixed, key: `${fixed.x},${fixed.y},${fixed.z}` };
  });
  const canonicalVertices = [
    ...new Map(fixedVertices.map((vertex) => [vertex.key, vertex.fixed] as const)).values(),
  ].sort(compareFixedVectors);
  const canonicalIndices = new Map<string, number>(
    canonicalVertices.map(
      (vertex, index) => [`${vertex.x},${vertex.y},${vertex.z}`, index] as const,
    ),
  );
  const canonicalTriangles = mesh.triangles
    .map((triangle) =>
      triangle
        .map((vertexIndex) => {
          const vertex = fixedVertices[vertexIndex];
          const canonicalIndex = vertex ? canonicalIndices.get(vertex.key) : undefined;
          if (canonicalIndex === undefined)
            throw new Error("Triangle references an unknown canonical vertex");
          return canonicalIndex;
        })
        .sort((left, right) => left - right),
    )
    .sort(compareIntegerArrays);
  const chunkSize = 4096;
  const vertexChunkHashes: string[] = [];
  for (let offset = 0; offset < canonicalVertices.length; offset += chunkSize)
    vertexChunkHashes.push(
      contentHash(stableJson(canonicalVertices.slice(offset, offset + chunkSize))),
    );
  const triangleChunkHashes: string[] = [];
  for (let offset = 0; offset < canonicalTriangles.length; offset += chunkSize)
    triangleChunkHashes.push(
      contentHash(stableJson(canonicalTriangles.slice(offset, offset + chunkSize))),
    );
  return contentHash(
    stableJson({
      coordinateSystem: "right_handed_y_up_meters",
      canonicalization: "translation_normalized_q32_vertex_and_unoriented_triangle_order",
      vertexCount: canonicalVertices.length,
      triangleCount: canonicalTriangles.length,
      vertexChunkHashes,
      triangleChunkHashes,
    }),
  );
}

function compareFixedVectors(
  left: { readonly x: string; readonly y: string; readonly z: string },
  right: { readonly x: string; readonly y: string; readonly z: string },
): number {
  return (
    compareBigIntegers(left.x, right.x) ||
    compareBigIntegers(left.y, right.y) ||
    compareBigIntegers(left.z, right.z)
  );
}

function compareBigIntegers(left: string, right: string): number {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function compareIntegerArrays(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function bottomContactPatches(mesh: NormalizedMesh): SupportPlanePatch[] {
  const minimumY = Math.min(...mesh.vertices.map((vertex) => vertex.y));
  const maximumY = Math.max(...mesh.vertices.map((vertex) => vertex.y));
  const tolerance = Math.max(1e-6, (maximumY - minimumY) * 1e-5);
  return mesh.triangles
    .map(([a, b, c]) => [mesh.vertices[a], mesh.vertices[b], mesh.vertices[c]] as const)
    .filter(
      (
        polygon,
      ): polygon is readonly [
        NonNullable<(typeof polygon)[0]>,
        NonNullable<(typeof polygon)[1]>,
        NonNullable<(typeof polygon)[2]>,
      ] => polygon.every((point) => point !== undefined && point.y <= minimumY + tolerance),
    )
    .map((polygon) => ({ polygon }));
}

function socketUp(normal: { readonly x: number; readonly y: number; readonly z: number }) {
  const helper = Math.abs(normal.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 0, y: 0, z: 1 };
  const projection = normal.x * helper.x + normal.y * helper.y + normal.z * helper.z;
  const raw = {
    x: helper.x - normal.x * projection,
    y: helper.y - normal.y * projection,
    z: helper.z - normal.z * projection,
  };
  const length = Math.hypot(raw.x, raw.y, raw.z);
  if (!(length > 1e-12)) throw new Error("Geometric interface up axis is degenerate");
  return { x: raw.x / length, y: raw.y / length, z: raw.z / length };
}

function identityTransform() {
  return {
    position: fixedVector({ x: 0, y: 0, z: 0 }),
    rotationQuaternion: ["0", "0", "0", quantizeQ32_32(1)] as [string, string, string, string],
    uniformScale: quantizeQ32_32(1),
  };
}

function fixedVector(value: { x: number; y: number; z: number }) {
  return {
    x: quantizeQ32_32(value.x),
    y: quantizeQ32_32(value.y),
    z: quantizeQ32_32(value.z),
  };
}
