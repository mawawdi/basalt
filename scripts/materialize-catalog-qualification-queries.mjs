import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  CATALOG_QUALIFICATION_DESCRIPTION_DECISION_SCHEMA,
  CATALOG_QUALIFICATION_DESCRIPTION_PROPOSAL_SCHEMA,
  CATALOG_QUALIFICATION_DESCRIPTION_SET_SCHEMA,
  CATALOG_VISUAL_REVIEW_INDEX_SCHEMA,
  requireCreatorReviewedCatalogQualificationDescriptions,
  sealCatalogQualificationDevelopmentQuerySet,
  sealCatalogSearchQuery,
} from "../packages/catalog-authoring/dist/index.js";
import { CATALOG_MEASUREMENT_SET_SCHEMA } from "../packages/catalog-model/dist/index.js";
import { quantizeQ32_32 } from "../packages/contracts/dist/index.js";

const root = resolve(".");
const proposalPath = "registry/qualifications/catalog-description-proposal.json";
const decisionPath = "registry/qualifications/catalog-description-decision.json";
const descriptionSetPath = "registry/qualifications/catalog-description-set.json";
const outputPath = "registry/qualifications/catalog-development-query-set.json";

const proposal = CATALOG_QUALIFICATION_DESCRIPTION_PROPOSAL_SCHEMA.parse(
  await readJson(proposalPath),
);
const decision = CATALOG_QUALIFICATION_DESCRIPTION_DECISION_SCHEMA.parse(
  await readJson(decisionPath),
);
const descriptions = CATALOG_QUALIFICATION_DESCRIPTION_SET_SCHEMA.parse(
  await readJson(descriptionSetPath),
);
requireCreatorReviewedCatalogQualificationDescriptions({ proposal, decision, descriptions });

const measurements = CATALOG_MEASUREMENT_SET_SCHEMA.parse(
  await readJson(".basalt/catalog/measurements.json"),
);
const renders = CATALOG_VISUAL_REVIEW_INDEX_SCHEMA.parse(
  await readJson(".basalt/catalog/review/index.json"),
);
if (measurements.hash !== proposal.measurementSetHash)
  throw new Error("Reviewed descriptions do not bind the current measurement set");
if (renders.hash !== proposal.visualReviewIndexHash)
  throw new Error("Reviewed descriptions do not bind the current visual review index");

const queries = [
  developmentQuery({
    queryId: "small_wooden_footbridge",
    text: "Small arched wooden footbridge for a garden path, with railings on both sides; fit within 3.5 m wide, 2.5 m tall, and 6.5 m long.",
    coverageTags: ["appearance", "metric_limit", "style", "whole_component_boundary"],
    authoringNote:
      "Combines visible construction, a standalone-object requirement, and measured fit limits.",
    maximumSizeMeters: [3.5, 2.5, 6.5],
    styleTerms: ["stylized", "wooden"],
  }),
  developmentQuery({
    queryId: "curved_dirt_road_module",
    text: "Curved dirt-road segment for extending a modular route, with grass along the edges and visible stones; fit within a 7 m by 1 m by 7 m box.",
    coverageTags: ["appearance", "close_alternative", "metric_limit", "whole_component_boundary"],
    authoringNote:
      "Tests a route-surface component against visually similar terrain-edged channel pieces.",
    maximumSizeMeters: [7, 1, 7],
    styleTerms: ["stylized"],
  }),
  developmentQuery({
    queryId: "dry_earthen_channel",
    text: "Shallow curved dry earthen channel or ditch with grassy banks and stones, not a drivable road; fit within 6 m by 1.5 m by 6 m.",
    coverageTags: ["appearance", "close_alternative", "metric_limit", "whole_component_boundary"],
    authoringNote:
      "Makes the road-versus-channel distinction explicit while retaining a practical size bound.",
    maximumSizeMeters: [6, 1.5, 6],
    styleTerms: ["stylized"],
  }),
  developmentQuery({
    queryId: "snowy_low_poly_tree",
    text: "Low-poly green tree with visible snow on the crown and a brown trunk, no more than 6 m tall and roughly 3.5 m across.",
    coverageTags: ["appearance", "metric_limit", "style"],
    authoringNote:
      "Uses only visible tree features and measured scale, without asserting species or season.",
    maximumSizeMeters: [3.5, 6, 3.5],
    styleTerms: ["low poly", "snow covered"],
  }),
  developmentQuery({
    queryId: "bent_tropical_palm",
    text: "Stylized bent palm tree with sparse bright-green fronds for a tropical shoreline; no more than 8 m across and 5 m tall.",
    coverageTags: ["appearance", "metric_limit", "style"],
    authoringNote:
      "Tests a distinctive silhouette and broad placement context under an executable size cap.",
    maximumSizeMeters: [8, 5, 5],
    styleTerms: ["stylized", "tropical"],
  }),
  developmentQuery({
    queryId: "upright_gray_boulder",
    text: "Single upright faceted gray boulder, about 1.3 m tall with a flattened top, fitting inside a 0.8 m by 1.5 m by 0.8 m box.",
    coverageTags: ["appearance", "close_alternative", "metric_limit"],
    authoringNote:
      "Separates a compact upright rock silhouette from beige pillars and broader boulders.",
    maximumSizeMeters: [0.8, 1.5, 0.8],
    styleTerms: ["faceted"],
  }),
  developmentQuery({
    queryId: "complete_treasure_chest",
    text: "Complete closed wooden treasure chest with gray metal bands and an arched slatted lid, suitable as a standalone prop and under 1.5 m wide.",
    coverageTags: ["appearance", "metric_limit", "whole_component_boundary"],
    authoringNote:
      "Requires a complete standalone prop rather than a chest component or generic container.",
    maximumSizeMeters: [1.5, 1, 1],
    styleTerms: ["wooden"],
  }),
  developmentQuery({
    queryId: "faceted_pillar_component",
    text: "One beige pillar-shaped construction piece with a faceted cap, around 1.2 m tall; a component rather than a complete wall.",
    coverageTags: ["appearance", "metric_limit", "whole_component_boundary"],
    authoringNote:
      "Tests visible form without inventing the piece's unresolved assembly connections.",
    maximumSizeMeters: [0.7, 1.5, 0.7],
    styleTerms: ["faceted"],
  }),
  developmentQuery({
    queryId: "mixed_fruit_bowl",
    text: "Small tabletop bowl containing bananas and mixed red, green, and orange fruit, under half a metre across.",
    coverageTags: ["aggregate_request", "appearance", "metric_limit"],
    authoringNote:
      "Exercises a composed multi-object prop with specific visible contents instead of an aggregate label.",
    maximumSizeMeters: [0.5, 0.35, 0.5],
    styleTerms: ["stylized"],
  }),
  developmentQuery({
    queryId: "bones_ground_scatter",
    text: "Low ground dressing made of scattered pale bones on an irregular gray mound, under 3 m across.",
    coverageTags: ["aggregate_request", "appearance", "metric_limit"],
    authoringNote:
      "Tests a multi-piece ground scatter whose composition matters more than a generic object noun.",
    maximumSizeMeters: [3, 1, 3],
    styleTerms: ["stylized"],
  }),
  developmentQuery({
    queryId: "mustard_beanbag_chair",
    text: "Complete faceted beanbag chair in mustard yellow, with a visible seat hollow and raised back, around 1 m wide.",
    coverageTags: ["appearance", "metric_limit", "style", "whole_component_boundary"],
    authoringNote:
      "Uses the visible seating form while tolerating simplified stylized construction details.",
    maximumSizeMeters: [1.3, 1.2, 1.3],
    styleTerms: ["faceted", "stylized"],
  }),
  developmentQuery({
    queryId: "small_two_tone_party_hat",
    text: "Small two-tone conical party hat with a red-orange upper cone and purple lower band, under 30 cm tall.",
    coverageTags: ["appearance", "metric_limit", "whole_component_boundary"],
    authoringNote:
      "Covers a small wearable-style attachment without asserting an unobserved brim or fastening method.",
    maximumSizeMeters: [0.25, 0.3, 0.25],
    styleTerms: ["stylized"],
  }),
  developmentQuery({
    queryId: "tabletop_paper_trimmer",
    text: "Compact tabletop paper trimmer with a blue cutting bed, straight guide rail, and black sliding cutter, under 60 cm long.",
    coverageTags: ["appearance", "close_alternative", "metric_limit"],
    authoringNote:
      "Distinguishes a rail-and-slider trimmer from a guillotine cutter with a raised pivoting arm.",
    maximumSizeMeters: [0.5, 0.3, 0.6],
    styleTerms: ["stylized"],
  }),
  developmentQuery({
    queryId: "curved_triple_monitor_rig",
    text: "Complete desktop rig with three curved monitors on one central adjustable stand, under 2 m wide.",
    coverageTags: ["appearance", "metric_limit", "whole_component_boundary"],
    authoringNote:
      "Requires the visible three-screen assembly rather than an individual monitor component.",
    maximumSizeMeters: [2, 1, 1],
    styleTerms: ["modern"],
  }),
  developmentQuery({
    queryId: "small_mushroom_cluster",
    text: "Small cluster of three brown mushrooms with rounded caps for low-poly forest groundcover, under half a metre tall.",
    coverageTags: ["aggregate_request", "appearance", "metric_limit", "style"],
    authoringNote: "Combines count, visible form, ground-cover role, style, and measured height.",
    maximumSizeMeters: [0.6, 0.6, 0.6],
    styleTerms: ["low poly"],
  }),
  developmentQuery({
    queryId: "round_stone_fountain_probe",
    text: "Round marble fountain with three stacked basins, a winged statue, and visible water jets, about 3 m wide.",
    coverageTags: ["appearance", "metric_limit", "no_match_probe"],
    authoringNote:
      "Demands a specific multi-tier fountain composition; pooling and review will determine whether it is truly absent.",
    maximumSizeMeters: [4, 3, 4],
    styleTerms: ["stone"],
  }),
  developmentQuery({
    queryId: "paved_intersection_probe",
    text: "Four-way asphalt intersection with white lane arrows, zebra crossings, curb sidewalks, and traffic lights, fitting within a 12 m square.",
    coverageTags: [
      "appearance",
      "close_alternative",
      "metric_limit",
      "no_match_probe",
      "whole_component_boundary",
    ],
    authoringNote:
      "Probes a route component that should not be satisfied by a curved dirt-road segment alone.",
    maximumSizeMeters: [12, 2, 12],
    styleTerms: ["paved"],
  }),
  developmentQuery({
    queryId: "weatherproof_openable_chest",
    text: "Weatherproof treasure chest with a working hinged lid that can be opened during gameplay.",
    coverageTags: ["appearance", "unobservable_property", "whole_component_boundary"],
    authoringNote:
      "The visible shape may match a chest while weather resistance and functional articulation require unavailable evidence.",
    styleTerms: ["wooden"],
  }),
  developmentQuery({
    queryId: "load_bearing_player_bridge",
    text: "Wooden footbridge verified to safely carry player characters across a six-metre gap.",
    coverageTags: ["appearance", "unobservable_property", "whole_component_boundary"],
    authoringNote:
      "Separates visible bridge relevance from unsupported load-bearing and gameplay-safety claims.",
    styleTerms: ["wooden"],
  }),
  developmentQuery({
    queryId: "powered_dual_wall_outlet",
    text: "Electrically functional two-socket wall outlet that can supply power to connected devices.",
    coverageTags: ["appearance", "unobservable_property", "whole_component_boundary"],
    authoringNote:
      "Tests whether visual validation abstains when function cannot be established from renders and measurements.",
    styleTerms: ["wall mounted"],
  }),
];

const querySet = sealCatalogQualificationDevelopmentQuerySet({
  descriptionSetHash: descriptions.hash,
  descriptionDecisionArtifactHash: decision.hash,
  measurementSetHash: measurements.hash,
  visualReviewIndexHash: renders.hash,
  poolingPlan: {
    retrievalChannels: ["basename_only", "hybrid", "image_text_only", "metadata_only"],
    resultDepthPerChannel: 5,
    backgroundPopulation: "full_measured_basename_searchable_corpus",
    poolConstruction: "canonical_union_with_unscored_manual_recall_seeds",
    unjudgedPolicy: "unknown_not_negative",
  },
  queries,
});

await writeJson(outputPath, querySet);
process.stdout.write(
  `${JSON.stringify(
    {
      status: "incomplete",
      completedStage: "query_authoring",
      nextStage: querySet.nextStage,
      reason:
        "Distinct development requests are authored without answer labels; retrieval union pooling and independent judgments remain pending",
      querySet: resolve(root, outputPath),
      querySetHash: querySet.hash,
      descriptionSetHash: querySet.descriptionSetHash,
      queries: querySet.queries.length,
      requestsWithMetricLimits: querySet.queries.filter((entry) =>
        entry.coverageTags.includes("metric_limit"),
      ).length,
      noMatchProbes: querySet.queries.filter((entry) =>
        entry.coverageTags.includes("no_match_probe"),
      ).length,
      unobservablePropertyRequests: querySet.queries.filter((entry) =>
        entry.coverageTags.includes("unobservable_property"),
      ).length,
      expectedRelevanceLabels: 0,
      qualificationExecutionAuthorized: querySet.qualificationExecutionAuthorized,
    },
    null,
    2,
  )}\n`,
);

function developmentQuery({
  queryId,
  text,
  coverageTags,
  authoringNote,
  maximumSizeMeters,
  styleTerms = [],
}) {
  return {
    queryId,
    request: sealCatalogSearchQuery({
      text,
      styleTerms,
      rankingMode: "automatic",
      constraints: {
        ...(maximumSizeMeters ? { maximumSizeMeters: fixedVector(maximumSizeMeters) } : {}),
        commercialUseRequired: true,
        redistributionRequired: true,
      },
      limit: 20,
      validationLimit: 5,
    }),
    coverageTags,
    authoringNote,
  };
}

function fixedVector([x, y, z]) {
  return {
    x: quantizeQ32_32(x),
    y: quantizeQ32_32(y),
    z: quantizeQ32_32(z),
  };
}

async function readJson(path) {
  return JSON.parse(await readFile(resolve(root, path), "utf8"));
}

async function writeJson(path, value) {
  const absolute = resolve(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
