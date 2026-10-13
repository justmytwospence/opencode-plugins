// A fake marimo server behind the core's Io (registry, session list, kiosk SSE streams fed from
// the recorded fixture), a recorder for the herdr port, and a Marimo built on both.
import { readFileSync } from "node:fs";
import type { Cancellable, Io, StreamEnd } from "../src/core/io.ts";
import type { HerdrPort } from "../src/herdr.ts";
import { Marimo, type MarimoOptions } from "../src/server.ts";

export const SERVER = "http://127.0.0.1:2799";

/** The fixture's SSE events, in order; event 57 (1-based) is `lEQa` starting to run. */
export const EVENTS = readFileSync(new URL("./fixtures/kiosk-run.sse", import.meta.url), "utf8").split("\n\n").filter((e) => e.trim());
export const RUNNING_AT = 57;

interface Stream {
  file: string;
  onText: (text: string) => void;
}

export class FakeMarimo {
  /** Open notebook sessions on the server: session id to path. */
  readonly sessions = new Map<string, string>();
  /** What a new stream of each path receives on connect. */
  readonly replay = new Map<string, string[]>();
  private readonly streams = new Set<Stream>();
  readonly io: Io;

  constructor() {
    this.io = {
      registryEntries: async () => (this.sessions.size ? [{ host: "127.0.0.1", port: 2799, pid: process.pid }] : []),
      getJson: async (url) => {
        if (!url.startsWith(`${SERVER}/api/sessions`)) return undefined;
        return Object.fromEntries([...this.sessions].map(([id, path]) => [id, { path }]));
      },
      stream: (url, _headers, onText): Cancellable<StreamEnd> => {
        const params = new URLSearchParams(url.slice(url.indexOf("?") + 1));
        const file = params.get("file") ?? this.sessions.get(params.get("session_id") ?? "") ?? "";
        const stream: Stream = { file, onText };
        let finish: (end: StreamEnd) => void = () => {};
        const done = new Promise<StreamEnd>((resolve) => {
          finish = resolve;
        });
        if (!this.sessions.has(params.get("session_id") ?? "") && ![...this.sessions.values()].includes(file)) {
          finish({ ok: false, status: 404 });
          return { done, cancel: () => {} };
        }
        this.streams.add(stream);
        queueMicrotask(() => {
          for (const text of this.replay.get(file) ?? []) onText(`${text}\n\n`);
        });
        return {
          done,
          cancel: () => {
            this.streams.delete(stream);
            finish({ ok: true });
          },
        };
      },
      realpath: async (path) => path,
      sleep: (ms): Cancellable<void> => {
        let cancel = (): void => {};
        const done = new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, ms);
          cancel = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        return { done, cancel };
      },
    };
  }

  /** Open a notebook (as a browser would), replaying the fixture's first `upTo` events on connect. */
  open(sessionId: string, path: string, upTo = EVENTS.length): void {
    this.sessions.set(sessionId, path);
    this.replay.set(path, EVENTS.slice(0, upTo));
  }

  close(sessionId: string): void {
    const path = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    for (const s of this.streams) if (s.file === path) this.streams.delete(s);
  }

  /** Send more of the fixture (events `from` to `to`, 0-based) to every stream of the notebook. */
  send(path: string, from: number, to = EVENTS.length): void {
    const chunk = EVENTS.slice(from, to).map((e) => `${e}\n\n`).join("");
    this.replay.set(path, [...(this.replay.get(path) ?? []), ...EVENTS.slice(from, to)]);
    for (const s of this.streams) if (s.file === path) s.onText(chunk);
  }
}

export function herdrRecorder() {
  const calls: Array<["token", string, string | undefined] | ["notify", string, string, string]> = [];
  const port: HerdrPort = {
    token: async (sessionID, value) => void calls.push(["token", sessionID, value]),
    notify: async (sessionID, title, body) => void calls.push(["notify", sessionID, title, body]),
  };
  return { port, calls };
}

export function marimo(fake: FakeMarimo, options: Partial<MarimoOptions> = {}) {
  const herdr = herdrRecorder();
  let changes = 0;
  const m = new Marimo({
    watcher: { io: fake.io, cwd: "/w", pollMs: 50 },
    herdr: herdr.port,
    changed: () => changes++,
    debounceMs: 0,
    ...options,
  });
  return { marimo: m, herdr, changes: () => changes };
}

export async function until(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}
