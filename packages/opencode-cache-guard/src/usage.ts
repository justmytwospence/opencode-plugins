// The usage block of an Anthropic Messages response, from a clone of the response the session's
// `http.response` hook sees: a JSON body, or the `message_start` event of an SSE stream (the only
// event that carries `cache_read_input_tokens` and `cache_creation_input_tokens`). Reading the
// clone never touches the stream OpenCode consumes.

export interface CacheUsage {
  /** Tokens served from the cache. */
  read: number;
  /** Tokens written to the cache. */
  write: number;
  /** The whole prompt: uncached input, cache reads and cache writes. */
  prompt: number;
}

/** The usage of a Messages response body (JSON), or undefined. */
export function usageOf(json: unknown): CacheUsage | undefined {
  const usage = (json as { usage?: Record<string, unknown> } | undefined)?.usage;
  if (!usage || typeof usage !== "object") return undefined;
  const n = (key: string) => (typeof usage[key] === "number" ? (usage[key] as number) : 0);
  const read = n("cache_read_input_tokens");
  const write = n("cache_creation_input_tokens");
  return { read, write, prompt: n("input_tokens") + read + write };
}

/** The `message_start` usage in an SSE stream's text, or undefined. */
export function usageOfStream(text: string): CacheUsage | undefined {
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    let data: unknown;
    try {
      data = JSON.parse(line.slice(5).trim());
    } catch {
      continue;
    }
    const event = data as { type?: string; message?: unknown };
    if (event?.type === "message_start") return usageOf(event.message);
  }
  return undefined;
}

/** Longest response body this reads looking for usage. */
const MAX_BYTES = 4 * 1024 * 1024;

/**
 * The cache usage of a Messages response, read from `response` (pass a clone). Resolves undefined
 * for errors, non-Messages bodies and anything this cannot parse; never throws.
 */
export async function readUsage(response: Pick<Response, "ok" | "headers" | "body" | "text">): Promise<CacheUsage | undefined> {
  if (!response.ok) return undefined;
  const type = response.headers.get("content-type") ?? "";
  try {
    if (type.includes("text/event-stream")) {
      // Stop at the first message_start: the rest of the stream is the reply, which can be long.
      const reader = response.body?.getReader();
      if (!reader) return undefined;
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (value) buffer += decoder.decode(value, { stream: true });
        const usage = usageOfStream(buffer);
        if (usage) {
          void reader.cancel().catch(() => undefined);
          return usage;
        }
        if (done || buffer.length > MAX_BYTES) return undefined;
      }
    }
    const text = await response.text();
    if (text.length > MAX_BYTES) return undefined;
    return usageOf(JSON.parse(text));
  } catch {
    return undefined;
  }
}
