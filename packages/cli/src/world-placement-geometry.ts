import { readBoundedWorkspaceBytes } from "@basalt/artifact-store";
import { measureAssetPlacementGeometry } from "@basalt/asset-inspection";
import {
  resolveCatalogRequirements,
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
  if (hashes.size > 512)
    throw new Error(
      "Vegetation measurement palette exceeds 512 assets; use a bounded region palette",
    );
  const result: AssetPlacementGeometry[] = [];
  for (const hash of [...hashes].sort()) {
    const asset = input.assets.find((candidate) => candidate.hash === hash);
    const source =
      asset &&
      input.sourceManifest.assets.find(
        (candidate) => candidate.contentHash === asset.source.contentHash,
      );
    if (!asset || !source) throw new Error(`Missing placement geometry source for ${hash}`);
    const bytes = await readBoundedWorkspaceBytes(
      input.root,
      source.relativePath,
      32 * 1024 * 1024,
    );
    result.push(measureAssetPlacementGeometry(bytes, asset));
  }
  return result;
}
