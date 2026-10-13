// opencode-status-footer (terminal): the compact Git marks right after the footer's own
// `dir:branch` (`* ↑1 ↓3 !`; see git.ts), and the Claude and Codex subscription windows in the
// session sidebar under OpenCode's context and cost (`Claude 5h 42% 2h13m`). OpenCode already
// shows the directory, branch, context and cost, so this adds only what it lacks.
//
// Plain TypeScript with jsx() rather than JSX: see AGENTS.md.
import { Plugin } from "@opencode/plugin/tui";
import { For, Show, createSignal } from "solid-js";
import { jsx } from "@opentui/solid/jsx-runtime";
import { type GitStatus, readStatus, sameStatus, segments } from "./git.ts";
import { formatWindow, fresh, severity } from "./quota.ts";
import { type Quota, StatusFooterRpc } from "./rpc.ts";

/** Re-read Git at most this often while nothing prompts it; a turn ending reads at once. */
const POLL_MS = 3000;

/** The Git marks without the branch, which OpenCode's footer already shows. */
export function marks(status: GitStatus | undefined) {
  const all = segments(status);
  if (!all || !status?.branch) return all; // undefined, or `!` alone when Git is unreadable.
  const rest = all.slice(2); // the branch and the space after it
  return rest.length ? rest : undefined;
}

export default Plugin.define({
  id: "status-footer.tui",
  setup(context) {
    /** A theme color for a segment's color name: the text color, muted, or a feedback color. */
    const color = (name: string | undefined) => {
      const t = context.theme;
      if (name === "error" || name === "warning" || name === "success") return t.text.feedback[name].base;
      if (name === "textMuted") return t.text.muted;
      return t.text.base;
    };

    // Git, for the directory the terminal is showing.
    const [git, setGit] = createSignal<GitStatus | undefined>(undefined);
    const directory = () => {
      const route = context.ui.router.current();
      if (route.type === "session") {
        const dir = context.data.session.get(route.sessionID)?.location?.directory;
        if (dir) return dir;
      }
      return (context.location ?? context.data.location.default()).directory;
    };
    let busy = false;
    let again = false;
    const refresh = async (): Promise<void> => {
      if (busy) {
        again = true;
        return;
      }
      busy = true;
      try {
        const next = await readStatus(directory());
        if (!sameStatus(next, git())) setGit(next);
      } catch {
        // Keep the last reading.
      } finally {
        busy = false;
        if (again) {
          again = false;
          void refresh();
        }
      }
    };
    void refresh();
    const ticker = setInterval(() => void refresh(), POLL_MS);
    const offDone = context.data.on("session.execution.succeeded", () => void refresh());
    const offFailed = context.data.on("session.execution.failed", () => void refresh());

    // Subscription windows, from the server half.
    const [quota, setQuota] = createSignal<Quota>({ accounts: [] });
    const [now, setNow] = createSignal(Date.now());
    const clock = setInterval(() => setNow(Date.now()), 30_000);
    const rpc = context.client.rpc(StatusFooterRpc);
    const load = () =>
      rpc
        .quota({})
        .then((q) => {
          setQuota(q as unknown as Quota);
        })
        .catch(() => undefined);
    void load();
    const offQuota = rpc.events.on("quota", (event) => {
      setQuota(event.data as unknown as Quota);
    });
    // The cache file can change without a response passing through this server.
    const reload = setInterval(() => void load(), 60_000);

    context.ui.slot({
      append: "prompt.footer.status",
      render: () =>
        jsx(Show as never, {
          get when() {
            return marks(git());
          },
          children: (parts: () => NonNullable<ReturnType<typeof marks>>) =>
            jsx("text", {
              wrapMode: "none",
              get children() {
                return parts().map((s) => jsx("span", { style: { fg: color(s.color) }, children: s.text }));
              },
            }),
        }),
    });

    context.ui.slot({
      append: "sidebar.content",
      render: () =>
        jsx(For as never, {
          get each() {
            return quota().accounts.filter((a) => fresh(a.windows, now()).length > 0);
          },
          children: (account: Quota["accounts"][number]) =>
            jsx("text", {
              wrapMode: "none",
              get children() {
                const windows = fresh(account.windows, now());
                return [
                  jsx("span", { style: { fg: color("textMuted") }, children: `${account.name} ` }),
                  ...windows.flatMap((w, i) => [
                    ...(i ? [jsx("span", { style: { fg: color("textMuted") }, children: " · " })] : []),
                    jsx("span", { style: { fg: color(severity(w.used)) }, children: formatWindow(w, now()) }),
                  ]),
                ];
              },
            }),
        }),
    });

    return () => {
      clearInterval(ticker);
      clearInterval(clock);
      clearInterval(reload);
      offDone();
      offFailed();
      offQuota();
    };
  },
});
