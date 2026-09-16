import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import {
  CATALOG_QUALIFICATION_DEVELOPMENT_CANDIDATE_POOL_SCHEMA,
  CATALOG_QUALIFICATION_DEVELOPMENT_QUERY_SET_SCHEMA,
  CATALOG_QUALIFICATION_DEVELOPMENT_RELEVANCE_DECISION_SCHEMA,
  CATALOG_QUALIFICATION_DEVELOPMENT_VALIDATOR_CASE_SET_SCHEMA,
  CATALOG_VISUAL_REVIEW_INDEX_SCHEMA,
  requireCatalogQualificationDevelopmentValidatorCaseSet,
} from "../packages/catalog-authoring/dist/index.js";
import { CATALOG_MEASUREMENT_SET_SCHEMA } from "../packages/catalog-model/dist/index.js";

const root = resolve(".");
const outputRoot = resolve(root, ".basalt/catalog/qualification/development/validator-review");
const readJson = async (path) => JSON.parse(await readFile(resolve(root, path), "utf8"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const queries = CATALOG_QUALIFICATION_DEVELOPMENT_QUERY_SET_SCHEMA.parse(
  await readJson("registry/qualifications/catalog-development-query-set.json"),
);
const pool = CATALOG_QUALIFICATION_DEVELOPMENT_CANDIDATE_POOL_SCHEMA.parse(
  await readJson(".basalt/catalog/qualification/development/candidate-pool.json"),
);
const relevanceDecision = CATALOG_QUALIFICATION_DEVELOPMENT_RELEVANCE_DECISION_SCHEMA.parse(
  await readJson("registry/qualifications/catalog-development-relevance-decision.json"),
);
const caseSet = CATALOG_QUALIFICATION_DEVELOPMENT_VALIDATOR_CASE_SET_SCHEMA.parse(
  await readJson("registry/qualifications/catalog-development-validator-case-set.json"),
);
requireCatalogQualificationDevelopmentValidatorCaseSet({
  queries,
  pool,
  relevanceDecision,
  caseSet,
});
const measurements = CATALOG_MEASUREMENT_SET_SCHEMA.parse(
  await readJson(".basalt/catalog/measurements.json"),
);
const renders = CATALOG_VISUAL_REVIEW_INDEX_SCHEMA.parse(
  await readJson(".basalt/catalog/review/index.json"),
);
if (
  measurements.hash !== caseSet.measurementSetHash ||
  renders.hash !== caseSet.visualReviewIndexHash
)
  throw new Error("Validator review evidence has changed since case authoring");

await mkdir(outputRoot, { recursive: true });
const renderBySource = new Map(renders.items.map((entry) => [entry.sourceContentHash, entry]));
const cases = [];
for (const [index, validationCase] of caseSet.cases.entries()) {
  const render = renderBySource.get(validationCase.sourceContentHash);
  if (!render || render.evidence.hash !== validationCase.renderEvidenceHash)
    throw new Error(`Validator review lacks exact render evidence: ${validationCase.caseId}`);
  const artifactsByView = new Map(render.viewArtifacts.map((entry) => [entry.viewId, entry]));
  const evidenceByView = new Map(render.evidence.views.map((entry) => [entry.viewId, entry]));
  const views = [];
  for (const selected of validationCase.validationRequest.candidate.selectedRgbViews) {
    const artifact = artifactsByView.get(selected.viewId);
    const evidence = evidenceByView.get(selected.viewId);
    if (!artifact || !evidence || selected.rgbHash !== evidence.rgbHash)
      throw new Error(
        `Validator review has stale view ${validationCase.caseId}/${selected.viewId}`,
      );
    const bytes = await readFile(resolve(root, artifact.rgbRelativePath));
    if (sha256(bytes) !== selected.rgbHash)
      throw new Error(`Validator review RGB changed: ${validationCase.caseId}/${selected.viewId}`);
    views.push({
      viewId: selected.viewId,
      path: webPath(relative(outputRoot, resolve(root, artifact.rgbRelativePath))),
      absolutePath: resolve(root, artifact.rgbRelativePath),
    });
  }
  const primary = views.find((entry) => entry.viewId === "low_00") ?? views[0];
  cases.push({
    index,
    caseId: validationCase.caseId,
    validationRequestHash: validationCase.validationRequest.hash,
    requestText: validationCase.validationRequest.query.text,
    styleTerms: validationCase.validationRequest.query.styleTerms,
    constraints: validationCase.validationRequest.query.constraints,
    sourceContentHash: validationCase.sourceContentHash,
    metricSummary: validationCase.validationRequest.candidate.metricSummary,
    primaryViewPath: primary.path,
    primaryViewAbsolutePath: primary.absolutePath,
    views,
    proposedVerdict: validationCase.proposedVerdict,
  });
}

const decisionTemplate = {
  kind: "CatalogQualificationDevelopmentValidatorDecision",
  caseSetHash: caseSet.hash,
  relevanceDecisionHash: relevanceDecision.hash,
  reviewer: { authority: "creator", reviewerId: null },
  reviewMethod: "independent_validator_verdict_review",
  reviewerStatement: null,
  reviewedAt: null,
  coverage: null,
  cases: caseSet.cases.map((entry) => ({
    caseId: entry.caseId,
    validationRequestHash: entry.validationRequest.hash,
    reviewAction: null,
    expectedVerdict: null,
    note: null,
  })),
};
const reviewData = {
  caseSetHash: caseSet.hash,
  relevanceDecisionHash: relevanceDecision.hash,
  decisionTemplate,
  cases: cases.map((entry) => {
    const publicEntry = { ...entry };
    delete publicEntry.primaryViewAbsolutePath;
    return publicEntry;
  }),
};

await writeFile(
  resolve(outputRoot, "decision-template.json"),
  `${JSON.stringify(decisionTemplate, null, 2)}\n`,
);
await writeFile(resolve(outputRoot, "index.html"), html(reviewData));
await writeFile(
  resolve(outputRoot, "README.md"),
  `# Development validator-verdict review\n\nOpen \`index.html\`. All ${cases.length} cases are visible on one page. Each case also exposes the exact twelve RGB views and decimal measurements supplied to the validator.\n\nChoose the verdict that a requirement validator should return from this evidence: \`match\`, \`mismatch\`, or \`uncertain\`. Reject only a defective case. No answer is preselected, and the derived proposal is withheld until after the decision.\n\nThis review does not execute a model, approve a validator, authorize qualification, or authorize corpus work.\n`,
);
await renderOverview(cases, resolve(outputRoot, "overview.png"));

process.stdout.write(
  `${JSON.stringify(
    {
      status: "ready_for_independent_validator_verdict_review",
      caseSetHash: caseSet.hash,
      cases: cases.length,
      page: resolve(outputRoot, "index.html"),
      overview: resolve(outputRoot, "overview.png"),
      decisionTemplate: resolve(outputRoot, "decision-template.json"),
      qualificationExecutionAuthorized: false,
    },
    null,
    2,
  )}\n`,
);

function webPath(path) {
  return path.split("\\").join("/");
}

async function renderOverview(entries, output) {
  const columns = 4;
  const tileWidth = 500;
  const tileHeight = 330;
  const headerHeight = 110;
  const rows = Math.ceil(entries.length / columns);
  const canvas = createCanvas(columns * tileWidth, headerHeight + rows * tileHeight);
  const context = canvas.getContext("2d");
  context.fillStyle = "#10151d";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#f1f5f9";
  context.font = "700 30px sans-serif";
  context.fillText("VALIDATOR VERDICT REVIEW — ALL 44 CASES", 24, 44);
  context.fillStyle = "#95a3b8";
  context.font = "18px sans-serif";
  context.fillText(
    "No answers preselected · open index.html for all twelve views and measurements",
    24,
    78,
  );
  for (const entry of entries) {
    const column = entry.index % columns;
    const row = Math.floor(entry.index / columns);
    const x = column * tileWidth;
    const y = headerHeight + row * tileHeight;
    context.fillStyle = entry.index % 2 === 0 ? "#1a222e" : "#1d2633";
    context.fillRect(x + 6, y + 6, tileWidth - 12, tileHeight - 12);
    const image = await loadImage(entry.primaryViewAbsolutePath);
    const imageBox = { x: x + 18, y: y + 18, width: tileWidth - 36, height: 218 };
    const scale = Math.min(imageBox.width / image.width, imageBox.height / image.height);
    const width = image.width * scale;
    const height = image.height * scale;
    context.drawImage(
      image,
      imageBox.x + (imageBox.width - width) / 2,
      imageBox.y + (imageBox.height - height) / 2,
      width,
      height,
    );
    context.fillStyle = "#f6b84a";
    context.font = "700 17px monospace";
    context.fillText(String(entry.index + 1).padStart(2, "0"), x + 18, y + 258);
    context.fillStyle = "#e8edf4";
    context.font = "16px sans-serif";
    drawWrappedText(context, entry.requestText, x + 62, y + 258, tileWidth - 82, 20, 2);
    context.fillStyle = "#8fa0b6";
    context.font = "13px monospace";
    context.fillText(entry.sourceContentHash.slice(0, 12), x + 18, y + 314);
  }
  await writeFile(output, canvas.toBuffer("image/png"));
}

function drawWrappedText(context, text, x, y, maxWidth, lineHeight, maxLines) {
  const words = text.split(/\s+/u);
  let line = "";
  let lineIndex = 0;
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (context.measureText(candidate).width <= maxWidth) {
      line = candidate;
      continue;
    }
    context.fillText(line, x, y + lineIndex * lineHeight);
    lineIndex += 1;
    if (lineIndex >= maxLines) return;
    line = word;
  }
  if (lineIndex < maxLines) context.fillText(line, x, y + lineIndex * lineHeight);
}

function html(data) {
  const serialized = JSON.stringify(data).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Basalt — validator verdict review</title>
  <style>
    :root { color-scheme:dark; --bg:#0e131a; --panel:#161d27; --panel2:#1c2531; --line:#2e3a4a; --text:#edf2f7; --muted:#9aa8ba; --accent:#f4b649; --match:#69c68b; --mismatch:#ec7777; --uncertain:#e0b75a; --danger:#dc5f6d; }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--bg); color:var(--text); font:14px/1.45 Inter,ui-sans-serif,system-ui,sans-serif; }
    button,input,textarea,select { font:inherit; }
    button { color:var(--text); background:#222c39; border:1px solid var(--line); border-radius:8px; padding:8px 11px; cursor:pointer; }
    button:hover { border-color:#617089; }
    .top { position:sticky; top:0; z-index:5; display:flex; gap:18px; align-items:center; padding:14px 20px; background:rgba(14,19,26,.96); border-bottom:1px solid var(--line); backdrop-filter:blur(12px); }
    .title { min-width:285px; }
    .title h1 { margin:0; font-size:18px; }
    .title p { margin:2px 0 0; color:var(--muted); font-size:12px; }
    .progress { flex:1; height:8px; overflow:hidden; background:#242d39; border-radius:999px; }
    .progress span { display:block; width:0; height:100%; background:linear-gradient(90deg,#d79531,#ffd277); }
    .count { color:var(--muted); white-space:nowrap; }
    .primary { background:var(--accent); border-color:var(--accent); color:#201506; font-weight:750; }
    .intro { max-width:1480px; margin:18px auto 0; padding:0 20px; display:grid; grid-template-columns:1fr auto; gap:14px; align-items:start; }
    .intro .copy { background:#141b24; border:1px solid var(--line); border-radius:12px; padding:14px 16px; }
    .intro h2 { margin:0 0 6px; font-size:16px; }
    .intro p { margin:4px 0; color:var(--muted); }
    .legend { display:flex; flex-wrap:wrap; gap:8px; }
    .legend span { padding:6px 9px; border-radius:999px; background:#202936; border:1px solid var(--line); color:#c6d0dc; font-size:12px; }
    .grid { max-width:1480px; margin:16px auto 70px; padding:0 20px; display:grid; grid-template-columns:repeat(auto-fill,minmax(310px,1fr)); gap:14px; }
    .card { min-width:0; background:var(--panel); border:1px solid var(--line); border-radius:12px; overflow:hidden; }
    .card[data-state="complete"] { border-color:#3e6f55; }
    .card[data-state="rejected"] { border-color:#7e3e48; }
    .image { position:relative; display:block; width:100%; padding:0; border:0; border-radius:0; background:#252e3a; }
    .image img { display:block; width:100%; height:220px; object-fit:contain; }
    .number { position:absolute; top:10px; left:10px; padding:4px 7px; border-radius:6px; background:rgba(8,11,16,.88); color:var(--accent); font:700 13px ui-monospace,monospace; }
    .body { padding:13px; }
    .request { margin:0 0 9px; min-height:42px; font-weight:700; font-size:15px; }
    .metrics { color:var(--muted); font:12px/1.5 ui-monospace,monospace; }
    .question { margin:12px 0 7px; color:#dbe3ed; font-weight:650; }
    .choices { display:grid; grid-template-columns:repeat(3,1fr); gap:6px; }
    .choices button { padding:8px 4px; }
    .choices .match.selected { color:#07170d; background:var(--match); border-color:var(--match); }
    .choices .mismatch.selected { color:#210809; background:var(--mismatch); border-color:var(--mismatch); }
    .choices .uncertain.selected { color:#1f1604; background:var(--uncertain); border-color:var(--uncertain); }
    .reject { width:100%; margin-top:7px; color:#e8a4ab; background:transparent; }
    .reject.selected { background:#6b303a; color:white; border-color:#9b4653; }
    textarea { width:100%; min-height:74px; margin-top:8px; padding:9px; resize:vertical; color:var(--text); background:#10161e; border:1px solid var(--line); border-radius:8px; }
    .status { margin-top:8px; color:var(--muted); font-size:12px; }
    .status.problem { color:#e4a6aa; }
    dialog { color:var(--text); background:#141b24; border:1px solid var(--line); border-radius:12px; box-shadow:0 30px 90px #000a; }
    dialog::backdrop { background:#06090dcc; }
    .evidence { width:min(1240px,96vw); height:min(900px,94vh); padding:0; overflow:hidden; }
    .evidence-head { display:flex; justify-content:space-between; align-items:center; padding:12px 14px; border-bottom:1px solid var(--line); }
    .evidence-main { display:grid; grid-template-columns:minmax(0,1fr) 320px; height:calc(100% - 55px); }
    .viewer { min-width:0; display:grid; grid-template-rows:minmax(0,1fr) 112px; background:#232c37; }
    .viewer>img { width:100%; height:100%; object-fit:contain; min-height:0; }
    .film { display:flex; gap:7px; overflow-x:auto; padding:8px; border-top:1px solid var(--line); background:#111720; }
    .film button { flex:0 0 104px; padding:3px; }
    .film button.active { border-color:var(--accent); }
    .film img { display:block; width:96px; height:82px; object-fit:contain; }
    .side { padding:18px; overflow:auto; }
    .side h3 { margin-top:0; }
    .side dl { display:grid; grid-template-columns:1fr auto; gap:8px 12px; }
    .side dt { color:var(--muted); }
    .side dd { margin:0; text-align:right; }
    .complete-dialog { width:min(680px,94vw); }
    .complete-dialog form { display:grid; gap:12px; }
    .field { display:grid; gap:5px; }
    input,select { width:100%; padding:9px; color:var(--text); background:#10161e; border:1px solid var(--line); border-radius:8px; }
    .actions { display:flex; justify-content:flex-end; gap:8px; }
    .message { min-height:20px; color:#e99aa2; }
    @media (max-width:760px) { .top { flex-wrap:wrap; } .title { min-width:100%; } .intro { grid-template-columns:1fr; } .evidence-main { grid-template-columns:1fr; } .side { display:none; } }
  </style>
</head>
<body>
  <header class="top"><div class="title"><h1>Development validator-verdict review</h1><p>44 cases · exact visual and measured evidence · no preselected answers</p></div><div class="progress"><span id="fill"></span></div><div class="count" id="count">0 / 44</div><button class="primary" id="complete">Download final decision</button></header>
  <section class="intro"><div class="copy"><h2>What should the validator return from this evidence?</h2><p><strong>Match</strong> only when identity, visible constraints, and measured bounds agree. Use <strong>Mismatch</strong> for a clear contradiction. Use <strong>Uncertain</strong> when a required property—such as working hinges, electrical behavior, weatherproofing, or structural capacity—cannot be established here.</p><p>The proposal derived from the earlier relevance ledger is intentionally hidden. Every case requires a fresh click.</p></div><div class="legend"><span>all 15 reviewed matches</span><span>all 9 boundary cases</span><span>20 deterministic hard negatives</span></div></section>
  <main class="grid" id="grid"></main>
  <dialog class="evidence" id="evidence"><div class="evidence-head"><strong id="evidence-label"></strong><button id="close-evidence">Close</button></div><div class="evidence-main"><div class="viewer"><img id="evidence-image"><div class="film" id="film"></div></div><aside class="side" id="evidence-side"></aside></div></dialog>
  <dialog class="complete-dialog" id="complete-dialog"><form method="dialog"><h2 style="margin:0">Complete validator decision</h2><p style="margin:0;color:var(--muted)">This records expected validator verdicts only. It does not approve a model or authorize qualification execution.</p><div class="field"><label for="reviewer-authority">Reviewer authority</label><select id="reviewer-authority"><option value="creator">Human creator</option><option value="delegated_ai">Delegated AI reviewer</option></select></div><div class="field"><label for="reviewer-id">Reviewer ID</label><input id="reviewer-id" maxlength="160"></div><div class="field"><label for="reviewer-statement">Review statement</label><textarea id="reviewer-statement" maxlength="2048" placeholder="I independently reviewed all 44 validator cases against their exact visual and measured evidence…"></textarea></div><div class="message" id="message"></div><div class="actions"><button value="cancel">Cancel</button><button type="button" class="primary" id="download">Download decision JSON</button></div></form></dialog>
  <script>
    const DATA = ${serialized};
    const STORAGE_KEY = "basalt-validator-review:" + DATA.caseSetHash;
    let state = loadState();
    let openIndex = 0;
    let selectedView = "low_00";
    const grid = document.querySelector("#grid");
    const evidence = document.querySelector("#evidence");
    const completeDialog = document.querySelector("#complete-dialog");
    render();
    document.querySelector("#close-evidence").addEventListener("click", () => evidence.close());
    document.querySelector("#complete").addEventListener("click", beginComplete);
    document.querySelector("#download").addEventListener("click", download);

    function loadState() {
      try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
        if (saved?.caseSetHash === DATA.caseSetHash && saved?.cases?.length === DATA.cases.length) return saved;
      } catch {}
      return structuredClone(DATA.decisionTemplate);
    }
    function save() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); renderProgress(); }
    function render() {
      grid.innerHTML = DATA.cases.map((entry,index) => card(entry,index)).join("");
      grid.querySelectorAll("[data-choice]").forEach((button) => button.addEventListener("click", choose));
      grid.querySelectorAll("[data-reject]").forEach((button) => button.addEventListener("click", reject));
      grid.querySelectorAll("[data-note]").forEach((input) => input.addEventListener("input", note));
      grid.querySelectorAll("[data-evidence]").forEach((button) => button.addEventListener("click", () => showEvidence(Number(button.dataset.evidence))));
      renderProgress();
    }
    function card(entry,index) {
      const decision = state.cases[index];
      const metric = entry.metricSummary;
      const verdict = decision.expectedVerdict;
      const rejected = decision.reviewAction === "rejected";
      const needsNote = decision.reviewAction === "revised" || rejected;
      const error = validate(index);
      const stateName = rejected ? "rejected" : error ? "" : "complete";
      return '<article class="card" data-state="' + stateName + '"><button class="image" data-evidence="' + index + '"><img src="' + escapeHtml(entry.primaryViewPath) + '" alt="Candidate evidence"><span class="number">' + String(index+1).padStart(2,"0") + '</span></button><div class="body"><p class="request">' + escapeHtml(entry.requestText) + '</p><div class="metrics">' + meters(metric.sizeMeters.x) + ' × ' + meters(metric.sizeMeters.y) + ' × ' + meters(metric.sizeMeters.z) + ' m · ' + metric.triangleCount.toLocaleString() + ' triangles<br>' + escapeHtml(metric.support.measurementMethod.replaceAll("_"," ")) + ' · ' + entry.sourceContentHash.slice(0,12) + '</div><p class="question">Expected validator verdict</p><div class="choices"><button class="match ' + (verdict === "match" && !rejected ? "selected" : "") + '" data-choice="match" data-index="' + index + '">Match</button><button class="mismatch ' + (verdict === "mismatch" && !rejected ? "selected" : "") + '" data-choice="mismatch" data-index="' + index + '">Mismatch</button><button class="uncertain ' + (verdict === "uncertain" && !rejected ? "selected" : "") + '" data-choice="uncertain" data-index="' + index + '">Uncertain</button></div><button class="reject ' + (rejected ? "selected" : "") + '" data-reject="' + index + '">Reject defective case</button>' + (needsNote ? '<textarea data-note="' + index + '" placeholder="Explain the revision or defect (16+ characters)">' + escapeHtml(decision.note ?? "") + '</textarea>' : '') + '<div class="status ' + (error ? "problem" : "") + '">' + escapeHtml(error ?? (decision.reviewAction === "confirmed" ? "Reviewed" : decision.reviewAction === "revised" ? "Reviewed with corrected verdict" : "Rejected for reauthoring")) + '</div></div></article>';
    }
    function choose(event) {
      const index = Number(event.currentTarget.dataset.index);
      const verdict = event.currentTarget.dataset.choice;
      const proposed = DATA.cases[index].proposedVerdict;
      state.cases[index].expectedVerdict = verdict;
      state.cases[index].reviewAction = verdict === proposed ? "confirmed" : "revised";
      if (verdict === proposed) state.cases[index].note = null;
      save(); render();
    }
    function reject(event) {
      const index = Number(event.currentTarget.dataset.reject);
      const decision = state.cases[index];
      if (decision.reviewAction === "rejected") {
        decision.reviewAction = null; decision.expectedVerdict = null; decision.note = null;
      } else {
        decision.reviewAction = "rejected"; decision.expectedVerdict = null; decision.note = null;
      }
      save(); render();
    }
    function note(event) { const index = Number(event.currentTarget.dataset.note); state.cases[index].note = event.currentTarget.value.trim() || null; save(); }
    function validate(index) {
      const decision = state.cases[index];
      if (!decision.reviewAction) return "Choose a verdict.";
      if (decision.reviewAction === "confirmed" && !decision.expectedVerdict) return "Choose a verdict.";
      if ((decision.reviewAction === "revised" || decision.reviewAction === "rejected") && (decision.note?.length ?? 0) < 16) return "Explain this change in at least 16 characters.";
      return null;
    }
    function renderProgress() {
      const complete = state.cases.filter((_entry,index) => !validate(index)).length;
      document.querySelector("#count").textContent = complete + " / " + DATA.cases.length;
      document.querySelector("#fill").style.width = (complete / DATA.cases.length * 100) + "%";
    }
    function beginComplete() {
      const incomplete = state.cases.findIndex((_entry,index) => validate(index));
      if (incomplete >= 0) { document.querySelectorAll(".card")[incomplete].scrollIntoView({behavior:"smooth",block:"center"}); return; }
      document.querySelector("#reviewer-authority").value = state.reviewer.authority ?? "creator";
      document.querySelector("#reviewer-id").value = state.reviewer.reviewerId ?? "";
      document.querySelector("#reviewer-statement").value = state.reviewerStatement ?? "";
      document.querySelector("#message").textContent = "";
      completeDialog.showModal();
    }
    function download() {
      const reviewerId = document.querySelector("#reviewer-id").value.trim();
      const statement = document.querySelector("#reviewer-statement").value.trim();
      const message = document.querySelector("#message");
      if (!reviewerId) { message.textContent = "Reviewer ID is required."; return; }
      if (statement.length < 32) { message.textContent = "The review statement must be at least 32 characters."; return; }
      const incomplete = state.cases.findIndex((_entry,index) => validate(index));
      if (incomplete >= 0) { message.textContent = "Case " + (incomplete+1) + " is incomplete."; return; }
      state.reviewer.authority = document.querySelector("#reviewer-authority").value;
      state.reviewer.reviewerId = reviewerId;
      state.reviewerStatement = statement;
      state.reviewedAt = new Date().toISOString();
      state.coverage = "complete";
      save();
      const blob = new Blob([JSON.stringify(state,null,2) + "\\n"],{type:"application/json"});
      const anchor = document.createElement("a"); anchor.href = URL.createObjectURL(blob); anchor.download = "catalog-development-validator-decision.json"; anchor.click(); URL.revokeObjectURL(anchor.href); completeDialog.close();
    }
    function showEvidence(index) { openIndex = index; selectedView = DATA.cases[index].views.find((entry) => entry.viewId === "low_00")?.viewId ?? DATA.cases[index].views[0].viewId; renderEvidence(); evidence.showModal(); }
    function renderEvidence() {
      const entry = DATA.cases[openIndex];
      const view = entry.views.find((candidate) => candidate.viewId === selectedView) ?? entry.views[0];
      const metric = entry.metricSummary;
      document.querySelector("#evidence-label").textContent = "Case " + String(openIndex+1).padStart(2,"0") + " · " + view.viewId;
      document.querySelector("#evidence-image").src = view.path;
      document.querySelector("#film").innerHTML = entry.views.map((candidate) => '<button class="' + (candidate.viewId === view.viewId ? "active" : "") + '" data-view="' + candidate.viewId + '"><img src="' + escapeHtml(candidate.path) + '" alt="' + candidate.viewId + '"></button>').join("");
      document.querySelector("#film").querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => { selectedView = button.dataset.view; renderEvidence(); }));
      document.querySelector("#evidence-side").innerHTML = '<h3>' + escapeHtml(entry.requestText) + '</h3><dl><dt>Size X × Y × Z</dt><dd>' + meters(metric.sizeMeters.x) + ' × ' + meters(metric.sizeMeters.y) + ' × ' + meters(metric.sizeMeters.z) + ' m</dd><dt>Triangles</dt><dd>' + metric.triangleCount.toLocaleString() + '</dd><dt>Renderable parts</dt><dd>' + metric.partCounts.renderable + '</dd><dt>Collision parts</dt><dd>' + metric.partCounts.collision + '</dd><dt>Primary contact</dt><dd>' + escapeHtml(metric.support.primaryContact.replaceAll("_"," ")) + '</dd><dt>Contact method</dt><dd>' + escapeHtml(metric.support.measurementMethod.replaceAll("_"," ")) + '</dd><dt>Planar area</dt><dd>' + metric.support.contactAreaSquareMeters.toFixed(4) + ' m²</dd></dl><p style="color:var(--muted)">Judge only the exact visual and measured evidence shown. Do not infer hidden behavior, filenames, pack identity, or construction semantics.</p>';
    }
    function meters(value) { return Math.abs(value) >= 10 ? value.toFixed(2) : value.toFixed(3); }
    function escapeHtml(value) { return String(value).replace(/[&<>"']/g,(character) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[character])); }
  </script>
</body>
</html>\n`;
}
