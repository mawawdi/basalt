import { z } from "zod";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import { hashSchema } from "../../spatial-core/src/primitives.js";

/**
 * Provider-neutral interchange between qualified neural inference and Basalt's
 * fixed asset-adaptation worker. Providers may choose their own internal mesh
 * representation, but retained output must lower to this exact tensor set.
 */
export const MESH_ATTRIBUTE_TENSOR_BUNDLE_ABI = "basalt-mesh-attribute-tensor-bundle@2" as const;

export const MESH_ATTRIBUTE_TENSOR_LAYOUT = Object.freeze([
  Object.freeze({ name: "positions", dtype: "F32", columns: 3 }),
  Object.freeze({ name: "triangle_indices", dtype: "I32", columns: 3 }),
  Object.freeze({ name: "base_color", dtype: "F32", columns: 3 }),
  Object.freeze({ name: "roughness", dtype: "F32", columns: 1 }),
  Object.freeze({ name: "metallic", dtype: "F32", columns: 1 }),
  Object.freeze({ name: "opacity", dtype: "F32", columns: 1 }),
  Object.freeze({ name: "normals", dtype: "F32", columns: 3 }),
] as const);

export const MESH_ATTRIBUTE_TENSOR_SCHEMA_HASH = contentHash(
  stableJson({
    abi: MESH_ATTRIBUTE_TENSOR_BUNDLE_ABI,
    tensors: [
      ["positions", "F32", ["vertex_count", 3]],
      ["triangle_indices", "I32", ["triangle_count", 3]],
      ["base_color", "F32", ["vertex_count", 3]],
      ["roughness", "F32", ["vertex_count", 1]],
      ["metallic", "F32", ["vertex_count", 1]],
      ["opacity", "F32", ["vertex_count", 1]],
      ["normals", "F32", ["vertex_count", 3]],
    ],
  }),
);

const finite = z.number().finite();

export const NEURAL_TENSOR_ARTIFACT_SCHEMA = z
  .object({
    locator: z.string().regex(/^binary-artifacts\/[a-f0-9]{64}\.bin$/u),
    artifactHash: hashSchema,
    bytes: z
      .number()
      .int()
      .positive()
      .max(2 * 1024 * 1024 * 1024),
    mediaType: z.literal("application/x-safetensors"),
  })
  .strict()
  .refine(
    (value) => value.locator === `binary-artifacts/${value.artifactHash}.bin`,
    "Tensor artifact locator must identify its exact bytes",
  );

export const NEURAL_MESH_TRANSFORM_OWNERSHIP_SCHEMA = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("canonical_baked"),
      canonicalFrame: z.literal("right-handed-y-up-negative-z-forward"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("source_frame_unbaked"),
      sourceFrame: z.string().trim().min(1).max(160),
      sourceToCanonicalMatrixColumnMajor: z.array(finite).length(16),
    })
    .strict(),
]);

const descriptorSchema = z
  .object({
    name: z.enum([
      "positions",
      "triangle_indices",
      "base_color",
      "roughness",
      "metallic",
      "opacity",
      "normals",
    ]),
    dtype: z.enum(["F32", "I32"]),
    shape: z.tuple([z.number().int().positive(), z.number().int().positive()]),
    valueRange: z.tuple([finite, finite]),
  })
  .strict()
  .refine(({ valueRange }) => valueRange[0] <= valueRange[1], "Tensor range is reversed");

const payloadMaterial = z
  .object({
    kind: z.literal("RouteNeutralMeshAttributeTensorPayload"),
    abi: z.literal(MESH_ATTRIBUTE_TENSOR_BUNDLE_ABI),
    tensorSchemaHash: z.literal(MESH_ATTRIBUTE_TENSOR_SCHEMA_HASH),
    artifact: NEURAL_TENSOR_ARTIFACT_SCHEMA,
    vertexCount: z.number().int().min(3).max(20_000_000),
    triangleCount: z.number().int().positive().max(40_000_000),
    tensors: z.array(descriptorSchema).length(MESH_ATTRIBUTE_TENSOR_LAYOUT.length),
    transformOwnership: NEURAL_MESH_TRANSFORM_OWNERSHIP_SCHEMA,
    topology: z
      .object({
        connectedComponents: z.number().int().positive().max(1_000_000),
        boundaryEdges: z.number().int().nonnegative(),
        nonManifoldEdges: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    const expected = [
      [
        "positions",
        "F32",
        value.vertexCount,
        3,
        Number.NEGATIVE_INFINITY,
        Number.POSITIVE_INFINITY,
      ],
      ["triangle_indices", "I32", value.triangleCount, 3, 0, value.vertexCount - 1],
      ["base_color", "F32", value.vertexCount, 3, 0, 1],
      ["roughness", "F32", value.vertexCount, 1, 0, 1],
      ["metallic", "F32", value.vertexCount, 1, 0, 1],
      ["opacity", "F32", value.vertexCount, 1, 0, 1],
      ["normals", "F32", value.vertexCount, 3, -1, 1],
    ] as const;
    expected.forEach(([name, dtype, rows, columns, minimum, maximum], index) => {
      const tensor = value.tensors[index];
      if (
        !tensor ||
        tensor.name !== name ||
        tensor.dtype !== dtype ||
        tensor.shape[0] !== rows ||
        tensor.shape[1] !== columns ||
        tensor.valueRange[0] < minimum ||
        tensor.valueRange[1] > maximum
      )
        context.addIssue({
          code: "custom",
          path: ["tensors", index],
          message: `Tensor ${name} has the wrong route-neutral descriptor`,
        });
    });
  });

export const ROUTE_NEUTRAL_MESH_ATTRIBUTE_TENSOR_PAYLOAD_SCHEMA = payloadMaterial.safeExtend({
  hash: hashSchema,
});
export type RouteNeutralMeshAttributeTensorPayload = z.infer<
  typeof ROUTE_NEUTRAL_MESH_ATTRIBUTE_TENSOR_PAYLOAD_SCHEMA
>;

export function sealRouteNeutralMeshAttributeTensorPayload(
  input: z.input<typeof payloadMaterial>,
): RouteNeutralMeshAttributeTensorPayload {
  const material = payloadMaterial.parse(input);
  return ROUTE_NEUTRAL_MESH_ATTRIBUTE_TENSOR_PAYLOAD_SCHEMA.parse({
    ...material,
    hash: contentHash(stableJson(material)),
  });
}

export function assertRouteNeutralMeshAttributeTensorPayloadIdentity(
  value: unknown,
): asserts value is RouteNeutralMeshAttributeTensorPayload {
  const payload = ROUTE_NEUTRAL_MESH_ATTRIBUTE_TENSOR_PAYLOAD_SCHEMA.parse(value);
  const { hash, ...material } = payload;
  if (hash !== contentHash(stableJson(material)))
    throw new Error("Route-neutral mesh-attribute tensor payload identity is invalid");
}
