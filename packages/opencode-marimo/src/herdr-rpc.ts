// The `herdr` RPC: how other components report to herdr without herdr code of their own. The
// role pi-herdr's event bus plays for Pi. This file is the contract; components that report copy
// it verbatim (scripts/test-contracts.mjs keeps the copies identical) and import nothing else of
// opencode-herdr.
//
// OpenCode 2 runs every server half in one shared background service, which serves many
// terminals and herdr panes at once, so a server half cannot know a pane. It reports per
// session instead: opencode-herdr's server half records the state and re-emits it as events, and
// each terminal (opencode-herdr's CLI half, which runs in the pane and has HERDR_PANE_ID) applies
// what concerns the session family it shows.
//
// Calls fail with `rpc.unavailable` when opencode-herdr is not loaded: catch and ignore them.
// opencode-herdr emits `ready` when it registers, so a component whose calls failed before can
// send its current state again.
//
//   token  { sessionID, key, value?, ttlMs? }   set (value) or clear (no value) the pane token `$key`
//   notify { sessionID, title, body?, sound?, unlessFocused? }   a herdr notification
//   zoom   { sessionID, holder, active }        zoom the pane while any holder is active
//   state  { sessionID } -> { tokens }          the tokens currently set for a session (for a
//                                                terminal that starts showing it)
import type { Rpc } from "@opencode/plugin/rpc";

const sessionID = { type: "string", minLength: 1 } as const;

const tokenSchema = {
  type: "object",
  properties: {
    sessionID,
    key: { type: "string", minLength: 1 },
    value: { type: "string" },
    ttlMs: { type: "number", minimum: 0 },
  },
  required: ["sessionID", "key"],
  additionalProperties: false,
} as const;

const notifySchema = {
  type: "object",
  properties: {
    sessionID,
    title: { type: "string", minLength: 1 },
    body: { type: "string" },
    sound: { enum: ["none", "done", "request"] },
    unlessFocused: { type: "boolean" },
  },
  required: ["sessionID", "title"],
  additionalProperties: false,
} as const;

const zoomSchema = {
  type: "object",
  properties: { sessionID, holder: { type: "string", minLength: 1 }, active: { type: "boolean" } },
  required: ["sessionID", "holder", "active"],
  additionalProperties: false,
} as const;

const empty = { type: "object", properties: {}, additionalProperties: false } as const;

export const HerdrRpc = {
  id: "herdr",
  methods: {
    token: { input: tokenSchema, output: empty },
    notify: { input: notifySchema, output: empty },
    zoom: { input: zoomSchema, output: empty },
    state: {
      input: { type: "object", properties: { sessionID }, required: ["sessionID"], additionalProperties: false },
      output: {
        type: "object",
        properties: { tokens: { type: "array", items: tokenSchema } },
        required: ["tokens"],
        additionalProperties: false,
      },
    },
  },
  events: {
    ready: { schema: empty },
    token: { schema: tokenSchema },
    notify: { schema: notifySchema },
    zoom: { schema: zoomSchema },
  },
} as const satisfies Rpc.PortableDefinition;

export type HerdrToken = { sessionID: string; key: string; value?: string; ttlMs?: number };
export type HerdrNotify = { sessionID: string; title: string; body?: string; sound?: "none" | "done" | "request"; unlessFocused?: boolean };
export type HerdrZoom = { sessionID: string; holder: string; active: boolean };
