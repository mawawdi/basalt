// Compare retained worlds. Captures are made separately so every inspected attempt survives.
import {
  readBoundedWorkspaceBytes,
  writeCanonicalWorkspaceJson,
  writePrivateWorkspaceText,
} from "@basalt/artifact-store";
import { contentHash, stableJson } from "@basalt/contracts";
import { sealRefinementPolicy, verifyWorldBuild } from "@basalt/world-refinement";

const root = process.cwd(),
  output = ".basalt/evals/harvest-valley-comparison";
const read = async (path) =>
  JSON.parse(
    (await readBoundedWorkspaceBytes(root, `${output}/${path}`, 256 * 1024 * 1024)).toString(),
  );
const before = await read("before/world-build.json"),
  after = await read("after/world-build.json");
const beforePlan = await read("before/spatial-plan.json"),
  afterPlan = await read("after/spatial-plan.json");
const fixedIds = new Set(
  beforePlan.realizationIntents
    .filter((i) => ["single", "surface_grid"].includes(i.kind))
    .map((i) => i.intentId),
);
const fixed = (world) =>
  world.instances
    .filter((i) => fixedIds.has(i.intentId))
    .map((i) => ({
      intentId: i.intentId,
      assetHash: i.assetHash,
      transformMeters: i.transformMeters,
    }))
    .sort((a, b) => stableJson(a).localeCompare(stableJson(b)));
const protectedHash = contentHash(stableJson(fixed(before)));
if (protectedHash !== contentHash(stableJson(fixed(after))))
  throw new Error("Protected authored placements changed");
const heights = (world) =>
  world.foundation.baseTerrainFields.flatMap((f) =>
    f.samples.map((s) => [s.xMeters, s.zMeters, s.elevationMeters]),
  );
if (stableJson(heights(before)) !== stableJson(heights(after)))
  throw new Error("Terrain heights changed");
const routes = (world) =>
  world.foundation.routeConstructions.map((r) => ({ id: r.routeId, segments: r.travelSegments }));
if (stableJson(routes(before)) !== stableJson(routes(after)))
  throw new Error("Route travel geometry changed");
const observation = verifyWorldBuild({
  plan: afterPlan,
  worldBuild: after,
  policy: sealRefinementPolicy({
    maximumIterations: 1,
    constructionParameters: [],
    routeAlternatives: [],
    protectedTaskHashes: [],
    requiredCheckKinds: ["occupancy_clearance"],
  }),
  expectations: {
    dimensions: [],
    access: [],
    viewCorridors: [],
    styles: [],
    minimumNeighborClearanceMeters: 0,
  },
});
const variants = ["before", "sparse-ridge", "after"];
const records = [];
for (const variant of variants) {
  const world = await read(`${variant}/world-build.json`);
  const capture = await read(`${variant}/preview/capture.json`);
  if (capture.worldBuildHash !== world.worldBuildHash) throw new Error("Stale world capture");
  if (records.length && stableJson(capture.cameras) !== stableJson(records[0].capture.cameras))
    throw new Error("Comparison cameras differ");
  for (const image of capture.images) {
    const bytes = await readBoundedWorkspaceBytes(
      root,
      `${output}/${variant}/preview/${image.file}`,
      16 * 1024 * 1024,
    );
    if (contentHash(bytes) !== image.hash) throw new Error("Capture image changed");
  }
  records.push({
    variant,
    worldBuildHash: world.worldBuildHash,
    instances: world.instances.length,
    models: new Set(world.instances.map((i) => i.assetHash)).size,
    capture,
  });
}
const report = {
  records,
  protectedInstanceCount: fixed(before).length,
  protectedHash,
  terrainHeightsUnchanged: true,
  routeGeometryUnchanged: true,
  observation,
  engineVerified: false,
  limits: [
    "Same-agent visual review; no independent acceptance.",
    "Native terrain material relief, root contact and collision require the creator's Studio check.",
  ],
};
async function replace(path, value, text = false) {
  let previous;
  try {
    previous = contentHash(await readBoundedWorkspaceBytes(root, path, 32 * 1024 * 1024));
  } catch (error) {
    if (error.code !== "ENOENT" && !error.message.includes("missing")) throw error;
  }
  return (text ? writePrivateWorkspaceText : writeCanonicalWorkspaceJson)(root, path, value, {
    maxBytes: 32 * 1024 * 1024,
    ...(previous ? { expectedExistingHash: previous } : {}),
  });
}
await replace(`${output}/report.json`, report);
const cameras = records[0].capture.cameras;
const html = `<!doctype html><meta charset="utf-8"><title>Harvest Valley planting comparison</title>
<style>body{margin:24px;background:#141b1d;color:#eee;font:16px system-ui}h1{font-size:28px}p{max-width:1000px;line-height:1.5}.pair{display:grid;grid-template-columns:1fr 1fr;gap:16px}img{width:100%}figure{margin:0}figcaption{padding:8px}a{color:#9edbce}section{margin:32px 0}</style>
<h1>Harvest Valley · before and after</h1><p>The same five cameras, retained exact builds. ${fixed(before).length} authored placements, terrain heights and route geometry are unchanged. Layered vegetation and authored material patches are new. Preview only; Studio review is pending.</p>
<p><a href="report.json">Evidence and checks</a> · <a href="sparse-ridge/preview/overview.png">Retained first attempt: sparse ridge</a></p>
${cameras.map((c) => `<section><h2>${c.cameraId}</h2><div class="pair">${["before", "after"].map((v) => `<figure><a href="${v}/preview/${c.cameraId}.png"><img src="${v}/preview/${c.cameraId}.png"></a><figcaption>${v} · ${records.find((r) => r.variant === v).instances} instances</figcaption></figure>`).join("")}</div></section>`).join("")}`;
await replace(`${output}/index.html`, html, true);
console.log(
  JSON.stringify({
    protectedInstanceCount: report.protectedInstanceCount,
    occupancy: observation.checks.find((check) => check.kind === "occupancy_clearance")?.status,
    worldBuildHash: after.worldBuildHash,
  }),
);
