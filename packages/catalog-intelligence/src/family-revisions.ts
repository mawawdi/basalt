import { contentHash, stableJson } from "../../contracts/src/index.js";
import { compareSpatialStrings } from "../../spatial-core/src/primitives.js";
import {
  computeFamilyMerkleId,
  sealAssetFamilyRevision,
  type AssetFamilyRevision,
  type CatalogAssetRecord,
  type TrimSheetMapping,
} from "../../basalt-types/src/index.js";
import { quantizeQ32_32 } from "../../basalt-types/src/fixed.js";
import type { CatalogFamilyDeclaration } from "./contracts.js";
import { buildJointSockets, buildMountSockets } from "./sockets.js";

export interface MountContactEvidence {
  readonly supportPlaneFits: ReadonlyArray<{
    readonly normalQ32_32: { readonly x: string; readonly y: string; readonly z: string };
    readonly originQ32_32: { readonly x: string; readonly y: string; readonly z: string };
    readonly boundaryRadiusStuds: number;
    readonly inlierCount: number;
    readonly pointCount: number;
  }>;
}

export interface JointContactEvidence {
  readonly jointPlaneFits: ReadonlyArray<{
    readonly normalQ32_32: { readonly x: string; readonly y: string; readonly z: string };
    readonly originQ32_32: { readonly x: string; readonly y: string; readonly z: string };
    readonly boundaryRadiusStuds: number;
    readonly inlierCount: number;
    readonly pointCount: number;
  }>;
}

export interface FamilySealEvidence {
  readonly trimMappings?: readonly TrimSheetMapping[];
  readonly mountContacts?: Readonly<Record<string, MountContactEvidence>>;
  readonly jointContacts?: Readonly<Record<string, JointContactEvidence>>;
}

export function buildAuthoredAssetFamilyRevision(
  declaration: CatalogFamilyDeclaration,
  assets: readonly CatalogAssetRecord[],
  evidence: FamilySealEvidence = {},
): AssetFamilyRevision {
  if (declaration.status !== "declared" && declaration.status !== "sealed")
    throw new Error(`Cannot seal incomplete family declaration: ${declaration.familyName}`);
  const byId = new Map(assets.map((asset) => [asset.assetId, asset]));
  const records = declaration.members.map((member) => byId.get(member.assetId));
  if (records.some((record) => record === undefined))
    throw new Error(
      `Family declaration references an unknown measured asset: ${declaration.familyName}`,
    );
  const resolvedRecords = records as CatalogAssetRecord[];
  const geometryHashes = resolvedRecords.map((record) => record.merkleLeafHash).sort();
  const physicsCompanionHash = contentHash(
    stableJson(
      resolvedRecords
        .map((record) => ({ assetId: record.assetId, collisionProxy: record.collisionProxy }))
        .sort((left, right) => compareSpatialStrings(left.assetId, right.assetId)),
    ),
  );
  const trimBands = [...(declaration.trimBands ?? [])];
  const trimMappings = [...(evidence.trimMappings ?? [])];
  const bandIds = new Set(trimBands.map((band) => band.bandId));
  for (const mapping of trimMappings)
    if (!bandIds.has(mapping.bandId))
      throw new Error(
        `Trim mapping references unknown trim band: ${mapping.bandId} in ${declaration.familyName}`,
      );
  const materialTrimHash =
    trimBands.length > 0
      ? contentHash(
          stableJson({
            sharedTrimSheetAssetId: declaration.sharedTrimSheetAssetId,
            trimBands,
          }),
        )
      : contentHash(declaration.sharedTrimSheetAssetId);
  const socketsByAssetId = new Map<string, ReturnType<typeof buildMountSockets>>();
  if (declaration.mountSockets)
    for (const member of declaration.members) {
      const contact = evidence.mountContacts?.[member.assetId];
      if (!contact || contact.supportPlaneFits.length === 0) continue;
      const sockets = buildMountSockets({
        variantName: member.variantName,
        supportPlaneFits: contact.supportPlaneFits,
      });
      if (sockets.length > 0) socketsByAssetId.set(member.assetId, sockets);
    }
  if (declaration.jointSockets)
    for (const member of declaration.members) {
      const contact = evidence.jointContacts?.[member.assetId];
      if (!contact || contact.jointPlaneFits.length === 0) continue;
      const sockets = buildJointSockets({
        variantName: member.variantName,
        jointPlaneFits: contact.jointPlaneFits,
      });
      if (sockets.length === 0) continue;
      const combined = [...(socketsByAssetId.get(member.assetId) ?? []), ...sockets];
      if (combined.length > 128)
        throw new Error(
          `Member ${member.assetId} of ${declaration.familyName} seals ${combined.length} sockets, beyond the 128-socket archetype bound`,
        );
      socketsByAssetId.set(member.assetId, combined);
    }
  const socketGrammarHash =
    socketsByAssetId.size > 0
      ? contentHash(
          stableJson(
            [...socketsByAssetId.entries()]
              .sort(([left], [right]) => compareSpatialStrings(left, right))
              .map(([assetId, socket]) => ({ assetId, socket })),
          ),
        )
      : undefined;
  const merkleInput = {
    handle: declaration.handle,
    geometryHashes,
    materialTrimHash,
    physicsCompanionHash,
    ...(socketGrammarHash ? { socketGrammarHash } : {}),
  };
  const familyId = computeFamilyMerkleId(merkleInput);
  const styleHash = contentHash(
    stableJson({
      handle: declaration.handle,
      familyName: declaration.familyName,
      displayName: declaration.displayName,
      semanticRole: declaration.semanticRole,
      styleTokens: [...declaration.styleTokens].sort(),
    }),
  );
  return sealAssetFamilyRevision({
    familyId,
    familyHandle: declaration.handle,
    semanticRole: declaration.semanticRole,
    sharedTrimSheetAssetId: declaration.sharedTrimSheetAssetId,
    trimMappings,
    archetypes: declaration.members.map((member) => ({
      assetId: member.assetId,
      variantName: member.variantName,
      selectionWeight: quantizeQ32_32(1 / declaration.members.length),
      metricScaleVarianceMin: "0",
      metricScaleVarianceMax: "0",
      registeredSockets: [...(socketsByAssetId.get(member.assetId) ?? [])],
    })),
    compositeBoundingEnvelope: compositeEnvelope(resolvedRecords),
    globalStyleContractHash: styleHash,
    materialTrimSheetHash: materialTrimHash,
    geometryHashes,
    physicsCompanionHash,
    ...(socketGrammarHash ? { socketGrammarHash } : {}),
  });
}

function compositeEnvelope(records: readonly CatalogAssetRecord[]) {
  const minimum = { ...records[0]!.boundingBox.min };
  const maximum = { ...records[0]!.boundingBox.max };
  for (const record of records.slice(1))
    for (const axis of ["x", "y", "z"] as const) {
      if (BigInt(record.boundingBox.min[axis]) < BigInt(minimum[axis]))
        minimum[axis] = record.boundingBox.min[axis];
      if (BigInt(record.boundingBox.max[axis]) > BigInt(maximum[axis]))
        maximum[axis] = record.boundingBox.max[axis];
    }
  return { min: minimum, max: maximum };
}
