import { familyCardSchema, type FamilyCard } from "./family-card.js";

/** Code-unit string order. Locale-aware comparison must never feed sealed output. */
function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export interface CompactPaletteCard {
  readonly h: string;
  readonly id: string;
  readonly r: readonly string[];
  readonly arch: readonly (readonly [string, readonly [number, number, number]])[];
  readonly surf: readonly string[];
  readonly dens: readonly [number, number];
  readonly sock: { readonly e: number; readonly g: readonly string[] } | null;
}

export function serializePaletteMenu(cards: readonly FamilyCard[]): string {
  const canonical = cards
    .map((card) => familyCardSchema.parse(card))
    .sort((left, right) => compareStrings(left.fid, right.fid));
  return JSON.stringify(
    canonical.map<CompactPaletteCard>((card) => ({
      h: card.handle,
      id: card.fid,
      r: [...card.roles].sort(),
      arch: card.archetypes
        .map((archetype) => [archetype.token, archetype.bounds] as const)
        .sort((left, right) => compareStrings(left[0], right[0])),
      surf: [...card.affinities.surfaces].sort(),
      dens: [card.density.min_per_hectare, card.density.max_per_hectare],
      sock: card.sockets
        ? { e: card.sockets.elevation_step_dh, g: [...card.sockets.compatible_groups].sort() }
        : null,
    })),
  );
}
