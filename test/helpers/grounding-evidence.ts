import type { GroundingEvidenceFile } from "../../packages/world-compiler/src/index.js";

/**
 * Synthetic per-family grounding evidence for tests: one unit-tall asset per
 * archetype with rebased (centered) bounds. Production evidence comes from
 * measured inventory via the palette script.
 */
export function groundingEvidenceFixture(
  familyId: string,
  archetypeCount: number,
): GroundingEvidenceFile {
  return {
    kind: "BasaltFamilyGroundingEvidence",
    abi: "basalt-family-grounding-evidence@1",
    inventoryHash: "0".repeat(64),
    evidence: [
      {
        familyId,
        archetypes: Array.from({ length: archetypeCount }, (_, index) => ({
          assetId: `${familyId}_asset_${index}`,
          boundsMinimumStuds: { x: -1, y: 0, z: -1 },
          boundsMaximumStuds: { x: 1, y: 4, z: 1 },
          contactRadiusStuds: 0.5,
        })),
      },
    ],
  };
}
