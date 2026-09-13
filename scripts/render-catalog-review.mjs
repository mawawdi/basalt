#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { basename, dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  CATALOG_VISUAL_REVIEW_INDEX_SCHEMA,
  CATALOG_REVIEW_VIEWPOINTS,
  sealCatalogRenderEvidence,
  sealCatalogVisualReviewIndex,
} from "@basalt/catalog-authoring";
import { TRUSTED_SOURCE_MANIFEST_SCHEMA } from "@basalt/catalog-model";
import { contentHash, stableJson } from "@basalt/contracts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reviewRoot = resolve(root, ".basalt/catalog/review");
const previewRoot = resolve(reviewRoot, "previews");
const blender = process.env.BASALT_BLENDER ?? "/Applications/Blender.app/Contents/MacOS/Blender";
const rendererPath = resolve(root, "workers/catalog-review/render.py");
const contactSheetPath = resolve(root, "workers/catalog-review/contact_sheets.py");
const cameraRig = {
  projection: "orthographic",
  resolution: [320, 320],
  renderSamples: 16,
  framingMargin: 1.7,
  views: CATALOG_REVIEW_VIEWPOINTS,
};
const lighting = {
  world: [0.055, 0.065, 0.08, 0.9],
  key: [2, -3, 4, 85],
  fill: [-3, -1, 2, 35],
  rim: [0, 3, 1, 20],
  exposure: 0.35,
  look: "AgX - Medium High Contrast",
};
const materialMode = {
  importedAlbedoAndAlpha: true,
  metallic: 0,
  roughness: 0.72,
  emissionStrength: 0,
};
const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const renderPolicyReceiptSchema = z
  .object({
    kind: z.literal("CatalogMultiviewRenderJob"),
    rendererImplementationHash: z.string().regex(/^[a-f0-9]{64}$/u),
    cameraRigHash: z.string().regex(/^[a-f0-9]{64}$/u),
    lightingHash: z.string().regex(/^[a-f0-9]{64}$/u),
    materialModeHash: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .passthrough();

function run(command, args, capture = false, filterProgress = false) {
  return new Promise((done, fail) => {
    const chunks = [];
    const filteredLines = [];
    const errorTail = [];
    let lineBuffer = "";
    const child = spawn(command, args, {
      cwd: root,
      stdio: capture
        ? ["ignore", "pipe", "inherit"]
        : filterProgress
          ? ["ignore", "pipe", "pipe"]
          : "inherit",
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    });
    if (capture) child.stdout.on("data", (chunk) => chunks.push(chunk));
    if (filterProgress) {
      child.stdout.on("data", (chunk) => {
        lineBuffer += chunk.toString("utf8");
        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop() ?? "";
        for (const line of lines)
          if (
            line.startsWith('{"rendered"') ||
            line.startsWith('{"hash"') ||
            line.startsWith('{"completed"')
          ) {
            filteredLines.push(line);
            process.stdout.write(`${line}\n`);
          }
      });
      child.stderr.on("data", (chunk) => {
        errorTail.push(chunk);
        while (errorTail.reduce((sum, value) => sum + value.byteLength, 0) > 64 * 1024)
          errorTail.shift();
      });
    }
    child.once("error", fail);
    child.once("exit", (code) =>
      code === 0
        ? done(
            capture
              ? Buffer.concat(chunks).toString("utf8")
              : filterProgress
                ? filteredLines
                : undefined,
          )
        : fail(
            new Error(
              `${basename(command)} exited ${code}${errorTail.length > 0 ? `: ${Buffer.concat(errorTail).toString("utf8")}` : ""}`,
            ),
          ),
    );
  });
}

function boundedWorkerCount(itemCount) {
  const requested = Number(
    process.env.BASALT_REVIEW_WORKERS ?? Math.min(4, availableParallelism()),
  );
  if (!Number.isSafeInteger(requested) || requested < 1 || requested > 8)
    throw new Error("BASALT_REVIEW_WORKERS must be an integer from 1 through 8");
  return Math.min(requested, itemCount);
}

function contiguousShards(items, count) {
  return Array.from({ length: count }, (_, index) =>
    items.slice(
      Math.floor((items.length * index) / count),
      Math.floor((items.length * (index + 1)) / count),
    ),
  );
}

async function regularFile(path) {
  const info = await lstat(path).catch(() => undefined);
  return Boolean(info?.isFile() && !info.isSymbolicLink());
}

async function realPng(path) {
  if (!(await regularFile(path))) return false;
  const descriptor = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const signature = Buffer.alloc(8);
    const { bytesRead } = await descriptor.read(signature, 0, signature.length, 0);
    return (
      bytesRead === signature.length &&
      signature.equals(Buffer.from("89504e470d0a1a0a", "hex"))
    );
  } finally {
    await descriptor.close();
  }
}

async function hashFile(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error(`Render artifact is not a regular file: ${path}`);
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = resolve(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

function reviewItem(pack, file) {
  const outputDirectory = resolve(previewRoot, file.sha256);
  return {
    sourceContentHash: file.sha256,
    packageId: pack.packageId,
    sourcePath: resolve(root, file.relativePath),
    relativePath: file.relativePath,
    contactSheetPath: resolve(outputDirectory, "contact-sheet.png"),
    views: CATALOG_REVIEW_VIEWPOINTS.map((view) => ({
      ...view,
      rgbPath: resolve(outputDirectory, `${view.viewId}-rgb.png`),
      silhouettePath: resolve(outputDirectory, `${view.viewId}-silhouette.png`),
      normalizedDepthPath: resolve(outputDirectory, `${view.viewId}-depth.png`),
    })),
  };
}

function portableRelative(path) {
  return relative(root, path).split("\\").join("/");
}

async function renderOutputsComplete(item) {
  const paths = item.views.flatMap((view) => [
    view.rgbPath,
    view.silhouettePath,
    view.normalizedDepthPath,
  ]);
  return (await Promise.all(paths.map(realPng))).every(Boolean);
}

async function removeRegularOutput(path) {
  const information = await lstat(path).catch((error) => {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  });
  if (!information) return;
  if (!information.isFile() || information.isSymbolicLink())
    throw new Error(`Refusing to replace unsafe render output: ${path}`);
  await unlink(path);
}

async function resetItemOutputs(item) {
  await Promise.all([
    removeRegularOutput(item.contactSheetPath),
    ...item.views.flatMap((view) => [
      removeRegularOutput(view.rgbPath),
      removeRegularOutput(view.silhouettePath),
      removeRegularOutput(view.normalizedDepthPath),
    ]),
  ]);
}

async function resetGeneratedDirectory(path) {
  const information = await lstat(path).catch((error) => {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  });
  if (information) {
    if (!information.isDirectory() || information.isSymbolicLink())
      throw new Error(`Refusing to reset unsafe generated directory: ${path}`);
    await rm(path, { recursive: true });
  }
  await mkdir(path, { recursive: true, mode: 0o700 });
}

async function main() {
  const blenderIdentity = String(await run(blender, ["--version"], true))
    .split("\n")[0]
    ?.trim();
  const rendererImplementationHash = createHash("sha256")
    .update(await readFile(rendererPath))
    .update(await readFile(contactSheetPath))
    .update(blenderIdentity)
    .digest("hex");
  const cameraRigHash = contentHash(stableJson(cameraRig));
  const lightingHash = contentHash(stableJson(lighting));
  const materialModeHash = contentHash(stableJson(materialMode));
  const source = TRUSTED_SOURCE_MANIFEST_SCHEMA.parse(
    JSON.parse(await readFile(resolve(root, "registry/source-manifest.json"), "utf8")),
  );
  const sourceManifestHash = contentHash(stableJson(source));
  const byHash = new Map();
  for (const pack of source.packages)
    for (const file of pack.files) {
      const candidate = reviewItem(pack, file);
      const existing = byHash.get(file.sha256);
      if (!existing || compare(candidate.relativePath, existing.relativePath) < 0)
        byHash.set(file.sha256, candidate);
    }
  const items = [...byHash.values()].sort((left, right) =>
    compare(left.sourceContentHash, right.sourceContentHash),
  );
  const indexPath = resolve(reviewRoot, "index.json");
  const previous = await readFile(indexPath, "utf8")
    .then((value) => CATALOG_VISUAL_REVIEW_INDEX_SCHEMA.parse(JSON.parse(value)))
    .catch(() => undefined);
  const jobPath = resolve(reviewRoot, "render-job.json");
  const previousJob = await readFile(jobPath, "utf8")
    .then((value) => renderPolicyReceiptSchema.parse(JSON.parse(value)))
    .catch(() => undefined);
  const policyMatches = (value) =>
    value?.rendererImplementationHash === rendererImplementationHash &&
    value.cameraRigHash === cameraRigHash &&
    value.lightingHash === lightingHash &&
    value.materialModeHash === materialModeHash;
  const reusableEvidence = policyMatches(previous) || policyMatches(previousJob);
  if (!reusableEvidence) await resetGeneratedDirectory(previewRoot);
  else await mkdir(previewRoot, { recursive: true, mode: 0o700 });
  for (const item of items)
    await mkdir(dirname(item.contactSheetPath), { recursive: true, mode: 0o700 });
  const pending = [];
  for (const item of items)
    if (!reusableEvidence || !(await renderOutputsComplete(item))) pending.push(item);
  if (reusableEvidence)
    for (const item of pending) await resetItemOutputs(item);
  const job = {
    kind: "CatalogMultiviewRenderJob",
    rendererImplementationHash,
    cameraRigHash,
    lightingHash,
    materialModeHash,
    items: pending,
  };
  await writeJsonAtomic(jobPath, job);

  const renderFailures = new Map();
  if (pending.length > 0) {
    const shards = contiguousShards(pending, boundedWorkerCount(pending.length));
    const executions = shards.map(async (shard, index) => {
      const shardPath = resolve(
        reviewRoot,
        `render-shard-${String(index + 1).padStart(2, "0")}.json`,
      );
      await writeJsonAtomic(shardPath, { ...job, items: shard });
      return run(
        blender,
        [
          "--background",
          "--factory-startup",
          "--disable-autoexec",
          "--offline-mode",
          "--python-exit-code",
          "73",
          "--python",
          rendererPath,
          "--",
          "--job",
          shardPath,
        ],
        false,
        true,
      );
    });
    const results = await Promise.allSettled(executions);
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length > 0)
      throw new Error(
        `${failures.length} of ${shards.length} render shards failed: ${failures.map((failure) => String(failure.reason)).join("; ")}`,
      );
    for (const result of results)
      if (result.status === "fulfilled")
        for (const line of result.value ?? []) {
          const parsed = JSON.parse(line);
          if (typeof parsed.hash === "string" && typeof parsed.reason === "string")
            renderFailures.set(parsed.hash, parsed.reason);
        }
  }

  const completedItems = [];
  const failedItems = [];
  for (const item of items)
    if (await renderOutputsComplete(item)) completedItems.push(item);
    else failedItems.push(item);

  const sheetJobPath = resolve(reviewRoot, "contact-sheet-job.json");
  await writeJsonAtomic(sheetJobPath, { kind: "CatalogContactSheetJob", items: completedItems });
  const sheetRoot = resolve(reviewRoot, "sheets");
  await resetGeneratedDirectory(sheetRoot);
  await run("python3", [
    contactSheetPath,
    "--job",
    sheetJobPath,
    "--output",
    sheetRoot,
  ]);

  const indexedItems = [];
  for (const item of completedItems) {
    const evidence = sealCatalogRenderEvidence({
      sourceContentHash: item.sourceContentHash,
      rendererImplementationHash,
      cameraRigHash,
      lightingHash,
      materialModeHash,
      views: await Promise.all(
        item.views.map(async (view) => ({
          viewId: view.viewId,
          azimuthDegrees: view.azimuthDegrees,
          elevationDegrees: view.elevationDegrees,
          rgbHash: await hashFile(view.rgbPath),
          silhouetteHash: await hashFile(view.silhouettePath),
          normalizedDepthHash: await hashFile(view.normalizedDepthPath),
        })),
      ),
      contactSheetHash: await hashFile(item.contactSheetPath),
    });
    const fileName = basename(item.relativePath);
    indexedItems.push({
      sourceContentHash: item.sourceContentHash,
      packageId: item.packageId,
      reviewHints: {
        relativePath: item.relativePath,
        filenameStem: fileName.slice(0, fileName.length - extname(fileName).length),
        vendorDirectory: dirname(item.relativePath).split("\\").join("/"),
        authority: "review_hint_only",
      },
      contactSheetRelativePath: portableRelative(item.contactSheetPath),
      viewArtifacts: item.views.map((view) => ({
        viewId: view.viewId,
        rgbRelativePath: portableRelative(view.rgbPath),
        silhouetteRelativePath: portableRelative(view.silhouettePath),
        normalizedDepthRelativePath: portableRelative(view.normalizedDepthPath),
      })),
      evidence,
    });
  }
  const diagnostics = failedItems.map(
    (item) =>
      `render:${item.sourceContentHash}:${renderFailures.get(item.sourceContentHash) ?? "current renderer did not produce every required artifact"}`,
  );
  const index = sealCatalogVisualReviewIndex({
    status: diagnostics.length === 0 ? "eligible" : "incomplete",
    sourceManifestHash,
    rendererImplementationHash,
    cameraRigHash,
    lightingHash,
    materialModeHash,
    items: indexedItems,
    diagnostics,
  });
  await writeJsonAtomic(indexPath, index);
  process.stdout.write(
    `${JSON.stringify({ status: index.status, assets: indexedItems.length, refused: failedItems.length, rendered: pending.length, index: indexPath }, null, 2)}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
