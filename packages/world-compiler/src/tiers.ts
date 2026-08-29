import { contentHash, stableJson } from "../../contracts/src/index.js";
import type { WorldBiomeFamilyRequest } from "./family-resolver.js";
import {
  compileBasaltWorldFoundation,
  createBasaltWorldCompilerPlan,
  type BasaltWorldFoundation,
} from "./index.js";
import {
  compileResolvedFamilyPopulationPlans,
  type WorldAssetFamilyRegistry,
} from "./family-resolver.js";
import { createBasaltWorldEmission, type BasaltWorldEmissionManifest } from "./emission.js";
import { populateBasaltWorld, type BasaltPopulationOptions } from "./population.js";
import type {
  WorldCompilerPlan,
  WorldPopulationArtifact,
  WorldFamilyPopulationPlan,
} from "./contracts.js";

export const BASALT_HIERARCHICAL_WORLD_ABI = "basalt-hierarchical-world@1" as const;

export interface BasaltHierarchicalWorld {
  readonly kind: "BasaltHierarchicalWorld";
  readonly abi: typeof BASALT_HIERARCHICAL_WORLD_ABI;
  readonly foundation: BasaltWorldFoundation;
  readonly mesoPlan?: WorldCompilerPlan;
  readonly microPopulation?: WorldPopulationArtifact;
  readonly partitionEmission?: BasaltWorldEmissionManifest;
  readonly hash: string;
}

export interface CompileHierarchicalWorldInput {
  readonly worldPlan: unknown;
  readonly styleContractHash: string;
  readonly familyPlans?: readonly WorldFamilyPopulationPlan[];
  readonly familyRegistry?: WorldAssetFamilyRegistry;
  readonly familyRequests?: readonly WorldBiomeFamilyRequest[];
  readonly stage?: "macro" | "meso" | "micro" | "partition";
  readonly population?: BasaltPopulationOptions;
  readonly chunkSize?: number;
}

/**
 * Execute the macro/meso/micro/partition pipeline in one deterministic call.
 * Each later tier is optional, so an aerial foundation can be emitted while
 * asset workers are still offline. Family intent is the only input to meso;
 * individual meshes never cross this boundary.
 */
export function compileHierarchicalWorld(
  input: CompileHierarchicalWorldInput,
): BasaltHierarchicalWorld {
  const foundation = compileBasaltWorldFoundation(input.worldPlan);
  const stage = input.stage ?? "partition";
  const familyPlans = input.familyPlans
    ? [...input.familyPlans]
    : input.familyRegistry && input.familyRequests
      ? compileResolvedFamilyPopulationPlans({
          registry: input.familyRegistry,
          requests: input.familyRequests,
        })
      : [];
  const mesoPlan =
    stage === "macro" || familyPlans.length === 0
      ? undefined
      : createBasaltWorldCompilerPlan({
          foundation,
          styleContractHash: input.styleContractHash,
          stage,
          familyPlans,
        });
  const microPopulation =
    mesoPlan && stage !== "meso"
      ? populateBasaltWorld(foundation, mesoPlan, input.population)
      : undefined;
  const partitionEmission =
    microPopulation && stage === "partition"
      ? createBasaltWorldEmission(
          foundation,
          microPopulation,
          input.chunkSize ?? input.population?.chunkSize ?? 128,
        )
      : undefined;
  const material = {
    kind: "BasaltHierarchicalWorld" as const,
    abi: BASALT_HIERARCHICAL_WORLD_ABI,
    foundation: {
      worldPlanHash: foundation.worldPlanHash,
      surfaceIndexHash: foundation.surfaceIndexHash,
      regionIds: foundation.regionIds,
      terrainSurfaceIds: foundation.terrainSurfaceIds,
      constructedSurfaceIds: foundation.constructedSurfaceIds,
      routeIds: foundation.routeIds,
    },
    ...(mesoPlan ? { mesoPlanHash: mesoPlan.hash } : {}),
    ...(microPopulation ? { microPopulationHash: microPopulation.hash } : {}),
    ...(partitionEmission ? { partitionEmissionHash: partitionEmission.hash } : {}),
  };
  return {
    kind: "BasaltHierarchicalWorld",
    abi: BASALT_HIERARCHICAL_WORLD_ABI,
    foundation,
    ...(mesoPlan ? { mesoPlan } : {}),
    ...(microPopulation ? { microPopulation } : {}),
    ...(partitionEmission ? { partitionEmission } : {}),
    hash: contentHash(stableJson(material)),
  };
}
