import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  ImmutableBinaryArtifactStore,
  ImmutableJsonArtifactStore,
  acquireWorkspaceExclusiveLock,
  readBoundedWorkspaceBytes,
  writeCanonicalWorkspaceJson,
} from "@basalt/artifact-store";

test("immutable stores verify exact bytes and reject tampered content", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "basalt-artifacts-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const jsonStore = new ImmutableJsonArtifactStore(join(root, "json"));
  const jsonReference = await jsonStore.write({ b: 2, a: 1 });
  assert.deepEqual(await jsonStore.read(jsonReference), { a: 1, b: 2 });

  const binaryStore = new ImmutableBinaryArtifactStore(join(root, "binary"));
  const binaryReference = await binaryStore.write(
    Uint8Array.from([0x42, 0x41, 0x53, 0x41, 0x4c, 0x54]),
    "application/octet-stream",
  );
  assert.deepEqual(
    [...(await binaryStore.read(binaryReference))],
    [0x42, 0x41, 0x53, 0x41, 0x4c, 0x54],
  );
  await writeFile(resolve(binaryStore.root, binaryReference.locator), "broken");
  await assert.rejects(binaryStore.read(binaryReference), /byte count mismatch|SHA-256 mismatch/u);
});

test("workspace locks are exclusive, bounded, and release only their own inode", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "basalt-workspace-lock-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const lock = await acquireWorkspaceExclusiveLock(root, "state/import.lock");
  await assert.rejects(
    acquireWorkspaceExclusiveLock(root, "state/import.lock"),
    (error: NodeJS.ErrnoException) => error.code === "EEXIST",
  );
  await lock.release();
  const reacquired = await acquireWorkspaceExclusiveLock(root, "state/import.lock");
  await reacquired.release();
});

test("workspace JSON creation is canonical and replacement is hash guarded", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "basalt-workspace-write-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const first = await writeCanonicalWorkspaceJson(root, "state/result.json", { value: 1 });
  const repeated = await writeCanonicalWorkspaceJson(root, "state/result.json", { value: 1 });
  assert.equal(repeated.replaced, false);
  assert.equal(repeated.artifactHash, first.artifactHash);
  await assert.rejects(
    writeCanonicalWorkspaceJson(root, "state/result.json", { value: 2 }),
    /replacement hash required/u,
  );
  await assert.rejects(
    writeCanonicalWorkspaceJson(
      root,
      "state/result.json",
      { value: 2 },
      {
        expectedExistingHash: "0".repeat(64),
      },
    ),
    /replacement hash mismatch/u,
  );
  const replaced = await writeCanonicalWorkspaceJson(
    root,
    "state/result.json",
    { value: 2 },
    {
      expectedExistingHash: first.artifactHash,
    },
  );
  assert.equal(replaced.replaced, true);
});

test("bounded workspace reads fail closed on symlinks and escaped paths", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "basalt-workspace-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const outside = await mkdtemp(join(tmpdir(), "basalt-outside-"));
  context.after(async () => rm(outside, { recursive: true, force: true }));
  await mkdir(join(root, "declared"));
  await writeFile(join(root, "declared", "safe.json"), "{}", { flag: "wx" });
  await writeFile(join(outside, "secret.json"), '{"secret":true}', { flag: "wx" });
  await symlink(join(outside, "secret.json"), join(root, "declared", "linked.json"));

  assert.equal(
    Buffer.from(await readBoundedWorkspaceBytes(root, "declared/safe.json", 16)).toString("utf8"),
    "{}",
  );
  await assert.rejects(
    readBoundedWorkspaceBytes(root, "declared/linked.json", 1024),
    /symbolic link/u,
  );
  await assert.rejects(
    readBoundedWorkspaceBytes(root, join(outside, "secret.json"), 1024),
    /escapes/u,
  );
});
