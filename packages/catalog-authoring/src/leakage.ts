import { z } from "zod";
import {
  CATALOG_MEASUREMENT_SET_SCHEMA,
  TRUSTED_SOURCE_MANIFEST_SCHEMA,
  type CatalogMeasurementSet,
  type TrustedSourceManifest,
} from "@basalt/catalog-model";
import {
  COMPILATION_STATUS_SCHEMA,
  DIAGNOSTIC_SCHEMA,
  HASH_SCHEMA,
  contentHash,
  stableJson,
} from "@basalt/contracts";
import {
  CATALOG_LEAKAGE_GROUPING_POLICY_SCHEMA,
  CATALOG_LEAKAGE_RELATION_KIND_SCHEMA,
  type CatalogLeakageGroupingPolicy,
} from "./rubric.js";
import {
  canonicalValues,
  requireCanonicalValues,
  sealArtifact,
  verifyArtifactHash,
} from "./artifact.js";

export const CATALOG_LEAKAGE_RELATION_SCHEMA = z
  .object({
    leftSourceContentHash: HASH_SCHEMA,
    rightSourceContentHash: HASH_SCHEMA,
    relationKind: CATALOG_LEAKAGE_RELATION_KIND_SCHEMA,
    evidenceHash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.leftSourceContentHash >= value.rightSourceContentHash)
      context.addIssue({
        code: "custom",
        message: "Leakage relation endpoints must be distinct and canonically ordered",
      });
  });
export type CatalogLeakageRelation = z.output<typeof CATALOG_LEAKAGE_RELATION_SCHEMA>;

export const CATALOG_NEAR_DUPLICATE_RELATION_SCHEMA = CATALOG_LEAKAGE_RELATION_SCHEMA.safeExtend({
  relationKind: z.literal("near_duplicate_shape"),
}).strict();
export type CatalogNearDuplicateRelation = z.output<typeof CATALOG_NEAR_DUPLICATE_RELATION_SCHEMA>;

const LEAKAGE_ANALYSIS_DIAGNOSTIC_SCHEMA = DIAGNOSTIC_SCHEMA.extend({
  gateStatus: z.enum(["incomplete", "rejected"]),
}).strict();

export const CATALOG_NEAR_DUPLICATE_SEARCH_SCHEMA = z
  .object({
    kind: z.literal("CatalogNearDuplicateSearch"),
    status: COMPILATION_STATUS_SCHEMA,
    sourceManifestHash: HASH_SCHEMA,
    visualReviewIndexHash: HASH_SCHEMA,
    implementationHash: HASH_SCHEMA,
    descriptorSetHash: HASH_SCHEMA,
    similarityThreshold: z
      .object({
        numerator: z.number().int().positive(),
        denominator: z.number().int().positive(),
      })
      .strict(),
    searchedSourceContentHashes: z.array(HASH_SCHEMA),
    comparedPairCount: z.number().int().nonnegative().safe(),
    relations: z.array(CATALOG_NEAR_DUPLICATE_RELATION_SCHEMA),
    diagnostics: z.array(LEAKAGE_ANALYSIS_DIAGNOSTIC_SCHEMA),
    compilerAuthority: z.literal(false),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(
      value.searchedSourceContentHashes,
      String,
      "near-duplicate searched sources",
      context,
    );
    requireCanonicalValues(value.relations, relationKey, "near-duplicate relations", context);
    requireCanonicalValues(value.diagnostics, stableJson, "near-duplicate diagnostics", context);
    if (value.similarityThreshold.numerator >= value.similarityThreshold.denominator)
      context.addIssue({
        code: "custom",
        path: ["similarityThreshold"],
        message: "Near-duplicate similarity must be a proper fraction",
      });
    if (value.status !== aggregateDiagnosticStatus(value.diagnostics))
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Near-duplicate search status does not match its diagnostics",
      });
    const searched = new Set(value.searchedSourceContentHashes);
    for (const [index, relation] of value.relations.entries())
      if (
        !searched.has(relation.leftSourceContentHash) ||
        !searched.has(relation.rightSourceContentHash)
      )
        context.addIssue({
          code: "custom",
          path: ["relations", index],
          message: "Near-duplicate relation must reference two searched sources",
        });
    const expectedPairCount =
      (value.searchedSourceContentHashes.length * (value.searchedSourceContentHashes.length - 1)) /
      2;
    if (value.status === "eligible" && value.comparedPairCount !== expectedPairCount)
      context.addIssue({
        code: "custom",
        path: ["comparedPairCount"],
        message: "Eligible near-duplicate search must compare every source pair",
      });
  });
export type CatalogNearDuplicateSearch = z.output<typeof CATALOG_NEAR_DUPLICATE_SEARCH_SCHEMA>;

const LEAKAGE_ANALYSIS_COVERAGE_SCHEMA = z
  .object({
    exactContentIdentity: z.boolean(),
    canonicalGeometryIdentity: z.boolean(),
    geometryContainment: z.boolean(),
    sharedMaterialPayload: z.boolean(),
    nearDuplicateShape: z.boolean(),
  })
  .strict();

export const CATALOG_LEAKAGE_ANALYSIS_SCHEMA = z
  .object({
    kind: z.literal("CatalogLeakageAnalysis"),
    status: COMPILATION_STATUS_SCHEMA,
    sourceManifestHash: HASH_SCHEMA,
    measurementSetHash: HASH_SCHEMA,
    groupingPolicyHash: HASH_SCHEMA,
    nearDuplicateSearchHash: HASH_SCHEMA,
    implementationHash: HASH_SCHEMA,
    coverage: LEAKAGE_ANALYSIS_COVERAGE_SCHEMA,
    relations: z.array(CATALOG_LEAKAGE_RELATION_SCHEMA),
    diagnostics: z.array(LEAKAGE_ANALYSIS_DIAGNOSTIC_SCHEMA),
    compilerAuthority: z.literal(false),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(value.relations, relationKey, "leakage relations", context);
    requireCanonicalValues(value.diagnostics, stableJson, "leakage diagnostics", context);
    const expectedStatus = aggregateDiagnosticStatus(value.diagnostics);
    if (value.status !== expectedStatus)
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Leakage analysis status does not match its diagnostics",
      });
    if (value.status === "eligible" && Object.values(value.coverage).some((entry) => !entry))
      context.addIssue({
        code: "custom",
        path: ["coverage"],
        message: "Eligible leakage analysis requires complete physical coverage",
      });
  });
export type CatalogLeakageAnalysis = z.output<typeof CATALOG_LEAKAGE_ANALYSIS_SCHEMA>;

const LEAKAGE_EVIDENCE_REFERENCE_SCHEMA = z
  .object({
    relationKind: CATALOG_LEAKAGE_RELATION_KIND_SCHEMA,
    evidenceHash: HASH_SCHEMA,
  })
  .strict();

export const CATALOG_LEAKAGE_GROUP_SCHEMA = z
  .object({
    kind: z.literal("CatalogLeakageGroup"),
    sourceContentHashes: z.array(HASH_SCHEMA).min(1),
    evidence: z.array(LEAKAGE_EVIDENCE_REFERENCE_SCHEMA).min(1),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(value.sourceContentHashes, String, "leakage-group sources", context);
    requireCanonicalValues(
      value.evidence,
      (entry) => `${entry.relationKind}:${entry.evidenceHash}`,
      "leakage-group evidence",
      context,
    );
  });
export type CatalogLeakageGroup = z.output<typeof CATALOG_LEAKAGE_GROUP_SCHEMA>;

export function sealCatalogNearDuplicateSearch(
  input: Omit<CatalogNearDuplicateSearch, "kind" | "status" | "compilerAuthority" | "hash">,
): CatalogNearDuplicateSearch {
  const diagnostics = canonicalValues(input.diagnostics, stableJson, "near-duplicate diagnostics");
  return sealArtifact(CATALOG_NEAR_DUPLICATE_SEARCH_SCHEMA, {
    kind: "CatalogNearDuplicateSearch" as const,
    status: aggregateDiagnosticStatus(diagnostics),
    ...input,
    searchedSourceContentHashes: canonicalValues(
      input.searchedSourceContentHashes,
      String,
      "near-duplicate searched sources",
    ),
    relations: canonicalValues(
      input.relations.map((entry) => CATALOG_NEAR_DUPLICATE_RELATION_SCHEMA.parse(entry)),
      relationKey,
      "near-duplicate relations",
    ),
    diagnostics,
    compilerAuthority: false as const,
  });
}

export function sealCatalogLeakageAnalysis(
  input: Omit<CatalogLeakageAnalysis, "kind" | "status" | "compilerAuthority" | "hash">,
): CatalogLeakageAnalysis {
  const diagnostics = canonicalValues(input.diagnostics, stableJson, "leakage diagnostics");
  return sealArtifact(CATALOG_LEAKAGE_ANALYSIS_SCHEMA, {
    kind: "CatalogLeakageAnalysis" as const,
    status: aggregateDiagnosticStatus(diagnostics),
    ...input,
    relations: canonicalValues(
      input.relations.map((entry) => CATALOG_LEAKAGE_RELATION_SCHEMA.parse(entry)),
      relationKey,
      "leakage relations",
    ),
    diagnostics,
    compilerAuthority: false as const,
  });
}

export function analyzeCatalogLeakage(input: {
  readonly sourceManifest: TrustedSourceManifest;
  readonly measurements: CatalogMeasurementSet;
  readonly groupingPolicy: CatalogLeakageGroupingPolicy;
  readonly nearDuplicateSearch: CatalogNearDuplicateSearch;
}): CatalogLeakageAnalysis {
  const manifest = TRUSTED_SOURCE_MANIFEST_SCHEMA.parse(input.sourceManifest);
  const measurements = CATALOG_MEASUREMENT_SET_SCHEMA.parse(input.measurements);
  const policy = CATALOG_LEAKAGE_GROUPING_POLICY_SCHEMA.parse(input.groupingPolicy);
  const nearDuplicateSearch = CATALOG_NEAR_DUPLICATE_SEARCH_SCHEMA.parse(input.nearDuplicateSearch);
  const sourceManifestHash = contentHash(stableJson(manifest));
  const diagnostics: Array<z.output<typeof LEAKAGE_ANALYSIS_DIAGNOSTIC_SCHEMA>> = [];
  const bindingMatches = measurements.sourceManifestHash === sourceManifestHash;
  if (!bindingMatches)
    diagnostics.push(
      leakageDiagnostic(
        "measurement_manifest_mismatch",
        "Leakage analysis requires measurements for the exact canonical source manifest",
        "rejected",
        ["measurementSetHash"],
        [measurements.hash, sourceManifestHash],
      ),
    );

  const expectedSources = new Set(manifest.assets.map((asset) => asset.contentHash));
  const measuredSources = new Set(measurements.assets.map((asset) => asset.source.contentHash));
  const missingMeasurements = [...expectedSources].filter((hash) => !measuredSources.has(hash));
  if (missingMeasurements.length > 0)
    diagnostics.push(
      leakageDiagnostic(
        "incomplete_physical_measurement",
        `${missingMeasurements.length} source identities lack physical leakage evidence`,
        "incomplete",
        ["coverage"],
        missingMeasurements,
      ),
    );

  const searchedSources = new Set(nearDuplicateSearch.searchedSourceContentHashes);
  const collisionOnlySources = new Set(
    measurements.assets
      .filter(
        (asset) =>
          asset.parts.length > 0 && asset.parts.every((part) => part.role === "collision_proxy"),
      )
      .map((asset) => asset.source.contentHash),
  );
  const expectedNearDuplicateSources = new Set(
    [...expectedSources].filter((hash) => !collisionOnlySources.has(hash)),
  );
  const missingNearDuplicateSources = [...expectedNearDuplicateSources].filter(
    (hash) => !searchedSources.has(hash),
  );
  const unknownNearDuplicateSources = nearDuplicateSearch.searchedSourceContentHashes.filter(
    (hash) => !expectedNearDuplicateSources.has(hash),
  );
  if (nearDuplicateSearch.sourceManifestHash !== sourceManifestHash)
    diagnostics.push(
      leakageDiagnostic(
        "near_duplicate_manifest_mismatch",
        "Near-duplicate search binds another canonical source manifest",
        "rejected",
        ["nearDuplicateSearchHash"],
        [nearDuplicateSearch.hash, sourceManifestHash],
      ),
    );
  if (
    stableJson(nearDuplicateSearch.similarityThreshold) !==
    stableJson(policy.nearDuplicateSimilarity)
  )
    diagnostics.push(
      leakageDiagnostic(
        "near_duplicate_policy_mismatch",
        "Near-duplicate search does not use the current leakage similarity threshold",
        "rejected",
        ["nearDuplicateSearchHash"],
        [nearDuplicateSearch.hash, policy.hash],
      ),
    );
  if (unknownNearDuplicateSources.length > 0)
    diagnostics.push(
      leakageDiagnostic(
        "near_duplicate_unknown_sources",
        `${unknownNearDuplicateSources.length} near-duplicate descriptors reference collision-only or unknown sources`,
        "rejected",
        ["nearDuplicateSearchHash"],
        unknownNearDuplicateSources,
      ),
    );
  if (missingNearDuplicateSources.length > 0)
    diagnostics.push(
      leakageDiagnostic(
        "near_duplicate_search_pending",
        `${missingNearDuplicateSources.length} renderable source identities lack near-duplicate shape evidence`,
        "incomplete",
        ["coverage", "nearDuplicateShape"],
        missingNearDuplicateSources,
      ),
    );
  for (const diagnostic of nearDuplicateSearch.diagnostics) diagnostics.push(diagnostic);

  const relations: CatalogLeakageRelation[] = [];
  connectSharedFeatures(
    measurements.assets.map((asset) => ({
      sourceContentHash: asset.source.contentHash,
      featureHashes: [asset.geometryHash],
    })),
    "canonical_geometry_identity",
    relations,
  );
  connectSharedFeatures(
    measurements.assets.map((asset) => ({
      sourceContentHash: asset.source.contentHash,
      featureHashes: asset.parts.map((part) => part.geometryHash),
    })),
    "geometry_containment",
    relations,
  );
  connectSharedFeatures(
    measurements.assets.map((asset) => ({
      sourceContentHash: asset.source.contentHash,
      featureHashes: asset.materials.flatMap((material) => material.payloadHashes),
    })),
    "shared_material_payload",
    relations,
  );
  for (const relation of nearDuplicateSearch.relations)
    relations.push(CATALOG_NEAR_DUPLICATE_RELATION_SCHEMA.parse(relation));

  const physicalCoverage = bindingMatches && missingMeasurements.length === 0;
  const nearDuplicateCoverage =
    nearDuplicateSearch.status === "eligible" &&
    nearDuplicateSearch.sourceManifestHash === sourceManifestHash &&
    stableJson(nearDuplicateSearch.similarityThreshold) ===
      stableJson(policy.nearDuplicateSimilarity) &&
    missingNearDuplicateSources.length === 0 &&
    unknownNearDuplicateSources.length === 0;
  return sealCatalogLeakageAnalysis({
    sourceManifestHash,
    measurementSetHash: measurements.hash,
    groupingPolicyHash: policy.hash,
    nearDuplicateSearchHash: nearDuplicateSearch.hash,
    implementationHash: contentHash(
      stableJson({
        algorithm: "source_neutral_physical_connected_components",
        exactGeometry:
          "translation_normalized_q32_canonical_vertex_and_unoriented_triangle_serialization",
        observedRelationKinds: policy.observedRelationKinds,
        groupingRelationKinds: policy.groupingRelationKinds,
        contextRelationKinds: policy.contextRelationKinds,
        nearDuplicateImplementationHash: nearDuplicateSearch.implementationHash,
      }),
    ),
    coverage: {
      exactContentIdentity: true,
      canonicalGeometryIdentity: physicalCoverage,
      geometryContainment: physicalCoverage,
      sharedMaterialPayload: physicalCoverage,
      nearDuplicateShape: nearDuplicateCoverage,
    },
    relations,
    diagnostics,
  });
}

export function buildCatalogLeakageGroups(
  sourceManifest: TrustedSourceManifest,
  analysis: CatalogLeakageAnalysis,
  groupingPolicy: CatalogLeakageGroupingPolicy,
): CatalogLeakageGroup[] {
  const manifest = TRUSTED_SOURCE_MANIFEST_SCHEMA.parse(sourceManifest);
  const sealed = CATALOG_LEAKAGE_ANALYSIS_SCHEMA.parse(analysis);
  const policy = CATALOG_LEAKAGE_GROUPING_POLICY_SCHEMA.parse(groupingPolicy);
  const sourceManifestHash = contentHash(stableJson(manifest));
  if (sealed.sourceManifestHash !== sourceManifestHash)
    throw new Error("Leakage analysis binds another source manifest");
  if (sealed.groupingPolicyHash !== policy.hash)
    throw new Error("Leakage analysis binds another grouping policy");
  const sources = new Set(manifest.assets.map((asset) => asset.contentHash));
  const parents = new Map([...sources].map((source) => [source, source]));
  const groupingKinds = new Set(policy.groupingRelationKinds);
  const groupingRelations = sealed.relations.filter((relation) =>
    groupingKinds.has(relation.relationKind),
  );
  for (const relation of groupingRelations) {
    if (
      !sources.has(relation.leftSourceContentHash) ||
      !sources.has(relation.rightSourceContentHash)
    )
      throw new Error("Leakage relation references an unknown source identity");
    union(parents, relation.leftSourceContentHash, relation.rightSourceContentHash);
  }
  const membersByRoot = new Map<string, string[]>();
  for (const source of [...sources].sort()) {
    const root = find(parents, source);
    const values = membersByRoot.get(root) ?? [];
    values.push(source);
    membersByRoot.set(root, values);
  }
  return canonicalValues(
    [...membersByRoot.values()].map((sourceContentHashes) => {
      const memberSet = new Set(sourceContentHashes);
      const references = groupingRelations
        .filter(
          (relation) =>
            memberSet.has(relation.leftSourceContentHash) &&
            memberSet.has(relation.rightSourceContentHash),
        )
        .map(({ relationKind, evidenceHash }) => ({ relationKind, evidenceHash }));
      return sealCatalogLeakageGroup({
        sourceContentHashes,
        evidence:
          references.length > 0
            ? uniqueEvidence(references)
            : [
                {
                  relationKind: "exact_content_identity",
                  evidenceHash: sourceContentHashes[0]!,
                },
              ],
      });
    }),
    (group) => group.hash,
    "leakage groups",
  );
}

export function sealCatalogLeakageGroup(
  input: Omit<CatalogLeakageGroup, "kind" | "hash">,
): CatalogLeakageGroup {
  return sealArtifact(CATALOG_LEAKAGE_GROUP_SCHEMA, {
    kind: "CatalogLeakageGroup" as const,
    sourceContentHashes: canonicalValues(
      input.sourceContentHashes,
      String,
      "leakage-group sources",
    ),
    evidence: canonicalValues(
      input.evidence,
      (entry) => `${entry.relationKind}:${entry.evidenceHash}`,
      "leakage-group evidence",
    ),
  });
}

function connectSharedFeatures(
  assets: readonly { sourceContentHash: string; featureHashes: readonly string[] }[],
  relationKind: "canonical_geometry_identity" | "geometry_containment" | "shared_material_payload",
  output: CatalogLeakageRelation[],
): void {
  const ownersByFeature = new Map<string, Set<string>>();
  for (const asset of assets)
    for (const featureHash of new Set(asset.featureHashes)) {
      const owners = ownersByFeature.get(featureHash) ?? new Set<string>();
      owners.add(asset.sourceContentHash);
      ownersByFeature.set(featureHash, owners);
    }
  for (const [evidenceHash, owners] of ownersByFeature) {
    const ordered = [...owners].sort();
    const anchor = ordered[0];
    if (!anchor) continue;
    for (const rightSourceContentHash of ordered.slice(1))
      output.push({
        leftSourceContentHash: anchor,
        rightSourceContentHash,
        relationKind,
        evidenceHash,
      });
  }
}

function relationKey(relation: CatalogLeakageRelation): string {
  return `${relation.leftSourceContentHash}:${relation.rightSourceContentHash}:${relation.relationKind}:${relation.evidenceHash}`;
}

function uniqueEvidence(
  values: readonly { relationKind: CatalogLeakageRelation["relationKind"]; evidenceHash: string }[],
) {
  return [
    ...new Map(
      values.map((entry) => [`${entry.relationKind}:${entry.evidenceHash}`, entry] as const),
    ).values(),
  ];
}

function find(parents: Map<string, string>, value: string): string {
  const parent = parents.get(value);
  if (!parent) throw new Error(`Unknown leakage source ${value}`);
  if (parent === value) return value;
  const root = find(parents, parent);
  parents.set(value, root);
  return root;
}

function union(parents: Map<string, string>, left: string, right: string): void {
  const leftRoot = find(parents, left);
  const rightRoot = find(parents, right);
  if (leftRoot === rightRoot) return;
  if (leftRoot < rightRoot) parents.set(rightRoot, leftRoot);
  else parents.set(leftRoot, rightRoot);
}

function leakageDiagnostic(
  code: string,
  message: string,
  gateStatus: "incomplete" | "rejected",
  path: readonly (string | number)[],
  evidenceHashes: readonly string[] = [],
) {
  return LEAKAGE_ANALYSIS_DIAGNOSTIC_SCHEMA.parse({
    code,
    message,
    gateStatus,
    path,
    evidenceHashes: canonicalValues(evidenceHashes, String, "diagnostic evidence"),
  });
}

function aggregateDiagnosticStatus(
  diagnostics: readonly z.output<typeof LEAKAGE_ANALYSIS_DIAGNOSTIC_SCHEMA>[],
): "eligible" | "incomplete" | "rejected" {
  if (diagnostics.some((entry) => entry.gateStatus === "rejected")) return "rejected";
  return diagnostics.length > 0 ? "incomplete" : "eligible";
}
