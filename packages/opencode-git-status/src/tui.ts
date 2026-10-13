// opencode-git-status (TUI): a readable checkout summary to the right of the prompt.
// Formatting and Git status collection live in git.ts.
//
// Plain TypeScript rather than JSX, with Solid taken from opencode: see host.ts.

import type { TuiPlugin } from "@opencode-ai/plugin/tui";
import { type GitStatus, readStatus, sameStatus, segments } from "./git.js";
import { line, loadHost } from "./host.js";

/** Re-read at most this often while nothing prompts it; a turn ending reads at once. */
const POLL_MS = 3000;

const tui: TuiPlugin = async (api) => {
  const host = await loadHost();
  const [status, setStatus] = host.solid.createSignal<GitStatus | undefined>(undefined);
  const cwd = api.state.path.directory || process.cwd();
  let busy = false;
  let again = false;
  const refresh = async (): Promise<void> => {
    if (busy) { again = true; return; }
    busy = true;
    try {
      const next = await readStatus(cwd);
      if (!sameStatus(next, status())) setStatus(next);
    } finally {
      busy = false;
      if (again) { again = false; void refresh(); }
    }
  };
  void refresh();
  const ticker = setInterval(() => void refresh(), POLL_MS);
  // Tool calls and turn ends are when the agent changes files.
  const offIdle = api.event.on("session.idle", () => void refresh());
  const offPart = api.event.on("message.part.updated", (event) => {
    const part = event.properties.part as { type?: string; state?: { status?: string } };
    if (part.type === "tool" && part.state?.status === "completed") void refresh();
  });
  api.lifecycle.onDispose(() => {
    clearInterval(ticker);
    offIdle();
    offPart();
  });
  const theme = () => api.theme.current;
  const view = () =>
    line(
      host,
      () => theme().textMuted,
      () => segments(status())?.map((s) => (s.color ? { text: s.text, color: theme()[s.color] } : { text: s.text })),
    );
  // Before opencode-marimo (300) and opencode-cache-guard (310) in the same slot.
  api.slots.register({
    order: 290,
    slots: {
      home_prompt_right: view,
      session_prompt_right: view,
    },
  });
};

export default { id: "opencode-git-status-tui", tui };
