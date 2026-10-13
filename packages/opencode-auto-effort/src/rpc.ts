// The auto-effort RPC: one event, `changed`, which the server half emits when it moves a session's
// level and the CLI half turns into a toast (server plugins cannot show toasts themselves).
import type { Rpc } from "@opencode/plugin/rpc";

export const AutoEffortRpc = {
  id: "auto-effort",
  methods: {},
  events: {
    changed: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          message: { type: "string" },
          warning: { type: "boolean" },
        },
        required: ["sessionID", "message", "warning"],
        additionalProperties: false,
      },
    },
  },
} as const satisfies Rpc.PortableDefinition;

export type ChangedEvent = {
  sessionID: string;
  message: string;
  warning: boolean;
};
