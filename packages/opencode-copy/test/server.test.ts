import { afterEach, beforeEach, expect, test } from "vitest";
import { rank } from "../src/server.ts";
import { segmentKey } from "../src/segments.ts";
import { jevFetch } from "./harness.ts";

const input = {
  sessionID: "s",
  pieces: [
    { id: "S001", kind: "command", text: "git status" },
    { id: "S002", kind: "paragraph", text: "An explanation of what happened." },
  ],
  recent: ["show me the status"],
  pieceChars: 600,
  model: "jev-latest",
  timeoutMs: 1_000,
};

const key = process.env.TYPESAFE_API_KEY;
beforeEach(() => {
  process.env.TYPESAFE_API_KEY = "test";
});
afterEach(() => {
  if (key === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = key;
});

test("rank asks a want score per piece and copyable for prose, and keys the answers by content", async () => {
  const logs: string[] = [];
  const { fetch, requests } = jevFetch({
    "want::S001": { type: "score", score: 2.7, confidence: 0.9 },
    "want::S002": { type: "score", score: 0.4, confidence: 0.8 },
    "copyable::S002": { type: "noul", noul: 0.1 },
  });
  const out = await rank(input, { fetch, log: (m) => logs.push(m) });
  expect(out.ok).toBe(true);
  expect(out.judged).toEqual([
    { key: segmentKey({ id: "S001", kind: "command", text: "git status", turn: 0, order: 0 }), want: 2.7 },
    { key: segmentKey({ id: "S002", kind: "paragraph", text: "An explanation of what happened.", turn: 0, order: 1 }), want: 0.4, copyable: 0.1 },
  ]);
  const body = requests[0] as { model: string; state: { recent_user_messages: string[]; pieces: Record<string, { kind: string; text: string }> }; questions: Record<string, unknown> };
  expect(body.model).toBe("jev-latest");
  expect(body.state.recent_user_messages).toEqual(["show me the status"]);
  expect(body.state.pieces.S001).toEqual({ kind: "command", text: "git status" });
  expect(Object.keys(body.questions)).toEqual(["want::S001", "want::S002", "copyable::S002"]);
  expect(logs[0]).toMatch(/^s: ranked 2 pieces in \d+ ms/);
});

test("rank reports Jev failures instead of throwing, and nothing to rank is fine", async () => {
  delete process.env.TYPESAFE_API_KEY;
  const out = await rank(input);
  expect(out).toEqual({ ok: false, judged: [], reason: "TYPESAFE_API_KEY is not set" });
  expect(await rank({ ...input, pieces: [] })).toEqual({ ok: true, judged: [] });
});
