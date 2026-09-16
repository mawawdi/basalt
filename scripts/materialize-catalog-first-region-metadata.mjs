import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import {
  readBoundedWorkspaceBytes,
  writeCanonicalWorkspaceJson,
  writePrivateWorkspaceText,
} from "@basalt/artifact-store";
import {
  CATALOG_AUTHORITY_COMMIT_SCHEMA,
  CATALOG_VISUAL_REVIEW_INDEX_SCHEMA,
  requireCurrentCatalogAuthoredMetadataEvidence,
  sealAssetMetricPromptSummary,
  sealCatalogAuthoredMetadataBatch,
  sealCatalogSearchMetadata,
} from "@basalt/catalog-authoring";
import { CATALOG_MEASUREMENT_SET_SCHEMA } from "@basalt/catalog-model";
import { contentHash, stableJson } from "@basalt/contracts";

const repositoryRoot = resolve(".");
const outputRoot = ".basalt/catalog/metadata";
const batchPath = `${outputRoot}/first-region-batch.json`;
const reviewPath = `${outputRoot}/first-region-review.html`;

// These captions are deliberately limited to visible form, color, and composition. The admitted
// catalog handles select the demand-bound tranche, but source names do not supply caption facts.
const descriptions = new Map([
  [
    "plant_bush_01_ground",
    "Compact low-poly olive-green bush with a dense cluster of upright pointed foliage.",
  ],
  [
    "plant_bush_02_ground",
    "Broad low-poly shrub with a pale olive-green faceted canopy supported by several thin brown stems.",
  ],
  [
    "plant_bush_03_ground",
    "Dense rounded low-poly bush with angular olive-green foliage and no visible trunk.",
  ],
  [
    "plant_fern_01_ground",
    "Low fern-like rosette of broad pointed pale-green leaves spreading close to the ground.",
  ],
  [
    "plant_fern_02_ground",
    "Rounded fern-like ground plant with layered broad leaves in pale and dark olive green.",
  ],
  ["plant_grass_04_ground", "Upright clump of long narrow olive-green grass blades."],
  ["rock_01_ground", "Small squat faceted gray-beige rock with a broad blocky shape."],
  ["rock_02_ground", "Small rounded faceted gray-beige rock with sloped layered faces."],
  ["rock_03_ground", "Small compact gray-beige stone with an irregular rounded faceted shape."],
  ["rock_04_ground", "Small elongated gray-beige rock with a low angular profile."],
  ["rock_boulder_01_ground", "Large near-round faceted gray-beige boulder."],
  ["rock_rounded_01_ground", "Low flattened oval light-gray rock with a faceted surface."],
  [
    "tree_03_ground",
    "Medium low-poly tree with a brown trunk, an irregular pointed olive-green crown, and a small side foliage clump.",
  ],
  [
    "tree_birch_04_ground",
    "Slender low-poly tree with a dark trunk and two irregular crowns of very dark foliage with tan, olive, and rust highlights.",
  ],
  ["tree_log_01_ground", "Long narrow fallen brown log with broken ends and short branch stubs."],
  [
    "tree_log_02_ground",
    "Short thick fallen brown log with forked broken ends and several branch stubs.",
  ],
  [
    "tree_pine_01_ground",
    "Layered conical low-poly conifer with a brown trunk and foliage panels in tan, olive, rust, and dark brown.",
  ],
  [
    "tree_pine_large_01_ground",
    "Tall narrow low-poly conifer with a brown trunk and layered foliage panels in tan, olive, rust, and dark brown.",
  ],
  [
    "tree_round_03_ground",
    "Small low-poly tree with a short brown trunk and a single rounded olive-green crown.",
  ],
  [
    "tree_round_04_ground",
    "Medium low-poly tree with a branching brown trunk and a two-lobed rounded olive-green crown.",
  ],
  [
    "tree_stump_03_ground",
    "Wide flared dark-brown tree stump with a jagged broken top and exposed splinters.",
  ],
  ["tree_stump_04_ground", "Tall narrow dark-brown tree stump with a jagged split top."],
  [
    "tree_tallround_01_ground",
    "Tall spreading low-poly tree with a brown branching trunk and three separated rounded pale olive-green crown clumps.",
  ],
  [
    "tree_willow_large_01_ground",
    "Large low-poly weeping tree with a branching brown trunk and dense hanging foliage in dark olive, tan, and rust tones.",
  ],
]);

const [catalog, firstUseStatus, measurements, renders] = await Promise.all([
  readJson("registry/catalog.json").then((value) => CATALOG_AUTHORITY_COMMIT_SCHEMA.parse(value)),
  readJson(".basalt/evals/catalog-first-use/status.json"),
  readJson(".basalt/catalog/measurements.json").then((value) =>
    CATALOG_MEASUREMENT_SET_SCHEMA.parse(value),
  ),
  readJson(".basalt/catalog/review/index.json").then((value) =>
    CATALOG_VISUAL_REVIEW_INDEX_SCHEMA.parse(value),
  ),
]);

verifyFirstUseStatus(firstUseStatus, catalog);
if (catalog.declarations.length !== descriptions.size)
  throw new Error(
    `Expected the ${descriptions.size}-asset first-region tranche, found ${catalog.declarations.length} admitted declarations`,
  );
if (measurements.sourceManifestHash !== renders.sourceManifestHash)
  throw new Error("Current measurements and renders bind different source manifests");

const measurementsBySource = new Map(
  measurements.assets.map((asset) => [asset.source.contentHash, asset]),
);
const rendersBySource = new Map(renders.items.map((item) => [item.sourceContentHash, item]));
const records = catalog.declarations.map((declaration) => {
  const description = descriptions.get(declaration.handle);
  if (!description) throw new Error(`Missing visible description for ${declaration.handle}`);
  if (declaration.members.length !== 1)
    throw new Error(`${declaration.handle} must identify exactly one admitted source`);
  const memberId = declaration.members[0].memberId;
  const match = /^source_([a-f0-9]{16})$/u.exec(memberId);
  if (!match) throw new Error(`${declaration.handle} has an unexpected member identity`);
  const sourcePrefix = match[1];
  const candidates = measurements.assets.filter((asset) =>
    asset.source.contentHash.startsWith(sourcePrefix),
  );
  if (candidates.length !== 1)
    throw new Error(
      `${declaration.handle} resolves to ${candidates.length} current measured sources`,
    );
  const measurement = candidates[0];
  const render = rendersBySource.get(measurement.source.contentHash);
  if (!render) throw new Error(`Missing current render evidence for ${declaration.handle}`);
  const metricSummary = sealAssetMetricPromptSummary(measurement);
  return { declaration, description, measurement, render, metricSummary };
});

if (records.some((record) => !measurementsBySource.has(record.measurement.source.contentHash)))
  throw new Error("First-region metadata selection escaped the current measurement set");

const notEstablished = "Not established by this visible-description authoring pass.";
const abstained = { status: "abstained", reason: notEstablished };
const batch = sealCatalogAuthoredMetadataBatch({
  batchId: "first-region-outdoor-tranche",
  sourceManifestHash: measurements.sourceManifestHash,
  measurementSetHash: measurements.hash,
  visualReviewIndexHash: renders.hash,
  producer: { authority: "delegated_ai", actorId: "codex-executor" },
  sourceArtifactHashes: [catalog.hash, firstUseStatus.hash],
  entries: records.map(({ description, measurement, render }) => ({
    sourceContentHash: measurement.source.contentHash,
    measurementHash: measurement.hash,
    renderEvidenceHash: render.evidence.hash,
    authoringCertainty: { status: "concrete" },
    metadata: sealCatalogSearchMetadata({
      caption: { status: "observed", value: description },
      primaryNoun: abstained,
      alternateNouns: abstained,
      materials: abstained,
      colors: abstained,
      visibleText: abstained,
      useCases: abstained,
      environments: abstained,
      styleTerms: abstained,
      visualComposition: abstained,
      sourceRoleHint: abstained,
      completeness: abstained,
      visibleDamage: abstained,
      issueNotes: { status: "observed", value: [] },
    }),
  })),
});
requireCurrentCatalogAuthoredMetadataEvidence({ batch, measurements, renders });

await Promise.all([
  writeGeneratedJson(batchPath, batch),
  writeGeneratedText(reviewPath, reviewPage({ batch, records })),
]);

process.stdout.write(
  `${JSON.stringify(
    {
      status: "unreviewed",
      assets: batch.entries.length,
      batch: resolve(repositoryRoot, batchPath),
      review: resolve(repositoryRoot, reviewPath),
      batchHash: batch.hash,
      measurementSetHash: batch.measurementSetHash,
      visualReviewIndexHash: batch.visualReviewIndexHash,
      qualificationExecutionAuthorized: false,
    },
    null,
    2,
  )}\n`,
);

function verifyFirstUseStatus(value, catalog) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("First-use status must be an object");
  const { hash, ...material } = value;
  if (typeof hash !== "string" || contentHash(stableJson(material)) !== hash)
    throw new Error("First-use status hash mismatch");
  if (
    value.kind !== "CatalogFirstUseStatus" ||
    value.status !== "eligible" ||
    value.catalogCommitHash !== catalog.hash ||
    value.admittedEntryCount !== catalog.declarations.length ||
    value.catalogGapCount !== 0 ||
    value.robloxLoweringGapCount !== 0
  )
    throw new Error("First-use status does not bind an eligible zero-gap use of this catalog");
}

function reviewPage({ batch, records }) {
  const cards = records
    .map(({ declaration, description, render, metricSummary }, index) => {
      const preview = render.viewArtifacts.find((view) => view.viewId === "low_01");
      if (!preview) throw new Error(`Missing low_01 review view for ${declaration.handle}`);
      const previewPath = relative(dirname(reviewPath), preview.rgbRelativePath);
      const contactSheetPath = relative(dirname(reviewPath), render.contactSheetRelativePath);
      const size = metricSummary.sizeMeters;
      const dimensions = `${formatMeters(size.x)} × ${formatMeters(size.y)} × ${formatMeters(size.z)} m`;
      const id = `asset-${index + 1}`;
      return `
        <article class="card">
          <button class="preview" type="button" onclick="document.getElementById('${id}').showModal()">
            <img src="${escapeHtml(previewPath)}" alt="Review view for ${escapeHtml(declaration.handle)}">
          </button>
          <div class="body">
            <p class="number">${String(index + 1).padStart(2, "0")}</p>
            <h2>${escapeHtml(declaration.handle)}</h2>
            <p class="caption">${escapeHtml(description)}</p>
            <p class="measure">${dimensions}</p>
            <p class="hash">${render.sourceContentHash.slice(0, 12)}</p>
          </div>
          <dialog id="${id}">
            <div class="dialog-head">
              <div><strong>${String(index + 1).padStart(2, "0")} · ${escapeHtml(declaration.handle)}</strong><br>${escapeHtml(description)} · ${dimensions}</div>
              <button type="button" onclick="this.closest('dialog').close()">Close</button>
            </div>
            <img src="${escapeHtml(contactSheetPath)}" alt="Twelve-view contact sheet for ${escapeHtml(declaration.handle)}">
          </dialog>
        </article>`;
    })
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Basalt first-region outdoor metadata review</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #10141b; color: #edf2f7; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 28px; }
    header { max-width: 1050px; margin: 0 auto 24px; }
    h1 { margin: 0 0 8px; font-size: clamp(26px, 4vw, 46px); letter-spacing: -0.035em; }
    header p { color: #aab6c5; line-height: 1.5; margin: 6px 0; }
    .notice { border-left: 3px solid #e6a94f; padding-left: 12px; color: #f3cb87; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(285px, 1fr)); gap: 16px; max-width: 1800px; margin: auto; }
    .card { overflow: hidden; background: #19202a; border: 1px solid #2d3746; border-radius: 12px; box-shadow: 0 10px 28px #0005; }
    .preview { display: block; width: 100%; height: 230px; padding: 0; border: 0; background: #252c36; cursor: zoom-in; }
    .preview img { width: 100%; height: 100%; object-fit: contain; }
    .body { padding: 15px 16px 17px; min-height: 210px; }
    .number { color: #e6a94f; font-weight: 800; letter-spacing: .08em; margin: 0; }
    h2 { font-size: 17px; overflow-wrap: anywhere; margin: 5px 0 12px; }
    .caption { line-height: 1.45; min-height: 64px; }
    .measure, .hash { color: #91a0b2; font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; }
    dialog { width: min(96vw, 1280px); max-height: 94vh; padding: 0; color: #edf2f7; background: #10141b; border: 1px solid #45536a; border-radius: 12px; }
    dialog::backdrop { background: #000c; }
    dialog > img { display: block; width: 100%; max-height: calc(94vh - 80px); object-fit: contain; }
    .dialog-head { display: flex; gap: 18px; align-items: center; justify-content: space-between; padding: 14px 16px; line-height: 1.4; }
    button { color: inherit; }
    .dialog-head button { padding: 8px 14px; background: #273244; border: 1px solid #526078; border-radius: 8px; cursor: pointer; }
  </style>
</head>
<body>
  <header>
    <h1>First-region outdoor tranche</h1>
    <p>All ${records.length} admitted outdoor assets, shown together. Click any image for its twelve-view contact sheet. Dimensions are measured X × Y × Z bounds.</p>
    <p class="notice">These are agent-authored visible-description hypotheses. They are searchable but unreviewed, and they approve no construction role, contextual purpose, qualification result, or compiler action.</p>
    <p>Batch <code>${batch.hash}</code></p>
  </header>
  <main class="grid">${cards}
  </main>
</body>
</html>`;
}

function formatMeters(value) {
  return value.toFixed(2).replace(/\.00$/u, "");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function readJson(path) {
  return JSON.parse(await readFile(resolve(repositoryRoot, path), "utf8"));
}

async function writeGeneratedJson(path, value) {
  return writeGenerated(path, value, writeCanonicalWorkspaceJson);
}

async function writeGeneratedText(path, value) {
  return writeGenerated(path, value, writePrivateWorkspaceText);
}

async function writeGenerated(path, value, writer) {
  let expectedExistingHash;
  try {
    const current = await readBoundedWorkspaceBytes(repositoryRoot, path, 128 * 1024 * 1024);
    expectedExistingHash = createHash("sha256").update(current).digest("hex");
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("missing")) throw error;
  }
  return writer(repositoryRoot, path, value, {
    maxBytes: 128 * 1024 * 1024,
    ...(expectedExistingHash ? { expectedExistingHash } : {}),
  });
}
