import { inspectGlb } from "@basalt/asset-inspection";
import { readBoundedWorkspaceBytes } from "@basalt/artifact-store";

export async function verifyRobloxBindingCoverage(repositoryRoot, binding, upload) {
  const uploadBytes = await readBoundedWorkspaceBytes(
    repositoryRoot,
    `.basalt/roblox/upload-artifacts/${upload.uploadArtifact.locator}`,
  );
  const inspection = inspectGlb(uploadBytes, { maximumBytes: uploadBytes.byteLength });
  const primitiveCount = inspection.nodes.reduce((total, node) => total + node.primitiveCount, 0);
  if (binding.materialExpectations.length !== primitiveCount)
    throw new Error(
      `Roblox binding material coverage does not match the uploaded GLB primitive count: ${binding.assetHash} expected ${primitiveCount}, received ${binding.materialExpectations.length}`,
    );
  return { primitiveCount, inspectionHash: inspection.hash };
}
