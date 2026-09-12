import test from "node:test";
import assert from "node:assert/strict";
import {
  checkSiblingCoherence,
  clusterSiblings,
  compatibleTreatments,
  KIND_COHERENCE_THRESHOLD,
  PROPOSAL_CLUSTER_THRESHOLD,
  proposeFamilyCohorts,
  siblingCoherenceDistance,
  type ProposalAssetEvidence,
  type ProposalDistanceOptions,
} from "../packages/catalog-intelligence/src/family-proposals.js";

function evidence(
  partial: Partial<ProposalAssetEvidence> & { assetId: string },
): ProposalAssetEvidence {
  return {
    boundsStuds: [3, 3, 3],
    triangleCount: 1000,
    submeshCount: 1,
    primaryContact: "bottom",
    hasManifoldTopology: true,
    topologicalGenus: 0,
    materialAppearanceHashes: ["common"],
    sourceFileHash: `file_${partial.assetId}`,
    ...partial,
  };
}

function optionsFor(assets: ProposalAssetEvidence[]): ProposalDistanceOptions {
  const frequency = new Map<string, number>();
  for (const asset of assets)
    for (const hash of new Set(asset.materialAppearanceHashes))
      frequency.set(hash, (frequency.get(hash) ?? 0) + 1);
  return { hashDocumentFrequency: frequency, assetCount: assets.length };
}

test("sibling distance ignores absolute size and triangle count", () => {
  const miniature = evidence({
    assetId: "miniature",
    boundsStuds: [0.8, 1, 0.8],
    triangleCount: 50,
  });
  const landscape = evidence({
    assetId: "landscape",
    boundsStuds: [8, 10, 8],
    triangleCount: 50000,
  });
  const options = optionsFor([miniature, landscape]);
  assert.equal(siblingCoherenceDistance(miniature, landscape, options), 0);
  const blade = evidence({ assetId: "blade", boundsStuds: [0.8, 3.2, 0.2] });
  const slab = evidence({ assetId: "slab", boundsStuds: [20, 1, 20] });
  assert.ok(
    siblingCoherenceDistance(blade, slab, optionsFor([blade, slab])) > KIND_COHERENCE_THRESHOLD,
  );
});

test("contact mismatch splits otherwise identical geometry", () => {
  const grounded = evidence({ assetId: "grounded", boundsStuds: [3, 3, 3] });
  const floating = evidence({
    assetId: "floating",
    boundsStuds: [3, 3, 3],
    primaryContact: "unknown",
  });
  const options = optionsFor([grounded, floating]);
  assert.equal(siblingCoherenceDistance(grounded, floating, options), 4);
});

test("coherence thresholds stay pinned to calibration", () => {
  assert.equal(KIND_COHERENCE_THRESHOLD, 3.0);
  assert.equal(PROPOSAL_CLUSTER_THRESHOLD, 2.5);
});

test("sibling coherence flags outliers from the medoid", () => {
  const assets = [
    evidence({ assetId: "a", boundsStuds: [3.1, 3.8, 3.1] }),
    evidence({ assetId: "b", boundsStuds: [3.0, 3.7, 3.0] }),
    evidence({ assetId: "c", boundsStuds: [3.2, 3.9, 3.2] }),
  ];
  assert.deepEqual(checkSiblingCoherence(assets).outliers, []);
  const withOutlier = [...assets, evidence({ assetId: "z", boundsStuds: [0.8, 3.2, 0.2] })];
  assert.deepEqual(checkSiblingCoherence(withOutlier).outliers, ["z"]);
  assert.deepEqual(checkSiblingCoherence([]), { outliers: [], medoidAssetId: null });
});

test("sibling clustering separates shapes and unites scales", () => {
  const blade = evidence({ assetId: "blade", boundsStuds: [0.8, 3.2, 0.2] });
  const slab = evidence({ assetId: "slab", boundsStuds: [20, 1, 20] });
  assert.deepEqual(clusterSiblings([blade, slab]), [["blade"], ["slab"]]);
  const small = evidence({ assetId: "small", boundsStuds: [3, 3, 3] });
  const large = evidence({ assetId: "large", boundsStuds: [30, 30, 30] });
  assert.deepEqual(clusterSiblings([small, large]), [["large", "small"]]);
});

test("compatible treatments follow the coverage formula", () => {
  assert.deepEqual(compatibleTreatments(3), [
    "foundation",
    "barrier",
    "canopy",
    "groundcover",
    "focal_insert",
    "portal",
    "connector",
    "clutter",
  ]);
  assert.deepEqual(compatibleTreatments(30), [
    "foundation",
    "barrier",
    "canopy",
    "focal_insert",
    "portal",
    "connector",
  ]);
  assert.deepEqual(compatibleTreatments(200), ["foundation", "barrier", "portal", "connector"]);
});

test("cohort proposals exclude unsupported assets, never force them", () => {
  const assets = [
    evidence({ assetId: "grounded", boundsStuds: [3, 3, 3] }),
    evidence({ assetId: "floating", boundsStuds: [3, 3, 3], primaryContact: "unknown" }),
  ];
  const { cohorts, singletons, excluded } = proposeFamilyCohorts(assets);
  assert.equal(cohorts.length, 0);
  assert.deepEqual(singletons, ["grounded"]);
  assert.equal(excluded.length, 1);
  assert.equal(excluded[0]!.assetId, "floating");
  assert.match(excluded[0]!.reason, /no measured support evidence/i);
});

test("cohort proposals carry shape evidence and compatible treatments", () => {
  const assets = [
    evidence({ assetId: "a", boundsStuds: [3, 3, 3] }),
    evidence({ assetId: "b", boundsStuds: [3.2, 2.8, 3.1] }),
    evidence({ assetId: "c", boundsStuds: [0.8, 3.2, 0.2] }),
  ];
  const { cohorts, singletons, excluded } = proposeFamilyCohorts(assets);
  assert.equal(excluded.length, 0);
  assert.deepEqual(singletons, ["c"]);
  assert.equal(cohorts.length, 1);
  assert.equal(cohorts[0]!.cohortId, "cohort_001");
  assert.deepEqual(cohorts[0]!.members, ["a", "b"]);
  assert.ok(Math.abs(cohorts[0]!.aspectCentroid[0] - 0.95) < 0.1);
  assert.deepEqual(cohorts[0]!.sizeRange.minBounds, [3, 2.8, 3]);
  assert.deepEqual(cohorts[0]!.sizeRange.maxBounds, [3.2, 3, 3.1]);
  assert.ok(cohorts[0]!.compatibleTreatments.includes("clutter"));
  assert.equal(cohorts[0]!.splitCandidate, false);
});

test("cohort proposals are deterministic under input order", () => {
  const assets = [
    evidence({ assetId: "b", boundsStuds: [3.1, 3.8, 3.1] }),
    evidence({ assetId: "a", boundsStuds: [3.0, 3.7, 3.0] }),
    evidence({ assetId: "c", boundsStuds: [22, 12, 22], triangleCount: 4000 }),
  ];
  const first = proposeFamilyCohorts(assets);
  const second = proposeFamilyCohorts([...assets].reverse());
  assert.deepEqual(first, second);
});
