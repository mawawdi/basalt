#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const run = promisify(execFile);
const root = resolve(new URL("..", import.meta.url).pathname);
const pluginRoot = resolve(root, "plugin/src");

async function walk(directory) {
  const files = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
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
process.stdout.write(`Basalt connector parse check passed: ${files.length} Luau modules\n`);
