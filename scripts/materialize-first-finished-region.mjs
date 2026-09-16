import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
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
import {
  FIRST_FINISHED_REGION_OUTPUT_ROOT,
  FIRST_FINISHED_REGION_TOWER_ENTRY_ROUTE_ID,
  firstFinishedRegionFixture,
} from "../dist/test/helpers/first-finished-region-fixture.js";
import { loadSemanticRegistry } from "../dist/test/helpers/semantic-registry.js";
import { verifyRobloxUploadEvidence } from "./verify-roblox-upload-evidence.mjs";

const execFile = promisify(execFileCallback);
const repositoryRoot = resolve(".");
const outputRoot = FIRST_FINISHED_REGION_OUTPUT_ROOT;
const searchRoot = `${outputRoot}/search`;

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

const bindings = await loadVerifiedBindings();
const robloxImport = createRobloxImportManifest(first, bindings);
const requirementsBody = {
  kind: "FirstFinishedRegionRequirements",
  scope: "representative_region_core",
  authority: "delegated_ai_proposal",
  worldScaleClaim: "none",
  regionBrief: {
    setting:
      "A stylized low-poly wooded ridge where two approach routes rejoin at a climbable timber observation tower.",
    palette:
      "Matte olive grass, warm earth paths, weathered brown timber, and admitted natural props.",
    experience:
      "The tower silhouette should read from the trailhead while the ridge conceals its entrance; the grounded trail and elevated boardwalk provide distinct approaches before merging at the stairs.",
  },
  coreRequirements: [
    {
      requirementId: "reachable_observation_tower",
      realization: "procedural_construction",
      required: true,
      acceptance:
        "One 6.5 meter timber tower with a connected stair run and usable viewing platform.",
    },
    {
      requirementId: "grounded_ridge_trail",
      realization: "deterministic_route",
      required: true,
      acceptance: "A grounded winding approach from the trailhead to the tower merge.",
    },
    {
      requirementId: "elevated_scenic_alternative",
      realization: "deterministic_route",
      required: true,
      acceptance: "A supported boardwalk alternative sharing the split and merge junctions.",
    },
    {
      requirementId: "outdoor_population",
      realization: "admitted_catalog",
      required: true,
      acceptance: "Measured admitted trees, rocks, groundcover, and one fallen-log prop.",
    },
    {
      requirementId: "approach_reveal",
      realization: "authored_terrain_and_camera_intent",
      required: true,
      acceptance:
        "Creator inspection confirms the tower silhouette is visible before its entrance and route merge are revealed.",
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

const tower = first.meso.constructedStructures[0];
if (!tower) throw new Error("First-finished-region build lacks its observation tower");
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
    ...tower.elements.filter((entry) => !panelIds.has(entry.elementId)),
    ...first.instances,
  ].some((entry) => overlapsStrictly(opening.clearanceBoundsMeters, entry.boundsMeters));
});
const boardwalk = routeById.get("ScenicBoardwalk");
const boardwalkComplete = Boolean(
  boardwalk?.status === "eligible" &&
  boardwalk.treatmentKind === "elevated" &&
  boardwalk.supports.length >= 2 &&
  boardwalk.edgeRails.length > 0 &&
  boardwalk.edgePosts.length > 0 &&
  boardwalk.junctions.length === 2,
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
    requirementId: "outdoor_population",
    status:
      first.catalogResolution.gaps.length === 0 && first.instances.length > 0
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
    "Creator-run Studio inspection must verify both routes, tower traversal, approach reveal, materials, and exact connector readback.",
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
]);
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

async function loadVerifiedBindings() {
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
  }
  return bindings;
}

function instructions(status) {
  return (
    `# First finished region core\n\n` +
    `Offline core: **${status.offlineCoreStatus}**. Creator gate: **${status.creatorGateStatus}**. ` +
    `This is a 48 m representative region, not evidence of the complete 40 km² world.\n\n` +
    `The build contains one grounded ridge trail, one elevated boardwalk alternative, two shared junctions, ` +
    `a route-connected 6.5 m procedural observation tower, and ${status.realizedInstanceCount} real admitted catalog instances. ` +
    `Optional cabin, lantern, campfire, footbridge, and signpost accents remain explicit non-blocking gaps in ` +
    `\`remaining-gaps.json\`; none were silently admitted.\n\n` +
    `## One creator gate\n\n` +
    `1. Close Roblox Studio so it cannot retain an older in-memory connector.\n` +
    `2. Run \`npm run plugin:build\`, then reopen the target place in Studio.\n` +
    `3. Run \`node bin/basalt.js roblox import .basalt/evals/first-finished-region/world-build.json\`.\n` +
    `4. In Roblox Studio, open the Basalt plugin and choose **Import**. A prior failed staging world is removed by the connector's bounded retry path.\n` +
    `5. In one play session, walk the grounded trail and the elevated boardwalk from split to merge, climb the tower stairs, stand on the platform, and inspect catalog asset colors/materials. Confirm whether the tower silhouette is visible from the trailhead before its entrance is revealed.\n` +
    `6. Stop play and preserve \`.basalt/roblox/import-report.json\`. Report the traversal/reveal result once; no optional-prop review is required for this gate.\n\n` +
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
