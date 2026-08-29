import { z } from "zod";
import { hashSchema } from "../../spatial-core/src/primitives.js";

export const REFERENCE_IMAGE_JSON_ARTIFACT_SCHEMA = z
  .object({
    locator: z.string().regex(/^artifacts\/[a-f0-9]{64}\.json$/u),
    artifactHash: hashSchema,
    bytes: z
      .number()
      .int()
      .positive()
      .max(32 * 1024 * 1024),
  })
  .strict()
  .refine(
    (value) => value.locator === `artifacts/${value.artifactHash}.json`,
    "JSON artifact locator must identify its exact bytes",
  );

export const REFERENCE_IMAGE_BINARY_ARTIFACT_SCHEMA = z
  .object({
    locator: z.string().regex(/^binary-artifacts\/[a-f0-9]{64}\.bin$/u),
    artifactHash: hashSchema,
    bytes: z
      .number()
      .int()
      .positive()
      .max(256 * 1024 * 1024),
    mediaType: z.string().trim().min(3).max(160),
  })
  .strict()
  .refine(
    (value) => value.locator === `binary-artifacts/${value.artifactHash}.bin`,
    "Binary artifact locator must identify its exact bytes",
  );
