// Local, read-only WebGL preview of exact catalog meshes and compiled terrain.
// The renderer is an art-direction aid, never Roblox engine evidence.
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import puppeteer from "puppeteer";
import { readBoundedWorkspaceBytes } from "@basalt/artifact-store";
import { contentHash } from "@basalt/contracts";
import { WORLD_BUILD_SCHEMA, sampleTerrainFieldSurface } from "@basalt/world-compiler";

const options = new Map();
for (let i = 2; i < process.argv.length; i += 2) options.set(process.argv[i], process.argv[i + 1]);
const worldPath = options.get("--world");
if (!worldPath)
  throw new Error(
    "Usage: node scripts/preview-world.mjs --world <world-build.json> [--capture <directory>] [--port <port>]",
  );
const root = resolve(".");
const readJson = async (path) =>
  JSON.parse((await readBoundedWorkspaceBytes(root, path, 256 * 1024 * 1024)).toString("utf8"));
const world = WORLD_BUILD_SCHEMA.parse(await readJson(worldPath));
if (world.foundation.status !== "eligible")
  throw new Error("Preview requires eligible compiled terrain and paths");
const catalog = await readJson("registry/catalog.json");
if (world.catalogSnapshotHash !== catalog.snapshot.hash)
  throw new Error("Preview catalog does not match the world");
const evidence = catalog.retainedEvidence.find((entry) => entry.kind === "CatalogMeasurementSet");
const measurementBytes = await readBoundedWorkspaceBytes(
  root,
  evidence.relativePath,
  256 * 1024 * 1024,
);
if (contentHash(measurementBytes) !== evidence.bytesHash)
  throw new Error("Retained measurements changed");
const measurements = JSON.parse(measurementBytes.toString("utf8"));
const files = new Map();
const types = new Map();
for (const instance of world.instances) {
  if (types.has(instance.assetHash)) continue;
  const asset = measurements.assets.find((entry) => entry.hash === instance.assetHash);
  const source = catalog.sourceManifest.assets.find(
    (entry) => entry.contentHash === asset.source.contentHash,
  );
  const bytes = await readBoundedWorkspaceBytes(root, source.relativePath, 32 * 1024 * 1024);
  if (contentHash(bytes) !== source.contentHash)
    throw new Error(`Preview source changed: ${source.relativePath}`);
  if (
    asset.coordinateFrame.up !== "+Y" ||
    asset.coordinateFrame.handedness !== "right_handed" ||
    asset.coordinateFrame.unitsToMeters !== "4294967296"
  )
    throw new Error("Preview needs canonical meter GLBs");
  const url = `/assets/${asset.hash}.glb`;
  files.set(url, { bytes, type: "model/gltf-binary" });
  types.set(instance.assetHash, { hash: asset.hash, url });
}
const terrains = world.foundation.terrainFields.map((field) => {
  const base = world.foundation.baseTerrainFields.find(
    (entry) => entry.hash === field.baseTerrainFieldHash,
  );
  const xs = [...new Set(base.samples.map((p) => p.xMeters))].sort((a, b) => a - b);
  const zs = [...new Set(base.samples.map((p) => p.zMeters))].sort((a, b) => a - b);
  const columns = Math.ceil((xs.at(-1) - xs[0]) / 2) + 1;
  const rows = Math.ceil((zs.at(-1) - zs[0]) / 2) + 1;
  if (columns * rows > 100_000)
    throw new Error("Preview a bounded world partition (maximum 100,000 terrain vertices)");
  const points = [];
  for (let z = 0; z < rows; z += 1)
    for (let x = 0; x < columns; x += 1) {
      const px = xs[0] + (x * (xs.at(-1) - xs[0])) / (columns - 1);
      const pz = zs[0] + (z * (zs.at(-1) - zs[0])) / (rows - 1);
      const sample = sampleTerrainFieldSurface(
        field,
        base,
        world.foundation.routeConstructions,
        world.foundation.routeJunctions,
        px,
        pz,
      );
      points.push([px, sample.elevationMeters, pz, sample.materialId]);
    }
  return { columns, rows, points };
});
const data = {
  hash: world.worldBuildHash,
  bounds: world.foundation.boundsMeters,
  instances: world.instances,
  assets: [...types.values()],
  terrains,
  routes: world.foundation.routeConstructions,
  junctions: world.foundation.routeJunctions,
};
files.set("/scene.json", { bytes: Buffer.from(JSON.stringify(data)), type: "application/json" });
const modules = [
  ["/client.mjs", "scripts/world-preview-client.mjs"],
  ["/three/three.module.js", "node_modules/three/build/three.module.js"],
  ["/three/three.core.js", "node_modules/three/build/three.core.js"],
  ...[
    "loaders/GLTFLoader.js",
    "controls/OrbitControls.js",
    "utils/BufferGeometryUtils.js",
    "utils/SkeletonUtils.js",
  ].map((path) => [`/three/addons/${path}`, `node_modules/three/examples/jsm/${path}`]),
];
for (const [url, path] of modules)
  files.set(url, {
    bytes: await readBoundedWorkspaceBytes(root, path, 16 * 1024 * 1024),
    type: "text/javascript",
  });
files.set("/", {
  bytes: Buffer.from(
    `<!doctype html><html><head><meta charset="utf-8"><title>Basalt world preview</title><style>body{margin:0;background:#bed2d5;overflow:hidden;font:13px system-ui;color:#fff}#caption{position:absolute;bottom:24px;left:28px;pointer-events:none;text-shadow:0 1px 5px #172020}#caption strong{display:block;font-size:24px;margin-bottom:5px}button{position:relative;margin:16px 0 0 16px;padding:9px 14px;border:0;border-radius:6px;background:#213332db;color:white;cursor:pointer}canvas{position:absolute;inset:0;z-index:-1}</style><script type="importmap">{"imports":{"three":"/three/three.module.js","three/addons/":"/three/addons/"}}</script></head><body><button data-view="overview">Overview</button><button data-view="arrival">Farm court</button><button data-view="ridge">Ridge</button><div id="caption"><strong>Basalt</strong><span id="status">Loading exact catalog meshes…</span></div><script type="module" src="/client.mjs"></script></body></html>`,
  ),
  type: "text/html",
});
const server = createServer((request, response) => {
  const file = files.get(new URL(request.url, "http://127.0.0.1").pathname);
  if (!file) {
    response.writeHead(404);
    response.end();
    return;
  }
  response.writeHead(200, {
    "Content-Type": file.type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(file.bytes);
});
await new Promise((done) => server.listen(Number(options.get("--port") ?? "0"), "127.0.0.1", done));
const url = `http://127.0.0.1:${server.address().port}/`;
console.log(
  JSON.stringify({
    url,
    worldBuildHash: world.worldBuildHash,
    instances: world.instances.length,
    models: types.size,
    evidence: "preview_only",
  }),
);
if (options.has("--capture")) {
  const directory = resolve(options.get("--capture"));
  await mkdir(directory, { recursive: true });
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--enable-unsafe-swiftshader"],
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1200, deviceScaleFactor: 1 });
    page.on("pageerror", (error) => console.error(error.message));
    await page.goto(url, { waitUntil: "networkidle0", timeout: 120_000 });
    await page.waitForFunction(() => globalThis.basaltPreviewReady === true, { timeout: 120_000 });
    for (const view of ["overview", "arrival", "ridge"]) {
      await page.evaluate((name) => globalThis.basaltPreviewView(name), view);
      await page.screenshot({ path: resolve(directory, `${view}.png`) });
    }
  } finally {
    await browser.close();
    server.close();
  }
}
