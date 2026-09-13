#!/usr/bin/env node
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";

const execFile = promisify(execFileCallback);
const root = resolve(new URL("..", import.meta.url).pathname);
const result = await execFile(process.execPath, ["bin/basalt.js", "roblox", "install-plugin"], {
  cwd: root,
  maxBuffer: 4 * 1024 * 1024,
});
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
