import { z } from "zod";
import { HASH_SCHEMA, contentHash, deepFreezeJson, stableJson } from "@basalt/contracts";

export const NEURAL_MESH_TENSOR_LAYOUT = Object.freeze([
  Object.freeze({ name: "positions", dtype: "F32", columns: 3 }),
  Object.freeze({ name: "triangle_indices", dtype: "I32", columns: 3 }),
  Object.freeze({ name: "base_color", dtype: "F32", columns: 3 }),
  Object.freeze({ name: "roughness", dtype: "F32", columns: 1 }),
  Object.freeze({ name: "metallic", dtype: "F32", columns: 1 }),
  Object.freeze({ name: "opacity", dtype: "F32", columns: 1 }),
  Object.freeze({ name: "normals", dtype: "F32", columns: 3 }),
] as const);

export const NEURAL_MESH_TENSOR_LAYOUT_HASH = contentHash(stableJson(NEURAL_MESH_TENSOR_LAYOUT));

const finite = z.number().finite();
const affineMatrix = z
  .array(finite)
  .length(16)
  .superRefine((value, context) => {
    if (value[3] !== 0 || value[7] !== 0 || value[11] !== 0 || value[15] !== 1)
      context.addIssue({ code: "custom", message: "Source transform must be affine" });
    const determinant =
      value[0]! * (value[5]! * value[10]! - value[9]! * value[6]!) -
      value[4]! * (value[1]! * value[10]! - value[9]! * value[2]!) +
      value[8]! * (value[1]! * value[6]! - value[5]! * value[2]!);
    if (Math.abs(determinant) < 1e-12)
      context.addIssue({ code: "custom", message: "Source transform must be invertible" });
  });
const tensorDescriptor = z
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
  .refine((value) => value.valueRange[0] <= value.valueRange[1], "Tensor range is reversed");

export const NEURAL_MESH_TENSOR_PAYLOAD_SCHEMA = z
  .object({
    kind: z.literal("NeuralMeshTensorPayload"),
    tensorLayoutHash: z.literal(NEURAL_MESH_TENSOR_LAYOUT_HASH),
    artifact: z
      .object({
        artifactHash: HASH_SCHEMA,
        bytes: z
          .number()
          .int()
          .positive()
          .max(2 * 1024 * 1024 * 1024),
        mediaType: z.literal("application/x-safetensors"),
      })
      .strict(),
    sourceCoordinateFrame: z
      .object({
        name: z.string().regex(/^[A-Za-z][A-Za-z0-9_.+-]{0,127}$/u),
        handedness: z.literal("right_handed"),
        up: z.enum(["+X", "-X", "+Y", "-Y", "+Z", "-Z"]),
        forward: z.enum(["+X", "-X", "+Y", "-Y", "+Z", "-Z"]),
        positionUnits: z.enum(["provider_normalized", "meters"]),
        metricScaleEvidenceHash: HASH_SCHEMA.optional(),
        sourceToCanonicalMatrixColumnMajor: affineMatrix,
        transformsBaked: z.boolean(),
      })
      .strict()
      .superRefine((value, context) => {
        if ((value.positionUnits === "meters") !== (value.metricScaleEvidenceHash !== undefined))
          context.addIssue({
            code: "custom",
            path: ["metricScaleEvidenceHash"],
            message: "Only metrically evidenced positions may claim meters",
          });
      }),
    vertexCount: z.number().int().min(3).max(20_000_000),
    triangleCount: z.number().int().positive().max(40_000_000),
    tensors: z.array(tensorDescriptor).length(NEURAL_MESH_TENSOR_LAYOUT.length),
    topology: z
      .object({
        connectedComponents: z.number().int().positive().max(1_000_000),
        boundaryEdges: z.number().int().nonnegative(),
        nonManifoldEdges: z.number().int().nonnegative(),
      })
      .strict(),
    hash: HASH_SCHEMA,
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
          message: `Tensor ${name} has the wrong provider-neutral descriptor`,
        });
    });
    const { hash: _hash, ...material } = value;
    if (contentHash(stableJson(material)) !== value.hash)
      context.addIssue({ code: "custom", path: ["hash"], message: "Tensor payload hash mismatch" });
  });
export type NeuralMeshTensorPayload = z.output<typeof NEURAL_MESH_TENSOR_PAYLOAD_SCHEMA>;

export function sealNeuralMeshTensorPayload(
  input: Omit<NeuralMeshTensorPayload, "kind" | "tensorLayoutHash" | "hash">,
): NeuralMeshTensorPayload {
  const material = {
    kind: "NeuralMeshTensorPayload" as const,
    tensorLayoutHash: NEURAL_MESH_TENSOR_LAYOUT_HASH,
    ...input,
  };
  return deepFreezeJson(
    NEURAL_MESH_TENSOR_PAYLOAD_SCHEMA.parse({
      ...material,
      hash: contentHash(stableJson(material)),
    }),
  ) as NeuralMeshTensorPayload;
}
