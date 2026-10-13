// Manual end-to-end check inside herdr (not part of `npm test`):
//   node --experimental-strip-types test/live-child.mts [tab|split]
// Starts an OpenCode child on a fresh session (this script has no server to create one with a
// model), asks it to reply PONG, waits for the reply (read through `opencode session export`),
// then closes it.
import { Children } from "../src/core/children.ts";
import { herdrTarget, socketCall } from "../src/core/herdr.ts";
import { exec } from "../src/exec.ts";
import { opencodeChild } from "../src/session.ts";

const target = herdrTarget();
if (!target) throw new Error("run inside herdr");
const call = socketCall(target.socketPath);
const where = (process.argv[2] ?? "tab") as "tab" | "split";
let resolveReply: (t: string) => void;
const replied = new Promise<string>((r) => (resolveReply = r));
const children = new Children({
  call,
  agent: opencodeChild({ messages: async () => undefined }, exec),
  selfPane: target.paneId,
  exec,
  persist: () => {},
  deliver: (_rec, text) => resolveReply(text),
  hold: (rec, on) => console.log("hold", rec.name, on),
  pollMs: 1_000,
});
const t0 = Date.now();
const rec = await children.spawn({ task: "Reply with exactly the word PONG and nothing else. Do not use tools.", name: "oc-herdr-live", where, cwd: process.cwd() });
console.log("spawned", rec.name, rec.paneId, `${Date.now() - t0}ms`);
const text = await Promise.race([replied, new Promise<string>((_, rej) => setTimeout(() => rej(new Error("no reply in 180 s")), 180_000))]);
console.log("reply after", `${Date.now() - t0}ms:`, JSON.stringify(text));
console.log(await children.list());
console.log(await children.close(rec.name));
