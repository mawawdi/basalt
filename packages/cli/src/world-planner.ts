/** Providers perform one bounded inference. They cannot execute tools or mutate a world. */
export interface WorldPlannerRequest {
  readonly system: string;
  readonly prompt: string;
  readonly schema: Record<string, unknown>;
  readonly images: readonly { readonly dataUrl: string; readonly hash: string }[];
  readonly signal: AbortSignal;
}
export interface WorldPlannerResponse {
  readonly output: unknown;
  readonly raw: string;
  readonly usage: unknown;
  readonly model: string;
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
    readonly receipt: { raw: string; usage: unknown; model: string },
  ) {
    super(message);
  }
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
  reasoningEffort?: "none" | "low" | "high";
  fetch?: typeof fetch;
}): WorldPlanner {
  if (!input.apiKey.trim() || !/^[A-Za-z0-9_.:/-]{1,160}$/u.test(input.model))
    throw new Error("OpenRouter requires an explicit key and model ID");
  const transport = input.fetch ?? fetch;
  const reasoningEffort = input.reasoningEffort ?? "low";
  return {
    providerId: "OpenRouter",
    model: input.model,
    configuration: { maxOutputTokens: 24576, reasoningEffort, providerSort: "throughput" },
    async complete(request) {
      request.signal.throwIfAborted();
      const response = await untilAborted(
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
            max_tokens: 24576,
            reasoning:
              reasoningEffort === "none" ? { enabled: false } : { effort: reasoningEffort },
            provider: { require_parameters: true, sort: "throughput" },
            response_format: {
              type: "json_schema",
              json_schema: { name: "basalt_world_proposal", strict: true, schema: request.schema },
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
          if (size > 8 * 1024 * 1024) throw new Error("Planner response exceeded 8 MiB");
          buffers.push(result.value);
        }
      } finally {
        // Transport cancellation must not hold the caller past its deadline.
        void reader.cancel().catch(() => undefined);
      }
      const raw = Buffer.concat(buffers).toString("utf8").split(input.apiKey).join("[redacted]");
      if (!response.ok)
        throw new WorldPlannerResponseError(
          `OpenRouter HTTP ${response.status}: ${raw.slice(0, 1024)}`,
          { raw, usage: null, model: input.model },
        );
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
        usage?: unknown;
        choices?: Array<{
          finish_reason?: string;
          message?: { content?: string; refusal?: string; tool_calls?: unknown[] };
        }>;
      };
      const choice = body.choices?.[0];
      const receipt = { raw, usage: body.usage ?? null, model: body.model ?? input.model };
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
