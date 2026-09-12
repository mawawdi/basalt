#!/usr/bin/env node
// Local pipeline operator: click-through UI for palette → compile → upload →
// bridge for any brief/plan working directory. Serves 127.0.0.1 only. Reads
// the Roblox API key from the repo-root .env into process memory for uploads;
// the key is never served, logged, or written anywhere — status reports a
// boolean only.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readEnvFileKey } from "./read-env-file.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dirIndex = process.argv.indexOf("--dir");
const workDir = resolve(
  root,
  dirIndex >= 0 && dirIndex + 1 < process.argv.length
    ? process.argv[dirIndex + 1]
    : ".basalt/slice",
);
const logPath = resolve(workDir, "operator.log");
const configPath = resolve(workDir, "operator-config.json");
const PORT = 8797;

const PATHS = {
  palette: resolve(workDir, "palette"),
  build: resolve(workDir, "build.json"),
  export: resolve(workDir, "export"),
  sidecar: resolve(workDir, "sidecar.json"),
  materialMap: resolve(workDir, "material-map.json"),
  emission: resolve(workDir, "emission.json"),
};

mkdirSync(workDir, { recursive: true });
writeFileSync(logPath, "", { flag: "a" });

let apiKey = process.env.BASALT_ROBLOX_API_KEY ?? readEnvFileKey(root, "BASALT_ROBLOX_API_KEY");

let config = {
  creatorUserId: "1048340316",
  includeIncomplete: true,
  briefPath: "test/helpers/slice-region.brief.json",
  planPath: "test/helpers/slice-region.plan.json",
  engineMaterials: { sliceMaterial: "Sand", asphalt: "Asphalt" },
};
try {
  config = { ...config, ...JSON.parse(readFileSync(configPath, "utf8")) };
} catch {
  /* first run */
}
const saveConfig = () => writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

const steps = {};
let bridgeChild = null;
const redact = (text) => (apiKey ? String(text).split(apiKey).join("<redacted>") : String(text));
function log(line) {
  const stamped = `${new Date().toISOString()} ${redact(line)}\n`;
  writeFileSync(logPath, stamped, { flag: "a" });
}

function runStep(name, command, args, options = {}) {
  if (steps[name]?.status === "running") throw new Error(`Step ${name} is already running`);
  steps[name] = { status: "running", detail: "", updatedAt: Date.now() };
  log(`--- ${name}: ${command} ${args.join(" ")}`);
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...(options.env ?? {}) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let tail = "";
  const capture = (chunk) => {
    const text = redact(String(chunk));
    log(`[${name}] ${text.trimEnd()}`);
    tail = `${tail}${text}`.slice(-2000);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  return new Promise((resolveDone) => {
    child.on("error", (error) => {
      steps[name] = { status: "error", detail: redact(error.message), updatedAt: Date.now() };
      log(`--- ${name} failed to start: ${redact(error.message)}`);
      resolveDone(false);
    });
    child.on("exit", (code) => {
      const ok = code === 0;
      steps[name] = {
        status: ok ? "done" : "error",
        detail: ok ? summarize(name) : tail.trim().split("\n").pop() || `exit ${code}`,
        updatedAt: Date.now(),
      };
      log(`--- ${name} ${ok ? "done" : `failed with exit ${code}`}`);
      resolveDone(ok);
    });
  });
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function summarize(name) {
  try {
    if (name === "palette") {
      const requests = readJson(resolve(PATHS.palette, "family-requests.json")) ?? [];
      return `${requests.length} family requests`;
    }
    if (name === "compile") {
      const manifest = readJson(resolve(PATHS.export, "scene-manifest.json"));
      return manifest
        ? `${manifest.instances.length} instances, ${manifest.parts.length} parts, export ${manifest.hash.slice(0, 12)}`
        : "export written";
    }
    if (name === "upload") {
      const sidecar = readJson(PATHS.sidecar);
      return sidecar ? `${sidecar.bindings.length} bindings` : "sidecar written";
    }
    if (name === "bridge-files") return "material map + emission written";
  } catch {
    /* fall through */
  }
  return "done";
}

async function writeBridgeFiles() {
  const manifest = readJson(resolve(PATHS.export, "scene-manifest.json"));
  if (!manifest?.hash) throw new Error("Compile first: no scene export");
  if (!Array.isArray(manifest.materialIds))
    throw new Error("Compile first: export lacks material ids");
  const engineMaterials = config.engineMaterials;
  const unmapped = manifest.materialIds.filter((id) => !(id in engineMaterials));
  if (unmapped.length > 0)
    throw new Error(`Export material ids lack engine bindings: ${unmapped.join(", ")}`);
  writeFileSync(
    PATHS.materialMap,
    `${JSON.stringify(
      {
        kind: "BasaltMaterialMap",
        abi: "basalt-material-map@1",
        engine: "roblox",
        exportHash: manifest.hash,
        bindings: manifest.materialIds.map((materialId) => ({
          materialId,
          robloxMaterial: engineMaterials[materialId],
        })),
      },
      null,
      2,
    )}\n`,
  );
  const build = readJson(PATHS.build);
  if (!build?.emission) throw new Error("Compile first: no world build");
  writeFileSync(PATHS.emission, `${JSON.stringify(build.emission)}\n`);
}

async function bridgeHealth() {
  try {
    const response = await fetch("http://127.0.0.1:8787/health");
    if (!response.ok) return { running: false };
    return { running: true, ...(await response.json()) };
  } catch {
    return { running: false };
  }
}

function startBridge() {
  if (bridgeChild?.exitCode === null) throw new Error("Bridge is already running");
  for (const [label, path] of Object.entries({
    emission: PATHS.emission,
    export: resolve(PATHS.export, "scene-manifest.json"),
    sidecar: PATHS.sidecar,
    materialMap: PATHS.materialMap,
  })) {
    try {
      readFileSync(path);
    } catch {
      throw new Error(`Bridge needs ${label} first`);
    }
  }
  log("--- bridge: starting");
  bridgeChild = spawn(
    process.execPath,
    [
      "bin/basalt.js",
      "studio",
      "bridge",
      "--manifest",
      PATHS.emission,
      "--revision",
      "0".repeat(64),
      "--export-dir",
      PATHS.export,
      "--sidecar",
      PATHS.sidecar,
      "--material-map",
      PATHS.materialMap,
    ],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
  );
  const capture = (chunk) => log(`[bridge] ${redact(String(chunk)).trimEnd()}`);
  bridgeChild.stdout.on("data", capture);
  bridgeChild.stderr.on("data", capture);
  bridgeChild.on("exit", (code) => {
    log(`--- bridge exited with ${code}`);
    bridgeChild = null;
  });
}

function stopBridge() {
  if (bridgeChild?.exitCode === null) {
    bridgeChild.kill("SIGTERM");
    log("--- bridge: stop requested");
  }
  bridgeChild = null;
}

const server = createServer(async (request, response) => {
  const send = (code, value) => {
    response.statusCode = code;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(value));
  };
  try {
    if (request.method === "GET" && request.url === "/") {
      response.statusCode = 200;
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(readFileSync(resolve(root, "scripts/operator.html")));
      return;
    }
    if (request.method === "GET" && request.url === "/api/status") {
      const manifest = readJson(resolve(PATHS.export, "scene-manifest.json"));
      const sidecar = readJson(PATHS.sidecar);
      send(200, {
        steps,
        config: { ...config },
        apiKeySet: Boolean(apiKey),
        exportHash: manifest?.hash,
        instanceCount: manifest?.instances.length,
        partCount: manifest?.parts.length,
        sidecarBindings: sidecar?.bindings.length,
        bridge: await bridgeHealth(),
      });
      return;
    }
    if (request.method === "GET" && request.url?.startsWith("/api/log")) {
      const since = Number(new URL(request.url, "http://x").searchParams.get("since") ?? 0);
      const full = readFileSync(logPath, "utf8");
      send(200, { chunk: full.slice(since).slice(-20000), next: full.length });
      return;
    }
    if (request.method === "POST" && request.url === "/api/config") {
      const body = JSON.parse(await textBody(request));
      if (body.creatorUserId !== undefined) {
        if (!/^\d{1,20}$/u.test(String(body.creatorUserId)))
          throw new Error("Creator user id must be numeric");
        config.creatorUserId = String(body.creatorUserId);
      }
      if (body.briefPath !== undefined) {
        if (typeof body.briefPath !== "string" || body.briefPath.length === 0)
          throw new Error("Brief path must be a non-empty string");
        config.briefPath = body.briefPath;
      }
      if (body.planPath !== undefined) {
        if (typeof body.planPath !== "string" || body.planPath.length === 0)
          throw new Error("Plan path must be a non-empty string");
        config.planPath = body.planPath;
      }
      if (body.engineMaterials !== undefined) {
        const bindings = body.engineMaterials;
        if (
          typeof bindings !== "object" ||
          bindings === null ||
          Array.isArray(bindings) ||
          Object.entries(bindings).length === 0 ||
          Object.entries(bindings).some(
            ([materialId, engineMaterial]) =>
              typeof materialId !== "string" ||
              materialId.length === 0 ||
              typeof engineMaterial !== "string" ||
              !/^[A-Za-z]{2,32}$/u.test(engineMaterial),
          )
        )
          throw new Error("Engine materials must map ids to engine material names");
        config.engineMaterials = { ...bindings };
      }
      if (body.includeIncomplete !== undefined)
        config.includeIncomplete = Boolean(body.includeIncomplete);
      saveConfig();
      send(200, { ok: true });
      return;
    }
    if (request.method === "POST" && request.url?.startsWith("/api/run/")) {
      const name = request.url.slice("/api/run/".length);
      if (name === "palette")
        runStep(name, process.execPath, [
          "scripts/resolve-region-palette.mjs",
          "--",
          "--brief",
          config.briefPath,
          "--output",
          PATHS.palette,
        ]);
      else if (name === "compile")
        runStep(name, process.execPath, [
          "bin/basalt.js",
          "world",
          "compile",
          config.planPath,
          "--output",
          PATHS.build,
          "--family-registry",
          resolve(PATHS.palette, "family-registry.json"),
          "--family-requests",
          resolve(PATHS.palette, "family-requests.json"),
          "--family-evidence",
          resolve(PATHS.palette, "family-evidence.json"),
          "--export-dir",
          PATHS.export,
        ]);
      else if (name === "upload") {
        if (!apiKey) throw new Error("No API key: add BASALT_ROBLOX_API_KEY to the repo-root .env");
        if (!/^\d{1,20}$/u.test(config.creatorUserId))
          throw new Error("Creator user id must be numeric");
        runStep(
          name,
          process.execPath,
          [
            "scripts/upload-scene-meshes.mjs",
            "--",
            "--export-dir",
            PATHS.export,
            "--sidecar-out",
            PATHS.sidecar,
            "--creator-user-id",
            config.creatorUserId,
            ...(config.includeIncomplete ? ["--include-incomplete"] : []),
          ],
          { env: { BASALT_ROBLOX_API_KEY: apiKey } },
        );
      } else if (name === "bridge-files") {
        steps[name] = { status: "running", detail: "", updatedAt: Date.now() };
        try {
          await writeBridgeFiles();
          steps[name] = { status: "done", detail: summarize(name), updatedAt: Date.now() };
        } catch (error) {
          steps[name] = {
            status: "error",
            detail: error instanceof Error ? error.message : String(error),
            updatedAt: Date.now(),
          };
        }
      } else if (name === "bridge-start") {
        steps[name] = { status: "running", detail: "", updatedAt: Date.now() };
        try {
          startBridge();
          steps[name] = { status: "done", detail: "bridge on :8787", updatedAt: Date.now() };
        } catch (error) {
          steps[name] = {
            status: "error",
            detail: error instanceof Error ? error.message : String(error),
            updatedAt: Date.now(),
          };
        }
      } else throw new Error(`Unknown step: ${name}`);
      send(200, { ok: true });
      return;
    }
    if (request.method === "POST" && request.url === "/api/bridge/stop") {
      stopBridge();
      steps["bridge-start"] = { status: "pending", detail: "", updatedAt: Date.now() };
      send(200, { ok: true });
      return;
    }
    send(404, { error: "not found" });
  } catch (error) {
    send(400, { error: error instanceof Error ? error.message : String(error) });
  }
});

function textBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 64 * 1024) rejectBody(new Error("request too large"));
    });
    request.on("end", () => resolveBody(body));
    request.on("error", rejectBody);
  });
}

server.listen(PORT, "127.0.0.1", () => {
  log(`operator listening on http://127.0.0.1:${PORT}`);
  process.stdout.write(
    `Basalt operator (${workDir}): open http://127.0.0.1:${PORT} in a browser\n`,
  );
});
process.once("SIGINT", () => {
  stopBridge();
  process.exit(0);
});
process.once("SIGTERM", () => {
  stopBridge();
  process.exit(0);
});
