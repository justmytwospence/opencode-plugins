// opencode-herdr (terminal): what this herdr pane says about the session it shows, and what the
// server half asks it to do for that session's family. The port of pi-herdr's pane side.
//
// This half runs in the terminal process, so it has the pane (HERDR_PANE_ID, the herdr socket)
// and knows which session the terminal shows (`ui.router.current()`; the family through
// `data.session.root`). It never draws in OpenCode; it reports to herdr:
//
// - The pane's title and the token `task`: the session's title. The displayed agent name:
//   `opencode opus-5-5:high` (the prompt's model and variant). Both apply only while herdr's own
//   OpenCode integration holds the pane.
// - Pane tokens, notifications and zoom for the shown family, from the `herdr` RPC's events
//   (other components' calls, and the server half's own `bg` for pending children); the tokens are
//   fetched (`state`) when the pane starts showing a session.
// - `attach` (src/rpc.ts): tells the server half which root session this pane shows, so
//   `herdr_child` can find it; resent on the server's `ready` and periodically.
// - The space token `pr`: the branch's pull request from `gh pr view`, checked at start, when a
//   turn ends, and every 3 minutes. `PI_HERDR_PR=0` turns it off.
//
// Herdr's own OpenCode integration owns the pane's working/blocked/idle state (pending permissions
// and question forms included), so nothing here reports state.
import { Plugin } from "@opencode/plugin/tui";
import { Bridge } from "./bridge.ts";
import { type Call, type HerdrTarget, MAX_TTL_MS, herdrTarget, socketCall } from "./core/herdr.ts";
import { PR_FIELDS, parsePrView, prToken } from "./core/pr.ts";
import { PaneReporter, WorkspaceReporter } from "./core/report.ts";
import { shortModel } from "./core/text.ts";
import { exec as runExec } from "./exec.ts";
import type { Exec } from "./core/children.ts";
import { HerdrRpc, type HerdrNotify, type HerdrToken, type HerdrZoom } from "./herdr-rpc.ts";
import { HerdrPaneRpc } from "./rpc.ts";

const SOURCE = "opencode-herdr:tui";
const TICK_MS = 2_000;
const ATTACH_MS = 30_000;
const PR_TTL_MS = 10 * 60_000;
const PR_POLL_MS = 3 * 60_000;

export interface ModelLike {
  id?: string;
  modelID?: string;
  variant?: string;
}

/** `opencode opus-5-5:high` from a model and variant; `opencode` without one. */
export function displayAgent(model: ModelLike | undefined): string {
  const name = shortModel(model?.modelID ?? model?.id);
  if (!name) return "opencode";
  return model?.variant ? `opencode ${name}:${model.variant}` : `opencode ${name}`;
}

/** The model of the latest message that names one (assistant replies, model switches). */
export function lastModel(messages: readonly { model?: ModelLike }[]): ModelLike | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]?.model;
    if (m?.id || m?.modelID) return m;
  }
  return undefined;
}

/** The session's title, unless it is still OpenCode's placeholder. */
export function sessionTitle(title: string | undefined): string | undefined {
  if (!title?.trim() || /^(New session|Untitled)\b/iu.test(title.trim())) return undefined;
  return title.trim();
}

/** Tokens of the shown family by key: one value per key, several sessions' values joined. */
export class TokenView {
  private readonly byKey = new Map<string, Map<string, HerdrToken>>();

  set(t: HerdrToken): void {
    let m = this.byKey.get(t.key);
    if (!m) this.byKey.set(t.key, (m = new Map()));
    if (t.value?.trim()) m.set(t.sessionID, t);
    else m.delete(t.sessionID);
    if (!m.size) this.byKey.delete(t.key);
  }

  value(key: string): string | undefined {
    const m = this.byKey.get(key);
    if (!m?.size) return undefined;
    return [...new Set([...m.values()].map((t) => t.value!.trim()))].join(" · ");
  }

  ttl(key: string): number {
    const m = this.byKey.get(key);
    let ttl = MAX_TTL_MS;
    for (const t of m?.values() ?? []) if (t.ttlMs !== undefined) ttl = Math.min(ttl, t.ttlMs);
    return ttl;
  }

  keys(): string[] {
    return [...this.byKey.keys()];
  }

  clear(): void {
    this.byKey.clear();
  }
}

/** What the pane view needs from OpenCode, so tests can fake it. */
export interface TuiHost {
  /** The session the terminal shows. */
  shown(): string | undefined;
  root(sessionID: string): string;
  family(rootID: string): string[];
  title(sessionID: string): string | undefined;
  directory(sessionID: string): string | undefined;
  model(sessionID: string): ModelLike | undefined;
  attach(input: { sessionID: string; paneId: string; socketPath: string }): Promise<void>;
  detach(input: { sessionID: string; paneId: string }): Promise<void>;
  state(sessionID: string): Promise<HerdrToken[]>;
  exec: Exec;
  prEnabled?: boolean;
}

export interface PaneView {
  /** Reconcile the pane with the shown session (title, agent, attachment). */
  tick(): Promise<void>;
  token(t: HerdrToken): void;
  notify(n: HerdrNotify): Promise<void>;
  zoom(z: HerdrZoom): Promise<void>;
  /** The server half (re)started: attach again and reload the tokens. */
  ready(): Promise<void>;
  /** A turn of the shown family ended. */
  turnEnded(sessionID: string): void;
  refreshPr(): Promise<void>;
  /** Re-send tokens that near their TTL, and the attachment. */
  keepalive(): Promise<void>;
  readonly shownRoot: string | undefined;
  dispose(): Promise<void>;
}

export function createPaneView(target: HerdrTarget, call: Call, host: TuiHost, schedule: (fn: () => void, ms: number) => void = (fn, ms) => void setTimeout(fn, ms).unref?.()): PaneView {
  const pane = new PaneReporter(call, target.paneId, "opencode", SOURCE);
  const bridge = new Bridge(call, pane);
  const tokens = new TokenView();
  let workspace: WorkspaceReporter | undefined;
  let prEnabled = host.prEnabled ?? process.env.PI_HERDR_PR !== "0";
  let shownRoot: string | undefined;
  let generation = 0;

  const inFamily = (sessionID: string) => shownRoot !== undefined && host.root(sessionID) === shownRoot;
  const applyToken = (t: HerdrToken) => {
    tokens.set(t);
    void pane.setToken(t.key, tokens.value(t.key), tokens.ttl(t.key));
  };
  const attach = async () => {
    if (!shownRoot) return;
    await host.attach({ sessionID: shownRoot, paneId: target.paneId, socketPath: target.socketPath }).catch(() => undefined);
  };
  const loadState = async () => {
    const root = shownRoot;
    if (!root) return;
    const epoch = generation;
    const members = [...new Set([root, ...host.family(root)])];
    const lists = await Promise.all(members.map((m) => host.state(m).catch(() => [] as HerdrToken[])));
    if (epoch !== generation) return;
    for (const list of lists) for (const t of list) applyToken(t);
  };
  const clearFamilyTokens = () => {
    const keys = tokens.keys();
    tokens.clear();
    for (const key of keys) void pane.setToken(key, undefined);
  };

  const switchTo = async (root: string | undefined) => {
    const previous = shownRoot;
    generation++;
    shownRoot = root;
    if (previous) void host.detach({ sessionID: previous, paneId: target.paneId }).catch(() => undefined);
    clearFamilyTokens();
    await bridge.reset();
    if (!root) return;
    await attach();
    await loadState();
  };

  const refreshPr = async () => {
    if (!prEnabled) return;
    const sid = host.shown();
    const directory = sid ? host.directory(sid) : undefined;
    if (!directory) return;
    if (!workspace) {
      const self = await call("pane.get", { pane_id: target.paneId });
      const id: string | undefined = self.result?.pane?.workspace_id;
      if (!id) return;
      workspace = new WorkspaceReporter(call, id, SOURCE);
    }
    const r = await host.exec("gh", ["pr", "view", "--json", PR_FIELDS], directory);
    if (r.code === 127) {
      prEnabled = false;
      return;
    }
    if (r.code === 0) return void workspace.setToken("pr", prToken(parsePrView(r.stdout)), PR_TTL_MS);
    // No PR for this branch (or not a GitHub repo): clear. Other failures (network) keep the last.
    if (/no pull requests found|not a git repository|no git remotes|none of the git remotes/iu.test(r.stderr)) void workspace.setToken("pr", undefined);
  };

  return {
    get shownRoot() {
      return shownRoot;
    },
    async tick() {
      const sid = host.shown();
      const root = sid ? host.root(sid) : undefined;
      if (root !== shownRoot) await switchTo(root);
      if (!sid) {
        void pane.setPresentation(undefined, "opencode");
        void pane.setToken("task", undefined);
        return;
      }
      const title = sessionTitle(host.title(sid));
      void pane.setPresentation(title, displayAgent(host.model(sid)));
      void pane.setToken("task", title);
    },
    token(t) {
      if (inFamily(t.sessionID)) applyToken(t);
    },
    async notify(n) {
      if (inFamily(n.sessionID)) await bridge.notify(n);
    },
    async zoom(z) {
      if (inFamily(z.sessionID)) await bridge.zoom(`${z.sessionID}:${z.holder}`, z.active);
    },
    async ready() {
      if (!shownRoot) return;
      clearFamilyTokens();
      await attach();
      await loadState();
    },
    turnEnded(sessionID) {
      if (inFamily(sessionID)) schedule(() => void refreshPr(), 5_000);
    },
    refreshPr,
    async keepalive() {
      await attach();
      await pane.refresh();
      await workspace?.refresh();
    },
    async dispose() {
      const root = shownRoot;
      shownRoot = undefined;
      generation++;
      if (root) await host.detach({ sessionID: root, paneId: target.paneId }).catch(() => undefined);
      await bridge.reset();
      await pane.clearAll();
      await workspace?.clearTokens();
    },
  };
}

export default Plugin.define({
  id: "herdr.tui",
  setup(context) {
    const target = herdrTarget();
    if (!target) return;
    const call = socketCall(target.socketPath);
    const herdr = context.client.rpc(HerdrRpc);
    const panes = context.client.rpc(HerdrPaneRpc);
    const host: TuiHost = {
      shown: () => {
        const route = context.ui.router.current();
        return route.type === "session" ? route.sessionID : undefined;
      },
      root: (id) => context.data.session.root(id),
      family: (root) => context.data.session.family(root),
      title: (id) => context.data.session.get(id)?.title,
      directory: (id) => context.data.session.get(id)?.location?.directory ?? context.location?.directory ?? context.data.location.default().directory,
      model: (id) => context.ui.model.current() ?? lastModel(context.data.session.message.list(id) as { model?: ModelLike }[]),
      attach: async (input) => {
        await panes.attach(input);
      },
      detach: async (input) => {
        await panes.detach(input);
      },
      state: async (sessionID) => ((await herdr.state({ sessionID })) as { tokens: HerdrToken[] }).tokens,
      exec: runExec,
    };
    const view = createPaneView(target, call, host);

    const offs = [
      herdr.events.on("token", (e) => view.token(e.data as unknown as HerdrToken)),
      herdr.events.on("notify", (e) => void view.notify(e.data as unknown as HerdrNotify)),
      herdr.events.on("zoom", (e) => void view.zoom(e.data as unknown as HerdrZoom)),
      herdr.events.on("ready", () => void view.ready()),
      context.data.on("session.execution.succeeded", (e) => view.turnEnded(e.data.sessionID)),
      context.data.on("session.execution.failed", (e) => view.turnEnded(e.data.sessionID)),
      context.data.on("session.renamed", () => void view.tick()),
    ];
    void view.tick();
    const ticker = setInterval(() => void view.tick(), TICK_MS);
    const keepalive = setInterval(() => void view.keepalive(), ATTACH_MS);
    const prTimer = setInterval(() => void view.refreshPr(), PR_POLL_MS);
    const prSoon = setTimeout(() => void view.refreshPr(), 2_000);
    for (const t of [ticker, keepalive, prTimer, prSoon]) t.unref?.();

    return () => {
      clearInterval(ticker);
      clearInterval(keepalive);
      clearInterval(prTimer);
      clearTimeout(prSoon);
      for (const off of offs) off();
      return view.dispose();
    };
  },
});
