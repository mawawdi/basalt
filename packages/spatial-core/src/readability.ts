import { z } from "zod";

/** Pixel readability is a surface-level observation contract, independent of rendering backend. */
export const COMPILER_RENDER_READABILITY_METRICS = [
  "mean_luminance",
  "readable_pixel_fraction",
  "center_mean_luminance",
  "center_readable_pixel_fraction",
  "clipped_white_pixel_fraction",
  "luminance_standard_deviation",
] as const;

const normalizedThreshold = z.number().finite().min(0).max(1);
const readabilityCheck = z.discriminatedUnion("metric", [
  z.object({ metric: z.literal("mean_luminance"), minimum: normalizedThreshold }).strict(),
  z.object({ metric: z.literal("readable_pixel_fraction"), minimum: normalizedThreshold }).strict(),
  z.object({ metric: z.literal("center_mean_luminance"), minimum: normalizedThreshold }).strict(),
  z
    .object({ metric: z.literal("center_readable_pixel_fraction"), minimum: normalizedThreshold })
    .strict(),
  z
    .object({ metric: z.literal("clipped_white_pixel_fraction"), maximum: normalizedThreshold })
    .strict(),
  z
    .object({ metric: z.literal("luminance_standard_deviation"), minimum: normalizedThreshold })
    .strict(),
]);

export const COMPILER_RENDER_READABILITY_INTENT_SCHEMA = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("art_directed"), rationale: z.string().trim().min(1).max(1024) })
    .strict(),
  z
    .object({
      kind: z.literal("bounded"),
      checks: z.array(readabilityCheck).min(1).max(COMPILER_RENDER_READABILITY_METRICS.length),
    })
    .strict()
    .superRefine((value, context) => {
      if (new Set(value.checks.map((check) => check.metric)).size !== value.checks.length)
        context.addIssue({
          code: "custom",
          path: ["checks"],
          message: "Render readability metrics must be unique",
        });
    }),
]);
export type CompilerRenderReadabilityIntent = z.infer<
  typeof COMPILER_RENDER_READABILITY_INTENT_SCHEMA
>;
