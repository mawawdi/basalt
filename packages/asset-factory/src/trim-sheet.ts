import { z } from "zod";
import {
  quantizeQ32_32,
  TRIM_BAND_SCHEMA,
  type TrimBand,
  type TrimSheetMapping,
} from "../../basalt-types/src/index.js";
import { entityId, hashSchema } from "../../spatial-core/src/primitives.js";

export const TRIM_SHEET_SPECIFICATION_ABI = "basalt-trim-sheet@1" as const;

const positive = z.number().finite().positive();

export const TRIM_HOTSPOT_ENERGY_WEIGHTS_SCHEMA = z
  .object({
    aspectRatioPenalty: positive.default(1.0),
    areaDistortionPenalty: positive.default(1.5),
    semanticPenalty: positive.default(5.0),
  })
  .strict();

export type TrimHotspotEnergyWeights = z.infer<typeof TRIM_HOTSPOT_ENERGY_WEIGHTS_SCHEMA>;

export const TRIM_SHEET_SPECIFICATION_SCHEMA = z
  .object({
    kind: z.literal("TrimSheetSpecification"),
    abi: z.literal(TRIM_SHEET_SPECIFICATION_ABI),
    id: entityId,
    trimAtlasHandle: hashSchema,
    resolution: z
      .object({
        width: z.number().int().positive().max(8192),
        height: z.number().int().positive().max(8192),
      })
      .strict(),
    targetTexelDensity: positive, // in pixels per stud (or pixels per meter)
    bands: z.array(TRIM_BAND_SCHEMA).min(1).max(128),
    energyWeights: TRIM_HOTSPOT_ENERGY_WEIGHTS_SCHEMA.default({
      aspectRatioPenalty: 1.0,
      areaDistortionPenalty: 1.5,
      semanticPenalty: 5.0,
    }),
  })
  .strict()
  .superRefine((spec, context) => {
    const ids = new Set<string>();
    for (const [index, band] of spec.bands.entries()) {
      if (ids.has(band.bandId)) {
        context.addIssue({
          code: "custom",
          path: ["bands", index, "bandId"],
          message: `Duplicate trim band ID: ${band.bandId}`,
        });
      }
      ids.add(band.bandId);
    }
  });

export type TrimSheetSpecification = z.infer<typeof TRIM_SHEET_SPECIFICATION_SCHEMA>;

export const TRIM_SHEET_MAPPING_PROFILE_SCHEMA = z
  .object({
    trimAtlasHandle: hashSchema,
    bandId: entityId,
    targetTexelDensity: positive,
    energy: z.number().finite().nonnegative(),
  })
  .strict();
export type TrimSheetMappingProfile = z.infer<typeof TRIM_SHEET_MAPPING_PROFILE_SCHEMA>;

export interface QuadStripMeasurement {
  readonly assetId: string;
  readonly aspectRatio: number;
  readonly surfaceArea: number;
  readonly semanticRole?: string;
  readonly semanticCost?: number;
}

const HOTSPOT_ALPHA = 1.0;
const HOTSPOT_BETA = 1.5;
const HOTSPOT_GAMMA = 5.0;
const HOTSPOT_MAXIMUM_ENERGY = 0.45;
const HOTSPOT_TARGET_DENSITY_PX_PER_METER = 512;

export function computeHotspotDistortionEnergy(
  strip: QuadStripMeasurement,
  band: TrimBand,
  semanticCost: number,
): number {
  if (
    !Number.isFinite(strip.aspectRatio) ||
    strip.aspectRatio <= 0 ||
    !Number.isFinite(strip.surfaceArea) ||
    strip.surfaceArea <= 0
  )
    throw new Error("Hotspot strip measurements must be finite and positive");
  if (!Number.isFinite(semanticCost) || semanticCost < 0)
    throw new Error("Hotspot semantic cost must be finite and non-negative");
  const bandAspectRatio = band.metricWidth / Math.max(1e-6, band.metricHeight);
  const bandArea = band.metricWidth * band.metricHeight;
  return (
    HOTSPOT_ALPHA * Math.abs(Math.log(strip.aspectRatio / Math.max(1e-6, bandAspectRatio))) +
    HOTSPOT_BETA * Math.abs(strip.surfaceArea / Math.max(1e-6, bandArea) - 1) +
    HOTSPOT_GAMMA * semanticCost
  );
}

export function selectHotspotTrimBand(
  strip: QuadStripMeasurement,
  bands: readonly TrimBand[],
): TrimSheetMapping | undefined {
  const eligible = bands.filter(
    (band) =>
      band.tilingAxis === "v" &&
      (!strip.semanticRole || band.semanticRoles.includes(strip.semanticRole)),
  );
  const pool = eligible.length > 0 ? eligible : bands.filter((band) => band.tilingAxis === "v");
  let selected: { band: TrimBand; energy: number } | undefined;
  for (const band of pool) {
    const energy = computeHotspotDistortionEnergy(strip, band, strip.semanticCost ?? 0);
    if (
      !selected ||
      energy < selected.energy ||
      (energy === selected.energy && band.bandId < selected.band.bandId)
    )
      selected = { band, energy };
  }
  if (!selected || selected.energy > HOTSPOT_MAXIMUM_ENERGY) return undefined;
  const roles = selected.band.semanticRoles;
  const materialClass = roles.some((role) =>
    /wood|timber|lumber|trunk|bark|foliage|frond|leaf|canopy/iu.test(role),
  )
    ? roles.some((role) => /foliage|frond|leaf|canopy/iu.test(role))
      ? "foliage_card"
      : "wood"
    : roles.some((role) => /metal/iu.test(role))
      ? "metal_trim"
      : "stone";
  return {
    assetId: strip.assetId,
    bandId: selected.band.bandId,
    materialClass,
    uMin: quantizeQ32_32(selected.band.uMin),
    uMax: quantizeQ32_32(selected.band.uMax),
    vMin: quantizeQ32_32(selected.band.vMin),
    vMax: quantizeQ32_32(selected.band.vMax),
    targetTexelDensityPxPerMeter: quantizeQ32_32(HOTSPOT_TARGET_DENSITY_PX_PER_METER),
    maxDistortionEnergy: quantizeQ32_32(selected.energy),
  };
}

/**
 * Computes shape-mismatch energy for matching a 3D UV island to a trim sheet band:
 * E(k, T_i) = alpha * |ln(AR_k / AR_T_i)| + beta * |(Area_3D(k) / (W_T_i * H_T_i)) - 1.0|
 */
export function computeTrimBandMismatchEnergy(
  islandAspectRatio: number,
  island3dArea: number,
  band: TrimBand,
  weights: TrimHotspotEnergyWeights = {
    aspectRatioPenalty: 1.0,
    areaDistortionPenalty: 1.5,
    semanticPenalty: 5.0,
  },
): number {
  const bandAspectRatio = band.metricWidth / Math.max(1e-6, band.metricHeight);
  const bandArea = band.metricWidth * band.metricHeight;

  const safeIslandRatio = Math.max(1e-6, islandAspectRatio);
  const safeBandRatio = Math.max(1e-6, bandAspectRatio);
  const ratioDiff = Math.abs(Math.log(safeIslandRatio / safeBandRatio));
  const areaDiff = Math.abs(island3dArea / Math.max(1e-6, bandArea) - 1.0);

  return weights.aspectRatioPenalty * ratioDiff + weights.areaDistortionPenalty * areaDiff;
}

/**
 * Finds the optimal trim band for an extracted surface island among candidate bands matching semantic roles.
 */
export function matchOptimalTrimBand(
  islandAspectRatio: number,
  island3dArea: number,
  candidateBands: readonly TrimBand[],
  semanticRole?: string,
  weights: TrimHotspotEnergyWeights = {
    aspectRatioPenalty: 1.0,
    areaDistortionPenalty: 1.5,
    semanticPenalty: 5.0,
  },
): TrimBand | undefined {
  if (candidateBands.length === 0) {
    return undefined;
  }

  const eligibleBands = semanticRole
    ? candidateBands.filter((b) => b.semanticRoles.includes(semanticRole))
    : candidateBands;

  const searchPool = eligibleBands.length > 0 ? eligibleBands : candidateBands;

  let bestBand: TrimBand | undefined;
  let lowestEnergy = Number.POSITIVE_INFINITY;

  for (const band of searchPool) {
    const energy = computeTrimBandMismatchEnergy(islandAspectRatio, island3dArea, band, weights);
    if (energy <= HOTSPOT_MAXIMUM_ENERGY && energy < lowestEnergy) {
      lowestEnergy = energy;
      bestBand = band;
    }
  }

  return bestBand;
}
