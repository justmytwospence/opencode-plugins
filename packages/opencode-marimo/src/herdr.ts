// Shows the kernel hold (core/hold.ts) in herdr through opencode-herdr's `herdr` RPC, per
// session: while the kernel holds, the pane token `marimo` (`$marimo` in a sidebar row) says what
// runs; when the run ends the token is cleared and a notification with the done sound says it
// finished, unless the pane is focused. opencode-herdr's CLI half applies both to the pane showing
// the session; without it the calls fail and are ignored. The role pi-herdr's event bus plays for
// pi-marimo.
//
// herdr's opencode integration is the sole authority over the pane's idle/working state, so this
// never reports state.
import { HERDR_TOKEN, type HoldChange } from "./core/hold.ts";

/** A day, herdr's ceiling: a token outlives a crashed agent by at most this long. */
export const TTL_MS = 86_400_000;

/** The two `herdr` RPC calls used, already bound to a session. Failures are the port's to swallow. */
export interface HerdrPort {
  token(sessionID: string, value: string | undefined): Promise<void>;
  notify(sessionID: string, title: string, body: string): Promise<void>;
}

/** Turns a session's hold changes into herdr reports, in order. */
export class HerdrHold {
  private chain: Promise<unknown> = Promise.resolve();
  /** The token value reported for each session with an active hold. */
  private readonly values = new Map<string, string>();

  constructor(private readonly port: HerdrPort) {}

  apply(sessionID: string, change: HoldChange): Promise<unknown> {
    if (change.kind === "none") return this.chain;
    this.chain = this.chain.then(async () => {
      if (change.kind === "held") {
        this.values.set(sessionID, change.value);
        await this.port.token(sessionID, change.value);
        return;
      }
      if (this.values.delete(sessionID)) await this.port.token(sessionID, undefined);
      if (change.kind === "finished") await this.port.notify(sessionID, change.title, change.body);
    });
    return this.chain;
  }

  /** opencode-herdr became ready during a hold: send the tokens again. */
  resend(): Promise<unknown> {
    this.chain = this.chain.then(async () => {
      for (const [sessionID, value] of this.values) await this.port.token(sessionID, value);
    });
    return this.chain;
  }
}
