import { z } from "zod";
import {
  ASCII_ID_SCHEMA,
  HASH_SCHEMA,
  compareCanonicalStrings,
  contentHash,
  deepFreezeJson,
  stableJson,
} from "@basalt/contracts";

export const UPPER_SORTS = [
  "object",
  "aggregate",
  "substance",
  "space",
  "boundary",
  "phenomenon",
  "information_content",
] as const;
export const UPPER_SORT_SCHEMA = z.enum(UPPER_SORTS);
export type UpperSort = z.output<typeof UPPER_SORT_SCHEMA>;
export const UPPER_SORT_DEFINITIONS = [
  {
    upperSort: "aggregate",
    normativeDefinition:
      "A plurality treated as one realization without asserting that it is one object.",
  },
  {
    upperSort: "boundary",
    normativeDefinition: "A physical or virtual surface delimiting an entity or space.",
  },
  {
    upperSort: "information_content",
    normativeDefinition: "Information that can be borne by a physical or virtual realization.",
  },
  {
    upperSort: "object",
    normativeDefinition:
      "A bounded persistent entity that can be individually placed or assembled.",
  },
  {
    upperSort: "phenomenon",
    normativeDefinition: "A process-like, event-like, or field-like occurrence.",
  },
  {
    upperSort: "space",
    normativeDefinition:
      "A physical or logical extent that may contain entities or participate in spatial planning.",
  },
  {
    upperSort: "substance",
    normativeDefinition: "Material measured or realized by amount rather than individual identity.",
  },
] as const;

export const EVIDENCE_LEVELS = ["declared", "measured", "simulated", "engine_verified"] as const;
export const EVIDENCE_LEVEL_SCHEMA = z.enum(EVIDENCE_LEVELS);
export type EvidenceLevel = z.output<typeof EVIDENCE_LEVEL_SCHEMA>;

export const REALIZATION_FORMS = [
  "whole",
  "aggregate",
  "component",
  "assembly",
  "surface",
  "field_or_effect",
] as const;
export const REALIZATION_FORM_SCHEMA = z.enum(REALIZATION_FORMS);
export type RealizationForm = z.output<typeof REALIZATION_FORM_SCHEMA>;

export const ASSERTION_KINDS = [
  "denotation",
  "affordance",
  "state",
  "surface_treatment",
  "role",
  "relation",
  "realization_form",
] as const;
export const ASSERTION_KIND_SCHEMA = z.enum(ASSERTION_KINDS);

export const CONCEPT_ID_SCHEMA = z.string().regex(/^bsc_[0-9]{6}$/u);
export const AFFORDANCE_ID_SCHEMA = z.string().regex(/^baf_[0-9]{6}$/u);
export const STATE_DIMENSION_ID_SCHEMA = z.string().regex(/^bsd_[0-9]{6}$/u);
export const STATE_VALUE_ID_SCHEMA = z.string().regex(/^bsv_[0-9]{6}$/u);
export const SURFACE_TREATMENT_ID_SCHEMA = z.string().regex(/^bst_[0-9]{6}$/u);
export const ROLE_SCHEME_ID_SCHEMA = z.string().regex(/^brs_[0-9]{6}$/u);
export const ROLE_ID_SCHEMA = z.string().regex(/^bro_[0-9]{6}$/u);
export const RELATION_ID_SCHEMA = z.string().regex(/^bre_[0-9]{6}$/u);
export const ANNOTATION_PREDICATE_ID_SCHEMA = z.string().regex(/^bap_[0-9]{6}$/u);

const definition = z.string().trim().min(12).max(2048);
const canonicalStrings = <T extends z.ZodTypeAny>(schema: T, maximum = 65_536) =>
  z
    .array(schema)
    .max(maximum)
    .superRefine((values, context) => {
      const serialized = values.map((value) => stableJson(value));
      if (new Set(serialized).size !== values.length)
        context.addIssue({ code: "custom", message: "Values must be unique" });
    });

export const SEMANTIC_KERNEL_SCHEMA = z
  .object({
    kind: z.literal("SemanticKernel"),
    upperSorts: canonicalStrings(
      z.object({ upperSort: UPPER_SORT_SCHEMA, normativeDefinition: definition }).strict(),
      UPPER_SORTS.length,
    ).length(UPPER_SORTS.length),
    evidenceOrder: z.tuple([
      z.literal("declared"),
      z.literal("measured"),
      z.literal("simulated"),
      z.literal("engine_verified"),
    ]),
    assertionKinds: z.tuple(
      ASSERTION_KINDS.map((value) => z.literal(value)) as [
        z.ZodLiteral<"denotation">,
        z.ZodLiteral<"affordance">,
        z.ZodLiteral<"state">,
        z.ZodLiteral<"surface_treatment">,
        z.ZodLiteral<"role">,
        z.ZodLiteral<"relation">,
        z.ZodLiteral<"realization_form">,
      ],
    ),
    reasoningRules: z.tuple([
      z.literal("materialized_ancestry"),
      z.literal("exact_or_descendant_matching"),
      z.literal("set_inclusion"),
      z.literal("state_equality"),
      z.literal("evidence_ordering"),
      z.literal("declared_relation_expansion"),
    ]),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => verifyHash(value, "hash", context));
export type SemanticKernel = z.output<typeof SEMANTIC_KERNEL_SCHEMA>;

export function sealSemanticKernel(): SemanticKernel {
  const material = {
    kind: "SemanticKernel" as const,
    upperSorts: UPPER_SORT_DEFINITIONS,
    evidenceOrder: EVIDENCE_LEVELS,
    assertionKinds: ASSERTION_KINDS,
    reasoningRules: [
      "materialized_ancestry",
      "exact_or_descendant_matching",
      "set_inclusion",
      "state_equality",
      "evidence_ordering",
      "declared_relation_expansion",
    ] as const,
  };
  return freeze(SEMANTIC_KERNEL_SCHEMA.parse({ ...material, hash: hashMaterial(material) }));
}

export const CONCEPT_COMMITMENT_DECLARATION_SCHEMA = z
  .object({
    conceptId: CONCEPT_ID_SCHEMA,
    upperSort: UPPER_SORT_SCHEMA,
    normativeDefinition: definition,
    identityCriteria: z
      .object({
        necessary: z.array(definition).min(1),
        excludes: z.array(definition).min(1),
      })
      .strict(),
    parentIds: z.array(CONCEPT_ID_SCHEMA),
  })
  .strict();
export type ConceptCommitmentDeclaration = z.output<typeof CONCEPT_COMMITMENT_DECLARATION_SCHEMA>;

const commitmentReference = z
  .object({ conceptId: CONCEPT_ID_SCHEMA, commitmentHash: HASH_SCHEMA })
  .strict();
export const CONCEPT_COMMITMENT_REFERENCE_SCHEMA = commitmentReference;
export type ConceptCommitmentReference = z.output<typeof commitmentReference>;

export const CONCEPT_COMMITMENT_SCHEMA = z
  .object({
    kind: z.literal("ConceptCommitment"),
    kernelHash: HASH_SCHEMA,
    conceptId: CONCEPT_ID_SCHEMA,
    upperSort: UPPER_SORT_SCHEMA,
    normativeDefinition: definition,
    identityCriteria: CONCEPT_COMMITMENT_DECLARATION_SCHEMA.shape.identityCriteria,
    directParents: canonicalStrings(commitmentReference, 16),
    ancestors: canonicalStrings(commitmentReference),
    commitmentHash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => verifyHash(value, "commitmentHash", context));
export type ConceptCommitment = z.output<typeof CONCEPT_COMMITMENT_SCHEMA>;

export const AFFORDANCE_DEFINITION_SCHEMA = hashedDefinition(
  "AffordanceDefinition",
  AFFORDANCE_ID_SCHEMA,
  "affordanceId",
);
export const REALIZATION_FORM_DEFINITION_SCHEMA = hashedDefinition(
  "RealizationFormDefinition",
  REALIZATION_FORM_SCHEMA,
  "realizationForm",
);
export const SURFACE_TREATMENT_DEFINITION_SCHEMA = hashedDefinition(
  "SurfaceTreatmentDefinition",
  SURFACE_TREATMENT_ID_SCHEMA,
  "surfaceTreatmentId",
);

const stateValueDefinition = z
  .object({
    stateValueId: STATE_VALUE_ID_SCHEMA,
    normativeDefinition: definition,
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => verifyHash(value, "hash", context));
export const STATE_DIMENSION_DEFINITION_SCHEMA = z
  .object({
    kind: z.literal("StateDimensionDefinition"),
    stateDimensionId: STATE_DIMENSION_ID_SCHEMA,
    cardinality: z.literal("exactly_one_when_asserted"),
    normativeDefinition: definition,
    values: canonicalStrings(stateValueDefinition, 128),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => verifyHash(value, "hash", context));

const roleDefinition = z
  .object({ roleId: ROLE_ID_SCHEMA, normativeDefinition: definition, hash: HASH_SCHEMA })
  .strict()
  .superRefine((value, context) => verifyHash(value, "hash", context));
export const ROLE_SCHEME_DEFINITION_SCHEMA = z
  .object({
    kind: z.literal("RoleSchemeDefinition"),
    roleSchemeId: ROLE_SCHEME_ID_SCHEMA,
    scope: z.enum(["assembly_grammar", "route_grammar", "space_program", "scene_intent"]),
    normativeDefinition: definition,
    roles: canonicalStrings(roleDefinition, 256),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => verifyHash(value, "hash", context));

export const RELATION_DEFINITION_SCHEMA = z
  .object({
    kind: z.literal("RelationDefinition"),
    relationId: RELATION_ID_SCHEMA,
    normativeDefinition: definition,
    domainSorts: canonicalStrings(UPPER_SORT_SCHEMA, UPPER_SORTS.length).min(1),
    rangeSorts: canonicalStrings(UPPER_SORT_SCHEMA, UPPER_SORTS.length).min(1),
    symmetric: z.boolean(),
    transitive: z.boolean(),
    inverseRelationId: RELATION_ID_SCHEMA.optional(),
    closurePolicy: z.string().trim().min(1).max(2048).optional(),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => verifyHash(value, "hash", context));

export const ANNOTATION_PREDICATE_DEFINITION_SCHEMA = z
  .object({
    kind: z.literal("AnnotationPredicateDefinition"),
    annotationPredicateId: ANNOTATION_PREDICATE_ID_SCHEMA,
    normativeDefinition: definition,
    domainKinds: canonicalStrings(ASCII_ID_SCHEMA).min(1),
    rangeKind: ASCII_ID_SCHEMA,
    compilerAuthority: z.literal(false),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => verifyHash(value, "hash", context));

export type AffordanceDefinition = z.output<typeof AFFORDANCE_DEFINITION_SCHEMA>;
export type RealizationFormDefinition = z.output<typeof REALIZATION_FORM_DEFINITION_SCHEMA>;
export type SurfaceTreatmentDefinition = z.output<typeof SURFACE_TREATMENT_DEFINITION_SCHEMA>;
export type StateDimensionDefinition = z.output<typeof STATE_DIMENSION_DEFINITION_SCHEMA>;
export type RoleSchemeDefinition = z.output<typeof ROLE_SCHEME_DEFINITION_SCHEMA>;
export type RelationDefinition = z.output<typeof RELATION_DEFINITION_SCHEMA>;
export type AnnotationPredicateDefinition = z.output<typeof ANNOTATION_PREDICATE_DEFINITION_SCHEMA>;

export const SEMANTIC_CONSTRAINT_DEFINITION_SCHEMA = z
  .object({
    kind: z.literal("SemanticConstraintDefinition"),
    constraintId: z.string().regex(/^bco_[0-9]{6}$/u),
    appliesTo: z.enum(["concept", "assertion", "requirement", "entry", "realization"]),
    normativeRule: definition,
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => verifyHash(value, "hash", context));
export type SemanticConstraintDefinition = z.output<typeof SEMANTIC_CONSTRAINT_DEFINITION_SCHEMA>;

export const SEMANTIC_CONSTRAINT_SET_SCHEMA = z
  .object({
    kind: z.literal("SemanticConstraintSet"),
    definitions: canonicalStrings(SEMANTIC_CONSTRAINT_DEFINITION_SCHEMA),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => verifyHash(value, "hash", context));
export type SemanticConstraintSet = z.output<typeof SEMANTIC_CONSTRAINT_SET_SCHEMA>;

export function sealSemanticConstraintSet(
  definitionsInput: readonly SemanticConstraintDefinition[],
): SemanticConstraintSet {
  const definitions = canonicalize(
    definitionsInput.map((entry) => SEMANTIC_CONSTRAINT_DEFINITION_SCHEMA.parse(entry)),
    (entry) => entry.constraintId,
    "semantic constraints",
  );
  const material = { kind: "SemanticConstraintSet" as const, definitions };
  return freeze(
    SEMANTIC_CONSTRAINT_SET_SCHEMA.parse({ ...material, hash: hashMaterial(material) }),
  );
}

const semanticReference = z
  .object({ kind: ASCII_ID_SCHEMA, id: ASCII_ID_SCHEMA, hash: HASH_SCHEMA })
  .strict();

export const SEMANTIC_MODULE_SNAPSHOT_SCHEMA = z
  .object({
    kind: z.literal("SemanticModuleSnapshot"),
    kernelHash: HASH_SCHEMA,
    concepts: canonicalStrings(commitmentReference),
    definitions: canonicalStrings(semanticReference),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => verifyHash(value, "hash", context));
export type SemanticModuleSnapshot = z.output<typeof SEMANTIC_MODULE_SNAPSHOT_SCHEMA>;

export interface SemanticModule {
  readonly kernel: SemanticKernel;
  readonly concepts: readonly ConceptCommitment[];
  readonly affordances: readonly AffordanceDefinition[];
  readonly realizationForms: readonly RealizationFormDefinition[];
  readonly stateDimensions: readonly StateDimensionDefinition[];
  readonly surfaceTreatments: readonly SurfaceTreatmentDefinition[];
  readonly roleSchemes: readonly RoleSchemeDefinition[];
  readonly relations: readonly RelationDefinition[];
  readonly annotationPredicates: readonly AnnotationPredicateDefinition[];
  readonly constraints: SemanticConstraintSet;
  readonly snapshot: SemanticModuleSnapshot;
}

export function sealConceptCommitments(input: {
  readonly kernel: SemanticKernel;
  readonly declarations: readonly ConceptCommitmentDeclaration[];
}): ConceptCommitment[] {
  const kernel = SEMANTIC_KERNEL_SCHEMA.parse(input.kernel);
  const declarations = input.declarations.map((entry) =>
    CONCEPT_COMMITMENT_DECLARATION_SCHEMA.parse(entry),
  );
  const byId = uniqueBy(declarations, (entry) => entry.conceptId, "concept declaration");
  const visiting = new Set<string>();
  const sealed = new Map<string, ConceptCommitment>();
  const sealOne = (conceptId: string): ConceptCommitment => {
    const cached = sealed.get(conceptId);
    if (cached) return cached;
    if (visiting.has(conceptId)) throw new Error(`Semantic concept cycle reaches ${conceptId}`);
    const declaration = byId.get(conceptId);
    if (!declaration) throw new Error(`Unknown semantic concept ${conceptId}`);
    visiting.add(conceptId);
    const directParents = canonicalize(
      declaration.parentIds.map((parentId) => {
        const parent = sealOne(parentId);
        if (parent.upperSort !== declaration.upperSort)
          throw new Error(`Cross-sort parent ${parentId} for ${conceptId}`);
        return { conceptId: parent.conceptId, commitmentHash: parent.commitmentHash };
      }),
      (entry) => entry.conceptId,
      `parents of ${conceptId}`,
    );
    const ancestorById = new Map<string, ConceptCommitmentReference>();
    for (const parent of directParents) {
      const sealedParent = sealed.get(parent.conceptId)!;
      ancestorById.set(parent.conceptId, parent);
      for (const ancestor of sealedParent.ancestors) ancestorById.set(ancestor.conceptId, ancestor);
    }
    const ancestors = canonicalize(
      [...ancestorById.values()],
      (entry) => entry.conceptId,
      `ancestors of ${conceptId}`,
    );
    const material = {
      kind: "ConceptCommitment" as const,
      kernelHash: kernel.hash,
      conceptId,
      upperSort: declaration.upperSort,
      normativeDefinition: declaration.normativeDefinition,
      identityCriteria: declaration.identityCriteria,
      directParents,
      ancestors,
    };
    const commitment = freeze(
      CONCEPT_COMMITMENT_SCHEMA.parse({
        ...material,
        commitmentHash: hashMaterial(material),
      }),
    );
    sealed.set(conceptId, commitment);
    visiting.delete(conceptId);
    return commitment;
  };
  return [...byId.keys()].sort(compareCanonicalStrings).map(sealOne);
}

export function sealSemanticModule(input: Omit<SemanticModule, "snapshot">): SemanticModule {
  const kernel = SEMANTIC_KERNEL_SCHEMA.parse(input.kernel);
  const parsedConcepts = canonicalize(
    input.concepts.map((entry) => CONCEPT_COMMITMENT_SCHEMA.parse(entry)),
    (entry) => entry.conceptId,
    "concept commitments",
  );
  for (const concept of parsedConcepts)
    if (concept.kernelHash !== kernel.hash)
      throw new Error(`Concept ${concept.conceptId} belongs to another semantic kernel`);
  const concepts = sealConceptCommitments({
    kernel,
    declarations: parsedConcepts.map((concept) => ({
      conceptId: concept.conceptId,
      upperSort: concept.upperSort,
      normativeDefinition: concept.normativeDefinition,
      identityCriteria: concept.identityCriteria,
      parentIds: concept.directParents.map((parent) => parent.conceptId),
    })),
  });
  if (stableJson(concepts) !== stableJson(parsedConcepts))
    throw new Error(
      "Concept commitments do not contain their exact sealed parent and ancestry graph",
    );
  const affordances = parseCanonical(
    input.affordances,
    AFFORDANCE_DEFINITION_SCHEMA,
    "affordanceId",
  );
  const realizationForms = parseCanonical(
    input.realizationForms,
    REALIZATION_FORM_DEFINITION_SCHEMA,
    "realizationForm",
  );
  const stateDimensions = parseCanonical(
    input.stateDimensions,
    STATE_DIMENSION_DEFINITION_SCHEMA,
    "stateDimensionId",
  );
  const surfaceTreatments = parseCanonical(
    input.surfaceTreatments,
    SURFACE_TREATMENT_DEFINITION_SCHEMA,
    "surfaceTreatmentId",
  );
  const roleSchemes = parseCanonical(
    input.roleSchemes,
    ROLE_SCHEME_DEFINITION_SCHEMA,
    "roleSchemeId",
  );
  const relations = parseCanonical(input.relations, RELATION_DEFINITION_SCHEMA, "relationId");
  const annotationPredicates = parseCanonical(
    input.annotationPredicates,
    ANNOTATION_PREDICATE_DEFINITION_SCHEMA,
    "annotationPredicateId",
  );
  const constraints = SEMANTIC_CONSTRAINT_SET_SCHEMA.parse(input.constraints);
  validateStateAndRoleIdentities(stateDimensions, roleSchemes);
  validateRelations(relations);
  const definitions = [
    ...affordances.map((entry) => ({ kind: entry.kind, id: entry.affordanceId, hash: entry.hash })),
    ...realizationForms.map((entry) => ({
      kind: entry.kind,
      id: entry.realizationForm,
      hash: entry.hash,
    })),
    ...stateDimensions.map((entry) => ({
      kind: entry.kind,
      id: entry.stateDimensionId,
      hash: entry.hash,
    })),
    ...stateDimensions.flatMap((entry) =>
      entry.values.map((value) => ({
        kind: "StateValueDefinition",
        id: value.stateValueId,
        hash: value.hash,
      })),
    ),
    ...surfaceTreatments.map((entry) => ({
      kind: entry.kind,
      id: entry.surfaceTreatmentId,
      hash: entry.hash,
    })),
    ...roleSchemes.map((entry) => ({ kind: entry.kind, id: entry.roleSchemeId, hash: entry.hash })),
    ...roleSchemes.flatMap((entry) =>
      entry.roles.map((role) => ({
        kind: "RoleDefinition",
        id: role.roleId,
        hash: role.hash,
      })),
    ),
    ...relations.map((entry) => ({ kind: entry.kind, id: entry.relationId, hash: entry.hash })),
    ...annotationPredicates.map((entry) => ({
      kind: entry.kind,
      id: entry.annotationPredicateId,
      hash: entry.hash,
    })),
    ...constraints.definitions.map((entry) => ({
      kind: entry.kind,
      id: entry.constraintId,
      hash: entry.hash,
    })),
  ].sort((left, right) => compareCanonicalStrings(stableJson(left), stableJson(right)));
  const snapshotMaterial = {
    kind: "SemanticModuleSnapshot" as const,
    kernelHash: kernel.hash,
    concepts: concepts.map((entry) => ({
      conceptId: entry.conceptId,
      commitmentHash: entry.commitmentHash,
    })),
    definitions,
  };
  const snapshot = freeze(
    SEMANTIC_MODULE_SNAPSHOT_SCHEMA.parse({
      ...snapshotMaterial,
      hash: hashMaterial(snapshotMaterial),
    }),
  );
  return freeze({
    kernel,
    concepts,
    affordances,
    realizationForms,
    stateDimensions,
    surfaceTreatments,
    roleSchemes,
    relations,
    annotationPredicates,
    constraints,
    snapshot,
  });
}

export const SEMANTIC_DEPENDENCY_CLOSURE_SCHEMA = z
  .object({
    kind: z.literal("SemanticDependencyClosure"),
    kernelHash: HASH_SCHEMA,
    concepts: canonicalStrings(commitmentReference),
    definitions: canonicalStrings(semanticReference),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => verifyHash(value, "hash", context));
export type SemanticDependencyClosure = z.output<typeof SEMANTIC_DEPENDENCY_CLOSURE_SCHEMA>;

export function createSemanticDependencyClosure(input: {
  readonly module: SemanticModule;
  readonly conceptIds: readonly string[];
  readonly definitionIds?: readonly string[];
}): SemanticDependencyClosure {
  const conceptById = new Map(input.module.concepts.map((entry) => [entry.conceptId, entry]));
  const concepts = new Map<string, ConceptCommitmentReference>();
  for (const conceptIdInput of input.conceptIds) {
    const conceptId = CONCEPT_ID_SCHEMA.parse(conceptIdInput);
    const concept = conceptById.get(conceptId);
    if (!concept) throw new Error(`Unknown concept in dependency closure: ${conceptId}`);
    concepts.set(conceptId, { conceptId, commitmentHash: concept.commitmentHash });
    for (const ancestor of concept.ancestors) concepts.set(ancestor.conceptId, ancestor);
  }
  const definitionById = new Map(
    input.module.snapshot.definitions.map((entry) => [entry.id, entry]),
  );
  const definitions = (input.definitionIds ?? []).map((id) => {
    const found = definitionById.get(id);
    if (!found) throw new Error(`Unknown semantic definition in dependency closure: ${id}`);
    return found;
  });
  const material = {
    kind: "SemanticDependencyClosure" as const,
    kernelHash: input.module.kernel.hash,
    concepts: canonicalize([...concepts.values()], (entry) => entry.conceptId, "closure concepts"),
    definitions: canonicalize(
      definitions,
      (entry) => `${entry.kind}:${entry.id}`,
      "closure definitions",
    ),
  };
  return freeze(
    SEMANTIC_DEPENDENCY_CLOSURE_SCHEMA.parse({ ...material, hash: hashMaterial(material) }),
  );
}

const lexiconEntry = z
  .object({
    subjectKind: z.enum([
      "concept",
      "affordance",
      "state_dimension",
      "state_value",
      "surface_treatment",
      "role_scheme",
      "role",
      "relation",
      "realization_form",
      "annotation_predicate",
    ]),
    subjectId: ASCII_ID_SCHEMA,
    preferredLabels: z.record(
      z.string().regex(/^[a-z]{2}(?:-[A-Z]{2})?$/u),
      z.string().trim().min(1).max(160),
    ),
    alternateLabels: z.array(z.string().trim().min(1).max(160)),
    hiddenLabels: z.array(z.string().trim().min(1).max(160)),
    scopeNote: z.string().trim().min(1).max(2048).optional(),
    examples: z.array(z.string().trim().min(1).max(512)),
    counterexamples: z.array(z.string().trim().min(1).max(512)),
    externalMappings: z.array(
      z
        .object({ vocabulary: ASCII_ID_SCHEMA, identifier: z.string().trim().min(1).max(512) })
        .strict(),
    ),
  })
  .strict();
export const SEMANTIC_LEXICON_SNAPSHOT_SCHEMA = z
  .object({
    kind: z.literal("SemanticLexiconSnapshot"),
    entries: canonicalStrings(lexiconEntry),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyHash(value, "hash", context);
    const aliases = new Map<string, string>();
    for (const [index, entry] of value.entries.entries())
      for (const label of [
        ...Object.values(entry.preferredLabels),
        ...entry.alternateLabels,
        ...entry.hiddenLabels,
      ]) {
        const key = `${entry.subjectKind}:${label.normalize("NFKC").toLowerCase()}`;
        const owner = aliases.get(key);
        if (owner && owner !== entry.subjectId)
          context.addIssue({
            code: "custom",
            path: ["entries", index],
            message: `Ambiguous label ${label}`,
          });
        aliases.set(key, entry.subjectId);
      }
  });
export type SemanticLexiconSnapshot = z.output<typeof SEMANTIC_LEXICON_SNAPSHOT_SCHEMA>;

export function sealSemanticLexicon(
  entriesInput: readonly z.input<typeof lexiconEntry>[],
): SemanticLexiconSnapshot {
  const entries = canonicalize(
    entriesInput.map((entry) => lexiconEntry.parse(entry)),
    (entry) => `${entry.subjectKind}:${entry.subjectId}`,
    "lexicon entries",
  );
  const material = { kind: "SemanticLexiconSnapshot" as const, entries };
  return freeze(
    SEMANTIC_LEXICON_SNAPSHOT_SCHEMA.parse({ ...material, hash: hashMaterial(material) }),
  );
}

export const SEMANTIC_REQUIREMENT_SCHEMA = z
  .object({
    denotation: commitmentReference.extend({ matchMode: z.enum(["exact", "descendant"]) }).strict(),
    realizationForms: canonicalStrings(REALIZATION_FORM_SCHEMA, REALIZATION_FORMS.length).min(1),
    affordances: canonicalStrings(
      z
        .object({ affordanceId: AFFORDANCE_ID_SCHEMA, minimumEvidence: EVIDENCE_LEVEL_SCHEMA })
        .strict(),
      64,
    ),
    states: canonicalStrings(
      z
        .object({
          stateDimensionId: STATE_DIMENSION_ID_SCHEMA,
          stateValueId: STATE_VALUE_ID_SCHEMA,
        })
        .strict(),
      32,
    ),
    surfaceTreatmentIds: canonicalStrings(SURFACE_TREATMENT_ID_SCHEMA, 64),
    dependencyClosureHash: HASH_SCHEMA,
  })
  .strict();
export type SemanticRequirement = z.output<typeof SEMANTIC_REQUIREMENT_SCHEMA>;

export const SEMANTIC_ASSERTION_SUBJECT_SCHEMA = z
  .object({
    kind: z.enum([
      "catalog_asset",
      "catalog_member",
      "catalog_entry",
      "planned_entity",
      "realized_instance",
    ]),
    id: ASCII_ID_SCHEMA,
  })
  .strict();

const assertionBase = { subject: SEMANTIC_ASSERTION_SUBJECT_SCHEMA };
const confidence = { confidence: z.number().finite().min(0).max(1) };
const evidence = {
  evidence: z
    .object({
      level: EVIDENCE_LEVEL_SCHEMA,
      evidenceHashes: z
        .array(HASH_SCHEMA)
        .min(1)
        .superRefine((values, context) =>
          validateCanonicalArray(values, String, "assertion evidence hashes", context),
        ),
    })
    .strict(),
};

// Keep every public assertion variant explicit. Besides preserving useful inferred
// TypeScript unions, this makes it impossible to add a predicate without making a
// deliberate hypothesis/admission decision for it.
export const SEMANTIC_HYPOTHESIS_ASSERTION_SCHEMA = z.discriminatedUnion("assertionKind", [
  z
    .object({
      assertionKind: z.literal("denotation"),
      ...assertionBase,
      concept: commitmentReference,
      ...confidence,
    })
    .strict(),
  z
    .object({
      assertionKind: z.literal("affordance"),
      ...assertionBase,
      affordanceId: AFFORDANCE_ID_SCHEMA,
      ...confidence,
    })
    .strict(),
  z
    .object({
      assertionKind: z.literal("state"),
      ...assertionBase,
      stateDimensionId: STATE_DIMENSION_ID_SCHEMA,
      stateValueId: STATE_VALUE_ID_SCHEMA,
      ...confidence,
    })
    .strict(),
  z
    .object({
      assertionKind: z.literal("surface_treatment"),
      ...assertionBase,
      surfaceTreatmentId: SURFACE_TREATMENT_ID_SCHEMA,
      ...confidence,
    })
    .strict(),
  z
    .object({
      assertionKind: z.literal("role"),
      ...assertionBase,
      roleSchemeId: ROLE_SCHEME_ID_SCHEMA,
      roleId: ROLE_ID_SCHEMA,
      ...confidence,
    })
    .strict(),
  z
    .object({
      assertionKind: z.literal("relation"),
      ...assertionBase,
      relationId: RELATION_ID_SCHEMA,
      object: SEMANTIC_ASSERTION_SUBJECT_SCHEMA,
      ...confidence,
    })
    .strict(),
  z
    .object({
      assertionKind: z.literal("realization_form"),
      ...assertionBase,
      realizationForm: REALIZATION_FORM_SCHEMA,
      ...confidence,
    })
    .strict(),
]);
export const SEMANTIC_ADMITTED_ASSERTION_SCHEMA = z.discriminatedUnion("assertionKind", [
  z
    .object({
      assertionKind: z.literal("denotation"),
      ...assertionBase,
      concept: commitmentReference,
      ...evidence,
    })
    .strict(),
  z
    .object({
      assertionKind: z.literal("affordance"),
      ...assertionBase,
      affordanceId: AFFORDANCE_ID_SCHEMA,
      ...evidence,
    })
    .strict(),
  z
    .object({
      assertionKind: z.literal("state"),
      ...assertionBase,
      stateDimensionId: STATE_DIMENSION_ID_SCHEMA,
      stateValueId: STATE_VALUE_ID_SCHEMA,
      ...evidence,
    })
    .strict(),
  z
    .object({
      assertionKind: z.literal("surface_treatment"),
      ...assertionBase,
      surfaceTreatmentId: SURFACE_TREATMENT_ID_SCHEMA,
      ...evidence,
    })
    .strict(),
  z
    .object({
      assertionKind: z.literal("role"),
      ...assertionBase,
      roleSchemeId: ROLE_SCHEME_ID_SCHEMA,
      roleId: ROLE_ID_SCHEMA,
      ...evidence,
    })
    .strict(),
  z
    .object({
      assertionKind: z.literal("relation"),
      ...assertionBase,
      relationId: RELATION_ID_SCHEMA,
      object: SEMANTIC_ASSERTION_SUBJECT_SCHEMA,
      ...evidence,
    })
    .strict(),
  z
    .object({
      assertionKind: z.literal("realization_form"),
      ...assertionBase,
      realizationForm: REALIZATION_FORM_SCHEMA,
      ...evidence,
    })
    .strict(),
]);

export const SEMANTIC_HYPOTHESIS_ASSERTION_BUNDLE_SCHEMA = z
  .object({
    kind: z.literal("SemanticAssertionBundle"),
    authority: z.literal("hypothesis"),
    hypothesisSourceHash: HASH_SCHEMA,
    assertions: z.array(SEMANTIC_HYPOTHESIS_ASSERTION_SCHEMA),
    abstentions: z.array(z.string().trim().min(1).max(1024)),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyHash(value, "hash", context);
    validateCanonicalArray(value.assertions, stableJson, "hypothesis assertions", context);
    validateCanonicalArray(value.abstentions, String, "hypothesis abstentions", context);
  });

export const SEMANTIC_ADMITTED_ASSERTION_BUNDLE_SCHEMA = z
  .object({
    kind: z.literal("SemanticAssertionBundle"),
    authority: z.literal("admitted"),
    assertions: z.array(SEMANTIC_ADMITTED_ASSERTION_SCHEMA),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    verifyHash(value, "hash", context);
    validateCanonicalArray(value.assertions, stableJson, "admitted assertions", context);
    const states = new Map<string, string>();
    for (const [index, rawAssertion] of value.assertions.entries()) {
      const assertion = rawAssertion as {
        readonly assertionKind: string;
        readonly subject: { readonly kind: string; readonly id: string };
        readonly stateDimensionId?: string;
        readonly stateValueId?: string;
      };
      if (assertion.assertionKind !== "state") continue;
      if (!assertion.stateDimensionId || !assertion.stateValueId) continue;
      const key = `${assertion.subject.kind}:${assertion.subject.id}:${assertion.stateDimensionId}`;
      const previous = states.get(key);
      if (previous && previous !== assertion.stateValueId)
        context.addIssue({
          code: "custom",
          path: ["assertions", index],
          message: `Conflicting state values for ${key}`,
        });
      states.set(key, assertion.stateValueId);
    }
  });

export const SEMANTIC_ASSERTION_BUNDLE_SCHEMA = z.union([
  SEMANTIC_HYPOTHESIS_ASSERTION_BUNDLE_SCHEMA,
  SEMANTIC_ADMITTED_ASSERTION_BUNDLE_SCHEMA,
]);
export type SemanticAssertionBundle = z.output<typeof SEMANTIC_ASSERTION_BUNDLE_SCHEMA>;

export function sealSemanticAssertionBundle(
  input: Omit<Extract<SemanticAssertionBundle, { authority: "hypothesis" }>, "kind" | "hash">,
): Extract<SemanticAssertionBundle, { authority: "hypothesis" }>;
export function sealSemanticAssertionBundle(
  input: Omit<Extract<SemanticAssertionBundle, { authority: "admitted" }>, "kind" | "hash">,
): Extract<SemanticAssertionBundle, { authority: "admitted" }>;
export function sealSemanticAssertionBundle(
  input:
    | Omit<Extract<SemanticAssertionBundle, { authority: "hypothesis" }>, "kind" | "hash">
    | Omit<Extract<SemanticAssertionBundle, { authority: "admitted" }>, "kind" | "hash">,
): SemanticAssertionBundle {
  const material =
    input.authority === "hypothesis"
      ? {
          kind: "SemanticAssertionBundle" as const,
          ...input,
          assertions: canonicalize(input.assertions, stableJson, "hypothesis assertions"),
          abstentions: canonicalize(input.abstentions, String, "hypothesis abstentions"),
        }
      : {
          kind: "SemanticAssertionBundle" as const,
          ...input,
          assertions: canonicalize(
            input.assertions.map((assertion) => ({
              ...assertion,
              evidence: {
                ...assertion.evidence,
                evidenceHashes: canonicalize(
                  assertion.evidence.evidenceHashes,
                  String,
                  "assertion evidence hashes",
                ),
              },
            })),
            stableJson,
            "admitted assertions",
          ),
        };
  return freeze(
    SEMANTIC_ASSERTION_BUNDLE_SCHEMA.parse({ ...material, hash: hashMaterial(material) }),
  );
}

/** Validate every authoritative assertion against one exact semantic module.
 * Endpoint sorts for relations may be supplied by the caller when the related
 * subject is admitted in another bundle. */
export function validateAdmittedSemanticAssertions(input: {
  readonly module: SemanticModule;
  readonly bundle: SemanticAssertionBundle;
  readonly resolveExternalSubjectSort?: (
    subject: z.output<typeof SEMANTIC_ASSERTION_SUBJECT_SCHEMA>,
  ) => UpperSort | undefined;
}): asserts input is {
  readonly module: SemanticModule;
  readonly bundle: Extract<SemanticAssertionBundle, { authority: "admitted" }>;
  readonly resolveExternalSubjectSort?: (
    subject: z.output<typeof SEMANTIC_ASSERTION_SUBJECT_SCHEMA>,
  ) => UpperSort | undefined;
} {
  const bundle = SEMANTIC_ASSERTION_BUNDLE_SCHEMA.parse(input.bundle);
  if (bundle.authority !== "admitted")
    throw new Error("Only admitted semantic assertions can satisfy compiler authority");
  const concepts = new Map(input.module.concepts.map((entry) => [entry.conceptId, entry]));
  const affordances = new Set(input.module.affordances.map((entry) => entry.affordanceId));
  const treatments = new Set(
    input.module.surfaceTreatments.map((entry) => entry.surfaceTreatmentId),
  );
  const realizationForms = new Set(
    input.module.realizationForms.map((entry) => entry.realizationForm),
  );
  const stateDimensions = new Map(
    input.module.stateDimensions.map((entry) => [
      entry.stateDimensionId,
      new Set(entry.values.map((value) => value.stateValueId)),
    ]),
  );
  const roleSchemes = new Map(
    input.module.roleSchemes.map((entry) => [
      entry.roleSchemeId,
      new Set(entry.roles.map((role) => role.roleId)),
    ]),
  );
  const relations = new Map(input.module.relations.map((entry) => [entry.relationId, entry]));
  const subjectSorts = new Map<string, UpperSort>();
  for (const assertion of bundle.assertions) {
    if (assertion.assertionKind !== "denotation") continue;
    const concept = concepts.get(assertion.concept.conceptId);
    if (!concept || concept.commitmentHash !== assertion.concept.commitmentHash)
      throw new Error(`Unknown denotation commitment ${assertion.concept.conceptId}`);
    const key = semanticSubjectKey(assertion.subject);
    if (subjectSorts.has(key))
      throw new Error(`Admitted subject ${key} has more than one denotation`);
    subjectSorts.set(key, concept.upperSort);
  }
  const subjectSort = (subject: z.output<typeof SEMANTIC_ASSERTION_SUBJECT_SCHEMA>) =>
    subjectSorts.get(semanticSubjectKey(subject)) ?? input.resolveExternalSubjectSort?.(subject);
  for (const assertion of bundle.assertions) {
    switch (assertion.assertionKind) {
      case "denotation":
        break;
      case "affordance":
        if (!affordances.has(assertion.affordanceId))
          throw new Error(`Unknown affordance ${assertion.affordanceId}`);
        break;
      case "state":
        if (!stateDimensions.get(assertion.stateDimensionId)?.has(assertion.stateValueId))
          throw new Error(
            `State value ${assertion.stateValueId} is outside dimension ${assertion.stateDimensionId}`,
          );
        break;
      case "surface_treatment":
        if (!treatments.has(assertion.surfaceTreatmentId))
          throw new Error(`Unknown surface treatment ${assertion.surfaceTreatmentId}`);
        break;
      case "role":
        if (!roleSchemes.get(assertion.roleSchemeId)?.has(assertion.roleId))
          throw new Error(`Role ${assertion.roleId} is outside scheme ${assertion.roleSchemeId}`);
        break;
      case "relation": {
        const relation = relations.get(assertion.relationId);
        if (!relation) throw new Error(`Unknown relation ${assertion.relationId}`);
        const domain = subjectSort(assertion.subject);
        const range = subjectSort(assertion.object);
        if (!domain || !range)
          throw new Error(
            `Relation ${assertion.relationId} lacks denotation authority for an endpoint`,
          );
        if (!relation.domainSorts.includes(domain) || !relation.rangeSorts.includes(range))
          throw new Error(
            `Relation ${assertion.relationId} rejects ${domain} -> ${range} endpoints`,
          );
        break;
      }
      case "realization_form":
        if (!realizationForms.has(assertion.realizationForm))
          throw new Error(`Unknown realization form ${assertion.realizationForm}`);
        break;
      default:
        assertNever(assertion);
    }
  }
}

export function semanticAncestorDistance(
  module: SemanticModule,
  candidateConceptId: string,
  requirement: SemanticRequirement["denotation"],
): number | undefined {
  const candidate = module.concepts.find((entry) => entry.conceptId === candidateConceptId);
  if (!candidate || candidate.commitmentHash === "") return undefined;
  if (candidate.conceptId === requirement.conceptId)
    return candidate.commitmentHash === requirement.commitmentHash ? 0 : undefined;
  if (requirement.matchMode === "exact") return undefined;
  const index = candidate.ancestors.findIndex(
    (entry) =>
      entry.conceptId === requirement.conceptId &&
      entry.commitmentHash === requirement.commitmentHash,
  );
  if (index < 0) return undefined;
  return shortestAncestorDistance(module, candidate.conceptId, requirement.conceptId);
}

/** Query admitted relation authority using only direct facts and relation-declared
 * symmetric/inverse expansion. No transitive or lexical inference is performed. */
export function semanticRelationHolds(input: {
  readonly module: SemanticModule;
  readonly bundles: readonly Extract<SemanticAssertionBundle, { authority: "admitted" }>[];
  readonly relationId: string;
  readonly subject: z.input<typeof SEMANTIC_ASSERTION_SUBJECT_SCHEMA>;
  readonly object: z.input<typeof SEMANTIC_ASSERTION_SUBJECT_SCHEMA>;
  readonly minimumEvidence?: EvidenceLevel;
}): boolean {
  const relationId = RELATION_ID_SCHEMA.parse(input.relationId);
  const subject = SEMANTIC_ASSERTION_SUBJECT_SCHEMA.parse(input.subject);
  const object = SEMANTIC_ASSERTION_SUBJECT_SCHEMA.parse(input.object);
  const minimumEvidence = EVIDENCE_LEVEL_SCHEMA.parse(input.minimumEvidence ?? "declared");
  const relation = input.module.relations.find((entry) => entry.relationId === relationId);
  if (!relation) throw new Error(`Unknown relation ${relationId}`);
  const concepts = new Map(input.module.concepts.map((entry) => [entry.conceptId, entry]));
  const subjectSorts = new Map<string, UpperSort>();
  for (const bundle of input.bundles)
    for (const assertion of bundle.assertions) {
      if (assertion.assertionKind !== "denotation") continue;
      const concept = concepts.get(assertion.concept.conceptId);
      if (!concept || concept.commitmentHash !== assertion.concept.commitmentHash)
        throw new Error(`Unknown denotation commitment ${assertion.concept.conceptId}`);
      const key = semanticSubjectKey(assertion.subject);
      const previous = subjectSorts.get(key);
      if (previous && previous !== concept.upperSort)
        throw new Error(`Admitted subject ${key} has contradictory upper sorts`);
      subjectSorts.set(key, concept.upperSort);
    }
  for (const bundle of input.bundles)
    validateAdmittedSemanticAssertions({
      module: input.module,
      bundle,
      resolveExternalSubjectSort: (candidate) => subjectSorts.get(semanticSubjectKey(candidate)),
    });
  const matches = (
    assertion: Extract<
      Extract<SemanticAssertionBundle, { authority: "admitted" }>["assertions"][number],
      { assertionKind: "relation" }
    >,
    expectedRelationId: string,
    expectedSubject: typeof subject,
    expectedObject: typeof object,
  ) =>
    assertion.relationId === expectedRelationId &&
    semanticSubjectKey(assertion.subject) === semanticSubjectKey(expectedSubject) &&
    semanticSubjectKey(assertion.object) === semanticSubjectKey(expectedObject) &&
    evidenceSatisfies(assertion.evidence.level, minimumEvidence);
  for (const bundle of input.bundles)
    for (const assertion of bundle.assertions) {
      if (assertion.assertionKind !== "relation") continue;
      if (matches(assertion, relationId, subject, object)) return true;
      if (relation.symmetric && matches(assertion, relationId, object, subject)) return true;
      if (
        relation.inverseRelationId &&
        matches(assertion, relation.inverseRelationId, object, subject)
      )
        return true;
    }
  return false;
}

export function evidenceSatisfies(observed: EvidenceLevel, minimum: EvidenceLevel): boolean {
  return EVIDENCE_LEVELS.indexOf(observed) >= EVIDENCE_LEVELS.indexOf(minimum);
}

export function sealDefinition<T extends { readonly kind: string }>(
  input: T,
): T & { readonly hash: string } {
  return freeze({ ...input, hash: hashMaterial(input) });
}

function hashedDefinition<K extends string, S extends z.ZodTypeAny, F extends string>(
  kind: K,
  idSchema: S,
  idField: F,
) {
  return z
    .object({
      kind: z.literal(kind),
      [idField]: idSchema,
      normativeDefinition: definition,
      hash: HASH_SCHEMA,
    } as Record<F | "kind" | "normativeDefinition" | "hash", z.ZodTypeAny>)
    .strict()
    .superRefine((value, context) => verifyHash(value, "hash", context)) as z.ZodType<
    { readonly kind: K; readonly normativeDefinition: string; readonly hash: string } & {
      readonly [P in F]: z.output<S>;
    }
  >;
}

function shortestAncestorDistance(
  module: SemanticModule,
  from: string,
  to: string,
): number | undefined {
  const byId = new Map(module.concepts.map((entry) => [entry.conceptId, entry]));
  const queue = [{ id: from, distance: 0 }];
  const visited = new Set<string>();
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]!;
    if (current.id === to) return current.distance;
    if (visited.has(current.id)) continue;
    visited.add(current.id);
    const concept = byId.get(current.id);
    if (concept)
      for (const parent of concept.directParents)
        queue.push({ id: parent.conceptId, distance: current.distance + 1 });
  }
  return undefined;
}

function parseCanonical<T extends z.ZodTypeAny>(
  values: readonly unknown[],
  schema: T,
  idField: string,
): z.output<T>[] {
  return canonicalize(
    values.map((entry) => schema.parse(entry)),
    (entry) => String((entry as Record<string, unknown>)[idField]),
    idField,
  );
}

function validateStateAndRoleIdentities(
  dimensions: readonly StateDimensionDefinition[],
  schemes: readonly RoleSchemeDefinition[],
): void {
  uniqueBy(
    dimensions.flatMap((entry) => entry.values),
    (entry) => entry.stateValueId,
    "state value",
  );
  uniqueBy(
    schemes.flatMap((entry) => entry.roles),
    (entry) => entry.roleId,
    "role",
  );
}

function validateRelations(relations: readonly RelationDefinition[]): void {
  const byId = new Map(relations.map((entry) => [entry.relationId, entry]));
  for (const relation of relations) {
    if (relation.inverseRelationId && !byId.has(relation.inverseRelationId))
      throw new Error(`Relation ${relation.relationId} has an unknown inverse`);
    if (
      relation.symmetric &&
      relation.inverseRelationId &&
      relation.inverseRelationId !== relation.relationId
    )
      throw new Error(`Symmetric relation ${relation.relationId} cannot name another inverse`);
    if (relation.inverseRelationId) {
      const inverse = byId.get(relation.inverseRelationId)!;
      if (inverse.inverseRelationId !== relation.relationId)
        throw new Error(`Relation ${relation.relationId} has a non-reciprocal inverse`);
      if (
        stableJson(relation.domainSorts) !== stableJson(inverse.rangeSorts) ||
        stableJson(relation.rangeSorts) !== stableJson(inverse.domainSorts)
      )
        throw new Error(
          `Relation ${relation.relationId} inverse has incompatible domain and range`,
        );
    }
  }
}

function semanticSubjectKey(subject: z.output<typeof SEMANTIC_ASSERTION_SUBJECT_SCHEMA>): string {
  return `${subject.kind}:${subject.id}`;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled semantic assertion: ${stableJson(value)}`);
}

function canonicalize<T>(values: readonly T[], key: (value: T) => string, label: string): T[] {
  const result = [...values].sort((left, right) => compareCanonicalStrings(key(left), key(right)));
  if (new Set(result.map(key)).size !== result.length) throw new Error(`${label} must be unique`);
  return result;
}

function validateCanonicalArray<T>(
  values: readonly T[],
  key: (value: T) => string,
  label: string,
  context: z.RefinementCtx,
): void {
  const keys = values.map(key);
  if (new Set(keys).size !== keys.length)
    context.addIssue({ code: "custom", message: `${label} must be unique` });
  if (
    keys.some((value, index) => index > 0 && compareCanonicalStrings(keys[index - 1]!, value) >= 0)
  )
    context.addIssue({ code: "custom", message: `${label} must use canonical order` });
}

function uniqueBy<T>(
  values: readonly T[],
  key: (value: T) => string,
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

function hashMaterial(value: unknown): string {
  return contentHash(stableJson(value));
}

function verifyHash(
  value: Record<string, unknown>,
  hashField: string,
  context: z.RefinementCtx,
): void {
  const material = { ...value };
  delete material[hashField];
  if (hashMaterial(material) !== value[hashField])
    context.addIssue({ code: "custom", path: [hashField], message: `${hashField} mismatch` });
}

function freeze<T>(value: T): T {
  return deepFreezeJson(value) as T;
}
