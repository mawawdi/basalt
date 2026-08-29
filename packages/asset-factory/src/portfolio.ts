import { z } from "zod";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import { compareSpatialStrings, entityId, hashSchema } from "../../spatial-core/src/primitives.js";
import {
  ASSET_FACTORY_ROUTES,
  isNeuralAssetEligibleForDeclaration,
  ASSET_REQUIREMENT_INTENT_SCHEMA,
  assertAssetRequirementIntentIdentity,
  type AssetFactoryDescriptor,
  type AssetRequirementIntent,
} from "./contracts.js";
import {
  ASSET_FACTORY_REGISTRY_SCHEMA,
  assertAssetFactoryRegistryIdentity,
  type AssetFactoryRegistry,
} from "./registry.js";

export const ASSET_ACQUISITION_PORTFOLIO_ABI = "basalt-asset-acquisition-portfolio@2" as const;

export const ASSET_PORTFOLIO_SCORE_DIMENSIONS = [
  "visual_intent",
  "silhouette",
  "material",
  "topology",
  "physical",
  "contextual",
] as const;

export const ASSET_PORTFOLIO_HARD_GATES = [
  "adapted_identity",
  "bounds",
  "canonical_axes",
  "collision",
  "delivery_budget",
  "finite_geometry",
  "output_capabilities",
  "pbr_channels",
  "rights",
  "support_contact",
  "texture_budget",
  "transform_ownership",
] as const;

const scoreWeights = z
  .object({
    visual_intent: z.number().finite().min(0).max(1),
    silhouette: z.number().finite().min(0).max(1),
    material: z.number().finite().min(0).max(1),
    topology: z.number().finite().min(0).max(1),
    physical: z.number().finite().min(0).max(1),
    contextual: z.number().finite().min(0).max(1),
  })
  .strict()
  .refine(
    (value) => Math.abs(Object.values(value).reduce((sum, weight) => sum + weight, 0) - 1) < 1e-9,
    "Asset portfolio score weights must sum to one",
  );

export const ASSET_PORTFOLIO_SELECTION_RUBRIC_SCHEMA = z
  .object({
    kind: z.literal("common_prepared_asset_rubric"),
    hardGates: z
      .array(z.enum(ASSET_PORTFOLIO_HARD_GATES))
      .length(ASSET_PORTFOLIO_HARD_GATES.length),
    weights: scoreWeights,
    minimumWeightedScore: z.number().finite().min(0).max(1),
    tieBreak: z.literal("candidate_id"),
  })
  .strict()
  .superRefine((value, context) => {
    if (stableJson(value.hardGates) !== stableJson(ASSET_PORTFOLIO_HARD_GATES))
      context.addIssue({
        code: "custom",
        path: ["hardGates"],
        message: "Asset portfolio hard gates must be complete and canonical",
      });
  });
export type AssetPortfolioSelectionRubric = z.infer<typeof ASSET_PORTFOLIO_SELECTION_RUBRIC_SCHEMA>;

const candidateCapabilities = z
  .object({
    semanticCoverage: z.discriminatedUnion("kind", [
      z
        .object({ kind: z.literal("closed_set"), tags: z.array(z.string()).min(1).max(256) })
        .strict(),
      z.object({ kind: z.literal("open_vocab") }).strict(),
    ]),
    outputRoles: z.array(z.string()).min(1).max(16),
    namedSemanticParts: z.boolean(),
    pivots: z.boolean(),
    articulatedParts: z.boolean(),
    sockets: z.boolean(),
    transparency: z.boolean(),
    collision: z.boolean(),
    editOperations: z.array(z.string()).max(32),
  })
  .strict();

export const ASSET_ACQUISITION_CANDIDATE_MATERIAL_SCHEMA = z
  .object({
    kind: z.literal("factory_candidate"),
    reason: z.enum(["catalog_retrieval", "long_tail_generation", "structured_procedure"]),
    route: z.enum(ASSET_FACTORY_ROUTES),
    factoryId: entityId,
    factoryRevisionHash: hashSchema,
    qualificationHash: hashSchema,
    /** Neural inference is an offline family-factory job; it never blocks map assembly. */
    executionPhase: z.enum(["parallel_local", "parallel_remote", "offline_family_factory"]),
    referenceIds: z.array(entityId).max(64),
    costCeiling: z
      .object({
        maximumInvocations: z.literal(1),
        maximumOutputBytes: z
          .number()
          .int()
          .positive()
          .max(2 * 1024 * 1024 * 1024),
        paidCompute: z.enum(["none", "qualification_bound"]),
      })
      .strict(),
    capabilities: candidateCapabilities,
  })
  .strict();
export const ASSET_ACQUISITION_CANDIDATE_SCHEMA =
  ASSET_ACQUISITION_CANDIDATE_MATERIAL_SCHEMA.safeExtend({ id: hashSchema }).strict();
export type AssetAcquisitionCandidate = z.infer<typeof ASSET_ACQUISITION_CANDIDATE_SCHEMA>;

export const ASSET_ACQUISITION_PORTFOLIO_MATERIAL_SCHEMA = z
  .object({
    kind: z.literal("AssetAcquisitionPortfolio"),
    abi: z.literal(ASSET_ACQUISITION_PORTFOLIO_ABI),
    intentHash: hashSchema,
    resolutionHash: hashSchema,
    registryHash: hashSchema,
    form: z.literal("object"),
    candidates: z.array(ASSET_ACQUISITION_CANDIDATE_SCHEMA).max(256),
    selectionRubric: ASSET_PORTFOLIO_SELECTION_RUBRIC_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    const canonical = [...value.candidates].sort((left, right) =>
      compareSpatialStrings(left.id, right.id),
    );
    if (stableJson(canonical) !== stableJson(value.candidates))
      context.addIssue({
        code: "custom",
        path: ["candidates"],
        message: "Asset acquisition candidates must be canonical",
      });
    if (new Set(value.candidates.map(({ id }) => id)).size !== value.candidates.length)
      context.addIssue({
        code: "custom",
        path: ["candidates"],
        message: "Asset acquisition candidates must be unique",
      });
    for (const [index, candidate] of value.candidates.entries())
      if (
        new Set(candidate.referenceIds).size !== candidate.referenceIds.length ||
        stableJson(candidate.referenceIds) !==
          stableJson([...candidate.referenceIds].sort(compareSpatialStrings))
      )
        context.addIssue({
          code: "custom",
          path: ["candidates", index, "referenceIds"],
          message: "Candidate reference IDs must be unique and canonical",
        });
  });
export const ASSET_ACQUISITION_PORTFOLIO_SCHEMA =
  ASSET_ACQUISITION_PORTFOLIO_MATERIAL_SCHEMA.safeExtend({ hash: hashSchema }).strict();
export type AssetAcquisitionPortfolio = z.infer<typeof ASSET_ACQUISITION_PORTFOLIO_SCHEMA>;

const DEFAULT_PORTFOLIO_WEIGHTS = {
  visual_intent: 0.25,
  silhouette: 0.2,
  material: 0.15,
  topology: 0.1,
  physical: 0.15,
  contextual: 0.15,
} as const;

/**
 * Forms the complete peer set for one unresolved intent. Exact accepted-library
 * reuse is checked by the host before this function and does not masquerade as
 * another acquisition candidate.
 */
export function formAssetAcquisitionPortfolio(input: {
  intent: AssetRequirementIntent;
  registry: AssetFactoryRegistry;
}): AssetAcquisitionPortfolio {
  assertAssetRequirementIntentIdentity(input.intent);
  assertAssetFactoryRegistryIdentity(input.registry);
  const intent = ASSET_REQUIREMENT_INTENT_SCHEMA.parse(input.intent);
  const registry = ASSET_FACTORY_REGISTRY_SCHEMA.parse(input.registry);
  const candidates = registry.entries
    .filter(({ descriptor }) => factorySupportsIntent(descriptor, intent))
    .map(({ descriptor, qualification }) => {
      const referenceIds = factoryReferenceIds(descriptor, intent);
      if (referenceIds === undefined)
        throw new Error("Portfolio admitted a factory without a satisfiable reference contract");
      return sealCandidate({
        kind: "factory_candidate",
        reason: routeReason(descriptor.route),
        route: descriptor.route,
        factoryId: descriptor.id,
        factoryRevisionHash: descriptor.revisionHash,
        qualificationHash: qualification.hash,
        executionPhase:
          descriptor.route === "neural_asset"
            ? "offline_family_factory"
            : descriptor.executionClass === "trusted_host_composition" ||
                descriptor.executionClass === "trusted_local_blender"
              ? "parallel_local"
              : "parallel_remote",
        referenceIds,
        costCeiling: {
          maximumInvocations: 1,
          maximumOutputBytes: descriptor.maximumOutputBytes,
          paidCompute: descriptor.route === "neural_asset" ? "qualification_bound" : "none",
        },
        capabilities: {
          semanticCoverage: descriptor.semanticCapabilities.semanticCoverage,
          outputRoles: descriptor.outputCapabilities.roles,
          namedSemanticParts: descriptor.outputCapabilities.namedSemanticParts,
          pivots: descriptor.outputCapabilities.pivots,
          articulatedParts: descriptor.outputCapabilities.articulatedParts,
          sockets: descriptor.outputCapabilities.sockets,
          transparency: descriptor.outputCapabilities.transparency,
          collision: descriptor.outputCapabilities.collision,
          editOperations: descriptor.outputCapabilities.editOperations,
        },
      });
    })
    .sort((left, right) => compareSpatialStrings(left.id, right.id));
  const selectionRubric = ASSET_PORTFOLIO_SELECTION_RUBRIC_SCHEMA.parse({
    kind: "common_prepared_asset_rubric",
    hardGates: ASSET_PORTFOLIO_HARD_GATES,
    weights: DEFAULT_PORTFOLIO_WEIGHTS,
    minimumWeightedScore:
      intent.declaration.importance === "hero"
        ? 0.8
        : intent.declaration.importance === "featured"
          ? 0.7
          : 0.6,
    tieBreak: "candidate_id",
  });
  const material = ASSET_ACQUISITION_PORTFOLIO_MATERIAL_SCHEMA.parse({
    kind: "AssetAcquisitionPortfolio",
    abi: ASSET_ACQUISITION_PORTFOLIO_ABI,
    intentHash: intent.hash,
    resolutionHash: intent.resolutionHash,
    registryHash: registry.hash,
    form: intent.declaration.form.kind,
    candidates,
    selectionRubric,
  });
  return ASSET_ACQUISITION_PORTFOLIO_SCHEMA.parse({
    ...material,
    hash: contentHash(stableJson(material)),
  });
}

export function assertAssetAcquisitionPortfolioIdentity(
  value: unknown,
): asserts value is AssetAcquisitionPortfolio {
  const portfolio = ASSET_ACQUISITION_PORTFOLIO_SCHEMA.parse(value);
  for (const candidate of portfolio.candidates) {
    const { id, ...material } = candidate;
    if (contentHash(stableJson(material)) !== id)
      throw new Error("Asset acquisition candidate identity is invalid");
  }
  const { hash, ...material } = portfolio;
  if (contentHash(stableJson(material)) !== hash)
    throw new Error("Asset acquisition portfolio identity is invalid");
}

function sealCandidate(
  input: z.input<typeof ASSET_ACQUISITION_CANDIDATE_MATERIAL_SCHEMA>,
): AssetAcquisitionCandidate {
  const material = ASSET_ACQUISITION_CANDIDATE_MATERIAL_SCHEMA.parse(input);
  return ASSET_ACQUISITION_CANDIDATE_SCHEMA.parse({
    ...material,
    id: contentHash(stableJson(material)),
  });
}

function factorySupportsIntent(
  descriptor: AssetFactoryDescriptor,
  intent: AssetRequirementIntent,
): boolean {
  const declaration = intent.declaration;
  if (descriptor.route === "neural_asset" && !isNeuralAssetEligibleForDeclaration(declaration))
    return false;
  if (!descriptor.acceptedForms.includes(declaration.form.kind)) return false;
  const requiredOutput = declaration.outputRequirements;
  const output = descriptor.outputCapabilities;
  if (requiredOutput.roles.some((role) => !output.roles.includes(role))) return false;
  if (requiredOutput.semanticParts.length > 0 && !output.namedSemanticParts) return false;
  if (requiredOutput.semanticParts.some((part) => part.pivot.kind === "required") && !output.pivots)
    return false;
  if (requiredOutput.articulation.kind === "required" && !output.articulatedParts) return false;
  if (requiredOutput.semanticParts.some((part) => part.sockets.length > 0) && !output.sockets)
    return false;
  if (requiredOutput.transparency.kind === "required" && !output.transparency) return false;
  if (requiredOutput.collision.kind === "required" && !output.collision) return false;
  if (
    requiredOutput.editOperations.some(
      (operation) => !output.editOperations.includes(operation.kind),
    )
  )
    return false;
  if (
    declaration.dependencies.length > descriptor.maximumInputAssets ||
    (declaration.dependencies.length > 0 && !descriptor.acceptsPreparedDependencies)
  )
    return false;
  if (factoryReferenceIds(descriptor, intent) === undefined) return false;
  const capabilities = descriptor.semanticCapabilities;
  if (!capabilities.finishStyles.includes(declaration.surfaceIntent.finishStyle)) return false;
  if (!capabilities.novelty.includes(declaration.novelty)) return false;
  if (capabilities.semanticCoverage.kind === "closed_set") {
    const coveredTags = capabilities.semanticCoverage.tags;
    if (!declaration.semanticTags.some((tag) => coveredTags.includes(tag))) return false;
  }
  if (
    declaration.surfaceIntent.materialRoles.some(
      ({ materialClass }) => !capabilities.materialClasses.includes(materialClass),
    )
  )
    return false;
  return capabilities.objectConstructions.includes(declaration.form.construction);
}

/**
 * References are optional evidence available to the portfolio, rather than a
 * global requirement that every peer route must consume. Each candidate binds
 * the exact canonical subset it is qualified to use. A procedural candidate
 * can therefore compete beside an image-conditioned neural candidate without
 * pretending their inputs or costs are identical.
 */
function factoryReferenceIds(
  descriptor: AssetFactoryDescriptor,
  intent: AssetRequirementIntent,
): string[] | undefined {
  if (descriptor.referenceContract.kind === "none") return [];
  const contract = descriptor.referenceContract;
  const compatible = intent.references
    .filter(
      (reference) =>
        contract.mediaTypes.includes(reference.artifact.mediaType) &&
        (contract.alphaPolicy !== "required" || reference.alpha === "present") &&
        (contract.alphaPolicy !== "forbidden" || reference.alpha === "absent"),
    )
    .sort((left, right) => compareSpatialStrings(left.id, right.id));
  if (compatible.length < contract.minimumArtifacts) return undefined;
  return compatible.slice(0, contract.maximumArtifacts).map(({ id }) => id);
}

function routeReason(route: AssetFactoryDescriptor["route"]): AssetAcquisitionCandidate["reason"] {
  if (route === "trusted_procedure") return "structured_procedure";
  if (route === "retrieval") return "catalog_retrieval";
  return "long_tail_generation";
}
