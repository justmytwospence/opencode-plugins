import { describe, expect, it } from "vitest";
import { childrenFile } from "../src/server.ts";
import { lastAssistantText, opencodeChild } from "../src/session.ts";
import { displayAgent, sessionTitle } from "../src/tui.ts";

const rec = { name: "c", paneId: "w1:p2", where: "tab" as const, cwd: "/r", task: "t", createdAt: 0, awaiting: false, session: "ses_1" };

describe("opencode children", () => {
  it("reads the last assistant text, skipping synthetic parts and tool-only steps", () => {
    const messages = [
      { info: { role: "user" }, parts: [{ type: "text", text: "go" }] },
      { info: { role: "assistant" }, parts: [{ type: "text", text: "first" }] },
      { info: { role: "assistant" }, parts: [{ type: "step-start" }, { type: "reasoning", text: "x" }, { type: "text", text: "Done.", synthetic: false }, { type: "text", text: "hidden", synthetic: true }] },
      { info: { role: "assistant" }, parts: [{ type: "tool" }] },
    ];
    expect(lastAssistantText(messages)).toBe("Done.");
    expect(lastAssistantText([])).toBeUndefined();
  });

  it("starts opencode with the model, and falls back to opencode export", async () => {
    const execs: string[][] = [];
    const agent = opencodeChild({ messages: async () => undefined }, async (cmd, args) => {
      execs.push([cmd, ...args]);
      return { code: 0, stdout: JSON.stringify({ info: {}, messages: [{ info: { role: "assistant" }, parts: [{ type: "text", text: "PONG\n\n<next>x</next>" }] }] }), stderr: "" };
    });
    expect(agent.kind).toBe("opencode");
    expect(agent.args({ task: "t", cwd: "/r", model: "anthropic/claude-sonnet-5-5" }, "c")).toEqual(["--model", "anthropic/claude-sonnet-5-5"]);
    expect(agent.args({ task: "t", cwd: "/r" }, "c")).toEqual([]);
    expect(await agent.reply(rec)).toBe("PONG");
    expect(execs).toEqual([["opencode", "export", "ses_1"]]);
    const direct = opencodeChild({ messages: async () => [{ info: { role: "assistant" }, parts: [{ type: "text", text: "via api" }] }] }, async () => ({ code: 1, stdout: "", stderr: "" }));
    expect(await direct.reply(rec)).toBe("via api");
    expect(await direct.reply({ ...rec, session: undefined })).toBeUndefined();
  });

  it("saves each parent session's children in its own file", () => {
    expect(childrenFile("ses_ab/c", "/data")).toBe("/data/children/ses_ab_c.json");
  });
});

describe("tui", () => {
  it("names the agent from the latest message with a model", () => {
    expect(displayAgent([{ role: "user", model: { providerID: "anthropic", modelID: "claude-opus-5-5", variant: "high" } }])).toBe("opencode opus-5-5:high");
    expect(displayAgent([{ role: "assistant", providerID: "openai", modelID: "gpt-6-astra" }, { role: "user" }])).toBe("opencode gpt-6-astra");
    expect(displayAgent([])).toBe("opencode");
  });

  it("ignores opencode's placeholder title", () => {
    expect(sessionTitle("New session - 2026-09-23T22:19:40.673Z")).toBeUndefined();
    expect(sessionTitle(" Fix auth flow ")).toBe("Fix auth flow");
    expect(sessionTitle(undefined)).toBeUndefined();
  });
});
