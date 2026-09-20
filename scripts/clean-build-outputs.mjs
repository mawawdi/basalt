#!/usr/bin/env node
import { readdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = resolve(root, "packages");
const packages = await readdir(packageRoot, { withFileTypes: true });
const outputs = [
  resolve(root, "dist"),
  ...packages
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => resolve(packageRoot, entry.name, "dist")),
];

for (const output of outputs) await rm(output, { recursive: true, force: true });
