// opencode-herdr's private RPC between its own two halves. The server half runs once for every
// terminal, so it cannot know which herdr pane shows a session; the CLI half, which runs in the
// pane, tells it. The public contract other components use is src/herdr-rpc.ts.
//
//   attach { sessionID, paneId, socketPath }   this pane shows that root session now
//   detach { sessionID, paneId }               it no longer does (the pane switched or closed)
import type { Rpc } from "@opencode/plugin/rpc";

const sessionID = { type: "string", minLength: 1 } as const;
const paneId = { type: "string", minLength: 1 } as const;
const empty = { type: "object", properties: {}, additionalProperties: false } as const;

export const HerdrPaneRpc = {
  id: "herdr-pane",
  methods: {
    attach: {
      input: {
        type: "object",
        properties: { sessionID, paneId, socketPath: { type: "string", minLength: 1 } },
        required: ["sessionID", "paneId", "socketPath"],
        additionalProperties: false,
      },
      output: empty,
    },
    detach: {
      input: { type: "object", properties: { sessionID, paneId }, required: ["sessionID", "paneId"], additionalProperties: false },
      output: empty,
    },
  },
  events: {},
} as const satisfies Rpc.PortableDefinition;

export type PaneAttachment = { sessionID: string; paneId: string; socketPath: string };
