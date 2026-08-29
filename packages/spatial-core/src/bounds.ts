import {
  SCENE_IDENTITY_ROTATION,
  sceneHalfExtents,
  sceneInverse,
  sceneMultiply,
  sceneTransformVector,
  type SceneRotation,
  type SceneVector,
} from "./geometry.js";
export interface SceneBox {
  position: SceneVector;
  rotation: SceneRotation;
  size: SceneVector;
}
export function measureSceneBoxConstraint(
  kind: "separation" | "containment",
  first: SceneBox,
  second: SceneBox,
  clearance: number,
): {
  valid: boolean;
  margins: SceneVector;
  numericalSafety: SceneVector;
  boundsFrame: "world_axes" | "second_node_local_axes";
} {
  const axes = ["x", "y", "z"] as const;
  const worldDelta = {
    x: first.position.x - second.position.x,
    y: first.position.y - second.position.y,
    z: first.position.z - second.position.z,
  };
  const inverse = sceneInverse(second.rotation);
  const delta = kind === "separation" ? worldDelta : sceneTransformVector(inverse, worldDelta);
  const firstHalf = sceneHalfExtents(
    kind === "separation" ? first.rotation : sceneMultiply(inverse, first.rotation),
    first.size,
  );
  const secondHalf = sceneHalfExtents(
    kind === "separation" ? second.rotation : SCENE_IDENTITY_ROTATION,
    second.size,
  );
  const axisAligned = [first.rotation, second.rotation].every((matrix) =>
    matrix.every((value) => value === 0 || Math.abs(value) === 1),
  );
  const numericalSafety = {} as SceneVector;
  const margins = {} as SceneVector;
  for (const axis of axes) {
    numericalSafety[axis] = axisAligned
      ? 0
      : 64 *
        Number.EPSILON *
        (Math.abs(delta[axis]) + firstHalf[axis] + secondHalf[axis] + clearance + 1);
    margins[axis] =
      kind === "separation"
        ? Math.abs(delta[axis]) - (firstHalf[axis] + secondHalf[axis] + clearance)
        : secondHalf[axis] - (Math.abs(delta[axis]) + firstHalf[axis] + clearance);
  }
  const valid =
    kind === "separation"
      ? axes.some(
          (axis) =>
            Math.abs(delta[axis]) >=
            firstHalf[axis] + secondHalf[axis] + clearance + numericalSafety[axis],
        )
      : axes.every(
          (axis) =>
            Math.abs(delta[axis]) + firstHalf[axis] + clearance + numericalSafety[axis] <=
            secondHalf[axis],
        );
  return {
    valid,
    margins,
    numericalSafety,
    boundsFrame: kind === "separation" ? "world_axes" : "second_node_local_axes",
  };
}
