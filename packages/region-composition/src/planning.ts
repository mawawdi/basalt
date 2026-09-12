import { contentHash, stableJson } from "../../contracts/src/index.js";
import {
  DEFAULT_SPATIAL_ADMISSION_POLICY,
  assertBoundedSpatialJson,
  compareSpatialStrings,
} from "../../spatial-core/src/primitives.js";
import {
  compileWorldPlan,
  type CompiledWorldPlan,
  type SpatialWorldPlan,
} from "../../world-planning/src/index.js";
import { calibratePerspectiveCamera } from "./camera.js";
import {
  REGIONAL_PLAN_ABI,
  REGIONAL_PLAN_SCHEMA,
  REGIONAL_PLANNING_INVENTORY_ABI,
  REGIONAL_PLANNING_INVENTORY_SCHEMA,
  type RegionalPlacementAuthority,
  type RegionalPlan,
  type RegionalPlanningInventory,
} from "./contracts.js";

export interface RegionalRequirementState {
  readonly requirementId: string;
  readonly primaryRegionId: string;
  readonly state: "absent" | "prepared" | "placed";
  readonly placementConstraintHash: string;
  readonly placementAuthority: RegionalPlacementAuthority;
}

export interface RegionalSelectionPolicy {
  readonly maximumRegions: number;
  readonly includeOptionalRequirements: boolean;
}

/** Hash the already-built global substrate without depending on any asset executor. */
export function globalFoundationHash(compiled: CompiledWorldPlan): string {
  return contentHash(
    stableJson({
      worldPlanHash: compiled.worldPlanHash,
      surfaceIndexHash: compiled.surfaceIndexHash,
      terrainFields: compiled.terrainFields.map((field) => field.hash).sort(compareSpatialStrings),
      constructedSurfaces: compiled.plan.constructedSurfaces,
      routeProfiles: compiled.routeProfiles,
    }),
  );
}

/** Build the exact inventory that R+ selection may inspect. */
export function buildRegionalPlanningInventory(input: {
  readonly worldPlan: unknown;
  readonly requirementStates: readonly RegionalRequirementState[];
}): RegionalPlanningInventory {
  const compiled = compileWorldPlan(input.worldPlan);
  const stateByRequirement = new Map(
    input.requirementStates.map((entry) => [entry.requirementId, entry]),
  );
  if (stateByRequirement.size !== input.requirementStates.length)
    throw new Error("Regional requirement states must be unique");
  if (
    stateByRequirement.size !== compiled.plan.assetRequirements.length ||
    compiled.plan.assetRequirements.some((requirement) => !stateByRequirement.has(requirement.id))
  )
    throw new Error("Regional planning inventory must account for every world asset requirement");

  const declarationIds = new Set(
    compiled.plan.assetRequirements.map((requirement) => requirement.declarationId),
  );
  const anchorIds = new Set(compiled.plan.anchors.map((anchor) => anchor.id));
  const requirements = compiled.plan.assetRequirements.map((requirement) => {
    const state = stateByRequirement.get(requirement.id)!;
    if (!requirement.regionIds.includes(state.primaryRegionId))
      throw new Error(`Primary region is invalid for requirement ${requirement.id}`);
    validatePlacementAuthority(state.placementAuthority, compiled, anchorIds, declarationIds);
    return {
      requirementId: requirement.id,
      declarationId: requirement.declarationId,
      requirementHash: requirement.requirementHash,
      placementConstraintHash: state.placementConstraintHash,
      primaryRegionId: state.primaryRegionId,
      regionIds: [...requirement.regionIds].sort(compareSpatialStrings),
      required: requirement.required,
      state: state.state,
      placementAuthority: canonicalPlacementAuthority(state.placementAuthority),
    };
  });
  requirements.sort((left, right) =>
    compareSpatialStrings(left.requirementId, right.requirementId),
  );
  const material = {
    kind: "RegionalPlanningInventory" as const,
    abi: REGIONAL_PLANNING_INVENTORY_ABI,
    worldPlanHash: compiled.worldPlanHash,
    surfaceIndexHash: compiled.surfaceIndexHash,
    globalFoundationHash: globalFoundationHash(compiled),
    styleContractHash: compiled.plan.styleContractHash,
    requirements,
  };
  return sealInventory(material);
}

export function assertRegionalPlanningInventory(
  value: unknown,
  worldPlan?: unknown,
): asserts value is RegionalPlanningInventory {
  assertBoundedSpatialJson(value, DEFAULT_SPATIAL_ADMISSION_POLICY);
  const parsed = REGIONAL_PLANNING_INVENTORY_SCHEMA.parse(value);
  assertSealedIdentity(parsed, "regional_inventory");
  assertCanonicalUnique(
    parsed.requirements.map((entry) => entry.requirementId),
    "Requirement IDs",
  );
  for (const requirement of parsed.requirements) {
    assertCanonicalUnique(requirement.regionIds, "Requirement region IDs");
    if (!requirement.regionIds.includes(requirement.primaryRegionId))
      throw new Error(`Inventory primary region mismatch: ${requirement.requirementId}`);
    if (requirement.placementAuthority.kind === "surface")
      assertCanonicalUnique(requirement.placementAuthority.surfaceIds, "Placement surface IDs");
  }
  if (worldPlan !== undefined) {
    const compiled = compileWorldPlan(worldPlan);
    if (
      parsed.worldPlanHash !== compiled.worldPlanHash ||
      parsed.surfaceIndexHash !== compiled.surfaceIndexHash ||
      parsed.globalFoundationHash !== globalFoundationHash(compiled) ||
      parsed.styleContractHash !== compiled.plan.styleContractHash
    )
      throw new Error("Regional planning inventory does not bind the compiled world foundation");
    const expected = new Map(compiled.plan.assetRequirements.map((entry) => [entry.id, entry]));
    if (expected.size !== parsed.requirements.length)
      throw new Error("Regional planning inventory requirement coverage mismatch");
    for (const item of parsed.requirements) {
      const requirement = expected.get(item.requirementId);
      if (
        !requirement ||
        requirement.declarationId !== item.declarationId ||
        requirement.requirementHash !== item.requirementHash ||
        requirement.required !== item.required ||
        stableJson([...requirement.regionIds].sort(compareSpatialStrings)) !==
          stableJson(item.regionIds)
      )
        throw new Error(`Regional inventory requirement mismatch: ${item.requirementId}`);
      validatePlacementAuthority(
        item.placementAuthority,
        compiled,
        anchorIds(compiled),
        declarationIds(compiled),
      );
    }
  }
}

/**
 * Select R+ deterministically from unresolved requirements, substrate support,
 * region priority, and retained cameras. Asset route availability is irrelevant.
 */
export function selectRegionalPlan(input: {
  readonly worldPlan: unknown;
  readonly inventory: RegionalPlanningInventory;
  readonly policy: RegionalSelectionPolicy;
}): RegionalPlan {
  const compiled = compileWorldPlan(input.worldPlan);
  assertRegionalPlanningInventory(input.inventory, compiled.plan);
  if (
    !Number.isInteger(input.policy.maximumRegions) ||
    input.policy.maximumRegions < 1 ||
    input.policy.maximumRegions > 256
  )
    throw new Error("Regional selection limit must be an integer from 1 through 256");

  const active = input.inventory.requirements.filter(
    (entry) =>
      entry.state !== "placed" && (entry.required || input.policy.includeOptionalRequirements),
  );
  const cycles = dependencyCycleDeclarations(active);
  const unranked = compiled.plan.regions.map((region) => {
    const requirements = active.filter((entry) => entry.primaryRegionId === region.id);
    const blockers = new Set<RegionalPlan["decisions"][number]["blockedBy"][number]>();
    const surfaceIds = requirements.flatMap((entry) =>
      entry.placementAuthority.kind === "surface" ? entry.placementAuthority.surfaceIds : [],
    );
    for (const requirement of requirements) {
      if (
        requirement.placementAuthority.kind === "surface" &&
        !requirement.placementAuthority.surfaceIds.some((surfaceId) =>
          compiled.surfaces.regionIds(surfaceId).includes(requirement.primaryRegionId),
        )
      )
        blockers.add("surface_region_mismatch");
      if (cycles.has(requirement.declarationId)) blockers.add("dependency_cycle");
    }
    const camera = chooseRegionCamera(compiled.plan, region.id);
    if (requirements.length > 0 && !camera) blockers.add("missing_region_camera");
    const calibration = camera ? calibratePerspectiveCamera(camera) : undefined;
    return {
      region,
      requirements,
      blockers: [...blockers].sort(compareSpatialStrings),
      surfaceIds: [...new Set(surfaceIds)].sort(compareSpatialStrings),
      camera,
      calibration,
    };
  });
  const selectable = unranked
    .filter((entry) => entry.requirements.length > 0 && entry.blockers.length === 0)
    .sort(
      (left, right) =>
        right.region.refinementPriority - left.region.refinementPriority ||
        compareSpatialStrings(left.region.id, right.region.id),
    );
  const rankByRegion = new Map(
    selectable.slice(0, input.policy.maximumRegions).map((entry, rank) => [entry.region.id, rank]),
  );
  const decisions = unranked.map((entry) => {
    const rank = rankByRegion.get(entry.region.id);
    const disposition =
      entry.requirements.length === 0
        ? ("complete" as const)
        : entry.blockers.length > 0
          ? ("blocked" as const)
          : rank !== undefined
            ? ("selected" as const)
            : ("deferred" as const);
    const foundationMaterial = {
      globalFoundationHash: input.inventory.globalFoundationHash,
      region: entry.region,
      requirementIds: entry.requirements
        .map((requirement) => requirement.requirementId)
        .sort(compareSpatialStrings),
      placementConstraintHashes: entry.requirements
        .map((requirement) => requirement.placementConstraintHash)
        .filter((hash, index, hashes) => hashes.indexOf(hash) === index)
        .sort(compareSpatialStrings),
      surfaceIds: entry.surfaceIds,
      cameraCalibrationHash: entry.calibration?.hash,
    };
    return {
      regionId: entry.region.id,
      disposition,
      ...(rank === undefined ? {} : { rank }),
      refinementPriority: entry.region.refinementPriority,
      functionalRole: entry.region.purpose,
      requirementIds: foundationMaterial.requirementIds,
      placementConstraintHashes: foundationMaterial.placementConstraintHashes,
      placementSurfaceIds: entry.surfaceIds,
      appearanceContractHash: input.inventory.styleContractHash,
      regionFoundationHash: contentHash(stableJson(foundationMaterial)),
      ...(entry.camera
        ? { cameraId: entry.camera.id, cameraCalibrationHash: entry.calibration!.hash }
        : {}),
      blockedBy: entry.blockers,
      assetExecutorRequired: false as const,
    };
  });
  decisions.sort((left, right) => compareSpatialStrings(left.regionId, right.regionId));
  const selectedRegionIds = [...rankByRegion.entries()]
    .sort((left, right) => left[1] - right[1])
    .map(([regionId]) => regionId);
  const material = {
    kind: "RegionalPlan" as const,
    abi: REGIONAL_PLAN_ABI,
    worldPlanHash: compiled.worldPlanHash,
    surfaceIndexHash: compiled.surfaceIndexHash,
    globalFoundationHash: input.inventory.globalFoundationHash,
    inventoryHash: input.inventory.hash,
    selectionPolicy: input.policy,
    selectedRegionIds,
    decisions,
    status: decisions.some((decision) => decision.disposition === "blocked")
      ? ("incomplete" as const)
      : ("eligible" as const),
  };
  return sealRegionalPlan(material);
}

export function assertRegionalPlan(
  value: unknown,
  inventory?: RegionalPlanningInventory,
  worldPlan?: unknown,
): asserts value is RegionalPlan {
  assertBoundedSpatialJson(value, DEFAULT_SPATIAL_ADMISSION_POLICY);
  const parsed = REGIONAL_PLAN_SCHEMA.parse(value);
  assertSealedIdentity(parsed, "regional_plan");
  assertCanonicalUnique(
    parsed.decisions.map((entry) => entry.regionId),
    "Regional decision IDs",
  );
  assertCanonicalUnique(parsed.selectedRegionIds, "Selected region IDs", false);
  const selected = parsed.decisions
    .filter((entry) => entry.disposition === "selected")
    .sort((left, right) => left.rank! - right.rank!);
  if (
    selected.some((entry, index) => entry.rank !== index) ||
    stableJson(selected.map((entry) => entry.regionId)) !== stableJson(parsed.selectedRegionIds)
  )
    throw new Error("Regional selection ranks do not match R+");
  for (const decision of parsed.decisions) {
    assertCanonicalUnique(decision.requirementIds, "Regional requirement IDs");
    assertCanonicalUnique(decision.placementConstraintHashes, "Placement constraint hashes");
    assertCanonicalUnique(decision.placementSurfaceIds, "Regional surface IDs");
    assertCanonicalUnique(decision.blockedBy, "Regional blockers");
  }
  const expectedStatus = parsed.decisions.some((entry) => entry.disposition === "blocked")
    ? "incomplete"
    : "eligible";
  if (parsed.status !== expectedStatus) throw new Error("Regional plan status is inconsistent");
  if (
    inventory &&
    (parsed.worldPlanHash !== inventory.worldPlanHash ||
      parsed.surfaceIndexHash !== inventory.surfaceIndexHash ||
      parsed.globalFoundationHash !== inventory.globalFoundationHash ||
      parsed.inventoryHash !== inventory.hash)
  )
    throw new Error("Regional plan does not bind its planning inventory");
  if (inventory && worldPlan !== undefined) {
    const expected = selectRegionalPlan({
      worldPlan,
      inventory,
      policy: parsed.selectionPolicy,
    });
    if (stableJson(parsed) !== stableJson(expected))
      throw new Error("Regional plan does not match deterministic R+ selection");
  }
}

function validatePlacementAuthority(
  authority: RegionalPlacementAuthority,
  compiled: CompiledWorldPlan,
  anchorIds: ReadonlySet<string>,
  declarationIds: ReadonlySet<string>,
): void {
  if (authority.kind === "surface") {
    assertCanonicalUnique(authority.surfaceIds, "Placement surface IDs", false);
    for (const surfaceId of authority.surfaceIds)
      if (!compiled.surfaces.has(surfaceId))
        throw new Error(`Regional placement references unknown surface ${surfaceId}`);
  } else if (authority.kind === "world_anchor") {
    if (!anchorIds.has(authority.anchorId))
      throw new Error(`Regional placement references unknown anchor ${authority.anchorId}`);
  } else if (!declarationIds.has(authority.targetDeclarationId)) {
    throw new Error(`Regional placement references unknown asset ${authority.targetDeclarationId}`);
  }
}

function anchorIds(compiled: CompiledWorldPlan): ReadonlySet<string> {
  return new Set(compiled.plan.anchors.map((anchor) => anchor.id));
}

function declarationIds(compiled: CompiledWorldPlan): ReadonlySet<string> {
  return new Set(compiled.plan.assetRequirements.map((requirement) => requirement.declarationId));
}

function canonicalPlacementAuthority(
  authority: RegionalPlacementAuthority,
): RegionalPlacementAuthority {
  return authority.kind === "surface"
    ? { ...authority, surfaceIds: [...authority.surfaceIds].sort(compareSpatialStrings) }
    : structuredClone(authority);
}

function chooseRegionCamera(
  plan: SpatialWorldPlan,
  regionId: string,
): SpatialWorldPlan["cameras"][number] | undefined {
  return [...plan.cameras]
    .filter((camera) => camera.regionIds.includes(regionId))
    .sort(
      (left, right) =>
        Number(right.evidenceRole === "region_detail") -
          Number(left.evidenceRole === "region_detail") || compareSpatialStrings(left.id, right.id),
    )[0];
}

function dependencyCycleDeclarations(
  requirements: readonly RegionalPlanningInventory["requirements"][number][],
): Set<string> {
  const edges = new Map<string, string>();
  for (const requirement of requirements)
    if (requirement.placementAuthority.kind === "asset_socket")
      edges.set(requirement.declarationId, requirement.placementAuthority.targetDeclarationId);
  const cycles = new Set<string>();
  for (const start of edges.keys()) {
    const path: string[] = [];
    const positions = new Map<string, number>();
    let current: string | undefined = start;
    while (current !== undefined && !positions.has(current)) {
      positions.set(current, path.length);
      path.push(current);
      current = edges.get(current);
    }
    if (current !== undefined && positions.has(current))
      for (const declarationId of path.slice(positions.get(current)!)) cycles.add(declarationId);
  }
  return cycles;
}

function sealInventory(
  material: Omit<RegionalPlanningInventory, "id" | "hash">,
): RegionalPlanningInventory {
  assertBoundedSpatialJson(material, DEFAULT_SPATIAL_ADMISSION_POLICY);
  const hash = contentHash(stableJson(material));
  return REGIONAL_PLANNING_INVENTORY_SCHEMA.parse({
    ...material,
    id: `regional_inventory_${hash.slice(0, 24)}`,
    hash,
  });
}

function sealRegionalPlan(material: Omit<RegionalPlan, "id" | "hash">): RegionalPlan {
  assertBoundedSpatialJson(material, DEFAULT_SPATIAL_ADMISSION_POLICY);
  const hash = contentHash(stableJson(material));
  return REGIONAL_PLAN_SCHEMA.parse({
    ...(material as unknown as Record<string, unknown>),
    id: `regional_plan_${hash.slice(0, 24)}`,
    hash,
  });
}

function assertSealedIdentity(
  parsed: RegionalPlanningInventory | RegionalPlan,
  prefix: "regional_inventory" | "regional_plan",
): void {
  const { id, hash, ...material } = parsed;
  const expected = contentHash(stableJson(material));
  if (hash !== expected || id !== `${prefix}_${expected.slice(0, 24)}`)
    throw new Error(`${parsed.kind} identity mismatch`);
}

function assertCanonicalUnique(
  values: readonly string[],
  label: string,
  requireSorted = true,
): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} must be unique`);
  if (requireSorted && stableJson([...values].sort(compareSpatialStrings)) !== stableJson(values))
    throw new Error(`${label} must be canonical`);
}
