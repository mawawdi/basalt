import { z } from "zod";
import {
  ASCII_ID_SCHEMA,
  HASH_SCHEMA,
  compareCanonicalStrings,
  contentHash,
  deepFreezeJson,
  stableJson,
  type Diagnostic,
  type GateResult,
} from "@basalt/contracts";
import { CATALOG_RIGHTS_SCHEMA } from "./primitives.js";

export const SOURCE_ASSET_ROOT = "registry/source-assets/sha256";

const sourceRightsMaterial = CATALOG_RIGHTS_SCHEMA.omit({ evidenceHash: true });

export const SOURCE_PROVENANCE_RECORD_SCHEMA = z
  .object({
    sourceContentHash: HASH_SCHEMA,
    originId: ASCII_ID_SCHEMA,
    archivePaths: z.array(z.string().trim().min(1).max(4096)),
    originalPath: z.string().trim().min(1).max(4096),
    sourceKind: z.enum(["creator_owned", "licensed", "generated"]),
    metersPerSourceUnit: z.number().finite().positive(),
    rights: sourceRightsMaterial,
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyHash(value, context);
    assertCanonical(value.archivePaths, String, "provenance archive paths", context);
  });
export type SourceProvenanceRecord = z.output<typeof SOURCE_PROVENANCE_RECORD_SCHEMA>;

/** Bind compiler-visible rights to the content identity and effective claim,
 * never to an archive, vendor path, or individual provenance record. Multiple
 * origins carrying the same bytes and claim therefore leave this hash stable. */
export function sourceRightsEvidenceHash(
  input: Pick<SourceProvenanceRecord, "sourceContentHash" | "metersPerSourceUnit" | "rights">,
): string {
  return contentHash(
    stableJson({
      kind: "SourceRightsEvidence",
      sourceContentHash: HASH_SCHEMA.parse(input.sourceContentHash),
      metersPerSourceUnit: z.number().finite().positive().parse(input.metersPerSourceUnit),
      rights: sourceRightsMaterial.parse(input.rights),
    }),
  );
}

export function sealSourceProvenanceRecord(
  input: Omit<SourceProvenanceRecord, "hash">,
): SourceProvenanceRecord {
  const material = {
    ...input,
    archivePaths: canonical(input.archivePaths, String, "provenance archive paths"),
  };
  return deepFreezeJson(
    SOURCE_PROVENANCE_RECORD_SCHEMA.parse({
      ...material,
      hash: contentHash(stableJson(material)),
    }),
  );
}

export const SOURCE_PROVENANCE_LEDGER_SCHEMA = z
  .object({
    kind: z.literal("SourceProvenanceLedger"),
    records: z.array(SOURCE_PROVENANCE_RECORD_SCHEMA),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyHash(value, context);
    assertCanonical(value.records, (entry) => entry.hash, "source provenance records", context);
  });
export type SourceProvenanceLedger = z.output<typeof SOURCE_PROVENANCE_LEDGER_SCHEMA>;

export function sealSourceProvenanceLedger(
  records: readonly SourceProvenanceRecord[],
): SourceProvenanceLedger {
  const material = {
    kind: "SourceProvenanceLedger" as const,
    records: canonical(
      records.map((record) => SOURCE_PROVENANCE_RECORD_SCHEMA.parse(record)),
      (entry) => entry.hash,
      "source provenance records",
    ),
  };
  return deepFreezeJson(
    SOURCE_PROVENANCE_LEDGER_SCHEMA.parse({
      ...material,
      hash: contentHash(stableJson(material)),
    }),
  );
}

export const TRUSTED_SOURCE_MANIFEST_SCHEMA = z
  .object({
    kind: z.literal("TrustedSourceManifest"),
    rightsNotice: z.string().min(1).max(4096),
    assetRoot: z.literal(SOURCE_ASSET_ROOT),
    assets: z
      .array(
        z
          .object({
            contentHash: HASH_SCHEMA,
            relativePath: z.string().min(1).max(4096),
            metersPerSourceUnit: z.number().finite().positive(),
            rights: CATALOG_RIGHTS_SCHEMA,
          })
          .strict()
          .superRefine((value, context) => {
            const expected = sourceAssetRelativePath(value.contentHash);
            if (value.relativePath !== expected)
              context.addIssue({
                code: "custom",
                path: ["relativePath"],
                message: `Canonical source identity must live at ${expected}`,
              });
          }),
      )
      .min(1),
  })
  .strict()
  .superRefine((value, context) => {
    assertCanonical(value.assets, (entry) => entry.contentHash, "source identities", context);
    const paths = value.assets.map((entry) => entry.relativePath);
    if (new Set(paths).size !== paths.length)
      context.addIssue({ code: "custom", message: "Canonical source paths must be unique" });
  });
export type TrustedSourceManifest = z.output<typeof TRUSTED_SOURCE_MANIFEST_SCHEMA>;

export function sourceAssetRelativePath(contentHashValue: string): string {
  const hash = HASH_SCHEMA.parse(contentHashValue);
  return `${SOURCE_ASSET_ROOT}/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}.glb`;
}

export function validateSourceAuthority(input: {
  readonly manifest: unknown;
  readonly provenance: unknown;
}): GateResult<{ manifest: TrustedSourceManifest; provenance: SourceProvenanceLedger }> {
  const manifestResult = TRUSTED_SOURCE_MANIFEST_SCHEMA.safeParse(input.manifest);
  const provenanceResult = SOURCE_PROVENANCE_LEDGER_SCHEMA.safeParse(input.provenance);
  if (!manifestResult.success || !provenanceResult.success)
    return {
      status: "rejected",
      diagnostics: [
        diagnostic(
          "invalid_source_authority",
          [
            manifestResult.success ? "" : z.prettifyError(manifestResult.error),
            provenanceResult.success ? "" : z.prettifyError(provenanceResult.error),
          ]
            .filter(Boolean)
            .join("\n"),
        ),
      ],
    };
  const manifest = manifestResult.data;
  const provenance = provenanceResult.data;
  const issues: Diagnostic[] = [];
  const recordsBySource = new Map<string, SourceProvenanceRecord[]>();
  for (const record of provenance.records) {
    const sourceRecords = recordsBySource.get(record.sourceContentHash) ?? [];
    sourceRecords.push(record);
    recordsBySource.set(record.sourceContentHash, sourceRecords);
  }
  for (const [index, asset] of manifest.assets.entries()) {
    const sourceRecords = recordsBySource.get(asset.contentHash) ?? [];
    const effectiveRights = {
      licenseId: asset.rights.licenseId,
      commercialUsePermitted: asset.rights.commercialUsePermitted,
      redistributionPermitted: asset.rights.redistributionPermitted,
      attribution: asset.rights.attribution,
    };
    const expectedEvidenceHash = sourceRightsEvidenceHash({
      sourceContentHash: asset.contentHash,
      metersPerSourceUnit: asset.metersPerSourceUnit,
      rights: effectiveRights,
    });
    if (asset.rights.evidenceHash !== expectedEvidenceHash)
      issues.push(
        diagnostic(
          "rights_evidence_mismatch",
          `Rights evidence for source ${asset.contentHash} does not match its source-neutral claim`,
          [asset.rights.evidenceHash, expectedEvidenceHash],
          ["assets", index, "rights", "evidenceHash"],
        ),
      );
    if (!sourceRecords.some((record) => sourceRightsEvidenceHash(record) === expectedEvidenceHash))
      issues.push(
        diagnostic(
          "invalid_rights_provenance",
          `Source ${asset.contentHash} lacks provenance supporting its exact rights claim`,
          [asset.rights.evidenceHash, ...sourceRecords.map((record) => record.hash)],
          ["assets", index, "rights", "evidenceHash"],
        ),
      );
    const expectedRights = stableJson(effectiveRights);
    if (sourceRecords.some((record) => stableJson(record.rights) !== expectedRights))
      issues.push(
        diagnostic(
          "conflicting_source_rights",
          `Provenance records disagree about effective rights for source ${asset.contentHash}`,
          sourceRecords.map((record) => record.hash),
          ["assets", index, "rights"],
        ),
      );
    if (sourceRecords.some((record) => record.metersPerSourceUnit !== asset.metersPerSourceUnit))
      issues.push(
        diagnostic(
          "conflicting_source_scale",
          `Provenance records disagree about metric scale for source ${asset.contentHash}`,
          sourceRecords.map((record) => record.hash),
          ["assets", index, "metersPerSourceUnit"],
        ),
      );
  }
  const sourceHashes = new Set(manifest.assets.map((asset) => asset.contentHash));
  for (const record of provenance.records)
    if (!sourceHashes.has(record.sourceContentHash))
      issues.push(
        diagnostic(
          "orphaned_source_provenance",
          `Provenance record ${record.hash} names an unknown source identity`,
          [record.hash],
        ),
      );
  if (issues.length > 0)
    return {
      status: "rejected",
      diagnostics: issues.sort((left, right) =>
        compareCanonicalStrings(stableJson(left), stableJson(right)),
      ),
    };
  return { status: "eligible", value: { manifest, provenance }, diagnostics: [] };
}

function canonical<T>(values: readonly T[], key: (value: T) => string, label: string): T[] {
  const result = [...values].sort((left, right) => compareCanonicalStrings(key(left), key(right)));
  if (new Set(result.map(key)).size !== result.length) throw new Error(`${label} must be unique`);
  return result;
}

function assertCanonical<T>(
  values: readonly T[],
  key: (value: T) => string,
  label: string,
  context: z.RefinementCtx,
): void {
  const keys = values.map(key);
  if (
    new Set(keys).size !== keys.length ||
    stableJson([...keys].sort(compareCanonicalStrings)) !== stableJson(keys)
  )
    context.addIssue({ code: "custom", message: `${label} must be unique and canonical` });
}

function verifyHash(value: Record<string, unknown>, context: z.RefinementCtx): void {
  const material = { ...value };
  delete material.hash;
  if (contentHash(stableJson(material)) !== value.hash)
    context.addIssue({ code: "custom", path: ["hash"], message: "Artifact hash mismatch" });
}

function diagnostic(
  code: string,
  message: string,
  evidenceHashes: readonly string[] = [],
  path: readonly (string | number)[] = [],
): Diagnostic {
  return {
    code,
    message,
    evidenceHashes: [...evidenceHashes].sort(compareCanonicalStrings),
    path: [...path],
  };
}
