// What the CLI half does to its pane for `notify` and `zoom` events of the `herdr` RPC: the part
// of pi-herdr's event-bus bridge that concerns a pane (tokens go through PaneReporter). Zoom is
// held per holder: the pane zooms while any holder is active and unzooms when the last lets go,
// only if the bridge zoomed it.
import type { Call } from "./core/herdr.ts";
import type { PaneReporter } from "./core/report.ts";

export interface NotifyEvent {
  title: string;
  body?: string;
  sound?: "none" | "done" | "request";
  /** Skip the notification while this pane is focused. */
  unlessFocused?: boolean;
}

export class Bridge {
  private readonly holders = new Set<string>();
  /** Whether the bridge zoomed the pane (and so should unzoom it). */
  private zoomedByUs = false;
  private chain: Promise<unknown> = Promise.resolve();

  private readonly call: Call;
  private readonly pane: PaneReporter;

  constructor(call: Call, pane: PaneReporter) {
    this.call = call;
    this.pane = pane;
  }

  async notify(e: NotifyEvent | undefined): Promise<void> {
    if (!e?.title) return;
    if (e.unlessFocused) {
      const pane = await this.call("pane.get", { pane_id: this.pane.paneId });
      if (pane.result?.pane?.focused === true) return;
    }
    await this.call("notification.show", { title: e.title, body: e.body, sound: e.sound ?? "none" });
  }

  zoom(holder: string, active: boolean): Promise<unknown> {
    this.chain = this.chain.then(async () => {
      const had = this.holders.size > 0;
      if (active) this.holders.add(holder);
      else this.holders.delete(holder);
      const has = this.holders.size > 0;
      if (has && !had) {
        const l = await this.call("pane.layout", { pane_id: this.pane.paneId });
        if (l.result?.layout?.zoomed !== false) return;
        const r = await this.call("pane.zoom", { pane_id: this.pane.paneId, mode: "on" });
        this.zoomedByUs = !r.error;
      } else if (!has && had && this.zoomedByUs) {
        this.zoomedByUs = false;
        await this.call("pane.zoom", { pane_id: this.pane.paneId, mode: "off" });
      }
    });
    return this.chain;
  }

  /** Drop every hold (the pane shows another session, or the plugin ends); unzooms if the bridge zoomed. */
  async reset(): Promise<void> {
    await this.chain;
    if (this.zoomedByUs) await this.call("pane.zoom", { pane_id: this.pane.paneId, mode: "off" });
    this.holders.clear();
    this.zoomedByUs = false;
  }
}
