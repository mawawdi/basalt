import { createCanvas, loadImage } from "@napi-rs/canvas";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { sealCatalogCreatorReviewPacket } from "../packages/catalog-authoring/dist/index.js";
import { contentHash, dequantizeQ32_32, stableJson } from "../packages/contracts/dist/index.js";

const root = resolve(".");
const outputRoot = resolve(root, ".basalt/catalog/admission/outdoor-tranche");
const readJson = async (path) => JSON.parse(await readFile(resolve(root, path), "utf8"));

const selected = [
  ["8730b69b9cdbd17b7b1a2b9c8b6e61d86d2454468722486f04b50e6d99f6fc12", "tree", "bsc_000003"],
  ["accdd7742e4d06cf93f1c09a7a01607ae5686ba5daf5dbd791534341dcf84dde", "tree", "bsc_000003"],
  ["d6c118d28bb052840ad3a2e5ee601a5fc2c8c06278c3d28062712650fb672e0f", "tree", "bsc_000003"],
  ["f020fe057d2ad733517f83fafac66d297528826b48251633100e191ef255fab6", "tree", "bsc_000003"],
  ["3bd8fae39914bb8cb6d33a32cab04ee584f0cefeaa7536b185b7e1e5d7786420", "tree", "bsc_000003"],
  ["b2d9a9a20a7ab70d877c6569eac34dd822020d49cfa47af6820fc1961228485a", "tree", "bsc_000003"],
  ["856dbb16fd6fb2efa098b6faa7ae7a190ad4f0eae91bd26dff978c053cd548dc", "tree", "bsc_000003"],
  ["025f3575def4aa6c6797c596d948cf327a2bc1357cf01316489a6699a3e6ec32", "tree", "bsc_000003"],
  ["c453b2f0b6854e5b69e75254200e0f0602f1a83b4df57439c5532b01435dd463", "boulder", "bsc_000013"],
  ["20dd01e550ab59b1948e6247b138dbf5a9e5ee6b8ed66d970adbb672f0b8aba5", "rock", "bsc_000012"],
  ["6a457958e187c29934dc7e6ed2ed6a0fb1bb49f452b1d7b1f77251889bf7eb9a", "rock", "bsc_000012"],
  ["b6368c3f2c7b48872a60db5c74feb32d934b87af3fdfa77a2c47a1c7ccf9ad3c", "rock", "bsc_000012"],
  ["3887b64f53052461321f8ad03778a915fefbbb8546fdbdb7cae3f75734d9570c", "rock", "bsc_000012"],
  ["2cc52b5bed2ed8cc2a4370cb16fe0c7289dd87b58db64606d8d648feedf297f2", "rock", "bsc_000012"],
  ["cfc507647e476208b4636bd67a0451175c15d6881ec2ee98a5a0fa351b910ed1", "shrub", "bsc_000004"],
  ["e7c6213201dab0c27af13c7df05a263dd5aab25e6b6e5b6b00ddf386a6689978", "shrub", "bsc_000004"],
  ["e8b17a35b6cac682a55945c1b83321d36d9f162dbde417a8422ada50831b8109", "shrub", "bsc_000004"],
  ["36a7823395db528befe176580107558fd8c00697581dda7d12d2e2e844d048bc", "fern", "bsc_000005"],
  ["99f17578c60f06a26686018536cfaf3271e6ab23b750a013c008649c51a4a35e", "fern", "bsc_000005"],
  ["9cbd54bdf6f7601a949248f3bf86b442c1061972218a30f8475f6baaca7f9b4d", "grass", "bsc_000005"],
  ["535d6f663a1ae46bbd863f5d27081f29c5f743fe1e5a01ab33197d388dc82c8a", "fallen_log", "bsc_000018"],
  ["01b8c04e0bf9133aca28764f979c389c4d0d5e471bf9c81f47e128c4689f6299", "fallen_log", "bsc_000018"],
  ["00d9775903130915c301b083bd09d00141b3607e132d32b09f9c44df832f3339", "tree_stump", "bsc_000019"],
  ["7a9d4305696ce362a57d5b4714cc35ebacbd4fba07c4b5b93a45ac235f9697bc", "tree_stump", "bsc_000019"],
];

const [manifest, measurements, renders, hints, rubric, policy] = await Promise.all(
  [
    "registry/source-manifest.json",
    ".basalt/catalog/measurements.json",
    ".basalt/catalog/review/index.json",
    ".basalt/catalog/metadata/source-name-hints.json",
    "registry/admission-rubric.json",
    "registry/admission-policy.json",
  ].map(readJson),
);
const concepts = new Map(
  await Promise.all(
    [...new Set(selected.map((entry) => entry[2]))].map(async (conceptId) => {
      const concept = await readJson(`registry/semantics/concepts/${conceptId}.json`);
      return [conceptId, concept];
    }),
  ),
);
const manifestBySource = new Map(manifest.assets.map((entry) => [entry.contentHash, entry]));
const measurementBySource = new Map(
  measurements.assets.map((entry) => [entry.source.contentHash, entry]),
);
const renderBySource = new Map(renders.items.map((entry) => [entry.sourceContentHash, entry]));
const hintBySource = new Map(hints.items.map((entry) => [entry.sourceContentHash, entry]));
const criterionIds = rubric.criteria
  .filter((entry) => entry.subjectKind === "asset")
  .map((entry) => entry.criterionId)
  .sort(compare);

const styleProfile = {
  handle: "stylized_low_poly_nature",
  shapeLanguage:
    "Readable faceted silhouettes with simplified organic masses and deliberately low polygon density.",
  silhouetteHierarchy: [
    {
      level: "primary",
      guidance:
        "Keep trunks, canopies, rock masses, and groundcover clusters readable at world scale.",
    },
    {
      level: "secondary",
      guidance:
        "Preserve the few large angular breaks that distinguish variants without adding fine noise.",
    },
  ],
  detailScale: [
    {
      level: "asset",
      guidance:
        "Use broad color blocks and authored facets; avoid microdetail that competes with the silhouette.",
    },
  ],
  edgeTreatment: "Retain authored hard-edged low-poly facets and clean silhouette transitions.",
  materialLanguage:
    "Use the authored matte color-blocked materials with restrained highlights and no synthesized surface wear.",
  texelDensity: { minimumPixelsPerMeter: 4, targetPixelsPerMeter: 64, maximumPixelsPerMeter: 1024 },
  surfaceVariation: {
    scaleMeters: 2,
    intensity: 0,
    guidance: "Retain authored color variation; add no compiler-authored mottling.",
  },
  wearPolicy: {
    amount: 0,
    placement: "Retain source wear only.",
    exclusions: ["Do not add edge wear or dirt during catalog realization."],
  },
  lightingIntent: "Read as matte stylized outdoor forms under world-level lighting.",
  antiGoals: [
    "Do not infer interchangeability from the shared visual family.",
    "Do not smooth away the authored faceted silhouette.",
    "Do not replace authored materials with photorealistic textures.",
  ],
  palette: [
    { id: "bark_brown", name: "Bark brown", color: "#6A4A2F", metallic: 0, roughness: 0.85 },
    { id: "foliage_green", name: "Foliage green", color: "#667A32", metallic: 0, roughness: 0.85 },
    { id: "rock_gray", name: "Rock gray", color: "#77766F", metallic: 0, roughness: 0.9 },
  ],
};

const candidates = selected.map(([sourceContentHash, label, conceptId]) => {
  const source = manifestBySource.get(sourceContentHash);
  const measurement = measurementBySource.get(sourceContentHash);
  const render = renderBySource.get(sourceContentHash);
  const hint = hintBySource.get(sourceContentHash);
  const concept = concepts.get(conceptId);
  if (!source || !measurement || !render || !hint || !concept)
    throw new Error(`Outdoor review input is incomplete for ${sourceContentHash}`);
  if (measurement.source.rights.evidenceHash !== source.rights.evidenceHash)
    throw new Error(`Outdoor review rights lineage is stale for ${sourceContentHash}`);
  const sourceName = hint.observations.map((entry) => entry.originalFilename).join(" + ");
  const pbrChannels = [
    ...new Set(measurement.materials.flatMap((entry) => entry.pbrChannels)),
  ].sort(compare);
  const rgbViewHashes = render.evidence.views.map((entry) => entry.rgbHash).sort(compare);
  const entryStem = basename(sourceName, ".glb")
    .replace(/^SM_/u, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  return {
    sourceContentHash,
    sourceRelativePath: source.relativePath,
    sourceNameForReviewOnly: sourceName,
    assetId: measurement.assetId,
    assetHash: measurement.hash,
    rights: measurement.source.rights,
    evidence: {
      measurementHash: measurement.hash,
      renderEvidenceHash: render.evidence.hash,
      contactSheetRelativePath: render.contactSheetRelativePath,
      rgbViewHashes,
    },
    metricSummary: {
      sourceFrame: {
        handedness: measurement.coordinateFrame.handedness,
        up: measurement.coordinateFrame.up,
        forward: measurement.coordinateFrame.forward,
        unitsToMeters: dequantizeQ32_32(measurement.coordinateFrame.unitsToMeters),
      },
      sizeMeters: {
        x: size(measurement, "x"),
        y: size(measurement, "y"),
        z: size(measurement, "z"),
      },
      triangleCount: measurement.parts.reduce((sum, part) => sum + part.triangleCount, 0),
      sourceBytes: measurement.source.sourceArtifact.bytes,
      partCount: measurement.parts.length,
      materialCount: measurement.materials.length,
      pbrChannels,
      primaryContact: measurement.support.primaryContact,
      contactAreaSquareMeters: dequantizeQ32_32(measurement.support.contactAreaSquareMeters),
      supportMeasurementMethod: measurement.support.measurementMethod,
      collisionMode: measurement.collision.mode,
      socketCount: measurement.sockets.length,
    },
    proposal: {
      entryHandle: `${entryStem}_ground`,
      memberId: `source_${sourceContentHash.slice(0, 16)}`,
      denotation: { conceptId, commitmentHash: concept.commitmentHash },
      realizationForm: "whole",
      placement: { support: "ground", contact: "bottom", interfaces: [] },
      styleProfileHandle: styleProfile.handle,
      singletonSubstitutionSet: true,
    },
    criterionIds,
    reviewStatus: "pending_creator_review",
    label,
    render,
  };
});

const packet = sealCatalogCreatorReviewPacket({
  batchId: "outdoor_tranche",
  purpose: "outdoor_catalog_admission",
  sourceManifestHash: contentHash(stableJson(manifest)),
  measurementSetHash: measurements.hash,
  visualReviewIndexHash: renders.hash,
  semanticModuleHash: rubric.semanticModuleHash,
  admissionPolicyHash: policy.hash,
  admissionRubricHash: rubric.hash,
  proposedStyleProfile: styleProfile,
  selectionRationale:
    "Twenty-four non-LOD sources from one visually inspected low-poly outdoor family: eight individual trees, six individual rocks, six shrubs or groundcover plants, and four fallen-log or stump props. Every proposal remains a singleton substitution set.",
  reviewProcedure: [
    "Inspect every 12-view contact sheet, including unlit base color, depth, silhouette, and surface-normal evidence.",
    "Confirm the proposed denotation and whole-object realization independently of the filename.",
    "Confirm bottom support, upright orientation, completeness, materials, and collision suitability against the measured record. planar_patch_fit carries a positive fitted area; lower_extrema proves only Y-up bottom alignment and carries zero planar area.",
    "Approve the shared style profile only if every accepted source is visually coherent with it.",
    "Mark uncertainty incomplete and any contradicted semantic, geometric, rights, or installation claim rejected.",
  ],
  candidates: candidates.map((candidate) => {
    const reviewCandidate = { ...candidate };
    delete reviewCandidate.label;
    delete reviewCandidate.render;
    delete reviewCandidate.sourceNameForReviewOnly;
    return reviewCandidate;
  }),
  reviewerAuthorityRequired: "creator",
});

await mkdir(outputRoot, { recursive: true });
await writeFile(
  resolve(outputRoot, "review-packet.json"),
  `${JSON.stringify(packet, null, 2)}\n`,
  "utf8",
);
const template = {
  kind: "CatalogCreatorReviewDecisionTemplate",
  packetHash: packet.hash,
  reviewer: { authority: "creator", reviewerId: null },
  reviewMethod: "independent_visual_review",
  reviewerStatement: null,
  reviewedAt: null,
  styleProfileDecision: null,
  decisions: packet.candidates.map((candidate) => ({
    sourceContentHash: candidate.sourceContentHash,
    outcome: null,
    proposalApproved: null,
    criteria: candidate.criterionIds.map((criterionId) => ({
      criterionId,
      outcome: null,
      evidenceHashes: [
        candidate.assetHash,
        candidate.evidence.renderEvidenceHash,
        candidate.rights.evidenceHash,
      ].sort(compare),
      note: null,
    })),
    note: null,
  })),
};
await writeFile(
  resolve(outputRoot, "decision-template.json"),
  `${JSON.stringify(template, null, 2)}\n`,
  "utf8",
);
await renderReviewSheet(candidates, resolve(outputRoot, "review-sheet.png"));
const evidencePages = await renderEvidencePages(candidates);
await writeFile(resolve(outputRoot, "README.md"), reviewInstructions(packet, candidates), "utf8");
process.stdout.write(
  `${JSON.stringify({ status: "incomplete", reason: "Creator admission decision required", packet: resolve(outputRoot, "review-packet.json"), decisionTemplate: resolve(outputRoot, "decision-template.json"), reviewSheet: resolve(outputRoot, "review-sheet.png"), evidencePages, sources: packet.candidates.length, hash: packet.hash }, null, 2)}\n`,
);

function size(measurement, axis) {
  return (
    dequantizeQ32_32(measurement.bounds.max[axis]) - dequantizeQ32_32(measurement.bounds.min[axis])
  );
}

async function renderReviewSheet(items, output) {
  const columns = 6;
  const rows = 4;
  const tileWidth = 300;
  const tileHeight = 350;
  const canvas = createCanvas(columns * tileWidth, rows * tileHeight);
  const context = canvas.getContext("2d");
  context.fillStyle = "#17191d";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.textBaseline = "top";
  for (const [index, item] of items.entries()) {
    const x = (index % columns) * tileWidth;
    const y = Math.floor(index / columns) * tileHeight;
    const artifact = item.render.viewArtifacts.find((entry) => entry.viewId === "low_00");
    if (!artifact) throw new Error(`Missing low_00 render for ${item.sourceContentHash}`);
    const image = await loadImage(resolve(root, artifact.rgbRelativePath));
    context.drawImage(image, x + 8, y + 8, 284, 284);
    context.fillStyle = "#f4f5f7";
    context.font = "bold 13px sans-serif";
    context.fillText(`${String(index + 1).padStart(2, "0")} · ${item.label}`, x + 8, y + 298);
    context.font = "11px sans-serif";
    context.fillStyle = "#d9dce1";
    context.fillText(trimText(context, item.sourceNameForReviewOnly, 284), x + 8, y + 316);
    context.fillStyle = "#979da7";
    const metric = item.metricSummary;
    context.fillText(
      `${item.sourceContentHash.slice(0, 8)} · ${metric.sizeMeters.x.toFixed(2)}×${metric.sizeMeters.y.toFixed(2)}×${metric.sizeMeters.z.toFixed(2)}m · ${metric.triangleCount} tri`,
      x + 8,
      y + 332,
    );
  }
  await writeFile(output, canvas.toBuffer("image/png"));
}

async function renderEvidencePages(items) {
  const pageSize = 6;
  const columns = 3;
  const rows = 2;
  const tileWidth = 480;
  const tileHeight = 440;
  const outputs = [];
  for (let start = 0; start < items.length; start += pageSize) {
    const canvas = createCanvas(columns * tileWidth, rows * tileHeight);
    const context = canvas.getContext("2d");
    context.fillStyle = "#17191d";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.textBaseline = "top";
    for (const [pageIndex, item] of items.slice(start, start + pageSize).entries()) {
      const x = (pageIndex % columns) * tileWidth;
      const y = Math.floor(pageIndex / columns) * tileHeight;
      const image = await loadImage(resolve(root, item.render.contactSheetRelativePath));
      context.drawImage(image, x + 5, y + 5, 470, 400);
      context.fillStyle = "#f4f5f7";
      context.font = "bold 13px sans-serif";
      context.fillText(
        `${String(start + pageIndex + 1).padStart(2, "0")} · ${item.label} · ${item.sourceNameForReviewOnly}`,
        x + 7,
        y + 410,
      );
      context.fillStyle = "#979da7";
      context.font = "11px sans-serif";
      context.fillText(item.sourceContentHash, x + 7, y + 426);
    }
    const page = Math.floor(start / pageSize) + 1;
    const path = resolve(outputRoot, `review-evidence-${String(page).padStart(2, "0")}.png`);
    await writeFile(path, canvas.toBuffer("image/png"));
    outputs.push(path);
  }
  return outputs;
}

function reviewInstructions(packet, items) {
  const rows = items
    .map(
      (item, index) =>
        `| ${index + 1} | ${item.label} | ${item.sourceNameForReviewOnly} | \`${item.sourceContentHash}\` | ${item.metricSummary.supportMeasurementMethod} / ${item.metricSummary.contactAreaSquareMeters.toFixed(6)} m² | [contact sheet](../../../review/previews/${item.sourceContentHash}/contact-sheet.png) |`,
    )
    .join("\n");
  return `# Outdoor catalog tranche creator review\n\nStatus: pending creator review. The labels and entry shapes in this packet are agent proposals, not human admissions.\n\nPacket hash: \`${packet.hash}\`\n\nReview \`review-sheet.png\`, then open the exact contact sheet for every source. Complete \`decision-template.json\` with your creator identity, reviewer statement, timestamp, style decision, per-source outcome, every criterion outcome, and notes. Rename the completed file to \`decision.json\`; do not change \`review-packet.json\`.\n\n${packet.reviewProcedure.map((entry, index) => `${index + 1}. ${entry}`).join("\n")}\n\n| # | Proposed class | Source name (review hint only) | Source hash | Support evidence | Visual evidence |\n| ---: | --- | --- | --- | --- | --- |\n${rows}\n`;
}

function trimText(context, value, width) {
  if (context.measureText(value).width <= width) return value;
  let trimmed = value;
  while (trimmed.length > 1 && context.measureText(`${trimmed}…`).width > width)
    trimmed = trimmed.slice(0, -1);
  return `${trimmed}…`;
}

function compare(left, right) {
  return left.localeCompare(right);
}
