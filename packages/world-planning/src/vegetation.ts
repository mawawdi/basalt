import {
  REALIZATION_INTENT_SCHEMA,
  type PopulationDensityField,
  type RealizationIntent,
  type VegetationDistribution,
} from "@basalt/catalog-model";
import { deepFreezeJson } from "@basalt/contracts";

type ScatterIntent = Extract<RealizationIntent, { kind: "surface_scatter" }>;

export interface VegetationPaletteMember {
  readonly plantId: string;
  readonly requirementId: string;
  readonly layer: VegetationDistribution["layer"];
  readonly priority: number;
  readonly maximumCount: number;
  readonly minimumCount: number;
  readonly candidateDensityPerSquareMeter: number;
  readonly spacingMeters: VegetationDistribution["spacingMeters"];
  readonly canopyResponse: VegetationDistribution["canopyResponse"];
  readonly densityField?: PopulationDensityField;
}

export interface VegetationArea {
  readonly areaId: string;
  readonly habitatFieldId: string;
  readonly regionId: string;
  readonly surfaceId: string;
  readonly boundary: ScatterIntent["boundary"];
  readonly densityField: PopulationDensityField;
  readonly palette: readonly VegetationPaletteMember[];
  /** Existing authored canopy anchors, on this same region and surface. */
  readonly canopyIntentIds: readonly string[];
  readonly clearings: readonly (VegetationDistribution["clearings"][number] & {
    readonly layers: readonly VegetationDistribution["layer"][];
  })[];
  readonly maximumSlopeDegrees: number;
  readonly maximumSupportReliefMeters: number;
  readonly groundEmbedMeters: number;
  readonly routeClearanceHeightMeters: number;
  readonly minimumSeparationMeters: number;
}

/**
 * Expand one authored plant community into ordinary validated intents. No asset
 * selection, placement, new persisted contract, or inferred ecological claims.
 */
export function createVegetationIntents(input: VegetationArea): readonly ScatterIntent[] {
  if (input.palette.length < 1) throw new Error("Vegetation palette must contain members");
  const ids = input.palette.map((member) => `${input.areaId}_${member.plantId}`);
  if (new Set(ids).size !== ids.length) throw new Error("Vegetation plant IDs must be unique");
  const canopyIntentIds = [
    ...input.canopyIntentIds,
    ...input.palette.flatMap((member, index) => (member.layer === "canopy" ? [ids[index]!] : [])),
  ];
  const intents = input.palette.map(
    (member, index) =>
      REALIZATION_INTENT_SCHEMA.parse({
        kind: "surface_scatter",
        intentId: ids[index],
        requirementId: member.requirementId,
        priority: member.priority,
        regionId: input.regionId,
        surfaceId: input.surfaceId,
        boundary: input.boundary,
        minimumCount: member.minimumCount,
        targetCount: member.maximumCount,
        minimumSeparationMeters: input.minimumSeparationMeters,
        densityField: member.densityField ?? input.densityField,
        vegetation: {
          areaId: input.areaId,
          habitatFieldId: input.habitatFieldId,
          layer: member.layer,
          candidateDensityPerSquareMeter: member.candidateDensityPerSquareMeter,
          spacingMeters: member.spacingMeters,
          canopyResponse: member.canopyResponse,
          canopyIntentIds: member.layer === "canopy" ? [] : canopyIntentIds,
          maximumSlopeDegrees: input.maximumSlopeDegrees,
          maximumSupportReliefMeters: input.maximumSupportReliefMeters,
          groundEmbedMeters: input.groundEmbedMeters,
          routeClearanceHeightMeters: input.routeClearanceHeightMeters,
          clearings: input.clearings
            .filter((clearing) => clearing.layers.includes(member.layer))
            .map(({ layers: _layers, ...clearing }) => clearing),
        },
      }) as ScatterIntent,
  );
  return deepFreezeJson(intents);
}
