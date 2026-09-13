import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  AFFORDANCE_DEFINITION_SCHEMA,
  ANNOTATION_PREDICATE_DEFINITION_SCHEMA,
  CONCEPT_COMMITMENT_SCHEMA,
  REALIZATION_FORM_DEFINITION_SCHEMA,
  RELATION_DEFINITION_SCHEMA,
  ROLE_SCHEME_DEFINITION_SCHEMA,
  SEMANTIC_CONSTRAINT_SET_SCHEMA,
  SEMANTIC_HYPOTHESIS_ASSERTION_BUNDLE_SCHEMA,
  SEMANTIC_KERNEL_SCHEMA,
  SEMANTIC_LEXICON_SNAPSHOT_SCHEMA,
  STATE_DIMENSION_DEFINITION_SCHEMA,
  SURFACE_TREATMENT_DEFINITION_SCHEMA,
  createSemanticDependencyClosure,
  sealConceptCommitments,
  sealSemanticAssertionBundle,
  sealSemanticLexicon,
  sealSemanticModule,
  semanticRelationHolds,
  validateAdmittedSemanticAssertions,
} from "@basalt/semantic-kernel";
import { contentHash, stableJson } from "@basalt/contracts";

const registryRoot = resolve("registry/semantics");

test("the complete semantic registry seals with exact proposal counts", async () => {
  const module = await loadModule();
  assert.equal(module.concepts.length, 146);
  assert.equal(module.affordances.length, 24);
  assert.equal(module.realizationForms.length, 6);
  assert.equal(module.stateDimensions.length, 7);
  assert.equal(module.stateDimensions.flatMap((entry) => entry.values).length, 22);
  assert.equal(module.surfaceTreatments.length, 7);
  assert.equal(module.roleSchemes.length, 4);
  assert.equal(module.roleSchemes.flatMap((entry) => entry.roles).length, 44);
  assert.equal(module.relations.length, 11);
  assert.deepEqual(
    module.relations.filter((entry) => entry.symmetric).map((entry) => entry.relationId),
    ["bre_000006", "bre_000009", "bre_000010"],
  );
  assert.equal(module.annotationPredicates.length, 1);
});

test("labels are isolated and unrelated leaves preserve existing commitments and closures", async () => {
  const module = await loadModule();
  const tree = module.concepts.find((entry) => entry.conceptId === "bsc_000003")!;
  const closure = createSemanticDependencyClosure({
    module,
    conceptIds: [tree.conceptId],
  });
  const lexicon = SEMANTIC_LEXICON_SNAPSHOT_SCHEMA.parse(await json("lexicon.json"));
  const changedLexicon = sealSemanticLexicon(
    lexicon.entries.map((entry) =>
      entry.subjectId === tree.conceptId
        ? { ...entry, preferredLabels: { en: "tree renamed for authoring" } }
        : entry,
    ),
  );
  assert.notEqual(changedLexicon.hash, lexicon.hash);
  assert.equal(
    module.concepts.find((entry) => entry.conceptId === tree.conceptId)!.commitmentHash,
    tree.commitmentHash,
  );

  const declarations = module.concepts.map((entry) => ({
    conceptId: entry.conceptId,
    upperSort: entry.upperSort,
    normativeDefinition: entry.normativeDefinition,
    identityCriteria: entry.identityCriteria,
    parentIds: entry.directParents.map((parent) => parent.conceptId),
  }));
  const extendedConcepts = sealConceptCommitments({
    kernel: module.kernel,
    declarations: [
      ...declarations,
      {
        conceptId: "bsc_999999",
        upperSort: "object" as const,
        normativeDefinition:
          "A synthetic unrelated object used only to test localized semantic invalidation.",
        identityCriteria: {
          necessary: [
            "The entity satisfies the synthetic unrelated object identity used by this test.",
          ],
          excludes: [
            "Entities admitted under any existing domain concept are excluded from this test concept.",
          ],
        },
        parentIds: [],
      },
    ],
  });
  const extended = sealSemanticModule({ ...module, concepts: extendedConcepts });
  const extendedTree = extended.concepts.find((entry) => entry.conceptId === tree.conceptId)!;
  assert.equal(extendedTree.commitmentHash, tree.commitmentHash);
  assert.equal(
    createSemanticDependencyClosure({ module: extended, conceptIds: [tree.conceptId] }).hash,
    closure.hash,
  );
  assert.notEqual(extended.snapshot.hash, module.snapshot.hash);
});

test("semantic commitments reject cycles and cross-sort inheritance", async () => {
  const module = await loadModule();
  assert.throws(
    () =>
      sealConceptCommitments({
        kernel: module.kernel,
        declarations: [
          {
            conceptId: "bsc_900001",
            upperSort: "object",
            normativeDefinition:
              "A first synthetic object participating in an invalid semantic cycle.",
            identityCriteria: {
              necessary: ["The first cyclic synthetic identity condition must hold."],
              excludes: ["All non-cyclic identities are excluded from this synthetic condition."],
            },
            parentIds: ["bsc_900002"],
          },
          {
            conceptId: "bsc_900002",
            upperSort: "object",
            normativeDefinition:
              "A second synthetic object participating in an invalid semantic cycle.",
            identityCriteria: {
              necessary: ["The second cyclic synthetic identity condition must hold."],
              excludes: ["All non-cyclic identities are excluded from this synthetic condition."],
            },
            parentIds: ["bsc_900001"],
          },
        ],
      }),
    /cycle/u,
  );
  assert.throws(
    () =>
      sealConceptCommitments({
        kernel: module.kernel,
        declarations: [
          {
            conceptId: "bsc_900003",
            upperSort: "space",
            normativeDefinition:
              "A synthetic space used to test forbidden inheritance from an object.",
            identityCriteria: {
              necessary: ["The candidate is a synthetic spatial extent."],
              excludes: ["Bounded persistent objects are excluded."],
            },
            parentIds: ["bsc_900004"],
          },
          {
            conceptId: "bsc_900004",
            upperSort: "object",
            normativeDefinition:
              "A synthetic object used as an invalid parent for a spatial concept.",
            identityCriteria: {
              necessary: ["The candidate is a synthetic bounded object."],
              excludes: ["Spatial extents are excluded."],
            },
            parentIds: [],
          },
        ],
      }),
    /Cross-sort/u,
  );
});

test("semantic commitments materialize deterministic multi-parent ancestry", async () => {
  const module = await loadModule();
  const identityCriteria = (name: string) => ({
    necessary: [`The candidate satisfies the ${name} identity condition.`],
    excludes: [`Candidates outside the ${name} identity condition are excluded.`],
  });
  const concepts = sealConceptCommitments({
    kernel: module.kernel,
    declarations: [
      {
        conceptId: "bsc_910001",
        upperSort: "object",
        normativeDefinition: "The first parent of a synthetic multiply inherited object.",
        identityCriteria: identityCriteria("first synthetic parent"),
        parentIds: [],
      },
      {
        conceptId: "bsc_910002",
        upperSort: "object",
        normativeDefinition: "The second parent of a synthetic multiply inherited object.",
        identityCriteria: identityCriteria("second synthetic parent"),
        parentIds: [],
      },
      {
        conceptId: "bsc_910003",
        upperSort: "object",
        normativeDefinition: "A synthetic object whose identity specializes both parents.",
        identityCriteria: identityCriteria("multiply inherited synthetic child"),
        parentIds: ["bsc_910002", "bsc_910001"],
      },
    ],
  });
  const child = concepts.find((entry) => entry.conceptId === "bsc_910003")!;
  assert.deepEqual(
    child.directParents.map((parent) => parent.conceptId),
    ["bsc_910001", "bsc_910002"],
  );
  assert.deepEqual(
    child.ancestors.map((ancestor) => ancestor.conceptId),
    ["bsc_910001", "bsc_910002"],
  );
});

test("semantic assertion bundles canonicalize set order and reject duplicates", async () => {
  const module = await loadModule();
  const concept = module.concepts.find((entry) => entry.conceptId === "bsc_000003")!;
  const assertions = [
    {
      assertionKind: "denotation" as const,
      subject: { kind: "catalog_asset" as const, id: "asset" },
      concept: { conceptId: concept.conceptId, commitmentHash: concept.commitmentHash },
      confidence: 0.9,
    },
    {
      assertionKind: "realization_form" as const,
      subject: { kind: "catalog_asset" as const, id: "asset" },
      realizationForm: "whole" as const,
      confidence: 0.8,
    },
  ];
  const first = sealSemanticAssertionBundle({
    authority: "hypothesis",
    hypothesisSourceHash: "a".repeat(64),
    assertions,
    abstentions: ["zeta", "alpha"],
  });
  const reordered = sealSemanticAssertionBundle({
    authority: "hypothesis",
    hypothesisSourceHash: "a".repeat(64),
    assertions: [...assertions].reverse(),
    abstentions: ["alpha", "zeta"],
  });
  assert.equal(first.hash, reordered.hash);
  const nonCanonical = {
    kind: "SemanticAssertionBundle" as const,
    authority: "hypothesis" as const,
    hypothesisSourceHash: "a".repeat(64),
    assertions,
    abstentions: ["zeta", "alpha"],
  };
  assert.throws(
    () =>
      SEMANTIC_HYPOTHESIS_ASSERTION_BUNDLE_SCHEMA.parse({
        ...nonCanonical,
        hash: contentHash(stableJson(nonCanonical)),
      }),
    /canonical order/u,
  );
  assert.throws(
    () =>
      sealSemanticAssertionBundle({
        authority: "hypothesis",
        hypothesisSourceHash: "a".repeat(64),
        assertions: [assertions[0]!, assertions[0]!],
        abstentions: [],
      }),
    /must be unique/u,
  );
});

test("admitted assertion bundles reject contradictory states", async () => {
  const evidenceHash = "a".repeat(64);
  assert.throws(
    () =>
      sealSemanticAssertionBundle({
        authority: "admitted",
        assertions: [
          {
            assertionKind: "state",
            subject: { kind: "catalog_asset", id: "asset_test" },
            stateDimensionId: "bsd_000001",
            stateValueId: "bsv_000001",
            evidence: { level: "declared", evidenceHashes: [evidenceHash] },
          },
          {
            assertionKind: "state",
            subject: { kind: "catalog_asset", id: "asset_test" },
            stateDimensionId: "bsd_000001",
            stateValueId: "bsv_000002",
            evidence: { level: "measured", evidenceHashes: [evidenceHash] },
          },
        ],
      }),
    /Conflicting state/u,
  );
});

test("module sealing rejects a self-consistent hash over stale ancestry", async () => {
  const module = await loadModule();
  const target = module.concepts.find((entry) => entry.conceptId === "bsc_000003")!;
  const { commitmentHash: _commitmentHash, ...base } = target;
  const material = { ...base, ancestors: [] };
  const stale = { ...material, commitmentHash: contentHash(stableJson(material)) };
  const { snapshot: _snapshot, ...authority } = module;
  assert.throws(
    () =>
      sealSemanticModule({
        ...authority,
        concepts: module.concepts.map((entry) =>
          entry.conceptId === target.conceptId ? stale : entry,
        ),
      }),
    /exact sealed parent and ancestry graph/u,
  );
});

test("admitted assertions reject out-of-scheme roles and invalid relation sorts", async () => {
  const module = await loadModule();
  const object = module.concepts.find((entry) => entry.upperSort === "object")!;
  const evidence = { level: "declared" as const, evidenceHashes: ["a".repeat(64)] };
  const subject = { kind: "catalog_asset" as const, id: "asset_subject" };
  const objectTarget = { kind: "catalog_asset" as const, id: "asset_target" };
  const invalidRole = sealSemanticAssertionBundle({
    authority: "admitted",
    assertions: [
      { assertionKind: "denotation", subject, concept: conceptRef(object), evidence },
      {
        assertionKind: "role",
        subject,
        roleSchemeId: module.roleSchemes[0]!.roleSchemeId,
        roleId: module.roleSchemes[1]!.roles[0]!.roleId,
        evidence,
      },
    ],
  });
  assert.throws(
    () => validateAdmittedSemanticAssertions({ module, bundle: invalidRole }),
    /outside scheme/u,
  );

  const invalidRelation = sealSemanticAssertionBundle({
    authority: "admitted",
    assertions: [
      { assertionKind: "denotation", subject, concept: conceptRef(object), evidence },
      {
        assertionKind: "denotation",
        subject: objectTarget,
        concept: conceptRef(object),
        evidence,
      },
      {
        assertionKind: "relation",
        subject,
        relationId: "bre_000005",
        object: objectTarget,
        evidence,
      },
    ],
  });
  assert.throws(
    () => validateAdmittedSemanticAssertions({ module, bundle: invalidRelation }),
    /rejects object -> object/u,
  );
});

test("relation reasoning expands only declared symmetry or inverses and respects evidence", async () => {
  const module = await loadModule();
  const object = module.concepts.find((entry) => entry.upperSort === "object")!;
  const evidence = {
    level: "declared" as const,
    evidenceHashes: [contentHash("relation-evidence")],
  };
  const first = { kind: "catalog_asset" as const, id: "asset_first" };
  const second = { kind: "catalog_asset" as const, id: "asset_second" };
  const bundle = sealSemanticAssertionBundle({
    authority: "admitted",
    assertions: [
      { assertionKind: "denotation", subject: first, concept: conceptRef(object), evidence },
      { assertionKind: "denotation", subject: second, concept: conceptRef(object), evidence },
      {
        assertionKind: "relation",
        subject: first,
        relationId: "bre_000006",
        object: second,
        evidence,
      },
      {
        assertionKind: "relation",
        subject: first,
        relationId: "bre_000008",
        object: second,
        evidence,
      },
    ],
  });
  assert.equal(
    semanticRelationHolds({
      module,
      bundles: [bundle],
      relationId: "bre_000006",
      subject: second,
      object: first,
    }),
    true,
  );
  assert.equal(
    semanticRelationHolds({
      module,
      bundles: [bundle],
      relationId: "bre_000008",
      subject: second,
      object: first,
    }),
    false,
  );
  assert.equal(
    semanticRelationHolds({
      module,
      bundles: [bundle],
      relationId: "bre_000006",
      subject: first,
      object: second,
      minimumEvidence: "measured",
    }),
    false,
  );
});

test("the lexicon refuses an alias shared by distinct commitments", () => {
  const entry = (subjectId: string) => ({
    subjectKind: "concept" as const,
    subjectId,
    preferredLabels: { en: "ambiguous fixture label" },
    alternateLabels: [],
    hiddenLabels: [],
    examples: [],
    counterexamples: [],
    externalMappings: [],
  });
  assert.throws(
    () => sealSemanticLexicon([entry("bsc_000001"), entry("bsc_000002")]),
    /Ambiguous label/u,
  );
});

function conceptRef(concept: { conceptId: string; commitmentHash: string }) {
  return { conceptId: concept.conceptId, commitmentHash: concept.commitmentHash };
}

async function loadModule() {
  const kernel = SEMANTIC_KERNEL_SCHEMA.parse(await json("kernel.json"));
  const conceptFiles = (await readdir(resolve(registryRoot, "concepts"))).sort();
  const roleFiles = (await readdir(resolve(registryRoot, "roles"))).sort();
  return sealSemanticModule({
    kernel,
    concepts: await Promise.all(
      conceptFiles.map(async (file) =>
        CONCEPT_COMMITMENT_SCHEMA.parse(await json(`concepts/${file}`)),
      ),
    ),
    affordances: AFFORDANCE_DEFINITION_SCHEMA.array().parse(await json("affordances.json")),
    realizationForms: REALIZATION_FORM_DEFINITION_SCHEMA.array().parse(
      await json("realization-forms.json"),
    ),
    stateDimensions: STATE_DIMENSION_DEFINITION_SCHEMA.array().parse(await json("states.json")),
    surfaceTreatments: SURFACE_TREATMENT_DEFINITION_SCHEMA.array().parse(
      await json("treatments.json"),
    ),
    roleSchemes: await Promise.all(
      roleFiles.map(async (file) =>
        ROLE_SCHEME_DEFINITION_SCHEMA.parse(await json(`roles/${file}`)),
      ),
    ),
    relations: RELATION_DEFINITION_SCHEMA.array().parse(await json("relations.json")),
    annotationPredicates: ANNOTATION_PREDICATE_DEFINITION_SCHEMA.array().parse(
      await json("annotation-predicates.json"),
    ),
    constraints: SEMANTIC_CONSTRAINT_SET_SCHEMA.parse(await json("constraints.json")),
  });
}

async function json(path: string): Promise<unknown> {
  return JSON.parse(await readFile(resolve(registryRoot, path), "utf8"));
}
