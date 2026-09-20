import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
  readBoundedWorkspaceBytes,
  readBoundedWorkspaceJson,
  writeCanonicalWorkspaceJson,
} from "@basalt/artifact-store";
import {
  CATALOG_EMBEDDING_MATRIX_SCHEMA,
  CATALOG_AUTHORITY_COMMIT_SCHEMA,
  CATALOG_SEARCH_INDEX_SCHEMA,
  CATALOG_SEARCH_METADATA_REQUEST_SET_SCHEMA,
  CATALOG_SEARCH_METADATA_SET_SCHEMA,
  CATALOG_SOURCE_NAME_HINT_SET_SCHEMA,
  CATALOG_VISUAL_REVIEW_INDEX_SCHEMA,
} from "@basalt/catalog-authoring";
import {
  CATALOG_DISPOSITION_SCHEMA,
  CATALOG_MEASUREMENT_SET_SCHEMA,
  SOURCE_PROVENANCE_LEDGER_SCHEMA,
  TRUSTED_SOURCE_MANIFEST_SCHEMA,
  validateSourceAuthority,
} from "@basalt/catalog-model";
import { contentHash, stableJson } from "@basalt/contracts";
import { ROBLOX_ASSET_BINDING_SCHEMA, ROBLOX_ASSET_UPLOAD_LEDGER_SCHEMA } from "@basalt/roblox";
import { verifyRobloxUploadEvidence } from "./verify-roblox-upload-evidence.mjs";

const repositoryRoot = resolve(".");
const outputPath = ".basalt/catalog/readiness.json";
const maximumJsonBytes = 512 * 1024 * 1024;
const concurrency = 4;

const [sourceManifest, provenance, measurements, renders, dispositions, catalog] =
  await Promise.all([
    readJson("registry/source-manifest.json", TRUSTED_SOURCE_MANIFEST_SCHEMA),
    readJson("registry/source-provenance.json", SOURCE_PROVENANCE_LEDGER_SCHEMA),
    readJson(".basalt/catalog/measurements.json", CATALOG_MEASUREMENT_SET_SCHEMA),
    readJson(".basalt/catalog/review/index.json", CATALOG_VISUAL_REVIEW_INDEX_SCHEMA),
    readJson("registry/dispositions.json", CATALOG_DISPOSITION_SCHEMA.array()),
    readJson("registry/catalog.json", CATALOG_AUTHORITY_COMMIT_SCHEMA),
  ]);

const sourceManifestHash = contentHash(stableJson(sourceManifest));
const sourceAuthority = validateSourceAuthority({ manifest: sourceManifest, provenance });
const sourceChecks = sourceManifest.assets.map((asset) => ({
  path: asset.relativePath,
  expectedHash: asset.contentHash,
  expectedBytes: measurements.assets.find((entry) => entry.source.contentHash === asset.contentHash)
    ?.source.sourceArtifact?.bytes,
}));
const sourceBinaryValidation = await validateFiles(sourceChecks);

const measuredSources = new Set(measurements.assets.map((asset) => asset.source.contentHash));
const manifestSources = new Set(sourceManifest.assets.map((asset) => asset.contentHash));
const measurementLineageFailures = measurements.assets.flatMap((asset) => {
  const descriptor = asset.source.sourceArtifact;
  return [
    ...(!manifestSources.has(asset.source.contentHash)
      ? [`Unknown measured source ${asset.source.contentHash}`]
      : []),
    ...(descriptor?.artifactHash !== asset.source.contentHash
      ? [`Measurement ${asset.hash} does not bind its source bytes`]
      : []),
  ];
});
for (const sourceHash of manifestSources)
  if (!measuredSources.has(sourceHash))
    measurementLineageFailures.push(`Source ${sourceHash} has no measurement`);

const renderSources = new Set(renders.items.map((item) => item.sourceContentHash));
const renderLineageFailures = [];
const renderChecks = [];
let contactSheetCount = 0;
for (const item of renders.items) {
  if (!manifestSources.has(item.sourceContentHash))
    renderLineageFailures.push(`Unknown rendered source ${item.sourceContentHash}`);
  const evidenceByView = new Map(item.evidence.views.map((view) => [view.viewId, view]));
  for (const artifact of item.viewArtifacts) {
    const evidence = evidenceByView.get(artifact.viewId);
    if (!evidence) {
      renderLineageFailures.push(
        `Render ${item.sourceContentHash} lacks evidence for ${artifact.viewId}`,
      );
      continue;
    }
    renderChecks.push(
      { path: artifact.rgbRelativePath, expectedHash: evidence.rgbHash },
      { path: artifact.silhouetteRelativePath, expectedHash: evidence.silhouetteHash },
      {
        path: artifact.normalizedDepthRelativePath,
        expectedHash: evidence.normalizedDepthHash,
      },
      { path: artifact.surfaceNormalRelativePath, expectedHash: evidence.surfaceNormalHash },
      {
        path: artifact.unlitBaseColorRelativePath,
        expectedHash: evidence.unlitBaseColorHash,
      },
    );
  }
  const contactSheet = await inspectRegularFile(item.contactSheetRelativePath);
  if (contactSheet.ok) contactSheetCount += 1;
  else renderLineageFailures.push(contactSheet.diagnostic);
}
for (const sourceHash of manifestSources)
  if (!renderSources.has(sourceHash))
    renderLineageFailures.push(`Source ${sourceHash} has no render`);
const renderBinaryValidation = await validateFiles(renderChecks);

const sourceNames = await optionalParsedJson(
  ".basalt/catalog/metadata/source-name-hints.json",
  CATALOG_SOURCE_NAME_HINT_SET_SCHEMA,
);
const defaultSearch = await optionalParsedJson(
  ".basalt/catalog/search/index.json",
  CATALOG_SEARCH_INDEX_SCHEMA,
);
const metadataRequests = await optionalParsedJson(
  ".basalt/catalog/metadata/requests.json",
  CATALOG_SEARCH_METADATA_REQUEST_SET_SCHEMA,
);
const metadataSet = await optionalParsedJson(
  ".basalt/catalog/metadata/set.json",
  CATALOG_SEARCH_METADATA_SET_SCHEMA,
);
const robloxUploads = await optionalParsedJson(
  ".basalt/roblox/asset-uploads.json",
  ROBLOX_ASSET_UPLOAD_LEDGER_SCHEMA,
);
const robloxBindings = await optionalParsedJson(
  ".basalt/roblox/asset-bindings.json",
  ROBLOX_ASSET_BINDING_SCHEMA.array(),
);
const robloxUploadEvidenceFailures = [];
if (robloxUploads.current)
  try {
    await verifyRobloxUploadEvidence(repositoryRoot, robloxUploads.value);
  } catch (error) {
    robloxUploadEvidenceFailures.push(error instanceof Error ? error.message : String(error));
  }
const robloxPublicationsBySource = new Map(
  (robloxUploads.current ? robloxUploads.value.uploads : []).map((entry) => [
    entry.sourceArtifactHash,
    entry,
  ]),
);
const robloxPublicationStatus = !robloxUploads.current
  ? "missing_or_stale"
  : robloxUploadEvidenceFailures.length > 0
    ? "rejected"
    : robloxUploads.value.uploads.length > 0 &&
        robloxUploads.value.uploads.every((entry) => entry.status === "eligible")
      ? "eligible"
      : robloxUploads.value.uploads.some(
            (entry) => entry.status === "rejected" || entry.status === "failed",
          )
        ? "rejected"
        : "incomplete";
const robloxBindingLineageFailures = robloxBindings.current
  ? robloxBindings.value.flatMap((binding) => {
      const publication = robloxPublicationsBySource.get(binding.sourceArtifactHash);
      return robloxUploadEvidenceFailures.length === 0 &&
        publication?.status === "eligible" &&
        publication.robloxAssetId === binding.robloxAssetId &&
        publication.uploadArtifact.artifactHash === binding.uploadArtifactHash &&
        publication.uploadHash === binding.publicationEvidenceHash
        ? []
        : [`Binding ${binding.assetHash} lacks its exact eligible publication receipt`];
    })
  : [];
const matrixPaths = (await listFiles(".basalt/catalog/search")).filter((path) =>
  /(?:image-text|shape)-matrix\.json$/u.test(path),
);
const validMatrices = [];
const staleMatrices = [];
const matrixBinaryChecks = [];
for (const path of matrixPaths) {
  const parsed = await optionalParsedJson(path, CATALOG_EMBEDDING_MATRIX_SCHEMA);
  if (!parsed.current) {
    staleMatrices.push({ path, reason: parsed.reason });
    continue;
  }
  validMatrices.push({ path, hash: parsed.value.hash, purpose: parsed.value.purpose });
  matrixBinaryChecks.push({
    path: `.basalt/cas/binary-artifacts/${parsed.value.blob.contentHash}.bin`,
    expectedHash: parsed.value.blob.contentHash,
    expectedBytes: parsed.value.blob.sizeBytes,
  });
}
const matrixBinaryValidation = await validateFiles(matrixBinaryChecks);

const legacyMetadataRoots = [
  ".basalt/catalog/metadata/sets/baseline-selection.json",
  ".basalt/catalog/metadata/sets/challenger-selection.json",
  ".basalt/catalog/metadata/evaluation/baseline-selection.json",
  ".basalt/catalog/metadata/evaluation/challenger-selection.json",
];
const staleArtifacts = [...staleMatrices];
for (const path of legacyMetadataRoots) {
  const parsed = await optionalParsedJson(path, CATALOG_SEARCH_METADATA_SET_SCHEMA);
  if (!parsed.current && parsed.reason !== "missing")
    staleArtifacts.push({ path, reason: "superseded metadata/evaluation contract" });
}
for (const [path, parsed] of [
  [".basalt/catalog/metadata/source-name-hints.json", sourceNames],
  [".basalt/catalog/search/index.json", defaultSearch],
  [".basalt/catalog/metadata/requests.json", metadataRequests],
  [".basalt/catalog/metadata/set.json", metadataSet],
])
  if (!parsed.current && parsed.reason !== "missing")
    staleArtifacts.push({ path, reason: parsed.reason });

const dispositionCounts = Object.fromEntries(
  ["eligible", "incomplete", "rejected"].map((status) => [
    status,
    dispositions.filter((entry) => entry.status === status).length,
  ]),
);
const gaps = [
  ...(catalog.declarations.length === 0 ? ["No catalog entry declarations are admitted"] : []),
  ...(catalog.assertions.length === 0 ? ["No admitted semantic assertion bundles exist"] : []),
  ...(dispositionCounts.eligible === 0 ? ["No source disposition is eligible"] : []),
  ...(!metadataSet.current ? ["No current compact metadata set is available"] : []),
  ...(validMatrices.length === 0 ? ["No current learned embedding matrix is available"] : []),
  ...(!robloxUploads.current ? ["No Roblox asset publication ledger exists"] : []),
  ...(robloxPublicationStatus === "rejected"
    ? [
        "Some Roblox asset publications are rejected, failed, or lack exact retained payload evidence",
      ]
    : robloxPublicationStatus === "incomplete"
      ? ["Some Roblox asset publications are incomplete"]
      : []),
  ...(!robloxBindings.current ? ["No Roblox asset-binding registry exists"] : []),
  ...(robloxBindingLineageFailures.length > 0
    ? ["Some Roblox asset bindings lack exact eligible publication evidence"]
    : []),
  ...(sourceBinaryValidation.invalid > 0 ? ["Some source binaries failed hash validation"] : []),
  ...(renderBinaryValidation.invalid > 0 ? ["Some render artifacts failed hash validation"] : []),
  ...(matrixBinaryValidation.invalid > 0
    ? ["Some referenced embedding matrix blobs failed hash validation"]
    : []),
];

const material = {
  kind: "CatalogReadinessReport",
  status: gaps.length === 0 ? "eligible" : "incomplete",
  source: {
    manifestHash: sourceManifestHash,
    provenanceHash: provenance.hash,
    authorityStatus: sourceAuthority.status,
    identities: sourceManifest.assets.length,
    validatedBinaries: sourceBinaryValidation.valid,
    invalidBinaries: sourceBinaryValidation.invalid,
    failures: sourceBinaryValidation.failures,
  },
  measurements: {
    hash: measurements.hash,
    status: measurements.status,
    sourceManifestHash: measurements.sourceManifestHash,
    records: measurements.assets.length,
    exactSourceCoverage:
      measuredSources.size === manifestSources.size && measurementLineageFailures.length === 0,
    lineageFailures: measurementLineageFailures,
  },
  renders: {
    hash: renders.hash,
    status: renders.status,
    sourceManifestHash: renders.sourceManifestHash,
    records: renders.items.length,
    contactSheets: contactSheetCount,
    referencedFiles: renderChecks.length,
    validatedFiles: renderBinaryValidation.valid,
    invalidFiles: renderBinaryValidation.invalid,
    lineageFailures: [...renderLineageFailures, ...renderBinaryValidation.failures],
  },
  search: {
    sourceNameHints: sourceNames.current
      ? {
          status: sourceNames.value.status,
          records: sourceNames.value.items.length,
          hash: sourceNames.value.hash,
        }
      : { status: "missing_or_stale", reason: sourceNames.reason },
    defaultIndex: defaultSearch.current
      ? {
          status: defaultSearch.value.status,
          documents: defaultSearch.value.documents.length,
          coverage: defaultSearch.value.coverage,
          hash: defaultSearch.value.hash,
        }
      : { status: "missing_or_stale", reason: defaultSearch.reason },
    metadataRequests: metadataRequests.current
      ? {
          status: metadataRequests.value.status,
          scope: metadataRequests.value.scope,
          requests: metadataRequests.value.requests.length,
          hash: metadataRequests.value.hash,
        }
      : { status: "missing_or_stale", reason: metadataRequests.reason },
    metadataSet: metadataSet.current
      ? {
          status: metadataSet.value.status,
          receipts: metadataSet.value.receipts.length,
          hash: metadataSet.value.hash,
        }
      : { status: "missing_or_stale", reason: metadataSet.reason },
    embeddingMatrices: validMatrices,
    validatedMatrixBlobs: matrixBinaryValidation.valid,
    invalidMatrixBlobs: matrixBinaryValidation.invalid,
  },
  authority: {
    commitHash: catalog.hash,
    status: catalog.status,
    declarations: catalog.declarations.length,
    assertions: catalog.assertions.length,
    entries: catalog.snapshot.entries.length,
    dispositions: dispositionCounts,
  },
  roblox: {
    publications: robloxUploads.current
      ? {
          status: robloxPublicationStatus,
          creator: robloxUploads.value.creator,
          records: robloxUploads.value.uploads.length,
          states: Object.fromEntries(
            ["pending_operation", "pending_moderation", "eligible", "rejected", "failed"].map(
              (status) => [
                status,
                robloxUploads.value.uploads.filter((entry) => entry.status === status).length,
              ],
            ),
          ),
          hash: robloxUploads.value.ledgerHash,
          evidenceFailures: robloxUploadEvidenceFailures,
        }
      : { status: "missing_or_stale", reason: robloxUploads.reason },
    bindings: robloxBindings.current
      ? {
          status: robloxBindingLineageFailures.length === 0 ? "eligible" : "rejected",
          records: robloxBindings.value.length,
          hash: contentHash(stableJson(robloxBindings.value)),
          lineageFailures: robloxBindingLineageFailures,
        }
      : { status: "missing_or_stale", reason: robloxBindings.reason },
  },
  reusableEvidence: [
    { kind: "source_assets", count: sourceBinaryValidation.valid, hash: sourceManifestHash },
    { kind: "measurements", count: measurements.assets.length, hash: measurements.hash },
    { kind: "renders", count: renders.items.length, hash: renders.hash },
    ...(sourceNames.current
      ? [
          {
            kind: "source_name_hints",
            count: sourceNames.value.items.length,
            hash: sourceNames.value.hash,
          },
        ]
      : []),
    ...(validMatrices.length > 0
      ? [
          {
            kind: "embedding_matrices",
            count: validMatrices.length,
            hash: contentHash(stableJson(validMatrices)),
          },
        ]
      : []),
    ...(robloxUploads.current
      ? [
          {
            kind: "roblox_asset_publications",
            count: robloxUploads.value.uploads.filter((entry) => entry.status === "eligible")
              .length,
            hash: robloxUploads.value.ledgerHash,
          },
        ]
      : []),
  ],
  staleArtifacts: staleArtifacts.sort((left, right) => left.path.localeCompare(right.path)),
  gaps: gaps.sort(),
  compilerAuthority: false,
};
const report = { ...material, hash: contentHash(stableJson(material)) };
let expectedExistingHash;
try {
  expectedExistingHash = sha256(
    await readBoundedWorkspaceBytes(repositoryRoot, outputPath, maximumJsonBytes),
  );
} catch (error) {
  if (!(error instanceof Error) || !error.message.includes("missing")) throw error;
}
await writeCanonicalWorkspaceJson(repositoryRoot, outputPath, report, {
  maxBytes: maximumJsonBytes,
  ...(expectedExistingHash ? { expectedExistingHash } : {}),
});
process.stdout.write(
  `${JSON.stringify({ status: report.status, output: outputPath, ...report }, null, 2)}\n`,
);

async function readJson(path, schema) {
  return schema.parse(await readBoundedWorkspaceJson(repositoryRoot, path, maximumJsonBytes));
}

async function optionalParsedJson(path, schema) {
  try {
    const raw = await readBoundedWorkspaceJson(repositoryRoot, path, maximumJsonBytes);
    const parsed = schema.safeParse(raw);
    return parsed.success
      ? { current: true, value: parsed.data }
      : { current: false, reason: "schema_or_hash_mismatch" };
  } catch (error) {
    if (error instanceof Error && error.message.includes("missing"))
      return { current: false, reason: "missing" };
    return { current: false, reason: "unreadable" };
  }
}

async function validateFiles(checks) {
  let valid = 0;
  let invalid = 0;
  const failures = [];
  await mapLimit(checks, concurrency, async (check) => {
    try {
      const info = await inspectRegularFile(check.path);
      if (!info.ok) throw new Error(info.diagnostic);
      if (check.expectedBytes !== undefined && info.bytes !== check.expectedBytes)
        throw new Error(`Byte size mismatch for ${check.path}`);
      const actualHash = await hashFile(check.path);
      if (actualHash !== check.expectedHash)
        throw new Error(`Content hash mismatch for ${check.path}`);
      valid += 1;
    } catch (error) {
      invalid += 1;
      failures.push(String(error));
    }
  });
  return { valid, invalid, failures };
}

async function inspectRegularFile(path) {
  try {
    const destination = resolve(repositoryRoot, path);
    const resolved = await realpath(destination);
    if (resolved !== repositoryRoot && !resolved.startsWith(`${repositoryRoot}/`))
      return { ok: false, diagnostic: `Path escapes workspace: ${path}` };
    const information = await lstat(destination);
    if (!information.isFile() || information.isSymbolicLink())
      return { ok: false, diagnostic: `Path is not a regular no-follow file: ${path}` };
    return { ok: true, bytes: information.size };
  } catch (error) {
    return { ok: false, diagnostic: `Unreadable artifact ${path}: ${String(error)}` };
  }
}

async function hashFile(path) {
  const hash = createHash("sha256");
  const stream = createReadStream(resolve(repositoryRoot, path));
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

async function listFiles(path) {
  const result = [];
  const visit = async (relative) => {
    for (const entry of await readdir(resolve(repositoryRoot, relative), {
      withFileTypes: true,
    }).catch((error) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    })) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile() && !entry.isSymbolicLink()) result.push(child);
    }
  };
  await visit(path);
  return result.sort();
}

async function mapLimit(values, limit, operation) {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, async () => {
      while (cursor < values.length) {
        const index = cursor;
        cursor += 1;
        await operation(values[index], index);
      }
    }),
  );
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
