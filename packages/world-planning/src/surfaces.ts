import {
  CONSTRUCTED_SURFACE_SCHEMA,
  TERRAIN_FIELD_ARTIFACT_SCHEMA,
  type ConstructedSurface,
  type PlacementSurfaceKind,
  type TerrainFieldArtifact,
  type WorldVector3,
} from "./contracts.js";
import { contentHash, stableJson } from "../../contracts/src/index.js";

export interface SurfaceCoordinate {
  readonly u: number;
  readonly v: number;
}

export interface PlacementSurfaceSample {
  readonly surfaceId: string;
  readonly kind: PlacementSurfaceKind;
  readonly coordinate: SurfaceCoordinate;
  readonly position: WorldVector3;
  readonly normal: WorldVector3;
  readonly slopeDegrees: number;
  readonly regionWeights: Readonly<Record<string, number>>;
  readonly materialWeights: Readonly<Record<string, number>>;
  readonly navigable: boolean;
}

export interface PlacementSurfaceRay {
  readonly origin: WorldVector3;
  readonly direction: WorldVector3;
  readonly surfaceIds?: readonly string[];
  readonly minimumDistance?: number;
  readonly maximumDistance?: number;
}

export interface PlacementSurfaceRayHit {
  readonly surfaceId: string;
  readonly triangleIndex: number;
  readonly distance: number;
  readonly barycentricWeights: readonly [number, number, number];
  readonly sample: PlacementSurfaceSample;
}

export interface ConstructedSurfaceMesh {
  readonly vertices: readonly WorldVector3[];
  readonly triangles: readonly (readonly [number, number, number])[];
  readonly coordinates: readonly SurfaceCoordinate[];
  readonly normals: readonly WorldVector3[];
}

/** Exact finite mesh representation used by render, bounds, and repair consumers. */
export function constructedSurfaceMesh(surface: ConstructedSurface): ConstructedSurfaceMesh {
  if (surface.geometry.kind === "triangle_patch")
    return {
      vertices: surface.geometry.vertices.map((vertex) => canonicalVector(vertex.position)),
      triangles: surface.geometry.triangles,
      coordinates: surface.geometry.vertices.map((vertex) => ({
        u: canonicalNumber(vertex.coordinate.u),
        v: canonicalNumber(vertex.coordinate.v),
      })),
      normals: surface.geometry.vertices.map((vertex) => canonicalVector(vertex.normal)),
    };
  const geometry = surface.geometry;
  const vertices = [
    planarPoint(geometry, geometry.uRange.minimum, geometry.vRange.minimum),
    planarPoint(geometry, geometry.uRange.maximum, geometry.vRange.minimum),
    planarPoint(geometry, geometry.uRange.minimum, geometry.vRange.maximum),
    planarPoint(geometry, geometry.uRange.maximum, geometry.vRange.maximum),
  ];
  const normal = normalize(cross(geometry.uAxis, geometry.vAxis));
  return {
    vertices: vertices.map(canonicalVector),
    triangles: [
      [0, 1, 2],
      [1, 3, 2],
    ],
    coordinates: [
      { u: geometry.uRange.minimum, v: geometry.vRange.minimum },
      { u: geometry.uRange.maximum, v: geometry.vRange.minimum },
      { u: geometry.uRange.minimum, v: geometry.vRange.maximum },
      { u: geometry.uRange.maximum, v: geometry.vRange.maximum },
    ],
    normals: vertices.map(() => canonicalVector(normal)),
  };
}

/** Translate either surface representation without changing its parameterization. */
export function translatedConstructedSurface(
  surface: ConstructedSurface,
  translation: WorldVector3,
): ConstructedSurface {
  return CONSTRUCTED_SURFACE_SCHEMA.parse({
    ...surface,
    geometry:
      surface.geometry.kind === "planar_patch"
        ? { ...surface.geometry, origin: add(surface.geometry.origin, translation) }
        : {
            ...surface.geometry,
            vertices: surface.geometry.vertices.map((vertex) => ({
              ...vertex,
              position: add(vertex.position, translation),
            })),
          },
  });
}

/** Shared sampling authority for outdoor fields and bounded constructed patches. */
export class PlacementSurfaceIndex {
  readonly hash: string;
  private readonly terrain = new Map<string, TerrainFieldArtifact>();
  private readonly constructed = new Map<string, ConstructedSurface>();

  constructor(terrainFields: readonly unknown[], constructedSurfaces: readonly unknown[]) {
    for (const input of terrainFields) {
      const field = TERRAIN_FIELD_ARTIFACT_SCHEMA.parse(input);
      if (this.has(field.surfaceId))
        throw new Error(`Placement surface ID is duplicated: ${field.surfaceId}`);
      this.terrain.set(field.surfaceId, field);
    }
    for (const input of constructedSurfaces) {
      const surface = CONSTRUCTED_SURFACE_SCHEMA.parse(input);
      if (this.has(surface.id))
        throw new Error(`Placement surface ID is duplicated: ${surface.id}`);
      this.constructed.set(surface.id, surface);
    }
    this.hash = contentHash(
      stableJson({
        terrainFields: [...this.terrain.values()]
          .map((field) => ({ surfaceId: field.surfaceId, hash: field.hash }))
          .sort((left, right) => left.surfaceId.localeCompare(right.surfaceId)),
        constructedSurfaces: [...this.constructed.values()].sort((left, right) =>
          left.id.localeCompare(right.id),
        ),
      }),
    );
  }

  has(surfaceId: string): boolean {
    return this.terrain.has(surfaceId) || this.constructed.has(surfaceId);
  }

  ids(): string[] {
    return [...this.terrain.keys(), ...this.constructed.keys()].sort();
  }

  /** Produce a new immutable index with additional constructed surfaces registered. */
  withConstructedSurfaces(additionalConstructed: readonly unknown[]): PlacementSurfaceIndex {
    return new PlacementSurfaceIndex(
      [...this.terrain.values()],
      [...this.constructed.values(), ...additionalConstructed],
    );
  }

  /** Resolve compatibility without sampling an arbitrary coordinate. */
  kind(surfaceId: string): PlacementSurfaceKind {
    if (this.terrain.has(surfaceId)) return "terrain";
    const surface = this.constructed.get(surfaceId);
    if (surface) return surface.kind;
    throw new Error(`Placement surface does not exist: ${surfaceId}`);
  }

  sample(surfaceId: string, coordinate: SurfaceCoordinate): PlacementSurfaceSample {
    const field = this.terrain.get(surfaceId);
    if (field) return sampleTerrain(field, coordinate);
    const surface = this.constructed.get(surfaceId);
    if (surface) return sampleConstructed(surface, coordinate);
    throw new Error(`Placement surface does not exist: ${surfaceId}`);
  }

  coordinatesFromWorld(surfaceId: string, point: WorldVector3): SurfaceCoordinate {
    const field = this.terrain.get(surfaceId);
    if (field) return { u: point.x, v: point.z };
    const surface = this.constructed.get(surfaceId);
    if (!surface) throw new Error(`Placement surface does not exist: ${surfaceId}`);
    const geometry = surface.geometry;
    if (geometry.kind === "triangle_patch") {
      let closest:
        | {
            readonly distanceSquared: number;
            readonly weights: readonly [number, number, number];
            readonly triangle: readonly [number, number, number];
          }
        | undefined;
      for (const triangle of geometry.triangles) {
        const candidate = closestPointOnTriangle(
          point,
          geometry.vertices[triangle[0]]!.position,
          geometry.vertices[triangle[1]]!.position,
          geometry.vertices[triangle[2]]!.position,
        );
        if (!closest || candidate.distanceSquared < closest.distanceSquared - 1e-12)
          closest = { ...candidate, triangle };
      }
      const triangle = closest!.triangle;
      const vertices = triangle.map((index) => geometry.vertices[index]!);
      return {
        u: weightedNumber(
          vertices.map((vertex) => vertex.coordinate.u),
          closest!.weights,
        ),
        v: weightedNumber(
          vertices.map((vertex) => vertex.coordinate.v),
          closest!.weights,
        ),
      };
    }
    const offset = {
      x: point.x - geometry.origin.x,
      y: point.y - geometry.origin.y,
      z: point.z - geometry.origin.z,
    };
    return {
      u: dot(offset, geometry.uAxis),
      v: dot(offset, geometry.vAxis),
    };
  }

  coordinateBounds(surfaceId: string): {
    u: { minimum: number; maximum: number };
    v: { minimum: number; maximum: number };
  } {
    const field = this.terrain.get(surfaceId);
    if (field)
      return {
        u: { minimum: field.bounds.x.minimum, maximum: field.bounds.x.maximum },
        v: { minimum: field.bounds.z.minimum, maximum: field.bounds.z.maximum },
      };
    const surface = this.constructed.get(surfaceId);
    if (surface) {
      if (surface.geometry.kind === "planar_patch")
        return { u: surface.geometry.uRange, v: surface.geometry.vRange };
      const coordinates = surface.geometry.vertices.map((vertex) => vertex.coordinate);
      return {
        u: {
          minimum: Math.min(...coordinates.map((coordinate) => coordinate.u)),
          maximum: Math.max(...coordinates.map((coordinate) => coordinate.u)),
        },
        v: {
          minimum: Math.min(...coordinates.map((coordinate) => coordinate.v)),
          maximum: Math.max(...coordinates.map((coordinate) => coordinate.v)),
        },
      };
    }
    throw new Error(`Placement surface does not exist: ${surfaceId}`);
  }

  regionIds(surfaceId: string): string[] {
    const field = this.terrain.get(surfaceId);
    if (field)
      return [
        ...new Set(field.samples.flatMap((sample) => Object.keys(sample.regionWeights))),
      ].sort();
    const surface = this.constructed.get(surfaceId);
    if (surface) return [surface.regionId];
    throw new Error(`Placement surface does not exist: ${surfaceId}`);
  }

  /**
   * Maximum spacing that still observes every terrain-field cell crossed by a
   * route. Planar patch segment ends are exact. Triangle patches return a
   * conservative coordinate-space step derived from their shortest mesh edge.
   */
  routeSamplingStep(surfaceId: string): number | undefined {
    const field = this.terrain.get(surfaceId);
    if (field)
      return Math.min(
        (field.bounds.x.maximum - field.bounds.x.minimum) / (field.resolution.columns - 1),
        (field.bounds.z.maximum - field.bounds.z.minimum) / (field.resolution.rows - 1),
      );
    const surface = this.constructed.get(surfaceId);
    if (surface?.geometry.kind === "planar_patch") return undefined;
    if (surface?.geometry.kind === "triangle_patch") {
      const geometry = surface.geometry;
      let step = Number.POSITIVE_INFINITY;
      for (const triangle of geometry.triangles) {
        const coordinates = triangle.map((index) => geometry.vertices[index]!.coordinate);
        const twiceArea = Math.abs(
          (coordinates[1]!.u - coordinates[0]!.u) * (coordinates[2]!.v - coordinates[0]!.v) -
            (coordinates[1]!.v - coordinates[0]!.v) * (coordinates[2]!.u - coordinates[0]!.u),
        );
        for (let index = 0; index < 3; index += 1) {
          const first = coordinates[index]!;
          const second = coordinates[(index + 1) % 3]!;
          const edgeLength = Math.hypot(first.u - second.u, first.v - second.v);
          step = Math.min(step, twiceArea / edgeLength / 2);
        }
      }
      return step;
    }
    throw new Error(`Placement surface does not exist: ${surfaceId}`);
  }

  /**
   * Intersect the exact indexed triangles used by surface sampling and export.
   * Rays are two-sided; the nearest positive hit wins with stable ID/index tie-breaking.
   */
  raycast(ray: PlacementSurfaceRay): PlacementSurfaceRayHit | undefined {
    assertFiniteVector(ray.origin, "Ray origin");
    assertFiniteVector(ray.direction, "Ray direction");
    const direction = normalize(ray.direction);
    const minimumDistance = ray.minimumDistance ?? 0;
    const maximumDistance = ray.maximumDistance ?? Number.POSITIVE_INFINITY;
    if (
      !Number.isFinite(minimumDistance) ||
      minimumDistance < 0 ||
      (!(maximumDistance > minimumDistance) && maximumDistance !== Number.POSITIVE_INFINITY)
    )
      throw new Error("Ray distance interval is invalid");
    const surfaceIds = ray.surfaceIds ? [...ray.surfaceIds] : this.ids();
    if (new Set(surfaceIds).size !== surfaceIds.length)
      throw new Error("Ray surface IDs must be unique");
    surfaceIds.sort();
    for (const surfaceId of surfaceIds)
      if (!this.has(surfaceId)) throw new Error(`Placement surface does not exist: ${surfaceId}`);

    let nearest: PlacementSurfaceRayHit | undefined;
    const consider = (
      surfaceId: string,
      triangleIndex: number,
      first: WorldVector3,
      second: WorldVector3,
      third: WorldVector3,
      coordinates: readonly [SurfaceCoordinate, SurfaceCoordinate, SurfaceCoordinate],
      sampleFromWeights?: (
        weights: readonly [number, number, number],
        coordinate: SurfaceCoordinate,
      ) => PlacementSurfaceSample,
    ): void => {
      const intersection = intersectRayTriangle(ray.origin, direction, first, second, third);
      if (
        !intersection ||
        intersection.distance < minimumDistance - 1e-9 ||
        intersection.distance > maximumDistance + 1e-9
      )
        return;
      if (
        nearest &&
        (intersection.distance > nearest.distance + 1e-9 ||
          (Math.abs(intersection.distance - nearest.distance) <= 1e-9 &&
            (surfaceId > nearest.surfaceId ||
              (surfaceId === nearest.surfaceId && triangleIndex >= nearest.triangleIndex))))
      )
        return;
      const coordinate = {
        u: weightedNumber(
          coordinates.map((entry) => entry.u),
          intersection.barycentricWeights,
        ),
        v: weightedNumber(
          coordinates.map((entry) => entry.v),
          intersection.barycentricWeights,
        ),
      };
      nearest = {
        surfaceId,
        triangleIndex,
        distance: intersection.distance,
        barycentricWeights: intersection.barycentricWeights,
        sample: sampleFromWeights
          ? sampleFromWeights(intersection.barycentricWeights, coordinate)
          : this.sample(surfaceId, coordinate),
      };
    };

    for (const surfaceId of surfaceIds) {
      const field = this.terrain.get(surfaceId);
      if (field) {
        let triangleIndex = 0;
        for (let row = 0; row < field.resolution.rows - 1; row += 1)
          for (let column = 0; column < field.resolution.columns - 1; column += 1) {
            const backLeft = row * field.resolution.columns + column;
            const backRight = backLeft + 1;
            const frontLeft = backLeft + field.resolution.columns;
            const frontRight = frontLeft + 1;
            for (const triangle of [
              [backLeft, frontLeft, backRight],
              [backRight, frontLeft, frontRight],
            ] as const) {
              const samples = triangle.map(
                (index) => field.samples[index]!,
              ) as unknown as readonly [
                TerrainFieldArtifact["samples"][number],
                TerrainFieldArtifact["samples"][number],
                TerrainFieldArtifact["samples"][number],
              ];
              consider(
                surfaceId,
                triangleIndex,
                samples[0].position,
                samples[1].position,
                samples[2].position,
                samples.map((sample) => ({
                  u: sample.position.x,
                  v: sample.position.z,
                })) as unknown as readonly [
                  SurfaceCoordinate,
                  SurfaceCoordinate,
                  SurfaceCoordinate,
                ],
                (weights, coordinate) =>
                  interpolateTerrainTriangle(field, samples, weights, coordinate),
              );
              triangleIndex += 1;
            }
          }
        continue;
      }
      const surface = this.constructed.get(surfaceId)!;
      const mesh = constructedSurfaceMesh(surface);
      for (const [triangleIndex, triangle] of mesh.triangles.entries()) {
        const coordinates = triangle.map(
          (index) => mesh.coordinates[index]!,
        ) as unknown as readonly [SurfaceCoordinate, SurfaceCoordinate, SurfaceCoordinate];
        consider(
          surfaceId,
          triangleIndex,
          mesh.vertices[triangle[0]]!,
          mesh.vertices[triangle[1]]!,
          mesh.vertices[triangle[2]]!,
          coordinates,
          (weights, coordinate) =>
            interpolateConstructedTriangle(surface, mesh, triangle, weights, coordinate),
        );
      }
    }
    return nearest;
  }
}

function interpolateConstructedTriangle(
  surface: ConstructedSurface,
  mesh: ConstructedSurfaceMesh,
  triangle: readonly [number, number, number],
  weights: readonly [number, number, number],
  coordinate: SurfaceCoordinate,
): PlacementSurfaceSample {
  const position = weightedVector(
    triangle.map((index) => mesh.vertices[index]!),
    weights,
  );
  const normal = normalize(
    weightedVector(
      triangle.map((index) => mesh.normals[index]!),
      weights,
    ),
  );
  return {
    surfaceId: surface.id,
    kind: surface.kind,
    coordinate,
    position,
    normal,
    slopeDegrees: (Math.acos(clamp(normal.y, -1, 1)) * 180) / Math.PI,
    regionWeights: { [surface.regionId]: 1 },
    materialWeights: { [surface.materialId]: 1 },
    navigable: surface.navigable,
  };
}

function sampleTerrain(
  field: TerrainFieldArtifact,
  coordinate: SurfaceCoordinate,
): PlacementSurfaceSample {
  const { columns, rows } = field.resolution;
  const uAmount = normalizedAmount(
    coordinate.u,
    field.bounds.x.minimum,
    field.bounds.x.maximum,
    field.surfaceId,
  );
  const vAmount = normalizedAmount(
    coordinate.v,
    field.bounds.z.minimum,
    field.bounds.z.maximum,
    field.surfaceId,
  );
  const columnPosition = uAmount * (columns - 1);
  const rowPosition = vAmount * (rows - 1);
  const leftColumn = Math.min(columns - 2, Math.floor(columnPosition));
  const rightColumn = leftColumn + 1;
  const backRow = Math.min(rows - 2, Math.floor(rowPosition));
  const frontRow = backRow + 1;
  const uBlend = columnPosition - leftColumn;
  const vBlend = rowPosition - backRow;
  const backLeft = field.samples[backRow * columns + leftColumn]!;
  const backRight = field.samples[backRow * columns + rightColumn]!;
  const frontLeft = field.samples[frontRow * columns + leftColumn]!;
  const frontRight = field.samples[frontRow * columns + rightColumn]!;
  const [samples, weights] =
    uBlend + vBlend <= 1
      ? ([
          [backLeft, frontLeft, backRight],
          [1 - uBlend - vBlend, vBlend, uBlend],
        ] as const)
      : ([
          [backRight, frontLeft, frontRight],
          [1 - vBlend, 1 - uBlend, uBlend + vBlend - 1],
        ] as const);
  return interpolateTerrainTriangle(field, samples, weights, coordinate);
}

function interpolateTerrainTriangle(
  field: TerrainFieldArtifact,
  samples: readonly [
    TerrainFieldArtifact["samples"][number],
    TerrainFieldArtifact["samples"][number],
    TerrainFieldArtifact["samples"][number],
  ],
  weights: readonly [number, number, number],
  coordinate: SurfaceCoordinate,
): PlacementSurfaceSample {
  const normal = normalize(
    weightedVector(
      samples.map((sample) => sample.normal),
      weights,
    ),
  );
  return {
    surfaceId: field.surfaceId,
    kind: "terrain",
    coordinate,
    position: weightedVector(
      samples.map((sample) => sample.position),
      weights,
    ),
    normal,
    slopeDegrees: (Math.acos(clamp(normal.y, -1, 1)) * 180) / Math.PI,
    regionWeights: weightedRecord(
      samples.map((sample) => sample.regionWeights),
      weights,
    ),
    materialWeights: weightedRecord(
      samples.map((sample) => sample.materialWeights),
      weights,
    ),
    navigable: samples.every((sample, index) => weights[index]! <= 1e-9 || sample.navigable),
  };
}

function sampleConstructed(
  surface: ConstructedSurface,
  coordinate: SurfaceCoordinate,
): PlacementSurfaceSample {
  const geometry = surface.geometry;
  if (geometry.kind === "triangle_patch") {
    for (const triangle of geometry.triangles) {
      const vertices = triangle.map((index) => geometry.vertices[index]!);
      const weights = barycentricCoordinateWeights(
        coordinate,
        vertices[0]!.coordinate,
        vertices[1]!.coordinate,
        vertices[2]!.coordinate,
      );
      if (weights.some((weight) => weight < -1e-8)) continue;
      const normal = normalize(
        weightedVector(
          vertices.map((vertex) => vertex.normal),
          weights,
        ),
      );
      return {
        surfaceId: surface.id,
        kind: surface.kind,
        coordinate,
        position: weightedVector(
          vertices.map((vertex) => vertex.position),
          weights,
        ),
        normal,
        slopeDegrees: (Math.acos(clamp(normal.y, -1, 1)) * 180) / Math.PI,
        regionWeights: { [surface.regionId]: 1 },
        materialWeights: { [surface.materialId]: 1 },
        navigable: surface.navigable,
      };
    }
    throw new Error(`Surface coordinate is outside ${surface.id}`);
  }
  normalizedAmount(coordinate.u, geometry.uRange.minimum, geometry.uRange.maximum, surface.id);
  normalizedAmount(coordinate.v, geometry.vRange.minimum, geometry.vRange.maximum, surface.id);
  const normal = normalize(cross(geometry.uAxis, geometry.vAxis));
  return {
    surfaceId: surface.id,
    kind: surface.kind,
    coordinate,
    position: {
      x: geometry.origin.x + geometry.uAxis.x * coordinate.u + geometry.vAxis.x * coordinate.v,
      y: geometry.origin.y + geometry.uAxis.y * coordinate.u + geometry.vAxis.y * coordinate.v,
      z: geometry.origin.z + geometry.uAxis.z * coordinate.u + geometry.vAxis.z * coordinate.v,
    },
    normal,
    slopeDegrees: (Math.acos(clamp(normal.y, -1, 1)) * 180) / Math.PI,
    regionWeights: { [surface.regionId]: 1 },
    materialWeights: { [surface.materialId]: 1 },
    navigable: surface.navigable,
  };
}

function planarPoint(
  geometry: Extract<ConstructedSurface["geometry"], { readonly kind: "planar_patch" }>,
  u: number,
  v: number,
): WorldVector3 {
  return {
    x: geometry.origin.x + geometry.uAxis.x * u + geometry.vAxis.x * v,
    y: geometry.origin.y + geometry.uAxis.y * u + geometry.vAxis.y * v,
    z: geometry.origin.z + geometry.uAxis.z * u + geometry.vAxis.z * v,
  };
}

function weightedNumber(values: readonly number[], weights: readonly number[]): number {
  return values.reduce((sum, value, index) => sum + value * weights[index]!, 0);
}

function weightedVector(values: readonly WorldVector3[], weights: readonly number[]): WorldVector3 {
  return {
    x: weightedNumber(
      values.map((value) => value.x),
      weights,
    ),
    y: weightedNumber(
      values.map((value) => value.y),
      weights,
    ),
    z: weightedNumber(
      values.map((value) => value.z),
      weights,
    ),
  };
}

function weightedRecord(
  values: readonly Readonly<Record<string, number>>[],
  weights: readonly number[],
): Record<string, number> {
  const keys = [...new Set(values.flatMap((value) => Object.keys(value)))].sort();
  const raw = keys.map((key) =>
    values.reduce((sum, value, index) => sum + (value[key] ?? 0) * weights[index]!, 0),
  );
  const total = raw.reduce((sum, value) => sum + value, 0);
  const result: Record<string, number> = {};
  let assigned = 0;
  for (let index = 0; index < keys.length; index += 1) {
    const value =
      index === keys.length - 1
        ? Math.max(0, 1 - assigned)
        : Math.min(1 - assigned, Math.max(0, raw[index]! / total));
    result[keys[index]!] = value;
    assigned += value;
  }
  return result;
}

function normalizedAmount(
  value: number,
  minimum: number,
  maximum: number,
  surfaceId: string,
): number {
  if (!Number.isFinite(value) || value < minimum - 1e-8 || value > maximum + 1e-8)
    throw new Error(`Surface coordinate is outside ${surfaceId}`);
  return clamp((value - minimum) / (maximum - minimum), 0, 1);
}

function normalize(value: WorldVector3): WorldVector3 {
  const length = Math.hypot(value.x, value.y, value.z);
  if (!(length > 1e-12)) throw new Error("Placement surface has a degenerate normal");
  return { x: value.x / length, y: value.y / length, z: value.z / length };
}

function dot(left: WorldVector3, right: WorldVector3): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function cross(left: WorldVector3, right: WorldVector3): WorldVector3 {
  return {
    x: left.y * right.z - left.z * right.y,
    y: left.z * right.x - left.x * right.z,
    z: left.x * right.y - left.y * right.x,
  };
}

function barycentricCoordinateWeights(
  point: SurfaceCoordinate,
  first: SurfaceCoordinate,
  second: SurfaceCoordinate,
  third: SurfaceCoordinate,
): [number, number, number] {
  const denominator =
    (second.v - third.v) * (first.u - third.u) + (third.u - second.u) * (first.v - third.v);
  const firstWeight =
    ((second.v - third.v) * (point.u - third.u) + (third.u - second.u) * (point.v - third.v)) /
    denominator;
  const secondWeight =
    ((third.v - first.v) * (point.u - third.u) + (first.u - third.u) * (point.v - third.v)) /
    denominator;
  return [firstWeight, secondWeight, 1 - firstWeight - secondWeight];
}

function closestPointOnTriangle(
  point: WorldVector3,
  first: WorldVector3,
  second: WorldVector3,
  third: WorldVector3,
): { readonly distanceSquared: number; readonly weights: readonly [number, number, number] } {
  const ab = subtract(second, first);
  const ac = subtract(third, first);
  const ap = subtract(point, first);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return distanceResult(point, first, [1, 0, 0]);

  const bp = subtract(point, second);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return distanceResult(point, second, [0, 1, 0]);

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const amount = d1 / (d1 - d3);
    return distanceResult(point, add(first, multiply(ab, amount)), [1 - amount, amount, 0]);
  }

  const cp = subtract(point, third);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return distanceResult(point, third, [0, 0, 1]);

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const amount = d2 / (d2 - d6);
    return distanceResult(point, add(first, multiply(ac, amount)), [1 - amount, 0, amount]);
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const amount = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return distanceResult(point, add(second, multiply(subtract(third, second), amount)), [
      0,
      1 - amount,
      amount,
    ]);
  }

  const denominator = 1 / (va + vb + vc);
  const secondWeight = vb * denominator;
  const thirdWeight = vc * denominator;
  const firstWeight = 1 - secondWeight - thirdWeight;
  return distanceResult(
    point,
    add(first, add(multiply(ab, secondWeight), multiply(ac, thirdWeight))),
    [firstWeight, secondWeight, thirdWeight],
  );
}

function distanceResult(
  point: WorldVector3,
  closest: WorldVector3,
  weights: readonly [number, number, number],
): { readonly distanceSquared: number; readonly weights: readonly [number, number, number] } {
  const offset = subtract(point, closest);
  return { distanceSquared: dot(offset, offset), weights };
}

function add(left: WorldVector3, right: WorldVector3): WorldVector3 {
  return { x: left.x + right.x, y: left.y + right.y, z: left.z + right.z };
}

function subtract(left: WorldVector3, right: WorldVector3): WorldVector3 {
  return { x: left.x - right.x, y: left.y - right.y, z: left.z - right.z };
}

function multiply(value: WorldVector3, factor: number): WorldVector3 {
  return { x: value.x * factor, y: value.y * factor, z: value.z * factor };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function canonicalNumber(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

function canonicalVector(value: WorldVector3): WorldVector3 {
  return {
    x: canonicalNumber(value.x),
    y: canonicalNumber(value.y),
    z: canonicalNumber(value.z),
  };
}

function assertFiniteVector(value: WorldVector3, label: string): void {
  if (![value.x, value.y, value.z].every(Number.isFinite))
    throw new Error(`${label} must be finite`);
}

function intersectRayTriangle(
  origin: WorldVector3,
  direction: WorldVector3,
  first: WorldVector3,
  second: WorldVector3,
  third: WorldVector3,
):
  | {
      readonly distance: number;
      readonly barycentricWeights: readonly [number, number, number];
    }
  | undefined {
  const edgeOne = subtract(second, first);
  const edgeTwo = subtract(third, first);
  const perpendicular = cross(direction, edgeTwo);
  const determinant = dot(edgeOne, perpendicular);
  if (Math.abs(determinant) <= 1e-12) return undefined;
  const inverse = 1 / determinant;
  const fromFirst = subtract(origin, first);
  const secondWeight = dot(fromFirst, perpendicular) * inverse;
  if (secondWeight < -1e-10 || secondWeight > 1 + 1e-10) return undefined;
  const crossFromFirst = cross(fromFirst, edgeOne);
  const thirdWeight = dot(direction, crossFromFirst) * inverse;
  if (thirdWeight < -1e-10 || secondWeight + thirdWeight > 1 + 1e-10) return undefined;
  const distance = dot(edgeTwo, crossFromFirst) * inverse;
  if (distance < -1e-10) return undefined;
  return {
    distance: Math.max(0, distance),
    barycentricWeights: [1 - secondWeight - thirdWeight, secondWeight, thirdWeight],
  };
}
