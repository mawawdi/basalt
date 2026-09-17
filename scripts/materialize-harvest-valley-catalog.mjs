import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readBoundedWorkspaceBytes, writeCanonicalWorkspaceJson } from "@basalt/artifact-store";
import {
  sealAssetMetricPromptSummary,
  sealCatalogAuthoredMetadataBatch,
  sealCatalogCreatorReviewDecision,
  sealCatalogCreatorReviewPacket,
  sealCatalogSearchMetadata,
  validateCatalogCreatorReviewDecision,
} from "@basalt/catalog-authoring";
import { contentHash, dequantizeQ32_32 } from "@basalt/contracts";
import { loadSemanticRegistry } from "../dist/test/helpers/semantic-registry.js";

const root = resolve(".");
const options = new Map();
for (let i = 2; i < process.argv.length; i += 2) options.set(process.argv[i], process.argv[i + 1]);
const readJson = async (path) => JSON.parse(await readFile(resolve(root, path), "utf8"));
const catalog = await readJson("registry/catalog.json");
const measuredEvidence = catalog.retainedEvidence.find(
  (entry) => entry.kind === "CatalogMeasurementSet",
);
if (!measuredEvidence) throw new Error("The committed catalog lacks retained measurements");
const [
  selection,
  manifest,
  measurements,
  renders,
  policy,
  rubric,
  styles,
  module,
  searchMeasurements,
] = await Promise.all([
  readJson(options.get("--selection") ?? "test/fixtures/harvest-valley-assets.json"),
  readJson("registry/source-manifest.json"),
  readJson(measuredEvidence.relativePath),
  readJson(".basalt/catalog/review/index.json"),
  readJson("registry/admission-policy.json"),
  readJson("registry/admission-rubric.json"),
  readJson("registry/style-profiles.json"),
  loadSemanticRegistry(),
  readJson(".basalt/catalog/measurements.json"),
]);
if (
  typeof selection.batchId !== "string" ||
  !/^[a-z][a-z0-9-]{0,63}$/u.test(selection.batchId) ||
  typeof selection.rationale !== "string"
)
  throw new Error("A reviewed selection requires a bounded batchId and selection rationale");
const output = `.basalt/catalog/admission/${selection.batchId}`;
const metadataOutput = `.basalt/catalog/metadata/${selection.batchId}-batch.json`;
const baseStyle = styles.find((style) => style.handle === "stylized_low_poly_nature");
if (!baseStyle) throw new Error("The admitted outdoor style is missing");
const style = {
  ...baseStyle,
  handle: selection.styleProfileHandle,
  shapeLanguage:
    "Readable stylized rural silhouettes: faceted vegetation and rocks, timber farm buildings, pitched shingle roofs and simple agricultural props.",
  materialLanguage:
    "Authored matte earth, straw, timber, muted red paint and weathered white walls with slate-gray roofs; preserve source texture and vertex colors.",
  palette: [
    ...baseStyle.palette,
    { id: "barn_red", name: "Muted barn red", color: "#914634", metallic: 0, roughness: 0.9 },
    { id: "straw_gold", name: "Dry straw", color: "#B9A26B", metallic: 0, roughness: 0.9 },
    { id: "warm_white", name: "Weathered white", color: "#CDC9BA", metallic: 0, roughness: 0.85 },
  ],
};
const criteria = rubric.criteria.filter((criterion) => criterion.subjectKind === "asset");
const records = [];
for (const spec of selection.assets) {
  const asset = measurements.assets.find(
    (item) => item.source.contentHash === spec.sourceContentHash,
  );
  const source = manifest.assets.find((item) => item.contentHash === spec.sourceContentHash);
  const render = renders.items.find((item) => item.sourceContentHash === spec.sourceContentHash);
  const concept = module.concepts.find((item) => item.conceptId === spec.conceptId);
  if (!asset || !source || !render || !concept)
    throw new Error(`Missing evidence for ${spec.handle}`);
  const sourceBytes = await readBoundedWorkspaceBytes(root, source.relativePath);
  if (contentHash(sourceBytes) !== spec.sourceContentHash)
    throw new Error(`Source drift: ${spec.handle}`);
  if (asset.support.primaryContact !== "bottom" || asset.parts.length === 0)
    throw new Error(`Unsupported installation: ${spec.handle}`);
  if (!asset.source.rights.commercialUsePermitted || !asset.source.rights.redistributionPermitted)
    throw new Error(`Insufficient rights: ${spec.handle}`);
  for (const view of render.viewArtifacts) {
    const evidence = render.evidence.views.find((item) => item.viewId === view.viewId);
    if (!evidence) throw new Error(`Missing view lineage for ${spec.handle}`);
    for (const [path, hash] of [
      [view.rgbRelativePath, evidence.rgbHash],
      [view.unlitBaseColorRelativePath, evidence.unlitBaseColorHash],
    ]) {
      if (contentHash(await readBoundedWorkspaceBytes(root, path)) !== hash)
        throw new Error(`Render drift: ${spec.handle}/${view.viewId}`);
    }
  }
  records.push({ spec, asset, source, render, concept });
}
const packet = sealCatalogCreatorReviewPacket({
  batchId: `${selection.batchId}-catalog`,
  purpose: "outdoor_catalog_admission",
  sourceManifestHash: measurements.sourceManifestHash,
  measurementSetHash: measurements.hash,
  visualReviewIndexHash: renders.hash,
  semanticModuleHash: module.snapshot.hash,
  admissionPolicyHash: policy.hash,
  admissionRubricHash: rubric.hash,
  proposedStyleProfile: style,
  selectionRationale: selection.rationale,
  reviewProcedure: [
    "Inspect canonical multiview RGB evidence and measured scale, source integrity, materials, bottom contact and part structure.",
    "Preserve every selected source as a singleton; no folder- or name-based substitution grouping.",
    "Keep interior traversal, interaction, light emission and engine behavior unasserted. The creator performs final Studio inspection.",
    "This is an explicit user-delegated authoring decision, not independent human review or automated corpus qualification.",
  ],
  candidates: records.map(({ spec, asset, source, render, concept }) => ({
    sourceContentHash: spec.sourceContentHash,
    sourceRelativePath: source.relativePath,
    assetId: asset.assetId,
    assetHash: asset.hash,
    rights: asset.source.rights,
    evidence: {
      measurementHash: asset.hash,
      renderEvidenceHash: render.evidence.hash,
      contactSheetRelativePath: render.contactSheetRelativePath,
      rgbViewHashes: render.evidence.views.map((view) => view.rgbHash).sort(),
    },
    metricSummary: {
      sourceFrame: {
        handedness: asset.coordinateFrame.handedness,
        up: asset.coordinateFrame.up,
        forward: asset.coordinateFrame.forward,
        unitsToMeters: dequantizeQ32_32(asset.coordinateFrame.unitsToMeters),
      },
      sizeMeters: Object.fromEntries(
        ["x", "y", "z"].map((axis) => [
          axis,
          dequantizeQ32_32(asset.bounds.max[axis]) - dequantizeQ32_32(asset.bounds.min[axis]),
        ]),
      ),
      triangleCount: asset.parts.reduce((sum, part) => sum + part.triangleCount, 0),
      sourceBytes: asset.source.sourceArtifact.bytes,
      partCount: asset.parts.length,
      materialCount: asset.materials.length,
      pbrChannels: [...new Set(asset.materials.flatMap((material) => material.pbrChannels))].sort(),
      primaryContact: asset.support.primaryContact,
      contactAreaSquareMeters: dequantizeQ32_32(asset.support.contactAreaSquareMeters),
      supportMeasurementMethod: asset.support.measurementMethod,
      collisionMode: asset.collision.mode,
      socketCount: asset.sockets.length,
    },
    proposal: {
      entryHandle: `rural_${spec.handle}`,
      memberId: `source_${spec.sourceContentHash.slice(0, 16)}`,
      denotation: { conceptId: concept.conceptId, commitmentHash: concept.commitmentHash },
      realizationForm: spec.realizationForm,
      placement: { support: "ground", contact: "bottom", interfaces: [] },
      styleProfileHandle: style.handle,
      singletonSubstitutionSet: true,
    },
    criterionIds: criteria.map((criterion) => criterion.criterionId).sort(),
    reviewStatus: "pending_creator_review",
  })),
  reviewerAuthorityRequired: "delegated_ai",
});
const notes = {
  appearance_identity:
    "Inspected multiview RGB evidence supports the concrete description; missing-roof and unrelated-style candidates were excluded.",
  external_resource_closure:
    "Exact retained GLB and measured material resources render successfully; source and rendered-view bytes are hash-checked.",
  geometry_health:
    "Measured nonempty bounded geometry and renderable parts; no claim of watertight topology or engine collision quality.",
  installation_contract:
    "Measured Y-up bottom contact supports upright ground placement; terrain pads must cover the complete footprint. No sockets or enterable interior are asserted.",
  material_readability:
    "Source materials and canonical RGB/base-color evidence are retained and hash-checked; final Roblox appearance requires creator inspection.",
  metric_contract:
    "Use the measured meter dimensions without scale changes; do not infer semantic clearances from the outer box.",
  realization_identity:
    "The declared whole or aggregate matches the visible asset composition; none is claimed to be a modular kit.",
  rights_contract: "The exact source rights record permits commercial use and redistribution.",
  semantic_identity:
    "The existing broad denotation is supported by visible identity; narrower names remain search descriptions rather than new semantic commitments.",
  source_integrity: "The retained source bytes match the exact measured content hash.",
  style_contract:
    "Muted rural materials and stylized silhouettes fit the reviewed valley palette; no substitution equivalence is asserted.",
};
const existingDecision = await readJson(`${output}/decision.json`).catch((error) => {
  if (error?.code !== "ENOENT") throw error;
  return undefined;
});
const decision = sealCatalogCreatorReviewDecision({
  packetHash: packet.hash,
  reviewer: {
    authority: "delegated_ai",
    reviewerId: "codex-showcase-curator",
    delegationStatement:
      "The creator explicitly requested another more complex and attractive region without primitive buildings, and instructed Codex to increase the catalog, use more variety and make the scene coherent. This bounded visual curation executes that request; the creator has not personally reviewed these assets.",
  },
  reviewMethod: "delegated_visual_review",
  reviewerStatement:
    "Codex inspected the selected asset images and measured evidence while curating Harvest Valley. These are scoped visual, semantic and ground-placement authoring decisions, not independent human review, engine verification, or automated model qualification.",
  reviewedAt: existingDecision?.reviewedAt ?? new Date().toISOString(),
  styleProfileDecision: "approved",
  decisions: packet.candidates.map((candidate) => {
    const spec = selection.assets.find(
      (item) => item.sourceContentHash === candidate.sourceContentHash,
    );
    return {
      sourceContentHash: candidate.sourceContentHash,
      outcome: "eligible",
      proposalApproved: true,
      criteria: criteria.map((criterion) => ({
        criterionId: criterion.criterionId,
        outcome: "pass",
        evidenceHashes: [
          ...new Set([
            candidate.assetHash,
            candidate.evidence.renderEvidenceHash,
            candidate.rights.evidenceHash,
          ]),
        ].sort(),
        note: `${notes[criterion.criterionId]} ${spec.scopeNote}`,
      })),
      note: `${spec.caption} ${spec.scopeNote}`,
    };
  }),
});
validateCatalogCreatorReviewDecision({ packet, decision, rubric });
const abstained = {
  status: "abstained",
  reason: "Not established by this bounded visible-description pass.",
};
const metadata = sealCatalogAuthoredMetadataBatch({
  batchId: `${selection.batchId}-descriptions`,
  sourceManifestHash: measurements.sourceManifestHash,
  measurementSetHash: searchMeasurements.hash,
  visualReviewIndexHash: renders.hash,
  producer: { authority: "delegated_ai", actorId: "codex-showcase-curator" },
  sourceArtifactHashes: [packet.hash, decision.hash].sort(),
  entries: records.map(({ spec, render }) => {
    const asset = searchMeasurements.assets.find(
      (item) => item.source.contentHash === spec.sourceContentHash,
    );
    if (!asset) throw new Error(`Missing searchable measurement: ${spec.handle}`);
    sealAssetMetricPromptSummary(asset);
    return {
      sourceContentHash: spec.sourceContentHash,
      measurementHash: asset.hash,
      renderEvidenceHash: render.evidence.hash,
      authoringCertainty: { status: "concrete" },
      metadata: sealCatalogSearchMetadata({
        caption: { status: "observed", value: spec.caption },
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
        issueNotes: { status: "observed", value: [spec.scopeNote] },
      }),
    };
  }),
});
await writeJson(`${output}/review-packet.json`, packet);
await writeJson(`${output}/decision.json`, decision);
await writeJson(metadataOutput, metadata);
console.log(
  JSON.stringify(
    {
      assets: records.length,
      packet: `${output}/review-packet.json`,
      decision: `${output}/decision.json`,
      metadata: metadataOutput,
    },
    null,
    2,
  ),
);

async function writeJson(path, value) {
  let expectedExistingHash;
  try {
    expectedExistingHash = createHash("sha256")
      .update(await readBoundedWorkspaceBytes(root, path))
      .digest("hex");
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("missing")) throw error;
  }
  await writeCanonicalWorkspaceJson(root, path, value, {
    maxBytes: 16 * 1024 * 1024,
    ...(expectedExistingHash ? { expectedExistingHash } : {}),
  });
}
