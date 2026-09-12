import {
  HECTARE_STUDS2,
  ROLE_CLEARANCE_DEFAULTS,
  ROLE_DENSITY_DEFAULTS,
  SPATIAL_ROLES,
  type SpatialRole,
} from "../../basalt-types/src/index.js";

/**
 * Evidence-driven family cohort proposals. Every input is measured geometry,
 * topology, material, contact, or collision evidence; paths, filenames, and
 * vendor labels never enter. Output is a proposal for human review: a family
 * exists only when an authored declaration names it.
 *
 * Kind-first model: cohorts group by scale-free shape and structure.
 * Absolute size never excludes; it routes each cohort to compatible
 * treatment rows (density/clearance presets) that the seal validates.
 */

export interface ProposalAssetEvidence {
  readonly assetId: string;
  readonly boundsStuds: readonly [number, number, number];
  readonly triangleCount: number;
  readonly submeshCount: number;
  readonly primaryContact: string;
  readonly hasManifoldTopology: boolean;
  readonly topologicalGenus: number;
  readonly materialAppearanceHashes: readonly string[];
  readonly sourceFileHash: string;
}

export interface SiblingCoherenceWeights {
  readonly aspectWeight?: number;
}

export interface ProposalDistanceOptions {
  /** Number of assets sharing each material hash (inverse-frequency weight). */
  readonly hashDocumentFrequency: ReadonlyMap<string, number>;
  readonly assetCount: number;
  readonly aspectWeight?: number;
}

const LOG_FLOOR = 1e-3;

/**
 * Scale-free dissimilarity between two measured assets: shape (aspect
 * ratios), structure (submesh, topology), support (contact), and material
 * overlap. Absolute size and triangle count deliberately do not enter: a
 * miniature and a landscape variant of one kind cohere, and detail classes
 * mix within a family. Size governs treatment derivation, never membership.
 */
export function siblingCoherenceDistance(
  left: ProposalAssetEvidence,
  right: ProposalAssetEvidence,
  options: ProposalDistanceOptions,
): number {
  const aspectWeight = options.aspectWeight ?? 1;
  const aspect = (ev: ProposalAssetEvidence): [number, number] => {
    const [x, y, z] = ev.boundsStuds;
    const horiz = Math.max(Math.max(x, z), LOG_FLOOR);
    return [y / horiz, Math.min(x, z) / horiz];
  };
  const [leftA1, leftA2] = aspect(left);
  const [rightA1, rightA2] = aspect(right);
  let distance = aspectWeight * ((leftA1 - rightA1) ** 2 + (leftA2 - rightA2) ** 2);
  if (left.submeshCount !== right.submeshCount) distance += 0.3;
  if (left.primaryContact !== right.primaryContact) distance += 4;
  if (left.hasManifoldTopology !== right.hasManifoldTopology) distance += 1;
  const genusBand = (genus: number): number => (genus < 0 ? -1 : genus === 0 ? 0 : 1);
  if (genusBand(left.topologicalGenus) !== genusBand(right.topologicalGenus)) distance += 1;
  const leftHashes = new Set(left.materialAppearanceHashes);
  const rightHashes = new Set(right.materialAppearanceHashes);
  const shared = [...leftHashes].some((hash) => rightHashes.has(hash));
  if (shared) {
    let bonus = 0;
    for (const hash of leftHashes) {
      if (!rightHashes.has(hash)) continue;
      const frequency = options.hashDocumentFrequency.get(hash) ?? options.assetCount;
      bonus = Math.max(bonus, Math.min(2, Math.log(options.assetCount / Math.max(frequency, 1))));
    }
    distance = Math.max(0, distance - bonus);
  } else if (leftHashes.size > 0 && rightHashes.size > 0) {
    distance += 1.5;
  }
  return distance;
}

/**
 * Sibling coherence threshold: every declaration member must sit within this
 * distance of the declaration medoid (medoid-star topology: bounded spread,
 * tolerant of shape gradients within a kind). Calibrated on the nine
 * dissolved starter families (62 members): worst medoid radius 2.959
 * (palm crowns), so 3.0 coheres all nine whole. Pinned so reruns are
 * byte-identical.
 */
export const KIND_COHERENCE_THRESHOLD = 3.0;

/**
 * Proposer cohort diameter (complete linkage): every pair inside a cohort
 * sits within this distance, so cohorts are bounded blobs for review.
 * Stays at or below KIND_COHERENCE_THRESHOLD so every proposed cohort
 * seals under medoid-star admission; stable across 2.0-2.5 on the starter
 * catalog (58 cohorts, largest 62, split flagged over 16 for review
 * splitting). Pinned so reruns are byte-identical.
 */
export const PROPOSAL_CLUSTER_THRESHOLD = 2.5;

export interface SiblingCoherenceVerdict {
  /** Asset IDs beyond threshold from the medoid; empty means coherent. */
  readonly outliers: readonly string[];
  /** Asset ID of the medoid (minimum total distance, asset-ID tiebreak). */
  readonly medoidAssetId: string | null;
}

/**
 * Medoid-star coherence check for one declaration's members. Deterministic:
 * medoid minimizes total sibling distance with asset-ID tiebreak; outliers
 * sort by asset ID.
 */
export function checkSiblingCoherence(
  assets: readonly ProposalAssetEvidence[],
  threshold: number = KIND_COHERENCE_THRESHOLD,
  weights: SiblingCoherenceWeights = {},
): SiblingCoherenceVerdict {
  const ordered = [...assets].sort((a, b) => a.assetId.localeCompare(b.assetId));
  if (ordered.length === 0) return { outliers: [], medoidAssetId: null };
  const frequency = new Map<string, number>();
  for (const asset of ordered)
    for (const hash of new Set(asset.materialAppearanceHashes))
      frequency.set(hash, (frequency.get(hash) ?? 0) + 1);
  const options: ProposalDistanceOptions = {
    hashDocumentFrequency: frequency,
    assetCount: ordered.length,
    ...weights,
  };
  const size = ordered.length;
  const matrix = new Float64Array(size * size);
  for (let i = 0; i < size; i += 1)
    for (let j = i + 1; j < size; j += 1) {
      const distance = siblingCoherenceDistance(ordered[i]!, ordered[j]!, options);
      matrix[i * size + j] = distance;
      matrix[j * size + i] = distance;
    }
  let medoid = 0;
  let medoidTotal = Number.POSITIVE_INFINITY;
  for (let i = 0; i < size; i += 1) {
    let total = 0;
    for (let j = 0; j < size; j += 1) total += matrix[i * size + j]!;
    if (
      total < medoidTotal ||
      (total === medoidTotal && ordered[i]!.assetId < ordered[medoid]!.assetId)
    ) {
      medoid = i;
      medoidTotal = total;
    }
  }
  const outliers: string[] = [];
  for (let i = 0; i < size; i += 1)
    if (matrix[medoid * size + i]! > threshold) outliers.push(ordered[i]!.assetId);
  outliers.sort((a, b) => a.localeCompare(b));
  return { outliers, medoidAssetId: ordered[medoid]!.assetId };
}

/**
 * Cluster member IDs by sibling coherence distance with complete linkage.
 * Deterministic: pairs sort by (distance, lesser ID, greater ID) and merge
 * while the merged cluster's diameter stays within threshold.
 */
export function clusterSiblings(
  assets: readonly ProposalAssetEvidence[],
  threshold: number = PROPOSAL_CLUSTER_THRESHOLD,
  weights: SiblingCoherenceWeights = {},
): string[][] {
  const ordered = [...assets].sort((a, b) => a.assetId.localeCompare(b.assetId));
  const frequency = new Map<string, number>();
  for (const asset of ordered)
    for (const hash of new Set(asset.materialAppearanceHashes))
      frequency.set(hash, (frequency.get(hash) ?? 0) + 1);
  const options: ProposalDistanceOptions = {
    hashDocumentFrequency: frequency,
    assetCount: ordered.length,
    ...weights,
  };
  const size = ordered.length;
  const matrix = new Float64Array(size * size);
  const pairs: Array<{ distance: number; left: number; right: number }> = [];
  for (let i = 0; i < size; i += 1)
    for (let j = i + 1; j < size; j += 1) {
      const distance = siblingCoherenceDistance(ordered[i]!, ordered[j]!, options);
      matrix[i * size + j] = distance;
      matrix[j * size + i] = distance;
      pairs.push({ distance, left: i, right: j });
    }
  pairs.sort(
    (a, b) =>
      a.distance - b.distance ||
      ordered[a.left]!.assetId.localeCompare(ordered[b.left]!.assetId) ||
      ordered[a.right]!.assetId.localeCompare(ordered[b.right]!.assetId),
  );
  const parent = ordered.map((_, index) => index);
  const members = ordered.map((_, index) => [index]);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root]!;
    return root;
  };
  const diameterAcross = (left: readonly number[], right: readonly number[]): number => {
    let worst = 0;
    for (const a of left) for (const b of right) worst = Math.max(worst, matrix[a * size + b]!);
    return worst;
  };
  for (const pair of pairs) {
    if (pair.distance > threshold) break;
    const leftRoot = find(pair.left);
    const rightRoot = find(pair.right);
    if (leftRoot === rightRoot) continue;
    if (diameterAcross(members[leftRoot]!, members[rightRoot]!) > threshold) continue;
    const keep = Math.min(leftRoot, rightRoot);
    const drop = Math.max(leftRoot, rightRoot);
    parent[drop] = keep;
    members[keep] = [...members[keep]!, ...members[drop]!];
    members[drop] = [];
  }
  const clusters: string[][] = [];
  for (let i = 0; i < size; i += 1) {
    if (parent[i] !== i || members[i]!.length === 0) continue;
    clusters.push(
      members[i]!.map((index) => ordered[index]!.assetId).sort((a, b) => a.localeCompare(b)),
    );
  }
  clusters.sort((a, b) => a[0]!.localeCompare(b[0]!));
  return clusters;
}

/**
 * Treatment rows whose density preset is physically realizable for a cohort
 * of the given largest horizontal extent (coverage formula: max density ×
 * clearance cell must fit one hectare). Zero-density rows (hand-placed)
 * always qualify. Advisory for review; the seal revalidates the declared
 * row. Deterministic SPATIAL_ROLES order.
 */
export function compatibleTreatments(maxExtentStuds: number): SpatialRole[] {
  const compatible: SpatialRole[] = [];
  for (const role of SPATIAL_ROLES) {
    const density = ROLE_DENSITY_DEFAULTS[role];
    if (density.max_per_hectare <= 0) {
      compatible.push(role);
      continue;
    }
    const clearance = ROLE_CLEARANCE_DEFAULTS[role];
    const cell = (maxExtentStuds + 2 * clearance) ** 2;
    if (density.max_per_hectare * cell <= HECTARE_STUDS2) compatible.push(role);
  }
  return compatible;
}

export interface FamilyCohortProposal {
  readonly cohortId: string;
  readonly members: readonly string[];
  /** Mean aspect ratios (a1 = y/max(x,z), a2 = min(x,z)/max(x,z)). */
  readonly aspectCentroid: readonly [number, number];
  /** Per-axis measured span across members: absolute size as evidence. */
  readonly sizeRange: {
    readonly minBounds: readonly [number, number, number];
    readonly maxBounds: readonly [number, number, number];
  };
  readonly compatibleTreatments: readonly SpatialRole[];
  readonly splitCandidate: boolean;
}

export interface ExcludedProposalAsset {
  readonly assetId: string;
  readonly reason: string;
}

/**
 * Size-octave partition key: floor(log2(maxdim)). Review bucketing only —
 * the seal stays scale-free, so the author may always declare across
 * octaves and the gate decides on kind.
 */
export function sizeOctave(boundsStuds: readonly [number, number, number]): number {
  return Math.floor(Math.log2(Math.max(Math.max(...boundsStuds), 1e-3)));
}

export function proposeFamilyCohorts(
  assets: readonly ProposalAssetEvidence[],
  threshold: number = PROPOSAL_CLUSTER_THRESHOLD,
  weights: SiblingCoherenceWeights = {},
): {
  cohorts: FamilyCohortProposal[];
  singletons: string[];
  excluded: ExcludedProposalAsset[];
} {
  const byId = new Map(assets.map((asset) => [asset.assetId, asset]));
  const clusterable: ProposalAssetEvidence[] = [];
  const excluded: ExcludedProposalAsset[] = [];
  for (const asset of assets) {
    if (asset.primaryContact !== "bottom") {
      excluded.push({
        assetId: asset.assetId,
        reason:
          `No measured support evidence (primaryContact ${asset.primaryContact}); ` +
          `placeable families require bottom support.`,
      });
      continue;
    }
    clusterable.push(asset);
  }
  const octaves = new Map<number, ProposalAssetEvidence[]>();
  for (const asset of clusterable) {
    const key = sizeOctave(asset.boundsStuds);
    if (!octaves.has(key)) octaves.set(key, []);
    octaves.get(key)!.push(asset);
  }
  const groups = [...octaves.values()].flatMap((band) => clusterSiblings(band, threshold, weights));
  const cohorts: FamilyCohortProposal[] = [];
  const singletons: string[] = [];
  for (const members of groups) {
    if (members.length < 2) {
      singletons.push(...members);
      continue;
    }
    const evidence = members.map((id) => byId.get(id)!);
    let a1 = 0;
    let a2 = 0;
    const minBounds = [Infinity, Infinity, Infinity];
    const maxBounds = [-Infinity, -Infinity, -Infinity];
    for (const member of evidence) {
      const [x, y, z] = member.boundsStuds;
      const horiz = Math.max(Math.max(x, z), LOG_FLOOR);
      a1 += y / horiz;
      a2 += Math.min(x, z) / horiz;
      for (const [axis, value] of [x, y, z].entries()) {
        minBounds[axis] = Math.min(minBounds[axis]!, value);
        maxBounds[axis] = Math.max(maxBounds[axis]!, value);
      }
    }
    const maxExtent = Math.max(maxBounds[0]!, maxBounds[2]!);
    cohorts.push({
      cohortId: "",
      members: [...members].sort((a, b) => a.localeCompare(b)),
      aspectCentroid: [a1 / members.length, a2 / members.length],
      sizeRange: {
        minBounds: minBounds as [number, number, number],
        maxBounds: maxBounds as [number, number, number],
      },
      compatibleTreatments: compatibleTreatments(maxExtent),
      splitCandidate: members.length > 16,
    });
  }
  cohorts.sort((a, b) => a.members[0]!.localeCompare(b.members[0]!));
  const numbered = cohorts.map((proposal, index) => ({
    ...proposal,
    cohortId: `cohort_${String(index + 1).padStart(3, "0")}`,
  }));
  singletons.sort((a, b) => a.localeCompare(b));
  excluded.sort((a, b) => a.assetId.localeCompare(b.assetId));
  return { cohorts: numbered, singletons, excluded };
}
