import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import {
  CATALOG_QUALIFICATION_DESCRIPTION_PROPOSAL_SCHEMA,
  CATALOG_REVIEW_EVIDENCE_AUDIT_SCHEMA,
} from "../packages/catalog-authoring/dist/index.js";

const root = resolve(".");
const outputRoot = resolve(root, ".basalt/catalog/qualification/review");
const proposalPath = "registry/qualifications/catalog-description-proposal.json";
const auditPath = "registry/qualifications/catalog-review-evidence-audit.json";
const readJson = async (path) => JSON.parse(await readFile(resolve(root, path), "utf8"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const proposal = CATALOG_QUALIFICATION_DESCRIPTION_PROPOSAL_SCHEMA.parse(
  await readJson(proposalPath),
);
const audit = CATALOG_REVIEW_EVIDENCE_AUDIT_SCHEMA.parse(await readJson(auditPath));
if (proposal.reviewEvidenceAuditHash !== audit.hash)
  throw new Error("Description proposal does not bind the current review-evidence audit");
if (proposal.qualificationExecutionAuthorized)
  throw new Error("Unreviewed description proposals cannot authorize qualification execution");

for (const asset of proposal.assets) {
  for (const view of asset.evidence.rgbViews) {
    const bytes = await readFile(resolve(root, view.rgbRelativePath));
    if (sha256(bytes) !== view.rgbHash)
      throw new Error(`RGB review evidence changed: ${asset.sourceContentHash}/${view.viewId}`);
  }
}

const decisionTemplate = {
  kind: "CatalogQualificationDescriptionDecision",
  proposalHash: proposal.hash,
  reviewer: { authority: "creator", reviewerId: null },
  reviewMethod: "independent_visible_description_review",
  reviewerStatement: null,
  reviewedAt: null,
  coverage: null,
  assets: proposal.assets.map((asset) => ({
    sourceContentHash: asset.sourceContentHash,
    reviewAction: null,
    evidenceUsability: asset.evidenceUsability,
    visibleDescription: asset.visibleDescription,
  })),
};

const reviewData = {
  proposalHash: proposal.hash,
  auditHash: audit.hash,
  collisionCompanionsExcluded: audit.findings.length,
  collisionCompanionsMisclassified: audit.findings.filter((entry) =>
    entry.measuredPartRoles.some((role) => role !== "collision_proxy"),
  ).length,
  defectKinds: [
    "material_projection_failure",
    "missing_or_incomplete_views",
    "non_renderable_collision_companion",
    "render_bounds_failure",
    "unreadable_scale_or_framing",
  ],
  decisionTemplate,
  assets: proposal.assets.map((asset, index) => ({
    index,
    sourceContentHash: asset.sourceContentHash,
    sourceRelativePath: asset.sourceRelativePath,
    filenameObservations: asset.filenameHint.observations,
    visibleDescription: asset.visibleDescription,
    contactSheetPath: browserRelativePath(asset.evidence.contactSheetRelativePath),
    views: asset.evidence.rgbViews.map((view) => ({
      ...view,
      path: browserRelativePath(view.rgbRelativePath),
    })),
    metricSummary: asset.evidence.metricSummary,
  })),
};

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
await writeFile(
  resolve(outputRoot, "decision-template.json"),
  `${JSON.stringify(decisionTemplate, null, 2)}\n`,
  "utf8",
);
await writeFile(resolve(outputRoot, "index.html"), htmlDocument(reviewData), "utf8");
await renderOverviewSheet(proposal.assets, resolve(outputRoot, "all-24-assets.png"));
await writeFile(
  resolve(outputRoot, "README.md"),
  `# Catalog description pilot review\n\n` +
    `Open \`index.html\`. It contains all 24 development assets in one workspace, with twelve ` +
    `views, enlargement, exact measurements, and one required decision: whether the proposed visible ` +
    `description is accurate. Editing, uncertainty, and image-defect controls appear only when selected. ` +
    `Filename observations are visually separated and have no authority. Internal sampling tags are not ` +
    `part of the creator decision.\n\n` +
    `The evidence audit excluded ${audit.findings.length} explicit collision companions before proposal ` +
    `selection; ${reviewData.collisionCompanionsMisclassified} are currently measured as renderable and ` +
    `therefore remain an explicit upstream diagnostic.\n\n` +
    `After independently reviewing every asset, use **Download final decision** and run ` +
    `\`npm run catalog:qualification:finalize-descriptions -- --decision <downloaded-json>\`. ` +
    `That only seals the reviewed descriptions. Query authoring and qualification execution remain blocked.\n`,
  "utf8",
);

process.stdout.write(
  `${JSON.stringify(
    {
      status: "incomplete",
      reason: "Pending independent creator review of all 24 development assets",
      page: resolve(outputRoot, "index.html"),
      overview: resolve(outputRoot, "all-24-assets.png"),
      decisionTemplate: resolve(outputRoot, "decision-template.json"),
      proposalHash: proposal.hash,
      assets: proposal.assets.length,
      viewsPerAsset: 12,
      collisionCompanionsExcluded: audit.findings.length,
      qualificationExecutionAuthorized: false,
    },
    null,
    2,
  )}\n`,
);

function browserRelativePath(repositoryPath) {
  const prefix = ".basalt/catalog/";
  if (!repositoryPath.startsWith(prefix))
    throw new Error(`Review evidence path is outside the catalog evidence root: ${repositoryPath}`);
  return `../../${repositoryPath.slice(prefix.length)}`;
}

async function renderOverviewSheet(assets, output) {
  const columns = 6;
  const rows = 4;
  const tileWidth = 320;
  const tileHeight = 280;
  const canvas = createCanvas(columns * tileWidth, rows * tileHeight);
  const context = canvas.getContext("2d");
  context.fillStyle = "#15191f";
  context.fillRect(0, 0, canvas.width, canvas.height);
  for (const [index, asset] of assets.entries()) {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = column * tileWidth;
    const y = row * tileHeight;
    context.fillStyle = index % 2 === 0 ? "#202630" : "#252c36";
    context.fillRect(x + 1, y + 1, tileWidth - 2, tileHeight - 2);
    const view = asset.evidence.rgbViews.find((entry) => entry.viewId === "low_00");
    if (!view) throw new Error(`Pilot source lacks low_00: ${asset.sourceContentHash}`);
    const image = await loadImage(resolve(root, view.rgbRelativePath));
    const availableWidth = tileWidth - 20;
    const availableHeight = 210;
    const scale = Math.min(availableWidth / image.width, availableHeight / image.height);
    const width = image.width * scale;
    const height = image.height * scale;
    context.drawImage(
      image,
      x + (tileWidth - width) / 2,
      y + 8 + (availableHeight - height) / 2,
      width,
      height,
    );
    context.fillStyle = "#f3f5f7";
    context.font = "600 14px sans-serif";
    context.fillText(String(index + 1).padStart(2, "0"), x + 10, y + 236);
    context.fillStyle = "#b9c1cb";
    context.font = "12px sans-serif";
    context.fillText(
      truncate(asset.visibleDescription.text ?? "UNREVIEWABLE", 46),
      x + 10,
      y + 257,
    );
    context.fillStyle = "#7f8995";
    context.font = "11px monospace";
    context.fillText(asset.sourceContentHash.slice(0, 12), x + 10, y + 274);
  }
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, canvas.toBuffer("image/png"));
}

function truncate(value, limit) {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function htmlDocument(data) {
  const embedded = JSON.stringify(data).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Basalt — 24-asset description review</title>
  <style>
    :root { color-scheme: dark; --ink:#eef1f4; --muted:#98a2ae; --line:#343c47; --panel:#1b2027; --panel2:#222933; --base:#11151a; --amber:#e6a84c; --red:#e06b67; --green:#78ba8b; --focus:#87aee6; }
    * { box-sizing: border-box; }
    html, body { margin:0; min-height:100%; background:var(--base); color:var(--ink); font-family:Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    button, input, select, textarea { font:inherit; }
    button, select, input, textarea { color:var(--ink); background:#151a20; border:1px solid var(--line); border-radius:4px; }
    button { cursor:pointer; padding:8px 11px; }
    button:hover { border-color:#5d6876; }
    button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible { outline:2px solid var(--focus); outline-offset:2px; }
    .topbar { position:sticky; top:0; z-index:20; min-height:64px; display:flex; align-items:center; gap:16px; padding:10px 16px; background:#151a20; border-bottom:1px solid var(--line); }
    .title { min-width:280px; }
    .title h1 { margin:0; font-size:17px; font-weight:650; letter-spacing:.01em; }
    .title p { margin:3px 0 0; color:var(--muted); font-size:12px; }
    .progress { flex:1; display:flex; align-items:center; gap:10px; }
    .track { flex:1; height:7px; background:#2a3039; border-radius:4px; overflow:hidden; }
    .fill { height:100%; width:0; background:var(--green); }
    .count { color:var(--muted); font-size:12px; font-variant-numeric:tabular-nums; min-width:72px; text-align:right; }
    .top-actions { display:flex; gap:8px; }
    .primary { background:#dde3ea; color:#11151a; border-color:#dde3ea; font-weight:650; }
    .warning { color:#ffd58c; border-color:#76562a; background:#2a2217; }
    .layout { display:grid; grid-template-columns:minmax(520px, 42vw) minmax(560px, 1fr); min-height:calc(100vh - 64px); }
    .catalog { padding:14px; border-right:1px solid var(--line); }
    .catalog-head { display:flex; align-items:center; justify-content:space-between; margin-bottom:12px; }
    .catalog-head h2 { margin:0; font-size:13px; letter-spacing:.08em; text-transform:uppercase; }
    .catalog-head a { color:#b7c9e7; font-size:12px; }
    .grid { display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)); gap:8px; }
    .card { position:relative; width:100%; padding:0; overflow:hidden; text-align:left; background:var(--panel); }
    .card.active { border-color:var(--focus); box-shadow:0 0 0 1px var(--focus); }
    .card.reviewed::after { content:"✓"; position:absolute; top:7px; right:7px; display:grid; place-items:center; width:22px; height:22px; color:#102016; background:var(--green); border-radius:50%; font-weight:800; }
    .card img { display:block; width:100%; aspect-ratio:1.18; object-fit:contain; background:#252c35; }
    .card-body { padding:8px; min-height:86px; }
    .eyebrow { color:var(--amber); font:600 10px ui-monospace, SFMono-Regular, Menlo, monospace; text-transform:uppercase; }
    .card-desc { margin-top:5px; color:#d9dde2; font-size:12px; line-height:1.3; }
    .hash { margin-top:5px; color:#77818d; font:10px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .inspector { position:sticky; top:64px; height:calc(100vh - 64px); overflow:auto; padding:18px; background:#171c22; }
    .inspector-head { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; margin-bottom:12px; }
    .inspector h2 { margin:2px 0 5px; font-size:19px; font-weight:650; }
    .subhash { color:var(--muted); font:11px ui-monospace, SFMono-Regular, Menlo, monospace; word-break:break-all; }
    .nav { display:flex; gap:6px; }
    .stage { position:relative; min-height:390px; display:grid; place-items:center; background:#252c35; border:1px solid var(--line); }
    .stage img { display:block; width:100%; height:440px; object-fit:contain; cursor:zoom-in; }
    .view-label { position:absolute; left:9px; bottom:8px; padding:4px 6px; background:#0e1217dd; color:#cbd1d8; font:11px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .filmstrip { display:grid; grid-template-columns:repeat(12, 1fr); gap:5px; margin:7px 0 15px; }
    .thumb { padding:0; overflow:hidden; border-radius:3px; background:#252c35; }
    .thumb.active { border-color:var(--focus); box-shadow:0 0 0 1px var(--focus); }
    .thumb img { display:block; width:100%; aspect-ratio:1; object-fit:contain; }
    .evidence-row { display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:14px; }
    .panel { padding:12px; background:var(--panel); border:1px solid var(--line); border-radius:4px; }
    .panel h3 { margin:0 0 9px; font-size:12px; letter-spacing:.06em; text-transform:uppercase; color:#cbd1d8; }
    .metrics { display:grid; grid-template-columns:auto 1fr; gap:5px 12px; margin:0; font-size:12px; }
    .metrics dt { color:var(--muted); }
    .metrics dd { margin:0; text-align:right; font-variant-numeric:tabular-nums; }
    details summary { color:var(--amber); cursor:pointer; font-size:12px; }
    details p { color:#c8aa79; font:11px ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap:anywhere; }
    .authority { margin-top:9px; color:var(--red); font-size:11px; font-weight:650; text-transform:uppercase; letter-spacing:.05em; }
    .form { display:grid; gap:10px; }
    .field { display:grid; gap:5px; }
    .field label, .group-label { color:#b8c0ca; font-size:11px; font-weight:650; letter-spacing:.04em; text-transform:uppercase; }
    input, select, textarea { width:100%; padding:8px; }
    textarea { min-height:64px; resize:vertical; line-height:1.35; }
    .row { display:grid; grid-template-columns:1fr 1fr; gap:9px; }
    .defects { display:grid; grid-template-columns:1fr 1fr; gap:5px; padding:8px; border:1px solid var(--line); }
    .defects label { display:flex; align-items:flex-start; gap:6px; color:#c4cad1; font-size:11px; text-transform:none; letter-spacing:0; }
    .defects input { width:auto; margin-top:2px; }
    .decision-panel { padding:16px; }
    .question { margin:0; font-size:18px; font-weight:650; line-height:1.3; }
    blockquote { margin:0; padding:14px 16px; border-left:3px solid var(--amber); background:#151a20; color:#f3f5f7; font-size:16px; line-height:1.45; }
    .action-grid { display:grid; grid-template-columns:repeat(4, 1fr); gap:8px; }
    .action { min-height:44px; font-weight:650; }
    .action.selected { color:#101820; background:var(--focus); border-color:var(--focus); }
    .action.accurate.selected { color:#102016; background:var(--green); border-color:var(--green); }
    .action.problem.selected { color:#260c0b; background:var(--red); border-color:var(--red); }
    .conditional { display:grid; gap:10px; padding:12px; border:1px solid var(--line); background:#151a20; }
    .field-help { color:var(--muted); font-size:11px; line-height:1.4; }
    .decision-state { display:grid; gap:3px; padding:11px 12px; border:1px solid var(--line); background:#151a20; }
    .decision-state strong { font-size:12px; }
    .decision-state span { color:var(--muted); font-size:11px; }
    .decision-state.complete { border-color:#3e6b4b; }
    .decision-state.complete strong { color:var(--green); }
    .decision-state.needs-attention { border-color:#76562a; }
    .decision-state.needs-attention strong { color:#ffd58c; }
    .invalid { border-color:var(--red) !important; }
    dialog { width:min(96vw, 1500px); height:min(94vh, 1100px); padding:12px; border:1px solid #626d79; background:#101419; color:var(--ink); }
    dialog::backdrop { background:#05070ad9; }
    dialog img { width:100%; height:calc(100% - 44px); object-fit:contain; background:#252c35; }
    .dialog-head { display:flex; justify-content:space-between; align-items:center; height:36px; }
    .dialog-head button { padding:5px 10px; }
    .reviewer-dialog { width:min(680px, 94vw); height:auto; }
    .reviewer-dialog form { display:grid; gap:12px; }
    .reviewer-dialog textarea { min-height:110px; }
    .dialog-actions { display:flex; justify-content:flex-end; gap:8px; }
    .message { min-height:18px; color:#f2b6b2; font-size:12px; }
    @media (max-width:1100px) { .layout { grid-template-columns:1fr; } .catalog { border-right:0; } .inspector { position:relative; top:0; height:auto; } .grid { grid-template-columns:repeat(4, 1fr); } }
    @media (max-width:700px) { .topbar { flex-wrap:wrap; } .layout { display:block; } .grid { grid-template-columns:repeat(2, 1fr); } .row, .evidence-row { grid-template-columns:1fr; } .action-grid { grid-template-columns:repeat(2, 1fr); } .filmstrip { grid-template-columns:repeat(6, 1fr); } }
  </style>
</head>
<body>
  <header class="topbar">
    <div class="title"><h1>Development description review</h1><p>24 assets · all visible here · unscored proposal</p></div>
    <div class="progress"><div class="track"><div class="fill" id="fill"></div></div><div class="count" id="count">0 / 24</div></div>
    <div class="top-actions"><button id="reset">Reset</button><button class="primary" id="finish">Download final decision</button></div>
  </header>
  <main class="layout">
    <section class="catalog">
      <div class="catalog-head"><h2>All 24 assets</h2><a href="all-24-assets.png" target="_blank">Open single-sheet overview</a></div>
      <div class="panel warning" style="margin-bottom:12px">Collision guard: <strong>${data.collisionCompanionsExcluded}</strong> explicit <code>_Collision</code> companions were excluded before this pilot; <strong>${data.collisionCompanionsMisclassified}</strong> remain flagged upstream as wrongly renderable.</div>
      <div class="grid" id="grid"></div>
    </section>
    <aside class="inspector" id="inspector"></aside>
  </main>
  <dialog id="image-dialog"><div class="dialog-head"><span id="dialog-label"></span><button id="close-image">Close</button></div><img id="dialog-image" alt="Enlarged asset view"></dialog>
  <dialog class="reviewer-dialog" id="reviewer-dialog"><form method="dialog" id="reviewer-form">
    <h2 style="margin:0">Complete creator decision</h2>
    <p style="margin:0;color:var(--muted);font-size:13px">This seals descriptions only. It does not create queries, expected relevance, validator verdicts, or permission to execute qualification.</p>
    <div class="field"><label for="reviewer-id">Reviewer ID</label><input id="reviewer-id" maxlength="160" autocomplete="name"></div>
    <div class="field"><label for="reviewer-statement">Independent review statement</label><textarea id="reviewer-statement" maxlength="2048" placeholder="I independently reviewed all 24 assets against the visual and measured evidence…"></textarea></div>
    <div class="message" id="review-message"></div>
    <div class="dialog-actions"><button value="cancel">Cancel</button><button type="button" class="primary" id="download">Download decision JSON</button></div>
  </form></dialog>
  <script>
    const DATA = ${embedded};
    const STORAGE_KEY = "basalt-description-review:" + DATA.proposalHash;
    const generic = new Set(["3d asset","asset","attachment","component","environment object","model","modular piece","object","object aggregate","piece","stylized asset","stylized object","stylized object aggregate","thing"]);
    const original = structuredClone(DATA.decisionTemplate);
    let state = loadState();
    let selected = 0;
    let selectedView = "low_00";

    const grid = document.querySelector("#grid");
    const inspector = document.querySelector("#inspector");
    const imageDialog = document.querySelector("#image-dialog");
    const reviewerDialog = document.querySelector("#reviewer-dialog");

    renderGrid();
    renderInspector();
    renderProgress();

    document.querySelector("#reset").addEventListener("click", () => {
      if (!confirm("Discard every saved review decision for this exact proposal?")) return;
      localStorage.removeItem(STORAGE_KEY);
      state = structuredClone(DATA.decisionTemplate);
      selected = 0;
      selectedView = "low_00";
      renderGrid(); renderInspector(); renderProgress();
    });
    document.querySelector("#finish").addEventListener("click", () => {
      document.querySelector("#reviewer-id").value = state.reviewer.reviewerId ?? "";
      document.querySelector("#reviewer-statement").value = state.reviewerStatement ?? "";
      document.querySelector("#review-message").textContent = "";
      reviewerDialog.showModal();
    });
    document.querySelector("#download").addEventListener("click", downloadFinal);
    document.querySelector("#close-image").addEventListener("click", () => imageDialog.close());
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && imageDialog.open) imageDialog.close();
      if (event.target.matches("input, textarea, select") || reviewerDialog.open || imageDialog.open) return;
      if (event.key === "ArrowLeft") selectAsset(Math.max(0, selected - 1));
      if (event.key === "ArrowRight") selectAsset(Math.min(DATA.assets.length - 1, selected + 1));
    });

    function loadState() {
      try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
        if (saved?.proposalHash === DATA.proposalHash && saved?.assets?.length === 24) return saved;
      } catch {}
      return structuredClone(DATA.decisionTemplate);
    }

    function save() {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      renderProgress();
    }

    function renderGrid() {
      grid.innerHTML = DATA.assets.map((asset, index) => {
        const decision = state.assets[index];
        const view = asset.views.find((entry) => entry.viewId === "low_00") ?? asset.views[0];
        const reviewed = decision.reviewAction && !validateAsset(decision, index);
        return '<button class="card ' + (index === selected ? 'active ' : '') + (reviewed ? 'reviewed' : '') + '" data-index="' + index + '">' +
          '<img src="' + escapeHtml(view.path) + '" alt="Asset ' + (index + 1) + '">' +
          '<div class="card-body"><div class="eyebrow">' + String(index + 1).padStart(2, '0') + ' · ' + escapeHtml(actionLabel(decision.reviewAction)) + '</div>' +
          '<div class="card-desc">' + escapeHtml(asset.visibleDescription.text ?? 'No reviewable proposal') + '</div>' +
          '<div class="hash">' + asset.sourceContentHash.slice(0,12) + '</div></div></button>';
      }).join("");
      grid.querySelectorAll(".card").forEach((card) => card.addEventListener("click", () => selectAsset(Number(card.dataset.index))));
    }

    function selectAsset(index) {
      selected = index;
      selectedView = "low_00";
      renderGrid(); renderInspector();
      inspector.scrollTo({ top:0, behavior:"instant" });
    }

    function renderInspector() {
      const asset = DATA.assets[selected];
      const decision = state.assets[selected];
      const view = asset.views.find((entry) => entry.viewId === selectedView) ?? asset.views[0];
      selectedView = view.viewId;
      const metric = asset.metricSummary;
      const size = metric.sizeMeters;
      const filmstrip = asset.views.map((entry) =>
        '<button class="thumb ' + (entry.viewId === selectedView ? 'active' : '') + '" data-view="' + entry.viewId + '" title="' + entry.viewId + '"><img src="' + escapeHtml(entry.path) + '" alt="' + entry.viewId + '"></button>'
      ).join('');
      const defectBoxes = DATA.defectKinds.map((entry) =>
        '<label><input type="checkbox" data-defect="' + entry + '" ' + (decision.evidenceUsability.defectKinds.includes(entry) ? 'checked' : '') + '>' + escapeHtml(entry.replaceAll('_',' ')) + '</label>'
      ).join('');
      const selectedAction = decision.reviewAction;
      const editFields = selectedAction === 'edited'
        ? '<div class="field conditional"><label for="description-text">Correct visible description</label><textarea id="description-text" placeholder="Describe only what the images support">' + escapeHtml(decision.visibleDescription.text ?? '') + '</textarea><span class="field-help">Name visible form, materials, colors, and major parts. Do not infer hidden construction purpose.</span></div>'
        : '';
      const unsureFields = selectedAction === 'unsure'
        ? '<div class="conditional"><div class="field"><label for="description-text">Broad description you can support</label><textarea id="description-text" placeholder="Keep only the visually supported part">' + escapeHtml(decision.visibleDescription.text ?? '') + '</textarea></div><div class="field"><label for="description-reason">What remains uncertain?</label><textarea id="description-reason" placeholder="Explain the unresolved visible identity or boundary">' + escapeHtml(decision.visibleDescription.uncertaintyReason ?? '') + '</textarea></div></div>'
        : '';
      const imageProblemFields = selectedAction === 'image_problem'
        ? '<div class="conditional"><div><div class="group-label">Image problem</div><div class="defects">' + defectBoxes + '</div></div><div class="field"><label for="evidence-note">What prevents visual review?</label><textarea id="evidence-note" placeholder="Describe the rendering, framing, or missing-view problem">' + escapeHtml(decision.evidenceUsability.note ?? '') + '</textarea></div></div>'
        : '';
      const decisionError = selectedAction ? validateAsset(decision, selected) : null;
      inspector.innerHTML =
        '<div class="inspector-head"><div><div class="eyebrow">Asset ' + String(selected + 1).padStart(2,'0') + ' of 24 · description only</div><h2>' + escapeHtml(asset.visibleDescription.text ?? 'Unreviewable evidence') + '</h2><div class="subhash">' + asset.sourceContentHash + '</div></div><div class="nav"><button id="previous" ' + (selected === 0 ? 'disabled' : '') + '>←</button><button id="next" ' + (selected === DATA.assets.length - 1 ? 'disabled' : '') + '>→</button></div></div>' +
        '<div class="stage"><img id="main-image" src="' + escapeHtml(view.path) + '" alt="Selected ' + escapeHtml(view.viewId) + ' view"><span class="view-label">' + escapeHtml(view.viewId) + ' · click to enlarge</span></div>' +
        '<div class="filmstrip">' + filmstrip + '</div>' +
        '<div class="evidence-row"><section class="panel"><h3>Measured evidence</h3><dl class="metrics"><dt>Size X × Y × Z</dt><dd>' + meters(size.x) + ' × ' + meters(size.y) + ' × ' + meters(size.z) + ' m</dd><dt>Triangles</dt><dd>' + metric.triangleCount.toLocaleString() + '</dd><dt>Parts</dt><dd>' + metric.partCounts.renderable + ' render / ' + metric.partCounts.collision + ' collision</dd><dt>Primary contact</dt><dd>' + escapeHtml(metric.support.primaryContact.replaceAll('_',' ')) + '</dd><dt>Contact method</dt><dd>' + escapeHtml(metric.support.measurementMethod.replaceAll('_',' ')) + '</dd><dt>Planar area</dt><dd>' + metric.support.contactAreaSquareMeters.toFixed(4) + ' m²</dd></dl></section>' +
        '<section class="panel"><h3>Separated source hint</h3><details><summary>Reveal filename observation</summary><p>' + asset.filenameObservations.map(escapeHtml).join('<br>') + '</p><div class="authority">Authority: none</div></details><p style="color:var(--muted);font-size:11px;line-height:1.4">Use this only to notice possible mismatches. Do not let it override the images or measurements.</p></section></div>' +
        '<section class="panel form decision-panel"><h3>One independent decision</h3><p class="question">Does this description accurately describe what you can see?</p><blockquote>' + escapeHtml(asset.visibleDescription.text ?? 'No proposed description') + '</blockquote>' +
        '<div class="action-grid"><button class="action accurate ' + (selectedAction === 'accurate' ? 'selected' : '') + '" data-action="accurate">Accurate</button><button class="action ' + (selectedAction === 'edited' ? 'selected' : '') + '" data-action="edited">Edit description</button><button class="action ' + (selectedAction === 'unsure' ? 'selected' : '') + '" data-action="unsure">Unsure</button><button class="action problem ' + (selectedAction === 'image_problem' ? 'selected' : '') + '" data-action="image_problem">Image problem</button></div>' +
        editFields + unsureFields + imageProblemFields +
        '<div class="decision-state ' + (decisionError ? 'needs-attention' : selectedAction ? 'complete' : '') + '"><strong>' + (selectedAction ? escapeHtml(actionLabel(selectedAction)) : 'Choose one answer') + '</strong><span>' + escapeHtml(decisionError ?? (selectedAction ? 'Decision recorded.' : 'Review the views, then choose the closest answer.')) + '</span></div></section>';
      inspector.querySelector("#previous").addEventListener("click", () => selectAsset(selected - 1));
      inspector.querySelector("#next").addEventListener("click", () => selectAsset(selected + 1));
      inspector.querySelector("#main-image").addEventListener("click", () => showImage(asset, view));
      inspector.querySelectorAll(".thumb").forEach((thumb) => thumb.addEventListener("click", () => { selectedView = thumb.dataset.view; renderInspector(); }));
      bindDecisionFields(decision);
    }

    function bindDecisionFields(decision) {
      inspector.querySelectorAll("[data-action]").forEach((button) => button.addEventListener("click", () => selectReviewAction(decision, button.dataset.action)));
      inspector.querySelectorAll("[data-defect]").forEach((checkbox) => checkbox.addEventListener("change", () => {
        decision.evidenceUsability.defectKinds = [...inspector.querySelectorAll("[data-defect]:checked")].map((entry) => entry.dataset.defect).sort();
        changed(decision);
      }));
      bindOptional("#evidence-note", "input", (value) => {
        const note = value.trim() || null;
        decision.evidenceUsability.note = note;
        decision.visibleDescription.uncertaintyReason = note;
      });
      bindOptional("#description-text", "input", (value) => { decision.visibleDescription.text = value.trim() || null; });
      bindOptional("#description-reason", "input", (value) => { decision.visibleDescription.uncertaintyReason = value.trim() || null; });
    }

    function bindOptional(selector, event, update) {
      inspector.querySelector(selector)?.addEventListener(event, (inputEvent) => {
        update(inputEvent.target.value);
        changed(state.assets[selected]);
      });
    }

    function selectReviewAction(decision, action) {
      if (decision.reviewAction !== action) {
        const baseline = original.assets[selected];
        decision.reviewAction = action;
        if (action === "accurate") {
          decision.evidenceUsability = structuredClone(baseline.evidenceUsability);
          decision.visibleDescription = structuredClone(baseline.visibleDescription);
        }
        if (action === "edited") {
          decision.evidenceUsability = { status:"usable", defectKinds:[], note:null };
          decision.visibleDescription = { status:"concrete", text:baseline.visibleDescription.text, uncertaintyReason:null };
        }
        if (action === "unsure") {
          decision.evidenceUsability = { status:"usable", defectKinds:[], note:null };
          decision.visibleDescription = { status:"uncertain", text:baseline.visibleDescription.text, uncertaintyReason:baseline.visibleDescription.status === "uncertain" ? baseline.visibleDescription.uncertaintyReason : null };
        }
        if (action === "image_problem") {
          decision.evidenceUsability = { status:"defective", defectKinds:[], note:null };
          decision.visibleDescription = { status:"unreviewable", text:null, uncertaintyReason:null };
        }
      }
      save(); renderGrid(); renderInspector();
    }

    function changed() {
      save(); renderGrid(); refreshDecisionState();
    }

    function refreshDecisionState() {
      const decision = state.assets[selected];
      const error = validateAsset(decision, selected);
      const element = inspector.querySelector(".decision-state");
      if (!element) return;
      element.className = "decision-state " + (error ? "needs-attention" : "complete");
      element.querySelector("strong").textContent = actionLabel(decision.reviewAction);
      element.querySelector("span").textContent = error ?? "Decision recorded.";
    }

    function validateAsset(value, index) {
      if (!value.reviewAction) return "Choose one answer.";
      const usability = value.evidenceUsability;
      if (usability.status === "usable" && (usability.defectKinds.length || usability.note)) return "Usable evidence cannot carry defects or a defect note.";
      if (usability.status === "defective" && (!usability.defectKinds.length || (usability.note?.length ?? 0) < 16)) return "Defective evidence needs at least one typed defect and a note of 16+ characters.";
      const description = value.visibleDescription;
      if (usability.status === "defective" && description.status !== "unreviewable") return "Defective evidence must leave the description unreviewable.";
      if (usability.status === "usable" && description.status === "unreviewable") return "Usable evidence needs a concrete or explicitly uncertain description.";
      if (description.status === "concrete" && (!validText(description.text) || description.uncertaintyReason)) return "Concrete descriptions need specific text and no uncertainty reason.";
      if (description.status === "uncertain" && (!validText(description.text) || (description.uncertaintyReason?.length ?? 0) < 16)) return "Uncertain descriptions need broad specific text and a reason of 16+ characters.";
      if (description.status === "unreviewable" && (description.text || (description.uncertaintyReason?.length ?? 0) < 16)) return "Unreviewable evidence needs no description and a refusal reason of 16+ characters.";
      const baseline = original.assets[index];
      const unchanged = JSON.stringify(value.evidenceUsability) === JSON.stringify(baseline.evidenceUsability) && JSON.stringify(value.visibleDescription) === JSON.stringify(baseline.visibleDescription);
      if (value.reviewAction === "accurate" && !unchanged) return "Accurate must preserve the proposed description exactly.";
      if (value.reviewAction === "edited" && (description.status !== "concrete" || unchanged)) return "Edit description must save a changed concrete description.";
      if (value.reviewAction === "unsure" && (usability.status !== "usable" || description.status !== "uncertain")) return "Unsure must preserve usable evidence and record a broad description with uncertainty.";
      if (value.reviewAction === "image_problem" && (usability.status !== "defective" || description.status !== "unreviewable")) return "Image problem must record defective evidence without asserting a description.";
      return null;
    }

    function validText(value) { return typeof value === "string" && value.trim().length >= 3 && !generic.has(value.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim()); }

    function renderProgress() {
      const reviewed = state.assets.filter((entry, index) => entry.reviewAction && !validateAsset(entry, index)).length;
      document.querySelector("#count").textContent = reviewed + " / 24";
      document.querySelector("#fill").style.width = (reviewed / 24 * 100) + "%";
    }

    function downloadFinal() {
      const reviewerId = document.querySelector("#reviewer-id").value.trim();
      const statement = document.querySelector("#reviewer-statement").value.trim();
      const message = document.querySelector("#review-message");
      const missing = state.assets.findIndex((entry, index) => validateAsset(entry, index));
      if (missing >= 0) { message.textContent = "Asset " + (missing + 1) + " is incomplete or invalid."; return; }
      if (!reviewerId) { message.textContent = "Reviewer ID is required."; return; }
      if (statement.length < 32) { message.textContent = "The independent review statement must be at least 32 characters."; return; }
      state.reviewer.reviewerId = reviewerId;
      state.reviewerStatement = statement;
      state.reviewedAt = new Date().toISOString();
      state.coverage = "complete";
      save();
      const blob = new Blob([JSON.stringify(state, null, 2) + "\\n"], { type:"application/json" });
      const anchor = document.createElement("a");
      anchor.href = URL.createObjectURL(blob);
      anchor.download = "catalog-description-decision.json";
      anchor.click();
      URL.revokeObjectURL(anchor.href);
      reviewerDialog.close();
    }

    function showImage(asset, view) {
      document.querySelector("#dialog-image").src = view.path;
      document.querySelector("#dialog-label").textContent = "Asset " + (selected + 1) + " · " + view.viewId + " · " + asset.sourceContentHash.slice(0,12);
      imageDialog.showModal();
    }

    function actionLabel(value) {
      return ({ accurate:"accurate", edited:"description edited", unsure:"unsure", image_problem:"image problem" })[value] ?? "not reviewed";
    }
    function meters(value) { return Math.abs(value) >= 10 ? value.toFixed(2) : value.toFixed(3); }
    function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (character) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[character])); }
  </script>
</body>
</html>\n`;
}
