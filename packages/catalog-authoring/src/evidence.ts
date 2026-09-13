import { z } from "zod";
import { COMPILATION_STATUS_SCHEMA, HASH_SCHEMA, stableJson } from "@basalt/contracts";
import {
  canonicalValues,
  requireCanonicalValues,
  sealArtifact,
  verifyArtifactHash,
} from "./artifact.js";

export const CATALOG_EVIDENCE_CHANNELS = [
  "appearance",
  "geometry",
  "installation",
  "integrity",
  "material",
  "semantics",
  "shape",
] as const;
export const CATALOG_EVIDENCE_CHANNEL_SCHEMA = z.enum(CATALOG_EVIDENCE_CHANNELS);
export type CatalogEvidenceChannelName = z.output<typeof CATALOG_EVIDENCE_CHANNEL_SCHEMA>;

export const CATALOG_EVIDENCE_ARTIFACT_KINDS = [
  "appearance_embedding",
  "collision_measurement",
  "geometry_embedding",
  "geometry_sample",
  "integrity_report",
  "interface_measurement",
  "material_embedding",
  "material_inventory",
  "metric_measurement",
  "normalized_depth_render_set",
  "rgb_render_set",
  "semantic_embedding",
  "semantic_hypothesis_set",
  "shape_embedding",
  "silhouette_render_set",
  "support_measurement",
  "surface_normal_render_set",
  "unlit_base_color_render_set",
] as const;
export const CATALOG_EVIDENCE_ARTIFACT_KIND_SCHEMA = z.enum(CATALOG_EVIDENCE_ARTIFACT_KINDS);
export type CatalogEvidenceArtifactKind = z.output<typeof CATALOG_EVIDENCE_ARTIFACT_KIND_SCHEMA>;

export const CATALOG_EVIDENCE_KINDS_BY_CHANNEL = Object.freeze({
  appearance: ["appearance_embedding", "rgb_render_set"],
  geometry: ["geometry_embedding", "geometry_sample", "metric_measurement"],
  installation: ["collision_measurement", "interface_measurement", "support_measurement"],
  integrity: ["integrity_report"],
  material: ["material_embedding", "material_inventory", "unlit_base_color_render_set"],
  semantics: ["semantic_embedding", "semantic_hypothesis_set"],
  shape: [
    "normalized_depth_render_set",
    "shape_embedding",
    "silhouette_render_set",
    "surface_normal_render_set",
  ],
} satisfies Record<CatalogEvidenceChannelName, readonly CatalogEvidenceArtifactKind[]>);

export const CATALOG_MINIMUM_EVIDENCE_KINDS_BY_CHANNEL = Object.freeze({
  appearance: ["rgb_render_set"],
  geometry: ["geometry_sample", "metric_measurement"],
  installation: ["collision_measurement", "interface_measurement", "support_measurement"],
  integrity: ["integrity_report"],
  material: ["material_inventory", "unlit_base_color_render_set"],
  semantics: ["semantic_hypothesis_set"],
  shape: ["normalized_depth_render_set", "silhouette_render_set", "surface_normal_render_set"],
} satisfies Record<CatalogEvidenceChannelName, readonly CatalogEvidenceArtifactKind[]>);

export const CATALOG_EVIDENCE_REFERENCE_SCHEMA = z
  .object({
    evidenceKind: CATALOG_EVIDENCE_ARTIFACT_KIND_SCHEMA,
    artifactHash: HASH_SCHEMA,
    implementationHash: HASH_SCHEMA,
    inputHashes: z.array(HASH_SCHEMA).max(256),
  })
  .strict()
  .superRefine((value, context) =>
    requireCanonicalValues(value.inputHashes, String, "evidence inputs", context),
  );
export type CatalogEvidenceReference = z.output<typeof CATALOG_EVIDENCE_REFERENCE_SCHEMA>;

export const CATALOG_EVIDENCE_CHANNEL_RECEIPT_SCHEMA = z
  .object({
    kind: z.literal("CatalogEvidenceChannelReceipt"),
    channel: CATALOG_EVIDENCE_CHANNEL_SCHEMA,
    status: COMPILATION_STATUS_SCHEMA,
    references: z.array(CATALOG_EVIDENCE_REFERENCE_SCHEMA).max(64),
    diagnostics: z.array(z.string().trim().min(1).max(2048)).max(256),
    compilerAuthority: z.literal(false),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(value.references, evidenceReferenceKey, "evidence references", context);
    requireCanonicalValues(value.diagnostics, String, "evidence diagnostics", context);
    const allowed = new Set(CATALOG_EVIDENCE_KINDS_BY_CHANNEL[value.channel]);
    for (const [index, reference] of value.references.entries())
      if (!allowed.has(reference.evidenceKind))
        context.addIssue({
          code: "custom",
          path: ["references", index, "evidenceKind"],
          message: `${reference.evidenceKind} does not belong to the ${value.channel} channel`,
        });
    const present = new Set(value.references.map((reference) => reference.evidenceKind));
    const missing = CATALOG_MINIMUM_EVIDENCE_KINDS_BY_CHANNEL[value.channel].filter(
      (kind) => !present.has(kind),
    );
    if (value.status === "eligible" && (missing.length > 0 || value.diagnostics.length > 0))
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Eligible evidence channels require every minimum artifact and no diagnostics",
      });
    if (value.status !== "eligible" && value.diagnostics.length === 0)
      context.addIssue({
        code: "custom",
        path: ["diagnostics"],
        message: "Incomplete or rejected evidence requires a diagnostic",
      });
  });
export type CatalogEvidenceChannelReceipt = z.output<
  typeof CATALOG_EVIDENCE_CHANNEL_RECEIPT_SCHEMA
>;

export function sealCatalogEvidenceChannelReceipt(input: {
  readonly channel: CatalogEvidenceChannelName;
  readonly status: "eligible" | "incomplete" | "rejected";
  readonly references: readonly CatalogEvidenceReference[];
  readonly diagnostics: readonly string[];
}): CatalogEvidenceChannelReceipt {
  return sealArtifact(CATALOG_EVIDENCE_CHANNEL_RECEIPT_SCHEMA, {
    kind: "CatalogEvidenceChannelReceipt" as const,
    channel: input.channel,
    status: input.status,
    references: canonicalValues(
      input.references.map((reference) => ({
        ...reference,
        inputHashes: canonicalValues(reference.inputHashes, String, "evidence inputs"),
      })),
      evidenceReferenceKey,
      "evidence references",
    ),
    diagnostics: canonicalValues(input.diagnostics, String, "evidence diagnostics"),
    compilerAuthority: false as const,
  });
}

export const CATALOG_ASSET_EVIDENCE_SET_SCHEMA = z
  .object({
    kind: z.literal("CatalogAssetEvidenceSet"),
    status: COMPILATION_STATUS_SCHEMA,
    sourceContentHash: HASH_SCHEMA,
    sourceManifestHash: HASH_SCHEMA,
    channels: z.array(CATALOG_EVIDENCE_CHANNEL_RECEIPT_SCHEMA).length(7),
    diagnostics: z.array(z.string().trim().min(1).max(2048)).max(2048),
    compilerAuthority: z.literal(false),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(
      value.channels,
      (channel) => channel.channel,
      "evidence channels",
      context,
    );
    requireCanonicalValues(value.diagnostics, String, "asset evidence diagnostics", context);
    if (
      stableJson(value.channels.map((channel) => channel.channel)) !==
      stableJson(CATALOG_EVIDENCE_CHANNELS)
    )
      context.addIssue({
        code: "custom",
        path: ["channels"],
        message: "An asset evidence set requires every evidence channel exactly once",
      });
    const expectedStatus = aggregateStatus(value.channels.map((channel) => channel.status));
    if (value.status !== expectedStatus)
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Asset evidence status does not match its channels",
      });
  });
export type CatalogAssetEvidenceSet = z.output<typeof CATALOG_ASSET_EVIDENCE_SET_SCHEMA>;

export function sealCatalogAssetEvidenceSet(input: {
  readonly sourceContentHash: string;
  readonly sourceManifestHash: string;
  readonly channels: readonly CatalogEvidenceChannelReceipt[];
}): CatalogAssetEvidenceSet {
  const channels = canonicalValues(
    input.channels,
    (channel) => channel.channel,
    "evidence channels",
  );
  const diagnostics = channels.flatMap((channel) =>
    channel.diagnostics.map((diagnostic) => `${channel.channel}:${diagnostic}`),
  );
  return sealArtifact(CATALOG_ASSET_EVIDENCE_SET_SCHEMA, {
    kind: "CatalogAssetEvidenceSet" as const,
    status: aggregateStatus(channels.map((channel) => channel.status)),
    sourceContentHash: HASH_SCHEMA.parse(input.sourceContentHash),
    sourceManifestHash: HASH_SCHEMA.parse(input.sourceManifestHash),
    channels,
    diagnostics: canonicalValues(diagnostics, String, "asset evidence diagnostics"),
    compilerAuthority: false as const,
  });
}

function evidenceReferenceKey(reference: CatalogEvidenceReference): string {
  return `${reference.evidenceKind}:${reference.artifactHash}:${reference.implementationHash}`;
}

function aggregateStatus(statuses: readonly ("eligible" | "incomplete" | "rejected")[]) {
  if (statuses.includes("rejected")) return "rejected" as const;
  if (statuses.includes("incomplete")) return "incomplete" as const;
  return "eligible" as const;
}
