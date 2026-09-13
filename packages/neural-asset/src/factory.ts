import { z } from "zod";
import {
  ASSET_FACTORY_REQUEST_SCHEMA,
  CATALOG_FULFILLMENT_PLAN_SCHEMA,
  sealAssetFactoryCandidate,
  type AssetFactoryCandidate,
  type AssetFactoryRequest,
  type CatalogFulfillmentPlan,
} from "@basalt/asset-factory";
import {
  HASH_SCHEMA,
  compareCanonicalStrings,
  contentAddressedEntityId,
  contentHash,
  deepFreezeJson,
  stableJson,
  type Diagnostic,
  type GateResult,
} from "@basalt/contracts";
import {
  NEURAL_ASSET_GENERATION_REQUEST_SCHEMA,
  NEURAL_ASSET_GENERATION_RECEIPT_SCHEMA,
  NEURAL_INPUT_REFERENCE_SCHEMA,
  NEURAL_PROVIDER_DECLARATION_SCHEMA,
  NEURAL_WORKER_QUALIFICATION_SCHEMA,
  sealNeuralAssetGenerationRequest,
  type NeuralAssetGenerationReceipt,
  type NeuralAssetGenerationRequest,
  type NeuralInputReference,
  type NeuralProviderDeclaration,
  type NeuralProviderId,
  type NeuralWorkerQualification,
} from "./execution.js";

export const NEURAL_ASSET_BATCH_SCHEMA = z
  .object({
    kind: z.literal("NeuralAssetBatch"),
    batchId: z.string().regex(/^NeuralAssetBatch_[a-f0-9]{47}$/u),
    fulfillmentPlanHash: HASH_SCHEMA,
    requests: z.array(NEURAL_ASSET_GENERATION_REQUEST_SCHEMA).min(1).max(4096),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    const keys = value.requests.map((request) => request.requestHash);
    if (
      new Set(keys).size !== keys.length ||
      stableJson([...keys].sort(compareCanonicalStrings)) !== stableJson(keys)
    )
      context.addIssue({
        code: "custom",
        path: ["requests"],
        message: "Batch requests must be unique and canonical",
      });
    if (
      value.requests.some(
        (request) => request.factoryRequest.fulfillmentPlanHash !== value.fulfillmentPlanHash,
      )
    )
      context.addIssue({
        code: "custom",
        path: ["requests"],
        message: "Batch requests must bind the same fulfillment plan",
      });
    const { batchId: _batchId, hash: _hash, ...material } = value;
    if (contentAddressedEntityId("NeuralAssetBatch", material) !== value.batchId)
      context.addIssue({ code: "custom", path: ["batchId"], message: "Batch ID mismatch" });
    if (contentHash(stableJson(material)) !== value.hash)
      context.addIssue({ code: "custom", path: ["hash"], message: "Batch hash mismatch" });
  });
export type NeuralAssetBatch = z.output<typeof NEURAL_ASSET_BATCH_SCHEMA>;

export function createNeuralAssetBatch(input: {
  readonly fulfillmentPlan: CatalogFulfillmentPlan;
  readonly factoryRequests: readonly AssetFactoryRequest[];
  readonly references: ReadonlyMap<string, NeuralInputReference>;
  readonly providers: readonly {
    readonly declaration: NeuralProviderDeclaration;
    readonly qualification: NeuralWorkerQualification;
  }[];
  readonly providerPreference: readonly NeuralProviderId[];
  readonly sourceGeometryArtifacts?: ReadonlyMap<
    string,
    {
      readonly artifactHash: string;
      readonly bytes: number;
      readonly mediaType: "model/gltf-binary";
    }
  >;
}): GateResult<NeuralAssetBatch> {
  const plan = CATALOG_FULFILLMENT_PLAN_SCHEMA.parse(input.fulfillmentPlan);
  if (plan.outcome.strategy === "reuse_binding")
    return incomplete(
      "generation_not_required",
      "A reused catalog binding requires no neural work",
    );
  const requests = input.factoryRequests
    .map((request) => ASSET_FACTORY_REQUEST_SCHEMA.parse(request))
    .sort((left, right) => compareCanonicalStrings(left.job.jobId, right.job.jobId));
  const plannedJobs = new Map(plan.outcome.jobs.map((job) => [job.jobId, job] as const));
  if (
    requests.length !== plannedJobs.size ||
    requests.some(
      (request) =>
        request.fulfillmentPlanHash !== plan.hash ||
        plannedJobs.get(request.job.jobId)?.jobHash !== request.job.jobHash,
    )
  )
    return incomplete(
      "factory_request_mismatch",
      "Factory requests do not cover the exact fulfillment jobs",
    );
  const providerById = new Map(
    input.providers.map((entry) => {
      const declaration = NEURAL_PROVIDER_DECLARATION_SCHEMA.parse(entry.declaration);
      const qualification = NEURAL_WORKER_QUALIFICATION_SCHEMA.parse(entry.qualification);
      return [declaration.providerId, { declaration, qualification }] as const;
    }),
  );
  const generated: NeuralAssetGenerationRequest[] = [];
  const missing: Diagnostic[] = [];
  for (const request of requests) {
    const capability =
      request.job.operation === "restyle_materials" ? "material_restyle" : "image_to_3d";
    const provider = input.providerPreference
      .map((providerId) => providerById.get(providerId))
      .find(
        (candidate) =>
          candidate?.declaration.status === "eligible" &&
          candidate.qualification.status === "eligible" &&
          candidate.qualification.providerDeclarationHash === candidate.declaration.hash &&
          candidate.declaration.capabilities.includes(capability),
      );
    if (!provider) {
      missing.push(
        diagnostic(
          "qualified_provider_missing",
          `No qualified provider supports ${capability} for ${request.job.jobId}`,
          [request.job.jobHash],
        ),
      );
      continue;
    }
    const reference = input.references.get(request.job.referenceImageArtifactHash);
    if (!reference) {
      missing.push(
        diagnostic(
          "reference_missing",
          `No retained input reference exists for ${request.job.jobId}`,
          [request.job.referenceImageArtifactHash],
        ),
      );
      continue;
    }
    const parsedReference = NEURAL_INPUT_REFERENCE_SCHEMA.parse(reference);
    const sourceGeometryArtifact = request.job.sourceAssetHash
      ? input.sourceGeometryArtifacts?.get(request.job.sourceAssetHash)
      : undefined;
    if (request.job.operation === "restyle_materials" && !sourceGeometryArtifact) {
      missing.push(
        diagnostic(
          "source_geometry_missing",
          `Material restyling lacks retained source geometry for ${request.job.jobId}`,
          [request.job.sourceAssetHash!],
        ),
      );
      continue;
    }
    generated.push(
      sealNeuralAssetGenerationRequest({
        factoryRequest: request,
        providerId: provider.declaration.providerId,
        providerDeclarationHash: provider.declaration.hash,
        qualificationHash: provider.qualification.hash,
        operation: request.job.operation,
        reference: parsedReference,
        ...(sourceGeometryArtifact ? { sourceGeometryArtifact } : {}),
        seed: request.job.seed,
      }),
    );
  }
  if (missing.length > 0) return { status: "incomplete", diagnostics: missing };
  return { status: "eligible", value: sealNeuralAssetBatch(plan.hash, generated), diagnostics: [] };
}

export function sealNeuralAssetBatch(
  fulfillmentPlanHash: string,
  rawRequests: readonly NeuralAssetGenerationRequest[],
): NeuralAssetBatch {
  const requests = rawRequests
    .map((request) => NEURAL_ASSET_GENERATION_REQUEST_SCHEMA.parse(request))
    .sort((left, right) => compareCanonicalStrings(left.requestHash, right.requestHash));
  const material = {
    kind: "NeuralAssetBatch" as const,
    fulfillmentPlanHash: HASH_SCHEMA.parse(fulfillmentPlanHash),
    requests,
  };
  return deepFreezeJson(
    NEURAL_ASSET_BATCH_SCHEMA.parse({
      ...material,
      batchId: contentAddressedEntityId("NeuralAssetBatch", material),
      hash: contentHash(stableJson(material)),
    }),
  ) as NeuralAssetBatch;
}

/**
 * Neural output is still not a catalog asset. Only a successfully finished GLB
 * can become an asset-factory candidate and then enter measurement/admission.
 */
export function retainFinishedNeuralCandidate(input: {
  readonly factoryRequest: AssetFactoryRequest;
  readonly generationRequest: NeuralAssetGenerationRequest;
  readonly generationReceipt: NeuralAssetGenerationReceipt;
  readonly finishedSourceArtifact?: {
    readonly artifactHash: string;
    readonly bytes: number;
    readonly mediaType: "model/gltf-binary";
  };
  readonly finishingEvidenceHashes: readonly string[];
}): AssetFactoryCandidate {
  const request = ASSET_FACTORY_REQUEST_SCHEMA.parse(input.factoryRequest);
  const generationRequest = NEURAL_ASSET_GENERATION_REQUEST_SCHEMA.parse(input.generationRequest);
  const receipt = NEURAL_ASSET_GENERATION_RECEIPT_SCHEMA.parse(input.generationReceipt);
  if (
    generationRequest.factoryRequest.hash !== request.hash ||
    receipt.requestHash !== generationRequest.requestHash
  )
    throw new Error("Finished neural output does not bind the exact factory request");
  if (receipt.status === "eligible" && !input.finishedSourceArtifact)
    throw new Error("Eligible neural output must pass asset finishing before retention");
  return sealAssetFactoryCandidate({
    requestHash: request.hash,
    status: receipt.status === "eligible" ? "eligible" : receipt.status,
    ...(input.finishedSourceArtifact
      ? { finishedSourceArtifact: input.finishedSourceArtifact }
      : {}),
    neuralGenerationReceiptHash: receipt.hash,
    finishingEvidenceHashes: [...input.finishingEvidenceHashes],
    lineageEvidenceHashes: [
      ...receipt.lineageEvidenceHashes,
      receipt.hash,
      request.job.referenceImageArtifactHash,
      ...(request.job.sourceAssetHash ? [request.job.sourceAssetHash] : []),
    ],
    diagnostics: [...receipt.diagnostics],
  });
}

function diagnostic(code: string, message: string, evidenceHashes: string[]): Diagnostic {
  return {
    code,
    message,
    path: [],
    evidenceHashes: [...evidenceHashes].sort(compareCanonicalStrings),
  };
}

function incomplete(code: string, message: string): GateResult<never> {
  return { status: "incomplete", diagnostics: [diagnostic(code, message, [])] };
}
