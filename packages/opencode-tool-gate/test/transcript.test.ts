import { expect, test } from "vitest";
import { agentBeforeLatestUser, callerText, recentTexts, recentUserMessages } from "../src/transcript.ts";
import { assistant, user } from "./harness.ts";

const call = { type: "tool", id: "t1", name: "shell" };
const message = (content: { type: string; text?: string; id?: string; name?: string }[], id = "m1") => ({ id, type: "assistant", content });

test("callerText prefers the visible text beside the call, by call id or message id", () => {
  const messages = [message([{ type: "reasoning", text: "private" }, { type: "text", text: "Pushing is what you asked for." }, call])];
  expect(callerText(messages, { callID: "t1" })).toBe("Pushing is what you asked for.");
  expect(callerText(messages, { messageID: "m1" })).toBe("Pushing is what you asked for.");
});

test("callerText falls back to reasoning when the agent wrote no text", () => {
  const messages = [message([{ type: "reasoning", text: "" }, { type: "reasoning", text: "Pushing this branch and opening the PR, as you chose.\n\n" }, call])];
  expect(callerText(messages, { callID: "t1" })).toBe("Pushing this branch and opening the PR, as you chose.");
});

test("callerText is empty when the call came with neither", () => {
  expect(callerText([message([call])], { callID: "t1" })).toBe("");
  expect(callerText([message([{ type: "text", text: "other" }])], { callID: "t1", messageID: "m9" })).toBe("");
});

test("recent requests, the agent's latest explanation, and what a short reply answers", () => {
  const messages = [user("first", "u1"), assistant("Want me to push?", undefined, "a1"), user("yes", "u2"), assistant("Pushing.", "c1", "a2")];
  expect(recentUserMessages(messages, 3)).toEqual(["first", "yes"]);
  expect(recentTexts(messages)).toEqual({ user: "yes", assistant: "Pushing." });
  expect(agentBeforeLatestUser(messages)).toBe("Want me to push?");
  expect(agentBeforeLatestUser([user("only")])).toBe("");
});
