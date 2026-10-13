// Shows the kernel hold (core/hold.ts) in herdr for the pane this process runs in. Node-only,
// opencode-marimo only (pi-marimo goes through pi-herdr's event bus; claude-marimo through the `herdr` CLI).
// Outside herdr (no HERDR_ENV / socket / pane) it does nothing.
//
// herdr's pi and opencode integrations are the sole authority over the pane's idle/working state,
// so this never reports state: while the kernel holds it sets the pane token `marimo` (`$marimo` in
// a sidebar row), and when the run ends it clears the token and shows a notification with the done
// sound, unless the pane is focused. herdr protocol: one JSON line `{ id, method, params }` on the
// Unix socket at $HERDR_SOCKET_PATH, answered by one JSON line.
import net from "node:net";

import { HERDR_SOURCE, HERDR_TOKEN, type HoldChange } from "./core/hold.js";

/** A day, herdr's ceiling: a token outlives a crashed agent by at most this long. */
const TTL_MS = 86_400_000;

export interface HerdrTarget {
  socketPath: string;
  paneId: string;
}

export function herdrTarget(env: NodeJS.ProcessEnv = process.env): HerdrTarget | undefined {
  if (env.HERDR_ENV !== "1" || !env.HERDR_SOCKET_PATH || !env.HERDR_PANE_ID) return undefined;
  return { socketPath: env.HERDR_SOCKET_PATH, paneId: env.HERDR_PANE_ID };
}

let counter = 0;

/** Sends one request; resolves to the parsed reply, or undefined on error or after 1 s. Never throws. */
export function sendHerdr(target: HerdrTarget, method: string, params: Record<string, unknown>): Promise<any> {
  const id = `${HERDR_SOURCE}:${Date.now()}:${counter++}`;
  return new Promise((resolve) => {
    let done = false;
    let buffer = "";
    const finish = (reply: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(reply);
    };
    const socket = net.createConnection(process.platform === "win32" ? `\\\\.\\pipe\\${target.socketPath}` : target.socketPath);
    const timer = setTimeout(() => finish(undefined), 1000);
    timer.unref?.();
    socket.on("error", () => finish(undefined));
    socket.on("connect", () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      try {
        finish(JSON.parse(buffer.slice(0, end)));
      } catch {
        finish(undefined);
      }
    });
    socket.on("end", () => finish(undefined));
  });
}

/** Turns hold changes into herdr reports, in order. */
export class HerdrHold {
  private chain: Promise<unknown> = Promise.resolve();
  private reported = false;
  private readonly agent: string;
  private readonly target: HerdrTarget | undefined;
  private readonly send: typeof sendHerdr;

  constructor(agent: string, target: HerdrTarget | undefined, send: typeof sendHerdr = sendHerdr) {
    this.agent = agent;
    this.target = target;
    this.send = send;
  }

  apply(change: HoldChange): Promise<unknown> {
    const target = this.target;
    if (!target || change.kind === "none") return this.chain;
    this.chain = this.chain.then(async () => {
      if (change.kind === "held") {
        this.reported = true;
        await this.token(target, change.value);
        return;
      }
      if (this.reported) await this.token(target, undefined);
      this.reported = false;
      if (change.kind !== "finished") return;
      const pane = await this.send(target, "pane.get", { pane_id: target.paneId });
      if (pane?.result?.pane?.focused === true) return;
      await this.send(target, "notification.show", { title: change.title, body: change.body, sound: "done" });
    });
    return this.chain;
  }

  private token(target: HerdrTarget, value: string | undefined): Promise<unknown> {
    return this.send(target, "pane.report_metadata", {
      pane_id: target.paneId,
      source: HERDR_SOURCE,
      agent: this.agent,
      tokens: { [HERDR_TOKEN]: value ?? null },
      ...(value === undefined ? {} : { ttl_ms: TTL_MS }),
    });
  }
}
