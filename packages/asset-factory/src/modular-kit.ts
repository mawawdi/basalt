import { z } from "zod";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import { entityId, hashSchema } from "../../spatial-core/src/primitives.js";
import {
  CONSTRUCTED_PLACEMENT_SURFACE_KINDS,
  CONSTRUCTED_SURFACE_SCHEMA,
  PLACEMENT_SURFACE_KINDS,
  PLACEMENT_SURFACE_KIND_SCHEMA,
  WORLD_VECTOR3_SCHEMA,
  type ConstructedSurface,
  type WorldVector3,
} from "../../world-planning/src/contracts.js";
import { TRIM_SHEET_MAPPING_PROFILE_SCHEMA } from "./trim-sheet.js";

export const MODULAR_KIT_ABI = "basalt-modular-kit@1" as const;
export const ASSEMBLY_RECIPE_ABI = "basalt-assembly-recipe@1" as const;

export const SOCKET_GENDER_SCHEMA = z.enum(["male", "female", "neutral"]);
export type SocketGender = z.infer<typeof SOCKET_GENDER_SCHEMA>;

const finite = z.number().finite();
const positive = finite.positive();
const vector3Tuple = z.tuple([finite, finite, finite]);

export const SOCKET_LOCAL_FRAME_SCHEMA = z
  .object({
    origin: vector3Tuple,
    normal: vector3Tuple, // Outward mating direction
    upVector: vector3Tuple, // Alignment orientation
  })
  .strict();

export const SOCKET_BOUNDARY_PROFILE_SCHEMA = z
  .object({
    shape: z.enum(["polygon", "rectangle", "circle"]),
    dimensions: z.tuple([positive, finite.nonnegative()]), // [width, height] or [radius, 0]
    planarTolerance: positive.default(1e-4),
    canonicalPolygonVertices: z
      .array(z.tuple([finite, finite]))
      .min(3)
      .max(64)
      .optional(),
  })
  .strict();

export const SOCKET_SNAP_POLICY_SCHEMA = z
  .object({
    angularStepDegrees: finite.nonnegative().max(360).default(0), // e.g. 60 for hex, 90 for orthogonal, 0 for continuous
    allowInversion: z.boolean().default(false),
    weldDistanceThreshold: positive.default(0.005),
  })
  .strict();

export const SOCKET_CONTRACT_SCHEMA = z
  .object({
    socketId: entityId,
    semanticRole: z.string().trim().min(1).max(80),
    gender: SOCKET_GENDER_SCHEMA,
    localFrame: SOCKET_LOCAL_FRAME_SCHEMA,
    boundaryProfile: SOCKET_BOUNDARY_PROFILE_SCHEMA,
    snapPolicy: SOCKET_SNAP_POLICY_SCHEMA,
  })
  .strict();

export type SocketContract = z.infer<typeof SOCKET_CONTRACT_SCHEMA>;

export const EXPOSED_MODULAR_SURFACE_SCHEMA = z
  .object({
    surfaceSuffix: z
      .string()
      .trim()
      .min(1)
      .max(32)
      .regex(/^[A-Za-z0-9_-]+$/, "Surface suffix must be alphanumeric, hyphen or underscore"),
    kind: z.enum(CONSTRUCTED_PLACEMENT_SURFACE_KINDS),
    materialId: entityId,
    navigable: z.boolean().default(true),
    localOrigin: WORLD_VECTOR3_SCHEMA,
    uAxis: WORLD_VECTOR3_SCHEMA,
    vAxis: WORLD_VECTOR3_SCHEMA,
    uRange: z.object({ minimum: finite, maximum: finite }).strict(),
    vRange: z.object({ minimum: finite, maximum: finite }).strict(),
  })
  .strict();

export type ExposedModularSurface = z.infer<typeof EXPOSED_MODULAR_SURFACE_SCHEMA>;

export const MODULAR_ARCHETYPE_SPECIFICATION_SCHEMA = z
  .object({
    archetypeId: entityId,
    name: z.string().trim().min(1).max(160),
    semanticRole: z.string().trim().min(1).max(80),
    boundingEnvelope: z.tuple([positive, positive, positive]),
    maxTriangleBudget: z.number().int().positive().max(65_536),
    sockets: z.array(SOCKET_CONTRACT_SCHEMA).max(64),
    supportedSurfaceKinds: z
      .array(PLACEMENT_SURFACE_KIND_SCHEMA)
      .max(PLACEMENT_SURFACE_KINDS.length),
    exposedSurfaces: z.array(EXPOSED_MODULAR_SURFACE_SCHEMA).max(32).default([]),
    materialStrategy: z
      .object({
        mode: z.enum(["trim_hotspot", "tiling_pbr", "unique_baked"]),
        trimAtlasHandle: hashSchema.optional(),
        sharedPbrMaterialId: entityId.optional(),
      })
      .strict(),
    collisionStrategy: z.enum(["precise_convex_decomposition", "box_envelope", "hull_cluster"]),
  })
  .strict()
  .superRefine((archetype, context) => {
    const socketIds = new Set<string>();
    for (const [index, socket] of archetype.sockets.entries()) {
      if (socketIds.has(socket.socketId)) {
        context.addIssue({
          code: "custom",
          path: ["sockets", index, "socketId"],
          message: `Duplicate socket ID on archetype: ${socket.socketId}`,
        });
      }
      socketIds.add(socket.socketId);
    }
  });

export type ModularArchetypeSpecification = z.infer<typeof MODULAR_ARCHETYPE_SPECIFICATION_SCHEMA>;

export const MODULAR_KIT_ADJACENCY_RULE_SCHEMA = z
  .object({
    sourceArchetypeId: entityId,
    sourceSocketId: entityId,
    targetArchetypeId: entityId,
    targetSocketId: entityId,
    probabilityWeight: positive.default(1.0),
  })
  .strict();

export type ModularKitAdjacencyRule = z.infer<typeof MODULAR_KIT_ADJACENCY_RULE_SCHEMA>;

export const MODULAR_KIT_REQUIREMENT_SCHEMA = z
  .object({
    kind: z.literal("ModularKitRequirement"),
    abi: z.literal(MODULAR_KIT_ABI),
    kitId: entityId,
    name: z.string().trim().min(1).max(160),
    styleContractHash: hashSchema,
    studsPerUnit: positive.default(1.0),
    archetypes: z.array(MODULAR_ARCHETYPE_SPECIFICATION_SCHEMA).min(1).max(64),
    adjacencyRules: z.array(MODULAR_KIT_ADJACENCY_RULE_SCHEMA).max(512),
    tolerances: z
      .object({
        socketMismatchThreshold: positive.default(0.01),
        maxMeshInterpenetration: finite.nonnegative().default(0.001),
      })
      .strict(),
  })
  .strict()
  .superRefine((kit, context) => {
    const archetypeIds = new Set<string>();
    const archetypeSockets = new Map<string, Set<string>>();

    for (const [index, arch] of kit.archetypes.entries()) {
      if (archetypeIds.has(arch.archetypeId)) {
        context.addIssue({
          code: "custom",
          path: ["archetypes", index, "archetypeId"],
          message: `Duplicate archetype ID in kit: ${arch.archetypeId}`,
        });
      }
      archetypeIds.add(arch.archetypeId);
      archetypeSockets.set(arch.archetypeId, new Set(arch.sockets.map((s) => s.socketId)));
    }

    for (const [index, rule] of kit.adjacencyRules.entries()) {
      const srcSockets = archetypeSockets.get(rule.sourceArchetypeId);
      if (!srcSockets) {
        context.addIssue({
          code: "custom",
          path: ["adjacencyRules", index, "sourceArchetypeId"],
          message: `Adjacency rule references unknown source archetype: ${rule.sourceArchetypeId}`,
        });
      } else if (!srcSockets.has(rule.sourceSocketId)) {
        context.addIssue({
          code: "custom",
          path: ["adjacencyRules", index, "sourceSocketId"],
          message: `Source socket ${rule.sourceSocketId} not found on archetype ${rule.sourceArchetypeId}`,
        });
      }

      const tgtSockets = archetypeSockets.get(rule.targetArchetypeId);
      if (!tgtSockets) {
        context.addIssue({
          code: "custom",
          path: ["adjacencyRules", index, "targetArchetypeId"],
          message: `Adjacency rule references unknown target archetype: ${rule.targetArchetypeId}`,
        });
      } else if (!tgtSockets.has(rule.targetSocketId)) {
        context.addIssue({
          code: "custom",
          path: ["adjacencyRules", index, "targetSocketId"],
          message: `Target socket ${rule.targetSocketId} not found on archetype ${rule.targetArchetypeId}`,
        });
      }
    }
  });

export type ModularKitRequirement = z.infer<typeof MODULAR_KIT_REQUIREMENT_SCHEMA>;

export const PREPARED_MODULAR_KIT_ARTIFACT_ABI = "basalt-prepared-modular-kit@1" as const;
const preparedModularKitMaterial = z
  .object({
    kind: z.literal("PreparedModularKitArtifact"),
    abi: z.literal(PREPARED_MODULAR_KIT_ARTIFACT_ABI),
    kitId: entityId,
    styleContractHash: hashSchema,
    archetypeHandles: z.array(hashSchema).min(1).max(64),
    socketRegistryHash: hashSchema,
    trimSheetMappings: z.array(TRIM_SHEET_MAPPING_PROFILE_SCHEMA).max(256),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      new Set(value.archetypeHandles).size !== value.archetypeHandles.length ||
      stableJson([...value.archetypeHandles].sort()) !== stableJson(value.archetypeHandles)
    )
      context.addIssue({
        code: "custom",
        path: ["archetypeHandles"],
        message: "Prepared kit archetype handles must be unique and canonical",
      });
  });
export const PREPARED_MODULAR_KIT_ARTIFACT_SCHEMA = preparedModularKitMaterial
  .safeExtend({ hash: hashSchema })
  .strict();
export type PreparedModularKitArtifact = z.infer<typeof PREPARED_MODULAR_KIT_ARTIFACT_SCHEMA>;

export function sealPreparedModularKitArtifact(
  input: z.input<typeof preparedModularKitMaterial>,
): PreparedModularKitArtifact {
  const material = preparedModularKitMaterial.parse({
    ...input,
    archetypeHandles: [...input.archetypeHandles].sort(),
  });
  return Object.freeze({ ...material, hash: contentHash(stableJson(material)) });
}

export function assertPreparedModularKitArtifactIdentity(
  value: unknown,
): asserts value is PreparedModularKitArtifact {
  const artifact = PREPARED_MODULAR_KIT_ARTIFACT_SCHEMA.parse(value);
  const { hash, ...material } = artifact;
  if (hash !== contentHash(stableJson(material)))
    throw new Error("Prepared modular-kit artifact identity is invalid");
}

/** A typed landmark graph: large shells stay procedural, focal inserts use sockets. */
const assemblyRecipeMaterial = z
  .object({
    kind: z.literal("AssemblyRecipe"),
    abi: z.literal(ASSEMBLY_RECIPE_ABI),
    id: entityId,
    styleContractHash: hashSchema,
    shell: z
      .object({
        archetypeId: entityId,
        repetition: z.number().int().positive().max(4096),
        trimSheetRequired: z.literal(true),
      })
      .strict(),
    socketedComponents: z
      .array(
        z
          .object({
            componentId: entityId,
            archetypeId: entityId,
            socketId: entityId,
            semanticRole: z.string().trim().min(1).max(160),
          })
          .strict(),
      )
      .max(256),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = value.socketedComponents.map((component) => component.componentId);
    if (new Set(ids).size !== ids.length)
      context.addIssue({
        code: "custom",
        path: ["socketedComponents"],
        message: "Assembly component IDs must be unique",
      });
    const canonical = [...value.socketedComponents].sort((left, right) =>
      left.componentId.localeCompare(right.componentId),
    );
    if (stableJson(canonical) !== stableJson(value.socketedComponents))
      context.addIssue({
        code: "custom",
        path: ["socketedComponents"],
        message: "Assembly component IDs must be canonical",
      });
  });
export const ASSEMBLY_RECIPE_SCHEMA = assemblyRecipeMaterial
  .safeExtend({ hash: hashSchema })
  .strict();
export type AssemblyRecipe = z.infer<typeof ASSEMBLY_RECIPE_SCHEMA>;

export function sealAssemblyRecipe(input: z.input<typeof assemblyRecipeMaterial>): AssemblyRecipe {
  const material = assemblyRecipeMaterial.parse({
    ...input,
    socketedComponents: [...input.socketedComponents].sort((left, right) =>
      left.componentId.localeCompare(right.componentId),
    ),
  });
  return Object.freeze({ ...material, hash: contentHash(stableJson(material)) });
}

export function assertAssemblyRecipeIdentity(value: unknown): asserts value is AssemblyRecipe {
  const recipe = ASSEMBLY_RECIPE_SCHEMA.parse(value);
  const { hash, ...material } = recipe;
  if (hash !== contentHash(stableJson(material)))
    throw new Error("Assembly recipe identity is invalid");
}

function rotateVectorByQuaternion(
  v: WorldVector3,
  q: readonly [number, number, number, number],
): WorldVector3 {
  const [qx, qy, qz, qw] = q;
  const tx = 2 * (qy * v.z - qz * v.y);
  const ty = 2 * (qz * v.x - qx * v.z);
  const tz = 2 * (qx * v.y - qy * v.x);

  return {
    x: v.x + qw * tx + (qy * tz - qz * ty),
    y: v.y + qw * ty + (qz * tx - qx * tz),
    z: v.z + qw * tz + (qx * ty - qy * tx),
  };
}

function normalizeVector(v: WorldVector3): WorldVector3 {
  const len = Math.hypot(v.x, v.y, v.z);
  if (len <= 1e-12) return { x: 0, y: 1, z: 0 };
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

/**
 * Transforms an archetype's exposed modular planar surfaces into world-space ConstructedSurface records
 * when placed with a specific position and rotation quaternion.
 */
export function deriveConstructedSurfacesFromPlacement(input: {
  readonly archetype: ModularArchetypeSpecification;
  readonly placementId: string;
  readonly regionId: string;
  readonly position: WorldVector3;
  readonly rotation: readonly [number, number, number, number];
}): ConstructedSurface[] {
  const result: ConstructedSurface[] = [];
  for (const exposed of input.archetype.exposedSurfaces ?? []) {
    const rotatedLocalOrigin = rotateVectorByQuaternion(exposed.localOrigin, input.rotation);
    const worldOrigin: WorldVector3 = {
      x: input.position.x + rotatedLocalOrigin.x,
      y: input.position.y + rotatedLocalOrigin.y,
      z: input.position.z + rotatedLocalOrigin.z,
    };
    const worldUAxis = normalizeVector(rotateVectorByQuaternion(exposed.uAxis, input.rotation));
    const worldVAxis = normalizeVector(rotateVectorByQuaternion(exposed.vAxis, input.rotation));

    const surfaceId = `${input.placementId}_${exposed.surfaceSuffix}`.slice(0, 64);
    result.push(
      CONSTRUCTED_SURFACE_SCHEMA.parse({
        id: surfaceId,
        regionId: input.regionId,
        kind: exposed.kind,
        geometry: {
          kind: "planar_patch",
          origin: worldOrigin,
          uAxis: worldUAxis,
          vAxis: worldVAxis,
          uRange: exposed.uRange,
          vRange: exposed.vRange,
        },
        materialId: exposed.materialId,
        navigable: exposed.navigable,
      }),
    );
  }
  return result;
}
