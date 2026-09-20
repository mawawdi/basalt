/** Providers perform one bounded inference. They cannot execute tools or mutate a world. */
export interface WorldPlannerRequest {
  readonly system: string;
  readonly prompt: string;
  readonly schema: Record<string, unknown>;
  readonly images: readonly { readonly dataUrl: string; readonly hash: string }[];
  readonly maxOutputTokens: number;
  readonly signal: AbortSignal;
}
export interface WorldPlannerResponse {
  readonly output: unknown;
  readonly raw: string;
  readonly usage: unknown;
  readonly model: string;
  readonly upstreamProvider?: string;
  readonly transportFailures?: readonly WorldPlannerTransportFailure[];
}
export interface WorldPlannerTransportFailure {
  readonly attempt: number;
  readonly status: number;
  readonly raw: string;
  readonly retryAfterMilliseconds: number | null;
  readonly retried: boolean;
}
export interface WorldPlannerResourceExhaustion {
  readonly kind: "resource_exhaustion";
  readonly resource: string;
  readonly origin: "OpenRouter";
  readonly unit: "output_tokens";
  readonly requestedOutputTokens: number;
  readonly availableOutputTokens: number | null;
  readonly reason: string;
  readonly resumable: true;
}
export interface WorldPlanner {
  readonly providerId: string;
  readonly model: string;
  readonly configuration?: Readonly<Record<string, unknown>>;
  complete(request: WorldPlannerRequest): Promise<WorldPlannerResponse>;
}

export class WorldPlannerResponseError extends Error {
  constructor(
    message: string,
    readonly receipt: {
      raw: string;
      usage: unknown;
      model: string;
      upstreamProvider?: string;
      transportFailures?: readonly WorldPlannerTransportFailure[];
      resourceExhaustion?: WorldPlannerResourceExhaustion;
    },
  ) {
    super(message);
  }
}

function openRouterResourceExhaustion(
  status: number,
  raw: string,
  requestedOutputTokens: number,
): WorldPlannerResourceExhaustion | undefined {
  if (status !== 402) return undefined;
  let source = "openrouter_credits";
  let reason = `OpenRouter rejected a ${requestedOutputTokens}-output-token allocation`;
  let availableOutputTokens: number | null = null;
  try {
    const parsed = JSON.parse(raw) as {
      error?: { message?: unknown; metadata?: { limit_source?: unknown } };
    };
    if (typeof parsed.error?.metadata?.limit_source === "string")
      source = parsed.error.metadata.limit_source;
    if (typeof parsed.error?.message === "string") {
      reason = parsed.error.message;
      const match = reason.match(/can only afford\s+([\d,]+)/iu);
      if (match) {
        const available = Number(match[1]!.replaceAll(",", ""));
        if (Number.isSafeInteger(available) && available >= 0) availableOutputTokens = available;
      }
    }
  } catch {
    // The raw response remains authoritative evidence when the provider body is malformed.
  }
  return {
    kind: "resource_exhaustion",
    resource: source,
    origin: "OpenRouter",
    unit: "output_tokens",
    requestedOutputTokens,
    availableOutputTokens,
    reason,
    resumable: true,
  };
}

function waitForRetry(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    function done() {
      signal.removeEventListener("abort", abort);
      resolve();
    }
    function abort() {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? new Error("Planner request aborted"));
    }
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

function retryAfterMilliseconds(response: Response, raw: string): number | null {
  let value = response.headers.get("retry-after");
  if (!value)
    try {
      const parsed = JSON.parse(raw) as {
        error?: { metadata?: { headers?: { "Retry-After"?: unknown } } };
      };
      const embedded = parsed.error?.metadata?.headers?.["Retry-After"];
      if (typeof embedded === "string" || typeof embedded === "number") value = String(embedded);
    } catch {
      // The HTTP failure body remains in receipt evidence; an unparseable body supplies no delay.
    }
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function untilAborted<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("Planner request aborted"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    pending.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

/** Standard JSON-Schema chat completion, with local validation still authoritative. */
export function createOpenRouterPlanner(input: {
  apiKey: string;
  model: string;
  origin: string;
  reasoningEffort?: "none" | "low" | "high";
  maximumOutputTokensPerRequest: number;
  maximumResponseBytes: number;
  providerSort: "price" | "throughput" | "latency";
  maximumTransientRetries: number;
  maximumRetryDelayMilliseconds: number;
  retryableHttpStatuses: readonly number[];
  fetch?: typeof fetch;
}): WorldPlanner {
  if (
    !input.apiKey.trim() ||
    !input.origin.trim() ||
    !/^[A-Za-z0-9_.:/-]{1,160}$/u.test(input.model) ||
    !Number.isSafeInteger(input.maximumOutputTokensPerRequest) ||
    input.maximumOutputTokensPerRequest <= 0 ||
    !Number.isSafeInteger(input.maximumResponseBytes) ||
    input.maximumResponseBytes <= 0 ||
    !Number.isSafeInteger(input.maximumTransientRetries) ||
    input.maximumTransientRetries < 0 ||
    !Number.isSafeInteger(input.maximumRetryDelayMilliseconds) ||
    input.maximumRetryDelayMilliseconds < 0 ||
    new Set(input.retryableHttpStatuses).size !== input.retryableHttpStatuses.length ||
    input.retryableHttpStatuses.some(
      (status) => !Number.isSafeInteger(status) || status < 400 || status > 599,
    )
  )
    throw new Error("OpenRouter requires an explicit key and model ID");
  const transport = input.fetch ?? fetch;
  const reasoningEffort = input.reasoningEffort ?? "low";
  return {
    providerId: "OpenRouter",
    model: input.model,
    configuration: {
      origin: input.origin,
      maximumOutputTokensPerRequest: input.maximumOutputTokensPerRequest,
      maximumResponseBytes: input.maximumResponseBytes,
      reasoningEffort,
      providerSort: input.providerSort,
      maximumTransientRetries: input.maximumTransientRetries,
      maximumRetryDelayMilliseconds: input.maximumRetryDelayMilliseconds,
      retryableHttpStatuses: [...input.retryableHttpStatuses],
    },
    async complete(request) {
      request.signal.throwIfAborted();
      if (
        !Number.isSafeInteger(request.maxOutputTokens) ||
        request.maxOutputTokens <= 0 ||
        request.maxOutputTokens > input.maximumOutputTokensPerRequest
      )
        throw new Error(
          `Planner output allocation must be a positive safe integer no greater than ${input.maximumOutputTokensPerRequest}`,
        );
      const transportFailures: WorldPlannerTransportFailure[] = [];
      let response: Response;
      let raw: string;
      for (let attempt = 1; ; attempt++) {
        response = await untilAborted(
          transport("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            redirect: "error",
            signal: request.signal,
            headers: {
              Authorization: `Bearer ${input.apiKey}`,
              "Content-Type": "application/json",
              "X-Title": "Basalt",
            },
            body: JSON.stringify({
              model: input.model,
              stream: false,
              // The provider counts reasoning and the final JSON against this same allowance.
              max_tokens: request.maxOutputTokens,
              reasoning:
                reasoningEffort === "none" ? { enabled: false } : { effort: reasoningEffort },
              provider: { require_parameters: true, sort: input.providerSort },
              response_format: {
                type: "json_schema",
                json_schema: {
                  name: "basalt_world_proposal",
                  strict: true,
                  schema: request.schema,
                },
              },
              messages: [
                { role: "system", content: request.system },
                {
                  role: "user",
                  content: [
                    { type: "text", text: request.prompt },
                    ...request.images.map((i) => ({
                      type: "image_url",
                      image_url: { url: i.dataUrl },
                    })),
                  ],
                },
              ],
            }),
          }),
          request.signal,
        );
        const reader = response.body?.getReader();
        if (!reader) throw new Error("Planner returned an empty HTTP body");
        const buffers: Uint8Array[] = [];
        let size = 0;
        try {
          for (;;) {
            const result = await untilAborted(reader.read(), request.signal);
            if (result.done) break;
            size += result.value.byteLength;
            if (size > input.maximumResponseBytes)
              throw new Error(
                `Planner response exceeded the execution policy (${input.maximumResponseBytes} bytes)`,
              );
            buffers.push(result.value);
          }
        } finally {
          // Transport cancellation must not hold the caller past its deadline.
          void reader.cancel().catch(() => undefined);
        }
        raw = Buffer.concat(buffers).toString("utf8").split(input.apiKey).join("[redacted]");
        if (response.ok) break;
        const delay = retryAfterMilliseconds(response, raw);
        const retried =
          attempt <= input.maximumTransientRetries &&
          input.retryableHttpStatuses.includes(response.status) &&
          delay !== null &&
          delay <= input.maximumRetryDelayMilliseconds;
        transportFailures.push({
          attempt,
          status: response.status,
          raw,
          retryAfterMilliseconds: delay,
          retried,
        });
        if (retried) {
          await waitForRetry(delay, request.signal);
          continue;
        }
        const resourceExhaustion = openRouterResourceExhaustion(
          response.status,
          raw,
          request.maxOutputTokens,
        );
        throw new WorldPlannerResponseError(
          `OpenRouter HTTP ${response.status}: ${raw.slice(0, 1_024)}${raw.length > 1_024 ? " (full response retained in receipt evidence)" : ""}`,
          {
            raw,
            usage: null,
            model: input.model,
            ...(response.headers.get("x-openrouter-provider")
              ? { upstreamProvider: response.headers.get("x-openrouter-provider")! }
              : {}),
            transportFailures,
            ...(resourceExhaustion ? { resourceExhaustion } : {}),
          },
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new WorldPlannerResponseError("Planner returned invalid HTTP JSON", {
          raw,
          usage: null,
          model: input.model,
        });
      }
      const body = parsed as {
        error?: { message?: string };
        model?: string;
        provider?: string;
        usage?: unknown;
        choices?: Array<{
          finish_reason?: string;
          message?: { content?: string; refusal?: string; tool_calls?: unknown[] };
        }>;
      };
      const choice = body.choices?.[0];
      const receipt = {
        raw,
        usage: body.usage ?? null,
        model: body.model ?? input.model,
        ...(body.provider ? { upstreamProvider: body.provider } : {}),
        ...(transportFailures.length ? { transportFailures } : {}),
      };
      if (
        body.error ||
        !choice ||
        choice.finish_reason !== "stop" ||
        choice.message?.refusal ||
        choice.message?.tool_calls?.length ||
        typeof choice.message?.content !== "string"
      )
        throw new WorldPlannerResponseError(
          `Planner did not complete one JSON response (${choice?.finish_reason ?? body.error?.message ?? "missing choice"})`,
          receipt,
        );
      try {
        return { output: JSON.parse(choice.message.content), ...receipt };
      } catch {
        throw new WorldPlannerResponseError("Planner returned invalid JSON", receipt);
      }
    },
  };
}
