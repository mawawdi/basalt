import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import {
  CATALOG_QUALIFICATION_FIXTURE_SCHEMA,
  CATALOG_VISUAL_REVIEW_INDEX_SCHEMA,
  sealCatalogQualificationReviewPacket,
} from "../packages/catalog-authoring/dist/index.js";

const root = resolve(".");
const outputRoot = resolve(root, ".basalt/catalog/qualification/review");
const packetPath = resolve(root, "registry/qualifications/catalog-adjudication-review-packet.json");
const readJson = async (path) => JSON.parse(await readFile(resolve(root, path), "utf8"));
const compare = (left, right) => left.localeCompare(right);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const splits = ["development", "holdout", "model_selection"];

const fixture = CATALOG_QUALIFICATION_FIXTURE_SCHEMA.parse(
  await readJson("registry/catalog-qualification.json"),
);
if (fixture.adjudication.status !== "pending_creator_review")
  throw new Error("Review material must be generated from the pending proposal fixture");
const renderIndex = CATALOG_VISUAL_REVIEW_INDEX_SCHEMA.parse(
  await readJson(".basalt/catalog/review/index.json"),
);
const hints = await readJson(".basalt/catalog/metadata/source-name-hints.json");
if (renderIndex.hash !== fixture.visualReviewIndexHash)
  throw new Error("Qualification proposal binds another visual review index");

const renderBySource = new Map(renderIndex.items.map((item) => [item.sourceContentHash, item]));
const hintBySource = new Map(hints.items.map((item) => [item.sourceContentHash, item]));
const cohortAssets = fixture.assets
  .filter((asset) => asset.population === "cohort")
  .sort((left, right) => compare(left.sourceContentHash, right.sourceContentHash));
const visualBySource = new Map();
const imageBySource = new Map();

await mkdir(outputRoot, { recursive: true });
await mkdir(dirname(packetPath), { recursive: true });

for (const asset of cohortAssets) {
  const render = renderBySource.get(asset.sourceContentHash);
  if (!render) throw new Error(`Missing review evidence for ${asset.sourceContentHash}`);
  const view = render.viewArtifacts.find((candidate) => candidate.viewId === "low_00");
  const viewEvidence = render.evidence.views.find((candidate) => candidate.viewId === "low_00");
  if (!view || !viewEvidence)
    throw new Error(`Missing low_00 RGB view for ${asset.sourceContentHash}`);
  const rgbBytes = await readFile(resolve(root, view.rgbRelativePath));
  if (sha256(rgbBytes) !== viewEvidence.rgbHash)
    throw new Error(`RGB review evidence hash mismatch for ${asset.sourceContentHash}`);
  visualBySource.set(asset.sourceContentHash, {
    sourceContentHash: asset.sourceContentHash,
    renderEvidenceHash: render.evidence.hash,
    rgbHash: viewEvidence.rgbHash,
    rgbRelativePath: view.rgbRelativePath,
    contactSheetRelativePath: render.contactSheetRelativePath,
  });
}

const pages = [];
for (const split of splits) {
  await renderAssetPages(split);
  await renderQueryPages(split);
  await renderValidatorPages(split);
}

const packet = sealCatalogQualificationReviewPacket({
  proposalFixtureHash: fixture.hash,
  visualReviewIndexHash: renderIndex.hash,
  reviewScope: {
    assetDescriptions: "required",
    queryAssetRelevance: "required",
    validatorVerdicts: "required",
  },
  pages,
  visuals: [...visualBySource.values()],
  assets: cohortAssets.map((asset) => ({
    sourceContentHash: asset.sourceContentHash,
    split: asset.split,
    proposedEvidenceExpectation: asset.evidenceExpectation,
    proposedStratum: asset.stratum,
    proposedNouns: asset.adjudicatedNouns,
  })),
  queries: fixture.queries.map((query) => ({
    queryId: query.queryId,
    split: query.split,
    queryHash: query.query.hash,
    proposedExpectation: query.expectation,
    proposedJudgments: query.judgments,
  })),
  validationCases: fixture.validationCases.map((validationCase) => ({
    caseId: validationCase.caseId,
    split: validationCase.split,
    requestHash: validationCase.request.hash,
    candidateSourceContentHash: validationCase.request.candidate.sourceContentHash,
    proposedVerdict: validationCase.expectedVerdict,
  })),
});

await writeFile(packetPath, `${JSON.stringify(packet, null, 2)}\n`, "utf8");
await writeFile(resolve(outputRoot, "packet.json"), `${JSON.stringify(packet, null, 2)}\n`, "utf8");

const decisionTemplate = {
  kind: "CatalogQualificationAdjudicationDecision",
  proposalFixtureHash: fixture.hash,
  reviewPacketHash: packet.hash,
  reviewer: { authority: "creator", reviewerId: null },
  reviewMethod: "independent_visual_review",
  reviewerStatement: null,
  reviewedAt: null,
  coverage: {
    assetDescriptions: null,
    queryAssetRelevance: null,
    validatorVerdicts: null,
  },
  assets: packet.assets.map((asset) => ({
    sourceContentHash: asset.sourceContentHash,
    reviewAction: null,
    evidenceExpectation: asset.proposedEvidenceExpectation,
    stratum: asset.proposedStratum,
    adjudicatedNouns: asset.proposedNouns,
  })),
  queries: packet.queries.map((query) => ({
    queryId: query.queryId,
    expectationReviewAction: null,
    expectation: query.proposedExpectation,
    judgments: query.proposedJudgments.map((judgment) => ({
      ...judgment,
      reviewAction: null,
    })),
  })),
  validationCases: packet.validationCases.map((validationCase) => ({
    caseId: validationCase.caseId,
    reviewAction: null,
    expectedVerdict: validationCase.proposedVerdict,
  })),
};
await writeFile(
  resolve(outputRoot, "decision-template.json"),
  `${JSON.stringify(decisionTemplate, null, 2)}\n`,
  "utf8",
);
await writeFile(
  resolve(outputRoot, "README.md"),
  `# Catalog qualification adjudication\n\n` +
    `The answer-key values in the packet are filename-derived proposals and have no authority. ` +
    `Independently inspect every asset-description page, every query–asset relationship on the ` +
    `query pages, and every validator case. In \`decision-template.json\`, set each action to ` +
    `\`confirmed\` only after direct review or to \`revised\` while changing the value. Fill the ` +
    `creator identity, statement, timestamp, and all three coverage fields (\`complete\`). Then run ` +
    `\`npm run catalog:qualification:finalize -- --decision .basalt/catalog/qualification/review/decision-template.json\`.\n`,
  "utf8",
);

process.stdout.write(
  `${JSON.stringify(
    {
      status: "incomplete",
      reason:
        "Pending creator review of asset descriptions, query-asset relevance, and validator verdicts",
      packet: packetPath,
      packetHash: packet.hash,
      decisionTemplate: resolve(outputRoot, "decision-template.json"),
      pages: packet.pages.length,
      assets: packet.assets.length,
      queries: packet.queries.length,
      queryAssetJudgments: packet.queries.reduce(
        (total, query) => total + query.proposedJudgments.length,
        0,
      ),
      validationCases: packet.validationCases.length,
    },
    null,
    2,
  )}\n`,
);

async function renderAssetPages(split) {
  const assets = cohortAssets.filter((asset) => asset.split === split);
  const columns = 8;
  const rows = 4;
  const tileWidth = 256;
  const tileHeight = 304;
  const pageSize = columns * rows;
  for (let start = 0; start < assets.length; start += pageSize) {
    const canvas = createCanvas(columns * tileWidth, rows * tileHeight);
    const context = prepareCanvas(canvas, "ASSET DESCRIPTION PROPOSALS — REVIEW EACH LABEL");
    for (const [index, asset] of assets.slice(start, start + pageSize).entries()) {
      const column = index % columns;
      const row = Math.floor(index / columns);
      const x = column * tileWidth;
      const y = row * tileHeight;
      await drawSourceImage(context, asset.sourceContentHash, x + 6, y + 24, 244, 230);
      const filename = hintBySource
        .get(asset.sourceContentHash)
        ?.observations.map((entry) => entry.originalFilename)
        .join(" + ");
      drawText(
        context,
        `${String(start + index + 1).padStart(2, "0")} · ${asset.stratum}`,
        x + 7,
        y + 258,
        242,
        "#f4f5f7",
        "bold 12px sans-serif",
      );
      drawText(
        context,
        asset.adjudicatedNouns.join(", "),
        x + 7,
        y + 274,
        242,
        "#d9dce1",
        "11px sans-serif",
      );
      drawText(
        context,
        `${asset.sourceContentHash.slice(0, 8)} · ${filename ?? ""}`,
        x + 7,
        y + 289,
        242,
        "#979da7",
        "10px sans-serif",
      );
    }
    await writePage(canvas, "asset_descriptions", split, start / pageSize + 1);
  }
}

async function renderQueryPages(split) {
  const queries = fixture.queries.filter((query) => query.split === split);
  const rows = 4;
  const rowHeight = 286;
  for (let start = 0; start < queries.length; start += rows) {
    const canvas = createCanvas(2048, rows * rowHeight);
    const context = prepareCanvas(canvas, "QUERY–ASSET PROPOSALS — REVIEW EVERY RELATIONSHIP");
    for (const [row, query] of queries.slice(start, start + rows).entries()) {
      const y = row * rowHeight;
      drawText(
        context,
        `${query.queryId} · proposed ${query.expectation}`,
        12,
        y + 24,
        2024,
        "#f4f5f7",
        "bold 14px sans-serif",
      );
      drawText(context, query.query.text, 12, y + 43, 2024, "#f6c96b", "13px sans-serif");
      const tileWidth = 2048 / query.judgments.length;
      for (const [column, judgment] of query.judgments.entries()) {
        const x = Math.floor(column * tileWidth);
        await drawSourceImage(
          context,
          judgment.sourceContentHash,
          x + 6,
          y + 66,
          tileWidth - 12,
          174,
        );
        drawText(
          context,
          `PROPOSED: ${judgment.relevance}`,
          x + 7,
          y + 244,
          tileWidth - 14,
          judgment.relevance === "relevant"
            ? "#77d59b"
            : judgment.relevance === "uncertain"
              ? "#f6c96b"
              : "#e58b8b",
          "bold 11px sans-serif",
        );
        drawText(
          context,
          judgment.sourceContentHash.slice(0, 12),
          x + 7,
          y + 260,
          tileWidth - 14,
          "#979da7",
          "10px monospace",
        );
      }
    }
    await writePage(canvas, "query_asset_relevance", split, start / rows + 1);
  }
}

async function renderValidatorPages(split) {
  const cases = fixture.validationCases.filter((validationCase) => validationCase.split === split);
  const columns = 4;
  const rows = 3;
  const tileWidth = 512;
  const tileHeight = 360;
  const pageSize = columns * rows;
  for (let start = 0; start < cases.length; start += pageSize) {
    const canvas = createCanvas(columns * tileWidth, rows * tileHeight);
    const context = prepareCanvas(canvas, "VALIDATOR VERDICT PROPOSALS — REVIEW EACH CASE");
    for (const [index, validationCase] of cases.slice(start, start + pageSize).entries()) {
      const column = index % columns;
      const row = Math.floor(index / columns);
      const x = column * tileWidth;
      const y = row * tileHeight;
      drawText(
        context,
        validationCase.caseId,
        x + 8,
        y + 24,
        tileWidth - 16,
        "#f4f5f7",
        "bold 12px sans-serif",
      );
      drawText(
        context,
        validationCase.request.query.text,
        x + 8,
        y + 41,
        tileWidth - 16,
        "#f6c96b",
        "11px sans-serif",
      );
      await drawSourceImage(
        context,
        validationCase.request.candidate.sourceContentHash,
        x + 8,
        y + 61,
        tileWidth - 16,
        244,
      );
      drawText(
        context,
        `PROPOSED VERDICT: ${validationCase.expectedVerdict}`,
        x + 8,
        y + 310,
        tileWidth - 16,
        "#d9dce1",
        "bold 11px sans-serif",
      );
      drawText(
        context,
        validationCase.request.candidate.sourceContentHash.slice(0, 16),
        x + 8,
        y + 327,
        tileWidth - 16,
        "#979da7",
        "10px monospace",
      );
    }
    await writePage(canvas, "validator_verdicts", split, start / pageSize + 1);
  }
}

function prepareCanvas(canvas, banner) {
  const context = canvas.getContext("2d");
  context.fillStyle = "#17191d";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#d46b6b";
  context.font = "bold 13px sans-serif";
  context.textBaseline = "top";
  context.fillText(banner, 8, 4);
  return context;
}

async function drawSourceImage(context, sourceContentHash, x, y, width, height) {
  const visual = visualBySource.get(sourceContentHash);
  if (!visual) throw new Error(`Review packet lacks visual evidence for ${sourceContentHash}`);
  let promise = imageBySource.get(sourceContentHash);
  if (!promise) {
    promise = loadImage(resolve(root, visual.rgbRelativePath));
    imageBySource.set(sourceContentHash, promise);
  }
  const sourceImage = await promise;
  context.fillStyle = "#292d33";
  context.fillRect(x, y, width, height);
  const scale = Math.min(width / sourceImage.width, height / sourceImage.height);
  const drawnWidth = Math.round(sourceImage.width * scale);
  const drawnHeight = Math.round(sourceImage.height * scale);
  context.drawImage(
    sourceImage,
    x + Math.round((width - drawnWidth) / 2),
    y + Math.round((height - drawnHeight) / 2),
    drawnWidth,
    drawnHeight,
  );
}

function drawText(context, value, x, y, width, color, font) {
  context.fillStyle = color;
  context.font = font;
  context.fillText(trimText(context, value, width), x, y);
}

async function writePage(canvas, pageKind, split, pageNumber) {
  const filename = `${pageKind}-${split}-${String(pageNumber).padStart(2, "0")}.png`;
  const relativePath = `.basalt/catalog/qualification/review/${filename}`;
  const bytes = canvas.toBuffer("image/png");
  await writeFile(resolve(root, relativePath), bytes);
  pages.push({ pageKind, split, pageNumber, relativePath, bytesHash: sha256(bytes) });
}

function trimText(context, value, width) {
  if (context.measureText(value).width <= width) return value;
  let trimmed = value;
  while (trimmed.length > 1 && context.measureText(`${trimmed}…`).width > width)
    trimmed = trimmed.slice(0, -1);
  return `${trimmed}…`;
}
