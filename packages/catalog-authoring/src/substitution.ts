import { z } from "zod";
import {
  COMPILATION_STATUS_SCHEMA,
  HASH_SCHEMA,
  compareCanonicalStrings,
  contentHash,
  dequantizeQ32_32,
  stableJson,
} from "@basalt/contracts";
import {
  CATALOG_MEASUREMENT_SET_SCHEMA,
  type CatalogAssetArtifact,
  type CatalogMeasurementSet,
} from "@basalt/catalog-model";
import { facetValueKey, type CatalogFacetValue } from "./facets.js";
import {
  CATALOG_FEATURE_CHANNEL_SCHEMA,
  CATALOG_FEATURE_SET_SCHEMA,
  type CatalogFeatureSet,
} from "./features.js";
import {
  CATALOG_CALIBRATED_PREDICTION_SET_SCHEMA,
  type CatalogCalibratedPredictionSet,
} from "./prediction.js";
import { CATALOG_ADMISSION_POLICY_SCHEMA, type CatalogAdmissionPolicy } from "./policy.js";
import {
  canonicalValues,
  requireCanonicalValues,
  sealArtifact,
  verifyArtifactHash,
} from "./artifact.js";

const PAIR_OUTCOME_SCHEMA = z.enum(["compatible", "incompatible", "uncertain"]);

const PAIR_CHANNEL_SCORE_SCHEMA = z
  .object({
    channel: CATALOG_FEATURE_CHANNEL_SCHEMA,
    similarityMillionths: z.number().int().min(-1_000_000).max(1_000_000),
    requiredMinimumMillionths: z.number().int().min(-1_000_000).max(1_000_000),
    leftFeatureHash: HASH_SCHEMA,
    rightFeatureHash: HASH_SCHEMA,
  })
  .strict();

export const CATALOG_SUBSTITUTION_COMPATIBILITY_RECEIPT_SCHEMA = z
  .object({
    kind: z.literal("CatalogSubstitutionCompatibilityReceipt"),
    policyHash: HASH_SCHEMA,
    predictionSetHash: HASH_SCHEMA,
    featureSetHash: HASH_SCHEMA,
    measurementSetHash: HASH_SCHEMA,
    leftSourceContentHash: HASH_SCHEMA,
    rightSourceContentHash: HASH_SCHEMA,
    semanticSignatureHash: HASH_SCHEMA,
    placementSignatureHash: HASH_SCHEMA,
    hardChecks: z
      .object({
        exactSemanticSite: z.boolean(),
        exactRealizationForm: z.boolean(),
        exactState: z.boolean(),
        exactSupport: z.boolean(),
        compatibleInterfaces: z.boolean(),
        metricEnvelope: z.boolean(),
      })
      .strict(),
    channelScores: z.array(PAIR_CHANNEL_SCORE_SCHEMA).max(3),
    outcome: PAIR_OUTCOME_SCHEMA,
    diagnostics: z.array(z.string().trim().min(1).max(1024)).max(64),
    compilerAuthority: z.literal(false),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(value.channelScores, (entry) => entry.channel, "pair channels", context);
    requireCanonicalValues(value.diagnostics, String, "pair diagnostics", context);
    if (compareCanonicalStrings(value.leftSourceContentHash, value.rightSourceContentHash) >= 0)
      context.addIssue({
        code: "custom",
        path: ["rightSourceContentHash"],
        message: "Substitution pair endpoints must use canonical order",
      });
    const hardPass = Object.values(value.hardChecks).every(Boolean);
    const channelsPass = value.channelScores.every(
      (entry) => entry.similarityMillionths >= entry.requiredMinimumMillionths,
    );
    if (value.outcome === "compatible" && (!hardPass || !channelsPass))
      context.addIssue({
        code: "custom",
        path: ["outcome"],
        message: "Compatible substitution pairs must pass every hard and learned check",
      });
  });
export type CatalogSubstitutionCompatibilityReceipt = z.output<
  typeof CATALOG_SUBSTITUTION_COMPATIBILITY_RECEIPT_SCHEMA
>;

const SUBSTITUTION_PROPOSAL_SCHEMA = z
  .object({
    proposalId: HASH_SCHEMA,
    semanticSignatureHash: HASH_SCHEMA,
    placementSignatureHash: HASH_SCHEMA,
    sourceContentHashes: z.array(HASH_SCHEMA).min(1).max(4096),
    compatibilityReceiptHashes: z.array(HASH_SCHEMA).max(10_000_000),
    wholeSetInvariant: z.literal("every_distinct_member_pair_is_compatible"),
  })
  .strict()
  .superRefine((value, context) => {
    requireCanonicalValues(value.sourceContentHashes, String, "proposal sources", context);
    requireCanonicalValues(
      value.compatibilityReceiptHashes,
      String,
      "proposal compatibility receipts",
      context,
    );
    const pairCount =
      (value.sourceContentHashes.length * (value.sourceContentHashes.length - 1)) / 2;
    if (value.compatibilityReceiptHashes.length !== pairCount)
      context.addIssue({
        code: "custom",
        path: ["compatibilityReceiptHashes"],
        message: "A multi-member substitution proposal requires evidence for every pair",
      });
  });

export const CATALOG_SUBSTITUTION_PROPOSAL_SET_SCHEMA = z
  .object({
    kind: z.literal("CatalogSubstitutionProposalSet"),
    status: COMPILATION_STATUS_SCHEMA,
    policyHash: HASH_SCHEMA,
    pilotPlanHash: HASH_SCHEMA,
    predictionSetHash: HASH_SCHEMA,
    featureSetHash: HASH_SCHEMA,
    measurementSetHash: HASH_SCHEMA,
    compatibilityReceipts: z
      .array(CATALOG_SUBSTITUTION_COMPATIBILITY_RECEIPT_SCHEMA)
      .max(10_000_000),
    proposals: z.array(SUBSTITUTION_PROPOSAL_SCHEMA).max(100_000),
    unresolvedSourceContentHashes: z.array(HASH_SCHEMA).max(100_000),
    diagnostics: z.array(z.string().trim().min(1).max(1024)).max(100_000),
    compilerAuthority: z.literal(false),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(value.compatibilityReceipts, pairKey, "compatibility receipts", context);
    requireCanonicalValues(
      value.proposals,
      (entry) => entry.proposalId,
      "substitution proposals",
      context,
    );
    requireCanonicalValues(
      value.unresolvedSourceContentHashes,
      String,
      "unresolved substitution sources",
      context,
    );
    requireCanonicalValues(value.diagnostics, String, "substitution diagnostics", context);
    const receipts = new Map(value.compatibilityReceipts.map((entry) => [entry.hash, entry]));
    for (const [proposalIndex, proposal] of value.proposals.entries())
      for (const receiptHash of proposal.compatibilityReceiptHashes) {
        const receipt = receipts.get(receiptHash);
        if (
          !receipt ||
          receipt.outcome !== "compatible" ||
          !proposal.sourceContentHashes.includes(receipt.leftSourceContentHash) ||
          !proposal.sourceContentHashes.includes(receipt.rightSourceContentHash)
        )
          context.addIssue({
            code: "custom",
            path: ["proposals", proposalIndex, "compatibilityReceiptHashes"],
            message: "A proposal cites missing, incompatible, or out-of-set pair evidence",
          });
      }
    const expected = value.unresolvedSourceContentHashes.length === 0 ? "eligible" : "incomplete";
    if (value.status !== expected)
      context.addIssue({ code: "custom", path: ["status"], message: "Proposal status mismatch" });
  });
export type CatalogSubstitutionProposalSet = z.output<
  typeof CATALOG_SUBSTITUTION_PROPOSAL_SET_SCHEMA
>;

interface Candidate {
  readonly sourceContentHash: string;
  readonly semanticSignatureHash: string;
  readonly placementSignatureHash: string;
  readonly values: readonly CatalogFacetValue[];
  readonly asset: CatalogAssetArtifact;
}

export function buildCatalogSubstitutionProposalSet(input: {
  readonly policy: CatalogAdmissionPolicy;
  readonly pilotPlanHash: string;
  readonly predictions: CatalogCalibratedPredictionSet;
  readonly features: CatalogFeatureSet;
  readonly measurements: CatalogMeasurementSet;
}): CatalogSubstitutionProposalSet {
  const policy = CATALOG_ADMISSION_POLICY_SCHEMA.parse(input.policy);
  const predictions = CATALOG_CALIBRATED_PREDICTION_SET_SCHEMA.parse(input.predictions);
  const features = CATALOG_FEATURE_SET_SCHEMA.parse(input.features);
  const measurements = CATALOG_MEASUREMENT_SET_SCHEMA.parse(input.measurements);
  const assets = new Map(measurements.assets.map((entry) => [entry.source.contentHash, entry]));
  const candidates: Candidate[] = [];
  const unresolved = new Set<string>();
  for (const prediction of predictions.predictions.filter(
    (entry) => entry.ablation === "combined",
  )) {
    const asset = assets.get(prediction.sourceContentHash);
    if (!asset || prediction.outcome !== "resolved") {
      unresolved.add(prediction.sourceContentHash);
      continue;
    }
    const values = prediction.facets.flatMap((facet) =>
      facet.outcome === "singleton" ? facet.candidates.map((entry) => entry.value) : [],
    );
    const placement = measuredPlacement(asset);
    if (!placement) {
      unresolved.add(prediction.sourceContentHash);
      continue;
    }
    candidates.push({
      sourceContentHash: prediction.sourceContentHash,
      semanticSignatureHash: contentHash(
        stableJson(canonicalValues(values, facetValueKey, "candidate semantic signature")),
      ),
      placementSignatureHash: contentHash(stableJson(placement)),
      values,
      asset,
    });
  }
  const featureLookup = new Map(
    features.receipts.map(
      (entry) => [`${entry.sourceContentHash}:${entry.channel}`, entry] as const,
    ),
  );
  const buckets = groupBy(
    candidates,
    (entry) => `${entry.semanticSignatureHash}:${entry.placementSignatureHash}`,
  );
  const compatibilityReceipts: CatalogSubstitutionCompatibilityReceipt[] = [];
  const proposals: z.output<typeof SUBSTITUTION_PROPOSAL_SCHEMA>[] = [];
  for (const bucket of [...buckets.values()]) {
    const ordered = [...bucket].sort((left, right) =>
      compareCanonicalStrings(left.sourceContentHash, right.sourceContentHash),
    );
    const receipts = new Map<string, CatalogSubstitutionCompatibilityReceipt>();
    for (let leftIndex = 0; leftIndex < ordered.length; leftIndex += 1)
      for (let rightIndex = leftIndex + 1; rightIndex < ordered.length; rightIndex += 1) {
        const receipt = evaluatePair(
          ordered[leftIndex]!,
          ordered[rightIndex]!,
          policy,
          predictions.hash,
          features,
          measurements.hash,
          featureLookup,
        );
        receipts.set(pairKey(receipt), receipt);
        compatibilityReceipts.push(receipt);
      }

    // Conservative deterministic clique cover: no proposal can contain an unproven pair.
    // False splits are permitted; false merges are not.
    const partitions: Candidate[][] = [];
    for (const candidate of ordered) {
      const target = partitions.find((partition) =>
        partition.every((member) =>
          member.sourceContentHash === candidate.sourceContentHash
            ? true
            : receipts.get(candidatePairKey(member.sourceContentHash, candidate.sourceContentHash))
                ?.outcome === "compatible",
        ),
      );
      if (target) target.push(candidate);
      else partitions.push([candidate]);
    }
    for (const partition of partitions) {
      const sources = partition.map((entry) => entry.sourceContentHash);
      const receiptHashes: string[] = [];
      for (let leftIndex = 0; leftIndex < sources.length; leftIndex += 1)
        for (let rightIndex = leftIndex + 1; rightIndex < sources.length; rightIndex += 1) {
          const receipt = receipts.get(candidatePairKey(sources[leftIndex]!, sources[rightIndex]!));
          if (!receipt || receipt.outcome !== "compatible")
            throw new Error("Substitution partition lost its complete compatibility proof");
          receiptHashes.push(receipt.hash);
        }
      const sourceContentHashes = canonicalValues(sources, String, "proposal sources");
      const proposalMaterial = {
        semanticSignatureHash: partition[0]!.semanticSignatureHash,
        placementSignatureHash: partition[0]!.placementSignatureHash,
        sourceContentHashes,
        compatibilityReceiptHashes: canonicalValues(
          receiptHashes,
          String,
          "proposal compatibility receipts",
        ),
        wholeSetInvariant: "every_distinct_member_pair_is_compatible" as const,
      };
      proposals.push({
        proposalId: contentHash(stableJson(proposalMaterial)),
        ...proposalMaterial,
      });
    }
  }
  for (const source of predictions.unresolvedSourceContentHashes) unresolved.add(source);
  const unresolvedSourceContentHashes = canonicalValues(
    [...unresolved],
    String,
    "unresolved substitution sources",
  );
  return sealArtifact(CATALOG_SUBSTITUTION_PROPOSAL_SET_SCHEMA, {
    kind: "CatalogSubstitutionProposalSet" as const,
    status:
      unresolvedSourceContentHashes.length === 0 ? ("eligible" as const) : ("incomplete" as const),
    policyHash: policy.hash,
    pilotPlanHash: input.pilotPlanHash,
    predictionSetHash: predictions.hash,
    featureSetHash: features.hash,
    measurementSetHash: measurements.hash,
    compatibilityReceipts: canonicalValues(
      compatibilityReceipts,
      pairKey,
      "compatibility receipts",
    ),
    proposals: canonicalValues(proposals, (entry) => entry.proposalId, "substitution proposals"),
    unresolvedSourceContentHashes,
    diagnostics:
      unresolvedSourceContentHashes.length === 0
        ? []
        : [
            `${unresolvedSourceContentHashes.length} pilot sources lack complete substitution evidence`,
          ],
    compilerAuthority: false as const,
  });
}

function evaluatePair(
  left: Candidate,
  right: Candidate,
  policy: CatalogAdmissionPolicy,
  predictionSetHash: string,
  featureSet: CatalogFeatureSet,
  measurementSetHash: string,
  featureLookup: ReadonlyMap<string, CatalogFeatureSet["receipts"][number]>,
): CatalogSubstitutionCompatibilityReceipt {
  const channels = policy.substitution.requiredFeatureChannels.map((channel) => {
    const leftFeature = featureLookup.get(`${left.sourceContentHash}:${channel}`);
    const rightFeature = featureLookup.get(`${right.sourceContentHash}:${channel}`);
    if (!leftFeature || !rightFeature) return undefined;
    return {
      channel,
      similarityMillionths: cosineMillionths(
        leftFeature.aggregate.values,
        rightFeature.aggregate.values,
      ),
      requiredMinimumMillionths: policy.substitution.minimumSimilarityMillionthsByChannel[channel],
      leftFeatureHash: leftFeature.hash,
      rightFeatureHash: rightFeature.hash,
    };
  });
  const completeChannels = channels.filter((entry) => entry !== undefined);
  const hardChecks = {
    exactSemanticSite: left.semanticSignatureHash === right.semanticSignatureHash,
    exactRealizationForm: exactFacet(left.values, right.values, "realization_form"),
    exactState: exactFacet(left.values, right.values, "state"),
    exactSupport: left.placementSignatureHash === right.placementSignatureHash,
    compatibleInterfaces: left.asset.sockets.length === right.asset.sockets.length,
    metricEnvelope: axisRatiosWithin(
      left.asset,
      right.asset,
      policy.substitution.maximumAxisRatioMillionths,
    ),
  };
  const diagnostics: string[] = [];
  if (completeChannels.length !== channels.length)
    diagnostics.push("Required learned feature evidence is missing");
  for (const [name, passed] of Object.entries(hardChecks))
    if (!passed) diagnostics.push(`Hard substitution check failed: ${name}`);
  for (const channel of completeChannels)
    if (channel.similarityMillionths < channel.requiredMinimumMillionths)
      diagnostics.push(`Feature threshold failed: ${channel.channel}`);
  const hardPass = Object.values(hardChecks).every(Boolean);
  const learnedPass = completeChannels.every(
    (entry) => entry.similarityMillionths >= entry.requiredMinimumMillionths,
  );
  const outcome =
    completeChannels.length !== channels.length
      ? ("uncertain" as const)
      : hardPass && learnedPass
        ? ("compatible" as const)
        : ("incompatible" as const);
  return sealArtifact(CATALOG_SUBSTITUTION_COMPATIBILITY_RECEIPT_SCHEMA, {
    kind: "CatalogSubstitutionCompatibilityReceipt" as const,
    policyHash: policy.hash,
    predictionSetHash,
    featureSetHash: featureSet.hash,
    measurementSetHash,
    leftSourceContentHash: left.sourceContentHash,
    rightSourceContentHash: right.sourceContentHash,
    semanticSignatureHash: left.semanticSignatureHash,
    placementSignatureHash: left.placementSignatureHash,
    hardChecks,
    channelScores: canonicalValues(completeChannels, (entry) => entry.channel, "pair channels"),
    outcome,
    diagnostics: canonicalValues(diagnostics, String, "pair diagnostics"),
    compilerAuthority: false as const,
  });
}

function exactFacet(
  left: readonly CatalogFacetValue[],
  right: readonly CatalogFacetValue[],
  kind: CatalogFacetValue["assertionKind"],
): boolean {
  return (
    stableJson(
      left
        .filter((entry) => entry.assertionKind === kind)
        .map(facetValueKey)
        .sort(compareCanonicalStrings),
    ) ===
    stableJson(
      right
        .filter((entry) => entry.assertionKind === kind)
        .map(facetValueKey)
        .sort(compareCanonicalStrings),
    )
  );
}

function measuredPlacement(asset: CatalogAssetArtifact) {
  switch (asset.support.primaryContact) {
    case "bottom":
      return { support: "ground", contact: "bottom", interfaces: [] } as const;
    case "lateral_wall":
      return { support: "wall", contact: "lateral_wall", interfaces: [] } as const;
    case "top_ceiling":
      return { support: "ceiling", contact: "top_ceiling", interfaces: [] } as const;
    case "socket_only":
      return { support: "socket", contact: "socket_only", interfaces: [] } as const;
    case "unknown":
      return undefined;
  }
}

function axisRatiosWithin(
  left: CatalogAssetArtifact,
  right: CatalogAssetArtifact,
  maximumMillionths: number,
): boolean {
  const extents = (asset: CatalogAssetArtifact) =>
    (["x", "y", "z"] as const).map(
      (axis) => dequantizeQ32_32(asset.bounds.max[axis]) - dequantizeQ32_32(asset.bounds.min[axis]),
    );
  const leftExtents = extents(left);
  const rightExtents = extents(right);
  return leftExtents.every((extent, index) => {
    const other = rightExtents[index]!;
    if (extent <= 0 || other <= 0) return false;
    return Math.max(extent / other, other / extent) * 1_000_000 <= maximumMillionths;
  });
}

function cosineMillionths(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length || left.length === 0)
    throw new Error("Feature dimensions differ");
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index]! * right[index]!;
    leftNorm += left[index]! * left[index]!;
    rightNorm += right[index]! * right[index]!;
  }
  if (leftNorm === 0 || rightNorm === 0) throw new Error("Feature vectors cannot be zero");
  return Math.round((dot / Math.sqrt(leftNorm * rightNorm)) * 1_000_000);
}

function candidatePairKey(left: string, right: string): string {
  return compareCanonicalStrings(left, right) < 0 ? `${left}:${right}` : `${right}:${left}`;
}

function pairKey(receipt: CatalogSubstitutionCompatibilityReceipt): string {
  return candidatePairKey(receipt.leftSourceContentHash, receipt.rightSourceContentHash);
}

function groupBy<T>(values: readonly T[], key: (value: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const group = groups.get(key(value)) ?? [];
    group.push(value);
    groups.set(key(value), group);
  }
  return groups;
}
