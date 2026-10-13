// A fake of what the core needs from OpenCode: a recorder for wake-ups, herdr tokens and change
// notices, and a tool-call context with an abort signal.
import type { Call, Host } from "../src/core.ts";

export function fakeHost() {
  const wakes: { sessionID: string; text: string }[] = [];
  const tokens: { sessionID: string; value: string | undefined }[] = [];
  const changed: string[] = [];
  const logs: string[] = [];
  const host: Host = {
    wake: async (sessionID, text) => void wakes.push({ sessionID, text }),
    token: (sessionID, value) => void tokens.push({ sessionID, value }),
    changed: (sessionID) => void changed.push(sessionID),
    log: (m) => void logs.push(m),
  };
  return { host, wakes, tokens, changed, logs };
}

export function call(sessionID: string, cwd: string): Call & { abort: AbortController; progress: (title: string) => void; titles: string[] } {
  const abort = new AbortController();
  const titles: string[] = [];
  return { sessionID, cwd, signal: abort.signal, progress: (t) => void titles.push(t), abort, titles };
}

export async function until(cond: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting for a condition");
    await new Promise((r) => setTimeout(r, 20));
  }
}
