import { z } from "zod";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import { compareSpatialStrings, entityId, hashSchema } from "../../spatial-core/src/primitives.js";
import {
  PLACEMENT_SURFACE_KINDS,
  PLACEMENT_SURFACE_KIND_SCHEMA,
  type PlacementSurfaceKind,
} from "../../world-planning/src/contracts.js";
import {
  PROCEDURAL_MATERIAL_GRAPH_SCHEMA,
  proceduralMaterialGraphPaletteBindings,
} from "./material-graph.js";
import { TRIM_SHEET_SPECIFICATION_SCHEMA } from "./trim-sheet.js";

export const ASSET_REQUIREMENT_ABI = "basalt-asset-requirement@8" as const;
export const ASSET_REQUIREMENT_INTENT_ABI = "basalt-asset-requirement-intent@11" as const;
export const ASSET_FACTORY_DESCRIPTOR_ABI = "basalt-asset-factory-descriptor@4" as const;
export const ASSET_FACTORY_QUALIFICATION_ABI = "basalt-asset-factory-qualification@2" as const;
export const ASSET_SOURCE_CANDIDATE_ABI = "basalt-asset-source-candidate@2" as const;
export const ADAPTED_ASSET_CANDIDATE_ABI = "basalt-adapted-asset-candidate@4" as const;
export const ASSET_REFERENCE_CATALOG_ABI = "basalt-asset-reference-catalog@2" as const;
export const ASSET_REFERENCE_VERIFICATION_ABI = "basalt-asset-reference-verification@1" as const;

/** Asset routes produce reusable objects; worlds and assemblies have separate compilers. */
export const ASSET_FORM_KINDS = ["object"] as const;
export const ASSET_FACTORY_ROUTES = ["neural_asset", "retrieval", "trusted_procedure"] as const;
/** One-shot neural geometry is reserved for small focal inserts. */
export const MAX_NEURAL_ASSET_BOUND_STUDS = 8.0 as const;
export const ASSET_ACQUISITION_CONTEXTS = [
  "micro_scatter",
  "structural_kit",
  "focal_insert",
  "ordinary_object",
] as const;
export const ASSET_OUTPUT_ROLES = [
  "render_static",
  "render_interactive",
  "collision_proxy",
] as const;
export const ASSET_EDIT_OPERATIONS = [
  "attach_to_socket",
  "replace_part_material",
  "rotate_part",
  "scale_part",
  "toggle_part_visibility",
  "translate_part",
] as const;
export const ASSET_MATERIAL_CLASSES = [
  "brick",
  "custom",
  "fabric",
  "foliage",
  "glass",
  "metal",
  "painted_surface",
  "plaster",
  "rock",
  "soil",
  "stone",
  "water",
  "wood",
] as const;
export const ASSET_FINISH_STYLES = ["realistic", "reference_matched", "stylized"] as const;
export const ASSET_NOVELTY_VALUES = ["reuse_ok", "unique", "variation_required"] as const;
export const ASSET_OBJECT_CONSTRUCTIONS = ["hard_surface", "mixed", "organic"] as const;
export const MAXIMUM_COLLISION_SUPPORT_PATCHES_PER_PART = 32;
export const MAXIMUM_COLLISION_SUPPORT_PATCHES_PER_CANDIDATE = 16_384;
export const MAXIMUM_ASSET_CONTACT_PATCHES_PER_PART = 32;
export const MAXIMUM_ASSET_CONTACT_PATCHES_PER_CANDIDATE = 16_384;
export const ASSET_SCALE_CLASSES = [
  "handheld",
  "human_prop",
  "furnishing",
  "architectural_module",
  "building",
  "landscape_feature",
] as const;

const finiteCoordinate = z.number().finite().min(-1_000_000).max(1_000_000);
const positive = z.number().finite().positive();
const positiveBounded = positive.max(1_000_000);
const semanticText = z.string().trim().min(1).max(1024);
const shortText = z.string().trim().min(1).max(160);
const contentHandle = z.string().trim().min(1).max(256);
const unitInterval = z.number().finite().min(0).max(1);
const semanticTag = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u);
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/u);

/** One shared style contract feeds world lowering and asset adaptation. */
export const ASSET_STYLE_CONTRACT_SCHEMA = z
  .object({
    id: entityId,
    shapeLanguage: z.string().trim().min(1).max(2048),
    silhouetteHierarchy: z
      .array(
        z
          .object({
            level: shortText,
            guidance: z.string().trim().min(1).max(1024),
          })
          .strict(),
      )
      .min(1)
      .max(8),
    detailScale: z
      .array(
        z
          .object({
            level: shortText,
            guidance: z.string().trim().min(1).max(1024),
          })
          .strict(),
      )
      .min(1)
      .max(8),
    edgeTreatment: z.string().trim().min(1).max(2048),
    materialLanguage: z.string().trim().min(1).max(2048),
    texelDensity: z
      .object({
        minimumPixelsPerStud: z.number().finite().positive().max(4096),
        targetPixelsPerStud: z.number().finite().positive().max(4096),
        maximumPixelsPerStud: z.number().finite().positive().max(4096),
      })
      .strict()
      .refine(
        (value) =>
          value.minimumPixelsPerStud <= value.targetPixelsPerStud &&
          value.targetPixelsPerStud <= value.maximumPixelsPerStud,
        "Style texel-density range must be ordered",
      ),
    surfaceVariation: z
      .object({
        scaleStuds: z.number().finite().positive().max(100_000),
        intensity: unitInterval,
        guidance: z.string().trim().min(1).max(1024),
      })
      .strict(),
    wearPolicy: z
      .object({
        amount: unitInterval,
        placement: z.string().trim().min(1).max(1024),
        exclusions: z.array(z.string().trim().min(1).max(256)).max(32),
      })
      .strict(),
    lightingIntent: z.string().trim().min(1).max(2048),
    antiGoals: z.array(z.string().trim().min(1).max(512)).max(16),
    palette: z
      .array(
        z
          .object({
            id: entityId,
            name: z.string().trim().min(1).max(160),
            color: hexColor,
            metallic: unitInterval,
            roughness: unitInterval,
            emissive: hexColor.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(32),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.palette.map((entry) => entry.id)).size !== value.palette.length)
      context.addIssue({
        code: "custom",
        path: ["palette"],
        message: "Style palette IDs must be unique",
      });
    const silhouetteLevels = value.silhouetteHierarchy.map((entry) => entry.level);
    if (new Set(silhouetteLevels).size !== silhouetteLevels.length)
      context.addIssue({
        code: "custom",
        path: ["silhouetteHierarchy"],
        message: "Silhouette hierarchy levels must be unique",
      });
    const detailLevels = value.detailScale.map((entry) => entry.level);
    if (new Set(detailLevels).size !== detailLevels.length)
      context.addIssue({
        code: "custom",
        path: ["detailScale"],
        message: "Detail-scale levels must be unique",
      });
  });
export type AssetStyleContract = z.infer<typeof ASSET_STYLE_CONTRACT_SCHEMA>;

export const BOUND_ASSET_STYLE_CONTRACT_SCHEMA = ASSET_STYLE_CONTRACT_SCHEMA.safeExtend({
  hash: hashSchema,
})
  .strict()
  .superRefine((value, context) => {
    const { hash, ...contract } = value;
    if (contentHash(stableJson(contract)) !== hash)
      context.addIssue({ code: "custom", path: ["hash"], message: "Style contract hash mismatch" });
  });
export type BoundAssetStyleContract = z.infer<typeof BOUND_ASSET_STYLE_CONTRACT_SCHEMA>;

export const ASSET_VECTOR3_SCHEMA = z
  .object({ x: finiteCoordinate, y: finiteCoordinate, z: finiteCoordinate })
  .strict();
export const ASSET_BOUNDS_SCHEMA = z
  .object({
    center: ASSET_VECTOR3_SCHEMA,
    size: ASSET_VECTOR3_SCHEMA.refine(
      ({ x, y, z }) => x > 0 && y > 0 && z > 0,
      "Asset bounds must be positive",
    ),
  })
  .strict();
export const ASSET_TRANSFORM_SCHEMA = z
  .object({
    position: ASSET_VECTOR3_SCHEMA,
    rotation: z
      .object({
        xDegrees: z.number().finite(),
        yDegrees: z.number().finite(),
        zDegrees: z.number().finite(),
      })
      .strict(),
    scale: ASSET_VECTOR3_SCHEMA.refine(
      ({ x, y, z }) => x > 0 && y > 0 && z > 0,
      "Asset transform scale must be positive",
    ),
  })
  .strict();

/**
 * One asset-level translation establishes the canonical support origin. Mesh
 * vertices, pivots, sockets, support samples, and collision geometry remain in
 * their declared mesh-local frames; subtracting this value from every part
 * placement moves the complete hierarchy into the canonical root exactly once.
 */
export const ASSET_CANONICAL_ROOT_SCHEMA = z
  .object({
    kind: z.literal("support_origin"),
    sourceSupportOrigin: ASSET_VECTOR3_SCHEMA,
    outputSupportOrigin: z.object({ x: z.literal(0), y: z.literal(0), z: z.literal(0) }).strict(),
    application: z.literal("subtract_once_from_part_placement_positions"),
  })
  .strict();

export const ASSET_JSON_ARTIFACT_REFERENCE_SCHEMA = z
  .object({
    locator: z.string().regex(/^artifacts\/[a-f0-9]{64}\.json$/u),
    artifactHash: hashSchema,
    bytes: z
      .number()
      .int()
      .positive()
      .max(16 * 1024 * 1024),
  })
  .strict()
  .refine(
    (value) => value.locator === `artifacts/${value.artifactHash}.json`,
    "JSON artifact locator must identify its exact hash",
  );
export const ASSET_BINARY_ARTIFACT_REFERENCE_SCHEMA = z
  .object({
    locator: z.string().regex(/^binary-artifacts\/[a-f0-9]{64}\.bin$/u),
    artifactHash: hashSchema,
    bytes: z
      .number()
      .int()
      .positive()
      .max(512 * 1024 * 1024),
    mediaType: z.string().regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u),
  })
  .strict()
  .refine(
    (value) => value.locator === `binary-artifacts/${value.artifactHash}.bin`,
    "Binary artifact locator must identify its exact hash",
  );
const glbArtifact = ASSET_BINARY_ARTIFACT_REFERENCE_SCHEMA.safeExtend({
  mediaType: z.literal("model/gltf-binary"),
}).strict();

const objectForm = z
  .object({
    kind: z.literal("object"),
    description: semanticText,
    construction: z.enum(ASSET_OBJECT_CONSTRUCTIONS),
    requiredFeatures: z.array(shortText).max(64),
    forbiddenFeatures: z.array(shortText).max(64),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.requiredFeatures).size !== value.requiredFeatures.length)
      context.addIssue({
        code: "custom",
        path: ["requiredFeatures"],
        message: "Required features must be unique",
      });
    if (new Set(value.forbiddenFeatures).size !== value.forbiddenFeatures.length)
      context.addIssue({
        code: "custom",
        path: ["forbiddenFeatures"],
        message: "Forbidden features must be unique",
      });
    const forbidden = new Set(value.forbiddenFeatures);
    if (value.requiredFeatures.some((feature) => forbidden.has(feature)))
      context.addIssue({
        code: "custom",
        path: ["forbiddenFeatures"],
        message: "An object feature cannot be both required and forbidden",
      });
  });

export const ASSET_FORM_SCHEMA = objectForm;

const surfaceBand = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("suppressed"), reason: shortText }).strict(),
  z
    .object({
      kind: z.literal("variation"),
      pattern: shortText,
      scaleStuds: positiveBounded,
      strength: unitInterval,
      description: shortText,
    })
    .strict(),
]);

const edgeTreatment = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("suppressed"), reason: shortText }).strict(),
  z
    .object({
      kind: z.literal("treated"),
      profile: shortText,
      widthStuds: positiveBounded,
      segments: z.number().int().min(1).max(8),
      strength: unitInterval,
      description: shortText,
    })
    .strict(),
]);

const contextualTreatment = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("suppressed"), reason: shortText }).strict(),
  z
    .object({
      kind: z.literal("applied"),
      effect: shortText,
      reachStuds: positiveBounded,
      strength: unitInterval,
      description: shortText,
    })
    .strict(),
]);

/**
 * Material adaptation is authored per semantic material role. A source may be
 * retained byte-for-value through the normalized texture bake, harmonized by
 * an exact declared amount, or replaced by a declared synthesized finish.
 * Palette lookup is therefore never inferred from a material class.
 */
export const ASSET_MATERIAL_ADAPTATION_POLICY_SCHEMA = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("preserve_source") }).strict(),
  z
    .object({
      kind: z.literal("harmonize"),
      paletteEntryId: entityId,
      strength: unitInterval,
    })
    .strict(),
  z
    .object({
      kind: z.literal("synthesize"),
      graph: PROCEDURAL_MATERIAL_GRAPH_SCHEMA,
    })
    .strict(),
]);
export type AssetMaterialAdaptationPolicy = z.infer<typeof ASSET_MATERIAL_ADAPTATION_POLICY_SCHEMA>;

/** Mesh shading and normal-map authorship are independent explicit choices. */
export const ASSET_SHADING_POLICY_SCHEMA = z
  .object({
    surfaceNormals: z.enum(["preserve_source", "flat", "smooth"]),
    normalTexture: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("preserve_source") }).strict(),
      z.object({ kind: z.literal("omit") }).strict(),
      z
        .object({
          kind: z.literal("synthesize"),
          strength: unitInterval,
        })
        .strict(),
    ]),
  })
  .strict();
export type AssetShadingPolicy = z.infer<typeof ASSET_SHADING_POLICY_SCHEMA>;

/**
 * Opacity is an explicit material decision. Texture-backed modes retain an
 * independently addressable source alpha image/channel (including the opacity
 * tensor on a mesh-attribute bundle); the fixed adapter bakes that authority
 * into the final glTF base-color alpha channel. A constant is useful for
 * intentionally translucent surfaces, but cannot satisfy a cutout mask.
 */
export const ASSET_OPACITY_POLICY_SCHEMA = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("opaque") }).strict(),
  z
    .object({
      kind: z.literal("mask"),
      source: z.literal("source_texture_or_attribute"),
      cutoff: unitInterval,
    })
    .strict(),
  z
    .object({
      kind: z.literal("blend"),
      source: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("source_texture_or_attribute") }).strict(),
        z.object({ kind: z.literal("constant"), alpha: unitInterval }).strict(),
      ]),
    })
    .strict(),
]);
export type AssetOpacityPolicy = z.infer<typeof ASSET_OPACITY_POLICY_SCHEMA>;

export const ASSET_SURFACE_INTENT_SCHEMA = z
  .object({
    materialRoles: z
      .array(
        z
          .object({
            id: entityId,
            description: semanticText,
            materialClass: z.enum(ASSET_MATERIAL_CLASSES),
            materialAdaptation: ASSET_MATERIAL_ADAPTATION_POLICY_SCHEMA,
            shading: ASSET_SHADING_POLICY_SCHEMA,
            opacity: ASSET_OPACITY_POLICY_SCHEMA,
            projection: z.discriminatedUnion("mode", [
              z
                .object({
                  mode: z.literal("mesh_uv"),
                  scaleStuds: z.object({ u: positiveBounded, v: positiveBounded }).strict(),
                })
                .strict(),
              z
                .object({
                  mode: z.literal("asset_planar"),
                  scaleStuds: z.object({ u: positiveBounded, v: positiveBounded }).strict(),
                  frame: z
                    .object({
                      origin: z.literal("canonical_asset_origin"),
                      uAxis: z.enum(["+X", "-X", "+Y", "-Y", "+Z", "-Z"]),
                      vAxis: z.enum(["+X", "-X", "+Y", "-Y", "+Z", "-Z"]),
                    })
                    .strict()
                    .refine(
                      ({ uAxis, vAxis }) => uAxis.slice(1) !== vAxis.slice(1),
                      "Asset-planar projection axes must be orthogonal",
                    ),
                })
                .strict(),
              z
                .object({
                  mode: z.literal("asset_triplanar"),
                  scaleStuds: z.object({ u: positiveBounded, v: positiveBounded }).strict(),
                  blendExponent: z.number().finite().min(1).max(32),
                })
                .strict(),
              z
                .object({
                  mode: z.literal("trim_hotspot"),
                  trimSheet: TRIM_SHEET_SPECIFICATION_SCHEMA,
                })
                .strict(),
            ]),
            variationBands: z
              .object({ macro: surfaceBand, meso: surfaceBand, micro: surfaceBand })
              .strict(),
            edgeTreatment,
            contextualTreatment: z
              .object({
                contact: contextualTreatment,
                upward: contextualTreatment,
                exposure: contextualTreatment,
              })
              .strict(),
          })
          .strict()
          .superRefine((value, context) => {
            if (
              value.materialAdaptation.kind === "synthesize" &&
              value.shading.normalTexture.kind === "synthesize" &&
              value.materialAdaptation.graph.outputs.normal.kind !== "height_gradient"
            )
              context.addIssue({
                code: "custom",
                path: ["materialAdaptation", "graph", "outputs", "normal"],
                message: "A synthesized normal texture requires an explicit material height output",
              });
            const present = [
              ["macro", value.variationBands.macro],
              ["meso", value.variationBands.meso],
              ["micro", value.variationBands.micro],
            ] as const;
            for (let index = 1; index < present.length; index += 1) {
              const larger = present[index - 1]!;
              const smaller = present[index]!;
              if (
                larger[1].kind === "variation" &&
                smaller[1].kind === "variation" &&
                larger[1].scaleStuds <= smaller[1].scaleStuds
              )
                context.addIssue({
                  code: "custom",
                  path: ["variationBands", smaller[0], "scaleStuds"],
                  message: "Surface variation bands must descend from macro to meso to micro scale",
                });
            }
          }),
      )
      .min(1)
      .max(64),
    finishStyle: z.enum(ASSET_FINISH_STYLES),
  })
  .strict()
  .superRefine((value, context) => {
    if (!isCanonicalById(value.materialRoles))
      context.addIssue({
        code: "custom",
        path: ["materialRoles"],
        message: "Surface material roles must be unique and canonical",
      });
  });

const assetDependencyDeclaration = z
  .object({ id: entityId, purpose: shortText, assetHandle: contentHandle })
  .strict();
const assetReferenceDeclaration = z
  .object({ id: entityId, purpose: shortText, referenceHandle: contentHandle })
  .strict();

export const ASSET_SURFACE_PLACEMENT_REQUIREMENT_SCHEMA = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z
    .object({
      kind: z.literal("surface_contact"),
      mode: z.enum(["resting", "embedded", "attached", "suspended"]),
      outwardNormal: ASSET_VECTOR3_SCHEMA.refine(
        ({ x, y, z }) => Math.abs(Math.hypot(x, y, z) - 1) <= 1e-3,
        "Required asset contact normal must be normalized",
      ),
      requiredSurfaceKinds: z
        .array(PLACEMENT_SURFACE_KIND_SCHEMA)
        .min(1)
        .max(PLACEMENT_SURFACE_KINDS.length),
    })
    .strict()
    .superRefine((value, context) => {
      if (!isCanonicalStrings(value.requiredSurfaceKinds))
        context.addIssue({
          code: "custom",
          path: ["requiredSurfaceKinds"],
          message: "Required placement surfaces must be unique and canonical",
        });
      const measurable = surfaceKindsForAssetContact(value.mode, value.outwardNormal);
      for (const kind of value.requiredSurfaceKinds)
        if (!measurable.includes(kind))
          context.addIssue({
            code: "custom",
            path: ["requiredSurfaceKinds"],
            message: `Required ${kind} surface conflicts with the declared contact mode and normal`,
          });
    }),
]);

const requiredAssetSocket = z
  .object({ id: entityId, type: shortText, purpose: shortText })
  .strict();

const requiredSemanticPart = z
  .object({
    id: entityId,
    name: shortText,
    semanticRole: shortText,
    role: z.enum(ASSET_OUTPUT_ROLES),
    pivot: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("not_required") }).strict(),
      z.object({ kind: z.literal("required"), purpose: shortText }).strict(),
    ]),
    sockets: z.array(requiredAssetSocket).max(128),
  })
  .strict()
  .superRefine((value, context) => {
    validateUniqueIds(value.sockets, context, ["sockets"]);
    if (!isCanonicalById(value.sockets))
      context.addIssue({
        code: "custom",
        path: ["sockets"],
        message: "Required sockets must be canonical by ID",
      });
  });

const assetPartSetRequirement = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("not_required") }).strict(),
  z
    .object({ kind: z.literal("required"), partIds: z.array(entityId).min(1).max(512) })
    .strict()
    .superRefine((value, context) => {
      if (!isCanonicalStrings(value.partIds))
        context.addIssue({
          code: "custom",
          path: ["partIds"],
          message: "Required part IDs must be unique and canonical",
        });
    }),
]);

const assetTransparencyRequirement = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("not_required") }).strict(),
  z.object({ kind: z.literal("forbidden") }).strict(),
  z
    .object({ kind: z.literal("required"), partIds: z.array(entityId).min(1).max(512) })
    .strict()
    .superRefine((value, context) => {
      if (!isCanonicalStrings(value.partIds))
        context.addIssue({
          code: "custom",
          path: ["partIds"],
          message: "Transparent part IDs must be unique and canonical",
        });
    }),
]);

export const ASSET_EDIT_OPERATION_REQUIREMENT_SCHEMA = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("attach_to_socket"),
      partId: entityId,
      socketId: entityId,
      purpose: shortText,
    })
    .strict(),
  ...(
    [
      "replace_part_material",
      "rotate_part",
      "scale_part",
      "toggle_part_visibility",
      "translate_part",
    ] as const
  ).map((kind) =>
    z.object({ kind: z.literal(kind), partId: entityId, purpose: shortText }).strict(),
  ),
]);

/**
 * Creator-requested functional output constraints. Subject identity stays open
 * vocabulary through names, semantic roles, purposes, and socket types; only
 * engine-level output and edit mechanics are closed and machine-verifiable.
 */
export const ASSET_OUTPUT_REQUIREMENTS_SCHEMA = z
  .object({
    roles: z.array(z.enum(ASSET_OUTPUT_ROLES)).min(1).max(ASSET_OUTPUT_ROLES.length),
    semanticParts: z.array(requiredSemanticPart).max(512),
    articulation: assetPartSetRequirement,
    transparency: assetTransparencyRequirement,
    collision: assetPartSetRequirement,
    editOperations: z.array(ASSET_EDIT_OPERATION_REQUIREMENT_SCHEMA).max(512),
  })
  .strict()
  .superRefine((value, context) => {
    if (!isCanonicalStrings(value.roles))
      context.addIssue({
        code: "custom",
        path: ["roles"],
        message: "Required output roles must be unique and canonical",
      });
    validateUniqueIds(value.semanticParts, context, ["semanticParts"]);
    if (!isCanonicalById(value.semanticParts))
      context.addIssue({
        code: "custom",
        path: ["semanticParts"],
        message: "Required semantic parts must be canonical by ID",
      });
    const parts = new Map(value.semanticParts.map((part) => [part.id, part] as const));
    for (const [index, part] of value.semanticParts.entries())
      if (!value.roles.includes(part.role))
        context.addIssue({
          code: "custom",
          path: ["semanticParts", index, "role"],
          message: "Required semantic part role is absent from required output roles",
        });
    for (const [field, requirement] of [
      ["articulation", value.articulation],
      ["collision", value.collision],
      ["transparency", value.transparency],
    ] as const) {
      if (requirement.kind !== "required") continue;
      for (const partId of requirement.partIds) {
        const part = parts.get(partId);
        if (!part)
          context.addIssue({
            code: "custom",
            path: [field, "partIds"],
            message: `${field} references an undeclared semantic part: ${partId}`,
          });
        else if (
          field === "articulation" &&
          (part.role !== "render_interactive" || part.pivot.kind !== "required")
        )
          context.addIssue({
            code: "custom",
            path: [field, "partIds"],
            message: `Articulated part must be interactive and require its pivot: ${partId}`,
          });
      }
    }
    const operationIdentities = value.editOperations.map(assetEditOperationIdentity);
    if (
      new Set(operationIdentities).size !== operationIdentities.length ||
      operationIdentities.some(
        (identity, index) => index > 0 && operationIdentities[index - 1]! >= identity,
      )
    )
      context.addIssue({
        code: "custom",
        path: ["editOperations"],
        message: "Required edit operations must be unique and canonical",
      });
    for (const [index, operation] of value.editOperations.entries()) {
      const part = parts.get(operation.partId);
      if (!part)
        context.addIssue({
          code: "custom",
          path: ["editOperations", index, "partId"],
          message: `Edit operation references an undeclared semantic part: ${operation.partId}`,
        });
      if (
        operation.kind === "attach_to_socket" &&
        !part?.sockets.some((socket) => socket.id === operation.socketId)
      )
        context.addIssue({
          code: "custom",
          path: ["editOperations", index, "socketId"],
          message: `Edit operation references an undeclared socket: ${operation.partId}/${operation.socketId}`,
        });
      if (operation.kind === "rotate_part" && part?.pivot.kind !== "required")
        context.addIssue({
          code: "custom",
          path: ["editOperations", index, "partId"],
          message: `Rotate operation requires a declared functional pivot: ${operation.partId}`,
        });
    }
  });
export type AssetOutputRequirements = z.infer<typeof ASSET_OUTPUT_REQUIREMENTS_SCHEMA>;

function assetEditOperationIdentity(
  operation: z.infer<typeof ASSET_EDIT_OPERATION_REQUIREMENT_SCHEMA>,
): string {
  return stableJson(
    operation.kind === "attach_to_socket"
      ? { kind: operation.kind, partId: operation.partId, socketId: operation.socketId }
      : { kind: operation.kind, partId: operation.partId },
  );
}

export const ASSET_REQUIREMENT_DECLARATION_SCHEMA = z
  .object({
    kind: z.literal("AssetRequirement"),
    abi: z.literal(ASSET_REQUIREMENT_ABI),
    id: entityId,
    name: shortText,
    semanticRole: shortText,
    importance: z.enum(["hero", "featured", "supporting"]),
    novelty: z.enum(ASSET_NOVELTY_VALUES),
    acquisitionContext: z.enum(ASSET_ACQUISITION_CONTEXTS).default("ordinary_object"),
    geometryLanguage: z.enum(["detailed_mesh", "explicit_primitive_aesthetic"]),
    surfacePlacement: ASSET_SURFACE_PLACEMENT_REQUIREMENT_SCHEMA,
    semanticTags: z.array(semanticTag).min(1).max(24),
    styleContractId: entityId,
    form: ASSET_FORM_SCHEMA,
    outputRequirements: ASSET_OUTPUT_REQUIREMENTS_SCHEMA,
    surfaceIntent: ASSET_SURFACE_INTENT_SCHEMA,
    delivery: z
      .object({
        scaleClass: z.enum(ASSET_SCALE_CLASSES),
        expectedBounds: ASSET_BOUNDS_SCHEMA,
        maximumUniqueTriangles: z.number().int().positive().max(2_000_000),
        maximumRenderedTriangles: z.number().int().positive().max(20_000_000),
        maximumParts: z.number().int().positive().max(512),
        maximumMaterials: z.number().int().positive().max(2048),
        maximumTextureEdge: z.number().int().positive().max(8192),
      })
      .strict()
      .superRefine((value, context) => {
        if (value.maximumUniqueTriangles > value.maximumRenderedTriangles)
          context.addIssue({
            code: "custom",
            message: "Unique triangle budget cannot exceed rendered triangle budget",
          });
      }),
    dependencies: z.array(assetDependencyDeclaration).max(256),
    references: z.array(assetReferenceDeclaration).max(64),
  })
  .strict()
  .superRefine((value, context) => {
    validateUniqueIds(value.dependencies, context, ["dependencies"]);
    validateUniqueIds(value.references, context, ["references"]);
    if (!isCanonicalStrings(value.semanticTags))
      context.addIssue({
        code: "custom",
        path: ["semanticTags"],
        message: "Asset semantic tags must be unique and canonical",
      });
    const dependencies = new Set(value.dependencies.map(({ id }) => id));
    const required = requiredDependencyIds(value.form);
    for (const id of required)
      if (!dependencies.has(id))
        context.addIssue({
          code: "custom",
          path: ["form"],
          message: `Asset form references an undeclared dependency: ${id}`,
        });
    const materialRoles = new Set(value.surfaceIntent.materialRoles.map(({ id }) => id));
    for (const id of requiredSurfaceRoleIds(value.form))
      if (!materialRoles.has(id))
        context.addIssue({
          code: "custom",
          path: ["form"],
          message: `Asset form references an undeclared surface material role: ${id}`,
        });
  });
export type AssetRequirementDeclaration = z.infer<typeof ASSET_REQUIREMENT_DECLARATION_SCHEMA>;
export type AssetForm = AssetRequirementDeclaration["form"];
export type AssetFormKind = AssetForm["kind"];

/**
 * One-shot neural geometry is deliberately a small focal-insert capability.
 * Macro structures, modular kits, and micro scatter must use procedures or
 * catalog families so a single malformed reconstruction cannot define a world.
 */
export function isNeuralAssetEligibleForDeclaration(input: unknown): boolean {
  const declaration = ASSET_REQUIREMENT_DECLARATION_SCHEMA.parse(input);
  return isNeuralAssetEligibleForBounds({
    acquisitionContext: declaration.acquisitionContext,
    boundsSize: declaration.delivery.expectedBounds.size,
  });
}

export function isNeuralAssetEligibleForBounds(input: {
  readonly acquisitionContext: (typeof ASSET_ACQUISITION_CONTEXTS)[number];
  readonly boundsSize: { readonly x: number; readonly y: number; readonly z: number };
}): boolean {
  const extents = [input.boundsSize.x, input.boundsSize.y, input.boundsSize.z];
  return (
    input.acquisitionContext === "focal_insert" &&
    extents.every((extent) => Number.isFinite(extent) && extent > 0) &&
    Math.max(...extents) <= MAX_NEURAL_ASSET_BOUND_STUDS
  );
}

const boundDependency = z
  .object({
    id: entityId,
    purpose: shortText,
    assetId: entityId,
    preparedAssetHash: hashSchema,
    manifestArtifact: ASSET_JSON_ARTIFACT_REFERENCE_SCHEMA,
  })
  .strict();

const assetReferenceArtifact = ASSET_BINARY_ARTIFACT_REFERENCE_SCHEMA.refine(
  (value) => value.mediaType === "image/png" || value.mediaType === "image/jpeg",
  "Asset references must be PNG or JPEG images",
);
const assetReferenceRights = z
  .object({
    usage: z.enum(["creator_owned", "commercial_use_permitted"]),
    evidenceArtifact: ASSET_BINARY_ARTIFACT_REFERENCE_SCHEMA.safeExtend({
      mediaType: z.literal("text/plain"),
    }).strict(),
  })
  .strict();
const assetReferenceScope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("project"), projectId: z.string().trim().min(1).max(256) }).strict(),
  z
    .object({
      kind: z.literal("creator_request"),
      projectId: z.string().trim().min(1).max(256),
      creatorRequestHash: hashSchema,
    })
    .strict(),
]);

/**
 * The exact creator-supplied catalog row retained inside an asset intent. The
 * generic authority has no generated-image branch: a generated reference must
 * cross a separately typed and qualified producer boundary before this ABI can
 * change.
 */
export const ASSET_REFERENCE_CATALOG_ENTRY_MATERIAL_SCHEMA = z
  .object({
    kind: z.literal("AssetReferenceCatalogEntry"),
    abi: z.literal(ASSET_REFERENCE_CATALOG_ABI),
    label: z.string().trim().min(1).max(256),
    scope: assetReferenceScope,
    origin: z.literal("creator_supplied"),
    artifact: assetReferenceArtifact,
    alpha: z.enum(["present", "absent"]),
    rights: assetReferenceRights,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.artifact.mediaType === "image/jpeg" && value.alpha !== "absent")
      context.addIssue({
        code: "custom",
        path: ["alpha"],
        message: "JPEG references cannot claim an alpha channel",
      });
  });

export const ASSET_REFERENCE_CATALOG_ENTRY_SCHEMA =
  ASSET_REFERENCE_CATALOG_ENTRY_MATERIAL_SCHEMA.safeExtend({
    hash: hashSchema,
    referenceHandle: z.string().regex(/^reference_[a-f0-9]{64}$/u),
  })
    .strict()
    .superRefine((value, context) => {
      const { hash, referenceHandle, ...material } = value;
      const expected = contentHash(stableJson(material));
      if (hash !== expected || referenceHandle !== `reference_${expected}`)
        context.addIssue({
          code: "custom",
          path: ["hash"],
          message: "Asset reference catalog entry identity mismatch",
        });
    });
export type AssetReferenceCatalogEntry = z.infer<typeof ASSET_REFERENCE_CATALOG_ENTRY_SCHEMA>;

const assetReferenceVerificationMaterial = z
  .object({
    kind: z.literal("AssetReferenceVerification"),
    abi: z.literal(ASSET_REFERENCE_VERIFICATION_ABI),
    authorityQualificationHash: hashSchema,
    catalogHash: hashSchema,
    catalogEntryHash: hashSchema,
    resolvedFor: z
      .object({
        projectId: z.string().trim().min(1).max(256),
        creatorRequestHash: hashSchema,
      })
      .strict(),
    image: z
      .object({
        artifactHash: hashSchema,
        mediaType: z.enum(["image/png", "image/jpeg"]),
        encoding: z.enum(["png_verified", "jpeg_verified"]),
        alpha: z.enum(["present", "absent"]),
      })
      .strict(),
    rights: z
      .object({
        evidenceArtifactHash: hashSchema,
        nonemptyNormalizedUtf8Verified: z.literal(true),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.authorityQualificationHash !== value.catalogHash)
      context.addIssue({
        code: "custom",
        path: ["authorityQualificationHash"],
        message: "Reference authority qualification must bind the exact catalog",
      });
    const expectedEncoding =
      value.image.mediaType === "image/png" ? "png_verified" : "jpeg_verified";
    if (value.image.encoding !== expectedEncoding)
      context.addIssue({
        code: "custom",
        path: ["image", "encoding"],
        message: "Reference verification encoding differs from its media type",
      });
  });

export const ASSET_REFERENCE_VERIFICATION_SCHEMA = assetReferenceVerificationMaterial
  .safeExtend({ hash: hashSchema })
  .strict()
  .superRefine((value, context) => {
    const { hash, ...material } = value;
    if (hash !== contentHash(stableJson(material)))
      context.addIssue({
        code: "custom",
        path: ["hash"],
        message: "Asset reference verification identity mismatch",
      });
  });
export type AssetReferenceVerification = z.infer<typeof ASSET_REFERENCE_VERIFICATION_SCHEMA>;

export function sealAssetReferenceVerification(
  input: z.input<typeof assetReferenceVerificationMaterial>,
): AssetReferenceVerification {
  const material = assetReferenceVerificationMaterial.parse(input);
  return ASSET_REFERENCE_VERIFICATION_SCHEMA.parse({
    ...material,
    hash: contentHash(stableJson(material)),
  });
}

export const ASSET_REFERENCE_RESOLUTION_SCHEMA = z
  .object({
    artifact: ASSET_BINARY_ARTIFACT_REFERENCE_SCHEMA,
    alpha: z.enum(["present", "absent"]),
    rights: assetReferenceRights,
    catalogEntry: ASSET_REFERENCE_CATALOG_ENTRY_SCHEMA,
    verification: ASSET_REFERENCE_VERIFICATION_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => validateAssetReferenceResolution(value, context));
export type AssetReferenceResolution = z.infer<typeof ASSET_REFERENCE_RESOLUTION_SCHEMA>;

export function assertAssetReferenceResolutionIdentity(
  value: unknown,
): asserts value is AssetReferenceResolution {
  ASSET_REFERENCE_RESOLUTION_SCHEMA.parse(value);
}

const boundReference = ASSET_REFERENCE_RESOLUTION_SCHEMA.safeExtend({
  id: entityId,
  purpose: shortText,
}).strict();

export const ASSET_REQUIREMENT_INTENT_MATERIAL_SCHEMA = z
  .object({
    kind: z.literal("AssetRequirementIntent"),
    abi: z.literal(ASSET_REQUIREMENT_INTENT_ABI),
    declaration: ASSET_REQUIREMENT_DECLARATION_SCHEMA,
    declarationHash: hashSchema,
    resolutionHash: hashSchema,
    projectId: z.string().trim().min(1).max(256),
    creatorRequestHash: hashSchema,
    styleContract: BOUND_ASSET_STYLE_CONTRACT_SCHEMA,
    dependencies: z.array(boundDependency).max(256),
    references: z.array(boundReference).max(64),
  })
  .strict()
  .superRefine((value, context) => validateIntentBindings(value, context));
export const ASSET_REQUIREMENT_INTENT_SCHEMA = ASSET_REQUIREMENT_INTENT_MATERIAL_SCHEMA.safeExtend({
  hash: hashSchema,
}).strict();
export type AssetRequirementIntent = z.infer<typeof ASSET_REQUIREMENT_INTENT_SCHEMA>;

export function sealAssetRequirementIntent(input: {
  declaration: unknown;
  projectId: string;
  creatorRequestHash: string;
  styleContract: AssetStyleContract;
  dependencies: readonly z.input<typeof boundDependency>[];
  references: readonly z.input<typeof boundReference>[];
}): AssetRequirementIntent {
  const declaration = ASSET_REQUIREMENT_DECLARATION_SCHEMA.parse(input.declaration);
  const dependencies = input.dependencies
    .map((dependency) => boundDependency.parse(dependency))
    .sort((left, right) => compareSpatialStrings(left.id, right.id));
  const references = input.references
    .map((reference) => boundReference.parse(reference))
    .sort((left, right) => compareSpatialStrings(left.id, right.id));
  const styleContractMaterial = ASSET_STYLE_CONTRACT_SCHEMA.parse(input.styleContract);
  const styleContract = BOUND_ASSET_STYLE_CONTRACT_SCHEMA.parse({
    ...styleContractMaterial,
    hash: contentHash(stableJson(styleContractMaterial)),
  });
  const declarationHash = contentHash(stableJson(declaration));
  const resolutionHash = contentHash(
    stableJson({
      declarationHash,
      styleContractHash: styleContract.hash,
      dependencies: dependencies.map(({ id, preparedAssetHash }) => ({ id, preparedAssetHash })),
      references: references.map(assetReferenceResolutionBindingMaterial),
    }),
  );
  const material = ASSET_REQUIREMENT_INTENT_MATERIAL_SCHEMA.parse({
    kind: "AssetRequirementIntent",
    abi: ASSET_REQUIREMENT_INTENT_ABI,
    declaration,
    declarationHash,
    resolutionHash,
    projectId: input.projectId,
    creatorRequestHash: input.creatorRequestHash,
    styleContract,
    dependencies,
    references,
  });
  return ASSET_REQUIREMENT_INTENT_SCHEMA.parse({
    ...material,
    hash: contentHash(stableJson(material)),
  });
}

export function assertAssetRequirementIntentIdentity(
  value: unknown,
): asserts value is AssetRequirementIntent {
  const intent = ASSET_REQUIREMENT_INTENT_SCHEMA.parse(value);
  const { hash, ...material } = intent;
  if (contentHash(stableJson(material)) !== hash)
    throw new Error("Asset requirement intent identity is invalid");
  if (contentHash(stableJson(intent.declaration)) !== intent.declarationHash)
    throw new Error("Asset requirement declaration identity is invalid");
  const expectedResolutionHash = contentHash(
    stableJson({
      declarationHash: intent.declarationHash,
      styleContractHash: intent.styleContract.hash,
      dependencies: intent.dependencies.map(({ id, preparedAssetHash }) => ({
        id,
        preparedAssetHash,
      })),
      references: intent.references.map(assetReferenceResolutionBindingMaterial),
    }),
  );
  if (expectedResolutionHash !== intent.resolutionHash)
    throw new Error("Asset requirement resolution identity is invalid");
}

const descriptorCommon = {
  kind: z.literal("AssetFactoryDescriptor"),
  abi: z.literal(ASSET_FACTORY_DESCRIPTOR_ABI),
  id: entityId,
  revisionHash: hashSchema,
  acceptedForms: z.array(z.enum(ASSET_FORM_KINDS)).min(1).max(ASSET_FORM_KINDS.length),
  parameterContract: z
    .object({ abi: z.string().trim().min(1).max(160), jsonSchemaHash: hashSchema })
    .strict(),
  acceptsPreparedDependencies: z.boolean(),
  maximumInputAssets: z.number().int().nonnegative().max(512),
  referenceContract: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("none") }).strict(),
    z
      .object({
        kind: z.literal("bounded"),
        minimumArtifacts: z.number().int().nonnegative().max(64),
        maximumArtifacts: z.number().int().positive().max(64),
        mediaTypes: z
          .array(z.string().regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u))
          .min(1)
          .max(16),
        rightsBinding: z.literal("required"),
        alphaPolicy: z.enum(["allowed", "required", "forbidden"]),
      })
      .strict()
      .refine((value) => value.minimumArtifacts <= value.maximumArtifacts, {
        message: "Reference minimum cannot exceed its maximum",
      }),
  ]),
  maximumOutputBytes: z
    .number()
    .int()
    .positive()
    .max(2 * 1024 * 1024 * 1024),
  semanticCapabilities: z
    .object({
      semanticCoverage: z.discriminatedUnion("kind", [
        z
          .object({ kind: z.literal("closed_set"), tags: z.array(semanticTag).min(1).max(256) })
          .strict(),
        z.object({ kind: z.literal("open_vocab") }).strict(),
      ]),
      objectConstructions: z.array(z.enum(ASSET_OBJECT_CONSTRUCTIONS)).max(3),
      materialClasses: z
        .array(z.enum(ASSET_MATERIAL_CLASSES))
        .min(1)
        .max(ASSET_MATERIAL_CLASSES.length),
      finishStyles: z.array(z.enum(ASSET_FINISH_STYLES)).min(1).max(ASSET_FINISH_STYLES.length),
      novelty: z.array(z.enum(ASSET_NOVELTY_VALUES)).min(1).max(ASSET_NOVELTY_VALUES.length),
    })
    .strict(),
  outputCapabilities: z
    .object({
      roles: z.array(z.enum(ASSET_OUTPUT_ROLES)).min(1).max(ASSET_OUTPUT_ROLES.length),
      namedSemanticParts: z.boolean(),
      pivots: z.boolean(),
      articulatedParts: z.boolean(),
      sockets: z.boolean(),
      transparency: z.boolean(),
      collision: z.boolean(),
      editOperations: z.array(z.enum(ASSET_EDIT_OPERATIONS)).max(ASSET_EDIT_OPERATIONS.length),
    })
    .strict(),
};

const trustedProcedureDescriptor = z
  .object({
    ...descriptorCommon,
    route: z.literal("trusted_procedure"),
    determinism: z.enum(["deterministic", "seeded"]),
    executionClass: z.enum(["trusted_host_composition", "trusted_local_blender"]),
  })
  .strict();
const retrievalDescriptor = z
  .object({
    ...descriptorCommon,
    route: z.literal("retrieval"),
    determinism: z.literal("deterministic"),
    executionClass: z.literal("remote_retrieval"),
  })
  .strict();
const neuralDescriptor = z
  .object({
    ...descriptorCommon,
    route: z.literal("neural_asset"),
    determinism: z.literal("nondeterministic"),
    executionClass: z.literal("remote_neural_asset"),
  })
  .strict();

export const ASSET_FACTORY_DESCRIPTOR_MATERIAL_SCHEMA = z
  .discriminatedUnion("route", [trustedProcedureDescriptor, retrievalDescriptor, neuralDescriptor])
  .superRefine((value, context) => {
    validateDescriptorCanonical(value, context);
  });
export const ASSET_FACTORY_DESCRIPTOR_SCHEMA = z
  .discriminatedUnion("route", [
    trustedProcedureDescriptor.extend({ hash: hashSchema }).strict(),
    retrievalDescriptor.extend({ hash: hashSchema }).strict(),
    neuralDescriptor.extend({ hash: hashSchema }).strict(),
  ])
  .superRefine((value, context) => {
    validateDescriptorCanonical(value, context);
  });
export type AssetFactoryDescriptor = z.infer<typeof ASSET_FACTORY_DESCRIPTOR_SCHEMA>;
export type AssetFactoryRoute = AssetFactoryDescriptor["route"];

export function sealAssetFactoryDescriptor(
  input: z.input<typeof ASSET_FACTORY_DESCRIPTOR_MATERIAL_SCHEMA>,
): AssetFactoryDescriptor {
  const material = ASSET_FACTORY_DESCRIPTOR_MATERIAL_SCHEMA.parse({
    ...input,
    acceptedForms: [...input.acceptedForms].sort(compareSpatialStrings),
    referenceContract:
      input.referenceContract.kind === "bounded"
        ? {
            ...input.referenceContract,
            mediaTypes: [...input.referenceContract.mediaTypes].sort(compareSpatialStrings),
          }
        : input.referenceContract,
    semanticCapabilities: {
      ...input.semanticCapabilities,
      semanticCoverage:
        input.semanticCapabilities.semanticCoverage.kind === "closed_set"
          ? {
              kind: "closed_set" as const,
              tags: [...input.semanticCapabilities.semanticCoverage.tags].sort(
                compareSpatialStrings,
              ),
            }
          : input.semanticCapabilities.semanticCoverage,
      objectConstructions: [...input.semanticCapabilities.objectConstructions].sort(
        compareSpatialStrings,
      ),
      materialClasses: [...input.semanticCapabilities.materialClasses].sort(compareSpatialStrings),
      finishStyles: [...input.semanticCapabilities.finishStyles].sort(compareSpatialStrings),
      novelty: [...input.semanticCapabilities.novelty].sort(compareSpatialStrings),
    },
    outputCapabilities: {
      ...input.outputCapabilities,
      roles: [...input.outputCapabilities.roles].sort(compareSpatialStrings),
      editOperations: [...input.outputCapabilities.editOperations].sort(compareSpatialStrings),
    },
  });
  return ASSET_FACTORY_DESCRIPTOR_SCHEMA.parse({
    ...material,
    hash: contentHash(stableJson(material)),
  });
}

export function assertAssetFactoryDescriptorIdentity(
  value: unknown,
): asserts value is AssetFactoryDescriptor {
  const descriptor = ASSET_FACTORY_DESCRIPTOR_SCHEMA.parse(value);
  const { hash, ...material } = descriptor;
  if (contentHash(stableJson(material)) !== hash)
    throw new Error("Asset factory descriptor identity is invalid");
}

const qualificationCommon = {
  kind: z.literal("AssetFactoryQualification"),
  abi: z.literal(ASSET_FACTORY_QUALIFICATION_ABI),
  factoryId: entityId,
  factoryRevisionHash: hashSchema,
  parameterSchemaHash: hashSchema,
  executionIdentityHash: hashSchema,
  dependencyInventoryHash: hashSchema,
  probeEvidenceArtifact: ASSET_JSON_ARTIFACT_REFERENCE_SCHEMA,
  qualifiedAt: z.string().datetime({ offset: true }),
  status: z.literal("eligible"),
};

const trustedLocalBlenderQualification = z
  .object({
    ...qualificationCommon,
    route: z.literal("trusted_procedure"),
    executionClass: z.literal("trusted_local_blender"),
    workerSha256: hashSchema,
    blenderQualificationHash: hashSchema,
  })
  .strict();
const trustedHostCompositionQualification = z
  .object({
    ...qualificationCommon,
    route: z.literal("trusted_procedure"),
    executionClass: z.literal("trusted_host_composition"),
    hostModuleSha256: hashSchema,
  })
  .strict();
const retrievalQualification = z
  .object({
    ...qualificationCommon,
    route: z.literal("retrieval"),
    executionClass: z.literal("remote_retrieval"),
    registrySnapshotHash: hashSchema,
    rightsPolicyHash: hashSchema,
  })
  .strict();
const neuralQualification = z
  .object({
    ...qualificationCommon,
    route: z.literal("neural_asset"),
    executionClass: z.literal("remote_neural_asset"),
    adapterId: entityId,
    adapterRevisionHash: hashSchema,
    adapterSha256: hashSchema,
    runtimeImageHash: hashSchema,
    modelIdentityHash: hashSchema,
    postprocessorIdentityHash: hashSchema,
    termsSnapshotHash: hashSchema,
    egressPolicyHash: hashSchema,
    inputPolicyHash: hashSchema,
  })
  .strict();

export const ASSET_FACTORY_QUALIFICATION_MATERIAL_SCHEMA = z.union([
  trustedLocalBlenderQualification,
  trustedHostCompositionQualification,
  retrievalQualification,
  neuralQualification,
]);
export const ASSET_FACTORY_QUALIFICATION_SCHEMA = z.union([
  trustedLocalBlenderQualification.extend({ hash: hashSchema }).strict(),
  trustedHostCompositionQualification.extend({ hash: hashSchema }).strict(),
  retrievalQualification.extend({ hash: hashSchema }).strict(),
  neuralQualification.extend({ hash: hashSchema }).strict(),
]);
export type AssetFactoryQualification = z.infer<typeof ASSET_FACTORY_QUALIFICATION_SCHEMA>;

export function sealAssetFactoryQualification(
  input: z.input<typeof ASSET_FACTORY_QUALIFICATION_MATERIAL_SCHEMA>,
): AssetFactoryQualification {
  const material = ASSET_FACTORY_QUALIFICATION_MATERIAL_SCHEMA.parse(input);
  return ASSET_FACTORY_QUALIFICATION_SCHEMA.parse({
    ...material,
    hash: contentHash(stableJson(material)),
  });
}

export function assertAssetFactoryQualificationIdentity(
  value: unknown,
): asserts value is AssetFactoryQualification {
  const qualification = ASSET_FACTORY_QUALIFICATION_SCHEMA.parse(value);
  const { hash, ...material } = qualification;
  if (contentHash(stableJson(material)) !== hash)
    throw new Error("Asset factory qualification identity is invalid");
}

export const ASSET_RIGHTS_CLAIM_SCHEMA = z
  .object({
    id: entityId,
    sourceLabel: shortText,
    licenseId: shortText,
    usage: z.enum(["creator_owned", "commercial_use_permitted", "research_only"]),
    attribution: z.string().max(2048),
    evidenceArtifact: ASSET_BINARY_ARTIFACT_REFERENCE_SCHEMA,
  })
  .strict();

const retrievalOrigin = z
  .object({
    kind: z.literal("retrieval"),
    factoryId: entityId,
    factoryRevisionHash: hashSchema,
    qualificationHash: hashSchema,
    registrySnapshotHash: hashSchema,
    recordId: z.string().trim().min(1).max(512),
    sourceArtifactHash: hashSchema,
    metadataArtifact: ASSET_JSON_ARTIFACT_REFERENCE_SCHEMA,
    licenseSnapshotArtifact: ASSET_BINARY_ARTIFACT_REFERENCE_SCHEMA,
  })
  .strict();
const trustedProcedureOrigin = z
  .object({
    kind: z.literal("trusted_procedure"),
    factoryId: entityId,
    factoryRevisionHash: hashSchema,
    qualificationHash: hashSchema,
    parametersHash: hashSchema,
    inputPreparedAssetHashes: z.array(hashSchema).max(512),
    sourceArtifactHashes: z.array(hashSchema).max(4096),
  })
  .strict()
  .superRefine((value, context) => {
    validateCanonicalHashes(value.inputPreparedAssetHashes, context, ["inputPreparedAssetHashes"]);
    validateCanonicalHashes(value.sourceArtifactHashes, context, ["sourceArtifactHashes"]);
  });
const neuralAssetOrigin = z
  .object({
    kind: z.literal("neural_asset"),
    factoryId: entityId,
    factoryRevisionHash: hashSchema,
    adapterId: entityId,
    adapterRevisionHash: hashSchema,
    qualificationHash: hashSchema,
    adapterSha256: hashSchema,
    runtimeImageHash: hashSchema,
    modelIdentityHash: hashSchema,
    postprocessorIdentityHash: hashSchema,
    dependencyInventoryHash: hashSchema,
    termsSnapshotHash: hashSchema,
    egressPolicyHash: hashSchema,
    inputPolicyHash: hashSchema,
    attemptId: entityId,
    requestArtifact: ASSET_JSON_ARTIFACT_REFERENCE_SCHEMA,
    responseReceiptArtifact: ASSET_JSON_ARTIFACT_REFERENCE_SCHEMA,
    termsSnapshotArtifact: ASSET_BINARY_ARTIFACT_REFERENCE_SCHEMA,
    referenceArtifactHashes: z.array(hashSchema).max(64),
  })
  .strict()
  .superRefine((value, context) => {
    validateCanonicalHashes(value.referenceArtifactHashes, context, ["referenceArtifactHashes"]);
    if (value.termsSnapshotArtifact.artifactHash !== value.termsSnapshotHash)
      context.addIssue({
        code: "custom",
        path: ["termsSnapshotHash"],
        message: "Neural terms identity must name the retained terms snapshot",
      });
  });

export const ASSET_SOURCE_LINEAGE_SCHEMA = z.discriminatedUnion("kind", [
  retrievalOrigin,
  trustedProcedureOrigin,
  neuralAssetOrigin,
]);
export type AssetSourceLineage = z.infer<typeof ASSET_SOURCE_LINEAGE_SCHEMA>;

export const SOURCE_TRANSFORM_OWNERSHIP_SCHEMA = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("already_baked"),
      coordinateFrame: z.literal("gltf-y-up-asset-units"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("requires_bake"),
      coordinateFrame: z.string().trim().min(1).max(160),
      sourceToCanonicalMatrixColumnMajor: z.array(z.number().finite()).length(16),
    })
    .strict()
    .superRefine((value, context) => {
      const matrix = value.sourceToCanonicalMatrixColumnMajor;
      if (matrix[3] !== 0 || matrix[7] !== 0 || matrix[11] !== 0 || matrix[15] !== 1)
        context.addIssue({
          code: "custom",
          path: ["sourceToCanonicalMatrixColumnMajor"],
          message: "Source-to-canonical transform must be an affine column-major matrix",
        });
      const determinant =
        matrix[0]! * (matrix[5]! * matrix[10]! - matrix[9]! * matrix[6]!) -
        matrix[4]! * (matrix[1]! * matrix[10]! - matrix[9]! * matrix[2]!) +
        matrix[8]! * (matrix[1]! * matrix[6]! - matrix[5]! * matrix[2]!);
      if (Math.abs(determinant) < 1e-12)
        context.addIssue({
          code: "custom",
          path: ["sourceToCanonicalMatrixColumnMajor"],
          message: "Source-to-canonical transform must be invertible",
        });
    }),
]);

const sourceGeometryCommon = {
  id: entityId,
  transformOwnership: SOURCE_TRANSFORM_OWNERSHIP_SCHEMA,
};

export const SOURCE_ASSET_GEOMETRY_SCHEMA = z.discriminatedUnion("kind", [
  z
    .object({
      ...sourceGeometryCommon,
      kind: z.literal("glb_node"),
      artifact: glbArtifact,
      nodeName: z.string().trim().min(1).max(256),
    })
    .strict(),
  z
    .object({
      ...sourceGeometryCommon,
      kind: z.literal("prepared_mesh"),
      sourcePreparedAssetHash: hashSchema,
      sourceMeshId: entityId,
      artifact: glbArtifact,
      nodeName: z.string().trim().min(1).max(256),
    })
    .strict(),
  z
    .object({
      ...sourceGeometryCommon,
      kind: z.literal("mesh_attribute_bundle"),
      artifact: ASSET_BINARY_ARTIFACT_REFERENCE_SCHEMA.safeExtend({
        mediaType: z.literal("application/x-safetensors"),
      }).strict(),
      tensorSchemaHash: hashSchema,
    })
    .strict(),
]);
export type SourceAssetGeometry = z.infer<typeof SOURCE_ASSET_GEOMETRY_SCHEMA>;

export const ASSET_CONTACT_PATCH_SCHEMA = z
  .object({
    polygon: z.tuple([ASSET_VECTOR3_SCHEMA, ASSET_VECTOR3_SCHEMA, ASSET_VECTOR3_SCHEMA]),
    outwardNormal: ASSET_VECTOR3_SCHEMA.refine(
      ({ x, y, z }) => Math.abs(Math.hypot(x, y, z) - 1) <= 1e-3,
      "Asset contact-patch normal must be normalized",
    ),
    contactSamples: z.array(ASSET_VECTOR3_SCHEMA).min(1).max(4),
  })
  .strict()
  .superRefine((value, context) => {
    const [first, second, third] = value.polygon;
    const ab = subtractAssetVectors(second, first);
    const ac = subtractAssetVectors(third, first);
    const cross = {
      x: ab.y * ac.z - ab.z * ac.y,
      y: ab.z * ac.x - ab.x * ac.z,
      z: ab.x * ac.y - ab.y * ac.x,
    };
    const magnitude = Math.hypot(cross.x, cross.y, cross.z);
    if (magnitude <= 1e-8)
      context.addIssue({
        code: "custom",
        path: ["polygon"],
        message: "Asset contact patch must have nonzero area",
      });
    else if (
      (cross.x * value.outwardNormal.x +
        cross.y * value.outwardNormal.y +
        cross.z * value.outwardNormal.z) /
        magnitude <
      0.999
    )
      context.addIssue({
        code: "custom",
        path: ["outwardNormal"],
        message: "Asset contact-patch winding and normal disagree",
      });
    const rotations = [value.polygon, [second, third, first], [third, first, second]];
    if (stableJson(value.polygon) !== rotations.map(stableJson).sort(compareSpatialStrings)[0])
      context.addIssue({
        code: "custom",
        path: ["polygon"],
        message: "Asset contact-patch vertices must use canonical cyclic order",
      });
    const sampleIdentities = value.contactSamples.map(stableJson);
    if (
      new Set(sampleIdentities).size !== sampleIdentities.length ||
      sampleIdentities.some(
        (identity, index) => index > 0 && sampleIdentities[index - 1]! >= identity,
      )
    )
      context.addIssue({
        code: "custom",
        path: ["contactSamples"],
        message: "Asset contact samples must be unique and canonical",
      });
    if (
      magnitude > 1e-8 &&
      value.contactSamples.some(
        (sample) =>
          Math.abs(
            (sample.x - first.x) * value.outwardNormal.x +
              (sample.y - first.y) * value.outwardNormal.y +
              (sample.z - first.z) * value.outwardNormal.z,
          ) > 1e-5 || !assetPointInsideTriangle(sample, value.polygon, value.outwardNormal),
      )
    )
      context.addIssue({
        code: "custom",
        path: ["contactSamples"],
        message: "Asset contact samples must lie on their exact topology patch",
      });
  });

export const ASSET_SUPPORT_GEOMETRY_SCHEMA = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none"), reason: shortText }).strict(),
  z
    .object({
      kind: z.literal("surface_contact"),
      coordinateSpace: z.literal("asset_local"),
      mode: z.enum(["resting", "embedded", "attached", "suspended"]),
      contactPatches: z
        .array(ASSET_CONTACT_PATCH_SCHEMA)
        .min(1)
        .max(MAXIMUM_ASSET_CONTACT_PATCHES_PER_PART),
    })
    .strict()
    .superRefine((value, context) => {
      const identities = value.contactPatches.map(stableJson);
      if (
        new Set(identities).size !== identities.length ||
        identities.some((identity, index) => index > 0 && identities[index - 1]! >= identity)
      )
        context.addIssue({
          code: "custom",
          path: ["contactPatches"],
          message: "Asset contact patches must be unique and canonical",
        });
      if (
        (value.mode === "resting" || value.mode === "embedded") &&
        value.contactPatches.some((patch) => patch.outwardNormal.y >= -1e-5)
      )
        context.addIssue({
          code: "custom",
          path: ["contactPatches"],
          message: "Resting and embedded contact patches must face canonical -Y",
        });
    }),
]);

const UPWARD_PLACEMENT_SURFACE_KINDS = PLACEMENT_SURFACE_KINDS.filter(
  (kind): kind is Exclude<PlacementSurfaceKind, "ceiling" | "wall"> =>
    kind !== "ceiling" && kind !== "wall",
);

/**
 * Derive physical placement compatibility from retained contact orientation and
 * support mode. Semantic source-route claims are deliberately absent from this
 * calculation. Resting and embedded contacts can follow any upward-facing
 * indexed surface. Attached contacts use the measured contact side. Suspended
 * contacts qualify only for an overhead surface.
 */
export function deriveMeasuredAssetSurfaceKinds(
  support: z.infer<typeof ASSET_SUPPORT_GEOMETRY_SCHEMA>,
): PlacementSurfaceKind[] {
  if (support.kind === "none") return [];
  const compatible: PlacementSurfaceKind[][] = support.contactPatches.map(({ outwardNormal }) =>
    surfaceKindsForAssetContact(support.mode, outwardNormal),
  );
  return PLACEMENT_SURFACE_KINDS.filter((kind) =>
    compatible.every((kinds) => kinds.includes(kind)),
  );
}

function surfaceKindsForAssetContact(
  mode: "resting" | "embedded" | "attached" | "suspended",
  outwardNormal: { readonly x: number; readonly y: number; readonly z: number },
): PlacementSurfaceKind[] {
  if (mode === "resting" || mode === "embedded")
    return outwardNormal.y < -1e-5 ? [...UPWARD_PLACEMENT_SURFACE_KINDS] : [];
  if (mode === "suspended") return outwardNormal.y > 1e-5 ? ["ceiling"] : [];
  if (outwardNormal.y < -1e-5) return [...UPWARD_PLACEMENT_SURFACE_KINDS];
  if (outwardNormal.y > 1e-5) return ["ceiling"];
  return ["wall"];
}

export const ASSET_COLLISION_HINT_SCHEMA = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none"), reason: shortText }).strict(),
  z.object({ kind: z.enum(["convex_hull", "mesh"]), meshId: entityId }).strict(),
]);

export const ASSET_COLLISION_SUPPORT_PATCH_SCHEMA = z
  .object({
    polygon: z.tuple([ASSET_VECTOR3_SCHEMA, ASSET_VECTOR3_SCHEMA, ASSET_VECTOR3_SCHEMA]),
    normal: ASSET_VECTOR3_SCHEMA.refine(
      ({ x, y, z }) => Math.abs(Math.hypot(x, y, z) - 1) <= 1e-3,
      "Collision support-patch normal must be normalized",
    ),
  })
  .strict()
  .superRefine((value, context) => {
    const [first, second, third] = value.polygon;
    const ab = subtractAssetVectors(second, first);
    const ac = subtractAssetVectors(third, first);
    const cross = {
      x: ab.y * ac.z - ab.z * ac.y,
      y: ab.z * ac.x - ab.x * ac.z,
      z: ab.x * ac.y - ab.y * ac.x,
    };
    const magnitude = Math.hypot(cross.x, cross.y, cross.z);
    if (magnitude <= 1e-8)
      context.addIssue({
        code: "custom",
        path: ["polygon"],
        message: "Collision support patch must have nonzero area",
      });
    else if (
      (cross.x * value.normal.x + cross.y * value.normal.y + cross.z * value.normal.z) / magnitude <
      0.999
    )
      context.addIssue({
        code: "custom",
        path: ["normal"],
        message: "Collision support patch winding and normal disagree",
      });
    if (value.normal.y <= 1e-5)
      context.addIssue({
        code: "custom",
        path: ["normal"],
        message: "Collision support patch must face canonical +Y",
      });
    const rotations = [value.polygon, [second, third, first], [third, first, second]];
    if (stableJson(value.polygon) !== rotations.map(stableJson).sort(compareSpatialStrings)[0])
      context.addIssue({
        code: "custom",
        path: ["polygon"],
        message: "Collision support patch vertices must use canonical cyclic order",
      });
  });

export const ASSET_COLLISION_METADATA_SCHEMA = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none"), reason: shortText }).strict(),
  z
    .object({
      kind: z.enum(["convex_hull", "mesh"]),
      meshId: entityId,
      supportPatches: z
        .array(ASSET_COLLISION_SUPPORT_PATCH_SCHEMA)
        .min(1)
        .max(MAXIMUM_COLLISION_SUPPORT_PATCHES_PER_PART),
    })
    .strict()
    .superRefine((value, context) => {
      const identities = value.supportPatches.map(stableJson);
      if (
        new Set(identities).size !== identities.length ||
        identities.some((identity, index) => index > 0 && identities[index - 1]! >= identity)
      )
        context.addIssue({
          code: "custom",
          path: ["supportPatches"],
          message: "Collision support patches must be unique and canonical",
        });
    }),
]);

export const SOURCE_ASSET_PART_DECLARATION_SCHEMA = z
  .object({
    id: entityId,
    name: shortText,
    semanticRole: shortText,
    role: z.enum(ASSET_OUTPUT_ROLES),
    visualGeometry: z.enum(["detailed_mesh", "primitive"]),
    materialRoleId: entityId,
    sourceId: entityId,
    placements: z.array(ASSET_TRANSFORM_SCHEMA).min(1).max(8192),
    pivotHint: ASSET_VECTOR3_SCHEMA,
    socketHints: z
      .array(
        z
          .object({ id: entityId, type: shortText, localTransform: ASSET_TRANSFORM_SCHEMA })
          .strict(),
      )
      .max(128),
    collisionHint: ASSET_COLLISION_HINT_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    validateUniqueIds(value.socketHints, context, ["socketHints"]);
  });
export type SourceAssetPartDeclaration = z.infer<typeof SOURCE_ASSET_PART_DECLARATION_SCHEMA>;

export const ASSET_SOURCE_CANDIDATE_MATERIAL_SCHEMA = z
  .object({
    kind: z.literal("AssetSourceCandidate"),
    abi: z.literal(ASSET_SOURCE_CANDIDATE_ABI),
    id: entityId,
    requirementHash: hashSchema,
    invocationHash: hashSchema,
    sources: z.array(SOURCE_ASSET_GEOMETRY_SCHEMA).min(1).max(512),
    partDeclarations: z.array(SOURCE_ASSET_PART_DECLARATION_SCHEMA).min(1).max(512),
    rights: z.array(ASSET_RIGHTS_CLAIM_SCHEMA).min(1).max(512),
    lineage: ASSET_SOURCE_LINEAGE_SCHEMA,
    producerReportArtifact: ASSET_JSON_ARTIFACT_REFERENCE_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    for (const [key, values] of [
      ["sources", value.sources],
      ["partDeclarations", value.partDeclarations],
      ["rights", value.rights],
    ] as const) {
      validateUniqueIds(values, context, [key]);
      if (!isCanonicalById(values))
        context.addIssue({
          code: "custom",
          path: [key],
          message: `Asset source ${key} must be canonical`,
        });
    }
    const sourceIds = new Set(value.sources.map(({ id }) => id));
    for (const [index, part] of value.partDeclarations.entries()) {
      if (!sourceIds.has(part.sourceId))
        context.addIssue({
          code: "custom",
          path: ["partDeclarations", index, "sourceId"],
          message: "Asset source part references absent geometry",
        });
      if (part.collisionHint.kind !== "none" && !sourceIds.has(part.collisionHint.meshId))
        context.addIssue({
          code: "custom",
          path: ["partDeclarations", index, "collisionHint", "meshId"],
          message: "Asset source collision hint references absent geometry",
        });
    }
  });
export const ASSET_SOURCE_CANDIDATE_SCHEMA = ASSET_SOURCE_CANDIDATE_MATERIAL_SCHEMA.safeExtend({
  hash: hashSchema,
}).strict();
export type AssetSourceCandidate = z.infer<typeof ASSET_SOURCE_CANDIDATE_SCHEMA>;

export function sealAssetSourceCandidate(
  input: z.input<typeof ASSET_SOURCE_CANDIDATE_MATERIAL_SCHEMA>,
): AssetSourceCandidate {
  const material = ASSET_SOURCE_CANDIDATE_MATERIAL_SCHEMA.parse({
    ...input,
    sources: [...input.sources].sort((left, right) => compareSpatialStrings(left.id, right.id)),
    partDeclarations: input.partDeclarations
      .map((part) => ({
        ...part,
        socketHints: [...part.socketHints].sort((left, right) =>
          compareSpatialStrings(left.id, right.id),
        ),
      }))
      .sort((left, right) => compareSpatialStrings(left.id, right.id)),
    rights: [...input.rights].sort((left, right) => compareSpatialStrings(left.id, right.id)),
    lineage: canonicalSourceLineage(input.lineage),
  });
  return ASSET_SOURCE_CANDIDATE_SCHEMA.parse({
    ...material,
    hash: contentHash(stableJson(material)),
  });
}

export function assertAssetSourceCandidateIdentity(
  value: unknown,
): asserts value is AssetSourceCandidate {
  const candidate = ASSET_SOURCE_CANDIDATE_SCHEMA.parse(value);
  const { hash, ...material } = candidate;
  if (contentHash(stableJson(material)) !== hash)
    throw new Error("Asset source candidate identity is invalid");
}

export const ADAPTED_ASSET_MESH_SCHEMA = z
  .object({
    id: entityId,
    kind: z.literal("glb_node"),
    artifact: glbArtifact,
    nodeName: z.string().trim().min(1).max(256),
    nodeTransform: z.literal("identity"),
  })
  .strict();
export type AdaptedAssetMesh = z.infer<typeof ADAPTED_ASSET_MESH_SCHEMA>;

export const ADAPTED_ASSET_PART_SCHEMA = z
  .object({
    id: entityId,
    name: shortText,
    semanticRole: shortText,
    role: z.enum(ASSET_OUTPUT_ROLES),
    visualGeometry: z.enum(["detailed_mesh", "primitive"]),
    materialRoleId: entityId,
    meshId: entityId,
    placements: z.array(ASSET_TRANSFORM_SCHEMA).min(1).max(8192),
    pivot: ASSET_VECTOR3_SCHEMA,
    sockets: z
      .array(
        z
          .object({ id: entityId, type: shortText, localTransform: ASSET_TRANSFORM_SCHEMA })
          .strict(),
      )
      .max(128),
    support: ASSET_SUPPORT_GEOMETRY_SCHEMA,
    collision: ASSET_COLLISION_METADATA_SCHEMA,
    surfaceKinds: z.array(PLACEMENT_SURFACE_KIND_SCHEMA).max(PLACEMENT_SURFACE_KINDS.length),
  })
  .strict()
  .superRefine((value, context) => {
    validateUniqueIds(value.sockets, context, ["sockets"]);
    if (!isCanonicalStrings(value.surfaceKinds))
      context.addIssue({
        code: "custom",
        path: ["surfaceKinds"],
        message: "Surface kinds must be unique and canonical",
      });
    if (
      stableJson(value.surfaceKinds) !== stableJson(deriveMeasuredAssetSurfaceKinds(value.support))
    )
      context.addIssue({
        code: "custom",
        path: ["surfaceKinds"],
        message: "Adapted surface compatibility must derive from measured support",
      });
  });
export type AdaptedAssetPart = z.infer<typeof ADAPTED_ASSET_PART_SCHEMA>;

export const ADAPTED_ASSET_CANDIDATE_MATERIAL_SCHEMA = z
  .object({
    kind: z.literal("AdaptedAssetCandidate"),
    abi: z.literal(ADAPTED_ASSET_CANDIDATE_ABI),
    id: entityId,
    requirementHash: hashSchema,
    invocationHash: hashSchema,
    sourceCandidate: ASSET_SOURCE_CANDIDATE_SCHEMA,
    coordinateFrame: z.literal("gltf-y-up-asset-units"),
    canonicalAxes: z
      .object({
        handedness: z.literal("right_handed"),
        up: z.literal("+Y"),
        forward: z.literal("-Z"),
      })
      .strict(),
    transformOwnership: z.literal("canonical_identity_nodes"),
    canonicalRoot: ASSET_CANONICAL_ROOT_SCHEMA,
    studsPerUnit: positive.max(10_000),
    meshes: z.array(ADAPTED_ASSET_MESH_SCHEMA).min(1).max(512),
    parts: z.array(ADAPTED_ASSET_PART_SCHEMA).min(1).max(512),
    adaptation: z
      .object({
        adapterId: entityId,
        adapterRevisionHash: hashSchema,
        adapterQualificationHash: hashSchema,
        postprocessorIdentityHash: hashSchema,
        reportArtifact: ASSET_JSON_ARTIFACT_REFERENCE_SCHEMA,
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    for (const [key, values] of [
      ["meshes", value.meshes],
      ["parts", value.parts],
    ] as const) {
      validateUniqueIds(values, context, [key]);
      if (!isCanonicalById(values))
        context.addIssue({
          code: "custom",
          path: [key],
          message: `Adapted asset ${key} must be canonical`,
        });
    }
    if (new Set(value.meshes.map(({ nodeName }) => nodeName)).size !== value.meshes.length)
      context.addIssue({
        code: "custom",
        path: ["meshes"],
        message: "Adapted asset mesh node names must be unique",
      });
    if (
      value.id !== value.sourceCandidate.id ||
      value.requirementHash !== value.sourceCandidate.requirementHash ||
      value.invocationHash !== value.sourceCandidate.invocationHash
    )
      context.addIssue({
        code: "custom",
        path: ["sourceCandidate"],
        message: "Adapted asset authority must equal its source candidate",
      });
    const meshes = new Set(value.meshes.map(({ id }) => id));
    const collisionSupportPatchCount = value.parts.reduce(
      (total, part) =>
        total + (part.collision.kind === "none" ? 0 : part.collision.supportPatches.length),
      0,
    );
    if (collisionSupportPatchCount > MAXIMUM_COLLISION_SUPPORT_PATCHES_PER_CANDIDATE)
      context.addIssue({
        code: "custom",
        path: ["parts"],
        message: "Adapted collision support patches exceed the candidate budget",
      });
    const contactPatchCount = value.parts.reduce(
      (total, part) =>
        total + (part.support.kind === "surface_contact" ? part.support.contactPatches.length : 0),
      0,
    );
    if (contactPatchCount > MAXIMUM_ASSET_CONTACT_PATCHES_PER_CANDIDATE)
      context.addIssue({
        code: "custom",
        path: ["parts"],
        message: "Adapted contact patches exceed the candidate budget",
      });
    for (const [index, part] of value.parts.entries()) {
      if (!meshes.has(part.meshId))
        context.addIssue({
          code: "custom",
          path: ["parts", index, "meshId"],
          message: "Adapted part references an absent mesh",
        });
      if (part.collision.kind !== "none" && !meshes.has(part.collision.meshId))
        context.addIssue({
          code: "custom",
          path: ["parts", index, "collision", "meshId"],
          message: "Adapted collision metadata references an absent mesh",
        });
    }
    const adaptedParts = new Map(value.parts.map((part) => [part.id, part] as const));
    for (const declaration of value.sourceCandidate.partDeclarations) {
      const adapted = adaptedParts.get(declaration.id);
      if (!adapted)
        context.addIssue({
          code: "custom",
          path: ["parts"],
          message: `Adaptation dropped a declared part: ${declaration.id}`,
        });
      else {
        if (
          declaration.placements.length !== adapted.placements.length ||
          declaration.placements.some((placement, index) => {
            const rebased = adapted.placements[index];
            return (
              !rebased ||
              stableJson(rebased.rotation) !== stableJson(placement.rotation) ||
              stableJson(rebased.scale) !== stableJson(placement.scale) ||
              Math.abs(
                rebased.position.x -
                  (placement.position.x - value.canonicalRoot.sourceSupportOrigin.x),
              ) > 1e-6 ||
              Math.abs(
                rebased.position.y -
                  (placement.position.y - value.canonicalRoot.sourceSupportOrigin.y),
              ) > 1e-6 ||
              Math.abs(
                rebased.position.z -
                  (placement.position.z - value.canonicalRoot.sourceSupportOrigin.z),
              ) > 1e-6
            );
          })
        )
          context.addIssue({
            code: "custom",
            path: ["parts"],
            message: `Adaptation did not apply one common root rebase: ${declaration.id}`,
          });
        if (stableJson(adapted.pivot) !== stableJson(declaration.pivotHint))
          context.addIssue({
            code: "custom",
            path: ["parts"],
            message: `Adaptation changed a mesh-local pivot: ${declaration.id}`,
          });
        const retainedSockets = new Map(adapted.sockets.map((socket) => [socket.id, socket]));
        for (const socket of declaration.socketHints) {
          const retained = retainedSockets.get(socket.id);
          if (!retained || stableJson(retained) !== stableJson(socket))
            context.addIssue({
              code: "custom",
              path: ["parts"],
              message: `Adaptation dropped a declared socket: ${declaration.id}/${socket.id}`,
            });
        }
        if (
          declaration.collisionHint.kind !== "none" &&
          (adapted.collision.kind !== declaration.collisionHint.kind ||
            !adaptedCollisionMeshesForSource(
              declaration.collisionHint.meshId,
              value.sourceCandidate.partDeclarations,
              adaptedParts,
            ).has(adapted.collision.meshId))
        )
          context.addIssue({
            code: "custom",
            path: ["parts"],
            message: `Adaptation changed or redirected declared collision metadata: ${declaration.id}`,
          });
      }
    }
  });
export const ADAPTED_ASSET_CANDIDATE_SCHEMA = ADAPTED_ASSET_CANDIDATE_MATERIAL_SCHEMA.safeExtend({
  hash: hashSchema,
}).strict();
export type AdaptedAssetCandidate = z.infer<typeof ADAPTED_ASSET_CANDIDATE_SCHEMA>;

export function sealAdaptedAssetCandidate(
  input: z.input<typeof ADAPTED_ASSET_CANDIDATE_MATERIAL_SCHEMA>,
): AdaptedAssetCandidate {
  assertAssetSourceCandidateIdentity(input.sourceCandidate);
  const material = ADAPTED_ASSET_CANDIDATE_MATERIAL_SCHEMA.parse({
    ...input,
    meshes: [...input.meshes].sort((left, right) => compareSpatialStrings(left.id, right.id)),
    parts: input.parts
      .map((part) => ({
        ...part,
        sockets: [...part.sockets].sort((left, right) => compareSpatialStrings(left.id, right.id)),
        support:
          part.support.kind === "none"
            ? part.support
            : {
                ...part.support,
                contactPatches: [...part.support.contactPatches]
                  .map((patch) => ({
                    ...patch,
                    contactSamples: [...patch.contactSamples].sort((left, right) =>
                      compareSpatialStrings(stableJson(left), stableJson(right)),
                    ),
                  }))
                  .sort((left, right) =>
                    compareSpatialStrings(stableJson(left), stableJson(right)),
                  ),
              },
        collision:
          part.collision.kind === "none"
            ? part.collision
            : {
                ...part.collision,
                supportPatches: [...part.collision.supportPatches].sort((left, right) =>
                  compareSpatialStrings(stableJson(left), stableJson(right)),
                ),
              },
        surfaceKinds: deriveMeasuredAssetSurfaceKinds(part.support),
      }))
      .sort((left, right) => compareSpatialStrings(left.id, right.id)),
  });
  return ADAPTED_ASSET_CANDIDATE_SCHEMA.parse({
    ...material,
    hash: contentHash(stableJson(material)),
  });
}

export function assertAdaptedAssetCandidateIdentity(
  value: unknown,
): asserts value is AdaptedAssetCandidate {
  const candidate = ADAPTED_ASSET_CANDIDATE_SCHEMA.parse(value);
  assertAssetSourceCandidateIdentity(candidate.sourceCandidate);
  const { hash, ...material } = candidate;
  if (contentHash(stableJson(material)) !== hash)
    throw new Error("Adapted asset candidate identity is invalid");
}

function adaptedCollisionMeshesForSource(
  sourceId: string,
  declarations: readonly SourceAssetPartDeclaration[],
  adaptedParts: ReadonlyMap<string, AdaptedAssetPart>,
): ReadonlySet<string> {
  return new Set(
    declarations
      .filter((declaration) => declaration.sourceId === sourceId)
      .map((declaration) => adaptedParts.get(declaration.id)?.meshId)
      .filter((meshId): meshId is string => meshId !== undefined),
  );
}

function assetReferenceResolutionBindingMaterial(
  reference: z.infer<typeof boundReference>,
): z.infer<typeof boundReference> {
  return {
    id: reference.id,
    purpose: reference.purpose,
    artifact: reference.artifact,
    alpha: reference.alpha,
    rights: reference.rights,
    catalogEntry: reference.catalogEntry,
    verification: reference.verification,
  };
}

function validateAssetReferenceResolution(
  value: {
    artifact: z.infer<typeof ASSET_BINARY_ARTIFACT_REFERENCE_SCHEMA>;
    alpha: "present" | "absent";
    rights: z.infer<typeof assetReferenceRights>;
    catalogEntry: AssetReferenceCatalogEntry;
    verification: AssetReferenceVerification;
  },
  context: z.RefinementCtx,
): void {
  if (stableJson(value.artifact) !== stableJson(value.catalogEntry.artifact))
    context.addIssue({
      code: "custom",
      path: ["artifact"],
      message: "Resolved reference artifact differs from its exact catalog entry",
    });
  if (value.alpha !== value.catalogEntry.alpha)
    context.addIssue({
      code: "custom",
      path: ["alpha"],
      message: "Resolved reference alpha differs from its exact catalog entry",
    });
  if (stableJson(value.rights) !== stableJson(value.catalogEntry.rights))
    context.addIssue({
      code: "custom",
      path: ["rights"],
      message: "Resolved reference rights differ from its exact catalog entry",
    });
  if (value.verification.catalogEntryHash !== value.catalogEntry.hash)
    context.addIssue({
      code: "custom",
      path: ["verification", "catalogEntryHash"],
      message: "Reference verification differs from its exact catalog entry",
    });
  if (
    value.verification.image.artifactHash !== value.artifact.artifactHash ||
    value.verification.image.mediaType !== value.artifact.mediaType ||
    value.verification.image.alpha !== value.alpha
  )
    context.addIssue({
      code: "custom",
      path: ["verification", "image"],
      message: "Reference image verification differs from the retained image",
    });
  if (value.verification.rights.evidenceArtifactHash !== value.rights.evidenceArtifact.artifactHash)
    context.addIssue({
      code: "custom",
      path: ["verification", "rights"],
      message: "Reference rights verification differs from retained rights evidence",
    });
}

function validateIntentBindings(
  value: z.infer<typeof ASSET_REQUIREMENT_INTENT_MATERIAL_SCHEMA>,
  context: z.RefinementCtx,
): void {
  if (value.styleContract.id !== value.declaration.styleContractId)
    context.addIssue({
      code: "custom",
      path: ["styleContract", "id"],
      message: "Bound style contract differs from the asset requirement declaration",
    });
  const paletteEntries = new Map(value.styleContract.palette.map((entry) => [entry.id, entry]));
  value.declaration.surfaceIntent.materialRoles.forEach((role, index) => {
    const bindings =
      role.materialAdaptation.kind === "harmonize"
        ? [{ id: role.materialAdaptation.paletteEntryId, channel: "base_color" as const }]
        : role.materialAdaptation.kind === "synthesize"
          ? proceduralMaterialGraphPaletteBindings(role.materialAdaptation.graph)
          : [];
    bindings.forEach((binding) => {
      const paletteEntry = paletteEntries.get(binding.id);
      if (!paletteEntry)
        context.addIssue({
          code: "custom",
          path: ["declaration", "surfaceIntent", "materialRoles", index, "materialAdaptation"],
          message: `Material adaptation names an absent style palette entry: ${binding.id}`,
        });
      else if (binding.channel === "emissive" && paletteEntry.emissive === undefined)
        context.addIssue({
          code: "custom",
          path: ["declaration", "surfaceIntent", "materialRoles", index, "materialAdaptation"],
          message: `Material graph requests an undeclared emissive palette channel: ${binding.id}`,
        });
    });
  });
  const declaredDependencies = new Map(
    value.declaration.dependencies.map((dependency) => [dependency.id, dependency.purpose]),
  );
  const declaredReferences = new Map(
    value.declaration.references.map((reference) => [
      reference.id,
      { purpose: reference.purpose, referenceHandle: reference.referenceHandle },
    ]),
  );
  if (!isCanonicalById(value.dependencies))
    context.addIssue({
      code: "custom",
      path: ["dependencies"],
      message: "Bound asset dependencies must be unique and canonical",
    });
  if (!isCanonicalById(value.references))
    context.addIssue({
      code: "custom",
      path: ["references"],
      message: "Bound asset references must be unique and canonical",
    });
  if (value.dependencies.length !== declaredDependencies.size)
    context.addIssue({
      code: "custom",
      path: ["dependencies"],
      message: "Every declared asset dependency must be bound exactly once",
    });
  if (value.references.length !== declaredReferences.size)
    context.addIssue({
      code: "custom",
      path: ["references"],
      message: "Every declared asset reference must be bound exactly once",
    });
  value.dependencies.forEach((dependency, index) => {
    if (declaredDependencies.get(dependency.id) !== dependency.purpose)
      context.addIssue({
        code: "custom",
        path: ["dependencies", index],
        message: "Bound asset dependency differs from its declaration",
      });
  });
  value.references.forEach((reference, index) => {
    const declaration = declaredReferences.get(reference.id);
    if (
      declaration?.purpose !== reference.purpose ||
      declaration.referenceHandle !== reference.catalogEntry.referenceHandle
    )
      context.addIssue({
        code: "custom",
        path: ["references", index],
        message: "Bound asset reference differs from its declaration",
      });
    if (
      reference.verification.resolvedFor.projectId !== value.projectId ||
      reference.verification.resolvedFor.creatorRequestHash !== value.creatorRequestHash
    )
      context.addIssue({
        code: "custom",
        path: ["references", index, "verification", "resolvedFor"],
        message: "Bound asset reference verification differs from the intent authority scope",
      });
    if (
      reference.catalogEntry.scope.projectId !== value.projectId ||
      (reference.catalogEntry.scope.kind === "creator_request" &&
        reference.catalogEntry.scope.creatorRequestHash !== value.creatorRequestHash)
    )
      context.addIssue({
        code: "custom",
        path: ["references", index, "catalogEntry", "scope"],
        message: "Bound asset reference catalog scope differs from the intent authority scope",
      });
  });
}

function validateDescriptorCanonical(
  value: {
    acceptedForms: readonly string[];
    referenceContract: { kind: "none" } | { kind: "bounded"; mediaTypes: readonly string[] };
    semanticCapabilities: {
      semanticCoverage: { kind: "closed_set"; tags: readonly string[] } | { kind: "open_vocab" };
      objectConstructions: readonly string[];
      materialClasses: readonly string[];
      finishStyles: readonly string[];
      novelty: readonly string[];
    };
    outputCapabilities: {
      roles: readonly string[];
      namedSemanticParts: boolean;
      pivots: boolean;
      articulatedParts: boolean;
      sockets: boolean;
      transparency: boolean;
      collision: boolean;
      editOperations: readonly string[];
    };
  },
  context: z.RefinementCtx,
): void {
  for (const [name, values] of [
    ["acceptedForms", value.acceptedForms],
    ["objectConstructions", value.semanticCapabilities.objectConstructions],
    ["materialClasses", value.semanticCapabilities.materialClasses],
    ["finishStyles", value.semanticCapabilities.finishStyles],
    ["novelty", value.semanticCapabilities.novelty],
    ["roles", value.outputCapabilities.roles],
    ["editOperations", value.outputCapabilities.editOperations],
  ] as const)
    if (!isCanonicalStrings(values))
      context.addIssue({
        code: "custom",
        path:
          name === "acceptedForms"
            ? [name]
            : name === "roles" || name === "editOperations"
              ? ["outputCapabilities", name]
              : ["semanticCapabilities", name],
        message: `Factory ${name} must be unique and canonical`,
      });
  if (
    value.semanticCapabilities.semanticCoverage.kind === "closed_set" &&
    !isCanonicalStrings(value.semanticCapabilities.semanticCoverage.tags)
  )
    context.addIssue({
      code: "custom",
      path: ["semanticCapabilities", "semanticCoverage", "tags"],
      message: "Factory semantic tags must be unique and canonical",
    });
  if (
    value.referenceContract.kind === "bounded" &&
    !isCanonicalStrings(value.referenceContract.mediaTypes)
  )
    context.addIssue({
      code: "custom",
      path: ["referenceContract", "mediaTypes"],
      message: "Factory reference media types must be unique and canonical",
    });
  if (
    value.outputCapabilities.articulatedParts &&
    (!value.outputCapabilities.namedSemanticParts ||
      !value.outputCapabilities.pivots ||
      !value.outputCapabilities.roles.includes("render_interactive"))
  )
    context.addIssue({
      code: "custom",
      path: ["outputCapabilities", "articulatedParts"],
      message: "Articulated output requires named interactive parts with retained pivots",
    });
  if (
    value.outputCapabilities.editOperations.includes("attach_to_socket") &&
    !value.outputCapabilities.sockets
  )
    context.addIssue({
      code: "custom",
      path: ["outputCapabilities", "editOperations"],
      message: "Socket attachment edits require socket output capability",
    });
  if (
    value.outputCapabilities.editOperations.includes("rotate_part") &&
    !value.outputCapabilities.pivots
  )
    context.addIssue({
      code: "custom",
      path: ["outputCapabilities", "editOperations"],
      message: "Part rotation edits require retained pivot output capability",
    });
}

function canonicalSourceLineage(input: z.input<typeof ASSET_SOURCE_LINEAGE_SCHEMA>): unknown {
  if (input.kind === "trusted_procedure")
    return {
      ...input,
      inputPreparedAssetHashes: [...input.inputPreparedAssetHashes].sort(compareSpatialStrings),
      sourceArtifactHashes: [...input.sourceArtifactHashes].sort(compareSpatialStrings),
    };
  if (input.kind === "neural_asset")
    return {
      ...input,
      referenceArtifactHashes: [...input.referenceArtifactHashes].sort(compareSpatialStrings),
    };
  return input;
}

function requiredDependencyIds(form: AssetForm): string[] {
  void form;
  return [];
}

function requiredSurfaceRoleIds(form: AssetForm): string[] {
  void form;
  return [];
}

function validateUniqueIds(
  values: readonly { id: string }[],
  context: z.RefinementCtx,
  path: PropertyKey[],
): void {
  if (new Set(values.map(({ id }) => id)).size !== values.length)
    context.addIssue({ code: "custom", path, message: "Identifiers must be unique" });
}

function validateCanonicalHashes(
  values: readonly string[],
  context: z.RefinementCtx,
  path: PropertyKey[],
): void {
  if (!isCanonicalStrings(values))
    context.addIssue({ code: "custom", path, message: "Hashes must be unique and canonical" });
}

function isCanonicalStrings(values: readonly string[]): boolean {
  return (
    new Set(values).size === values.length &&
    values.every((value, index) => index === 0 || values[index - 1]! < value)
  );
}

function isCanonicalById(values: readonly { id: string }[]): boolean {
  return isCanonicalStrings(values.map(({ id }) => id));
}

function subtractAssetVectors(
  left: z.infer<typeof ASSET_VECTOR3_SCHEMA>,
  right: z.infer<typeof ASSET_VECTOR3_SCHEMA>,
): z.infer<typeof ASSET_VECTOR3_SCHEMA> {
  return { x: left.x - right.x, y: left.y - right.y, z: left.z - right.z };
}

function assetPointInsideTriangle(
  point: z.infer<typeof ASSET_VECTOR3_SCHEMA>,
  polygon: readonly [
    z.infer<typeof ASSET_VECTOR3_SCHEMA>,
    z.infer<typeof ASSET_VECTOR3_SCHEMA>,
    z.infer<typeof ASSET_VECTOR3_SCHEMA>,
  ],
  normal: z.infer<typeof ASSET_VECTOR3_SCHEMA>,
): boolean {
  for (let index = 0; index < 3; index += 1) {
    const first = polygon[index]!;
    const second = polygon[(index + 1) % 3]!;
    const edge = subtractAssetVectors(second, first);
    const relative = subtractAssetVectors(point, first);
    const cross = {
      x: edge.y * relative.z - edge.z * relative.y,
      y: edge.z * relative.x - edge.x * relative.z,
      z: edge.x * relative.y - edge.y * relative.x,
    };
    if (cross.x * normal.x + cross.y * normal.y + cross.z * normal.z < -1e-6) return false;
  }
  return true;
}
