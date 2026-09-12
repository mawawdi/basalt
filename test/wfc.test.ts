import assert from "node:assert/strict";
import test from "node:test";
import {
  solveWfc,
  type WfcAdjacency,
  type WfcEdge,
  type WfcTile,
} from "../packages/world-compiler/src/index.js";

function ringGraph(size: number): { cells: string[]; edges: WfcEdge[] } {
  const cells = Array.from({ length: size }, (_, index) => `c${index}`);
  const edges: WfcEdge[] = [];
  for (let index = 0; index < size; index += 1) {
    edges.push({ from: `c${index}`, to: `c${(index + 1) % size}`, direction: "next" });
    edges.push({ from: `c${(index + 1) % size}`, to: `c${index}`, direction: "prev" });
  }
  return { cells, edges };
}

const alternatingTiles: WfcTile[] = [
  { id: "A", weight: 1 },
  { id: "B", weight: 1 },
];

const alternatingAdjacency: WfcAdjacency[] = [
  {
    direction: "next",
    allowed: [
      ["A", "B"],
      ["B", "A"],
    ],
  },
  {
    direction: "prev",
    allowed: [
      ["A", "B"],
      ["B", "A"],
    ],
  },
];

test("wfc solves ring alternation deterministically", () => {
  const first = solveWfc({
    graph: ringGraph(4),
    tiles: alternatingTiles,
    adjacency: alternatingAdjacency,
    seed: 1,
  });
  assert.deepEqual(
    [...first.assignments].sort(([left], [right]) => (left < right ? -1 : 1)),
    [
      ["c0", "B"],
      ["c1", "A"],
      ["c2", "B"],
      ["c3", "A"],
    ],
  );
  assert.equal(first.restarts, 0);
  const second = solveWfc({
    graph: ringGraph(4),
    tiles: alternatingTiles,
    adjacency: alternatingAdjacency,
    seed: 1,
  });
  assert.deepEqual([...second.assignments], [...first.assignments]);
});

test("wfc absorbs declaration order", () => {
  const { cells, edges } = ringGraph(6);
  const ordered = solveWfc({
    graph: { cells, edges },
    tiles: alternatingTiles,
    adjacency: alternatingAdjacency,
    seed: 7,
  });
  const shuffled = solveWfc({
    graph: { cells: [...cells].reverse(), edges: [...edges].reverse() },
    tiles: [...alternatingTiles].reverse(),
    adjacency: [...alternatingAdjacency].reverse(),
    seed: 7,
  });
  assert.deepEqual([...shuffled.assignments].sort(), [...ordered.assignments].sort());
  assert.equal(shuffled.restarts, ordered.restarts);
});

test("wfc solutions satisfy every directed edge across seeds", () => {
  const { cells, edges } = ringGraph(8);
  const allowed = new Map(
    alternatingAdjacency.map((entry) => [
      entry.direction,
      new Set(entry.allowed.map(([from, to]) => `${from}>${to}`)),
    ]),
  );
  for (let seed = 1; seed <= 8; seed += 1) {
    const solution = solveWfc({
      graph: { cells, edges },
      tiles: alternatingTiles,
      adjacency: alternatingAdjacency,
      seed,
    });
    assert.equal(solution.assignments.size, 8);
    for (const edge of edges) {
      const pair = `${solution.assignments.get(edge.from)}>${solution.assignments.get(edge.to)}`;
      assert.ok(
        allowed.get(edge.direction)!.has(pair),
        `seed ${seed} edge ${edge.from}>${edge.to}`,
      );
    }
  }
});

test("wfc respects per-cell initial domains", () => {
  const solution = solveWfc({
    graph: ringGraph(4),
    tiles: alternatingTiles,
    adjacency: alternatingAdjacency,
    seed: 1,
    initialDomains: [{ cell: "c0", tiles: ["A"] }],
  });
  assert.equal(solution.assignments.get("c0"), "A");
  assert.equal(solution.assignments.get("c1"), "B");
  assert.throws(
    () =>
      solveWfc({
        graph: ringGraph(2),
        tiles: alternatingTiles,
        adjacency: alternatingAdjacency,
        seed: 1,
        initialDomains: [{ cell: "c0", tiles: [] }],
      }),
    /has no candidate tiles/,
  );
  assert.throws(
    () =>
      solveWfc({
        graph: ringGraph(2),
        tiles: alternatingTiles,
        adjacency: alternatingAdjacency,
        seed: 1,
        initialDomains: [{ cell: "ghost", tiles: ["A"] }],
      }),
    /unknown cell: ghost/,
  );
});

test("wfc contradictions name the cell and blocking neighborhood", () => {
  assert.throws(
    () =>
      solveWfc({
        graph: {
          cells: ["x", "y"],
          edges: [
            { from: "x", to: "y", direction: "next" },
            { from: "y", to: "x", direction: "prev" },
          ],
        },
        tiles: alternatingTiles,
        adjacency: [
          { direction: "next", allowed: [["A", "B"]] },
          { direction: "prev", allowed: [["A", "A"]] },
        ],
        seed: 1,
        maxRestarts: 2,
      }),
    /WFC contradiction at cell "(x|y)".*candidates eliminated/,
  );
  assert.throws(
    () =>
      solveWfc({
        graph: { cells: ["loop"], edges: [{ from: "loop", to: "loop", direction: "loop" }] },
        tiles: alternatingTiles,
        adjacency: [{ direction: "loop", allowed: [["A", "B"]] }],
        seed: 1,
        maxRestarts: 0,
      }),
    /WFC contradiction at cell "loop"/,
  );
});

test("wfc fails closed on degenerate models", () => {
  assert.throws(
    () =>
      solveWfc({
        graph: { cells: [], edges: [] },
        tiles: alternatingTiles,
        adjacency: [],
        seed: 1,
      }),
    /at least one cell/,
  );
  assert.throws(
    () =>
      solveWfc({
        graph: { cells: ["c0", "c0"], edges: [] },
        tiles: alternatingTiles,
        adjacency: [],
        seed: 1,
      }),
    /unique/,
  );
  assert.throws(
    () =>
      solveWfc({
        graph: ringGraph(2),
        tiles: [{ id: "A", weight: 0 }],
        adjacency: alternatingAdjacency,
        seed: 1,
      }),
    /positive finite/,
  );
  assert.throws(
    () =>
      solveWfc({
        graph: { cells: ["c0"], edges: [{ from: "c0", to: "ghost", direction: "next" }] },
        tiles: alternatingTiles,
        adjacency: alternatingAdjacency,
        seed: 1,
      }),
    /unknown cell: ghost/,
  );
  assert.throws(
    () =>
      solveWfc({
        graph: ringGraph(2),
        tiles: alternatingTiles,
        adjacency: [{ direction: "next", allowed: [["A", "ghost"]] }],
        seed: 1,
      }),
    /unknown tile: ghost/,
  );
  assert.throws(
    () =>
      solveWfc({
        graph: ringGraph(2),
        tiles: alternatingTiles,
        adjacency: alternatingAdjacency,
        seed: 1.5,
      }),
    /integer/,
  );
});
