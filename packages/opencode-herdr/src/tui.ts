// opencode-herdr (TUI): what the pane says about the session on screen, and the space's PR.
//
// - The pane's title and the token `task`: the session's title (opencode writes one after the
//   first exchange). The displayed agent name: `opencode opus-5-5:high` (model and variant of the
//   latest message). Both apply only while herdr's opencode integration holds the pane.
// - The space token `pr`: the branch's pull request from `gh pr view` ("#123 ✓ approved"),
//   checked at start, when a turn ends, and every 3 minutes.
//
// The TUI knows which session this pane shows; the server half (src/server.ts) has the tool and
// the `bg` token. The port of pi-herdr; src/core is shared with it verbatim.
import type { TuiPlugin } from "@opencode-ai/plugin/tui";
import { herdrTarget, socketCall } from "./core/herdr.ts";
import { PR_FIELDS, parsePrView, prToken } from "./core/pr.ts";
import { PaneReporter, WorkspaceReporter } from "./core/report.ts";
import { shortModel } from "./core/text.ts";
import { exec } from "./exec.ts";

const SOURCE = "opencode-herdr:tui";
const PR_TTL_MS = 10 * 60_000;
const PR_POLL_MS = 3 * 60_000;

interface MessageInfo {
  role?: string;
  modelID?: string;
  providerID?: string;
  variant?: string;
  model?: { providerID?: string; modelID?: string; variant?: string };
}

/** `opencode opus-5-5:high` from the session's latest message that names a model. */
export function displayAgent(messages: readonly MessageInfo[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const model = shortModel(m?.modelID ?? m?.model?.modelID);
    if (!model) continue;
    const variant = m?.variant ?? m?.model?.variant;
    return variant ? `opencode ${model}:${variant}` : `opencode ${model}`;
  }
  return "opencode";
}

/** The session's title, unless it is still opencode's placeholder. */
export function sessionTitle(title: string | undefined): string | undefined {
  if (!title?.trim() || /^New session - /u.test(title)) return undefined;
  return title.trim();
}

const tui: TuiPlugin = async (api) => {
  const target = herdrTarget();
  if (!target) return;
  const call = socketCall(target.socketPath);
  const pane = new PaneReporter(call, target.paneId, "opencode", SOURCE);
  const directory = (api.state as any).path?.directory || process.cwd();
  let workspace: WorkspaceReporter | undefined;
  let prEnabled = process.env.PI_HERDR_PR !== "0";
  let wasBusy = false;
  let prSoon: ReturnType<typeof setTimeout> | undefined;

  const shownSession = (): string | undefined => {
    const route = api.route.current as { name?: string; params?: { sessionID?: string } };
    return route?.name === "session" && route.params?.sessionID ? String(route.params.sessionID) : undefined;
  };

  const refreshPr = async () => {
    if (!prEnabled) return;
    if (!workspace) {
      const self = await call("pane.get", { pane_id: target.paneId });
      const id: string | undefined = self.result?.pane?.workspace_id;
      if (!id) return;
      workspace = new WorkspaceReporter(call, id, SOURCE);
    }
    const r = await exec("gh", ["pr", "view", "--json", PR_FIELDS], directory);
    if (r.code === 127) {
      prEnabled = false;
      return;
    }
    if (r.code === 0) return void workspace.setToken("pr", prToken(parsePrView(r.stdout)), PR_TTL_MS);
    if (/no pull requests found|not a git repository|no git remotes|none of the git remotes/iu.test(r.stderr)) void workspace.setToken("pr", undefined);
  };
  const schedulePr = (ms: number) => {
    if (!prEnabled) return;
    if (prSoon) clearTimeout(prSoon);
    prSoon = setTimeout(() => void refreshPr(), ms);
    prSoon.unref?.();
  };

  const tick = () => {
    const sid = shownSession();
    if (!sid) {
      void pane.setPresentation(undefined, "opencode");
      void pane.setToken("task", undefined);
      return;
    }
    const state = api.state.session as any;
    const title = sessionTitle(state.get(sid)?.title);
    void pane.setPresentation(title, displayAgent((state.messages(sid) ?? []) as MessageInfo[]));
    void pane.setToken("task", title);
    const status = state.status(sid);
    const busy = !!status && (typeof status === "string" ? status : status.type) !== "idle";
    if (wasBusy && !busy) schedulePr(5_000);
    wasBusy = busy;
  };

  tick();
  schedulePr(2_000);
  const ticker = setInterval(() => {
    tick();
    void pane.refresh();
    void workspace?.refresh();
  }, 2_000);
  const prTimer = setInterval(() => void refreshPr(), PR_POLL_MS);
  ticker.unref?.();
  prTimer.unref?.();

  api.lifecycle.onDispose(async () => {
    clearInterval(ticker);
    clearInterval(prTimer);
    if (prSoon) clearTimeout(prSoon);
    await pane.clearAll();
    await workspace?.clearTokens();
  });
};

export default { id: "opencode-herdr-tui", tui };
