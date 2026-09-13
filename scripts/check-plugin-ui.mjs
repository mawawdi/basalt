#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

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
for (const file of files) {
  await run("luau-compile", ["--only-parse", file], { cwd: root });
}

const panel = await readFile(resolve(pluginRoot, "Basalt/PluginPanel.luau"), "utf8");
const connector = await readFile(resolve(pluginRoot, "Basalt/ConnectorRuntime.luau"), "utf8");
for (const [source, pattern, invariant] of [
  [panel, "CreateDockWidgetPluginGuiAsync", "a docked Studio panel"],
  [panel, 'primaryText = "Waiting for bridge"', "an explicit connection state"],
  [panel, 'stop.Name = "StopAction"', "a bounded stop action"],
  [connector, "ImportSequence.run", "sequential queue draining"],
  [connector, 'primaryText = "Import"', "one-click world import"],
]) {
  if (!source.includes(pattern)) throw new Error(`Plugin UI must retain ${invariant}`);
}
if (panel.includes('Instance.new("TextBox")'))
  throw new Error("Plugin UI must not expose manual bridge credential fields");

process.stdout.write(
  `Basalt connector UI check passed: ${files.length} Luau modules, docked one-click sequential import\n`,
);
