import { z } from "zod";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import { compareSpatialStrings, hashSchema } from "../../spatial-core/src/primitives.js";
import {
  ASSET_FACTORY_DESCRIPTOR_SCHEMA,
  ASSET_FACTORY_QUALIFICATION_SCHEMA,
  assertAssetFactoryDescriptorIdentity,
  assertAssetFactoryQualificationIdentity,
  type AssetFactoryDescriptor,
  type AssetFactoryQualification,
} from "./contracts.js";

export const ASSET_FACTORY_REGISTRY_ABI = "basalt-asset-factory-registry@2" as const;

export const ASSET_FACTORY_REGISTRATION_SCHEMA = z
  .object({
    descriptor: ASSET_FACTORY_DESCRIPTOR_SCHEMA,
    qualification: ASSET_FACTORY_QUALIFICATION_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => validateRegistration(value, context));
export type AssetFactoryRegistration = z.infer<typeof ASSET_FACTORY_REGISTRATION_SCHEMA>;

export const ASSET_FACTORY_REGISTRY_MATERIAL_SCHEMA = z
  .object({
    kind: z.literal("AssetFactoryRegistry"),
    abi: z.literal(ASSET_FACTORY_REGISTRY_ABI),
    entries: z.array(ASSET_FACTORY_REGISTRATION_SCHEMA).max(128),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = value.entries.map(({ descriptor }) => descriptor.id);
    if (
      new Set(ids).size !== ids.length ||
      ids.some((id, index) => index > 0 && value.entries[index - 1]!.descriptor.id >= id)
    )
      context.addIssue({
        code: "custom",
        path: ["entries"],
        message: "Asset factory registry entries must be unique and canonical",
      });
  });
export const ASSET_FACTORY_REGISTRY_SCHEMA = ASSET_FACTORY_REGISTRY_MATERIAL_SCHEMA.safeExtend({
  hash: hashSchema,
}).strict();
export type AssetFactoryRegistry = z.infer<typeof ASSET_FACTORY_REGISTRY_SCHEMA>;

export function sealAssetFactoryRegistry(
  entries: readonly {
    descriptor: AssetFactoryDescriptor;
    qualification: AssetFactoryQualification;
  }[],
): AssetFactoryRegistry {
  const canonical = [...entries]
    .map((entry) => {
      assertAssetFactoryDescriptorIdentity(entry.descriptor);
      assertAssetFactoryQualificationIdentity(entry.qualification);
      return ASSET_FACTORY_REGISTRATION_SCHEMA.parse(entry);
    })
    .sort((left, right) => compareSpatialStrings(left.descriptor.id, right.descriptor.id));
  const material = ASSET_FACTORY_REGISTRY_MATERIAL_SCHEMA.parse({
    kind: "AssetFactoryRegistry",
    abi: ASSET_FACTORY_REGISTRY_ABI,
    entries: canonical,
  });
  return ASSET_FACTORY_REGISTRY_SCHEMA.parse({
    ...material,
    hash: contentHash(stableJson(material)),
  });
}

export function assertAssetFactoryRegistryIdentity(
  value: unknown,
): asserts value is AssetFactoryRegistry {
  const registry = ASSET_FACTORY_REGISTRY_SCHEMA.parse(value);
  const { hash, ...material } = registry;
  if (contentHash(stableJson(material)) !== hash)
    throw new Error("Asset factory registry identity is invalid");
  for (const entry of registry.entries) {
    assertAssetFactoryDescriptorIdentity(entry.descriptor);
    assertAssetFactoryQualificationIdentity(entry.qualification);
  }
}

function validateRegistration(
  value: {
    descriptor: AssetFactoryDescriptor;
    qualification: AssetFactoryQualification;
  },
  context: z.RefinementCtx,
): void {
  const { descriptor, qualification } = value;
  if (qualification.factoryId !== descriptor.id)
    context.addIssue({
      code: "custom",
      path: ["qualification", "factoryId"],
      message: "Factory qualification belongs to another descriptor",
    });
  if (qualification.factoryRevisionHash !== descriptor.revisionHash)
    context.addIssue({
      code: "custom",
      path: ["qualification", "factoryRevisionHash"],
      message: "Factory qualification targets another revision",
    });
  if (qualification.route !== descriptor.route)
    context.addIssue({
      code: "custom",
      path: ["qualification", "route"],
      message: "Factory qualification route differs from its descriptor",
    });
  if (qualification.executionClass !== descriptor.executionClass)
    context.addIssue({
      code: "custom",
      path: ["qualification", "executionClass"],
      message: "Factory qualification execution class differs from its descriptor",
    });
  if (qualification.parameterSchemaHash !== descriptor.parameterContract.jsonSchemaHash)
    context.addIssue({
      code: "custom",
      path: ["qualification", "parameterSchemaHash"],
      message: "Factory qualification targets another parameter contract",
    });
}
