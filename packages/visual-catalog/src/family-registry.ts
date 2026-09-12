import { contentHash, stableJson } from "../../contracts/src/index.js";
import {
  assetFamilyRevisionSchema,
  familyCardSchema,
  type AssetFamilyRevision,
  type FamilyCard,
} from "../../basalt-types/src/index.js";
import { z } from "zod";

export const VISUAL_FAMILY_REGISTRY_ABI = "basalt-visual-family-registry@1" as const;

export const visualFamilyRegistrySchema = z
  .object({
    kind: z.literal("VisualFamilyRegistry"),
    abi: z.literal(VISUAL_FAMILY_REGISTRY_ABI),
    families: z.array(assetFamilyRevisionSchema).max(20_000),
    cards: z.array(familyCardSchema).max(20_000),
    hash: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
export type VisualFamilyRegistry = z.infer<typeof visualFamilyRegistrySchema>;

export function sealVisualFamilyRegistry(
  families: readonly AssetFamilyRevision[],
  cards: readonly FamilyCard[],
): VisualFamilyRegistry {
  const canonicalFamilies = families
    .map((family) => assetFamilyRevisionSchema.parse(family))
    .sort((left, right) => left.familyId.localeCompare(right.familyId));
  const canonicalCards = cards
    .map((card) => familyCardSchema.parse(card))
    .sort((left, right) => left.fid.localeCompare(right.fid));
  if (new Set(canonicalFamilies.map((family) => family.familyId)).size !== canonicalFamilies.length)
    throw new Error("Visual family registry family IDs must be unique");
  if (new Set(canonicalCards.map((card) => card.fid)).size !== canonicalCards.length)
    throw new Error("Visual family registry card IDs must be unique");
  const familyIds = new Set(canonicalFamilies.map((family) => family.familyId));
  if (canonicalCards.some((card) => !familyIds.has(card.fid)))
    throw new Error("Visual family card has no family revision");
  const material = {
    kind: "VisualFamilyRegistry" as const,
    abi: VISUAL_FAMILY_REGISTRY_ABI,
    families: canonicalFamilies,
    cards: canonicalCards,
  };
  return visualFamilyRegistrySchema.parse({ ...material, hash: contentHash(stableJson(material)) });
}

export function assertVisualFamilyRegistryIdentity(
  value: unknown,
): asserts value is VisualFamilyRegistry {
  const registry = visualFamilyRegistrySchema.parse(value);
  const { hash, ...material } = registry;
  if (contentHash(stableJson(material)) !== hash)
    throw new Error("Visual family registry identity is invalid");
}
