import { describe, expect, it } from "vitest";
import { formatModel, lastAssistantText, opencodeChild, parseModel } from "../src/session.ts";

const rec = { name: "c", paneId: "w1:p2", where: "tab" as const, cwd: "/r", task: "t", createdAt: 0, awaiting: false, session: "ses_1" };

describe("opencode children", () => {
  it("reads the last assistant text, skipping reasoning and tool-only steps", () => {
    const messages = [
      { type: "user", content: [] },
      { type: "assistant", content: [{ type: "text", text: "first" }] },
      { type: "assistant", content: [{ type: "reasoning", text: "x" }, { type: "text", text: "Done." }] },
      { type: "assistant", content: [{ type: "tool" }] },
      { type: "model-switched" },
    ];
    expect(lastAssistantText(messages)).toBe("Done.");
    expect(lastAssistantText([])).toBeUndefined();
  });

  it("parses and formats provider/model#variant", () => {
    expect(parseModel("anthropic/claude-opus-4-6#high")).toEqual({ providerID: "anthropic", id: "claude-opus-4-6", variant: "high" });
    expect(parseModel("openai/gpt-5")).toEqual({ providerID: "openai", id: "gpt-5" });
    expect(parseModel("nope")).toBeUndefined();
    expect(parseModel("a/")).toBeUndefined();
    expect(parseModel(undefined)).toBeUndefined();
    expect(formatModel({ providerID: "anthropic", id: "claude-opus-4-6", variant: "high" })).toBe("anthropic/claude-opus-4-6#high");
    expect(formatModel(undefined)).toBeUndefined();
  });

  it("creates the child's session in its directory and starts the TUI on it; without a creator, a fresh session", async () => {
    const created: unknown[] = [];
    const agent = opencodeChild({ messages: async () => undefined }, async () => ({ code: 1, stdout: "", stderr: "" }), async (directory, model) => {
      created.push({ directory, model });
      return "ses_new";
    });
    expect(agent.kind).toBe("opencode");
    expect(await agent.args({ task: "t", cwd: "/r/.worktrees/x", model: "anthropic/claude-sonnet-4-5#low" }, "c")).toEqual(["--session", "ses_new"]);
    expect(created).toEqual([{ directory: "/r/.worktrees/x", model: { providerID: "anthropic", id: "claude-sonnet-4-5", variant: "low" } }]);
    expect(agent.created.get("c")).toBe("ses_new");
    const plain = opencodeChild({ messages: async () => undefined }, async () => ({ code: 1, stdout: "", stderr: "" }));
    expect(await plain.args({ task: "t", cwd: "/r" }, "c")).toEqual([]);
  });

  it("reads the reply through the server, else through opencode session export", async () => {
    const execs: string[][] = [];
    const agent = opencodeChild({ messages: async () => undefined }, async (cmd, args) => {
      execs.push([cmd, ...args]);
      return { code: 0, stdout: JSON.stringify({ info: {}, messages: [{ type: "assistant", content: [{ type: "text", text: "PONG\n\n<next>x</next>" }] }] }), stderr: "" };
    });
    expect(await agent.reply(rec)).toBe("PONG");
    expect(execs).toEqual([["opencode", "session", "export", "ses_1"]]);
    const direct = opencodeChild({ messages: async () => [{ type: "assistant", content: [{ type: "text", text: "via server" }] }] }, async () => ({ code: 1, stdout: "", stderr: "" }));
    expect(await direct.reply(rec)).toBe("via server");
    expect(await direct.reply({ ...rec, session: undefined })).toBeUndefined();
  });
});
