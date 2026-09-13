import { z } from "zod";
import {
  COMPILATION_STATUS_SCHEMA,
  contentAddressedEntityId,
  contentHash,
  deepFreezeJson,
  stableJson,
  type CompilationStatus,
} from "@basalt/contracts";
import { createMurmurHash3Random, entityId, hashSchema } from "./primitives.js";

const candidateId = z.string().min(1).max(128);
const relationId = z.string().min(1).max(128);
const weightedCandidate = z
  .object({ candidateId, weight: z.number().int().positive().max(0x7fff_ffff) })
  .strict();

export const CONSTRAINT_MODEL_SCHEMA = z
  .object({
    kind: z.literal("ConstraintModel"),
    seed: z.number().int().min(0).max(0xffff_ffff),
    cells: z
      .array(
        z
          .object({ cellId: entityId, candidates: z.array(weightedCandidate).min(1).max(4096) })
          .strict(),
      )
      .min(1)
      .max(65_536),
    edges: z
      .array(
        z
          .object({
            edgeId: entityId,
            fromCellId: entityId,
            toCellId: entityId,
            relationId,
            policy: z.literal("directed"),
          })
          .strict(),
      )
      .max(262_144),
    relations: z
      .array(
        z
          .object({
            relationId,
            allowed: z
              .array(z.tuple([candidateId, candidateId]))
              .min(1)
              .max(1_000_000),
          })
          .strict(),
      )
      .max(65_536),
    policy: z
      .object({
        maximumDecisions: z.number().int().positive().max(10_000_000),
        maximumBacktracks: z.number().int().nonnegative().max(10_000_000),
      })
      .strict(),
    hash: hashSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const problem = constraintModelProblem(value);
    if (problem) context.addIssue({ code: "custom", message: problem });
    const { hash: _hash, ...material } = value;
    if (contentHash(stableJson(material)) !== value.hash)
      context.addIssue({
        code: "custom",
        path: ["hash"],
        message: "Constraint model hash mismatch",
      });
  });
export type ConstraintModel = z.output<typeof CONSTRAINT_MODEL_SCHEMA>;

export interface ConstraintEdgeDeclaration {
  readonly edgeId: string;
  readonly fromCellId: string;
  readonly toCellId: string;
  readonly relationId: string;
  readonly policy: "directed" | "symmetric";
}

export interface ConstraintModelDeclaration {
  readonly seed: number;
  readonly cells: ConstraintModel["cells"];
  readonly edges: readonly ConstraintEdgeDeclaration[];
  readonly relations: ConstraintModel["relations"];
  readonly policy: ConstraintModel["policy"];
}

const contradictionSchema = z
  .object({
    cellId: entityId,
    edgeId: entityId.optional(),
    relationId: relationId.optional(),
    eliminatedCandidateIds: z.array(candidateId).max(4096),
    depth: z.number().int().nonnegative(),
  })
  .strict();

export const CONSTRAINT_SOLUTION_SCHEMA = z
  .object({
    kind: z.literal("ConstraintSolution"),
    id: entityId,
    modelHash: hashSchema,
    status: COMPILATION_STATUS_SCHEMA,
    assignments: z.array(z.object({ cellId: entityId, candidateId }).strict()).max(65_536),
    decisions: z.number().int().nonnegative(),
    propagations: z.number().int().nonnegative(),
    backtracks: z.number().int().nonnegative(),
    contradictions: z.array(contradictionSchema).max(65_536),
    diagnostics: z.array(z.string().min(1).max(1024)).max(1024),
    hash: hashSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const { id: _id, hash: _hash, ...material } = value;
    if (contentHash(stableJson(material)) !== value.hash)
      context.addIssue({
        code: "custom",
        path: ["hash"],
        message: "Constraint solution hash mismatch",
      });
    if (contentAddressedEntityId("constraint_solution", material) !== value.id)
      context.addIssue({
        code: "custom",
        path: ["id"],
        message: "Constraint solution ID mismatch",
      });
  });
export type ConstraintSolution = z.output<typeof CONSTRAINT_SOLUTION_SCHEMA>;

export function sealConstraintModel(input: ConstraintModelDeclaration): ConstraintModel {
  const cells = input.cells
    .map((cell) => ({
      cellId: cell.cellId,
      candidates: [...cell.candidates].sort((left, right) =>
        compare(left.candidateId, right.candidateId),
      ),
    }))
    .sort((left, right) => compare(left.cellId, right.cellId));
  const edges = input.edges
    .flatMap((edge) => {
      const forward = { ...edge, policy: "directed" as const };
      if (edge.policy === "directed") return [forward];
      return [
        forward,
        {
          edgeId: contentAddressedEntityId("edge", {
            sourceEdgeId: edge.edgeId,
            direction: "reverse",
          }),
          fromCellId: edge.toCellId,
          toCellId: edge.fromCellId,
          relationId: edge.relationId,
          policy: "directed" as const,
        },
      ];
    })
    .sort((left, right) => compare(left.edgeId, right.edgeId));
  const relations = input.relations
    .map((relation) => ({
      relationId: relation.relationId,
      allowed: [...relation.allowed].sort(comparePair),
    }))
    .sort((left, right) => compare(left.relationId, right.relationId));
  const material = {
    kind: "ConstraintModel" as const,
    seed: input.seed,
    cells,
    edges,
    relations,
    policy: input.policy,
  };
  const problem = constraintModelProblem({ ...material, hash: "0".repeat(64) });
  if (problem) throw new Error(problem);
  return deepFreezeJson(
    CONSTRAINT_MODEL_SCHEMA.parse({ ...material, hash: contentHash(stableJson(material)) }),
  ) as ConstraintModel;
}

interface Arc {
  readonly edgeId: string;
  readonly from: string;
  readonly to: string;
  readonly relationId: string;
  readonly allowed: ReadonlySet<string>;
}

interface PreparedConstraintModel {
  readonly model: ConstraintModel;
  readonly weights: ReadonlyMap<string, ReadonlyMap<string, number>>;
  readonly arcs: readonly Arc[];
  readonly incoming: ReadonlyMap<string, readonly Arc[]>;
}

interface SearchState {
  domains: Map<string, Set<string>>;
  decisions: number;
  propagations: number;
  backtracks: number;
  contradictions: z.output<typeof contradictionSchema>[];
  limitReached?: "decision" | "backtrack";
}

export function solveConstraintModel(modelInput: unknown): ConstraintSolution {
  const model = CONSTRAINT_MODEL_SCHEMA.parse(modelInput);
  const prepared = prepare(model);
  const state: SearchState = {
    domains: new Map(
      model.cells.map((cell) => [
        cell.cellId,
        new Set(cell.candidates.map((candidate) => candidate.candidateId)),
      ]),
    ),
    decisions: 0,
    propagations: 0,
    backtracks: 0,
    contradictions: [],
  };
  const seedFromHash = Number.parseInt(model.hash.slice(0, 8), 16) ^ model.seed;
  const rng = createMurmurHash3Random(seedFromHash >>> 0);
  const complete = propagate(prepared, state, prepared.arcs, 0) && search(prepared, state, rng, 0);
  const assignments = complete
    ? model.cells.map((cell) => ({
        cellId: cell.cellId,
        candidateId: [...state.domains.get(cell.cellId)!][0]!,
      }))
    : [];
  const status: CompilationStatus = complete ? "eligible" : "incomplete";
  const diagnostics = complete
    ? []
    : [
        state.limitReached === "decision"
          ? "Constraint decision budget exhausted"
          : state.limitReached === "backtrack"
            ? "Constraint backtrack budget exhausted"
            : "Constraint model is unsatisfiable",
      ];
  const material = {
    kind: "ConstraintSolution" as const,
    modelHash: model.hash,
    status,
    assignments,
    decisions: state.decisions,
    propagations: state.propagations,
    backtracks: state.backtracks,
    contradictions: state.contradictions,
    diagnostics,
  };
  return deepFreezeJson(
    CONSTRAINT_SOLUTION_SCHEMA.parse({
      ...material,
      id: contentAddressedEntityId("constraint_solution", material),
      hash: contentHash(stableJson(material)),
    }),
  ) as ConstraintSolution;
}

function search(
  prepared: PreparedConstraintModel,
  state: SearchState,
  rng: () => number,
  depth: number,
): boolean {
  const target = chooseCell(prepared, state, rng);
  if (!target) return [...state.domains.values()].every((domain) => domain.size === 1);
  if (state.decisions >= prepared.model.policy.maximumDecisions) {
    state.limitReached = "decision";
    return false;
  }
  state.decisions += 1;
  const candidates = weightedCandidateOrder(
    state.domains.get(target.cellId)!,
    prepared.weights.get(target.cellId)!,
    rng,
  );
  const snapshot = cloneDomains(state.domains);
  for (const candidateId of candidates) {
    state.domains = cloneDomains(snapshot);
    state.domains.set(target.cellId, new Set([candidateId]));
    const arcs = prepared.incoming.get(target.cellId) ?? [];
    if (propagate(prepared, state, arcs, depth) && search(prepared, state, rng, depth + 1))
      return true;
    if (state.backtracks >= prepared.model.policy.maximumBacktracks) {
      state.limitReached = "backtrack";
      state.domains = snapshot;
      return false;
    }
    state.backtracks += 1;
  }
  state.domains = snapshot;
  return false;
}

function chooseCell(
  prepared: PreparedConstraintModel,
  state: SearchState,
  rng: () => number,
): { cellId: string; entropy: number } | undefined {
  let minimum = Number.POSITIVE_INFINITY;
  let candidates: Array<{ cellId: string; entropy: number }> = [];
  for (const cell of prepared.model.cells) {
    const domain = state.domains.get(cell.cellId)!;
    if (domain.size <= 1) continue;
    const weights = prepared.weights.get(cell.cellId)!;
    let sum = 0;
    let weightedLogs = 0;
    for (const candidate of domain) {
      const weight = weights.get(candidate)!;
      sum += weight;
      weightedLogs += weight * Math.log(weight);
    }
    const entropy = Math.log(sum) - weightedLogs / sum;
    if (entropy < minimum - 1e-12) {
      minimum = entropy;
      candidates = [{ cellId: cell.cellId, entropy }];
    } else if (Math.abs(entropy - minimum) <= 1e-12)
      candidates.push({ cellId: cell.cellId, entropy });
  }
  if (candidates.length === 0) return undefined;
  candidates.sort((left, right) => compare(left.cellId, right.cellId));
  return candidates[Math.min(candidates.length - 1, Math.floor(rng() * candidates.length))];
}

function weightedCandidateOrder(
  domain: ReadonlySet<string>,
  weights: ReadonlyMap<string, number>,
  rng: () => number,
): string[] {
  return [...domain]
    .map((candidateId) => ({
      candidateId,
      weight: weights.get(candidateId)!,
      // Exponential race gives a weighted permutation without replacement.
      score: -Math.log(Math.max(Number.MIN_VALUE, rng())) / weights.get(candidateId)!,
    }))
    .sort((left, right) => left.score - right.score || compare(left.candidateId, right.candidateId))
    .map((entry) => entry.candidateId);
}

function propagate(
  prepared: PreparedConstraintModel,
  state: SearchState,
  seedArcs: readonly Arc[],
  depth: number,
): boolean {
  const queue = [...seedArcs];
  const queued = new Set(queue.map((arc) => arcKey(arc)));
  while (queue.length > 0) {
    const arc = queue.shift()!;
    queued.delete(arcKey(arc));
    state.propagations += 1;
    const fromDomain = state.domains.get(arc.from)!;
    const toDomain = state.domains.get(arc.to)!;
    const removed: string[] = [];
    for (const fromCandidate of fromDomain) {
      const supported = [...toDomain].some((toCandidate) =>
        arc.allowed.has(pairKey(fromCandidate, toCandidate)),
      );
      if (!supported) removed.push(fromCandidate);
    }
    if (removed.length === 0) continue;
    for (const candidate of removed) fromDomain.delete(candidate);
    if (fromDomain.size === 0) {
      state.contradictions.push({
        cellId: arc.from,
        edgeId: arc.edgeId,
        relationId: arc.relationId,
        eliminatedCandidateIds: removed.sort(compare),
        depth,
      });
      return false;
    }
    for (const incoming of prepared.incoming.get(arc.from) ?? []) {
      if (incoming.from === arc.to) continue;
      const key = arcKey(incoming);
      if (!queued.has(key)) {
        queue.push(incoming);
        queued.add(key);
      }
    }
  }
  return true;
}

function prepare(model: ConstraintModel): PreparedConstraintModel {
  const relations = new Map(
    model.relations.map(
      (relation) =>
        [
          relation.relationId,
          new Set(relation.allowed.map(([from, to]) => pairKey(from, to))),
        ] as const,
    ),
  );
  const weights = new Map(
    model.cells.map(
      (cell) =>
        [
          cell.cellId,
          new Map(
            cell.candidates.map((candidate) => [candidate.candidateId, candidate.weight] as const),
          ),
        ] as const,
    ),
  );
  const arcs: Arc[] = [];
  for (const edge of model.edges) {
    const allowed = relations.get(edge.relationId)!;
    arcs.push({
      edgeId: edge.edgeId,
      from: edge.fromCellId,
      to: edge.toCellId,
      relationId: edge.relationId,
      allowed,
    });
    const inverse = new Set(
      [...allowed].map((key) => {
        const separator = key.indexOf("\u0000");
        return pairKey(key.slice(separator + 1), key.slice(0, separator));
      }),
    );
    arcs.push({
      edgeId: edge.edgeId,
      from: edge.toCellId,
      to: edge.fromCellId,
      relationId: edge.relationId,
      allowed: inverse,
    });
  }
  arcs.sort((left, right) => compare(arcKey(left), arcKey(right)));
  const incoming = new Map<string, Arc[]>();
  for (const cell of model.cells) incoming.set(cell.cellId, []);
  for (const arc of arcs) incoming.get(arc.to)!.push(arc);
  return { model, weights, arcs, incoming };
}

function constraintModelProblem(
  value: z.output<typeof CONSTRAINT_MODEL_SCHEMA> | Record<string, unknown>,
): string | undefined {
  const model = value as z.output<typeof CONSTRAINT_MODEL_SCHEMA>;
  const cells = new Map<string, Set<string>>();
  for (const cell of model.cells) {
    if (cells.has(cell.cellId)) return `Constraint cell IDs must be unique: ${cell.cellId}`;
    const candidates = new Set(cell.candidates.map((candidate) => candidate.candidateId));
    if (candidates.size !== cell.candidates.length)
      return `Constraint cell candidates must be unique: ${cell.cellId}`;
    cells.set(cell.cellId, candidates);
  }
  const relations = new Map<string, readonly (readonly [string, string])[]>();
  for (const relation of model.relations) {
    if (relations.has(relation.relationId))
      return `Constraint relation IDs must be unique: ${relation.relationId}`;
    if (
      new Set(relation.allowed.map(([from, to]) => pairKey(from, to))).size !==
      relation.allowed.length
    )
      return `Constraint relation pairs must be unique: ${relation.relationId}`;
    relations.set(relation.relationId, relation.allowed);
  }
  const edgeIds = new Set<string>();
  for (const edge of model.edges) {
    if (edgeIds.has(edge.edgeId)) return `Constraint edge IDs must be unique: ${edge.edgeId}`;
    edgeIds.add(edge.edgeId);
    const from = cells.get(edge.fromCellId);
    const to = cells.get(edge.toCellId);
    if (!from || !to) return `Constraint edge references an unknown cell: ${edge.edgeId}`;
    const allowed = relations.get(edge.relationId);
    if (!allowed)
      return `Constraint edge references an unknown relation: ${edge.edgeId}/${edge.relationId}`;
    for (const [fromCandidate, toCandidate] of allowed)
      if (!from.has(fromCandidate) || !to.has(toCandidate))
        return `Constraint relation references a candidate outside edge domains: ${edge.edgeId}/${fromCandidate}/${toCandidate}`;
  }
  return undefined;
}

function cloneDomains(domains: ReadonlyMap<string, ReadonlySet<string>>): Map<string, Set<string>> {
  return new Map([...domains].map(([cellId, domain]) => [cellId, new Set(domain)]));
}

function pairKey(from: string, to: string): string {
  return `${from}\u0000${to}`;
}

function arcKey(arc: Arc): string {
  return `${arc.edgeId}\u0000${arc.from}\u0000${arc.to}`;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function comparePair(left: readonly [string, string], right: readonly [string, string]): number {
  return compare(left[0], right[0]) || compare(left[1], right[1]);
}
