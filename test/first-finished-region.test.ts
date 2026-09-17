import assert from "node:assert/strict";
import test from "node:test";
import { createRobloxImportManifest } from "@basalt/roblox";
import { compileBasaltWorld } from "@basalt/world-compiler";
import {
  FIRST_FINISHED_REGION_OVERLOOK_ROUTE_ID,
  FIRST_FINISHED_REGION_RAVINE_OVERLOOK_ROUTE_ID,
  FIRST_FINISHED_REGION_SIZE_METERS,
  FIRST_FINISHED_REGION_TOWER_ENTRY_ROUTE_ID,
  FIRST_FINISHED_REGION_VISUAL_ENVIRONMENT,
  firstFinishedRegionFixture,
} from "./helpers/first-finished-region-fixture.js";
import { loadSemanticRegistry } from "./helpers/semantic-registry.js";

type SimpleBounds = {
  readonly min: { readonly x: number; readonly y: number; readonly z: number };
  readonly max: { readonly x: number; readonly y: number; readonly z: number };
};

test("the first finished region integrates routes, construction, and admitted catalog assets", async () => {
  const module = await loadSemanticRegistry();
  const fixture = await firstFinishedRegionFixture(module);
  const first = compileBasaltWorld(fixture.compileInput);
  const second = compileBasaltWorld(fixture.compileInput);

  assert.equal(first.status, "eligible", first.diagnostics.join("; "));
  assert.equal(first.worldBuildHash, second.worldBuildHash);
  assert.equal(first.catalogSnapshotHash, fixture.catalogCommit.snapshot.hash);
  assert.deepEqual(first.visualEnvironment, FIRST_FINISHED_REGION_VISUAL_ENVIRONMENT);
  assert.equal(first.catalogResolution.gaps.length, 0);
  assert.deepEqual(first.diagnostics, []);
  assert.equal(first.foundation.boundsMeters.max.x, FIRST_FINISHED_REGION_SIZE_METERS);
  assert.equal(first.foundation.boundsMeters.max.z, FIRST_FINISHED_REGION_SIZE_METERS);
  const terrainElevations = first.foundation.baseTerrainFields.flatMap((entry) =>
    entry.samples.map((sample) => sample.elevationMeters),
  );
  assert.ok(Math.max(...terrainElevations) - Math.min(...terrainElevations) >= 21);
  assert.equal(first.foundation.routeConstructions.length, 7);
  assert.equal(first.foundation.routeJunctions.length, 4);
  const boardwalk = first.foundation.routeConstructions.find(
    (entry) => entry.routeId === "ScenicBoardwalk",
  );
  assert.equal(boardwalk?.treatmentKind, "elevated");
  assert.ok((boardwalk?.supports.length ?? 0) >= 20);
  assert.ok((boardwalk?.edgeRails.length ?? 0) > 0);
  assert.ok((boardwalk?.edgePosts.length ?? 0) > 0);
  const supportStations = new Map<number, NonNullable<typeof boardwalk>["supports"]>();
  for (const support of boardwalk?.supports ?? [])
    supportStations.set(support.stationMeters, [
      ...(supportStations.get(support.stationMeters) ?? []),
      support,
    ]);
  assert.ok([...supportStations.values()].every((supports) => supports.length === 2));
  const edgePostStations = new Map<number, NonNullable<typeof boardwalk>["edgePosts"]>();
  for (const post of boardwalk?.edgePosts ?? [])
    edgePostStations.set(post.stationMeters, [
      ...(edgePostStations.get(post.stationMeters) ?? []),
      post,
    ]);
  assert.ok([...edgePostStations.values()].every((posts) => posts.length === 2));
  assert.equal(boardwalk?.edgeRails.length, Math.max(0, edgePostStations.size - 1) * 4);
  assert.ok(
    [...(boardwalk?.edgeRails ?? []), ...(boardwalk?.edgePosts ?? [])].every(
      (entry) => entry.appearance.materialId === "WoodPlanks",
    ),
  );
  const skywalk = first.foundation.routeConstructions.find(
    (entry) => entry.routeId === "SummitSkywalk",
  );
  assert.equal(skywalk?.treatmentKind, "elevated");
  assert.ok((skywalk?.supports.length ?? 0) >= 18);
  assert.ok((skywalk?.edgeRails.length ?? 0) > 0);
  assert.ok((skywalk?.edgePosts.length ?? 0) > 0);
  for (const junction of first.foundation.routeJunctions) {
    assert.equal(junction.appearance.materialId, "WoodPlanks");
    assert.equal(junction.terrainTreatment.kind, "grade");
    if (junction.terrainTreatment.kind === "grade")
      assert.equal(junction.terrainTreatment.terrainMaterialId, "Ground");
    for (const participant of junction.participants) {
      const route = first.foundation.routeConstructions.find(
        (entry) => entry.routeId === participant.routeId,
      );
      assert.ok(route);
      assert.ok(junction.radiusMeters + 1e-9 >= route.widthMeters / 2);
      const endpoint = participant.endpoint === "start" ? route.profile[0]! : route.profile.at(-1)!;
      assert.deepEqual(endpoint.centerTopMeters, junction.centerTopMeters);
    }
  }
  assert.equal(first.meso.constructedStructures.length, 4);
  const tower = first.meso.constructedStructures.find((entry) =>
    entry.accessPaths.some(
      (accessPath) => accessPath.entryRouteId === FIRST_FINISHED_REGION_TOWER_ENTRY_ROUTE_ID,
    ),
  );
  const pavilion = first.meso.constructedStructures.find((entry) =>
    entry.accessPaths.some(
      (accessPath) => accessPath.entryRouteId === FIRST_FINISHED_REGION_OVERLOOK_ROUTE_ID,
    ),
  );
  const gateway = first.meso.constructedStructures.find((entry) =>
    entry.elements.some((element) => element.operationId === "GatewaySign"),
  );
  const ravineOverlook = first.meso.constructedStructures.find((entry) =>
    entry.accessPaths.some(
      (accessPath) => accessPath.entryRouteId === FIRST_FINISHED_REGION_RAVINE_OVERLOOK_ROUTE_ID,
    ),
  );
  assert.ok(tower);
  assert.ok(pavilion);
  assert.ok(gateway);
  assert.ok(ravineOverlook);
  const towerSpur = first.foundation.routeConstructions.find(
    (entry) => entry.routeId === FIRST_FINISHED_REGION_TOWER_ENTRY_ROUTE_ID,
  )!;
  const stairEntry = tower.accessPaths[0]!.entryMeters;
  const routeFinish = towerSpur.profile.at(-1)!.centerTopMeters;
  assert.ok(Math.hypot(routeFinish.x - stairEntry.x, routeFinish.z - stairEntry.z) <= 1e-9);
  assert.ok(Math.abs(routeFinish.y - stairEntry.y) <= 0.1);
  const towerAccess = tower.accessPaths.find(
    (entry) => entry.entryRouteId === FIRST_FINISHED_REGION_TOWER_ENTRY_ROUTE_ID,
  )!;
  const towerSteps = tower.elements
    .filter((entry) => entry.operationId === "TowerStairs")
    .sort((left, right) => left.boundsMeters.min.z - right.boundsMeters.min.z);
  assert.equal(towerSteps.length, towerAccess.stepElementIds.length);
  assert.ok(
    towerSteps.every(
      (step) =>
        step.boundsMeters.max.y - step.boundsMeters.min.y <= towerAccess.riserHeightMeters + 1e-9,
    ),
  );
  assert.ok(towerSteps.at(-1)!.boundsMeters.min.y > stairEntry.y + 10);
  const overlook = first.foundation.routeConstructions.find(
    (entry) => entry.routeId === FIRST_FINISHED_REGION_OVERLOOK_ROUTE_ID,
  )!;
  const pavilionEntry = pavilion.accessPaths[0]!.entryMeters;
  const overlookFinish = overlook.profile.at(-1)!.centerTopMeters;
  assert.ok(
    Math.hypot(overlookFinish.x - pavilionEntry.x, overlookFinish.z - pavilionEntry.z) <= 1e-9,
  );
  assert.ok(Math.abs(overlookFinish.y - pavilionEntry.y) <= 0.1);
  const ravineOverlookRoute = first.foundation.routeConstructions.find(
    (entry) => entry.routeId === FIRST_FINISHED_REGION_RAVINE_OVERLOOK_ROUTE_ID,
  )!;
  const ravineOverlookEntry = ravineOverlook.accessPaths[0]!.entryMeters;
  const ravineOverlookFinish = ravineOverlookRoute.profile.at(-1)!.centerTopMeters;
  assert.ok(
    Math.hypot(
      ravineOverlookFinish.x - ravineOverlookEntry.x,
      ravineOverlookFinish.z - ravineOverlookEntry.z,
    ) <= 1e-9,
  );
  assert.ok(Math.abs(ravineOverlookFinish.y - ravineOverlookEntry.y) <= 0.1);
  const towerOperations = new Set(tower.elements.map((entry) => entry.operationId));
  for (const operationId of [
    "FrontStairOpening",
    "SideTopRailEast",
    "SideTopRailWest",
    "BackTopRail",
    "PlatformBeamEastWest",
    "PlatformBeamNorthSouth",
    "TowerBraceFront_1",
    "TowerBraceBack_2",
    "CanopyPost_West_Front",
    "CanopyRoof",
    "CanopyCrown",
  ])
    assert.ok(towerOperations.has(operationId), `tower is missing ${operationId}`);
  const pavilionOperations = new Set(pavilion.elements.map((entry) => entry.operationId));
  for (const operationId of [
    "PavilionDeck",
    "PavilionEntrySteps",
    "PavilionRoof",
    "PavilionBenchSeat",
    "PavilionBenchBack",
  ])
    assert.ok(pavilionOperations.has(operationId), `pavilion is missing ${operationId}`);
  assert.ok(tower.boundsMeters.max.y - tower.boundsMeters.min.y >= 16);
  for (const structure of first.meso.constructedStructures)
    for (const opening of structure.openings) {
      const panelIds = new Set(opening.panelElementIds);
      const candidates: Array<{ readonly id: string; readonly boundsMeters: SimpleBounds }> = [
        ...first.meso.constructedStructures
          .flatMap((entry) => entry.elements)
          .filter((entry) => !panelIds.has(entry.elementId))
          .map((entry) => ({ id: entry.operationId, boundsMeters: entry.boundsMeters })),
        ...first.instances.map((entry) => ({
          id: entry.instanceId,
          boundsMeters: entry.boundsMeters,
        })),
      ];
      const blockerIds: string[] = candidates
        .filter((entry) => overlapsStrictly(opening.clearanceBoundsMeters, entry.boundsMeters))
        .map((entry) => entry.id);
      assert.deepEqual(blockerIds, [], `opening ${opening.openingId} has an offline blocker`);
    }
  assert.equal(first.instances.length, 230);
  assert.deepEqual([...new Set(first.instances.map((entry) => entry.intentId))].sort(), [
    "PlaceEastCanopyGrove",
    "PlaceEastFernFloor",
    "PlaceEastLog",
    "PlaceLowerBushMass",
    "PlaceLowerCanopyGrove",
    "PlaceLowerGrassMeadow",
    "PlaceLowerLog",
    "PlaceMeadowLog",
    "PlaceMonumentTreeEastRidge",
    "PlaceMonumentTreeNorthEast",
    "PlaceMonumentTreeNorthWest",
    "PlaceMonumentTreeSouthEast",
    "PlaceNorthPineForest",
    "PlaceOverlookLog",
    "PlaceOverlookRoundedRocks",
    "PlacePavilionLog",
    "PlacePavilionUnderstory",
    "PlaceRavineBoulders",
    "PlaceRavineLog",
    "PlaceRidgeTrailGrassWest",
    "PlaceSummitBushMass",
    "PlaceTowerLog",
    "PlaceTrailheadStoneField",
    "PlaceUpperTrailUnderstory",
    "PlaceWestFernFloor",
    "PlaceWestLog",
    "PlaceWestPineForest",
  ]);
  assert.deepEqual([...new Set(first.instances.map((entry) => entry.entryHandle))].sort(), [
    "plant_bush_03_ground",
    "plant_fern_01_ground",
    "plant_grass_04_ground",
    "rock_03_ground",
    "rock_boulder_01_ground",
    "rock_rounded_01_ground",
    "tree_03_ground",
    "tree_log_02_ground",
    "tree_pine_large_01_ground",
    "tree_round_04_ground",
    "tree_willow_large_01_ground",
  ]);

  const roblox = createRobloxImportManifest(first);
  assert.deepEqual(
    roblox.transactions.find((entry) => entry.stage === "commit")!.visualEnvironment,
    FIRST_FINISHED_REGION_VISUAL_ENVIRONMENT,
  );
  assert.deepEqual(
    roblox.loweringGaps.filter((entry) => entry.kind !== "asset_binding"),
    [],
  );
  const readback = roblox.transactions.find((entry) => entry.stage === "readback")!;
  assert.ok(readback.expectedConstructedElements.length > 0);
  const constructedElementById = new Map(
    first.meso.constructedStructures
      .flatMap((entry) => entry.elements)
      .map((entry) => [entry.elementId, entry] as const),
  );
  for (const expectation of readback.expectedConstructedElements) {
    const element = constructedElementById.get(expectation.elementId);
    assert.ok(element);
    assert.equal(expectation.materialId, element.appearance.materialId);
    assert.deepEqual(expectation.baseColorSrgb, element.appearance.baseColorSrgb);
  }
  assert.ok(readback.expectedConstructedElements.some((entry) => entry.materialId === "Slate"));
  assert.ok(
    readback.expectedConstructedElements.some((entry) => entry.materialId === "WoodPlanks"),
  );
  assert.equal(
    readback.expectedConstructedElements.length,
    first.meso.constructedStructures.flatMap((entry) => entry.elements).length,
  );
  assert.equal(
    readback.expectedConstructedOpenings.length,
    first.meso.constructedStructures.flatMap((entry) => entry.openings).length,
  );
});

function overlapsStrictly(left: SimpleBounds, right: SimpleBounds): boolean {
  return (
    left.min.x < right.max.x &&
    left.max.x > right.min.x &&
    left.min.y < right.max.y &&
    left.max.y > right.min.y &&
    left.min.z < right.max.z &&
    left.max.z > right.min.z
  );
}
