import { sealCatalogAssetArtifact, type CatalogAssetArtifact } from "@basalt/catalog-model";
import { contentHash, quantizeQ32_32, stableJson } from "@basalt/contracts";
import type { NormalizedMesh } from "./geometry.js";
import { inspectGlb, inspectGlbMeshes } from "./glb.js";
import { fitJointPlanes } from "./joint-planes.js";
import { fitSupportPlane, seedFromAssetId, type SupportPlanePatch } from "./support-plane.js";

export interface CatalogGlbSource {
  readonly contentHash: string;
  readonly packageId: string;
  readonly licenseId: string;
  readonly commercialUsePermitted: boolean;
  readonly redistributionPermitted: boolean;
  readonly attribution: string;
  readonly metersPerSourceUnit: number;
}

/** Measure GLB bytes without making any semantic admission decision. */
export function measureCatalogGlb(
  bytes: Uint8Array,
  source: CatalogGlbSource,
): CatalogAssetArtifact {
  const report = inspectGlb(bytes, {
    maximumBytes: 512 * 1024 * 1024,
    maximumTriangles: 20_000_000,
    maximumTrianglesPerMesh: 20_000_000,
    assetUnitsToMeters: source.metersPerSourceUnit,
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
  const geometry = combineMeshes(
    inspectGlbMeshes(bytes).map((mesh) => scaleMesh(mesh, source.metersPerSourceUnit)),
  );
  const supportResult = fitSupportPlane(
    bottomContactPatches(geometry),
    seedFromAssetId(source.contentHash),
  );
  const supportEvidence =
    supportResult.status === "fit"
      ? contentHash(stableJson({ policy: MEASUREMENT_POLICY_HASH, result: supportResult }))
      : undefined;
  const jointResult = fitJointPlanes(geometry);
  const socketEvidence =
    jointResult.status === "fit"
      ? contentHash(stableJson({ policy: MEASUREMENT_POLICY_HASH, result: jointResult }))
      : undefined;
  const sockets =
    jointResult.status === "fit"
      ? jointResult.fits.slice(0, 4096).map((fit, index) => {
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
  const measurementEvidenceHashes = [report.hash, supportEvidence, socketEvidence]
    .filter((hash): hash is string => hash !== undefined)
    .sort();
  return sealCatalogAssetArtifact({
    source: {
      contentHash: source.contentHash,
      packageId: source.packageId,
      licenseId: source.licenseId,
      commercialUsePermitted: source.commercialUsePermitted,
      redistributionPermitted: source.redistributionPermitted,
      attribution: source.attribution,
      sourceArtifact: {
        artifactHash: source.contentHash,
        bytes: report.byteLength,
        mediaType: "model/gltf-binary",
      },
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
      contentHash: contentHash(stableJson({ source: source.contentHash, node: node.name, index })),
      role: "render_static" as const,
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
      pbrChannels: material.pbrChannels.filter(
        (
          channel,
        ): channel is
          "base_color" | "metallic_roughness" | "normal" | "occlusion" | "opacity" | "emissive" =>
          channel !== "specular",
      ),
    })),
    support: {
      primaryContact: supportResult.status === "fit" ? "bottom" : "unknown",
      contactAreaSquareMeters:
        supportResult.status === "fit"
          ? quantizeQ32_32(
              supportResult.fits.reduce(
                (sum, fit) => sum + Math.PI * fit.boundaryRadiusMeters ** 2,
                0,
              ),
            )
          : "0",
      ...(supportEvidence ? { evidenceHash: supportEvidence } : {}),
      ...(supportResult.status === "refused"
        ? { refusalReason: `Geometric bottom-contact fit refused: ${supportResult.reason}` }
        : {}),
    },
    collision: { mode: "none", companionAssetHashes: [], orientedBounds: [] },
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
    support: "extreme_bottom_topology_area_stratified_ransac",
    interfaces: "exterior_planar_component_fit",
    interfaceLimit: 4096,
  }),
);

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
