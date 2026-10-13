// The cache-guard RPC between the server half (one shared server, state per session) and the
// terminal halves (one per terminal, each showing some session).
//
//   state    { sessionID } -> snapshot | null   the session's cache clock, as the server knows it
//   arm      { sessionID, kind, text? }          what the session's next compaction should do:
//                                                 "jev": Jev's summary written in code, judged against
//                                                 `text` (nothing is compacted when Jev fails);
//                                                 "guidance": `text` goes to OpenCode's summarizer
//   jev      {} -> { kind, reason?, label?, latencyMs? }   whether the server reaches Jev, and how fast
//
//   state     a snapshot changed
//   trimmed   tool output was trimmed (the terminal shows a toast)
//   compacted a compaction the terminal armed ran (ok) or did not (the reason)
import type { Rpc } from "@opencode/plugin/rpc";
import type { Snapshot } from "./clock.ts";

const sessionID = { type: "string", minLength: 1 } as const;

const modelSchema = {
  type: "object",
  properties: { providerID: { type: "string" }, modelID: { type: "string" } },
  required: ["providerID", "modelID"],
  additionalProperties: false,
} as const;

const priceSchema = {
  type: "object",
  properties: { input: { type: "number" }, cacheRead: { type: "number" }, cacheWrite: { type: "number" } },
  required: ["input", "cacheRead"],
  additionalProperties: false,
} as const;

export const snapshotSchema = {
  type: "object",
  properties: {
    sessionID,
    lastAt: { type: "number" },
    ttlMs: { type: "number" },
    tokens: { type: "number" },
    model: modelSchema,
    price: priceSchema,
    lastCache: {
      type: "object",
      properties: { read: { type: "number" }, write: { type: "number" }, prompt: { type: "number" } },
      required: ["read", "write", "prompt"],
      additionalProperties: false,
    },
    updatedAt: { type: "number" },
  },
  required: ["sessionID", "lastAt", "tokens", "updatedAt"],
  additionalProperties: false,
} as const;

const noteSchema = {
  type: "object",
  properties: { sessionID, message: { type: "string" } },
  required: ["sessionID", "message"],
  additionalProperties: false,
} as const;

export const CacheGuardRpc = {
  id: "cache-guard",
  methods: {
    state: {
      input: { type: "object", properties: { sessionID }, required: ["sessionID"], additionalProperties: false },
      output: { anyOf: [snapshotSchema, { type: "null" }] },
    },
    arm: {
      input: {
        type: "object",
        properties: { sessionID, kind: { enum: ["jev", "guidance"] }, text: { type: "string" } },
        required: ["sessionID", "kind"],
        additionalProperties: false,
      },
      output: { type: "object", properties: {}, additionalProperties: false },
    },
    jev: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: {
        type: "object",
        properties: {
          kind: { enum: ["ready", "missing", "off"] },
          reason: { type: "string" },
          label: { type: "string" },
          latencyMs: { type: "number" },
        },
        required: ["kind"],
        additionalProperties: false,
      },
    },
  },
  events: {
    state: { schema: snapshotSchema },
    trimmed: { schema: noteSchema },
    compacted: {
      schema: {
        type: "object",
        properties: { sessionID, ok: { type: "boolean" }, message: { type: "string" } },
        required: ["sessionID", "ok", "message"],
        additionalProperties: false,
      },
    },
  },
} as const satisfies Rpc.PortableDefinition;

export type StateOutput = Snapshot | null;
export type ArmInput = { sessionID: string; kind: "jev" | "guidance"; text?: string };
export type JevOutput = { kind: "ready" | "missing" | "off"; reason?: string; label?: string; latencyMs?: number };
export type Note = { sessionID: string; message: string };
export type Compacted = { sessionID: string; ok: boolean; message: string };
