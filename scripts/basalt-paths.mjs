import { resolve } from "node:path";

/** Canonical project-local state paths. Every script resolves these through here. */
export function catalogInventoryPath(repositoryRoot) {
  return resolve(repositoryRoot, ".basalt/catalog-cache/source-inventory.json");
}

export function sourceManifestPath(repositoryRoot) {
  return resolve(repositoryRoot, "registry/source-manifest.json");
}
