import { z } from "zod";
import { familyHandleSchema, SPATIAL_ROLES, type SpatialRole } from "./taxonomy.js";

const finiteNumber = z.number().finite();
const rolesSchema = z.array(z.enum(SPATIAL_ROLES)).min(1).max(SPATIAL_ROLES.length);
const boundsSchema = z.tuple([
  finiteNumber.nonnegative(),
  finiteNumber.nonnegative(),
  finiteNumber.nonnegative(),
]);

export const metricEnvelopeCardSchema = z
  .object({
    minDimensionsStuds: boundsSchema,
    maxDimensionsStuds: boundsSchema,
    clearanceRadiusStuds: finiteNumber.nonnegative(),
  })
  .strict();

export const surfaceAffinityCardSchema = z
  .object({
    surfaces: z.array(z.string().trim().min(1).max(128)).max(64),
    maxSlopeDeg: finiteNumber.min(0).max(180),
    clearanceRadiusStuds: finiteNumber.nonnegative(),
  })
  .strict();

export const densityEnvelopeCardSchema = z
  .object({
    minPerHectare: finiteNumber.nonnegative(),
    maxPerHectare: finiteNumber.nonnegative(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.minPerHectare > value.maxPerHectare)
      context.addIssue({
        code: "custom",
        path: ["maxPerHectare"],
        message: "Density range is inverted",
      });
  });

export const familyArchetypeCardSchema = z
  .object({
    token: z.string().trim().min(1).max(128),
    bounds: boundsSchema,
    mass: finiteNumber.nonnegative(),
  })
  .strict();

export const familySocketCardSchema = z
  .object({
    grid_step: boundsSchema,
    elevation_step_dh: finiteNumber.nonnegative(),
    compatible_groups: z.array(z.string().trim().min(1).max(128)).max(64),
  })
  .strict();

export const familyCardSchema = z
  .object({
    handle: familyHandleSchema,
    fid: z.string().regex(/^family_[a-z0-9_]+_[a-f0-9]{12,64}$/u),
    roles: rolesSchema,
    archetypes: z.array(familyArchetypeCardSchema).min(1).max(4096),
    affinities: z
      .object({
        surfaces: z.array(z.string().trim().min(1).max(128)).max(64),
        max_slope_deg: finiteNumber.min(0).max(180),
        clearance_rad: finiteNumber.nonnegative(),
      })
      .strict(),
    density: z
      .object({
        min_per_hectare: finiteNumber.nonnegative(),
        max_per_hectare: finiteNumber.nonnegative(),
      })
      .strict(),
    sockets: familySocketCardSchema.nullable(),
  })
  .strict();

/**
 * Planning-policy scatter density per role. These are authored placement priors,
 * not measurements: structural roles scatter at 0 because they are placed by
 * layout, while scatter roles carry per-hectare ranges the planner samples.
 */
export const ROLE_DENSITY_DEFAULTS: Readonly<
  Record<SpatialRole, { readonly min_per_hectare: number; readonly max_per_hectare: number }>
> = {
  foundation: { min_per_hectare: 0, max_per_hectare: 0 },
  barrier: { min_per_hectare: 0, max_per_hectare: 0 },
  canopy: { min_per_hectare: 12, max_per_hectare: 64 },
  groundcover: { min_per_hectare: 200, max_per_hectare: 2000 },
  focal_insert: { min_per_hectare: 2, max_per_hectare: 20 },
  portal: { min_per_hectare: 0, max_per_hectare: 0 },
  connector: { min_per_hectare: 0, max_per_hectare: 0 },
  clutter: { min_per_hectare: 50, max_per_hectare: 500 },
};

/**
 * Stylized average density for mass estimates until per-material densities exist.
 * Card mass is bounding-volume mass, documented as an estimate for budgets only.
 */
export const STYLIZED_MASS_DENSITY_KG_PER_M3 = 500;

export type MetricEnvelopeCard = z.infer<typeof metricEnvelopeCardSchema>;
export type SurfaceAffinityCard = z.infer<typeof surfaceAffinityCardSchema>;
export type DensityEnvelopeCard = z.infer<typeof densityEnvelopeCardSchema>;
export type FamilyArchetypeCard = z.infer<typeof familyArchetypeCardSchema>;
export type FamilySocketCard = z.infer<typeof familySocketCardSchema>;
export type FamilyCard = z.infer<typeof familyCardSchema>;
export type { SpatialRole };
