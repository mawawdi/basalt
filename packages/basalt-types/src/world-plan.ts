import { z } from "zod";
import { familyCardSchema } from "./family-card.js";
import { familyHandleSchema, SPATIAL_ROLES } from "./taxonomy.js";

const finitePositive = z.number().finite().positive();
const boundedStuds = z.tuple([
  z.number().finite().nonnegative().max(8),
  z.number().finite().nonnegative().max(8),
  z.number().finite().nonnegative().max(8),
]);

export const worldStyleContractSchema = z
  .object({
    style_motif: z.string().trim().min(1).max(128),
    edge_fidelity: z.enum(["sharp", "faceted", "soft_bevel"]),
    palette_tokens: z.array(z.string().trim().min(1).max(128)).max(128),
    texel_density_target: finitePositive,
  })
  .strict();

export const regionalExploitationBindingSchema = z
  .object({
    region_id: z.string().trim().min(1).max(128),
    assigned_fid: z.string().regex(/^family_[a-z0-9_]+_[a-f0-9]{12,64}$/u),
    target_density_per_hectare: z.number().finite().nonnegative(),
  })
  .strict();

export const familyRequirementSchema = z
  .object({
    requirement_id: z.string().trim().min(1).max(128),
    suggested_handle: familyHandleSchema,
    spatial_role: z.enum(SPATIAL_ROLES),
    bounding_envelope_studs: boundedStuds,
    target_texel_density: finitePositive,
    min_archetype_count: z.number().int().min(3).max(4096),
    surface_affinity: z.string().trim().min(1).max(128),
  })
  .strict();

export const worldPlanSchema = z
  .object({
    world_id: z.string().trim().min(1).max(128),
    style_contract: worldStyleContractSchema,
    palette_menu: z.array(familyCardSchema).min(1).max(20),
    exploit_bindings: z.array(regionalExploitationBindingSchema).max(4096),
    explore_requirements: z.array(familyRequirementSchema).max(4096),
  })
  .strict()
  .superRefine((value, context) => {
    const fids = new Set(value.palette_menu.map((card) => card.fid));
    value.exploit_bindings.forEach((binding, index) => {
      if (!fids.has(binding.assigned_fid))
        context.addIssue({
          code: "custom",
          path: ["exploit_bindings", index, "assigned_fid"],
          message: "Exploit binding is not in the palette menu",
        });
    });
  });

export type WorldStyleContract = z.infer<typeof worldStyleContractSchema>;
export type RegionalExploitationBinding = z.infer<typeof regionalExploitationBindingSchema>;
export type FamilyRequirement = z.infer<typeof familyRequirementSchema>;
export type WorldPlan = z.infer<typeof worldPlanSchema>;
