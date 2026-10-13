// The copy RPC: the terminal half asks the server half to rank candidate pieces with Jev. The
// server half runs in OpenCode's background service, whose environment holds TYPESAFE_API_KEY;
// it builds the questions (rank.ts), asks Jev and returns one judgment per piece, keyed by the
// piece's content hash (segmentKey) so the terminal can cache it for the session.
import type { Rpc } from "@opencode/plugin/rpc";

const pieceSchema = {
  type: "object",
  properties: {
    id: { type: "string", minLength: 1 },
    kind: { type: "string", minLength: 1 },
    lang: { type: "string" },
    text: { type: "string" },
  },
  required: ["id", "kind", "text"],
  additionalProperties: false,
} as const;

const judgedSchema = {
  type: "object",
  properties: {
    key: { type: "string" },
    want: { type: "number" },
    copyable: { type: "number" },
  },
  required: ["key", "want"],
  additionalProperties: false,
} as const;

export const CopyRpc = {
  id: "copy",
  methods: {
    rank: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string", minLength: 1 },
          pieces: { type: "array", items: pieceSchema },
          recent: { type: "array", items: { type: "string" } },
          pieceChars: { type: "number", minimum: 1 },
          model: { type: "string", minLength: 1 },
          timeoutMs: { type: "number", minimum: 1 },
        },
        required: ["sessionID", "pieces", "recent", "pieceChars", "model", "timeoutMs"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          judged: { type: "array", items: judgedSchema },
          reason: { type: "string" },
          latencyMs: { type: "number" },
        },
        required: ["ok", "judged"],
        additionalProperties: false,
      },
    },
  },
  events: {},
} as const satisfies Rpc.PortableDefinition;

export type RankPiece = { id: string; kind: string; lang?: string; text: string };
export type RankInput = { sessionID: string; pieces: RankPiece[]; recent: string[]; pieceChars: number; model: string; timeoutMs: number };
export type RankJudged = { key: string; want: number; copyable?: number };
export type RankOutput = { ok: boolean; judged: RankJudged[]; reason?: string; latencyMs?: number };
