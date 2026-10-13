// The next-prompt RPC: the terminal half, which reads the suggestion out of a finished answer,
// asks the server half (where TYPESAFE_API_KEY lives and one verdict serves every terminal) to
// vet it with Jev before showing it.
import type { Rpc } from "@opencode/plugin/rpc";

export const NextPromptRpc = {
  id: "next-prompt",
  methods: {
    vet: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          messageID: { type: "string" },
          suggestion: { type: "string" },
          userPrompt: { type: "string" },
          assistantTail: { type: "string" },
        },
        required: ["sessionID", "messageID", "suggestion", "userPrompt", "assistantTail"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          show: { type: "boolean" },
          reason: { type: "string" },
        },
        required: ["show", "reason"],
        additionalProperties: false,
      },
    },
  },
  events: {},
} as const satisfies Rpc.PortableDefinition;

export interface Candidate {
  sessionID: string;
  messageID: string;
  suggestion: string;
  userPrompt: string;
  assistantTail: string;
}

export interface Verdict {
  show: boolean;
  reason: string;
}
