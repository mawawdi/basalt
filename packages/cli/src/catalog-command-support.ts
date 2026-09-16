import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { getBoundedWorkspaceFileSize, readBoundedWorkspaceBytes } from "@basalt/artifact-store";
import {
  catalogWorkerOutputIsComplete,
  catalogWorkerResultHashMatches,
  type CatalogWorkerJob,
  type CatalogWorkerOutput,
} from "@basalt/catalog-authoring";
import { contentHash, stableJson } from "@basalt/contracts";

export const CATALOG_METADATA_ROOT = ".basalt/catalog/metadata";
export const CATALOG_CONTEXT_ROOT = ".basalt/catalog/context";
export const CATALOG_QUALIFICATION_ROOT = ".basalt/catalog/qualification";
export const CATALOG_SEARCH_ROOT = ".basalt/catalog/search";
export const CATALOG_CAS_ROOT = ".basalt/cas";
export const CATALOG_WORKER_PATH = "workers/catalog-metadata/worker.py";
export const CATALOG_MODAL_PATH = "workers/catalog-metadata/modal_app.py";

export interface CatalogCommandContext {
  readonly root: string;
  readJson(path: string): Promise<unknown>;
  readOptionalJson(path: string): Promise<unknown | undefined>;
  writeJson(path: string, value: unknown): Promise<void>;
  print(value: unknown): void;
}

export function parseOptions(values: readonly string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--"))
      throw new Error(`Malformed option near ${key ?? "end of command"}`);
    if (result.has(key)) throw new Error(`Option is repeated: ${key}`);
    result.set(key, value);
  }
  return result;
}

export function splitList(value: string | undefined): string[] {
  return value
    ? [
        ...new Set(
          value
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean),
        ),
      ].sort(compare)
    : [];
}

export function parseBoolean(value: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`Expected true or false, received ${value}`);
}

export function requireInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new Error(`${label} must be a nonnegative integer`);
  return parsed;
}

export function absolute(root: string, path: string): string {
  return resolve(root, path);
}

export async function readText(root: string, path: string): Promise<string> {
  return Buffer.from(await readBoundedWorkspaceBytes(root, path, 64 * 1024))
    .toString("utf8")
    .trim();
}

export async function readTextExact(root: string, path: string): Promise<string> {
  return Buffer.from(await readBoundedWorkspaceBytes(root, path, 64 * 1024)).toString("utf8");
}

export async function fileSize(root: string, path: string): Promise<number> {
  return getBoundedWorkspaceFileSize(root, path, 64 * 1024 * 1024);
}

export async function fileHash(root: string, path: string): Promise<string> {
  return sha256(await readBoundedWorkspaceBytes(root, path, 64 * 1024 * 1024));
}

export function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sealCliArtifact<T extends z.ZodTypeAny>(schema: T, material: object): z.output<T> {
  return schema.parse({ ...material, hash: contentHash(stableJson(material)) });
}

export async function executeCachedCatalogWorker<T extends CatalogWorkerOutput>(input: {
  readonly job: CatalogWorkerJob;
  readonly outputSchema: {
    parse(value: unknown): T;
    safeParse(value: unknown): z.ZodSafeParseResult<T>;
  };
  readonly executor: "local" | "modal";
  readonly force: boolean;
  readonly context: CatalogCommandContext;
}): Promise<T> {
  const jobPath = `${CATALOG_METADATA_ROOT}/jobs/${input.job.hash}.json`;
  const outputPath = `${CATALOG_METADATA_ROOT}/worker-output/${input.job.hash}.json`;
  await input.context.writeJson(jobPath, input.job);
  if (input.force) await removeRegularFileIfPresent(input.context.root, outputPath);
  if (!input.force) {
    const existing = await input.context.readOptionalJson(outputPath);
    const parsed =
      existing === undefined || !catalogWorkerResultHashMatches(existing)
        ? undefined
        : input.outputSchema.safeParse(existing);
    if (
      parsed?.success &&
      parsed.data.jobHash === input.job.hash &&
      catalogWorkerOutputIsComplete(input.job, parsed.data)
    )
      return parsed.data;
  }
  await executeCatalogWorker(input.executor, jobPath, outputPath, input.context.root);
  const raw = await input.context.readJson(outputPath);
  if (!catalogWorkerResultHashMatches(raw)) throw new Error("Catalog worker result hash mismatch");
  const output = input.outputSchema.parse(raw);
  if (output.jobHash !== input.job.hash || !catalogWorkerOutputIsComplete(input.job, output))
    throw new Error("Catalog worker output does not cover its exact bounded job");
  return output;
}

async function executeCatalogWorker(
  executor: "local" | "modal",
  jobPath: string,
  outputPath: string,
  root: string,
): Promise<void> {
  const command = executor === "modal" ? "modal" : "python3";
  const values =
    executor === "modal"
      ? ["run", "--quiet", CATALOG_MODAL_PATH, "--job", jobPath, "--output", outputPath]
      : [
          CATALOG_WORKER_PATH,
          "--job",
          absolute(root, jobPath),
          "--output",
          absolute(root, outputPath),
        ];
  const environment: NodeJS.ProcessEnv = { ...process.env, PYTHONDONTWRITEBYTECODE: "1" };
  for (const name of ["HUGGINGFACE_TOKEN"] as const) {
    if (environment[name]) continue;
    const value = await readRepositoryEnvValue(root, name);
    if (value) environment[name] = value;
  }
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(command, values, {
      cwd: root,
      env: environment,
      stdio: "inherit",
    });
    child.once("error", rejectRun);
    child.once("exit", (code) =>
      code === 0 ? resolveRun() : rejectRun(new Error(`${command} exited with status ${code}`)),
    );
  });
}

async function readRepositoryEnvValue(root: string, name: string): Promise<string | undefined> {
  let text: string;
  try {
    text = Buffer.from(await readBoundedWorkspaceBytes(root, ".env", 64 * 1024)).toString("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${escaped}\\s*=\\s*("?)([^"\\n]*)\\1\\s*$`, "u");
  let found: string | undefined;
  for (const line of text.split("\n")) {
    const match = pattern.exec(line);
    if (match?.[2]?.trim()) found = match[2].trim();
  }
  return found;
}

async function removeRegularFileIfPresent(root: string, path: string): Promise<void> {
  const destination = absolute(root, path);
  const information = await lstat(destination).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!information) return;
  if (!information.isFile() || information.isSymbolicLink())
    throw new Error(`Refusing to replace unsafe worker output ${path}`);
  await unlink(destination);
}

export function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
