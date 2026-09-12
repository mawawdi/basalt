#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const trustedRoot = resolve(repositoryRoot, "registry");
const manifestPath = resolve(trustedRoot, "source-manifest.json");

// Reference artifacts live alongside sources but are calibration anchors, never
// catalog members. ScaleCharacter.glb defines the avatar-scale truth (a 1.88 m
// human); it must not enter the inventory or the untriaged gate.
const REFERENCE_EXCLUSIONS = new Set(["ScaleCharacter.glb"]);

// Authored unit conventions per source file, in meters per raw vertex unit.
// The FBX oracle (binary vertex extents vs. real-world scale, corroborated by a
// Blender metric import) proves the corpus mixes meters, decimeters, and
// centimeters while every FBX falsely declares UnitScaleFactor 1.0. Default is
// 1.0 (meters); only measured exceptions are listed. Keys are basenames: the
// writer rejects duplicate basenames so an override can never silently cover
// two different files.
const SOURCE_UNIT_OVERRIDES = new Map([
  ["SM_Veh_Car_Ambo_01.glb", 0.1],
  ["SM_Veh_Car_Medium_01.glb", 0.1],
  ["SM_Veh_Car_Muscle_01.glb", 0.1],
  ["SM_Veh_Car_Police_01.glb", 0.1],
  ["SM_Veh_Car_Sedan_01.glb", 0.1],
  ["SM_Veh_Car_Small_01.glb", 0.1],
  ["SM_Veh_Car_Taxi_01.glb", 0.1],
  ["SM_Veh_Car_Van_01.glb", 0.1],
  ["SM_Veh_Steering_Wheel_01.glb", 0.1],
  ["SM_Env_Grass_02.glb", 0.1],
  ["SM_Env_Grass_03.glb", 0.1],
  ["SM_Env_Grass_01--1129fc75735d.glb", 0.1],
  ["SM_Env_Cloud_01.glb", 0.1],
  ["SM_Env_Cloud_02.glb", 0.1],
  ["SM_Env_Cloud_03.glb", 0.1],
  ["SM_Env_Cloud_01--e3fc40ac3486.glb", 0.1],
  ["SM_Env_Cloud_02--2b1b99db05db.glb", 0.1],
  ["SM_Env_Cloud_03--1b836b343569.glb", 0.1],
  ["SM_Env_Skyline_01.glb", 0.1],
  ["SM_Shark.glb", 0.01],
  ["SM_Fish.glb", 0.01],
  ["SM_Prop_Police_Baton_01.glb", 0.01],
  ["SM_Env_Flower_01.glb", 0.01],
  ["SM_Item_Bag_Attachment_03.glb", 0.01],
  ["SM_Env_Ocean_Tile_01.glb", 0.01],
  ["SM_Env_Ocean_Tile_01--6d1facfb06f6.glb", 0.01],
  ["SM_Bld_Apartment_Stairs_01_Collision.glb", 0.01],
  ["SM_Bld_Apartment_Stairs_02_Collision.glb", 0.01],
  ["SM_Bld_Apartment_Stairs_Corner_01_Collision.glb", 0.01],
  ["SM_Bld_Cuba_Sunshade_01_Collision.glb", 0.01],
  ["SM_Bld_Cuba_Sunshade_02_Collision.glb", 0.01],
  ["SM_Bld_Dock_01_Collision.glb", 0.01],
  ["SM_Bld_Dock_02_Collision.glb", 0.01],
  ["SM_Bld_Dock_03_Collision.glb", 0.01],
  ["SM_Bld_Rickety_Dock_01_Collision.glb", 0.01],
  ["SM_Bld_Rickety_Dock_02_Collision.glb", 0.01],
  ["SM_Bld_Rickety_Dock_03_Collision.glb", 0.01],
  ["SM_Bld_Rickety_Dock_Platform_01_Collision.glb", 0.01],
  ["SM_Bld_Rickety_Dock_Platform_02_Collision.glb", 0.01],
  ["SM_Bld_Rickety_Dock_Stairs_Curved_01_Collision.glb", 0.01],
  ["SM_Bld_Rickety_House_02_Collision.glb", 0.01],
  ["SM_Bld_Rickety_House_03_Collision.glb", 0.01],
  ["SM_Bld_Rickety_Tower_03_Collision.glb", 0.01],
  ["SM_Bld_Shanty_Preset_01_Collision.glb", 0.01],
  ["SM_Bld_Shanty_Preset_02_Collision.glb", 0.01],
  ["SM_Bld_Shanty_Preset_03_Collision.glb", 0.01],
  ["SM_Bld_Shanty_Preset_04_Collision.glb", 0.01],
  ["SM_Bld_Shanty_Preset_05_Collision.glb", 0.01],
  ["SM_Bld_Shanty_Preset_06_Collision.glb", 0.01],
  ["SM_Bld_Shanty_Preset_07_Collision.glb", 0.01],
  ["SM_Bld_Shop_01_Collision.glb", 0.01],
  ["SM_Bld_Shop_02_Collision.glb", 0.01],
  ["SM_Bld_Shop_03_Collision.glb", 0.01],
  ["SM_Env_PalmTree_01_Collision.glb", 0.01],
  ["SM_Env_PalmTree_02_Collision.glb", 0.01],
  ["SM_Env_PalmTree_03_Collision.glb", 0.01],
  ["SM_Env_PalmTree_04_Collision.glb", 0.01],
  ["SM_Env_PalmTree_Tall_01_Collision.glb", 0.01],
  ["SM_Env_PalmTree_Tall_02_Collision.glb", 0.01],
  ["SM_Env_Sidewalk_Construction_01_Collision.glb", 0.01],
  ["SM_Env_Tree_Large_01_Collision.glb", 0.01],
  ["SM_Env_Tree_Large_02_Collision.glb", 0.01],
  ["SM_Veh_Boat_Medium_01_Hull_Collision.glb", 0.01],
  ["SM_Veh_Boat_Small_01_Hull_Pirate_Collision.glb", 0.01],
  ["SM_Veh_Boat_Warship_01_Hull_Pirate_Collision.glb", 0.01],
  ["SM_Veh_Boat_Warship_01_Hull_Pirate_Upsized_Collision.glb", 0.01],
  ["SM_Veh_Veh_Boat_Large_01_Hull_Collision.glb", 0.01],
]);

function argument(name, args, required = true) {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (required && (!value || value.startsWith("--"))) throw new Error(`Missing ${name}`);
  return value;
}

async function filesUnder(root) {
  const output = [];
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const info = await lstat(path);
        if (info.isSymbolicLink() || (await realpath(path)) !== path)
          throw new Error(`Symlinked source file rejected: ${path}`);
        output.push(path);
      }
    }
  };
  await visit(root);
  return output.sort((left, right) => left.localeCompare(right));
}

async function main() {
  const args = process.argv.slice(2);
  const packageId = argument("--package-id", args);
  const rootArgument = argument("--root", args);
  const sourceKind = argument("--source-kind", args, false) ?? "commercial_pack";
  const licenseId = argument("--license-id", args, false) ?? "commercial-use-permitted";
  const attribution =
    argument("--attribution", args, false) ??
    "Creator-provided commercial rights; no vendor attribution requested";
  const archivePaths = args.flatMap((value, index) =>
    value === "--archive" && args[index + 1] ? [args[index + 1]] : [],
  );
  const root = resolve(repositoryRoot, rootArgument);
  const trustedPrefix = `${trustedRoot}${sep}`;
  if (!root.startsWith(trustedPrefix)) throw new Error("--root must be inside registry");
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(root)) !== root)
    throw new Error("Source root must be a canonical directory");
  const files = await filesUnder(root);
  const seenBasenames = new Set();
  const records = [];
  for (const path of files) {
    const name = basename(path);
    if (REFERENCE_EXCLUSIONS.has(name)) continue;
    if (seenBasenames.has(name))
      throw new Error(`Duplicate source basename breaks unit overrides: ${name}`);
    seenBasenames.add(name);
    const bytes = await readFile(path);
    records.push({
      relativePath: relative(repositoryRoot, path).split(sep).join("/"),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      metersPerSourceUnit: SOURCE_UNIT_OVERRIDES.get(name) ?? 1.0,
    });
  }
  let manifest = {
    kind: "TrustedSourceManifest",
    abi: "basalt-trusted-sources@2",
    rightsNotice: "registry/rights-note.md",
    packages: [],
  };
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const packageEntry = {
    packageId,
    archivePaths,
    assetRoots: [relative(repositoryRoot, root).split(sep).join("/")],
    sourceKind,
    licenseId,
    commercialUsePermitted: true,
    redistributionPermitted: true,
    attribution,
    files: records,
  };
  const packages = manifest.packages.filter((entry) => entry.packageId !== packageId);
  packages.push(packageEntry);
  manifest = {
    ...manifest,
    packages: packages.sort((left, right) => left.packageId.localeCompare(right.packageId)),
  };
  await mkdir(trustedRoot, { recursive: true, mode: 0o700 });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  process.stdout.write(
    `${JSON.stringify({ manifest: manifestPath, packageId, files: records.length }, null, 2)}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(
    `Source registration failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
