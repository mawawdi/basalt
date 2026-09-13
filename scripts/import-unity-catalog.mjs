#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  CATALOG_DISPOSITION_SCHEMA,
  SOURCE_PROVENANCE_LEDGER_SCHEMA,
  TRUSTED_SOURCE_MANIFEST_SCHEMA,
  sealSourceProvenanceLedger,
  sealSourceProvenanceRecord,
  sourceAssetRelativePath,
  sourceRightsEvidenceHash,
} from "@basalt/catalog-model";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const registryRoot = resolve(repositoryRoot, "registry");
const archiveRoot = resolve(registryRoot, "source-archives");
const generatedRoot = resolve(repositoryRoot, ".basalt", "catalog", "imports");
const blenderExecutable =
  process.env.BASALT_BLENDER ?? "/Applications/Blender.app/Contents/MacOS/Blender";
const blenderWorker = resolve(repositoryRoot, "workers", "catalog-import", "worker.py");
const sourceManifestPath = resolve(registryRoot, "source-manifest.json");
const sourceProvenancePath = resolve(registryRoot, "source-provenance.json");
const dispositionsPath = resolve(registryRoot, "dispositions.json");

const ARCHIVE_ENTRY = /^[a-f0-9]{32}(?:\/(?:asset|asset\.meta|pathname|preview\.png)\/?|\/?)$/u;
const GUID = /^[a-f0-9]{32}$/u;

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseArguments(values) {
  const result = new Map();
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    if (!key?.startsWith("--")) throw new Error(`Unexpected argument: ${key}`);
    const value = values[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
    result.set(key, value);
    index += 1;
  }
  return result;
}

function required(options, name) {
  const value = options.get(name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function inside(root, path) {
  return path === root || path.startsWith(`${root}${sep}`);
}

async function canonicalRegularFile(path, root, label) {
  if (!inside(root, path)) throw new Error(`${label} is outside ${root}`);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || (await realpath(path)) !== path)
    throw new Error(`${label} must be a canonical regular file: ${path}`);
}

async function run(executable, values, options = {}) {
  await new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, values, {
      cwd: repositoryRoot,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    });
    const stdout = [];
    const stderr = [];
    child.stdout?.on("data", (chunk) => stdout.push(chunk));
    child.stderr?.on("data", (chunk) => stderr.push(chunk));
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: "" });
      else
        rejectRun(
          new Error(
            `${basename(executable)} failed (${signal ?? code}): ${Buffer.concat(stderr).toString("utf8")}`,
          ),
        );
    });
  });
}

async function output(executable, values) {
  return await new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, values, {
      cwd: repositoryRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun(Buffer.concat(stdout).toString("utf8"));
      else
        rejectRun(
          new Error(
            `${basename(executable)} failed (${signal ?? code}): ${Buffer.concat(stderr).toString("utf8")}`,
          ),
        );
    });
  });
}

function safeUnityPath(raw) {
  if (raw.includes("\0") || raw.includes("\\") || raw.includes("\n") || raw.includes("\r"))
    throw new Error(`Unsafe Unity pathname: ${JSON.stringify(raw)}`);
  if (!raw.startsWith("Assets/") || raw.startsWith("/") || raw.split("/").includes(".."))
    throw new Error(`Unity pathname escaped Assets/: ${raw}`);
  return raw;
}

async function unpackArchive(archivePath, temporaryRoot) {
  const listing = (await output("tar", ["-tzf", archivePath])).split("\n").filter(Boolean);
  for (const entry of listing)
    if (entry !== ".icon.png" && !ARCHIVE_ENTRY.test(entry))
      throw new Error(`Unexpected Unity archive entry: ${entry}`);
  const unpacked = resolve(temporaryRoot, "archive");
  await mkdir(unpacked, { recursive: true, mode: 0o700 });
  await run("tar", ["-xzf", archivePath, "-C", unpacked]);
  return unpacked;
}

async function reconstructProject(unpackedRoot, temporaryRoot) {
  const projectRoot = resolve(temporaryRoot, "project");
  await mkdir(projectRoot, { recursive: true, mode: 0o700 });
  const records = [];
  const names = (await readdir(unpackedRoot)).sort(compare);
  for (const name of names) {
    if (name === ".icon.png") continue;
    if (!GUID.test(name)) throw new Error(`Unexpected Unity record ID: ${name}`);
    const recordRoot = resolve(unpackedRoot, name);
    const pathnameFile = resolve(recordRoot, "pathname");
    let pathname;
    try {
      const pathnameRecord = await readFile(pathnameFile, "utf8");
      const [firstLine, ...trailingLines] = pathnameRecord.split(/\r?\n/u);
      if (trailingLines.some((line) => line !== "" && !/^0+$/u.test(line)))
        throw new Error(`Unexpected trailing Unity pathname data for record ${name}`);
      pathname = safeUnityPath(firstLine);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    const source = resolve(recordRoot, "asset");
    const destination = resolve(projectRoot, pathname);
    const hasAsset = await stat(source)
      .then((entry) => entry.isFile())
      .catch((error) => {
        if (error?.code === "ENOENT") return false;
        throw error;
      });
    if (hasAsset) {
      if (!inside(projectRoot, destination))
        throw new Error(`Unity path escaped staging: ${pathname}`);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await copyFile(source, destination);
    }
    records.push({ guid: name, pathname, source, destination, hasAsset });
  }
  const byPath = new Map();
  for (const record of records) {
    if (byPath.has(record.pathname))
      throw new Error(`Duplicate Unity pathname: ${record.pathname}`);
    byPath.set(record.pathname, record);
  }
  return { projectRoot, records };
}

function yamlDocuments(text) {
  return text.split(/(?=^--- !u!)/mu).filter((document) => document.startsWith("--- !u!"));
}

function referencedGuid(line) {
  const match = /\bguid: ([a-f0-9]{32})\b/u.exec(line);
  return match?.[1];
}

function parsePrefabBindings(record) {
  const text = record.text;
  const pieces = [];
  for (const document of yamlDocuments(text)) {
    const objectId = /\bm_GameObject: \{fileID: (-?\d+)\}/u.exec(document)?.[1];
    if (!objectId) continue;
    const meshLine = document.split("\n").find((line) => /^\s*m_Mesh:/u.test(line));
    const meshGuid = meshLine ? referencedGuid(meshLine) : undefined;
    const materialGuids = [];
    const lines = document.split("\n");
    const start = lines.findIndex((line) => /^\s*m_Materials:\s*$/u.test(line));
    if (start >= 0)
      for (let index = start + 1; index < lines.length; index += 1) {
        const line = lines[index];
        if (!/^\s+- /u.test(line)) break;
        const guid = referencedGuid(line);
        if (guid) materialGuids.push(guid);
      }
    pieces.push({ objectId, meshGuid, materialGuids });
  }
  const byObject = new Map();
  for (const piece of pieces) {
    const merged = byObject.get(piece.objectId) ?? { meshGuid: undefined, materialGuids: [] };
    if (piece.meshGuid) merged.meshGuid = piece.meshGuid;
    if (piece.materialGuids.length > 0) merged.materialGuids = piece.materialGuids;
    byObject.set(piece.objectId, merged);
  }
  return [...byObject.values()]
    .filter((value) => value.meshGuid && value.materialGuids.length > 0)
    .map((value) => ({
      meshGuid: value.meshGuid,
      materialGuids: value.materialGuids,
      prefabPath: record.pathname,
    }));
}

function parseUnityMaterial(record, recordsByGuid) {
  const text = record.text;
  const name = /^\s*m_Name:\s*(.+?)\s*$/mu.exec(text)?.[1] ?? basename(record.pathname, ".mat");
  const textureGuids = {};
  const lines = text.split("\n");
  let textureProperty;
  for (const line of lines) {
    const property = /^\s*- (_[A-Za-z0-9]+):\s*$/u.exec(line)?.[1];
    if (property) textureProperty = property;
    else if (textureProperty && /\bm_Texture:/u.test(line)) {
      const guid = referencedGuid(line);
      if (guid) textureGuids[textureProperty] = guid;
      textureProperty = undefined;
    }
  }
  const texturePath = (property) => {
    const guid = textureGuids[property];
    const texture = guid ? recordsByGuid.get(guid) : undefined;
    return texture?.hasAsset ? texture.destination : undefined;
  };
  const numberProperty = (property, fallback) => {
    const match = new RegExp(`^\\s*- ${property}: (-?[0-9.eE+]+)\\s*$`, "mu").exec(text);
    const value = match ? Number(match[1]) : fallback;
    return Number.isFinite(value) ? value : fallback;
  };
  const colorMatch = /^\s*- _Color: \{r: ([^,]+), g: ([^,]+), b: ([^,]+), a: ([^}]+)\}/mu.exec(
    text,
  );
  const shaderKeywords = /^\s*m_ShaderKeywords:\s*(.*?)\s*$/mu.exec(text)?.[1] ?? "";
  const unityMode = numberProperty("_Mode", 0);
  const alphaMode =
    shaderKeywords.includes("_ALPHATEST_ON") || unityMode === 1
      ? "MASK"
      : shaderKeywords.includes("_ALPHABLEND_ON") ||
          shaderKeywords.includes("_ALPHAPREMULTIPLY_ON") ||
          unityMode >= 2
        ? "BLEND"
        : "OPAQUE";
  const baseColor = colorMatch ? colorMatch.slice(1).map(Number) : [1, 1, 1, 1];
  return {
    name,
    baseColor,
    metallic: numberProperty("_Metallic", 0),
    roughness: 1 - numberProperty("_Glossiness", 0.5),
    alphaCutoff: numberProperty("_Cutoff", 0.5),
    alphaMode,
    textures: {
      baseColor: texturePath("_MainTex"),
      normal: texturePath("_BumpMap"),
      metallicRoughness: texturePath("_MetallicGlossMap"),
      occlusion: texturePath("_OcclusionMap"),
      emissive: texturePath("_EmissionMap"),
    },
  };
}

function parseUnityModelImportSettings(model, text) {
  const globalScaleMatch = /^\s*globalScale:\s*([-+0-9.eE]+)\s*$/mu.exec(text);
  const useFileScaleMatch = /^\s*useFileScale:\s*([01])\s*$/mu.exec(text);
  if (!globalScaleMatch || !useFileScaleMatch)
    throw new Error(`FBX is missing sealed Unity scale metadata: ${model.pathname}`);
  const globalScale = Number(globalScaleMatch[1]);
  if (!Number.isFinite(globalScale) || globalScale <= 0 || globalScale > 10_000)
    throw new Error(`FBX has invalid Unity globalScale ${globalScaleMatch[1]}: ${model.pathname}`);
  if (useFileScaleMatch[1] !== "1")
    throw new Error(
      `FBX disables Unity file-unit conversion, which is unsupported: ${model.pathname}`,
    );
  return { globalScale };
}

function stem(pathname) {
  return basename(pathname, extname(pathname));
}

function bindingScore(model, binding) {
  const exact = stem(binding.prefabPath) === stem(model.pathname) ? 0 : 1;
  return [exact, binding.prefabPath.length, binding.prefabPath];
}

function compareTuple(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    const result = compare(left[index], right[index]);
    if (result !== 0) return result;
  }
  return 0;
}

function defaultMaterialFor(model, materials) {
  const lower = model.pathname.toLowerCase();
  const ranked = [...materials.values()].sort((left, right) => {
    const rank = (entry) => {
      const name = entry.material.name.toLowerCase();
      const path = entry.pathname.toLowerCase();
      let score = 100;
      if (lower.includes("character") && name.includes("character")) score -= 80;
      if (lower.includes("snow") && name.includes("snow")) score -= 70;
      if (lower.includes("dark") && name.includes("dark")) score -= 60;
      if (/(_01|_01_a|material_01)$/u.test(name)) score -= 40;
      if (path.includes("/alts/") || path.includes("/alternatives/")) score += 20;
      if (path.includes("/misc/")) score += 10;
      if (entry.material.textures.baseColor) score -= 10;
      return [score, path];
    };
    return compareTuple(rank(left), rank(right));
  });
  return ranked[0];
}

async function buildJob(project, assetPrefix, outputRoot, originId) {
  const recordsByGuid = new Map(project.records.map((record) => [record.guid, record]));
  const textRecords = [];
  for (const record of project.records) {
    const extension = extname(record.pathname).toLowerCase();
    if (!record.hasAsset || (extension !== ".prefab" && extension !== ".mat")) continue;
    textRecords.push({ ...record, text: await readFile(record.destination, "utf8") });
  }
  const materials = new Map();
  for (const record of textRecords.filter(
    (entry) => extname(entry.pathname).toLowerCase() === ".mat",
  ))
    materials.set(record.guid, {
      pathname: record.pathname,
      text: record.text,
      material: parseUnityMaterial(record, recordsByGuid),
    });
  const bindings = textRecords
    .filter((entry) => extname(entry.pathname).toLowerCase() === ".prefab")
    .flatMap(parsePrefabBindings);
  const bindingsByModel = new Map();
  for (const binding of bindings) {
    const values = bindingsByModel.get(binding.meshGuid) ?? [];
    values.push(binding);
    bindingsByModel.set(binding.meshGuid, values);
  }
  const sourceModels = project.records
    .filter((record) => record.hasAsset && extname(record.pathname).toLowerCase() === ".fbx")
    .sort((left, right) => compare(left.pathname, right.pathname));
  const models = [];
  const refusedModels = [];
  for (const model of sourceModels) {
    const handle = await open(model.destination, "r");
    try {
      const header = Buffer.alloc(23);
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      if (
        bytesRead === header.length &&
        header.toString("ascii") === "Kaydara FBX Binary  \u0000\u001a\u0000"
      ) {
        const metadataSource = resolve(dirname(model.source), "asset.meta");
        const metadataInfo = await lstat(metadataSource).catch(() => undefined);
        if (!metadataInfo?.isFile() || metadataInfo.isSymbolicLink())
          throw new Error(`Unity FBX metadata is not a regular file: ${model.pathname}`);
        const metadata = await readFile(metadataSource, "utf8").catch((error) => {
          throw new Error(
            `Unable to read Unity FBX metadata for ${model.pathname}: ${error.message}`,
          );
        });
        models.push({
          ...model,
          importSettings: parseUnityModelImportSettings(model, metadata),
        });
      } else
        refusedModels.push({
          pathname: model.pathname,
          reason: "ascii_fbx_is_not_supported_by_the_deterministic_blender_importer",
        });
    } finally {
      await handle.close();
    }
  }
  const outputs = new Set();
  const jobs = models.map((model) => {
    if (!(model.pathname === `${assetPrefix}.fbx` || model.pathname.startsWith(`${assetPrefix}/`)))
      throw new Error(`FBX falls outside --asset-prefix: ${model.pathname}`);
    const relativeModel = relative(resolve("/", assetPrefix), resolve("/", model.pathname)).replace(
      /\.fbx$/iu,
      ".glb",
    );
    if (relativeModel.startsWith(".."))
      throw new Error(`FBX escaped asset prefix: ${model.pathname}`);
    const outputPath = resolve(outputRoot, relativeModel);
    if (!inside(outputRoot, outputPath)) throw new Error(`Output path escaped root: ${outputPath}`);
    if (outputs.has(outputPath)) throw new Error(`Duplicate GLB output: ${outputPath}`);
    outputs.add(outputPath);
    const candidates = [...(bindingsByModel.get(model.guid) ?? [])].sort((left, right) =>
      compareTuple(bindingScore(model, left), bindingScore(model, right)),
    );
    const selected = candidates.find((candidate) =>
      candidate.materialGuids.some((guid) => materials.has(guid)),
    );
    const fallback = defaultMaterialFor(model, materials);
    const selectedMaterials = selected
      ? selected.materialGuids.map((guid) => materials.get(guid)).filter(Boolean)
      : fallback
        ? [fallback]
        : [];
    return {
      modelGuid: model.guid,
      sourcePath: model.destination,
      sourceUnityPath: model.pathname,
      outputPath,
      unityGlobalScale: model.importSettings.globalScale,
      materialAuthority: selected ? `prefab:${selected.prefabPath}` : "archive_default",
      materials: selectedMaterials.map((entry) => entry.material),
    };
  });
  return {
    kind: "UnityCatalogImportJob",
    originId,
    jobs,
    archiveRecords: project.records.length,
    prefabBindings: bindings.length,
    materialDeclarations: materials.size,
    skippedRecords: project.records
      .filter((record) => record.hasAsset && extname(record.pathname).toLowerCase() !== ".fbx")
      .map((record) => ({ pathname: record.pathname, reason: "not_a_renderable_fbx_model" }))
      .concat(refusedModels)
      .sort((left, right) => compare(left.pathname, right.pathname)),
  };
}

async function sha256File(path) {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

async function registerOutputs(job, archiveRelativePath, outputRoot, rights) {
  const previousManifest = TRUSTED_SOURCE_MANIFEST_SCHEMA.parse(
    JSON.parse(await readFile(sourceManifestPath, "utf8")),
  );
  const previousLedger = SOURCE_PROVENANCE_LEDGER_SCHEMA.parse(
    JSON.parse(await readFile(sourceProvenancePath, "utf8")),
  );
  const records = previousLedger.records.filter((record) => record.originId !== job.originId);
  const files = [];
  for (const item of job.jobs) {
    await canonicalRegularFile(item.outputPath, outputRoot, "Imported GLB");
    const contentHash = await sha256File(item.outputPath);
    const relativePath = sourceAssetRelativePath(contentHash);
    const destination = resolve(repositoryRoot, relativePath);
    const current = await lstat(destination).catch((error) => {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    });
    if (current) {
      if (
        !current.isFile() ||
        current.isSymbolicLink() ||
        (await sha256File(destination)) !== contentHash
      )
        throw new Error(`Canonical source collision: ${relativePath}`);
    } else {
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await copyFile(item.outputPath, destination);
    }
    const provenance = sealSourceProvenanceRecord({
      sourceContentHash: contentHash,
      originId: job.originId,
      archivePaths: [archiveRelativePath],
      originalPath: item.sourceUnityPath,
      sourceKind: rights.sourceKind,
      metersPerSourceUnit: 1,
      rights: {
        licenseId: rights.licenseId,
        commercialUsePermitted: rights.commercialUsePermitted,
        redistributionPermitted: rights.redistributionPermitted,
        attribution: rights.attribution,
      },
    });
    records.push(provenance);
    files.push({ contentHash, relativePath, provenanceHash: provenance.hash });
  }
  const ledger = sealSourceProvenanceLedger(records);
  const recordsBySource = new Map();
  for (const record of ledger.records) {
    const values = recordsBySource.get(record.sourceContentHash) ?? [];
    values.push(record);
    recordsBySource.set(record.sourceContentHash, values);
  }
  const assets = [...recordsBySource]
    .sort(([left], [right]) => compare(left, right))
    .map(([contentHash, sourceRecords]) => {
      const meterScales = new Set(sourceRecords.map((record) => record.metersPerSourceUnit));
      if (meterScales.size !== 1)
        throw new Error(`Conflicting source-unit scales for ${contentHash}`);
      const rightsClaims = new Set(sourceRecords.map((record) => JSON.stringify(record.rights)));
      if (rightsClaims.size !== 1) throw new Error(`Conflicting source rights for ${contentHash}`);
      const rightsRecord = sourceRecords[0];
      if (!rightsRecord) throw new Error(`Missing source provenance for ${contentHash}`);
      return {
        contentHash,
        relativePath: sourceAssetRelativePath(contentHash),
        metersPerSourceUnit: rightsRecord.metersPerSourceUnit,
        rights: { ...rightsRecord.rights, evidenceHash: sourceRightsEvidenceHash(rightsRecord) },
      };
    });
  const manifest = TRUSTED_SOURCE_MANIFEST_SCHEMA.parse({
    kind: "TrustedSourceManifest",
    rightsNotice: previousManifest.rightsNotice,
    assetRoot: previousManifest.assetRoot,
    assets,
  });
  await writeJsonAtomic(sourceProvenancePath, ledger);
  await writeJsonAtomic(sourceManifestPath, manifest);

  const liveHashes = new Set(manifest.assets.map((asset) => asset.contentHash));
  const existingDispositions = new Map(
    CATALOG_DISPOSITION_SCHEMA.array()
      .parse(JSON.parse(await readFile(dispositionsPath, "utf8")))
      .map((entry) => [entry.sourceContentHash, entry]),
  );
  const dispositions = [...liveHashes].map(
    (sourceContentHash) =>
      existingDispositions.get(sourceContentHash) ?? {
        sourceContentHash,
        status: "incomplete",
        reason: "Awaiting authored visual, semantic, support, and placement review",
      },
  );
  dispositions.sort((left, right) => compare(left.sourceContentHash, right.sourceContentHash));
  await writeJsonAtomic(dispositionsPath, dispositions);
  for (const previous of previousManifest.assets)
    if (!liveHashes.has(previous.contentHash)) {
      const path = resolve(repositoryRoot, previous.relativePath);
      await canonicalRegularFile(
        path,
        resolve(repositoryRoot, previousManifest.assetRoot),
        "Orphaned source",
      );
      await rm(path);
    }
  return files.sort((left, right) => compare(left.contentHash, right.contentHash));
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const archivePath = resolve(repositoryRoot, required(options, "--archive"));
  const originId = required(options, "--origin-id");
  const assetPrefix = required(options, "--asset-prefix").replace(/\/$/u, "");
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(originId))
    throw new Error(`Invalid origin ID: ${originId}`);
  if (!inside(archiveRoot, archivePath))
    throw new Error("--archive must be under registry/source-archives");
  await canonicalRegularFile(archivePath, archiveRoot, "Unity archive");
  await canonicalRegularFile(blenderExecutable, resolve("/Applications"), "Blender executable");
  await canonicalRegularFile(blenderWorker, repositoryRoot, "Catalog import worker");
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), "basalt-unity-import-"));
  try {
    const unpacked = await unpackArchive(archivePath, temporaryRoot);
    const project = await reconstructProject(unpacked, temporaryRoot);
    const outputRoot = resolve(temporaryRoot, "glb-output");
    await mkdir(outputRoot, { recursive: true, mode: 0o700 });
    const job = await buildJob(project, assetPrefix, outputRoot, originId);
    await mkdir(generatedRoot, { recursive: true, mode: 0o700 });
    const jobPath = resolve(generatedRoot, `${originId}-job.json`);
    await writeJsonAtomic(jobPath, job);
    process.stdout.write(
      `${JSON.stringify({ status: "pending", originId, models: job.jobs.length, job: jobPath })}\n`,
    );
    await run(blenderExecutable, [
      "--background",
      "--factory-startup",
      "--disable-autoexec",
      "--offline-mode",
      "--python-exit-code",
      "73",
      "--python",
      blenderWorker,
      "--",
      "--job",
      jobPath,
    ]);
    const archiveRelativePath = relative(repositoryRoot, archivePath).split(sep).join("/");
    const files = await registerOutputs(job, archiveRelativePath, outputRoot, {
      sourceKind: options.get("--source-kind") ?? "creator_owned",
      licenseId: options.get("--license-id") ?? "commercial-use-permitted",
      commercialUsePermitted: options.get("--commercial-use") !== "false",
      redistributionPermitted: options.get("--redistribution") !== "false",
      attribution:
        options.get("--attribution") ??
        "Creator-provided commercial rights; no vendor attribution requested",
    });
    const report = {
      kind: "UnityCatalogImportReport",
      originId,
      archivePath: archiveRelativePath,
      assetPrefix,
      assetRoot: "registry/source-assets/sha256",
      importedModels: files.length,
      archiveRecords: job.archiveRecords,
      prefabBindings: job.prefabBindings,
      materialDeclarations: job.materialDeclarations,
      skippedRecords: job.skippedRecords,
      outputs: files,
    };
    const reportPath = resolve(generatedRoot, `${originId}-report.json`);
    await writeJsonAtomic(reportPath, report);
    process.stdout.write(
      `${JSON.stringify({ status: "eligible", originId, imported: files.length, report: reportPath }, null, 2)}\n`,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(
    `Unity catalog import failed: ${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
});
