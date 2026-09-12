import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { pathToFileURL } from "node:url";

const repositoryRoot = workerData.repositoryRoot;
const trustedSourceRoot = resolve(repositoryRoot, "registry");

function resolveAssetPath(relativePath) {
  if (!relativePath.startsWith("registry/"))
    throw new Error(`Catalog path is outside trusted sources: ${relativePath}`);
  const path = resolve(repositoryRoot, relativePath);
  const prefix = `${trustedSourceRoot}${sep}`;
  if (!path.startsWith(prefix) || path.includes(`${sep}..${sep}`))
    throw new Error(`Catalog path escaped trusted sources: ${relativePath}`);
  return path;
}

async function assertRegularFile(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || (await realpath(path)) !== path)
    throw new Error(`Asset must be a canonical regular file: ${path}`);
}

async function resolveGltfResource(sourcePath, uri) {
  let decoded;
  try {
    decoded = decodeURIComponent(uri);
  } catch {
    throw new Error(`glTF resource URI is not valid percent encoding: ${uri}`);
  }
  if (
    decoded.includes("\0") ||
    decoded.startsWith("/") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(decoded)
  )
    throw new Error(`glTF resource URI is outside the declared source root: ${uri}`);
  const path = resolve(dirname(sourcePath), decoded);
  const prefix = `${trustedSourceRoot}${sep}`;
  if (!path.startsWith(prefix) || path.includes(`${sep}..${sep}`))
    throw new Error(`glTF resource escaped trusted sources: ${uri}`);
  await assertRegularFile(path);
  return new Uint8Array(await readFile(path));
}

function isCollisionCompanion(relativePath) {
  const stem = relativePath.replace(/\.(?:glb|gltf)$/iu, "");
  return /(?:_Collision|_COL)$/iu.test(stem) || /(?:^|[/\\])(?:UCX|UBX)_/iu.test(stem);
}

function mergeMeshes(meshes) {
  const vertices = [];
  const triangles = [];
  for (const mesh of meshes) {
    const offset = vertices.length;
    vertices.push(...mesh.vertices);
    triangles.push(...mesh.triangles.map(([a, b, c]) => [a + offset, b + offset, c + offset]));
  }
  if (vertices.length === 0 || triangles.length === 0)
    throw new Error("GLB has no normalized triangle geometry");
  return { vertices, triangles };
}

function geometryEnvelope(mesh) {
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (const point of mesh.vertices) {
    minimum[0] = Math.min(minimum[0], point.x);
    minimum[1] = Math.min(minimum[1], point.y);
    minimum[2] = Math.min(minimum[2], point.z);
    maximum[0] = Math.max(maximum[0], point.x);
    maximum[1] = Math.max(maximum[1], point.y);
    maximum[2] = Math.max(maximum[2], point.z);
  }
  const boundsStuds = maximum.map((value, axis) => value - minimum[axis]);
  if (
    boundsStuds.some((value) => !Number.isFinite(value)) ||
    boundsStuds.every((value) => value <= 1e-8)
  )
    throw new Error("Normalized geometry has no finite spatial extent");
  return { minimum, maximum, boundsStuds };
}

function emptyCollisionEvidence() {
  return {
    status: "none",
    syntacticGate: false,
    volumetricGate: false,
    complexityGate: false,
    watertight: false,
    convex: false,
    convexComponentCount: 0,
  };
}

async function measureAsset(asset, modules) {
  const {
    quantizeQ32_32,
    inspectGlb,
    inspectGlbMeshes,
    inspectGlbTopology,
    inspectGlbAssetContactPatches,
    packGltfToGlb,
    normalizeSource,
    rebaseAssetPivot,
    measureGeometry,
  } = modules;
  const sourcePath = resolveAssetPath(asset.source.relativePath);
  await assertRegularFile(sourcePath);
  const sourceBytes = new Uint8Array(await readFile(sourcePath));
  const bytes = /\.gltf$/iu.test(sourcePath)
    ? await packGltfToGlb(sourceBytes, (uri) => resolveGltfResource(sourcePath, uri))
    : sourceBytes;
  const report = inspectGlb(bytes, {
    maximumBytes: 256 * 1024 * 1024,
    maximumTriangles: 2_000_000,
    maximumTrianglesPerMesh: 2_000_000,
    maximumNodes: 8192,
    maximumMaterials: 512,
    maximumTextures: 512,
    maximumTexturePixels: 64 * 4096 * 4096,
    assetUnitsToStuds: 1,
  });
  const rawMesh = mergeMeshes(inspectGlbMeshes(bytes));
  const normalized = normalizeSource(
    { nodes: [{ meshIndex: 0 }], meshes: [rawMesh] },
    { pivotPolicy: "bottom_center_obb" },
  );
  const rebased = rebaseAssetPivot(normalized.meshes[0], "bottom_center_obb");
  const pairMesh = {
    ...normalized.meshes[0],
    vertices: normalized.meshes[0].vertices.map((vertex) => ({
      x: vertex.x / normalized.studsPerSourceUnit,
      y: vertex.y / normalized.studsPerSourceUnit,
      z: vertex.z / normalized.studsPerSourceUnit,
    })),
  };
  const envelope = geometryEnvelope(rebased.mesh);
  const geometry = measureGeometry(rebased.mesh);
  const nodeNames = report.nodes
    .filter((node) => node.meshIndex !== undefined)
    .map((node) => node.name);
  const topology = inspectGlbTopology(bytes, nodeNames);
  const geometryEvidenceStatus =
    topology.hasManifoldTopology && Number.isInteger(geometry.genus) && geometry.genus >= 0
      ? "validated"
      : "invalid_topology";
  const bottomPatches = nodeNames.flatMap((nodeName) =>
    inspectGlbAssetContactPatches(bytes, nodeName, { x: 0, y: -1, z: 0 }, 100_000),
  );
  const texturePixelCount = report.images.reduce(
    (total, image) => total + image.width * image.height,
    0,
  );
  const pbrChannels = [
    ...new Set(report.materials.flatMap((material) => material.pbrChannels)),
  ].sort();
  const textureFacts = report.images.map((image) => ({
    width: image.width,
    height: image.height,
    format: "PNG_PBR",
    texelDensityPxPerMeter: quantizeQ32_32(512),
    channelHash: image.sha256,
  }));
  // Contact polygons arrive in asset units; areas convert by the square of the
  // same unit rate the normalized mesh uses.
  const areaToStuds2 = normalized.studsPerSourceUnit ** 2;
  const bottomContactAreaStuds2 =
    bottomPatches.reduce(
      (total, patch) =>
        total +
        Math.abs(
          (patch.polygon[1].x - patch.polygon[0].x) * (patch.polygon[2].z - patch.polygon[0].z),
        ),
      0,
    ) * areaToStuds2;
  const surfaceAreaStuds2 =
    report.nodes.reduce((total, node) => total + (node.surfaceArea ?? 0), 0) * areaToStuds2;
  return {
    assetId: asset.record.assetId,
    mesh: rebased.mesh,
    pairMesh,
    measurement: {
      status: "measured",
      boundsStuds: envelope.boundsStuds,
      boundsMinimumQ32_32: {
        x: quantizeQ32_32(envelope.minimum[0]),
        y: quantizeQ32_32(envelope.minimum[1]),
        z: quantizeQ32_32(envelope.minimum[2]),
      },
      boundsMaximumQ32_32: {
        x: quantizeQ32_32(envelope.maximum[0]),
        y: quantizeQ32_32(envelope.maximum[1]),
        z: quantizeQ32_32(envelope.maximum[2]),
      },
      pivotOffsetQ32_32: {
        x: rebased.pivotOffset.x,
        y: rebased.pivotOffset.y,
        z: rebased.pivotOffset.z,
      },
      triangleCount: report.triangleCount,
      vertexCount: rebased.mesh.vertices.length,
      submeshCount: report.meshCount,
      materialSlotCount: Math.max(1, report.materialCount),
      texturePixelCount,
      supportedSurfaceKinds:
        bottomPatches.length > 0 ? ["floor", "platform", "ramp", "roof", "terrain"] : [],
      primaryContact: bottomPatches.length > 0 ? "bottom" : "unknown",
      bottomContactAreaStuds2,
      surfaceAreaStuds2,
      texelDensityPixelsPerStud: (() => {
        const minimum = report.nodes
          .flatMap((node) => node.uvMetrics ?? [])
          .reduce(
            (best, metric) => Math.min(best, metric.pixelsPerStud.p05),
            Number.POSITIVE_INFINITY,
          );
        return Number.isFinite(minimum) ? minimum : 0;
      })(),
      hasManifoldTopology: topology.hasManifoldTopology,
      geometryEvidenceStatus,
      topologicalGenus: geometry.genus,
      materialAppearanceHashes: report.materials.map((material) => material.appearanceHash).sort(),
      pbrChannels,
      renderable: !isCollisionCompanion(asset.source.relativePath),
      collision: emptyCollisionEvidence(),
      normalizedPivot: "bottom_center_obb",
      textureEvidence: texturePixelCount > 0 ? "embedded" : "none",
      textureFacts,
    },
  };
}

async function main() {
  const [
    { quantizeQ32_32 },
    inspection,
    { normalizeSource },
    { rebaseAssetPivot },
    { measureGeometry },
  ] = await Promise.all([
    import(pathToFileURL(resolve(repositoryRoot, "dist/packages/basalt-types/src/fixed.js")).href),
    import(
      pathToFileURL(resolve(repositoryRoot, "dist/packages/asset-inspection/src/index.js")).href
    ),
    import(
      pathToFileURL(resolve(repositoryRoot, "dist/packages/asset-inspection/src/source.js")).href
    ),
    import(
      pathToFileURL(resolve(repositoryRoot, "dist/packages/prepared-asset/src/normalize.js")).href
    ),
    import(
      pathToFileURL(
        resolve(repositoryRoot, "dist/packages/catalog-intelligence/src/geometric-invariants.js"),
      ).href
    ),
  ]);
  const modules = {
    quantizeQ32_32,
    ...inspection,
    normalizeSource,
    rebaseAssetPivot,
    measureGeometry,
  };
  const results = [];
  for (const asset of workerData.assets) {
    try {
      results.push(await measureAsset(asset, modules));
    } catch (error) {
      results.push({
        assetId: asset.record.assetId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  parentPort.postMessage({ results });
}

main().catch((error) => {
  parentPort.postMessage({ fatal: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
