import { z } from "zod";
import {
  COMPILATION_STATUS_SCHEMA,
  DIAGNOSTIC_SCHEMA,
  HASH_SCHEMA,
  contentHash,
  stableJson,
  type Diagnostic,
  type GateResult,
} from "@basalt/contracts";
import { TRUSTED_SOURCE_MANIFEST_SCHEMA, type TrustedSourceManifest } from "@basalt/catalog-model";
import {
  CATALOG_LEAKAGE_GROUPING_POLICY_SCHEMA,
  type CatalogLeakageGroupingPolicy,
} from "./rubric.js";
import {
  CATALOG_LEAKAGE_ANALYSIS_SCHEMA,
  CATALOG_LEAKAGE_GROUP_SCHEMA,
  buildCatalogLeakageGroups,
  type CatalogLeakageAnalysis,
  type CatalogLeakageGroup,
} from "./leakage.js";
import {
  canonicalValues,
  requireCanonicalValues,
  sealArtifact,
  verifyArtifactHash,
} from "./artifact.js";

export const CATALOG_CALIBRATION_ROLES = ["calibration", "development", "evaluation"] as const;
export const CATALOG_CALIBRATION_ROLE_SCHEMA = z.enum(CATALOG_CALIBRATION_ROLES);
export type CatalogCalibrationRole = z.output<typeof CATALOG_CALIBRATION_ROLE_SCHEMA>;

export const CATALOG_CALIBRATION_ASSIGNMENT_SCHEMA = z
  .object({ groupHash: HASH_SCHEMA, role: CATALOG_CALIBRATION_ROLE_SCHEMA })
  .strict();
export type CatalogCalibrationAssignment = z.output<typeof CATALOG_CALIBRATION_ASSIGNMENT_SCHEMA>;

export const CATALOG_CALIBRATION_TARGET_SCHEMA = z
  .object({
    role: CATALOG_CALIBRATION_ROLE_SCHEMA,
    targetPermille: z.number().int().positive().max(1_000),
  })
  .strict();
export type CatalogCalibrationTarget = z.output<typeof CATALOG_CALIBRATION_TARGET_SCHEMA>;

/** Deterministically balances whole leakage groups by source count. No source
 * origin, filename, semantic prediction, or vendor identity participates. */
export function assignCatalogCalibrationGroups(
  groups: readonly CatalogLeakageGroup[],
  targets: readonly CatalogCalibrationTarget[],
): CatalogCalibrationAssignment[] {
  const canonicalTargets = canonicalValues(
    targets.map((target) => CATALOG_CALIBRATION_TARGET_SCHEMA.parse(target)),
    (target) => target.role,
    "calibration targets",
  );
  const targetByRole = new Map(
    canonicalTargets.map((target) => [target.role, target.targetPermille] as const),
  );
  const loads = new Map<CatalogCalibrationRole, number>(
    CATALOG_CALIBRATION_ROLES.map((role) => [role, 0]),
  );
  const orderedGroups = [...groups].sort(
    (left, right) =>
      right.sourceContentHashes.length - left.sourceContentHashes.length ||
      (left.hash < right.hash ? -1 : left.hash > right.hash ? 1 : 0),
  );
  const assignments = orderedGroups.map((group) => {
    const role = [...CATALOG_CALIBRATION_ROLES].sort((left, right) => {
      const leftTarget = targetByRole.get(left) ?? 0;
      const rightTarget = targetByRole.get(right) ?? 0;
      if (leftTarget === 0 || rightTarget === 0)
        throw new Error("Calibration assignment requires a positive target for every role");
      const leftLoad = (loads.get(left) ?? 0) / leftTarget;
      const rightLoad = (loads.get(right) ?? 0) / rightTarget;
      return leftLoad - rightLoad || (left < right ? -1 : left > right ? 1 : 0);
    })[0]!;
    loads.set(role, (loads.get(role) ?? 0) + group.sourceContentHashes.length);
    return { groupHash: group.hash, role };
  });
  return canonicalValues(
    assignments,
    (assignment) => assignment.groupHash,
    "calibration assignments",
  );
}

export const CATALOG_CALIBRATION_DIAGNOSTIC_SCHEMA = DIAGNOSTIC_SCHEMA.extend({
  gateStatus: z.enum(["incomplete", "rejected"]),
}).strict();
export type CatalogCalibrationDiagnostic = z.output<typeof CATALOG_CALIBRATION_DIAGNOSTIC_SCHEMA>;

export const CATALOG_CALIBRATION_SPLIT_SCHEMA = z
  .object({
    kind: z.literal("CatalogCalibrationSplit"),
    status: COMPILATION_STATUS_SCHEMA,
    sourceManifestHash: HASH_SCHEMA,
    groupingPolicyHash: HASH_SCHEMA,
    leakageAnalysisHash: HASH_SCHEMA,
    groups: z.array(CATALOG_LEAKAGE_GROUP_SCHEMA).max(100_000),
    assignments: z.array(CATALOG_CALIBRATION_ASSIGNMENT_SCHEMA).max(100_000),
    targets: z.array(CATALOG_CALIBRATION_TARGET_SCHEMA).length(3),
    diagnostics: z.array(CATALOG_CALIBRATION_DIAGNOSTIC_SCHEMA).max(100_000),
    compilerAuthority: z.literal(false),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyArtifactHash(value, context);
    requireCanonicalValues(value.groups, (entry) => entry.hash, "leakage groups", context);
    requireCanonicalValues(
      value.assignments,
      (entry) => entry.groupHash,
      "calibration assignments",
      context,
    );
    requireCanonicalValues(value.targets, (entry) => entry.role, "calibration targets", context);
    requireCanonicalValues(value.diagnostics, diagnosticKey, "split diagnostics", context);
    if (
      stableJson(value.targets.map((entry) => entry.role)) !== stableJson(CATALOG_CALIBRATION_ROLES)
    )
      context.addIssue({
        code: "custom",
        path: ["targets"],
        message: "Calibration targets require every role exactly once",
      });
    if (value.targets.reduce((sum, entry) => sum + entry.targetPermille, 0) !== 1_000)
      context.addIssue({
        code: "custom",
        path: ["targets"],
        message: "Calibration targets must total exactly 1000 permille",
      });
    if (value.status !== diagnosticStatus(value.diagnostics))
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Calibration split status does not match its diagnostics",
      });
  });
export type CatalogCalibrationSplit = z.output<typeof CATALOG_CALIBRATION_SPLIT_SCHEMA>;

export function sealCatalogCalibrationSplit(input: {
  readonly sourceManifest: TrustedSourceManifest;
  readonly groupingPolicy: CatalogLeakageGroupingPolicy;
  readonly leakageAnalysis: CatalogLeakageAnalysis;
  readonly assignments: readonly CatalogCalibrationAssignment[];
  readonly targets: readonly CatalogCalibrationTarget[];
}): CatalogCalibrationSplit {
  const manifest = TRUSTED_SOURCE_MANIFEST_SCHEMA.parse(input.sourceManifest);
  const policy = CATALOG_LEAKAGE_GROUPING_POLICY_SCHEMA.parse(input.groupingPolicy);
  const analysis = CATALOG_LEAKAGE_ANALYSIS_SCHEMA.parse(input.leakageAnalysis);
  const material = canonicalSplitMaterial({
    sourceManifestHash: contentHash(stableJson(manifest)),
    groupingPolicyHash: policy.hash,
    leakageAnalysisHash: analysis.hash,
    groups: buildCatalogLeakageGroups(manifest, analysis, policy),
    assignments: [...input.assignments],
    targets: [...input.targets],
  });
  const diagnostics = assessSplit(material, manifest, analysis);
  return sealArtifact(CATALOG_CALIBRATION_SPLIT_SCHEMA, {
    kind: "CatalogCalibrationSplit" as const,
    status: diagnosticStatus(diagnostics),
    ...material,
    diagnostics,
    compilerAuthority: false as const,
  });
}

export function validateCatalogCalibrationSplit(input: {
  readonly split: unknown;
  readonly sourceManifest: TrustedSourceManifest;
  readonly groupingPolicy: CatalogLeakageGroupingPolicy;
  readonly leakageAnalysis: CatalogLeakageAnalysis;
}): GateResult<CatalogCalibrationSplit> {
  const parsed = CATALOG_CALIBRATION_SPLIT_SCHEMA.safeParse(input.split);
  if (!parsed.success)
    return {
      status: "rejected",
      diagnostics: [
        plainDiagnostic("invalid_calibration_split", z.prettifyError(parsed.error), [], []),
      ],
    };
  const expected = sealCatalogCalibrationSplit({
    sourceManifest: input.sourceManifest,
    groupingPolicy: input.groupingPolicy,
    leakageAnalysis: input.leakageAnalysis,
    assignments: parsed.data.assignments,
    targets: parsed.data.targets,
  });
  if (expected.hash !== parsed.data.hash)
    return {
      status: "rejected",
      diagnostics: [
        plainDiagnostic(
          "stale_calibration_split",
          "Calibration split does not match its current source and grouping policy",
          [],
          [parsed.data.hash, expected.hash],
        ),
      ],
    };
  if (parsed.data.status === "eligible")
    return { status: "eligible", value: parsed.data, diagnostics: [] };
  return {
    status: parsed.data.status,
    diagnostics: parsed.data.diagnostics.map(({ gateStatus: _gateStatus, ...entry }) => entry),
  };
}

type SplitMaterial = Omit<
  CatalogCalibrationSplit,
  "kind" | "status" | "diagnostics" | "compilerAuthority" | "hash"
>;

function canonicalSplitMaterial(input: SplitMaterial): SplitMaterial {
  return {
    ...input,
    groups: canonicalValues(
      input.groups.map((entry) => CATALOG_LEAKAGE_GROUP_SCHEMA.parse(entry)),
      (entry) => entry.hash,
      "leakage groups",
    ),
    assignments: canonicalValues(
      input.assignments.map((entry) => CATALOG_CALIBRATION_ASSIGNMENT_SCHEMA.parse(entry)),
      (entry) => entry.groupHash,
      "calibration assignments",
    ),
    targets: canonicalValues(
      input.targets.map((entry) => CATALOG_CALIBRATION_TARGET_SCHEMA.parse(entry)),
      (entry) => entry.role,
      "calibration targets",
    ),
  };
}

function assessSplit(
  split: SplitMaterial,
  manifest: TrustedSourceManifest,
  analysis: CatalogLeakageAnalysis,
): CatalogCalibrationDiagnostic[] {
  const diagnostics: CatalogCalibrationDiagnostic[] = [];
  const expectedManifestHash = contentHash(stableJson(manifest));
  if (split.sourceManifestHash !== expectedManifestHash)
    diagnostics.push(
      calibrationDiagnostic(
        "source_manifest_binding_mismatch",
        "Calibration split must bind the exact source identity manifest",
        "rejected",
        ["sourceManifestHash"],
        [split.sourceManifestHash, expectedManifestHash],
      ),
    );
  if (split.leakageAnalysisHash !== analysis.hash)
    diagnostics.push(
      calibrationDiagnostic(
        "leakage_analysis_binding_mismatch",
        "Calibration split must bind the exact physical leakage analysis",
        "rejected",
        ["leakageAnalysisHash"],
        [split.leakageAnalysisHash, analysis.hash],
      ),
    );
  if (analysis.groupingPolicyHash !== split.groupingPolicyHash)
    diagnostics.push(
      calibrationDiagnostic(
        "leakage_policy_binding_mismatch",
        "Leakage analysis and calibration split bind different grouping policies",
        "rejected",
        ["groupingPolicyHash"],
        [split.groupingPolicyHash, analysis.groupingPolicyHash],
      ),
    );
  if (analysis.status !== "eligible")
    diagnostics.push(
      calibrationDiagnostic(
        "leakage_analysis_not_eligible",
        `Physical leakage analysis is ${analysis.status}`,
        analysis.status,
        ["leakageAnalysisHash"],
        [analysis.hash],
      ),
    );

  const expectedSources = new Set(manifest.assets.map((asset) => asset.contentHash));
  const memberCounts = new Map<string, number>();
  for (const [groupIndex, group] of split.groups.entries())
    for (const sourceHash of group.sourceContentHashes) {
      memberCounts.set(sourceHash, (memberCounts.get(sourceHash) ?? 0) + 1);
      if (!expectedSources.has(sourceHash))
        diagnostics.push(
          calibrationDiagnostic(
            "unknown_split_source",
            `Leakage group references unknown source identity ${sourceHash}`,
            "rejected",
            ["groups", groupIndex, "sourceContentHashes"],
            [sourceHash],
          ),
        );
    }
  const duplicated = [...memberCounts].filter(([, count]) => count > 1);
  if (duplicated.length > 0)
    diagnostics.push(
      calibrationDiagnostic(
        "overlapping_leakage_groups",
        `${duplicated.length} source identities occur in more than one leakage group`,
        "rejected",
        ["groups"],
        duplicated.map(([hash]) => hash).slice(0, 256),
      ),
    );
  const missingCount = manifest.assets.filter(
    (asset) => !memberCounts.has(asset.contentHash),
  ).length;
  if (missingCount > 0)
    diagnostics.push(
      calibrationDiagnostic(
        "incomplete_leakage_partition",
        `${missingCount} source identities still need physical near-duplicate grouping evidence`,
        "incomplete",
        ["groups"],
      ),
    );

  const groupHashes = new Set(split.groups.map((group) => group.hash));
  const assignmentHashes = new Set(split.assignments.map((entry) => entry.groupHash));
  const missingAssignments = split.groups.filter(
    (group) => !assignmentHashes.has(group.hash),
  ).length;
  if (missingAssignments > 0)
    diagnostics.push(
      calibrationDiagnostic(
        "unassigned_leakage_groups",
        `${missingAssignments} leakage groups do not have a calibration role`,
        "incomplete",
        ["assignments"],
      ),
    );
  for (const [index, assignment] of split.assignments.entries())
    if (!groupHashes.has(assignment.groupHash))
      diagnostics.push(
        calibrationDiagnostic(
          "unknown_leakage_group_assignment",
          `Assignment references unknown leakage group ${assignment.groupHash}`,
          "rejected",
          ["assignments", index],
          [assignment.groupHash],
        ),
      );
  for (const role of CATALOG_CALIBRATION_ROLES)
    if (!split.assignments.some((entry) => entry.role === role))
      diagnostics.push(
        calibrationDiagnostic(
          "empty_calibration_role",
          `Calibration role ${role} has no assigned leakage groups`,
          "incomplete",
          ["assignments"],
        ),
      );
  return canonicalValues(diagnostics, diagnosticKey, "split diagnostics");
}

function calibrationDiagnostic(
  code: string,
  message: string,
  gateStatus: "incomplete" | "rejected",
  path: readonly (string | number)[],
  evidenceHashes: readonly string[] = [],
): CatalogCalibrationDiagnostic {
  return CATALOG_CALIBRATION_DIAGNOSTIC_SCHEMA.parse({
    code,
    message,
    path,
    evidenceHashes: canonicalValues(evidenceHashes, String, "diagnostic evidence"),
    gateStatus,
  });
}

function plainDiagnostic(
  code: string,
  message: string,
  path: readonly (string | number)[],
  evidenceHashes: readonly string[],
): Diagnostic {
  return DIAGNOSTIC_SCHEMA.parse({ code, message, path, evidenceHashes });
}

function diagnosticStatus(
  diagnostics: readonly CatalogCalibrationDiagnostic[],
): "eligible" | "incomplete" | "rejected" {
  if (diagnostics.some((entry) => entry.gateStatus === "rejected")) return "rejected";
  return diagnostics.length > 0 ? "incomplete" : "eligible";
}

function diagnosticKey(value: CatalogCalibrationDiagnostic): string {
  return stableJson(value);
}
