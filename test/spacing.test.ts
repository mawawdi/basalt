import assert from "node:assert/strict";
import test from "node:test";
import {
  MINIMUM_CLEARANCE_RADIUS_STUDS,
  clearanceRadius,
  createCrossFamilySpacing,
  maximumClearanceRadius,
} from "../packages/world-compiler/src/index.js";
import { groundingEvidenceFixture } from "./helpers/grounding-evidence.js";

test("Spacing floors clearance at the legacy pairwise gap", () => {
  assert.equal(MINIMUM_CLEARANCE_RADIUS_STUDS, 0.25);
  assert.equal(clearanceRadius(0.03, 1), 0.25);
  assert.equal(clearanceRadius(2, 1.5), 3);
  assert.throws(() => clearanceRadius(0, 1), /positive/);
  assert.throws(() => clearanceRadius(1, 0), /positive/);
});

test("Spacing grid rejects overlap and allows touching discs", () => {
  const spacing = createCrossFamilySpacing(2);
  assert.equal(spacing.tryClaim(0, 0, 1), true);
  assert.equal(spacing.tryClaim(1.5, 0, 1), false);
  assert.equal(spacing.tryClaim(2, 0, 1), true);
  assert.equal(spacing.tryClaim(0, 0, 0.5), false);
  assert.throws(() => spacing.tryClaim(9, 9, 3), /escapes the spacing grid bound/);
  assert.throws(() => createCrossFamilySpacing(0), /positive/);
});

test("Spacing grid covers worst-case pairs across cells", () => {
  const spacing = createCrossFamilySpacing(4);
  assert.equal(spacing.tryClaim(0, 0, 4), true);
  // 7.9 < 4 + 4: overlapping pair nearly three cells apart diagonally.
  assert.equal(spacing.tryClaim(5.5, 5.5, 4), false);
  assert.equal(spacing.tryClaim(8, 0, 4), true);
  const wide = createCrossFamilySpacing(4);
  assert.equal(wide.tryClaim(-100, -100, 4), true);
  assert.equal(wide.tryClaim(100, 100, 4), true);
});

test("Spacing grid repels across partition seams", () => {
  // One world-space grid: a claim near x = 60 on one partition blocks the
  // same disc claimed from the neighbor side. Fresh grids stay independent.
  const spacing = createCrossFamilySpacing(2);
  assert.equal(spacing.tryClaim(59, 0, 1), true);
  assert.equal(spacing.tryClaim(60.5, 0, 1), false);
  assert.equal(spacing.tryClaim(61, 0, 1), true);
  const fresh = createCrossFamilySpacing(2);
  assert.equal(fresh.tryClaim(60.5, 0, 1), true);
});

test("Spacing sizes grids from evidence spans and scale bounds", () => {
  const evidence = groundingEvidenceFixture("sizedFamily", 2);
  const maximum = maximumClearanceRadius(
    [
      {
        familyId: "sizedFamily",
        regionIds: ["region"],
        surfaceKinds: ["terrain"],
        distribution: "poisson_scatter",
        minimumCount: 0,
        maximumCount: 4,
        density: { minimum: 0, target: 0.4, maximum: 0.8 },
        variationSeed: 0,
        excludedRouteIds: [],
        excludedRegionIds: [],
        archetypeCount: 2,
        scaleRange: [1, 2],
      },
    ],
    new Map([["sizedFamily", evidence.evidence[0]!.archetypes]]),
  );
  assert.equal(maximum, 1);
  assert.throws(
    () =>
      maximumClearanceRadius(
        [
          {
            familyId: "missingFamily",
            regionIds: ["region"],
            surfaceKinds: ["terrain"],
            distribution: "poisson_scatter",
            minimumCount: 0,
            maximumCount: 4,
            density: { minimum: 0, target: 0.4, maximum: 0.8 },
            variationSeed: 0,
            excludedRouteIds: [],
            excludedRegionIds: [],
          },
        ],
        new Map(),
      ),
    /no grounding evidence/,
  );
});
