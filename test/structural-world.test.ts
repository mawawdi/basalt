import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  STYLE_PROFILE_DECLARATION_SCHEMA,
  sealCatalogAssetArtifact,
  sealCatalogSnapshot,
  sealStyleProfile,
  type CatalogAssetArtifact,
} from "@basalt/catalog-model";
import { contentHash, quantizeQ32_32 } from "@basalt/contracts";
import { createRobloxImportManifest, sealRobloxAssetBinding } from "@basalt/roblox";
import {
  createSemanticDependencyClosure,
  sealSemanticAssertionBundle,
} from "@basalt/semantic-kernel";
import { compileBasaltWorld } from "@basalt/world-compiler";
import { sealSpatialWorldPlan } from "@basalt/world-planning";
import { loadSemanticRegistry } from "./helpers/semantic-registry.js";

const evidenceHash = contentHash("structural-fixture-evidence");

test("assemblies bind exact components, sockets, surfaces, rooms, portals, and stairs", async () => {
  const module = await loadSemanticRegistry();
  const element = module.concepts.find((entry) => entry.conceptId === "bsc_000028")!;
  const building = module.concepts.find((entry) => entry.conceptId === "bsc_000022")!;
  const region = module.concepts.find((entry) => entry.conceptId === "bsc_000316")!;
  const room = module.concepts.find((entry) => entry.conceptId === "bsc_000302")!;
  const wallAsset = componentAsset("wall", [
    socket("door", 0, 0.5, -0.5, 0, 0, -1, 1),
    socket("right", 0.5, 0.5, 0, 1, 0, 0, 0.1),
  ]);
  const floorAsset = componentAsset("floor", [socket("left", -0.5, 0.5, 0, -1, 0, 0, 0.1)]);
  const wallAssertions = assetAssertions(wallAsset.assetId, element, "component");
  const floorAssertions = assetAssertions(floorAsset.assetId, element, "component");
  const componentClosure = createSemanticDependencyClosure({
    module,
    conceptIds: [element.conceptId],
    definitionIds: ["component"],
  });
  const kitClosure = createSemanticDependencyClosure({
    module,
    conceptIds: [building.conceptId],
    definitionIds: ["assembly"],
  });
  const styles = STYLE_PROFILE_DECLARATION_SCHEMA.array().parse(
    JSON.parse(await readFile(resolve("registry/style-profiles.json"), "utf8")),
  );
  const snapshot = sealCatalogSnapshot({
    semanticModule: module,
    semanticAssertions: [wallAssertions, floorAssertions],
    styleProfiles: styles.map(sealStyleProfile),
    assets: [wallAsset, floorAsset],
    declarations: [
      {
        kind: "substitution_set",
        handle: "wall_component",
        semantic: semanticSignature(element, "component", componentClosure.hash),
        placement: {
          support: "ground",
          contact: "bottom",
          interfaces: [
            { interfaceId: "door_opening", polarity: "neutral" },
            { interfaceId: "join_plug", polarity: "plug" },
          ],
        },
        styleProfileHandle: "neutral",
        evidenceHashes: [evidenceHash],
        members: [
          {
            memberId: "wall_a",
            assetHash: wallAsset.hash,
            assertionBundleHash: wallAssertions.hash,
            selectionWeight: 1,
            socketBindings: [
              { socketId: "door", interfaceId: "door_opening", polarity: "neutral" },
              { socketId: "right", interfaceId: "join_plug", polarity: "plug" },
            ],
          },
        ],
      },
      {
        kind: "substitution_set",
        handle: "floor_component",
        semantic: semanticSignature(element, "component", componentClosure.hash),
        placement: {
          support: "ground",
          contact: "bottom",
          interfaces: [{ interfaceId: "join_socket", polarity: "socket" }],
        },
        styleProfileHandle: "neutral",
        evidenceHashes: [evidenceHash],
        members: [
          {
            memberId: "floor_a",
            assetHash: floorAsset.hash,
            assertionBundleHash: floorAssertions.hash,
            selectionWeight: 1,
            socketBindings: [{ socketId: "left", interfaceId: "join_socket", polarity: "socket" }],
          },
        ],
      },
      {
        kind: "assembly_kit",
        handle: "building_kit",
        semantic: semanticSignature(building, "assembly", kitClosure.hash),
        placement: { support: "ground", contact: "bottom", interfaces: [] },
        styleProfileHandle: "neutral",
        evidenceHashes: [evidenceHash],
        roleSchemeId: "brs_000001",
        providers: [
          {
            roleSchemeId: "brs_000001",
            roleId: "bro_000002",
            providerHandles: ["floor_component"],
            minimumCount: 1,
            maximumCount: 1,
            socketBindings: [{ providerSocketId: "left", interfaceId: "join_socket" }],
          },
          {
            roleSchemeId: "brs_000001",
            roleId: "bro_000003",
            providerHandles: ["wall_component"],
            minimumCount: 1,
            maximumCount: 1,
            socketBindings: [
              { providerSocketId: "door", interfaceId: "door_opening" },
              { providerSocketId: "right", interfaceId: "join_plug" },
            ],
          },
        ],
        interfaces: [
          { interfaceId: "door_opening", polarity: "neutral" },
          { interfaceId: "join_plug", polarity: "plug" },
          { interfaceId: "join_socket", polarity: "socket" },
        ],
        allowedMates: [{ firstInterfaceId: "join_plug", secondInterfaceId: "join_socket" }],
        transitions: [
          {
            fromRoleId: "bro_000003",
            toRoleId: "bro_000002",
            hostInterfaceId: "join_plug",
            childInterfaceId: "join_socket",
          },
        ],
        topology: { connectivity: "connected", cyclePolicy: "forbidden", minimumConnections: 1 },
        lattice: { pitchMeters: q(1), authority: "authored" },
        terminalRoleIds: ["bro_000002", "bro_000003"],
        requiredCoverageRoleIds: ["bro_000002", "bro_000003"],
      },
    ],
    dispositions: [
      {
        sourceContentHash: floorAsset.source.contentHash,
        status: "eligible",
        usage: { kind: "entry_member", entryHandle: "floor_component", memberId: "floor_a" },
      },
      {
        sourceContentHash: wallAsset.source.contentHash,
        status: "eligible",
        usage: { kind: "entry_member", entryHandle: "wall_component", memberId: "wall_a" },
      },
    ],
    sourceContentHashes: [floorAsset.source.contentHash, wallAsset.source.contentHash].sort(),
  });
  const regionAssertions = plannedAssertions("RegionEntity", region);
  const roomAssertions = plannedAssertions("RoomEntity", room);
  const regionClosure = createSemanticDependencyClosure({ module, conceptIds: [region.conceptId] });
  const roomClosure = createSemanticDependencyClosure({ module, conceptIds: [room.conceptId] });
  const requirement = {
    requirementId: "BuildingRequirement",
    semantic: {
      denotation: {
        conceptId: building.conceptId,
        commitmentHash: building.commitmentHash,
        matchMode: "exact" as const,
      },
      realizationForms: ["assembly" as const],
      affordances: [],
      states: [],
      surfaceTreatmentIds: [],
      dependencyClosureHash: kitClosure.hash,
    },
    acceptedEntryKinds: ["assembly_kit" as const],
    styleProfileHandles: ["neutral"],
    placement: { requiredSupport: "ground" as const, requiredInterfaceIds: [] },
    metricBounds: {},
    rights: { commercialUseRequired: true, redistributionRequired: true },
    budget: { maximumTriangles: 10_000, maximumSourceBytes: 10_000, maximumInstances: 16 },
    required: true,
  };
  const plan = sealSpatialWorldPlan({
    planId: "StructuralWorld",
    seed: 7,
    boundsMeters: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 } },
    semanticEntities: [
      {
        entityId: "RegionEntity",
        upperSort: "space",
        semanticDependencyClosureHash: regionClosure.hash,
        admittedAssertionBundleHash: regionAssertions.hash,
      },
      {
        entityId: "RoomEntity",
        upperSort: "space",
        regionId: "MainRegion",
        semanticDependencyClosureHash: roomClosure.hash,
        admittedAssertionBundleHash: roomAssertions.hash,
      },
    ],
    admittedAssertions: [regionAssertions, roomAssertions],
    regions: [
      {
        regionId: "MainRegion",
        semanticEntityId: "RegionEntity",
        volume: {
          kind: "box",
          bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 } },
        },
        refinementPriority: 0,
      },
    ],
    placementSurfaces: [],
    terrainPlans: [],
    routes: [],
    routeJunctions: [],
    lotPolicies: [
      {
        policyId: "MainLots",
        regionId: "MainRegion",
        cellMeters: 8,
        minimumLotMeters: 8,
        maximumLotMeters: 8,
        routeMarginMeters: 0,
        maximumLots: 1,
      },
    ],
    structuralPrograms: [
      {
        programId: "MainStructure",
        regionId: "MainRegion",
        floorCount: 2,
        floorHeightMeters: 2,
        slots: [
          {
            slotId: "FloorSlot",
            floorIndex: 0,
            roleSchemeId: "brs_000001",
            roleId: "bro_000002",
            minimumCount: 1,
            maximumCount: 1,
          },
          {
            slotId: "WallSlot",
            floorIndex: 0,
            roleSchemeId: "brs_000001",
            roleId: "bro_000003",
            minimumCount: 1,
            maximumCount: 1,
          },
        ],
        placements: [
          {
            cell: { slotId: "FloorSlot", ordinal: 0 },
            lattice: { x: 3, y: 0, z: 2, yawQuarterTurns: 0 },
          },
          {
            cell: { slotId: "WallSlot", ordinal: 0 },
            lattice: { x: 2, y: 0, z: 2, yawQuarterTurns: 0 },
          },
        ],
        connections: [
          {
            connectionId: "WallToFloor",
            host: { slotId: "WallSlot", ordinal: 0, interfaceId: "join_plug" },
            child: { slotId: "FloorSlot", ordinal: 0, interfaceId: "join_socket" },
          },
        ],
        constructedSurfaces: [
          {
            surfaceId: "RoomFloor",
            kind: "constructed_floor",
            source: { slotId: "FloorSlot", ordinal: 0 },
            localNormal: { x: 0, y: 1, z: 0 },
          },
          {
            surfaceId: "RoomWall",
            kind: "constructed_wall",
            source: { slotId: "WallSlot", ordinal: 0 },
            localNormal: { x: 0, y: 0, z: -1 },
          },
        ],
        portals: [
          {
            portalId: "RoomDoor",
            source: { slotId: "WallSlot", ordinal: 0 },
            socketId: "door",
            widthMeters: 0.5,
            heightMeters: 1,
            clearanceMeters: 0.25,
            adjacentRoomIds: ["RoomA"],
          },
        ],
        rooms: [
          {
            roomId: "RoomA",
            floorIndex: 0,
            semanticEntityId: "RoomEntity",
            surfaceIds: ["RoomFloor", "RoomWall"],
            portalIds: ["RoomDoor"],
          },
        ],
        proceduralStairs: [
          {
            generatorId: "MainStair",
            fromFloor: 0,
            toFloor: 1,
            widthMeters: 1,
            treadDepthMeters: 0.2,
            maximumRiserHeightMeters: 0.2,
            originLattice: { x: 5, y: 0, z: 2, yawQuarterTurns: 0 },
          },
        ],
      },
    ],
    constructionPrograms: [],
    catalogRequirements: [requirement],
    realizationIntents: [
      {
        kind: "assembly",
        intentId: "BuildMainStructure",
        requirementId: requirement.requirementId,
        priority: 100,
        regionId: "MainRegion",
        lotPolicyId: "MainLots",
        programId: "MainStructure",
      },
    ],
    cameras: [],
  });
  const first = compileBasaltWorld({
    semanticModule: module,
    catalogSnapshot: snapshot,
    catalogAssets: [wallAsset, floorAsset],
    spatialPlan: plan,
  });
  const second = compileBasaltWorld({
    semanticModule: module,
    catalogSnapshot: snapshot,
    catalogAssets: [floorAsset, wallAsset],
    spatialPlan: plan,
  });
  assert.equal(first.worldBuildHash, second.worldBuildHash);
  assert.equal(first.status, "eligible");
  assert.equal(first.catalogResolution.bindings[0]?.memberId, undefined);
  assert.equal(first.catalogResolution.bindings[0]?.assetHash, undefined);
  assert.equal(first.meso.instances.length, 2);
  assert.equal(first.meso.assemblies[0]?.connections.length, 1);
  assert.equal(first.meso.constructedSurfaces.length, 2);
  assert.equal(first.meso.portals[0]?.opening.socketId, "door");
  assert.equal(first.meso.rooms[0]?.semanticDependencyClosureHash, roomClosure.hash);
  assert.equal(first.meso.rooms[0]?.floorIndex, 0);
  assert.equal(first.meso.proceduralStairs[0]?.stepBoundsMeters.length, 10);
  assert.deepEqual([...new Set(first.tasks.map((task) => task.scope))].sort(), [
    "floor",
    "lot",
    "region",
    "room",
    "structure",
    "world",
  ]);
  assert.equal(first.tasks.filter((task) => task.scope === "floor").length, 1);
  assert.equal(first.tasks.filter((task) => task.scope === "room").length, 1);
  const manifest = createRobloxImportManifest(first, [
    robloxBinding(wallAsset, 101),
    robloxBinding(floorAsset, 102),
  ]);
  const meso = manifest.transactions.find((entry) => entry.stage === "meso")!;
  assert.equal(meso.expectedArtifactHashes.length, 6);
  assert.equal(meso.expectedInstanceHashes.length, 2);
});

function componentAsset(
  name: string,
  sockets: CatalogAssetArtifact["sockets"],
): CatalogAssetArtifact {
  return sealCatalogAssetArtifact({
    source: {
      contentHash: contentHash(`structural-${name}-source`),
      rights: {
        licenseId: "fixture-license",
        commercialUsePermitted: true,
        redistributionPermitted: true,
        attribution: "Synthetic structural test fixture",
        evidenceHash: contentHash(`structural-${name}-rights`),
      },
      sourceArtifact: {
        artifactHash: contentHash(`structural-${name}-bytes`),
        bytes: 1024,
        mediaType: "model/gltf-binary",
      },
    },
    geometryHash: contentHash(`structural-${name}-geometry`),
    deformation: {
      mode: "static",
      measuredPose: "static",
      animationCount: 0,
      skinCount: 0,
    },
    coordinateFrame: {
      handedness: "right_handed",
      up: "+Y",
      forward: "-Z",
      unitsToMeters: q(1),
      canonicalRoot: transform(),
    },
    bounds: { min: vector(-0.5, 0, -0.5), max: vector(0.5, 1, 0.5) },
    parts: [
      {
        partId: name,
        geometryHash: contentHash(`structural-${name}-part`),
        role: "render_static",
        transform: transform(),
        bounds: { min: vector(-0.5, 0, -0.5), max: vector(0.5, 1, 0.5) },
        triangleCount: 12,
        materialHashes: [contentHash("structural-material")],
      },
    ],
    materials: [
      {
        appearanceHash: contentHash("structural-material"),
        payloadHashes: [],
        pbrChannels: ["base_color"],
      },
    ],
    support: {
      primaryContact: "bottom",
      contactAreaSquareMeters: q(1),
      measurementMethod: "planar_patch_fit",
      evidenceHash,
    },
    collision: {
      mode: "part_obbs",
      companionAssetHashes: [],
      orientedBounds: [
        { center: vector(0, 0.5, 0), halfSize: vector(0.5, 0.5, 0.5), rotation: [0, 0, 0, 1] },
      ],
      evidenceHash,
    },
    sockets,
    measurementEvidenceHashes: [evidenceHash],
  });
}

function socket(
  id: string,
  x: number,
  y: number,
  z: number,
  nx: number,
  ny: number,
  nz: number,
  radius: number,
) {
  return {
    socketId: id,
    localOriginMeters: vector(x, y, z),
    normal: vector(nx, ny, nz),
    up: vector(0, 1, 0),
    boundaryRadiusMeters: q(radius),
    evidenceHash: contentHash(`socket-${id}`),
  };
}

function semanticSignature(
  concept: { conceptId: string; commitmentHash: string },
  realizationForm: "component" | "assembly",
  dependencyClosureHash: string,
) {
  return {
    denotation: { conceptId: concept.conceptId, commitmentHash: concept.commitmentHash },
    realizationForm,
    fixedStates: [],
    affordances: [],
    surfaceTreatmentIds: [],
    dependencyClosureHash,
  };
}

function assetAssertions(
  assetId: string,
  concept: { conceptId: string; commitmentHash: string },
  realizationForm: "component",
) {
  return sealSemanticAssertionBundle({
    authority: "admitted",
    assertions: [
      {
        assertionKind: "denotation",
        subject: { kind: "catalog_asset", id: assetId },
        concept: { conceptId: concept.conceptId, commitmentHash: concept.commitmentHash },
        evidence: { level: "declared", evidenceHashes: [evidenceHash] },
      },
      {
        assertionKind: "realization_form",
        subject: { kind: "catalog_asset", id: assetId },
        realizationForm,
        evidence: { level: "measured", evidenceHashes: [evidenceHash] },
      },
    ],
  });
}

function plannedAssertions(
  entityId: string,
  concept: { conceptId: string; commitmentHash: string },
) {
  return sealSemanticAssertionBundle({
    authority: "admitted",
    assertions: [
      {
        assertionKind: "denotation",
        subject: { kind: "planned_entity", id: entityId },
        concept: { conceptId: concept.conceptId, commitmentHash: concept.commitmentHash },
        evidence: { level: "declared", evidenceHashes: [evidenceHash] },
      },
    ],
  });
}

function robloxBinding(asset: CatalogAssetArtifact, robloxAssetId: number) {
  return sealRobloxAssetBinding({
    assetHash: asset.hash,
    robloxAssetId,
    sourceArtifactHash: asset.source.sourceArtifact!.artifactHash,
    uploadArtifactHash: "d".repeat(64),
    publicationEvidenceHash: "c".repeat(64),
    materialExpectations: [
      {
        partPath: [{ name: "Renderable", siblingOrdinal: 0 }],
        className: "MeshPart",
        material: "Plastic",
        color: { red: 255, green: 255, blue: 255 },
        transparency: 0,
        reflectance: 0,
      },
    ],
  });
}

function q(value: number): string {
  return quantizeQ32_32(value);
}
function vector(x: number, y: number, z: number) {
  return { x: q(x), y: q(y), z: q(z) };
}
function transform() {
  return {
    position: vector(0, 0, 0),
    rotationQuaternion: [q(0), q(0), q(0), q(1)] as [string, string, string, string],
    uniformScale: q(1),
  };
}
