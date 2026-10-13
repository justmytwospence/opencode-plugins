import { expect, test } from "vitest";
import { DEFAULTS, clientLookup, createHooks, isHiddenAgent, type Lookup } from "../src/server.js";
import { INSTRUCTION } from "../src/tag.js";

const TITLE_PROMPT = "You are a title generator. You output ONLY a thread title.";

function lookup(over: Partial<Lookup> = {}): Lookup {
  return { hiddenPrompts: async () => [TITLE_PROMPT], isChild: async () => false, ...over };
}

async function transform(hooks: ReturnType<typeof createHooks>, system: string[], sessionID: string | null = "s1") {
  await hooks["experimental.chat.system.transform"]!({ sessionID: sessionID ?? undefined, model: {} as never }, { system });
  return system;
}

test("the instruction is appended once, as its own block", async () => {
  const hooks = createHooks(lookup(), () => DEFAULTS);
  const system = await transform(hooks, ["You are OpenCode."]);
  expect(system).toEqual(["You are OpenCode.", INSTRUCTION]);
  await transform(hooks, system);
  expect(system).toEqual(["You are OpenCode.", INSTRUCTION]);
});

test("hidden agents, subagent sessions, calls without a session and a disabled plugin get nothing", async () => {
  expect(await transform(createHooks(lookup(), () => DEFAULTS), [`${TITLE_PROMPT}\nMore rules.`])).toHaveLength(1);
  expect(await transform(createHooks(lookup({ isChild: async () => true }), () => DEFAULTS), ["main"])).toHaveLength(1);
  expect(await transform(createHooks(lookup(), () => DEFAULTS), ["main"], null)).toHaveLength(1);
  expect(await transform(createHooks(lookup(), () => ({ ...DEFAULTS, enabled: false })), ["main"])).toHaveLength(1);
  expect(await transform(createHooks(lookup({ isChild: () => Promise.reject(new Error("x")) }), () => DEFAULTS), ["main"])).toHaveLength(1);
});

test("isHiddenAgent ignores empty prompts", () => {
  expect(isHiddenAgent(["anything"], ["", "  "])).toBe(false);
});

test("completed text loses its tag line; other text is untouched", async () => {
  const hooks = createHooks(lookup(), () => DEFAULTS);
  const output = { text: "Done.\n\n<next>Run the tests</next>" };
  await hooks["experimental.text.complete"]!({ sessionID: "s", messageID: "m", partID: "p" }, output);
  expect(output.text).toBe("Done.");
  const plain = { text: "Mentions `<next>x</next>` inline." };
  await hooks["experimental.text.complete"]!({ sessionID: "s", messageID: "m", partID: "p" }, plain);
  expect(plain.text).toBe("Mentions `<next>x</next>` inline.");
});

test("clientLookup caches agents and sessions", async () => {
  let agentCalls = 0;
  let sessionCalls = 0;
  const l = clientLookup({
    app: {
      agents: async () => {
        agentCalls++;
        return { data: [{ hidden: true, prompt: TITLE_PROMPT }, { hidden: false, prompt: "build" }, { hidden: true }] };
      },
    },
    session: {
      get: async ({ path }) => {
        sessionCalls++;
        return { data: path.id === "child" ? { parentID: "root" } : {} };
      },
    },
  });
  expect(await l.hiddenPrompts()).toEqual([TITLE_PROMPT]);
  await l.hiddenPrompts();
  expect(agentCalls).toBe(1);
  expect(await l.isChild("child")).toBe(true);
  expect(await l.isChild("root")).toBe(false);
  await l.isChild("child");
  expect(sessionCalls).toBe(2);
});
