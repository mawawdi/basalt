import { ROBLOX_STUD_METERS } from "./constants.js";

/** Roblox smooth terrain is fixed to four-stud voxels. */
export const ROBLOX_TERRAIN_VOXEL_STUDS = 4 as const;
export const ROBLOX_TERRAIN_VOXEL_METERS = ROBLOX_TERRAIN_VOXEL_STUDS * ROBLOX_STUD_METERS;

/**
 * A reconstructed smooth-terrain surface may lie up to half a voxel away from
 * the engine-neutral surface sampled into that voxel field. This is an engine
 * realization allowance, not an authored route tolerance.
 */
export const ROBLOX_TERRAIN_SURFACE_QUANTIZATION_ALLOWANCE_METERS = ROBLOX_TERRAIN_VOXEL_METERS / 2;

/** Float/raycast noise accepted only when observing an already bounded surface. */
export const ROBLOX_TERRAIN_CONTACT_OBSERVATION_TOLERANCE_METERS = 0.1 * ROBLOX_STUD_METERS;

/**
 * SolidOccupancy values are samples of Roblox's smooth voxel field, not a
 * literal bottom-up height inside an isolated box. A geometric heightfield
 * surface therefore enters sample space half a voxel below its world-space
 * elevation. Without this center-to-surface conversion, a flat field is
 * realized approximately two studs too high.
 */
export const ROBLOX_TERRAIN_SURFACE_SAMPLE_OFFSET_METERS = ROBLOX_TERRAIN_VOXEL_METERS / 2;

export function robloxTerrainSolidOccupancy(
  surfaceElevationMeters: number,
  cellBottomMeters: number,
): number {
  if (!Number.isFinite(surfaceElevationMeters) || !Number.isFinite(cellBottomMeters))
    throw new Error("Roblox terrain elevations must be finite");
  return Math.max(
    0,
    Math.min(
      1,
      (surfaceElevationMeters - ROBLOX_TERRAIN_SURFACE_SAMPLE_OFFSET_METERS - cellBottomMeters) /
        ROBLOX_TERRAIN_VOXEL_METERS,
    ),
  );
}
