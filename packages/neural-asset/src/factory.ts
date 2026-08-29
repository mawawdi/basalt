import { z } from "zod";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import { entityId, hashSchema } from "../../spatial-core/src/primitives.js";
import { NEURAL_PROVIDER_IDS, type NeuralProviderId } from "./execution.js";
import { MAX_NEURAL_ASSET_BOUND_STUDS } from "../../asset-factory/src/contracts.js";

/** Offline-only family-factory queue. It has no world placement or render step. */
export const NEURAL_FAMILY_FACTORY_BATCH_ABI = "basalt-neural-family-factory-batch@1" as const;
export const NEURAL_FAMILY_FACTORY_JOB_ABI = "basalt-neural-family-factory-job@1" as const;

const jobMaterial = z
  .object({
    kind: z.literal("NeuralFamilyFactoryJob"),
    abi: z.literal(NEURAL_FAMILY_FACTORY_JOB_ABI),
    requirementId: entityId,
    familyId: entityId,
    provider: z.enum(NEURAL_PROVIDER_IDS),
    referenceHash: hashSchema,
    styleContractHash: hashSchema,
    acquisitionContext: z.literal("focal_insert"),
    expectedBoundsStuds: z
      .object({
        x: z.number().finite().positive(),
        y: z.number().finite().positive(),
        z: z.number().finite().positive(),
      })
      .strict(),
    seed: z.number().int().nonnegative().max(0xffff_ffff),
    archetypeOrdinal: z.number().int().nonnegative().max(255),
    status: z.enum(["queued", "completed", "incomplete"]),
    outputHandoffHash: hashSchema.optional(),
    failureCode: z.string().trim().min(1).max(160).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      Math.max(
        value.expectedBoundsStuds.x,
        value.expectedBoundsStuds.y,
        value.expectedBoundsStuds.z,
      ) > MAX_NEURAL_ASSET_BOUND_STUDS
    )
      context.addIssue({
        code: "custom",
        path: ["expectedBoundsStuds"],
        message: `Neural family geometry cannot exceed ${MAX_NEURAL_ASSET_BOUND_STUDS} studs`,
      });
    if ((value.status === "completed") !== (value.outputHandoffHash !== undefined))
      context.addIssue({
        code: "custom",
        path: ["outputHandoffHash"],
        message: "Completed family jobs require an exact output handoff",
      });
    if ((value.status === "incomplete") !== (value.failureCode !== undefined))
      context.addIssue({
        code: "custom",
        path: ["failureCode"],
        message: "Incomplete family jobs require one failure code",
      });
  });

export const NEURAL_FAMILY_FACTORY_JOB_SCHEMA = jobMaterial.safeExtend({ hash: hashSchema });
export type NeuralFamilyFactoryJob = z.infer<typeof NEURAL_FAMILY_FACTORY_JOB_SCHEMA>;

const batchMaterial = z
  .object({
    kind: z.literal("NeuralFamilyFactoryBatch"),
    abi: z.literal(NEURAL_FAMILY_FACTORY_BATCH_ABI),
    worldPlanHash: hashSchema,
    styleContractHash: hashSchema,
    jobs: z.array(NEURAL_FAMILY_FACTORY_JOB_SCHEMA).min(1).max(4096),
  })
  .strict()
  .superRefine((value, context) => {
    const ordered = [...value.jobs].sort((left, right) => left.hash.localeCompare(right.hash));
    if (stableJson(ordered) !== stableJson(value.jobs))
      context.addIssue({
        code: "custom",
        path: ["jobs"],
        message: "Neural family jobs must be canonical by job hash",
      });
    for (const [index, job] of value.jobs.entries())
      if (job.styleContractHash !== value.styleContractHash)
        context.addIssue({
          code: "custom",
          path: ["jobs", index, "styleContractHash"],
          message: "Family job style must match its batch",
        });
  });

export const NEURAL_FAMILY_FACTORY_BATCH_SCHEMA = batchMaterial.safeExtend({ hash: hashSchema });
export type NeuralFamilyFactoryBatch = z.infer<typeof NEURAL_FAMILY_FACTORY_BATCH_SCHEMA>;

export function sealNeuralFamilyFactoryJob(
  input: z.input<typeof jobMaterial>,
): NeuralFamilyFactoryJob {
  const material = jobMaterial.parse(input);
  return NEURAL_FAMILY_FACTORY_JOB_SCHEMA.parse({
    ...material,
    hash: contentHash(stableJson(material)),
  });
}

export function sealNeuralFamilyFactoryBatch(input: {
  readonly worldPlanHash: string;
  readonly styleContractHash: string;
  readonly jobs: readonly NeuralFamilyFactoryJob[];
}): NeuralFamilyFactoryBatch {
  const jobs = [...input.jobs].sort((left, right) => left.hash.localeCompare(right.hash));
  const material = batchMaterial.parse({
    kind: "NeuralFamilyFactoryBatch",
    abi: NEURAL_FAMILY_FACTORY_BATCH_ABI,
    worldPlanHash: hashSchema.parse(input.worldPlanHash),
    styleContractHash: hashSchema.parse(input.styleContractHash),
    jobs,
  });
  return NEURAL_FAMILY_FACTORY_BATCH_SCHEMA.parse({
    ...material,
    hash: contentHash(stableJson(material)),
  });
}

export function assertNeuralFamilyFactoryBatchIdentity(
  value: unknown,
): asserts value is NeuralFamilyFactoryBatch {
  const batch = NEURAL_FAMILY_FACTORY_BATCH_SCHEMA.parse(value);
  const { hash, ...material } = batch;
  if (hash !== contentHash(stableJson(material)))
    throw new Error("Neural family-factory batch identity is invalid");
  for (const job of batch.jobs) {
    const { hash: jobHash, ...jobMaterialValue } = job;
    if (jobHash !== contentHash(stableJson(jobMaterialValue)))
      throw new Error("Neural family-factory job identity is invalid");
  }
}

export function queueNeuralFamilyFactoryJobs(input: {
  readonly worldPlanHash: string;
  readonly styleContractHash: string;
  readonly jobs: readonly {
    readonly requirementId: string;
    readonly familyId: string;
    readonly provider: NeuralProviderId;
    readonly referenceHash: string;
    readonly expectedBoundsStuds: { readonly x: number; readonly y: number; readonly z: number };
    readonly seed: number;
    readonly archetypeOrdinal: number;
  }[];
}): NeuralFamilyFactoryBatch {
  return sealNeuralFamilyFactoryBatch({
    worldPlanHash: input.worldPlanHash,
    styleContractHash: input.styleContractHash,
    jobs: input.jobs.map((job) =>
      sealNeuralFamilyFactoryJob({
        kind: "NeuralFamilyFactoryJob",
        abi: NEURAL_FAMILY_FACTORY_JOB_ABI,
        ...job,
        styleContractHash: input.styleContractHash,
        acquisitionContext: "focal_insert",
        expectedBoundsStuds: job.expectedBoundsStuds,
        status: "queued",
      }),
    ),
  });
}
