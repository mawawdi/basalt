import { z } from "zod";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import { hashSchema } from "../../spatial-core/src/primitives.js";
import {
  FLUX2_KLEIN_4B_PRODUCER,
  LONGCAT_IMAGE_EDIT_PRODUCER,
  QWEN_IMAGE_2512_PRODUCER,
  QWEN_IMAGE_EDIT_2511_PRODUCER,
  REFERENCE_IMAGE_PRODUCER_QUALIFICATION_SCHEMA,
  SAM3_PRODUCER,
  assertReferenceImageProducerQualificationIdentity,
  type ReferenceImageProducerQualification,
} from "./producers.js";

export const REFERENCE_IMAGE_PRODUCER_REGISTRY_ABI =
  "basalt-reference-image-producer-registry@4" as const;
export const REFERENCE_IMAGE_EXECUTION_CLASS = "remote_neural_image" as const;

export const REFERENCE_IMAGE_PRODUCTION_ROUTES = [
  "isolated_reference",
  "region_composition",
  "prompted_segmentation",
] as const;
export type ReferenceImageProductionRoute = (typeof REFERENCE_IMAGE_PRODUCTION_ROUTES)[number];

const registryEntryMaterial = z
  .object({
    route: z.enum(REFERENCE_IMAGE_PRODUCTION_ROUTES),
    executionClass: z.literal(REFERENCE_IMAGE_EXECUTION_CLASS),
    producerId: z.enum([
      FLUX2_KLEIN_4B_PRODUCER.id,
      LONGCAT_IMAGE_EDIT_PRODUCER.id,
      QWEN_IMAGE_2512_PRODUCER.id,
      QWEN_IMAGE_EDIT_2511_PRODUCER.id,
      SAM3_PRODUCER.id,
    ]),
    producerIdentityHash: hashSchema,
    qualificationHash: hashSchema,
    modalImageId: z.string().regex(/^im-[A-Za-z0-9]+$/u),
    runtimeImageHash: hashSchema,
    workerSourceHash: hashSchema,
    modelVolumeSnapshotHash: hashSchema,
    qualification: REFERENCE_IMAGE_PRODUCER_QUALIFICATION_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    const qualification = value.qualification;
    if (qualification.localStatus !== "eligible")
      context.addIssue({
        code: "custom",
        path: ["qualification", "localStatus"],
        message: "Only eligible producer qualifications may enter the runtime registry",
      });
    const expected = deriveRegistryEntry(qualification);
    if (stableJson(value) !== stableJson(expected))
      context.addIssue({
        code: "custom",
        message: "Runtime entry must derive exactly from its producer qualification",
      });
  });

export const REFERENCE_IMAGE_PRODUCER_REGISTRY_ENTRY_SCHEMA = registryEntryMaterial;
export type ReferenceImageProducerRegistryEntry = z.infer<
  typeof REFERENCE_IMAGE_PRODUCER_REGISTRY_ENTRY_SCHEMA
>;

const registryMaterial = z
  .object({
    kind: z.literal("ReferenceImageProducerRegistry"),
    abi: z.literal(REFERENCE_IMAGE_PRODUCER_REGISTRY_ABI),
    entries: z.array(REFERENCE_IMAGE_PRODUCER_REGISTRY_ENTRY_SCHEMA).max(8),
  })
  .strict()
  .superRefine((value, context) => {
    const keys = value.entries.map(({ route, producerId }) => `${route}:${producerId}`);
    if (stableJson(keys) !== stableJson([...keys].sort()))
      context.addIssue({
        code: "custom",
        path: ["entries"],
        message: "Reference-image registry entries must use canonical route and producer order",
      });
    if (new Set(keys).size !== value.entries.length)
      context.addIssue({
        code: "custom",
        path: ["entries"],
        message: "Reference-image registry may contain each route and producer pair only once",
      });
  });

export const REFERENCE_IMAGE_PRODUCER_REGISTRY_SCHEMA = registryMaterial.safeExtend({
  hash: hashSchema,
});
export type ReferenceImageProducerRegistry = z.infer<
  typeof REFERENCE_IMAGE_PRODUCER_REGISTRY_SCHEMA
>;

export function referenceImageProductionRoute(
  qualification: ReferenceImageProducerQualification,
): ReferenceImageProductionRoute {
  switch (qualification.producer.id) {
    case QWEN_IMAGE_2512_PRODUCER.id:
      return "isolated_reference";
    case QWEN_IMAGE_EDIT_2511_PRODUCER.id:
    case FLUX2_KLEIN_4B_PRODUCER.id:
    case LONGCAT_IMAGE_EDIT_PRODUCER.id:
      return "region_composition";
    case SAM3_PRODUCER.id:
      return "prompted_segmentation";
  }
}

export function sealReferenceImageProducerRegistry(
  qualifications: readonly ReferenceImageProducerQualification[],
): ReferenceImageProducerRegistry {
  const entries = qualifications.map((qualification) => {
    assertReferenceImageProducerQualificationIdentity(qualification);
    return deriveRegistryEntry(qualification);
  });
  entries.sort((left, right) => {
    const leftKey = `${left.route}:${left.producerId}`;
    const rightKey = `${right.route}:${right.producerId}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  const material = registryMaterial.parse({
    kind: "ReferenceImageProducerRegistry",
    abi: REFERENCE_IMAGE_PRODUCER_REGISTRY_ABI,
    entries,
  });
  return REFERENCE_IMAGE_PRODUCER_REGISTRY_SCHEMA.parse({
    ...material,
    hash: contentHash(stableJson(material)),
  });
}

export function assertReferenceImageProducerRegistryIdentity(
  value: unknown,
): asserts value is ReferenceImageProducerRegistry {
  const registry = REFERENCE_IMAGE_PRODUCER_REGISTRY_SCHEMA.parse(value);
  for (const entry of registry.entries)
    assertReferenceImageProducerQualificationIdentity(entry.qualification);
  const { hash, ...material } = registry;
  if (contentHash(stableJson(material)) !== hash)
    throw new Error("Reference-image producer registry identity is invalid");
}

export function referenceImageProducerPortfolio(
  registry: ReferenceImageProducerRegistry,
  route: ReferenceImageProductionRoute,
): readonly ReferenceImageProducerRegistryEntry[] {
  assertReferenceImageProducerRegistryIdentity(registry);
  return registry.entries.filter((entry) => entry.route === route);
}

export function requireReferenceImageProducer(
  registry: ReferenceImageProducerRegistry,
  route: ReferenceImageProductionRoute,
  producerId: ReferenceImageProducerRegistryEntry["producerId"],
): ReferenceImageProducerRegistryEntry {
  const entry = referenceImageProducerPortfolio(registry, route).find(
    (candidate) => candidate.producerId === producerId,
  );
  if (!entry) throw new Error(`No eligible ${producerId} producer is registered for ${route}`);
  return entry;
}

function deriveRegistryEntry(
  qualification: ReferenceImageProducerQualification,
): ReferenceImageProducerRegistryEntry {
  return {
    route: referenceImageProductionRoute(qualification),
    executionClass: REFERENCE_IMAGE_EXECUTION_CLASS,
    producerId: qualification.producer.id,
    producerIdentityHash: qualification.producerIdentityHash,
    qualificationHash: qualification.hash,
    modalImageId: qualification.runtime.modalImageId,
    runtimeImageHash: qualification.runtime.runtimeImageHash,
    workerSourceHash: qualification.runtime.workerSourceHash,
    modelVolumeSnapshotHash: qualification.runtime.modelVolumeSnapshotHash,
    qualification,
  };
}
