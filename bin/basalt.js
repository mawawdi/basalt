#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { assertRuntimeBuildCurrent } from "../scripts/runtime-build-manifest.mjs";

const entrypoint = resolve(import.meta.dirname, "../packages/cli/dist/index.js");
if (!existsSync(entrypoint)) {
  process.stderr.write("Basalt is not built. Run npm run build first.\n");
  process.exit(2);
}

try {
  await assertRuntimeBuildCurrent();
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}. Run npm run build first.\n`,
  );
  process.exit(2);
}

const child = spawn(process.execPath, [entrypoint, ...process.argv.slice(2)], { stdio: "inherit" });
let forwardedSignal;
for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    forwardedSignal = signal;
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  });
}
child.on("error", (error) => {
  process.stderr.write(`Basalt compiler failed to start: ${error.message}\n`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  const signalExitCodes = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };
  process.exitCode = signal
    ? (signalExitCodes[signal] ?? 1)
    : (code ?? (forwardedSignal ? (signalExitCodes[forwardedSignal] ?? 1) : 1));
});
