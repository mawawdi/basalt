import { contentHash, compareCanonicalStrings, stableJson } from "@basalt/contracts";
import { horizontalMaskSignedDistance } from "@basalt/spatial-core";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join, resolve } from "node:path";
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
  executionStatus: "complete" | "resource_exhausted";
  considered: number;
  placed: number;
  rejectedDensity: number;
  rejectedRegenerationMask: number;
  rejectedSpacing: number;
  rejectedSlope: number;
  rejectedPlacement: number;
  execution: {
    readonly policyId: string;
    readonly origin: string;
    readonly unit: "candidate_evaluations";
    readonly allocated: number | null;
    required: number;
    completed: number;
    exhaustionReason?: string;
  };
}

export interface VegetationExecutionPolicy {
  readonly policyId: string;
  readonly origin: string;
  /** Memory-oriented run size. It changes execution shape, never candidate order or output. */
  readonly candidateBatchSize: number;
  /** Maximum inputs opened by one deterministic external merge pass. */
  readonly mergeFanIn: number;
  /** Operator-owned checkpoint root. Completed logical runs are removed after realization. */
  readonly candidateRunDirectory: string;
  /** Optional operator allocation. Exhaustion yields incomplete evidence rather than invalid intent. */
  readonly maximumCandidateEvaluations?: number;
}

/**
 * Finite adaptive dart throwing with joint species competition, followed by canopy-conditioned
 * layers. Candidates are visited in the same canonical priority/hash order for every execution
 * batch size. Trial density is absolute; resource exhaustion never changes authored intent.
 */
export function distributeVegetation(
  intents: readonly VegetationIntent[],
  context: {
    readonly seed: number;
    readonly initialCanopy: readonly RealizedInstance[];
    readonly executionPolicy: VegetationExecutionPolicy;
    readonly candidateAllowed?: (
      intent: VegetationIntent,
      candidate: VegetationCandidate,
    ) => boolean;
    readonly heightAt: (surfaceId: string, x: number, z: number) => number;
    readonly place: (
      intent: VegetationIntent,
      candidate: VegetationCandidate,
    ) => RealizedInstance | undefined;
  },
): VegetationPlacementSummary[] {
  const executionPolicy = context.executionPolicy;
  if (!executionPolicy.policyId.trim() || !executionPolicy.origin.trim())
    throw new Error("Vegetation execution policy must record its identity and origin");
  const batchSize = executionPolicy.candidateBatchSize;
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0)
    throw new Error("Vegetation candidate batch size must be a positive safe integer");
  const mergeFanIn = executionPolicy.mergeFanIn;
  if (!Number.isSafeInteger(mergeFanIn) || mergeFanIn < 2)
    throw new Error("Vegetation merge fan-in must be a safe integer of at least two");
  if (!executionPolicy.candidateRunDirectory.trim())
    throw new Error("Vegetation candidate run directory must be explicit");
  const maximum = executionPolicy.maximumCandidateEvaluations;
  if (maximum !== undefined && (!Number.isSafeInteger(maximum) || maximum <= 0))
    throw new Error("Vegetation candidate allocation must be a positive safe integer");
  const summaries = new Map<string, VegetationPlacementSummary>();
  const populations: Population[] = [];
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
    if (!Number.isSafeInteger(trials))
      throw new Error(
        `Vegetation candidate count for ${intent.intentId} exceeds the numeric representation limit`,
      );
    totalTrials += trials;
    if (!Number.isSafeInteger(totalTrials))
      throw new Error("Total vegetation candidate count exceeds the numeric representation limit");
    populations.push({ intent, minX, minZ, width, depth, trials });
    summaries.set(intent.intentId, {
      intentId: intent.intentId,
      trials,
      executionStatus: "complete",
      considered: 0,
      placed: 0,
      rejectedDensity: 0,
      rejectedRegenerationMask: 0,
      rejectedSpacing: 0,
      rejectedSlope: 0,
      rejectedPlacement: 0,
      execution: {
        policyId: executionPolicy.policyId,
        origin: executionPolicy.origin,
        unit: "candidate_evaluations",
        allocated: maximum ?? null,
        required: 0,
        completed: 0,
      },
    });
  }
  for (const summary of summaries.values()) summary.execution.required = totalTrials;
  const groups: Population[][] = [];
  for (const layer of ["canopy", "understory", "ground_cover"] as const) {
    const layerPopulations = populations.filter(
      (population) => population.intent.vegetation.layer === layer,
    );
    const priorities = [...new Set(layerPopulations.map(({ intent }) => intent.priority))].sort(
      (left, right) => right - left,
    );
    for (const priority of priorities)
      groups.push(layerPopulations.filter(({ intent }) => intent.priority === priority));
  }
  let remainingAllocation = maximum ?? Number.MAX_SAFE_INTEGER;
  let completedEvaluations = 0;
  const prepared: PreparedCandidateRun[] = [];
  for (const group of groups) {
    const result = prepareCanonicalCandidateRun(
      group,
      context.seed,
      executionPolicy,
      remainingAllocation,
    );
    prepared.push(result);
    remainingAllocation -= result.evaluationsPerformed;
    completedEvaluations += result.completedEvaluations;
    if (!result.complete) {
      const reason =
        `Candidate evaluation allocation exhausted after ${completedEvaluations} of ${totalTrials}; ` +
        `checkpoint ${result.checkpointDirectory} retains resumable work`;
      for (const summary of summaries.values()) {
        summary.executionStatus = "resource_exhausted";
        summary.execution.completed = completedEvaluations;
        summary.execution.exhaustionReason = reason;
      }
      return [...summaries.values()];
    }
  }
  for (const summary of summaries.values()) summary.execution.completed = totalTrials;
  const canopy = [...context.initialCanopy];
  let realized = false;
  try {
    for (const [groupIndex, group] of groups.entries()) {
      const grid = new SpacingGrid(
        Math.max(...group.map(({ intent }) => intent.vegetation.spacingMeters.maximum)),
      );
      forEachCanonicalCandidate(prepared[groupIndex]!, group, ({ intent, candidate }) => {
        const summary = summaries.get(intent.intentId)!;
        if (summary.placed >= intent.targetCount) return;
        const { x, z } = candidate;
        const policy = intent.vegetation;
        if (context.candidateAllowed && !context.candidateAllowed(intent, candidate)) {
          summary.rejectedRegenerationMask++;
          return;
        }
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
        if (unit(candidate.hash, 16) >= density) {
          summary.rejectedDensity++;
          return;
        }
        const radius =
          policy.spacingMeters.minimum +
          (policy.spacingMeters.maximum - policy.spacingMeters.minimum) * (1 - density);
        const scope = `${intent.regionId}/${intent.surfaceId}`;
        if (grid.conflicts(scope, x, z, radius)) {
          summary.rejectedSpacing++;
          return;
        }
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
        ) {
          summary.rejectedSlope++;
          return;
        }
        summary.considered++;
        const instance = context.place(intent, candidate);
        if (!instance) {
          summary.rejectedPlacement++;
          return;
        }
        summary.placed++;
        grid.add(scope, x, z, radius);
        if (intent.vegetation.layer === "canopy") canopy.push(instance);
      });
    }
    realized = true;
  } finally {
    if (realized)
      for (const run of prepared) rmSync(run.checkpointDirectory, { recursive: true, force: true });
  }
  return [...summaries.values()];
}

interface Population {
  readonly intent: VegetationIntent;
  readonly minX: number;
  readonly minZ: number;
  readonly width: number;
  readonly depth: number;
  readonly trials: number;
}

interface CandidateEntry {
  readonly intent: VegetationIntent;
  readonly candidate: VegetationCandidate;
}

interface CandidateCheckpoint {
  readonly signature: string;
  readonly totalEvaluations: number;
  completedEvaluations: number;
  runCount: number;
  complete: boolean;
}

interface PreparedCandidateRun {
  readonly checkpointDirectory: string;
  readonly candidatePath: string;
  readonly completedEvaluations: number;
  readonly evaluationsPerformed: number;
  readonly complete: boolean;
}

/**
 * Candidate generation is checkpointed by logical input. The execution allocation controls how
 * much work one invocation performs; it cannot change the canonical candidate stream.
 */
function prepareCanonicalCandidateRun(
  populations: readonly Population[],
  seed: number,
  executionPolicy: VegetationExecutionPolicy,
  evaluationAllocation: number,
): PreparedCandidateRun {
  const signature = contentHash(
    stableJson({
      seed,
      populations: populations.map((population) => ({
        intent: population.intent,
        minX: population.minX,
        minZ: population.minZ,
        width: population.width,
        depth: population.depth,
        trials: population.trials,
      })),
    }),
  );
  const scratchRoot = resolve(executionPolicy.candidateRunDirectory);
  const checkpointDirectory = join(scratchRoot, signature);
  const manifestPath = join(checkpointDirectory, "manifest.json");
  const candidatePath = join(checkpointDirectory, "candidates.bin");
  mkdirSync(checkpointDirectory, { recursive: true });
  const totalEvaluations = populations.reduce((total, population) => total + population.trials, 0);
  let checkpoint: CandidateCheckpoint;
  if (existsSync(manifestPath)) {
    checkpoint = parseCandidateCheckpoint(readFileSync(manifestPath, "utf8"), signature);
    if (checkpoint.totalEvaluations !== totalEvaluations)
      throw new Error(`Vegetation checkpoint ${signature} has inconsistent trial evidence`);
    if (
      !checkpoint.complete &&
      checkpoint.completedEvaluations === checkpoint.totalEvaluations &&
      existsSync(candidatePath)
    ) {
      checkpoint.complete = true;
      writeCandidateCheckpoint(manifestPath, checkpoint);
    }
    if (checkpoint.complete && !existsSync(candidatePath)) {
      rmSync(checkpointDirectory, { recursive: true, force: true });
      return prepareCanonicalCandidateRun(populations, seed, executionPolicy, evaluationAllocation);
    }
  } else {
    checkpoint = {
      signature,
      totalEvaluations,
      completedEvaluations: 0,
      runCount: 0,
      complete: false,
    };
    writeCandidateCheckpoint(manifestPath, checkpoint);
  }
  if (checkpoint.complete)
    return {
      checkpointDirectory,
      candidatePath,
      completedEvaluations: checkpoint.completedEvaluations,
      evaluationsPerformed: 0,
      complete: true,
    };
  const evaluationsPerformed = Math.min(
    Math.max(0, evaluationAllocation),
    checkpoint.totalEvaluations - checkpoint.completedEvaluations,
  );
  let remaining = evaluationsPerformed;
  let skipped = checkpoint.completedEvaluations;
  let pending: CandidateRecord[] = [];
  const flush = () => {
    if (pending.length === 0) return;
    pending.sort((left, right) => compareCandidateRecords(left, right, populations));
    const path = candidateRunPath(checkpointDirectory, checkpoint.runCount++);
    writeCandidateRun(path, pending);
    pending = [];
  };
  for (const [populationIndex, population] of populations.entries()) {
    if (remaining === 0) break;
    if (skipped >= population.trials) {
      skipped -= population.trials;
      continue;
    }
    const firstTrial = skipped;
    skipped = 0;
    const lastTrial = Math.min(population.trials, firstTrial + remaining);
    for (let index = firstTrial; index < lastTrial; index++) {
      const hash = contentHash(`${seed}:${population.intent.intentId}:${index}`);
      const x = population.minX + unit(hash, 0) * population.width;
      const z = population.minZ + unit(hash, 8) * population.depth;
      if (insideBoundary(population.intent.boundary, x, z)) pending.push({ hash, populationIndex });
      if (pending.length === executionPolicy.candidateBatchSize) flush();
    }
    remaining -= lastTrial - firstTrial;
  }
  flush();
  checkpoint.completedEvaluations += evaluationsPerformed;
  if (checkpoint.completedEvaluations === checkpoint.totalEvaluations) {
    finalizeCandidateCheckpoint(checkpointDirectory, checkpoint, populations, executionPolicy);
    checkpoint.complete = true;
  }
  writeCandidateCheckpoint(manifestPath, checkpoint);
  return {
    checkpointDirectory,
    candidatePath,
    completedEvaluations: checkpoint.completedEvaluations,
    evaluationsPerformed,
    complete: checkpoint.complete,
  };
}

function forEachCanonicalCandidate(
  prepared: PreparedCandidateRun,
  populations: readonly Population[],
  visit: (entry: CandidateEntry) => void,
): void {
  if (!prepared.complete) throw new Error("Cannot realize an incomplete vegetation candidate run");
  const reader = new CandidateRunReader(prepared.candidatePath);
  try {
    for (let record = reader.next(); record; record = reader.next()) {
      const population = populations[record.populationIndex];
      if (!population) throw new Error("Vegetation candidate references an unknown population");
      const x = population.minX + unit(record.hash, 0) * population.width;
      const z = population.minZ + unit(record.hash, 8) * population.depth;
      visit({ intent: population.intent, candidate: { x, z, hash: record.hash } });
    }
  } finally {
    reader.close();
  }
}

function candidateRunPath(directory: string, index: number): string {
  return join(directory, `run-${String(index).padStart(12, "0")}.bin`);
}

function parseCandidateCheckpoint(raw: string, signature: string): CandidateCheckpoint {
  const value = JSON.parse(raw) as Partial<CandidateCheckpoint>;
  if (
    value.signature !== signature ||
    !Number.isSafeInteger(value.totalEvaluations) ||
    value.totalEvaluations! < 0 ||
    !Number.isSafeInteger(value.completedEvaluations) ||
    value.completedEvaluations! < 0 ||
    value.completedEvaluations! > value.totalEvaluations! ||
    !Number.isSafeInteger(value.runCount) ||
    value.runCount! < 0 ||
    typeof value.complete !== "boolean"
  )
    throw new Error(`Vegetation checkpoint ${signature} is malformed`);
  return value as CandidateCheckpoint;
}

function writeCandidateCheckpoint(path: string, checkpoint: CandidateCheckpoint): void {
  const temporary = `${path}.tmp`;
  rmSync(temporary, { force: true });
  writeFileSync(temporary, `${stableJson(checkpoint)}\n`, { flag: "wx" });
  renameSync(temporary, path);
}

function finalizeCandidateCheckpoint(
  checkpointDirectory: string,
  checkpoint: CandidateCheckpoint,
  populations: readonly Population[],
  executionPolicy: VegetationExecutionPolicy,
): void {
  const candidatePath = join(checkpointDirectory, "candidates.bin");
  const temporaryCandidatePath = `${candidatePath}.tmp`;
  rmSync(temporaryCandidatePath, { force: true });
  const inputRuns = Array.from({ length: checkpoint.runCount }, (_, index) =>
    candidateRunPath(checkpointDirectory, index),
  );
  if (inputRuns.some((path) => !existsSync(path)))
    throw new Error(`Vegetation checkpoint ${checkpoint.signature} is missing a candidate run`);
  if (inputRuns.length === 0) {
    writeFileSync(temporaryCandidatePath, Buffer.alloc(0), { flag: "wx" });
  } else if (inputRuns.length === 1) {
    renameSync(inputRuns[0]!, temporaryCandidatePath);
  } else {
    const mergeDirectory = mkdtempSync(join(checkpointDirectory, "merge-"));
    try {
      let current = inputRuns;
      let pass = 0;
      while (current.length > 1) {
        const next: string[] = [];
        for (let first = 0; first < current.length; first += executionPolicy.mergeFanIn) {
          const group = current.slice(first, first + executionPolicy.mergeFanIn);
          if (group.length === 1) {
            next.push(group[0]!);
            continue;
          }
          const output = join(
            mergeDirectory,
            `pass-${String(pass).padStart(4, "0")}-${String(next.length).padStart(12, "0")}.bin`,
          );
          mergeCandidateRuns(group, output, populations, executionPolicy.candidateBatchSize);
          next.push(output);
        }
        current = next;
        pass++;
      }
      renameSync(current[0]!, temporaryCandidatePath);
    } finally {
      rmSync(mergeDirectory, { recursive: true, force: true });
    }
  }
  renameSync(temporaryCandidatePath, candidatePath);
  for (const path of inputRuns) rmSync(path, { force: true });
}

interface CandidateRecord {
  readonly hash: string;
  readonly populationIndex: number;
}

const CANDIDATE_RECORD_BYTES = 40;

function compareCandidateRecords(
  left: CandidateRecord,
  right: CandidateRecord,
  populations: readonly Population[],
): number {
  return (
    compareCanonicalStrings(left.hash, right.hash) ||
    compareCanonicalStrings(
      populations[left.populationIndex]!.intent.intentId,
      populations[right.populationIndex]!.intent.intentId,
    )
  );
}

function encodeCandidateRecords(records: readonly CandidateRecord[]): Buffer {
  const bytes = Buffer.allocUnsafe(records.length * CANDIDATE_RECORD_BYTES);
  for (const [index, record] of records.entries()) {
    const offset = index * CANDIDATE_RECORD_BYTES;
    Buffer.from(record.hash, "hex").copy(bytes, offset);
    bytes.writeBigUInt64BE(BigInt(record.populationIndex), offset + 32);
  }
  return bytes;
}

function writeAll(fileDescriptor: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(fileDescriptor, bytes, offset);
}

function writeCandidateRun(path: string, records: readonly CandidateRecord[]): void {
  const fileDescriptor = openSync(path, "wx");
  try {
    writeAll(fileDescriptor, encodeCandidateRecords(records));
  } finally {
    closeSync(fileDescriptor);
  }
}

class CandidateRunReader {
  readonly #fileDescriptor: number;
  readonly #bytes = Buffer.allocUnsafe(CANDIDATE_RECORD_BYTES);
  #closed = false;
  constructor(path: string) {
    this.#fileDescriptor = openSync(path, "r");
  }
  next(): CandidateRecord | undefined {
    let offset = 0;
    while (offset < CANDIDATE_RECORD_BYTES) {
      const read = readSync(
        this.#fileDescriptor,
        this.#bytes,
        offset,
        CANDIDATE_RECORD_BYTES - offset,
        null,
      );
      if (read === 0) {
        if (offset !== 0) throw new Error("Vegetation candidate run ended inside a record");
        return undefined;
      }
      offset += read;
    }
    const populationIndex = Number(this.#bytes.readBigUInt64BE(32));
    if (!Number.isSafeInteger(populationIndex))
      throw new Error("Vegetation candidate run population index exceeds numeric representation");
    return { hash: this.#bytes.subarray(0, 32).toString("hex"), populationIndex };
  }
  close(): void {
    if (this.#closed) return;
    closeSync(this.#fileDescriptor);
    this.#closed = true;
  }
}

interface MergeHead {
  readonly record: CandidateRecord;
  readonly readerIndex: number;
}

function mergeCandidateRuns(
  inputs: readonly string[],
  output: string,
  populations: readonly Population[],
  outputBatchSize: number,
): void {
  const readers = inputs.map((path) => new CandidateRunReader(path));
  const outputDescriptor = openSync(output, "wx");
  const heap: MergeHead[] = [];
  const before = (left: MergeHead, right: MergeHead) =>
    compareCandidateRecords(left.record, right.record, populations) < 0;
  const push = (value: MergeHead) => {
    heap.push(value);
    for (let index = heap.length - 1; index > 0;) {
      const parent = Math.floor((index - 1) / 2);
      if (!before(heap[index]!, heap[parent]!)) break;
      [heap[index], heap[parent]] = [heap[parent]!, heap[index]!];
      index = parent;
    }
  };
  const pop = (): MergeHead => {
    const first = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let index = 0; ;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < heap.length && before(heap[left]!, heap[smallest]!)) smallest = left;
        if (right < heap.length && before(heap[right]!, heap[smallest]!)) smallest = right;
        if (smallest === index) break;
        [heap[index], heap[smallest]] = [heap[smallest]!, heap[index]!];
        index = smallest;
      }
    }
    return first;
  };
  try {
    readers.forEach((reader, readerIndex) => {
      const record = reader.next();
      if (record) push({ record, readerIndex });
    });
    let outputRecords: CandidateRecord[] = [];
    const flush = () => {
      if (outputRecords.length === 0) return;
      writeAll(outputDescriptor, encodeCandidateRecords(outputRecords));
      outputRecords = [];
    };
    while (heap.length > 0) {
      const head = pop();
      outputRecords.push(head.record);
      if (outputRecords.length === outputBatchSize) flush();
      const replacement = readers[head.readerIndex]!.next();
      if (replacement) push({ record: replacement, readerIndex: head.readerIndex });
    }
    flush();
  } finally {
    closeSync(outputDescriptor);
    for (const reader of readers) reader.close();
  }
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
    if (y < clearing.verticalRangeMeters.minimum || y > clearing.verticalRangeMeters.maximum)
      continue;
    const distance = horizontalMaskSignedDistance(clearing.mask, { x, z });
    if (distance <= 0) return 0;
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
