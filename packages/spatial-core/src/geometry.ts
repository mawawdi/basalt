export interface SceneVector {
  x: number;
  y: number;
  z: number;
}
export type SceneRotation = readonly [
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
export const SCENE_IDENTITY_ROTATION: SceneRotation = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const f32 = (value: number) => {
  const result = Math.fround(Math.abs(value) < 1e-12 ? 0 : value);
  return Object.is(result, -0) ? 0 : result;
};
export function sceneEulerXyz(degrees: SceneVector): SceneRotation {
  const x = (degrees.x * Math.PI) / 180;
  const y = (degrees.y * Math.PI) / 180;
  const z = (degrees.z * Math.PI) / 180;
  const cx = Math.cos(x),
    sx = Math.sin(x),
    cy = Math.cos(y),
    sy = Math.sin(y),
    cz = Math.cos(z),
    sz = Math.sin(z);
  return [
    cy * cz,
    -cy * sz,
    sy,
    sx * sy * cz + cx * sz,
    -sx * sy * sz + cx * cz,
    -sx * cy,
    -cx * sy * cz + sx * sz,
    cx * sy * sz + sx * cz,
    cx * cy,
  ].map(f32) as unknown as SceneRotation;
}
export function sceneMultiply(
  a: SceneRotation,
  b: SceneRotation,
  canonical = false,
): SceneRotation {
  const out: number[] = [];
  for (let row = 0; row < 3; row += 1)
    for (let column = 0; column < 3; column += 1) {
      const value =
        a[row * 3]! * b[column]! +
        a[row * 3 + 1]! * b[column + 3]! +
        a[row * 3 + 2]! * b[column + 6]!;
      out.push(canonical ? f32(value) : value);
    }
  return out as unknown as SceneRotation;
}
export function sceneTransformVector(rotation: SceneRotation, vector: SceneVector): SceneVector {
  return {
    x: rotation[0] * vector.x + rotation[1] * vector.y + rotation[2] * vector.z,
    y: rotation[3] * vector.x + rotation[4] * vector.y + rotation[5] * vector.z,
    z: rotation[6] * vector.x + rotation[7] * vector.y + rotation[8] * vector.z,
  };
}
export function sceneInverse(rotation: SceneRotation): SceneRotation {
  const [a, b, c, d, e, f, g, h, i] = rotation;
  const determinant = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 0.5)
    throw new Error("Scene rotation lost its invertible rigid-frame representation");
  return [
    e * i - f * h,
    c * h - b * i,
    b * f - c * e,
    f * g - d * i,
    a * i - c * g,
    c * d - a * f,
    d * h - e * g,
    b * g - a * h,
    a * e - b * d,
  ].map((value) => value / determinant) as unknown as SceneRotation;
}
export function sceneHalfExtents(rotation: SceneRotation, size: SceneVector): SceneVector {
  const half = {
    x: Math.fround(size.x) / 2,
    y: Math.fround(size.y) / 2,
    z: Math.fround(size.z) / 2,
  };
  return {
    x:
      Math.abs(rotation[0]) * half.x +
      Math.abs(rotation[1]) * half.y +
      Math.abs(rotation[2]) * half.z,
    y:
      Math.abs(rotation[3]) * half.x +
      Math.abs(rotation[4]) * half.y +
      Math.abs(rotation[5]) * half.z,
    z:
      Math.abs(rotation[6]) * half.x +
      Math.abs(rotation[7]) * half.y +
      Math.abs(rotation[8]) * half.z,
  };
}
