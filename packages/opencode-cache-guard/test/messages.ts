// OpenCode 2 session messages for the tests.
import type { MessageLike } from "../src/units.ts";

export const user = (text: string, synthetic = false): MessageLike => (synthetic ? { type: "synthetic", text } : { type: "user", text });

export const assistant = (
  texts: string[],
  tools: Array<{ tool: string; callID: string; input: Record<string, unknown>; output?: string; error?: string }> = [],
  extra: Record<string, unknown> = {},
): MessageLike => ({
  type: "assistant",
  ...extra,
  content: [
    ...texts.map((text) => ({ type: "text", text })),
    ...tools.map((t) => ({
      type: "tool",
      id: t.callID,
      name: t.tool,
      state: t.error !== undefined
        ? { status: "error", input: t.input, error: { name: "ToolError", message: t.error } }
        : { status: "completed", input: t.input, content: [{ type: "text", text: t.output ?? "" }] },
    })),
  ],
});

export const compaction = (summary: string, status = "completed"): MessageLike => ({ type: "compaction", status, summary, recent: "" });
