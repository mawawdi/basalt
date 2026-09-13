export type Matrix4x4 = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

export interface GeometryVector3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export type GeometryTriangle = readonly [number, number, number];

export interface NormalizedMesh {
  readonly vertices: readonly GeometryVector3[];
  readonly triangles: readonly GeometryTriangle[];
  readonly normals?: readonly GeometryVector3[];
  readonly uv0?: readonly (readonly [number, number])[];
  readonly materialIndices?: readonly number[];
}

export const IDENTITY_MATRIX: Matrix4x4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function multiplyMatrices(left: Matrix4x4, right: Matrix4x4): Matrix4x4 {
  const result = Array.from({ length: 16 }, () => 0);
  for (let column = 0; column < 4; column += 1)
    for (let row = 0; row < 4; row += 1)
      result[column * 4 + row] =
        left[row]! * right[column * 4]! +
        left[4 + row]! * right[column * 4 + 1]! +
        left[8 + row]! * right[column * 4 + 2]! +
        left[12 + row]! * right[column * 4 + 3]!;
  return matrix4x4(result);
}

function matrix4x4(values: readonly number[]): Matrix4x4 {
  if (values.length !== 16 || values.some((value) => !Number.isFinite(value)))
    throw new Error("A matrix must contain sixteen finite values");
  return [
    values[0]!,
    values[1]!,
    values[2]!,
    values[3]!,
    values[4]!,
    values[5]!,
    values[6]!,
    values[7]!,
    values[8]!,
    values[9]!,
    values[10]!,
    values[11]!,
    values[12]!,
    values[13]!,
    values[14]!,
    values[15]!,
  ];
}

export function transformPoint(matrix: Matrix4x4, point: GeometryVector3): GeometryVector3 {
  const x = matrix[0]! * point.x + matrix[4]! * point.y + matrix[8]! * point.z + matrix[12]!;
  const y = matrix[1]! * point.x + matrix[5]! * point.y + matrix[9]! * point.z + matrix[13]!;
  const z = matrix[2]! * point.x + matrix[6]! * point.y + matrix[10]! * point.z + matrix[14]!;
  const w = matrix[3]! * point.x + matrix[7]! * point.y + matrix[11]! * point.z + matrix[15]!;
  return w !== 0 && w !== 1 ? { x: x / w, y: y / w, z: z / w } : { x, y, z };
}

/** Inverse-transpose transform for a direction. Translation is intentionally ignored. */
export function transformNormal(matrix: Matrix4x4, normal: GeometryVector3): GeometryVector3 {
  const a = matrix[0]!;
  const b = matrix[4]!;
  const c = matrix[8]!;
  const d = matrix[1]!;
  const e = matrix[5]!;
  const f = matrix[9]!;
  const g = matrix[2]!;
  const h = matrix[6]!;
  const i = matrix[10]!;
  const determinant = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(determinant) < 1e-12)
    throw new Error("Cannot transform a normal through a singular matrix");
  const inverseTranspose = {
    x: (e * i - f * h) * normal.x + (f * g - d * i) * normal.y + (d * h - e * g) * normal.z,
    y: (c * h - b * i) * normal.x + (a * i - c * g) * normal.y + (b * g - a * h) * normal.z,
    z: (b * f - c * e) * normal.x + (c * d - a * f) * normal.y + (a * e - b * d) * normal.z,
  };
  const length = Math.hypot(inverseTranspose.x, inverseTranspose.y, inverseTranspose.z);
  if (length < 1e-12) throw new Error("Normal collapsed during inverse-transpose transform");
  return {
    x: inverseTranspose.x / length,
    y: inverseTranspose.y / length,
    z: inverseTranspose.z / length,
  };
}
