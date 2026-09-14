import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { readBoundedWorkspaceBytes, writeCanonicalWorkspaceJson } from "@basalt/artifact-store";
import { compileBasaltWorld } from "@basalt/world-compiler";
import { createRobloxImportManifest } from "@basalt/roblox";
import { loadSemanticRegistry } from "../dist/test/helpers/semantic-registry.js";
import { routeCorridorFixture } from "../dist/test/helpers/route-corridor-fixture.js";

const repositoryRoot = resolve(".");
const outputRoot = ".basalt/evals/route-corridor";
const semanticModule = await loadSemanticRegistry();
const fixture = await routeCorridorFixture(semanticModule);
const first = compileBasaltWorld(fixture.compileInput);
const second = compileBasaltWorld(fixture.compileInput);

if (first.status !== "eligible")
  throw new Error(
    `Route-corridor fixture compiled as ${first.status}: ${first.diagnostics.join("; ")}`,
  );
if (first.worldBuildHash !== second.worldBuildHash)
  throw new Error("Route-corridor fixture is not deterministic");
const robloxImport = createRobloxImportManifest(first);
if (robloxImport.loweringGaps.length > 0)
  throw new Error(
    `Route-corridor Roblox lowering is incomplete: ${robloxImport.loweringGaps
      .map((gap) => gap.reason)
      .join("; ")}`,
  );

await Promise.all([
  writeGeneratedJson(`${outputRoot}/spatial-plan.json`, fixture.plan),
  writeGeneratedJson(`${outputRoot}/world-build.json`, first),
  writeGeneratedJson(`${outputRoot}/roblox-import.json`, robloxImport),
]);

process.stdout.write(
  `${JSON.stringify(
    {
      status: first.status,
      worldBuildHash: first.worldBuildHash,
      routeConstructions: first.foundation.routeConstructions.map((route) => ({
        routeId: route.routeId,
        treatment: route.treatmentKind,
        segments: route.travelSegments.length,
        bends: route.bends.length,
        supports: route.supports.length,
      })),
      junctions: first.foundation.routeJunctions.length,
      outputRoot,
      robloxImport: `${outputRoot}/roblox-import.json`,
    },
    null,
    2,
  )}\n`,
);

async function writeGeneratedJson(path, value) {
  let expectedExistingHash;
  try {
    const current = await readBoundedWorkspaceBytes(repositoryRoot, path);
    expectedExistingHash = createHash("sha256").update(current).digest("hex");
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("missing")) throw error;
  }
  return writeCanonicalWorkspaceJson(repositoryRoot, path, value, {
    maxBytes: 64 * 1024 * 1024,
    ...(expectedExistingHash ? { expectedExistingHash } : {}),
  });
}
