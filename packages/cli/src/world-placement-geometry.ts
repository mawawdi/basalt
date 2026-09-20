import {
  readBoundedWorkspaceBytes,
  readBoundedWorkspaceJson,
  writeCanonicalWorkspaceJson,
} from "@basalt/artifact-store";
import { measureAssetPlacementGeometry } from "@basalt/asset-inspection";
import {
  resolveCatalogRequirements,
  ASSET_PLACEMENT_GEOMETRY_SCHEMA,
  type AssetPlacementGeometry,
  type CatalogAssetArtifact,
  type CatalogSnapshot,
  type TrustedSourceManifest,
} from "@basalt/catalog-model";
import type { SemanticModule } from "@basalt/semantic-kernel";
import { isVegetationIntent } from "@basalt/world-compiler";
import type { SpatialWorldPlan } from "@basalt/world-planning";

/** Prepare only the selected plant palette from local, hash-verified GLBs. No model or catalog mutation. */
export async function prepareWorldPlacementGeometry(input: {
  readonly root: string;
  readonly plan: SpatialWorldPlan;
  readonly semanticModule: SemanticModule;
  readonly snapshot: CatalogSnapshot;
  readonly assets: readonly CatalogAssetArtifact[];
  readonly sourceManifest: TrustedSourceManifest;
  readonly cacheMaximumBytes: number;
}): Promise<AssetPlacementGeometry[]> {
  const vegetation = input.plan.realizationIntents.filter(isVegetationIntent);
  if (vegetation.length === 0) return [];
  const referenced = new Set(vegetation.flatMap((intent) => intent.vegetation.canopyIntentIds));
  const requirements = new Set(
    input.plan.realizationIntents
      .filter((intent) => isVegetationIntent(intent) || referenced.has(intent.intentId))
      .map((intent) => intent.requirementId),
  );
  const resolution = resolveCatalogRequirements({
    semanticModule: input.semanticModule,
    snapshot: input.snapshot,
    requirements: input.plan.catalogRequirements.filter((requirement) =>
      requirements.has(requirement.requirementId),
    ),
  });
  const hashes = new Set<string>();
  for (const binding of resolution.bindings) {
    const entry = input.snapshot.entries.find(
      (candidate) => candidate.handle === binding.entryHandle,
    );
    if (entry && entry.kind !== "collection")
      for (const member of entry.memberAssets) hashes.add(member.assetHash);
  }
  const result: AssetPlacementGeometry[] = [];
  for (const hash of [...hashes].sort()) {
    const asset = input.assets.find((candidate) => candidate.hash === hash);
    const source =
      asset &&
      input.sourceManifest.assets.find(
        (candidate) => candidate.contentHash === asset.source.contentHash,
      );
    if (!asset || !source) throw new Error(`Missing placement geometry source for ${hash}`);
    const cachePath = `.basalt/cache/placement-geometry/${asset.hash}.json`;
    try {
      const cached = ASSET_PLACEMENT_GEOMETRY_SCHEMA.parse(
        await readBoundedWorkspaceJson(input.root, cachePath, input.cacheMaximumBytes),
      );
      if (
        cached.assetHash !== asset.hash ||
        cached.sourceContentHash !== asset.source.contentHash ||
        cached.geometryHash !== asset.geometryHash
      )
        throw new Error(`Stale placement geometry cache binding for ${asset.hash}`);
      result.push(cached);
      continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const sourceArtifact = asset.source.sourceArtifact;
    if (!sourceArtifact)
      throw new Error(`Asset ${asset.hash} lacks a measured source byte declaration`);
    let bytes: Uint8Array;
    try {
      bytes = await readBoundedWorkspaceBytes(
        input.root,
        source.relativePath,
        sourceArtifact.bytes,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new Error(
          `Placement geometry source is absent for asset ${asset.hash}: ${source.relativePath}`,
        );
      throw error;
    }
    if (bytes.byteLength !== sourceArtifact.bytes)
      throw new Error(`Asset ${asset.hash} source size no longer matches measured evidence`);
    const measured = measureAssetPlacementGeometry(bytes, asset);
    await writeCanonicalWorkspaceJson(input.root, cachePath, measured, {
      maxBytes: input.cacheMaximumBytes,
    });
    result.push(measured);
  }
  return result;
}
