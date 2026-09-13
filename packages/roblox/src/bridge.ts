import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "zod";
import { HASH_SCHEMA, contentHash, stableJson } from "@basalt/contracts";
import {
  readBoundedWorkspaceBytes,
  readBoundedWorkspaceJson,
  acquireWorkspaceExclusiveLock,
  writeCanonicalWorkspaceJson,
  writePrivateWorkspaceText,
  type WorkspaceExclusiveLock,
} from "@basalt/artifact-store";
import {
  ROBLOX_IMPORT_MANIFEST_SCHEMA,
  ROBLOX_READBACK_SCHEMA,
  computeRobloxObservedWorldStateHash,
  verifyRobloxReadback,
  type RobloxImportManifest,
} from "./protocol.js";

export const ROBLOX_PORT_RANGE: Readonly<{ minimum: number; maximum: number }> = Object.freeze({
  minimum: 8787,
  maximum: 8797,
});
export const ROBLOX_CREDENTIAL_PATH = ".basalt/roblox/credential.json";
export const ROBLOX_CONNECTION_BOOTSTRAP_PATH = ".basalt/roblox/EmbeddedConnection.luau";
export const ROBLOX_IMPORT_LOCK_PATH = ".basalt/roblox/import.lock";

export const ROBLOX_CREDENTIAL_SCHEMA = z
  .object({
    kind: z.literal("RobloxLocalCredential"),
    token: z.string().regex(/^[a-f0-9]{64}$/u),
    portRange: z.object({ minimum: z.literal(8787), maximum: z.literal(8797) }).strict(),
    hash: HASH_SCHEMA,
  })
  .strict()
  .superRefine((value, context) => {
    const material = { ...value };
    delete (material as Partial<typeof value>).hash;
    if (contentHash(stableJson(material)) !== value.hash)
      context.addIssue({ code: "custom", path: ["hash"], message: "Credential hash mismatch" });
  });
export type RobloxCredential = z.output<typeof ROBLOX_CREDENTIAL_SCHEMA>;

export async function installRobloxCredential(workspaceRoot: string): Promise<RobloxCredential> {
  const material = {
    kind: "RobloxLocalCredential" as const,
    token: randomBytes(32).toString("hex"),
    portRange: ROBLOX_PORT_RANGE,
  };
  const credential = ROBLOX_CREDENTIAL_SCHEMA.parse({
    ...material,
    hash: contentHash(stableJson(material)),
  });
  await replaceWorkspaceJson(workspaceRoot, ROBLOX_CREDENTIAL_PATH, credential);
  const bootstrap = [
    "-- Generated locally by `basalt roblox install-plugin`. Do not commit.",
    "return {",
    `\ttoken = ${JSON.stringify(credential.token)},`,
    `\tminimumPort = ${credential.portRange.minimum},`,
    `\tmaximumPort = ${credential.portRange.maximum},`,
    "}",
    "",
  ].join("\n");
  await replaceWorkspaceText(workspaceRoot, ROBLOX_CONNECTION_BOOTSTRAP_PATH, bootstrap);
  return credential;
}

export async function readRobloxCredential(workspaceRoot: string): Promise<RobloxCredential> {
  return ROBLOX_CREDENTIAL_SCHEMA.parse(
    await readBoundedWorkspaceJson(workspaceRoot, ROBLOX_CREDENTIAL_PATH, 4096),
  );
}

export type RobloxBridgeState = "idle" | "pending" | "complete" | "incomplete";

export class RobloxImportBridge {
  public readonly workspaceRoot: string;
  public readonly manifest: RobloxImportManifest;
  public readonly credential: RobloxCredential;
  #index = 0;
  #state: RobloxBridgeState = "idle";
  #diagnostics: string[] = [];
  #server: ReturnType<typeof createServer> | undefined;
  #lock: WorkspaceExclusiveLock | undefined;
  #port: number | undefined;

  public constructor(input: {
    readonly workspaceRoot: string;
    readonly manifest: RobloxImportManifest;
    readonly credential: RobloxCredential;
  }) {
    this.workspaceRoot = input.workspaceRoot;
    this.manifest = ROBLOX_IMPORT_MANIFEST_SCHEMA.parse(input.manifest);
    this.credential = ROBLOX_CREDENTIAL_SCHEMA.parse(input.credential);
  }

  public get state(): RobloxBridgeState {
    return this.#state;
  }

  public get port(): number | undefined {
    return this.#port;
  }

  public async start(): Promise<number> {
    if (this.#server) throw new Error("Roblox bridge is already active");
    try {
      this.#lock = await acquireWorkspaceExclusiveLock(this.workspaceRoot, ROBLOX_IMPORT_LOCK_PATH);
    } catch (error) {
      if (isAlreadyExists(error)) throw new Error("Another Basalt Roblox import is active");
      throw error;
    }
    this.#state = "pending";
    this.#server = createServer((request, response) => {
      void this.#handle(request, response);
    });
    for (let port = ROBLOX_PORT_RANGE.minimum; port <= ROBLOX_PORT_RANGE.maximum; port += 1)
      try {
        await listen(this.#server, port);
        this.#port = port;
        return port;
      } catch (error) {
        if (!isAddressInUse(error) || port === ROBLOX_PORT_RANGE.maximum) {
          await this.stop();
          throw error;
        }
      }
    throw new Error("No Roblox bridge port is available");
  }

  public async stop(): Promise<void> {
    if (this.#server) await close(this.#server);
    this.#server = undefined;
    this.#port = undefined;
    if (this.#lock) await this.#lock.release();
    this.#lock = undefined;
    if (this.#state === "pending") this.#state = "incomplete";
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (request.method === "GET" && request.url === "/health") {
        sendJson(response, 200, { status: "ok" });
        return;
      }
      if (!authenticated(request, this.credential.token)) {
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }
      if (request.method === "GET" && request.url === "/session") {
        sendJson(response, 200, {
          state: this.#state,
          sessionHash: this.manifest.sessionHash,
          worldBuildHash: this.manifest.worldBuildHash,
          worldStatus: this.manifest.worldStatus,
          loweringGapCount: this.manifest.loweringGaps.length,
          stage: this.manifest.transactions[this.#index]?.stage ?? "complete",
          progress: { complete: this.#index, total: this.manifest.transactions.length },
          diagnosticCount: this.#diagnostics.length,
        });
        return;
      }
      if (request.method === "GET" && request.url === "/next") {
        sendJson(response, 200, {
          state: this.#state,
          transaction: this.manifest.transactions[this.#index] ?? null,
        });
        return;
      }
      if (request.method === "POST" && request.url === "/readback") {
        const transaction = this.manifest.transactions[this.#index];
        if (!transaction) throw new Error("Import has no pending transaction");
        const readback = ROBLOX_READBACK_SCHEMA.parse(await readJsonBody(request, 4 * 1024 * 1024));
        const diagnostics = verifyRobloxReadback(transaction, readback);
        if (readback.status === "incomplete" || diagnostics.length > 0) {
          this.#diagnostics.push(...readback.diagnostics, ...diagnostics);
          this.#state = "incomplete";
          sendJson(response, 409, { state: this.#state, diagnostics: this.#diagnostics });
          return;
        }
        this.#index += 1;
        this.#state = this.#index >= this.manifest.transactions.length ? "complete" : "pending";
        sendJson(response, 200, {
          state: this.#state,
          observedWorldStateHash: computeRobloxObservedWorldStateHash(transaction, readback),
          progress: { complete: this.#index, total: this.manifest.transactions.length },
        });
        return;
      }
      if (request.method === "POST" && request.url === "/cancel") {
        this.#state = "incomplete";
        this.#diagnostics.push("Import cancelled at a transaction boundary");
        sendJson(response, 200, { state: this.#state });
        return;
      }
      if (request.method === "POST" && request.url === "/restart") {
        this.#index = 0;
        this.#diagnostics = [];
        this.#state = "pending";
        sendJson(response, 200, {
          state: this.#state,
          progress: { complete: 0, total: this.manifest.transactions.length },
        });
        return;
      }
      sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      this.#state = "incomplete";
      const message = error instanceof Error ? error.message : String(error);
      this.#diagnostics.push(message);
      sendJson(response, 400, { state: this.#state, error: message });
    }
  }
}

function authenticated(request: IncomingMessage, token: string): boolean {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7), "utf8");
  const expected = Buffer.from(token, "utf8");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function readJsonBody(request: IncomingMessage, maximumBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maximumBytes) throw new Error("Request body exceeds byte limit");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Request body is not valid JSON");
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const bytes = Buffer.from(stableJson(value), "utf8");
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(bytes.length),
    "cache-control": "no-store",
  });
  response.end(bytes);
}

function listen(server: ReturnType<typeof createServer>, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

function isAddressInUse(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "EADDRINUSE"
  );
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

async function replaceWorkspaceJson(root: string, path: string, value: unknown): Promise<void> {
  const expectedExistingHash = await existingHash(root, path);
  await writeCanonicalWorkspaceJson(root, path, value, {
    maxBytes: 4096,
    ...(expectedExistingHash ? { expectedExistingHash } : {}),
  });
}

async function replaceWorkspaceText(root: string, path: string, value: string): Promise<void> {
  const expectedExistingHash = await existingHash(root, path);
  await writePrivateWorkspaceText(root, path, value, {
    maxBytes: 4096,
    ...(expectedExistingHash ? { expectedExistingHash } : {}),
  });
}

async function existingHash(root: string, path: string): Promise<string | undefined> {
  try {
    const bytes = await readBoundedWorkspaceBytes(root, path, 4096);
    return contentHash(Buffer.from(bytes).toString("utf8"));
  } catch (error) {
    if (
      error instanceof Error &&
      /does not exist|ENOENT|not found|file is missing/iu.test(error.message)
    )
      return undefined;
    throw error;
  }
}
