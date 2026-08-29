import { z } from "zod";
import { entityId, hashSchema } from "../../spatial-core/src/primitives.js";

export const TRIM_SHEET_SPECIFICATION_ABI = "basalt-trim-sheet@1" as const;

const unitInterval = z.number().finite().min(0).max(1);
const positive = z.number().finite().positive();

export const TRIM_BAND_SCHEMA = z
  .object({
    bandId: entityId,
    semanticRoles: z.array(z.string().trim().min(1).max(80)).min(1).max(16),
    uMin: unitInterval,
    vMin: unitInterval,
    uMax: unitInterval,
    vMax: unitInterval,
    tilingAxis: z.enum(["u", "v", "none"]),
    metricWidth: positive,
    metricHeight: positive,
  })
  .strict()
  .superRefine((band, context) => {
    if (band.uMin >= band.uMax) {
      context.addIssue({
        code: "custom",
        path: ["uMax"],
        message: "Trim band uMax must be strictly greater than uMin",
      });
    }
    if (band.vMin >= band.vMax) {
      context.addIssue({
        code: "custom",
        path: ["vMax"],
        message: "Trim band vMax must be strictly greater than vMin",
      });
    }
  });

export type TrimBand = z.infer<typeof TRIM_BAND_SCHEMA>;

export const TRIM_HOTSPOT_ENERGY_WEIGHTS_SCHEMA = z
  .object({
    aspectRatioPenalty: positive.default(1.0),
    areaDistortionPenalty: positive.default(0.5),
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
      areaDistortionPenalty: 0.5,
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

/**
 * Computes shape-mismatch energy for matching a 3D UV island to a trim sheet band:
 * E(k, T_i) = alpha * |ln(AR_k / AR_T_i)| + beta * |(Area_3D(k) / (W_T_i * H_T_i)) - 1.0|
 */
export function computeTrimBandMismatchEnergy(
  islandAspectRatio: number,
  island3dArea: number,
  band: TrimBand,
  weights: TrimHotspotEnergyWeights = { aspectRatioPenalty: 1.0, areaDistortionPenalty: 0.5 },
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
  weights?: TrimHotspotEnergyWeights,
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
    if (energy < lowestEnergy) {
      lowestEnergy = energy;
      bestBand = band;
    }
  }

  return bestBand;
}
