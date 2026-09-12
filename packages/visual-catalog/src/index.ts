import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import {
  ImmutableBinaryArtifactStore,
  type BinaryArtifactReference,
} from "../../artifact-store/src/index.js";
import {
  BINARY_ARTIFACT_SCHEMA,
  PREPARED_ASSET_SCHEMA,
  verifyPreparedAsset,
  type PreparedAsset,
} from "../../prepared-asset/src/index.js";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import { compareSpatialStrings, entityId, hashSchema } from "../../spatial-core/src/primitives.js";

export const VISUAL_ASSET_LIBRARY_ABI = "basalt-visual-asset-library@2" as const;
export const VISUAL_ASSET_LIBRARY_PATH = "visual-assets/library.json" as const;

const evidenceDescriptor = z
  .object({
    path: z.string().min(1).max(4096),
    mediaType: z.string().min(3).max(160),
  })
  .strict();

export const VISUAL_ASSET_LIBRARY_DESCRIPTOR_SCHEMA = z
  .object({
    id: entityId,
    title: z.string().trim().min(1).max(160),
    description: z.string().trim().min(1).max(1024),
    tags: z.array(z.string().trim().min(1).max(80)).max(32),
    preparedAssetPath: z.string().min(1).max(4096),
    review: z
      .object({
        status: z.enum(["locally_qualified", "creator_approved"]),
        reviewedAt: z.string().datetime({ offset: true }),
        evidence: evidenceDescriptor,
      })
      .strict(),
  })
  .strict();

export const VISUAL_ASSET_LIBRARY_ENTRY_SCHEMA = z
  .object({
    kind: z.literal("VisualAssetLibraryEntry"),
    abi: z.literal(VISUAL_ASSET_LIBRARY_ABI),
    id: entityId,
    title: z.string().trim().min(1).max(160),
    description: z.string().trim().min(1).max(1024),
    tags: z.array(z.string().trim().min(1).max(80)).max(32),
    preparedAsset: PREPARED_ASSET_SCHEMA,
    review: z
      .object({
        status: z.enum(["locally_qualified", "creator_approved"]),
        reviewedAt: z.string().datetime({ offset: true }),
        evidenceArtifact: BINARY_ARTIFACT_SCHEMA,
      })
      .strict(),
  })
  .strict();
export type VisualAssetLibraryEntry = z.infer<typeof VISUAL_ASSET_LIBRARY_ENTRY_SCHEMA>;

export const VISUAL_ASSET_LIBRARY_MANIFEST_SCHEMA = z
  .object({
    kind: z.literal("VisualAssetLibraryManifest"),
    abi: z.literal(VISUAL_ASSET_LIBRARY_ABI),
    entries: z.array(VISUAL_ASSET_LIBRARY_ENTRY_SCHEMA).max(512),
    hash: hashSchema,
  })
  .strict();
export type VisualAssetLibraryManifest = z.infer<typeof VISUAL_ASSET_LIBRARY_MANIFEST_SCHEMA>;

export async function buildVisualAssetLibrary(input: {
  binaryStore: ImmutableBinaryArtifactStore;
  descriptors: readonly unknown[];
}): Promise<VisualAssetLibraryManifest> {
  if (input.descriptors.length > 512) throw new Error("Visual asset library exceeds 512 entries");
  const entries: VisualAssetLibraryEntry[] = [];
  for (const value of input.descriptors) {
    const descriptor = VISUAL_ASSET_LIBRARY_DESCRIPTOR_SCHEMA.parse(value);
    const asset = await verifyPreparedAsset(
      input.binaryStore,
      await readCanonicalJson(descriptor.preparedAssetPath, 16 * 1024 * 1024),
    );
    if (asset.previews.length !== 3)
      throw new Error(`Library asset lacks its retained visual review views: ${descriptor.id}`);
    const reviewBytes = await readBoundedRegularFile(
      descriptor.review.evidence.path,
      16 * 1024 * 1024,
    );
    const evidenceArtifact = await input.binaryStore.write(
      reviewBytes,
      descriptor.review.evidence.mediaType,
    );
    entries.push(
      VISUAL_ASSET_LIBRARY_ENTRY_SCHEMA.parse({
        kind: "VisualAssetLibraryEntry",
        abi: VISUAL_ASSET_LIBRARY_ABI,
        id: descriptor.id,
        title: descriptor.title,
        description: descriptor.description,
        tags: canonicalTags(descriptor.tags),
        preparedAsset: asset,
        review: {
          status: descriptor.review.status,
          reviewedAt: descriptor.review.reviewedAt,
          evidenceArtifact,
        },
      }),
    );
  }
  return sealVisualAssetLibrary(entries);
}

export function sealVisualAssetLibrary(
  entries: readonly VisualAssetLibraryEntry[],
): VisualAssetLibraryManifest {
  const canonical = entries
    .map((entry) => VISUAL_ASSET_LIBRARY_ENTRY_SCHEMA.parse(entry))
    .sort((left, right) => compareSpatialStrings(left.id, right.id));
  if (new Set(canonical.map((entry) => entry.id)).size !== canonical.length)
    throw new Error("Visual asset library entry IDs must be unique");
  if (new Set(canonical.map((entry) => entry.preparedAsset.hash)).size !== canonical.length)
    throw new Error("Visual asset library prepared-asset hashes must be unique");
  for (const entry of canonical)
    if (stableJson(entry.tags) !== stableJson(canonicalTags(entry.tags)))
      throw new Error(`Visual asset library tags are not canonical: ${entry.id}`);
  const material = {
    kind: "VisualAssetLibraryManifest" as const,
    abi: VISUAL_ASSET_LIBRARY_ABI,
    entries: canonical,
  };
  return { ...material, hash: contentHash(stableJson(material)) };
}

export interface IssuedVisualAsset {
  readonly assetHandle: string;
  readonly preparedAssetHash: string;
  readonly resolutionHash: string;
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly geometry: {
    readonly bounds: PreparedAsset["bounds"];
    readonly baseSizeStuds: PreparedAsset["bounds"]["size"];
    readonly canonicalAxes: PreparedAsset["canonicalAxes"];
    readonly transformOwnership: PreparedAsset["transformOwnership"];
    readonly uniqueTriangles: number;
    readonly renderedTriangles: number;
    readonly instances: number;
    readonly parts: number;
    readonly materialSlots: number;
    readonly texturedParts: number;
    readonly sockets: readonly string[];
    readonly supportPolicies: readonly PreparedAsset["geometry"]["parts"][number]["support"][];
    readonly collisionPolicies: readonly PreparedAsset["geometry"]["parts"][number]["collision"][];
  };
  readonly reviewStatus: "locally_qualified" | "creator_approved";
  readonly rights: {
    readonly usage: "creator_owned" | "commercial_use_permitted";
    readonly claims: ReadonlyArray<{
      readonly id: string;
      readonly sourceLabel: string;
      readonly licenseId: string;
      readonly usage: "creator_owned" | "commercial_use_permitted";
      readonly attribution: string;
    }>;
  };
}

export const VISUAL_ASSET_HANDLE_SCHEMA = z.string().regex(/^asset_[a-f0-9]{64}$/u);

/** A stable content handle names the exact PreparedAsset independently of a request. */
export function createVisualAssetHandle(preparedAssetHash: string): string {
  return `asset_${hashSchema.parse(preparedAssetHash)}`;
}

/** A full hash binds one content handle to its entry and current request authority. */
export function createVisualAssetResolutionHash(input: {
  assetHandle: string;
  preparedAssetHash: string;
  entryId: string;
  projectId: string;
  creatorRequestHash: string;
}): string {
  const assetHandle = VISUAL_ASSET_HANDLE_SCHEMA.parse(input.assetHandle);
  const preparedAssetHash = hashSchema.parse(input.preparedAssetHash);
  if (assetHandle !== createVisualAssetHandle(preparedAssetHash))
    throw new Error("Visual asset handle does not identify the declared prepared asset");
  const entryId = entityId.parse(input.entryId);
  const projectId = z.string().trim().min(1).max(512).parse(input.projectId);
  const creatorRequestHash = hashSchema.parse(input.creatorRequestHash);
  return contentHash(
    stableJson({
      abi: VISUAL_ASSET_LIBRARY_ABI,
      assetHandle,
      preparedAssetHash,
      entryId,
      projectId,
      creatorRequestHash,
    }),
  );
}

/** Exact prepared assets with stable handles, request-bound resolutions, and no exposed locators. */
export class VisualAssetLibrary {
  private readonly entries: Map<string, VisualAssetLibraryEntry>;
  private admissionTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly binaryStore: ImmutableBinaryArtifactStore,
    entries: readonly VisualAssetLibraryEntry[],
  ) {
    const canonical = entries.map((entry) => VISUAL_ASSET_LIBRARY_ENTRY_SCHEMA.parse(entry));
    if (new Set(canonical.map((entry) => entry.id)).size !== canonical.length)
      throw new Error("Visual asset library entry IDs must be unique");
    if (new Set(canonical.map((entry) => entry.preparedAsset.hash)).size !== canonical.length)
      throw new Error("Visual asset library prepared-asset hashes must be unique");
    for (const entry of canonical)
      if (stableJson(entry.tags) !== stableJson(canonicalTags(entry.tags)))
        throw new Error(`Visual asset library entry is not canonical: ${entry.id}`);
    this.entries = new Map(canonical.map((entry) => [entry.id, structuredClone(entry)]));
  }

  async admitPrepared(input: {
    preparedAsset: PreparedAsset;
    id: string;
    title: string;
    description: string;
    tags: readonly string[];
    projectId: string;
    creatorRequestHash: string;
    reviewedAt: string;
  }): Promise<IssuedVisualAsset> {
    const preparedAsset = await verifyPreparedAsset(this.binaryStore, input.preparedAsset);
    const reviewEvidence = Buffer.from(
      `${stableJson({
        kind: "LocalVisualAssetReview",
        preparedAssetHash: preparedAsset.hash,
        previewHashes: preparedAsset.previews.map((preview) => preview.artifact.artifactHash),
        lineageOrigin: preparedAsset.lineage.origin,
        sourceCandidateHash: preparedAsset.lineage.sourceCandidateHash,
        adaptedCandidateHash: preparedAsset.lineage.adaptedCandidateHash,
        finisherWorkerHash: preparedAsset.preparation.finisherWorkerHash,
        finisherQualificationHash: preparedAsset.preparation.finisherQualificationHash,
        checks: [
          "exact_prepared_asset_identity",
          "retained_lineage_and_rights",
          "per_part_triangle_budget",
          "canonical_axes_and_identity_node_transforms",
          "support_contact_collision_and_socket_metadata",
          "material_presence",
          "three_retained_review_views",
        ],
        claim: "locally_qualified",
      })}\n`,
    );
    const evidenceArtifact = await this.binaryStore.write(reviewEvidence, "application/json");
    const entry = VISUAL_ASSET_LIBRARY_ENTRY_SCHEMA.parse({
      kind: "VisualAssetLibraryEntry",
      abi: VISUAL_ASSET_LIBRARY_ABI,
      id: input.id,
      title: input.title,
      description: input.description,
      tags: canonicalTags(input.tags),
      preparedAsset,
      review: {
        status: "locally_qualified",
        reviewedAt: input.reviewedAt,
        evidenceArtifact,
      },
    });
    return this.serializeAdmission(async () => {
      const existing = this.entries.get(entry.id);
      if (existing) {
        if (existing.preparedAsset.hash !== entry.preparedAsset.hash)
          throw new Error(
            `Visual asset library identity already belongs to other bytes: ${entry.id}`,
          );
        return this.modelView(existing, input.projectId, input.creatorRequestHash);
      }
      if (
        [...this.entries.values()].some(
          (candidate) => candidate.preparedAsset.hash === entry.preparedAsset.hash,
        )
      )
        throw new Error("Prepared asset is already admitted under another visual asset identity");
      const admitted = structuredClone(entry);
      await this.persist([...this.entries.values(), admitted]);
      this.entries.set(admitted.id, admitted);
      return this.modelView(admitted, input.projectId, input.creatorRequestHash);
    });
  }

  async search(input: {
    projectId: string;
    creatorRequestHash: string;
    query: string;
    maximumTriangles?: number;
    limit?: number;
  }): Promise<{ kind: "VisualAssetLibraryResults"; results: IssuedVisualAsset[] }> {
    const query = input.query.normalize("NFC").trim().toLocaleLowerCase("en-US");
    if (!query || Buffer.byteLength(query, "utf8") > 512)
      throw new Error("Visual asset library query is empty or exceeds 512 bytes");
    if (!/^[a-f0-9]{64}$/u.test(input.creatorRequestHash))
      throw new Error("Visual asset search lacks exact creator-request authority");
    const limit = input.limit ?? 8;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20)
      throw new Error("Visual asset result limit must be between 1 and 20");
    const terms = query.split(/\s+/u);
    const matches = [...this.entries.values()]
      .filter(
        (entry) =>
          input.maximumTriangles === undefined ||
          entry.preparedAsset.geometry.renderedTriangles <= input.maximumTriangles,
      )
      .map((entry) => {
        const haystack =
          `${entry.title} ${entry.description} ${entry.tags.join(" ")} ${entry.preparedAsset.lineage.origin} ${entry.preparedAsset.geometry.parts.map((part) => `${part.name} ${part.semanticRole}`).join(" ")} ${entry.preparedAsset.geometry.meshes.map((mesh) => `${mesh.nodeName} ${mesh.materials.map((material) => material.name).join(" ")}`).join(" ")} ${entry.preparedAsset.rights.claims.map((claim) => claim.sourceLabel).join(" ")}`.toLocaleLowerCase(
            "en-US",
          );
        return {
          entry,
          score: terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0),
        };
      })
      .filter(({ score }) => score > 0)
      .sort(
        (left, right) =>
          right.score - left.score || compareSpatialStrings(left.entry.id, right.entry.id),
      )
      .slice(0, limit);
    for (const { entry } of matches) await verifyLibraryEntry(this.binaryStore, entry);
    return {
      kind: "VisualAssetLibraryResults",
      results: matches.map(({ entry }) =>
        this.modelView(entry, input.projectId, input.creatorRequestHash),
      ),
    };
  }

  async resolve(input: {
    assetHandle: string;
    preparedAssetHash: string;
    resolutionHash: string;
    projectId: string;
    creatorRequestHash: string;
  }): Promise<VisualAssetLibraryEntry> {
    const assetHandle = VISUAL_ASSET_HANDLE_SCHEMA.parse(input.assetHandle);
    const preparedAssetHash = hashSchema.parse(input.preparedAssetHash);
    const resolutionHash = hashSchema.parse(input.resolutionHash);
    const entry = [...this.entries.values()].find(
      (candidate) => createVisualAssetHandle(candidate.preparedAsset.hash) === assetHandle,
    );
    if (!entry) throw new Error("Visual asset handle is absent from the current library");
    if (entry.preparedAsset.hash !== preparedAssetHash)
      throw new Error("Visual asset resolution does not bind the exact prepared asset");
    const expectedResolutionHash = createVisualAssetResolutionHash({
      assetHandle,
      preparedAssetHash,
      entryId: entry.id,
      projectId: input.projectId,
      creatorRequestHash: input.creatorRequestHash,
    });
    if (resolutionHash !== expectedResolutionHash)
      throw new Error(
        "Visual asset resolution hash is absent or belongs to another creator request",
      );
    await verifyLibraryEntry(this.binaryStore, entry);
    return structuredClone(entry);
  }

  /** Host-only lookup used to bind prepared dependencies before request resolution exists. */
  async resolveContent(assetHandleValue: string): Promise<VisualAssetLibraryEntry> {
    const assetHandle = VISUAL_ASSET_HANDLE_SCHEMA.parse(assetHandleValue);
    const entry = [...this.entries.values()].find(
      (candidate) => createVisualAssetHandle(candidate.preparedAsset.hash) === assetHandle,
    );
    if (!entry) throw new Error("Visual asset handle is absent from the current library");
    await verifyLibraryEntry(this.binaryStore, entry);
    return structuredClone(entry);
  }

  /**
   * Host-only release-evidence lookup. Missing hashes stay absent so the
   * release gate can report an incomplete inventory; retained entries are
   * still fully reverified and corruption fails closed.
   */
  async resolvePreparedAssets(
    preparedAssetHashValues: readonly string[],
  ): Promise<PreparedAsset[]> {
    const preparedAssetHashes = preparedAssetHashValues.map((value) => hashSchema.parse(value));
    if (new Set(preparedAssetHashes).size !== preparedAssetHashes.length)
      throw new Error("Prepared-asset release lookup contains duplicate hashes");
    const byHash = new Map(
      [...this.entries.values()].map((entry) => [entry.preparedAsset.hash, entry] as const),
    );
    const retained = preparedAssetHashes.flatMap((hash) => {
      const entry = byHash.get(hash);
      return entry ? [entry] : [];
    });
    await Promise.all(retained.map((entry) => verifyLibraryEntry(this.binaryStore, entry)));
    return retained.map((entry) => structuredClone(entry.preparedAsset));
  }

  private modelView(
    entry: VisualAssetLibraryEntry,
    projectId: string,
    creatorRequestHash: string,
  ): IssuedVisualAsset {
    const assetHandle = createVisualAssetHandle(entry.preparedAsset.hash);
    const preparedAssetHash = entry.preparedAsset.hash;
    const resolutionHash = createVisualAssetResolutionHash({
      assetHandle,
      preparedAssetHash,
      entryId: entry.id,
      projectId,
      creatorRequestHash,
    });
    const meshById = new Map(entry.preparedAsset.geometry.meshes.map((mesh) => [mesh.id, mesh]));
    const renderParts = entry.preparedAsset.geometry.parts.filter(
      (part) => part.role !== "collision_proxy",
    );
    return {
      assetHandle,
      preparedAssetHash,
      resolutionHash,
      id: entry.id,
      title: entry.title,
      description: entry.description,
      tags: [...entry.tags],
      geometry: {
        bounds: entry.preparedAsset.bounds,
        baseSizeStuds: {
          x: entry.preparedAsset.bounds.size.x * entry.preparedAsset.studsPerUnit,
          y: entry.preparedAsset.bounds.size.y * entry.preparedAsset.studsPerUnit,
          z: entry.preparedAsset.bounds.size.z * entry.preparedAsset.studsPerUnit,
        },
        canonicalAxes: entry.preparedAsset.canonicalAxes,
        transformOwnership: entry.preparedAsset.transformOwnership,
        uniqueTriangles: entry.preparedAsset.geometry.uniqueTriangles,
        renderedTriangles: entry.preparedAsset.geometry.renderedTriangles,
        instances: entry.preparedAsset.geometry.instanceCount,
        parts: renderParts.length,
        materialSlots: renderParts.reduce(
          (total, part) => total + meshById.get(part.meshId)!.materials.length,
          0,
        ),
        texturedParts: renderParts.filter((part) => meshById.get(part.meshId)!.textures.length > 0)
          .length,
        sockets: renderParts.flatMap((part) => part.sockets.map((socket) => socket.id)),
        supportPolicies: renderParts.map((part) => part.support),
        collisionPolicies: renderParts.map((part) => part.collision),
      },
      reviewStatus: entry.review.status,
      rights: {
        usage: entry.preparedAsset.rights.usage,
        claims: entry.preparedAsset.rights.claims.map((claim) => ({
          id: claim.id,
          sourceLabel: claim.sourceLabel,
          licenseId: claim.licenseId,
          usage: claim.usage,
          attribution: claim.attribution,
        })),
      },
    };
  }

  private serializeAdmission<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.admissionTail.then(operation, operation);
    this.admissionTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async persist(entries: readonly VisualAssetLibraryEntry[]): Promise<void> {
    const manifest = sealVisualAssetLibrary(entries);
    const destination = join(this.binaryStore.root, VISUAL_ASSET_LIBRARY_PATH);
    const directory = dirname(destination);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const directoryInfo = await lstat(directory);
    if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory())
      throw new Error("Visual asset library directory is unsafe");
    try {
      const destinationInfo = await lstat(destination);
      if (destinationInfo.isSymbolicLink() || !destinationInfo.isFile())
        throw new Error("Visual asset library destination is unsafe");
    } catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const temporary = join(
      directory,
      `.${VISUAL_ASSET_LIBRARY_PATH.split("/").at(-1)!}.${randomUUID()}.tmp`,
    );
    try {
      await writeFile(temporary, `${stableJson(manifest)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, destination);
    } finally {
      await unlink(temporary).catch((error: unknown) => {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      });
    }
  }
}

export async function loadVisualAssetLibrary(
  binaryStore: ImmutableBinaryArtifactStore,
): Promise<VisualAssetLibrary> {
  const path = resolve(binaryStore.root, VISUAL_ASSET_LIBRARY_PATH);
  let value: unknown;
  try {
    value = await readCanonicalJson(path, 32 * 1024 * 1024);
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return new VisualAssetLibrary(binaryStore, []);
    throw error;
  }
  const manifest = VISUAL_ASSET_LIBRARY_MANIFEST_SCHEMA.parse(value);
  const { hash, ...material } = manifest;
  if (contentHash(stableJson(material)) !== hash)
    throw new Error("Visual asset library identity is invalid");
  for (const entry of manifest.entries) await verifyLibraryEntry(binaryStore, entry);
  return new VisualAssetLibrary(binaryStore, manifest.entries);
}

async function verifyLibraryEntry(
  store: ImmutableBinaryArtifactStore,
  entry: VisualAssetLibraryEntry,
): Promise<void> {
  await Promise.all([
    verifyPreparedAsset(store, entry.preparedAsset),
    store.verify(entry.review.evidenceArtifact),
  ]);
}

async function readCanonicalJson(path: string, maximumBytes: number): Promise<unknown> {
  const text = Buffer.from(await readBoundedRegularFile(path, maximumBytes)).toString("utf8");
  if (!text.endsWith("\n")) throw new Error("Visual asset library JSON is not canonical");
  const value: unknown = JSON.parse(text);
  if (`${stableJson(value)}\n` !== text)
    throw new Error("Visual asset library JSON is not canonical");
  return value;
}

async function readBoundedRegularFile(path: string, maximumBytes: number): Promise<Uint8Array> {
  if (!isAbsolute(path)) throw new Error("Visual asset library inputs must use absolute paths");
  const descriptor = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await descriptor.stat();
    if (!before.isFile() || before.size <= 0 || before.size > maximumBytes)
      throw new Error("Visual asset library input is not a bounded regular file");
    const bytes = await descriptor.readFile();
    const after = await descriptor.stat();
    if (
      bytes.byteLength !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs
    )
      throw new Error("Visual asset library input changed while reading");
    return bytes;
  } finally {
    await descriptor.close();
  }
}

function canonicalTags(tags: readonly string[]): string[] {
  const values = [...new Set(tags.map((tag) => tag.normalize("NFC").trim()))].sort(
    compareSpatialStrings,
  );
  if (values.some((tag) => !tag)) throw new Error("Visual asset tags cannot be empty");
  return values;
}

export type { BinaryArtifactReference };
export * from "./family-registry.js";
