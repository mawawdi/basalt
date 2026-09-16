import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  CATALOG_CALIBRATION_SPLIT_SCHEMA,
  CATALOG_LEAKAGE_ANALYSIS_SCHEMA,
  CATALOG_SOURCE_NAME_HINT_SET_SCHEMA,
  CATALOG_VISUAL_REVIEW_INDEX_SCHEMA,
  buildCatalogReviewEvidenceAudit,
  sealAssetMetricPromptSummary,
  sealCatalogQualificationDescriptionProposal,
} from "../packages/catalog-authoring/dist/index.js";
import {
  CATALOG_MEASUREMENT_SET_SCHEMA,
  TRUSTED_SOURCE_MANIFEST_SCHEMA,
} from "../packages/catalog-model/dist/index.js";
import { contentHash, stableJson } from "../packages/contracts/dist/index.js";

const root = resolve(".");
const proposalPath = "registry/qualifications/catalog-description-proposal.json";
const auditPath = "registry/qualifications/catalog-review-evidence-audit.json";
const readJson = async (path) => JSON.parse(await readFile(resolve(root, path), "utf8"));
const compare = (left, right) => left.localeCompare(right);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const definitions = [
  {
    sourceContentHash: "0034c2c42719801ce1e679c00d4062e8a86e39d6898c7ba57e52d760cc3b02bc",
    selectionTags: ["assembly_component", "component_like", "intentionally_partial"],
    visibleDescription: concrete("Beige pillar-shaped piece with a faceted cap"),
  },
  {
    sourceContentHash: "020e15254e550187ed7627c2c566e4a37dad45f822ad7a2c3e07e1034557ec2d",
    selectionTags: ["complete", "single_object", "standalone"],
    visibleDescription: concrete(
      "Closed wooden treasure chest with an arched slatted lid and gray metal bands",
    ),
  },
  {
    sourceContentHash: "421e4424b52b4b85987b7906053de7885e9c40bbb5295b1fcd791f8d2913b593",
    selectionTags: ["complete", "environment_realizer", "single_object"],
    visibleDescription: concrete("Tall upright gray faceted boulder with a flattened top"),
  },
  {
    sourceContentHash: "6b091f89824cb3b949f882c7bf1770c53102fce88a0f659f34f63160a18e4020",
    selectionTags: ["complete", "multi_object_aggregate", "standalone"],
    visibleDescription: concrete(
      "Shallow rectangular bowl holding bananas and mixed red, green, and orange fruit",
    ),
  },
  {
    sourceContentHash: "04db0038e87112d91bc1d2c8da17746bbeb82b71c0208f059e3878f215cea136",
    selectionTags: ["component_like", "intentionally_partial", "route_component"],
    visibleDescription: concrete("Curved dirt-road segment with grassy banks and scattered stones"),
  },
  {
    sourceContentHash: "05206c0e079973ab7d3846ff41f87c13093acf9d2f86b5757e8ab0cde10df4d9",
    selectionTags: ["complete", "single_object", "standalone"],
    visibleDescription: concrete("Small arched wooden footbridge with railings on both sides"),
  },
  {
    sourceContentHash: "052942c66b259cfcf031a217b51b6a83def56c72617c5def78e0bf8d1eaeaeb0",
    selectionTags: ["complete", "environment_realizer", "single_object", "vegetation"],
    visibleDescription: concrete("Low-poly tree with a brown trunk and snow-covered green crown"),
  },
  {
    sourceContentHash: "1ee7945e406721919edd23b846ff1cafe3a88231931d2e3ec6a866399b17e855",
    selectionTags: ["complete", "single_object", "standalone", "style_contrast"],
    visibleDescription: concrete("Faceted mustard-yellow beanbag chair with a deep slouched seat"),
  },
  {
    sourceContentHash: "098e0b264794ad8ecf671727d98951721b80770c8751877fa8bc08032798ec0f",
    selectionTags: ["complete", "single_object", "source_name_mismatch", "standalone"],
    visibleDescription: concrete(
      "Tabletop paper trimmer with a blue rectangular bed, straight guide rail, and black slider",
    ),
  },
  {
    sourceContentHash: "47ce4f9f15f0e1136b3cc0e3f6949179867228675e2648aa44293658c1f75225",
    selectionTags: ["attachment", "complete", "single_object"],
    visibleDescription: concrete(
      "Two-tone conical party hat with a red-orange top and purple lower band",
    ),
  },
  {
    sourceContentHash: "1de7681563f4e018de08531d57e73ae5f2704639d2af553772e8d37fdeedc3de",
    selectionTags: ["complete", "environment_realizer", "multi_object_aggregate"],
    visibleDescription: concrete("Scattered pale bones across a low irregular gray ground mound"),
  },
  {
    sourceContentHash: "605c8509448840a4709efe97d966e2750d32fc416f254f8115d1b27b50c1e65b",
    selectionTags: ["attachment", "complete", "single_object"],
    visibleDescription: concrete(
      "White rectangular wall plate with two stacked electrical receptacles",
    ),
  },
  {
    sourceContentHash: "1f3c7e8784292a1b102d18bfdd576a941fac4d3c0fdb5c8f5445935d3c06d19a",
    selectionTags: ["assembly_component", "component_like", "intentionally_partial"],
    visibleDescription: concrete(
      "Simple wooden fence panel made of three slightly uneven horizontal rails",
    ),
  },
  {
    sourceContentHash: "2519f7d3fef35f984e57282d802a434e5187dafbc5e9cc3fab9a9a7e2f39d15b",
    selectionTags: ["complete", "environment_realizer", "single_object", "vegetation"],
    visibleDescription: concrete(
      "Slender bent palm tree with a small crown of bright-green fronds",
    ),
  },
  {
    sourceContentHash: "2553b31cbd7c5c11e752d1e53fa011b628de163844bcb70520a6f67f30902b6b",
    selectionTags: ["complete", "semantic_boundary", "single_object", "standalone"],
    visibleDescription: concrete("Black cannon mounted on a brown four-wheeled wooden carriage"),
  },
  {
    sourceContentHash: "25c127f1e39ae40d42cf8f123e7f3a3f29619e4f31405af4ab1a41c399c2232a",
    selectionTags: [
      "component_like",
      "intentionally_partial",
      "route_component",
      "semantic_boundary",
      "source_name_mismatch",
    ],
    visibleDescription: concrete("Curved shallow tan earthen channel with grassy banks and stones"),
  },
  {
    sourceContentHash: "f68a62f4a45621b57b5260697f0806741423c9818d63e540debde90ea24b0fda",
    selectionTags: ["complete", "semantic_boundary", "single_object", "standalone"],
    visibleDescription: concrete(
      "Curved triple-monitor desktop rig mounted on a central adjustable stand",
    ),
  },
  {
    sourceContentHash: "2c0f4c5a5d4b7abc6be33b0a0c810ac2ae9c955491efc01f897819c8a6252e34",
    selectionTags: ["complete", "single_object", "standalone", "style_contrast"],
    visibleDescription: concrete(
      "Boxy gray outdoor air-conditioning unit with a circular fan grille",
    ),
  },
  {
    sourceContentHash: "3000ffbd87e5aa4f71b2fc3475e9ec77281d7b0379b64d32b267f8f0fc28b356",
    selectionTags: [
      "complete",
      "environment_realizer",
      "multi_object_aggregate",
      "semantic_boundary",
    ],
    visibleDescription: uncertainDescription(
      "Thin elongated white cloud-like form with a small detached fragment",
      "The isolated geometry supports a cloud-like reading, but scale and scene context are absent.",
    ),
  },
  {
    sourceContentHash: "33626269f7598396c633a2c1e115070bc48679984e472df154690377c8ecc45d",
    selectionTags: [
      "assembly_component",
      "component_like",
      "intentionally_partial",
      "semantic_boundary",
    ],
    visibleDescription: concrete("Long narrow gray rectangular beam with beveled ends"),
  },
  {
    sourceContentHash: "61123c8b2a32e2998d6a1bde535d1319f6bf5db6ee52c6386d1a69e47370b166",
    selectionTags: [
      "complete",
      "environment_realizer",
      "semantic_boundary",
      "single_object",
      "source_name_mismatch",
    ],
    visibleDescription: uncertainDescription(
      "Irregular low olive-green faceted ground clump",
      "The views do not distinguish moss, rock, or another low ground-cover form with confidence.",
    ),
  },
  {
    sourceContentHash: "6e909023406815ec410952b01dd597ed4a4bf83a4f635a4a83f374f96ef7d107",
    selectionTags: ["complete", "environment_realizer", "multi_object_aggregate", "vegetation"],
    visibleDescription: concrete("Cluster of three brown mushrooms with rounded caps"),
  },
  {
    sourceContentHash: "760581ed515130882342903035e8d6e594bbd983a8732519fadb0c877acaa461",
    selectionTags: ["attachment", "complete", "semantic_boundary", "single_object"],
    visibleDescription: concrete(
      "Red wheeled agricultural implement with a tow arm and multiple curved tines",
    ),
  },
  {
    sourceContentHash: "fede7d0c848deb25b909ca7b0201c3c824a8c25b5d3ab1a6a5dc6faf706386e5",
    selectionTags: ["complete", "multi_object_aggregate", "standalone"],
    visibleDescription: concrete("Stack of sealed brown cardboard boxes in two uneven tiers"),
  },
];

if (definitions.length !== 24) throw new Error("Description pilot must contain exactly 24 assets");
if (new Set(definitions.map((entry) => entry.sourceContentHash)).size !== definitions.length)
  throw new Error("Description pilot contains duplicate source identities");

const sourceManifest = TRUSTED_SOURCE_MANIFEST_SCHEMA.parse(
  await readJson("registry/source-manifest.json"),
);
const measurements = CATALOG_MEASUREMENT_SET_SCHEMA.parse(
  await readJson(".basalt/catalog/measurements.json"),
);
const renders = CATALOG_VISUAL_REVIEW_INDEX_SCHEMA.parse(
  await readJson(".basalt/catalog/review/index.json"),
);
const sourceNames = CATALOG_SOURCE_NAME_HINT_SET_SCHEMA.parse(
  await readJson(".basalt/catalog/metadata/source-name-hints.json"),
);
const calibration = CATALOG_CALIBRATION_SPLIT_SCHEMA.parse(
  await readJson("registry/calibration-split.json"),
);
const leakage = CATALOG_LEAKAGE_ANALYSIS_SCHEMA.parse(
  await readJson("registry/leakage-analysis.json"),
);
const sourceManifestHash = contentHash(stableJson(sourceManifest));

for (const [label, hash] of [
  ["measurement set", measurements.sourceManifestHash],
  ["visual review index", renders.sourceManifestHash],
  ["source-name hints", sourceNames.sourceManifestHash],
  ["calibration split", calibration.sourceManifestHash],
  ["leakage analysis", leakage.sourceManifestHash],
])
  if (hash !== sourceManifestHash) throw new Error(`${label} binds another source manifest`);

const audit = buildCatalogReviewEvidenceAudit({
  sourceManifestHash,
  measurements,
  sourceNameHints: sourceNames,
});
if (audit.findings.length === 0)
  throw new Error("Expected explicit collision companions were not detected before review");

const sourceByHash = new Map(sourceManifest.assets.map((entry) => [entry.contentHash, entry]));
const measurementByHash = new Map(
  measurements.assets.map((entry) => [entry.source.contentHash, entry]),
);
const renderByHash = new Map(renders.items.map((entry) => [entry.sourceContentHash, entry]));
const hintByHash = new Map(sourceNames.items.map((entry) => [entry.sourceContentHash, entry]));
const groupBySource = new Map(
  calibration.groups.flatMap((group) =>
    group.sourceContentHashes.map((sourceContentHash) => [sourceContentHash, group.hash]),
  ),
);
const roleByGroup = new Map(calibration.assignments.map((entry) => [entry.groupHash, entry.role]));
const collisionCompanions = new Set(audit.findings.map((entry) => entry.sourceContentHash));

const assets = [];
for (const definition of definitions) {
  const { sourceContentHash } = definition;
  if (collisionCompanions.has(sourceContentHash))
    throw new Error(`Collision companion cannot enter appearance review: ${sourceContentHash}`);
  const source = sourceByHash.get(sourceContentHash);
  const measurement = measurementByHash.get(sourceContentHash);
  const render = renderByHash.get(sourceContentHash);
  const hint = hintByHash.get(sourceContentHash);
  const leakageGroupHash = groupBySource.get(sourceContentHash);
  if (!source || !measurement || !render || !hint || !leakageGroupHash)
    throw new Error(`Pilot source lacks bound evidence: ${sourceContentHash}`);
  if (roleByGroup.get(leakageGroupHash) !== "development")
    throw new Error(`Pilot source is not in the development split: ${sourceContentHash}`);

  const viewEvidenceById = new Map(render.evidence.views.map((entry) => [entry.viewId, entry]));
  const rgbViews = [];
  for (const view of render.viewArtifacts) {
    const viewEvidence = viewEvidenceById.get(view.viewId);
    if (!viewEvidence)
      throw new Error(`Render view lacks evidence: ${sourceContentHash}/${view.viewId}`);
    const bytes = await readFile(resolve(root, view.rgbRelativePath));
    if (sha256(bytes) !== viewEvidence.rgbHash)
      throw new Error(`RGB evidence hash mismatch: ${sourceContentHash}/${view.viewId}`);
    rgbViews.push({
      viewId: view.viewId,
      rgbHash: viewEvidence.rgbHash,
      rgbRelativePath: view.rgbRelativePath,
    });
  }

  assets.push({
    sourceContentHash,
    sourceRelativePath: source.relativePath,
    leakageGroupHash,
    split: "development",
    selectionTags: definition.selectionTags,
    evidenceUsability: { status: "usable", defectKinds: [], note: null },
    visibleDescription: definition.visibleDescription,
    evidence: {
      renderEvidenceHash: render.evidence.hash,
      contactSheetRelativePath: render.contactSheetRelativePath,
      rgbViews: rgbViews.sort((left, right) => compare(left.viewId, right.viewId)),
      metricSummary: sealAssetMetricPromptSummary(measurement),
    },
    filenameHint: {
      artifactHash: hint.hash,
      authority: "none",
      observations: hint.observations.map((entry) => entry.originalFilename).sort(compare),
    },
  });
}

const proposal = sealCatalogQualificationDescriptionProposal({
  sourceManifestHash,
  measurementSetHash: measurements.hash,
  visualReviewIndexHash: renders.hash,
  reviewEvidenceAuditHash: audit.hash,
  leakageAnalysisHash: leakage.hash,
  calibrationSplitHash: calibration.hash,
  assets,
});

await writeJson(auditPath, audit);
await writeJson(proposalPath, proposal);

process.stdout.write(
  `${JSON.stringify(
    {
      status: "incomplete",
      reason: "Pending independent creator review of the 24-asset description pilot",
      proposal: resolve(root, proposalPath),
      proposalHash: proposal.hash,
      evidenceAudit: resolve(root, auditPath),
      evidenceAuditHash: audit.hash,
      collisionCompanionsExcluded: audit.findings.length,
      collisionCompanionsMisclassifiedAsRenderable: audit.findings.filter((entry) =>
        entry.measuredPartRoles.some((role) => role !== "collision_proxy"),
      ).length,
      assets: proposal.assets.length,
      split: proposal.split,
      queryAuthoringStatus: proposal.queryAuthoringStatus,
      qualificationExecutionAuthorized: proposal.qualificationExecutionAuthorized,
    },
    null,
    2,
  )}\n`,
);

function concrete(text) {
  return { status: "concrete", text, uncertaintyReason: null };
}

function uncertainDescription(text, uncertaintyReason) {
  return { status: "uncertain", text, uncertaintyReason };
}

async function writeJson(path, value) {
  const absolute = resolve(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
