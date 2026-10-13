import { describe, expect, test } from "vitest";

import { DEFAULT_SETTINGS, mergeSettings } from "../src/core.ts";
import { GUIDANCE_OPTIONS, type HeldPrompt, JEV_TIP, choiceOptions, choiceTitle, guidanceText, heldPrompt, holdable } from "../src/holds.ts";
import { type Actions, type Dialogs, act, decideHold, jevOffer, offer } from "../src/tui.ts";

const T0 = Date.parse("2026-10-07T12:00:00Z");
const sonnet = { input: 2, cacheRead: 0.2 };

function held(text = "go on"): HeldPrompt {
  return heldPrompt({ text, now: T0, line: "The prompt cache expired 10m ago.", reason: { kind: "expired", idleMs: 600_000 }, tokens: 601_000, price: sonnet, ttlMs: 300_000 });
}

describe("held prompt", () => {
  test("the record and the priced options, Send first (Pi's order), Keep last", () => {
    const h = held();
    expect(h.costs!.send).toBeCloseTo(1.5025, 3);
    expect(h.costs!.compact).toBeCloseTo(1.202, 3);
    const options = choiceOptions(h);
    expect(options.map((o) => o.value)).toEqual(["send", "mute", "compact", "fresh", "keep"]);
    expect(options[2]!.title).toBe("Compact first, then send (~$1.20)");
    expect(options[0]!.title).toBe("Send anyway (~$1.50)");
    const unpriced = choiceOptions({ ...h, costs: undefined });
    expect(unpriced[0]!.title).toBe("Send anyway");
    expect(unpriced[2]!.description).toContain("601k-token history");
  });

  test("with Jev: its option sits before Compact first; without it, the title carries the tip", () => {
    const h = held();
    const withJev = choiceOptions(h, { ready: true });
    expect(withJev.map((o) => o.value)).toEqual(["send", "mute", "jev", "compact", "fresh", "keep"]);
    expect(withJev[2]!.title).toBe("Compact with Jev, then send (~1s, ~$0)");
    expect(withJev[2]!.description).toContain("601k-token history");
    expect(choiceTitle(h)).toBe("Prompt cache miss. The prompt cache expired 10m ago.");
    expect(choiceTitle(h, { ready: true, tip: false })).toBe("Prompt cache miss. The prompt cache expired 10m ago.");
    expect(choiceTitle(h, { ready: false, tip: true })).toBe(`Prompt cache miss. The prompt cache expired 10m ago.\n${JEV_TIP}`);
    expect(JEV_TIP).toBe('Tip: set TYPESAFE_API_KEY (https://console.typesafe.ai/keys) for Jev, which compacts on a one-second summary for ~$0; "jev": { "enabled": false } in cache-guard.json hides this.');
    expect(jevOffer({ kind: "ready", label: "typesafe/jev-latest", latencyMs: 300 }, DEFAULT_SETTINGS)).toEqual({ ready: true, tip: false });
    expect(jevOffer({ kind: "missing", reason: "TYPESAFE_API_KEY is not set" }, DEFAULT_SETTINGS)).toEqual({ ready: false, tip: true });
    expect(jevOffer({ kind: "off" }, DEFAULT_SETTINGS)).toEqual({ ready: false, tip: false });
    // The server has not answered yet: no Jev option, no tip.
    expect(jevOffer(undefined, DEFAULT_SETTINGS)).toEqual({ ready: false, tip: false });
    expect(jevOffer({ kind: "missing", reason: "x" }, mergeSettings(DEFAULT_SETTINGS, ['{"jev":{"enabled":false}}']))).toEqual({ ready: false, tip: false });
  });

  test("guidance: default adds nothing, focus quotes the prompt, custom is the user's text", () => {
    const h = held("fix the flaky test");
    expect(guidanceText("default", h)).toBeUndefined();
    expect(guidanceText("focus", h)).toContain("fix the flaky test");
    expect(guidanceText("custom", h, "  keep the file list ")).toBe("keep the file list");
    expect(guidanceText("custom", h, "   ")).toBeUndefined();
    expect(GUIDANCE_OPTIONS.map((o) => o.value)).toEqual(["default", "focus", "custom"]);
  });

  test("holdable: real prompts in normal mode while warnings are on", () => {
    expect(holdable("go on", "normal", DEFAULT_SETTINGS)).toBe(true);
    expect(holdable("   ", "normal", DEFAULT_SETTINGS)).toBe(false);
    expect(holdable("/compact", "normal", DEFAULT_SETTINGS)).toBe(false);
    expect(holdable("ls", "shell", DEFAULT_SETTINGS)).toBe(false);
    expect(holdable("go on", "normal", mergeSettings(DEFAULT_SETTINGS, ['{"warn":{"enabled":false}}']))).toBe(false);
    expect(holdable("go on", "normal", mergeSettings(DEFAULT_SETTINGS, ['{"enabled":false}']))).toBe(false);
  });

  test("decideHold: a cold, big cache holds; warm, small, muted, or a model with no prices and few tokens do not", () => {
    const opus = { providerID: "anthropic", modelID: "claude-opus-5-5" };
    const snapshot = { sessionID: "s", lastAt: T0 - 900_000, ttlMs: 300_000, tokens: 601_000, model: opus, price: { input: 4, cacheRead: 0.2, cacheWrite: 5 }, updatedAt: T0 };
    const base = { text: "go on", mode: "normal", snapshot, model: opus, now: T0, settings: DEFAULT_SETTINGS, muted: false };
    const h = decideHold(base);
    expect(h).toMatchObject({ text: "go on", reason: "expired", tokens: 601_000 });
    expect(h!.line).toBe("The prompt cache expired 10m ago: this prompt re-caches 601k tokens (~$2.88 at API prices).");
    expect(h!.costs!.send).toBeCloseTo(3.005, 3);
    expect(decideHold({ ...base, snapshot: { ...snapshot, lastAt: T0 - 60_000 } })).toBeUndefined();
    expect(decideHold({ ...base, snapshot: { ...snapshot, tokens: 20_000 } })).toBeUndefined();
    expect(decideHold({ ...base, muted: true })).toBeUndefined();
    expect(decideHold({ ...base, text: "/new" })).toBeUndefined();
    expect(decideHold({ ...base, snapshot: undefined })).toBeUndefined();
    // A model switch misses even while the clock runs; the new model's list price is used.
    const switched = decideHold({ ...base, snapshot: { ...snapshot, lastAt: T0 - 60_000 }, model: { providerID: "anthropic", modelID: "claude-sonnet-5" } });
    expect(switched).toMatchObject({ reason: "model" });
    expect(switched!.line).toContain("claude-sonnet-5 has no cache of this conversation");
    // Without prices the token threshold applies.
    expect(decideHold({ ...base, snapshot: { ...snapshot, price: undefined, tokens: 90_000 } })).toBeUndefined();
    expect(decideHold({ ...base, snapshot: { ...snapshot, price: undefined, tokens: 120_000 } })).toMatchObject({ tokens: 120_000, costs: undefined });
  });
});

function fakeActions(overrides: Partial<Actions> = {}) {
  const log: string[] = [];
  const actions: Actions = {
    restore: () => log.push("restore"),
    submit: async () => { log.push("submit"); },
    mute: (s) => log.push(`mute ${s}`),
    compact: async (s, arm) => { log.push(`compact ${s} ${arm.kind}${arm.text ? ` ${arm.text.split("\n")[0]}` : ""}`); },
    fresh: async () => { log.push("fresh"); return "n1"; },
    toast: (message, variant) => log.push(`toast ${variant} ${message}`),
    ...overrides,
  };
  return { actions, log };
}

/** Dialogs that answer from a script of picks (an index into the options, a typed string, or undefined for Esc). */
function scripted(picks: Array<number | string | undefined>) {
  const shown: Array<{ title: string; options?: string[] }> = [];
  const dialogs: Dialogs = {
    select: async (title, options) => {
      shown.push({ title, options: options.map((o) => String(o.value)) });
      const pick = picks.shift();
      return typeof pick === "number" ? options[pick]!.value : undefined;
    },
    prompt: async (title) => {
      shown.push({ title });
      const pick = picks.shift();
      return typeof pick === "string" ? pick : undefined;
    },
  };
  return { dialogs, shown };
}

describe("choices", () => {
  test("keep restores; send submits; mute mutes then submits", async () => {
    const { actions, log } = fakeActions();
    await act("keep", "s", held(), actions);
    await act("send", "s", held(), actions);
    await act("mute", "s", held(), actions);
    expect(log).toEqual(["restore", "submit", "mute s", "submit"]);
  });

  test("compact arms the guidance, compacts, then sends; a failed compaction restores the prompt", async () => {
    const { actions, log } = fakeActions();
    await act("compact", "s", held(), actions, "Keep the plan.");
    expect(log).toEqual(["toast info Compacting, then sending your prompt.", "compact s guidance Keep the plan.", "submit"]);
    const failing = fakeActions({ compact: async () => { throw new Error("Compaction failed (no model)."); } });
    await act("compact", "s", held(), failing.actions);
    expect(failing.log).toEqual(["toast info Compacting, then sending your prompt.", "restore", "toast error Compaction failed (no model). The prompt is back in the box."]);
  });

  test("jev arms Jev's summary against the prompt, compacts, then sends; a Jev failure sends nothing", async () => {
    const { actions, log } = fakeActions();
    await act("jev", "s", held(), actions);
    expect(log).toEqual(["toast info Compacting with Jev, then sending your prompt.", "compact s jev go on", "submit"]);
    const failing = fakeActions({ compact: async () => { throw new Error("Compaction with Jev did not run: Jev failed (timed out)."); } });
    await act("jev", "s", held(), failing.actions);
    expect(failing.log.at(-1)).toBe("toast error Compaction with Jev did not run: Jev failed (timed out). The prompt is back in the box.");
  });

  test("fresh creates a session and sends there; a failed create restores the prompt", async () => {
    const { actions, log } = fakeActions();
    await act("fresh", "s", held(), actions);
    expect(log).toEqual(["fresh", "submit"]);
    const failing = fakeActions({ fresh: async () => undefined });
    await act("fresh", "s", held(), failing.actions);
    expect(failing.log).toEqual(["restore", "toast error Creating a session failed; the prompt is back in the box."]);
  });

  test("the dialog with Jev: its option runs the Jev path; the tip shows only while Jev is missing", async () => {
    const { actions, log } = fakeActions();
    const { dialogs, shown } = scripted([2]);
    await offer(dialogs, "s", held(), actions, { ready: true, tip: false });
    expect(shown[0]!.title).not.toContain("Tip:");
    expect(shown[0]!.options).toEqual(["send", "mute", "jev", "compact", "fresh", "keep"]);
    expect(log).toEqual(["toast info Compacting with Jev, then sending your prompt.", "compact s jev go on", "submit"]);
    const missing = scripted([undefined]);
    await offer(missing.dialogs, "s", held(), actions, { ready: false, tip: true });
    expect(missing.shown[0]!.title).toContain("Tip: set TYPESAFE_API_KEY");
    expect(missing.shown[0]!.options).toEqual(["send", "mute", "compact", "fresh", "keep"]);
  });

  test("the dialog: Esc and Keep restore; compact asks for guidance; custom guidance goes through a prompt", async () => {
    const { actions, log } = fakeActions();
    const esc = scripted([undefined]);
    await offer(esc.dialogs, "s", held(), actions, { ready: false, tip: false });
    expect(log).toEqual(["restore"]);
    log.length = 0;
    await offer(scripted([4]).dialogs, "s", held(), actions, { ready: false, tip: false });
    expect(log).toEqual(["restore"]);
    log.length = 0;

    const custom = scripted([2, 2, "Keep the file list."]);
    await offer(custom.dialogs, "s", held(), actions, { ready: false, tip: false });
    expect(custom.shown.map((d) => d.title)).toEqual([expect.stringContaining("Prompt cache miss"), "Compact with", "Compaction guidance"]);
    expect(custom.shown[1]!.options).toEqual(["default", "focus", "custom"]);
    expect(log).toEqual(["toast info Compacting, then sending your prompt.", "compact s guidance Keep the file list.", "submit"]);
    log.length = 0;

    // Esc in the guidance dialog or the prompt keeps the prompt.
    await offer(scripted([2, undefined]).dialogs, "s", held(), actions, { ready: false, tip: false });
    await offer(scripted([2, 2, undefined]).dialogs, "s", held(), actions, { ready: false, tip: false });
    expect(log).toEqual(["restore", "restore"]);
    log.length = 0;

    await offer(scripted([2, 1]).dialogs, "s", held(), actions, { ready: false, tip: false });
    expect(log[1]).toBe("compact s guidance Keep what is needed to continue with the user's next request, quoted below, and drop the rest.");
    log.length = 0;
    await offer(scripted([2, 0]).dialogs, "s", held(), actions, { ready: false, tip: false });
    expect(log[1]).toBe("compact s guidance");
    log.length = 0;
    await offer(scripted([0]).dialogs, "s", held(), actions, { ready: false, tip: false });
    expect(log).toEqual(["submit"]);
  });
});
