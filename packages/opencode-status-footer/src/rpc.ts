// The status-footer RPC: the server half reads subscription windows from provider responses
// (one shared server sees every session's responses) and serves them to the terminals.
import type { Rpc } from "@opencode/plugin/rpc";

const windowSchema = {
  type: "object",
  properties: {
    label: { type: "string" },
    used: { type: "number" },
    resetsAt: { type: "number" },
    at: { type: "number" },
  },
  required: ["label", "used", "at"],
  additionalProperties: false,
} as const;

const quotaSchema = {
  type: "object",
  properties: {
    accounts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          source: { type: "string" },
          windows: { type: "array", items: windowSchema },
        },
        required: ["name", "source", "windows"],
        additionalProperties: false,
      },
    },
  },
  required: ["accounts"],
  additionalProperties: false,
} as const;

export const StatusFooterRpc = {
  id: "status-footer",
  methods: {
    quota: { input: { type: "object", properties: {}, additionalProperties: false }, output: quotaSchema },
  },
  events: {
    quota: { schema: quotaSchema },
  },
} as const satisfies Rpc.PortableDefinition;

export type QuotaWindow = { label: string; used: number; resetsAt?: number; at: number };
export type Account = { name: string; source: string; windows: QuotaWindow[] };
export type Quota = { accounts: Account[] };
