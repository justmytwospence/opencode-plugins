// The tool-gate RPC between its server half (which decides and keeps each session's mode) and
// its CLI half (which switches modes and shows them). Calls are per session: a terminal passes
// the session it shows.
//
//   status    { sessionID } -> Status                the mode, cycle and counts of a session
//   setMode   { sessionID, mode } -> { mode }        switch a session's mode (a name parseMode accepts)
//   cycleMode { sessionID } -> { mode }              the next mode in the configured cycle
//   changed   { sessionID, mode, previous?, counts }  emitted on every mode change and decision
//   notice    { sessionID, message, variant }         something the CLI half should show as a toast
import type { Rpc } from "@opencode/plugin/rpc";

const sessionID = { type: "string", minLength: 1 } as const;

const counts = {
  type: "object",
  properties: { auto: { type: "number" }, pushedBack: { type: "number" }, asked: { type: "number" } },
  required: ["auto", "pushedBack", "asked"],
  additionalProperties: false,
} as const;

const status = {
  type: "object",
  properties: {
    mode: { type: "string" },
    cycle: { type: "array", items: { type: "string" } },
    counts,
    jev: { type: "string" },
    pushBack: { type: "boolean" },
    rules: { type: "number" },
    grants: { type: "number" },
  },
  required: ["mode", "cycle", "counts", "jev", "pushBack", "rules", "grants"],
  additionalProperties: false,
} as const;

const modeOut = { type: "object", properties: { mode: { type: "string" } }, required: ["mode"], additionalProperties: false } as const;

export const ToolGateRpc = {
  id: "tool-gate",
  methods: {
    status: {
      input: { type: "object", properties: { sessionID }, required: ["sessionID"], additionalProperties: false },
      output: status,
    },
    setMode: {
      input: { type: "object", properties: { sessionID, mode: { type: "string" } }, required: ["sessionID", "mode"], additionalProperties: false },
      output: modeOut,
      errors: { unknown_mode: { type: "object", properties: {}, additionalProperties: false } },
    },
    cycleMode: {
      input: { type: "object", properties: { sessionID }, required: ["sessionID"], additionalProperties: false },
      output: modeOut,
    },
  },
  events: {
    changed: {
      schema: {
        type: "object",
        properties: { sessionID, mode: { type: "string" }, previous: { type: "string" }, counts },
        required: ["sessionID", "mode", "counts"],
        additionalProperties: false,
      },
    },
    notice: {
      schema: {
        type: "object",
        properties: { sessionID, message: { type: "string" }, variant: { enum: ["info", "warning", "error"] } },
        required: ["sessionID", "message", "variant"],
        additionalProperties: false,
      },
    },
  },
} as const satisfies Rpc.PortableDefinition;

export interface Counts {
  auto: number;
  pushedBack: number;
  asked: number;
}

export interface Status {
  mode: string;
  cycle: string[];
  counts: Counts;
  jev: string;
  pushBack: boolean;
  rules: number;
  grants: number;
}

export interface ChangedEvent {
  sessionID: string;
  mode: string;
  previous?: string;
  counts: Counts;
}

export interface NoticeEvent {
  sessionID: string;
  message: string;
  variant: "info" | "warning" | "error";
}
