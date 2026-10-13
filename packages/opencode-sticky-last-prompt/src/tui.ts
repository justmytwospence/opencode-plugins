// opencode-sticky-last-prompt (terminal): when the last user prompt has scrolled out of view, a
// dim bar at the top of the transcript shows it; a click scrolls back to it.
//
// The bar is a box in the `app` slot, positioned absolutely over the top rows of the transcript's
// viewport. OpenCode's transcript is an OpenTUI ScrollBox whose rows carry message ids, found by
// walking the renderer's tree from the root (anchors.ts); the prompt to pin is recomputed after
// every drawn frame from live layout, so scrolling, streaming, resizing and session switches
// re-derive it without polling. If the transcript cannot be found, nothing is shown.
//
// Plain TypeScript with jsx() rather than JSX: see AGENTS.md.

import { Plugin } from "@opencode/plugin/tui";
import type { Renderable } from "@opentui/core";
import { jsx } from "@opentui/solid/jsx-runtime";
import { createSignal } from "solid-js";
import { type ScrollLike, type UserAnchor, collectAnchors, findTranscript, jumpTarget, selectAnchor, showsPrompts } from "./anchors.ts";

/** Milliseconds between walks of the renderer tree while the transcript is not found. */
const SEARCH_EVERY = 500;

export function parseLines(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.min(3, Math.floor(n)) : 1;
}

interface Frame {
  top: number;
  left: number;
  width: number;
}

interface Pinned {
  anchor: UserAnchor;
  scroll: ScrollLike;
}

export default Plugin.define({
  id: "sticky-last-prompt.tui",
  setup(context) {
    const lines = parseLines((context.options as { lines?: unknown }).lines);
    const [frame, setFrame] = createSignal<Frame | undefined>(undefined);
    const [pinned, setPinned] = createSignal<Pinned | undefined>(undefined);
    const [hover, setHover] = createSignal(false);
    let bar: Renderable | undefined;
    let scroll: ScrollLike | undefined;
    let scrollSession: string | undefined;
    let searched = 0;

    /** This session's user prompts, by message id. */
    const prompts = (sessionID: string) => {
      const map = new Map<string, string>();
      for (const message of context.data.session.message.list(sessionID)) {
        if (message.type === "user" && message.text.trim()) map.set(message.id, message.text);
      }
      return map;
    };

    const clear = () => {
      if (pinned()) setPinned(undefined);
    };

    const update = () => {
      const route = context.ui.router.current();
      if (route.type !== "session") return clear();
      const map = prompts(route.sessionID);
      if (map.size === 0) return clear();
      if (!scroll || scroll.isDestroyed || scrollSession !== route.sessionID || !showsPrompts(scroll, map)) {
        const now = Date.now();
        if (now - searched < SEARCH_EVERY) return clear();
        searched = now;
        scroll = findTranscript(context.renderer.root, map);
        scrollSession = route.sessionID;
        if (!scroll) return clear();
      }
      const selected = selectAnchor(collectAnchors(scroll, map), scroll.scrollTop, lines);
      const parent = bar?.parent as Renderable | null | undefined;
      const vp = scroll.viewport;
      if (!selected || !parent || vp.x === undefined || vp.y === undefined || !vp.width) return clear();
      const next: Frame = { top: vp.y - parent.y, left: vp.x - parent.x, width: vp.width };
      const current = frame();
      if (!current || current.top !== next.top || current.left !== next.left || current.width !== next.width) setFrame(next);
      const shown = pinned();
      if (!shown || shown.scroll !== scroll || shown.anchor.id !== selected.id || shown.anchor.text !== selected.text || shown.anchor.start !== selected.start) {
        setPinned({ anchor: selected, scroll });
      }
    };

    // Every change that can move the transcript (scroll, stream, resize, navigation) draws a
    // frame; reading layout after it is drawn keeps this one frame behind at most.
    const onFrame = () => {
      try {
        update();
      } catch {
        clear();
      }
    };
    context.renderer.on("frame", onFrame);

    const jump = () => {
      const shown = pinned();
      if (!shown || shown.scroll.isDestroyed) return;
      shown.scroll.scrollTo(jumpTarget(shown.anchor, lines));
      context.renderer.requestRender();
    };

    context.ui.slot({
      append: "app",
      render: () =>
        jsx("box", {
          ref: (el: Renderable) => {
            bar = el;
          },
          position: "absolute",
          zIndex: 100,
          height: lines,
          paddingLeft: 1,
          paddingRight: 1,
          get visible() {
            return !!pinned() && !!frame();
          },
          get top() {
            return frame()?.top ?? 0;
          },
          get left() {
            return frame()?.left ?? 0;
          },
          get width() {
            return frame()?.width ?? 1;
          },
          get backgroundColor() {
            return context.theme.background.raised.base;
          },
          onMouseOver: () => setHover(true),
          onMouseOut: () => setHover(false),
          onMouseUp: (event: { button?: number; stopPropagation(): void }) => {
            if (event.button !== undefined && event.button !== 0) return;
            event.stopPropagation();
            jump();
          },
          // The wheel over the bar scrolls the transcript it covers.
          onMouseScroll: (event: { stopPropagation(): void }) => {
            const shown = pinned();
            const target = shown?.scroll as (ScrollLike & { processMouseEvent?: (e: unknown) => void }) | undefined;
            if (!target || target.isDestroyed || typeof target.processMouseEvent !== "function") return;
            event.stopPropagation();
            target.processMouseEvent(event);
          },
          children: jsx("text", {
            wrapMode: lines > 1 ? "word" : "none",
            truncate: lines === 1,
            selectable: false,
            get fg() {
              return hover() ? context.theme.text.action.secondary.hovered : context.theme.text.muted;
            },
            get children() {
              const shown = pinned();
              return shown ? `\u2191 ${shown.anchor.text}` : "";
            },
          }),
        }),
    });

    return () => {
      context.renderer.off("frame", onFrame);
      bar = undefined;
      scroll = undefined;
    };
  },
});
