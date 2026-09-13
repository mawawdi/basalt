import { z } from "zod";
import {
  COMPILATION_STATUS_SCHEMA,
  HASH_SCHEMA,
  compareCanonicalStrings,
  contentHash,
} from "@basalt/contracts";
import { CATALOG_MEASUREMENT_SET_SCHEMA, type CatalogMeasurementSet } from "@basalt/catalog-model";
import {
  CATALOG_CALIBRATION_ROLES,
  CATALOG_CALIBRATION_SPLIT_SCHEMA,
  type CatalogCalibrationRole,
  type CatalogCalibrationSplit,
} from "./calibration.js";
import {
  canonicalValues,
  requireCanonicalValues,
  sealArtifact,
  verifyArtifactHash,
} from "./artifact.js";
import { CATALOG_ADMISSION_POLICY_SCHEMA, type CatalogAdmissionPolicy } from "./policy.js";
import { CATALOG_VISUAL_REVIEW_INDEX_SCHEMA, type CatalogVisualReviewIndex } from "./render.js";

const PILOT_GROUP_SCHEMA = z
  .object({
    groupHash: HASH_SCHEMA,
    role: z.enum(CATALOG_CALIBRATION_ROLES),
    sourceContentHashes: z.array(HASH_SCHEMA).min(1).max(100_000),
    representativeSourceContentHash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    requireCanonicalValues(value.sourceContentHashes, String, "pilot group sources", context);
    if (!value.sourceContentHashes.includes(value.representativeSourceContentHash))
      context.addIssue({
        code: "custom",
        path: ["representativeSourceContentHash"],
        message: "Pilot representative must belong to the leakage group",
      });
  });

export const CATALOG_QUALIFICATION_PILOT_PLAN_SCHEMA = z
  .object({
    kind: z.literal("CatalogQualificationPilotPlan"),
    status: COMPILATION_STATUS_SCHEMA,
    policyHash: HASH_SCHEMA,
    rubricHash: HASH_SCHEMA,
    semanticModuleHash: HASH_SCHEMA,
    semanticLexiconHash: HASH_SCHEMA,
    measurementSetHash: HASH_SCHEMA,
    visualReviewIndexHash: HASH_SCHEMA,
    calibrationSplitHash: HASH_SCHEMA,
    groups: z.array(PILOT_GROUP_SCHEMA).max(30_000),
    selectedSourceContentHashes: z.array(HASH_SCHEMA).max(100_000),
    diagnostics: z.array(z.string().trim().min(1).max(1024)).max(100_000),
    compilerAuthority: z.literal(false),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(value.groups, (entry) => entry.groupHash, "pilot groups", context);
    requireCanonicalValues(value.selectedSourceContentHashes, String, "pilot sources", context);
    requireCanonicalValues(value.diagnostics, String, "pilot diagnostics", context);
    const grouped = canonicalValues(
      value.groups.flatMap((group) => group.sourceContentHashes),
      String,
      "sources across pilot groups",
    );
    if (grouped.join(":") !== value.selectedSourceContentHashes.join(":"))
      context.addIssue({
        code: "custom",
        path: ["selectedSourceContentHashes"],
        message: "Pilot source set does not equal the union of selected groups",
      });
    const expected = value.diagnostics.length === 0 ? "eligible" : "incomplete";
    if (value.status !== expected)
      context.addIssue({ code: "custom", path: ["status"], message: "Pilot status mismatch" });
  });
export type CatalogQualificationPilotPlan = z.output<
  typeof CATALOG_QUALIFICATION_PILOT_PLAN_SCHEMA
>;

export function buildCatalogQualificationPilotPlan(input: {
  readonly policy: CatalogAdmissionPolicy;
  readonly rubricHash: string;
  readonly semanticModuleHash: string;
  readonly semanticLexiconHash: string;
  readonly measurements: CatalogMeasurementSet;
  readonly visualReview: CatalogVisualReviewIndex;
  readonly calibrationSplit: CatalogCalibrationSplit;
}): CatalogQualificationPilotPlan {
  const policy = CATALOG_ADMISSION_POLICY_SCHEMA.parse(input.policy);
  const measurements = CATALOG_MEASUREMENT_SET_SCHEMA.parse(input.measurements);
  const visual = CATALOG_VISUAL_REVIEW_INDEX_SCHEMA.parse(input.visualReview);
  const split = CATALOG_CALIBRATION_SPLIT_SCHEMA.parse(input.calibrationSplit);
  const diagnostics: string[] = [];
  if (measurements.sourceManifestHash !== visual.sourceManifestHash)
    throw new Error("Pilot measurements and renders bind different source manifests");
  if (split.sourceManifestHash !== measurements.sourceManifestHash)
    throw new Error("Pilot calibration split binds a different source manifest");

  const rendered = new Set(visual.items.map((item) => item.sourceContentHash));
  const eligibleSources = new Set(
    measurements.assets
      .filter(
        (asset) =>
          (!policy.pilot.requireStatic || asset.deformation.mode === "static") &&
          (!policy.pilot.requireSinglePart || asset.parts.length === 1) &&
          (!policy.pilot.requireSingleMaterial || asset.materials.length === 1) &&
          (!policy.pilot.requireBottomContact || asset.support.primaryContact === "bottom") &&
          rendered.has(asset.source.contentHash),
      )
      .map((asset) => asset.source.contentHash),
  );
  const roles = new Map(
    split.assignments.map((assignment) => [assignment.groupHash, assignment.role]),
  );
  const candidates = split.groups.filter((group) =>
    group.sourceContentHashes.every((source) => eligibleSources.has(source)),
  );
  const selected: z.output<typeof PILOT_GROUP_SCHEMA>[] = [];
  for (const role of CATALOG_CALIBRATION_ROLES) {
    const ranked = candidates
      .filter((group) => roles.get(group.hash) === role)
      .sort((left, right) =>
        compareCanonicalStrings(
          contentHash(`${policy.pilot.selectionSeedHash}:${role}:${left.hash}`),
          contentHash(`${policy.pilot.selectionSeedHash}:${role}:${right.hash}`),
        ),
      );
    if (ranked.length < policy.pilot.groupsPerRole)
      diagnostics.push(
        `${role} has ${ranked.length} eligible groups; ${policy.pilot.groupsPerRole} are required`,
      );
    for (const group of ranked.slice(0, policy.pilot.groupsPerRole))
      selected.push({
        groupHash: group.hash,
        role,
        sourceContentHashes: group.sourceContentHashes,
        representativeSourceContentHash: selectRepresentative(
          group.sourceContentHashes,
          policy.pilot.selectionSeedHash,
          role,
        ),
      });
  }
  const groups = canonicalValues(selected, (group) => group.groupHash, "pilot groups");
  const sources = canonicalValues(
    groups.flatMap((group) => group.sourceContentHashes),
    String,
    "pilot sources",
  );
  return sealArtifact(CATALOG_QUALIFICATION_PILOT_PLAN_SCHEMA, {
    kind: "CatalogQualificationPilotPlan" as const,
    status: diagnostics.length === 0 ? ("eligible" as const) : ("incomplete" as const),
    policyHash: policy.hash,
    rubricHash: input.rubricHash,
    semanticModuleHash: input.semanticModuleHash,
    semanticLexiconHash: input.semanticLexiconHash,
    measurementSetHash: measurements.hash,
    visualReviewIndexHash: visual.hash,
    calibrationSplitHash: split.hash,
    groups,
    selectedSourceContentHashes: sources,
    diagnostics: canonicalValues(diagnostics, String, "pilot diagnostics"),
    compilerAuthority: false as const,
  });
}

export function pilotGroupsByRole(
  plan: CatalogQualificationPilotPlan,
  role: CatalogCalibrationRole,
): readonly CatalogQualificationPilotPlan["groups"][number][] {
  return plan.groups.filter((group) => group.role === role);
}

function selectRepresentative(
  sources: readonly string[],
  seedHash: string,
  role: CatalogCalibrationRole,
): string {
  return [...sources].sort((left, right) =>
    compareCanonicalStrings(
      contentHash(`${seedHash}:${role}:representative:${left}`),
      contentHash(`${seedHash}:${role}:representative:${right}`),
    ),
  )[0]!;
}
