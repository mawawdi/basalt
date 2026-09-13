import { z } from "zod";
import {
  COMPILATION_STATUS_SCHEMA,
  HASH_SCHEMA,
  Q32_32_SCHEMA,
  compareCanonicalStrings,
  contentHash,
  dequantizeQ32_32,
  deepFreezeJson,
  stableJson,
} from "@basalt/contracts";
import {
  CATALOG_AABB_FIXED_SCHEMA,
  CATALOG_VECTOR3_FIXED_SCHEMA,
  NONNEGATIVE_Q32_SCHEMA,
  POSITIVE_Q32_SCHEMA,
  canonicalUniqueStrings,
} from "./primitives.js";

const sourceArtifact = z
  .object({
    artifactHash: HASH_SCHEMA,
    bytes: z
      .number()
      .int()
      .positive()
      .max(512 * 1024 * 1024),
    mediaType: z.string().regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/u),
  })
  .strict();
const transform = z
  .object({
    position: CATALOG_VECTOR3_FIXED_SCHEMA,
    rotationQuaternion: z.tuple([Q32_32_SCHEMA, Q32_32_SCHEMA, Q32_32_SCHEMA, Q32_32_SCHEMA]),
    uniformScale: POSITIVE_Q32_SCHEMA,
  })
  .strict();

export const CATALOG_ASSET_ARTIFACT_SCHEMA = z
  .object({
    kind: z.literal("CatalogAssetArtifact"),
    assetId: z.string().regex(/^asset_[a-f0-9]{16,56}$/u),
    source: z
      .object({
        contentHash: HASH_SCHEMA,
        packageId: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/u),
        licenseId: z.string().trim().min(1).max(160),
        commercialUsePermitted: z.boolean(),
        redistributionPermitted: z.boolean(),
        attribution: z.string().max(2048),
        sourceArtifact: sourceArtifact.optional(),
      })
      .strict(),
    coordinateFrame: z
      .object({
        handedness: z.enum(["right_handed", "left_handed"]),
        up: z.enum(["+X", "-X", "+Y", "-Y", "+Z", "-Z"]),
        forward: z.enum(["+X", "-X", "+Y", "-Y", "+Z", "-Z"]),
        unitsToMeters: POSITIVE_Q32_SCHEMA,
        canonicalRoot: transform,
      })
      .strict(),
    bounds: CATALOG_AABB_FIXED_SCHEMA,
    parts: z
      .array(
        z
          .object({
            partId: z.string().min(1).max(128),
            contentHash: HASH_SCHEMA,
            role: z.enum(["render_static", "render_interactive", "collision_proxy"]),
            transform,
            bounds: CATALOG_AABB_FIXED_SCHEMA,
            triangleCount: z.number().int().nonnegative().max(20_000_000),
            materialHashes: z.array(HASH_SCHEMA).max(512),
          })
          .strict(),
      )
      .max(4096),
    materials: z
      .array(
        z
          .object({
            appearanceHash: HASH_SCHEMA,
            pbrChannels: z
              .array(
                z.enum([
                  "base_color",
                  "metallic_roughness",
                  "normal",
                  "occlusion",
                  "opacity",
                  "emissive",
                ]),
              )
              .max(6),
          })
          .strict(),
      )
      .max(512),
    support: z
      .object({
        primaryContact: z.enum(["bottom", "lateral_wall", "top_ceiling", "socket_only", "unknown"]),
        contactAreaSquareMeters: NONNEGATIVE_Q32_SCHEMA,
        evidenceHash: HASH_SCHEMA.optional(),
        refusalReason: z.string().trim().min(1).max(512).optional(),
      })
      .strict(),
    collision: z
      .object({
        mode: z.enum(["none", "companion", "part_obbs"]),
        companionAssetHashes: z.array(HASH_SCHEMA).max(128),
        orientedBounds: z
          .array(
            z
              .object({
                center: CATALOG_VECTOR3_FIXED_SCHEMA,
                halfSize: CATALOG_VECTOR3_FIXED_SCHEMA,
                rotation: z
                  .tuple([
                    z.number().finite(),
                    z.number().finite(),
                    z.number().finite(),
                    z.number().finite(),
                  ])
                  .refine(
                    (value) => Math.abs(Math.hypot(...value) - 1) <= 1e-6,
                    "Collision rotation must be normalized",
                  ),
              })
              .strict(),
          )
          .max(4096),
        evidenceHash: HASH_SCHEMA.optional(),
      })
      .strict(),
    sockets: z
      .array(
        z
          .object({
            socketId: z.string().min(1).max(128),
            localOriginMeters: CATALOG_VECTOR3_FIXED_SCHEMA,
            normal: CATALOG_VECTOR3_FIXED_SCHEMA,
            up: CATALOG_VECTOR3_FIXED_SCHEMA,
            boundaryRadiusMeters: NONNEGATIVE_Q32_SCHEMA,
            evidenceHash: HASH_SCHEMA,
          })
          .strict(),
      )
      .max(4096),
    socketMeasurementRefusal: z.string().trim().min(1).max(512).optional(),
    measurementEvidenceHashes: z.array(HASH_SCHEMA).max(4096),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    for (const [name, values] of [
      ["collision.companionAssetHashes", value.collision.companionAssetHashes],
      ["measurementEvidenceHashes", value.measurementEvidenceHashes],
    ] as const)
      if (stableJson(canonicalUniqueStrings(values, name)) !== stableJson(values))
        context.addIssue({
          code: "custom",
          path: name.split("."),
          message: `${name} must be canonical`,
        });
    if (
      value.parts.some((part) => part.role === "collision_proxy") &&
      value.collision.mode === "none"
    )
      context.addIssue({
        code: "custom",
        path: ["collision"],
        message: "Collision parts require collision evidence",
      });
    if (
      value.collision.mode === "none" &&
      (value.collision.companionAssetHashes.length > 0 || value.collision.evidenceHash)
    )
      context.addIssue({
        code: "custom",
        path: ["collision"],
        message: "Collision-free assets cannot carry collision evidence",
      });
    if (
      value.collision.mode === "companion" &&
      (value.collision.companionAssetHashes.length === 0 || !value.collision.evidenceHash)
    )
      context.addIssue({
        code: "custom",
        path: ["collision"],
        message: "Collision companions require exact evidence",
      });
    if (value.collision.mode === "part_obbs" && !value.collision.evidenceHash)
      context.addIssue({
        code: "custom",
        path: ["collision", "evidenceHash"],
        message: "Part OBBs require evidence",
      });
    if (value.collision.mode === "part_obbs" && value.collision.orientedBounds.length === 0)
      context.addIssue({
        code: "custom",
        path: ["collision", "orientedBounds"],
        message: "Part OBB collision requires measured oriented bounds",
      });
    if (value.collision.mode !== "part_obbs" && value.collision.orientedBounds.length > 0)
      context.addIssue({
        code: "custom",
        path: ["collision", "orientedBounds"],
        message: "Only part OBB collision may carry oriented bounds",
      });
    if (new Set(value.parts.map((part) => part.partId)).size !== value.parts.length)
      context.addIssue({ code: "custom", path: ["parts"], message: "Part IDs must be unique" });
    if (new Set(value.sockets.map((socket) => socket.socketId)).size !== value.sockets.length)
      context.addIssue({ code: "custom", path: ["sockets"], message: "Socket IDs must be unique" });
    if (axisDimension(value.coordinateFrame.up) === axisDimension(value.coordinateFrame.forward))
      context.addIssue({
        code: "custom",
        path: ["coordinateFrame"],
        message: "Up and forward axes must differ",
      });
    checkQuaternion(
      value.coordinateFrame.canonicalRoot.rotationQuaternion,
      ["coordinateFrame", "canonicalRoot"],
      context,
    );
    value.parts.forEach((part, index) =>
      checkQuaternion(part.transform.rotationQuaternion, ["parts", index, "transform"], context),
    );
    value.sockets.forEach((socket, index) => checkSocket(socket, index, context));
    if (value.support.primaryContact === "unknown" && !value.support.refusalReason)
      context.addIssue({
        code: "custom",
        path: ["support", "refusalReason"],
        message: "Unknown support requires a refusal reason",
      });
    if (value.sockets.length === 0 && !value.socketMeasurementRefusal)
      context.addIssue({
        code: "custom",
        path: ["socketMeasurementRefusal"],
        message: "Missing sockets require a refusal reason",
      });
    const { hash: _hash, ...material } = value;
    if (contentHash(stableJson(material)) !== value.hash)
      context.addIssue({ code: "custom", path: ["hash"], message: "Catalog asset hash mismatch" });
  });
export type CatalogAssetArtifact = z.output<typeof CATALOG_ASSET_ARTIFACT_SCHEMA>;

export const CATALOG_MEASUREMENT_DIAGNOSTIC_SCHEMA = z
  .object({ sourceContentHash: HASH_SCHEMA, reason: z.string().trim().min(1).max(1024) })
  .strict();
export const CATALOG_MEASUREMENT_SET_SCHEMA = z
  .object({
    kind: z.literal("CatalogMeasurementSet"),
    status: COMPILATION_STATUS_SCHEMA,
    sourceManifestHash: HASH_SCHEMA,
    assets: z.array(CATALOG_ASSET_ARTIFACT_SCHEMA).max(100_000),
    diagnostics: z.array(CATALOG_MEASUREMENT_DIAGNOSTIC_SCHEMA).max(100_000),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    const expectedStatus = value.diagnostics.length === 0 ? "eligible" : "incomplete";
    if (value.status !== expectedStatus)
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Measurement status does not match its diagnostics",
      });
    const measured = value.assets.map((asset) => asset.source.contentHash);
    const refused = value.diagnostics.map((entry) => entry.sourceContentHash);
    if (new Set(measured).size !== measured.length || new Set(refused).size !== refused.length)
      context.addIssue({ code: "custom", message: "Measurement identities must be unique" });
    if (measured.some((entry) => refused.includes(entry)))
      context.addIssue({ code: "custom", message: "A source cannot be measured and refused" });
    if (
      stableJson([...measured].sort(compareCanonicalStrings)) !== stableJson(measured) ||
      stableJson([...refused].sort(compareCanonicalStrings)) !== stableJson(refused)
    )
      context.addIssue({
        code: "custom",
        message: "Measurement results must use canonical source order",
      });
    const { hash: _hash, ...material } = value;
    if (contentHash(stableJson(material)) !== value.hash)
      context.addIssue({
        code: "custom",
        path: ["hash"],
        message: "Measurement set hash mismatch",
      });
  });
export type CatalogMeasurementSet = z.output<typeof CATALOG_MEASUREMENT_SET_SCHEMA>;
export type CatalogMeasurementDiagnostic = z.output<typeof CATALOG_MEASUREMENT_DIAGNOSTIC_SCHEMA>;

export function sealCatalogAssetArtifact(
  input: Omit<CatalogAssetArtifact, "kind" | "assetId" | "hash">,
): CatalogAssetArtifact {
  const sourceHash = HASH_SCHEMA.parse(input.source.contentHash);
  const material = {
    kind: "CatalogAssetArtifact" as const,
    assetId: `asset_${sourceHash.slice(0, 32)}`,
    ...input,
  };
  return deepFreezeJson(
    CATALOG_ASSET_ARTIFACT_SCHEMA.parse({
      ...material,
      hash: contentHash(stableJson(material)),
    }),
  ) as CatalogAssetArtifact;
}

export function sealCatalogMeasurementSet(input: {
  readonly sourceManifestHash: string;
  readonly assets: readonly CatalogAssetArtifact[];
  readonly diagnostics: readonly CatalogMeasurementDiagnostic[];
}): CatalogMeasurementSet {
  const assets = input.assets
    .map((entry) => CATALOG_ASSET_ARTIFACT_SCHEMA.parse(entry))
    .sort((a, b) => compareCanonicalStrings(a.source.contentHash, b.source.contentHash));
  const diagnostics = input.diagnostics
    .map((entry) => CATALOG_MEASUREMENT_DIAGNOSTIC_SCHEMA.parse(entry))
    .sort((a, b) => compareCanonicalStrings(a.sourceContentHash, b.sourceContentHash));
  const material = {
    kind: "CatalogMeasurementSet" as const,
    status: diagnostics.length === 0 ? ("eligible" as const) : ("incomplete" as const),
    sourceManifestHash: HASH_SCHEMA.parse(input.sourceManifestHash),
    assets,
    diagnostics,
  };
  return deepFreezeJson(
    CATALOG_MEASUREMENT_SET_SCHEMA.parse({
      ...material,
      hash: contentHash(stableJson(material)),
    }),
  ) as CatalogMeasurementSet;
}

function checkQuaternion(
  value: readonly string[],
  path: Array<string | number>,
  context: z.RefinementCtx,
): void {
  if (Math.abs(Math.hypot(...value.map(dequantizeQ32_32)) - 1) > 1e-6)
    context.addIssue({
      code: "custom",
      path,
      message: "Rotation quaternion must be normalized",
    });
}

function checkSocket(
  socket: CatalogAssetArtifact["sockets"][number],
  index: number,
  context: z.RefinementCtx,
): void {
  const normal = fixedVector(socket.normal);
  const up = fixedVector(socket.up);
  if (Math.abs(Math.hypot(normal.x, normal.y, normal.z) - 1) > 1e-6)
    context.addIssue({
      code: "custom",
      path: ["sockets", index, "normal"],
      message: "Socket normal must be unit length",
    });
  if (Math.abs(Math.hypot(up.x, up.y, up.z) - 1) > 1e-6)
    context.addIssue({
      code: "custom",
      path: ["sockets", index, "up"],
      message: "Socket up must be unit length",
    });
  if (Math.abs(normal.x * up.x + normal.y * up.y + normal.z * up.z) > 1e-6)
    context.addIssue({
      code: "custom",
      path: ["sockets", index],
      message: "Socket axes must be orthogonal",
    });
}

function fixedVector(value: z.output<typeof CATALOG_VECTOR3_FIXED_SCHEMA>) {
  return {
    x: dequantizeQ32_32(value.x),
    y: dequantizeQ32_32(value.y),
    z: dequantizeQ32_32(value.z),
  };
}

function axisDimension(axis: "+X" | "-X" | "+Y" | "-Y" | "+Z" | "-Z"): string {
  return axis.slice(1);
}
