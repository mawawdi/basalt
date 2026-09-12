import { parseFamilyHandle, type FamilyCard } from "../../basalt-types/src/index.js";
import type { AssetFamilyRevision } from "../../basalt-types/src/index.js";
import type { CatalogAssetEnvelope } from "../../catalog-intelligence/src/contracts.js";
import { sealWorldAssetFamilyRegistry, type WorldAssetFamilyRegistry } from "./family-resolver.js";

/**
 * Adapts sealed catalog families to the tag-index registry the compiler CLI
 * consumes. Tags derive from declared handle segments only, never paths.
 * Families with unmeasured or unadmitted members are excluded, mirroring the
 * canonical resolver's hard admission filter.
 */
export function adaptSealedCatalogToRegistry(input: {
  readonly revisions: readonly AssetFamilyRevision[];
  readonly cards: readonly FamilyCard[];
  readonly assets: readonly CatalogAssetEnvelope[];
}): WorldAssetFamilyRegistry {
  const cardsById = new Map(input.cards.map((card) => [card.fid, card]));
  const assetsById = new Map(input.assets.map((asset) => [asset.record.assetId, asset]));
  const candidates: {
    familyId: string;
    semanticTags: string[];
    styleTags: string[];
    roleTags: string[];
    variantCount: number;
  }[] = [];
  for (const revision of input.revisions) {
    const card = cardsById.get(revision.familyId);
    if (!card) continue;
    const members = revision.archetypes.map((archetype) => assetsById.get(archetype.assetId));
    const measured = members.filter(
      (asset): asset is CatalogAssetEnvelope =>
        asset !== undefined && asset.measurement.status === "measured",
    );
    if (measured.length !== revision.archetypes.length) continue;
    if (measured.some((asset) => asset.record.admissionStatus !== "locally_qualified")) continue;
    const parsed = parseFamilyHandle(card.handle);
    candidates.push({
      familyId: revision.familyId,
      semanticTags: [parsed.domain, parsed.morphologyNoun],
      styleTags: [parsed.styleMotif],
      roleTags: [parsed.spatialRole],
      variantCount: revision.archetypes.length,
    });
  }
  return sealWorldAssetFamilyRegistry(candidates);
}
