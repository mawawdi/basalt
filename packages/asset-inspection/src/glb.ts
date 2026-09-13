import { z } from "zod";
import { createHash } from "node:crypto";
import { contentHash, stableJson } from "@basalt/contracts";
import { compareSpatialStrings } from "@basalt/spatial-core";
import type { NormalizedMesh } from "./geometry.js";

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const GLB_VERSION = 2;
const SUPPORTED_EXTENSIONS = new Set([
  "KHR_materials_emissive_strength",
  "KHR_materials_specular",
  "KHR_materials_unlit",
  "KHR_texture_transform",
]);
const componentBytes = new Map([
  [5120, 1],
  [5121, 1],
  [5122, 2],
  [5123, 2],
  [5125, 4],
  [5126, 4],
]);
const typeComponents = new Map([
  ["SCALAR", 1],
  ["VEC2", 2],
  ["VEC3", 3],
  ["VEC4", 4],
  ["MAT2", 4],
  ["MAT3", 9],
  ["MAT4", 16],
]);
const textureReference = z
  .object({
    index: z.number().int().nonnegative(),
    texCoord: z.number().int().min(0).max(7).optional(),
    extensions: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
const pbrMetallicRoughness = z
  .object({
    baseColorFactor: z.array(z.number().finite().min(0).max(1)).length(4).optional(),
    baseColorTexture: textureReference.optional(),
    metallicFactor: z.number().finite().min(0).max(1).optional(),
    roughnessFactor: z.number().finite().min(0).max(1).optional(),
    metallicRoughnessTexture: textureReference.optional(),
  })
  .passthrough();

const gltfSchema = z
  .object({
    asset: z.object({ version: z.literal("2.0") }).passthrough(),
    scene: z.number().int().nonnegative().optional(),
    scenes: z
      .array(z.object({ nodes: z.array(z.number().int().nonnegative()).optional() }).passthrough())
      .optional(),
    nodes: z
      .array(
        z
          .object({
            name: z.string().min(1).max(256).optional(),
            children: z.array(z.number().int().nonnegative()).optional(),
            mesh: z.number().int().nonnegative().optional(),
            matrix: z.array(z.number().finite()).length(16).optional(),
            translation: z.array(z.number().finite()).length(3).optional(),
            rotation: z.array(z.number().finite()).length(4).optional(),
            scale: z.array(z.number().finite()).length(3).optional(),
            skin: z.number().int().nonnegative().optional(),
          })
          .passthrough(),
      )
      .default([]),
    meshes: z
      .array(
        z
          .object({
            name: z.string().optional(),
            primitives: z
              .array(
                z
                  .object({
                    attributes: z.record(z.string(), z.number().int().nonnegative()),
                    indices: z.number().int().nonnegative().optional(),
                    material: z.number().int().nonnegative().optional(),
                    mode: z.number().int().optional(),
                  })
                  .passthrough(),
              )
              .min(1),
          })
          .passthrough(),
      )
      .default([]),
    buffers: z
      .array(
        z
          .object({ byteLength: z.number().int().nonnegative(), uri: z.string().optional() })
          .passthrough(),
      )
      .default([]),
    bufferViews: z
      .array(
        z
          .object({
            buffer: z.number().int().nonnegative(),
            byteOffset: z.number().int().nonnegative().optional(),
            byteLength: z.number().int().nonnegative(),
            byteStride: z.number().int().positive().optional(),
          })
          .passthrough(),
      )
      .default([]),
    accessors: z
      .array(
        z
          .object({
            bufferView: z.number().int().nonnegative().optional(),
            byteOffset: z.number().int().nonnegative().optional(),
            componentType: z.number().int(),
            count: z.number().int().nonnegative(),
            type: z.string(),
            normalized: z.boolean().optional(),
            sparse: z.unknown().optional(),
          })
          .passthrough(),
      )
      .default([]),
    materials: z
      .array(
        z
          .object({
            name: z.string().optional(),
            pbrMetallicRoughness: pbrMetallicRoughness.optional(),
            normalTexture: textureReference
              .extend({ scale: z.number().finite().min(0).max(2).optional() })
              .optional(),
            occlusionTexture: textureReference
              .extend({ strength: z.number().finite().min(0).max(1).optional() })
              .optional(),
            emissiveTexture: textureReference.optional(),
            emissiveFactor: z.array(z.number().finite().min(0)).length(3).optional(),
            alphaMode: z.enum(["OPAQUE", "MASK", "BLEND"]).optional(),
            alphaCutoff: z.number().finite().min(0).max(1).optional(),
            doubleSided: z.boolean().optional(),
          })
          .passthrough(),
      )
      .default([]),
    images: z
      .array(
        z
          .object({
            bufferView: z.number().int().nonnegative().optional(),
            mimeType: z.enum(["image/png", "image/jpeg"]).optional(),
            uri: z.string().optional(),
          })
          .passthrough(),
      )
      .default([]),
    textures: z
      .array(
        z
          .object({
            source: z.number().int().nonnegative().optional(),
            sampler: z.number().int().nonnegative().optional(),
          })
          .passthrough(),
      )
      .default([]),
    samplers: z
      .array(
        z
          .object({
            magFilter: z.union([z.literal(9728), z.literal(9729)]).optional(),
            minFilter: z
              .union([
                z.literal(9728),
                z.literal(9729),
                z.literal(9984),
                z.literal(9985),
                z.literal(9986),
                z.literal(9987),
              ])
              .optional(),
            wrapS: z.union([z.literal(33071), z.literal(33648), z.literal(10497)]).optional(),
            wrapT: z.union([z.literal(33071), z.literal(33648), z.literal(10497)]).optional(),
          })
          .strict(),
      )
      .default([]),
    extensionsUsed: z.array(z.string()).optional(),
    extensionsRequired: z.array(z.string()).optional(),
    animations: z.array(z.unknown()).optional(),
    skins: z.array(z.unknown()).optional(),
  })
  .passthrough();

export interface GlbNodeReport {
  name: string;
  parentName?: string;
  meshIndex?: number;
  triangleCount: number;
  primitiveCount?: number;
  materialNames?: string[];
  attributeNames?: string[];
  /** Measured after the exact exported node transform is applied. */
  surfaceArea?: number;
  /** Sum of UV0 triangle areas for the same rendered primitives. */
  uvArea?: number;
  /** Final-GLB UV measurements grouped by the actually bound material. */
  uvMetrics?: GlbMaterialUvMetrics[];
  worldMatrix: [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  bounds?: { minimum: [number, number, number]; maximum: [number, number, number] };
}

export interface GlbMetricDistribution {
  minimum: number;
  p05: number;
  median: number;
  p95: number;
  maximum: number;
  areaWeightedRms: number;
}

export interface GlbMaterialUvMetrics {
  materialName: string;
  triangleCount: number;
  surfaceAreaAssetUnits2: number;
  uvArea: number;
  degenerateSurfaceFraction: number;
  mirroredSurfaceFraction: number;
  uvBounds: { minimum: [number, number]; maximum: [number, number] };
  unitAtlasOccupancyFraction: number;
  unitAtlasOverlapFraction: number;
  stretchRatio: GlbMetricDistribution;
  pixelsPerMeter: GlbMetricDistribution;
}

export interface GlbInspectionReport {
  kind: "GlbInspectionReport";
  hash: string;
  byteLength: number;
  jsonHash: string;
  deformationMode: "static" | "rigid_animation" | "skinned";
  measuredPose: "static" | "rest_pose";
  animationCount: number;
  skinCount: number;
  nodeCount: number;
  meshCount: number;
  triangleCount: number;
  materialCount: number;
  textureCount: number;
  images: Array<{
    index: number;
    mimeType: "image/png" | "image/jpeg";
    width: number;
    height: number;
    sha256: string;
    alphaChannel: "present" | "absent";
  }>;
  materials: Array<{
    name: string;
    appearanceHash: string;
    texturePayloadHashes: string[];
    textureChannels: Array<
      "base_color" | "metallic_roughness" | "normal" | "occlusion" | "opacity" | "emissive"
    >;
    /** Effective channels in the final GLB, including glTF's scalar PBR factors. */
    pbrChannels: Array<
      | "base_color"
      | "metallic_roughness"
      | "normal"
      | "occlusion"
      | "opacity"
      | "emissive"
      | "specular"
    >;
    /** Independently decoded glTF values after specification defaults are applied. */
    properties: {
      baseColorFactor: [number, number, number, number];
      metallicFactor: number;
      roughnessFactor: number;
      emissiveFactor: [number, number, number];
      alphaMode: "OPAQUE" | "MASK" | "BLEND";
      alphaCutoff: number | null;
      opacityAuthority: "none" | "base_color_factor" | "base_color_texture_alpha";
      doubleSided: boolean;
    };
    /** Exact embedded base-color image area when that channel is textured. */
    baseColorTexturePixels?: number;
    /** Content hash of the bound base-color image when that channel is textured. */
    baseColorImageSha256?: string;
  }>;
  nodes: GlbNodeReport[];
  extensions: string[];
}

export interface GlbInspectionOptions {
  maximumBytes?: number;
  maximumTriangles?: number;
  maximumTrianglesPerMesh?: number;
  maximumNodes?: number;
  maximumMaterials?: number;
  maximumTextures?: number;
  maximumTexturePixels?: number;
  expectedNodeNames?: readonly string[];
  /** Permit physical inspection of animated/skinned sources at their authored
   * rest/bind pose. This does not validate animation playback or deformation. */
  allowDeformableGeometry?: boolean;
  /** Uniform metric scale of the adapted GLB. Required for admission-grade
   * pixels-per-meter measurements; defaults to one for generic inspection. */
  assetUnitsToMeters?: number;
}

export type GltfExternalResourceResolver = (uri: string) => Uint8Array | Promise<Uint8Array>;

/**
 * Pack a .gltf JSON document and its bounded external resources into the
 * canonical embedded-resource GLB inspection form.
 */
export async function packGltfToGlb(
  jsonBytes: Uint8Array,
  resolveExternalResource?: GltfExternalResourceResolver,
): Promise<Uint8Array> {
  if (jsonBytes.byteLength === 0 || jsonBytes.byteLength > 256 * 1024 * 1024)
    throw new Error("glTF JSON is outside the admitted byte range");
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(jsonBytes));
  } catch {
    throw new Error("glTF JSON is invalid UTF-8 JSON");
  }
  const gltf = gltfSchema.parse(decoded);
  if (gltf.animations?.length || gltf.skins?.length)
    throw new Error("Animations and skins are outside the current Blender scene contract");
  const sourceBuffers = await Promise.all(
    gltf.buffers.map(async (buffer, index) => {
      if (!buffer.uri)
        throw new Error(`glTF buffer ${index} has no URI; use GLB for embedded buffers`);
      const bytes = await resolveGltfResource(buffer.uri, resolveExternalResource);
      if (bytes.byteLength < buffer.byteLength)
        throw new Error(`glTF buffer ${index} is shorter than its declared byteLength`);
      return bytes;
    }),
  );
  const bases: number[] = [];
  let totalLength = 0;
  for (const bytes of sourceBuffers) {
    totalLength = align4(totalLength);
    bases.push(totalLength);
    totalLength += bytes.byteLength;
  }
  const adjustedViews = gltf.bufferViews.map((bufferView, index) => {
    const source = sourceBuffers[bufferView.buffer];
    if (!source) throw new Error(`glTF bufferView ${index} references a missing buffer`);
    const offset = bufferView.byteOffset ?? 0;
    if (offset + bufferView.byteLength > source.byteLength)
      throw new Error(`glTF bufferView ${index} exceeds its source buffer`);
    return {
      ...bufferView,
      buffer: 0,
      byteOffset: bases[bufferView.buffer]! + offset,
    };
  });
  const imageViews = [...adjustedViews];
  const extraImageBytes = new Map<number, Uint8Array>();
  const imageRecords = await Promise.all(
    gltf.images.map(async (image, index) => {
      let bufferViewIndex = image.bufferView;
      let mimeType = image.mimeType;
      if (image.uri) {
        const bytes = await resolveGltfResource(image.uri, resolveExternalResource);
        const offset = align4(totalLength);
        totalLength = offset + bytes.byteLength;
        imageViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.byteLength });
        bufferViewIndex = imageViews.length - 1;
        mimeType ??= inferImageMimeType(bytes, image.uri);
        extraImageBytes.set(bufferViewIndex, bytes);
      }
      if (bufferViewIndex === undefined)
        throw new Error(`glTF image ${index} has no URI or bufferView`);
      const imageView = imageViews[bufferViewIndex];
      if (!imageView) throw new Error(`glTF image ${index} references a missing bufferView`);
      if (!mimeType) {
        const sourceView = gltf.bufferViews[image.bufferView ?? -1];
        const sourceBuffer = sourceView ? sourceBuffers[sourceView.buffer] : undefined;
        if (!sourceView || !sourceBuffer)
          throw new Error(`glTF image ${index} references a missing source bufferView`);
        const imageBytes = sourceBuffer.subarray(
          sourceView.byteOffset ?? 0,
          (sourceView.byteOffset ?? 0) + sourceView.byteLength,
        );
        mimeType = inferImageMimeType(imageBytes, `image-${index}`);
      }
      if (mimeType !== "image/png" && mimeType !== "image/jpeg")
        throw new Error(`glTF image ${index} uses an unsupported MIME type`);
      return { ...image, bufferView: bufferViewIndex, mimeType, uri: undefined };
    }),
  );
  if (totalLength > 256 * 1024 * 1024) throw new Error("Packed glTF exceeds the byte budget");
  const binary = new Uint8Array(totalLength);
  for (let index = 0; index < sourceBuffers.length; index += 1)
    binary.set(sourceBuffers[index]!, bases[index]!);
  for (const [viewIndex, bytes] of extraImageBytes)
    binary.set(bytes, imageViews[viewIndex]!.byteOffset);
  const packedDocument = {
    ...gltf,
    buffers: [{ byteLength: binary.byteLength }],
    bufferViews: imageViews,
    images: imageRecords,
  };
  return encodeGlb(packedDocument, binary);
}

async function resolveGltfResource(
  uri: string,
  resolveExternalResource?: GltfExternalResourceResolver,
): Promise<Uint8Array> {
  if (uri.startsWith("data:")) {
    const comma = uri.indexOf(",");
    if (comma < 0) throw new Error("glTF data URI is malformed");
    const metadata = uri.slice(5, comma);
    const payload = uri.slice(comma + 1);
    if (metadata.split(";").includes("base64")) {
      const bytes = Uint8Array.from(Buffer.from(payload, "base64"));
      if (bytes.byteLength === 0 && payload.length > 0) throw new Error("glTF base64 URI is empty");
      return bytes;
    }
    return new TextEncoder().encode(decodeURIComponent(payload));
  }
  if (!resolveExternalResource)
    throw new Error(`glTF external resource requires a resolver: ${uri}`);
  return resolveExternalResource(uri);
}

function inferImageMimeType(bytes: Uint8Array, label: string): "image/png" | "image/jpeg" {
  if (
    bytes.byteLength >= 8 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)
  )
    return "image/png";
  if (bytes.byteLength >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (/\.jpe?g$/iu.test(label)) return "image/jpeg";
  if (/\.png$/iu.test(label)) return "image/png";
  throw new Error(`glTF image MIME type cannot be inferred: ${label}`);
}

function align4(value: number): number {
  return (value + 3) & ~3;
}

function encodeGlb(document: unknown, binary: Uint8Array): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(document));
  const jsonLength = align4(json.byteLength);
  const binaryLength = align4(binary.byteLength);
  const output = new Uint8Array(12 + 8 + jsonLength + 8 + binaryLength);
  const view = new DataView(output.buffer);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, GLB_VERSION, true);
  view.setUint32(8, output.byteLength, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, JSON_CHUNK, true);
  output.set(json, 20);
  output.fill(0x20, 20 + json.byteLength, 20 + jsonLength);
  const binaryHeader = 20 + jsonLength;
  view.setUint32(binaryHeader, binaryLength, true);
  view.setUint32(binaryHeader + 4, BIN_CHUNK, true);
  output.set(binary, binaryHeader + 8);
  return output;
}

export interface GlbCollisionSupportPatch {
  polygon: [
    { x: number; y: number; z: number },
    { x: number; y: number; z: number },
    { x: number; y: number; z: number },
  ];
  normal: { x: number; y: number; z: number };
}

/** Extract normalized triangle buffers for deterministic offline geometry gates. */
export function inspectGlbMeshes(bytes: Uint8Array): readonly NormalizedMesh[] {
  if (bytes.byteLength < 20 || bytes.byteLength > 512 * 1024 * 1024)
    throw new Error("GLB byte length is outside the admitted range");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC || view.getUint32(4, true) !== GLB_VERSION)
    throw new Error("Malformed GLB header");
  const jsonLength = view.getUint32(12, true);
  if (view.getUint32(16, true) !== JSON_CHUNK || 20 + jsonLength > bytes.byteLength)
    throw new Error("Malformed GLB JSON chunk");
  const gltf = gltfSchema.parse(
    JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(20, 20 + jsonLength)),
    ),
  );
  const binaryOffset = 20 + jsonLength;
  if (binaryOffset + 8 > bytes.byteLength || view.getUint32(binaryOffset + 4, true) !== BIN_CHUNK)
    throw new Error("GLB geometry extraction requires an embedded BIN chunk");
  const binaryLength = view.getUint32(binaryOffset, true);
  const binary = bytes.subarray(binaryOffset + 8, binaryOffset + 8 + binaryLength);
  const parents = validateNodeGraph(gltf.nodes);
  const matrices = nodeWorldMatrices(gltf.nodes, parents);
  const meshes: NormalizedMesh[] = [];
  for (let nodeIndex = 0; nodeIndex < gltf.nodes.length; nodeIndex += 1) {
    const node = gltf.nodes[nodeIndex]!;
    if (node.mesh === undefined) continue;
    const mesh = gltf.meshes[node.mesh];
    if (!mesh) throw new Error(`GLB node references missing mesh: ${nodeIndex}`);
    const vertices: Array<{ x: number; y: number; z: number }> = [];
    const vertexIndices = new Map<string, number>();
    const triangles: Array<[number, number, number]> = [];
    for (const primitive of mesh.primitives) {
      if ((primitive.mode ?? 4) !== 4)
        throw new Error("GLB geometry extraction requires triangle primitives");
      const positionIndex = primitive.attributes.POSITION;
      if (positionIndex === undefined) throw new Error("GLB mesh lacks POSITION");
      const positions = accessorTuples(gltf, binary, positionIndex);
      const localIndices: number[] = [];
      for (const position of positions) {
        const transformed = transformPosition(position, matrices[nodeIndex]!);
        const key = transformed.map((value) => Math.round(value * 1_000_000)).join(",");
        let vertexIndex = vertexIndices.get(key);
        if (vertexIndex === undefined) {
          vertexIndex = vertices.length;
          vertices.push({ x: transformed[0], y: transformed[1], z: transformed[2] });
          vertexIndices.set(key, vertexIndex);
        }
        localIndices.push(vertexIndex);
      }
      const indices =
        primitive.indices === undefined
          ? Array.from({ length: positions.length }, (_, index) => index)
          : accessorTuples(gltf, binary, primitive.indices).map((entry) => entry[0]!);
      if (indices.length % 3 !== 0) throw new Error("GLB triangle index count is invalid");
      for (let index = 0; index < indices.length; index += 3)
        triangles.push([
          localIndices[indices[index]!]!,
          localIndices[indices[index + 1]!]!,
          localIndices[indices[index + 2]!]!,
        ]);
    }
    if (vertices.length > 0 && triangles.length > 0) meshes.push({ vertices, triangles });
  }
  return meshes;
}

type GlbCollisionSupportPoint = GlbCollisionSupportPatch["polygon"][number];

export interface GlbAssetContactPatch {
  polygon: [
    { x: number; y: number; z: number },
    { x: number; y: number; z: number },
    { x: number; y: number; z: number },
  ];
  outwardNormal: { x: number; y: number; z: number };
  contactSamples: [{ x: number; y: number; z: number }];
}

export interface GlbTopologyEvidence {
  triangleCount: number;
  boundaryEdgeCount: number;
  nonManifoldEdgeCount: number;
  degenerateTriangleCount: number;
  hasManifoldTopology: boolean;
}

/** Measure indexed and non-indexed triangle topology from the retained GLB. */
export function inspectGlbTopology(
  bytes: Uint8Array,
  expectedNodeNames?: readonly string[],
): GlbTopologyEvidence {
  const report = inspectGlb(bytes, {
    maximumBytes: Math.min(bytes.byteLength, 256 * 1024 * 1024),
    maximumTriangles: 2_000_000,
    maximumTrianglesPerMesh: 2_000_000,
    maximumNodes: 8_192,
    maximumMaterials: 512,
    maximumTextures: 512,
    maximumTexturePixels: 64 * 4096 * 4096,
    ...(expectedNodeNames ? { expectedNodeNames } : {}),
  });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const jsonLength = view.getUint32(12, true);
  const document = gltfSchema.parse(
    JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(20, 20 + jsonLength)),
    ),
  );
  const binaryOffset = 20 + jsonLength;
  const binaryLength = view.getUint32(binaryOffset, true);
  const binary = bytes.subarray(binaryOffset + 8, binaryOffset + 8 + binaryLength);
  const targetNames = expectedNodeNames
    ? new Set(expectedNodeNames)
    : new Set(report.nodes.filter((node) => node.meshIndex !== undefined).map((node) => node.name));
  const edges = new Map<string, number>();
  let triangleCount = 0;
  let degenerateTriangleCount = 0;
  const vertexKey = (position: readonly number[]): string =>
    position.map((value) => Math.round(value * 1_000_000)).join(",");
  const edgeKey = (left: string, right: string): string =>
    left < right ? `${left}|${right}` : `${right}|${left}`;
  for (const node of document.nodes) {
    if (!node.name || !targetNames.has(node.name) || node.mesh === undefined) continue;
    const mesh = document.meshes[node.mesh];
    if (!mesh) continue;
    for (const primitive of mesh.primitives) {
      const positionIndex = primitive.attributes.POSITION;
      if (positionIndex === undefined) continue;
      const positions = accessorTuples(document, binary, positionIndex);
      const indices =
        primitive.indices === undefined
          ? Array.from({ length: positions.length }, (_, index) => index)
          : accessorTuples(document, binary, primitive.indices).map((entry) => entry[0]!);
      for (let index = 0; index < indices.length; index += 3) {
        const triangle = indices.slice(index, index + 3).map((entry) => positions[entry]!);
        if (triangle.length !== 3) continue;
        const keys = triangle.map(vertexKey);
        triangleCount += 1;
        if (new Set(keys).size !== 3) {
          degenerateTriangleCount += 1;
          continue;
        }
        const edgePairs: Array<[string, string]> = [
          [keys[0]!, keys[1]!],
          [keys[1]!, keys[2]!],
          [keys[2]!, keys[0]!],
        ];
        for (const [left, right] of edgePairs) {
          const identity = edgeKey(left, right);
          edges.set(identity, (edges.get(identity) ?? 0) + 1);
        }
      }
    }
  }
  const boundaryEdgeCount = [...edges.values()].filter((count) => count === 1).length;
  const nonManifoldEdgeCount = [...edges.values()].filter((count) => count > 2).length;
  return {
    triangleCount,
    boundaryEdgeCount,
    nonManifoldEdgeCount,
    degenerateTriangleCount,
    hasManifoldTopology:
      triangleCount > 0 && degenerateTriangleCount === 0 && nonManifoldEdgeCount === 0,
  };
}

/** Select the same bounded proxy surfaces before and after glTF float encoding. */
export function selectBoundedPhysicalProxyPatches<
  T extends {
    readonly polygon: readonly { readonly x: number; readonly y: number; readonly z: number }[];
  },
>(patches: readonly T[], maximum: number): T[] {
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 4_096)
    throw new Error("Physical proxy surface budget is invalid");
  const compare = (left: string, right: string): number =>
    left < right ? -1 : left > right ? 1 : 0;
  const quantized = (value: unknown): unknown => {
    if (typeof value === "number") return Math.round(value * 100_000) / 100_000;
    if (Array.isArray(value)) return value.map(quantized);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.keys(value)
          .sort(compare)
          .map((key) => [key, quantized((value as Record<string, unknown>)[key])]),
      );
    return value;
  };
  const normalized = (patch: T): unknown => {
    const polygon = patch.polygon.map(quantized);
    const rotations = [
      polygon,
      [...polygon.slice(1), polygon[0]],
      [...polygon.slice(2), ...polygon.slice(0, 2)],
    ];
    return quantized({
      ...patch,
      polygon: rotations.sort((left, right) => compare(stableJson(left), stableJson(right)))[0],
    });
  };
  const area = (patch: T): number => {
    const [first, second, third] = patch.polygon;
    if (!first || !second || !third) return 0;
    const ab = { x: second.x - first.x, y: second.y - first.y, z: second.z - first.z };
    const ac = { x: third.x - first.x, y: third.y - first.y, z: third.z - first.z };
    return (
      Math.hypot(ab.y * ac.z - ab.z * ac.y, ab.z * ac.x - ab.x * ac.z, ab.x * ac.y - ab.y * ac.x) /
      2
    );
  };
  return [...patches]
    .sort(
      (left, right) =>
        Math.round(area(right) * 100_000) - Math.round(area(left) * 100_000) ||
        compare(stableJson(normalized(left)), stableJson(normalized(right))),
    )
    .slice(0, maximum)
    .sort((left, right) => compare(stableJson(normalized(left)), stableJson(normalized(right))));
}

export function inspectTextureImage(
  bytes: Uint8Array,
  mimeType: "image/png" | "image/jpeg",
  maximumPixels = 4096 * 4096,
): {
  width: number;
  height: number;
  sha256: string;
  alphaChannel: "present" | "absent";
} {
  const dimensions =
    mimeType === "image/png"
      ? pngDimensions(bytes)
      : { ...jpegDimensions(bytes), alphaChannel: "absent" as const };
  if (dimensions.width * dimensions.height > maximumPixels)
    throw new Error("Texture image exceeds the pixel budget");
  return {
    ...dimensions,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

/** Return exact per-primitive attribute and material bindings for one mesh node. */
export function inspectGlbPrimitiveBindings(
  bytes: Uint8Array,
  nodeName: string,
): Array<{ attributes: string[]; materialIndex?: number }> {
  const input = Buffer.from(bytes);
  if (input.byteLength < 20 || input.readUInt32LE(0) !== GLB_MAGIC)
    throw new Error("Primitive binding inspection requires a GLB");
  const jsonLength = input.readUInt32LE(12);
  if (20 + jsonLength > input.byteLength)
    throw new Error("Primitive binding GLB JSON is truncated");
  const document = gltfSchema.parse(
    JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(input.subarray(20, 20 + jsonLength)).trim(),
    ),
  );
  const node = document.nodes.find((entry) => entry.name === nodeName && entry.mesh !== undefined);
  const mesh = node?.mesh === undefined ? undefined : document.meshes[node.mesh];
  if (!mesh?.primitives.length) throw new Error(`GLB node has no primitive inventory: ${nodeName}`);
  return mesh.primitives.map((primitive) => ({
    attributes: Object.keys(primitive.attributes).sort(),
    ...(primitive.material === undefined ? {} : { materialIndex: primitive.material }),
  }));
}

/**
 * Retain the actual upward-facing collision triangles from one final GLB node.
 * Returning triangles rather than a convex footprint preserves mesh holes,
 * overhang boundaries, and disconnected support islands exactly.
 */
export function inspectGlbCollisionSupportPatches(
  bytes: Uint8Array,
  nodeName: string,
  maximumPatches = 100_000,
): GlbCollisionSupportPatch[] {
  return inspectGlbDirectionalTopology(bytes, nodeName, maximumPatches, {
    x: 0,
    y: 1,
    z: 0,
  }).patches.map(({ polygon, normal }) => ({ polygon, normal }));
}

/**
 * Retain the exact extreme triangles facing a creator-declared asset-local
 * contact direction. This measures floor, wall, ceiling, and embedded contact
 * from final GLB topology without trusting a route-authored surface claim.
 */
export function inspectGlbAssetContactPatches(
  bytes: Uint8Array,
  nodeName: string,
  outwardNormal: { readonly x: number; readonly y: number; readonly z: number },
  maximumPatches = 100_000,
): GlbAssetContactPatch[] {
  const normal = normalizedTopologyDirection(outwardNormal);
  const evidence = inspectGlbDirectionalTopology(bytes, nodeName, maximumPatches, normal);
  const directed = evidence.patches;
  if (directed.length === 0) return fallbackContactProxy(evidence.points, normal);
  const projections = directed.flatMap(({ polygon }) =>
    polygon.map((point) => topologyProjection(point, normal)),
  );
  const projectionExtents = projections.reduce(
    (extents, value) => ({
      minimum: Math.min(extents.minimum, value),
      maximum: Math.max(extents.maximum, value),
    }),
    { minimum: Infinity, maximum: -Infinity },
  );
  const extreme = projectionExtents.maximum;
  const tolerance = Math.max(1e-6, (projectionExtents.maximum - projectionExtents.minimum) * 1e-6);
  const patches = directed
    .filter(({ polygon }) =>
      polygon.every((point) => topologyProjection(point, normal) >= extreme - tolerance),
    )
    .map(({ polygon, normal }) => ({
      polygon,
      outwardNormal: normal,
      contactSamples: [
        collisionSupportPoint([
          (polygon[0].x + polygon[1].x + polygon[2].x) / 3,
          (polygon[0].y + polygon[1].y + polygon[2].y) / 3,
          (polygon[0].z + polygon[1].z + polygon[2].z) / 3,
        ]),
      ] as GlbAssetContactPatch["contactSamples"],
    }))
    .sort((left, right) => compareSpatialStrings(stableJson(left), stableJson(right)))
    .filter(({ polygon }) => {
      const first = polygon[0]!;
      const second = polygon[1]!;
      const third = polygon[2]!;
      const cross = cross3(
        subtract3(collisionSupportTuple(second), collisionSupportTuple(first)),
        subtract3(collisionSupportTuple(third), collisionSupportTuple(first)),
      );
      return Math.hypot(...cross) > 1e-8;
    });
  return patches.length > 0 ? patches : fallbackContactProxy(evidence.points, normal);
}

function inspectGlbDirectionalTopology(
  bytes: Uint8Array,
  nodeName: string,
  maximumPatches: number,
  direction: { readonly x: number; readonly y: number; readonly z: number },
): { patches: GlbCollisionSupportPatch[]; points: GlbCollisionSupportPoint[] } {
  if (!Number.isInteger(maximumPatches) || maximumPatches < 1 || maximumPatches > 2_000_000)
    throw new Error("Asset topology-patch budget is invalid");
  inspectGlb(bytes, {
    maximumBytes: Math.min(bytes.byteLength, 256 * 1024 * 1024),
    maximumTriangles: 2_000_000,
    maximumTrianglesPerMesh: 2_000_000,
    maximumNodes: 8_192,
    maximumMaterials: 512,
    maximumTextures: 512,
    maximumTexturePixels: 4096 * 4096,
  });

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: Array<{ type: number; bytes: Uint8Array }> = [];
  let offset = 12;
  while (offset < bytes.byteLength) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    offset += 8;
    chunks.push({ type, bytes: bytes.subarray(offset, offset + length) });
    offset += length;
  }
  const decoded = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(trimJsonPadding(chunks[0]!.bytes)),
  ) as unknown;
  const gltf = gltfSchema.parse(decoded);
  const binary = chunks.find((chunk) => chunk.type === BIN_CHUNK)?.bytes ?? new Uint8Array();
  const parents = validateNodeGraph(gltf.nodes);
  const worldMatrices = nodeWorldMatrices(gltf.nodes, parents);
  const nodeIndex = gltf.nodes.findIndex((node) => node.name === nodeName);
  const node = gltf.nodes[nodeIndex];
  const mesh = node?.mesh === undefined ? undefined : gltf.meshes[node.mesh];
  if (!node || !mesh) throw new Error(`Asset topology node has no mesh: ${nodeName}`);
  const worldMatrix = worldMatrices[nodeIndex]!;
  const retained = new Map<string, GlbCollisionSupportPatch>();
  const worldPoints: GlbCollisionSupportPoint[] = [];
  for (const primitive of mesh.primitives) {
    if ((primitive.mode ?? 4) !== 4)
      throw new Error(`Asset topology mesh is not triangle mode: ${nodeName}`);
    const positionAccessor = primitive.attributes.POSITION;
    if (positionAccessor === undefined)
      throw new Error(`Asset topology mesh lacks POSITION: ${nodeName}`);
    const positions = accessorTuples(gltf, binary, positionAccessor);
    worldPoints.push(
      ...positions.map((position) =>
        collisionSupportPoint(transformPosition(position, worldMatrix)),
      ),
    );
    const indices =
      primitive.indices === undefined
        ? Array.from({ length: positions.length }, (_, index) => index)
        : accessorTuples(gltf, binary, primitive.indices).map((entry) => entry[0]!);
    for (let triangle = 0; triangle < indices.length; triangle += 3) {
      const polygon: GlbCollisionSupportPatch["polygon"] = [
        collisionSupportPoint(transformPosition(positions[indices[triangle]!]!, worldMatrix)),
        collisionSupportPoint(transformPosition(positions[indices[triangle + 1]!]!, worldMatrix)),
        collisionSupportPoint(transformPosition(positions[indices[triangle + 2]!]!, worldMatrix)),
      ];
      const firstEdge = subtract3(
        collisionSupportTuple(polygon[1]),
        collisionSupportTuple(polygon[0]),
      );
      const secondEdge = subtract3(
        collisionSupportTuple(polygon[2]),
        collisionSupportTuple(polygon[0]),
      );
      const cross = cross3(firstEdge, secondEdge);
      const magnitude = Math.hypot(...cross);
      if (magnitude <= 1e-8) continue;
      const normal = {
        x: collisionSupportFloat(cross[0] / magnitude),
        y: collisionSupportFloat(cross[1] / magnitude),
        z: collisionSupportFloat(cross[2] / magnitude),
      };
      if (topologyProjection(normal, direction) <= 1e-5) continue;
      const rotations = [
        polygon,
        [polygon[1], polygon[2], polygon[0]] as GlbCollisionSupportPatch["polygon"],
        [polygon[2], polygon[0], polygon[1]] as GlbCollisionSupportPatch["polygon"],
      ];
      const canonicalPolygon = [...rotations].sort((left, right) =>
        compareSpatialStrings(stableJson(left), stableJson(right)),
      )[0]!;
      const patch = { polygon: canonicalPolygon, normal } satisfies GlbCollisionSupportPatch;
      retained.set(stableJson(patch), patch);
      if (retained.size > maximumPatches)
        throw new Error(`Asset topology mesh exceeds the patch budget: ${nodeName}`);
    }
  }
  return {
    patches: [...retained.values()].sort((left, right) =>
      compareSpatialStrings(stableJson(left), stableJson(right)),
    ),
    points: worldPoints,
  };
}

function fallbackContactProxy(
  points: readonly GlbCollisionSupportPoint[],
  direction: { readonly x: number; readonly y: number; readonly z: number },
): GlbAssetContactPatch[] {
  if (points.length === 0) return [];
  const projections = points.map((point) => topologyProjection(point, direction));
  const extreme = projections.reduce((maximum, value) => Math.max(maximum, value), -Infinity);
  const origin = points[0]!;
  const span = points.reduce(
    (maximum, point) =>
      Math.max(maximum, Math.hypot(point.x - origin.x, point.y - origin.y, point.z - origin.z)),
    1e-5,
  );
  const tolerance = Math.max(1e-6, span * 1e-6);
  const extremePoints = points.filter(
    (_point, index) => projections[index]! >= extreme - tolerance,
  );
  const center = extremePoints.reduce(
    (total, point) => ({
      x: total.x + point.x / extremePoints.length,
      y: total.y + point.y / extremePoints.length,
      z: total.z + point.z / extremePoints.length,
    }),
    { x: 0, y: 0, z: 0 },
  );
  const correction = extreme - topologyProjection(center, direction);
  const contact = collisionSupportPoint([
    center.x + direction.x * correction,
    center.y + direction.y * correction,
    center.z + direction.z * correction,
  ]);
  const reference: [number, number, number] = Math.abs(direction.y) > 0.9 ? [1, 0, 0] : [0, 1, 0];
  const tangentTuple = cross3([direction.x, direction.y, direction.z], reference);
  const tangentLength = Math.hypot(...tangentTuple);
  const tangent = tangentTuple.map((value) => value / tangentLength) as [number, number, number];
  const bitangent = cross3([direction.x, direction.y, direction.z], tangent);
  // Keep fallback contact topology measurable when source packages encode
  // geometry in centimeter-scale units; the typed admission contract rejects
  // triangles whose area is numerically indistinguishable from zero.
  const radius = Math.max(1e-4, span * 1e-2);
  const point = (tangentScale: number, bitangentScale: number) =>
    collisionSupportPoint([
      contact.x + radius * (tangent[0] * tangentScale + bitangent[0] * bitangentScale),
      contact.y + radius * (tangent[1] * tangentScale + bitangent[1] * bitangentScale),
      contact.z + radius * (tangent[2] * tangentScale + bitangent[2] * bitangentScale),
    ]);
  const polygon = [point(1, 0), point(0, 1), point(-1, -1)] as GlbAssetContactPatch["polygon"];
  const canonicalPolygon = (
    [
      polygon,
      [polygon[1], polygon[2], polygon[0]],
      [polygon[2], polygon[0], polygon[1]],
    ] as GlbAssetContactPatch["polygon"][]
  ).sort((left, right) => compareSpatialStrings(stableJson(left), stableJson(right)))[0]!;
  return [
    {
      polygon: canonicalPolygon,
      outwardNormal: {
        x: collisionSupportFloat(direction.x),
        y: collisionSupportFloat(direction.y),
        z: collisionSupportFloat(direction.z),
      },
      contactSamples: [contact],
    },
  ];
}

function normalizedTopologyDirection(direction: {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}): { x: number; y: number; z: number } {
  const magnitude = Math.hypot(direction.x, direction.y, direction.z);
  if (!Number.isFinite(magnitude) || Math.abs(magnitude - 1) > 1e-3)
    throw new Error("Asset contact direction must be normalized");
  return {
    x: collisionSupportFloat(direction.x / magnitude),
    y: collisionSupportFloat(direction.y / magnitude),
    z: collisionSupportFloat(direction.z / magnitude),
  };
}

function topologyProjection(
  point: { readonly x: number; readonly y: number; readonly z: number },
  direction: { readonly x: number; readonly y: number; readonly z: number },
): number {
  return point.x * direction.x + point.y * direction.y + point.z * direction.z;
}

export function inspectGlb(
  bytes: Uint8Array,
  options: GlbInspectionOptions = {},
): GlbInspectionReport {
  const limits = {
    maximumBytes: options.maximumBytes ?? 20 * 1024 * 1024,
    maximumTriangles: options.maximumTriangles ?? 2_000_000,
    maximumTrianglesPerMesh: options.maximumTrianglesPerMesh ?? 20_000,
    maximumNodes: options.maximumNodes ?? 8192,
    maximumMaterials: options.maximumMaterials ?? 512,
    maximumTextures: options.maximumTextures ?? 512,
    maximumTexturePixels: options.maximumTexturePixels ?? 4096 * 4096,
  };
  const assetUnitsToMeters = options.assetUnitsToMeters ?? 1;
  if (!Number.isFinite(assetUnitsToMeters) || assetUnitsToMeters <= 0)
    throw new Error("GLB physical scale must be finite and positive");
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength < 20 ||
    bytes.byteLength > limits.maximumBytes
  )
    throw new Error("GLB byte length is outside the admitted range");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC || view.getUint32(4, true) !== GLB_VERSION)
    throw new Error("Malformed GLB header");
  if (view.getUint32(8, true) !== bytes.byteLength) throw new Error("GLB declared length mismatch");
  const chunks: Array<{ type: number; bytes: Uint8Array }> = [];
  let offset = 12;
  while (offset < bytes.byteLength) {
    if (offset + 8 > bytes.byteLength) throw new Error("Truncated GLB chunk header");
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    offset += 8;
    if (length % 4 !== 0 || offset + length > bytes.byteLength)
      throw new Error("Malformed GLB chunk length");
    chunks.push({ type, bytes: bytes.subarray(offset, offset + length) });
    offset += length;
  }
  if (chunks.length < 1 || chunks.length > 2 || chunks[0]!.type !== JSON_CHUNK)
    throw new Error("GLB requires one JSON chunk followed by at most one BIN chunk");
  if (chunks.length === 2 && chunks[1]!.type !== BIN_CHUNK)
    throw new Error("Unsupported GLB chunk");
  const jsonBytes = trimJsonPadding(chunks[0]!.bytes);
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(jsonBytes));
  } catch {
    throw new Error("GLB JSON chunk is invalid UTF-8 JSON");
  }
  const gltf = gltfSchema.parse(decoded);
  if ((gltf.animations?.length || gltf.skins?.length) && !options.allowDeformableGeometry)
    throw new Error("Animations and skins are outside the current Blender scene contract");
  const extensions = [
    ...new Set([...(gltf.extensionsUsed ?? []), ...(gltf.extensionsRequired ?? [])]),
  ].sort();
  const unsupported = extensions.filter((entry) => !SUPPORTED_EXTENSIONS.has(entry));
  if (unsupported.length) throw new Error(`Unsupported GLB extensions: ${unsupported.join(", ")}`);
  validateExtensionPayloads(decoded, gltf.extensionsUsed ?? [], gltf.extensionsRequired ?? []);
  if (gltf.nodes.length > limits.maximumNodes) throw new Error("GLB node budget exceeded");
  if (gltf.materials.length > limits.maximumMaterials)
    throw new Error("GLB material budget exceeded");
  if (gltf.textures.length > limits.maximumTextures) throw new Error("GLB texture budget exceeded");
  if (gltf.buffers.length !== (chunks.length === 2 ? 1 : 0))
    throw new Error("GLB embedded buffer inventory is inconsistent");
  if (gltf.buffers.some((buffer) => buffer.uri !== undefined))
    throw new Error("GLB external buffer URI rejected");
  if (
    gltf.images.some(
      (image) => image.uri !== undefined || image.bufferView === undefined || !image.mimeType,
    )
  )
    throw new Error("GLB images must be supported embedded buffer views");
  const binary = chunks[1]?.bytes ?? new Uint8Array();
  if (
    gltf.buffers[0] &&
    (gltf.buffers[0].byteLength > binary.byteLength ||
      binary.byteLength - gltf.buffers[0].byteLength > 3)
  )
    throw new Error("GLB embedded buffer length is inconsistent");
  validateBufferViews(gltf, binary.byteLength);
  validateTextureReferences(gltf);
  const imageReports = inspectEmbeddedImages(gltf, binary, limits.maximumTexturePixels);
  const parents = validateNodeGraph(gltf.nodes);
  validateScenes(gltf, parents);
  const worldMatrices = nodeWorldMatrices(gltf.nodes, parents);

  const names = new Set<string>();
  const referencedMeshes = new Set<number>();
  const nodeReports: GlbNodeReport[] = [];
  let totalTriangles = 0;
  for (let index = 0; index < gltf.nodes.length; index += 1) {
    const node = gltf.nodes[index]!;
    const name = node.name ?? `unnamed-${index}`;
    const parentIndex = parents.get(index);
    const parentName =
      parentIndex === undefined
        ? undefined
        : (gltf.nodes[parentIndex]!.name ?? `unnamed-${parentIndex}`);
    const worldMatrix = worldMatrices[index]!;
    if (names.has(name)) throw new Error(`Duplicate GLB node name: ${name}`);
    names.add(name);
    if (node.mesh === undefined) {
      nodeReports.push({
        name,
        ...(parentName ? { parentName } : {}),
        triangleCount: 0,
        worldMatrix,
      });
      continue;
    }
    const mesh = gltf.meshes[node.mesh];
    if (!mesh) throw new Error(`GLB node references missing mesh: ${name}`);
    referencedMeshes.add(node.mesh);
    let triangleCount = 0;
    let surfaceArea = 0;
    let uvArea = 0;
    const uvTrianglesByMaterial = new Map<number, UvMetricTriangle[]>();
    let nodeBounds: GlbNodeReport["bounds"];
    for (const primitive of mesh.primitives) {
      if ((primitive.mode ?? 4) !== 4) throw new Error(`GLB mesh is not triangle mode: ${name}`);
      const positionIndex = primitive.attributes.POSITION;
      if (positionIndex === undefined) throw new Error(`GLB mesh lacks POSITION: ${name}`);
      const position = gltf.accessors[positionIndex];
      if (!position || position.type !== "VEC3" || position.componentType !== 5126)
        throw new Error(`GLB POSITION accessor must be float VEC3: ${name}`);
      for (const [attribute, accessorIndex] of Object.entries(primitive.attributes)) {
        const accessor = gltf.accessors[accessorIndex];
        if (!accessor) throw new Error(`GLB attribute ${attribute} is missing: ${name}`);
        if (accessor.count !== position.count)
          throw new Error(`GLB attribute ${attribute} count differs from POSITION: ${name}`);
        if (attribute === "NORMAL" && (accessor.type !== "VEC3" || accessor.componentType !== 5126))
          throw new Error(`GLB NORMAL accessor must be float VEC3: ${name}`);
        if (
          attribute === "TANGENT" &&
          (accessor.type !== "VEC4" || accessor.componentType !== 5126)
        )
          throw new Error(`GLB TANGENT accessor must be float VEC4: ${name}`);
        if (
          /^TEXCOORD_[0-7]$/u.test(attribute) &&
          (accessor.type !== "VEC2" || ![5121, 5123, 5126].includes(accessor.componentType))
        )
          throw new Error(`GLB ${attribute} accessor is unsupported: ${name}`);
        if (
          ["COLOR_0", "COLOR_1"].includes(attribute) &&
          (!["VEC3", "VEC4"].includes(accessor.type) ||
            ![5121, 5123, 5126].includes(accessor.componentType))
        )
          throw new Error(`GLB ${attribute} accessor is unsupported: ${name}`);
        const isJointAttribute = /^JOINTS_[01]$/u.test(attribute);
        const isWeightAttribute = /^WEIGHTS_[01]$/u.test(attribute);
        if (
          isJointAttribute &&
          (accessor.type !== "VEC4" || ![5121, 5123].includes(accessor.componentType))
        )
          throw new Error(`GLB ${attribute} accessor is unsupported: ${name}`);
        if (
          isWeightAttribute &&
          (accessor.type !== "VEC4" || ![5121, 5123, 5126].includes(accessor.componentType))
        )
          throw new Error(`GLB ${attribute} accessor is unsupported: ${name}`);
        if ((isJointAttribute || isWeightAttribute) && !options.allowDeformableGeometry)
          throw new Error(
            `GLB deformable attribute ${attribute} is outside this contract: ${name}`,
          );
        if (
          !["POSITION", "NORMAL", "TANGENT", "COLOR_0", "COLOR_1"].includes(attribute) &&
          !/^TEXCOORD_[0-7]$/u.test(attribute) &&
          !isJointAttribute &&
          !isWeightAttribute
        )
          throw new Error(`GLB attribute ${attribute} is unsupported: ${name}`);
        validateVertexAttributeValues(gltf, binary, accessorIndex, attribute, name);
      }
      const primitiveTriangles =
        primitive.indices === undefined
          ? position.count / 3
          : accessorCount(gltf, primitive.indices) / 3;
      if (!Number.isInteger(primitiveTriangles))
        throw new Error(`GLB triangle index count is invalid: ${name}`);
      if (primitive.indices !== undefined)
        validateTriangleIndices(gltf, binary, primitive.indices, position.count, name);
      triangleCount += primitiveTriangles;
      const measuredAreas = primitiveAreas(
        gltf,
        binary,
        positionIndex,
        primitive.attributes.TEXCOORD_0,
        primitive.indices,
        worldMatrix,
      );
      surfaceArea += measuredAreas.surfaceArea;
      uvArea += measuredAreas.uvArea;
      if (primitive.attributes.TEXCOORD_0 !== undefined && primitive.material !== undefined) {
        const retained = uvTrianglesByMaterial.get(primitive.material) ?? [];
        retained.push(
          ...primitiveUvMetricTriangles(
            gltf,
            binary,
            positionIndex,
            primitive.attributes.TEXCOORD_0,
            primitive.indices,
            worldMatrix,
          ),
        );
        uvTrianglesByMaterial.set(primitive.material, retained);
      }
      nodeBounds = unionBounds(
        nodeBounds,
        transformedAccessorBounds(gltf, binary, positionIndex, worldMatrix),
      );
      if (primitive.material !== undefined && !gltf.materials[primitive.material])
        throw new Error(`GLB primitive references missing material: ${name}`);
    }
    if (triangleCount > limits.maximumTrianglesPerMesh)
      throw new Error(`GLB mesh exceeds triangle limit: ${name}`);
    totalTriangles += triangleCount;
    nodeReports.push({
      name,
      ...(parentName ? { parentName } : {}),
      meshIndex: node.mesh,
      triangleCount,
      primitiveCount: mesh.primitives.length,
      materialNames: [
        ...new Set(
          mesh.primitives.map((primitive) =>
            primitive.material === undefined
              ? ""
              : gltf.materials[primitive.material]?.name || `material-${primitive.material}`,
          ),
        ),
      ].sort(),
      attributeNames: [
        ...new Set(mesh.primitives.flatMap((primitive) => Object.keys(primitive.attributes))),
      ].sort(),
      surfaceArea,
      uvArea,
      uvMetrics: [...uvTrianglesByMaterial.entries()]
        .map(([materialIndex, triangles]) =>
          summarizeUvMetricTriangles(
            triangles,
            gltf.materials[materialIndex]!.name || `material-${materialIndex}`,
            baseColorTextureDimensions(gltf, imageReports, gltf.materials[materialIndex]!),
            assetUnitsToMeters,
          ),
        )
        .sort((left, right) => compareSpatialStrings(left.materialName, right.materialName)),
      worldMatrix,
      ...(nodeBounds ? { bounds: nodeBounds } : {}),
    });
  }
  if (referencedMeshes.size !== gltf.meshes.length)
    throw new Error("GLB contains meshes outside the declared scene hierarchy");
  if (totalTriangles > limits.maximumTriangles)
    throw new Error("GLB aggregate triangle budget exceeded");
  if (options.expectedNodeNames) {
    const expected = [...options.expectedNodeNames].sort();
    const actual = nodeReports
      .filter((entry) => entry.meshIndex !== undefined)
      .map((entry) => entry.name)
      .sort();
    if (stableJson(actual) !== stableJson(expected))
      throw new Error(
        `GLB node inventory mismatch: expected ${expected.join(", ")}; found ${actual.join(", ")}`,
      );
  }
  const material = {
    kind: "GlbInspectionReport" as const,
    byteLength: bytes.byteLength,
    jsonHash: contentHash(new TextDecoder().decode(jsonBytes)),
    deformationMode:
      (gltf.skins?.length ?? 0) > 0
        ? ("skinned" as const)
        : (gltf.animations?.length ?? 0) > 0
          ? ("rigid_animation" as const)
          : ("static" as const),
    measuredPose:
      (gltf.animations?.length ?? 0) > 0 || (gltf.skins?.length ?? 0) > 0
        ? ("rest_pose" as const)
        : ("static" as const),
    animationCount: gltf.animations?.length ?? 0,
    skinCount: gltf.skins?.length ?? 0,
    nodeCount: gltf.nodes.length,
    meshCount: gltf.meshes.length,
    triangleCount: totalTriangles,
    materialCount: gltf.materials.length,
    textureCount: gltf.textures.length,
    images: imageReports,
    materials: gltf.materials.map((entry, index) => {
      const textureChannels = materialTextureChannels(gltf, imageReports, entry);
      const properties = materialProperties(gltf, imageReports, entry);
      if (
        properties.alphaMode === "MASK" &&
        properties.opacityAuthority !== "base_color_texture_alpha"
      )
        throw new Error(
          `Masked GLB material lacks an actual texture alpha authority: ${entry.name || index}`,
        );
      if (properties.alphaMode === "BLEND" && properties.opacityAuthority === "none")
        throw new Error(
          `Blended GLB material lacks an actual alpha authority: ${entry.name || index}`,
        );
      return {
        name: entry.name || `material-${index}`,
        appearanceHash: materialAppearanceHash(gltf, imageReports, entry),
        texturePayloadHashes: materialTexturePayloadHashes(gltf, imageReports, entry),
        textureChannels,
        pbrChannels: materialPbrChannels(entry, textureChannels),
        properties,
        ...(() => {
          const pixels = baseColorTexturePixels(gltf, imageReports, entry);
          return pixels === undefined ? {} : { baseColorTexturePixels: pixels };
        })(),
        ...(() => {
          const image = referencedTextureImage(
            gltf,
            imageReports,
            entry.pbrMetallicRoughness?.baseColorTexture,
          );
          return image === undefined ? {} : { baseColorImageSha256: image.sha256 };
        })(),
      };
    }),
    nodes: nodeReports,
    extensions,
  };
  return { ...material, hash: contentHash(stableJson(material)) };
}

function materialProperties(
  gltf: z.infer<typeof gltfSchema>,
  images: GlbInspectionReport["images"],
  material: z.infer<typeof gltfSchema>["materials"][number],
): GlbInspectionReport["materials"][number]["properties"] {
  const pbr = material.pbrMetallicRoughness;
  const round = (value: number): number => Math.round(value * 100000) / 100000;
  const baseColor = (pbr?.baseColorFactor ?? [1, 1, 1, 1]).map(round) as [
    number,
    number,
    number,
    number,
  ];
  const emissive = (material.emissiveFactor ?? [0, 0, 0]).map(round) as [number, number, number];
  const alphaMode = material.alphaMode ?? "OPAQUE";
  const baseColorImage = referencedTextureImage(
    gltf,
    images,
    material.pbrMetallicRoughness?.baseColorTexture,
  );
  const opacityAuthority =
    alphaMode === "OPAQUE"
      ? "none"
      : baseColorImage?.alphaChannel === "present"
        ? "base_color_texture_alpha"
        : alphaMode === "BLEND" && baseColor[3] < 1
          ? "base_color_factor"
          : "none";
  return {
    baseColorFactor: baseColor,
    metallicFactor: round(pbr?.metallicFactor ?? 1),
    roughnessFactor: round(pbr?.roughnessFactor ?? 1),
    emissiveFactor: emissive,
    alphaMode,
    alphaCutoff: alphaMode === "MASK" ? round(material.alphaCutoff ?? 0.5) : null,
    opacityAuthority,
    doubleSided: material.doubleSided ?? false,
  };
}

function materialPbrChannels(
  material: z.infer<typeof gltfSchema>["materials"][number],
  textureChannels: GlbInspectionReport["materials"][number]["textureChannels"],
): NonNullable<GlbInspectionReport["materials"][number]["pbrChannels"]> {
  const textureChannelSet = new Set(textureChannels);
  return [
    // A glTF material always has effective base-color, metallic, and roughness
    // factors even when their optional JSON properties use specification defaults.
    "base_color" as const,
    "metallic_roughness" as const,
    ...(textureChannelSet.has("normal") ? (["normal"] as const) : []),
    ...(textureChannelSet.has("occlusion") ? (["occlusion"] as const) : []),
    ...(material.alphaMode !== undefined && material.alphaMode !== "OPAQUE"
      ? (["opacity"] as const)
      : []),
    ...(textureChannelSet.has("emissive") ||
    (material.emissiveFactor ?? [0, 0, 0]).some((value) => value > 0)
      ? (["emissive"] as const)
      : []),
    ...(hasSpecularMaterialExtension(material) ? (["specular"] as const) : []),
  ];
}

function hasSpecularMaterialExtension(
  material: z.infer<typeof gltfSchema>["materials"][number],
): boolean {
  return (
    isPlainRecord(material.extensions) && isPlainRecord(material.extensions.KHR_materials_specular)
  );
}

function baseColorTexturePixels(
  gltf: z.infer<typeof gltfSchema>,
  images: GlbInspectionReport["images"],
  material: z.infer<typeof gltfSchema>["materials"][number],
): number | undefined {
  const reference = material.pbrMetallicRoughness?.baseColorTexture;
  if (!reference) return undefined;
  const texture = gltf.textures[reference.index];
  const image = texture?.source === undefined ? undefined : images[texture.source];
  return image ? image.width * image.height : undefined;
}

function baseColorTextureDimensions(
  gltf: z.infer<typeof gltfSchema>,
  images: GlbInspectionReport["images"],
  material: z.infer<typeof gltfSchema>["materials"][number],
): { width: number; height: number } | undefined {
  const reference = material.pbrMetallicRoughness?.baseColorTexture;
  if (!reference) return undefined;
  const texture = gltf.textures[reference.index];
  const image = texture?.source === undefined ? undefined : images[texture.source];
  return image ? { width: image.width, height: image.height } : undefined;
}

function materialTextureChannels(
  gltf: z.infer<typeof gltfSchema>,
  images: GlbInspectionReport["images"],
  material: z.infer<typeof gltfSchema>["materials"][number],
): GlbInspectionReport["materials"][number]["textureChannels"] {
  const baseColorImage = referencedTextureImage(
    gltf,
    images,
    material.pbrMetallicRoughness?.baseColorTexture,
  );
  return [
    ...(material.pbrMetallicRoughness?.baseColorTexture ? (["base_color"] as const) : []),
    ...(material.pbrMetallicRoughness?.metallicRoughnessTexture
      ? (["metallic_roughness"] as const)
      : []),
    ...(material.normalTexture ? (["normal"] as const) : []),
    ...(material.occlusionTexture ? (["occlusion"] as const) : []),
    ...(material.pbrMetallicRoughness?.baseColorTexture &&
    baseColorImage?.alphaChannel === "present" &&
    material.alphaMode !== undefined &&
    material.alphaMode !== "OPAQUE"
      ? (["opacity"] as const)
      : []),
    ...(material.emissiveTexture ? (["emissive"] as const) : []),
  ];
}

function referencedTextureImage(
  gltf: z.infer<typeof gltfSchema>,
  images: GlbInspectionReport["images"],
  reference: z.infer<typeof textureReference> | undefined,
): GlbInspectionReport["images"][number] | undefined {
  if (!reference) return undefined;
  const texture = gltf.textures[reference.index];
  return texture?.source === undefined ? undefined : images[texture.source];
}

/** Normalize names only. Original bytes remain the source authority; these derived
 * bytes prevent Blender's global material namespace from changing slot identity. */
export function namespaceGlbMaterials(bytes: Uint8Array, sourceId: string): Uint8Array {
  inspectGlb(bytes, { maximumBytes: bytes.byteLength });
  const input = Buffer.from(bytes);
  const jsonLength = input.readUInt32LE(12);
  const document = gltfSchema.parse(
    JSON.parse(input.subarray(20, 20 + jsonLength).toString("utf8")),
  );
  for (const [index, material] of document.materials.entries())
    material.name = `Source_${contentHash(sourceId).slice(0, 20)}_${index}`;
  const json = Buffer.from(JSON.stringify(document));
  const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 0x20);
  json.copy(padded);
  const tail = input.subarray(20 + jsonLength);
  const output = Buffer.alloc(20 + padded.length + tail.length);
  input.copy(output, 0, 0, 12);
  output.writeUInt32LE(output.length, 8);
  output.writeUInt32LE(padded.length, 12);
  output.writeUInt32LE(JSON_CHUNK, 16);
  padded.copy(output, 20);
  tail.copy(output, 20 + padded.length);
  return output;
}

/** Separate every mesh instance in the common asset frame. Parts retain their
 * measured transforms and original material assignments; they can be placed or
 * animated independently without reinterpreting a Blender hierarchy at runtime. */
export function splitGlbMeshParts(
  bytes: Uint8Array,
): Array<{ node: GlbNodeReport; bytes: Uint8Array }> {
  const inspected = inspectGlb(bytes, { maximumBytes: bytes.byteLength });
  const input = Buffer.from(bytes);
  const jsonLength = input.readUInt32LE(12);
  const source = gltfSchema.parse(
    JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        trimJsonPadding(input.subarray(20, 20 + jsonLength)),
      ),
    ),
  );
  const binaryHeader = 20 + jsonLength;
  const binaryLength = input.readUInt32LE(binaryHeader);
  const binary = input.subarray(binaryHeader + 8, binaryHeader + 8 + binaryLength);
  return inspected.nodes
    .filter((node) => node.meshIndex !== undefined)
    .map((node) => {
      const mesh = structuredClone(source.meshes[node.meshIndex!]!);
      const accessorIndices = new Set<number>();
      const materialIndices = new Set<number>();
      for (const primitive of mesh.primitives) {
        for (const index of Object.values(primitive.attributes)) accessorIndices.add(index);
        if (primitive.indices !== undefined) accessorIndices.add(primitive.indices);
        const targets = primitive.targets;
        if (Array.isArray(targets))
          for (const target of targets)
            if (isPlainRecord(target))
              for (const index of Object.values(target))
                if (typeof index === "number" && Number.isInteger(index) && index >= 0)
                  accessorIndices.add(index);
        if (primitive.material !== undefined) materialIndices.add(primitive.material);
      }

      const textureIndices = new Set<number>();
      const retainedMaterials = sortedIndices(materialIndices).map((index) =>
        structuredClone(source.materials[index]!),
      );
      for (const material of retainedMaterials)
        for (const reference of materialTextureReferences(material))
          textureIndices.add(reference.index);

      const imageIndices = new Set<number>();
      const samplerIndices = new Set<number>();
      const retainedTextures = sortedIndices(textureIndices).map((index) => {
        const texture = structuredClone(source.textures[index]!);
        if (texture.source !== undefined) imageIndices.add(texture.source);
        if (texture.sampler !== undefined) samplerIndices.add(texture.sampler);
        return texture;
      });
      const retainedImages = sortedIndices(imageIndices).map((index) =>
        structuredClone(source.images[index]!),
      );
      const retainedSamplers = sortedIndices(samplerIndices).map((index) =>
        structuredClone(source.samplers[index]!),
      );

      const bufferViewIndices = new Set<number>();
      const retainedAccessors = sortedIndices(accessorIndices).map((index) => {
        const accessor = structuredClone(source.accessors[index]!);
        if (accessor.bufferView !== undefined) bufferViewIndices.add(accessor.bufferView);
        return accessor;
      });
      for (const image of retainedImages)
        if (image.bufferView !== undefined) bufferViewIndices.add(image.bufferView);

      const packedChunks: Buffer[] = [];
      let packedLength = 0;
      const retainedBufferViews = sortedIndices(bufferViewIndices).map((index) => {
        const sourceView = source.bufferViews[index]!;
        const start = sourceView.byteOffset ?? 0;
        const padding = (4 - (packedLength % 4)) % 4;
        if (padding) {
          packedChunks.push(Buffer.alloc(padding));
          packedLength += padding;
        }
        const viewBytes = binary.subarray(start, start + sourceView.byteLength);
        const retained = {
          ...structuredClone(sourceView),
          buffer: 0,
          byteOffset: packedLength,
        };
        packedChunks.push(viewBytes);
        packedLength += viewBytes.byteLength;
        return retained;
      });

      const accessorMap = indexMap(accessorIndices);
      const materialMap = indexMap(materialIndices);
      const textureMap = indexMap(textureIndices);
      const imageMap = indexMap(imageIndices);
      const samplerMap = indexMap(samplerIndices);
      const bufferViewMap = indexMap(bufferViewIndices);

      for (const primitive of mesh.primitives) {
        primitive.attributes = Object.fromEntries(
          Object.entries(primitive.attributes).map(([name, index]) => [
            name,
            retainedIndex(accessorMap, index, `attribute ${name}`),
          ]),
        );
        if (primitive.indices !== undefined)
          primitive.indices = retainedIndex(accessorMap, primitive.indices, "indices");
        if (primitive.material !== undefined)
          primitive.material = retainedIndex(materialMap, primitive.material, "material");
        const targets = primitive.targets;
        if (Array.isArray(targets))
          primitive.targets = targets.map((target) =>
            isPlainRecord(target)
              ? Object.fromEntries(
                  Object.entries(target).map(([name, index]) => [
                    name,
                    retainedIndex(accessorMap, Number(index), `morph target ${name}`),
                  ]),
                )
              : target,
          );
      }
      for (const accessor of retainedAccessors)
        if (accessor.bufferView !== undefined)
          accessor.bufferView = retainedIndex(
            bufferViewMap,
            accessor.bufferView,
            "accessor buffer view",
          );
      for (const material of retainedMaterials)
        for (const reference of materialTextureReferences(material))
          reference.index = retainedIndex(textureMap, reference.index, "material texture");
      for (const texture of retainedTextures) {
        if (texture.source !== undefined)
          texture.source = retainedIndex(imageMap, texture.source, "texture image");
        if (texture.sampler !== undefined)
          texture.sampler = retainedIndex(samplerMap, texture.sampler, "texture sampler");
      }
      for (const image of retainedImages)
        if (image.bufferView !== undefined)
          image.bufferView = retainedIndex(bufferViewMap, image.bufferView, "image buffer view");

      const packedBinary = Buffer.concat(packedChunks, packedLength);
      const sourceBuffer = source.buffers[0];
      if (!sourceBuffer) throw new Error("GLB mesh dependency closure lacks its binary buffer");
      const document = {
        asset: source.asset,
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ name: node.name, mesh: 0, matrix: node.worldMatrix }],
        meshes: [mesh],
        buffers: [{ ...sourceBuffer, byteLength: packedBinary.byteLength }],
        bufferViews: retainedBufferViews,
        accessors: retainedAccessors,
        materials: retainedMaterials,
        images: retainedImages,
        textures: retainedTextures,
        samplers: retainedSamplers,
      };
      const extensions = observedExtensionNames(document);
      const extensionsUsed = [...new Set(source.extensionsUsed ?? [])]
        .filter((name) => extensions.has(name))
        .sort();
      const extensionsRequired = [...new Set(source.extensionsRequired ?? [])]
        .filter((name) => extensions.has(name))
        .sort();
      const completeDocument = {
        ...document,
        ...(extensionsUsed.length ? { extensionsUsed } : {}),
        ...(extensionsRequired.length ? { extensionsRequired } : {}),
      };
      const json = Buffer.from(JSON.stringify(completeDocument));
      const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 0x20);
      json.copy(padded);
      const paddedBinary = Buffer.alloc(Math.ceil(packedBinary.length / 4) * 4);
      packedBinary.copy(paddedBinary);
      const output = Buffer.alloc(12 + 8 + padded.length + 8 + paddedBinary.length);
      output.writeUInt32LE(GLB_MAGIC, 0);
      output.writeUInt32LE(GLB_VERSION, 4);
      output.writeUInt32LE(output.length, 8);
      output.writeUInt32LE(padded.length, 12);
      output.writeUInt32LE(JSON_CHUNK, 16);
      padded.copy(output, 20);
      const outputBinaryHeader = 20 + padded.length;
      output.writeUInt32LE(paddedBinary.length, outputBinaryHeader);
      output.writeUInt32LE(BIN_CHUNK, outputBinaryHeader + 4);
      paddedBinary.copy(output, outputBinaryHeader + 8);
      inspectGlb(output, { maximumBytes: output.length });
      return { node, bytes: output };
    });
}

function sortedIndices(values: ReadonlySet<number>): number[] {
  return [...values].sort((left, right) => left - right);
}

function indexMap(values: ReadonlySet<number>): Map<number, number> {
  return new Map(sortedIndices(values).map((value, index) => [value, index]));
}

function retainedIndex(values: ReadonlyMap<number, number>, source: number, label: string): number {
  const retained = values.get(source);
  if (retained === undefined) throw new Error(`GLB part dependency is missing ${label}`);
  return retained;
}

function materialTextureReferences(
  material: z.infer<typeof gltfSchema>["materials"][number],
): Array<z.infer<typeof textureReference>> {
  return [
    material.pbrMetallicRoughness?.baseColorTexture,
    material.pbrMetallicRoughness?.metallicRoughnessTexture,
    material.normalTexture,
    material.occlusionTexture,
    material.emissiveTexture,
  ].filter((value): value is z.infer<typeof textureReference> => value !== undefined);
}

function observedExtensionNames(value: unknown): Set<string> {
  const result = new Set<string>();
  const visit = (entry: unknown): void => {
    if (Array.isArray(entry)) {
      entry.forEach(visit);
      return;
    }
    if (!isPlainRecord(entry)) return;
    for (const [key, child] of Object.entries(entry)) {
      if (key === "extensions" && isPlainRecord(child))
        for (const extension of Object.keys(child)) result.add(extension);
      visit(child);
    }
  };
  visit(value);
  return result;
}

function materialAppearanceHash(
  gltf: z.infer<typeof gltfSchema>,
  images: GlbInspectionReport["images"],
  material: z.infer<typeof gltfSchema>["materials"][number],
): string {
  const texture = (reference: z.infer<typeof textureReference> | undefined) => {
    if (!reference) return null;
    const entry = gltf.textures[reference.index]!;
    const image = images[entry.source!]!;
    const sampler = entry.sampler === undefined ? undefined : gltf.samplers[entry.sampler];
    return {
      image: image.sha256,
      texCoord: reference.texCoord ?? 0,
      extensions: reference.extensions ?? {},
      wrapS: sampler?.wrapS ?? 10497,
      wrapT: sampler?.wrapT ?? 10497,
      magFilter: sampler?.magFilter ?? null,
      minFilter: sampler?.minFilter ?? null,
    };
  };
  const pbr = material.pbrMetallicRoughness;
  const round = (value: number) => Math.round(value * 100000) / 100000;
  return contentHash(
    stableJson({
      baseColor: (pbr?.baseColorFactor ?? [1, 1, 1, 1]).map(round),
      metallic: round(pbr?.metallicFactor ?? 1),
      roughness: round(pbr?.roughnessFactor ?? 1),
      baseColorTexture: texture(pbr?.baseColorTexture),
      metallicRoughnessTexture: texture(pbr?.metallicRoughnessTexture),
      normalTexture: texture(material.normalTexture),
      normalScale: round(material.normalTexture?.scale ?? 1),
      occlusionTexture: texture(material.occlusionTexture),
      occlusionStrength: round(material.occlusionTexture?.strength ?? 1),
      emissiveTexture: texture(material.emissiveTexture),
      emissive: (material.emissiveFactor ?? [0, 0, 0]).map(round),
      alphaMode: material.alphaMode ?? "OPAQUE",
      alphaCutoff: material.alphaMode === "MASK" ? round(material.alphaCutoff ?? 0.5) : null,
      doubleSided: material.doubleSided ?? false,
      extensions: material.extensions ?? {},
    }),
  );
}

function materialTexturePayloadHashes(
  gltf: z.infer<typeof gltfSchema>,
  images: GlbInspectionReport["images"],
  material: z.infer<typeof gltfSchema>["materials"][number],
): string[] {
  return [
    material.pbrMetallicRoughness?.baseColorTexture,
    material.pbrMetallicRoughness?.metallicRoughnessTexture,
    material.normalTexture,
    material.occlusionTexture,
    material.emissiveTexture,
  ]
    .map((reference) => referencedTextureImage(gltf, images, reference)?.sha256)
    .filter((hash): hash is string => hash !== undefined)
    .filter((hash, index, values) => values.indexOf(hash) === index)
    .sort();
}

function validateBufferViews(gltf: z.infer<typeof gltfSchema>, binaryLength: number): void {
  for (const [index, bufferView] of gltf.bufferViews.entries()) {
    if (bufferView.buffer !== 0) throw new Error(`GLB bufferView ${index} uses missing buffer`);
    const start = bufferView.byteOffset ?? 0;
    if (start % 4 !== 0) throw new Error(`GLB bufferView ${index} is not four-byte aligned`);
    if (start + bufferView.byteLength > binaryLength)
      throw new Error(`GLB bufferView ${index} exceeds buffer`);
  }
  for (const [index, accessor] of gltf.accessors.entries()) {
    if (accessor.sparse !== undefined)
      throw new Error(`Sparse GLB accessor is unsupported: ${index}`);
    if (accessor.bufferView === undefined)
      throw new Error(`GLB accessor lacks bufferView: ${index}`);
    const bufferView = gltf.bufferViews[accessor.bufferView];
    const bytes = componentBytes.get(accessor.componentType);
    const components = typeComponents.get(accessor.type);
    if (!bufferView || !bytes || !components) throw new Error(`Invalid GLB accessor: ${index}`);
    const elementBytes = bytes * components;
    const stride = bufferView.byteStride ?? elementBytes;
    if (stride < elementBytes || stride % bytes !== 0)
      throw new Error(`Invalid GLB accessor stride: ${index}`);
    const start = accessor.byteOffset ?? 0;
    if (start % bytes !== 0) throw new Error(`GLB accessor is misaligned: ${index}`);
    const end = accessor.count === 0 ? start : start + stride * (accessor.count - 1) + elementBytes;
    if (end > bufferView.byteLength) throw new Error(`GLB accessor exceeds bufferView: ${index}`);
  }
}

function validateTextureReferences(gltf: z.infer<typeof gltfSchema>): void {
  for (const [index, texture] of gltf.textures.entries()) {
    if (texture.source === undefined || !gltf.images[texture.source])
      throw new Error(`GLB texture ${index} has no valid image source`);
    if (texture.sampler !== undefined && !gltf.samplers[texture.sampler])
      throw new Error(`GLB texture ${index} references a missing sampler`);
  }
  const check = (value: { index: number } | undefined, label: string): void => {
    if (value && !gltf.textures[value.index])
      throw new Error(`GLB ${label} references a missing texture`);
  };
  for (const material of gltf.materials) {
    check(material.pbrMetallicRoughness?.baseColorTexture, "base color");
    check(material.pbrMetallicRoughness?.metallicRoughnessTexture, "metallic roughness");
    check(material.normalTexture, "normal");
    check(material.occlusionTexture, "occlusion");
    check(material.emissiveTexture, "emissive");
  }
}

function validateVertexAttributeValues(
  gltf: z.infer<typeof gltfSchema>,
  binary: Uint8Array,
  accessorIndex: number,
  attribute: string,
  name: string,
): void {
  if (attribute === "POSITION") return;
  const accessor = gltf.accessors[accessorIndex]!;
  const bufferView = gltf.bufferViews[accessor.bufferView!]!;
  const componentSize = componentBytes.get(accessor.componentType)!;
  const componentCount = typeComponents.get(accessor.type)!;
  const stride = bufferView.byteStride ?? componentSize * componentCount;
  const start = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const view = new DataView(binary.buffer, binary.byteOffset, binary.byteLength);
  if ((attribute === "NORMAL" || attribute === "TANGENT") && accessor.normalized)
    throw new Error(`GLB ${attribute} accessor cannot be normalized float data: ${name}`);
  if (
    /^TEXCOORD_[0-7]$/u.test(attribute) &&
    accessor.componentType !== 5126 &&
    accessor.normalized !== true
  )
    throw new Error(`GLB integer ${attribute} accessor must be normalized: ${name}`);
  if (
    ["COLOR_0", "COLOR_1"].includes(attribute) &&
    accessor.componentType !== 5126 &&
    accessor.normalized !== true
  )
    throw new Error(`GLB integer ${attribute} accessor must be normalized: ${name}`);
  if (/^JOINTS_[01]$/u.test(attribute) && accessor.normalized === true)
    throw new Error(`GLB ${attribute} accessor cannot be normalized: ${name}`);
  if (
    /^WEIGHTS_[01]$/u.test(attribute) &&
    accessor.componentType !== 5126 &&
    accessor.normalized !== true
  )
    throw new Error(`GLB integer ${attribute} accessor must be normalized: ${name}`);
  for (let element = 0; element < accessor.count; element += 1) {
    const values = Array.from({ length: componentCount }, (_, component) =>
      readAccessorComponent(
        view,
        start + element * stride + component * componentSize,
        accessor.componentType,
        accessor.normalized === true,
      ),
    );
    if (values.some((value) => !Number.isFinite(value)))
      throw new Error(`GLB ${attribute} contains nonfinite value: ${name}`);
    if (attribute === "NORMAL" && Math.abs(Math.hypot(...values) - 1) > 1e-3)
      throw new Error(`GLB NORMAL contains a non-unit vector: ${name}`);
    if (
      attribute === "TANGENT" &&
      (Math.abs(Math.hypot(...values.slice(0, 3)) - 1) > 1e-3 || ![1, -1].includes(values[3]!))
    )
      throw new Error(
        `GLB TANGENT contains an invalid frame vector: ${name}/${stableJson(values)}`,
      );
    if (
      /^WEIGHTS_[01]$/u.test(attribute) &&
      (values.some((value) => value < 0 || value > 1) ||
        Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) > 2e-2)
    )
      throw new Error(`GLB ${attribute} contains invalid normalized weights: ${name}`);
  }
}

function primitiveAreas(
  gltf: z.infer<typeof gltfSchema>,
  binary: Uint8Array,
  positionAccessor: number,
  uvAccessor: number | undefined,
  indexAccessor: number | undefined,
  worldMatrix: GlbNodeReport["worldMatrix"],
): { surfaceArea: number; uvArea: number } {
  const positions = accessorTuples(gltf, binary, positionAccessor);
  const uvs = uvAccessor === undefined ? undefined : accessorTuples(gltf, binary, uvAccessor);
  const indices =
    indexAccessor === undefined
      ? Array.from({ length: positions.length }, (_, index) => index)
      : accessorTuples(gltf, binary, indexAccessor).map((entry) => entry[0]!);
  let surfaceArea = 0;
  let uvArea = 0;
  for (let offset = 0; offset < indices.length; offset += 3) {
    const firstIndex = indices[offset]!;
    const secondIndex = indices[offset + 1]!;
    const thirdIndex = indices[offset + 2]!;
    const first = transformPosition(positions[firstIndex]!, worldMatrix);
    const second = transformPosition(positions[secondIndex]!, worldMatrix);
    const third = transformPosition(positions[thirdIndex]!, worldMatrix);
    const ab = [second[0] - first[0], second[1] - first[1], second[2] - first[2]];
    const ac = [third[0] - first[0], third[1] - first[1], third[2] - first[2]];
    surfaceArea +=
      Math.hypot(
        ab[1]! * ac[2]! - ab[2]! * ac[1]!,
        ab[2]! * ac[0]! - ab[0]! * ac[2]!,
        ab[0]! * ac[1]! - ab[1]! * ac[0]!,
      ) / 2;
    if (uvs) {
      const uvFirst = uvs[firstIndex]!;
      const uvSecond = uvs[secondIndex]!;
      const uvThird = uvs[thirdIndex]!;
      uvArea +=
        Math.abs(
          (uvSecond[0]! - uvFirst[0]!) * (uvThird[1]! - uvFirst[1]!) -
            (uvSecond[1]! - uvFirst[1]!) * (uvThird[0]! - uvFirst[0]!),
        ) / 2;
    }
  }
  return { surfaceArea, uvArea };
}

interface UvMetricTriangle {
  readonly surfaceArea: number;
  readonly uvSignedDoubleArea: number;
  readonly uv: readonly [
    readonly [number, number],
    readonly [number, number],
    readonly [number, number],
  ];
  readonly uvJacobianPerAssetUnit: readonly [number, number, number, number];
}

function primitiveUvMetricTriangles(
  gltf: z.infer<typeof gltfSchema>,
  binary: Uint8Array,
  positionAccessor: number,
  uvAccessor: number,
  indexAccessor: number | undefined,
  worldMatrix: GlbNodeReport["worldMatrix"],
): UvMetricTriangle[] {
  const positions = accessorTuples(gltf, binary, positionAccessor);
  const uvs = accessorTuples(gltf, binary, uvAccessor);
  const indices =
    indexAccessor === undefined
      ? Array.from({ length: positions.length }, (_, index) => index)
      : accessorTuples(gltf, binary, indexAccessor).map((entry) => entry[0]!);
  const result: UvMetricTriangle[] = [];
  for (let offset = 0; offset < indices.length; offset += 3) {
    const points = [indices[offset]!, indices[offset + 1]!, indices[offset + 2]!].map((index) =>
      transformPosition(positions[index]!, worldMatrix),
    ) as [[number, number, number], [number, number, number], [number, number, number]];
    const triangleUvs = [indices[offset]!, indices[offset + 1]!, indices[offset + 2]!].map(
      (index) => [uvs[index]![0]!, uvs[index]![1]!] as [number, number],
    ) as [[number, number], [number, number], [number, number]];
    const firstEdge = subtract3(points[1], points[0]);
    const secondEdge = subtract3(points[2], points[0]);
    const firstLength = Math.hypot(...firstEdge);
    const normal = cross3(firstEdge, secondEdge);
    const doubleSurfaceArea = Math.hypot(...normal);
    const uvSignedDoubleArea =
      (triangleUvs[1][0] - triangleUvs[0][0]) * (triangleUvs[2][1] - triangleUvs[0][1]) -
      (triangleUvs[1][1] - triangleUvs[0][1]) * (triangleUvs[2][0] - triangleUvs[0][0]);
    let uvJacobian: [number, number, number, number] = [0, 0, 0, 0];
    if (firstLength > 1e-12 && doubleSurfaceArea > 1e-16 && Math.abs(uvSignedDoubleArea) > 1e-16) {
      const tangent = firstEdge.map((value) => value / firstLength) as [number, number, number];
      const x1 = dot3(secondEdge, tangent);
      const y1 = doubleSurfaceArea / firstLength;
      const inverse = [1 / firstLength, -x1 / (firstLength * y1), 0, 1 / y1] as const;
      const du0 = triangleUvs[1][0] - triangleUvs[0][0];
      const du1 = triangleUvs[2][0] - triangleUvs[0][0];
      const dv0 = triangleUvs[1][1] - triangleUvs[0][1];
      const dv1 = triangleUvs[2][1] - triangleUvs[0][1];
      uvJacobian = [
        du0 * inverse[0] + du1 * inverse[2],
        du0 * inverse[1] + du1 * inverse[3],
        dv0 * inverse[0] + dv1 * inverse[2],
        dv0 * inverse[1] + dv1 * inverse[3],
      ];
    }
    result.push({
      surfaceArea: doubleSurfaceArea / 2,
      uvSignedDoubleArea,
      uv: triangleUvs,
      uvJacobianPerAssetUnit: uvJacobian,
    });
  }
  return result;
}

function summarizeUvMetricTriangles(
  triangles: readonly UvMetricTriangle[],
  materialName: string,
  texture: { width: number; height: number } | undefined,
  assetUnitsToMeters: number,
): GlbMaterialUvMetrics {
  const surfaceArea = triangles.reduce((sum, triangle) => sum + triangle.surfaceArea, 0);
  if (!(surfaceArea > 0))
    throw new Error(`GLB material has no measurable surface: ${materialName}`);
  const degenerateArea = triangles
    .filter(({ uvSignedDoubleArea }) => Math.abs(uvSignedDoubleArea) <= 1e-12)
    .reduce((sum, triangle) => sum + triangle.surfaceArea, 0);
  const positiveOrientationArea = triangles
    .filter(({ uvSignedDoubleArea }) => uvSignedDoubleArea > 1e-12)
    .reduce((sum, triangle) => sum + triangle.surfaceArea, 0);
  const negativeOrientationArea = triangles
    .filter(({ uvSignedDoubleArea }) => uvSignedDoubleArea < -1e-12)
    .reduce((sum, triangle) => sum + triangle.surfaceArea, 0);
  const allUvs = triangles.flatMap(({ uv }) => uv);
  const uvExtents = allUvs.reduce(
    (extents, value) => {
      extents.minimum[0] = Math.min(extents.minimum[0], value[0]);
      extents.minimum[1] = Math.min(extents.minimum[1], value[1]);
      extents.maximum[0] = Math.max(extents.maximum[0], value[0]);
      extents.maximum[1] = Math.max(extents.maximum[1], value[1]);
      return extents;
    },
    {
      minimum: [Infinity, Infinity] as [number, number],
      maximum: [-Infinity, -Infinity] as [number, number],
    },
  );
  const uvBounds = {
    minimum: uvExtents.minimum,
    maximum: uvExtents.maximum,
  };
  const densitySamples: Array<{ value: number; weight: number }> = [];
  const stretchSamples: Array<{ value: number; weight: number }> = [];
  for (const triangle of triangles) {
    const [a, b, c, d] = triangle.uvJacobianPerAssetUnit;
    const [pixelMinimum, pixelMaximum] = singularValues2x2(
      a * (texture?.width ?? 0),
      b * (texture?.width ?? 0),
      c * (texture?.height ?? 0),
      d * (texture?.height ?? 0),
    );
    const scaledMinimum = pixelMinimum / assetUnitsToMeters;
    const scaledMaximum = pixelMaximum / assetUnitsToMeters;
    densitySamples.push(
      { value: scaledMinimum, weight: triangle.surfaceArea / 2 },
      { value: scaledMaximum, weight: triangle.surfaceArea / 2 },
    );
    stretchSamples.push({
      value: scaledMinimum > 1e-12 ? scaledMaximum / scaledMinimum : 1_000_000_000_000,
      weight: triangle.surfaceArea,
    });
  }
  const coverage = estimateUnitAtlasCoverage(triangles);
  return {
    materialName,
    triangleCount: triangles.length,
    surfaceAreaAssetUnits2: surfaceArea,
    uvArea: triangles.reduce((sum, triangle) => sum + Math.abs(triangle.uvSignedDoubleArea) / 2, 0),
    degenerateSurfaceFraction: degenerateArea / surfaceArea,
    mirroredSurfaceFraction:
      Math.min(positiveOrientationArea, negativeOrientationArea) / surfaceArea,
    uvBounds,
    unitAtlasOccupancyFraction: coverage.occupancy,
    unitAtlasOverlapFraction: coverage.overlap,
    stretchRatio: metricDistribution(stretchSamples),
    pixelsPerMeter: metricDistribution(densitySamples),
  };
}

function metricDistribution(
  samples: readonly { value: number; weight: number }[],
): GlbMetricDistribution {
  const finite = samples
    .filter(({ value, weight }) => Number.isFinite(value) && value >= 0 && weight > 0)
    .sort((left, right) => left.value - right.value);
  if (finite.length === 0)
    return {
      minimum: 0,
      p05: 0,
      median: 0,
      p95: 0,
      maximum: 0,
      areaWeightedRms: 0,
    };
  const total = finite.reduce((sum, sample) => sum + sample.weight, 0);
  const quantile = (target: number): number => {
    let cumulative = 0;
    for (const sample of finite) {
      cumulative += sample.weight;
      if (cumulative + 1e-12 >= total * target) return sample.value;
    }
    return finite.at(-1)!.value;
  };
  return {
    minimum: finite[0]!.value,
    p05: quantile(0.05),
    median: quantile(0.5),
    p95: quantile(0.95),
    maximum: finite.at(-1)!.value,
    areaWeightedRms: Math.sqrt(
      finite.reduce((sum, sample) => sum + sample.value ** 2 * sample.weight, 0) / total,
    ),
  };
}

function estimateUnitAtlasCoverage(triangles: readonly UvMetricTriangle[]): {
  occupancy: number;
  overlap: number;
} {
  if (
    triangles.some(({ uv }) =>
      uv.some(([u, v]) => u < -1e-6 || u > 1 + 1e-6 || v < -1e-6 || v > 1 + 1e-6),
    )
  )
    return { occupancy: 0, overlap: 1 };
  const resolution = 128;
  const counts = new Uint16Array(resolution * resolution);
  for (const { uv } of triangles) {
    const lowX = Math.max(0, Math.floor(Math.min(...uv.map((value) => value[0])) * resolution));
    const highX = Math.min(
      resolution - 1,
      Math.ceil(Math.max(...uv.map((value) => value[0])) * resolution) - 1,
    );
    const lowY = Math.max(0, Math.floor(Math.min(...uv.map((value) => value[1])) * resolution));
    const highY = Math.min(
      resolution - 1,
      Math.ceil(Math.max(...uv.map((value) => value[1])) * resolution) - 1,
    );
    for (let y = lowY; y <= highY; y += 1)
      for (let x = lowX; x <= highX; x += 1)
        if (pointInsideUvTriangle((x + 0.5) / resolution, (y + 0.5) / resolution, uv)) {
          const index = y * resolution + x;
          counts[index] = Math.min(65_535, counts[index]! + 1);
        }
  }
  let occupied = 0;
  let overlapping = 0;
  for (const count of counts) {
    if (count > 0) occupied += 1;
    if (count > 1) overlapping += 1;
  }
  return {
    occupancy: occupied / counts.length,
    overlap: occupied === 0 ? 0 : overlapping / occupied,
  };
}

function pointInsideUvTriangle(x: number, y: number, triangle: UvMetricTriangle["uv"]): boolean {
  const [a, b, c] = triangle;
  const first = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
  const second = (c[0] - b[0]) * (y - b[1]) - (c[1] - b[1]) * (x - b[0]);
  const third = (a[0] - c[0]) * (y - c[1]) - (a[1] - c[1]) * (x - c[0]);
  return (
    (first > 1e-10 && second > 1e-10 && third > 1e-10) ||
    (first < -1e-10 && second < -1e-10 && third < -1e-10)
  );
}

function singularValues2x2(a: number, b: number, c: number, d: number): [number, number] {
  const trace = a * a + b * b + c * c + d * d;
  const determinant = (a * d - b * c) ** 2;
  const discriminant = Math.sqrt(Math.max(0, trace * trace - 4 * determinant));
  return [
    Math.sqrt(Math.max(0, (trace - discriminant) / 2)),
    Math.sqrt(Math.max(0, (trace + discriminant) / 2)),
  ];
}

function subtract3(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): [number, number, number] {
  return [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
}

function collisionSupportFloat(value: number): number {
  const retained = Math.fround(value);
  return Object.is(retained, -0) ? 0 : retained;
}

function collisionSupportPoint(value: readonly number[]): {
  readonly x: number;
  readonly y: number;
  readonly z: number;
} {
  return {
    x: collisionSupportFloat(value[0]!),
    y: collisionSupportFloat(value[1]!),
    z: collisionSupportFloat(value[2]!),
  };
}

function collisionSupportTuple(value: {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}): [number, number, number] {
  return [value.x, value.y, value.z];
}

function cross3(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): [number, number, number] {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
}

function dot3(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function accessorTuples(
  gltf: z.infer<typeof gltfSchema>,
  binary: Uint8Array,
  accessorIndex: number,
): number[][] {
  const accessor = gltf.accessors[accessorIndex]!;
  const bufferView = gltf.bufferViews[accessor.bufferView!]!;
  const componentSize = componentBytes.get(accessor.componentType)!;
  const componentCount = typeComponents.get(accessor.type)!;
  const stride = bufferView.byteStride ?? componentSize * componentCount;
  const start = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const view = new DataView(binary.buffer, binary.byteOffset, binary.byteLength);
  return Array.from({ length: accessor.count }, (_, element) =>
    Array.from({ length: componentCount }, (_, component) =>
      readAccessorComponent(
        view,
        start + element * stride + component * componentSize,
        accessor.componentType,
        accessor.normalized === true,
      ),
    ),
  );
}

function transformPosition(
  value: readonly number[],
  matrix: GlbNodeReport["worldMatrix"],
): [number, number, number] {
  return [
    matrix[0] * value[0]! + matrix[4] * value[1]! + matrix[8] * value[2]! + matrix[12],
    matrix[1] * value[0]! + matrix[5] * value[1]! + matrix[9] * value[2]! + matrix[13],
    matrix[2] * value[0]! + matrix[6] * value[1]! + matrix[10] * value[2]! + matrix[14],
  ];
}

function readAccessorComponent(
  view: DataView,
  offset: number,
  componentType: number,
  normalized: boolean,
): number {
  const raw =
    componentType === 5120
      ? view.getInt8(offset)
      : componentType === 5121
        ? view.getUint8(offset)
        : componentType === 5122
          ? view.getInt16(offset, true)
          : componentType === 5123
            ? view.getUint16(offset, true)
            : componentType === 5125
              ? view.getUint32(offset, true)
              : view.getFloat32(offset, true);
  if (!normalized || componentType === 5126) return raw;
  if (componentType === 5120) return Math.max(raw / 127, -1);
  if (componentType === 5121) return raw / 255;
  if (componentType === 5122) return Math.max(raw / 32767, -1);
  if (componentType === 5123) return raw / 65535;
  return raw / 4294967295;
}

function validateExtensionPayloads(
  decoded: unknown,
  used: readonly string[],
  required: readonly string[],
): void {
  const usedSet = new Set(used);
  if (required.some((entry) => !usedSet.has(entry)))
    throw new Error("GLB required extensions must also be declared as used");
  const observed = new Set<string>();
  const visit = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${path}[${index}]`));
      return;
    }
    if (!isPlainRecord(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (key !== "extensions") {
        visit(child, `${path}.${key}`);
        continue;
      }
      if (!isPlainRecord(child)) throw new Error(`GLB extensions payload is malformed: ${path}`);
      for (const [extension, payload] of Object.entries(child)) {
        if (!SUPPORTED_EXTENSIONS.has(extension) || !usedSet.has(extension))
          throw new Error(`Undeclared or unsupported GLB extension payload: ${extension}`);
        observed.add(extension);
        validateExtensionPayload(extension, payload, path);
      }
    }
  };
  visit(decoded, "gltf");
  if (used.some((entry) => !observed.has(entry)))
    throw new Error("GLB declares an extension without an admitted payload");
}

function validateExtensionPayload(extension: string, payload: unknown, path: string): void {
  if (!isPlainRecord(payload)) throw new Error(`GLB ${extension} payload is malformed`);
  if (extension === "KHR_materials_unlit") {
    if (!/^gltf\.materials\[[0-9]+\]$/u.test(path) || Object.keys(payload).length !== 0)
      throw new Error("GLB unlit extension is outside a material or has unknown fields");
    return;
  }
  if (extension === "KHR_materials_emissive_strength") {
    if (!/^gltf\.materials\[[0-9]+\]$/u.test(path))
      throw new Error("GLB emissive-strength extension is outside a material");
    const keys = Object.keys(payload);
    const strength = payload.emissiveStrength;
    if (
      keys.length !== 1 ||
      typeof strength !== "number" ||
      !Number.isFinite(strength) ||
      strength < 0 ||
      strength > 100_000
    )
      throw new Error("GLB emissive-strength extension is malformed");
    return;
  }
  if (extension === "KHR_materials_specular") {
    if (!/^gltf\.materials\[[0-9]+\]$/u.test(path))
      throw new Error("GLB specular extension is outside a material");
    const allowed = new Set([
      "specularFactor",
      "specularTexture",
      "specularColorFactor",
      "specularColorTexture",
    ]);
    if (Object.keys(payload).some((key) => !allowed.has(key)))
      throw new Error("GLB specular extension has unknown fields");
    const factor = payload.specularFactor;
    if (
      factor !== undefined &&
      (typeof factor !== "number" || !Number.isFinite(factor) || factor < 0 || factor > 1)
    )
      throw new Error("GLB specular factor is malformed");
    const colorFactor = payload.specularColorFactor;
    if (
      colorFactor !== undefined &&
      (!finiteTuple(colorFactor, 3) || colorFactor.some((value) => value < 0 || value > 4))
    )
      throw new Error("GLB specular color factor is malformed");
    for (const key of ["specularTexture", "specularColorTexture"]) {
      const reference = payload[key];
      if (reference === undefined) continue;
      if (!isPlainRecord(reference)) throw new Error(`GLB ${key} is malformed`);
      const referenceKeys = Object.keys(reference);
      if (referenceKeys.some((entry) => !["index", "texCoord", "extensions"].includes(entry)))
        throw new Error(`GLB ${key} has unknown fields`);
      if (
        typeof reference.index !== "number" ||
        !Number.isInteger(reference.index) ||
        reference.index < 0
      )
        throw new Error(`GLB ${key} index is malformed`);
      if (
        reference.texCoord !== undefined &&
        (typeof reference.texCoord !== "number" ||
          !Number.isInteger(reference.texCoord) ||
          reference.texCoord < 0 ||
          reference.texCoord > 7)
      )
        throw new Error(`GLB ${key} references an unsupported UV set`);
    }
    return;
  }
  if (!/(?:Texture|normalTexture|occlusionTexture|emissiveTexture)$/u.test(path))
    throw new Error("GLB texture-transform extension is outside a texture reference");
  const allowed = new Set(["offset", "rotation", "scale", "texCoord"]);
  if (Object.keys(payload).some((key) => !allowed.has(key)))
    throw new Error("GLB texture-transform extension has unknown fields");
  const offset = payload.offset;
  const scale = payload.scale;
  const rotation = payload.rotation;
  const texCoord = payload.texCoord;
  if (offset !== undefined && !finiteTuple(offset, 2))
    throw new Error("GLB texture-transform offset is malformed");
  if (scale !== undefined && (!finiteTuple(scale, 2) || scale.some((value) => value === 0)))
    throw new Error("GLB texture-transform scale is malformed");
  if (rotation !== undefined && (typeof rotation !== "number" || !Number.isFinite(rotation)))
    throw new Error("GLB texture-transform rotation is malformed");
  if (
    texCoord !== undefined &&
    (typeof texCoord !== "number" || !Number.isInteger(texCoord) || texCoord < 0 || texCoord > 7)
  )
    throw new Error("GLB texture-transform references an unsupported UV set");
}

function finiteTuple(value: unknown, length: number): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every((entry) => typeof entry === "number" && Number.isFinite(entry))
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function inspectEmbeddedImages(
  gltf: z.infer<typeof gltfSchema>,
  binary: Uint8Array,
  maximumPixels: number,
): GlbInspectionReport["images"] {
  return gltf.images.map((image, index) => {
    const bufferView = gltf.bufferViews[image.bufferView!];
    if (!bufferView) throw new Error(`GLB image ${index} references a missing bufferView`);
    const start = bufferView.byteOffset ?? 0;
    const bytes = binary.subarray(start, start + bufferView.byteLength);
    const inspected = inspectTextureImage(bytes, image.mimeType!, maximumPixels);
    return {
      index,
      mimeType: image.mimeType!,
      ...inspected,
    };
  });
}

function pngDimensions(bytes: Uint8Array): {
  width: number;
  height: number;
  alphaChannel: "present" | "absent";
} {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (
    bytes.byteLength < 33 ||
    signature.some((value, index) => bytes[index] !== value) ||
    new TextDecoder().decode(bytes.subarray(12, 16)) !== "IHDR"
  )
    throw new Error("GLB PNG image is malformed");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  const colorType = bytes[25];
  if (![0, 2, 3, 4, 6].includes(colorType ?? -1))
    throw new Error("GLB PNG image has an invalid color type");
  if (width === 0 || height === 0) throw new Error("GLB PNG image has empty dimensions");
  let offset = 8;
  let ended = false;
  while (offset < bytes.byteLength) {
    if (offset + 12 > bytes.byteLength) throw new Error("GLB PNG image is truncated");
    const length = view.getUint32(offset, false);
    const end = offset + 12 + length;
    if (end > bytes.byteLength) throw new Error("GLB PNG chunk exceeds image bytes");
    const type = new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8));
    if (type === "IEND") {
      if (end !== bytes.byteLength) throw new Error("GLB PNG image has trailing bytes");
      ended = true;
    }
    offset = end;
  }
  if (!ended) throw new Error("GLB PNG image has no IEND chunk");
  return {
    width,
    height,
    alphaChannel: colorType === 4 || colorType === 6 ? "present" : "absent",
  };
}

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8)
    throw new Error("GLB JPEG image is malformed");
  let offset = 2;
  while (offset + 4 <= bytes.byteLength) {
    if (bytes[offset] !== 0xff) throw new Error("GLB JPEG marker is malformed");
    const marker = bytes[offset + 1]!;
    offset += 2;
    if (marker === 0xd9) break;
    if (marker === 0xda) break;
    const length = (bytes[offset]! << 8) | bytes[offset + 1]!;
    if (length < 2 || offset + length > bytes.byteLength)
      throw new Error("GLB JPEG segment is truncated");
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (length < 7) throw new Error("GLB JPEG frame is malformed");
      const height = (bytes[offset + 3]! << 8) | bytes[offset + 4]!;
      const width = (bytes[offset + 5]! << 8) | bytes[offset + 6]!;
      if (!width || !height) throw new Error("GLB JPEG image has empty dimensions");
      return { width, height };
    }
    offset += length;
  }
  throw new Error("GLB JPEG image has no supported frame header");
}

function validateTriangleIndices(
  gltf: z.infer<typeof gltfSchema>,
  binary: Uint8Array,
  accessorIndex: number,
  vertexCount: number,
  name: string,
): void {
  const accessor = gltf.accessors[accessorIndex]!;
  const bufferView = gltf.bufferViews[accessor.bufferView!]!;
  const componentSize = componentBytes.get(accessor.componentType)!;
  const stride = bufferView.byteStride ?? componentSize;
  const start = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const view = new DataView(binary.buffer, binary.byteOffset, binary.byteLength);
  const indices: number[] = [];
  for (let index = 0; index < accessor.count; index += 1) {
    const offset = start + index * stride;
    const value =
      accessor.componentType === 5121
        ? view.getUint8(offset)
        : accessor.componentType === 5123
          ? view.getUint16(offset, true)
          : view.getUint32(offset, true);
    if (value >= vertexCount) throw new Error(`GLB index exceeds POSITION count: ${name}`);
    indices.push(value);
  }
  for (let index = 0; index < indices.length; index += 3)
    if (new Set(indices.slice(index, index + 3)).size !== 3)
      throw new Error(`GLB contains a degenerate indexed triangle: ${name}`);
}

function validateNodeGraph(nodes: z.infer<typeof gltfSchema>["nodes"]): Map<number, number> {
  const parents = new Map<number, number>();
  for (let index = 0; index < nodes.length; index += 1)
    for (const child of nodes[index]!.children ?? []) {
      if (!nodes[child]) throw new Error(`GLB node references missing child: ${child}`);
      if (parents.has(child)) throw new Error(`GLB node has multiple parents: ${child}`);
      parents.set(child, index);
    }
  const visiting = new Set<number>();
  const visited = new Set<number>();
  const visit = (index: number): void => {
    if (visited.has(index)) return;
    if (visiting.has(index)) throw new Error(`GLB node cycle includes ${index}`);
    visiting.add(index);
    for (const child of nodes[index]?.children ?? []) visit(child);
    visiting.delete(index);
    visited.add(index);
  };
  for (let index = 0; index < nodes.length; index += 1) visit(index);
  return parents;
}

function validateScenes(
  gltf: z.infer<typeof gltfSchema>,
  parents: ReadonlyMap<number, number>,
): void {
  if (gltf.scenes === undefined || gltf.scenes.length === 0)
    throw new Error("GLB requires an explicit scene");
  const sceneIndex = gltf.scene ?? 0;
  const scene = gltf.scenes[sceneIndex];
  if (!scene) throw new Error("GLB default scene is missing");
  const roots = scene.nodes ?? [];
  if (new Set(roots).size !== roots.length) throw new Error("GLB scene root is duplicated");
  for (const root of roots) {
    if (!gltf.nodes[root]) throw new Error(`GLB scene references missing root: ${root}`);
    if (parents.has(root)) throw new Error(`GLB scene root has a parent: ${root}`);
  }
  const reachable = new Set<number>();
  const visit = (index: number): void => {
    if (reachable.has(index)) return;
    reachable.add(index);
    for (const child of gltf.nodes[index]!.children ?? []) visit(child);
  };
  for (const root of roots) visit(root);
  if (reachable.size !== gltf.nodes.length)
    throw new Error("GLB contains nodes outside the declared scene");
}

function accessorCount(gltf: z.infer<typeof gltfSchema>, index: number): number {
  const accessor = gltf.accessors[index];
  if (
    !accessor ||
    accessor.type !== "SCALAR" ||
    ![5121, 5123, 5125].includes(accessor.componentType)
  )
    throw new Error(`GLB index accessor is invalid: ${index}`);
  return accessor.count;
}

function transformedAccessorBounds(
  gltf: z.infer<typeof gltfSchema>,
  binary: Uint8Array,
  index: number,
  transform: GlbNodeReport["worldMatrix"],
): { minimum: [number, number, number]; maximum: [number, number, number] } {
  const accessor = gltf.accessors[index]!;
  const bufferView = gltf.bufferViews[accessor.bufferView!]!;
  const stride = bufferView.byteStride ?? 12;
  const start = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const view = new DataView(binary.buffer, binary.byteOffset, binary.byteLength);
  const minimum: [number, number, number] = [Infinity, Infinity, Infinity];
  const maximum: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let vertex = 0; vertex < accessor.count; vertex += 1) {
    const position = [0, 1, 2].map((axis) =>
      view.getFloat32(start + vertex * stride + axis * 4, true),
    ) as [number, number, number];
    if (position.some((value) => !Number.isFinite(value)))
      throw new Error(`GLB POSITION contains nonfinite value: ${index}`);
    const transformed = transformPoint(transform, position);
    for (let axis = 0; axis < 3; axis += 1) {
      minimum[axis] = Math.min(minimum[axis]!, transformed[axis]!);
      maximum[axis] = Math.max(maximum[axis]!, transformed[axis]!);
    }
  }
  return { minimum, maximum };
}

function nodeWorldMatrices(
  nodes: z.infer<typeof gltfSchema>["nodes"],
  parents: ReadonlyMap<number, number>,
): GlbNodeReport["worldMatrix"][] {
  const result: Array<GlbNodeReport["worldMatrix"] | undefined> = Array(nodes.length);
  const resolveMatrix = (index: number): GlbNodeReport["worldMatrix"] => {
    const existing = result[index];
    if (existing) return existing;
    const local = localMatrix(nodes[index]!);
    const parent = parents.get(index);
    const world = parent === undefined ? local : multiplyMatrix(resolveMatrix(parent), local);
    result[index] = world;
    return world;
  };
  return nodes.map((_, index) => resolveMatrix(index));
}

function localMatrix(
  node: z.infer<typeof gltfSchema>["nodes"][number],
): GlbNodeReport["worldMatrix"] {
  if (node.matrix) {
    if (node.translation || node.rotation || node.scale)
      throw new Error("GLB node cannot declare matrix and TRS together");
    return canonicalMatrix(node.matrix);
  }
  const [x, y, z, w] = (node.rotation ?? [0, 0, 0, 1]) as [number, number, number, number];
  const length = Math.hypot(x, y, z, w);
  if (Math.abs(length - 1) > 1e-4) throw new Error("GLB node quaternion is not normalized");
  const qx = x / length;
  const qy = y / length;
  const qz = z / length;
  const qw = w / length;
  const [sx, sy, sz] = (node.scale ?? [1, 1, 1]) as [number, number, number];
  if (sx === 0 || sy === 0 || sz === 0) throw new Error("GLB node scale is singular");
  const [tx, ty, tz] = (node.translation ?? [0, 0, 0]) as [number, number, number];
  return canonicalMatrix([
    (1 - 2 * (qy * qy + qz * qz)) * sx,
    2 * (qx * qy + qz * qw) * sx,
    2 * (qx * qz - qy * qw) * sx,
    0,
    2 * (qx * qy - qz * qw) * sy,
    (1 - 2 * (qx * qx + qz * qz)) * sy,
    2 * (qy * qz + qx * qw) * sy,
    0,
    2 * (qx * qz + qy * qw) * sz,
    2 * (qy * qz - qx * qw) * sz,
    (1 - 2 * (qx * qx + qy * qy)) * sz,
    0,
    tx,
    ty,
    tz,
    1,
  ]);
}

function multiplyMatrix(
  left: GlbNodeReport["worldMatrix"],
  right: GlbNodeReport["worldMatrix"],
): GlbNodeReport["worldMatrix"] {
  const result = Array<number>(16).fill(0);
  for (let column = 0; column < 4; column += 1)
    for (let row = 0; row < 4; row += 1)
      for (let index = 0; index < 4; index += 1)
        result[column * 4 + row]! += left[index * 4 + row]! * right[column * 4 + index]!;
  return canonicalMatrix(result);
}

function transformPoint(
  matrix: GlbNodeReport["worldMatrix"],
  point: [number, number, number],
): [number, number, number] {
  return [
    canonicalNumber(
      matrix[0]! * point[0] + matrix[4]! * point[1] + matrix[8]! * point[2] + matrix[12]!,
    ),
    canonicalNumber(
      matrix[1]! * point[0] + matrix[5]! * point[1] + matrix[9]! * point[2] + matrix[13]!,
    ),
    canonicalNumber(
      matrix[2]! * point[0] + matrix[6]! * point[1] + matrix[10]! * point[2] + matrix[14]!,
    ),
  ];
}

function canonicalMatrix(values: readonly number[]): GlbNodeReport["worldMatrix"] {
  if (values.length !== 16 || values.some((value) => !Number.isFinite(value)))
    throw new Error("GLB node transform is malformed");
  if (
    Math.abs(values[3]!) > 1e-7 ||
    Math.abs(values[7]!) > 1e-7 ||
    Math.abs(values[11]!) > 1e-7 ||
    Math.abs(values[15]! - 1) > 1e-7
  )
    throw new Error("GLB node transform is not affine");
  const determinant =
    values[0]! * (values[5]! * values[10]! - values[9]! * values[6]!) -
    values[4]! * (values[1]! * values[10]! - values[9]! * values[2]!) +
    values[8]! * (values[1]! * values[6]! - values[5]! * values[2]!);
  if (Math.abs(determinant) < 1e-10) throw new Error("GLB node transform is singular");
  return values.map(canonicalNumber) as GlbNodeReport["worldMatrix"];
}

function canonicalNumber(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

function unionBounds(
  left: GlbNodeReport["bounds"],
  right: NonNullable<GlbNodeReport["bounds"]>,
): NonNullable<GlbNodeReport["bounds"]> {
  if (!left) return right;
  return {
    minimum: left.minimum.map((value, index) => Math.min(value, right.minimum[index]!)) as [
      number,
      number,
      number,
    ],
    maximum: left.maximum.map((value, index) => Math.max(value, right.maximum[index]!)) as [
      number,
      number,
      number,
    ],
  };
}

function trimJsonPadding(bytes: Uint8Array): Uint8Array {
  let end = bytes.byteLength;
  while (end > 0 && [0x20, 0x00, 0x0a, 0x0d, 0x09].includes(bytes[end - 1]!)) end -= 1;
  return bytes.subarray(0, end);
}
