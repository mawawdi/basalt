#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execute = promisify(execFile);
const environment = { ...process.env, PYTHONDONTWRITEBYTECODE: "1" };
const options = { env: environment, maxBuffer: 1024 * 1024 };

await runPython(["workers/catalog-review/test_near_duplicate.py"]);
await runPython(["workers/catalog-metadata/worker.py", "--self-test"]);
for (const path of ["workers/catalog-metadata/worker.py", "workers/catalog-metadata/modal_app.py"])
  await runPython([
    "-c",
    `compile(open(${JSON.stringify(path)}, encoding="utf-8").read(), ${JSON.stringify(path)}, "exec")`,
  ]);

const worker = await readFile("workers/catalog-metadata/worker.py", "utf8");
const modal = await readFile("workers/catalog-metadata/modal_app.py", "utf8");
const expected = new Map([
  ["MAX_ITEMS", "8"],
  ["MAX_VIEWS", "12"],
  ["IMAGE_LONG_EDGE", "384"],
  ["MAX_EVIDENCE_FILES", "192"],
  ["MAX_EVIDENCE_TOTAL_BYTES", "64 * 1024 * 1024"],
]);
for (const [name, value] of expected) {
  if (!worker.includes(`${name} = ${value}`)) throw new Error(`Metadata worker ${name} drifted`);
}
if (!modal.includes('"cpu": 4.0')) throw new Error("Modal metadata worker must use four CPU cores");
if (!modal.includes('"max_containers": 1'))
  throw new Error("Modal metadata execution must permit one container per execution path");
if (!modal.includes('"OMP_NUM_THREADS": "4"') || !modal.includes('"MKL_NUM_THREADS": "4"'))
  throw new Error("Modal metadata CPU thread bounds drifted");
if (/max_containers["']?\s*[:=]\s*[2-9]/u.test(modal))
  throw new Error("Modal metadata worker declares more than one container");

process.stdout.write("Catalog worker checks passed\n");

async function runPython(args) {
  const { stdout, stderr } = await execute("python3", args, options);
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
}
