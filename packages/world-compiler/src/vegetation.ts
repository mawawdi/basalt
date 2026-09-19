import { contentHash, compareCanonicalStrings } from "@basalt/contracts";
import type {
  AssetPlacementGeometry,
  PopulationDensityField,
  RealizationIntent,
  VegetationDistribution,
} from "@basalt/catalog-model";
import { populationDensityAt } from "./population-density.js";
import type { RealizedInstance } from "./world-build.js";

export type VegetationIntent = Extract<RealizationIntent, { kind: "surface_scatter" }> & {
  vegetation: VegetationDistribution;
  densityField: PopulationDensityField;
};
export function isVegetationIntent(intent: RealizationIntent): intent is VegetationIntent {
  return (
    intent.kind === "surface_scatter" &&
    intent.vegetation !== undefined &&
    intent.densityField !== undefined
  );
}

/** Nine terrain probes across the measured bottom envelope; no mesh deformation or terrain edits. */
export function vegetationGroundElevation(input: {
  readonly geometry: AssetPlacementGeometry;
  readonly x: number;
  readonly z: number;
  readonly yawRadians: number;
  readonly maximumReliefMeters: number;
  readonly embedMeters: number;
  readonly heightAt: (x: number, z: number) => number;
}): number | undefined {
  const bottom = input.geometry.bands.reduce((a, b) => (a.min.y <= b.min.y ? a : b));
  const elevations: number[] = [];
  const c = Math.cos(input.yawRadians),
    s = Math.sin(input.yawRadians);
  for (const u of [0, 0.5, 1])
    for (const v of [0, 0.5, 1]) {
      const x = bottom.min.x + u * (bottom.max.x - bottom.min.x);
      const z = bottom.min.z + v * (bottom.max.z - bottom.min.z);
      const elevation = input.heightAt(input.x + c * x + s * z, input.z - s * x + c * z);
      if (!Number.isFinite(elevation)) return undefined;
      elevations.push(elevation);
    }
  const minimum = Math.min(...elevations),
    maximum = Math.max(...elevations);
  if (maximum - minimum > input.maximumReliefMeters + 1e-9) return undefined;
  return minimum - input.embedMeters;
}

export interface VegetationCandidate {
  readonly x: number;
  readonly z: number;
  readonly hash: string;
}
export interface VegetationPlacementSummary {
  readonly intentId: string;
  readonly trials: number;
  considered: number;
  placed: number;
}

/**
 * Finite adaptive dart throwing with joint species competition, followed by canopy-conditioned
 * layers. Trial density is absolute; a cost cap never triggers replenishment. This is a bounded
 * regional sampler, not an ecosystem simulator or a chunk-invariant Bridson implementation.
 */
export function distributeVegetation(
  intents: readonly VegetationIntent[],
  context: {
    readonly seed: number;
    readonly initialCanopy: readonly RealizedInstance[];
    readonly heightAt: (surfaceId: string, x: number, z: number) => number;
    readonly place: (
      intent: VegetationIntent,
      candidate: VegetationCandidate,
    ) => RealizedInstance | undefined;
  },
): VegetationPlacementSummary[] {
  const summaries = new Map<string, VegetationPlacementSummary>();
  const candidates = new Map<string, VegetationCandidate[]>();
  let totalTrials = 0;
  for (const intent of [...intents].sort((a, b) =>
    compareCanonicalStrings(a.intentId, b.intentId),
  )) {
    const xs = intent.boundary.map((p) => p.u),
      zs = intent.boundary.map((p) => p.v);
    const minX = Math.min(...xs),
      minZ = Math.min(...zs);
    const width = Math.max(...xs) - minX,
      depth = Math.max(...zs) - minZ;
    const trials = Math.ceil(width * depth * intent.vegetation.candidateDensityPerSquareMeter);
    totalTrials += trials;
    if (trials > 65_536 || totalTrials > 262_144)
      throw new Error(
        "Vegetation trial budget exceeded; compile a smaller bounded region or lower candidate density",
      );
    const points: VegetationCandidate[] = [];
    for (let i = 0; i < trials; i++) {
      const hash = contentHash(`${context.seed}:${intent.intentId}:${i}`);
      const x = minX + unit(hash, 0) * width,
        z = minZ + unit(hash, 8) * depth;
      if (insideBoundary(intent.boundary, x, z)) points.push({ x, z, hash });
    }
    candidates.set(intent.intentId, points);
    summaries.set(intent.intentId, { intentId: intent.intentId, trials, considered: 0, placed: 0 });
  }
  const canopy = [...context.initialCanopy];
  for (const layer of ["canopy", "understory", "ground_cover"] as const) {
    const group = intents.filter((intent) => intent.vegetation.layer === layer);
    if (group.length === 0) continue;
    const grid = new SpacingGrid(
      Math.max(...group.map((intent) => intent.vegetation.spacingMeters.maximum)),
    );
    const stream = group
      .flatMap((intent) =>
        candidates.get(intent.intentId)!.map((candidate) => ({ intent, candidate })),
      )
      .sort(
        (a, b) =>
          b.intent.priority - a.intent.priority ||
          compareCanonicalStrings(a.candidate.hash, b.candidate.hash) ||
          compareCanonicalStrings(a.intent.intentId, b.intent.intentId),
      );
    for (const { intent, candidate } of stream) {
      const summary = summaries.get(intent.intentId)!;
      if (summary.placed >= intent.targetCount) continue;
      const { x, z } = candidate;
      const policy = intent.vegetation;
      const y = context.heightAt(intent.surfaceId, x, z);
      const cover = canopyInfluenceAt(
        canopy.filter((plant) => policy.canopyIntentIds.includes(plant.intentId)),
        x,
        z,
      );
      const response =
        policy.canopyResponse.open +
        (policy.canopyResponse.covered - policy.canopyResponse.open) * cover;
      const density =
        populationDensityAt(intent.densityField, x, z, boundaryDistance(intent.boundary, x, z)) *
        response *
        clearingFalloff(policy, x, y, z);
      if (unit(candidate.hash, 16) >= density) continue;
      const radius =
        policy.spacingMeters.minimum +
        (policy.spacingMeters.maximum - policy.spacingMeters.minimum) * (1 - density);
      const scope = `${intent.regionId}/${intent.surfaceId}`;
      if (grid.conflicts(scope, x, z, radius)) continue;
      const delta = 0.25;
      const gradientX =
        (context.heightAt(intent.surfaceId, x + delta, z) -
          context.heightAt(intent.surfaceId, x - delta, z)) /
        (2 * delta);
      const gradientZ =
        (context.heightAt(intent.surfaceId, x, z + delta) -
          context.heightAt(intent.surfaceId, x, z - delta)) /
        (2 * delta);
      if (
        (Math.atan(Math.hypot(gradientX, gradientZ)) * 180) / Math.PI >
        policy.maximumSlopeDegrees + 1e-9
      )
        continue;
      summary.considered++;
      const instance = context.place(intent, candidate);
      if (!instance) continue;
      summary.placed++;
      grid.add(scope, x, z, radius);
      if (layer === "canopy") canopy.push(instance);
    }
  }
  return [...summaries.values()];
}

/** An authored geometric influence field, not a claim of measured illumination. */
export function canopyInfluenceAt(
  canopy: readonly Pick<RealizedInstance, "boundsMeters">[],
  x: number,
  z: number,
): number {
  let cover = 0;
  for (const { boundsMeters: box } of canopy) {
    const rx = Math.max(0.01, (box.max.x - box.min.x) / 2),
      rz = Math.max(0.01, (box.max.z - box.min.z) / 2);
    const distance = Math.hypot(
      (x - (box.min.x + box.max.x) / 2) / rx,
      (z - (box.min.z + box.max.z) / 2) / rz,
    );
    cover = Math.max(cover, smooth((1.3 - distance) / 0.6));
  }
  return cover;
}

function clearingFalloff(policy: VegetationDistribution, x: number, y: number, z: number): number {
  let value = 1;
  for (const clearing of policy.clearings) {
    const { min, max } = clearing.boundsMeters;
    if (y < min.y || y > max.y) continue;
    const distance = Math.hypot(
      Math.max(min.x - x, 0, x - max.x),
      Math.max(min.z - z, 0, z - max.z),
    );
    if (distance === 0) return 0;
    if (clearing.falloffMeters > 0)
      value = Math.min(value, smooth(distance / clearing.falloffMeters));
  }
  return value;
}

class SpacingGrid {
  readonly cells = new Map<string, Array<{ x: number; z: number; radius: number }>>();
  constructor(readonly size: number) {}
  conflicts(scope: string, x: number, z: number, radius: number): boolean {
    const ix = Math.floor(x / this.size),
      iz = Math.floor(z / this.size);
    for (let dx = -1; dx <= 1; dx++)
      for (let dz = -1; dz <= 1; dz++)
        for (const point of this.cells.get(`${scope}:${ix + dx}:${iz + dz}`) ?? [])
          if (Math.hypot(x - point.x, z - point.z) < Math.max(radius, point.radius)) return true;
    return false;
  }
  add(scope: string, x: number, z: number, radius: number): void {
    const key = `${scope}:${Math.floor(x / this.size)}:${Math.floor(z / this.size)}`;
    const bucket = this.cells.get(key) ?? [];
    bucket.push({ x, z, radius });
    this.cells.set(key, bucket);
  }
}

function unit(hash: string, start: number): number {
  return Number.parseInt(hash.slice(start, start + 8), 16) / 0x1_0000_0000;
}
function smooth(n: number): number {
  const t = Math.max(0, Math.min(1, n));
  return t * t * (3 - 2 * t);
}
function insideBoundary(
  boundary: readonly { u: number; v: number }[],
  x: number,
  z: number,
): boolean {
  let inside = false;
  for (let i = 0, j = boundary.length - 1; i < boundary.length; j = i++) {
    const a = boundary[i]!,
      b = boundary[j]!;
    if (a.v > z !== b.v > z && x < ((b.u - a.u) * (z - a.v)) / (b.v - a.v) + a.u) inside = !inside;
  }
  return inside;
}
function boundaryDistance(
  boundary: readonly { u: number; v: number }[],
  x: number,
  z: number,
): number {
  let distance = Infinity;
  for (let i = 0; i < boundary.length; i++) {
    const a = boundary[i]!,
      b = boundary[(i + 1) % boundary.length]!;
    const dx = b.u - a.u,
      dz = b.v - a.v;
    const t = Math.max(
      0,
      Math.min(1, ((x - a.u) * dx + (z - a.v) * dz) / Math.max(1e-12, dx * dx + dz * dz)),
    );
    distance = Math.min(distance, Math.hypot(x - a.u - t * dx, z - a.v - t * dz));
  }
  return distance;
}
