import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { z } from "zod";
import {
  AuthoringWorkspaceStore,
  applyAuthoringTransaction,
  createAuthoringWorkspace,
  type AuthoringRecordKindRegistry,
} from "@basalt/authoring-graph";

const contentSchema = z
  .object({ value: z.number().int(), dependencyId: z.string().optional() })
  .strict();
const registry: AuthoringRecordKindRegistry = {
  semantic_record: {
    validate: (value) => canonicalContent(contentSchema.parse(value)),
    forkContent: (value, newId) => ({
      value: contentSchema.parse(value).value,
      dependencyId: newId,
    }),
    rebindDependency: (value, sourceId, replacementId) => {
      const parsed = contentSchema.parse(value);
      return canonicalContent({
        value: parsed.value,
        ...(parsed.dependencyId === sourceId
          ? { dependencyId: replacementId }
          : parsed.dependencyId === undefined
            ? {}
            : { dependencyId: parsed.dependencyId }),
      });
    },
  },
};

function canonicalContent(value: { value: number; dependencyId?: string | undefined }) {
  return value.dependencyId === undefined
    ? { value: value.value }
    : { value: value.value, dependencyId: value.dependencyId };
}

test("authoring transactions invalidate dependents without journal history", () => {
  const workspace = createAuthoringWorkspace({
    projectId: "semantic-kernel-test",
    intentHandles: ["intent"],
    registry,
    records: [
      {
        id: "source",
        recordKind: "semantic_record",
        ownerId: "owner",
        dependencies: [],
        content: { value: 1 },
      },
      {
        id: "owner",
        recordKind: "semantic_record",
        dependencies: ["source"],
        content: { value: 2, dependencyId: "source" },
      },
    ],
  });
  const source = workspace.records.find((record) => record.id === "source")!;
  const result = applyAuthoringTransaction(
    workspace,
    { head: workspace.head, editableRecordIds: ["source"], ownerIds: [], maximumEdits: 1 },
    {
      base: workspace.head,
      edits: [
        {
          op: "replace",
          entityId: "source",
          expectedHash: source.hash,
          record: { ...source, content: { value: 3 } },
        },
      ],
    },
    registry,
  );
  assert.notEqual(result.workspace.head, workspace.head);
  assert.deepEqual(result.receipt.changedIds, ["source"]);
  assert.deepEqual(result.receipt.invalidatedIds, ["owner", "source"]);
  assert.equal("parentRevision" in result.workspace, false);
});

test("authoring workspace heads enforce optimistic concurrency", async () => {
  const directory = await mkdtemp(join(tmpdir(), "basalt-authoring-"));
  try {
    const store = new AuthoringWorkspaceStore(directory);
    const first = createAuthoringWorkspace({
      projectId: "semantic-kernel-test",
      intentHandles: [],
      registry,
    });
    const firstBinding = await store.create("workspace", first, registry);
    assert.equal(firstBinding.head, first.head);
    const current = await store.current("workspace", registry);
    assert.equal(current?.workspace.head, first.head);

    const second = createAuthoringWorkspace({
      projectId: first.projectId,
      intentHandles: ["next_intent"],
      registry,
    });
    await store.commit("workspace", first.head, second, registry);
    await assert.rejects(
      store.commit("workspace", first.head, first, registry),
      /commit base is stale/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
