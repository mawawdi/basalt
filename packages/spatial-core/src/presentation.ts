import { z } from "zod";
import { entityId } from "./primitives.js";
const finite = z.number().finite();
export const SRGB_COLOR_SCHEMA = z
  .object({
    space: z.literal("srgb"),
    r: finite.min(0).max(1),
    g: finite.min(0).max(1),
    b: finite.min(0).max(1),
    a: finite.min(0).max(1),
  })
  .strict();
export const PRESENTATION_ATMOSPHERE_SCHEMA = z
  .object({
    color: SRGB_COLOR_SCHEMA,
    decay: SRGB_COLOR_SCHEMA,
    density: finite.min(0).max(1),
    offset: finite.min(-1).max(1),
    haze: finite.min(0).max(10),
    glare: finite.min(0).max(10),
  })
  .strict();
export const PRESENTATION_BLOOM_SCHEMA = z
  .object({
    enabled: z.boolean(),
    intensity: finite.min(0).max(10),
    size: finite.min(0).max(56),
    threshold: finite.min(0).max(1),
  })
  .strict();
export const PRESENTATION_COLOR_CORRECTION_SCHEMA = z
  .object({
    enabled: z.boolean(),
    brightness: finite.min(-1).max(1),
    contrast: finite.min(-1).max(4),
    saturation: finite.min(-1).max(4),
    tintColor: SRGB_COLOR_SCHEMA,
  })
  .strict();
export const PRESENTATION_SKY_SCHEMA = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("uniform_color"), color: SRGB_COLOR_SCHEMA }).strict(),
  z
    .object({
      kind: z.literal("cubemap"),
      positiveXTextureId: entityId,
      negativeXTextureId: entityId,
      positiveYTextureId: entityId,
      negativeYTextureId: entityId,
      positiveZTextureId: entityId,
      negativeZTextureId: entityId,
    })
    .strict(),
]);
export const SCENE_PRESENTATION_SCHEMA = z
  .object({
    kind: z.literal("ScenePresentation"),
    solar: z
      .object({
        clockTimeHours: finite.min(0).max(24),
        geographicLatitudeDegrees: finite.min(-90).max(90),
        brightness: finite.min(0).max(10),
        globalShadows: z.boolean(),
        shadowSoftness: finite.min(0).max(1),
      })
      .strict(),
    environment: z
      .object({
        ambient: SRGB_COLOR_SCHEMA,
        outdoorAmbient: SRGB_COLOR_SCHEMA,
        environmentDiffuseScale: finite.min(0).max(1),
        environmentSpecularScale: finite.min(0).max(1),
        colorShiftTop: SRGB_COLOR_SCHEMA,
        colorShiftBottom: SRGB_COLOR_SCHEMA,
        sky: PRESENTATION_SKY_SCHEMA,
      })
      .strict(),
    exposureStops: finite.min(-5).max(5),
    atmosphere: PRESENTATION_ATMOSPHERE_SCHEMA.optional(),
    bloom: PRESENTATION_BLOOM_SCHEMA.optional(),
    colorCorrection: PRESENTATION_COLOR_CORRECTION_SCHEMA.optional(),
    colorManagement: z
      .object({
        workingSpace: z.literal("scene_linear"),
        outputEncoding: z.literal("srgb"),
        viewTransform: z.literal("AgX"),
        look: z.literal("None"),
        gamma: z.literal(1),
      })
      .strict(),
  })
  .strict();
export type ScenePresentation = z.infer<typeof SCENE_PRESENTATION_SCHEMA>;
