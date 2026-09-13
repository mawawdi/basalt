import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const compiledRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = compiledRoot.endsWith("/dist") ? resolve(compiledRoot, "..") : compiledRoot;
const expectedActions = [
  "review_substitution_set",
  "review_assembly_kit",
  "review_attachment_set",
  "review_route_kit",
  "review_environment_realizer",
  "remain_incomplete",
  "review_collision_companion",
] as const;
const fixtureSchema = z
  .object({
    authority: z.literal("regression_fixture_only"),
    rule: z.string().min(1),
    cases: z
      .array(
        z
          .object({
            caseId: z.string().regex(/^[a-z][a-z0-9_]*$/u),
            sourceHints: z.array(z.string().endsWith(".glb")).min(1),
            reportedClaim: z.string().min(1),
            expectedAction: z.enum(expectedActions),
            requiredProof: z.string().min(1),
          })
          .strict(),
      )
      .length(expectedActions.length),
  })
  .strict();

test("imported catalog audit examples are non-authoritative structured regressions", () => {
  const fixture = fixtureSchema.parse(
    JSON.parse(readFileSync(resolve(root, "test/fixtures/catalog-audit-cases.json"), "utf8")),
  );
  assert.equal(new Set(fixture.cases.map((entry) => entry.caseId)).size, fixture.cases.length);
  assert.deepEqual(
    [...fixture.cases.map((entry) => entry.expectedAction)].sort(),
    [...expectedActions].sort(),
  );
  assert.match(fixture.rule, /review hints/u);
});
