import { z } from "zod";
import {
  SOURCE_PROVENANCE_LEDGER_SCHEMA,
  TRUSTED_SOURCE_MANIFEST_SCHEMA,
  validateSourceAuthority,
  type SourceProvenanceLedger,
  type TrustedSourceManifest,
} from "@basalt/catalog-model";
import { COMPILATION_STATUS_SCHEMA, HASH_SCHEMA, contentHash, stableJson } from "@basalt/contracts";
import {
  canonicalValues,
  requireCanonicalValues,
  sealArtifact,
  verifyArtifactHash,
} from "./artifact.js";

const NORMALIZER_POLICY = Object.freeze({
  input: "basename_only",
  unicodeNormalization: "NFKD",
  caseNormalization: "unicode_default_lowercase",
  tokenAlphabet: "ascii_alphanumeric",
  boundaries: ["camel_case", "punctuation", "letter_digit"],
  ignoredSuffixes: ["glb_extension", "extraction_collision_hash"],
});

const EXPLICIT_COLLISION_SUFFIX = /(?:^|[_-])collision(?:--[a-f0-9]{12,64})?\.glb$/iu;

/** The one source-name convention allowed to determine a technical role. Every
 * observed filename must agree so content reused under a renderable name is not
 * silently converted into collision-only geometry. */
export function sourceFilenameObservationsIdentifyCollisionCompanion(
  observations: readonly string[],
): boolean {
  return (
    observations.length > 0 && observations.every((value) => EXPLICIT_COLLISION_SUFFIX.test(value))
  );
}

/**
 * Name hints are weak supervision for authoring only. This hash identifies the
 * exact deterministic normalization policy; it is not semantic evidence and
 * can never satisfy a catalog or compiler requirement.
 */
export const SOURCE_NAME_HINT_NORMALIZER_IMPLEMENTATION_HASH = contentHash(
  stableJson(NORMALIZER_POLICY),
);

const SOURCE_NAME_TOKEN_SCHEMA = z
  .string()
  .regex(/^[a-z0-9]+$/u)
  .max(256);

export const CATALOG_SOURCE_NAME_HINT_OBSERVATION_SCHEMA = z
  .object({
    originalFilename: z
      .string()
      .trim()
      .min(1)
      .max(4096)
      .refine((value) => !/[\\/]/u.test(value), "A filename observation cannot contain a path"),
    normalizedStem: z.string().max(4096),
    tokens: z.array(SOURCE_NAME_TOKEN_SCHEMA).max(256),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.normalizedStem !== value.tokens.join(" "))
      context.addIssue({
        code: "custom",
        path: ["normalizedStem"],
        message: "Normalized source-name stem must be the canonical token sequence",
      });
  });
export type CatalogSourceNameHintObservation = z.output<
  typeof CATALOG_SOURCE_NAME_HINT_OBSERVATION_SCHEMA
>;

export const CATALOG_SOURCE_NAME_HINT_SCHEMA = z
  .object({
    kind: z.literal("CatalogSourceNameHint"),
    sourceContentHash: HASH_SCHEMA,
    normalizerImplementationHash: HASH_SCHEMA,
    interpretation: z.enum(["single_normalized_name", "multiple_normalized_names"]),
    observations: z.array(CATALOG_SOURCE_NAME_HINT_OBSERVATION_SCHEMA).min(1).max(256),
    diagnostics: z.array(z.string().trim().min(1).max(2048)).max(256),
    compilerAuthority: z.literal(false),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(
      value.observations,
      (observation) => observation.originalFilename,
      "source-name observations",
      context,
    );
    requireCanonicalValues(value.diagnostics, String, "source-name diagnostics", context);
    const normalizedNames = new Set(
      value.observations.map((observation) => observation.normalizedStem),
    );
    const expected =
      normalizedNames.size === 1 ? "single_normalized_name" : "multiple_normalized_names";
    if (value.interpretation !== expected)
      context.addIssue({
        code: "custom",
        path: ["interpretation"],
        message: "Source-name interpretation does not match its observations",
      });
  });
export type CatalogSourceNameHint = z.output<typeof CATALOG_SOURCE_NAME_HINT_SCHEMA>;

export const CATALOG_SOURCE_NAME_HINT_SET_SCHEMA = z
  .object({
    kind: z.literal("CatalogSourceNameHintSet"),
    status: COMPILATION_STATUS_SCHEMA,
    sourceManifestHash: HASH_SCHEMA,
    normalizerImplementationHash: HASH_SCHEMA,
    items: z.array(CATALOG_SOURCE_NAME_HINT_SCHEMA).min(1).max(100_000),
    diagnostics: z.array(z.string().trim().min(1).max(2048)).max(100_000),
    compilerAuthority: z.literal(false),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(
      value.items,
      (item) => item.sourceContentHash,
      "source-name hint items",
      context,
    );
    requireCanonicalValues(value.diagnostics, String, "source-name hint diagnostics", context);
    if (
      value.items.some(
        (item) => item.normalizerImplementationHash !== value.normalizerImplementationHash,
      )
    )
      context.addIssue({
        code: "custom",
        path: ["items"],
        message: "Every source-name hint must use the set's normalizer implementation",
      });
    const expectedStatus = value.diagnostics.length === 0 ? "eligible" : "incomplete";
    if (value.status !== expectedStatus)
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Source-name hint status does not match its diagnostics",
      });
  });
export type CatalogSourceNameHintSet = z.output<typeof CATALOG_SOURCE_NAME_HINT_SET_SCHEMA>;

export function normalizeSourceFilename(originalFilename: string): {
  readonly normalizedStem: string;
  readonly tokens: readonly string[];
} {
  const filename = z.string().trim().min(1).max(4096).parse(originalFilename);
  const stem = filename
    .replace(/\.glb$/iu, "")
    .replace(/--[a-f0-9]{12,64}$/iu, "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
    .replace(/([a-z])([A-Z])/gu, "$1 $2")
    .replace(/([A-Za-z])([0-9])/gu, "$1 $2")
    .replace(/([0-9])([A-Za-z])/gu, "$1 $2")
    .toLowerCase();
  const tokens = stem.match(/[a-z0-9]+/gu) ?? [];
  return { normalizedStem: tokens.join(" "), tokens };
}

export function buildCatalogSourceNameHintSet(input: {
  readonly sourceManifest: TrustedSourceManifest;
  readonly provenance: SourceProvenanceLedger;
}): CatalogSourceNameHintSet {
  const sourceManifest = TRUSTED_SOURCE_MANIFEST_SCHEMA.parse(input.sourceManifest);
  const provenance = SOURCE_PROVENANCE_LEDGER_SCHEMA.parse(input.provenance);
  const authority = validateSourceAuthority({ manifest: sourceManifest, provenance });
  if (authority.status !== "eligible")
    throw new Error(
      `Cannot derive source-name hints from invalid source authority: ${stableJson(authority.diagnostics)}`,
    );

  const namesBySource = new Map<string, Set<string>>();
  for (const record of provenance.records) {
    const filename = basename(record.originalPath);
    const names = namesBySource.get(record.sourceContentHash) ?? new Set<string>();
    names.add(filename);
    namesBySource.set(record.sourceContentHash, names);
  }

  const diagnostics: string[] = [];
  const items = sourceManifest.assets.map((source) => {
    const names = [...(namesBySource.get(source.contentHash) ?? [])];
    if (names.length === 0)
      throw new Error(`Validated provenance omitted source ${source.contentHash}`);
    const observations = canonicalValues(
      names.map((originalFilename) => ({
        originalFilename,
        ...normalizeSourceFilename(originalFilename),
      })),
      (observation) => observation.originalFilename,
      "source-name observations",
    );
    const itemDiagnostics = observations.every((observation) => observation.tokens.length === 0)
      ? [`Source ${source.contentHash} has no ASCII lexical tokens in its observed filenames`]
      : [];
    diagnostics.push(...itemDiagnostics);
    const normalizedNames = new Set(observations.map((observation) => observation.normalizedStem));
    return sealArtifact(CATALOG_SOURCE_NAME_HINT_SCHEMA, {
      kind: "CatalogSourceNameHint" as const,
      sourceContentHash: source.contentHash,
      normalizerImplementationHash: SOURCE_NAME_HINT_NORMALIZER_IMPLEMENTATION_HASH,
      interpretation:
        normalizedNames.size === 1
          ? ("single_normalized_name" as const)
          : ("multiple_normalized_names" as const),
      observations,
      diagnostics: itemDiagnostics,
      compilerAuthority: false as const,
    });
  });

  return sealArtifact(CATALOG_SOURCE_NAME_HINT_SET_SCHEMA, {
    kind: "CatalogSourceNameHintSet" as const,
    status: diagnostics.length === 0 ? ("eligible" as const) : ("incomplete" as const),
    sourceManifestHash: contentHash(stableJson(sourceManifest)),
    normalizerImplementationHash: SOURCE_NAME_HINT_NORMALIZER_IMPLEMENTATION_HASH,
    items: canonicalValues(items, (item) => item.sourceContentHash, "source-name hint items"),
    diagnostics: canonicalValues(diagnostics, String, "source-name hint diagnostics"),
    compilerAuthority: false as const,
  });
}

function basename(path: string): string {
  const segments = path.replace(/\\/gu, "/").split("/");
  const filename = segments.at(-1)?.trim();
  if (!filename) throw new Error(`Source provenance path has no filename: ${path}`);
  return filename;
}
