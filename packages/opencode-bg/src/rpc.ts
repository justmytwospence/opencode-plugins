// The bg RPC: the server half owns the tasks (one shared server runs every session's); the CLI
// half reads the tasks of the sessions it shows, reads a log's tail, stops a task, and hides ended
// ones. `changed` says a session's tasks changed, so the terminal re-reads them.
import type { Rpc } from "@opencode/plugin/rpc";

const taskSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    sessionID: { type: "string" },
    name: { type: "string" },
    kind: { enum: ["job", "service"] },
    command: { type: "string" },
    cwd: { type: "string" },
    logPath: { type: "string" },
    pid: { type: "number" },
    startedAt: { type: "number" },
    endedAt: { type: "number" },
    exitCode: { type: ["number", "null"] },
    signal: { type: ["string", "null"] },
    status: { enum: ["running", "done", "failed", "killed", "timeout"] },
    ready: { type: "boolean" },
    readyPattern: { type: "string" },
    readyLine: { type: "string" },
    keep: { type: "boolean" },
    killedBy: { enum: ["agent", "user", "session", "timeout"] },
    waiting: { type: "boolean" },
    willWake: { type: "boolean" },
  },
  required: ["id", "sessionID", "name", "kind", "command", "cwd", "logPath", "startedAt", "status", "ready", "keep", "waiting", "willWake"],
  additionalProperties: false,
} as const;

const sessionIDs = { type: "array", items: { type: "string" } } as const;

export const BgRpc = {
  id: "bg",
  methods: {
    tasks: {
      input: { type: "object", properties: { sessionIDs }, required: ["sessionIDs"], additionalProperties: false },
      output: { type: "object", properties: { tasks: { type: "array", items: taskSchema } }, required: ["tasks"], additionalProperties: false },
    },
    logs: {
      input: { type: "object", properties: { id: { type: "string" }, lines: { type: "number" } }, required: ["id"], additionalProperties: false },
      output: { type: "object", properties: { lines: { type: "array", items: { type: "string" } } }, required: ["lines"], additionalProperties: false },
    },
    kill: {
      input: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
      output: { type: "object", properties: { message: { type: "string" } }, required: ["message"], additionalProperties: false },
    },
    clear: {
      input: { type: "object", properties: { sessionIDs }, required: ["sessionIDs"], additionalProperties: false },
      output: { type: "object", properties: { count: { type: "number" } }, required: ["count"], additionalProperties: false },
    },
  },
  events: {
    changed: {
      schema: { type: "object", properties: { sessionID: { type: "string" } }, required: ["sessionID"], additionalProperties: false },
    },
  },
} as const satisfies Rpc.PortableDefinition;

export type ChangedEvent = { sessionID: string };
