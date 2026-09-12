import { readFileSync, statSync } from "node:fs";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AssetFamilyRevision } from "../../basalt-types/src/index.js";
import type { CatalogAssetEnvelope } from "../../catalog-intelligence/src/contracts.js";
import {
  compileBasaltWorldFoundation,
  createBasaltWorldCompilerPlan,
  populateBasaltWorld,
  createBasaltWorldEmission,
  summarizeBasaltWorld,
  assertWorldAssetFamilyRegistry,
  compileResolvedFamilyPopulationPlans,
  type BasaltWorldFoundation,
  type WorldBiomeFamilyRequest,
  type WorldFamilyPopulationPlan,
  type WorldPopulationArtifact,
} from "../../world-compiler/src/index.js";
import { stableJson } from "../../contracts/src/index.js";
import { emitSceneExport } from "../../world-compiler/src/scene-export.js";
import { assemblePlanRoads, type RoadAssembly } from "../../world-planning/src/roads.js";
import { type WorldAssetFamilyRegistry } from "../../world-compiler/src/family-resolver.js";
import {
  BasaltStudioBridge,
  createBasaltStudioBridgeServer,
  defaultBasaltBridgeDiscoveryPath,
  writeBasaltBridgeDiscovery,
} from "../../studio-bridge/src/index.js";

/**
 * Basalt's command surface is intentionally a world compiler surface. Game
 * scripts, Luau AST generation, experiments, and full-scene DCC review are
 * external concerns and are not reachable from this entry point.
 */
const args = process.argv.slice(2);

async function main(): Promise<void> {
  const [command, subcommand, ...rest] = args;
  if (command === "world" && subcommand === "compile") return compileWorld(rest[0], rest.slice(1));
  if (command === "world" && subcommand === "summary") return worldSummary(rest[0]);
  if (command === "studio" && subcommand === "bridge") return studioBridge(rest);
  if (command === "help" || command === "--help" || command === undefined) return usage();
  process.stderr.write(`Unknown command: ${[command, subcommand].filter(Boolean).join(" ")}\n\n`);
  usage();
  process.exitCode = 2;
}

async function compileWorld(planPath: string | undefined, values: string[]): Promise<void> {
  let options: Map<string, string>;
  try {
    options = parseOptions(values);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
    return;
  }
  const output = options.get("--output");
  if (!planPath || !output) {
    process.stderr.write(
      "Usage: basalt world compile <world-plan.json> --output <world-build.json> [--families <family-plans.json> | --family-registry <registry.json> --family-requests <requests.json>] [--style-hash <sha256>] [--stage macro|meso|micro|partition] [--chunk-size <studs>] [--export-dir <dir> [--inventory <source-inventory.json>] [--source-manifest <source-manifest.json>]]\n",
    );
    process.exitCode = 2;
    return;
  }
  try {
    const foundation = compileBasaltWorldFoundation(await readJson(resolve(planPath)));
    const familyPlans = await loadFamilyPlans(options, foundation);
    const stage =
      (options.get("--stage") as "macro" | "meso" | "micro" | "partition" | undefined) ??
      "partition";
    const compilerPlan =
      familyPlans.length > 0 && stage !== "macro"
        ? createBasaltWorldCompilerPlan({
            foundation,
            styleContractHash: options.get("--style-hash") ?? "0".repeat(64),
            stage,
            familyPlans,
          })
        : undefined;
    const chunkSize = numberOption(options, "--chunk-size", 128);
    const population =
      compilerPlan && stage !== "meso"
        ? populateBasaltWorld(foundation, compilerPlan, { chunkSize })
        : undefined;
    const roads =
      population && stage === "partition"
        ? assemblePlanRoads(foundation.worldPlan.plan, foundation.worldPlan.surfaces, {
            chunkSizeStuds: chunkSize,
          })
        : undefined;
    const emission =
      population && stage === "partition"
        ? createBasaltWorldEmission(foundation, population, chunkSize, roads ?? [])
        : undefined;
    const result = {
      kind: "BasaltWorldCompilation",
      abi: "basalt-world-compiler@1",
      foundation: {
        worldPlanHash: foundation.worldPlanHash,
        surfaceIndexHash: foundation.surfaceIndexHash,
        regionIds: foundation.regionIds,
        terrainSurfaceIds: foundation.terrainSurfaceIds,
        constructedSurfaceIds: foundation.constructedSurfaceIds,
        routeIds: foundation.routeIds,
      },
      ...(compilerPlan ? { compilerPlan } : {}),
      ...(population ? { population } : {}),
      ...(roads ? { roads } : {}),
      ...(emission ? { emission } : {}),
      summary: summarizeBasaltWorld({
        foundation,
        ...(compilerPlan ? { compilerPlan } : {}),
      }),
    };
    await writeCanonicalJson(resolve(output), result);
    const exportDir = options.get("--export-dir");
    let exportedPayloads = 0;
    if (exportDir) {
      if (!population || !roads || stage !== "partition")
        throw new Error("Scene export requires a populated partition compilation");
      exportedPayloads = await writeSceneExport({
        exportDir: resolve(exportDir),
        foundation,
        population,
        roads,
        inventoryPath: resolve(
          options.get("--inventory") ?? ".basalt/catalog-cache/source-inventory.json",
        ),
        sourceManifestPath: resolve(
          options.get("--source-manifest") ?? "registry/source-manifest.json",
        ),
      });
    }
    process.stdout.write(
      `${JSON.stringify(
        {
          status: "eligible",
          output: resolve(output),
          worldPlanHash: foundation.worldPlanHash,
          regionCount: foundation.regionIds.length,
          instanceCount: population?.instanceCount ?? 0,
          connectorChunkCount: emission?.chunks.length ?? 0,
          ...(exportDir ? { exportDir: resolve(exportDir), exportedPayloads } : {}),
          stage,
        },
        null,
        2,
      )}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `Basalt world compilation failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

async function worldSummary(planPath: string | undefined): Promise<void> {
  if (!planPath) {
    process.stderr.write("Usage: basalt world summary <world-plan.json>\n");
    process.exitCode = 2;
    return;
  }
  try {
    const foundation = compileBasaltWorldFoundation(await readJson(resolve(planPath)));
    process.stdout.write(`${JSON.stringify(summarizeBasaltWorld({ foundation }), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(
      `Basalt world summary failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

async function studioBridge(values: string[]): Promise<void> {
  let options: Map<string, string>;
  try {
    options = parseOptions(values);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
    return;
  }
  const manifestPath = options.get("--manifest");
  const revisionHash = options.get("--revision");
  const exportDir = options.get("--export-dir");
  const sidecarPath = options.get("--sidecar");
  const materialMapPath = options.get("--material-map");
  if (!manifestPath || !revisionHash) {
    process.stderr.write(
      "Usage: basalt studio bridge --manifest <world-emission.json> --revision <sha256> [--export-dir <dir>] [--sidecar <sidecar.json>] [--material-map <material-map.json>] [--port <number>] [--discovery <path>]\n",
    );
    process.exitCode = 2;
    return;
  }
  if ((sidecarPath ?? materialMapPath) && !exportDir) {
    process.stderr.write(
      "Basalt studio bridge: --sidecar and --material-map require --export-dir\n",
    );
    process.exitCode = 2;
    return;
  }
  try {
    const bridge = new BasaltStudioBridge({ maxQueue: numberOption(options, "--max-queue", 4096) });
    bridge.enqueueManifest(await readJson(resolve(manifestPath)), revisionHash);
    if (exportDir) await enqueueExportDir(bridge, resolve(exportDir));
    if (sidecarPath) bridge.enqueueSidecar(await readJson(resolve(sidecarPath)));
    if (materialMapPath) bridge.enqueueMaterialMap(await readJson(resolve(materialMapPath)));
    const port = numberOption(options, "--port", 8787);
    const server = createBasaltStudioBridgeServer(bridge, { port });
    const boundPort = await waitForBridgePort(server);
    const discoveryPath = resolve(options.get("--discovery") ?? defaultBasaltBridgeDiscoveryPath());
    await writeBasaltBridgeDiscovery(
      {
        kind: "BasaltStudioBridgeDiscovery",
        bridgeId: bridge.bridgeId,
        host: "127.0.0.1",
        port: boundPort,
        controlToken: bridge.controlToken,
        pid: process.pid,
        startedAt: new Date().toISOString(),
      },
      discoveryPath,
    );
    process.stdout.write(
      `${JSON.stringify({ status: "ready", bridgeId: bridge.bridgeId, port: boundPort, discoveryPath, pendingTransactions: bridge.status().pendingTransactions }, null, 2)}\n`,
    );
    await new Promise<void>((resolveServer) => {
      const close = () => {
        server.close(() => resolveServer());
      };
      process.once("SIGINT", close);
      process.once("SIGTERM", close);
    });
  } catch (error) {
    process.stderr.write(
      `Basalt Studio bridge failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

async function waitForBridgePort(
  server: ReturnType<typeof createBasaltStudioBridgeServer>,
): Promise<number> {
  if (server.listening) return bridgePort(server);
  return new Promise<number>((resolvePort, reject) => {
    server.once("listening", () => resolvePort(bridgePort(server)));
    server.once("error", reject);
  });
}

function bridgePort(server: ReturnType<typeof createBasaltStudioBridgeServer>): number {
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Basalt bridge has no bound port");
  return address.port;
}

async function loadFamilyPlans(
  options: Map<string, string>,
  foundation: ReturnType<typeof compileBasaltWorldFoundation>,
): Promise<readonly WorldFamilyPopulationPlan[]> {
  const direct = options.get("--families");
  if (direct) {
    const value = await readJson(resolve(direct));
    if (!Array.isArray(value)) throw new Error("--families must contain an array of family plans");
    return value as WorldFamilyPopulationPlan[];
  }
  const registryPath = options.get("--family-registry");
  const requestsPath = options.get("--family-requests");
  if (!registryPath && !requestsPath) return [];
  if (!registryPath || !requestsPath)
    throw new Error("--family-registry and --family-requests must be supplied together");
  const registryValue = await readJson(resolve(registryPath));
  assertWorldAssetFamilyRegistry(registryValue);
  const requestsValue = await readJson(resolve(requestsPath));
  if (!Array.isArray(requestsValue)) throw new Error("--family-requests must contain an array");
  const requests = requestsValue as WorldBiomeFamilyRequest[];
  for (const request of requests) {
    const regionIds = request.regionIds ?? [request.biomeId];
    if (regionIds.some((id) => !foundation.regionIds.includes(id)))
      throw new Error(`Family request references an unknown region: ${request.biomeId}`);
  }
  return compileResolvedFamilyPopulationPlans({
    registry: registryValue as WorldAssetFamilyRegistry,
    requests,
  });
}

function parseOptions(values: string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    if (!key?.startsWith("--")) throw new Error(`Unexpected argument: ${key ?? ""}`);
    const value = values[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
    result.set(key, value);
    index += 1;
  }
  return result;
}

function numberOption(options: Map<string, string>, name: string, fallback: number): number {
  const value = options.get(name);
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number`);
  return parsed;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function enqueueExportDir(bridge: BasaltStudioBridge, exportDir: string): Promise<void> {
  const manifest = (await readJson(resolve(exportDir, "scene-manifest.json"))) as {
    payloads: Array<{ contentHash: string; mediaType: string }>;
  };
  if (!Array.isArray(manifest?.payloads))
    throw new Error(`Scene export manifest lists no payloads: ${exportDir}`);
  const payloads = new Map<string, Uint8Array>();
  for (const entry of manifest.payloads) {
    const extension = entry.mediaType === "model/gltf-binary" ? "glb" : "bvx";
    const path = resolve(exportDir, "payloads", `${entry.contentHash}.${extension}`);
    try {
      payloads.set(entry.contentHash, new Uint8Array(await readFile(path)));
    } catch {
      throw new Error(`Scene export is missing payload bytes: ${entry.contentHash}`);
    }
  }
  bridge.enqueueSceneExport(manifest, payloads);
}

async function writeCanonicalJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${stableJson(value)}\n`, "utf8");
}

async function writeSceneExport(input: {
  readonly exportDir: string;
  readonly foundation: BasaltWorldFoundation;
  readonly population: WorldPopulationArtifact;
  readonly roads: readonly RoadAssembly[];
  readonly inventoryPath: string;
  readonly sourceManifestPath: string;
}): Promise<number> {
  const inventory = (await readJson(input.inventoryPath)) as {
    families: AssetFamilyRevision[];
    assets: CatalogAssetEnvelope[];
  };
  const sourceManifest = (await readJson(input.sourceManifestPath)) as {
    packages: Array<{ files: Array<{ relativePath: string; metersPerSourceUnit: number }> }>;
  };
  const unitsByPath: Record<string, number> = {};
  for (const pack of sourceManifest.packages)
    for (const file of pack.files) unitsByPath[file.relativePath] = file.metersPerSourceUnit;
  const repositoryRoot = resolve(".");
  const { manifest, payloads } = emitSceneExport({
    world: {
      foundation: input.foundation,
      microPopulation: input.population,
      roadAssemblies: input.roads,
    },
    revisions: inventory.families,
    assets: inventory.assets,
    unitsByPath,
    readSourceBytes: (relativePath) => {
      const absolute = resolve(repositoryRoot, relativePath);
      if (absolute !== repositoryRoot && !absolute.startsWith(`${repositoryRoot}/`))
        throw new Error(`Source path escapes the repository: ${relativePath}`);
      if (!statSync(absolute, { throwIfNoEntry: false })?.isFile())
        throw new Error(`Source path is not a regular file: ${relativePath}`);
      return new Uint8Array(readFileSync(absolute));
    },
  });
  const payloadDir = resolve(input.exportDir, "payloads");
  await mkdir(payloadDir, { recursive: true });
  await writeCanonicalJson(resolve(input.exportDir, "scene-manifest.json"), manifest);
  for (const entry of manifest.payloads) {
    const bytes = payloads.get(entry.contentHash)!;
    const extension = entry.mediaType === "model/gltf-binary" ? "glb" : "bvx";
    await writeFile(resolve(payloadDir, `${entry.contentHash}.${extension}`), bytes);
  }
  return manifest.payloads.length;
}

function usage(): void {
  process.stdout.write(
    [
      "Basalt — Hierarchical World Compiler",
      "",
      "  basalt world summary <world-plan.json>",
      "  basalt world compile <world-plan.json> --output <world-build.json>",
      "    [--families <family-plans.json> | --family-registry <registry.json> --family-requests <requests.json>]",
      "    [--style-hash <sha256>] [--stage macro|meso|micro|partition] [--chunk-size <studs>]",
      "  basalt studio bridge --manifest <world-emission.json> --revision <sha256> [--export-dir <dir>] [--sidecar <sidecar.json>] [--material-map <material-map.json>] [--port <number>] [--discovery <path>]",
      "",
      "The compiler emits deterministic terrain, family-level populations, and connector-sized chunk deltas.",
      "Gameplay scripts and whole-world DCC review are outside Basalt.",
    ].join("\n") + "\n",
  );
}

await main();
