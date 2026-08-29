import {
  ImmutableBinaryArtifactStore,
  ImmutableJsonArtifactStore,
} from "../../artifact-store/src/index.js";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import {
  PREPARED_ASSET_LINEAGE_REPORT_SCHEMA,
  PREPARED_ASSET_MATERIAL_REPORT_SCHEMA,
  prepareAdaptedAsset,
} from "./finish.js";
import { PREPARED_ASSET_SCHEMA, type PreparedAsset } from "./contracts.js";

/**
 * Reload every retained source, report, mesh, rights record, and preview through
 * the common finisher, then require the independently reconstructed manifest to
 * match the supplied identity exactly.
 */
export async function verifyPreparedAsset(
  store: ImmutableBinaryArtifactStore,
  value: unknown,
): Promise<PreparedAsset> {
  const manifest = PREPARED_ASSET_SCHEMA.parse(value);
  const { hash, ...material } = manifest;
  if (contentHash(stableJson(material)) !== hash)
    throw new Error("Prepared asset manifest identity is invalid");

  const jsonStore = new ImmutableJsonArtifactStore(store.root);
  const [geometryReport, materialReportValue, previewReport, lineageReportValue, finishingReport] =
    await Promise.all([
      jsonStore.read(manifest.preparation.geometryReportArtifact),
      jsonStore.read(manifest.preparation.materialReportArtifact),
      jsonStore.read(manifest.preparation.previewReportArtifact),
      jsonStore.read(manifest.lineage.lineageArtifact),
      jsonStore.read(manifest.preparation.finishingReportArtifact),
    ]);
  const lineageReport = PREPARED_ASSET_LINEAGE_REPORT_SCHEMA.parse(lineageReportValue);
  const materialReport = PREPARED_ASSET_MATERIAL_REPORT_SCHEMA.parse(materialReportValue);

  if (
    lineageReport.candidate.sourceCandidate.hash !== manifest.lineage.sourceCandidateHash ||
    lineageReport.candidate.hash !== manifest.lineage.adaptedCandidateHash ||
    lineageReport.intent.hash !== manifest.requirementHash ||
    materialReport.sourceCandidateHash !== manifest.lineage.sourceCandidateHash ||
    materialReport.adaptedCandidateHash !== manifest.lineage.adaptedCandidateHash ||
    materialReport.intentHash !== manifest.requirementHash
  )
    throw new Error("Prepared asset reports differ from the manifest identity");

  const rebuilt = await prepareAdaptedAsset({
    store,
    candidate: lineageReport.candidate,
    intent: lineageReport.intent,
    previews: manifest.previews.map(({ view, artifact }) => ({ view, artifact })),
    requiredTextureChannels: materialReport.requiredTextureChannels,
    finisherWorkerHash: manifest.preparation.finisherWorkerHash,
    finisherQualificationHash: manifest.preparation.finisherQualificationHash,
  });
  if (stableJson(rebuilt.manifest) !== stableJson(manifest))
    throw new Error("Prepared asset metadata differs from independently reconstructed artifacts");

  // The rebuild compares canonical report contents. These reads occur first so
  // a missing or corrupt claimed report cannot be recreated during verification.
  void geometryReport;
  void previewReport;
  void finishingReport;
  return manifest;
}
