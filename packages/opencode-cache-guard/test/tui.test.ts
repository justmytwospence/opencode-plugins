import { expect, test, vi } from "vitest";

import { DEFAULT_SETTINGS, mergeSettings } from "../src/core.ts";
import type { JevOutput } from "../src/rpc.ts";
import { type CompactCommandDeps, type JevCommandDeps, compactCommand, jevCommand, segments } from "../src/tui.ts";

test("warm: time left, muted", () => {
  expect(segments({ left: "4:12" })).toEqual([{ text: "cache ", color: "textMuted" }, { text: "4:12", color: "textMuted" }]);
});

test("cold: in the warning color", () => {
  expect(segments({ cold: "cold" })).toEqual([{ text: "cache ", color: "textMuted" }, { text: "cold", color: "warning" }]);
  expect(segments({ cold: "cold?" })).toEqual([{ text: "cache ", color: "textMuted" }, { text: "cold?", color: "warning" }]);
});

test("no state: nothing", () => {
  expect(segments(undefined)).toBeUndefined();
});

function command(overrides: Partial<JevCommandDeps> & { settings?: () => ReturnType<typeof mergeSettings> } = {}) {
  const dialogs: Array<{ title: string; options: Array<{ title: string; description?: string; onSelect: () => void }> }> = [];
  const toasts: string[] = [];
  const saved: Record<string, unknown>[] = [];
  let settings = overrides.settings?.() ?? DEFAULT_SETTINGS;
  const deps: JevCommandDeps = {
    settings: () => settings,
    state: async () => ({ kind: "ready", label: "typesafe/jev-latest", latencyMs: 312 }) as JevOutput,
    save: (patch) => {
      saved.push(patch);
      settings = mergeSettings(settings, [JSON.stringify(patch)]);
    },
    select: async (title, options) => void dialogs.push({ title, options }),
    toast: (message, variant) => toasts.push(`${variant} ${message}`),
    ...overrides,
  };
  return { deps, dialogs, toasts, saved };
}

test("cache-guard: Jev, when set up, shows the server's latency and can turn it off", async () => {
  const { deps, dialogs, toasts, saved } = command();
  await jevCommand(deps);
  expect(dialogs[0]!.title).toMatch(/^Jev: typesafe\/jev-latest, answered in 312 ms\. It trims large tool output/u);
  expect(dialogs[0]!.options.map((o) => o.title)).toEqual(["Done", "Turn Jev off"]);
  dialogs[0]!.options[1]!.onSelect();
  expect(saved).toEqual([{ jev: { enabled: false } }]);
  expect(toasts).toEqual(["info Jev is off: no trimming, no Jev compaction. cache-guard: Jev turns it back on."]);
  // Off: offers to turn it on, which checks again.
  await jevCommand(deps);
  expect(dialogs[1]!.title).toMatch(/^Jev is off: no trimming, no Jev compaction, no tips\.\nJev, TypeSafe's judgment model/u);
  expect(dialogs[1]!.options.map((o) => o.title)).toEqual(["Turn Jev on", "Leave it off"]);
  dialogs[1]!.options[0]!.onSelect();
  await vi.waitFor(() => expect(dialogs).toHaveLength(3));
  expect(saved.at(-1)).toEqual({ jev: { enabled: true } });
  expect(dialogs[2]!.title).toContain("answered in 312 ms");
  // A probe that fails says so.
  const down = command({ state: async () => ({ kind: "ready", label: "typesafe/jev-latest", reason: "invalid API key" }) });
  await jevCommand(down.deps);
  expect(down.dialogs[0]!.title).toMatch(/^Jev: typesafe\/jev-latest did not answer \(invalid API key\)\./u);
});

test("cache-guard: Jev, when not set up, explains the key and can turn the tips off", async () => {
  const { deps, dialogs, toasts, saved } = command({ state: async () => ({ kind: "missing", reason: "TYPESAFE_API_KEY is not set" }) });
  await jevCommand(deps);
  expect(dialogs[0]!.title).toBe("Jev is not set up: TYPESAFE_API_KEY is not set.\nJev, TypeSafe's judgment model, trims large tool output to what the agent needs and compacts a conversation in about a second, without an LLM summary.\nIt needs a TypeSafe API key from https://console.typesafe.ai/keys, as TYPESAFE_API_KEY in the environment of OpenCode's server (restart it after setting the key).");
  expect(dialogs[0]!.options.map((o) => o.title)).toEqual(["Done", "Turn Jev off (no more tips)"]);
  dialogs[0]!.options[1]!.onSelect();
  expect(saved).toEqual([{ jev: { enabled: false } }]);
  expect(toasts).toEqual(["info Jev is off: no trimming, no Jev compaction, no tips. cache-guard: Jev turns it back on."]);
  // Another provider configured: offer to clear it.
  const other = command({
    settings: () => mergeSettings(DEFAULT_SETTINGS, ['{"jev":{"provider":"openrouter"}}']),
    state: async () => ({ kind: "missing", reason: 'jev.provider "openrouter" is not supported here' }),
  });
  await jevCommand(other.deps);
  expect(other.dialogs[0]!.options.map((o) => o.title)).toEqual(["Done", "Use TypeSafe's API (clear jev.provider)", "Turn Jev off (no more tips)"]);
  other.dialogs[0]!.options[1]!.onSelect();
  expect(other.saved).toEqual([{ jev: { provider: "", model: "" } }]);
  // A save that fails is reported, and nothing else happens.
  const broken = command({ save: () => { throw new Error("/x/cache-guard.json is not a JSON object"); } });
  await jevCommand(broken.deps);
  broken.dialogs[0]!.options[1]!.onSelect();
  expect(broken.toasts).toEqual(["error Could not save the setting: /x/cache-guard.json is not a JSON object"]);
  // Everything off: one toast.
  const all = command({ settings: () => mergeSettings(DEFAULT_SETTINGS, ['{"enabled":false}']) });
  await jevCommand(all.deps);
  expect(all.dialogs).toEqual([]);
  expect(all.toasts).toEqual(['info cache-guard is off in its settings ("enabled": false), Jev included.']);
});

function compactDeps(state: JevOutput, overrides: Partial<CompactCommandDeps> = {}) {
  const log: string[] = [];
  const deps: CompactCommandDeps = {
    state: async () => state,
    compact: async (arm) => { log.push(`compact ${arm.kind}${arm.text ? ` ${arm.text}` : ""}`); },
    select: async (title, options) => { log.push(`select ${title} [${options.map((o) => o.title).join(", ")}]`); return undefined; },
    setup: async () => { log.push("setup"); },
    toast: (message, variant) => log.push(`toast ${variant} ${message}`),
    now: (() => { let t = 1_000; return () => (t += 1_500); })(),
    ...overrides,
  };
  return { deps, log };
}

test("cache-guard: compact runs Jev's compaction against the focus; a failure is toasted", async () => {
  const ready: JevOutput = { kind: "ready", label: "typesafe/jev-latest" };
  const { deps, log } = compactDeps(ready);
  await compactCommand("s", " keep the parser ", deps);
  expect(log).toEqual(["compact jev keep the parser", "toast info Compacted with Jev in 1.5 s."]);
  const bare = compactDeps(ready);
  await compactCommand("s", "", bare.deps);
  expect(bare.log[0]).toBe("compact jev");
  const failing = compactDeps(ready, { compact: async () => { throw new Error("Compaction with Jev did not run: Jev failed (timed out)."); } });
  await compactCommand("s", "", failing.deps);
  expect(failing.log).toEqual(["toast warning Compaction with Jev did not run: Jev failed (timed out)."]);
});

test("cache-guard: compact without Jev offers OpenCode's summary (with the focus as guidance) or the setup", async () => {
  const missing: JevOutput = { kind: "missing", reason: "TYPESAFE_API_KEY is not set" };
  const esc = compactDeps(missing);
  await compactCommand("s", "", esc.deps);
  expect(esc.log).toEqual(["select Jev is not set up (TYPESAFE_API_KEY is not set). Compact with OpenCode's summary instead? [Compact with OpenCode's summary, Set up Jev]"]);
  const summary = compactDeps(missing, { select: async () => "summary" as never });
  await compactCommand("s", "focus on tests", summary.deps);
  expect(summary.log).toEqual(["compact guidance focus on tests"]);
  const setup = compactDeps({ kind: "off" }, { select: async (title) => { expect(title).toMatch(/^Jev is off\./u); return "setup" as never; } });
  await compactCommand("s", "", setup.deps);
  expect(setup.log).toEqual(["setup"]);
});
