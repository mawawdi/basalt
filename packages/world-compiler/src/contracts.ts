import { z } from "zod";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import { compareWorldStrings, worldEntityId, worldHash } from "./primitives.js";

export const BASALT_WORLD_COMPILER_ABI = "basalt-world-compiler@1" as const;

/** Default per-instance scale variation when a plan carries no range. */
export const DEFAULT_INSTANCE_SCALE_RANGE: readonly [number, number] = [0.92, 1.08];
/** Density envelopes normalize to instances per this many square studs. */
export const DENSITY_AREA_NORMALIZATION_STUDS2 = 256;
/** Steepest slope any placement may accept, in degrees. */
export const MAXIMUM_SLOPE_DEGREES = 89;

const finite = z.number().finite();
const positive = finite.positive();
const vector3 = z.object({ x: finite, y: finite, z: finite }).strict();
const quaternion = z
  .tuple([finite, finite, finite, finite])
  .refine((value) => Math.abs(Math.hypot(...value) - 1) <= 1e-5, "Rotation must be normalized");

export const WORLD_COMPILER_STAGE_SCHEMA = z.enum(["macro", "meso", "micro", "partition"]);
export type WorldCompilerStage = z.infer<typeof WORLD_COMPILER_STAGE_SCHEMA>;

export const WORLD_FAMILY_POPULATION_PLAN_SCHEMA = z
  .object({
    familyId: worldEntityId,
    regionIds: z.array(worldEntityId).min(1).max(256),
    surfaceKinds: z
      .array(z.enum(["terrain", "floor", "ramp", "roof", "platform", "wall", "ceiling"]))
      .min(1)
      .max(7),
    distribution: z.enum([
      "poisson_scatter",
      "cluster",
      "along_path",
      "surface_grid",
      "socket",
      "wall_anchored",
    ]),
    minimumCount: z.number().int().nonnegative().safe(),
    maximumCount: z.number().int().positive().safe(),
    /** Number of coordinated archetypes available in the resolved family. */
    archetypeCount: z.number().int().positive().max(4096).default(1),
    /** Physical variation is bounded here; final bounds are checked at admission. */
    scaleRange: z
      .tuple([z.number().finite().positive(), z.number().finite().positive()])
      .default([...DEFAULT_INSTANCE_SCALE_RANGE])
      .refine(([minimum, maximum]) => minimum <= maximum, "Scale range is inverted"),
    density: z
      .object({
        minimum: z.number().finite().min(0),
        target: z.number().finite().min(0),
        maximum: z.number().finite().min(0),
      })
      .strict()
      .refine((value) => value.minimum <= value.target && value.target <= value.maximum, {
        message: "Family density range must be ordered",
      }),
    variationSeed: z.number().int().min(0).max(0xffff_ffff),
    excludedRouteIds: z.array(worldEntityId).max(256),
    excludedRegionIds: z.array(worldEntityId).max(256),
    elevationBandStuds: z
      .object({
        minimum: finite.min(-1_000_000).max(1_000_000).optional(),
        maximum: finite.min(-1_000_000).max(1_000_000).optional(),
      })
      .strict()
      .optional(),
    maximumSlopeDegrees: finite.min(0).max(MAXIMUM_SLOPE_DEGREES).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.minimumCount > value.maximumCount)
      context.addIssue({
        code: "custom",
        path: ["minimumCount"],
        message: "Family count range is inverted",
      });
    if (value.scaleRange[0] <= 0 || value.scaleRange[1] < value.scaleRange[0])
      context.addIssue({
        code: "custom",
        path: ["scaleRange"],
        message: "Family scale range must be positive and ordered",
      });
    const band = value.elevationBandStuds;
    if (band?.minimum !== undefined && band?.maximum !== undefined && band.minimum > band.maximum)
      context.addIssue({
        code: "custom",
        path: ["elevationBandStuds"],
        message: "Family elevation band is inverted",
      });
    for (const [field, values] of [
      ["regionIds", value.regionIds],
      ["surfaceKinds", value.surfaceKinds],
      ["excludedRouteIds", value.excludedRouteIds],
      ["excludedRegionIds", value.excludedRegionIds],
    ] as const)
      if (new Set(values).size !== values.length)
        context.addIssue({
          code: "custom",
          path: [field],
          message: "Family plan entries must be unique",
        });
  });
type ParsedWorldFamilyPopulationPlan = z.infer<typeof WORLD_FAMILY_POPULATION_PLAN_SCHEMA>;
export type WorldFamilyPopulationPlan = Omit<
  ParsedWorldFamilyPopulationPlan,
  "archetypeCount" | "scaleRange"
> & {
  readonly archetypeCount?: number;
  readonly scaleRange?: readonly [number, number];
};

export const WORLD_COMPILER_PLAN_SCHEMA = z
  .object({
    kind: z.literal("BasaltWorldCompilerPlan"),
    abi: z.literal(BASALT_WORLD_COMPILER_ABI),
    id: worldEntityId,
    hash: worldHash,
    worldPlanHash: worldHash,
    styleContractHash: worldHash,
    stage: WORLD_COMPILER_STAGE_SCHEMA,
    familyPlans: z.array(WORLD_FAMILY_POPULATION_PLAN_SCHEMA).max(4096),
  })
  .strict();
export type WorldCompilerPlan = z.infer<typeof WORLD_COMPILER_PLAN_SCHEMA>;

export const WORLD_POPULATION_INSTANCE_SCHEMA = z
  .object({
    id: worldEntityId,
    familyId: worldEntityId,
    archetypeId: worldEntityId,
    chunkId: worldEntityId,
    position: vector3,
    rotation: quaternion,
    scale: positive,
    footprint: z
      .object({
        contactRadiusStuds: z.number().finite().positive(),
        restYStuds: z.number().finite(),
        dropsStuds: z.tuple([
          z.number().finite().max(0),
          z.number().finite().max(0),
          z.number().finite().max(0),
          z.number().finite().max(0),
        ]),
      })
      .strict(),
  })
  .strict();
export type WorldPopulationInstance = z.infer<typeof WORLD_POPULATION_INSTANCE_SCHEMA>;

export const WORLD_POPULATION_ARTIFACT_SCHEMA = z
  .object({
    kind: z.literal("BasaltWorldPopulationArtifact"),
    abi: z.literal(BASALT_WORLD_COMPILER_ABI),
    id: worldEntityId,
    hash: worldHash,
    worldPlanHash: worldHash,
    populationPlanHash: worldHash,
    chunks: z
      .array(
        z
          .object({
            chunkId: worldEntityId,
            familyIds: z.array(worldEntityId).min(1).max(4096),
            instances: z.array(WORLD_POPULATION_INSTANCE_SCHEMA).max(65_536),
          })
          .strict(),
      )
      .max(4096),
    instanceCount: z.number().int().nonnegative().safe(),
  })
  .strict();
export type WorldPopulationArtifact = z.infer<typeof WORLD_POPULATION_ARTIFACT_SCHEMA>;

export function sealWorldCompilerPlan(
  input: Omit<WorldCompilerPlan, "kind" | "abi" | "id" | "hash" | "familyPlans"> & {
    familyPlans: readonly WorldFamilyPopulationPlan[];
  },
): WorldCompilerPlan {
  const familyPlans = input.familyPlans
    .map((plan) => canonicalFamilyPlan(plan))
    .sort((left, right) => compareWorldStrings(left.familyId, right.familyId));
  if (new Set(familyPlans.map((plan) => plan.familyId)).size !== familyPlans.length)
    throw new Error("Basalt family plans must be unique");
  const material = {
    kind: "BasaltWorldCompilerPlan" as const,
    abi: BASALT_WORLD_COMPILER_ABI,
    worldPlanHash: input.worldPlanHash,
    styleContractHash: input.styleContractHash,
    stage: input.stage,
    familyPlans,
  };
  return WORLD_COMPILER_PLAN_SCHEMA.parse({
    ...material,
    id: `basalt_world_plan_${input.worldPlanHash.slice(0, 24)}`,
    hash: contentHash(stableJson(material)),
  });
}

export function assertWorldCompilerPlanIdentity(
  value: unknown,
): asserts value is WorldCompilerPlan {
  const plan = WORLD_COMPILER_PLAN_SCHEMA.parse(value);
  const { hash, id: _id, ...material } = plan;
  if (plan.id !== `basalt_world_plan_${plan.worldPlanHash.slice(0, 24)}`)
    throw new Error("Basalt world compiler plan identity mismatch");
  if (plan.hash !== contentHash(stableJson(material)))
    throw new Error("Basalt world compiler plan hash mismatch");
}

export function sealWorldPopulationArtifact(input: {
  worldPlanHash: string;
  populationPlanHash: string;
  chunks: readonly WorldPopulationArtifact["chunks"][number][];
}): WorldPopulationArtifact {
  const chunks = input.chunks
    .map((chunk) => ({
      ...chunk,
      familyIds: [...new Set(chunk.familyIds)].sort(compareWorldStrings),
      instances: [...chunk.instances].sort((left, right) => compareWorldStrings(left.id, right.id)),
    }))
    .sort((left, right) => compareWorldStrings(left.chunkId, right.chunkId));
  const instanceCount = chunks.reduce((count, chunk) => count + chunk.instances.length, 0);
  if (
    chunks.some((chunk) =>
      chunk.instances.some((instance) => !chunk.familyIds.includes(instance.familyId)),
    )
  )
    throw new Error("Population chunk family index is incomplete");
  const material = {
    kind: "BasaltWorldPopulationArtifact" as const,
    abi: BASALT_WORLD_COMPILER_ABI,
    worldPlanHash: worldHash.parse(input.worldPlanHash),
    populationPlanHash: worldHash.parse(input.populationPlanHash),
    chunks,
    instanceCount,
  };
  return WORLD_POPULATION_ARTIFACT_SCHEMA.parse({
    ...material,
    id: `basalt_population_${contentHash(stableJson(material)).slice(0, 24)}`,
    hash: contentHash(stableJson(material)),
  });
}

function canonicalFamilyPlan(input: WorldFamilyPopulationPlan): WorldFamilyPopulationPlan {
  const plan = WORLD_FAMILY_POPULATION_PLAN_SCHEMA.parse(input);
  return {
    ...plan,
    regionIds: [...new Set(plan.regionIds)].sort(compareWorldStrings),
    surfaceKinds: [...new Set(plan.surfaceKinds)].sort(compareWorldStrings),
    excludedRouteIds: [...new Set(plan.excludedRouteIds)].sort(compareWorldStrings),
    excludedRegionIds: [...new Set(plan.excludedRegionIds)].sort(compareWorldStrings),
  };
}
