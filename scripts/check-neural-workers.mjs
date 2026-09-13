import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const root = resolve(".");
const environment = {
  ...process.env,
  PYTHONDONTWRITEBYTECODE: "1",
};

await execFile("python3", ["-m", "unittest", "workers/neural-provisioning/test_control_plane.py"], {
  cwd: root,
  env: environment,
  maxBuffer: 4 * 1024 * 1024,
});

const temporary = await realpath(await mkdtemp(join(tmpdir(), "basalt-neural-workers-")));
try {
  const trellisProbe = join(temporary, "trellis-worker.json");
  await execFile("python3", ["-S", "workers/trellis2/worker.py", "--probe", trellisProbe], {
    cwd: root,
    env: environment,
    maxBuffer: 1024 * 1024,
  });
  requireIncomplete(JSON.parse(await readFile(trellisProbe, "utf8")), "TRELLIS.2 worker");

  for (const [label, path] of [
    ["TRELLIS.2 Modal boundary", "workers/trellis2/modal_app.py"],
    ["TRELLIS.2 runtime image", "workers/trellis2/runtime_image.py"],
    ["TRELLIS.2 runtime manifest", "workers/trellis2/runtime_manifest.py"],
    ["Pixal3D worker", "workers/pixal3d/worker.py"],
    ["Pixal3D Modal boundary", "workers/pixal3d/modal_app.py"],
    ["Hunyuan3D 2.1 worker", "workers/hunyuan3d/worker.py"],
    ["neural provisioner", "workers/neural-provisioning/modal_app.py"],
  ]) {
    const { stdout } = await execFile("python3", ["-S", path, "--local-probe"], {
      cwd: root,
      env: environment,
      maxBuffer: 4 * 1024 * 1024,
    });
    requireIncomplete(JSON.parse(stdout), label);
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}

process.stdout.write("Neural worker contracts are parseable, offline, and fail closed.\n");

function requireIncomplete(value, label) {
  if (value?.status !== "incomplete" || value?.remoteInvocationOccurred === true)
    throw new Error(`${label} local probe is not fail closed`);
}
