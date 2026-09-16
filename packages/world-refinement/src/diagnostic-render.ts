import { createHash } from "node:crypto";
import { contentHash, stableJson } from "@basalt/contracts";
import {
  sampleTerrainFieldSurface,
  type ConstructedElement,
  type WorldBuild,
} from "@basalt/world-compiler";
import {
  WORLD_DIAGNOSTIC_CAMERA_SCHEMA,
  sealWorldDiagnosticRender,
  type WorldDiagnosticCamera,
  type WorldDiagnosticRender,
} from "./contracts.js";

type Point = { readonly x: number; readonly y: number; readonly z: number };
type RayHit = {
  readonly distance: number;
  readonly normal: Point;
  readonly color: readonly [number, number, number];
};

export const WORLD_DIAGNOSTIC_RENDERER_IMPLEMENTATION_HASH = contentHash(
  stableJson({
    kind: "WorldDiagnosticRenderer",
    projection: "pinhole_vertical_fov",
    primitives: [
      "axis_aligned_box",
      "height_field_triangle",
      "road_surface_triangle",
      "route_edge_rail_triangle",
      "route_junction_cylinder",
      "vertical_cylinder",
    ],
    shading: "normal_depth_material_hash",
    encoding: "ppm_p6",
  }),
);

/**
 * Deterministic, engine-neutral diagnostic rendering for bounded observations.
 * The output is intentionally simple: it is evidence for visual inspection,
 * not a claim that style or harmony has passed.
 */
export function renderWorldDiagnostics(input: {
  readonly worldBuild: WorldBuild;
  readonly cameras: readonly WorldDiagnosticCamera[];
}): {
  readonly renders: readonly WorldDiagnosticRender[];
  readonly payloads: ReadonlyMap<string, Uint8Array>;
} {
  if (input.cameras.length === 0 || input.cameras.length > 8)
    throw new Error("Diagnostic rendering requires between one and eight cameras");
  const primitives = renderPrimitives(input.worldBuild);
  if (primitives.length === 0) throw new Error("Diagnostic rendering requires realized geometry");
  const payloads = new Map<string, Uint8Array>();
  const renders = input.cameras.map((cameraInput) => {
    const camera = WORLD_DIAGNOSTIC_CAMERA_SCHEMA.parse(cameraInput);
    const payload = renderPpm(camera, primitives);
    const contentHashValue = createHash("sha256").update(payload).digest("hex");
    payloads.set(contentHashValue, payload);
    return sealWorldDiagnosticRender({
      worldBuildHash: input.worldBuild.worldBuildHash,
      camera,
      rendererImplementationHash: WORLD_DIAGNOSTIC_RENDERER_IMPLEMENTATION_HASH,
      geometryEvidenceHashes: primitives.map((entry) => entry.hash),
      payload: {
        kind: "diagnostic_render",
        contentHash: contentHashValue,
        sizeBytes: payload.byteLength,
        mediaType: "image/x-portable-pixmap",
      },
    });
  });
  return { renders, payloads };
}

type RenderPrimitive =
  | {
      readonly kind: "box";
      readonly bounds: { readonly min: Point; readonly max: Point };
      readonly color: readonly [number, number, number];
      readonly hash: string;
    }
  | {
      readonly kind: "cylinder";
      readonly center: Point;
      readonly radius: number;
      readonly height: number;
      readonly color: readonly [number, number, number];
      readonly hash: string;
    }
  | {
      readonly kind: "triangle";
      readonly a: Point;
      readonly b: Point;
      readonly c: Point;
      readonly color: readonly [number, number, number];
      readonly hash: string;
    };

function renderPrimitives(worldBuild: WorldBuild): RenderPrimitive[] {
  const constructed = worldBuild.meso.constructedStructures.flatMap((structure) =>
    structure.elements.map((element) => primitiveFromElement(element)),
  );
  const instances: RenderPrimitive[] = worldBuild.instances.map((instance) => ({
    kind: "box",
    bounds: instance.boundsMeters,
    color: colorFromIdentity(instance.entryHash),
    hash: instance.hash,
  }));
  const routes: RenderPrimitive[] = worldBuild.foundation.routeConstructions.flatMap((route) => [
    ...route.travelSegments.flatMap((segment) => {
      const [a, b, c, d] = segment.vertices.map((entry) => entry.positionMeters) as [
        Point,
        Point,
        Point,
        Point,
      ];
      return [
        {
          kind: "triangle" as const,
          a,
          b,
          c: d,
          color: [
            route.appearance.baseColorSrgb.red,
            route.appearance.baseColorSrgb.green,
            route.appearance.baseColorSrgb.blue,
          ] as const,
          hash: contentHash(
            stableJson({ routeHash: route.hash, segmentId: segment.segmentId, triangle: 0 }),
          ),
        },
        {
          kind: "triangle" as const,
          a,
          b: d,
          c,
          color: [
            route.appearance.baseColorSrgb.red,
            route.appearance.baseColorSrgb.green,
            route.appearance.baseColorSrgb.blue,
          ] as const,
          hash: contentHash(
            stableJson({ routeHash: route.hash, segmentId: segment.segmentId, triangle: 1 }),
          ),
        },
      ];
    }),
    ...route.edgeRails.flatMap((rail) => {
      const [a, b, c, d] = rail.vertices.map((entry) => entry.positionMeters) as [
        Point,
        Point,
        Point,
        Point,
      ];
      const color = appearanceColor(rail.appearance);
      return [
        {
          kind: "triangle" as const,
          a,
          b,
          c: d,
          color,
          hash: contentHash(stableJson({ railHash: rail.hash, triangle: 0 })),
        },
        {
          kind: "triangle" as const,
          a,
          b: d,
          c,
          color,
          hash: contentHash(stableJson({ railHash: rail.hash, triangle: 1 })),
        },
      ];
    }),
    ...route.supports.map((support) => ({
      kind: "cylinder" as const,
      center: support.centerMeters,
      radius: support.radiusMeters,
      height: support.heightMeters,
      color: appearanceColor(support.appearance),
      hash: support.hash,
    })),
    ...route.edgePosts.map((post) => ({
      kind: "cylinder" as const,
      center: post.centerMeters,
      radius: post.radiusMeters,
      height: post.heightMeters,
      color: appearanceColor(post.appearance),
      hash: post.hash,
    })),
  ]);
  const junctions: RenderPrimitive[] = worldBuild.foundation.routeJunctions.map((junction) => ({
    kind: "cylinder",
    center: {
      ...junction.centerTopMeters,
      y: junction.centerTopMeters.y - junction.thicknessMeters / 2,
    },
    radius: junction.radiusMeters,
    height: junction.thicknessMeters,
    color: appearanceColor(junction.appearance),
    hash: junction.hash,
  }));
  const terrain = worldBuild.foundation.terrainFields.flatMap((field) =>
    terrainPrimitives(worldBuild, field),
  );
  return [...constructed, ...instances, ...routes, ...junctions, ...terrain].sort((left, right) =>
    left.hash < right.hash ? -1 : left.hash > right.hash ? 1 : 0,
  );
}

function terrainPrimitives(
  worldBuild: WorldBuild,
  field: WorldBuild["foundation"]["terrainFields"][number],
): RenderPrimitive[] {
  const base = worldBuild.foundation.baseTerrainFields.find(
    (candidate) => candidate.hash === field.baseTerrainFieldHash,
  );
  if (!base) throw new Error(`Diagnostic terrain ${field.terrainPlanId} has no base artifact`);
  const baseXs = [...new Set(base.samples.map((sample) => sample.xMeters))].sort(
    (left, right) => left - right,
  );
  const baseZs = [...new Set(base.samples.map((sample) => sample.zMeters))].sort(
    (left, right) => left - right,
  );
  if (baseXs.length * baseZs.length !== base.samples.length)
    throw new Error(`Diagnostic terrain ${field.terrainPlanId} is not rectangular`);
  const contributingRoutes = worldBuild.foundation.routeConstructions.filter((route) =>
    field.routeConstructionHashes.includes(route.hash),
  );
  const desiredSpacing = Math.min(
    minimumSpacing(baseXs),
    minimumSpacing(baseZs),
    ...contributingRoutes.map((route) => route.widthMeters / 3),
  );
  const xCount = boundedDiagnosticAxisCount(baseXs.at(-1)! - baseXs[0]!, desiredSpacing);
  const zCount = boundedDiagnosticAxisCount(baseZs.at(-1)! - baseZs[0]!, desiredSpacing);
  const scale = Math.max(1, Math.ceil(Math.sqrt(((xCount - 1) * (zCount - 1)) / 16_384)));
  const xs = uniformCoordinates(baseXs[0]!, baseXs.at(-1)!, Math.max(2, Math.ceil(xCount / scale)));
  const zs = uniformCoordinates(baseZs[0]!, baseZs.at(-1)!, Math.max(2, Math.ceil(zCount / scale)));
  const triangles: RenderPrimitive[] = [];
  for (let row = 1; row < zs.length; row += 1)
    for (let column = 1; column < xs.length; column += 1) {
      const x0 = xs[column - 1]!;
      const x1 = xs[column]!;
      const z0 = zs[row - 1]!;
      const z1 = zs[row]!;
      const sample = (x: number, z: number) =>
        sampleTerrainFieldSurface(
          field,
          base,
          worldBuild.foundation.routeConstructions,
          worldBuild.foundation.routeJunctions,
          x,
          z,
        );
      const q00 = sample(x0, z0);
      const q10 = sample(x1, z0);
      const q01 = sample(x0, z1);
      const q11 = sample(x1, z1);
      const color = terrainColor(q00.materialId);
      const first = {
        a: { x: x0, y: q00.elevationMeters, z: z0 },
        b: { x: x1, y: q10.elevationMeters, z: z0 },
        c: { x: x1, y: q11.elevationMeters, z: z1 },
      };
      const second = {
        a: { x: x0, y: q00.elevationMeters, z: z0 },
        b: { x: x1, y: q11.elevationMeters, z: z1 },
        c: { x: x0, y: q01.elevationMeters, z: z1 },
      };
      for (const [triangleIndex, triangle] of [first, second].entries())
        triangles.push({
          kind: "triangle",
          ...triangle,
          color,
          hash: contentHash(
            stableJson({
              fieldHash: field.hash,
              row,
              column,
              triangleIndex,
              triangle,
            }),
          ),
        });
    }
  return triangles;
}

function minimumSpacing(values: readonly number[]): number {
  return Math.min(...values.slice(1).map((value, index) => value - values[index]!));
}

function boundedDiagnosticAxisCount(extent: number, spacing: number): number {
  if (!Number.isFinite(spacing) || spacing <= 0)
    throw new Error("Invalid diagnostic terrain spacing");
  return Math.max(2, Math.ceil(extent / spacing) + 1);
}

function uniformCoordinates(minimum: number, maximum: number, count: number): number[] {
  return Array.from(
    { length: count },
    (_, index) => minimum + ((maximum - minimum) * index) / (count - 1),
  );
}

function primitiveFromElement(element: ConstructedElement): RenderPrimitive {
  const color = appearanceColor(element.appearance);
  if (element.geometry.kind === "box")
    return { kind: "box", bounds: element.boundsMeters, color, hash: element.hash };
  return {
    kind: "cylinder",
    center: element.geometry.centerMeters,
    radius: element.geometry.radiusMeters,
    height: element.geometry.heightMeters,
    color,
    hash: element.hash,
  };
}

function appearanceColor(appearance: {
  readonly baseColorSrgb: { readonly red: number; readonly green: number; readonly blue: number };
}): readonly [number, number, number] {
  return [
    appearance.baseColorSrgb.red,
    appearance.baseColorSrgb.green,
    appearance.baseColorSrgb.blue,
  ];
}

function renderPpm(
  camera: WorldDiagnosticCamera,
  primitives: readonly RenderPrimitive[],
): Uint8Array {
  const forward = normalized(subtract(camera.lookAtMeters, camera.positionMeters));
  const right = normalized(cross(forward, camera.up));
  const up = normalized(cross(right, forward));
  const aspect = camera.widthPixels / camera.heightPixels;
  const halfHeight = Math.tan((camera.verticalFieldOfViewDegrees * Math.PI) / 360);
  const halfWidth = halfHeight * aspect;
  const header = Buffer.from(`P6\n${camera.widthPixels} ${camera.heightPixels}\n255\n`, "ascii");
  const pixels = new Uint8Array(camera.widthPixels * camera.heightPixels * 3);
  for (let y = 0; y < camera.heightPixels; y += 1)
    for (let x = 0; x < camera.widthPixels; x += 1) {
      const screenX = (((x + 0.5) / camera.widthPixels) * 2 - 1) * halfWidth;
      const screenY = (1 - ((y + 0.5) / camera.heightPixels) * 2) * halfHeight;
      const direction = normalized(add(add(forward, scale(right, screenX)), scale(up, screenY)));
      const hit = nearestHit(camera.positionMeters, direction, primitives);
      const color = hit ? shade(hit) : sky(direction);
      const offset = (y * camera.widthPixels + x) * 3;
      pixels[offset] = color[0];
      pixels[offset + 1] = color[1];
      pixels[offset + 2] = color[2];
    }
  const output = new Uint8Array(header.byteLength + pixels.byteLength);
  output.set(header, 0);
  output.set(pixels, header.byteLength);
  return output;
}

function nearestHit(
  origin: Point,
  direction: Point,
  primitives: readonly RenderPrimitive[],
): RayHit | undefined {
  let nearest: RayHit | undefined;
  for (const primitive of primitives) {
    const hit =
      primitive.kind === "box"
        ? intersectBox(origin, direction, primitive.bounds, primitive.color)
        : primitive.kind === "cylinder"
          ? intersectCylinder(origin, direction, primitive, primitive.color)
          : intersectTriangle(origin, direction, primitive);
    if (hit && (!nearest || hit.distance < nearest.distance)) nearest = hit;
  }
  return nearest;
}

function intersectTriangle(
  origin: Point,
  direction: Point,
  triangle: Extract<RenderPrimitive, { kind: "triangle" }>,
): RayHit | undefined {
  const edge1 = subtract(triangle.b, triangle.a);
  const edge2 = subtract(triangle.c, triangle.a);
  const p = cross(direction, edge2);
  const determinant = dot(edge1, p);
  if (Math.abs(determinant) <= 1e-12) return undefined;
  const inverse = 1 / determinant;
  const translated = subtract(origin, triangle.a);
  const u = dot(translated, p) * inverse;
  if (u < 0 || u > 1) return undefined;
  const q = cross(translated, edge1);
  const v = dot(direction, q) * inverse;
  if (v < 0 || u + v > 1) return undefined;
  const distance = dot(edge2, q) * inverse;
  if (distance <= 1e-6) return undefined;
  let normal = normalized(cross(edge1, edge2));
  if (dot(normal, direction) > 0) normal = scale(normal, -1);
  return { distance, normal, color: triangle.color };
}

function intersectBox(
  origin: Point,
  direction: Point,
  bounds: { readonly min: Point; readonly max: Point },
  color: readonly [number, number, number],
): RayHit | undefined {
  let entry = 0;
  let exit = Number.POSITIVE_INFINITY;
  let normal: Point = { x: 0, y: 1, z: 0 };
  for (const axis of ["x", "y", "z"] as const) {
    if (Math.abs(direction[axis]) <= 1e-12) {
      if (origin[axis] < bounds.min[axis] || origin[axis] > bounds.max[axis]) return undefined;
      continue;
    }
    const first = (bounds.min[axis] - origin[axis]) / direction[axis];
    const second = (bounds.max[axis] - origin[axis]) / direction[axis];
    const near = Math.min(first, second);
    const far = Math.max(first, second);
    if (near > entry) {
      entry = near;
      const sign = first < second ? -1 : 1;
      normal =
        axis === "x"
          ? { x: sign, y: 0, z: 0 }
          : axis === "y"
            ? { x: 0, y: sign, z: 0 }
            : { x: 0, y: 0, z: sign };
    }
    exit = Math.min(exit, far);
    if (entry > exit) return undefined;
  }
  return exit > 1e-6 ? { distance: Math.max(entry, 1e-6), normal, color } : undefined;
}

function intersectCylinder(
  origin: Point,
  direction: Point,
  cylinder: Extract<RenderPrimitive, { kind: "cylinder" }>,
  color: readonly [number, number, number],
): RayHit | undefined {
  const ox = origin.x - cylinder.center.x;
  const oz = origin.z - cylinder.center.z;
  const a = direction.x ** 2 + direction.z ** 2;
  const b = 2 * (ox * direction.x + oz * direction.z);
  const c = ox ** 2 + oz ** 2 - cylinder.radius ** 2;
  const candidates: Array<{ distance: number; normal: Point }> = [];
  if (a > 1e-12) {
    const discriminant = b * b - 4 * a * c;
    if (discriminant >= 0)
      for (const distance of [
        (-b - Math.sqrt(discriminant)) / (2 * a),
        (-b + Math.sqrt(discriminant)) / (2 * a),
      ]) {
        const y = origin.y + direction.y * distance;
        if (
          distance > 1e-6 &&
          y >= cylinder.center.y - cylinder.height / 2 &&
          y <= cylinder.center.y + cylinder.height / 2
        ) {
          const x = origin.x + direction.x * distance - cylinder.center.x;
          const z = origin.z + direction.z * distance - cylinder.center.z;
          candidates.push({ distance, normal: normalized({ x, y: 0, z }) });
        }
      }
  }
  if (Math.abs(direction.y) > 1e-12)
    for (const sign of [-1, 1] as const) {
      const y = cylinder.center.y + (sign * cylinder.height) / 2;
      const distance = (y - origin.y) / direction.y;
      const x = origin.x + direction.x * distance - cylinder.center.x;
      const z = origin.z + direction.z * distance - cylinder.center.z;
      if (distance > 1e-6 && x * x + z * z <= cylinder.radius ** 2)
        candidates.push({ distance, normal: { x: 0, y: sign, z: 0 } });
    }
  const nearest = candidates.sort((left, right) => left.distance - right.distance)[0];
  return nearest ? { ...nearest, color } : undefined;
}

function shade(hit: RayHit): readonly [number, number, number] {
  const light = normalized({ x: -0.4, y: 0.8, z: -0.45 });
  const diffuse = 0.35 + 0.65 * Math.max(0, dot(hit.normal, light));
  const depth = Math.max(0.45, Math.min(1, 1 - hit.distance / 500));
  return hit.color.map((channel) => Math.round(channel * diffuse * depth)) as unknown as readonly [
    number,
    number,
    number,
  ];
}

function sky(direction: Point): readonly [number, number, number] {
  const blend = Math.max(0, Math.min(1, direction.y * 0.5 + 0.5));
  return [Math.round(180 + 35 * blend), Math.round(205 + 30 * blend), Math.round(225 + 25 * blend)];
}

function colorFromIdentity(identity: string): readonly [number, number, number] {
  const hash = createHash("sha256").update(identity).digest();
  return [80 + (hash[0]! % 128), 80 + (hash[1]! % 128), 80 + (hash[2]! % 128)];
}

function terrainColor(materialId: string): readonly [number, number, number] {
  if (materialId === "Grass") return [91, 128, 72];
  if (materialId === "Sand") return [194, 176, 121];
  if (materialId === "Rock" || materialId === "Slate") return [112, 112, 108];
  return colorFromIdentity(`terrain:${materialId}`);
}

function add(left: Point, right: Point): Point {
  return { x: left.x + right.x, y: left.y + right.y, z: left.z + right.z };
}
function subtract(left: Point, right: Point): Point {
  return { x: left.x - right.x, y: left.y - right.y, z: left.z - right.z };
}
function scale(value: Point, factor: number): Point {
  return { x: value.x * factor, y: value.y * factor, z: value.z * factor };
}
function dot(left: Point, right: Point): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}
function cross(left: Point, right: Point): Point {
  return {
    x: left.y * right.z - left.z * right.y,
    y: left.z * right.x - left.x * right.z,
    z: left.x * right.y - left.y * right.x,
  };
}
function normalized(value: Point): Point {
  const length = Math.hypot(value.x, value.y, value.z);
  if (length <= 1e-12) throw new Error("Diagnostic render vector is degenerate");
  return { x: value.x / length, y: value.y / length, z: value.z / length };
}
