import { contentHash, deepFreezeJson, stableJson } from "@basalt/contracts";

const GLB_MAGIC = 0x46546c67;
const GLB_VERSION = 2;
const JSON_CHUNK = 0x4e4f534a;
const SECONDARY_VERTEX_COLOR = /^COLOR_([1-9][0-9]*)$/u;

/**
 * Roblox upload payloads retain the glTF base-color channel (`COLOR_0`) and
 * omit secondary color sets. Core glTF material evaluation never consumes
 * `COLOR_1+`; source packages commonly use those sets for wind or other
 * application controls, and Roblox can otherwise expose them as appearance.
 */
export const ROBLOX_GLTF_UPLOAD_ADAPTATION_POLICY = deepFreezeJson({
  kind: "RobloxGltfUploadAdaptationPolicy" as const,
  inputMediaType: "model/gltf-binary" as const,
  outputMediaType: "model/gltf-binary" as const,
  retainedVertexColorSemantics: ["COLOR_0"] as const,
  strippedVertexColorSemanticPattern: "COLOR_n where n >= 1" as const,
});

export const ROBLOX_GLTF_UPLOAD_ADAPTATION_POLICY_HASH = contentHash(
  stableJson(ROBLOX_GLTF_UPLOAD_ADAPTATION_POLICY),
);

export interface RobloxGltfUploadAdaptation {
  readonly policyHash: string;
  readonly strippedSecondaryVertexColorSemantics: readonly string[];
  readonly strippedPrimitiveAttributeCount: number;
  readonly preservedPrimaryVertexColorPrimitiveCount: number;
}

export interface AdaptedRobloxGlb {
  readonly bytes: Uint8Array;
  readonly adaptation: RobloxGltfUploadAdaptation;
}

interface GlbChunk {
  readonly type: number;
  readonly bytes: Uint8Array;
}

/** Derive a deterministic Roblox-safe GLB without mutating the source bytes. */
export function adaptGlbForRobloxUpload(input: Uint8Array): AdaptedRobloxGlb {
  if (!(input instanceof Uint8Array)) throw new Error("Roblox GLB adaptation requires bytes");
  const chunks = parseGlbChunks(input);
  const document = parseJsonDocument(chunks[0]!.bytes);
  const strippedSemantics = new Set<string>();
  let strippedPrimitiveAttributeCount = 0;
  let preservedPrimaryVertexColorPrimitiveCount = 0;

  const meshes = document.meshes;
  if (meshes !== undefined && !Array.isArray(meshes))
    throw new Error("Roblox GLB adaptation found malformed meshes");
  for (const mesh of meshes ?? []) {
    if (!isRecord(mesh) || !Array.isArray(mesh.primitives))
      throw new Error("Roblox GLB adaptation found a malformed mesh");
    for (const primitive of mesh.primitives) {
      if (!isRecord(primitive) || !isRecord(primitive.attributes))
        throw new Error("Roblox GLB adaptation found malformed primitive attributes");
      if (Object.hasOwn(primitive.attributes, "COLOR_0"))
        preservedPrimaryVertexColorPrimitiveCount += 1;
      for (const semantic of Object.keys(primitive.attributes)) {
        if (!SECONDARY_VERTEX_COLOR.test(semantic)) continue;
        delete primitive.attributes[semantic];
        strippedSemantics.add(semantic);
        strippedPrimitiveAttributeCount += 1;
      }
    }
  }

  const adaptation = deepFreezeJson({
    policyHash: ROBLOX_GLTF_UPLOAD_ADAPTATION_POLICY_HASH,
    strippedSecondaryVertexColorSemantics: [...strippedSemantics].sort(),
    strippedPrimitiveAttributeCount,
    preservedPrimaryVertexColorPrimitiveCount,
  });
  if (strippedPrimitiveAttributeCount === 0) return { bytes: Uint8Array.from(input), adaptation };

  const jsonBytes = new TextEncoder().encode(JSON.stringify(document));
  const paddedJson = new Uint8Array(align4(jsonBytes.byteLength));
  paddedJson.fill(0x20);
  paddedJson.set(jsonBytes);
  const outputChunks: readonly GlbChunk[] = [
    { type: JSON_CHUNK, bytes: paddedJson },
    ...chunks.slice(1),
  ];
  return { bytes: encodeGlb(outputChunks), adaptation };
}

function parseGlbChunks(input: Uint8Array): readonly GlbChunk[] {
  if (input.byteLength < 20) throw new Error("Roblox upload source is not a complete GLB 2 file");
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  if (
    view.getUint32(0, true) !== GLB_MAGIC ||
    view.getUint32(4, true) !== GLB_VERSION ||
    view.getUint32(8, true) !== input.byteLength
  )
    throw new Error("Roblox upload source is not a complete GLB 2 file");

  const chunks: GlbChunk[] = [];
  let offset = 12;
  while (offset < input.byteLength) {
    if (offset + 8 > input.byteLength) throw new Error("Roblox upload GLB has a truncated chunk");
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const end = offset + 8 + length;
    if (length % 4 !== 0 || end > input.byteLength)
      throw new Error("Roblox upload GLB has an invalid chunk length");
    chunks.push({ type, bytes: input.slice(offset + 8, end) });
    offset = end;
  }
  if (chunks.length === 0 || chunks[0]!.type !== JSON_CHUNK)
    throw new Error("Roblox upload GLB must begin with one JSON chunk");
  if (chunks.slice(1).some((chunk) => chunk.type === JSON_CHUNK))
    throw new Error("Roblox upload GLB contains multiple JSON chunks");
  return chunks;
}

function parseJsonDocument(bytes: Uint8Array): Record<string, unknown> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true })
      .decode(bytes)
      .replace(/[\u0000\x20\t\r\n]+$/u, "");
  } catch {
    throw new Error("Roblox upload GLB JSON is not valid UTF-8");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Roblox upload GLB JSON is invalid");
  }
  if (!isRecord(value)) throw new Error("Roblox upload GLB JSON root must be an object");
  return value;
}

function encodeGlb(chunks: readonly GlbChunk[]): Uint8Array {
  const totalLength = 12 + chunks.reduce((sum, chunk) => sum + 8 + chunk.bytes.byteLength, 0);
  const output = new Uint8Array(totalLength);
  const view = new DataView(output.buffer);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, GLB_VERSION, true);
  view.setUint32(8, totalLength, true);
  let offset = 12;
  for (const chunk of chunks) {
    view.setUint32(offset, chunk.bytes.byteLength, true);
    view.setUint32(offset + 4, chunk.type, true);
    output.set(chunk.bytes, offset + 8);
    offset += 8 + chunk.bytes.byteLength;
  }
  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function align4(value: number): number {
  return (value + 3) & ~3;
}
