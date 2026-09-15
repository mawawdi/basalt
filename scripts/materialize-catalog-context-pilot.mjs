import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { readBoundedWorkspaceBytes, writeCanonicalWorkspaceJson } from "@basalt/artifact-store";
import {
  CATALOG_CONTEXT_REQUEST_SET_SCHEMA,
  CATALOG_VISUAL_REVIEW_INDEX_SCHEMA,
  assessConstructionEligibility,
  sealCatalogContextReceiptSet,
  sealConstructionEligibilitySet,
} from "@basalt/catalog-authoring";
import { CATALOG_MEASUREMENT_SET_SCHEMA } from "@basalt/catalog-model";
import { contentHash, stableJson } from "@basalt/contracts";

const execFile = promisify(execFileCallback);
const repositoryRoot = resolve(".");
const outputRoot = ".basalt/catalog/context/modular-pilot";
const requestPath = `${outputRoot}/requests.json`;
const selectedSourceContentHashes = [
  "5df5494dad4fd2b2dc30dd9bba91d5d6fcc80f9826ebd603d900245608dee648",
  "60ab5107dc562db4b335ac0bcb4032296772a914ecd4d3f70127a5c8b4a008cc",
  "6a491e8289091a4320dd3ee208fa26c65c60587fdc81c4e0d8f2ccc5050596e4",
  "b792ad066eec6f607ea2754988729b689532547dbe8ad0b6693d52f474476c7b",
].sort();

await execFile(
  process.execPath,
  [
    "bin/basalt.js",
    "catalog",
    "context",
    "prepare",
    "--sources",
    selectedSourceContentHashes.join(","),
    "--limit",
    "1",
    "--output",
    requestPath,
  ],
  { cwd: repositoryRoot, maxBuffer: 16 * 1024 * 1024 },
);

const [requestSet, measurements, renders, provenance] = await Promise.all([
  readJson(requestPath).then((value) => CATALOG_CONTEXT_REQUEST_SET_SCHEMA.parse(value)),
  readJson(".basalt/catalog/measurements.json").then((value) =>
    CATALOG_MEASUREMENT_SET_SCHEMA.parse(value),
  ),
  readJson(".basalt/catalog/review/index.json").then((value) =>
    CATALOG_VISUAL_REVIEW_INDEX_SCHEMA.parse(value),
  ),
  readJson("registry/source-provenance.json"),
]);
if (requestSet.requests.length !== 1)
  throw new Error("The modular context pilot must contain exactly one bounded request");
const request = requestSet.requests[0];
if (
  stableJson(request.candidates.map((entry) => entry.sourceContentHash)) !==
  stableJson(selectedSourceContentHashes)
)
  throw new Error("The modular context request does not contain the exact selected sources");

const receiptSet = sealCatalogContextReceiptSet({
  requestSet,
  receipts: [],
  diagnostics: [
    "No context model was executed: attributed assembly purpose and compatible mate evidence are absent",
  ],
});
const assetBySource = new Map(
  measurements.assets.map((asset) => [asset.source.contentHash, asset]),
);
const assessments = selectedSourceContentHashes.map((sourceContentHash) => {
  const asset = assetBySource.get(sourceContentHash);
  if (!asset) throw new Error(`Missing measured modular pilot source ${sourceContentHash}`);
  return assessConstructionEligibility({ asset });
});
const eligibility = sealConstructionEligibilitySet({
  measurementSetHash: measurements.hash,
  contextReceiptSetHash: receiptSet.hash,
  assessments,
  diagnostics: [
    "Review abstains on assembly purpose, mate relationships, and socket compatibility pending attributed evidence",
  ],
});
if (
  receiptSet.status !== "incomplete" ||
  receiptSet.receipts.length !== 0 ||
  receiptSet.missingRequestHashes.length !== 1 ||
  eligibility.status !== "incomplete" ||
  eligibility.assessments.some((entry) => entry.status !== "incomplete")
)
  throw new Error("The no-evidence modular pilot must remain explicitly incomplete");

const renderBySource = new Map(renders.items.map((entry) => [entry.sourceContentHash, entry]));
const provenanceBySource = new Map(
  provenance.records.map((entry) => [entry.sourceContentHash, entry]),
);
const reviewEvidence = request.candidates.map((candidate) => {
  const render = renderBySource.get(candidate.sourceContentHash);
  const source = provenanceBySource.get(candidate.sourceContentHash);
  if (!render || !source)
    throw new Error(`Missing review evidence for ${candidate.sourceContentHash}`);
  return {
    sourceContentHash: candidate.sourceContentHash,
    sourcePathHint: source.originalPath,
    measurementHash: candidate.measurementHash,
    renderEvidenceHash: candidate.renderEvidenceHash,
    contactSheetRelativePath: render.contactSheetRelativePath,
    contactSheetContentHash: candidate.contactSheetContentHash,
    partCount: candidate.parts.length,
    measuredSockets: candidate.sockets.map((socket) => ({
      socketId: socket.socketId,
      evidenceHash: socket.evidenceHash,
    })),
  };
});
const statusBody = {
  kind: "CatalogModularContextPilotStatus",
  status: "incomplete",
  requestSetHash: requestSet.hash,
  receiptSetHash: receiptSet.hash,
  eligibilitySetHash: eligibility.hash,
  candidateCount: request.candidates.length,
  attributedAssemblyEvidenceCount: request.attributedAssemblyEvidence.length,
  modelRuns: 0,
  reviewEvidence,
  unresolved: [
    "assembly purpose",
    "compatible mate relationships",
    "whether measured sockets represent intended modular interfaces",
  ],
  authority: "non_authoritative_review_evidence",
};
const status = { ...statusBody, hash: contentHash(stableJson(statusBody)) };

await Promise.all([
  writeGeneratedJson(`${outputRoot}/receipts.json`, receiptSet),
  writeGeneratedJson(`${outputRoot}/review.json`, eligibility),
  writeGeneratedJson(`${outputRoot}/status.json`, status),
]);
await writeFile(resolve(repositoryRoot, `${outputRoot}/README.md`), readme(status), "utf8");

process.stdout.write(
  `${JSON.stringify(
    {
      status: status.status,
      candidates: status.candidateCount,
      modelRuns: status.modelRuns,
      requestSetHash: status.requestSetHash,
      receiptSetHash: status.receiptSetHash,
      eligibilitySetHash: status.eligibilitySetHash,
      unresolved: status.unresolved,
      outputRoot,
    },
    null,
    2,
  )}\n`,
);

function readme(status) {
  const rows = status.reviewEvidence
    .map(
      (entry) =>
        `- \`${entry.sourceContentHash}\`: \`${entry.sourcePathHint}\`; contact sheet \`${entry.contactSheetRelativePath}\`; ${entry.measuredSockets.length} measured socket(s).`,
    )
    .join("\n");
  return (
    `# Bounded modular-context pilot\n\n` +
    `Status: **incomplete**. This is one four-source, evidence-bound review request. No model ran and no component role, mate relationship, or assembly purpose is asserted. Measured sockets remain geometric observations, not proof that two sources mate.\n\n` +
    `${rows}\n\n` +
    `To proceed, supply attributed assembly evidence with exact members and evidence hashes, rerun \`catalog context prepare --assembly-evidence <file>\`, and only then execute the context interpreter. Any resulting hypothesis remains non-authoritative review evidence.\n`
  );
}

async function readJson(path) {
  return JSON.parse(await readFile(resolve(repositoryRoot, path), "utf8"));
}

async function writeGeneratedJson(path, value) {
  let expectedExistingHash;
  try {
    const current = await readBoundedWorkspaceBytes(repositoryRoot, path);
    expectedExistingHash = createHash("sha256").update(current).digest("hex");
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("missing")) throw error;
  }
  return writeCanonicalWorkspaceJson(repositoryRoot, path, value, {
    maxBytes: 128 * 1024 * 1024,
    ...(expectedExistingHash ? { expectedExistingHash } : {}),
  });
}
