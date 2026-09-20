import type { CatalogRequirement, RealizationIntent } from "@basalt/catalog-model";
import { readBoundedWorkspaceBytes } from "@basalt/artifact-store";
import { measureAssetPlacementGeometry } from "@basalt/asset-inspection";
import { contentHash, dequantizeQ32_32 } from "@basalt/contracts";
import {
  createSemanticDependencyClosure,
  sealSemanticAssertionBundle,
  type SemanticModule,
} from "@basalt/semantic-kernel";
import {
  createVegetationIntents,
  sealSpatialWorldPlan,
  sealWorldVisualEnvironment,
  type VegetationPaletteMember,
  type WorldRoute,
} from "@basalt/world-planning";
import { TEST_WORLD_EXECUTION_POLICY } from "./execution-policy.js";
import { catalogFirstUseFixture } from "./catalog-first-use-fixture.js";

export const HARVEST_VALLEY_OUTPUT_ROOT = ".basalt/evals/harvest-valley";
export const HARVEST_VALLEY_SIZE_METERS = 112;
const REGION = "HarvestValley";
const SURFACE = "HarvestValleyGround";
const ROUTE_ENTITY = "HarvestValleyPaths";
const STYLE = contentHash("harvest-valley-warm-rural-highlands");
const routeAppearance = {
  materialId: "Ground",
  baseColorSrgb: { red: 119, green: 96, blue: 65 },
  styleProfileHash: STYLE,
};

/** Authored composition fixture. Every visible object resolves through the real sealed catalog. */
export async function harvestValleyFixture(module: SemanticModule) {
  const base = await catalogFirstUseFixture(module);
  const regionEntity = base.plan.semanticEntities[0]!;
  const routeConcept = module.concepts.find((entry) => entry.conceptId === "bsc_000305")!;
  const routeClosure = createSemanticDependencyClosure({
    module,
    conceptIds: [routeConcept.conceptId],
  });
  const routeAssertions = sealSemanticAssertionBundle({
    authority: "admitted",
    assertions: [
      {
        assertionKind: "denotation",
        subject: { kind: "planned_entity", id: ROUTE_ENTITY },
        concept: { conceptId: routeConcept.conceptId, commitmentHash: routeConcept.commitmentHash },
        evidence: {
          level: "declared",
          evidenceHashes: [contentHash("harvest-valley-connected-walking-loop")],
        },
      },
    ],
  });
  const handles = [
    "rural_farmhouse",
    "rural_long_barn",
    "rural_small_barn",
    "rural_wind_pump",
    "rural_stone_arch",
    "rural_stone_well",
    "rural_harvest_cart",
    "rural_square_hay",
    "rural_round_hay",
    "rural_garden_bench",
    "rural_red_flowers",
    "rural_small_red_flowers",
    "rural_campfire_ring",
    "rural_sunflower",
    "rural_mushrooms",
    "rural_canvas_shelter",
    "rural_lantern",
    "rural_market_stall",
    "rural_swing_tree",
    "rural_tall_canopy_tree",
    "rural_monument_tree",
    "rural_old_broadleaf",
    "rural_woodland_group",
    "rural_silver_birch",
    "rural_slender_birch",
    "rural_ridge_pine",
    "rural_meadow_pine",
    "rural_orchard_spreading_tree",
    "rural_fruit_tree",
    "rural_orchard_round_tree",
    "rural_meadow_grass_patch",
    "rural_dense_grass_patch",
    "rural_purple_flower_clump",
    "rural_coral_flower_clump",
    "rural_trimmed_hedge",
    "rural_garden_hedge",
    "rural_leafy_shrub",
    "rural_rustic_fence",
    "rural_rail_fence",
    "rural_field_gate",
    "rural_weathered_barrel",
    "rural_wooden_barrel",
    "rural_water_trough",
    "rural_wooden_wheelbarrow",
    "rural_sack_group",
    "rural_tied_sack",
    "rural_closed_crate",
    "rural_open_crate",
    "rural_empty_handcart",
    "tree_03_ground",
    "tree_round_03_ground",
    "tree_round_04_ground",
    "tree_tallround_01_ground",
    "tree_log_02_ground",
    "plant_bush_03_ground",
    "plant_fern_01_ground",
    "plant_grass_04_ground",
    "rock_03_ground",
    "rock_boulder_01_ground",
    "rock_rounded_01_ground",
  ];
  const requirements: CatalogRequirement[] = handles.map((handle) => {
    const entry = base.catalogCommit.snapshot.entries.find((item) => item.handle === handle);
    if (!entry || entry.kind !== "substitution_set")
      throw new Error(`Missing admitted showcase entry ${handle}`);
    return {
      requirementId: handle,
      allowedEntryHandles: [handle],
      semantic: {
        denotation: { ...entry.semantic.denotation, matchMode: "exact" },
        realizationForms: [entry.semantic.realizationForm],
        affordances: [],
        states: [],
        surfaceTreatmentIds: [],
        dependencyClosureHash: entry.semantic.dependencyClosureHash,
      },
      acceptedEntryKinds: ["substitution_set"],
      styleProfileHandles: [entry.styleProfileHandle],
      placement: { requiredSupport: "ground", requiredInterfaceIds: [] },
      metricBounds: {},
      rights: { commercialUseRequired: true, redistributionRequired: true },
      budget: {
        maximumTriangles: entry.triangleCount,
        maximumSourceBytes: entry.sourceBytes,
      },
      required: true,
    };
  });
  const singles: [string, string, number, number, number][] = [
    ["Farmhouse", "rural_farmhouse", 48, 45, 180],
    ["MainBarn", "rural_long_barn", 75, 55, 270],
    ["UpperBarn", "rural_small_barn", 37, 75, 270],
    ["WindPump", "rural_wind_pump", 85, 66, 20],
    ["StoneArch", "rural_stone_arch", 74, 91, 0],
    ["VillageWell", "rural_stone_well", 63, 50, 0],
    ["Market", "rural_market_stall", 33, 36, 140],
    ["HarvestCart", "rural_harvest_cart", 69, 52, 250],
    ["FarmBench", "rural_garden_bench", 52, 53, 180],
    ["ScenicBench", "rural_garden_bench", 68, 85, 210],
    ["Shelter", "rural_canvas_shelter", 20.7, 63, 120],
    ["Campfire", "rural_campfire_ring", 24, 68, 0],
    ["CampLog", "tree_log_02_ground", 21, 69, 70],
    ["FarmLantern", "rural_lantern", 57, 44, 0],
    ["CampLantern", "rural_lantern", 17.6, 60, 20],
    ["HaySquareA", "rural_square_hay", 83, 55, 90],
    ["HaySquareB", "rural_square_hay", 84.8, 56.5, 80],
    ["HaySquareC", "rural_square_hay", 45, 75, 110],
    ["HayRoundA", "rural_round_hay", 73, 64, 20],
    ["HayRoundB", "rural_round_hay", 75, 64.5, 30],
    ["HayRoundC", "rural_round_hay", 45, 78, 45],
    ["HollowLog", "tree_log_02_ground", 18, 48, 35],
    ["OrchardTree", "tree_tallround_01_ground", 70, 79, 110],
    ["FarmShade", "tree_03_ground", 38, 55, 15],
    ["CampShade", "tree_tallround_01_ground", 17, 75, 240],
    ["WestMonument", "rural_monument_tree", 16, 18, 20],
    ["EastMatureCanopy", "rural_tall_canopy_tree", 103, 61, 10],
    ["SwingGrove", "rural_swing_tree", 92, 20, 160],
    ["OldCampTree", "rural_old_broadleaf", 17, 82, 15],
    ["DeepWoodGroup", "rural_woodland_group", 18, 98, 5],
    ["BarnBarrel", "rural_weathered_barrel", 81, 50, 10],
    ["BarnCask", "rural_wooden_barrel", 82.5, 50.4, 40],
    ["BarnCrate", "rural_closed_crate", 80.6, 58.4, 10],
    ["OpenHarvestCrate", "rural_open_crate", 81.8, 58.4, 340],
    ["FeedSacks", "rural_sack_group", 80.8, 60, 45],
    ["SpareSack", "rural_tied_sack", 82, 61, 10],
    ["WorkingWheelbarrow", "rural_wooden_wheelbarrow", 68, 58.5, 90],
    ["EmptyWagon", "rural_empty_handcart", 84, 72, 35],
    ["StockTrough", "rural_water_trough", 88.5, 65.8, 90],
    ["MarketCrate", "rural_open_crate", 30.1, 33, 10],
    ["MarketSack", "rural_tied_sack", 33.5, 33.1, 65],
    ["MarketBarrel", "rural_wooden_barrel", 36.1, 35, 5],
    ["HouseHedge", "rural_garden_hedge", 59, 51.5, 90],
  ];
  for (const [i, z] of [22, 24.5, 27, 29.5].entries())
    singles.push([`FrontHedge${i}`, "rural_trimmed_hedge", 43, z, 90]);
  const fenceRuns: string[][] = [];
  const boundsFor = (handle: string) => {
    const entry = base.catalogCommit.snapshot.entries.find((entry) => entry.handle === handle);
    if (!entry || entry.kind !== "substitution_set" || !entry.metricEnvelope)
      throw new Error(`Missing measured envelope for ${handle}`);
    return {
      minX: dequantizeQ32_32(entry.metricEnvelope.min.x),
      maxX: dequantizeQ32_32(entry.metricEnvelope.max.x),
      minZ: dequantizeQ32_32(entry.metricEnvelope.min.z),
      maxZ: dequantizeQ32_32(entry.metricEnvelope.max.z),
    };
  };
  const rustic = boundsFor("rural_rustic_fence");
  const gate = boundsFor("rural_field_gate");
  const fenceLength = rustic.maxX - rustic.minX;
  const gateLength = gate.maxX - gate.minX;
  const orchardWest = 47;
  const orchardFront = 62;
  const rowStart = orchardWest + rustic.maxZ;
  const rowWidth = 4 * fenceLength + gateLength;
  const orchardEast = rowStart + rowWidth - rustic.minZ;
  const sideStart = orchardFront + rustic.minZ;
  const orchardRear = sideStart + 7 * fenceLength - rustic.maxZ;
  function fenceRun(id: string, members: string[], start: number, fixed: number, yaw: 0 | 90) {
    const ids: string[] = [];
    let cursor = start;
    for (const [i, handle] of members.entries()) {
      const bounds = boundsFor(handle);
      const intentId = `${id}${i}`;
      singles.push(
        yaw === 0
          ? [intentId, handle, cursor - bounds.minX, fixed, yaw]
          : [intentId, handle, fixed, cursor + bounds.maxX, yaw],
      );
      cursor += bounds.maxX - bounds.minX;
      ids.push(intentId);
    }
    fenceRuns.push(ids);
  }
  const panels = (count: number) => Array<string>(count).fill("rural_rustic_fence");
  fenceRun(
    "OrchardFront",
    [...panels(2), "rural_field_gate", ...panels(2)],
    rowStart,
    orchardFront,
    0,
  );
  fenceRun("OrchardWest", panels(7), sideStart, orchardWest, 90);
  fenceRun("OrchardEast", panels(7), sideStart, orchardEast, 90);
  fenceRun("OrchardRearLeft", panels(2), rowStart, orchardRear, 0);
  fenceRun("OrchardRearRight", panels(2), rowStart + 2 * fenceLength + gateLength, orchardRear, 0);
  fenceRun("CampBoundary", Array<string>(2).fill("rural_rail_fence"), 18, 58, 0);
  for (const [i, [x, z]] of [
    [51, 74.1],
    [61.3, 74.1],
    [51, 77.8],
    [61.3, 77.8],
    [51, 81.8],
    [61.3, 81.8],
  ].entries()) {
    const handle = ["rural_fruit_tree", "rural_orchard_spreading_tree", "rural_orchard_round_tree"][
      i % 3
    ]!;
    singles.push([`OrchardRow${i}`, handle, x!, z!, i % 2 ? 180 : 0]);
  }
  const intents: RealizationIntent[] = singles.map(
    ([intentId, requirementId, u, v, yawDegrees]) => ({
      kind: "single",
      intentId,
      requirementId,
      priority: 1000,
      regionId: REGION,
      surfaceId: SURFACE,
      at: { u, v },
      yawDegrees,
    }),
  );
  function cluster(
    id: string,
    handle: string,
    x: number,
    z: number,
    radius: number,
    count: number,
    clearance: number,
    priority = 100,
  ) {
    intents.push({
      kind: "cluster",
      intentId: id,
      requirementId: handle,
      priority,
      regionId: REGION,
      surfaceId: SURFACE,
      center: { u: x, v: z },
      radiusMeters: radius,
      minimumCount: Math.max(1, Math.floor(count * 0.25)),
      targetCount: count,
      minimumSeparationMeters: clearance,
    });
  }
  function patch(
    id: string,
    handle: string,
    boundary: readonly (readonly [number, number])[],
    count: number,
    clearance: number,
    priority: number,
  ) {
    intents.push({
      kind: "surface_scatter",
      intentId: id,
      requirementId: handle,
      priority,
      regionId: REGION,
      surfaceId: SURFACE,
      boundary: boundary.map(([u, v]) => ({ u, v })),
      minimumCount: Math.max(1, Math.floor(count * 0.25)),
      targetCount: count,
      minimumSeparationMeters: clearance,
    });
  }
  // The settlement fills the walkable valley. Woods follow its banks, with
  // smaller colonies tapering into the court; the arrival meadow stays empty.
  const woods: { name: string; boundary: [number, number][]; tall: number; young: number }[] = [
    {
      name: "WestBank",
      boundary: [
        [5, 12],
        [18, 9],
        [29, 15],
        [32, 26],
        [25, 31],
        [24, 44],
        [16, 53],
        [7, 47],
      ],
      tall: 18,
      young: 16,
    },
    {
      name: "CampWood",
      boundary: [
        [5, 67],
        [12, 74],
        [16, 88],
        [30, 92],
        [31, 104],
        [8, 107],
      ],
      tall: 10,
      young: 14,
    },
    {
      name: "RidgeWood",
      boundary: [
        [41, 94],
        [50, 91],
        [58, 96],
        [65, 98],
        [72, 99],
        [80, 98],
        [87, 97],
        [95, 94],
        [107, 93],
        [106, 109],
        [40, 109],
      ],
      tall: 18,
      young: 16,
    },
    {
      name: "EastBank",
      boundary: [
        [96, 51],
        [108, 48],
        [108, 90],
        [95, 93],
        [96, 79],
        [93, 68],
      ],
      tall: 18,
      young: 12,
    },
    {
      name: "ArrivalWood",
      boundary: [
        [84, 9],
        [99, 6],
        [108, 15],
        [106, 33],
        [98, 44],
        [94, 36],
        [83, 31],
        [78, 21],
      ],
      tall: 25,
      young: 16,
    },
  ];
  const hardClearing = (
    min: { x: number; y: number; z: number },
    max: { x: number; y: number; z: number },
    falloffMeters: number,
  ) => ({
    mask: {
      polygon: [
        { x: min.x, z: min.z },
        { x: max.x, z: min.z },
        { x: max.x, z: max.z },
        { x: min.x, z: max.z },
      ],
      edgeProfile: { kind: "hard" as const },
    },
    verticalRangeMeters: { minimum: min.y, maximum: max.y },
    falloffMeters,
    layers: ["canopy", "understory", "ground_cover"] as const,
  });
  const clearings = [
    hardClearing({ x: 56, y: -8, z: 9 }, { x: 70, y: 12, z: 29 }, 5),
    hardClearing({ x: 44, y: -8, z: 59 }, { x: 68, y: 14, z: 87 }, 2),
    hardClearing({ x: 17, y: -8, z: 58 }, { x: 28, y: 8, z: 74 }, 3),
    hardClearing({ x: 40, y: -8, z: 37 }, { x: 87, y: 8, z: 59 }, 3),
    hardClearing({ x: 67, y: 9, z: 85 }, { x: 81, y: 16, z: 97 }, 3),
  ];
  const anchorIds = [
    "FarmShade",
    "CampShade",
    "WestMonument",
    "EastMatureCanopy",
    "SwingGrove",
    "OldCampTree",
    "DeepWoodGroup",
  ];
  const plant = (
    plantId: string,
    requirementId: string,
    layer: VegetationPaletteMember["layer"],
    maximumCount: number,
    density: number,
    minimum: number,
    maximum: number,
    open: number,
    covered: number,
    priority = 100,
  ): VegetationPaletteMember => ({
    plantId,
    requirementId,
    layer,
    maximumCount,
    minimumCount: 0,
    priority,
    candidateDensityPerSquareMeter: density,
    spacingMeters: { minimum, maximum },
    canopyResponse: { open, covered },
  });
  function community(
    areaId: string,
    boundary: [number, number][],
    palette: VegetationPaletteMember[],
    edgeFadeMeters: number,
  ) {
    intents.push(
      ...createVegetationIntents({
        areaId,
        habitatFieldId: areaId,
        regionId: REGION,
        surfaceId: SURFACE,
        boundary: boundary.map(([u, v]) => ({ u, v })),
        palette,
        densityField: {
          fieldId: areaId,
          seed: 260924,
          edgeFadeMeters,
          wavelengthMeters: 18,
          minimumDensity: 0.25,
          patchContrast: 1.6,
        },
        canopyIntentIds: anchorIds,
        clearings,
        maximumSlopeDegrees: 32,
        maximumSupportReliefMeters: 0.35,
        groundEmbedMeters: 0.025,
        routeClearanceHeightMeters: 3,
        minimumSeparationMeters: 0.02,
      }),
    );
  }
  for (const [i, wood] of woods.entries()) {
    const canopy = [
      "rural_silver_birch",
      "rural_ridge_pine",
      "rural_meadow_pine",
      "rural_slender_birch",
      "tree_03_ground",
    ][i]!;
    community(
      wood.name,
      wood.boundary,
      [
        plant(
          "Mature",
          "tree_tallround_01_ground",
          "canopy",
          Math.round(wood.tall * 0.4),
          0.12,
          3,
          5.5,
          1,
          1,
          300,
        ),
        plant("Canopy", canopy, "canopy", wood.tall, 0.22, 2.6, 4.2, 1, 1, 250),
        plant(
          "Saplings",
          i % 2 ? "tree_round_03_ground" : "tree_round_04_ground",
          "canopy",
          wood.young,
          0.2,
          1.7,
          2.8,
          1,
          1,
          200,
        ),
        plant("Bushes", "plant_bush_03_ground", "understory", 12, 0.09, 1.2, 2.8, 0.08, 0.65),
        plant("Shrubs", "rural_leafy_shrub", "understory", 65, 0.5, 0.5, 1.2, 0.12, 1),
        plant("Ferns", "plant_fern_01_ground", "understory", 45, 0.35, 0.6, 1.5, 0.04, 1),
        plant("Grass", "plant_grass_04_ground", "ground_cover", 180, 1.3, 0.25, 0.6, 0.75, 0.9),
        plant(
          "Meadow",
          i % 2 ? "rural_meadow_grass_patch" : "rural_dense_grass_patch",
          "ground_cover",
          20,
          0.12,
          1.4,
          2.6,
          1,
          0.3,
        ),
        plant("Mushrooms", "rural_mushrooms", "ground_cover", 12, 0.08, 0.4, 1.2, 0.01, 1),
      ],
      2,
    );
  }
  // Broader, sparse verge polygons replace repeated circular shrub colonies.
  const verges: [number, number][][] = [
    [
      [27, 13],
      [41, 17],
      [42, 28],
      [35, 28],
      [30, 23],
    ],
    [
      [8, 44],
      [20, 43],
      [28, 51],
      [24, 58],
      [14, 62],
      [7, 56],
    ],
    [
      [22, 84],
      [38, 89],
      [55, 92],
      [59, 100],
      [36, 105],
      [24, 96],
    ],
    [
      [74, 17],
      [84, 25],
      [97, 38],
      [94, 49],
      [85, 47],
      [76, 35],
    ],
    [
      [94, 78],
      [105, 82],
      [107, 101],
      [91, 105],
      [87, 98],
    ],
  ];
  for (const [i, boundary] of verges.entries())
    community(
      `Verge${i}`,
      boundary,
      [
        plant(
          "Meadow",
          i % 2 ? "rural_meadow_grass_patch" : "rural_dense_grass_patch",
          "ground_cover",
          12,
          0.07,
          1.6,
          3,
          0.65,
          0.15,
        ),
        plant("Grass", "plant_grass_04_ground", "ground_cover", 65, 0.4, 0.4, 1, 0.5, 0.8),
        plant("Shrubs", "rural_leafy_shrub", "understory", 18, 0.18, 0.7, 1.8, 0.03, 0.8),
        plant("Flowers", "rural_small_red_flowers", "ground_cover", 8, 0.05, 0.5, 1.5, 0.6, 0.04),
      ],
      5,
    );
  for (const [i, [x, z]] of [
    [83, 92],
    [7, 82],
    [103, 36],
  ].entries()) {
    cluster(`Outcrop${i}`, "rock_boulder_01_ground", x!, z!, 3.8, 4, 0.03, 450);
    cluster(`OutcropSkirt${i}`, "rock_rounded_01_ground", x! + 1, z! - 1, 4.6, 7, 0.025, 300);
    cluster(`OutcropChips${i}`, "rock_03_ground", x! + 1, z! - 1, 4.8, 14, 0.015, 290);
  }
  const gardens: [number, number][][] = [
    [
      [35.5, 46.5],
      [40.5, 45.5],
      [40.5, 54.3],
      [34.2, 54.3],
    ],
    [
      [36, 29],
      [41, 29],
      [41, 33],
      [36, 33],
    ],
    [
      [26, 33],
      [30, 33],
      [31, 43],
      [26, 43],
    ],
    [
      [82, 62],
      [88, 61],
      [90, 62],
      [90, 69],
      [88, 71],
      [88, 64],
      [82, 64],
    ],
  ];
  for (const [i, boundary] of gardens.entries()) {
    patch(`GardenPurple${i}`, "rural_purple_flower_clump", boundary, 8, 0.015, 185);
    patch(`GardenCoral${i}`, "rural_coral_flower_clump", boundary, 8, 0.015, 185);
    patch(`GardenFlowers${i}`, "rural_red_flowers", boundary, i === 0 ? 4 : 3, 0.02, 190);
    patch(`GardenSmallFlowers${i}`, "rural_small_red_flowers", boundary, 4, 0.02, 188);
  }
  cluster("ArrivalFlowers", "rural_small_red_flowers", 39, 24, 2.5, 12, 0.025, 150);
  cluster("ArrivalFlowerGrass", "plant_grass_04_ground", 38.5, 24, 4.2, 20, 0.02, 40);
  // Cultivation is intentionally regular; wild planting is not.
  intents.push({
    kind: "surface_grid",
    intentId: "SunflowerPlot",
    requirementId: "rural_sunflower",
    priority: 500,
    regionId: REGION,
    surfaceId: SURFACE,
    origin: { u: 54, v: 65 },
    columns: 9,
    rows: 8,
    spacingUMeters: 0.9,
    spacingVMeters: 1.05,
  });

  const routes = [
    path(
      "Arrival",
      [
        [52, 4],
        [47, 15],
        [47, 25],
        [51, 32],
        [57, 36],
      ],
      0,
      2.6,
    ),
    path(
      "CourtLane",
      [
        [57, 36],
        [62, 46],
        [75, 44],
      ],
      1,
      2.4,
    ),
    path(
      "MarketLane",
      [
        [49, 36],
        [38.2, 36],
        [38.2, 43],
        [31, 50],
        [29, 59],
      ],
      2,
      2.2,
      2,
    ),
    path(
      "UpperFarm",
      [
        [29, 59],
        [27, 75],
        [30, 85],
        [48, 87],
        [58, 87],
      ],
      3,
      2.2,
    ),
    path(
      "RidgeWalk",
      [
        [58, 87],
        [67, 102],
        [87, 97],
        [96, 80],
        [92, 58],
      ],
      4,
      2.1,
    ),
    path(
      "RidgeReturn",
      [
        [92, 58],
        [86, 46],
        [75, 44],
      ],
      5,
      2.2,
    ),
    path(
      "HouseWalk",
      [
        [49, 36],
        [49, 39.4],
      ],
      6,
      2.2,
    ),
    path(
      "UpperBarnWalk",
      [
        [29, 59],
        [37, 64.5],
        [37, 70.05],
      ],
      7,
      2.1,
      2,
    ),
    path(
      "WindPumpWalk",
      [
        [92, 58],
        [86, 60],
      ],
      8,
      2.1,
    ),
    path(
      "OrchardWalk",
      [
        [58, 87],
        [56, 84],
        [56, 74.4],
      ],
      9,
      2.1,
      4,
      0.4,
    ),
    path(
      "BarnDoorWalk",
      [
        [75, 44],
        [75, 48.15],
      ],
      10,
      2.1,
    ),
    path(
      "CampWalk",
      [
        [29, 59],
        [25.7, 61],
        [25.7, 65.8],
      ],
      11,
      2.1,
      4,
      0.5,
    ),
    path(
      "MarketLink",
      [
        [57, 36],
        [49, 36],
      ],
      12,
      2.2,
    ),
  ];
  const junctions = [
    junction("ArrivalSplit", 57, 36, [
      ["Arrival", "end"],
      ["CourtLane", "start"],
      ["MarketLink", "start"],
    ]),
    junction("HouseTurn", 49, 36, [
      ["MarketLink", "end"],
      ["MarketLane", "start"],
      ["HouseWalk", "start"],
    ]),
    junction("BarnCourt", 75, 44, [
      ["CourtLane", "end"],
      ["RidgeReturn", "end"],
      ["BarnDoorWalk", "start"],
    ]),
    junction("CampSplit", 29, 59, [
      ["MarketLane", "end"],
      ["UpperFarm", "start"],
      ["UpperBarnWalk", "start"],
      ["CampWalk", "start"],
    ]),
    junction("UpperPasture", 58, 87, [
      ["UpperFarm", "end"],
      ["RidgeWalk", "start"],
      ["OrchardWalk", "start"],
    ]),
    junction("WindPumpSplit", 92, 58, [
      ["RidgeWalk", "end"],
      ["RidgeReturn", "start"],
      ["WindPumpWalk", "start"],
    ]),
  ];
  const { kind: _kind, coordinateSystem: _coordinates, planHash: _hash, ...planBody } = base.plan;
  const bounds = { min: { x: 0, y: -8, z: 0 }, max: { x: 112, y: 60, z: 112 } };
  const plan = sealSpatialWorldPlan({
    ...planBody,
    planId: "HarvestValleyShowcase",
    seed: 260917,
    boundsMeters: bounds,
    semanticEntities: [
      regionEntity,
      {
        entityId: ROUTE_ENTITY,
        upperSort: "space",
        regionId: REGION,
        semanticDependencyClosureHash: routeClosure.hash,
        admittedAssertionBundleHash: routeAssertions.hash,
      },
    ],
    admittedAssertions: [...base.plan.admittedAssertions, routeAssertions],
    regions: [
      {
        regionId: REGION,
        semanticEntityId: regionEntity.entityId,
        volume: { kind: "box", bounds },
        refinementPriority: 0,
      },
    ],
    placementSurfaces: [
      {
        surfaceId: SURFACE,
        regionId: REGION,
        kind: "terrain",
        bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 112, y: 0, z: 112 } },
        normal: { x: 0, y: 1, z: 0 },
        sourceHash: contentHash("harvest-valley-surface"),
      },
    ],
    terrainPlans: [
      {
        terrainPlanId: "HarvestValleyTerrain",
        surfaceId: SURFACE,
        regionIds: [REGION],
        boundsMeters: { x: { minimum: 0, maximum: 112 }, z: { minimum: 0, maximum: 112 } },
        resolution: { columns: 113, rows: 113 },
        baseElevationMeters: 0,
        operations: [
          { kind: "raise", center: { x: 51, z: 51 }, radiusMeters: 76, deltaMeters: 3 },
          { kind: "raise", center: { x: 17, z: 82 }, radiusMeters: 32, deltaMeters: 8 },
          { kind: "raise", center: { x: 77, z: 102 }, radiusMeters: 32, deltaMeters: 12 },
          { kind: "raise", center: { x: 105, z: 59 }, radiusMeters: 40, deltaMeters: 8 },
          { kind: "raise", center: { x: 17, z: 22 }, radiusMeters: 24, deltaMeters: 4 },
          plateau(39, 37, 57, 53, 3, 8),
          plateau(69, 47, 82, 64, 4, 10),
          plateau(30, 68, 44, 82, 6, 10),
          plateau(81, 58, 89, 71, 6, 12),
          plateau(66, 85, 81, 96, 12, 32),
          plateau(18, 59, 26, 74, 4, 8),
          plateau(46, 62, 67, 84, 5.2, 18),
          plateau(56, 42, 68, 56, 3, 10),
          // Final contact pads protect each complete footprint from neighboring blends.
          plateau(39.8, 38.5, 56.2, 54, 3, 1.2),
          plateau(70.4, 47.3, 79.6, 62.7, 4, 1.2),
          plateau(32.4, 69.2, 41.6, 80.8, 6, 1.2),
          plateau(81, 58, 89, 71, 6, 2),
          plateau(46, 61, 66, 85, 5.6, 1.2),
          plateau(29.8, 32.8, 36.3, 39.2, 2.7, 1.2),
          plateau(17, 57, 27, 73, 4, 1.2),
          ...woods.map((wood, index) => ({
            kind: "paint" as const,
            materialId: "LeafyGrass",
            mask: {
              polygon: wood.boundary.map(([x, z]) => ({ x, z })),
              edgeProfile: {
                kind: "organic" as const,
                seed: 31_000 + index,
                wavelengthMeters: 8,
                displacementMeters: 1.8,
              },
            },
          })),
          ...[
            [
              [9, 18],
              [17, 14],
              [24, 20],
              [23, 31],
              [18, 43],
              [10, 42],
            ],
            [
              [88, 12],
              [99, 11],
              [103, 19],
              [100, 31],
              [94, 28],
              [86, 23],
            ],
            [
              [9, 79],
              [16, 85],
              [26, 96],
              [26, 104],
              [11, 102],
            ],
            [
              [53, 64],
              [62.5, 64],
              [62.5, 73],
              [53, 73],
            ],
          ].map((polygon) => ({
            kind: "paint" as const,
            materialId: "Ground",
            mask: {
              polygon: polygon.map(([x, z]) => ({ x: x!, z: z! })),
              edgeProfile: { kind: "hard" as const },
            },
          })),
        ],
        materialId: "Grass",
      },
    ],
    routes,
    routeJunctions: junctions,
    constructionPrograms: [],
    structuralPrograms: [],
    lotPolicies: [],
    catalogRequirements: requirements,
    realizationIntents: intents,
    visualEnvironment: sealWorldVisualEnvironment({
      clockTimeHours: 16.4,
      geographicLatitudeDegrees: 35,
      brightness: 2.5,
      exposureCompensation: 0.05,
      shadowSoftness: 0.35,
      environmentDiffuseScale: 0.72,
      environmentSpecularScale: 0.45,
      ambientSrgb: { red: 55, green: 62, blue: 65 },
      outdoorAmbientSrgb: { red: 111, green: 124, blue: 116 },
      colorShiftTopSrgb: { red: 22, green: 12, blue: 2 },
      colorShiftBottomSrgb: { red: 2, green: 5, blue: 9 },
      atmosphere: {
        colorSrgb: { red: 202, green: 220, blue: 229 },
        decaySrgb: { red: 112, green: 128, blue: 140 },
        density: 0.19,
        offset: 0.18,
        haze: 1.1,
        glare: 0.08,
      },
      colorGrade: {
        brightness: 0,
        contrast: 0.12,
        saturation: 0.07,
        tintSrgb: { red: 255, green: 249, blue: 238 },
      },
      sunRays: { intensity: 0.025, spread: 0.8 },
    }),
    cameras: [
      {
        cameraId: "HarvestValleyOverview",
        positionMeters: { x: 132, y: 92, z: -18 },
        lookAtMeters: { x: 56, y: 6, z: 60 },
        up: { x: 0, y: 1, z: 0 },
        fieldOfViewDegrees: 52,
        regionIds: [REGION],
        readabilityIntent: {
          kind: "art_directed",
          rationale:
            "The white farmhouse anchors a red-barn hamlet framed by wooded slopes and a distant rock arch.",
        },
      },
      {
        cameraId: "HarvestValleyArrival",
        positionMeters: { x: 64, y: 10, z: 22 },
        lookAtMeters: { x: 49, y: 8, z: 46 },
        up: { x: 0, y: 1, z: 0 },
        fieldOfViewDegrees: 60,
        regionIds: [REGION],
        readabilityIntent: {
          kind: "art_directed",
          rationale:
            "A flowered approach reveals the farmhouse, with farm structures and the rocky skyline beyond.",
        },
      },
    ],
  });
  const measuredRequirements = new Set(
    intents
      .filter(
        (intent) =>
          (intent.kind === "surface_scatter" && intent.vegetation) ||
          anchorIds.includes(intent.intentId),
      )
      .map((intent) => intent.requirementId),
  );
  const geometryHashes = new Set(
    base.catalogCommit.snapshot.entries.flatMap((entry) =>
      entry.kind !== "collection" && measuredRequirements.has(entry.handle)
        ? entry.memberAssets.map((member) => member.assetHash)
        : [],
    ),
  );
  const placementGeometry = [];
  for (const hash of [...geometryHashes].sort()) {
    const asset = base.measurements.assets.find((asset) => asset.hash === hash)!;
    const source = base.catalogCommit.sourceManifest.assets.find(
      (source) => source.contentHash === asset.source.contentHash,
    )!;
    placementGeometry.push(
      measureAssetPlacementGeometry(
        await readBoundedWorkspaceBytes(process.cwd(), source.relativePath, 32 * 1024 * 1024),
        asset,
      ),
    );
  }
  return {
    ...base,
    fenceRuns,
    plan,
    compileInput: {
      semanticModule: module,
      catalogSnapshot: base.catalogCommit.snapshot,
      catalogAssets: base.measurements.assets,
      spatialPlan: plan,
      placementGeometry,
      executionPolicy: TEST_WORLD_EXECUTION_POLICY,
    },
  };
}

function plateau(
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  elevationMeters: number,
  blendWidthMeters: number,
) {
  return {
    kind: "flatten" as const,
    polygon: [
      { x: x0, z: z0 },
      { x: x1, z: z0 },
      { x: x1, z: z1 },
      { x: x0, z: z1 },
    ],
    elevationMeters,
    blendWidthMeters,
  };
}
function path(
  routeId: string,
  points: number[][],
  terrainPriority: number,
  widthMeters: number,
  bendRadiusMeters = 4,
  blendWidthMeters = 1.4,
): WorldRoute {
  return {
    routeId,
    semanticEntityId: ROUTE_ENTITY,
    regionIds: [REGION],
    surfaceId: SURFACE,
    alignmentMeters: points.map(([x, z]) => ({ x: x!, z: z! })),
    elevationControls: [0, 1].map((stationFraction) => ({
      controlId: `${routeId}${stationFraction}`,
      stationFraction,
      surfaceElevation: { kind: "terrain_clearance", clearanceMeters: 0.08 },
    })),
    widthMeters,
    thicknessMeters: 0.16,
    bendRadiusMeters,
    maximumSegmentLengthMeters: 0.6,
    terrainPriority,
    closed: false,
    appearance: routeAppearance,
    construction: {
      kind: "follow_surface",
      surfaceRevealMeters: 0.08,
      crossfallRatio: 0,
      maximumGradeRatio: 0.55,
      shoulderWidthMeters: 0.45,
      blendWidthMeters,
      maximumCutDepthMeters: 5,
      maximumFillDepthMeters: 5,
      groundingToleranceMeters: 0.12,
      vegetationClearanceMeters: 0.8,
      terrainMaterialId: "Ground",
    },
  };
}
function junction(
  junctionId: string,
  x: number,
  z: number,
  participants: [string, "start" | "end"][],
) {
  return {
    junctionId,
    kind: "intersection" as const,
    positionMeters: { x, z },
    surfaceElevation: { kind: "terrain_clearance" as const, clearanceMeters: 0.08 },
    participants: participants.map(([routeId, endpoint]) => ({ routeId, endpoint })),
    maximumSnapDistanceMeters: 0.01,
    radiusMeters: 1.05,
    appearance: routeAppearance,
    terrainMaterialId: "Ground",
  };
}
