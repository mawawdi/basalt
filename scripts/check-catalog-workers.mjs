#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const { stdout, stderr } = await execute(
  "python3",
  ["workers/catalog-review/test_near_duplicate.py"],
  {
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    maxBuffer: 1024 * 1024,
  },
);
if (stdout) process.stdout.write(stdout);
if (stderr) process.stderr.write(stderr);
