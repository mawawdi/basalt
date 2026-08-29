import { contentHash, stableJson } from "../../contracts/src/index.js";
import {
  TERRAIN_FIELD_ABI,
  TERRAIN_FIELD_ARTIFACT_SCHEMA,
  TERRAIN_MATERIAL_BLEND_ABI,
  TERRAIN_MATERIAL_BLEND_ARTIFACT_SCHEMA,
  TERRAIN_STYLE_OVERLAY_BINDING_ABI,
  TERRAIN_PLAN_SCHEMA,
  WORLD_PLAN_SCHEMA,
  type TerrainFieldArtifact,
  type TerrainMaterialBlendArtifact,
  type TerrainOperation,
  type TerrainPlan,
  WORLD_STYLE_OVERLAY_SCHEMA,
  type WorldStyleOverlay,
  type WorldPoint2,
  type WorldRoute,
  type WorldVector3,
} from "./contracts.js";
import { PlacementSurfaceIndex } from "./surfaces.js";

/** Bounds one exported terrain partition for Roblox streaming and adaptation. */
export const TERRAIN_EXPORT_MAX_TRIANGLES = 20_000 as const;
const TERRAIN_EXPORT_MAX_CELL_AXIS = Math.floor(Math.sqrt(TERRAIN_EXPORT_MAX_TRIANGLES / 2));

/** Compile semantic terrain intent into one deterministic, content-addressed field. */
export function compileTerrainPlan(input: unknown): TerrainFieldArtifact {
  const plan = canonicalTerrainPlan(input);
  const { columns, rows } = plan.resolution;
  const stepX = (plan.bounds.x.maximum - plan.bounds.x.minimum) / (columns - 1);
  const stepZ = (plan.bounds.z.maximum - plan.bounds.z.minimum) / (rows - 1);
  const regionWeightRows: Array<Record<string, number>> = [];
  const materialWeightRows: Array<Record<string, number>> = [];
  let heights: number[] = [];

  for (let row = 0; row < rows; row += 1) {
    const z = plan.bounds.z.minimum + row * stepZ;
    for (let column = 0; column < columns; column += 1) {
      const x = plan.bounds.x.minimum + column * stepX;
      const regionWeights = weightsAt(plan, { x, z });
      const materialWeights = materialsAt(plan, regionWeights);
      let height = 0;
      for (const region of plan.regions) {
        const regionWeight = regionWeights[region.regionId] ?? 0;
        let regionHeight = region.baseElevation;
        for (const layer of region.noiseLayers)
          regionHeight += fractalNoise(x, z, plan.seed, layer) * layer.amplitude;
        height += regionHeight * regionWeight;
      }
      regionWeightRows.push(regionWeights);
      materialWeightRows.push(materialWeights);
      heights.push(f32(height));
    }
  }

  for (const operation of plan.operations) {
    if (operation.kind === "erosion") {
      heights = erode(heights, plan, operation, regionWeightRows);
    } else if (operation.kind === "local_patch" && operation.edit.kind === "smooth") {
      heights = smoothLocalPatch(heights, plan, operation, regionWeightRows);
    } else {
      heights = heights.map((height, index) => {
        const row = Math.floor(index / columns);
        const column = index % columns;
        return f32(
          applyHeightOperation(
            height,
            {
              x: plan.bounds.x.minimum + column * stepX,
              z: plan.bounds.z.minimum + row * stepZ,
            },
            operation,
            regionWeightRows[index]!,
          ),
        );
      });
    }
  }

  const samples = heights.map((height, index) => {
    const row = Math.floor(index / columns);
    const column = index % columns;
    const x = plan.bounds.x.minimum + column * stepX;
    const z = plan.bounds.z.minimum + row * stepZ;
    const left = heights[row * columns + Math.max(0, column - 1)]!;
    const right = heights[row * columns + Math.min(columns - 1, column + 1)]!;
    const back = heights[Math.max(0, row - 1) * columns + column]!;
    const front = heights[Math.min(rows - 1, row + 1) * columns + column]!;
    const dxDivisor = column === 0 || column === columns - 1 ? stepX : stepX * 2;
    const dzDivisor = row === 0 || row === rows - 1 ? stepZ : stepZ * 2;
    const normal = normalize({
      x: -(right - left) / dxDivisor,
      y: 1,
      z: -(front - back) / dzDivisor,
    });
    const slopeDegrees = (Math.acos(clamp(normal.y, -1, 1)) * 180) / Math.PI;
    return {
      position: { x: f32(x), y: height, z: f32(z) },
      normal,
      slopeDegrees: f32(slopeDegrees),
      regionWeights: regionWeightRows[index]!,
      materialWeights: materialWeightRows[index]!,
      navigable: slopeDegrees <= plan.navigation.maximumSlopeDegrees,
    };
  });
  const material = {
    kind: "TerrainFieldArtifact" as const,
    abi: TERRAIN_FIELD_ABI,
    id: `TerrainField_${contentHash(plan.id).slice(0, 24)}`,
    planHash: contentHash(stableJson(plan)),
    surfaceId: plan.surfaceId,
    bounds: plan.bounds,
    resolution: plan.resolution,
    samples,
  };
  return TERRAIN_FIELD_ARTIFACT_SCHEMA.parse({
    ...material,
    hash: contentHash(stableJson(material)),
  });
}

/**
 * Bind a seasonal or regional style overlay without touching terrain bytes.
 * Elevation, river/operation order, region weights, and navigability remain
 * addressed by the original TerrainFieldArtifact hash.
 */
export function bindTerrainStyleOverlay(input: {
  readonly terrainField: TerrainFieldArtifact;
  readonly overlay: WorldStyleOverlay;
}) {
  const field = TERRAIN_FIELD_ARTIFACT_SCHEMA.parse(input.terrainField);
  const overlay = WORLD_STYLE_OVERLAY_SCHEMA.parse(input.overlay);
  if (overlay.terrainFieldHash !== field.hash)
    throw new Error("Style overlay must bind the exact compiled terrain field hash");
  const material = {
    kind: "TerrainStyleOverlayBinding" as const,
    abi: TERRAIN_STYLE_OVERLAY_BINDING_ABI,
    terrainFieldHash: field.hash,
    overlay,
  };
  return Object.freeze({
    ...material,
    terrainField: field,
    hash: contentHash(stableJson(material)),
  });
}

/** Canonicalize only declaration sets; ordered height operations and polygon paths stay ordered. */
export function canonicalTerrainPlan(input: unknown): TerrainPlan {
  const plan = structuredClone(TERRAIN_PLAN_SCHEMA.parse(input));
  plan.regions.sort((left, right) => left.regionId.localeCompare(right.regionId));
  for (const region of plan.regions) {
    region.noiseLayers.sort((left, right) => left.id.localeCompare(right.id));
    region.materialWeights.sort((left, right) => left.materialId.localeCompare(right.materialId));
  }
  return TERRAIN_PLAN_SCHEMA.parse(plan);
}

/** Convert one field to a bounded, seamless indexed grid for the fixed scene compiler. */
export function terrainFieldMesh(fieldInput: unknown, geometryId: string) {
  const field = TERRAIN_FIELD_ARTIFACT_SCHEMA.parse(fieldInput);
  const { columns, rows } = field.resolution;
  const triangles: Array<[number, number, number]> = [];
  for (let row = 0; row < rows - 1; row += 1)
    for (let column = 0; column < columns - 1; column += 1) {
      const backLeft = row * columns + column;
      const backRight = backLeft + 1;
      const frontLeft = backLeft + columns;
      const frontRight = frontLeft + 1;
      triangles.push([backLeft, frontLeft, backRight], [backRight, frontLeft, frontRight]);
    }
  return {
    kind: "indexed_mesh" as const,
    id: geometryId,
    vertices: field.samples.map((sample) => sample.position),
    triangles,
    uvs: field.samples.map((sample) => ({
      x:
        (sample.position.x - field.bounds.x.minimum) /
        (field.bounds.x.maximum - field.bounds.x.minimum),
      y:
        (sample.position.z - field.bounds.z.minimum) /
        (field.bounds.z.maximum - field.bounds.z.minimum),
    })),
    normals: field.samples.map((sample) => sample.normal),
    tangentMode: "mikktspace" as const,
  };
}

export interface TerrainFieldPartition {
  readonly id: string;
  readonly fieldHash: string;
  readonly fieldBounds: TerrainFieldArtifact["bounds"];
  readonly fieldResolution: TerrainFieldArtifact["resolution"];
  readonly columnRange: readonly [number, number];
  readonly rowRange: readonly [number, number];
  readonly resolution: { readonly columns: number; readonly rows: number };
  readonly sourceSampleIndices: readonly number[];
  readonly samples: TerrainFieldArtifact["samples"];
  readonly triangles: readonly (readonly [number, number, number])[];
  readonly hash: string;
}

/** Partition a field while retaining exact source samples on every shared edge. */
export function partitionTerrainField(
  fieldInput: unknown,
  partitionColumns: number,
  partitionRows: number,
): TerrainFieldPartition[] {
  const field = TERRAIN_FIELD_ARTIFACT_SCHEMA.parse(fieldInput);
  if (
    !Number.isInteger(partitionColumns) ||
    !Number.isInteger(partitionRows) ||
    partitionColumns < 1 ||
    partitionRows < 1
  )
    throw new Error("Terrain partition grid must use positive integers");
  if (partitionColumns >= field.resolution.columns || partitionRows >= field.resolution.rows)
    throw new Error("Terrain partition grid cannot exceed field cell dimensions");
  const result: TerrainFieldPartition[] = [];
  const totalCellColumns = field.resolution.columns - 1;
  const totalCellRows = field.resolution.rows - 1;
  for (let partitionRow = 0; partitionRow < partitionRows; partitionRow += 1)
    for (let partitionColumn = 0; partitionColumn < partitionColumns; partitionColumn += 1) {
      const firstColumn = Math.floor((partitionColumn * totalCellColumns) / partitionColumns);
      const lastColumn = Math.floor(((partitionColumn + 1) * totalCellColumns) / partitionColumns);
      const firstRow = Math.floor((partitionRow * totalCellRows) / partitionRows);
      const lastRow = Math.floor(((partitionRow + 1) * totalCellRows) / partitionRows);
      const sourceSampleIndices: number[] = [];
      const samples: TerrainFieldArtifact["samples"] = [];
      const localColumns = lastColumn - firstColumn + 1;
      for (let row = firstRow; row <= lastRow; row += 1)
        for (let column = firstColumn; column <= lastColumn; column += 1) {
          const sourceIndex = row * field.resolution.columns + column;
          sourceSampleIndices.push(sourceIndex);
          samples.push(structuredClone(field.samples[sourceIndex]!));
        }
      const triangles: Array<[number, number, number]> = [];
      for (let row = 0; row < lastRow - firstRow; row += 1)
        for (let column = 0; column < lastColumn - firstColumn; column += 1) {
          const backLeft = row * localColumns + column;
          triangles.push(
            [backLeft, backLeft + localColumns, backLeft + 1],
            [backLeft + 1, backLeft + localColumns, backLeft + localColumns + 1],
          );
        }
      const material = {
        id: `${field.id}_${partitionRow}_${partitionColumn}`,
        fieldHash: field.hash,
        fieldBounds: field.bounds,
        fieldResolution: field.resolution,
        columnRange: [firstColumn, lastColumn] as const,
        rowRange: [firstRow, lastRow] as const,
        resolution: {
          columns: lastColumn - firstColumn + 1,
          rows: lastRow - firstRow + 1,
        },
        sourceSampleIndices,
        samples,
        triangles,
      };
      result.push({ ...material, hash: contentHash(stableJson(material)) });
    }
  assertTerrainPartitionContinuity(result);
  return result;
}

/**
 * Split a high-density field into deterministic mesh jobs that each satisfy the
 * Basalt partition ABI. Shared boundary samples are retained byte-for-byte.
 */
/** Lower one retained partition to the Basalt indexed-mesh contract. */
export function terrainFieldPartitionMesh(partition: TerrainFieldPartition, geometryId: string) {
  return {
    kind: "indexed_mesh" as const,
    id: geometryId,
    vertices: partition.samples.map((sample) => sample.position),
    triangles: partition.triangles.map((triangle) => [...triangle] as [number, number, number]),
    uvs: partition.samples.map((sample) => ({
      x:
        (sample.position.x - partition.fieldBounds.x.minimum) /
        (partition.fieldBounds.x.maximum - partition.fieldBounds.x.minimum),
      y:
        (sample.position.z - partition.fieldBounds.z.minimum) /
        (partition.fieldBounds.z.maximum - partition.fieldBounds.z.minimum),
    })),
    normals: partition.samples.map((sample) => sample.normal),
    tangentMode: "mikktspace" as const,
  };
}

export interface TerrainMaterialTextureDensity {
  readonly minimumPixelsPerStud: number;
  readonly targetPixelsPerStud: number;
  readonly maximumPixelsPerStud: number;
  readonly maximumTextureDimension: number;
}

export interface TerrainMaterialPartition extends TerrainFieldPartition {
  readonly materialBlend: TerrainMaterialBlendArtifact;
  readonly textureSize: { readonly width: number; readonly height: number };
  readonly surfaceAreaStuds2: number;
  readonly worldSamplingPixelsPerStud: number;
  readonly achievedPixelsPerStud: number;
}

/**
 * Split a terrain by both geometry and material-resolution budgets.
 *
 * Every returned bake contains the exact normalized source weights plus a one-cell
 * halo. Texture pixels are evaluated in source-field coordinates, so a shared edge
 * receives byte-identical PBR values even when neighboring texture dimensions differ.
 */
export function partitionTerrainFieldForMaterialExport(
  fieldInput: unknown,
  densityInput: TerrainMaterialTextureDensity,
): TerrainMaterialPartition[] {
  const field = TERRAIN_FIELD_ARTIFACT_SCHEMA.parse(fieldInput);
  const density = validateTerrainMaterialTextureDensity(densityInput);
  const cellColumns = field.resolution.columns - 1;
  const cellRows = field.resolution.rows - 1;
  const width = field.bounds.x.maximum - field.bounds.x.minimum;
  const depth = field.bounds.z.maximum - field.bounds.z.minimum;
  let partitionColumns = Math.max(
    Math.ceil(cellColumns / TERRAIN_EXPORT_MAX_CELL_AXIS),
    Math.ceil((width * density.targetPixelsPerStud) / density.maximumTextureDimension),
  );
  let partitionRows = Math.max(
    Math.ceil(cellRows / TERRAIN_EXPORT_MAX_CELL_AXIS),
    Math.ceil((depth * density.targetPixelsPerStud) / density.maximumTextureDimension),
  );

  while (partitionColumns <= cellColumns && partitionRows <= cellRows) {
    const partitions = partitionTerrainField(field, partitionColumns, partitionRows);
    const worldSamplingPixelsPerStud = terrainWorldSamplingDensity(partitions, density);
    const measured = partitions.map((partition) => {
      const texture = terrainPartitionTextureMetrics(partition, worldSamplingPixelsPerStud);
      return {
        ...partition,
        materialBlend: terrainMaterialBlendArtifact(field, partition),
        textureSize: { width: texture.width, height: texture.height },
        surfaceAreaStuds2: texture.surfaceAreaStuds2,
        worldSamplingPixelsPerStud,
        achievedPixelsPerStud: texture.achievedPixelsPerStud,
      } satisfies TerrainMaterialPartition;
    });
    const invalid = measured.filter(
      (partition) =>
        partition.textureSize.width > density.maximumTextureDimension ||
        partition.textureSize.height > density.maximumTextureDimension ||
        partition.achievedPixelsPerStud + 1e-6 < density.minimumPixelsPerStud ||
        partition.achievedPixelsPerStud - 1e-6 > density.maximumPixelsPerStud,
    );
    if (invalid.length === 0) return measured;

    const worst = invalid[0]!;
    const spanX = partitionWorldSpan(worst, "x");
    const spanZ = partitionWorldSpan(worst, "z");
    const widthPressure = (spanX * density.targetPixelsPerStud) / density.maximumTextureDimension;
    const heightPressure = (spanZ * density.targetPixelsPerStud) / density.maximumTextureDimension;
    if (widthPressure >= heightPressure && partitionColumns < cellColumns) partitionColumns += 1;
    else if (partitionRows < cellRows) partitionRows += 1;
    else if (partitionColumns < cellColumns) partitionColumns += 1;
    else break;
  }
  throw new Error(
    "Terrain material field cannot be represented by the bounded metric texture profile",
  );
}

export function terrainMaterialBlendArtifact(
  fieldInput: unknown,
  partition: TerrainFieldPartition,
): TerrainMaterialBlendArtifact {
  const field = TERRAIN_FIELD_ARTIFACT_SCHEMA.parse(fieldInput);
  if (
    partition.fieldHash !== field.hash ||
    stableJson(partition.fieldBounds) !== stableJson(field.bounds) ||
    stableJson(partition.fieldResolution) !== stableJson(field.resolution)
  )
    throw new Error(`Terrain material partition does not belong to field: ${partition.id}`);
  for (const [offset, sourceIndex] of partition.sourceSampleIndices.entries())
    if (stableJson(partition.samples[offset]) !== stableJson(field.samples[sourceIndex]))
      throw new Error(`Terrain material partition changed source sample ${sourceIndex}`);

  const materialIds = [
    ...new Set(field.samples.flatMap((sample) => Object.keys(sample.materialWeights))),
  ].sort();
  const sampleColumnRange = [
    Math.max(0, partition.columnRange[0] - 1),
    Math.min(field.resolution.columns - 1, partition.columnRange[1] + 1),
  ] as const;
  const sampleRowRange = [
    Math.max(0, partition.rowRange[0] - 1),
    Math.min(field.resolution.rows - 1, partition.rowRange[1] + 1),
  ] as const;
  const flatWeights: number[] = [];
  for (let row = sampleRowRange[0]; row <= sampleRowRange[1]; row += 1)
    for (let column = sampleColumnRange[0]; column <= sampleColumnRange[1]; column += 1) {
      const source = field.samples[row * field.resolution.columns + column]!.materialWeights;
      flatWeights.push(...materialIds.map((materialId) => source[materialId] ?? 0));
    }
  const weightsF32Base64 = encodeFloat32Weights(flatWeights);
  const weightMaterial = {
    materialIds,
    sampleColumnRange,
    sampleRowRange,
    weightEncoding: "float32_le_base64" as const,
    weightCount: flatWeights.length,
    weightsF32Base64,
  };
  const material = {
    kind: "TerrainMaterialBlendArtifact" as const,
    abi: TERRAIN_MATERIAL_BLEND_ABI,
    surfaceId: field.surfaceId,
    fieldHash: field.hash,
    partitionHash: partition.hash,
    fieldBounds: field.bounds,
    fieldResolution: field.resolution,
    partitionColumnRange: partition.columnRange,
    partitionRowRange: partition.rowRange,
    ...weightMaterial,
    weightGridHash: contentHash(stableJson(weightMaterial)),
  };
  return TERRAIN_MATERIAL_BLEND_ARTIFACT_SCHEMA.parse({
    ...material,
    hash: contentHash(stableJson(material)),
  });
}

/** Decode one validated compact field window into row-major material vectors. */
export function decodeTerrainMaterialBlendWeights(input: unknown): readonly (readonly number[])[] {
  const blend = TERRAIN_MATERIAL_BLEND_ARTIFACT_SCHEMA.parse(input);
  const bytes = Buffer.from(blend.weightsF32Base64, "base64");
  const result: number[][] = [];
  for (let offset = 0; offset < blend.weightCount; offset += blend.materialIds.length) {
    const sample: number[] = [];
    for (let layer = 0; layer < blend.materialIds.length; layer += 1)
      sample.push(bytes.readFloatLE((offset + layer) * 4));
    result.push(sample);
  }
  return result;
}

function encodeFloat32Weights(weights: readonly number[]): string {
  const bytes = Buffer.allocUnsafe(weights.length * 4);
  for (const [index, value] of weights.entries()) bytes.writeFloatLE(value, index * 4);
  return bytes.toString("base64");
}

function validateTerrainMaterialTextureDensity(
  value: TerrainMaterialTextureDensity,
): TerrainMaterialTextureDensity {
  if (
    !Number.isFinite(value.minimumPixelsPerStud) ||
    !Number.isFinite(value.targetPixelsPerStud) ||
    !Number.isFinite(value.maximumPixelsPerStud) ||
    value.minimumPixelsPerStud <= 0 ||
    value.minimumPixelsPerStud > value.targetPixelsPerStud ||
    value.targetPixelsPerStud > value.maximumPixelsPerStud ||
    !Number.isInteger(value.maximumTextureDimension) ||
    value.maximumTextureDimension < 2 ||
    value.maximumTextureDimension > 2048
  )
    throw new Error("Terrain material texture density contract is invalid");
  return { ...value };
}

function terrainPartitionTextureMetrics(
  partition: TerrainFieldPartition,
  worldSamplingPixelsPerStud: number,
): {
  width: number;
  height: number;
  surfaceAreaStuds2: number;
  achievedPixelsPerStud: number;
} {
  const surfaceArea = partition.triangles.reduce((sum, triangle) => {
    const a = partition.samples[triangle[0]]!.position;
    const b = partition.samples[triangle[1]]!.position;
    const c = partition.samples[triangle[2]]!.position;
    const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
    const ac = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z };
    const cross = {
      x: ab.y * ac.z - ab.z * ac.y,
      y: ab.z * ac.x - ab.x * ac.z,
      z: ab.x * ac.y - ab.y * ac.x,
    };
    return sum + Math.hypot(cross.x, cross.y, cross.z) / 2;
  }, 0);
  const spanX = partitionWorldSpan(partition, "x");
  const spanZ = partitionWorldSpan(partition, "z");
  const width = Math.max(2, Math.round(spanX * worldSamplingPixelsPerStud));
  const height = Math.max(2, Math.round(spanZ * worldSamplingPixelsPerStud));
  const surfaceAreaStuds2 = f32(surfaceArea);
  return {
    width,
    height,
    surfaceAreaStuds2,
    achievedPixelsPerStud: f32(Math.sqrt((width * height) / surfaceAreaStuds2)),
  };
}

function terrainWorldSamplingDensity(
  partitions: readonly TerrainFieldPartition[],
  density: TerrainMaterialTextureDensity,
): number {
  const stretches = partitions.map((partition) => {
    const horizontalArea = partitionWorldSpan(partition, "x") * partitionWorldSpan(partition, "z");
    const surfaceArea = partition.triangles.reduce((sum, triangle) => {
      const a = partition.samples[triangle[0]]!.position;
      const b = partition.samples[triangle[1]]!.position;
      const c = partition.samples[triangle[2]]!.position;
      const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
      const ac = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z };
      return (
        sum +
        Math.hypot(
          ab.y * ac.z - ab.z * ac.y,
          ab.z * ac.x - ab.x * ac.z,
          ab.x * ac.y - ab.y * ac.x,
        ) /
          2
      );
    }, 0);
    return Math.sqrt(surfaceArea / horizontalArea);
  });
  const minimum = Math.max(...stretches.map((stretch) => density.minimumPixelsPerStud * stretch));
  const maximum = Math.min(...stretches.map((stretch) => density.maximumPixelsPerStud * stretch));
  if (minimum > maximum + 1e-6)
    throw new Error(
      "Terrain slopes cannot share one seamless sampling lattice inside the style density range",
    );
  return f32(clamp(density.targetPixelsPerStud * Math.max(...stretches), minimum, maximum));
}

function partitionWorldSpan(partition: TerrainFieldPartition, axis: "x" | "z"): number {
  const positions = partition.samples.map((sample) => sample.position[axis]);
  return Math.max(...positions) - Math.min(...positions);
}

/** Fail closed if repeated source vertices differ in position, normal, or semantic weights. */
export function assertTerrainPartitionContinuity(
  partitions: readonly TerrainFieldPartition[],
): void {
  const retained = new Map<number, string>();
  for (const partition of partitions) {
    if (partition.sourceSampleIndices.length !== partition.samples.length)
      throw new Error(`Terrain partition sample index count is invalid: ${partition.id}`);
    for (const [offset, sourceIndex] of partition.sourceSampleIndices.entries()) {
      const identity = stableJson(partition.samples[offset]);
      const previous = retained.get(sourceIndex);
      if (previous !== undefined && previous !== identity)
        throw new Error(`Terrain partition boundary diverges at source sample ${sourceIndex}`);
      retained.set(sourceIndex, identity);
    }
  }
}

export const MAXIMUM_ROUTE_PROFILE_SAMPLES = 16_384 as const;

export interface RouteSurfaceProfileSample {
  readonly position: WorldVector3;
  readonly normal: WorldVector3;
  readonly surfaceSlopeDegrees: number;
}

export interface RouteGradeReport {
  readonly routeId: string;
  readonly surfaceId: string;
  readonly samples: readonly RouteSurfaceProfileSample[];
  readonly maximumGradeDegrees: number;
  readonly maximumStepHeight: number;
  readonly traversable: boolean;
  readonly profileHash: string;
}

/** Measure declared routes against the same placement surfaces used by assets. */
export function analyzeRouteGrades(
  planInput: unknown,
  surfaces?: PlacementSurfaceIndex,
): RouteGradeReport[] {
  const plan = WORLD_PLAN_SCHEMA.parse(planInput);
  const index =
    surfaces ??
    new PlacementSurfaceIndex(plan.terrainPlans.map(compileTerrainPlan), plan.constructedSurfaces);
  return plan.routes.map((route) => compileRouteSurfaceProfile(route, index));
}

/** Snap and densely sample one route against its declared surface authority. */
export function compileRouteSurfaceProfile(
  route: WorldRoute,
  surfaces: PlacementSurfaceIndex,
): RouteGradeReport {
  const declaredSegments = route.points
    .slice(1)
    .map((end, index) => [route.points[index]!, end] as const);
  if (route.closed) declaredSegments.push([route.points.at(-1)!, route.points[0]!]);
  const maximumSpacing = surfaces.routeSamplingStep(route.surfaceId);
  const samples: RouteSurfaceProfileSample[] = [];

  for (const [segmentIndex, [declaredStart, declaredEnd]] of declaredSegments.entries()) {
    const start = surfaces.coordinatesFromWorld(route.surfaceId, declaredStart);
    const end = surfaces.coordinatesFromWorld(route.surfaceId, declaredEnd);
    const coordinateLength = Math.hypot(end.u - start.u, end.v - start.v);
    const subdivisions = maximumSpacing
      ? Math.max(1, Math.ceil(coordinateLength / maximumSpacing))
      : 1;
    for (let offset = segmentIndex === 0 ? 0 : 1; offset <= subdivisions; offset += 1) {
      const amount = offset / subdivisions;
      const coordinate = {
        u: interpolate(start.u, end.u, amount),
        v: interpolate(start.v, end.v, amount),
      };
      const sampled = surfaces.sample(route.surfaceId, coordinate);
      if (!sampled.navigable)
        throw new Error(
          `Route ${route.id} crosses non-navigable surface ${route.surfaceId} at sample ${samples.length}`,
        );
      samples.push({
        position: canonicalRouteVector(sampled.position),
        normal: canonicalRouteVector(sampled.normal),
        surfaceSlopeDegrees: f32(sampled.slopeDegrees),
      });
      if (samples.length > MAXIMUM_ROUTE_PROFILE_SAMPLES)
        throw new Error(
          `Route ${route.id} exceeds ${MAXIMUM_ROUTE_PROFILE_SAMPLES} sampled surface points`,
        );
    }
  }

  let maximumGradeDegrees = Math.max(...samples.map((sample) => sample.surfaceSlopeDegrees));
  let maximumStepHeight = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const start = samples[index - 1]!.position;
    const end = samples[index]!.position;
    const rise = Math.abs(end.y - start.y);
    const run = Math.hypot(end.x - start.x, end.z - start.z);
    maximumStepHeight = Math.max(maximumStepHeight, rise);
    maximumGradeDegrees = Math.max(
      maximumGradeDegrees,
      (Math.atan2(rise, Math.max(run, 1e-12)) * 180) / Math.PI,
    );
  }
  const profileMaterial = {
    routeId: route.id,
    surfaceId: route.surfaceId,
    samples,
    maximumGradeDegrees: f32(maximumGradeDegrees),
    maximumStepHeight: f32(maximumStepHeight),
  };
  return {
    ...profileMaterial,
    traversable:
      maximumGradeDegrees <= route.maximumSlopeDegrees + 1e-6 &&
      maximumStepHeight <= route.maximumStepHeight + 1e-6,
    profileHash: contentHash(stableJson(profileMaterial)),
  };
}

function canonicalRouteVector(value: WorldVector3): WorldVector3 {
  return { x: f32(value.x), y: f32(value.y), z: f32(value.z) };
}

function weightsAt(plan: TerrainPlan, point: WorldPoint2): Record<string, number> {
  const raw = plan.regions.map((region) => {
    const signedDistance = signedPolygonDistance(point, region.footprint);
    return Math.exp(clamp(signedDistance / region.blendWidth, -40, 40));
  });
  return normalizedRecord(
    plan.regions.map((region) => region.regionId),
    raw,
  );
}

function materialsAt(
  plan: TerrainPlan,
  regionWeights: Readonly<Record<string, number>>,
): Record<string, number> {
  const totals = new Map<string, number>();
  for (const region of plan.regions) {
    const regionWeight = regionWeights[region.regionId] ?? 0;
    const materialTotal = region.materialWeights.reduce(
      (sum, material) => sum + material.weight,
      0,
    );
    for (const material of region.materialWeights)
      totals.set(
        material.materialId,
        (totals.get(material.materialId) ?? 0) + regionWeight * (material.weight / materialTotal),
      );
  }
  const entries = [...totals.entries()].sort(([left], [right]) => left.localeCompare(right));
  return normalizedRecord(
    entries.map(([id]) => id),
    entries.map(([, value]) => value),
  );
}

function applyHeightOperation(
  height: number,
  point: WorldPoint2,
  operation: Exclude<TerrainOperation, { kind: "erosion" }>,
  regionWeights: Readonly<Record<string, number>>,
): number {
  const influence = operation.regionId ? (regionWeights[operation.regionId] ?? 0) : 1;
  if (influence <= 0) return height;
  if (operation.kind === "ridge") {
    const distance = distanceToPolyline(point, operation.points);
    return height + operation.height * smoothFalloff(distance, operation.width) * influence;
  }
  if (operation.kind === "peak" || operation.kind === "basin") {
    const distance = Math.hypot(point.x - operation.center.x, point.z - operation.center.z);
    const radial = Math.pow(smoothFalloff(distance, operation.radius), operation.falloff);
    const signedMagnitude = operation.kind === "peak" ? operation.height : -operation.depth;
    return height + signedMagnitude * radial * influence;
  }
  if (operation.kind === "terrace") {
    const terraced = Math.round(height / operation.stepHeight) * operation.stepHeight;
    return interpolate(height, terraced, operation.strength * influence);
  }
  if (operation.kind === "dune") {
    const angle = (operation.directionDegrees * Math.PI) / 180;
    const projected = point.x * Math.cos(angle) + point.z * Math.sin(angle);
    return (
      height +
      Math.sin((projected * Math.PI * 2) / operation.wavelength) * operation.height * influence
    );
  }
  if (operation.kind === "channel") {
    const distance = distanceToPolyline(point, operation.points);
    return height - operation.depth * smoothFalloff(distance, operation.width) * influence;
  }
  if (operation.kind === "local_patch") {
    if (operation.edit.kind === "smooth") return height;
    const distance = Math.hypot(point.x - operation.center.x, point.z - operation.center.z);
    const radial = Math.pow(smoothFalloff(distance, operation.radius), operation.falloff);
    if (operation.edit.kind === "raise") return height + operation.edit.amount * radial * influence;
    if (operation.edit.kind === "lower") return height - operation.edit.amount * radial * influence;
    return interpolate(
      height,
      operation.edit.elevation,
      operation.edit.strength * radial * influence,
    );
  }
  const angle = (operation.directionDegrees * Math.PI) / 180;
  const displacement =
    (point.x - operation.origin.x) * Math.cos(angle) +
    (point.z - operation.origin.z) * Math.sin(angle);
  return height + displacement * operation.risePerUnit * influence;
}

function smoothLocalPatch(
  initial: readonly number[],
  plan: TerrainPlan,
  operation: Extract<TerrainOperation, { kind: "local_patch" }>,
  regionWeights: readonly Readonly<Record<string, number>>[],
): number[] {
  if (operation.edit.kind !== "smooth") return [...initial];
  const { columns, rows } = plan.resolution;
  const stepX = (plan.bounds.x.maximum - plan.bounds.x.minimum) / (columns - 1);
  const stepZ = (plan.bounds.z.maximum - plan.bounds.z.minimum) / (rows - 1);
  let heights = [...initial];
  for (let iteration = 0; iteration < operation.edit.iterations; iteration += 1) {
    const next = [...heights];
    for (let row = 0; row < rows; row += 1)
      for (let column = 0; column < columns; column += 1) {
        const index = row * columns + column;
        const x = plan.bounds.x.minimum + column * stepX;
        const z = plan.bounds.z.minimum + row * stepZ;
        const distance = Math.hypot(x - operation.center.x, z - operation.center.z);
        const radial = Math.pow(smoothFalloff(distance, operation.radius), operation.falloff);
        const influence = (regionWeights[index]?.[operation.regionId] ?? 0) * radial;
        if (influence <= 0) continue;
        const neighbors = [
          column > 0 ? index - 1 : undefined,
          column + 1 < columns ? index + 1 : undefined,
          row > 0 ? index - columns : undefined,
          row + 1 < rows ? index + columns : undefined,
        ].filter((value): value is number => value !== undefined);
        if (neighbors.length === 0) continue;
        const average =
          neighbors.reduce((sum, neighbor) => sum + heights[neighbor]!, 0) / neighbors.length;
        next[index] = f32(
          interpolate(heights[index]!, average, operation.edit.strength * influence),
        );
      }
    heights = next;
  }
  return heights;
}

function erode(
  initial: readonly number[],
  plan: TerrainPlan,
  operation: Extract<TerrainOperation, { kind: "erosion" }>,
  regionWeights: readonly Readonly<Record<string, number>>[],
): number[] {
  const { columns, rows } = plan.resolution;
  let heights = [...initial];
  for (let iteration = 0; iteration < operation.iterations; iteration += 1) {
    const next = [...heights];
    for (let row = 0; row < rows; row += 1)
      for (let column = 0; column < columns; column += 1) {
        const index = row * columns + column;
        const influence = operation.regionId
          ? (regionWeights[index]?.[operation.regionId] ?? 0)
          : 1;
        if (influence <= 0) continue;
        const neighbors = [
          column > 0 ? index - 1 : undefined,
          column + 1 < columns ? index + 1 : undefined,
          row > 0 ? index - columns : undefined,
          row + 1 < rows ? index + columns : undefined,
        ].filter((value): value is number => value !== undefined);
        const average =
          neighbors.reduce((sum, neighbor) => sum + heights[neighbor]!, 0) / neighbors.length;
        const difference = average - heights[index]!;
        if (Math.abs(difference) <= operation.talus) continue;
        next[index] = f32(heights[index]! + difference * operation.strength * influence * 0.25);
      }
    heights = next;
  }
  return heights;
}

function fractalNoise(
  x: number,
  z: number,
  seed: number,
  layer: TerrainPlan["regions"][number]["noiseLayers"][number],
): number {
  let frequency = layer.frequency;
  let amplitude = 1;
  let total = 0;
  let normalization = 0;
  for (let octave = 0; octave < layer.octaves; octave += 1) {
    const raw = valueNoise(x * frequency, z * frequency, seed + layer.seedOffset + octave * 7919);
    const shaped =
      layer.kind === "ridged"
        ? 1 - Math.abs(raw)
        : layer.kind === "billow"
          ? Math.abs(raw) * 2 - 1
          : raw;
    total += shaped * amplitude;
    normalization += amplitude;
    frequency *= layer.lacunarity;
    amplitude *= layer.gain;
  }
  return normalization > 0 ? total / normalization : 0;
}

function valueNoise(x: number, z: number, seed: number): number {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const tx = smoothstep(x - x0);
  const tz = smoothstep(z - z0);
  const a = hashNoise(x0, z0, seed);
  const b = hashNoise(x0 + 1, z0, seed);
  const c = hashNoise(x0, z0 + 1, seed);
  const d = hashNoise(x0 + 1, z0 + 1, seed);
  return interpolate(interpolate(a, b, tx), interpolate(c, d, tx), tz);
}

function hashNoise(x: number, z: number, seed: number): number {
  let value = (Math.imul(x, 0x1f123bb5) ^ Math.imul(z, 0x5f356495) ^ seed) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
  value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
  return ((value ^ (value >>> 16)) >>> 0) / 0x7fff_ffff - 1;
}

function signedPolygonDistance(point: WorldPoint2, polygon: readonly WorldPoint2[]): number {
  let distance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < polygon.length; index += 1)
    distance = Math.min(
      distance,
      distanceToSegment(point, polygon[index]!, polygon[(index + 1) % polygon.length]!),
    );
  return pointInPolygon(point, polygon) ? distance : -distance;
}

function pointInPolygon(point: WorldPoint2, polygon: readonly WorldPoint2[]): boolean {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const left = polygon[index]!;
    const right = polygon[previous]!;
    if (
      left.z > point.z !== right.z > point.z &&
      point.x < ((right.x - left.x) * (point.z - left.z)) / (right.z - left.z) + left.x
    )
      inside = !inside;
  }
  return inside;
}

function distanceToPolyline(point: WorldPoint2, points: readonly WorldPoint2[]): number {
  let result = Number.POSITIVE_INFINITY;
  for (let index = 0; index < points.length - 1; index += 1)
    result = Math.min(result, distanceToSegment(point, points[index]!, points[index + 1]!));
  return result;
}

function distanceToSegment(point: WorldPoint2, start: WorldPoint2, end: WorldPoint2): number {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const lengthSquared = dx * dx + dz * dz;
  const amount =
    lengthSquared === 0
      ? 0
      : clamp(((point.x - start.x) * dx + (point.z - start.z) * dz) / lengthSquared, 0, 1);
  return Math.hypot(point.x - (start.x + dx * amount), point.z - (start.z + dz * amount));
}

function normalizedRecord(
  ids: readonly string[],
  values: readonly number[],
): Record<string, number> {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!(total > 0) || !Number.isFinite(total))
    throw new Error("Terrain weights cannot be normalized");
  const result: Record<string, number> = {};
  let assigned = 0;
  for (let index = 0; index < ids.length; index += 1) {
    const value =
      index === ids.length - 1
        ? f32(Math.max(0, 1 - assigned))
        : Math.min(1 - assigned, Math.max(0, f32(values[index]! / total)));
    result[ids[index]!] = value;
    assigned += value;
  }
  return result;
}

function normalize(value: WorldVector3): WorldVector3 {
  const length = Math.hypot(value.x, value.y, value.z);
  if (!(length > 1e-12)) throw new Error("Cannot normalize a zero-length vector");
  return { x: f32(value.x / length), y: f32(value.y / length), z: f32(value.z / length) };
}

function smoothFalloff(distance: number, radius: number): number {
  const amount = clamp(1 - distance / radius, 0, 1);
  return amount * amount * (3 - 2 * amount);
}

function smoothstep(value: number): number {
  return value * value * (3 - 2 * value);
}

function interpolate(start: number, end: number, amount: number): number {
  return start + (end - start) * amount;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function f32(value: number): number {
  const result = Math.fround(Math.abs(value) < 1e-12 ? 0 : value);
  return Object.is(result, -0) ? 0 : result;
}
