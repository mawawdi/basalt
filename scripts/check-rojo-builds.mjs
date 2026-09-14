import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projects = [
  ["plugin", "packages/roblox/plugin/default.project.json", "BasaltStudioPlugin.rbxmx"],
];
const execOptions = { cwd: root, maxBuffer: 4 * 1024 * 1024, windowsHide: true };

async function assertRegular(path, label) {
  const info = await lstat(path).catch(() => undefined);
  if (!info || info.isSymbolicLink() || !info.isFile())
    throw new Error(`${label} is not a regular file: ${path}`);
  return info;
}

async function main() {
  const binary = process.env.BASALT_ROJO ?? "rojo";
  const requiredVersion = process.env.BASALT_ROJO_VERSION;
  if (requiredVersion) await assertRegular(binary, "Configured Basalt Rojo executable");
  const version = await execFile(binary, ["--version"], execOptions);
  const renderedVersion = `${version.stdout}\n${version.stderr}`.trim();
  if (!/^Rojo\s+\d+\.\d+\.\d+/m.test(renderedVersion))
    throw new Error(
      `Expected a Rojo executable, received: ${renderedVersion || "no version output"}`,
    );
  if (
    requiredVersion &&
    !new RegExp(`(?:^|\\s)Rojo\\s+${requiredVersion.replaceAll(".", "\\\\.")}(?:\\s|$)`, "m").test(
      renderedVersion,
    )
  )
    throw new Error(`Expected Rojo ${requiredVersion}, received: ${renderedVersion}`);

  // Materialize the ignored, repository-local connection module before Rojo
  // resolves the plugin tree. The built plugin and bridge then share the same
  // authenticated loopback credential without manual Studio configuration.
  await execFile(process.execPath, ["bin/basalt.js", "roblox", "install-plugin"], {
    ...execOptions,
    maxBuffer: 1024 * 1024,
  });

  const temporary = await mkdtemp(join(tmpdir(), "basalt-rojo-check-"));
  try {
    for (const [name, project, filename] of projects) {
      const projectPath = resolve(root, project);
      await assertRegular(projectPath, `${name} project`);
      const output = resolve(temporary, filename);
      await execFile(binary, ["build", projectPath, "--output", output], execOptions);
      const artifact = await assertRegular(output, `${name} temporary Rojo build`);
      if (artifact.size === 0) throw new Error(`${name} temporary Rojo build is empty`);
      if (name === "plugin") await verifyPluginArtifact(output);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
  }
  process.stdout.write(
    `Rojo check passed with ${renderedVersion.split("\n")[0]}: ${projects.map(([name]) => name).join(", ")}\n`,
  );
}

async function verifyPluginArtifact(path) {
  const xml = await readFile(path, "utf8");
  const modules = (
    await readdir(resolve(root, "packages/roblox/plugin/src/Basalt"), {
      withFileTypes: true,
    })
  )
    .filter((entry) => entry.isFile() && entry.name.endsWith(".luau"))
    .map((entry) => entry.name.slice(0, -".luau".length))
    .concat("EmbeddedConnection")
    .sort();
  for (const moduleName of modules) {
    const marker = `<string name="Name">${moduleName}</string>`;
    const count = xml.split(marker).length - 1;
    if (count !== 1)
      throw new Error(
        `Rojo plugin must contain exactly one ${moduleName} module; observed ${count}`,
      );
  }
  const helper = xml.indexOf("local function artifactObservation");
  const firstCall = xml.indexOf('artifactObservation("route_junction"');
  if (helper < 0 || firstCall < 0 || helper > firstCall)
    throw new Error("Built plugin calls artifactObservation before its local declaration");
}

await main();
