// The context RPC: the server half (one shared server sees every session's model requests)
// serves the breakdown of a session's last primary request; `updated` says a new one exists.
import type { Rpc } from "@opencode/plugin/rpc";

const itemSchema = {
  type: "object",
  properties: {
    label: { type: "string" },
    tokens: { type: "number" },
  },
  required: ["label", "tokens"],
  additionalProperties: false,
} as const;

const partSchema = {
  type: "object",
  properties: {
    key: { type: "string", enum: ["system", "instructions", "skills", "tools", "toolResults", "conversation"] },
    label: { type: "string" },
    tokens: { type: "number" },
    items: { type: "array", items: itemSchema },
    preview: { type: "string" },
    truncated: { type: "boolean" },
  },
  required: ["key", "label", "tokens", "items", "preview", "truncated"],
  additionalProperties: false,
} as const;

const snapshotSchema = {
  type: "object",
  properties: {
    parts: { type: "array", items: partSchema },
    at: { type: "number" },
    model: {
      type: "object",
      properties: { providerID: { type: "string" }, id: { type: "string" } },
      required: ["providerID", "id"],
      additionalProperties: false,
    },
    agent: { type: "string" },
    messages: { type: "number" },
  },
  required: ["parts", "at", "model", "agent", "messages"],
  additionalProperties: false,
} as const;

const sessionSchema = {
  type: "object",
  properties: { sessionID: { type: "string" } },
  required: ["sessionID"],
  additionalProperties: false,
} as const;

export const ContextRpc = {
  id: "context",
  methods: {
    /** The breakdown of the session's last primary model request; `snapshot` is absent before the first. */
    breakdown: {
      input: sessionSchema,
      output: {
        type: "object",
        properties: { snapshot: snapshotSchema },
        additionalProperties: false,
      },
    },
  },
  events: {
    updated: { schema: sessionSchema },
  },
} as const satisfies Rpc.PortableDefinition;

export type BreakdownInput = { sessionID: string };
export type UpdatedEvent = { sessionID: string };
