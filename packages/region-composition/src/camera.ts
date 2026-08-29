import { contentHash, stableJson } from "../../contracts/src/index.js";
import {
  DEFAULT_SPATIAL_ADMISSION_POLICY,
  assertBoundedSpatialJson,
  entityId,
} from "../../spatial-core/src/primitives.js";
import type { WorldCamera, WorldVector3 } from "../../world-planning/src/index.js";
import {
  CROP_SIMILARITY_ABI,
  CROP_SIMILARITY_SCHEMA,
  PERSPECTIVE_CAMERA_CALIBRATION_ABI,
  PERSPECTIVE_CAMERA_CALIBRATION_SCHEMA,
  type CropSimilarity,
  type ImagePoint,
  type Matrix3,
  type Matrix4,
  type PerspectiveCameraCalibration,
} from "./contracts.js";

export interface WorldRay {
  readonly origin: WorldVector3;
  readonly direction: WorldVector3;
}

export interface CalibratedWorldRay extends WorldRay {
  readonly nearPoint: WorldVector3;
  readonly farPoint: WorldVector3;
  readonly minimumDistance: number;
  readonly maximumDistance: number;
}

/** Build one explicit calibration using the retained WorldPlan camera convention. */
export function calibratePerspectiveCamera(camera: WorldCamera): PerspectiveCameraCalibration {
  entityId.parse(camera.id);
  if (
    !Number.isInteger(camera.width) ||
    !Number.isInteger(camera.height) ||
    camera.width < 1 ||
    camera.height < 1 ||
    !(camera.fieldOfViewDegrees >= 1 && camera.fieldOfViewDegrees <= 120) ||
    !(camera.nearClip > 0 && camera.nearClip < camera.farClip)
  )
    throw new Error("Perspective camera parameters are invalid");
  const forward = normalize(subtract(camera.lookAt, camera.position), "Camera view direction");
  const right = normalize(cross(forward, camera.up), "Camera up vector");
  const up = normalize(cross(right, forward), "Camera frame");
  const focalPixels = camera.height / (2 * Math.tan((camera.fieldOfViewDegrees * Math.PI) / 360));
  const intrinsics = canonicalMatrix3([
    focalPixels,
    0,
    camera.width / 2,
    0,
    focalPixels,
    camera.height / 2,
    0,
    0,
    1,
  ]);
  const worldToCamera = canonicalMatrix4([
    right.x,
    right.y,
    right.z,
    -dot(right, camera.position),
    -up.x,
    -up.y,
    -up.z,
    dot(up, camera.position),
    forward.x,
    forward.y,
    forward.z,
    -dot(forward, camera.position),
    0,
    0,
    0,
    1,
  ]);
  const cameraToWorld = canonicalMatrix4([
    right.x,
    -up.x,
    forward.x,
    camera.position.x,
    right.y,
    -up.y,
    forward.y,
    camera.position.y,
    right.z,
    -up.z,
    forward.z,
    camera.position.z,
    0,
    0,
    0,
    1,
  ]);
  const material = {
    kind: "PerspectiveCameraCalibration" as const,
    abi: PERSPECTIVE_CAMERA_CALIBRATION_ABI,
    cameraId: camera.id,
    sourceCameraHash: contentHash(stableJson(camera)),
    width: camera.width,
    height: camera.height,
    verticalFieldOfViewDegrees: canonicalNumber(camera.fieldOfViewDegrees),
    nearClip: canonicalNumber(camera.nearClip),
    farClip: canonicalNumber(camera.farClip),
    coordinateConvention: "pixel_boundary_top_left_x_right_y_down_camera_z_forward" as const,
    intrinsics,
    worldToCamera,
    cameraToWorld,
  };
  return sealCalibration(material);
}

export function assertPerspectiveCameraCalibration(
  value: unknown,
  sourceCamera?: WorldCamera,
): asserts value is PerspectiveCameraCalibration {
  assertBoundedSpatialJson(value, DEFAULT_SPATIAL_ADMISSION_POLICY);
  const parsed = PERSPECTIVE_CAMERA_CALIBRATION_SCHEMA.parse(value);
  const { id, hash, ...material } = parsed;
  const expected = contentHash(stableJson(material));
  if (hash !== expected || id !== `camera_calibration_${expected.slice(0, 24)}`)
    throw new Error("Perspective camera calibration identity mismatch");
  assertInverse4(parsed.worldToCamera, parsed.cameraToWorld);
  const focal = parsed.height / (2 * Math.tan((parsed.verticalFieldOfViewDegrees * Math.PI) / 360));
  const expectedIntrinsics = canonicalMatrix3([
    focal,
    0,
    parsed.width / 2,
    0,
    focal,
    parsed.height / 2,
    0,
    0,
    1,
  ]);
  assertMatrixClose(parsed.intrinsics, expectedIntrinsics, "Camera intrinsic matrix");
  if (sourceCamera) {
    const expectedCalibration = calibratePerspectiveCamera(sourceCamera);
    if (stableJson(parsed) !== stableJson(expectedCalibration))
      throw new Error("Perspective camera calibration does not bind the supplied camera");
  }
}

/** Create the exact orientation-preserving similarity A and derived K' = A K. */
export function createCropSimilarity(input: {
  readonly calibration: PerspectiveCameraCalibration;
  readonly outputSize: { readonly width: number; readonly height: number };
  readonly scale: number;
  readonly rotationRadians?: number;
  readonly translation: ImagePoint;
}): CropSimilarity {
  assertPerspectiveCameraCalibration(input.calibration);
  if (
    !Number.isInteger(input.outputSize.width) ||
    !Number.isInteger(input.outputSize.height) ||
    input.outputSize.width < 1 ||
    input.outputSize.height < 1 ||
    !Number.isFinite(input.scale) ||
    input.scale <= 0 ||
    !Number.isFinite(input.rotationRadians ?? 0) ||
    !Number.isFinite(input.translation.x) ||
    !Number.isFinite(input.translation.y)
  )
    throw new Error("Crop similarity parameters are invalid");
  const rotationRadians = canonicalNumber(input.rotationRadians ?? 0);
  const cosine = Math.cos(rotationRadians) * input.scale;
  const sine = Math.sin(rotationRadians) * input.scale;
  const sourceToCrop = canonicalMatrix3([
    cosine,
    -sine,
    input.translation.x,
    sine,
    cosine,
    input.translation.y,
    0,
    0,
    1,
  ]);
  const cropToSource = invertSimilarity(sourceToCrop);
  const derivedIntrinsics = multiplyMatrix3(sourceToCrop, input.calibration.intrinsics);
  const material = {
    kind: "CropSimilarity" as const,
    abi: CROP_SIMILARITY_ABI,
    cameraCalibrationHash: input.calibration.hash,
    sourceSize: { width: input.calibration.width, height: input.calibration.height },
    outputSize: input.outputSize,
    scale: canonicalNumber(input.scale),
    rotationRadians,
    translation: {
      x: canonicalNumber(input.translation.x),
      y: canonicalNumber(input.translation.y),
    },
    sourceToCrop,
    cropToSource,
    derivedIntrinsics,
    effectiveFocalPixels: canonicalNumber(input.calibration.intrinsics[0] * input.scale),
  };
  return sealCrop(material);
}

export function assertCropSimilarity(
  value: unknown,
  calibration: PerspectiveCameraCalibration,
): asserts value is CropSimilarity {
  assertPerspectiveCameraCalibration(calibration);
  assertBoundedSpatialJson(value, DEFAULT_SPATIAL_ADMISSION_POLICY);
  const parsed = CROP_SIMILARITY_SCHEMA.parse(value);
  const { id, hash, ...material } = parsed;
  const expected = contentHash(stableJson(material));
  if (hash !== expected || id !== `crop_similarity_${expected.slice(0, 24)}`)
    throw new Error("Crop similarity identity mismatch");
  if (
    parsed.cameraCalibrationHash !== calibration.hash ||
    parsed.sourceSize.width !== calibration.width ||
    parsed.sourceSize.height !== calibration.height
  )
    throw new Error("Crop similarity does not bind the supplied camera calibration");
  const expectedA = createSimilarityMatrix(
    parsed.scale,
    parsed.rotationRadians,
    parsed.translation,
  );
  assertMatrixClose(parsed.sourceToCrop, expectedA, "Crop similarity matrix");
  assertMatrixClose(parsed.cropToSource, invertSimilarity(expectedA), "Inverse crop matrix");
  assertMatrixClose(
    parsed.derivedIntrinsics,
    multiplyMatrix3(expectedA, calibration.intrinsics),
    "Derived crop intrinsics",
  );
  if (Math.abs(parsed.effectiveFocalPixels - calibration.intrinsics[0] * parsed.scale) > 1e-8)
    throw new Error("Crop effective focal length mismatch");
}

export function mapSourcePixelToCrop(crop: CropSimilarity, pixel: ImagePoint): ImagePoint {
  return transformImagePoint(crop.sourceToCrop, pixel);
}

export function mapCropPixelToSource(crop: CropSimilarity, pixel: ImagePoint): ImagePoint {
  return transformImagePoint(crop.cropToSource, pixel);
}

export function worldRayFromPixel(
  calibration: PerspectiveCameraCalibration,
  pixel: ImagePoint,
): WorldRay {
  assertPerspectiveCameraCalibration(calibration);
  const inverseIntrinsics = invertMatrix3(calibration.intrinsics);
  const cameraDirection = normalize(
    transformHomogeneousDirection(inverseIntrinsics, pixel),
    "Camera ray",
  );
  return cameraRayToWorld(calibration, cameraDirection);
}

export function worldRayFromCropPixel(
  calibration: PerspectiveCameraCalibration,
  crop: CropSimilarity,
  pixel: ImagePoint,
): WorldRay {
  assertCropSimilarity(crop, calibration);
  return worldRayFromPixel(calibration, mapCropPixelToSource(crop, pixel));
}

/** Unproject one source pixel at an exact positive camera-space Z depth. */
export function unprojectPixelAtCameraDepth(
  calibration: PerspectiveCameraCalibration,
  pixel: ImagePoint,
  cameraDepth: number,
): WorldVector3 {
  assertPerspectiveCameraCalibration(calibration);
  if (!Number.isFinite(pixel.x) || !Number.isFinite(pixel.y))
    throw new Error("Image point must be finite");
  if (!Number.isFinite(cameraDepth) || cameraDepth <= 0)
    throw new Error("Camera depth must be finite and positive");
  const inverseIntrinsics = invertMatrix3(calibration.intrinsics);
  const unitDepthPoint = transformHomogeneousDirection(inverseIntrinsics, pixel);
  if (Math.abs(unitDepthPoint.z - 1) > 1e-8)
    throw new Error("Camera intrinsics do not unproject to unit Z depth");
  return canonicalVector(
    transformPoint4(calibration.cameraToWorld, {
      x: unitDepthPoint.x * cameraDepth,
      y: unitDepthPoint.y * cameraDepth,
      z: cameraDepth,
    }),
  );
}

/** Unproject through the exact inverse crop A^-1 at camera-space Z depth. */
export function unprojectCropPixelAtCameraDepth(
  calibration: PerspectiveCameraCalibration,
  crop: CropSimilarity,
  pixel: ImagePoint,
  cameraDepth: number,
): WorldVector3 {
  assertCropSimilarity(crop, calibration);
  return unprojectPixelAtCameraDepth(calibration, mapCropPixelToSource(crop, pixel), cameraDepth);
}

/**
 * Return the calibrated finite ray segment that actually contributed pixels to
 * the retained render. Distances are Euclidean because the direction is unit length.
 */
export function calibratedWorldRayFromPixel(
  calibration: PerspectiveCameraCalibration,
  pixel: ImagePoint,
): CalibratedWorldRay {
  const ray = worldRayFromPixel(calibration, pixel);
  const nearPoint = unprojectPixelAtCameraDepth(calibration, pixel, calibration.nearClip);
  const farPoint = unprojectPixelAtCameraDepth(calibration, pixel, calibration.farClip);
  const minimumDistance = distance(ray.origin, nearPoint);
  const maximumDistance = distance(ray.origin, farPoint);
  if (!(minimumDistance < maximumDistance)) throw new Error("Camera ray clipping range is invalid");
  return {
    ...ray,
    nearPoint,
    farPoint,
    minimumDistance: canonicalNumber(minimumDistance),
    maximumDistance: canonicalNumber(maximumDistance),
  };
}

export function calibratedWorldRayFromCropPixel(
  calibration: PerspectiveCameraCalibration,
  crop: CropSimilarity,
  pixel: ImagePoint,
): CalibratedWorldRay {
  assertCropSimilarity(crop, calibration);
  return calibratedWorldRayFromPixel(calibration, mapCropPixelToSource(crop, pixel));
}

export function projectWorldPoint(
  calibration: PerspectiveCameraCalibration,
  point: WorldVector3,
): { readonly pixel: ImagePoint; readonly depth: number } {
  assertPerspectiveCameraCalibration(calibration);
  const cameraPoint = transformPoint4(calibration.worldToCamera, point);
  if (!(cameraPoint.z > 0)) throw new Error("World point is not in front of the camera");
  return {
    pixel: {
      x: (calibration.intrinsics[0] * cameraPoint.x) / cameraPoint.z + calibration.intrinsics[2],
      y: (calibration.intrinsics[4] * cameraPoint.y) / cameraPoint.z + calibration.intrinsics[5],
    },
    depth: cameraPoint.z,
  };
}

/** Project through K' = A K into the regional composition crop. */
export function projectWorldPointToCrop(
  calibration: PerspectiveCameraCalibration,
  crop: CropSimilarity,
  point: WorldVector3,
): { readonly pixel: ImagePoint; readonly depth: number } {
  assertCropSimilarity(crop, calibration);
  const cameraPoint = transformPoint4(calibration.worldToCamera, point);
  if (!(cameraPoint.z > 0)) throw new Error("World point is not in front of the camera");
  return {
    pixel: {
      x: canonicalNumber(
        (crop.derivedIntrinsics[0] * cameraPoint.x +
          crop.derivedIntrinsics[1] * cameraPoint.y +
          crop.derivedIntrinsics[2] * cameraPoint.z) /
          cameraPoint.z,
      ),
      y: canonicalNumber(
        (crop.derivedIntrinsics[3] * cameraPoint.x +
          crop.derivedIntrinsics[4] * cameraPoint.y +
          crop.derivedIntrinsics[5] * cameraPoint.z) /
          cameraPoint.z,
      ),
    },
    depth: cameraPoint.z,
  };
}

export function multiplyMatrix3(left: Matrix3, right: Matrix3): Matrix3 {
  const output = new Array<number>(9).fill(0);
  for (let row = 0; row < 3; row += 1)
    for (let column = 0; column < 3; column += 1)
      for (let inner = 0; inner < 3; inner += 1)
        output[row * 3 + column]! += left[row * 3 + inner]! * right[inner * 3 + column]!;
  return canonicalMatrix3(output as unknown as Matrix3);
}

function sealCalibration(
  material: Omit<PerspectiveCameraCalibration, "id" | "hash">,
): PerspectiveCameraCalibration {
  assertBoundedSpatialJson(material, DEFAULT_SPATIAL_ADMISSION_POLICY);
  const hash = contentHash(stableJson(material));
  return PERSPECTIVE_CAMERA_CALIBRATION_SCHEMA.parse({
    ...material,
    id: `camera_calibration_${hash.slice(0, 24)}`,
    hash,
  });
}

function sealCrop(material: Omit<CropSimilarity, "id" | "hash">): CropSimilarity {
  assertBoundedSpatialJson(material, DEFAULT_SPATIAL_ADMISSION_POLICY);
  const hash = contentHash(stableJson(material));
  return CROP_SIMILARITY_SCHEMA.parse({
    ...material,
    id: `crop_similarity_${hash.slice(0, 24)}`,
    hash,
  });
}

function createSimilarityMatrix(scale: number, angle: number, translation: ImagePoint): Matrix3 {
  const cosine = Math.cos(angle) * scale;
  const sine = Math.sin(angle) * scale;
  return canonicalMatrix3([cosine, -sine, translation.x, sine, cosine, translation.y, 0, 0, 1]);
}

function invertSimilarity(matrix: Matrix3): Matrix3 {
  const a = matrix[0];
  const b = matrix[3];
  const denominator = a * a + b * b;
  if (!(denominator > 1e-18)) throw new Error("Crop similarity is singular");
  return canonicalMatrix3([
    a / denominator,
    b / denominator,
    -(a * matrix[2] + b * matrix[5]) / denominator,
    -b / denominator,
    a / denominator,
    (b * matrix[2] - a * matrix[5]) / denominator,
    0,
    0,
    1,
  ]);
}

function invertMatrix3(matrix: Matrix3): Matrix3 {
  const [a, b, c, d, e, f, g, h, i] = matrix;
  const determinant = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(determinant) <= 1e-18) throw new Error("Image transform is singular");
  return canonicalMatrix3([
    (e * i - f * h) / determinant,
    (c * h - b * i) / determinant,
    (b * f - c * e) / determinant,
    (f * g - d * i) / determinant,
    (a * i - c * g) / determinant,
    (c * d - a * f) / determinant,
    (d * h - e * g) / determinant,
    (b * g - a * h) / determinant,
    (a * e - b * d) / determinant,
  ]);
}

function transformImagePoint(matrix: Matrix3, point: ImagePoint): ImagePoint {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y))
    throw new Error("Image point must be finite");
  const denominator = matrix[6] * point.x + matrix[7] * point.y + matrix[8];
  if (Math.abs(denominator) <= 1e-18) throw new Error("Image point maps to infinity");
  return {
    x: canonicalNumber((matrix[0] * point.x + matrix[1] * point.y + matrix[2]) / denominator),
    y: canonicalNumber((matrix[3] * point.x + matrix[4] * point.y + matrix[5]) / denominator),
  };
}

function transformHomogeneousDirection(matrix: Matrix3, point: ImagePoint): WorldVector3 {
  return {
    x: matrix[0] * point.x + matrix[1] * point.y + matrix[2],
    y: matrix[3] * point.x + matrix[4] * point.y + matrix[5],
    z: matrix[6] * point.x + matrix[7] * point.y + matrix[8],
  };
}

function cameraRayToWorld(
  calibration: PerspectiveCameraCalibration,
  cameraDirection: WorldVector3,
): WorldRay {
  const matrix = calibration.cameraToWorld;
  const origin = { x: matrix[3], y: matrix[7], z: matrix[11] };
  const direction = normalize(
    {
      x:
        matrix[0] * cameraDirection.x +
        matrix[1] * cameraDirection.y +
        matrix[2] * cameraDirection.z,
      y:
        matrix[4] * cameraDirection.x +
        matrix[5] * cameraDirection.y +
        matrix[6] * cameraDirection.z,
      z:
        matrix[8] * cameraDirection.x +
        matrix[9] * cameraDirection.y +
        matrix[10] * cameraDirection.z,
    },
    "World ray",
  );
  return { origin, direction };
}

function transformPoint4(matrix: Matrix4, point: WorldVector3): WorldVector3 {
  return {
    x: matrix[0] * point.x + matrix[1] * point.y + matrix[2] * point.z + matrix[3],
    y: matrix[4] * point.x + matrix[5] * point.y + matrix[6] * point.z + matrix[7],
    z: matrix[8] * point.x + matrix[9] * point.y + matrix[10] * point.z + matrix[11],
  };
}

function assertInverse4(left: Matrix4, right: Matrix4): void {
  for (let row = 0; row < 4; row += 1)
    for (let column = 0; column < 4; column += 1) {
      let value = 0;
      for (let inner = 0; inner < 4; inner += 1)
        value += left[row * 4 + inner]! * right[inner * 4 + column]!;
      const expected = row === column ? 1 : 0;
      if (Math.abs(value - expected) > 1e-8)
        throw new Error("Camera transforms are not exact inverses");
    }
}

function assertMatrixClose(
  actual: readonly number[],
  expected: readonly number[],
  label: string,
): void {
  if (actual.some((value, index) => Math.abs(value - expected[index]!) > 1e-8))
    throw new Error(`${label} mismatch`);
}

function normalize(value: WorldVector3, label: string): WorldVector3 {
  const length = Math.hypot(value.x, value.y, value.z);
  if (!(length > 1e-12)) throw new Error(`${label} is degenerate`);
  return {
    x: canonicalNumber(value.x / length),
    y: canonicalNumber(value.y / length),
    z: canonicalNumber(value.z / length),
  };
}

function subtract(left: WorldVector3, right: WorldVector3): WorldVector3 {
  return { x: left.x - right.x, y: left.y - right.y, z: left.z - right.z };
}

function cross(left: WorldVector3, right: WorldVector3): WorldVector3 {
  return {
    x: left.y * right.z - left.z * right.y,
    y: left.z * right.x - left.x * right.z,
    z: left.x * right.y - left.y * right.x,
  };
}

function dot(left: WorldVector3, right: WorldVector3): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function canonicalNumber(value: number): number {
  return Object.is(value, -0) || Math.abs(value) < 1e-15 ? 0 : value;
}

function canonicalMatrix3(value: Matrix3): Matrix3 {
  return value.map(canonicalNumber) as Matrix3;
}

function canonicalMatrix4(value: Matrix4): Matrix4 {
  return value.map(canonicalNumber) as Matrix4;
}

function canonicalVector(value: WorldVector3): WorldVector3 {
  return {
    x: canonicalNumber(value.x),
    y: canonicalNumber(value.y),
    z: canonicalNumber(value.z),
  };
}

function distance(left: WorldVector3, right: WorldVector3): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}
