import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { ImmutableBinaryArtifactStore, readBoundedWorkspaceBytes } from "@basalt/artifact-store";
import { stableJson } from "@basalt/contracts";
import { adaptGlbForRobloxUpload } from "@basalt/roblox";

const MAX_MODEL_BYTES = 20 * 1024 * 1024;
const DEFAULT_ARTIFACT_STORE = ".basalt/roblox/upload-artifacts";

/** Verify every receipt against both immutable source and retained upload bytes. */
export async function verifyRobloxUploadEvidence(
  repositoryRoot,
  ledger,
  artifactStorePath = DEFAULT_ARTIFACT_STORE,
) {
  const store = new ImmutableBinaryArtifactStore(resolve(repositoryRoot, artifactStorePath), {
    maxBytes: MAX_MODEL_BYTES,
  });
  for (const upload of ledger.uploads) {
    const source = await readBoundedWorkspaceBytes(
      repositoryRoot,
      upload.sourceRelativePath,
      MAX_MODEL_BYTES,
    );
    const sourceHash = createHash("sha256").update(source).digest("hex");
    if (
      source.byteLength !== upload.sourceBytes ||
      sourceHash !== upload.sourceContentHash ||
      sourceHash !== upload.sourceArtifactHash
    )
      throw new Error(`Roblox upload receipt source mismatch: ${upload.sourceArtifactHash}`);

    const expected = adaptGlbForRobloxUpload(source);
    if (stableJson(expected.adaptation) !== stableJson(upload.adaptation))
      throw new Error(`Roblox upload adaptation mismatch: ${upload.sourceArtifactHash}`);
    const retained = await store.read(upload.uploadArtifact);
    if (
      retained.byteLength !== expected.bytes.byteLength ||
      !Buffer.from(retained).equals(Buffer.from(expected.bytes))
    )
      throw new Error(
        `Roblox upload payload does not derive from source: ${upload.sourceArtifactHash}`,
      );
  }
  return { verifiedUploads: ledger.uploads.length };
}
