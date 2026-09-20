import { createHash } from "node:crypto";
import { parentPort } from "node:worker_threads";
import { readBoundedWorkspaceBytes } from "@basalt/artifact-store";
import { measureCatalogGlb, type CatalogGlbSource } from "@basalt/asset-inspection";

export interface CatalogMeasureTask {
  readonly taskId: number;
  readonly workspaceRoot: string;
  readonly relativePath: string;
  readonly sourceBytes: number;
  readonly source: CatalogGlbSource;
}

if (!parentPort) throw new Error("Catalog measurement worker requires a parent port");

parentPort.on("message", (task: CatalogMeasureTask) => {
  void measure(task).then(
    (asset) => parentPort!.postMessage({ taskId: task.taskId, asset }),
    (error: unknown) =>
      parentPort!.postMessage({
        taskId: task.taskId,
        error: error instanceof Error ? error.message : String(error),
      }),
  );
});

async function measure(task: CatalogMeasureTask) {
  const bytes = await readBoundedWorkspaceBytes(
    task.workspaceRoot,
    task.relativePath,
    task.sourceBytes,
  );
  if (bytes.byteLength !== task.sourceBytes) throw new Error("Source byte count changed");
  const observed = createHash("sha256").update(bytes).digest("hex");
  if (observed !== task.source.contentHash) throw new Error("Source bytes changed");
  return measureCatalogGlb(bytes, task.source);
}
