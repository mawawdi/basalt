import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  CATALOG_ADMISSION_POLICY_SCHEMA,
  CATALOG_ADMISSION_RUBRIC_SCHEMA,
  CATALOG_CREATOR_REVIEW_PACKET_SCHEMA,
  CATALOG_VISUAL_REVIEW_INDEX_SCHEMA,
  sealCatalogAcceptanceAudit,
  sealCatalogCreatorReviewDecision,
  validateCatalogCreatorReviewDecision,
} from "../packages/catalog-authoring/dist/index.js";
import {
  CATALOG_DISPOSITION_SCHEMA,
  CATALOG_ENTRY_DECLARATION_SCHEMA,
  CATALOG_MEASUREMENT_SET_SCHEMA,
  STYLE_PROFILE_DECLARATION_SCHEMA,
  TRUSTED_SOURCE_MANIFEST_SCHEMA,
  sealCatalogSnapshot,
  sealStyleProfile,
} from "../packages/catalog-model/dist/index.js";
import { contentHash, stableJson } from "../packages/contracts/dist/index.js";
import {
  AFFORDANCE_DEFINITION_SCHEMA,
  ANNOTATION_PREDICATE_DEFINITION_SCHEMA,
  CONCEPT_COMMITMENT_SCHEMA,
  REALIZATION_FORM_DEFINITION_SCHEMA,
  RELATION_DEFINITION_SCHEMA,
  ROLE_SCHEME_DEFINITION_SCHEMA,
  SEMANTIC_ADMITTED_ASSERTION_BUNDLE_SCHEMA,
  SEMANTIC_CONSTRAINT_SET_SCHEMA,
  SEMANTIC_KERNEL_SCHEMA,
  STATE_DIMENSION_DEFINITION_SCHEMA,
  SURFACE_TREATMENT_DEFINITION_SCHEMA,
  createSemanticDependencyClosure,
  sealSemanticAssertionBundle,
  sealSemanticModule,
} from "../packages/semantic-kernel/dist/index.js";

const root = resolve(".");
const options = parseOptions(process.argv.slice(2));
const decisionPath = options.get("--decision");
if (!decisionPath)
  throw new Error("Outdoor admission requires --decision with the completed creator decision");
const packetPath =
  options.get("--packet") ?? ".basalt/catalog/admission/outdoor-tranche/review-packet.json";

const packet = CATALOG_CREATOR_REVIEW_PACKET_SCHEMA.parse(await readJson(packetPath));
const decisionDraft = await readJson(decisionPath);
const decisionMaterial = { ...decisionDraft };
delete decisionMaterial.kind;
delete decisionMaterial.hash;
const decision = sealCatalogCreatorReviewDecision(decisionMaterial);
const rubric = CATALOG_ADMISSION_RUBRIC_SCHEMA.parse(
  await readJson("registry/admission-rubric.json"),
);
validateCatalogCreatorReviewDecision({ packet, decision, rubric });

const [
  module,
  measurements,
  policy,
  dispositions,
  styleProfiles,
  manifest,
  visualReview,
  existingAssertions,
  existingDeclarations,
] = await Promise.all([
  loadSemanticModule(),
  readJson(".basalt/catalog/measurements.json").then((value) =>
    CATALOG_MEASUREMENT_SET_SCHEMA.parse(value),
  ),
  readJson("registry/admission-policy.json").then((value) =>
    CATALOG_ADMISSION_POLICY_SCHEMA.parse(value),
  ),
  readJson("registry/dispositions.json").then((value) =>
    CATALOG_DISPOSITION_SCHEMA.array().parse(value),
  ),
  readJson("registry/style-profiles.json").then((value) =>
    STYLE_PROFILE_DECLARATION_SCHEMA.array().parse(value),
  ),
  readJson("registry/source-manifest.json").then((value) =>
    TRUSTED_SOURCE_MANIFEST_SCHEMA.parse(value),
  ),
  readJson(".basalt/catalog/review/index.json").then((value) =>
    CATALOG_VISUAL_REVIEW_INDEX_SCHEMA.parse(value),
  ),
  readDirectoryJson("registry/assertions", SEMANTIC_ADMITTED_ASSERTION_BUNDLE_SCHEMA),
  readDirectoryJson("registry/entries", CATALOG_ENTRY_DECLARATION_SCHEMA),
]);
for (const [name, actual, expected] of [
  ["source manifest", contentHash(stableJson(manifest)), packet.sourceManifestHash],
  ["semantic module", module.snapshot.hash, packet.semanticModuleHash],
  ["measurement set", measurements.hash, packet.measurementSetHash],
  ["visual review index", visualReview.hash, packet.visualReviewIndexHash],
  ["admission policy", policy.hash, packet.admissionPolicyHash],
  ["admission rubric", rubric.hash, packet.admissionRubricHash],
])
  if (actual !== expected) throw new Error(`Outdoor creator decision binds stale ${name}`);

const assetBySource = new Map(
  measurements.assets.map((asset) => [asset.source.contentHash, asset]),
);
const candidateBySource = new Map(
  packet.candidates.map((candidate) => [candidate.sourceContentHash, candidate]),
);
const dispositionBySource = new Map(
  dispositions.map((disposition) => [disposition.sourceContentHash, disposition]),
);
const assertions = [];
const declarations = [];
const audits = [];
const nextDispositions = new Map(dispositionBySource);

for (const sourceDecision of decision.decisions) {
  const candidate = candidateBySource.get(sourceDecision.sourceContentHash);
  const asset = assetBySource.get(sourceDecision.sourceContentHash);
  const currentDisposition = dispositionBySource.get(sourceDecision.sourceContentHash);
  if (!candidate || !asset || !currentDisposition)
    throw new Error(
      `Outdoor decision references missing authority: ${sourceDecision.sourceContentHash}`,
    );
  if (currentDisposition.status !== "incomplete")
    throw new Error(
      `Outdoor decision source is no longer pending: ${sourceDecision.sourceContentHash}`,
    );
  if (asset.hash !== candidate.assetHash)
    throw new Error(
      `Outdoor decision asset measurement is stale: ${sourceDecision.sourceContentHash}`,
    );

  if (sourceDecision.outcome !== "eligible") {
    nextDispositions.set(sourceDecision.sourceContentHash, {
      sourceContentHash: sourceDecision.sourceContentHash,
      status: sourceDecision.outcome,
      reason: sourceDecision.note,
    });
    continue;
  }

  const closure = createSemanticDependencyClosure({
    module,
    conceptIds: [candidate.proposal.denotation.conceptId],
    definitionIds: [candidate.proposal.realizationForm],
  });
  const assertion = sealSemanticAssertionBundle({
    authority: "admitted",
    assertions: [
      {
        assertionKind: "denotation",
        subject: { kind: "catalog_asset", id: candidate.assetId },
        concept: candidate.proposal.denotation,
        evidence: {
          level: "declared",
          evidenceHashes: [decision.hash, packet.hash].sort(compare),
        },
      },
      {
        assertionKind: "realization_form",
        subject: { kind: "catalog_asset", id: candidate.assetId },
        realizationForm: candidate.proposal.realizationForm,
        evidence: {
          level: "measured",
          evidenceHashes: [
            ...new Set([candidate.assetHash, candidate.evidence.measurementHash]),
          ].sort(compare),
        },
      },
    ],
  });
  const declaration = CATALOG_ENTRY_DECLARATION_SCHEMA.parse({
    kind: "substitution_set",
    handle: candidate.proposal.entryHandle,
    semantic: {
      denotation: candidate.proposal.denotation,
      realizationForm: candidate.proposal.realizationForm,
      fixedStates: [],
      affordances: [],
      surfaceTreatmentIds: [],
      dependencyClosureHash: closure.hash,
    },
    placement: candidate.proposal.placement,
    styleProfileHandle: candidate.proposal.styleProfileHandle,
    evidenceHashes: [
      candidate.evidence.measurementHash,
      candidate.evidence.renderEvidenceHash,
      decision.hash,
      packet.hash,
    ].sort(compare),
    members: [
      {
        memberId: candidate.proposal.memberId,
        assetHash: candidate.assetHash,
        assertionBundleHash: assertion.hash,
        selectionWeight: 1,
        socketBindings: [],
      },
    ],
  });
  const audit = sealCatalogAcceptanceAudit({
    batchId: packet.batchId,
    reviewPacketHash: packet.hash,
    reviewDecisionHash: decision.hash,
    reviewer: decision.reviewer,
    admissionPolicyHash: policy.hash,
    admissionRubricHash: rubric.hash,
    semanticModuleHash: module.snapshot.hash,
    measurementSetHash: measurements.hash,
    visualReviewIndexHash: packet.visualReviewIndexHash,
    sourceContentHash: candidate.sourceContentHash,
    assetHash: candidate.assetHash,
    renderEvidenceHash: candidate.evidence.renderEvidenceHash,
    assertionBundleHash: assertion.hash,
    entryHandle: declaration.handle,
    memberId: candidate.proposal.memberId,
    entryDeclarationHash: contentHash(stableJson(declaration)),
    styleProfileHandle: candidate.proposal.styleProfileHandle,
    criteria: sourceDecision.criteria,
  });
  assertions.push({ sourceContentHash: candidate.sourceContentHash, value: assertion });
  declarations.push({ sourceContentHash: candidate.sourceContentHash, value: declaration });
  audits.push({ sourceContentHash: candidate.sourceContentHash, value: audit });
  nextDispositions.set(candidate.sourceContentHash, {
    sourceContentHash: candidate.sourceContentHash,
    status: "eligible",
    usage: {
      kind: "entry_member",
      entryHandle: declaration.handle,
      memberId: candidate.proposal.memberId,
    },
  });
}

const eligibleCount = assertions.length;
const nextStyles = [...styleProfiles];
if (eligibleCount > 0) {
  if (decision.styleProfileDecision !== "approved")
    throw new Error("Eligible outdoor sources require the creator-approved style profile");
  const existingStyle = nextStyles.find(
    (style) => style.handle === packet.proposedStyleProfile.handle,
  );
  if (existingStyle && stableJson(existingStyle) !== stableJson(packet.proposedStyleProfile))
    throw new Error(`Style profile conflict: ${packet.proposedStyleProfile.handle}`);
  if (!existingStyle) nextStyles.push(packet.proposedStyleProfile);
}

const canonicalDispositions = [...nextDispositions.values()].sort((left, right) =>
  compare(left.sourceContentHash, right.sourceContentHash),
);
const mergedAssertions = mergeExact(
  existingAssertions,
  assertions.map((entry) => entry.value),
  (entry) => entry.hash,
  "assertion bundle",
);
const mergedDeclarations = mergeExact(
  existingDeclarations,
  declarations.map((entry) => entry.value),
  (entry) => entry.handle,
  "entry declaration",
);
// Validate the complete future authority snapshot before writing any artifact. This keeps a
// rejected declaration from leaving dispositions, assertions, or entries partially staged.
sealCatalogSnapshot({
  semanticModule: module,
  semanticAssertions: mergedAssertions,
  styleProfiles: nextStyles.map((style) => sealStyleProfile(style)),
  assets: measurements.assets,
  declarations: mergedDeclarations,
  dispositions: canonicalDispositions,
  sourceContentHashes: manifest.assets.map((asset) => asset.contentHash),
});

const writes = [
  ...assertions.map((entry) => ({
    path: `registry/assertions/${entry.sourceContentHash}.json`,
    value: entry.value,
  })),
  ...declarations.map((entry) => ({
    path: `registry/entries/${entry.value.handle}.json`,
    value: entry.value,
  })),
  ...audits.map((entry) => ({
    path: `registry/acceptance-audits/${entry.sourceContentHash}.json`,
    value: entry.value,
  })),
  { path: `registry/evidence/${packet.hash}.json`, value: packet },
  { path: `registry/evidence/${decision.hash}.json`, value: decision },
];
for (const write of writes) await requireAbsentOrExact(write.path, write.value);
for (const write of writes) await writeJson(write.path, write.value);
await writeJson("registry/dispositions.json", canonicalDispositions);
await writeJson(
  "registry/style-profiles.json",
  nextStyles.sort((left, right) => compare(left.handle, right.handle)),
);

process.stdout.write(
  `${JSON.stringify(
    {
      status: "eligible",
      packetHash: packet.hash,
      decisionHash: decision.hash,
      reviewer: decision.reviewer,
      dispositions: Object.fromEntries(
        ["eligible", "incomplete", "rejected"].map((status) => [
          status,
          decision.decisions.filter((entry) => entry.outcome === status).length,
        ]),
      ),
      assertions: assertions.length,
      singletonEntries: declarations.length,
      acceptanceAudits: audits.length,
    },
    null,
    2,
  )}\n`,
);

async function loadSemanticModule() {
  const semanticRoot = "registry/semantics";
  const [
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
  ] = await Promise.all([
    readJson(`${semanticRoot}/kernel.json`).then((value) => SEMANTIC_KERNEL_SCHEMA.parse(value)),
    readDirectoryJson(`${semanticRoot}/concepts`, CONCEPT_COMMITMENT_SCHEMA),
    readJson(`${semanticRoot}/affordances.json`).then((value) =>
      AFFORDANCE_DEFINITION_SCHEMA.array().parse(value),
    ),
    readJson(`${semanticRoot}/realization-forms.json`).then((value) =>
      REALIZATION_FORM_DEFINITION_SCHEMA.array().parse(value),
    ),
    readJson(`${semanticRoot}/states.json`).then((value) =>
      STATE_DIMENSION_DEFINITION_SCHEMA.array().parse(value),
    ),
    readJson(`${semanticRoot}/treatments.json`).then((value) =>
      SURFACE_TREATMENT_DEFINITION_SCHEMA.array().parse(value),
    ),
    readDirectoryJson(`${semanticRoot}/roles`, ROLE_SCHEME_DEFINITION_SCHEMA),
    readJson(`${semanticRoot}/relations.json`).then((value) =>
      RELATION_DEFINITION_SCHEMA.array().parse(value),
    ),
    readJson(`${semanticRoot}/annotation-predicates.json`).then((value) =>
      ANNOTATION_PREDICATE_DEFINITION_SCHEMA.array().parse(value),
    ),
    readJson(`${semanticRoot}/constraints.json`).then((value) =>
      SEMANTIC_CONSTRAINT_SET_SCHEMA.parse(value),
    ),
  ]);
  return sealSemanticModule({
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
  });
}

async function readDirectoryJson(path, schema) {
  const absolute = resolve(root, path);
  const names = (await readdir(absolute)).filter((name) => name.endsWith(".json")).sort(compare);
  return Promise.all(
    names.map(async (name) =>
      schema.parse(JSON.parse(await readFile(resolve(absolute, name), "utf8"))),
    ),
  );
}

async function requireAbsentOrExact(path, value) {
  const absolute = resolve(root, path);
  const information = await lstat(absolute).catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!information) return;
  if (!information.isFile() || information.isSymbolicLink())
    throw new Error(`Refusing to replace non-regular admission artifact: ${path}`);
  const current = JSON.parse(await readFile(absolute, "utf8"));
  if (stableJson(current) !== stableJson(value))
    throw new Error(`Refusing to replace conflicting admission artifact: ${path}`);
}

async function readJson(path) {
  return JSON.parse(await readFile(resolve(root, path), "utf8"));
}

async function writeJson(path, value) {
  const absolute = resolve(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function parseOptions(values) {
  const result = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || !value)
      throw new Error("Outdoor admission options must be --name value pairs");
    result.set(key, value);
  }
  return result;
}

function mergeExact(existing, additions, key, label) {
  const merged = new Map(existing.map((entry) => [key(entry), entry]));
  for (const entry of additions) {
    const identity = key(entry);
    const current = merged.get(identity);
    if (current && stableJson(current) !== stableJson(entry))
      throw new Error(`Conflicting ${label}: ${identity}`);
    merged.set(identity, entry);
  }
  return [...merged.values()].sort((left, right) => compare(key(left), key(right)));
}

function compare(left, right) {
  return left.localeCompare(right);
}
