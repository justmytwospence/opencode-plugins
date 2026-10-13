// opencode-next-prompt (TUI): when a turn ends with a suggestion, it is the ghost text of the
// empty prompt (`Ask anything… "Run the tests"`); Tab or Right fills it in, typing hides it, and
// a new prompt, a busy session or compaction drops it. Each session keeps its own suggestion.
//
// It renders the session prompt itself (the `session_prompt` slot, replace mode) with the host's
// props passed through, adding only the placeholder and a hint, and keeps the
// `session_prompt_right` slot so other plugins still draw beside it.
//
// No JSX and no static Solid imports. opencode compiles a plugin's .tsx with its Solid transform
// only outside node_modules, and maps `solid-js` and `@opentui/solid` imports to its own copies
// only in files whose path has no `#` or `?`; a git install lives in
// `node_modules/…/<name>#<commit>/`, so neither applies there. The host's copies are Bun virtual
// modules (`opentui:runtime-module:<specifier>`), importable from anywhere; a checkout without
// them (or an opencode that renames them) falls back to the plain specifiers. Props that must
// stay reactive are getters.

import type { TuiPlugin, TuiPluginApi, TuiPromptRef } from "@opencode-ai/plugin/tui";
import { Tracker, vet } from "./core.js";
import { DEFAULTS, NAME, type Options } from "./server.js";
import { loadSettings } from "./settings.js";

const KV_KEY = "next-prompt.enabled";
const RUNTIME_MODULE = "opentui:runtime-module:";

type Solid = typeof import("solid-js");
type JsxRuntime = typeof import("@opentui/solid/jsx-runtime");

async function hostModule<T>(specifier: string, fallback: () => Promise<T>): Promise<T> {
  try {
    return (await import(RUNTIME_MODULE + encodeURIComponent(specifier))) as T;
  } catch {
    return fallback();
  }
}

type SessionPromptProps = {
  session_id: string;
  visible?: boolean;
  disabled?: boolean;
  on_submit?: () => void;
  ref?: (ref: TuiPromptRef | undefined) => void;
};

const tui: TuiPlugin = async (api, pluginOptions) => {
  const { createEffect, createSignal, onCleanup } = await hostModule<Solid>("solid-js", () => import("solid-js"));
  const { jsx } = await hostModule<JsxRuntime>("@opentui/solid/jsx-runtime", () => import("@opentui/solid/jsx-runtime"));
  const options = (): Options =>
    loadSettings(NAME, DEFAULTS, pluginOptions as Record<string, unknown> | undefined, api.state.path.directory || process.cwd());
  const tracker = new Tracker();
  const [suggestions, setSuggestions] = createSignal<Record<string, string>>({});
  const generation = new Map<string, number>();
  const seenUsers = new Set<string>();
  let lastVerdict = "";
  // The mounted session prompt: its session and ref, for the accept key.
  let mounted: { sessionID: string; ref: () => TuiPromptRef | undefined } | undefined;

  const enabled = () => api.kv.get<boolean>(KV_KEY, true) !== false && options().enabled;

  const clear = (sessionID: string) => {
    generation.set(sessionID, (generation.get(sessionID) ?? 0) + 1);
    if (!(sessionID in suggestions())) return;
    const { [sessionID]: _gone, ...rest } = suggestions();
    setSuggestions(rest);
  };

  const settle = async (sessionID: string) => {
    const opts = options();
    const candidate = tracker.candidate(
      sessionID,
      api.state.session.messages(sessionID) as never,
      (id) => api.state.part(id) as never,
      opts.maxChars,
    );
    if (!candidate || !enabled()) return;
    const mine = (generation.get(sessionID) ?? 0) + 1;
    generation.set(sessionID, mine);
    const verdict = await vet(candidate, opts.jev);
    lastVerdict = `"${candidate.suggestion}": ${verdict.show ? "shown" : "held back"} (${verdict.reason})`;
    if (!verdict.show || generation.get(sessionID) !== mine) return;
    setSuggestions({ ...suggestions(), [sessionID]: candidate.suggestion });
  };

  const offs = [
    api.event.on("message.part.delta", (event) => tracker.delta(event.properties)),
    api.event.on("message.updated", (event) => {
      const { sessionID, info } = event.properties;
      // opencode updates a user message after its turn too (the summary); only a new one counts.
      if (info.role === "user" && !seenUsers.has(info.id)) {
        seenUsers.add(info.id);
        clear(sessionID);
        tracker.forget(sessionID);
      }
    }),
    api.event.on("session.status", (event) => {
      const { sessionID, status } = event.properties;
      if (status.type === "idle") void settle(sessionID);
      else clear(sessionID);
    }),
    api.event.on("session.idle", (event) => void settle(event.properties.sessionID)),
    api.event.on("session.compacted", (event) => clear(event.properties.sessionID)),
  ];

  const current = (): { text: string; ref: TuiPromptRef } | undefined => {
    if (!mounted) return undefined;
    const text = suggestions()[mounted.sessionID];
    const ref = mounted.ref();
    if (!text || !ref || ref.current.input !== "" || !ref.focused) return undefined;
    return { text, ref };
  };

  // Accept: a high-priority global layer, live only while a suggestion shows in an empty, focused prompt.
  const offAccept = api.keymap.registerLayer({
    priority: 1000,
    enabled: () => current() !== undefined,
    commands: [
      {
        name: "next-prompt.accept",
        run: () => {
          const now = current();
          if (!now || !mounted) return false;
          clear(mounted.sessionID);
          now.ref.set({ input: now.text, parts: [] });
          return true;
        },
      },
    ],
    bindings: options().acceptKeys.map((key) => ({ key, cmd: "next-prompt.accept" })),
  } as never);

  // `/next-prompt` in the palette: on or off (kept across restarts), with the last verdict.
  const offToggle = api.keymap.registerLayer({
    commands: [
      {
        namespace: "palette",
        name: "next-prompt.toggle",
        title: "Toggle next-prompt suggestions",
        category: "Prompt",
        slashName: "next-prompt",
        run: () => {
          const on = !enabled();
          api.kv.set(KV_KEY, on);
          if (!on) for (const id of Object.keys(suggestions())) clear(id);
          api.ui.toast({ message: `next-prompt ${on ? "on" : "off"}${lastVerdict ? `. Last: ${lastVerdict}` : ""}`, variant: "info" });
          return true;
        },
      },
    ],
  } as never);

  api.lifecycle.onDispose(() => {
    for (const off of offs) off();
    offAccept();
    offToggle();
  });

  function SessionPrompt(props: SessionPromptProps) {
    const [ref, setRef] = createSignal<TuiPromptRef | undefined>();
    const text = () => suggestions()[props.session_id];
    mounted = { sessionID: props.session_id, ref };
    createEffect(() => {
      mounted = { sessionID: props.session_id, ref };
    });
    onCleanup(() => {
      if (mounted?.ref === ref) mounted = undefined;
    });
    // Typing hides the suggestion for good, as in Claude Code.
    createEffect(() => {
      const r = ref();
      if (r && r.current.input !== "" && text()) clear(props.session_id);
    });
    const theme = () => api.theme.current;
    const hint = jsx("text", {
      get fg() {
        return theme().textMuted;
      },
      marginLeft: 1,
      children: `${keyLabel(options().acceptKeys[0] ?? "tab")} to accept the suggestion`,
    });
    const right = jsx(api.ui.Slot as never, {
      name: "session_prompt_right",
      get session_id() {
        return props.session_id;
      },
    });
    return jsx(api.ui.Prompt as never, {
      get sessionID() {
        return props.session_id;
      },
      get visible() {
        return props.visible;
      },
      get disabled() {
        return props.disabled;
      },
      onSubmit: () => props.on_submit?.(),
      ref: (r: TuiPromptRef | undefined) => {
        setRef(r);
        props.ref?.(r);
      },
      get placeholders() {
        const t = text();
        return { normal: t ? [t] : [] };
      },
      get hint() {
        return text() ? hint : undefined;
      },
      right,
    });
  }

  api.slots.register({
    order: 100,
    slots: {
      session_prompt: (_ctx, props) => jsx(SessionPrompt as never, props as never),
    },
  });
};

function keyLabel(key: string) {
  return key.charAt(0).toUpperCase() + key.slice(1);
}

export default { id: "opencode-next-prompt-tui", tui };
