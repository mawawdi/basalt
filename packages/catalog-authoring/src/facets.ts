import { z } from "zod";
import {
  AFFORDANCE_ID_SCHEMA,
  CONCEPT_COMMITMENT_REFERENCE_SCHEMA,
  REALIZATION_FORM_SCHEMA,
  STATE_DIMENSION_ID_SCHEMA,
  STATE_VALUE_ID_SCHEMA,
  SURFACE_TREATMENT_ID_SCHEMA,
  type SemanticAssertionBundle,
} from "@basalt/semantic-kernel";

export const CATALOG_PREDICTION_FACETS = [
  "affordance",
  "denotation",
  "realization_form",
  "state",
  "surface_treatment",
] as const;
export const CATALOG_PREDICTION_FACET_SCHEMA = z.enum(CATALOG_PREDICTION_FACETS);
export type CatalogPredictionFacet = z.output<typeof CATALOG_PREDICTION_FACET_SCHEMA>;

export const CATALOG_FACET_VALUE_SCHEMA = z.discriminatedUnion("assertionKind", [
  z
    .object({
      assertionKind: z.literal("denotation"),
      concept: CONCEPT_COMMITMENT_REFERENCE_SCHEMA,
    })
    .strict(),
  z
    .object({
      assertionKind: z.literal("realization_form"),
      realizationForm: REALIZATION_FORM_SCHEMA,
    })
    .strict(),
  z
    .object({
      assertionKind: z.literal("state"),
      stateDimensionId: STATE_DIMENSION_ID_SCHEMA,
      stateValueId: STATE_VALUE_ID_SCHEMA,
    })
    .strict(),
  z
    .object({
      assertionKind: z.literal("affordance"),
      affordanceId: AFFORDANCE_ID_SCHEMA,
    })
    .strict(),
  z
    .object({
      assertionKind: z.literal("surface_treatment"),
      surfaceTreatmentId: SURFACE_TREATMENT_ID_SCHEMA,
    })
    .strict(),
]);
export type CatalogFacetValue = z.output<typeof CATALOG_FACET_VALUE_SCHEMA>;

type HypothesisAssertion = Extract<
  SemanticAssertionBundle,
  { authority: "hypothesis" }
>["assertions"][number];

export function facetValueFromAssertion(
  assertion: HypothesisAssertion,
): CatalogFacetValue | undefined {
  switch (assertion.assertionKind) {
    case "denotation":
      return { assertionKind: "denotation", concept: assertion.concept };
    case "realization_form":
      return { assertionKind: "realization_form", realizationForm: assertion.realizationForm };
    case "state":
      return {
        assertionKind: "state",
        stateDimensionId: assertion.stateDimensionId,
        stateValueId: assertion.stateValueId,
      };
    case "affordance":
      return { assertionKind: "affordance", affordanceId: assertion.affordanceId };
    case "surface_treatment":
      return {
        assertionKind: "surface_treatment",
        surfaceTreatmentId: assertion.surfaceTreatmentId,
      };
    case "relation":
    case "role":
      return undefined;
  }
}

export function facetValueKey(value: CatalogFacetValue): string {
  switch (value.assertionKind) {
    case "denotation":
      return `denotation:${value.concept.conceptId}:${value.concept.commitmentHash}`;
    case "realization_form":
      return `realization_form:${value.realizationForm}`;
    case "state":
      return `state:${value.stateDimensionId}:${value.stateValueId}`;
    case "affordance":
      return `affordance:${value.affordanceId}`;
    case "surface_treatment":
      return `surface_treatment:${value.surfaceTreatmentId}`;
  }
}
