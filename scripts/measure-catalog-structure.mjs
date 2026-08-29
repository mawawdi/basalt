#!/usr/bin/env node
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertRuntimeBuildCurrent } from "./runtime-build-manifest.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "..");
const defaultInventoryPath = resolve(
  repositoryRoot,
  ".basalt/catalog-cache-v1/source-inventory.json",
);
const assetRoot = resolve(repositoryRoot, "3d-assets");

function parseLimit(values) {
  if (values.length === 0) return undefined;
  if (values.length !== 2 || values[0] !== "--limit")
    throw new Error(
      "Usage: node scripts/measure-catalog-structure.mjs [--limit <positive integer>]",
    );
  const limit = Number(values[1]);
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("--limit must be positive");
  return limit;
}

async function canonicalFile(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || (await realpath(path)) !== path)
    throw new Error(`Asset must be a canonical regular file: ${path}`);
  return info;
}

function resolveAssetPath(relativePath) {
  if (!relativePath.startsWith("3d-assets/"))
    throw new Error(`Catalog path is outside the Kenney source root: ${relativePath}`);
  const path = resolve(repositoryRoot, relativePath);
  const prefix = `${assetRoot}${sep}`;
  if (!path.startsWith(prefix) || path.includes(`${sep}..${sep}`))
    throw new Error(`Catalog path escaped the Kenney source root: ${relativePath}`);
  return path;
}

function measureBounds(nodes) {
  const bounds = nodes.filter((node) => node.bounds !== undefined).map((node) => node.bounds);
  if (bounds.length === 0) throw new Error("GLB has no measured mesh bounds");
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (const bound of bounds) {
    for (let index = 0; index < 3; index += 1) {
      minimum[index] = Math.min(minimum[index], bound.minimum[index]);
      maximum[index] = Math.max(maximum[index], bound.maximum[index]);
    }
  }
  const size = maximum.map((value, index) => value - minimum[index]);
  if (size.some((value) => !Number.isFinite(value) || value <= 1e-6))
    throw new Error("GLB has a zero or non-finite measured dimension");
  return size;
}

function measureGlbStructure(bytes) {
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes.byteLength < 20 ||
    header.getUint32(0, true) !== 0x46546c67 ||
    header.getUint32(4, true) !== 2
  )
    throw new Error("Malformed GLB header");
  if (header.getUint32(8, true) !== bytes.byteLength)
    throw new Error("GLB declared length mismatch");
  const jsonLength = header.getUint32(12, true);
  if (header.getUint32(16, true) !== 0x4e4f534a || 20 + jsonLength > bytes.byteLength)
    throw new Error("GLB JSON chunk is malformed");
  const document = JSON.parse(
    Buffer.from(bytes.subarray(20, 20 + jsonLength))
      .toString("utf8")
      .trim(),
  );
  const binaryOffset = 20 + jsonLength;
  const binaryLength =
    binaryOffset + 8 <= bytes.byteLength ? header.getUint32(binaryOffset, true) : 0;
  const binaryType =
    binaryOffset + 8 <= bytes.byteLength ? header.getUint32(binaryOffset + 4, true) : 0;
  if (binaryType !== 0x004e4942 || binaryOffset + 8 + binaryLength > bytes.byteLength)
    throw new Error("GLB binary chunk is missing or malformed");
  if ((document.buffers ?? []).length !== 1 || document.buffers[0].uri !== undefined)
    throw new Error("Catalog structure measurement requires one embedded buffer");
  const binary = bytes.subarray(binaryOffset + 8, binaryOffset + 8 + binaryLength);
  const accessors = document.accessors ?? [];
  const bufferViews = document.bufferViews ?? [];
  const nodes = document.nodes ?? [];
  const meshes = document.meshes ?? [];
  const parents = new Array(nodes.length).fill(-1);
  for (let index = 0; index < nodes.length; index += 1)
    for (const child of nodes[index].children ?? []) {
      if (!Number.isInteger(child) || child < 0 || child >= nodes.length || parents[child] !== -1)
        throw new Error("GLB node graph is malformed");
      parents[child] = index;
    }
  const worldMatrices = nodes.map((_node, index) => worldMatrix(index));
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  let triangleCount = 0;
  const readAccessor = (accessorIndex) => {
    const accessor = accessors[accessorIndex];
    if (!accessor || accessor.type !== "VEC3" || accessor.componentType !== 5126)
      throw new Error("GLB POSITION accessor is unsupported");
    const view = bufferViews[accessor.bufferView];
    if (!view || view.buffer !== 0) throw new Error("GLB POSITION buffer view is missing");
    const offset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    const stride = view.byteStride ?? 12;
    if (offset + Math.max(0, accessor.count - 1) * stride + 12 > binary.byteLength)
      throw new Error("GLB POSITION accessor exceeds its buffer");
    const values = [];
    const data = new DataView(binary.buffer, binary.byteOffset, binary.byteLength);
    for (let index = 0; index < accessor.count; index += 1) {
      const base = offset + index * stride;
      values.push([
        data.getFloat32(base, true),
        data.getFloat32(base + 4, true),
        data.getFloat32(base + 8, true),
      ]);
    }
    return values;
  };
  for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += 1) {
    const node = nodes[nodeIndex];
    if (node.mesh === undefined) continue;
    const mesh = meshes[node.mesh];
    if (!mesh) throw new Error("GLB node references a missing mesh");
    const matrix = worldMatrices[nodeIndex];
    for (const primitive of mesh.primitives ?? []) {
      if ((primitive.mode ?? 4) !== 4) throw new Error("GLB primitive is not triangle mode");
      const positions = readAccessor(primitive.attributes?.POSITION);
      const indexCount =
        primitive.indices === undefined ? positions.length : readIndexCount(primitive.indices);
      if (!Number.isInteger(indexCount / 3)) throw new Error("GLB triangle index count is invalid");
      triangleCount += indexCount / 3;
      for (const position of positions) {
        const point = transformPoint(position, matrix);
        for (let axis = 0; axis < 3; axis += 1) {
          minimum[axis] = Math.min(minimum[axis], point[axis]);
          maximum[axis] = Math.max(maximum[axis], point[axis]);
        }
      }
    }
  }
  if (!Number.isFinite(minimum[0]) || triangleCount < 1)
    throw new Error("GLB has no measurable triangle geometry");
  return {
    boundsStuds: maximum.map((value, axis) => value - minimum[axis]),
    triangleCount,
    meshCount: meshes.length,
    materialSlotCount: Math.max(1, (document.materials ?? []).length),
    texturePixelCount: 0,
  };

  function readIndexCount(accessorIndex) {
    const accessor = accessors[accessorIndex];
    if (
      !accessor ||
      accessor.type !== "SCALAR" ||
      ![5121, 5123, 5125].includes(accessor.componentType)
    )
      throw new Error("GLB index accessor is unsupported");
    return accessor.count;
  }

  function worldMatrix(index) {
    const node = nodes[index];
    const local = node.matrix ?? composeTrs(node.translation, node.rotation, node.scale);
    return parents[index] === -1 ? local : multiply(worldMatrix(parents[index]), local);
  }

  function composeTrs(translation = [0, 0, 0], rotation = [0, 0, 0, 1], scale = [1, 1, 1]) {
    const [x, y, z, w] = rotation;
    const [sx, sy, sz] = scale;
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
      translation[0],
      translation[1],
      translation[2],
      1,
    ];
  }

  function multiply(left, right) {
    const result = new Array(16).fill(0);
    for (let column = 0; column < 4; column += 1)
      for (let row = 0; row < 4; row += 1)
        for (let inner = 0; inner < 4; inner += 1)
          result[column * 4 + row] += left[inner * 4 + row] * right[column * 4 + inner];
    return result;
  }

  function transformPoint(point, matrix) {
    return [
      matrix[0] * point[0] + matrix[4] * point[1] + matrix[8] * point[2] + matrix[12],
      matrix[1] * point[0] + matrix[5] * point[1] + matrix[9] * point[2] + matrix[13],
      matrix[2] * point[0] + matrix[6] * point[1] + matrix[10] * point[2] + matrix[14],
    ];
  }
}

async function main() {
  const limit = parseLimit(process.argv.slice(2));
  await assertRuntimeBuildCurrent(repositoryRoot);
  const { contentHash, stableJson } = await import(
    pathToFileURL(resolve(repositoryRoot, "dist/packages/contracts/src/index.js")).href
  );
  const { inspectGlb } = await import(
    pathToFileURL(resolve(repositoryRoot, "dist/packages/asset-inspection/src/index.js")).href
  );
  const inventory = JSON.parse(await readFile(defaultInventoryPath, "utf8"));
  const assets = [...inventory.assets].sort((left, right) =>
    left.assetId.localeCompare(right.assetId),
  );
  const targets = assets
    .filter(
      (asset) => asset.source.kind === "kenney_cc0" && asset.measurement.status !== "measured",
    )
    .slice(0, limit);
  const failures = [];
  const measuredIds = new Set();
  for (const asset of targets) {
    try {
      const path = resolveAssetPath(asset.source.relativePath);
      await canonicalFile(path);
      const bytes = new Uint8Array(await readFile(path));
      let metrics;
      let coverage;
      try {
        const report = inspectGlb(bytes, {
          maximumBytes: 256 * 1024 * 1024,
          maximumTriangles: 2_000_000,
          maximumTrianglesPerMesh: 2_000_000,
          maximumNodes: 8192,
          maximumMaterials: 512,
          maximumTextures: 512,
          maximumTexturePixels: 64 * 4096 * 4096,
        });
        metrics = {
          boundsStuds: measureBounds(report.nodes),
          triangleCount: report.triangleCount,
          meshCount: report.meshCount,
          materialSlotCount: Math.max(1, report.materialCount),
          texturePixelCount: report.images.reduce(
            (total, image) => total + image.width * image.height,
            0,
          ),
        };
        coverage = ["gltf_structure", "materials", "textures"];
      } catch {
        metrics = measureGlbStructure(bytes);
        coverage = ["gltf_structure"];
      }
      asset.measurement = {
        status: "partial",
        ...metrics,
        hasFiniteGeometry: true,
        previewHashes: [],
        coverage,
      };
      measuredIds.add(asset.assetId);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      asset.measurement = {
        status: "pending",
        reason: `Structure measurement failed: ${reason}`,
      };
      failures.push({ assetId: asset.assetId, reason });
    }
  }
  const material = {
    kind: inventory.kind,
    abi: inventory.abi,
    sourceManifestHashes: inventory.sourceManifestHashes,
    assets,
    families: inventory.families,
  };
  const sealed = { ...material, hash: contentHash(stableJson(material)) };
  await writeFile(defaultInventoryPath, `${stableJson(sealed)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        inventory: defaultInventoryPath,
        scanned: targets.length,
        measuredPartial: measuredIds.size,
        failures: failures.length,
        failureExamples: failures.slice(0, 8),
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(
    `Catalog structure measurement failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
