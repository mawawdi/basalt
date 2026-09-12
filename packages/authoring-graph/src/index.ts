import { z } from "zod";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  ImmutableJsonArtifactStore,
  assertArtifactReference,
  type ArtifactReference,
} from "../../artifact-store/src/index.js";
import { contentHash, stableJson } from "../../contracts/src/index.js";
import {
  DEFAULT_SPATIAL_ADMISSION_POLICY,
  assertBoundedSpatialJson,
  compareSpatialStrings,
  entityId,
  hashSchema,
  type SpatialJsonValue,
} from "../../spatial-core/src/primitives.js";

export const AUTHORING_GRAPH_ABI = "basalt-authoring-graph@1" as const;
export const AUTHORING_GRAPH_STORE = ".basalt/creator-graph" as const;

export type ModelStage = "design" | "compose" | "asset" | "source" | "critique" | "repair";

export interface AuthoringRecordInput {
  readonly id: string;
  readonly family: string;
  readonly ownerId?: string;
  readonly dependencies: readonly string[];
  readonly content: SpatialJsonValue;
}

export interface AuthoringRecord extends AuthoringRecordInput {
  readonly hash: string;
}

export interface AuthoringWorkspace {
  readonly kind: "AuthoringWorkspace";
  readonly abi: typeof AUTHORING_GRAPH_ABI;
  readonly projectId: string;
  readonly revision: number;
  readonly parentHead?: string;
  readonly intentHandles: readonly string[];
  readonly records: readonly AuthoringRecord[];
  readonly head: string;
}

export interface AuthoringScope {
  readonly head: string;
  readonly editableRecordIds: readonly string[];
  readonly ownerIds: readonly string[];
  readonly maximumEdits: number;
}

export type AuthoringEdit =
  | { readonly op: "create"; readonly record: AuthoringRecordInput }
  | {
      readonly op: "replace";
      readonly entityId: string;
      readonly expectedHash: string;
      readonly record: AuthoringRecordInput;
    }
  | { readonly op: "delete"; readonly entityId: string; readonly expectedHash: string }
  | { readonly op: "connect"; readonly entityId: string; readonly dependencyId: string }
  | { readonly op: "disconnect"; readonly entityId: string; readonly dependencyId: string }
  | {
      readonly op: "fork";
      readonly sourceId: string;
      readonly expectedHash: string;
      readonly newId: string;
      readonly ownerId: string;
      readonly rebindOwnerId: string;
    };

export interface AuthoringTransaction {
  readonly base: string;
  readonly edits: readonly AuthoringEdit[];
}

export interface AuthoringReceipt {
  readonly status: "accepted";
  readonly head: string;
  readonly changedIds: readonly string[];
  readonly invalidatedIds: readonly string[];
}

export interface AuthoringWorkspaceBinding {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly head: string;
  readonly artifact: ArtifactReference;
}

export interface AuthoringRecordFamily {
  /** Validates and canonicalizes content for this closed family. */
  readonly validate: (content: unknown) => SpatialJsonValue;
  /** Derives a new stable root identity without asking the model to restate the record. */
  readonly forkContent?: (content: SpatialJsonValue, newId: string) => SpatialJsonValue;
  /** Rebinds one admitted semantic reference in a scoped owner record. */
  readonly rebindDependency?: (
    content: SpatialJsonValue,
    sourceId: string,
    replacementId: string,
  ) => SpatialJsonValue;
}

export type AuthoringFamilyRegistry = Readonly<Record<string, AuthoringRecordFamily>>;

const recordInputSchema = z
  .object({
    id: entityId,
    family: entityId,
    ownerId: entityId.optional(),
    dependencies: z.array(entityId).max(4096),
    content: z.unknown(),
  })
  .strict();

export function createAuthoringWorkspace(input: {
  projectId: string;
  intentHandles: readonly string[];
  records?: readonly AuthoringRecordInput[];
  registry: AuthoringFamilyRegistry;
}): AuthoringWorkspace {
  const records = canonicalRecords(input.records ?? [], input.registry);
  return sealWorkspace({
    kind: "AuthoringWorkspace",
    abi: AUTHORING_GRAPH_ABI,
    projectId: input.projectId,
    revision: 1,
    intentHandles: canonicalStrings(input.intentHandles, "intent handles"),
    records,
  });
}

export function applyAuthoringTransaction(
  workspaceInput: AuthoringWorkspace,
  scope: AuthoringScope,
  transaction: AuthoringTransaction,
  registry: AuthoringFamilyRegistry,
): { workspace: AuthoringWorkspace; receipt: AuthoringReceipt } {
  const workspace = assertAuthoringWorkspace(workspaceInput, registry);
  if (transaction.base !== workspace.head || scope.head !== workspace.head)
    throw new Error("Authoring transaction base is stale");
  if (
    !Number.isSafeInteger(scope.maximumEdits) ||
    scope.maximumEdits < 1 ||
    scope.maximumEdits > 1024 ||
    transaction.edits.length < 1 ||
    transaction.edits.length > scope.maximumEdits
  )
    throw new Error("Authoring transaction edit count exceeds its exact scope");

  const records = new Map(workspace.records.map((record) => [record.id, structuredClone(record)]));
  const editable = new Set(scope.editableRecordIds);
  const owners = new Set(scope.ownerIds);
  const directlyChanged = new Set<string>();
  const deletedIds = new Set<string>();
  const mayEdit = (id: string): boolean => {
    const record = records.get(id);
    return editable.has(id) || (record?.ownerId !== undefined && owners.has(record.ownerId));
  };

  for (const raw of transaction.edits) {
    assertBoundedSpatialJson(raw, DEFAULT_SPATIAL_ADMISSION_POLICY);
    const edit = raw as AuthoringEdit;
    if (edit.op === "create") {
      const record = canonicalRecord(edit.record, registry);
      if (records.has(record.id)) throw new Error(`Authoring record already exists: ${record.id}`);
      if (!record.ownerId || !owners.has(record.ownerId))
        throw new Error(`Authoring create is outside its owner scope: ${record.id}`);
      records.set(record.id, record);
      directlyChanged.add(record.id);
      continue;
    }
    if (edit.op === "fork") {
      const source = records.get(edit.sourceId);
      const owner = records.get(edit.rebindOwnerId);
      if (!source || source.hash !== edit.expectedHash)
        throw new Error(`Authoring fork source is stale: ${edit.sourceId}`);
      if (!owner || !mayEdit(owner.id) || !owners.has(edit.ownerId))
        throw new Error(`Authoring fork is outside its owner scope: ${edit.newId}`);
      if (records.has(edit.newId))
        throw new Error(`Authoring fork ID already exists: ${edit.newId}`);
      if (!owner.dependencies.includes(source.id))
        throw new Error("Authoring fork owner does not depend on its source");
      const sourceFamily = registry[source.family];
      const ownerFamily = registry[owner.family];
      if (!sourceFamily?.forkContent || !ownerFamily?.rebindDependency)
        throw new Error("Authoring family does not support semantic dependency forking");
      records.set(
        edit.newId,
        canonicalRecord(
          {
            ...source,
            id: edit.newId,
            ownerId: edit.ownerId,
            content: sourceFamily.forkContent(source.content, edit.newId),
          },
          registry,
        ),
      );
      records.set(
        owner.id,
        canonicalRecord(
          {
            ...owner,
            dependencies: owner.dependencies.map((id) => (id === source.id ? edit.newId : id)),
            content: ownerFamily.rebindDependency(owner.content, source.id, edit.newId),
          },
          registry,
        ),
      );
      directlyChanged.add(edit.newId);
      directlyChanged.add(owner.id);
      continue;
    }
    const current = records.get(edit.entityId);
    if (!current || !mayEdit(edit.entityId))
      throw new Error(`Authoring edit is outside its record scope: ${edit.entityId}`);
    if (edit.op === "replace") {
      if (current.hash !== edit.expectedHash)
        throw new Error(`Authoring replacement is stale: ${edit.entityId}`);
      if (edit.record.id !== edit.entityId)
        throw new Error("Authoring replacement cannot change record identity");
      records.set(edit.entityId, canonicalRecord(edit.record, registry));
    } else if (edit.op === "delete") {
      if (current.hash !== edit.expectedHash)
        throw new Error(`Authoring deletion is stale: ${edit.entityId}`);
      records.delete(edit.entityId);
      deletedIds.add(edit.entityId);
    } else {
      const dependencies = new Set(current.dependencies);
      if (edit.op === "connect") dependencies.add(edit.dependencyId);
      else if (!dependencies.delete(edit.dependencyId))
        throw new Error(`Authoring dependency is absent: ${edit.dependencyId}`);
      records.set(
        current.id,
        sealRecord({ ...current, dependencies: [...dependencies], hash: undefined }),
      );
    }
    directlyChanged.add(edit.entityId);
  }

  const undeclaredDependents = [...records.values()]
    .filter((record) => record.dependencies.some((dependency) => deletedIds.has(dependency)))
    .map((record) => record.id)
    .sort(compareSpatialStrings);
  if (undeclaredDependents.length > 0)
    throw new Error(
      `Authoring deletion has undeclared dependents: ${undeclaredDependents.join(", ")}`,
    );
  const canonical = canonicalRecords([...records.values()], registry);
  const reverse = reverseDependencies(canonical);
  const invalidated = new Set(directlyChanged);
  const queue = [...directlyChanged];
  for (let index = 0; index < queue.length; index += 1)
    for (const dependent of reverse.get(queue[index]!) ?? [])
      if (!invalidated.has(dependent)) {
        invalidated.add(dependent);
        queue.push(dependent);
      }
  const next = sealWorkspace({
    kind: "AuthoringWorkspace",
    abi: AUTHORING_GRAPH_ABI,
    projectId: workspace.projectId,
    revision: workspace.revision + 1,
    parentHead: workspace.head,
    intentHandles: workspace.intentHandles,
    records: canonical,
  });
  return {
    workspace: next,
    receipt: {
      status: "accepted",
      head: next.head,
      changedIds: [...directlyChanged].sort(compareSpatialStrings),
      invalidatedIds: [...invalidated].sort(compareSpatialStrings),
    },
  };
}

export function assertAuthoringWorkspace(
  value: AuthoringWorkspace,
  registry: AuthoringFamilyRegistry,
): AuthoringWorkspace {
  assertBoundedSpatialJson(value, DEFAULT_SPATIAL_ADMISSION_POLICY);
  if (
    value.kind !== "AuthoringWorkspace" ||
    value.abi !== AUTHORING_GRAPH_ABI ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    !hashSchema.safeParse(value.head).success
  )
    throw new Error("Authoring workspace envelope is invalid");
  const records = canonicalRecords(value.records, registry);
  const sealed = sealWorkspace({
    kind: value.kind,
    abi: value.abi,
    projectId: value.projectId,
    revision: value.revision,
    ...(value.parentHead ? { parentHead: value.parentHead } : {}),
    intentHandles: canonicalStrings(value.intentHandles, "intent handles"),
    records,
  });
  if (stableJson(sealed) !== stableJson(value))
    throw new Error("Authoring workspace identity mismatch");
  return sealed;
}

/** Durable, single-head storage for graph workspaces. Every revision remains immutable. */
export class AuthoringWorkspaceStore {
  readonly artifacts: ImmutableJsonArtifactStore;
  private readonly headsRoot: string;

  constructor(root: string) {
    const resolved = resolve(root);
    this.artifacts = new ImmutableJsonArtifactStore(resolved);
    this.headsRoot = resolve(resolved, "authoring-workspaces-v1");
  }

  async current(
    workspaceId: string,
    registry: AuthoringFamilyRegistry,
  ): Promise<{ workspace: AuthoringWorkspace; binding: AuthoringWorkspaceBinding } | undefined> {
    entityId.parse(workspaceId);
    await this.ensureHeadsRoot();
    const path = resolve(this.headsRoot, `${workspaceId}.json`);
    let serialized: string;
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 16 * 1024)
        throw new Error("Authoring workspace head is unsafe");
      serialized = await readFile(path, "utf8");
    } catch (error: unknown) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    const binding = assertWorkspaceBinding(JSON.parse(serialized) as unknown, workspaceId);
    const value = await this.artifacts.read(binding.artifact);
    const workspace = assertAuthoringWorkspace(value as AuthoringWorkspace, registry);
    if (workspace.head !== binding.head || workspace.projectId !== binding.projectId)
      throw new Error("Authoring workspace head does not bind its immutable artifact");
    return { workspace, binding };
  }

  async create(
    workspaceId: string,
    workspace: AuthoringWorkspace,
    registry: AuthoringFamilyRegistry,
  ): Promise<AuthoringWorkspaceBinding> {
    return this.publish(workspaceId, undefined, workspace, registry);
  }

  async commit(
    workspaceId: string,
    expectedHead: string,
    workspace: AuthoringWorkspace,
    registry: AuthoringFamilyRegistry,
  ): Promise<AuthoringWorkspaceBinding> {
    hashSchema.parse(expectedHead);
    return this.publish(workspaceId, expectedHead, workspace, registry);
  }

  private async publish(
    workspaceId: string,
    expectedHead: string | undefined,
    workspaceInput: AuthoringWorkspace,
    registry: AuthoringFamilyRegistry,
  ): Promise<AuthoringWorkspaceBinding> {
    entityId.parse(workspaceId);
    const workspace = assertAuthoringWorkspace(workspaceInput, registry);
    await this.ensureHeadsRoot();
    const lease = resolve(this.headsRoot, `${workspaceId}.lease`);
    try {
      await mkdir(lease);
    } catch (error: unknown) {
      if (isAlreadyExists(error)) throw new Error("Authoring workspace is being updated");
      throw error;
    }
    try {
      const current = await this.current(workspaceId, registry);
      if ((current?.workspace.head ?? undefined) !== expectedHead)
        throw new Error("Authoring workspace commit base is stale");
      const artifact = await this.artifacts.write(workspace);
      const binding: AuthoringWorkspaceBinding = {
        workspaceId,
        projectId: workspace.projectId,
        head: workspace.head,
        artifact,
      };
      const destination = resolve(this.headsRoot, `${workspaceId}.json`);
      const temporary = resolve(this.headsRoot, `.${workspaceId}.${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, `${stableJson(binding)}\n`, {
          encoding: "utf8",
          mode: 0o600,
          flag: "wx",
        });
        await rename(temporary, destination);
      } finally {
        await rm(temporary, { force: true });
      }
      return binding;
    } finally {
      await rm(lease, { recursive: true, force: true });
    }
  }

  private async ensureHeadsRoot(): Promise<void> {
    await mkdir(this.headsRoot, { recursive: true, mode: 0o700 });
    const info = await lstat(this.headsRoot);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Authoring workspace head root is unsafe");
  }
}

function canonicalRecords(
  inputs: readonly (AuthoringRecordInput | AuthoringRecord)[],
  registry: AuthoringFamilyRegistry,
): AuthoringRecord[] {
  const records = inputs.map((record) => canonicalRecord(record, registry));
  records.sort((left, right) => compareSpatialStrings(left.id, right.id));
  if (new Set(records.map((record) => record.id)).size !== records.length)
    throw new Error("Authoring record identities must be unique");
  const ids = new Set(records.map((record) => record.id));
  for (const record of records) {
    if (record.ownerId && !ids.has(record.ownerId))
      throw new Error(`Authoring record owner is absent: ${record.ownerId}`);
    for (const dependency of record.dependencies)
      if (!ids.has(dependency))
        throw new Error(`Authoring record dependency is absent: ${dependency}`);
  }
  assertAcyclic(records);
  return records;
}

function canonicalRecord(
  input: AuthoringRecordInput | AuthoringRecord,
  registry: AuthoringFamilyRegistry,
): AuthoringRecord {
  const parsed = recordInputSchema.parse({
    id: input.id,
    family: input.family,
    ...(input.ownerId ? { ownerId: input.ownerId } : {}),
    dependencies: input.dependencies,
    content: input.content,
  });
  const family = registry[parsed.family];
  if (!family) throw new Error(`Authoring record family is not active: ${parsed.family}`);
  return sealRecord({
    id: parsed.id,
    family: parsed.family,
    ...(parsed.ownerId ? { ownerId: parsed.ownerId } : {}),
    dependencies: canonicalStrings(parsed.dependencies, `${parsed.id} dependencies`),
    content: family.validate(parsed.content),
  });
}

function sealRecord(input: Omit<AuthoringRecord, "hash"> & { hash?: undefined }): AuthoringRecord {
  const material = {
    id: input.id,
    family: input.family,
    ...(input.ownerId ? { ownerId: input.ownerId } : {}),
    dependencies: canonicalStrings(input.dependencies, `${input.id} dependencies`),
    content: input.content,
  };
  return { ...material, hash: contentHash(stableJson(material)) };
}

function sealWorkspace(input: Omit<AuthoringWorkspace, "head">): AuthoringWorkspace {
  return { ...input, head: contentHash(stableJson(input)) };
}

function canonicalStrings(values: readonly string[], label: string): string[] {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label}`);
  return [...values].sort(compareSpatialStrings);
}

function reverseDependencies(records: Iterable<AuthoringRecord>): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const record of records)
    for (const dependency of record.dependencies) {
      const consumers = result.get(dependency) ?? new Set<string>();
      consumers.add(record.id);
      result.set(dependency, consumers);
    }
  return result;
}

function assertAcyclic(records: readonly AuthoringRecord[]): void {
  const dependencies = new Map(records.map((record) => [record.id, record.dependencies]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`Authoring dependency cycle includes ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of dependencies.get(id) ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of dependencies.keys()) visit(id);
}

function assertWorkspaceBinding(
  value: unknown,
  expectedWorkspaceId: string,
): AuthoringWorkspaceBinding {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (value as { workspaceId?: unknown }).workspaceId !== expectedWorkspaceId
  )
    throw new Error("Authoring workspace binding is invalid");
  const binding = value as unknown as AuthoringWorkspaceBinding;
  entityId.parse(binding.workspaceId);
  if (typeof binding.projectId !== "string" || binding.projectId.length < 1)
    throw new Error("Authoring workspace project binding is invalid");
  hashSchema.parse(binding.head);
  assertArtifactReference(binding.artifact);
  if (
    stableJson(value) !==
    stableJson({
      workspaceId: binding.workspaceId,
      projectId: binding.projectId,
      head: binding.head,
      artifact: binding.artifact,
    })
  )
    throw new Error("Authoring workspace binding has unknown fields");
  return binding;
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "EEXIST"
  );
}
