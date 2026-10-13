// opencode-marimo (TUI): the current notebook and what its kernel is running, to
// the right of the prompt; every followed notebook in the session sidebar; in herdr,
// a cell the agent started that outlives its turn (herdr.ts).
//
// Plain TypeScript rather than JSX, with Solid taken from opencode: see host.ts.

import type { TuiPlugin } from "@opencode-ai/plugin/tui";
import { KernelHold } from "./core/hold.js";
import { nodeIo } from "./core/node-io.js";
import { pairTargets } from "./core/touch.js";
import { MarimoWatcher } from "./core/watcher.js";
import { HerdrHold, herdrTarget } from "./herdr.js";
import { block, line, loadHost } from "./host.js";
import { modeFromEnv } from "./mode.js";
import { type Segment, segments, sidebarLines, type View, view } from "./status.js";

const tui: TuiPlugin = async (api) => {
  const host = await loadHost();
  const [current, setCurrent] = host.solid.createSignal<View>({});
  const [list, setList] = host.solid.createSignal<Segment[][] | undefined>(undefined);
  let ticker: ReturnType<typeof setInterval> | undefined;
  const watcher: MarimoWatcher = new MarimoWatcher({
    io: nodeIo(),
    cwd: api.state.path.directory || process.cwd(),
    token: process.env.MARIMO_TOKEN,
    onChange: () => update(),
  });
  // The TUI owns this pane, as herdr's own opencode integration has it: the hold lives here.
  const hold = new KernelHold();
  const herdr = new HerdrHold("opencode", herdrTarget());
  let inTurn = false;
  const update = (): void => {
    if (hold.active) void herdr.apply(hold.update(watcher.followed(), Date.now()));
    setCurrent(view(watcher));
    setList(sidebarLines(watcher));
    const running = watcher.connection === "connected" && watcher.notebook.running();
    if (running && !ticker) ticker = setInterval(update, 1000);
    if (!running && ticker) { clearInterval(ticker); ticker = undefined; }
  };
  watcher.mode = modeFromEnv();
  watcher.start();
  // The TUI runs apart from the server half, so it reads the agent's marimo-pair calls from the
  // session's tool parts to keep the same notebook current.
  const unsubscribe = api.event.on("message.part.updated", (event) => {
    const part = event.properties.part as { type?: string; state?: { status?: string; input?: unknown } };
    if (part.type !== "tool" || part.state?.status !== "running") return;
    const targets = pairTargets(JSON.stringify(part.state.input ?? {}));
    if (targets.length) watcher.touch(targets);
  });
  // A turn of the session shown in this pane: busy begins it, idle ends it.
  const shown = (sessionID: string): boolean => {
    const route = api.route.current as { name?: string; params?: { sessionID?: string } };
    return route.name === "session" && route.params?.sessionID === sessionID;
  };
  const turnEnded = (): void => {
    if (!inTurn) return;
    inTurn = false;
    void herdr.apply(hold.end(watcher.followed(), Date.now()));
  };
  const offStatus = api.event.on("session.status", (event) => {
    if (!shown(event.properties.sessionID)) return;
    if (event.properties.status.type === "idle") return turnEnded();
    if (inTurn) return;
    inTurn = true;
    void herdr.apply(hold.begin(Date.now()));
  });
  const offIdle = api.event.on("session.idle", (event) => {
    if (shown(event.properties.sessionID)) turnEnded();
  });
  api.lifecycle.onDispose(async () => {
    unsubscribe();
    offStatus();
    offIdle();
    await herdr.apply(hold.release());
    if (ticker) clearInterval(ticker);
    await watcher.stop();
  });
  const theme = () => api.theme.current;
  const status = () =>
    line(
      host,
      () => theme().textMuted,
      () => segments(current())?.map((s) => (s.color ? { text: s.text, color: theme()[s.color] } : { text: s.text })),
    );
  // The sidebar names every followed notebook; the prompt line has room only for the current one.
  const sidebar = () =>
    block(
      host,
      () => theme().textMuted,
      () => list()?.map((l) => l.map((s) => (s.color ? { text: s.text, color: theme()[s.color] } : { text: s.text }))),
    );
  api.slots.register({
    order: 300,
    slots: {
      home_prompt_right: status,
      session_prompt_right: status,
      sidebar_content: sidebar,
    },
  });
};

export default { id: "opencode-marimo-tui", tui };
