import { contentHash } from "@basalt/contracts";
import {
  createSemanticDependencyClosure,
  sealSemanticAssertionBundle,
  type SemanticModule,
} from "@basalt/semantic-kernel";
import { sealSpatialWorldPlan } from "@basalt/world-planning";
import { catalogFixture } from "./catalog-fixture.js";

export async function worldFixture(module: SemanticModule) {
  const catalog = await catalogFixture(module);
  const regionConcept = module.concepts.find((entry) => entry.conceptId === "bsc_000316")!;
  const routeConcept = module.concepts.find((entry) => entry.conceptId === "bsc_000305")!;
  const regionClosure = createSemanticDependencyClosure({
    module,
    conceptIds: [regionConcept.conceptId],
  });
  const routeClosure = createSemanticDependencyClosure({
    module,
    conceptIds: [routeConcept.conceptId],
  });
  const regionAssertions = entityAssertions(
    "RegionEntity",
    regionConcept.conceptId,
    regionConcept.commitmentHash,
  );
  const routeAssertions = entityAssertions(
    "RouteEntity",
    routeConcept.conceptId,
    routeConcept.commitmentHash,
  );
  const plan = sealSpatialWorldPlan({
    planId: "FixtureWorld",
    seed: 42,
    boundsMeters: { min: { x: 0, y: -2, z: 0 }, max: { x: 20, y: 12, z: 20 } },
    semanticEntities: [
      {
        entityId: "RegionEntity",
        upperSort: "space",
        semanticDependencyClosureHash: regionClosure.hash,
        admittedAssertionBundleHash: regionAssertions.hash,
      },
      {
        entityId: "RouteEntity",
        upperSort: "space",
        regionId: "MainRegion",
        semanticDependencyClosureHash: routeClosure.hash,
        admittedAssertionBundleHash: routeAssertions.hash,
      },
    ],
    admittedAssertions: [regionAssertions, routeAssertions],
    regions: [
      {
        regionId: "MainRegion",
        semanticEntityId: "RegionEntity",
        volume: {
          kind: "box",
          bounds: { min: { x: 0, y: -2, z: 0 }, max: { x: 20, y: 12, z: 20 } },
        },
        refinementPriority: 0,
      },
    ],
    placementSurfaces: [
      {
        surfaceId: "GroundSurface",
        regionId: "MainRegion",
        kind: "terrain",
        bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 20, y: 0, z: 20 } },
        normal: { x: 0, y: 1, z: 0 },
        sourceHash: contentHash("fixture-ground-surface"),
      },
    ],
    terrainPlans: [
      {
        terrainPlanId: "GroundTerrain",
        surfaceId: "GroundSurface",
        regionIds: ["MainRegion"],
        boundsMeters: {
          x: { minimum: 0, maximum: 20 },
          z: { minimum: 0, maximum: 20 },
        },
        resolution: { columns: 3, rows: 3 },
        baseElevationMeters: 0,
        operations: [{ kind: "raise", center: { x: 10, z: 10 }, radiusMeters: 8, deltaMeters: 2 }],
        materialId: "Grass",
      },
    ],
    routes: [
      {
        routeId: "MainRoute",
        semanticEntityId: "RouteEntity",
        regionIds: ["MainRegion"],
        surfaceId: "GroundSurface",
        pointsMeters: [
          { x: 1, y: 0, z: 1 },
          { x: 19, y: 0, z: 1 },
        ],
        widthMeters: 2,
        heightClearanceMeters: 0.2,
        closed: false,
      },
    ],
    lotPolicies: [],
    structuralPrograms: [],
    catalogRequirements: [catalog.requirement],
    realizationIntents: [
      {
        kind: "single",
        intentId: "PlaceTree",
        requirementId: catalog.requirement.requirementId,
        priority: 10,
        regionId: "MainRegion",
        surfaceId: "GroundSurface",
        at: { u: 10, v: 10 },
      },
    ],
    cameras: [],
  });
  return { ...catalog, plan };
}

function entityAssertions(entityId: string, conceptId: string, commitmentHash: string) {
  return sealSemanticAssertionBundle({
    authority: "admitted",
    assertions: [
      {
        assertionKind: "denotation",
        subject: { kind: "planned_entity", id: entityId },
        concept: { conceptId, commitmentHash },
        evidence: { level: "declared", evidenceHashes: [contentHash(`${entityId}:declared`)] },
      },
    ],
  });
}
