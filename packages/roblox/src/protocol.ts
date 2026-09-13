import { z } from "zod";
import {
  HASH_SCHEMA,
  compareCanonicalStrings,
  contentAddressedEntityId,
  contentHash,
  deepFreezeJson,
  stableJson,
} from "@basalt/contracts";
import { SPATIAL_AABB_SCHEMA, SPATIAL_VECTOR3_SCHEMA } from "@basalt/spatial-core";
import {
  ASSEMBLY_ARTIFACT_SCHEMA,
  COMPILED_WORLD_FOUNDATION_SCHEMA,
  CONSTRUCTED_SURFACE_SCHEMA,
  PORTAL_ARTIFACT_SCHEMA,
  PROCEDURAL_STAIR_ARTIFACT_SCHEMA,
  ROOM_ARTIFACT_SCHEMA,
  WORLD_BUILD_SCHEMA,
  type WorldBuild,
} from "@basalt/world-compiler";
import { ROBLOX_STUD_METERS } from "./constants.js";

const entityId = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u);
const quaternion = z.tuple([
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
]);
const observedArtifact = z
  .object({
    artifactKind: z.enum([
      "terrain_field",
      "route",
      "assembly",
      "constructed_surface",
      "portal",
      "room",
      "procedural_stair",
    ]),
    artifactId: entityId,
    realizedHash: HASH_SCHEMA,
  })
  .strict();
const materialPartPathSegment = z
  .object({ name: z.string().min(1).max(100), siblingOrdinal: z.number().int().nonnegative() })
  .strict();
const colorRgb = z
  .object({
    red: z.number().int().min(0).max(255),
    green: z.number().int().min(0).max(255),
    blue: z.number().int().min(0).max(255),
  })
  .strict();
const surfaceAppearanceExpectation = z
  .object({
    colorMap: z.string().max(1024),
    metalnessMap: z.string().max(1024),
    normalMap: z.string().max(1024),
    roughnessMap: z.string().max(1024),
    alphaMode: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/u),
  })
  .strict();
export const ROBLOX_MATERIAL_EXPECTATION_SCHEMA = z
  .object({
    partPath: z.array(materialPartPathSegment).min(1).max(128),
    className: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/u),
    material: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/u),
    color: colorRgb,
    transparency: z.number().finite().min(0).max(1),
    reflectance: z.number().finite().min(0).max(1),
    meshTextureId: z.string().max(1024).optional(),
    surfaceAppearance: surfaceAppearanceExpectation.optional(),
  })
  .strict();
export type RobloxMaterialExpectation = z.output<typeof ROBLOX_MATERIAL_EXPECTATION_SCHEMA>;

export const ROBLOX_SCENE_INSTANCE_SCHEMA = z
  .object({
    instanceId: entityId,
    assetHash: HASH_SCHEMA,
    sourceArtifactHash: HASH_SCHEMA.optional(),
    robloxAssetId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    transformMeters: z
      .object({
        position: SPATIAL_VECTOR3_SCHEMA,
        rotation: quaternion,
        scale: z.number().finite().positive(),
      })
      .strict(),
    sourceBoundsMeters: SPATIAL_AABB_SCHEMA,
    boundsMeters: SPATIAL_AABB_SCHEMA,
    materialExpectations: z.array(ROBLOX_MATERIAL_EXPECTATION_SCHEMA).max(100_000),
    evidenceHashes: z.array(HASH_SCHEMA).max(8192),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.robloxAssetId !== undefined) !== value.materialExpectations.length > 0)
      context.addIssue({
        code: "custom",
        path: ["materialExpectations"],
        message: "A bound Roblox asset requires complete material expectations",
      });
    validateMaterialExpectationPaths(value.materialExpectations, context);
  });

export const ROBLOX_IMPORT_TRANSACTION_SCHEMA = z
  .object({
    kind: z.literal("RobloxImportTransaction"),
    transactionId: entityId,
    sessionHash: HASH_SCHEMA,
    worldBuildHash: HASH_SCHEMA,
    sequence: z.number().int().nonnegative(),
    stage: z.enum(["preflight", "foundation", "meso", "micro", "readback", "commit"]),
    expectedObservedWorldStateHash: HASH_SCHEMA,
    foundation: z
      .object({
        worldBoundsMeters: SPATIAL_AABB_SCHEMA,
        terrainFields: COMPILED_WORLD_FOUNDATION_SCHEMA.shape.terrainFields,
        roadAssemblies: COMPILED_WORLD_FOUNDATION_SCHEMA.shape.roadAssemblies,
      })
      .strict()
      .optional(),
    meso: z
      .object({
        assemblies: z.array(ASSEMBLY_ARTIFACT_SCHEMA).max(65_536),
        constructedSurfaces: z.array(CONSTRUCTED_SURFACE_SCHEMA).max(65_536),
        portals: z.array(PORTAL_ARTIFACT_SCHEMA).max(65_536),
        rooms: z.array(ROOM_ARTIFACT_SCHEMA).max(65_536),
        proceduralStairs: z.array(PROCEDURAL_STAIR_ARTIFACT_SCHEMA).max(65_536),
      })
      .strict()
      .optional(),
    instances: z.array(ROBLOX_SCENE_INSTANCE_SCHEMA).max(100_000),
    expectedInstanceHashes: z
      .array(z.object({ instanceId: entityId, hash: HASH_SCHEMA }).strict())
      .max(100_000),
    expectedArtifactHashes: z.array(observedArtifact).max(262_144),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyHash(value, "hash", context);
    if ((value.stage === "foundation") !== (value.foundation !== undefined))
      context.addIssue({
        code: "custom",
        path: ["foundation"],
        message: "Only the foundation transaction carries foundation data",
      });
    if ((value.stage === "meso") !== (value.meso !== undefined))
      context.addIssue({
        code: "custom",
        path: ["meso"],
        message: "Only the meso transaction carries structural data",
      });
    if (
      new Set(value.expectedInstanceHashes.map((entry) => entry.instanceId)).size !==
      value.expectedInstanceHashes.length
    )
      context.addIssue({ code: "custom", message: "Expected instance identities must be unique" });
    const artifactKeys = value.expectedArtifactHashes.map(
      (entry) => `${entry.artifactKind}:${entry.artifactId}`,
    );
    if (new Set(artifactKeys).size !== artifactKeys.length)
      context.addIssue({
        code: "custom",
        message: "Expected structural artifact identities must be unique",
      });
  });
export type RobloxImportTransaction = z.output<typeof ROBLOX_IMPORT_TRANSACTION_SCHEMA>;

export const ROBLOX_IMPORT_MANIFEST_SCHEMA = z
  .object({
    kind: z.literal("RobloxImportManifest"),
    sessionHash: HASH_SCHEMA,
    worldBuildHash: HASH_SCHEMA,
    worldStatus: z.enum(["eligible", "incomplete"]),
    loweringGaps: z
      .array(
        z.object({ assetHash: HASH_SCHEMA, reason: z.string().trim().min(1).max(1024) }).strict(),
      )
      .max(100_000),
    transactions: z.array(ROBLOX_IMPORT_TRANSACTION_SCHEMA).min(4).max(100_000),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyHash(value, "hash", context);
    const expectedStages = ["preflight", "foundation", "meso", "micro", "readback", "commit"];
    if (stableJson(value.transactions.map((entry) => entry.stage)) !== stableJson(expectedStages))
      context.addIssue({
        code: "custom",
        message: "Roblox import stages must form the canonical sequence",
      });
    for (const [index, transaction] of value.transactions.entries())
      if (
        transaction.sequence !== index ||
        transaction.sessionHash !== value.sessionHash ||
        transaction.worldBuildHash !== value.worldBuildHash
      )
        context.addIssue({ code: "custom", message: "Roblox transaction lineage is inconsistent" });
  });
export type RobloxImportManifest = z.output<typeof ROBLOX_IMPORT_MANIFEST_SCHEMA>;

export const ROBLOX_ASSET_BINDING_SCHEMA = z
  .object({
    assetHash: HASH_SCHEMA,
    robloxAssetId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    sourceArtifactHash: HASH_SCHEMA,
    materialExpectations: z.array(ROBLOX_MATERIAL_EXPECTATION_SCHEMA).min(1).max(100_000),
    bindingHash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyHash(value, "bindingHash", context);
    validateMaterialExpectationPaths(value.materialExpectations, context);
  });
export type RobloxAssetBinding = z.output<typeof ROBLOX_ASSET_BINDING_SCHEMA>;

export function sealRobloxAssetBinding(
  input: Omit<RobloxAssetBinding, "bindingHash">,
): RobloxAssetBinding {
  const material = {
    ...input,
    materialExpectations: [...input.materialExpectations].sort((left, right) =>
      compareCanonicalStrings(stableJson(left.partPath), stableJson(right.partPath)),
    ),
  };
  return deepFreezeJson(
    ROBLOX_ASSET_BINDING_SCHEMA.parse({
      ...material,
      bindingHash: contentHash(stableJson(material)),
    }),
  );
}

export const ROBLOX_READBACK_SCHEMA = z
  .object({
    kind: z.literal("RobloxReadback"),
    sessionHash: HASH_SCHEMA,
    worldBuildHash: HASH_SCHEMA,
    transactionId: entityId,
    status: z.enum(["complete", "incomplete"]),
    instances: z
      .array(z.object({ instanceId: entityId, realizedHash: HASH_SCHEMA }).strict())
      .max(100_000),
    artifacts: z.array(observedArtifact).max(262_144),
    diagnostics: z.array(z.string().min(1).max(1024)).max(4096),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === "complete" && value.diagnostics.length > 0)
      context.addIssue({
        code: "custom",
        path: ["diagnostics"],
        message: "Complete readback cannot contain diagnostics",
      });
    if (value.status === "incomplete" && value.diagnostics.length === 0)
      context.addIssue({
        code: "custom",
        path: ["diagnostics"],
        message: "Incomplete readback requires a diagnostic",
      });
  });
export type RobloxReadback = z.output<typeof ROBLOX_READBACK_SCHEMA>;

export function createRobloxImportManifest(
  worldBuildInput: WorldBuild,
  assetBindingsInput: readonly RobloxAssetBinding[] = [],
): RobloxImportManifest {
  const worldBuild = WORLD_BUILD_SCHEMA.parse(worldBuildInput);
  if (worldBuild.status === "rejected") throw new Error("Rejected worlds cannot be imported");
  const assetBindings = assetBindingsInput.map((entry) => ROBLOX_ASSET_BINDING_SCHEMA.parse(entry));
  const bindingByAsset = new Map(assetBindings.map((entry) => [entry.assetHash, entry]));
  if (bindingByAsset.size !== assetBindings.length)
    throw new Error("Roblox asset bindings must be unique by asset hash");
  const sessionHash = contentHash(
    stableJson({ worldBuildHash: worldBuild.worldBuildHash, adapter: "roblox" }),
  );
  const instances = worldBuild.instances.map((instance) => {
    const binding = bindingByAsset.get(instance.assetHash);
    return {
      instanceId: instance.instanceId,
      assetHash: instance.assetHash,
      ...(binding
        ? {
            sourceArtifactHash: binding.sourceArtifactHash,
            robloxAssetId: binding.robloxAssetId,
          }
        : {}),
      transformMeters: instance.transformMeters,
      sourceBoundsMeters: instance.sourceBoundsMeters,
      boundsMeters: instance.boundsMeters,
      materialExpectations: binding?.materialExpectations ?? [],
      evidenceHashes: binding
        ? [...new Set([...instance.evidenceHashes, binding.bindingHash])].sort(
            compareCanonicalStrings,
          )
        : instance.evidenceHashes,
    };
  });
  const loweringGaps = [
    ...new Set(
      instances
        .filter((entry) => entry.robloxAssetId === undefined)
        .map((entry) => entry.assetHash),
    ),
  ]
    .sort(compareCanonicalStrings)
    .map((assetHash) => ({ assetHash, reason: "No admitted Roblox asset binding exists" }));
  const foundationArtifacts = foundationObservations(worldBuild);
  const structuralArtifacts = structuralObservations(worldBuild);
  const mesoPayload = {
    assemblies: worldBuild.meso.assemblies,
    constructedSurfaces: worldBuild.meso.constructedSurfaces,
    portals: worldBuild.meso.portals,
    rooms: worldBuild.meso.rooms,
    proceduralStairs: worldBuild.meso.proceduralStairs,
  };
  const stages = [
    { stage: "preflight" as const, instances: [] },
    {
      stage: "foundation" as const,
      instances: [],
      foundation: {
        worldBoundsMeters: worldBuild.foundation.plan.boundsMeters,
        terrainFields: worldBuild.foundation.terrainFields,
        roadAssemblies: worldBuild.foundation.roadAssemblies,
      },
      expectedArtifacts: foundationArtifacts,
    },
    {
      stage: "meso" as const,
      instances: instancesFor(worldBuild.meso.instances, instances),
      meso: mesoPayload,
      expectedArtifacts: structuralArtifacts,
    },
    { stage: "micro" as const, instances: instancesFor(worldBuild.micro.instances, instances) },
    {
      stage: "readback" as const,
      instances: [],
      expectedInstances: instances,
      expectedArtifacts: [...foundationArtifacts, ...structuralArtifacts],
    },
    { stage: "commit" as const, instances: [] },
  ];
  const transactions = stages.map((stage, sequence) => {
    const expectedInstanceHashes = (stage.expectedInstances ?? stage.instances)
      .map((entry) => ({ instanceId: entry.instanceId, hash: contentHash(stableJson(entry)) }))
      .sort((a, b) => compareCanonicalStrings(a.instanceId, b.instanceId));
    const expectedArtifactHashes = [...(stage.expectedArtifacts ?? [])].sort((left, right) =>
      compareCanonicalStrings(
        `${left.artifactKind}:${left.artifactId}`,
        `${right.artifactKind}:${right.artifactId}`,
      ),
    );
    const expectedObservedWorldStateHash = observedWorldStateHash({
      worldBuildHash: worldBuild.worldBuildHash,
      stage: stage.stage,
      instances: expectedInstanceHashes.map((entry) => ({
        instanceId: entry.instanceId,
        realizedHash: entry.hash,
      })),
      artifacts: expectedArtifactHashes,
    });
    const transactionMaterial = {
      kind: "RobloxImportTransaction" as const,
      transactionId: contentAddressedEntityId("Transaction", {
        sessionHash,
        sequence,
        stage: stage.stage,
      }),
      sessionHash,
      worldBuildHash: worldBuild.worldBuildHash,
      sequence,
      stage: stage.stage,
      expectedObservedWorldStateHash,
      ...(stage.foundation ? { foundation: stage.foundation } : {}),
      ...(stage.meso ? { meso: stage.meso } : {}),
      instances: stage.instances,
      expectedInstanceHashes,
      expectedArtifactHashes,
    };
    return deepFreezeJson(
      ROBLOX_IMPORT_TRANSACTION_SCHEMA.parse({
        ...transactionMaterial,
        hash: contentHash(stableJson(transactionMaterial)),
      }),
    );
  });
  const material = {
    kind: "RobloxImportManifest" as const,
    sessionHash,
    worldBuildHash: worldBuild.worldBuildHash,
    worldStatus:
      worldBuild.status === "incomplete" || loweringGaps.length > 0
        ? ("incomplete" as const)
        : ("eligible" as const),
    loweringGaps,
    transactions,
  };
  return deepFreezeJson(
    ROBLOX_IMPORT_MANIFEST_SCHEMA.parse({ ...material, hash: contentHash(stableJson(material)) }),
  );
}

export function verifyRobloxReadback(
  transaction: RobloxImportTransaction,
  readbackInput: unknown,
): readonly string[] {
  const readback = ROBLOX_READBACK_SCHEMA.parse(readbackInput);
  const diagnostics: string[] = [];
  if (readback.sessionHash !== transaction.sessionHash) diagnostics.push("Session hash mismatch");
  if (readback.worldBuildHash !== transaction.worldBuildHash)
    diagnostics.push("World build hash mismatch");
  if (readback.transactionId !== transaction.transactionId)
    diagnostics.push("Transaction ID mismatch");
  const observed = new Map(
    readback.instances.map((entry) => [entry.instanceId, entry.realizedHash]),
  );
  if (observed.size !== readback.instances.length)
    diagnostics.push("Readback repeats instance observations");
  for (const expected of transaction.expectedInstanceHashes)
    if (observed.get(expected.instanceId) !== expected.hash)
      diagnostics.push(`Instance ${expected.instanceId} did not match its exact realization hash`);
  for (const observedInstanceId of observed.keys())
    if (
      !transaction.expectedInstanceHashes.some((entry) => entry.instanceId === observedInstanceId)
    )
      diagnostics.push(`Unexpected instance observation ${observedInstanceId}`);
  const observedArtifacts = new Map(
    readback.artifacts.map((entry) => [
      `${entry.artifactKind}:${entry.artifactId}`,
      entry.realizedHash,
    ]),
  );
  if (observedArtifacts.size !== readback.artifacts.length)
    diagnostics.push("Readback repeats structural artifact observations");
  for (const expected of transaction.expectedArtifactHashes)
    if (
      observedArtifacts.get(`${expected.artifactKind}:${expected.artifactId}`) !==
      expected.realizedHash
    )
      diagnostics.push(
        `${expected.artifactKind} ${expected.artifactId} did not match its exact realization hash`,
      );
  for (const observedArtifactId of observedArtifacts.keys())
    if (
      !transaction.expectedArtifactHashes.some(
        (entry) => `${entry.artifactKind}:${entry.artifactId}` === observedArtifactId,
      )
    )
      diagnostics.push(`Unexpected artifact observation ${observedArtifactId}`);
  if (
    computeRobloxObservedWorldStateHash(transaction, readback) !==
    transaction.expectedObservedWorldStateHash
  )
    diagnostics.push("Observed world-state hash mismatch");
  return diagnostics.sort(compareCanonicalStrings);
}

export function computeRobloxObservedWorldStateHash(
  transaction: RobloxImportTransaction,
  readbackInput: RobloxReadback,
): string {
  const readback = ROBLOX_READBACK_SCHEMA.parse(readbackInput);
  return observedWorldStateHash({
    worldBuildHash: transaction.worldBuildHash,
    stage: transaction.stage,
    instances: readback.instances,
    artifacts: readback.artifacts,
  });
}

/** Generic meters become Roblox studs only here, at the adapter boundary. */
export function metersToRobloxStuds(meters: number): number {
  if (!Number.isFinite(meters)) throw new Error("Roblox lowering requires a finite meter value");
  return meters / ROBLOX_STUD_METERS;
}

/** Roblox observations return to the engine-neutral metric frame only here. */
export function robloxStudsToMeters(studs: number): number {
  if (!Number.isFinite(studs)) throw new Error("Roblox readback requires a finite stud value");
  return studs * ROBLOX_STUD_METERS;
}

/** Roblox terrain operates on its fixed four-stud voxel edge. */
export const ROBLOX_TERRAIN_VOXEL_METERS = 4 * ROBLOX_STUD_METERS;

function instancesFor(
  selected: readonly { instanceId: string }[],
  all: readonly z.output<typeof ROBLOX_SCENE_INSTANCE_SCHEMA>[],
) {
  const wanted = new Set(selected.map((entry) => entry.instanceId));
  return all.filter((entry) => wanted.has(entry.instanceId));
}

function structuralObservations(worldBuild: WorldBuild) {
  return [
    ...worldBuild.meso.assemblies.map((entry) => ({
      artifactKind: "assembly" as const,
      artifactId: entry.assemblyId,
      realizedHash: entry.hash,
    })),
    ...worldBuild.meso.constructedSurfaces.map((entry) => ({
      artifactKind: "constructed_surface" as const,
      artifactId: entry.surfaceId,
      realizedHash: entry.hash,
    })),
    ...worldBuild.meso.portals.map((entry) => ({
      artifactKind: "portal" as const,
      artifactId: entry.portalId,
      realizedHash: entry.hash,
    })),
    ...worldBuild.meso.rooms.map((entry) => ({
      artifactKind: "room" as const,
      artifactId: entry.roomId,
      realizedHash: entry.hash,
    })),
    ...worldBuild.meso.proceduralStairs.map((entry) => ({
      artifactKind: "procedural_stair" as const,
      artifactId: entry.stairId,
      realizedHash: entry.hash,
    })),
  ].sort((left, right) =>
    compareCanonicalStrings(
      `${left.artifactKind}:${left.artifactId}`,
      `${right.artifactKind}:${right.artifactId}`,
    ),
  );
}

function foundationObservations(worldBuild: WorldBuild) {
  return [
    ...worldBuild.foundation.terrainFields.map((entry) => ({
      artifactKind: "terrain_field" as const,
      artifactId: entry.terrainPlanId,
      realizedHash: entry.hash,
    })),
    ...worldBuild.foundation.roadAssemblies.map((entry) => ({
      artifactKind: "route" as const,
      artifactId: entry.routeId,
      realizedHash: entry.hash,
    })),
  ];
}

function observedWorldStateHash(input: {
  readonly worldBuildHash: string;
  readonly stage: RobloxImportTransaction["stage"];
  readonly instances: readonly { readonly instanceId: string; readonly realizedHash: string }[];
  readonly artifacts: readonly z.output<typeof observedArtifact>[];
}): string {
  return contentHash(
    stableJson({
      worldBuildHash: input.worldBuildHash,
      stage: input.stage,
      instances: [...input.instances].sort((left, right) =>
        compareCanonicalStrings(left.instanceId, right.instanceId),
      ),
      artifacts: [...input.artifacts].sort((left, right) =>
        compareCanonicalStrings(
          `${left.artifactKind}:${left.artifactId}`,
          `${right.artifactKind}:${right.artifactId}`,
        ),
      ),
    }),
  );
}

function verifyHash(value: Record<string, unknown>, field: string, context: z.RefinementCtx): void {
  const material = { ...value };
  delete material[field];
  if (contentHash(stableJson(material)) !== value[field])
    context.addIssue({ code: "custom", path: [field], message: "Artifact hash mismatch" });
}

function validateMaterialExpectationPaths(
  expectations: readonly RobloxMaterialExpectation[],
  context: z.RefinementCtx,
): void {
  const paths = expectations.map((entry) => stableJson(entry.partPath));
  if (new Set(paths).size !== paths.length)
    context.addIssue({
      code: "custom",
      path: ["materialExpectations"],
      message: "Roblox material expectation paths must be unique",
    });
}
