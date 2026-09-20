import { z } from "zod";
import { HORIZONTAL_MASK_SCHEMA } from "@basalt/spatial-core";
import {
  HASH_SCHEMA,
  compareCanonicalStrings,
  contentHash,
  deepFreezeJson,
  stableJson,
} from "@basalt/contracts";
import { WORLD_ENTITY_ID_SCHEMA, WORLD_POINT2_SCHEMA, type SpatialWorldPlan } from "./contracts.js";

const layer = z.enum(["canopy", "understory", "ground_cover"]);
const sourceText = z.string().trim().min(1);
const objectiveBase = {
  objectiveId: WORLD_ENTITY_ID_SCHEMA,
  sourceText,
};

export const REGION_EDIT_SPATIAL_TARGET_SCHEMA = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("whole_areas"),
      areaIds: z.array(WORLD_ENTITY_ID_SCHEMA).min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("directional_areas"),
      areaIds: z.array(WORLD_ENTITY_ID_SCHEMA).min(1),
      direction: z.enum([
        "north",
        "northeast",
        "east",
        "southeast",
        "south",
        "southwest",
        "west",
        "northwest",
      ]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("around_intents"),
      areaIds: z.array(WORLD_ENTITY_ID_SCHEMA).min(1),
      intentIds: z.array(WORLD_ENTITY_ID_SCHEMA).min(1),
    })
    .strict(),
]);
export type RegionEditSpatialTarget = z.output<typeof REGION_EDIT_SPATIAL_TARGET_SCHEMA>;

export const REGION_EDIT_OBJECTIVE_SCHEMA = z.discriminatedUnion("kind", [
  z
    .object({
      ...objectiveBase,
      kind: z.literal("vegetation_density"),
      direction: z.enum(["increase", "decrease"]),
      spatialTarget: REGION_EDIT_SPATIAL_TARGET_SCHEMA,
      layers: z.array(layer).min(1),
    })
    .strict(),
  z
    .object({
      ...objectiveBase,
      kind: z.literal("vegetation_clearing"),
      change: z.enum(["create", "expand"]),
      transitionRequirement: z.enum(["soft", "hard", "unspecified"]),
      spatialTarget: REGION_EDIT_SPATIAL_TARGET_SCHEMA,
      layers: z.array(layer).min(1),
    })
    .strict(),
  z
    .object({
      ...objectiveBase,
      kind: z.literal("terrain_material"),
      terrainPlanId: WORLD_ENTITY_ID_SCHEMA,
      operationIndex: z.number().int().nonnegative().safe(),
      requestedMaterialId: WORLD_ENTITY_ID_SCHEMA,
    })
    .strict(),
]);
export type RegionEditObjective = z.output<typeof REGION_EDIT_OBJECTIVE_SCHEMA>;

const preservation = z
  .object({
    exactIntentIds: z.array(WORLD_ENTITY_ID_SCHEMA),
    exactRouteIds: z.array(WORLD_ENTITY_ID_SCHEMA),
    preservePopulationOutsideRegenerationMasks: z.literal(true),
  })
  .strict();

export const REGION_EDIT_REQUEST_DRAFT_SCHEMA = z
  .object({
    objectives: z.array(REGION_EDIT_OBJECTIVE_SCHEMA).min(1),
    preservation,
    unresolvedRequirements: z.array(z.string().trim().min(1)),
  })
  .strict();
export type RegionEditRequestDraft = z.output<typeof REGION_EDIT_REQUEST_DRAFT_SCHEMA>;

export const REGION_EDIT_REQUEST_SCHEMA = z
  .object({
    kind: z.literal("RegionEditRequest"),
    prompt: z.string().trim().min(1),
    basePlanHash: HASH_SCHEMA,
    baseWorldBuildHash: HASH_SCHEMA,
    objectives: z.array(REGION_EDIT_OBJECTIVE_SCHEMA).min(1),
    preservation,
    unresolvedRequirements: z.array(z.string().trim().min(1)),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    const { hash: _hash, ...material } = value;
    if (value.hash !== contentHash(stableJson(material)))
      context.addIssue({ code: "custom", path: ["hash"], message: "Edit request hash mismatch" });
    const objectiveIds = value.objectives.map((entry) => entry.objectiveId);
    if (new Set(objectiveIds).size !== objectiveIds.length)
      context.addIssue({
        code: "custom",
        path: ["objectives"],
        message: "Edit objective IDs must be unique",
      });
    for (const [index, objective] of value.objectives.entries()) {
      if (!value.prompt.includes(objective.sourceText))
        context.addIssue({
          code: "custom",
          path: ["objectives", index, "sourceText"],
          message: "Objective source text must be an exact span of the creator prompt",
        });
      if (objective.kind !== "terrain_material") {
        requireUnique(
          objective.spatialTarget.areaIds,
          ["objectives", index, "spatialTarget", "areaIds"],
          context,
        );
        if (objective.spatialTarget.kind === "around_intents")
          requireUnique(
            objective.spatialTarget.intentIds,
            ["objectives", index, "spatialTarget", "intentIds"],
            context,
          );
        requireUnique(objective.layers, ["objectives", index, "layers"], context);
      }
    }
    requireUnique(value.preservation.exactIntentIds, ["preservation", "exactIntentIds"], context);
    requireUnique(value.preservation.exactRouteIds, ["preservation", "exactRouteIds"], context);
  });
export type RegionEditRequest = z.output<typeof REGION_EDIT_REQUEST_SCHEMA>;

export function sealRegionEditRequest(input: {
  readonly prompt: string;
  readonly basePlanHash: string;
  readonly baseWorldBuildHash: string;
  readonly draft: RegionEditRequestDraft;
}): RegionEditRequest {
  const draft = REGION_EDIT_REQUEST_DRAFT_SCHEMA.parse(input.draft);
  const material = {
    kind: "RegionEditRequest" as const,
    prompt: input.prompt,
    basePlanHash: input.basePlanHash,
    baseWorldBuildHash: input.baseWorldBuildHash,
    objectives: [...draft.objectives].sort((left, right) =>
      compareCanonicalStrings(left.objectiveId, right.objectiveId),
    ),
    preservation: {
      exactIntentIds: [...draft.preservation.exactIntentIds].sort(compareCanonicalStrings),
      exactRouteIds: [...draft.preservation.exactRouteIds].sort(compareCanonicalStrings),
      preservePopulationOutsideRegenerationMasks: true as const,
    },
    unresolvedRequirements: [...new Set(draft.unresolvedRequirements)].sort(
      compareCanonicalStrings,
    ),
  };
  return deepFreezeJson(
    REGION_EDIT_REQUEST_SCHEMA.parse({ ...material, hash: contentHash(stableJson(material)) }),
  );
}

const proposalObjectiveIds = z.array(WORLD_ENTITY_ID_SCHEMA).min(1);
export const REGION_EDIT_DENSITY_OPERATION_SCHEMA = z
  .object({
    kind: z.literal("vegetation_density"),
    objectiveIds: proposalObjectiveIds,
    areaId: WORLD_ENTITY_ID_SCHEMA,
    layers: z.array(layer).min(1),
    populationDensityMultiplier: z.number().finite().nonnegative(),
  })
  .strict();
export const REGION_EDIT_CLEARING_OPERATION_SCHEMA = z
  .object({
    kind: z.literal("vegetation_clearing"),
    objectiveIds: proposalObjectiveIds,
    areaId: WORLD_ENTITY_ID_SCHEMA,
    layers: z.array(layer).min(1),
    mask: HORIZONTAL_MASK_SCHEMA,
    verticalRangeMeters: z
      .object({ minimum: z.number().finite(), maximum: z.number().finite() })
      .strict()
      .refine((value) => value.minimum < value.maximum, "Clearing vertical range is inverted"),
    falloffMeters: z.number().finite().nonnegative(),
  })
  .strict();
export const REGION_EDIT_TERRAIN_OPERATION_SCHEMA = z
  .object({
    kind: z.literal("terrain_material"),
    objectiveIds: proposalObjectiveIds,
    terrainPlanId: WORLD_ENTITY_ID_SCHEMA,
    operationIndex: z.number().int().nonnegative().safe(),
    materialId: WORLD_ENTITY_ID_SCHEMA,
    polygon: z.array(WORLD_POINT2_SCHEMA).min(3),
  })
  .strict();
export const REGION_EDIT_OPERATION_SCHEMA = z.discriminatedUnion("kind", [
  REGION_EDIT_DENSITY_OPERATION_SCHEMA,
  REGION_EDIT_CLEARING_OPERATION_SCHEMA,
  REGION_EDIT_TERRAIN_OPERATION_SCHEMA,
]);
export type RegionEditOperation = z.output<typeof REGION_EDIT_OPERATION_SCHEMA>;

export const REGION_EDIT_PROPOSAL_DRAFT_SCHEMA = z
  .object({
    operations: z.array(REGION_EDIT_OPERATION_SCHEMA).min(1),
    rationale: z.string().trim().min(1),
  })
  .strict();
export type RegionEditProposalDraft = z.output<typeof REGION_EDIT_PROPOSAL_DRAFT_SCHEMA>;

export const REGION_EDIT_PROPOSAL_SCHEMA = z
  .object({
    kind: z.literal("RegionEditProposal"),
    requestHash: HASH_SCHEMA,
    basePlanHash: HASH_SCHEMA,
    baseWorldBuildHash: HASH_SCHEMA,
    operations: z.array(REGION_EDIT_OPERATION_SCHEMA).min(1),
    rationale: z.string().trim().min(1),
    providerId: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u),
    providerImplementationHash: HASH_SCHEMA,
    compilerAuthority: z.literal(false),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    const { hash: _hash, ...material } = value;
    if (value.hash !== contentHash(stableJson(material)))
      context.addIssue({ code: "custom", path: ["hash"], message: "Edit proposal hash mismatch" });
    const identities = value.operations.map(operationIdentity);
    if (new Set(identities).size !== identities.length)
      context.addIssue({
        code: "custom",
        path: ["operations"],
        message: "Edit operations must be unique",
      });
  });
export type RegionEditProposal = z.output<typeof REGION_EDIT_PROPOSAL_SCHEMA>;

export function sealRegionEditProposal(input: {
  readonly request: RegionEditRequest;
  readonly draft: RegionEditProposalDraft;
  readonly providerId: string;
  readonly providerImplementationHash: string;
}): RegionEditProposal {
  const request = REGION_EDIT_REQUEST_SCHEMA.parse(input.request);
  const draft = REGION_EDIT_PROPOSAL_DRAFT_SCHEMA.parse(input.draft);
  validateProposalCoverage(request, draft.operations);
  const operations = [...draft.operations]
    .map((operation) => ({
      ...operation,
      objectiveIds: [...new Set(operation.objectiveIds)].sort(compareCanonicalStrings),
      ...(operation.kind === "vegetation_density" || operation.kind === "vegetation_clearing"
        ? { layers: [...new Set(operation.layers)].sort(compareCanonicalStrings) }
        : {}),
    }))
    .sort((left, right) =>
      compareCanonicalStrings(operationIdentity(left), operationIdentity(right)),
    );
  const material = {
    kind: "RegionEditProposal" as const,
    requestHash: request.hash,
    basePlanHash: request.basePlanHash,
    baseWorldBuildHash: request.baseWorldBuildHash,
    operations,
    rationale: draft.rationale,
    providerId: input.providerId,
    providerImplementationHash: input.providerImplementationHash,
    compilerAuthority: false as const,
  };
  return deepFreezeJson(
    REGION_EDIT_PROPOSAL_SCHEMA.parse({ ...material, hash: contentHash(stableJson(material)) }),
  );
}

export function validateRegionEditTargets(
  request: RegionEditRequest,
  plan: SpatialWorldPlan,
): void {
  const vegetation = plan.realizationIntents.flatMap((intent) =>
    intent.kind === "surface_scatter" && intent.vegetation ? [intent] : [],
  );
  const areaLayers = new Set(
    vegetation.map((intent) => `${intent.vegetation!.areaId}:${intent.vegetation!.layer}`),
  );
  const areaIds = new Set(vegetation.map((intent) => intent.vegetation!.areaId));
  for (const objective of request.objectives) {
    if (objective.kind === "terrain_material") {
      const operation = plan.terrainPlans
        .find((entry) => entry.terrainPlanId === objective.terrainPlanId)
        ?.operations.at(objective.operationIndex);
      if (operation?.kind !== "paint")
        throw new Error(
          `Edit objective ${objective.objectiveId} references unavailable terrain paint`,
        );
      continue;
    }
    for (const areaId of objective.spatialTarget.areaIds) {
      if (!areaIds.has(areaId))
        throw new Error(
          `Edit objective ${objective.objectiveId} references unavailable area ${areaId}`,
        );
      for (const targetLayer of objective.layers)
        if (
          !areaLayers.has(`${areaId}:${targetLayer}`) &&
          objective.kind === "vegetation_density" &&
          objective.direction === "increase"
        )
          throw new Error(
            `Edit objective ${objective.objectiveId} references unavailable ${areaId}/${targetLayer}`,
          );
    }
    if (objective.spatialTarget.kind === "around_intents")
      for (const intentId of objective.spatialTarget.intentIds)
        if (!plan.realizationIntents.some((intent) => intent.intentId === intentId))
          throw new Error(
            `Edit objective ${objective.objectiveId} references unavailable anchor ${intentId}`,
          );
  }
  for (const intentId of request.preservation.exactIntentIds)
    if (!plan.realizationIntents.some((intent) => intent.intentId === intentId))
      throw new Error(`Edit preservation references unavailable intent ${intentId}`);
  for (const routeId of request.preservation.exactRouteIds)
    if (!plan.routes.some((route) => route.routeId === routeId))
      throw new Error(`Edit preservation references unavailable route ${routeId}`);
}

function validateProposalCoverage(
  request: RegionEditRequest,
  operations: readonly RegionEditOperation[],
): void {
  const objectives = new Map(request.objectives.map((entry) => [entry.objectiveId, entry]));
  for (const operation of operations)
    for (const objectiveId of operation.objectiveIds)
      if (!objectives.has(objectiveId))
        throw new Error(`Proposal references unknown objective ${objectiveId}`);
  for (const objective of request.objectives) {
    const linked = operations.filter((operation) =>
      operation.objectiveIds.includes(objective.objectiveId),
    );
    if (objective.kind === "terrain_material") {
      if (
        !linked.some(
          (operation) =>
            operation.kind === "terrain_material" &&
            operation.terrainPlanId === objective.terrainPlanId &&
            operation.operationIndex === objective.operationIndex &&
            operation.materialId === objective.requestedMaterialId,
        )
      )
        throw new Error(`Proposal does not implement terrain objective ${objective.objectiveId}`);
      continue;
    }
    for (const areaId of objective.spatialTarget.areaIds)
      for (const targetLayer of objective.layers) {
        const operation = linked.find(
          (candidate) =>
            candidate.kind === objective.kind &&
            candidate.areaId === areaId &&
            candidate.layers.includes(targetLayer),
        );
        if (!operation)
          throw new Error(
            `Proposal omits ${objective.objectiveId} target ${areaId}/${targetLayer}`,
          );
        if (objective.kind === "vegetation_density" && operation.kind === "vegetation_density") {
          const changesInDirection =
            objective.direction === "increase"
              ? operation.populationDensityMultiplier > 1
              : operation.populationDensityMultiplier < 1;
          if (!changesInDirection)
            throw new Error(
              `Proposal does not move ${objective.objectiveId} in the requested direction`,
            );
        }
        if (objective.kind === "vegetation_clearing" && operation.kind === "vegetation_clearing") {
          if (objective.transitionRequirement === "soft" && operation.falloffMeters <= 0)
            throw new Error(
              `Proposal does not provide a soft transition for ${objective.objectiveId}`,
            );
          if (objective.transitionRequirement === "hard" && operation.falloffMeters !== 0)
            throw new Error(
              `Proposal does not provide a hard transition for ${objective.objectiveId}`,
            );
        }
      }
  }
}

function operationIdentity(operation: RegionEditOperation): string {
  if (operation.kind === "terrain_material")
    return `${operation.kind}:${operation.terrainPlanId}:${operation.operationIndex}`;
  return `${operation.kind}:${operation.areaId}:${[...operation.layers].sort().join(",")}:${
    operation.kind === "vegetation_clearing"
      ? stableJson({ mask: operation.mask, verticalRangeMeters: operation.verticalRangeMeters })
      : "density"
  }`;
}

function requireUnique(
  values: readonly string[],
  path: PropertyKey[],
  context: z.core.$RefinementCtx<unknown>,
): void {
  if (new Set(values).size !== values.length)
    context.addIssue({ code: "custom", path, message: "Values must be unique", input: values });
}
