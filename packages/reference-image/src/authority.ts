import type {
  ArtifactReference,
  ImmutableBinaryArtifactStore,
  ImmutableJsonArtifactStore,
} from "../../artifact-store/src/index.js";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import {
  assertReferenceDecoderEvidenceIdentity,
  assertReferenceGenerationReceiptIdentity,
  assertReferenceImageArtifactIdentity,
  assertReferenceImageRequestIdentity,
  assertReferenceMaskQualityEvidenceIdentity,
  assertReferenceSegmentationReceiptIdentity,
  assertReferenceSegmentationRequestIdentity,
  type ReferenceImageArtifact,
} from "./artifact.js";
import {
  assertReferenceImageWorkerReceiptIdentity,
  assertReferenceImageWorkerReceiptMatches,
  assertReferenceImageWorkerRequestIdentity,
} from "./execution.js";
import {
  assertReferenceImageProducerQualificationIdentity,
  type ReferenceImageProducerQualification,
} from "./producers.js";

export interface VerifiedReferenceImageStores {
  readonly artifactStore: ImmutableJsonArtifactStore;
  readonly binaryStore: ImmutableBinaryArtifactStore;
}

const VERIFIED_REFERENCE_IMAGE_AUTHORITY = Symbol("VerifiedReferenceImageAuthority");

/**
 * Process-local proof that the reference and every authority-bearing dependency
 * were reloaded from immutable content-addressed stores. Parsed JSON alone can
 * never cross an image or 3D worker boundary.
 */
export class VerifiedReferenceImageAuthority {
  readonly artifact: ReferenceImageArtifact;
  readonly artifactReference: ArtifactReference;
  readonly verificationHash: string;

  private constructor(
    token: symbol,
    input: {
      readonly artifact: ReferenceImageArtifact;
      readonly artifactReference: ArtifactReference;
      readonly verifiedArtifactHashes: readonly string[];
    },
  ) {
    if (token !== VERIFIED_REFERENCE_IMAGE_AUTHORITY)
      throw new Error("Reference-image authority can only be reloaded from immutable stores");
    this.artifact = structuredClone(input.artifact);
    this.artifactReference = structuredClone(input.artifactReference);
    this.verificationHash = contentHash(
      stableJson({
        referenceImageArtifactHash: input.artifact.hash,
        storeArtifactHash: input.artifactReference.artifactHash,
        verifiedArtifactHashes: [...input.verifiedArtifactHashes].sort(),
      }),
    );
    Object.freeze(this);
  }

  static async reload(
    artifactReference: ArtifactReference,
    stores: VerifiedReferenceImageStores,
  ): Promise<VerifiedReferenceImageAuthority> {
    const artifact = await stores.artifactStore.read(
      artifactReference,
      assertReferenceImageArtifactIdentity,
    );
    const verified = new Set<string>([artifactReference.artifactHash]);

    await verifyBinary(stores, artifact.images.original, verified);
    await verifyBinary(stores, artifact.images.alphaMask, verified);
    await verifyBinary(stores, artifact.images.rgba, verified);
    await verifyBinary(stores, artifact.rights.evidenceArtifact, verified);

    const producer = await readJson(
      stores,
      artifact.lineage.producerQualificationArtifact,
      assertReferenceImageProducerQualificationIdentity,
      verified,
    );
    const segmenter = await readJson(
      stores,
      artifact.lineage.segmentationQualificationArtifact,
      assertReferenceImageProducerQualificationIdentity,
      verified,
    );
    assertExact(producer, artifact.producerQualification, "image-producer qualification");
    assertExact(segmenter, artifact.segmentationQualification, "segmentation qualification");
    await verifyQualificationDependencies(producer, stores, verified);
    await verifyQualificationDependencies(segmenter, stores, verified);

    const request = await readJson(
      stores,
      artifact.lineage.generationRequestArtifact,
      assertReferenceImageRequestIdentity,
      verified,
    );
    assertExact(request, artifact.request, "reference-image request");
    await readOpaqueJson(stores, request.providerRequestArtifact, verified);

    const generationReceipt = await readJson(
      stores,
      artifact.lineage.generationReceiptArtifact,
      assertReferenceGenerationReceiptIdentity,
      verified,
    );
    assertExact(
      generationReceipt,
      artifact.lineage.generationReceipt,
      "reference-image generation receipt",
    );
    const generationWorkerRequest = await readJson(
      stores,
      artifact.lineage.generationWorkerRequestArtifact,
      assertReferenceImageWorkerRequestIdentity,
      verified,
    );
    assertExact(
      generationWorkerRequest,
      artifact.lineage.generationWorkerRequest,
      "reference-image generation worker request",
    );
    const generationWorkerReceipt = await readJson(
      stores,
      artifact.lineage.generationWorkerReceiptArtifact,
      assertReferenceImageWorkerReceiptIdentity,
      verified,
    );
    assertExact(
      generationWorkerReceipt,
      artifact.lineage.generationWorkerReceipt,
      "reference-image generation worker receipt",
    );
    assertReferenceImageWorkerReceiptMatches(
      generationWorkerReceipt,
      generationWorkerRequest,
      producer,
    );
    const segmentationRequest = await readJson(
      stores,
      artifact.lineage.segmentationRequestArtifact,
      assertReferenceSegmentationRequestIdentity,
      verified,
    );
    assertExact(
      segmentationRequest,
      artifact.lineage.segmentationRequest,
      "reference-image segmentation request",
    );
    const segmentationReceipt = await readJson(
      stores,
      artifact.lineage.segmentationReceiptArtifact,
      assertReferenceSegmentationReceiptIdentity,
      verified,
    );
    assertExact(
      segmentationReceipt,
      artifact.lineage.segmentationReceipt,
      "reference-image segmentation receipt",
    );
    const segmentationWorkerRequest = await readJson(
      stores,
      artifact.lineage.segmentationWorkerRequestArtifact,
      assertReferenceImageWorkerRequestIdentity,
      verified,
    );
    assertExact(
      segmentationWorkerRequest,
      artifact.lineage.segmentationWorkerRequest,
      "reference-image segmentation worker request",
    );
    const segmentationWorkerReceipt = await readJson(
      stores,
      artifact.lineage.segmentationWorkerReceiptArtifact,
      assertReferenceImageWorkerReceiptIdentity,
      verified,
    );
    assertExact(
      segmentationWorkerReceipt,
      artifact.lineage.segmentationWorkerReceipt,
      "reference-image segmentation worker receipt",
    );
    assertReferenceImageWorkerReceiptMatches(
      segmentationWorkerReceipt,
      segmentationWorkerRequest,
      segmenter,
    );
    const decoder = await readJson(
      stores,
      artifact.images.decoderReportArtifact,
      assertReferenceDecoderEvidenceIdentity,
      verified,
    );
    assertExact(decoder, artifact.lineage.decoderEvidence, "reference-image decoder evidence");
    const mask = await readJson(
      stores,
      artifact.maskQuality.reportArtifact,
      assertReferenceMaskQualityEvidenceIdentity,
      verified,
    );
    assertExact(mask, artifact.lineage.maskQualityEvidence, "reference-image mask evidence");

    await readOpaqueJson(stores, artifact.images.compositorReportArtifact, verified);
    await readOpaqueJson(stores, artifact.rights.reviewArtifact, verified);

    return new VerifiedReferenceImageAuthority(VERIFIED_REFERENCE_IMAGE_AUTHORITY, {
      artifact,
      artifactReference,
      verifiedArtifactHashes: [...verified],
    });
  }
}

export async function reloadVerifiedReferenceImageAuthority(
  artifactReference: ArtifactReference,
  stores: VerifiedReferenceImageStores,
): Promise<VerifiedReferenceImageAuthority> {
  return VerifiedReferenceImageAuthority.reload(artifactReference, stores);
}

async function verifyQualificationDependencies(
  qualification: ReferenceImageProducerQualification,
  stores: VerifiedReferenceImageStores,
  verified: Set<string>,
): Promise<void> {
  await verifyBinary(stores, qualification.terms.sourceLicenseArtifact, verified);
  await verifyBinary(stores, qualification.terms.modelTermsArtifact, verified);
  await readOpaqueJson(stores, qualification.runtime.dependencyInventoryArtifact, verified);
  await readOpaqueJson(stores, qualification.runtime.sbomArtifact, verified);
  await readOpaqueJson(stores, qualification.runtime.importTraceArtifact, verified);
  await readOpaqueJson(stores, qualification.runtime.modelInventoryArtifact, verified);
  await readOpaqueJson(stores, qualification.terms.commercialReview.evidenceArtifact, verified);
  await readOpaqueJson(stores, qualification.dependencyReview.evidenceArtifact, verified);
  await readOpaqueJson(stores, qualification.workerProbe.evidenceArtifact, verified);
}

async function verifyBinary(
  stores: VerifiedReferenceImageStores,
  artifact: {
    readonly locator: string;
    readonly artifactHash: string;
    readonly bytes: number;
    readonly mediaType: string;
  },
  verified: Set<string>,
): Promise<void> {
  await stores.binaryStore.verify(artifact);
  verified.add(artifact.artifactHash);
}

async function readJson<T>(
  stores: VerifiedReferenceImageStores,
  reference: ArtifactReference,
  assertion: (value: unknown) => asserts value is T,
  verified: Set<string>,
): Promise<T> {
  const value = await stores.artifactStore.read(reference, assertion);
  verified.add(reference.artifactHash);
  return value;
}

async function readOpaqueJson(
  stores: VerifiedReferenceImageStores,
  reference: ArtifactReference,
  verified: Set<string>,
): Promise<void> {
  await stores.artifactStore.verify(reference);
  verified.add(reference.artifactHash);
}

function assertExact(actual: unknown, expected: unknown, label: string): void {
  if (stableJson(actual) !== stableJson(expected))
    throw new Error(`Retained ${label} does not match its reference-image binding`);
}
