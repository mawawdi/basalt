#!/usr/bin/env node
// No declared family member may match the decal-patch quarantine signature:
// single-texel UV over the whole mesh, flat spans, dwarfing its measured
// family cohort. Matches must move to quarantine with a reason; this check
// fails until they do. Reads only registry/ plus the compiled predicate.
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertRuntimeBuildCurrent } from "./runtime-build-manifest.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
await assertRuntimeBuildCurrent();
const { matchesPatchQuarantineSignature } = await import(
  pathToFileURL(resolve(repositoryRoot, "dist/packages/catalog-intelligence/src/index.js")).href
);
const { STUD_METERS } = await import(
  pathToFileURL(resolve(repositoryRoot, "dist/packages/basalt-types/src/fixed.js")).href
);

const manifest = JSON.parse(
  await readFile(resolve(repositoryRoot, "registry/family-manifest.json"), "utf8"),
);
const sourceManifest = JSON.parse(
  await readFile(resolve(repositoryRoot, "registry/source-manifest.json"), "utf8"),
);
const metersPerUnit = new Map();
for (const pkg of sourceManifest.packages ?? [])
  for (const file of pkg.files ?? [])
    metersPerUnit.set(file.relativePath, file.metersPerSourceUnit);

function readAccessor(doc, bytes, binOffset, index, type, component) {
  const accessor = doc.accessors[index];
  if (accessor.type !== type || accessor.componentType !== component)
    throw new Error(`accessor ${index} is not ${type}/float`);
  const view = doc.bufferViews[accessor.bufferView];
  const stride = view.byteStride ?? 0;
  const width = (type === "VEC3" ? 3 : 2) * 4;
  if (stride !== 0 && stride !== width)
    throw new Error(`accessor ${index} uses interleaved stride`);
  const start = binOffset + (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const out = [];
  for (let i = 0; i < accessor.count; i += 1) {
    const row = [];
    for (let c = 0; c < width / 4; c += 1)
      row.push(bytes.readFloatLE(start + i * (stride || width) + c * 4));
    out.push(row);
  }
  return out;
}

async function scanMember(relativePath) {
  const bytes = await readFile(resolve(repositoryRoot, relativePath));
  if (bytes.readUInt32LE(0) !== 0x46546c67) throw new Error(`${relativePath} is not a GLB`);
  const jsonLength = bytes.readUInt32LE(12);
  const doc = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString("utf8"));
  const binOffset = 20 + jsonLength + 8;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let uvMin = null;
  let uvMax = null;
  for (const mesh of doc.meshes ?? []) {
    for (const prim of mesh.primitives) {
      for (const p of readAccessor(doc, bytes, binOffset, prim.attributes.POSITION, "VEC3", 5126)) {
        for (let c = 0; c < 3; c += 1) {
          min[c] = Math.min(min[c], p[c]);
          max[c] = Math.max(max[c], p[c]);
        }
      }
      if (prim.attributes.TEXCOORD_0 === undefined) continue;
      for (const t of readAccessor(
        doc,
        bytes,
        binOffset,
        prim.attributes.TEXCOORD_0,
        "VEC2",
        5126,
      )) {
        uvMin = uvMin ?? [...t];
        uvMax = uvMax ?? [...t];
        for (let c = 0; c < 2; c += 1) {
          uvMin[c] = Math.min(uvMin[c], t[c]);
          uvMax[c] = Math.max(uvMax[c], t[c]);
        }
      }
    }
  }
  const units = metersPerUnit.get(relativePath);
  if (!Number.isFinite(units) || units <= 0) throw new Error(`no unit scale for ${relativePath}`);
  const toStuds = units / STUD_METERS;
  const spans = [0, 1, 2].map((c) => (max[c] - min[c]) * toStuds);
  return {
    minSpan: Math.min(...spans),
    maxSpan: Math.max(...spans),
    uvArea: uvMin ? (uvMax[0] - uvMin[0]) * (uvMax[1] - uvMin[1]) : Number.NaN,
  };
}

const members = [];
for (const family of manifest.families)
  for (const member of family.members)
    members.push({ family: family.familyName, path: member.sourcePath });
const measured = new Map();
for (const { path } of members) measured.set(path, await scanMember(path));
const cohort = new Map();
for (const { family, path } of members) {
  if (!cohort.has(family)) cohort.set(family, []);
  cohort.get(family).push(measured.get(path).maxSpan);
}
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const medians = new Map([...cohort].map(([family, spans]) => [family, median(spans)]));

const flagged = [];
for (const { family, path } of members) {
  const m = measured.get(path);
  if (
    matchesPatchQuarantineSignature({
      uvBboxArea: m.uvArea,
      minSpanStuds: m.minSpan,
      maxSpanStuds: m.maxSpan,
      familyMedianMaxSpanStuds: medians.get(family),
    })
  )
    flagged.push(
      `${path} (uv ${m.uvArea.toExponential(1)}, spans ${m.minSpan.toFixed(2)}/${m.maxSpan.toFixed(2)} vs cohort ${medians.get(family).toFixed(2)})`,
    );
}
process.stdout.write(
  `Catalog patches: ${members.length} members scanned, ${flagged.length} flagged\n`,
);
for (const line of flagged)
  console.error(`patch: declared member matches quarantine signature: ${line}`);
if (flagged.length > 0) process.exit(1);
