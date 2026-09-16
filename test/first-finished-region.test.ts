import assert from "node:assert/strict";
import test from "node:test";
import { createRobloxImportManifest } from "@basalt/roblox";
import { compileBasaltWorld } from "@basalt/world-compiler";
import {
  FIRST_FINISHED_REGION_TOWER_ENTRY_ROUTE_ID,
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
  assert.equal(first.catalogResolution.gaps.length, 0);
  assert.equal(first.foundation.routeConstructions.length, 4);
  assert.equal(first.foundation.routeJunctions.length, 2);
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
  assert.equal(first.meso.constructedStructures.length, 1);
  assert.equal(
    first.meso.constructedStructures[0]?.accessPaths[0]?.entryRouteId,
    FIRST_FINISHED_REGION_TOWER_ENTRY_ROUTE_ID,
  );
  const towerSpur = first.foundation.routeConstructions.find(
    (entry) => entry.routeId === FIRST_FINISHED_REGION_TOWER_ENTRY_ROUTE_ID,
  )!;
  const stairEntry = first.meso.constructedStructures[0]!.accessPaths[0]!.entryMeters;
  const routeFinish = towerSpur.profile.at(-1)!.centerTopMeters;
  assert.ok(Math.hypot(routeFinish.x - stairEntry.x, routeFinish.z - stairEntry.z) <= 1e-9);
  assert.ok(Math.abs(routeFinish.y - stairEntry.y) <= 0.1);
  const towerOperations = new Set(
    first.meso.constructedStructures[0]!.elements.map((entry) => entry.operationId),
  );
  for (const operationId of [
    "FrontStairOpening",
    "SideTopRailEast",
    "SideTopRailWest",
    "BackTopRail",
    "PlatformBeamEastWest",
    "PlatformBeamNorthSouth",
  ])
    assert.ok(towerOperations.has(operationId), `tower is missing ${operationId}`);
  for (const opening of first.meso.constructedStructures[0]!.openings) {
    const panelIds = new Set(opening.panelElementIds);
    const candidates: Array<{ readonly id: string; readonly boundsMeters: SimpleBounds }> = [
      ...first.meso.constructedStructures[0]!.elements.filter(
        (entry) => !panelIds.has(entry.elementId),
      ).map((entry) => ({ id: entry.operationId, boundsMeters: entry.boundsMeters })),
      ...first.instances.map((entry) => ({
        id: entry.instanceId,
        boundsMeters: entry.boundsMeters,
      })),
    ];
    const blockerIds: string[] = candidates
      .filter((entry) => overlapsStrictly(opening.clearanceBoundsMeters, entry.boundsMeters))
      .map((entry) => entry.id);
    assert.deepEqual(blockerIds, [], `tower opening ${opening.openingId} has an offline blocker`);
  }
  assert.deepEqual([...new Set(first.instances.map((entry) => entry.intentId))].sort(), [
    "PlaceEastGrove",
    "PlaceFallenLog",
    "PlaceNorthGrove",
    "PlaceRidgeRocks",
    "PlaceWoodlandGroundcover",
  ]);

  const roblox = createRobloxImportManifest(first);
  assert.deepEqual(
    roblox.loweringGaps.filter((entry) => entry.kind !== "asset_binding"),
    [],
  );
  const readback = roblox.transactions.find((entry) => entry.stage === "readback")!;
  assert.ok(readback.expectedConstructedElements.length > 0);
  assert.ok(
    readback.expectedConstructedElements.every(
      (entry) =>
        entry.materialId === "WoodPlanks" &&
        entry.baseColorSrgb.red === 112 &&
        entry.baseColorSrgb.green === 78 &&
        entry.baseColorSrgb.blue === 45,
    ),
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
