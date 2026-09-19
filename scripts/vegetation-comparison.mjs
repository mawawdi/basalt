// Bounded, same-scene development comparison. No Studio or model calls; no catalog mutation.
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { readBoundedWorkspaceBytes, writeCanonicalWorkspaceJson } from "@basalt/artifact-store";
import { contentHash, stableJson } from "@basalt/contracts";
import { CATALOG_AUTHORITY_COMMIT_SCHEMA } from "@basalt/catalog-authoring";
import { CATALOG_MEASUREMENT_SET_SCHEMA } from "@basalt/catalog-model";
import { compileBasaltWorld, canopyInfluenceAt } from "@basalt/world-compiler";
import { sealSpatialWorldPlan, SPATIAL_WORLD_PLAN_SCHEMA } from "@basalt/world-planning";
import { sealRefinementPolicy, verifyWorldBuild } from "@basalt/world-refinement";
import { prepareWorldPlacementGeometry } from "../packages/cli/dist/world-placement-geometry.js";
import { loadSemanticRegistry } from "../dist/test/helpers/semantic-registry.js";
import { writeFile } from "node:fs/promises";

const execFile = promisify(execFileCallback);
const options = new Map();
for (let i = 2; i < process.argv.length; i += 2) options.set(process.argv[i], process.argv[i + 1]);
if (!options.get("--plan") || !options.get("--views") || !options.get("--output"))
  throw new Error(
    "Usage: vegetation-comparison.mjs --plan <plan.json> --views <cameras.json> --output <new directory> [--spec <spec.json>] [--capture true|false]",
  );
const root = process.cwd(),
  output = options.get("--output");
const read = async (path) =>
  JSON.parse((await readBoundedWorkspaceBytes(root, path, 256 * 1024 * 1024)).toString("utf8"));
const save = (path, value) =>
  writeCanonicalWorkspaceJson(root, `${output}/${path}`, value, { maxBytes: 256 * 1024 * 1024 });
const source = SPATIAL_WORLD_PLAN_SCHEMA.parse(await read(options.get("--plan")));
const spec = await read(options.get("--spec") ?? "test/fixtures/vegetation-comparison.json");
const cameras = [...(await read(options.get("--views"))), ...(spec.extraCameras ?? [])];
const catalog = CATALOG_AUTHORITY_COMMIT_SCHEMA.parse(await read("registry/catalog.json"));
const retained = catalog.retainedEvidence.find(
  (entry) =>
    entry.kind === "CatalogMeasurementSet" && entry.artifactHash === catalog.measurementSetHash,
);
const measurementBytes = await readBoundedWorkspaceBytes(
  root,
  retained.relativePath,
  256 * 1024 * 1024,
);
if (contentHash(measurementBytes) !== retained.bytesHash)
  throw new Error("Retained measurement bytes changed");
const measurements = CATALOG_MEASUREMENT_SET_SCHEMA.parse(
  JSON.parse(measurementBytes.toString("utf8")),
);
const semanticModule = await loadSemanticRegistry();
const variants = ["current", "adaptive", "layered"];
const sourceEvidence = [];
for (const path of [
  "scripts/vegetation-comparison.mjs",
  "scripts/preview-world.mjs",
  "scripts/world-preview-client.mjs",
  "scripts/world-preview-views.mjs",
  "packages/catalog-model/src/requirements.ts",
  "packages/catalog-model/src/placement-geometry.ts",
  "packages/asset-inspection/src/placement-geometry.ts",
  "packages/world-compiler/src/compiler.ts",
  "packages/world-compiler/src/world-build.ts",
  "packages/world-compiler/src/vegetation.ts",
  "packages/world-compiler/src/population-density.ts",
  "packages/world-planning/src/contracts.ts",
  "packages/spatial-core/src/occupancy.ts",
  "packages/world-refinement/src/verifiers.ts",
  "packages/cli/src/world-placement-geometry.ts",
]) {
  const bytes = await readBoundedWorkspaceBytes(root, path, 4 * 1024 * 1024);
  sourceEvidence.push({ path, hash: contentHash(bytes), source: bytes.toString("utf8") });
}
await save("implementation.json", sourceEvidence);
await save("experiment.json", {
  sourcePlanHash: source.planHash,
  catalogHash: catalog.hash,
  spec,
  cameras,
  variants,
  implementationHash: contentHash(stableJson(sourceEvidence)),
  comparison:
    "Same terrain, routes, static intents, palette, seeds, cameras and per-species instance caps. Density-budget comparison, not matched counts. Current uses aggregate occupancy; adaptive and layered use measured bands. Adaptive disables canopy preference only. All results are development evidence, not engine verification.",
});
const base = structuredClone(source);
delete base.kind;
delete base.coordinateSystem;
delete base.planHash;
const fixed = base.realizationIntents.filter(
  (intent) => !spec.replaceRequirementIds.includes(intent.requirementId),
);
const regionId = base.regions[0].regionId,
  surfaceId = base.placementSurfaces[0].surfaceId;
const reports = [];
let geometry;
for (const seed of spec.seeds)
  for (const variant of variants) {
    const plants = spec.palette.map((plant, i) => ({
      kind: "surface_scatter",
      intentId: `Vegetation${i}`,
      requirementId: plant.requirementId,
      priority: plant.priority ?? 100,
      regionId,
      surfaceId,
      boundary: spec.boundary,
      minimumCount: 0,
      targetCount: plant.cap,
      minimumSeparationMeters: 0.02,
      densityField: {
        seed: seed + 7,
        edgeFadeMeters: 8,
        wavelengthMeters: plant.layer === "ground_cover" ? 8 : 28,
        minimumDensity: 0.12,
        patchContrast: 2,
      },
      ...(variant === "current"
        ? {}
        : {
            vegetation: {
              layer: plant.layer,
              candidateDensityPerSquareMeter: plant.density,
              spacingMeters: { minimum: plant.spacing[0], maximum: plant.spacing[1] },
              canopyIntentIds:
                plant.layer === "canopy"
                  ? []
                  : spec.palette.flatMap((parent, j) =>
                      parent.layer === "canopy" ? [`Vegetation${j}`] : [],
                    ),
              canopyResponse:
                variant === "adaptive"
                  ? { open: 1, covered: 1 }
                  : { open: plant.response[0], covered: plant.response[1] },
              maximumSlopeDegrees: 28,
              maximumSupportReliefMeters: 0.35,
              groundEmbedMeters: 0.025,
              routeClearanceHeightMeters: 3,
              clearings: spec.clearings,
            },
          }),
    }));
    const spatialPlan = sealSpatialWorldPlan({
      ...base,
      seed,
      realizationIntents: [...fixed, ...plants],
      cameras,
    });
    const folder = `${seed}/${variant}`;
    await save(`${folder}/spatial-plan.json`, spatialPlan);
    const start = performance.now();
    if (variant !== "current" && !geometry) {
      geometry = await prepareWorldPlacementGeometry({
        root,
        plan: spatialPlan,
        semanticModule,
        snapshot: catalog.snapshot,
        assets: measurements.assets,
        sourceManifest: catalog.sourceManifest,
      });
      await save("placement-geometry.json", geometry);
    }
    const preparedAt = performance.now();
    const input = {
      semanticModule,
      catalogSnapshot: catalog.snapshot,
      catalogAssets: measurements.assets,
      spatialPlan,
      placementGeometry: variant === "current" ? [] : geometry,
    };
    const world = compileBasaltWorld(input);
    const compileSeconds = (performance.now() - preparedAt) / 1000;
    if (compileBasaltWorld(input).worldBuildHash !== world.worldBuildHash)
      throw new Error("Vegetation replay differs");
    await save(`${folder}/world-build.json`, world);
    await save(`${folder}/views.json`, { worldBuildHash: world.worldBuildHash, cameras });
    const observation = verifyWorldBuild({
      plan: spatialPlan,
      worldBuild: world,
      policy: sealRefinementPolicy({
        maximumIterations: 1,
        constructionParameters: [],
        routeAlternatives: [],
        vegetation: [],
        terrainPaint: [],
        protectedIntentIds: [],
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
    await save(`${folder}/observation.json`, observation);
    const population = world.instances.filter((instance) =>
      instance.intentId.startsWith("Vegetation"),
    );
    const layer = (instance) =>
      spec.palette[Number(instance.intentId.slice("Vegetation".length))].layer;
    const canopy = population.filter((instance) => layer(instance) === "canopy");
    const understory = population.filter((instance) => layer(instance) === "understory");
    const underCanopy = understory.filter(
      (instance) =>
        canopyInfluenceAt(
          canopy,
          instance.transformMeters.position.x,
          instance.transformMeters.position.z,
        ) > 0.5,
    ).length;
    const clearingAnchors = population.filter(({ transformMeters: { position: p } }) =>
      spec.clearings.some(
        ({ boundsMeters: { min, max } }) =>
          p.x > min.x && p.x < max.x && p.y >= min.y && p.y <= max.y && p.z > min.z && p.z < max.z,
      ),
    ).length;
    const report = {
      seed,
      variant,
      status: world.status,
      worldBuildHash: world.worldBuildHash,
      compileSeconds,
      preparationSeconds: (preparedAt - start) / 1000,
      instances: world.instances.length,
      plants: population.length,
      counts: Object.fromEntries(
        spec.palette.map((plant, i) => [
          plant.requirementId,
          population.filter((p) => p.intentId === `Vegetation${i}`).length,
        ]),
      ),
      canopy: canopy.length,
      understory: understory.length,
      underCanopy,
      clearingAnchors,
      staticPlacementsHash: contentHash(
        stableJson(
          world.instances
            .filter((instance) => !instance.intentId.startsWith("Vegetation"))
            .map((i) => i.hash)
            .sort(),
        ),
      ),
      terrainHashes: world.foundation.terrainFields.map((field) => field.hash),
      routeHashes: world.foundation.routeConstructions.map((route) => route.hash),
      previewOnly: true,
      independentVisualReview: false,
      engineVerified: false,
      diagnostics: world.diagnostics,
      occupancyGate: observation.checks.find((check) => check.kind === "occupancy_clearance"),
    };
    reports.push(report);
    await save(`${folder}/metrics.json`, report);
    console.log(JSON.stringify(report));
    if (world.status === "eligible" && options.get("--capture") !== "false") {
      await execFile(
        process.execPath,
        [
          "scripts/preview-world.mjs",
          "--world",
          `${output}/${folder}/world-build.json`,
          "--views",
          `${output}/${folder}/views.json`,
          "--capture",
          `${output}/${folder}/preview`,
        ],
        { cwd: root, maxBuffer: 4 * 1024 * 1024 },
      );
    }
  }
for (const seed of spec.seeds) {
  const cases = reports.filter((report) => report.seed === seed);
  if (
    new Set(
      cases.map((report) =>
        stableJson([report.staticPlacementsHash, report.terrainHashes, report.routeHashes]),
      ),
    ).size !== 1
  )
    throw new Error("Comparison changed fixed scene content");
}
await save("report.json", {
  reports,
  previewOnly: true,
  independentVisualReview: false,
  engineVerified: false,
});
const escape = (text) =>
  String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
const html = `<!doctype html><meta charset="utf-8"><title>Basalt vegetation comparison</title><style>body{font:15px system-ui;background:#11191a;color:#e6ebde;margin:32px}h1{font-size:28px}.row{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:32px}img{width:100%}article{background:#1c2728;padding:12px}p{line-height:1.6}small{color:#bfcabb}</style><h1>Vegetation comparison</h1><p>Every predeclared seed and camera is shown. Fixed terrain, routes, props, palette and instance caps. Counts vary with density and constraints. Current uses independent quota filling; adaptive uses measured packing and clearings; layered also conditions smaller plants on accepted canopy. WebGL previews only; visual acceptance and Studio verification remain unestablished.</p>${spec.seeds
  .map(
    (seed) =>
      `<h2>Seed ${seed}</h2>${cameras
        .map(
          (camera) =>
            `<h3>${escape(camera.cameraId)}</h3><div class="row">${variants
              .map((variant) => {
                const r = reports.find(
                  (report) => report.seed === seed && report.variant === variant,
                );
                return `<article><strong>${escape(variant)}</strong><p>${r.plants} plants · ${r.canopy} trees · ${r.underCanopy}/${r.understory} shrubs/ferns under canopy · ${r.clearingAnchors} anchors inside clearings · ${r.compileSeconds.toFixed(2)}s compile</p><a href="${seed}/${variant}/preview/${camera.cameraId}.png"><img src="${seed}/${variant}/preview/${camera.cameraId}.png"></a><small>${r.worldBuildHash}</small></article>`;
              })
              .join("")}</div>`,
        )
        .join("")}`,
  )
  .join("")}`;
await writeFile(resolve(root, output, "index.html"), html, { flag: "wx" });
console.log(JSON.stringify({ report: resolve(root, output, "index.html") }));
