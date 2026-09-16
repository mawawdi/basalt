import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import {
  CATALOG_QUALIFICATION_DEVELOPMENT_CANDIDATE_POOL_SCHEMA,
  CATALOG_QUALIFICATION_DEVELOPMENT_QUERY_SET_SCHEMA,
  CATALOG_SEARCH_RESULT_SET_SCHEMA,
  CATALOG_VISUAL_REVIEW_INDEX_SCHEMA,
  requireCatalogQualificationDevelopmentCandidatePool,
  sealAssetMetricPromptSummary,
} from "../packages/catalog-authoring/dist/index.js";
import { CATALOG_MEASUREMENT_SET_SCHEMA } from "../packages/catalog-model/dist/index.js";
import { dequantizeQ32_32 } from "../packages/contracts/dist/index.js";

const root = resolve(".");
const developmentRoot = resolve(root, ".basalt/catalog/qualification/development");
const outputRoot = resolve(developmentRoot, "relevance-review");
const queryPath = "registry/qualifications/catalog-development-query-set.json";
const poolPath = ".basalt/catalog/qualification/development/candidate-pool.json";
const readJson = async (path) => JSON.parse(await readFile(resolve(root, path), "utf8"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const queries = CATALOG_QUALIFICATION_DEVELOPMENT_QUERY_SET_SCHEMA.parse(await readJson(queryPath));
const pool = CATALOG_QUALIFICATION_DEVELOPMENT_CANDIDATE_POOL_SCHEMA.parse(
  await readJson(poolPath),
);
const measurements = CATALOG_MEASUREMENT_SET_SCHEMA.parse(
  await readJson(".basalt/catalog/measurements.json"),
);
const renders = CATALOG_VISUAL_REVIEW_INDEX_SCHEMA.parse(
  await readJson(".basalt/catalog/review/index.json"),
);
const resultSetHashes = [
  ...new Set(
    pool.queryPools.flatMap((query) => query.retrievals.map((entry) => entry.resultSetHash)),
  ),
];
const resultSets = await Promise.all(
  resultSetHashes.map(async (hash) =>
    CATALOG_SEARCH_RESULT_SET_SCHEMA.parse(
      await readJson(`.basalt/catalog/qualification/development/artifacts/result-set/${hash}.json`),
    ),
  ),
);
requireCatalogQualificationDevelopmentCandidatePool({ queries, pool, resultSets });
if (
  measurements.hash !== pool.measurementSetHash ||
  renders.hash !== pool.visualReviewIndexHash ||
  queries.hash !== pool.querySetHash
)
  throw new Error("Relevance review inputs do not bind the current evidence");
if (pool.qualificationExecutionAuthorized)
  throw new Error("An unreviewed candidate pool cannot authorize qualification execution");

const measurementBySource = new Map(
  measurements.assets.map((entry) => [entry.source.contentHash, entry]),
);
const renderBySource = new Map(renders.items.map((entry) => [entry.sourceContentHash, entry]));
const uniqueCandidateHashes = [
  ...new Set(
    pool.queryPools.flatMap((query) =>
      query.candidates.map((candidate) => candidate.sourceContentHash),
    ),
  ),
].sort();

for (const sourceContentHash of uniqueCandidateHashes) {
  const measurement = measurementBySource.get(sourceContentHash);
  const render = renderBySource.get(sourceContentHash);
  if (!measurement || !render)
    throw new Error(`Pooled source lacks measured visual evidence: ${sourceContentHash}`);
  if (
    measurement.parts.length > 0 &&
    measurement.parts.every((part) => part.role === "collision_proxy")
  )
    throw new Error(`Collision-only companion entered relevance review: ${sourceContentHash}`);
  const evidenceByView = new Map(render.evidence.views.map((view) => [view.viewId, view]));
  for (const view of render.viewArtifacts) {
    const evidence = evidenceByView.get(view.viewId);
    if (!evidence) throw new Error(`Render evidence omitted ${sourceContentHash}/${view.viewId}`);
    const bytes = await readFile(resolve(root, view.rgbRelativePath));
    if (sha256(bytes) !== evidence.rgbHash)
      throw new Error(`RGB review evidence changed: ${sourceContentHash}/${view.viewId}`);
  }
}

const queryById = new Map(queries.queries.map((entry) => [entry.queryId, entry]));
const decisionTemplate = {
  kind: "CatalogQualificationDevelopmentRelevanceDecision",
  candidatePoolHash: pool.hash,
  querySetHash: queries.hash,
  reviewer: { authority: "creator", reviewerId: null },
  reviewMethod: "independent_query_asset_relevance_review",
  reviewerStatement: null,
  reviewedAt: null,
  coverage: null,
  queries: pool.queryPools.map((queryPool) => ({
    queryId: queryPool.queryId,
    requestHash: queryPool.requestHash,
    requestDisposition: null,
    requestIssue: null,
    judgments: queryPool.candidates.map((candidate) => ({
      sourceContentHash: candidate.sourceContentHash,
      measurementHash: candidate.measurementHash,
      renderEvidenceHash: candidate.renderEvidenceHash,
      verdict: null,
      note: null,
    })),
  })),
};

const reviewData = {
  poolHash: pool.hash,
  querySetHash: queries.hash,
  pairCount: pool.pooledPairCount,
  uniqueCandidateCount: uniqueCandidateHashes.length,
  collisionCompanionsExcluded: measurements.assets.filter(
    (asset) =>
      asset.parts.length > 0 && asset.parts.every((part) => part.role === "collision_proxy"),
  ).length,
  decisionTemplate,
  queries: pool.queryPools.map((queryPool, queryIndex) => {
    const authored = queryById.get(queryPool.queryId);
    if (!authored) throw new Error(`Candidate pool contains unknown query ${queryPool.queryId}`);
    return {
      queryIndex,
      queryId: queryPool.queryId,
      requestHash: queryPool.requestHash,
      text: authored.request.text,
      styleTerms: authored.request.styleTerms,
      maximumSizeMeters: authored.request.constraints.maximumSizeMeters
        ? Object.fromEntries(
            Object.entries(authored.request.constraints.maximumSizeMeters).map(([axis, value]) => [
              axis,
              dequantizeQ32_32(value),
            ]),
          )
        : null,
      candidates: queryPool.candidates.map((candidate, candidateIndex) => {
        const measurement = measurementBySource.get(candidate.sourceContentHash);
        const render = renderBySource.get(candidate.sourceContentHash);
        if (
          !measurement ||
          measurement.hash !== candidate.measurementHash ||
          !render ||
          render.evidence.hash !== candidate.renderEvidenceHash
        )
          throw new Error(
            `Candidate evidence does not match current artifacts: ${candidate.sourceContentHash}`,
          );
        const views = render.viewArtifacts.map((view) => ({
          viewId: view.viewId,
          path: browserPath(view.rgbRelativePath),
        }));
        return {
          candidateIndex,
          sourceContentHash: candidate.sourceContentHash,
          measurementHash: candidate.measurementHash,
          renderEvidenceHash: candidate.renderEvidenceHash,
          metricSummary: sealAssetMetricPromptSummary(measurement),
          contactSheetPath: browserPath(render.contactSheetRelativePath),
          views,
          primaryViewPath: views.find((view) => view.viewId === "low_00")?.path ?? views[0]?.path,
        };
      }),
    };
  }),
};

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
await writeFile(
  resolve(outputRoot, "decision-template.json"),
  `${JSON.stringify(decisionTemplate, null, 2)}\n`,
  "utf8",
);
await writeFile(resolve(outputRoot, "index.html"), htmlDocument(reviewData), "utf8");
const overviewPaths = await renderOverviewSheets(reviewData);
await writeFile(
  resolve(outputRoot, "README.md"),
  `# Development relevance review\n\n` +
    `Open \`index.html\`. All ${pool.pooledPairCount} query–asset pairs are visible on one page. ` +
    `For each request, confirm that the request itself is usable, then judge every pooled candidate as ` +
    `Relevant, Irrelevant, or Unsure. Filenames, model captions, retrieval channels, and ranks are hidden ` +
    `from the reviewer. Click any image for all twelve views and exact measurements.\n\n` +
    `If a request needs rewriting, mark it accordingly and explain why; its stale candidates are intentionally ` +
    `not judged. After completing the page, download the decision and run ` +
    `\`npm run catalog:qualification:finalize-relevance -- --decision <downloaded-json>\`. ` +
    `This review does not approve validator verdicts or authorize qualification execution.\n`,
  "utf8",
);

process.stdout.write(
  `${JSON.stringify(
    {
      status: "incomplete",
      reason: "Pending independent creator review of query–asset relevance",
      page: resolve(outputRoot, "index.html"),
      overviews: overviewPaths,
      decisionTemplate: resolve(outputRoot, "decision-template.json"),
      poolHash: pool.hash,
      queries: pool.queryPools.length,
      pairs: pool.pooledPairCount,
      uniqueCandidates: uniqueCandidateHashes.length,
      collisionCompanionsExcluded: reviewData.collisionCompanionsExcluded,
      qualificationExecutionAuthorized: false,
    },
    null,
    2,
  )}\n`,
);

function browserPath(repositoryPath) {
  const absolute = resolve(root, repositoryPath);
  const path = relative(outputRoot, absolute).replaceAll("\\", "/");
  if (path.startsWith("../../../../") || path.startsWith("/"))
    throw new Error(`Review evidence path escapes the catalog workspace: ${repositoryPath}`);
  return path;
}

async function renderOverviewSheets(data) {
  const queriesPerSheet = 5;
  const paths = [];
  const imageCache = new Map();
  for (let start = 0; start < data.queries.length; start += queriesPerSheet) {
    const sheetQueries = data.queries.slice(start, start + queriesPerSheet);
    const sectionHeights = sheetQueries.map(
      (query) => 116 + Math.ceil(query.candidates.length / 5) * 244,
    );
    const width = 1716;
    const height = 78 + sectionHeights.reduce((sum, value) => sum + value, 0);
    const canvas = createCanvas(width, height);
    const context = canvas.getContext("2d");
    context.fillStyle = "#111419";
    context.fillRect(0, 0, width, height);
    context.fillStyle = "#edf1f5";
    context.font = '600 26px "Avenir Next", sans-serif';
    context.fillText(
      `Basalt relevance review · requests ${start + 1}–${start + sheetQueries.length}`,
      24,
      40,
    );
    context.fillStyle = "#9aa5b1";
    context.font = '14px "Avenir Next", sans-serif';
    context.fillText(
      "Images and measured dimensions only · judge each request–candidate pair",
      24,
      64,
    );
    let y = 78;
    for (const [localQueryIndex, query] of sheetQueries.entries()) {
      const queryIndex = start + localQueryIndex;
      context.fillStyle = "#171b21";
      context.fillRect(0, y, width, sectionHeights[localQueryIndex]);
      context.fillStyle = "#d8aa55";
      context.font = '600 15px "Avenir Next", sans-serif';
      context.fillText(`Request ${String(queryIndex + 1).padStart(2, "0")}`, 24, y + 27);
      context.fillStyle = "#edf1f5";
      context.font = '600 18px "Avenir Next", sans-serif';
      drawWrappedText(context, query.text, 24, y + 53, width - 48, 23, 2);
      const gridY = y + 108;
      for (const [candidateIndex, candidate] of query.candidates.entries()) {
        const column = candidateIndex % 5;
        const row = Math.floor(candidateIndex / 5);
        const x = 24 + column * 338;
        const tileY = gridY + row * 244;
        context.fillStyle = "#20262e";
        context.fillRect(x, tileY, 326, 230);
        let image = imageCache.get(candidate.primaryViewPath);
        if (!image) {
          image = await loadImage(resolve(outputRoot, candidate.primaryViewPath));
          imageCache.set(candidate.primaryViewPath, image);
        }
        const imageWidth = 310;
        const imageHeight = 174;
        const scale = Math.min(imageWidth / image.width, imageHeight / image.height);
        const drawnWidth = image.width * scale;
        const drawnHeight = image.height * scale;
        context.drawImage(
          image,
          x + 8 + (imageWidth - drawnWidth) / 2,
          tileY + 6 + (imageHeight - drawnHeight) / 2,
          drawnWidth,
          drawnHeight,
        );
        context.fillStyle = "#111419dd";
        context.fillRect(x + 8, tileY + 8, 32, 23);
        context.fillStyle = "#edf1f5";
        context.font = '600 12px "Avenir Next", sans-serif';
        context.fillText(String(candidateIndex + 1).padStart(2, "0"), x + 16, tileY + 24);
        const size = candidate.metricSummary.sizeMeters;
        context.fillStyle = "#c5ccd4";
        context.font = '12px "Avenir Next", sans-serif';
        context.fillText(
          `${metersForSheet(size.x)} × ${metersForSheet(size.y)} × ${metersForSheet(size.z)} m`,
          x + 10,
          tileY + 198,
        );
        context.fillStyle = "#798594";
        context.font = "11px ui-monospace, monospace";
        context.fillText(candidate.sourceContentHash.slice(0, 12), x + 10, tileY + 217);
      }
      y += sectionHeights[localQueryIndex];
    }
    const path = resolve(outputRoot, `overview-${String(paths.length + 1).padStart(2, "0")}.png`);
    await writeFile(path, canvas.toBuffer("image/png"));
    paths.push(path);
  }
  return paths;
}

function drawWrappedText(context, text, x, y, maximumWidth, lineHeight, maximumLines) {
  const words = text.split(/\s+/u);
  let line = "";
  let lineIndex = 0;
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (context.measureText(next).width <= maximumWidth) {
      line = next;
      continue;
    }
    context.fillText(line, x, y + lineIndex * lineHeight);
    lineIndex += 1;
    if (lineIndex >= maximumLines) return;
    line = word;
  }
  if (line && lineIndex < maximumLines) context.fillText(line, x, y + lineIndex * lineHeight);
}

function metersForSheet(value) {
  return Math.abs(value) >= 10 ? value.toFixed(1) : value.toFixed(2);
}

function htmlDocument(data) {
  const embedded = JSON.stringify(data).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Basalt — development relevance review</title>
  <style>
    :root { color-scheme:dark; --base:#111419; --ledger:#171b21; --raised:#20262e; --line:#38414d; --ink:#edf1f5; --muted:#9aa5b1; --amber:#d8aa55; --blue:#79a9d5; --green:#76bd8c; --coral:#d8736e; --violet:#a594d6; }
    * { box-sizing:border-box; }
    html { scroll-behavior:smooth; }
    body { margin:0; background:var(--base); color:var(--ink); font-family:"Avenir Next", Avenir, "Segoe UI", sans-serif; }
    button, input, textarea { font:inherit; }
    button { color:var(--ink); background:transparent; border:1px solid var(--line); cursor:pointer; }
    button:hover { border-color:#657284; }
    button:focus-visible, input:focus-visible, textarea:focus-visible { outline:2px solid var(--blue); outline-offset:2px; }
    .topbar { position:sticky; top:0; z-index:30; display:grid; grid-template-columns:minmax(260px, 1fr) minmax(260px, 1.5fr) auto; gap:24px; align-items:center; min-height:76px; padding:11px 20px; background:#14181ef2; border-bottom:1px solid var(--line); backdrop-filter:blur(12px); }
    h1 { margin:0; font-family:"Avenir Next Condensed", "Arial Narrow", sans-serif; font-size:24px; font-weight:650; letter-spacing:.015em; }
    .subtitle { margin-top:2px; color:var(--muted); font-size:12px; }
    .progress-copy { display:flex; justify-content:space-between; gap:12px; color:#c9d0d8; font-size:12px; font-variant-numeric:tabular-nums; }
    .track { height:6px; margin-top:7px; overflow:hidden; background:#2b323b; }
    .fill { width:0; height:100%; background:var(--green); }
    .top-actions { display:flex; gap:8px; }
    .top-actions button { padding:9px 13px; }
    .primary { background:#e4e9ee; border-color:#e4e9ee; color:#14181e; font-weight:650; }
    .shell { display:grid; grid-template-columns:230px minmax(0, 1fr); max-width:1900px; margin:0 auto; }
    .rail { position:sticky; top:76px; align-self:start; height:calc(100vh - 76px); overflow:auto; padding:18px 14px 32px; border-right:1px solid var(--line); background:#14181e; }
    .rail-note { margin:0 4px 13px; color:var(--muted); font-size:11px; line-height:1.45; }
    .query-nav { display:grid; gap:3px; }
    .query-nav button { display:grid; grid-template-columns:26px 1fr 8px; gap:7px; align-items:center; padding:7px; border:0; border-left:2px solid transparent; text-align:left; color:#c3cad2; }
    .query-nav button:hover { background:#1c222a; }
    .query-nav button.active { border-left-color:var(--amber); background:#1c222a; color:var(--ink); }
    .nav-number { color:var(--amber); font-variant-numeric:tabular-nums; }
    .nav-text { overflow:hidden; white-space:nowrap; text-overflow:ellipsis; font-size:11px; }
    .nav-state { width:7px; height:7px; border-radius:50%; background:#4c5663; }
    .nav-state.partial { background:var(--amber); }
    .nav-state.complete { background:var(--green); }
    .nav-state.rejected { background:var(--coral); }
    .content { min-width:0; padding:22px 24px 80px; }
    .brief { display:grid; grid-template-columns:minmax(280px, 1fr) minmax(300px, 1.6fr); gap:24px; margin-bottom:28px; padding:18px 0 22px; border-bottom:2px solid var(--amber); }
    .brief strong { font-family:"Avenir Next Condensed", "Arial Narrow", sans-serif; font-size:28px; font-weight:600; line-height:1.05; }
    .brief p { max-width:76ch; margin:0; color:#c5ccd4; font-size:13px; line-height:1.55; }
    .query { scroll-margin-top:94px; display:grid; grid-template-columns:minmax(250px, 320px) minmax(0, 1fr); gap:20px; padding:24px 0 34px; border-bottom:1px solid var(--line); }
    .request { position:sticky; top:96px; align-self:start; padding-right:18px; border-right:1px solid var(--line); }
    .request-index { color:var(--amber); font-variant-numeric:tabular-nums; font-size:12px; }
    .request h2 { margin:7px 0 12px; font-family:"Avenir Next Condensed", "Arial Narrow", sans-serif; font-size:25px; font-weight:600; line-height:1.2; }
    .facts { display:flex; flex-wrap:wrap; gap:5px; margin:0 0 15px; }
    .fact { padding:4px 7px; color:#b9c2cc; border:1px solid #323b46; font-size:10px; }
    .request-question { margin:15px 0 8px; color:#d8dee5; font-size:12px; font-weight:650; }
    .request-actions { display:grid; grid-template-columns:1fr 1fr; gap:6px; }
    .request-actions button { min-height:40px; padding:6px; font-size:11px; }
    .request-actions .selected.accept { background:var(--green); border-color:var(--green); color:#101a13; font-weight:700; }
    .request-actions .selected.reject { background:var(--coral); border-color:var(--coral); color:#240c0a; font-weight:700; }
    .issue { width:100%; min-height:86px; margin-top:8px; padding:9px; resize:vertical; color:var(--ink); background:#111419; border:1px solid var(--coral); }
    .candidates { display:grid; grid-template-columns:repeat(4, minmax(170px, 1fr)); gap:10px; align-content:start; }
    .candidate { min-width:0; background:var(--ledger); border:1px solid var(--line); }
    .candidate[data-verdict="relevant"] { border-top:3px solid var(--green); }
    .candidate[data-verdict="irrelevant"] { border-top:3px solid var(--coral); }
    .candidate[data-verdict="unknown"] { border-top:3px solid var(--violet); }
    .candidate.disabled { opacity:.42; pointer-events:none; }
    .image-button { position:relative; display:block; width:100%; padding:0; border:0; border-bottom:1px solid var(--line); background:#252c35; }
    .image-button img { display:block; width:100%; aspect-ratio:1.18; object-fit:contain; }
    .candidate-number { position:absolute; left:7px; top:7px; padding:3px 6px; color:#f4f6f8; background:#111419d9; font-size:10px; font-variant-numeric:tabular-nums; }
    .candidate-body { padding:8px; }
    .metric { color:#b9c2cc; font-size:10px; line-height:1.45; font-variant-numeric:tabular-nums; }
    .candidate-hash { margin-top:4px; color:#687483; font:9px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .verdicts { display:grid; grid-template-columns:1fr 1fr 1fr; gap:4px; margin-top:8px; }
    .verdicts button { min-height:34px; padding:4px 2px; font-size:10px; }
    .verdicts button.selected.relevant { background:var(--green); border-color:var(--green); color:#101a13; font-weight:700; }
    .verdicts button.selected.irrelevant { background:var(--coral); border-color:var(--coral); color:#240c0a; font-weight:700; }
    .verdicts button.selected.unknown { background:var(--violet); border-color:var(--violet); color:#171222; font-weight:700; }
    .unknown-note { width:100%; min-height:62px; margin-top:6px; padding:7px; resize:vertical; color:var(--ink); background:#111419; border:1px solid var(--violet); font-size:11px; }
    .query-status { margin-top:10px; min-height:18px; color:var(--muted); font-size:11px; }
    .query-status.complete { color:var(--green); }
    .query-status.problem { color:#ef9b95; }
    dialog { width:min(96vw, 1500px); height:min(94vh, 1050px); padding:0; color:var(--ink); background:#101318; border:1px solid #667281; }
    dialog::backdrop { background:#040608e6; }
    .dialog-bar { position:sticky; top:0; z-index:2; display:flex; justify-content:space-between; align-items:center; min-height:48px; padding:8px 12px; background:#171b21; border-bottom:1px solid var(--line); }
    .dialog-bar button { padding:6px 10px; }
    .dialog-body { display:grid; grid-template-columns:minmax(0, 1fr) 280px; min-height:calc(100% - 48px); }
    .evidence-stage { min-width:0; padding:12px; background:#222932; }
    .evidence-stage > img { display:block; width:100%; height:min(70vh, 760px); object-fit:contain; }
    .filmstrip { display:grid; grid-template-columns:repeat(12, 1fr); gap:4px; margin-top:8px; }
    .filmstrip button { padding:0; overflow:hidden; background:#252c35; }
    .filmstrip button.active { border-color:var(--blue); box-shadow:0 0 0 1px var(--blue); }
    .filmstrip img { display:block; width:100%; aspect-ratio:1; object-fit:contain; }
    .evidence-side { padding:16px; border-left:1px solid var(--line); }
    .evidence-side h3 { margin:0 0 13px; font-family:"Avenir Next Condensed", "Arial Narrow", sans-serif; font-size:22px; font-weight:600; }
    .evidence-side dl { display:grid; grid-template-columns:1fr auto; gap:8px 12px; margin:0; font-size:12px; }
    .evidence-side dt { color:var(--muted); }
    .evidence-side dd { margin:0; text-align:right; font-variant-numeric:tabular-nums; }
    .evidence-side p { margin:18px 0 0; color:var(--muted); font-size:11px; line-height:1.5; }
    .reviewer-dialog { width:min(680px, 94vw); height:auto; padding:18px; }
    .reviewer-dialog form { display:grid; gap:12px; }
    .reviewer-dialog h2 { margin:0; }
    .field { display:grid; gap:5px; }
    .field label { color:#c3cbd4; font-size:11px; font-weight:650; }
    .field input, .field textarea { width:100%; padding:9px; color:var(--ink); background:#111419; border:1px solid var(--line); }
    .field textarea { min-height:110px; resize:vertical; }
    .dialog-actions { display:flex; justify-content:flex-end; gap:8px; }
    .dialog-actions button { padding:9px 12px; }
    .message { min-height:18px; color:#ef9b95; font-size:12px; }
    @media (max-width:1350px) { .candidates { grid-template-columns:repeat(3, minmax(170px, 1fr)); } }
    @media (max-width:1050px) { .shell { grid-template-columns:1fr; } .rail { display:none; } .query { grid-template-columns:1fr; } .request { position:relative; top:0; padding:0 0 16px; border-right:0; border-bottom:1px solid var(--line); } .candidates { grid-template-columns:repeat(3, minmax(160px, 1fr)); } }
    @media (max-width:720px) { .topbar { position:relative; grid-template-columns:1fr; gap:10px; } .content { padding:14px; } .brief { grid-template-columns:1fr; } .candidates { grid-template-columns:repeat(2, minmax(140px, 1fr)); } .dialog-body { grid-template-columns:1fr; } .evidence-side { border-left:0; border-top:1px solid var(--line); } .filmstrip { grid-template-columns:repeat(6, 1fr); } }
    @media (prefers-reduced-motion:reduce) { html { scroll-behavior:auto; } }
  </style>
</head>
<body>
  <header class="topbar">
    <div><h1>Query–asset relevance ledger</h1><div class="subtitle">${data.queries.length} requests · ${data.pairCount} pooled pairs · one continuous review</div></div>
    <div><div class="progress-copy"><span id="pair-progress">0 / ${data.pairCount} pairs</span><span id="query-progress">0 / ${data.queries.length} requests</span></div><div class="track"><div class="fill" id="fill"></div></div></div>
    <div class="top-actions"><button id="reset">Reset</button><button class="primary" id="finish">Download reviewed decisions</button></div>
  </header>
  <div class="shell">
    <aside class="rail"><p class="rail-note">Every request and candidate is on this page. Dots show completion.</p><nav class="query-nav" id="query-nav"></nav></aside>
    <main class="content">
      <section class="brief"><strong>Judge the request,<br>then every image.</strong><p>Relevant means the visible asset and measured size satisfy the whole request. Choose Unsure when a required property—such as load-bearing, electrical function, or an opening lid—cannot be established from this evidence. Filenames, generated captions, retrieval methods, and ranks are hidden. ${data.collisionCompanionsExcluded} collision-only companions were excluded before pooling.</p></section>
      <div id="queries"></div>
    </main>
  </div>
  <dialog id="evidence-dialog"><div class="dialog-bar"><span id="evidence-label"></span><button id="close-evidence">Close</button></div><div class="dialog-body"><div class="evidence-stage"><img id="evidence-image" alt="Enlarged candidate view"><div class="filmstrip" id="filmstrip"></div></div><aside class="evidence-side" id="evidence-side"></aside></div></dialog>
  <dialog class="reviewer-dialog" id="reviewer-dialog"><form method="dialog"><h2>Complete relevance decision</h2><p style="margin:0;color:var(--muted);font-size:13px;line-height:1.5">This records query usability and relevance only. Validator verdicts remain unreviewed, and qualification execution remains blocked.</p><div class="field"><label for="reviewer-authority">Reviewer authority</label><select id="reviewer-authority"><option value="creator">Human creator</option><option value="delegated_ai">Delegated AI reviewer</option></select></div><div class="field"><label for="reviewer-id">Reviewer ID</label><input id="reviewer-id" maxlength="160" autocomplete="name"></div><div class="field"><label for="reviewer-statement">Independent review statement</label><textarea id="reviewer-statement" maxlength="2048" placeholder="I independently reviewed every accepted request and its complete pooled candidate evidence…"></textarea></div><div class="message" id="review-message"></div><div class="dialog-actions"><button value="cancel">Cancel</button><button type="button" class="primary" id="download">Download decision JSON</button></div></form></dialog>
  <script>
    const DATA = ${embedded};
    const STORAGE_KEY = "basalt-relevance-review:" + DATA.poolHash;
    let state = loadState();
    let openEvidence = null;
    let selectedView = null;
    const queriesRoot = document.querySelector("#queries");
    const navRoot = document.querySelector("#query-nav");
    const evidenceDialog = document.querySelector("#evidence-dialog");
    const reviewerDialog = document.querySelector("#reviewer-dialog");

    render();
    document.querySelector("#reset").addEventListener("click", () => {
      if (!confirm("Discard every saved judgment for this exact candidate pool?")) return;
      localStorage.removeItem(STORAGE_KEY);
      state = structuredClone(DATA.decisionTemplate);
      render();
    });
    document.querySelector("#finish").addEventListener("click", beginDownload);
    document.querySelector("#download").addEventListener("click", downloadDecision);
    document.querySelector("#close-evidence").addEventListener("click", () => evidenceDialog.close());

    function loadState() {
      try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
        if (saved?.candidatePoolHash === DATA.poolHash && saved?.queries?.length === DATA.queries.length) return saved;
      } catch {}
      return structuredClone(DATA.decisionTemplate);
    }

    function save() {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      renderProgress();
      renderNav();
    }

    function render() {
      queriesRoot.innerHTML = DATA.queries.map((query, queryIndex) => renderQuery(query, queryIndex)).join("");
      bindPage();
      renderProgress();
      renderNav();
    }

    function renderNav() {
      navRoot.innerHTML = DATA.queries.map((query, index) => {
        const status = queryStatus(index);
        return '<button data-jump="' + index + '"><span class="nav-number">' + String(index + 1).padStart(2,"0") + '</span><span class="nav-text">' + escapeHtml(query.text) + '</span><span class="nav-state ' + status + '"></span></button>';
      }).join("");
      navRoot.querySelectorAll("[data-jump]").forEach((button) => button.addEventListener("click", () => {
        document.querySelector("#query-" + button.dataset.jump).scrollIntoView({ behavior:"smooth", block:"start" });
      }));
    }

    function renderQuery(query, queryIndex) {
      const decision = state.queries[queryIndex];
      const accepted = decision.requestDisposition === "accepted";
      const rejected = decision.requestDisposition === "rejected_for_reauthoring";
      const size = query.maximumSizeMeters;
      const facts = [
        ...(size ? ['max ' + meters(size.x) + ' × ' + meters(size.y) + ' × ' + meters(size.z) + ' m'] : ['no numeric size limit']),
        ...query.styleTerms,
      ];
      const candidates = query.candidates.map((candidate, candidateIndex) => renderCandidate(candidate, queryIndex, candidateIndex, rejected)).join("");
      const error = validateQuery(queryIndex);
      return '<section class="query" id="query-' + queryIndex + '"><div class="request"><div class="request-index">Request ' + String(queryIndex + 1).padStart(2,"0") + ' of ' + DATA.queries.length + ' · ' + query.candidates.length + ' candidates</div><h2>' + escapeHtml(query.text) + '</h2><div class="facts">' + facts.map((fact) => '<span class="fact">' + escapeHtml(fact) + '</span>').join('') + '</div><p class="request-question">Is this a clear, useful asset request?</p><div class="request-actions"><button class="accept ' + (accepted ? 'selected' : '') + '" data-disposition="accepted" data-query="' + queryIndex + '">Request is usable</button><button class="reject ' + (rejected ? 'selected' : '') + '" data-disposition="rejected_for_reauthoring" data-query="' + queryIndex + '">Needs rewriting</button></div>' + (rejected ? '<textarea class="issue" data-issue="' + queryIndex + '" placeholder="Explain what must change before repooling">' + escapeHtml(decision.requestIssue ?? '') + '</textarea>' : '') + '<div class="query-status ' + (error ? 'problem' : 'complete') + '">' + escapeHtml(error ?? (rejected ? 'Rewrite requested; stale candidate judgments cleared.' : accepted ? 'Request and every candidate reviewed.' : '')) + '</div></div><div class="candidates">' + candidates + '</div></section>';
    }

    function renderCandidate(candidate, queryIndex, candidateIndex, disabled) {
      const judgment = state.queries[queryIndex].judgments[candidateIndex];
      const metric = candidate.metricSummary;
      const size = metric.sizeMeters;
      const verdict = judgment.verdict;
      return '<article class="candidate ' + (disabled ? 'disabled' : '') + '" data-verdict="' + (verdict ?? '') + '"><button class="image-button" data-evidence="' + queryIndex + ':' + candidateIndex + '" aria-label="Open all views for candidate ' + (candidateIndex + 1) + '"><img loading="lazy" src="' + escapeHtml(candidate.primaryViewPath) + '" alt="Candidate ' + (candidateIndex + 1) + '"><span class="candidate-number">' + String(candidateIndex + 1).padStart(2,"0") + '</span></button><div class="candidate-body"><div class="metric">' + meters(size.x) + ' × ' + meters(size.y) + ' × ' + meters(size.z) + ' m<br>' + metric.triangleCount.toLocaleString() + ' triangles · ' + escapeHtml(metric.support.measurementMethod.replaceAll('_',' ')) + '</div><div class="candidate-hash">' + candidate.sourceContentHash.slice(0,12) + '</div><div class="verdicts"><button class="relevant ' + (verdict === 'relevant' ? 'selected' : '') + '" data-verdict-choice="relevant" data-query="' + queryIndex + '" data-candidate="' + candidateIndex + '">Relevant</button><button class="irrelevant ' + (verdict === 'irrelevant' ? 'selected' : '') + '" data-verdict-choice="irrelevant" data-query="' + queryIndex + '" data-candidate="' + candidateIndex + '">Not a match</button><button class="unknown ' + (verdict === 'unknown' ? 'selected' : '') + '" data-verdict-choice="unknown" data-query="' + queryIndex + '" data-candidate="' + candidateIndex + '">Unsure</button></div>' + (verdict === 'unknown' ? '<textarea class="unknown-note" data-unknown-note="' + queryIndex + ':' + candidateIndex + '" placeholder="What required fact cannot this evidence establish?">' + escapeHtml(judgment.note ?? '') + '</textarea>' : '') + '</div></article>';
    }

    function bindPage() {
      document.querySelectorAll("[data-disposition]").forEach((button) => button.addEventListener("click", () => {
        const index = Number(button.dataset.query);
        const decision = state.queries[index];
        decision.requestDisposition = button.dataset.disposition;
        if (decision.requestDisposition === "accepted") decision.requestIssue = null;
        if (decision.requestDisposition === "rejected_for_reauthoring") {
          decision.judgments = [];
          decision.requestIssue = decision.requestIssue ?? null;
        } else if (decision.judgments.length === 0) {
          decision.judgments = structuredClone(DATA.decisionTemplate.queries[index].judgments);
        }
        save(); render();
      }));
      document.querySelectorAll("[data-issue]").forEach((input) => input.addEventListener("input", () => {
        state.queries[Number(input.dataset.issue)].requestIssue = input.value.trim() || null;
        save(); refreshQueryStatus(Number(input.dataset.issue));
      }));
      document.querySelectorAll("[data-verdict-choice]").forEach((button) => button.addEventListener("click", () => {
        const queryIndex = Number(button.dataset.query);
        const candidateIndex = Number(button.dataset.candidate);
        const judgment = state.queries[queryIndex].judgments[candidateIndex];
        judgment.verdict = button.dataset.verdictChoice;
        if (judgment.verdict !== "unknown") judgment.note = null;
        save(); render();
      }));
      document.querySelectorAll("[data-unknown-note]").forEach((input) => input.addEventListener("input", () => {
        const [queryIndex, candidateIndex] = input.dataset.unknownNote.split(':').map(Number);
        state.queries[queryIndex].judgments[candidateIndex].note = input.value.trim() || null;
        save(); refreshQueryStatus(queryIndex);
      }));
      document.querySelectorAll("[data-evidence]").forEach((button) => button.addEventListener("click", () => {
        const [queryIndex, candidateIndex] = button.dataset.evidence.split(':').map(Number);
        showEvidence(queryIndex, candidateIndex);
      }));
    }

    function queryStatus(index) {
      const decision = state.queries[index];
      if (decision.requestDisposition === "rejected_for_reauthoring") return validateQuery(index) ? "partial" : "rejected";
      if (!decision.requestDisposition) return "";
      const decided = decision.judgments.filter((entry) => entry.verdict).length;
      return validateQuery(index) ? (decided > 0 ? "partial" : "") : "complete";
    }

    function validateQuery(index) {
      const decision = state.queries[index];
      const expected = DATA.queries[index];
      if (!decision.requestDisposition) return "Confirm whether this request is usable.";
      if (decision.requestDisposition === "rejected_for_reauthoring") {
        if ((decision.requestIssue?.length ?? 0) < 16) return "Explain the rewrite in at least 16 characters.";
        if (decision.judgments.length !== 0) return "Rejected requests cannot keep stale judgments.";
        return null;
      }
      if (decision.requestIssue) return "Usable requests cannot carry a rewrite issue.";
      if (decision.judgments.length !== expected.candidates.length) return "Candidate evidence list is incomplete.";
      for (let candidateIndex = 0; candidateIndex < decision.judgments.length; candidateIndex++) {
        const judgment = decision.judgments[candidateIndex];
        const candidate = expected.candidates[candidateIndex];
        if (judgment.sourceContentHash !== candidate.sourceContentHash || judgment.measurementHash !== candidate.measurementHash || judgment.renderEvidenceHash !== candidate.renderEvidenceHash) return "Candidate evidence identity changed; reset this review.";
        if (!judgment.verdict) return "Candidate " + (candidateIndex + 1) + " still needs a judgment.";
        if (judgment.verdict === "unknown" && (judgment.note?.length ?? 0) < 16) return "Candidate " + (candidateIndex + 1) + " needs an uncertainty reason of 16+ characters.";
      }
      return null;
    }

    function refreshQueryStatus(index) {
      const element = document.querySelector("#query-" + index + " .query-status");
      const error = validateQuery(index);
      if (!element) return;
      element.className = "query-status " + (error ? "problem" : "complete");
      element.textContent = error ?? (state.queries[index].requestDisposition === "rejected_for_reauthoring" ? "Rewrite requested; stale candidate judgments cleared." : "Request and every candidate reviewed.");
    }

    function renderProgress() {
      let requiredPairs = 0;
      let decidedPairs = 0;
      let completeQueries = 0;
      state.queries.forEach((query, index) => {
        if (query.requestDisposition !== "rejected_for_reauthoring") {
          requiredPairs += DATA.queries[index].candidates.length;
          decidedPairs += query.judgments.filter((entry) => entry.verdict && (entry.verdict !== "unknown" || (entry.note?.length ?? 0) >= 16)).length;
        }
        if (!validateQuery(index)) completeQueries += 1;
      });
      document.querySelector("#pair-progress").textContent = decidedPairs + " / " + requiredPairs + " required pairs";
      document.querySelector("#query-progress").textContent = completeQueries + " / " + DATA.queries.length + " requests";
      const totalUnits = requiredPairs + DATA.queries.length;
      const completeUnits = decidedPairs + completeQueries;
      document.querySelector("#fill").style.width = (totalUnits ? completeUnits / totalUnits * 100 : 0) + "%";
    }

    function beginDownload() {
      const incomplete = state.queries.findIndex((_entry, index) => validateQuery(index));
      if (incomplete >= 0) {
        document.querySelector("#query-" + incomplete).scrollIntoView({ behavior:"smooth", block:"start" });
        return;
      }
      document.querySelector("#reviewer-authority").value = state.reviewer.authority ?? "creator";
      document.querySelector("#reviewer-id").value = state.reviewer.reviewerId ?? "";
      document.querySelector("#reviewer-statement").value = state.reviewerStatement ?? "";
      document.querySelector("#review-message").textContent = "";
      reviewerDialog.showModal();
    }

    function downloadDecision() {
      const reviewerAuthority = document.querySelector("#reviewer-authority").value;
      const reviewerId = document.querySelector("#reviewer-id").value.trim();
      const statement = document.querySelector("#reviewer-statement").value.trim();
      const message = document.querySelector("#review-message");
      if (!reviewerId) { message.textContent = "Reviewer ID is required."; return; }
      if (statement.length < 32) { message.textContent = "The independent review statement must be at least 32 characters."; return; }
      const incomplete = state.queries.findIndex((_entry, index) => validateQuery(index));
      if (incomplete >= 0) { message.textContent = "Request " + (incomplete + 1) + " is incomplete."; return; }
      state.reviewer.authority = reviewerAuthority;
      state.reviewer.reviewerId = reviewerId;
      state.reviewerStatement = statement;
      state.reviewedAt = new Date().toISOString();
      state.coverage = "complete";
      save();
      const blob = new Blob([JSON.stringify(state, null, 2) + "\\n"], { type:"application/json" });
      const anchor = document.createElement("a");
      anchor.href = URL.createObjectURL(blob);
      anchor.download = "catalog-development-relevance-decision.json";
      anchor.click();
      URL.revokeObjectURL(anchor.href);
      reviewerDialog.close();
    }

    function showEvidence(queryIndex, candidateIndex) {
      openEvidence = { queryIndex, candidateIndex };
      const candidate = DATA.queries[queryIndex].candidates[candidateIndex];
      selectedView = candidate.views.find((entry) => entry.viewId === "low_00")?.viewId ?? candidate.views[0].viewId;
      renderEvidence();
      evidenceDialog.showModal();
    }

    function renderEvidence() {
      const { queryIndex, candidateIndex } = openEvidence;
      const query = DATA.queries[queryIndex];
      const candidate = query.candidates[candidateIndex];
      const view = candidate.views.find((entry) => entry.viewId === selectedView) ?? candidate.views[0];
      const metric = candidate.metricSummary;
      document.querySelector("#evidence-label").textContent = "Request " + (queryIndex + 1) + " · candidate " + (candidateIndex + 1) + " · " + view.viewId;
      document.querySelector("#evidence-image").src = view.path;
      document.querySelector("#filmstrip").innerHTML = candidate.views.map((entry) => '<button class="' + (entry.viewId === view.viewId ? 'active' : '') + '" data-view="' + entry.viewId + '" title="' + entry.viewId + '"><img src="' + escapeHtml(entry.path) + '" alt="' + entry.viewId + '"></button>').join('');
      document.querySelector("#filmstrip").querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => { selectedView = button.dataset.view; renderEvidence(); }));
      document.querySelector("#evidence-side").innerHTML = '<h3>' + escapeHtml(query.text) + '</h3><dl><dt>Size X × Y × Z</dt><dd>' + meters(metric.sizeMeters.x) + ' × ' + meters(metric.sizeMeters.y) + ' × ' + meters(metric.sizeMeters.z) + ' m</dd><dt>Triangles</dt><dd>' + metric.triangleCount.toLocaleString() + '</dd><dt>Renderable parts</dt><dd>' + metric.partCounts.renderable + '</dd><dt>Collision parts</dt><dd>' + metric.partCounts.collision + '</dd><dt>Primary contact</dt><dd>' + escapeHtml(metric.support.primaryContact.replaceAll('_',' ')) + '</dd><dt>Contact method</dt><dd>' + escapeHtml(metric.support.measurementMethod.replaceAll('_',' ')) + '</dd><dt>Planar contact area</dt><dd>' + metric.support.contactAreaSquareMeters.toFixed(4) + ' m²</dd></dl><p>Only visual and measured evidence is shown. Source filenames, generated captions, retrieval channel, and rank are intentionally withheld.</p>';
    }

    function meters(value) { return Math.abs(value) >= 10 ? value.toFixed(2) : value.toFixed(3); }
    function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (character) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[character])); }
  </script>
</body>
</html>\n`;
}
