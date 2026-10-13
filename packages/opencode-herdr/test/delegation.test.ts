import type { Plugin } from "@opencode-ai/plugin";
import { afterEach, expect, test, vi } from "vitest";
import { HerdrPlugin } from "../src/server.ts";

afterEach(() => vi.unstubAllEnvs());

test("Herdr tool guidance reserves interactive sessions for human-led handoffs", async () => {
  vi.stubEnv("HERDR_ENV", "1");
  vi.stubEnv("HERDR_SOCKET_PATH", "/unused/herdr.sock");
  vi.stubEnv("HERDR_PANE_ID", "w1:p1");
  const hooks = await HerdrPlugin({ client: {}, directory: "/unused" } as Parameters<Plugin>[0]);
  try {
    const tool = hooks.tool?.herdr_child;
    const description = tool?.description ?? "";
    expect(description).toContain("persistent, human-led");
    expect(description).toContain("subagent (the task tool)");
    expect(description).toContain("even when long, multi-step, or parallel");
    expect(description).toContain("explicit interactive-session request");
    expect(description).toContain("where=tab in the existing space");
    expect(description).toContain("Tabs and splits share files");
    expect(description).toContain("where=split only for deliberate side-by-side");
    expect(description).toContain("otherwise ask before creating one");
    expect(description).toContain("already open");
    expect(description).not.toContain("use a herdr child when the work is long or open-ended");
  } finally {
    await hooks.dispose?.();
  }
});
