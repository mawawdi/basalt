#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";

/** Code-unit string order. Locale-aware comparison must never feed sealed output. */
const compareStrings = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

const run = promisify(execFile);
const root = resolve(new URL("..", import.meta.url).pathname);
const pluginRoot = resolve(root, "packages/roblox/plugin/src");

async function walk(directory) {
  const files = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
    compareStrings(a.name, b.name),
  )) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else if (entry.isFile() && entry.name.endsWith(".luau")) files.push(path);
    else if (!entry.isFile()) throw new Error(`Plugin source is not a regular file: ${path}`);
  }
  return files;
}

const files = await walk(pluginRoot);
const sourceByFile = new Map(
  await Promise.all(files.map(async (file) => [file, await readFile(file, "utf8")])),
);
for (const file of files) {
  await run("luau-compile", ["--only-parse", file], { cwd: root });
}

const lintRoot = await mkdtemp(join(tmpdir(), "basalt-plugin-lint-"));
try {
  const lintConfig = join(lintRoot, "selene.toml");
  const standard = resolve(root, "selene-roblox").replaceAll("\\", "\\\\");
  await writeFile(lintConfig, `std = "${standard}"\n\n[rules]\nmultiple_statements = "allow"\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await run("selene", ["--config", lintConfig, "--num-threads", "4", relative(root, pluginRoot)], {
    cwd: root,
  });
} finally {
  await rm(lintRoot, { recursive: true, force: true, maxRetries: 3 });
}

// The standalone analyzer has no Roblox DataModel definitions, so its full
// type report is intentionally not a gate. Its unresolved-global diagnostics
// are still valuable: a misspelled or lexically out-of-scope helper compiles as
// a global lookup and otherwise fails only when Studio reaches that branch.
let analyzerOutput = "";
try {
  await run("luau-analyze", files, { cwd: root });
} catch (error) {
  analyzerOutput = `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
}
const robloxGlobals = new Set([
  "CFrame",
  "Color3",
  "DockWidgetPluginGuiInfo",
  "Enum",
  "Instance",
  "OverlapParams",
  "RaycastParams",
  "Region3",
  "UDim",
  "UDim2",
  "Vector2",
  "Vector3",
  "game",
  "plugin",
  "script",
  "settings",
  "task",
  "warn",
]);
const unexpectedGlobals = [
  ...new Set(
    [...analyzerOutput.matchAll(/Unknown global '([^']+)'/gu)]
      .map((match) => match[1])
      .filter((name) => !robloxGlobals.has(name)),
  ),
].sort(compareStrings);
if (unexpectedGlobals.length > 0)
  throw new Error(`Plugin has unresolved global calls: ${unexpectedGlobals.join(", ")}`);

for (const file of files) {
  const lines = sourceByFile.get(file).split(/\r?\n/u);
  for (const [declarationIndex, line] of lines.entries()) {
    const declaration = /^local function\s+([A-Za-z_][A-Za-z0-9_]*)/u.exec(line);
    if (!declaration) continue;
    const functionName = declaration[1];
    const call = new RegExp(`\\b${functionName}\\s*\\(`, "u");
    for (let earlierIndex = 0; earlierIndex < declarationIndex; earlierIndex += 1) {
      const executable = lines[earlierIndex].replace(/--.*$/u, "");
      if (call.test(executable))
        throw new Error(
          `${file}:${earlierIndex + 1} calls local function ${functionName} before its declaration on line ${declarationIndex + 1}`,
        );
    }
  }
}

const modules = new Map();
for (const file of files) {
  const moduleName = basename(file, ".luau");
  if (modules.has(moduleName))
    throw new Error(`Plugin has duplicate module identity ${moduleName}`);
  modules.set(moduleName, { file, source: sourceByFile.get(file) });
}

// Rojo materializes this ignored local credential module into the same Basalt
// folder. Verify its source exists and parses, while keeping its token private.
const embeddedConnection = resolve(root, ".basalt/roblox/EmbeddedConnection.luau");
const embeddedInfo = await lstat(embeddedConnection).catch(() => undefined);
if (!embeddedInfo?.isFile() || embeddedInfo.isSymbolicLink())
  throw new Error("Plugin requires a regular generated EmbeddedConnection module");
await run("luau-compile", ["--only-parse", embeddedConnection], { cwd: root });
modules.set("EmbeddedConnection", {
  file: embeddedConnection,
  source: await readFile(embeddedConnection, "utf8"),
});

const dependencies = new Map([...modules.keys()].map((name) => [name, new Set()]));
for (const [moduleName, module] of modules) {
  const importedAliases = new Map();
  for (const match of module.source.matchAll(
    /local\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*require\(script(?:\.Parent|\.Basalt)\.([A-Za-z_][A-Za-z0-9_]*)\)/gu,
  )) {
    const [, alias, targetName] = match;
    const target = modules.get(targetName);
    if (!target)
      throw new Error(`${relative(root, module.file)} requires missing module ${targetName}`);
    importedAliases.set(alias, targetName);
    dependencies.get(moduleName).add(targetName);
  }
  for (const [alias, targetName] of importedAliases) {
    const target = modules.get(targetName);
    const exportedMethods = new Set(
      [
        ...target.source.matchAll(
          /function\s+[A-Za-z_][A-Za-z0-9_]*\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/gu,
        ),
      ].map((match) => match[1]),
    );
    for (const call of module.source.matchAll(
      new RegExp(`\\b${alias}\\.([A-Za-z_][A-Za-z0-9_]*)\\s*\\(`, "gu"),
    )) {
      if (!exportedMethods.has(call[1]))
        throw new Error(
          `${relative(root, module.file)} calls missing export ${targetName}.${call[1]}`,
        );
    }
  }
}

const reachable = new Set();
const queue = ["Main.server"];
while (queue.length > 0) {
  const moduleName = queue.shift();
  if (reachable.has(moduleName)) continue;
  reachable.add(moduleName);
  for (const dependency of dependencies.get(moduleName) ?? []) queue.push(dependency);
}
for (const moduleName of modules.keys())
  if (moduleName !== "EmbeddedConnection" && !reachable.has(moduleName))
    throw new Error(`Plugin module ${moduleName} is unreachable from Main.server`);

const panel = modules.get("PluginPanel").source;
const connector = modules.get("ConnectorRuntime").source;
const loadedAsset = modules.get("LoadedAsset").source;
const environmentLowering = modules.get("EnvironmentLowering").source;
const worldLowering = modules.get("WorldLowering").source;
const modelBounds = modules.get("ModelBounds").source;
const terrainLowering = modules.get("TerrainLowering").source;
const terrainReadback = modules.get("TerrainReadback").source;
const routeGrounding = modules.get("RouteGrounding").source;
for (const [source, pattern, invariant] of [
  [panel, "CreateDockWidgetPluginGuiAsync", "a docked Studio panel"],
  [panel, 'primaryText = "Waiting for bridge"', "an explicit connection state"],
  [panel, 'stop.Name = "StopAction"', "a bounded stop action"],
  [connector, "ImportSequence.run", "sequential queue draining"],
  [connector, "TransactionBoundary.commit", "acknowledged two-phase world commit"],
  [connector, 'primaryText = "Import"', "one-click world import"],
  [connector, 'typeof(status.loweringGapCount) ~= "number"', "validated bridge status"],
  [connector, "WorldLowering.takeTraceEvents()", "failure-safe diagnostic trace transfer"],
  [connector, ".basalt/roblox/import-report.json", "a discoverable durable diagnostic report"],
  [worldLowering, "prepareAssetTemplates", "whole-transaction asset binding preflight"],
  [
    worldLowering,
    "EnvironmentLowering.begin(transaction.visualEnvironment)",
    "transactional visual-environment application",
  ],
  [environmentLowering, "EnvironmentLowering.verify()", "visual-environment property readback"],
  [environmentLowering, "snapshot.effects", "reversible prior post-processing effects"],
  [
    worldLowering,
    "fitAssetModelToDeclaration(probe :: Model, entry)",
    "pre-placement fit validation for every declared catalog instance",
  ],
  [loadedAsset, "exactly one geometric package model", "fail-closed loaded asset unwrapping"],
  [worldLowering, "route.thicknessMeters", "compiler-authored route thickness"],
  [worldLowering, "ModelBounds.worldAabb", "world-axis-aligned asset readback"],
  [modelBounds, "PointToWorldSpace", "BasePart-corner world bounds"],
  [
    worldLowering,
    "verifyRouteConstruction(root, routeConstruction)",
    "actual route geometry readback",
  ],
  [worldLowering, "Workspace:Raycast", "actual Roblox terrain-contact readback"],
  [
    worldLowering,
    "resolveFoundationRouteGeometry(foundation)",
    "realized-terrain route conformance",
  ],
  [worldLowering, "stationAdjustments", "continuous bounded route conformance"],
  [worldLowering, "RouteCoordination.resolve", "quantized route-junction coordination"],
  [worldLowering, "recordTerrainTrace", "final-only route terrain tracing"],
  [
    worldLowering,
    "routeAdjustmentAtStation",
    "route supports and edge protection following realized route corrections",
  ],
  [worldLowering, "adjustedVerticalCylinder", "ground-extended supports and translated edge posts"],
  [worldLowering, "junctionTerrainCorrection", "shared route-junction conformance"],
  [
    worldLowering,
    "rawLateral - travel * rawLateral:Dot(travel)",
    "orthonormal route lowering frames",
  ],
  [worldLowering, "orientation drifted: right", "component-level route readback diagnostics"],
  [worldLowering, "MAX_TERRAIN_QUERY_WAIT_FRAMES", "a bounded terrain-collision readiness barrier"],
  [worldLowering, "task.wait()", "terrain collision retries across scheduler frames"],
  [worldLowering, 'groundings.Name = "Grounding"', "bounded route grounding geometry"],
  [routeGrounding, "maximumBodyClearanceStuds", "body-relative route grounding policy"],
  [
    terrainLowering,
    "SURFACE_SAMPLE_OFFSET_METERS = CELL_METERS / 2",
    "centered smooth-terrain occupancy lowering",
  ],
  [terrainLowering, "TerrainReadback.materialMatches", "occupancy-aware terrain material readback"],
  [
    terrainReadback,
    "math.max(expectedOccupancy, observedOccupancy)",
    "quantized-empty terrain material semantics",
  ],
]) {
  if (!source.includes(pattern)) throw new Error(`Plugin UI must retain ${invariant}`);
}
const stopHandler = connector.match(/panel:onStop\(function\(\)[\s\S]*?\n\tend\)/u)?.[0] ?? "";
if (stopHandler.includes("WorldLowering.rollback") || stopHandler.includes("BridgeClient.cancel"))
  throw new Error("Plugin cancellation must be observed at a transaction boundary");
if (panel.includes('Instance.new("TextBox")'))
  throw new Error("Plugin UI must not expose manual bridge credential fields");

process.stdout.write(
  `Basalt connector UI check passed: ${files.length} Luau modules, docked one-click sequential import\n`,
);
