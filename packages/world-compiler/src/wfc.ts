import { createMurmurHash3Random } from "../../spatial-core/src/primitives.js";
import { compareWorldStrings } from "./primitives.js";

/**
 * Seeded simple-tiled wave-function collapse over an explicit cell graph.
 * The solver is dimensionality-agnostic: callers define cells, directed
 * edges with opaque direction labels, and per-direction tile-pair adjacency.
 * It decides nothing geometric — rings, facades, and volumes all map onto
 * cells plus directed adjacency, and a later assembly layer owns the
 * kit-to-cells mapping. Deterministic per seed: canonical ordering absorbs
 * declaration order, and every random choice draws from a seeded stream.
 */

export interface WfcTile {
  readonly id: string;
  readonly weight: number;
}

export interface WfcEdge {
  readonly from: string;
  readonly to: string;
  readonly direction: string;
}

/**
 * Callers supply both directed edges of every adjacency: propagation
 * follows edge direction, and direction labels are opaque to the solver,
 * so a missing reverse edge silently drops half the constraints.
 */

export interface WfcGraph {
  readonly cells: ReadonlyArray<string>;
  readonly edges: ReadonlyArray<WfcEdge>;
}

export interface WfcAdjacency {
  readonly direction: string;
  /** Allowed [fromTile, toTile] pairs along this direction. */
  readonly allowed: ReadonlyArray<readonly [string, string]>;
}

export interface WfcSolution {
  readonly assignments: ReadonlyMap<string, string>;
  readonly restarts: number;
}

export interface WfcInput {
  readonly graph: WfcGraph;
  readonly tiles: ReadonlyArray<WfcTile>;
  readonly adjacency: ReadonlyArray<WfcAdjacency>;
  readonly seed: number;
  readonly maxRestarts?: number;
  /** Per-cell candidate restriction; unrestricted cells start with all tiles. */
  readonly initialDomains?: ReadonlyArray<{
    readonly cell: string;
    readonly tiles: ReadonlyArray<string>;
  }>;
}

export const DEFAULT_WFC_MAX_RESTARTS = 8;

interface WfcContradiction {
  readonly cell: string;
  readonly neighbor: string;
  readonly direction: string;
  readonly neighborTiles: ReadonlyArray<string>;
  readonly eliminated: number;
  readonly lastTile: string;
}

export class WfcContradictionError extends Error {
  constructor(detail: WfcContradiction) {
    super(
      `WFC contradiction at cell "${detail.cell}": no tile satisfies ${detail.direction} adjacency ` +
        `from "${detail.neighbor}" (${detail.neighborTiles.join(", ") || "collapsed"}); ` +
        `${detail.eliminated} candidates eliminated, last tile "${detail.lastTile}" blocked`,
    );
    this.name = "WfcContradictionError";
  }
}

interface PreparedModel {
  readonly cells: ReadonlyArray<string>;
  readonly weights: ReadonlyMap<string, number>;
  readonly outgoing: ReadonlyMap<string, ReadonlyArray<{ to: string; direction: string }>>;
  readonly allowed: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<string>>>;
  readonly initialDomains: ReadonlyMap<string, ReadonlySet<string>>;
}

function prepareModel(input: WfcInput): PreparedModel {
  if (!Number.isInteger(input.seed)) throw new Error("WFC seed must be an integer");
  const maxRestarts = input.maxRestarts ?? DEFAULT_WFC_MAX_RESTARTS;
  if (!Number.isInteger(maxRestarts) || maxRestarts < 0)
    throw new Error("WFC restart budget must be a nonnegative integer");
  if (input.graph.cells.length === 0) throw new Error("WFC requires at least one cell");
  if (input.tiles.length === 0) throw new Error("WFC requires at least one tile");
  const cells = [...new Set(input.graph.cells)].sort(compareWorldStrings);
  if (cells.length !== input.graph.cells.length) throw new Error("WFC cell IDs must be unique");
  const cellSet = new Set(cells);
  const weights = new Map<string, number>();
  for (const tile of [...input.tiles].sort((left, right) =>
    compareWorldStrings(left.id, right.id),
  )) {
    if (weights.has(tile.id)) throw new Error(`Duplicate WFC tile: ${tile.id}`);
    if (!Number.isFinite(tile.weight) || tile.weight <= 0)
      throw new Error(`WFC tile weight must be a positive finite number: ${tile.id}`);
    weights.set(tile.id, tile.weight);
  }
  const outgoing = new Map<string, Array<{ to: string; direction: string }>>();
  for (const cell of cells) outgoing.set(cell, []);
  for (const edge of input.graph.edges) {
    if (!cellSet.has(edge.from)) throw new Error(`WFC edge references unknown cell: ${edge.from}`);
    if (!cellSet.has(edge.to)) throw new Error(`WFC edge references unknown cell: ${edge.to}`);
    outgoing.get(edge.from)!.push({ to: edge.to, direction: edge.direction });
  }
  for (const list of outgoing.values())
    list.sort(
      (left, right) =>
        compareWorldStrings(left.to, right.to) ||
        compareWorldStrings(left.direction, right.direction),
    );
  const allowed = new Map<string, Map<string, Set<string>>>();
  for (const entry of input.adjacency) {
    if (allowed.has(entry.direction))
      throw new Error(`Duplicate WFC adjacency: ${entry.direction}`);
    const pairs = new Map<string, Set<string>>();
    for (const [from, to] of entry.allowed) {
      if (!weights.has(from)) throw new Error(`WFC adjacency references unknown tile: ${from}`);
      if (!weights.has(to)) throw new Error(`WFC adjacency references unknown tile: ${to}`);
      const targets = pairs.get(from) ?? new Set<string>();
      targets.add(to);
      pairs.set(from, targets);
    }
    allowed.set(entry.direction, pairs);
  }
  const initialDomains = new Map<string, Set<string>>();
  for (const restriction of input.initialDomains ?? []) {
    if (!cellSet.has(restriction.cell))
      throw new Error(`WFC domain restriction references unknown cell: ${restriction.cell}`);
    if (initialDomains.has(restriction.cell))
      throw new Error(`Duplicate WFC domain restriction: ${restriction.cell}`);
    if (restriction.tiles.length === 0)
      throw new Error(`WFC cell "${restriction.cell}" has no candidate tiles`);
    const domain = new Set<string>();
    for (const tile of restriction.tiles) {
      if (!weights.has(tile))
        throw new Error(`WFC domain restriction references unknown tile: ${tile}`);
      domain.add(tile);
    }
    initialDomains.set(restriction.cell, domain);
  }
  return { cells, weights, outgoing, allowed, initialDomains };
}

interface WfcAttempt {
  readonly domains: Map<string, Set<string>>;
  readonly eliminations: Map<string, Array<{ tile: string; neighbor: string; direction: string }>>;
}

function attemptSolve(model: PreparedModel, seed: number): ReadonlyMap<string, string> {
  const rng = createMurmurHash3Random(seed >>> 0);
  const attempt: WfcAttempt = {
    domains: new Map(
      model.cells.map((cell) => [
        cell,
        new Set(model.initialDomains.get(cell) ?? model.weights.keys()),
      ]),
    ),
    eliminations: new Map(model.cells.map((cell) => [cell, []])),
  };
  // Pre-collapsed cells constrain their neighbors before observation.
  propagate(
    model,
    attempt,
    model.cells.filter((cell) => attempt.domains.get(cell)!.size === 1),
  );
  for (;;) {
    let target: string | null = null;
    let entropy = Number.POSITIVE_INFINITY;
    for (const cell of model.cells) {
      const size = attempt.domains.get(cell)!.size;
      if (size > 1 && size < entropy) {
        entropy = size;
        target = cell;
      }
    }
    if (target === null) {
      for (const cell of model.cells) {
        if (attempt.domains.get(cell)!.size === 0) throwContradiction(attempt, cell);
      }
      return new Map(model.cells.map((cell) => [cell, [...attempt.domains.get(cell)!][0]!]));
    }
    const tied = model.cells.filter((cell) => attempt.domains.get(cell)!.size === entropy);
    const chosen = tied[Math.min(tied.length - 1, Math.floor(rng() * tied.length))]!;
    observe(model, attempt, chosen, rng);
    propagate(model, attempt, [chosen]);
  }
}

function observe(model: PreparedModel, attempt: WfcAttempt, cell: string, rng: () => number): void {
  const domain = [...attempt.domains.get(cell)!].sort(compareWorldStrings);
  const total = domain.reduce((sum, tile) => sum + model.weights.get(tile)!, 0);
  let draw = rng() * total;
  let picked = domain[domain.length - 1]!;
  for (const tile of domain) {
    draw -= model.weights.get(tile)!;
    if (draw <= 0) {
      picked = tile;
      break;
    }
  }
  attempt.domains.set(cell, new Set([picked]));
  for (const tile of domain) {
    if (tile !== picked)
      attempt.eliminations.get(cell)!.push({ tile, neighbor: cell, direction: "observed" });
  }
}

function propagate(
  model: PreparedModel,
  attempt: WfcAttempt,
  seedCells: ReadonlyArray<string>,
): void {
  const queue = [...seedCells];
  const queued = new Set(queue);
  while (queue.length > 0) {
    const cell = queue.shift()!;
    queued.delete(cell);
    const domain = attempt.domains.get(cell)!;
    for (const edge of model.outgoing.get(cell)!) {
      const neighborDomain = attempt.domains.get(edge.to)!;
      const pairs = model.allowed.get(edge.direction);
      const surviving = [...neighborDomain].filter((tile) =>
        [...domain].some((source) => pairs?.get(source)?.has(tile) === true),
      );
      if (surviving.length === neighborDomain.size) continue;
      for (const tile of neighborDomain) {
        if (!surviving.includes(tile))
          attempt.eliminations
            .get(edge.to)!
            .push({ tile, neighbor: cell, direction: edge.direction });
      }
      attempt.domains.set(edge.to, new Set(surviving));
      if (surviving.length === 0) throwContradiction(attempt, edge.to);
      if (!queued.has(edge.to)) {
        queue.push(edge.to);
        queued.add(edge.to);
      }
    }
  }
}

function throwContradiction(attempt: WfcAttempt, cell: string): never {
  const log = attempt.eliminations.get(cell) ?? [];
  const last = log[log.length - 1] ?? { tile: "unknown", neighbor: cell, direction: "unknown" };
  const neighborDomain =
    last.neighbor === cell
      ? [...(attempt.domains.get(cell) ?? [])]
      : [...(attempt.domains.get(last.neighbor) ?? [])].sort(compareWorldStrings);
  throw new WfcContradictionError({
    cell,
    neighbor: last.neighbor,
    direction: last.direction,
    neighborTiles: neighborDomain,
    eliminated: log.length,
    lastTile: last.tile,
  });
}

/**
 * Collapse every cell to one tile. Restarts reseed deterministically on
 * contradiction; exhausting the budget rethrows the final contradiction
 * with its cell and blocking neighborhood.
 */
export function solveWfc(input: WfcInput): WfcSolution {
  const model = prepareModel(input);
  const maxRestarts = input.maxRestarts ?? DEFAULT_WFC_MAX_RESTARTS;
  let restarts = 0;
  for (;;) {
    try {
      const assignments = attemptSolve(model, input.seed + restarts);
      return { assignments, restarts };
    } catch (error) {
      if (!(error instanceof WfcContradictionError) || restarts >= maxRestarts) throw error;
      restarts += 1;
    }
  }
}
