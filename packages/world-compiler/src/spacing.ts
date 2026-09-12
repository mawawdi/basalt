import type { WorldFamilyPopulationPlan } from "./contracts.js";
import type { GroundingEvidenceIndex } from "./grounding.js";

/**
 * Extent-aware spacing on a uniform grid (Bridson-style). Each placement
 * claims its contact disc; radii vary per instance (contact radius × scale
 * with an absolute floor), so the neighborhood covers the worst-case pair.
 *
 * One grid per surface persists across families: earlier families claim space
 * first in family-id order, which keeps cross-family clearance deterministic.
 */

/** Absolute clearance floor; pairwise sums preserve the legacy 0.5-stud gap. */
export const MINIMUM_CLEARANCE_RADIUS_STUDS = 0.25;

export function clearanceRadius(contactRadiusStuds: number, scale: number): number {
  if (!Number.isFinite(contactRadiusStuds) || contactRadiusStuds <= 0)
    throw new Error("Contact radius must be positive");
  if (!Number.isFinite(scale) || scale <= 0) throw new Error("Clearance scale must be positive");
  return Math.max(contactRadiusStuds * scale, MINIMUM_CLEARANCE_RADIUS_STUDS);
}

/** Upper-bound radius over every planned family archetype for grid sizing. */
export function maximumClearanceRadius(
  familyPlans: readonly WorldFamilyPopulationPlan[],
  evidence: GroundingEvidenceIndex,
): number {
  let maximum = MINIMUM_CLEARANCE_RADIUS_STUDS;
  for (const plan of familyPlans) {
    const archetypes = evidence.get(plan.familyId);
    if (!archetypes) throw new Error(`Spacing has no grounding evidence for: ${plan.familyId}`);
    const scaleMaximum = plan.scaleRange?.[1] ?? 1.08;
    for (const archetype of archetypes)
      maximum = Math.max(maximum, archetype.contactRadiusStuds * scaleMaximum);
  }
  return maximum;
}

export interface CrossFamilySpacing {
  readonly cellSizeStuds: number;
  /**
   * Claim a contact disc, returning false when it would overlap a claimed
   * disc on the same surface. Touching discs (distance exactly the radii sum)
   * are allowed.
   */
  tryClaim(surfaceId: string, x: number, z: number, radius: number): boolean;
}

export function createCrossFamilySpacing(maximumRadius: number): CrossFamilySpacing {
  if (!Number.isFinite(maximumRadius) || maximumRadius <= 0)
    throw new Error("Spacing maximum radius must be positive");
  const cell = maximumRadius / Math.SQRT2;
  // Worst-case pair sums to 2 × maximum; ±3 cells cover 3/√2 ≈ 2.12 × maximum.
  const extent = 3;
  const grids = new Map<string, Map<string, Array<{ x: number; z: number; radius: number }>>>();
  return {
    cellSizeStuds: cell,
    tryClaim(surfaceId: string, x: number, z: number, radius: number): boolean {
      if (!Number.isFinite(radius) || radius <= 0 || radius > maximumRadius + 1e-9)
        throw new Error("Claim radius escapes the spacing grid bound");
      let grid = grids.get(surfaceId);
      if (!grid) {
        grid = new Map();
        grids.set(surfaceId, grid);
      }
      const cellX = Math.floor(x / cell);
      const cellZ = Math.floor(z / cell);
      for (let dx = -extent; dx <= extent; dx += 1) {
        for (let dz = -extent; dz <= extent; dz += 1) {
          const claimed = grid.get(`${cellX + dx},${cellZ + dz}`);
          if (!claimed) continue;
          for (const entry of claimed) {
            if (Math.hypot(entry.x - x, entry.z - z) < entry.radius + radius) return false;
          }
        }
      }
      const key = `${cellX},${cellZ}`;
      const cellEntries = grid.get(key);
      if (cellEntries) cellEntries.push({ x, z, radius });
      else grid.set(key, [{ x, z, radius }]);
      return true;
    },
  };
}
