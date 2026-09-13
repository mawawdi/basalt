import assert from "node:assert/strict";
import test from "node:test";
import { sealConstraintModel, solveConstraintModel } from "@basalt/spatial-core";

function alternatingRing(size: number, seed = 1) {
  const cells = Array.from({ length: size }, (_, index) => ({
    cellId: `c${index}`,
    candidates: [
      { candidateId: "A", weight: 1 },
      { candidateId: "B", weight: 1 },
    ],
  }));
  const edges = Array.from({ length: size }, (_, index) => ({
    edgeId: `edge${index}`,
    fromCellId: `c${index}`,
    toCellId: `c${(index + 1) % size}`,
    relationId: "alternates",
    policy: "symmetric" as const,
  }));
  return sealConstraintModel({
    seed,
    cells,
    edges,
    relations: [
      {
        relationId: "alternates",
        allowed: [
          ["A", "B"],
          ["B", "A"],
        ],
      },
    ],
    policy: { maximumDecisions: 128, maximumBacktracks: 128 },
  });
}

test("constraint solver seals arrays and solves symmetric ring adjacency deterministically", () => {
  const model = alternatingRing(8, 7);
  assert.equal(model.edges.length, 16);
  assert.ok(model.edges.every((edge) => edge.policy === "directed"));
  const first = solveConstraintModel(model);
  const second = solveConstraintModel(model);
  assert.equal(first.status, "eligible");
  assert.deepEqual(second, first);
  assert.equal(first.assignments.length, 8);
  const assignments = new Map(
    first.assignments.map((assignment) => [assignment.cellId, assignment.candidateId]),
  );
  for (let index = 0; index < 8; index += 1)
    assert.notEqual(assignments.get(`c${index}`), assignments.get(`c${(index + 1) % 8}`));
});

test("constraint model canonicalization absorbs declaration order", () => {
  const forward = alternatingRing(6, 11);
  const reversed = sealConstraintModel({
    seed: 11,
    cells: [...forward.cells].reverse().map((cell) => ({
      ...cell,
      candidates: [...cell.candidates].reverse(),
    })),
    edges: [...forward.edges].reverse(),
    relations: [...forward.relations].reverse().map((relation) => ({
      ...relation,
      allowed: [...relation.allowed].reverse(),
    })),
    policy: forward.policy,
  });
  assert.equal(reversed.hash, forward.hash);
  assert.deepEqual(solveConstraintModel(reversed), solveConstraintModel(forward));
});

test("constraint model rejects relation candidates outside an edge domain", () => {
  assert.throws(
    () =>
      sealConstraintModel({
        seed: 1,
        cells: [
          { cellId: "left", candidates: [{ candidateId: "A", weight: 1 }] },
          { cellId: "right", candidates: [{ candidateId: "B", weight: 1 }] },
        ],
        edges: [
          {
            edgeId: "impossible",
            fromCellId: "left",
            toCellId: "right",
            relationId: "same",
            policy: "directed",
          },
        ],
        relations: [{ relationId: "same", allowed: [["A", "A"]] }],
        policy: { maximumDecisions: 8, maximumBacktracks: 8 },
      }),
    /outside edge domains/,
  );
});

test("constraint solver uses bounded chronological backtracking", () => {
  const model = sealConstraintModel({
    seed: 22,
    cells: [
      {
        cellId: "a",
        candidates: [
          { candidateId: "red", weight: 5 },
          { candidateId: "blue", weight: 1 },
        ],
      },
      {
        cellId: "b",
        candidates: [
          { candidateId: "red", weight: 5 },
          { candidateId: "blue", weight: 1 },
        ],
      },
      {
        cellId: "c",
        candidates: [
          { candidateId: "red", weight: 5 },
          { candidateId: "blue", weight: 1 },
        ],
      },
    ],
    edges: [
      {
        edgeId: "ab",
        fromCellId: "a",
        toCellId: "b",
        relationId: "different",
        policy: "symmetric",
      },
      {
        edgeId: "bc",
        fromCellId: "b",
        toCellId: "c",
        relationId: "different",
        policy: "symmetric",
      },
      {
        edgeId: "ca",
        fromCellId: "c",
        toCellId: "a",
        relationId: "different",
        policy: "symmetric",
      },
    ],
    relations: [
      {
        relationId: "different",
        allowed: [
          ["red", "blue"],
          ["blue", "red"],
        ],
      },
    ],
    policy: { maximumDecisions: 64, maximumBacktracks: 64 },
  });
  const solution = solveConstraintModel(model);
  assert.equal(solution.status, "incomplete");
  assert.ok(solution.backtracks > 0);
  assert.ok(solution.contradictions.length > 0);
});

test("constraint model rejects duplicate declarations and expands asymmetric symmetric edges", () => {
  assert.throws(
    () =>
      sealConstraintModel({
        seed: 1,
        cells: [
          { cellId: "a", candidates: [{ candidateId: "A", weight: 1 }] },
          { cellId: "a", candidates: [{ candidateId: "A", weight: 1 }] },
        ],
        edges: [],
        relations: [],
        policy: { maximumDecisions: 1, maximumBacktracks: 0 },
      }),
    /unique/,
  );
  const asymmetric = sealConstraintModel({
    seed: 1,
    cells: [
      {
        cellId: "a",
        candidates: [
          { candidateId: "A", weight: 1 },
          { candidateId: "B", weight: 1 },
        ],
      },
      {
        cellId: "b",
        candidates: [
          { candidateId: "A", weight: 1 },
          { candidateId: "B", weight: 1 },
        ],
      },
    ],
    edges: [
      { edgeId: "ab", fromCellId: "a", toCellId: "b", relationId: "one_way", policy: "symmetric" },
    ],
    relations: [{ relationId: "one_way", allowed: [["A", "B"]] }],
    policy: { maximumDecisions: 8, maximumBacktracks: 8 },
  });
  assert.equal(asymmetric.edges.length, 2);
  assert.equal(solveConstraintModel(asymmetric).status, "incomplete");
});

test("directed constraints do not require callers to duplicate AC-3 reverse arcs", () => {
  const directed = sealConstraintModel({
    seed: 2,
    cells: [
      {
        cellId: "a",
        candidates: [
          { candidateId: "A", weight: 1 },
          { candidateId: "B", weight: 1 },
        ],
      },
      {
        cellId: "b",
        candidates: [
          { candidateId: "A", weight: 1 },
          { candidateId: "B", weight: 1 },
        ],
      },
    ],
    edges: [
      { edgeId: "ab", fromCellId: "a", toCellId: "b", relationId: "one_way", policy: "directed" },
    ],
    relations: [{ relationId: "one_way", allowed: [["A", "B"]] }],
    policy: { maximumDecisions: 8, maximumBacktracks: 8 },
  });
  const solution = solveConstraintModel(directed);
  assert.equal(directed.edges.length, 1);
  assert.equal(solution.status, "eligible");
  assert.deepEqual(solution.assignments, [
    { cellId: "a", candidateId: "A" },
    { cellId: "b", candidateId: "B" },
  ]);
});
