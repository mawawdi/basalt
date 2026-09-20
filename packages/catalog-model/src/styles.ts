import { z } from "zod";
import { HASH_SCHEMA, contentHash, deepFreezeJson, stableJson } from "@basalt/contracts";
import { STYLE_PROFILE_HANDLE_SCHEMA } from "./primitives.js";

const unit = z.number().finite().min(0).max(1);
const guidance = z.string().trim().min(1).max(2048);
const profileLayer = z.object({ level: z.string().trim().min(1).max(160), guidance }).strict();

export const STYLE_PROFILE_DECLARATION_SCHEMA = z
  .object({
    handle: STYLE_PROFILE_HANDLE_SCHEMA,
    shapeLanguage: guidance,
    silhouetteHierarchy: z.array(profileLayer).min(1),
    detailScale: z.array(profileLayer).min(1),
    edgeTreatment: guidance,
    materialLanguage: guidance,
    texelDensity: z
      .object({
        minimumPixelsPerMeter: z.number().finite().positive(),
        targetPixelsPerMeter: z.number().finite().positive(),
        maximumPixelsPerMeter: z.number().finite().positive(),
      })
      .strict()
      .refine(
        (value) =>
          value.minimumPixelsPerMeter <= value.targetPixelsPerMeter &&
          value.targetPixelsPerMeter <= value.maximumPixelsPerMeter,
        "Style texel-density range must be ordered",
      ),
    surfaceVariation: z
      .object({ scaleMeters: z.number().finite().positive(), intensity: unit, guidance })
      .strict(),
    wearPolicy: z
      .object({ amount: unit, placement: guidance, exclusions: z.array(guidance) })
      .strict(),
    lightingIntent: guidance,
    antiGoals: z.array(guidance),
    palette: z
      .array(
        z
          .object({
            id: z.string().min(1).max(64),
            name: z.string().trim().min(1).max(160),
            color: z.string().regex(/^#[0-9A-Fa-f]{6}$/u),
            metallic: unit,
            roughness: unit,
            emissive: z
              .string()
              .regex(/^#[0-9A-Fa-f]{6}$/u)
              .optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type StyleProfileDeclaration = z.output<typeof STYLE_PROFILE_DECLARATION_SCHEMA>;

export const SEALED_STYLE_PROFILE_SCHEMA = STYLE_PROFILE_DECLARATION_SCHEMA.safeExtend({
  kind: z.literal("SealedStyleProfile"),
  hash: HASH_SCHEMA,
})
  .strict()
  .superRefine((value, context) => {
    const { hash: _hash, ...material } = value;
    if (contentHash(stableJson(material)) !== value.hash)
      context.addIssue({ code: "custom", path: ["hash"], message: "Style profile hash mismatch" });
  });
export type SealedStyleProfile = z.output<typeof SEALED_STYLE_PROFILE_SCHEMA>;

export function sealStyleProfile(input: StyleProfileDeclaration): SealedStyleProfile {
  const declaration = STYLE_PROFILE_DECLARATION_SCHEMA.parse(input);
  const material = { kind: "SealedStyleProfile" as const, ...declaration };
  return deepFreezeJson(
    SEALED_STYLE_PROFILE_SCHEMA.parse({ ...material, hash: contentHash(stableJson(material)) }),
  ) as SealedStyleProfile;
}
