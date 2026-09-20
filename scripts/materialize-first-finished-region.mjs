import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { readBoundedWorkspaceBytes, writeCanonicalWorkspaceJson } from "@basalt/artifact-store";
import { contentHash, stableJson } from "@basalt/contracts";
import {
  ROBLOX_ASSET_BINDING_SCHEMA,
  ROBLOX_ASSET_UPLOAD_LEDGER_SCHEMA,
  createRobloxImportManifest,
  sealRobloxAssetBinding,
} from "@basalt/roblox";
import { compileBasaltWorld } from "@basalt/world-compiler";
import { renderWorldDiagnostics } from "@basalt/world-refinement";
import {
  FIRST_FINISHED_REGION_OVERLOOK_ROUTE_ID,
  FIRST_FINISHED_REGION_OUTPUT_ROOT,
  FIRST_FINISHED_REGION_RAVINE_OVERLOOK_ROUTE_ID,
  FIRST_FINISHED_REGION_SIZE_METERS,
  FIRST_FINISHED_REGION_TOWER_ENTRY_ROUTE_ID,
  firstFinishedRegionFixture,
} from "../dist/test/helpers/first-finished-region-fixture.js";
import { loadSemanticRegistry } from "../dist/test/helpers/semantic-registry.js";
import { verifyRobloxBindingCoverage } from "./verify-roblox-binding-coverage.mjs";
import { verifyRobloxUploadEvidence } from "./verify-roblox-upload-evidence.mjs";

const execFile = promisify(execFileCallback);
const repositoryRoot = resolve(".");
const outputRoot = FIRST_FINISHED_REGION_OUTPUT_ROOT;
const searchRoot = `${outputRoot}/search`;
const diagnosticRenderExecutionPolicy = {
  policyId: "FirstFinishedRegionDiagnosticRender",
  origin: "Creator-selected local first-finished-region materialization allocation",
  maximumPixelsPerCamera: 262_144,
  maximumTerrainTrianglesPerField: 16_384,
};

const searchRequests = [
  {
    searchId: "region-cabin",
    text: "cabin house shack hut",
    selectedSourceContentHash: "dd52850dbbc00c32b64692c918fd6f6025df37dc805a0a55c28d0de0d66c399a",
  },
  {
    searchId: "region-lantern",
    text: "outdoor hanging lantern",
    selectedSourceContentHash: "948567d0615306c7ed310798e9e013c6416d26fa5cf622fd43fde9d5135aba17",
  },
  {
    searchId: "region-campfire",
    text: "campfire fire pit",
    selectedSourceContentHash: "b00f6690b2ba21dc5c850feab073fc76d54f89078cd93ac597cc22d96c28dd6d",
  },
  {
    searchId: "region-footbridge",
    text: "wooden bridge footbridge",
    selectedSourceContentHash: "05206c0e079973ab7d3846ff41f87c13093acf9d2f86b5757e8ab0cde10df4d9",
  },
  { searchId: "region-signpost", text: "sign post trail marker" },
  { searchId: "region-tower", text: "observation tower lookout tower" },
];

const semanticModule = await loadSemanticRegistry();
const fixture = await firstFinishedRegionFixture(semanticModule);
const first = compileBasaltWorld(fixture.compileInput);
const second = compileBasaltWorld(fixture.compileInput);
if (first.worldBuildHash !== second.worldBuildHash)
  throw new Error("First-finished-region compilation is not deterministic");
if (first.status !== "eligible")
  throw new Error(
    `First-finished-region core compiled as ${first.status}: ${[
      ...first.foundation.diagnostics,
      ...first.meso.diagnostics,
      ...first.micro.diagnostics,
    ].join("; ")}`,
  );

await Promise.all(searchRequests.map(materializeSearch));
const searchEvidence = await Promise.all(searchRequests.map(readSearchEvidence));
const searchById = new Map(searchEvidence.map((entry) => [entry.searchId, entry]));
const admittedSources = new Set(
  fixture.catalogCommit.dispositions
    .filter((entry) => entry.status === "eligible")
    .map((entry) => entry.sourceContentHash),
);
for (const evidence of searchEvidence)
  if (
    evidence.selectedCandidate &&
    admittedSources.has(evidence.selectedCandidate.sourceContentHash)
  )
    throw new Error(
      `Optional candidate unexpectedly entered the admitted catalog: ${evidence.selectedCandidate.sourceContentHash}`,
    );

const bindingInventory = await loadVerifiedBindingInventory();
const robloxImport = createRobloxImportManifest(first, bindingInventory.bindings);
const bindingReview = createBindingReviewArtifacts(first, fixture, robloxImport, bindingInventory);
const diagnosticCameras = [
  {
    cameraId: "ExpandedRegionOverview",
    purpose: "overview",
    positionMeters: { x: 48, y: 82, z: 116 },
    lookAtMeters: { x: 48, y: 9, z: 52 },
    up: { x: 0, y: 1, z: 0 },
    verticalFieldOfViewDegrees: 58,
    widthPixels: 160,
    heightPixels: 90,
  },
  {
    cameraId: "ExpandedRegionTrailhead",
    purpose: "approach",
    positionMeters: { x: 8, y: 4, z: -8 },
    lookAtMeters: { x: 52, y: 13, z: 62 },
    up: { x: 0, y: 1, z: 0 },
    verticalFieldOfViewDegrees: 58,
    widthPixels: 160,
    heightPixels: 90,
  },
  {
    cameraId: "ExpandedRegionRavine",
    purpose: "overview",
    positionMeters: { x: 12, y: 24, z: 18 },
    lookAtMeters: { x: 42, y: 4, z: 41 },
    up: { x: 0, y: 1, z: 0 },
    verticalFieldOfViewDegrees: 60,
    widthPixels: 160,
    heightPixels: 90,
  },
  {
    cameraId: "ExpandedRegionSummits",
    purpose: "platform",
    positionMeters: { x: 49, y: 42, z: 108 },
    lookAtMeters: { x: 51, y: 17, z: 75 },
    up: { x: 0, y: 1, z: 0 },
    verticalFieldOfViewDegrees: 55,
    widthPixels: 160,
    heightPixels: 90,
  },
];
const diagnostics = await loadOrRenderDiagnostics(first, diagnosticCameras);
const diagnosticBody = {
  kind: "FirstFinishedRegionDiagnosticSet",
  worldBuildHash: first.worldBuildHash,
  renders: diagnostics.renders,
};
const diagnosticSet = {
  ...diagnosticBody,
  hash: contentHash(stableJson(diagnosticBody)),
};
const requirementsBody = {
  kind: "FirstFinishedRegionRequirements",
  scope: "representative_region_core",
  authority: "delegated_ai_proposal",
  worldScaleClaim: "none",
  regionBrief: {
    setting:
      "A stylized low-poly highland preserve rising from a sheltered trailhead through a deep ravine to layered wooded summits.",
    palette:
      "Matte olive grass, warm earth paths, dark weathered timber, muted slate roofs, and admitted natural props.",
    experience:
      "A gateway begins one directional ascent: a lower ravine boardwalk reaches a switchback ridge trail, a high skywalk crosses the summit saddle, and short branches terminate at a roofed tower, pavilion, and ravine overlook.",
  },
  coreRequirements: [
    {
      requirementId: "reachable_observation_tower",
      realization: "procedural_construction",
      required: true,
      acceptance:
        "One 13.5 meter timber lookout with a connected open stair run, usable viewing platform, structural bracing, guard rails, and slate canopy.",
    },
    {
      requirementId: "grounded_ridge_trail",
      realization: "deterministic_route",
      required: true,
      acceptance:
        "A grounded switchback ascent connects the upper ravine landing to the summit split.",
    },
    {
      requirementId: "elevated_scenic_alternative",
      realization: "deterministic_route",
      required: true,
      acceptance:
        "A supported and guarded boardwalk connects the lower and upper landings across the carved ravine.",
    },
    {
      requirementId: "layered_vertical_composition",
      realization: "authored_terrain",
      required: true,
      acceptance:
        "A 96 meter region with at least 21 meters of terrain relief, a readable transverse ravine, intermediate switchback terraces, and two distinct high plateaus.",
    },
    {
      requirementId: "summit_skywalk",
      realization: "deterministic_route",
      required: true,
      acceptance:
        "A second supported and guarded elevated span crosses the high saddle between the tower plateau and pavilion plateau.",
    },
    {
      requirementId: "ridge_pavilion_destination",
      realization: "procedural_construction",
      required: true,
      acceptance:
        "A route-connected roofed pavilion with a deck, seating, rails, and a dedicated summit approach.",
    },
    {
      requirementId: "ravine_overlook_destination",
      realization: "procedural_construction",
      required: true,
      acceptance:
        "A route-connected cantilevered overlook has deep supports, a guarded deck, seating, and a slate canopy above the ravine edge.",
    },
    {
      requirementId: "trailhead_gateway",
      realization: "procedural_construction",
      required: true,
      acceptance: "A timber gateway frames the beginning of the route network without blocking it.",
    },
    {
      requirementId: "outdoor_population",
      realization: "admitted_catalog",
      required: true,
      acceptance:
        "At least 220 measured admitted instances use at least ten distinct admitted asset entries, including canopy trees, tall pines, understory trees, monument trees, bushes, boulders, rounded rocks, low rocks, two groundcover scales, and eight fallen logs.",
    },
    {
      requirementId: "approach_reveal",
      realization: "authored_terrain_and_camera_intent",
      required: true,
      acceptance:
        "Creator inspection confirms the tower and pavilion read as distinct highland destinations and the route hierarchy is legible from the gateway.",
    },
  ],
  optionalRequirements: [
    "rustic_cabin_or_distant_settlement",
    "ground_or_hanging_lantern",
    "campfire",
    "small_wooden_footbridge",
    "complete_trail_signpost",
  ],
};
const requirements = {
  ...requirementsBody,
  hash: contentHash(stableJson(requirementsBody)),
};

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
if (!tower) throw new Error("First-finished-region build lacks its observation tower");
if (!pavilion) throw new Error("First-finished-region build lacks its ridge pavilion");
if (!gateway) throw new Error("First-finished-region build lacks its trailhead gateway");
if (!ravineOverlook) throw new Error("First-finished-region build lacks its ravine overlook");
const routeById = new Map(
  first.foundation.routeConstructions.map((entry) => [entry.routeId, entry]),
);
const optionalGaps = [
  pendingCandidate(
    "rustic_cabin_or_distant_settlement",
    searchById.get("region-cabin"),
    "A visually plausible cabin candidate exists, but it has not been described, reviewed, admitted, bound, or checked in context.",
  ),
  pendingCandidate(
    "ground_or_hanging_lantern",
    searchById.get("region-lantern"),
    "A visually plausible ground-lantern candidate exists, but its identity and intended use remain unreviewed.",
  ),
  pendingCandidate(
    "campfire",
    searchById.get("region-campfire"),
    "A visually plausible campfire candidate exists, but it remains outside catalog authority.",
  ),
  pendingCandidate(
    "small_wooden_footbridge",
    searchById.get("region-footbridge"),
    "A creator-reviewed footbridge caption exists in authored metadata, but the asset is not admitted for construction use; the deterministic boardwalk satisfies the core traversal requirement.",
  ),
  {
    requirementId: "complete_trail_signpost",
    status: "no_selected_candidate",
    blocking: false,
    rationale:
      "The retrieved post, frame, and rail pieces do not establish a complete readable trail sign; preserve this as a gap instead of pretending a component is the requested object.",
    searchEvidence: searchReference(searchById.get("region-signpost")),
  },
  {
    requirementId: "catalog_observation_tower",
    status: "procedural_core_selected",
    blocking: false,
    rationale:
      "Retrieved tower-shaped meshes lack evidence for the required route connection, stairs, platform access, and dimensions. The sealed procedural tower is the authoritative core realization.",
    searchEvidence: searchReference(searchById.get("region-tower")),
  },
];
const gapBody = {
  kind: "FirstFinishedRegionGapReport",
  authority: "delegated_ai_hypothesis",
  catalogCommitHash: fixture.catalogCommit.hash,
  searchIndexHash: searchEvidence[0]?.indexHash,
  coreGapCount: first.catalogResolution.gaps.length,
  optionalGaps,
};
const gapReport = { ...gapBody, hash: contentHash(stableJson(gapBody)) };

const towerAccess = tower.accessPaths.find(
  (entry) => entry.entryRouteId === FIRST_FINISHED_REGION_TOWER_ENTRY_ROUTE_ID,
);
const towerApproach = routeById.get(FIRST_FINISHED_REGION_TOWER_ENTRY_ROUTE_ID);
const towerApproachFinish = towerApproach?.profile.at(-1)?.centerTopMeters;
const towerOperationIds = new Set(tower.elements.map((entry) => entry.operationId));
const towerPresentationComplete = [
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
].every((operationId) => towerOperationIds.has(operationId));
const towerRouteConnected = Boolean(
  towerAccess &&
  towerApproachFinish &&
  Math.hypot(
    towerApproachFinish.x - towerAccess.entryMeters.x,
    towerApproachFinish.z - towerAccess.entryMeters.z,
  ) <= 1e-9 &&
  Math.abs(towerApproachFinish.y - towerAccess.entryMeters.y) <= 0.1,
);
const towerOpeningsClear = tower.openings.every((opening) => {
  const panelIds = new Set(opening.panelElementIds);
  return ![
    ...first.meso.constructedStructures
      .flatMap((entry) => entry.elements)
      .filter((entry) => !panelIds.has(entry.elementId)),
    ...first.instances,
  ].some((entry) => overlapsStrictly(opening.clearanceBoundsMeters, entry.boundsMeters));
});
const pavilionRouteConnected = structureRouteConnected(
  pavilion,
  routeById.get(FIRST_FINISHED_REGION_OVERLOOK_ROUTE_ID),
  FIRST_FINISHED_REGION_OVERLOOK_ROUTE_ID,
);
const pavilionOperationIds = new Set(pavilion.elements.map((entry) => entry.operationId));
const pavilionComplete =
  pavilionRouteConnected &&
  [
    "PavilionDeck",
    "PavilionEntrySteps",
    "PavilionRoof",
    "PavilionBenchSeat",
    "PavilionBenchBack",
  ].every((operationId) => pavilionOperationIds.has(operationId));
const ravineOverlookOperationIds = new Set(
  ravineOverlook.elements.map((entry) => entry.operationId),
);
const ravineOverlookComplete =
  structureRouteConnected(
    ravineOverlook,
    routeById.get(FIRST_FINISHED_REGION_RAVINE_OVERLOOK_ROUTE_ID),
    FIRST_FINISHED_REGION_RAVINE_OVERLOOK_ROUTE_ID,
  ) &&
  [
    "OverlookDeck",
    "OverlookEntrySteps",
    "OverlookViewRail",
    "OverlookCanopyRoof",
    "OverlookBenchSeat",
  ].every((operationId) => ravineOverlookOperationIds.has(operationId));
const gatewayOperationIds = new Set(gateway.elements.map((entry) => entry.operationId));
const gatewayComplete = [
  "GatewayPost_West",
  "GatewayPost_East",
  "GatewayLintel",
  "GatewaySign",
].every((operationId) => gatewayOperationIds.has(operationId));
const terrainElevations = first.foundation.baseTerrainFields.flatMap((entry) =>
  entry.samples.map((sample) => sample.elevationMeters),
);
const terrainReliefMeters = Math.max(...terrainElevations) - Math.min(...terrainElevations);
const boardwalk = routeById.get("ScenicBoardwalk");
const boardwalkComplete = Boolean(
  boardwalk?.status === "eligible" &&
  boardwalk.treatmentKind === "elevated" &&
  boardwalk.supports.length >= 2 &&
  boardwalk.edgeRails.length > 0 &&
  boardwalk.edgePosts.length > 0 &&
  boardwalk.junctions.length === 2,
);
const skywalk = routeById.get("SummitSkywalk");
const skywalkComplete = Boolean(
  skywalk?.status === "eligible" &&
  skywalk.treatmentKind === "elevated" &&
  skywalk.supports.length >= 2 &&
  skywalk.edgeRails.length > 0 &&
  skywalk.edgePosts.length > 0 &&
  skywalk.junctions.length === 2,
);
const junctionsComplete = first.foundation.routeJunctions.every(
  (junction) =>
    junction.appearance.materialId === "WoodPlanks" &&
    junction.terrainTreatment.kind === "grade" &&
    junction.terrainTreatment.terrainMaterialId === "Ground" &&
    junction.participants.every((participant) => {
      const route = routeById.get(participant.routeId);
      if (!route || junction.radiusMeters + 1e-9 < route.widthMeters / 2) return false;
      const endpoint = participant.endpoint === "start" ? route.profile[0] : route.profile.at(-1);
      return (
        endpoint && stableJson(endpoint.centerTopMeters) === stableJson(junction.centerTopMeters)
      );
    }),
);

const coreChecks = [
  {
    requirementId: "reachable_observation_tower",
    status:
      towerRouteConnected && towerPresentationComplete && towerOpeningsClear
        ? "eligible"
        : "incomplete",
    evidenceHashes: [tower.hash, tower.constructionProgramHash],
  },
  {
    requirementId: "grounded_ridge_trail",
    status:
      routeById.get("RidgeTrail")?.status === "eligible" && junctionsComplete
        ? "eligible"
        : "incomplete",
    evidenceHashes: routeById.get("RidgeTrail") ? [routeById.get("RidgeTrail").hash] : [],
  },
  {
    requirementId: "elevated_scenic_alternative",
    status: boardwalkComplete && junctionsComplete ? "eligible" : "incomplete",
    evidenceHashes: routeById.get("ScenicBoardwalk") ? [routeById.get("ScenicBoardwalk").hash] : [],
  },
  {
    requirementId: "summit_skywalk",
    status: skywalkComplete && junctionsComplete ? "eligible" : "incomplete",
    evidenceHashes: skywalk ? [skywalk.hash] : [],
  },
  {
    requirementId: "layered_vertical_composition",
    status:
      first.foundation.boundsMeters.max.x === FIRST_FINISHED_REGION_SIZE_METERS &&
      first.foundation.boundsMeters.max.z === FIRST_FINISHED_REGION_SIZE_METERS &&
      terrainReliefMeters >= 21
        ? "eligible"
        : "incomplete",
    evidenceHashes: first.foundation.baseTerrainFields.map((entry) => entry.hash),
  },
  {
    requirementId: "ridge_pavilion_destination",
    status: pavilionComplete ? "eligible" : "incomplete",
    evidenceHashes: [pavilion.hash, pavilion.constructionProgramHash],
  },
  {
    requirementId: "ravine_overlook_destination",
    status: ravineOverlookComplete ? "eligible" : "incomplete",
    evidenceHashes: [ravineOverlook.hash, ravineOverlook.constructionProgramHash],
  },
  {
    requirementId: "trailhead_gateway",
    status: gatewayComplete ? "eligible" : "incomplete",
    evidenceHashes: [gateway.hash, gateway.constructionProgramHash],
  },
  {
    requirementId: "outdoor_population",
    status:
      first.catalogResolution.gaps.length === 0 &&
      first.instances.length >= 220 &&
      new Set(first.instances.map((entry) => entry.entryHandle)).size >= 10 &&
      [
        "PlaceWestLog",
        "PlacePavilionLog",
        "PlaceLowerLog",
        "PlaceEastLog",
        "PlaceTowerLog",
        "PlaceRavineLog",
        "PlaceMeadowLog",
        "PlaceOverlookLog",
      ].every((intentId) => first.instances.some((instance) => instance.intentId === intentId))
        ? "eligible"
        : "incomplete",
    evidenceHashes: [first.catalogResolution.hash, ...first.instances.map((entry) => entry.hash)],
  },
  {
    requirementId: "approach_reveal",
    status: "pending_creator_inspection",
    evidenceHashes: [fixture.plan.planHash],
  },
];
const offlineCoreEligible = coreChecks
  .filter((entry) => entry.requirementId !== "approach_reveal")
  .every((entry) => entry.status === "eligible");
const statusBody = {
  kind: "FirstFinishedRegionStatus",
  status: "incomplete",
  offlineCoreStatus:
    offlineCoreEligible && robloxImport.loweringGaps.length === 0 ? "eligible" : "incomplete",
  creatorGateStatus: "pending",
  requirementsHash: requirements.hash,
  gapReportHash: gapReport.hash,
  catalogCommitHash: fixture.catalogCommit.hash,
  planHash: fixture.plan.planHash,
  worldBuildHash: first.worldBuildHash,
  robloxImportHash: robloxImport.hash,
  realizedInstanceCount: first.instances.length,
  routeCount: first.foundation.routeConstructions.length,
  junctionCount: first.foundation.routeJunctions.length,
  constructedStructureCount: first.meso.constructedStructures.length,
  catalogGapCount: first.catalogResolution.gaps.length,
  robloxLoweringGapCount: robloxImport.loweringGaps.length,
  coreChecks,
  blockers: [
    ...(robloxImport.loweringGaps.length > 0
      ? ["One or more catalog assets lack verified Roblox bindings"]
      : []),
    "Creator-run Studio inspection must verify the complete route network, tower and pavilion traversal, gateway framing, destination hierarchy, sealed visual environment, materials, and exact connector readback.",
  ],
};
const status = { ...statusBody, hash: contentHash(stableJson(statusBody)) };

await Promise.all([
  writeGeneratedJson(`${outputRoot}/requirements.json`, requirements),
  writeGeneratedJson(`${outputRoot}/spatial-plan.json`, fixture.plan),
  writeGeneratedJson(`${outputRoot}/world-build.json`, first),
  writeGeneratedJson(`${outputRoot}/roblox-import.json`, robloxImport),
  writeGeneratedJson(`${outputRoot}/remaining-gaps.json`, gapReport),
  writeGeneratedJson(`${outputRoot}/status.json`, status),
  writeGeneratedJson(`${outputRoot}/diagnostics.json`, diagnosticSet),
  writeGeneratedJson(`${outputRoot}/roblox-binding-upload-packet.json`, bindingReview.packet),
  writeGeneratedJson(
    `${outputRoot}/roblox-binding-decision-template.json`,
    bindingReview.decisionTemplate,
  ),
]);
await mkdir(resolve(repositoryRoot, `${outputRoot}/diagnostics`), { recursive: true });
await Promise.all(
  diagnostics.renders.map((render) =>
    writeFile(
      resolve(repositoryRoot, `${outputRoot}/diagnostics/${render.camera.cameraId}.ppm`),
      diagnostics.payloads.get(render.payload.contentHash),
    ),
  ),
);
await writeFile(resolve(repositoryRoot, `${outputRoot}/README.md`), instructions(status), "utf8");

process.stdout.write(
  `${JSON.stringify(
    {
      status: status.status,
      offlineCoreStatus: status.offlineCoreStatus,
      creatorGateStatus: status.creatorGateStatus,
      worldBuildHash: first.worldBuildHash,
      instances: first.instances.length,
      routes: first.foundation.routeConstructions.map((entry) => ({
        routeId: entry.routeId,
        treatment: entry.treatmentKind,
        status: entry.status,
      })),
      optionalGaps: optionalGaps.length,
      robloxLoweringGaps: robloxImport.loweringGaps.length,
      diagnosticRenders: diagnostics.renders.length,
      outputRoot,
    },
    null,
    2,
  )}\n`,
);

function overlapsStrictly(left, right) {
  return (
    left.min.x < right.max.x &&
    left.max.x > right.min.x &&
    left.min.y < right.max.y &&
    left.max.y > right.min.y &&
    left.min.z < right.max.z &&
    left.max.z > right.min.z
  );
}

function structureRouteConnected(structure, route, routeId) {
  const access = structure.accessPaths.find((entry) => entry.entryRouteId === routeId);
  const routeFinish = route?.profile.at(-1)?.centerTopMeters;
  return Boolean(
    access &&
    routeFinish &&
    Math.hypot(routeFinish.x - access.entryMeters.x, routeFinish.z - access.entryMeters.z) <=
      1e-9 &&
    Math.abs(routeFinish.y - access.entryMeters.y) <= 0.1,
  );
}

async function materializeSearch(request) {
  await execFile(
    process.execPath,
    [
      "bin/basalt.js",
      "catalog",
      "search",
      request.text,
      "--mode",
      "basename_only",
      "--limit",
      "20",
      "--validate",
      "0",
      "--output",
      `${searchRoot}/${request.searchId}.json`,
    ],
    { cwd: repositoryRoot, maxBuffer: 16 * 1024 * 1024 },
  );
}

async function readSearchEvidence(request) {
  const relativePath = `${searchRoot}/${request.searchId}.json`;
  const artifact = await readJson(relativePath);
  if (artifact.resultSet?.query?.text !== request.text)
    throw new Error(`Search artifact text drifted for ${request.searchId}`);
  const selectedCandidate = request.selectedSourceContentHash
    ? artifact.resultSet.results.find(
        (entry) => entry.sourceContentHash === request.selectedSourceContentHash,
      )
    : undefined;
  if (request.selectedSourceContentHash && !selectedCandidate)
    throw new Error(
      `Selected region candidate is absent from ${request.searchId}: ${request.selectedSourceContentHash}`,
    );
  return {
    searchId: request.searchId,
    relativePath,
    artifactHash: contentHash(stableJson(artifact)),
    indexHash: artifact.resultSet.indexHash,
    queryHash: artifact.resultSet.query.hash,
    resultSetHash: artifact.resultSet.hash,
    selectedCandidate,
    leadingSourceContentHashes: artifact.resultSet.results
      .slice(0, 5)
      .map((entry) => entry.sourceContentHash),
  };
}

function pendingCandidate(requirementId, evidence, rationale) {
  if (!evidence?.selectedCandidate)
    throw new Error(`Pending region candidate lacks search evidence: ${requirementId}`);
  return {
    requirementId,
    status: "candidate_pending_review_and_admission",
    blocking: false,
    rationale,
    candidate: {
      sourceContentHash: evidence.selectedCandidate.sourceContentHash,
      measurementHash: evidence.selectedCandidate.measurementHash,
      renderEvidenceHash: evidence.selectedCandidate.renderEvidenceHash,
    },
    searchEvidence: searchReference(evidence),
  };
}

function searchReference(evidence) {
  if (!evidence) throw new Error("First-finished-region search evidence is missing");
  return {
    relativePath: evidence.relativePath,
    artifactHash: evidence.artifactHash,
    indexHash: evidence.indexHash,
    queryHash: evidence.queryHash,
    resultSetHash: evidence.resultSetHash,
    leadingSourceContentHashes: evidence.leadingSourceContentHashes,
  };
}

async function loadVerifiedBindingInventory() {
  const bindings = ROBLOX_ASSET_BINDING_SCHEMA.array().parse(
    await readJson(".basalt/roblox/asset-bindings.json"),
  );
  const uploads = ROBLOX_ASSET_UPLOAD_LEDGER_SCHEMA.parse(
    await readJson(".basalt/roblox/asset-uploads.json"),
  );
  await verifyRobloxUploadEvidence(repositoryRoot, uploads);
  const uploadBySource = new Map(uploads.uploads.map((entry) => [entry.sourceArtifactHash, entry]));
  for (const binding of bindings) {
    const resealed = sealRobloxAssetBinding({
      assetHash: binding.assetHash,
      robloxAssetId: binding.robloxAssetId,
      sourceArtifactHash: binding.sourceArtifactHash,
      uploadArtifactHash: binding.uploadArtifactHash,
      publicationEvidenceHash: binding.publicationEvidenceHash,
      materialExpectations: binding.materialExpectations,
    });
    if (resealed.bindingHash !== binding.bindingHash)
      throw new Error(`Roblox binding is not exactly sealed: ${binding.assetHash}`);
    const upload = uploadBySource.get(binding.sourceArtifactHash);
    if (
      upload?.status !== "eligible" ||
      upload.robloxAssetId !== binding.robloxAssetId ||
      upload.uploadArtifact.artifactHash !== binding.uploadArtifactHash ||
      upload.uploadHash !== binding.publicationEvidenceHash
    )
      throw new Error(`Roblox binding lacks exact upload evidence: ${binding.assetHash}`);
    await verifyRobloxBindingCoverage(repositoryRoot, binding, upload);
  }
  return { bindings, uploads };
}

function createBindingReviewArtifacts(world, fixture, robloxImport, inventory) {
  const missingAssetHashes = [
    ...new Set(
      robloxImport.loweringGaps
        .filter((gap) => gap.kind === "asset_binding")
        .map((gap) => gap.subjectHash),
    ),
  ].sort();
  const measurementByHash = new Map(
    fixture.measurements.assets.map((asset) => [asset.hash, asset]),
  );
  const entryHandleByAsset = new Map(
    fixture.catalogCommit.snapshot.entries.flatMap((entry) =>
      entry.memberAssets.map((member) => [member.assetHash, entry.handle]),
    ),
  );
  const uploadBySource = new Map(
    inventory.uploads.uploads.map((entry) => [entry.sourceArtifactHash, entry]),
  );
  const missingBindings = missingAssetHashes.map((assetHash) => {
    const asset = measurementByHash.get(assetHash);
    if (!asset)
      throw new Error(`First-finished-region binding gap references unknown asset ${assetHash}`);
    const upload = uploadBySource.get(asset.source.sourceArtifact.artifactHash);
    return {
      assetHash,
      sourceContentHash: asset.source.contentHash,
      sourceRelativePath: upload?.sourceRelativePath ?? null,
      sourceArtifactHash: asset.source.sourceArtifact.artifactHash,
      proposedEntryHandle: entryHandleByAsset.get(assetHash) ?? null,
      sourceMaterials: asset.materials,
      sourceParts: asset.parts.map((part) => ({
        partId: part.partId,
        materialHashes: part.materialHashes,
      })),
      uploadStatus: upload?.status ?? "missing",
      robloxDisplayName: upload?.status === "eligible" ? upload.displayName : null,
      robloxAssetId: upload?.status === "eligible" ? upload.robloxAssetId : null,
      uploadArtifactHash: upload?.status === "eligible" ? upload.uploadArtifact.artifactHash : null,
      publicationEvidenceHash: upload?.status === "eligible" ? upload.uploadHash : null,
      materialExpectations: null,
    };
  });
  const packetBody = {
    kind: "CatalogFirstUseRobloxUploadPacket",
    status: missingBindings.every((item) => item.uploadStatus === "eligible")
      ? "eligible"
      : "incomplete",
    catalogCommitHash: fixture.catalogCommit.hash,
    worldBuildHash: world.worldBuildHash,
    bindingInventory: {
      relativePath: ".basalt/roblox/asset-bindings.json",
      status: "present",
      bindingCount: inventory.bindings.length,
    },
    publicationInventory: {
      relativePath: ".basalt/roblox/asset-uploads.json",
      status: "present",
      uploadCount: inventory.uploads.uploads.length,
      eligibleCount: inventory.uploads.uploads.filter((entry) => entry.status === "eligible")
        .length,
    },
    missingBindings,
    admittedAssets: [],
    instructions:
      missingBindings.length === 0
        ? []
        : [
            "Inspect every listed published model in a creator-owned Studio place and record exact material-bearing instance paths and appearance properties.",
            `Seal the completed decision with npm run eval:catalog-first-use:seal-bindings -- --packet ${outputRoot}/roblox-binding-upload-packet.json --decision ${outputRoot}/roblox-binding-decision.json.`,
            "Re-run npm run eval:first-finished-region and require zero asset_binding lowering gaps.",
          ],
  };
  const packet = { ...packetBody, hash: contentHash(stableJson(packetBody)) };
  return {
    packet,
    decisionTemplate: {
      kind: "CatalogFirstUseRobloxBindingDecision",
      uploadPacketHash: packet.hash,
      recordedBy: null,
      reviewerStatement: null,
      recordedAt: null,
      bindings: missingBindings.map((item) => ({
        assetHash: item.assetHash,
        sourceArtifactHash: item.sourceArtifactHash,
        uploadArtifactHash: item.uploadArtifactHash,
        publicationEvidenceHash: item.publicationEvidenceHash,
        robloxAssetId: item.robloxAssetId,
        materialExpectations: null,
      })),
    },
  };
}

async function loadOrRenderDiagnostics(world, cameras) {
  try {
    const cached = await readJson(`${outputRoot}/diagnostics.json`);
    const body = { ...cached };
    delete body.hash;
    if (
      cached.hash !== contentHash(stableJson(body)) ||
      cached.worldBuildHash !== world.worldBuildHash ||
      stableJson(cached.renders.map((entry) => entry.camera)) !== stableJson(cameras)
    )
      throw new Error("cached diagnostics do not bind this world and camera set");
    const payloads = new Map();
    for (const render of cached.renders) {
      const payload = await readFile(
        resolve(repositoryRoot, `${outputRoot}/diagnostics/${render.camera.cameraId}.ppm`),
      );
      const payloadHash = createHash("sha256").update(payload).digest("hex");
      if (payloadHash !== render.payload.contentHash)
        throw new Error(`cached diagnostic payload drifted: ${render.camera.cameraId}`);
      payloads.set(payloadHash, payload);
    }
    return { renders: cached.renders, payloads };
  } catch (error) {
    if (
      error?.code !== "ENOENT" &&
      !(error instanceof Error && error.message.startsWith("cached diagnostic"))
    )
      throw error;
    return renderWorldDiagnostics({
      worldBuild: world,
      cameras,
      executionPolicy: diagnosticRenderExecutionPolicy,
    });
  }
}

function instructions(status) {
  return (
    `# Expanded first finished region\n\n` +
    `Offline core: **${status.offlineCoreStatus}**. Creator gate: **${status.creatorGateStatus}**. ` +
    `This is a 96 m representative region, not evidence of the complete 40 km² world.\n\n` +
    `The build contains seven connected route segments, a lower ravine boardwalk, a high summit skywalk, four shared junctions, ` +
    `a route-connected 13.5 m roofed observation tower, ridge pavilion, cantilevered ravine overlook, trailhead gateway, and ${status.realizedInstanceCount} real admitted catalog instances across eleven visible asset types. ` +
    `Optional cabin, lantern, campfire, footbridge, and signpost accents remain explicit non-blocking gaps in ` +
    `\`remaining-gaps.json\`; none were silently admitted.\n\n` +
    `## One creator gate\n\n` +
    `1. Close Roblox Studio so it cannot retain an older in-memory connector.\n` +
    `2. Run \`npm run plugin:build\`, then reopen the target place in Studio.\n` +
    `3. Run \`node bin/basalt.js roblox import .basalt/evals/first-finished-region/world-build.json\`.\n` +
    `4. In Roblox Studio, open the Basalt plugin and choose **Import**. A prior failed staging world is removed by the connector's bounded retry path.\n` +
    `5. In one play session, pass through the gateway; cross the ravine boardwalk; climb the switchback ridge; visit the cantilevered ravine overlook; climb the open tower stairs; then cross the summit skywalk and follow SummitOverlook to the pavilion. Inspect route grounding, both elevated spans and their supports/rails, all three slate roofs, construction colors/materials, forest layering, ravine depth, large boulders, and all eight fallen logs. Confirm that the late-afternoon light has darker cool shadows, restrained warm highlights, richer color separation, and visible atmospheric depth without crushing asset detail; the tower, pavilion, and ravine overlook should remain distinct elevated destinations.\n` +
    `6. Stop play and preserve \`.basalt/roblox/import-report.json\`. Report the traversal and visual result once; no optional-prop review is required for this gate.\n\n` +
    `Offline compilation and lowering never create \`engine_verified\` authority.\n`
  );
}

async function readJson(path) {
  return JSON.parse(await readFile(resolve(repositoryRoot, path), "utf8"));
}

async function writeGeneratedJson(path, value) {
  let expectedExistingHash;
  try {
    const current = await readBoundedWorkspaceBytes(repositoryRoot, path);
    expectedExistingHash = createHash("sha256").update(current).digest("hex");
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("missing")) throw error;
  }
  return writeCanonicalWorkspaceJson(repositoryRoot, path, value, {
    maxBytes: 64 * 1024 * 1024,
    ...(expectedExistingHash ? { expectedExistingHash } : {}),
  });
}
