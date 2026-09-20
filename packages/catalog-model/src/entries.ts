import { z } from "zod";
import {
  COMPILATION_STATUS_SCHEMA,
  HASH_SCHEMA,
  compareCanonicalStrings,
  contentHash,
  deepFreezeJson,
  stableJson,
  type CompilationStatus,
} from "@basalt/contracts";
import {
  AFFORDANCE_ID_SCHEMA,
  CONCEPT_COMMITMENT_REFERENCE_SCHEMA,
  EVIDENCE_LEVEL_SCHEMA,
  REALIZATION_FORM_SCHEMA,
  ROLE_ID_SCHEMA,
  ROLE_SCHEME_ID_SCHEMA,
  SEMANTIC_ADMITTED_ASSERTION_BUNDLE_SCHEMA,
  STATE_DIMENSION_ID_SCHEMA,
  STATE_VALUE_ID_SCHEMA,
  SURFACE_TREATMENT_ID_SCHEMA,
  createSemanticDependencyClosure,
  evidenceSatisfies,
  validateAdmittedSemanticAssertions,
  type SemanticAssertionBundle,
  type SemanticModule,
} from "@basalt/semantic-kernel";
import type { CatalogAssetArtifact } from "./assets.js";
import {
  CATALOG_AABB_FIXED_SCHEMA,
  ENTRY_HANDLE_SCHEMA,
  INTERFACE_ID_SCHEMA,
  MEMBER_ID_SCHEMA,
  PLACEMENT_SIGNATURE_SCHEMA,
  POSITIVE_Q32_SCHEMA,
  SOCKET_POLARITY_SCHEMA,
  STYLE_PROFILE_HANDLE_SCHEMA,
  canonicalUniqueStrings,
  type CatalogEntryKind,
} from "./primitives.js";
import type { SealedStyleProfile } from "./styles.js";

export const CATALOG_ENTRY_VALIDATOR_BY_KIND = Object.freeze({
  substitution_set: "validate_substitution_set",
  assembly_kit: "validate_assembly_kit",
  attachment_set: "validate_attachment_set",
  route_kit: "validate_route_kit",
  environment_realizer: "validate_environment_realizer",
  collection: "validate_collection",
} satisfies Record<CatalogEntryKind, string>);

export const CATALOG_SEMANTIC_SIGNATURE_SCHEMA = z
  .object({
    denotation: CONCEPT_COMMITMENT_REFERENCE_SCHEMA,
    realizationForm: REALIZATION_FORM_SCHEMA,
    fixedStates: z.array(
      z
        .object({
          stateDimensionId: STATE_DIMENSION_ID_SCHEMA,
          stateValueId: STATE_VALUE_ID_SCHEMA,
        })
        .strict(),
    ),
    affordances: z.array(
      z
        .object({ affordanceId: AFFORDANCE_ID_SCHEMA, evidenceLevel: EVIDENCE_LEVEL_SCHEMA })
        .strict(),
    ),
    surfaceTreatmentIds: z.array(SURFACE_TREATMENT_ID_SCHEMA),
    dependencyClosureHash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    canonicalArray(value.fixedStates, (entry) => entry.stateDimensionId, "fixed states", context);
    canonicalArray(value.affordances, (entry) => entry.affordanceId, "affordances", context);
    canonicalArray(value.surfaceTreatmentIds, (entry) => entry, "surface treatments", context);
  });
export type CatalogSemanticSignature = z.output<typeof CATALOG_SEMANTIC_SIGNATURE_SCHEMA>;

const socketBinding = z
  .object({
    socketId: z.string().min(1).max(128),
    interfaceId: INTERFACE_ID_SCHEMA,
    polarity: SOCKET_POLARITY_SCHEMA,
  })
  .strict();
const catalogMember = z
  .object({
    memberId: MEMBER_ID_SCHEMA,
    assetHash: HASH_SCHEMA,
    assertionBundleHash: HASH_SCHEMA,
    selectionWeight: z.number().int().positive().safe(),
    socketBindings: z.array(socketBinding),
  })
  .strict();
const interfaceDeclaration = z
  .object({ interfaceId: INTERFACE_ID_SCHEMA, polarity: SOCKET_POLARITY_SCHEMA })
  .strict();
const runtimeBase = {
  handle: ENTRY_HANDLE_SCHEMA,
  semantic: CATALOG_SEMANTIC_SIGNATURE_SCHEMA,
  placement: PLACEMENT_SIGNATURE_SCHEMA,
  styleProfileHandle: STYLE_PROFILE_HANDLE_SCHEMA,
  evidenceHashes: z.array(HASH_SCHEMA),
};
const provider = z
  .object({
    roleSchemeId: ROLE_SCHEME_ID_SCHEMA,
    roleId: ROLE_ID_SCHEMA,
    providerHandles: z.array(ENTRY_HANDLE_SCHEMA).min(1),
    minimumCount: z.number().int().nonnegative().safe(),
    maximumCount: z.number().int().positive().safe(),
    socketBindings: z.array(
      z
        .object({
          providerSocketId: z.string().min(1).max(128),
          interfaceId: INTERFACE_ID_SCHEMA,
        })
        .strict(),
    ),
  })
  .strict()
  .refine((value) => value.minimumCount <= value.maximumCount, "Provider count is inverted");

const substitutionSetDeclaration = z
  .object({
    kind: z.literal("substitution_set"),
    ...runtimeBase,
    members: z.array(catalogMember).min(1),
  })
  .strict();
const assemblyKitDeclaration = z
  .object({
    kind: z.literal("assembly_kit"),
    ...runtimeBase,
    roleSchemeId: ROLE_SCHEME_ID_SCHEMA,
    providers: z.array(provider).min(1),
    interfaces: z.array(interfaceDeclaration),
    allowedMates: z.array(
      z
        .object({ firstInterfaceId: INTERFACE_ID_SCHEMA, secondInterfaceId: INTERFACE_ID_SCHEMA })
        .strict(),
    ),
    transitions: z
      .array(
        z
          .object({
            fromRoleId: ROLE_ID_SCHEMA,
            toRoleId: ROLE_ID_SCHEMA,
            hostInterfaceId: INTERFACE_ID_SCHEMA,
            childInterfaceId: INTERFACE_ID_SCHEMA,
          })
          .strict(),
      )
      .min(1),
    topology: z
      .object({
        connectivity: z.literal("connected"),
        cyclePolicy: z.enum(["forbidden", "permitted"]),
        minimumConnections: z.number().int().nonnegative().safe(),
      })
      .strict(),
    lattice: z
      .object({
        pitchMeters: POSITIVE_Q32_SCHEMA,
        authority: z.enum(["authored", "measured"]),
        evidenceHash: HASH_SCHEMA.optional(),
      })
      .strict(),
    terminalRoleIds: z.array(ROLE_ID_SCHEMA),
    requiredCoverageRoleIds: z.array(ROLE_ID_SCHEMA),
  })
  .strict();
const attachmentSetDeclaration = z
  .object({
    kind: z.literal("attachment_set"),
    ...runtimeBase,
    members: z.array(catalogMember).min(1),
    acceptedHostSupports: z.array(PLACEMENT_SIGNATURE_SCHEMA.shape.support).min(1),
    acceptedHostInterfaceIds: z.array(INTERFACE_ID_SCHEMA),
  })
  .strict();
const routeKitDeclaration = z
  .object({
    kind: z.literal("route_kit"),
    ...runtimeBase,
    roleSchemeId: ROLE_SCHEME_ID_SCHEMA,
    components: z
      .array(
        z
          .object({
            roleId: ROLE_ID_SCHEMA,
            topology: z.enum([
              "straight",
              "curve",
              "terminal",
              "junction",
              "crossing",
              "bridge",
              "tunnel",
            ]),
            providerHandles: z.array(ENTRY_HANDLE_SCHEMA).min(1),
          })
          .strict(),
      )
      .min(1),
    segmentLengthMeters: POSITIVE_Q32_SCHEMA,
    allowedTransitions: z.array(
      z.object({ fromRoleId: ROLE_ID_SCHEMA, toRoleId: ROLE_ID_SCHEMA }).strict(),
    ),
  })
  .strict();
const environmentRealizerDeclaration = z
  .object({
    kind: z.literal("environment_realizer"),
    ...runtimeBase,
    members: z.array(catalogMember).min(1),
    modes: z.array(z.enum(["sky", "atmosphere", "water_surface", "overhead", "far_field"])).min(1),
  })
  .strict();
const collectionDeclaration = z
  .object({
    kind: z.literal("collection"),
    handle: ENTRY_HANDLE_SCHEMA,
    entryHandles: z.array(ENTRY_HANDLE_SCHEMA).min(1),
  })
  .strict();

export const CATALOG_ENTRY_DECLARATION_SCHEMA = z.discriminatedUnion("kind", [
  substitutionSetDeclaration,
  assemblyKitDeclaration,
  attachmentSetDeclaration,
  routeKitDeclaration,
  environmentRealizerDeclaration,
  collectionDeclaration,
]);
export type CatalogEntryDeclaration = z.output<typeof CATALOG_ENTRY_DECLARATION_SCHEMA>;

const sealedBase = {
  handle: ENTRY_HANDLE_SCHEMA,
  childEntries: z.array(z.object({ handle: ENTRY_HANDLE_SCHEMA, entryHash: HASH_SCHEMA }).strict()),
  descendantAssetHashes: z.array(HASH_SCHEMA),
  triangleCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sourceBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  declarationHash: HASH_SCHEMA,
  entryHash: HASH_SCHEMA,
};
const sealedRuntimeBase = {
  ...sealedBase,
  semantic: CATALOG_SEMANTIC_SIGNATURE_SCHEMA,
  placement: PLACEMENT_SIGNATURE_SCHEMA,
  styleProfileHandle: STYLE_PROFILE_HANDLE_SCHEMA,
  styleProfileHash: HASH_SCHEMA,
  evidenceHashes: z.array(HASH_SCHEMA),
  memberAssets: z.array(
    z
      .object({
        memberId: MEMBER_ID_SCHEMA,
        assetHash: HASH_SCHEMA,
        assertionBundleHash: HASH_SCHEMA,
        selectionWeight: z.number().int().positive(),
        socketBindings: z.array(socketBinding),
        bounds: CATALOG_AABB_FIXED_SCHEMA,
        triangleCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        sourceBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        rights: z
          .object({
            commercialUsePermitted: z.boolean(),
            redistributionPermitted: z.boolean(),
            licenseId: z.string().trim().min(1).max(160),
          })
          .strict(),
      })
      .strict(),
  ),
  metricEnvelope: CATALOG_AABB_FIXED_SCHEMA.optional(),
  rights: z
    .object({
      commercialUsePermitted: z.boolean(),
      redistributionPermitted: z.boolean(),
      licenseIds: z.array(z.string().trim().min(1).max(160)),
    })
    .strict(),
};

const sealedEntryVariants = [
  z
    .object({
      kind: z.literal("substitution_set"),
      ...sealedRuntimeBase,
      declaration: substitutionSetDeclaration,
    })
    .strict(),
  z
    .object({
      kind: z.literal("assembly_kit"),
      ...sealedRuntimeBase,
      declaration: assemblyKitDeclaration,
    })
    .strict(),
  z
    .object({
      kind: z.literal("attachment_set"),
      ...sealedRuntimeBase,
      declaration: attachmentSetDeclaration,
    })
    .strict(),
  z
    .object({
      kind: z.literal("route_kit"),
      ...sealedRuntimeBase,
      declaration: routeKitDeclaration,
    })
    .strict(),
  z
    .object({
      kind: z.literal("environment_realizer"),
      ...sealedRuntimeBase,
      declaration: environmentRealizerDeclaration,
    })
    .strict(),
  z
    .object({ kind: z.literal("collection"), ...sealedBase, declaration: collectionDeclaration })
    .strict(),
] as const;
export const SEALED_CATALOG_ENTRY_SCHEMA = z
  .discriminatedUnion("kind", sealedEntryVariants)
  .superRefine((value, context) => {
    const { entryHash: _entryHash, ...material } = value;
    if (contentHash(stableJson(material)) !== value.entryHash)
      context.addIssue({
        code: "custom",
        path: ["entryHash"],
        message: "Catalog entry hash mismatch",
      });
  });
export type SealedCatalogEntry = z.output<typeof SEALED_CATALOG_ENTRY_SCHEMA>;
export type SealedRuntimeCatalogEntry = Exclude<SealedCatalogEntry, { kind: "collection" }>;

export const CATALOG_DISPOSITION_SCHEMA = z.discriminatedUnion("status", [
  z
    .object({
      sourceContentHash: HASH_SCHEMA,
      status: z.literal("eligible"),
      usage: z.discriminatedUnion("kind", [
        z
          .object({
            kind: z.literal("entry_member"),
            entryHandle: ENTRY_HANDLE_SCHEMA,
            memberId: MEMBER_ID_SCHEMA,
          })
          .strict(),
        z
          .object({
            kind: z.literal("collision_companion"),
            ownerSourceContentHash: HASH_SCHEMA,
          })
          .strict(),
      ]),
    })
    .strict(),
  z
    .object({
      sourceContentHash: HASH_SCHEMA,
      status: z.literal("incomplete"),
      reason: z.string().trim().min(1).max(1024),
    })
    .strict(),
  z
    .object({
      sourceContentHash: HASH_SCHEMA,
      status: z.literal("rejected"),
      reason: z.string().trim().min(1).max(1024),
    })
    .strict(),
]);
export type CatalogDisposition = z.output<typeof CATALOG_DISPOSITION_SCHEMA>;

export const CATALOG_SNAPSHOT_SCHEMA = z
  .object({
    kind: z.literal("CatalogSnapshot"),
    status: COMPILATION_STATUS_SCHEMA,
    semanticKernelHash: HASH_SCHEMA,
    semanticClosureHashes: z.array(HASH_SCHEMA),
    styleProfiles: z
      .array(z.object({ handle: STYLE_PROFILE_HANDLE_SCHEMA, hash: HASH_SCHEMA }).strict())
      .min(1),
    entries: z.array(SEALED_CATALOG_ENTRY_SCHEMA),
    eligibleAssetArtifactHashes: z.array(HASH_SCHEMA),
    sourceIdentityCount: z.number().int().nonnegative().safe(),
    dispositionsHash: HASH_SCHEMA,
    diagnostics: z.array(z.string().min(1).max(1024)),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    const { hash: _hash, ...material } = value;
    if (contentHash(stableJson(material)) !== value.hash)
      context.addIssue({
        code: "custom",
        path: ["hash"],
        message: "Catalog snapshot hash mismatch",
      });
  });
export type CatalogSnapshot = z.output<typeof CATALOG_SNAPSHOT_SCHEMA>;

export interface SealCatalogSnapshotInput {
  readonly semanticModule: SemanticModule;
  readonly semanticAssertions: readonly Extract<
    SemanticAssertionBundle,
    { authority: "admitted" }
  >[];
  readonly styleProfiles: readonly SealedStyleProfile[];
  readonly assets: readonly CatalogAssetArtifact[];
  readonly declarations: readonly CatalogEntryDeclaration[];
  readonly dispositions: readonly CatalogDisposition[];
  readonly sourceContentHashes: readonly string[];
}

export function sealCatalogSnapshot(input: SealCatalogSnapshotInput): CatalogSnapshot {
  const styles = uniqueMap(input.styleProfiles, (entry) => entry.handle, "style profile");
  const assets = uniqueMap(input.assets, (entry) => entry.hash, "asset artifact");
  if (new Set(input.assets.map((entry) => entry.source.contentHash)).size !== input.assets.length)
    throw new Error("Catalog measurements repeat source content identities");
  const assertions = uniqueMap(
    input.semanticAssertions.map((entry) => SEMANTIC_ADMITTED_ASSERTION_BUNDLE_SCHEMA.parse(entry)),
    (entry) => entry.hash,
    "semantic assertion bundle",
  );
  const subjectSorts = assertionSubjectSorts(input.semanticModule, [...assertions.values()]);
  for (const bundle of assertions.values())
    validateAdmittedSemanticAssertions({
      module: input.semanticModule,
      bundle,
      resolveExternalSubjectSort: (subject) => subjectSorts.get(`${subject.kind}:${subject.id}`),
    });

  const sourceHashes = canonicalUniqueStrings(input.sourceContentHashes, "source identities");
  const dispositions = input.dispositions.map((entry) => CATALOG_DISPOSITION_SCHEMA.parse(entry));
  const dispositionBySource = uniqueMap(
    dispositions,
    (entry) => entry.sourceContentHash,
    "source disposition",
  );
  if (
    sourceHashes.length !== dispositionBySource.size ||
    sourceHashes.some((hash) => !dispositionBySource.has(hash))
  )
    throw new Error("Every source content identity requires exactly one disposition");

  const declarations = input.declarations
    .map(canonicalDeclaration)
    .sort((a, b) => compareCanonicalStrings(a.handle, b.handle));
  const declared = uniqueMap(declarations, (entry) => entry.handle, "catalog entry handle");
  assertAcyclicComposition(declared);
  const sealed = new Map<string, SealedCatalogEntry>();
  const sealOne = (handle: string): SealedCatalogEntry => {
    const cached = sealed.get(handle);
    if (cached) return cached;
    const declaration = declared.get(handle);
    if (!declaration) throw new Error(`Catalog composition references unknown entry: ${handle}`);
    const children = childHandles(declaration).map((childHandle) => ({
      handle: childHandle,
      entryHash: sealOne(childHandle).entryHash,
    }));
    const members = "members" in declaration ? declaration.members : [];
    const memberAssets = members.map((member) => {
      const asset = assets.get(member.assetHash);
      if (!asset)
        throw new Error(`Catalog entry ${handle} references unknown asset ${member.assetHash}`);
      const disposition = dispositionBySource.get(asset.source.contentHash);
      if (
        disposition?.status !== "eligible" ||
        disposition.usage.kind !== "entry_member" ||
        disposition.usage.entryHandle !== handle ||
        disposition.usage.memberId !== member.memberId
      )
        throw new Error(
          `Catalog member ${handle}/${member.memberId} lacks its exact eligible disposition`,
        );
      const bundle = assertions.get(member.assertionBundleHash);
      if (!bundle || bundle.authority !== "admitted")
        throw new Error(
          `Catalog member ${handle}/${member.memberId} lacks admitted semantic assertions`,
        );
      if (declaration.kind !== "collection") {
        validateSemanticSignature(declaration.semantic, asset, bundle, input.semanticModule);
        validatePlacement(declaration.placement, member, asset, declaration.kind);
      }
      return {
        ...member,
        bounds: asset.bounds,
        triangleCount: asset.parts.reduce((sum, part) => sum + part.triangleCount, 0),
        sourceBytes: asset.source.sourceArtifact?.bytes ?? 0,
        rights: {
          commercialUsePermitted: asset.source.rights.commercialUsePermitted,
          redistributionPermitted: asset.source.rights.redistributionPermitted,
          licenseId: asset.source.rights.licenseId,
        },
      };
    });
    if (
      new Set(memberAssets.map((entry) => entry.memberId)).size !== memberAssets.length ||
      new Set(memberAssets.map((entry) => entry.assetHash)).size !== memberAssets.length
    )
      throw new Error(`Catalog entry repeats members or assets: ${handle}`);
    for (const member of memberAssets) {
      uniqueValues(
        member.socketBindings.map((binding) => binding.socketId),
        `Catalog member ${handle}/${member.memberId} socket IDs`,
      );
      uniqueValues(
        member.socketBindings.map((binding) => binding.interfaceId),
        `Catalog member ${handle}/${member.memberId} interface IDs`,
      );
    }
    validateEntryGrammar(declaration, declared, input.semanticModule);
    const descendantAssets = [
      ...memberAssets.map((member) => assets.get(member.assetHash)!),
      ...children.flatMap((child) =>
        sealOne(child.handle).descendantAssetHashes.map((hash) => assets.get(hash)!),
      ),
    ];
    const uniqueAssets = [
      ...new Map(descendantAssets.map((entry) => [entry.hash, entry])).values(),
    ].sort((a, b) => compareCanonicalStrings(a.hash, b.hash));
    const declarationHash = contentHash(stableJson(declaration));
    const common = {
      kind: declaration.kind,
      handle,
      childEntries: children,
      descendantAssetHashes: uniqueAssets.map((entry) => entry.hash),
      triangleCount: uniqueAssets.reduce(
        (sum, asset) =>
          sum + asset.parts.reduce((partSum, part) => partSum + part.triangleCount, 0),
        0,
      ),
      sourceBytes: uniqueAssets.reduce(
        (sum, asset) => sum + (asset.source.sourceArtifact?.bytes ?? 0),
        0,
      ),
      declarationHash,
      declaration,
    };
    const envelope = envelopeOf(uniqueAssets.map((entry) => entry.bounds));
    const material =
      declaration.kind === "collection"
        ? common
        : {
            ...common,
            semantic: declaration.semantic,
            placement: declaration.placement,
            styleProfileHandle: declaration.styleProfileHandle,
            styleProfileHash: required(styles, declaration.styleProfileHandle, "style profile")
              .hash,
            evidenceHashes: canonicalUniqueStrings(
              [
                ...declaration.evidenceHashes,
                ...memberAssets.map((entry) => entry.assertionBundleHash),
              ],
              `${handle} evidence`,
            ),
            memberAssets,
            ...(envelope ? { metricEnvelope: envelope } : {}),
            rights: {
              commercialUsePermitted: uniqueAssets.every(
                (entry) => entry.source.rights.commercialUsePermitted,
              ),
              redistributionPermitted: uniqueAssets.every(
                (entry) => entry.source.rights.redistributionPermitted,
              ),
              licenseIds: canonicalUniqueStrings(
                [...new Set(uniqueAssets.map((entry) => entry.source.rights.licenseId))],
                `${handle} licenses`,
              ),
            },
          };
    const entry = SEALED_CATALOG_ENTRY_SCHEMA.parse({
      ...material,
      entryHash: contentHash(stableJson(material)),
    });
    sealed.set(handle, entry);
    return entry;
  };
  for (const handle of [...declared.keys()].sort(compareCanonicalStrings)) sealOne(handle);
  validateEligibleDispositions(dispositions, sealed, assets);
  const entries = [...sealed.values()].sort((a, b) => compareCanonicalStrings(a.handle, b.handle));
  const diagnostics = dispositions
    .filter((entry) => entry.status === "incomplete")
    .map((entry) => `${entry.sourceContentHash}: ${entry.reason}`)
    .sort(compareCanonicalStrings);
  const status: CompilationStatus = diagnostics.length > 0 ? "incomplete" : "eligible";
  const semanticClosureHashes = canonicalUniqueStrings(
    [
      ...new Set(
        entries.flatMap((entry) =>
          entry.kind === "collection" ? [] : [entry.semantic.dependencyClosureHash],
        ),
      ),
    ],
    "semantic closure hashes",
  );
  const bySource = new Map(
    [...assets.values()].map((entry) => [entry.source.contentHash, entry] as const),
  );
  const eligibleAssetArtifactHashes = canonicalUniqueStrings(
    dispositions.flatMap((entry) => {
      if (entry.status !== "eligible") return [];
      const asset = bySource.get(entry.sourceContentHash);
      return asset ? [asset.hash] : [];
    }),
    "eligible asset hashes",
  );
  const canonicalDispositions = [...dispositions].sort((a, b) =>
    compareCanonicalStrings(a.sourceContentHash, b.sourceContentHash),
  );
  const material = {
    kind: "CatalogSnapshot" as const,
    status,
    semanticKernelHash: input.semanticModule.kernel.hash,
    semanticClosureHashes,
    styleProfiles: [...styles.values()]
      .map((entry) => ({ handle: entry.handle, hash: entry.hash }))
      .sort((a, b) => compareCanonicalStrings(a.handle, b.handle)),
    entries,
    eligibleAssetArtifactHashes,
    sourceIdentityCount: sourceHashes.length,
    dispositionsHash: contentHash(stableJson(canonicalDispositions)),
    diagnostics,
  };
  return deepFreezeJson(
    CATALOG_SNAPSHOT_SCHEMA.parse({ ...material, hash: contentHash(stableJson(material)) }),
  ) as CatalogSnapshot;
}

function assertionSubjectSorts(
  module: SemanticModule,
  bundles: readonly Extract<SemanticAssertionBundle, { authority: "admitted" }>[],
) {
  const concepts = new Map(module.concepts.map((entry) => [entry.conceptId, entry]));
  const result = new Map<string, (typeof module.concepts)[number]["upperSort"]>();
  for (const bundle of bundles) {
    for (const assertion of bundle.assertions) {
      if (assertion.assertionKind !== "denotation") continue;
      const concept = concepts.get(assertion.concept.conceptId);
      if (!concept || concept.commitmentHash !== assertion.concept.commitmentHash)
        throw new Error(`Unknown denotation commitment ${assertion.concept.conceptId}`);
      const key = `${assertion.subject.kind}:${assertion.subject.id}`;
      if (result.has(key)) throw new Error(`Catalog subject ${key} has multiple denotations`);
      result.set(key, concept.upperSort);
    }
  }
  return result;
}

function validateSemanticSignature(
  signature: CatalogSemanticSignature,
  asset: CatalogAssetArtifact,
  bundle: Extract<SemanticAssertionBundle, { authority: "admitted" }>,
  module: SemanticModule,
): void {
  const definitionIds = [
    signature.realizationForm,
    ...signature.affordances.map((entry) => entry.affordanceId),
    ...signature.fixedStates.flatMap((entry) => [entry.stateDimensionId, entry.stateValueId]),
    ...signature.surfaceTreatmentIds,
  ];
  const closure = createSemanticDependencyClosure({
    module,
    conceptIds: [signature.denotation.conceptId],
    definitionIds,
  });
  if (closure.hash !== signature.dependencyClosureHash)
    throw new Error(`Semantic signature closure mismatch for ${asset.assetId}`);
  const assertions = bundle.assertions.filter(
    (entry) => entry.subject.kind === "catalog_asset" && entry.subject.id === asset.assetId,
  );
  const denotation = assertions.find((entry) => entry.assertionKind === "denotation");
  if (
    !denotation ||
    denotation.concept.conceptId !== signature.denotation.conceptId ||
    denotation.concept.commitmentHash !== signature.denotation.commitmentHash
  )
    throw new Error(`Asset ${asset.assetId} does not prove the exact denotation commitment`);
  if (
    !assertions.some(
      (entry) =>
        entry.assertionKind === "realization_form" &&
        entry.realizationForm === signature.realizationForm,
    )
  )
    throw new Error(
      `Asset ${asset.assetId} does not prove realization form ${signature.realizationForm}`,
    );
  for (const state of signature.fixedStates)
    if (
      !assertions.some(
        (entry) =>
          entry.assertionKind === "state" &&
          entry.stateDimensionId === state.stateDimensionId &&
          entry.stateValueId === state.stateValueId,
      )
    )
      throw new Error(`Asset ${asset.assetId} does not prove fixed state ${state.stateValueId}`);
  for (const treatmentId of signature.surfaceTreatmentIds)
    if (
      !assertions.some(
        (entry) =>
          entry.assertionKind === "surface_treatment" && entry.surfaceTreatmentId === treatmentId,
      )
    )
      throw new Error(`Asset ${asset.assetId} does not prove treatment ${treatmentId}`);
  for (const affordance of signature.affordances) {
    const observed = assertions.find(
      (entry) =>
        entry.assertionKind === "affordance" && entry.affordanceId === affordance.affordanceId,
    );
    if (!observed || !evidenceSatisfies(observed.evidence.level, affordance.evidenceLevel))
      throw new Error(`Asset ${asset.assetId} lacks ${affordance.affordanceId} evidence`);
  }
}

function validatePlacement(
  placement: z.output<typeof PLACEMENT_SIGNATURE_SCHEMA>,
  member: z.output<typeof catalogMember>,
  asset: CatalogAssetArtifact,
  entryKind: CatalogEntryKind,
): void {
  const contacts = {
    ground: "bottom",
    surface: "bottom",
    wall: "lateral_wall",
    ceiling: "top_ceiling",
    socket: "socket_only",
  } as const;
  if (
    placement.support in contacts &&
    asset.support.primaryContact !== contacts[placement.support as keyof typeof contacts]
  )
    throw new Error(
      `Asset ${asset.assetId} contact does not satisfy ${placement.support} placement`,
    );
  if (placement.support === "environment" && entryKind !== "environment_realizer")
    throw new Error("Environment placement is reserved for environment realizers");
  const socketIds = new Set(asset.sockets.map((entry) => entry.socketId));
  for (const binding of member.socketBindings)
    if (!socketIds.has(binding.socketId))
      throw new Error(`Asset ${asset.assetId} lacks socket ${binding.socketId}`);
  for (const requiredInterface of placement.interfaces)
    if (
      !member.socketBindings.some(
        (entry) =>
          entry.interfaceId === requiredInterface.interfaceId &&
          entry.polarity === requiredInterface.polarity,
      )
    )
      throw new Error(`Asset ${asset.assetId} lacks interface ${requiredInterface.interfaceId}`);
}

function validateEntryGrammar(
  declaration: CatalogEntryDeclaration,
  declared: ReadonlyMap<string, CatalogEntryDeclaration>,
  module: SemanticModule,
): void {
  if (declaration.kind === "collection") return;
  const concept = module.concepts.find(
    (entry) => entry.conceptId === declaration.semantic.denotation.conceptId,
  );
  if (!concept || concept.commitmentHash !== declaration.semantic.denotation.commitmentHash)
    throw new Error(`Entry ${declaration.handle} references an unknown semantic commitment`);
  if (declaration.kind === "assembly_kit" || declaration.kind === "route_kit") {
    const scheme = module.roleSchemes.find(
      (entry) => entry.roleSchemeId === declaration.roleSchemeId,
    );
    if (!scheme) throw new Error(`Entry ${declaration.handle} references unknown role scheme`);
    const roles = new Set(scheme.roles.map((entry) => entry.roleId));
    const used =
      declaration.kind === "assembly_kit"
        ? [
            ...declaration.providers.map((entry) => entry.roleId),
            ...declaration.transitions.flatMap((entry) => [entry.fromRoleId, entry.toRoleId]),
            ...declaration.terminalRoleIds,
            ...declaration.requiredCoverageRoleIds,
          ]
        : [
            ...declaration.components.map((entry) => entry.roleId),
            ...declaration.allowedTransitions.flatMap((entry) => [
              entry.fromRoleId,
              entry.toRoleId,
            ]),
          ];
    if (used.some((roleId) => !roles.has(roleId)))
      throw new Error(`Entry ${declaration.handle} uses a role outside ${scheme.roleSchemeId}`);
  }
  if (declaration.kind === "assembly_kit") {
    uniqueValues(
      declaration.providers.map((entry) => entry.roleId),
      `Assembly kit ${declaration.handle} provider roles`,
    );
    uniqueValues(
      declaration.interfaces.map((entry) => entry.interfaceId),
      `Assembly kit ${declaration.handle} interfaces`,
    );
    uniqueValues(
      declaration.allowedMates.map(
        (entry) => `${entry.firstInterfaceId}:${entry.secondInterfaceId}`,
      ),
      `Assembly kit ${declaration.handle} allowed mates`,
    );
    uniqueValues(
      declaration.transitions.map(
        (entry) =>
          `${entry.fromRoleId}:${entry.toRoleId}:${entry.hostInterfaceId}:${entry.childInterfaceId}`,
      ),
      `Assembly kit ${declaration.handle} transitions`,
    );
    const interfaces = new Map(
      declaration.interfaces.map((entry) => [entry.interfaceId, entry] as const),
    );
    for (const provider of declaration.providers) {
      uniqueValues(
        provider.socketBindings.map((entry) => `${entry.providerSocketId}:${entry.interfaceId}`),
        `Assembly provider ${provider.roleId} socket bindings`,
      );
      for (const handle of provider.providerHandles) {
        const child = declared.get(handle);
        if (!child || child.kind !== "substitution_set")
          throw new Error(`Assembly provider ${handle} must be a substitution-set leaf`);
        for (const binding of provider.socketBindings)
          if (
            !child.members.some((member) =>
              member.socketBindings.some(
                (memberBinding) =>
                  memberBinding.socketId === binding.providerSocketId &&
                  memberBinding.interfaceId === binding.interfaceId &&
                  memberBinding.polarity === interfaces.get(binding.interfaceId)?.polarity,
              ),
            )
          )
            throw new Error(
              `Assembly provider ${handle} lacks ${binding.providerSocketId}/${binding.interfaceId}`,
            );
      }
      for (const binding of provider.socketBindings)
        if (!interfaces.has(binding.interfaceId))
          throw new Error(`Assembly provider ${provider.roleId} uses an unknown interface`);
    }
    for (const mate of declaration.allowedMates) {
      const first = interfaces.get(mate.firstInterfaceId);
      const second = interfaces.get(mate.secondInterfaceId);
      if (!first || !second)
        throw new Error(`Assembly kit ${declaration.handle} mate references an unknown interface`);
      if (!socketPolaritiesMate(first.polarity, second.polarity))
        throw new Error(
          `Assembly kit ${declaration.handle} admits incompatible interface polarities`,
        );
    }
    for (const transition of declaration.transitions) {
      if (
        !declaration.allowedMates.some(
          (mate) =>
            mate.firstInterfaceId === transition.hostInterfaceId &&
            mate.secondInterfaceId === transition.childInterfaceId,
        )
      )
        throw new Error(`Assembly transition lacks an exact allowed interface mate`);
    }
  }
  if (declaration.kind === "route_kit") {
    uniqueValues(
      declaration.components.map((entry) => entry.roleId),
      `Route kit ${declaration.handle} component roles`,
    );
    uniqueValues(
      declaration.components.map((entry) => entry.topology),
      `Route kit ${declaration.handle} topology realizers`,
    );
    uniqueValues(
      declaration.allowedTransitions.map((entry) => `${entry.fromRoleId}:${entry.toRoleId}`),
      `Route kit ${declaration.handle} transitions`,
    );
    for (const component of declaration.components)
      for (const handle of component.providerHandles) {
        const child = declared.get(handle);
        if (!child || child.kind !== "substitution_set")
          throw new Error(`Route provider ${handle} must be a substitution-set leaf`);
      }
  }
  for (const childHandle of childHandles(declaration))
    if (!declared.has(childHandle))
      throw new Error(`Entry ${declaration.handle} references unknown child ${childHandle}`);
  if (
    declaration.kind === "assembly_kit" &&
    declaration.lattice.authority === "measured" &&
    !declaration.lattice.evidenceHash
  )
    throw new Error(`Measured lattice for ${declaration.handle} requires evidence`);
}

function validateEligibleDispositions(
  dispositions: readonly CatalogDisposition[],
  entries: ReadonlyMap<string, SealedCatalogEntry>,
  assets: ReadonlyMap<string, CatalogAssetArtifact>,
): void {
  const bySource = new Map(
    [...assets.values()].map((entry) => [entry.source.contentHash, entry] as const),
  );
  const dispositionBySource = new Map(
    dispositions.map((entry) => [entry.sourceContentHash, entry] as const),
  );
  for (const disposition of dispositions) {
    if (disposition.status !== "eligible") continue;
    const asset = bySource.get(disposition.sourceContentHash);
    if (!asset)
      throw new Error(`Eligible disposition lacks measurement ${disposition.sourceContentHash}`);
    if (disposition.usage.kind === "collision_companion") {
      const owner = bySource.get(disposition.usage.ownerSourceContentHash);
      const ownerDisposition = dispositionBySource.get(disposition.usage.ownerSourceContentHash);
      if (
        !owner ||
        ownerDisposition?.status !== "eligible" ||
        ownerDisposition.usage.kind !== "entry_member" ||
        owner.collision.mode !== "companion" ||
        !owner.collision.companionAssetHashes.includes(asset.hash)
      )
        throw new Error(
          `Collision companion ${disposition.sourceContentHash} lacks an exact eligible owner binding`,
        );
      continue;
    }
    const memberId = disposition.usage.memberId;
    const entry = entries.get(disposition.usage.entryHandle);
    if (
      !entry ||
      entry.kind === "collection" ||
      !entry.memberAssets.some(
        (member) => member.memberId === memberId && member.assetHash === asset.hash,
      )
    )
      throw new Error(
        `Eligible disposition does not name an exact member: ${disposition.sourceContentHash}`,
      );
  }
}

function canonicalDeclaration(entry: CatalogEntryDeclaration): CatalogEntryDeclaration {
  const parsed = CATALOG_ENTRY_DECLARATION_SCHEMA.parse(entry);
  if (parsed.kind === "collection")
    return {
      ...parsed,
      entryHandles: canonicalUniqueStrings(parsed.entryHandles, `${parsed.handle} entries`),
    };
  const semantic = {
    ...parsed.semantic,
    fixedStates: [...parsed.semantic.fixedStates].sort((a, b) =>
      compareCanonicalStrings(a.stateDimensionId, b.stateDimensionId),
    ),
    affordances: [...parsed.semantic.affordances].sort((a, b) =>
      compareCanonicalStrings(a.affordanceId, b.affordanceId),
    ),
    surfaceTreatmentIds: canonicalUniqueStrings(
      parsed.semantic.surfaceTreatmentIds,
      `${parsed.handle} treatments`,
    ),
  };
  const placement = {
    ...parsed.placement,
    interfaces: [...parsed.placement.interfaces].sort((a, b) =>
      compareCanonicalStrings(`${a.interfaceId}:${a.polarity}`, `${b.interfaceId}:${b.polarity}`),
    ),
  };
  const common = {
    ...parsed,
    semantic,
    placement,
    evidenceHashes: canonicalUniqueStrings(parsed.evidenceHashes, `${parsed.handle} evidence`),
  };
  if ("members" in common) {
    const withMembers = {
      ...common,
      members: [...common.members]
        .sort((a, b) => compareCanonicalStrings(a.memberId, b.memberId))
        .map((member) => ({
          ...member,
          socketBindings: [...member.socketBindings].sort((a, b) =>
            compareCanonicalStrings(
              `${a.interfaceId}:${a.socketId}`,
              `${b.interfaceId}:${b.socketId}`,
            ),
          ),
        })),
    };
    if (withMembers.kind === "attachment_set")
      return {
        ...withMembers,
        acceptedHostSupports: canonicalUniqueStrings(
          withMembers.acceptedHostSupports,
          `${withMembers.handle} host supports`,
        ) as typeof withMembers.acceptedHostSupports,
        acceptedHostInterfaceIds: canonicalUniqueStrings(
          withMembers.acceptedHostInterfaceIds,
          `${withMembers.handle} host interfaces`,
        ),
      };
    if (withMembers.kind === "environment_realizer")
      return {
        ...withMembers,
        modes: canonicalUniqueStrings(
          withMembers.modes,
          `${withMembers.handle} environment modes`,
        ) as typeof withMembers.modes,
      };
    return withMembers as CatalogEntryDeclaration;
  }
  if (common.kind === "assembly_kit")
    return {
      ...common,
      providers: [...common.providers]
        .sort((left, right) => compareCanonicalStrings(left.roleId, right.roleId))
        .map((provider) => ({
          ...provider,
          providerHandles: canonicalUniqueStrings(
            provider.providerHandles,
            `${common.handle}/${provider.roleId} providers`,
          ),
          socketBindings: [...provider.socketBindings].sort((left, right) =>
            compareCanonicalStrings(
              `${left.interfaceId}:${left.providerSocketId}`,
              `${right.interfaceId}:${right.providerSocketId}`,
            ),
          ),
        })),
      interfaces: [...common.interfaces].sort((left, right) =>
        compareCanonicalStrings(left.interfaceId, right.interfaceId),
      ),
      allowedMates: [...common.allowedMates].sort((left, right) =>
        compareCanonicalStrings(
          `${left.firstInterfaceId}:${left.secondInterfaceId}`,
          `${right.firstInterfaceId}:${right.secondInterfaceId}`,
        ),
      ),
      transitions: [...common.transitions].sort((left, right) =>
        compareCanonicalStrings(stableJson(left), stableJson(right)),
      ),
      terminalRoleIds: canonicalUniqueStrings(
        common.terminalRoleIds,
        `${common.handle} terminal roles`,
      ),
      requiredCoverageRoleIds: canonicalUniqueStrings(
        common.requiredCoverageRoleIds,
        `${common.handle} coverage roles`,
      ),
    };
  if (common.kind === "route_kit")
    return {
      ...common,
      components: [...common.components]
        .sort((left, right) =>
          compareCanonicalStrings(
            `${left.topology}:${left.roleId}`,
            `${right.topology}:${right.roleId}`,
          ),
        )
        .map((component) => ({
          ...component,
          providerHandles: canonicalUniqueStrings(
            component.providerHandles,
            `${common.handle}/${component.roleId} providers`,
          ),
        })),
      allowedTransitions: [...common.allowedTransitions].sort((left, right) =>
        compareCanonicalStrings(
          `${left.fromRoleId}:${left.toRoleId}`,
          `${right.fromRoleId}:${right.toRoleId}`,
        ),
      ),
    };
  return common as CatalogEntryDeclaration;
}

function childHandles(entry: CatalogEntryDeclaration): string[] {
  if (entry.kind === "assembly_kit")
    return canonicalUniqueStrings(
      entry.providers.flatMap((providerEntry) => providerEntry.providerHandles),
      `${entry.handle} children`,
    );
  if (entry.kind === "route_kit")
    return canonicalUniqueStrings(
      entry.components.flatMap((component) => component.providerHandles),
      `${entry.handle} children`,
    );
  if (entry.kind === "collection")
    return canonicalUniqueStrings(entry.entryHandles, `${entry.handle} children`);
  return [];
}

function assertAcyclicComposition(
  declarations: ReadonlyMap<string, CatalogEntryDeclaration>,
): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (handle: string) => {
    if (visited.has(handle)) return;
    if (visiting.has(handle)) throw new Error(`Catalog composition cycle reaches ${handle}`);
    const declaration = required(declarations, handle, "catalog entry");
    visiting.add(handle);
    for (const child of childHandles(declaration)) visit(child);
    visiting.delete(handle);
    visited.add(handle);
  };
  for (const handle of declarations.keys()) visit(handle);
}

function envelopeOf(
  bounds: readonly CatalogAssetArtifact["bounds"][],
): CatalogAssetArtifact["bounds"] | undefined {
  if (bounds.length === 0) return undefined;
  const axes = ["x", "y", "z"] as const;
  return {
    min: Object.fromEntries(
      axes.map((axis) => [
        axis,
        bounds.reduce(
          (best, entry) => (BigInt(entry.min[axis]) < BigInt(best) ? entry.min[axis] : best),
          bounds[0]!.min[axis],
        ),
      ]),
    ) as CatalogAssetArtifact["bounds"]["min"],
    max: Object.fromEntries(
      axes.map((axis) => [
        axis,
        bounds.reduce(
          (best, entry) => (BigInt(entry.max[axis]) > BigInt(best) ? entry.max[axis] : best),
          bounds[0]!.max[axis],
        ),
      ]),
    ) as CatalogAssetArtifact["bounds"]["max"],
  };
}

function uniqueMap<T>(
  values: readonly T[],
  key: (entry: T) => string,
  label: string,
): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    const identity = key(value);
    if (result.has(identity)) throw new Error(`Duplicate ${label}: ${identity}`);
    result.set(identity, value);
  }
  return result;
}

function required<T>(map: ReadonlyMap<string, T>, key: string, label: string): T {
  const value = map.get(key);
  if (!value) throw new Error(`Unknown ${label}: ${key}`);
  return value;
}

function canonicalArray<T>(
  values: readonly T[],
  key: (entry: T) => string,
  label: string,
  context: z.RefinementCtx,
): void {
  const keys = values.map(key);
  if (new Set(keys).size !== keys.length)
    context.addIssue({ code: "custom", message: `${label} must be unique` });
  if (keys.some((key, index) => index > 0 && compareCanonicalStrings(keys[index - 1]!, key) >= 0))
    context.addIssue({ code: "custom", message: `${label} must use canonical order` });
}

function uniqueValues(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} must be unique`);
}

function socketPolaritiesMate(first: string, second: string): boolean {
  return (
    first === "neutral" ||
    second === "neutral" ||
    (first === "plug" && second === "socket") ||
    (first === "socket" && second === "plug")
  );
}
