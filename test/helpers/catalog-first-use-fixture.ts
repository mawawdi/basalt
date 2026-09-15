import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CATALOG_AUTHORITY_COMMIT_SCHEMA } from "@basalt/catalog-authoring";
import { CATALOG_MEASUREMENT_SET_SCHEMA, type CatalogRequirement } from "@basalt/catalog-model";
import { contentHash } from "@basalt/contracts";
import {
  createSemanticDependencyClosure,
  sealSemanticAssertionBundle,
  type SemanticModule,
} from "@basalt/semantic-kernel";
import { sealSpatialWorldPlan, type SpatialWorldPlan } from "@basalt/world-planning";

export const CATALOG_FIRST_USE_OUTPUT_ROOT = ".basalt/evals/catalog-first-use";
export const CATALOG_FIRST_USE_STYLE = "stylized_low_poly_nature";

export async function catalogFirstUseFixture(module: SemanticModule) {
  const catalogCommit = CATALOG_AUTHORITY_COMMIT_SCHEMA.parse(
    JSON.parse(await readFile(resolve("registry/catalog.json"), "utf8")),
  );
  const retainedMeasurements = catalogCommit.retainedEvidence.find(
    (entry) =>
      entry.kind === "CatalogMeasurementSet" &&
      entry.artifactHash === catalogCommit.measurementSetHash,
  );
  if (!retainedMeasurements)
    throw new Error("The real catalog commit does not retain its exact measurement set");
  const measurementBytes = await readFile(resolve(retainedMeasurements.relativePath));
  if (
    measurementBytes.byteLength !== retainedMeasurements.bytes ||
    createHash("sha256").update(measurementBytes).digest("hex") !== retainedMeasurements.bytesHash
  )
    throw new Error("The retained catalog measurement bytes do not match the catalog commit");
  const measurements = CATALOG_MEASUREMENT_SET_SCHEMA.parse(
    JSON.parse(measurementBytes.toString("utf8")),
  );
  if (measurements.hash !== catalogCommit.measurementSetHash)
    throw new Error("The retained measurements bind another catalog commit");

  const requirements = [
    requirement(module, "OutdoorTrees", "bsc_000003", 24),
    requirement(module, "OutdoorRocks", "bsc_000012", 16),
    requirement(module, "OutdoorGroundcover", "bsc_000005", 48),
    requirement(module, "OutdoorProps", "bsc_000018", 4),
  ];
  const regionConcept = requireConcept(module, "bsc_000316");
  const regionClosure = createSemanticDependencyClosure({
    module,
    conceptIds: [regionConcept.conceptId],
  });
  const regionAssertions = sealSemanticAssertionBundle({
    authority: "admitted",
    assertions: [
      {
        assertionKind: "denotation",
        subject: { kind: "planned_entity", id: "CatalogFirstUseRegionEntity" },
        concept: {
          conceptId: regionConcept.conceptId,
          commitmentHash: regionConcept.commitmentHash,
        },
        evidence: {
          level: "declared",
          evidenceHashes: [contentHash("catalog-first-use-region-intent")],
        },
      },
    ],
  });
  const plan = sealSpatialWorldPlan({
    planId: "CatalogFirstUse",
    seed: 2_609_150,
    boundsMeters: { min: { x: 0, y: -4, z: 0 }, max: { x: 48, y: 16, z: 48 } },
    semanticEntities: [
      {
        entityId: "CatalogFirstUseRegionEntity",
        upperSort: "space",
        semanticDependencyClosureHash: regionClosure.hash,
        admittedAssertionBundleHash: regionAssertions.hash,
      },
    ],
    admittedAssertions: [regionAssertions],
    regions: [
      {
        regionId: "CatalogFirstUseRegion",
        semanticEntityId: "CatalogFirstUseRegionEntity",
        volume: {
          kind: "box",
          bounds: { min: { x: 0, y: -4, z: 0 }, max: { x: 48, y: 16, z: 48 } },
        },
        refinementPriority: 0,
      },
    ],
    placementSurfaces: [
      {
        surfaceId: "CatalogFirstUseGround",
        regionId: "CatalogFirstUseRegion",
        kind: "terrain",
        bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 48, y: 0, z: 48 } },
        normal: { x: 0, y: 1, z: 0 },
        sourceHash: contentHash("catalog-first-use-ground-surface"),
      },
    ],
    terrainPlans: [
      {
        terrainPlanId: "CatalogFirstUseTerrain",
        surfaceId: "CatalogFirstUseGround",
        regionIds: ["CatalogFirstUseRegion"],
        boundsMeters: {
          x: { minimum: 0, maximum: 48 },
          z: { minimum: 0, maximum: 48 },
        },
        resolution: { columns: 33, rows: 33 },
        baseElevationMeters: 0,
        operations: [
          { kind: "raise", center: { x: 26, z: 24 }, radiusMeters: 18, deltaMeters: 2.5 },
          {
            kind: "flatten",
            polygon: rectangleXZ(4, 4, 18, 16),
            elevationMeters: 0.4,
            blendWidthMeters: 2,
          },
        ],
        materialId: "Grass",
      },
    ],
    routes: [],
    routeJunctions: [],
    lotPolicies: [],
    structuralPrograms: [],
    constructionPrograms: [],
    catalogRequirements: requirements,
    realizationIntents: [
      {
        kind: "cluster",
        intentId: "PlaceOutdoorTrees",
        requirementId: "OutdoorTrees",
        priority: 40,
        regionId: "CatalogFirstUseRegion",
        surfaceId: "CatalogFirstUseGround",
        center: { u: 33, v: 31 },
        radiusMeters: 10,
        minimumCount: 4,
        targetCount: 6,
        minimumSeparationMeters: 3,
      },
      {
        kind: "cluster",
        intentId: "PlaceOutdoorRocks",
        requirementId: "OutdoorRocks",
        priority: 30,
        regionId: "CatalogFirstUseRegion",
        surfaceId: "CatalogFirstUseGround",
        center: { u: 15, v: 30 },
        radiusMeters: 6,
        minimumCount: 2,
        targetCount: 4,
        minimumSeparationMeters: 2,
      },
      {
        kind: "surface_scatter",
        intentId: "PlaceOutdoorGroundcover",
        requirementId: "OutdoorGroundcover",
        priority: 20,
        regionId: "CatalogFirstUseRegion",
        surfaceId: "CatalogFirstUseGround",
        boundary: rectangle(6, 18, 42, 43),
        minimumCount: 8,
        targetCount: 14,
        minimumSeparationMeters: 1.5,
      },
      {
        kind: "single",
        intentId: "PlaceOutdoorProp",
        requirementId: "OutdoorProps",
        priority: 10,
        regionId: "CatalogFirstUseRegion",
        surfaceId: "CatalogFirstUseGround",
        at: { u: 13, v: 11 },
      },
    ],
    cameras: [
      {
        cameraId: "CatalogFirstUseOverview",
        positionMeters: { x: 24, y: 34, z: 52 },
        lookAtMeters: { x: 24, y: 1, z: 24 },
        up: { x: 0, y: 1, z: 0 },
        fieldOfViewDegrees: 55,
        regionIds: ["CatalogFirstUseRegion"],
        readabilityIntent: {
          kind: "art_directed",
          rationale: "Show the terrain and all four catalog-backed outdoor placement regions.",
        },
      },
    ],
  });
  const changedPlan = changeOutdoorPropBudget(plan, 1);
  return {
    catalogCommit,
    measurements,
    plan,
    changedPlan,
    requirements,
  };
}

export function changeOutdoorPropBudget(
  plan: SpatialWorldPlan,
  maximumSourceBytes: number,
): SpatialWorldPlan {
  const {
    kind: _kind,
    coordinateSystem: _coordinateSystem,
    planHash: _planHash,
    ...material
  } = plan;
  return sealSpatialWorldPlan({
    ...material,
    catalogRequirements: plan.catalogRequirements.map((entry) =>
      entry.requirementId === "OutdoorProps"
        ? { ...entry, budget: { ...entry.budget, maximumSourceBytes } }
        : entry,
    ),
  });
}

function requirement(
  module: SemanticModule,
  requirementId: string,
  conceptId: string,
  maximumInstances: number,
): CatalogRequirement {
  const concept = requireConcept(module, conceptId);
  const closure = createSemanticDependencyClosure({
    module,
    conceptIds: [conceptId],
    definitionIds: ["whole"],
  });
  return {
    requirementId,
    semantic: {
      denotation: {
        conceptId,
        commitmentHash: concept.commitmentHash,
        matchMode: "exact",
      },
      realizationForms: ["whole"],
      affordances: [],
      states: [],
      surfaceTreatmentIds: [],
      dependencyClosureHash: closure.hash,
    },
    acceptedEntryKinds: ["substitution_set"],
    styleProfileHandles: [CATALOG_FIRST_USE_STYLE],
    placement: { requiredSupport: "ground", requiredInterfaceIds: [] },
    metricBounds: {},
    rights: { commercialUseRequired: true, redistributionRequired: true },
    budget: {
      maximumTriangles: 5_000_000,
      maximumSourceBytes: 512 * 1024 * 1024,
      maximumInstances,
    },
    required: true,
  };
}

function requireConcept(module: SemanticModule, conceptId: string) {
  const concept = module.concepts.find((entry) => entry.conceptId === conceptId);
  if (!concept) throw new Error(`Catalog-first-use concept is missing: ${conceptId}`);
  return concept;
}

function rectangle(minU: number, minV: number, maxU: number, maxV: number) {
  return [
    { u: minU, v: minV },
    { u: maxU, v: minV },
    { u: maxU, v: maxV },
    { u: minU, v: maxV },
  ];
}

function rectangleXZ(minX: number, minZ: number, maxX: number, maxZ: number) {
  return [
    { x: minX, z: minZ },
    { x: maxX, z: minZ },
    { x: maxX, z: maxZ },
    { x: minX, z: maxZ },
  ];
}
