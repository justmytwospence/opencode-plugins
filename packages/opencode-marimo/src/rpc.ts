// The marimo RPC between the server half (which follows the notebooks) and the CLI half (which
// shows them). Methods are answered by the server half of the terminal's location; `changed` is
// emitted whenever a followed notebook or the mode changes, and the CLI half then asks for the
// report of the session it shows.
//
//   status   { sessionID? } -> { report }  what that session's agent sees: its current notebook
//                                          first (status.ts turns it into the prompt line)
//   snapshot { sessionID? } -> { text }    the state block the next prompt would carry ("" when
//                                          no notebook is connected)
//   mode     {} -> { mode }                the mode of this location: auto, pinned paths, or off
//   setMode  { mode } -> {}
//   list     {} -> { notebooks }           every notebook open on a registered marimo server
import type { Rpc } from "@opencode/plugin/rpc";

/** The session whose agent's view is asked for; none (the home screen) sees the watcher's own order. */
const sessionID = { type: "string" } as const;
const empty = { type: "object", properties: {}, additionalProperties: false } as const;

const modeSchema = {
  type: "object",
  properties: {
    kind: { enum: ["auto", "pinned", "off"] },
    paths: { type: "array", items: { type: "string" } },
  },
  required: ["kind"],
  additionalProperties: false,
} as const;

const notebookReport = {
  type: "object",
  properties: {
    path: { type: "string" },
    connection: { type: "string" },
    current: { type: "boolean" },
    running: {
      type: "object",
      properties: { section: { type: "string" }, cell: { type: "string" }, since: { type: "number" } },
      required: ["section", "cell"],
      additionalProperties: false,
    },
    queued: { type: "number" },
    errors: { type: "number" },
  },
  required: ["path", "connection", "current", "queued", "errors"],
  additionalProperties: false,
} as const;

const reportSchema = {
  type: "object",
  properties: {
    mode: { enum: ["auto", "pinned", "off"] },
    pinned: { type: "array", items: { type: "string" } },
    notebooks: { type: "array", items: notebookReport },
  },
  required: ["mode", "notebooks"],
  additionalProperties: false,
} as const;

export const MarimoRpc = {
  id: "marimo",
  methods: {
    status: {
      input: { type: "object", properties: { sessionID }, additionalProperties: false },
      output: { type: "object", properties: { report: reportSchema }, required: ["report"], additionalProperties: false },
    },
    snapshot: {
      input: { type: "object", properties: { sessionID }, additionalProperties: false },
      output: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
    },
    mode: {
      input: empty,
      output: { type: "object", properties: { mode: modeSchema }, required: ["mode"], additionalProperties: false },
    },
    setMode: {
      input: { type: "object", properties: { mode: modeSchema }, required: ["mode"], additionalProperties: false },
      output: empty,
    },
    list: {
      input: empty,
      output: {
        type: "object",
        properties: {
          notebooks: {
            type: "array",
            items: {
              type: "object",
              properties: { path: { type: "string" }, url: { type: "string" }, sessionId: { type: "string" } },
              required: ["path", "url", "sessionId"],
              additionalProperties: false,
            },
          },
        },
        required: ["notebooks"],
        additionalProperties: false,
      },
    },
  },
  events: {
    changed: { schema: empty },
  },
} as const satisfies Rpc.PortableDefinition;

/** The mode over the wire: `paths` only when pinned. */
export type ModeInput = { kind: "auto" | "off" } | { kind: "pinned"; paths: string[] };

export interface NotebookReport {
  path: string;
  /** "connected" | "connecting" | "disconnected" */
  connection: string;
  current: boolean;
  /** The running cell: its heading path (" › " joined), its name or id, and when it started. */
  running?: { section: string; cell: string; since?: number };
  queued: number;
  errors: number;
}

/** What a session's agent sees, the current notebook first. */
export interface Report {
  mode: "auto" | "pinned" | "off";
  /** Pinned paths (shown as "not open" while none is connected). */
  pinned?: string[];
  notebooks: NotebookReport[];
}
