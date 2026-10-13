// Manual chain check of both halves against a fake herdr (not part of `npm test`; needs the
// suite's scratch OpenCode from `node scripts/smoke.mjs --install-only` and tmux):
//
//   node --experimental-strip-types test/live-chain.mts
//
// Starts a fake herdr socket that answers like herdr and logs every call, a scratch shared
// `opencode serve` with this component loaded (isolated XDG directories under .smoke/) and the
// suite's scripted Anthropic mock, then a TUI in tmux attached to that server with the herdr
// environment (HERDR_ENV, the fake socket, a pane id) on a parent session. Then:
//   1. the CLI half reports the pane's presentation and attaches the session;
//   2. a `herdr` RPC `token` call over HTTP reaches the pane through the CLI half;
//   3. a prompt makes the model call herdr_child spawn: the server half creates the child's
//      session with the parent's model, the fake herdr gets tab.create/agent.start --session
//      <id>/agent.prompt, and the pane gets `bg`;
//   4. the child's session answers PONG (a prompt through the API, answered by the mock), the
//      fake herdr reports the turn done, and the reply arrives in the parent as a prompt.
// Prints each step and PASS/FAIL, then cleans up (the run directory stays for inspection).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { createServer as tcp } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const component = realpathSync(path.join(here, ".."));
const root = realpathSync(path.join(component, "..", ".."));
const smoke = path.join(root, ".smoke");
const binary = path.join(smoke, "node_modules", "@opencode", `cli-${process.platform}-${process.arch}`, "bin", "opencode");
if (!existsSync(binary)) throw new Error("run `node scripts/smoke.mjs --install-only` from the repo root first");
const run = path.join(smoke, "runs", `chain-${process.pid}`);
rmSync(run, { recursive: true, force: true });
const home = path.join(run, "home");
const project = path.join(run, "project");
for (const d of ["config/opencode", "data", "state", "cache"]) mkdirSync(path.join(home, d), { recursive: true });
mkdirSync(project, { recursive: true });
spawnSync("git", ["init", "-q"], { cwd: project });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise<number>((res) => { const s = tcp(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); });

// 1. The fake herdr.
const sock = path.join(run, "herdr.sock");
const calls: { method: string; params: Record<string, any> }[] = [];
const agent: Record<string, unknown> = { agent: "opencode", interactive_ready: true, agent_status: "idle", completion_seq: 1, state_change_seq: 1 };
const herdr = net.createServer((c) => {
  let buf = "";
  c.on("data", (d) => {
    buf += d.toString();
    let end: number;
    while ((end = buf.indexOf("\n")) >= 0) {
      const req = JSON.parse(buf.slice(0, end));
      buf = buf.slice(end + 1);
      calls.push({ method: req.method, params: req.params });
      const p = req.params ?? {};
      const result =
        req.method === "pane.get" ? { pane: { pane_id: p.pane_id, workspace_id: "w1", focused: false } }
        : req.method === "pane.layout" ? { layout: { zoomed: false, panes: [{ pane_id: "w1:p1", rect: { width: 200, height: 50 } }] } }
        : req.method === "agent.list" ? { agents: [] }
        : req.method === "tab.create" ? { tab: { tab_id: "w1:t2" }, root_pane: { pane_id: "w1:p2" } }
        : req.method === "agent.start" || req.method === "agent.get" ? { agent: { ...agent, pane_id: "w1:p2" } }
        : {};
      c.write(`${JSON.stringify({ id: req.id, result })}\n`);
    }
  });
});
await new Promise<void>((r) => herdr.listen(sock, r));
const of = (method: string) => calls.filter((c) => c.method === method);
const waitFor = async (what: string, test: () => boolean, ms = 30_000) => {
  const deadline = Date.now() + ms;
  while (!test()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
  console.log(`ok   ${what}`);
};

// 2. The mock provider: parent turn -> herdr_child spawn, then text; child turn -> PONG (its title
// request, in either order, gets PONG too); reply turn -> text. The parent has a title already.
const script = path.join(run, "script.json");
writeFileSync(script, JSON.stringify({ model: [
  { tool: "herdr_child", input: { action: "spawn", task: "Reply with exactly PONG.", name: "pong" } },
  { text: "Started the child." },
  { text: "PONG" },
  { text: "PONG" },
  { text: "Thanks, child." },
] }));
const log = path.join(run, "requests.jsonl");
const mock = spawn("node", [path.join(root, "scripts/mock-anthropic.mjs"), "--log", log, "--script", script], { stdio: ["ignore", "pipe", "inherit"] });
const mockPort = await new Promise<number>((res) => mock.stdout.on("data", (d) => { const m = /listening (\d+)/.exec(String(d)); if (m) res(Number(m[1])); }));

// 3. The scratch shared server with the component.
const port = await freePort();
writeFileSync(path.join(home, "config/opencode/opencode.json"), JSON.stringify({
  plugins: [component],
  model: "anthropic/claude-opus-4-6",
  providers: { anthropic: { settings: { baseURL: `http://127.0.0.1:${mockPort}/v1`, apiKey: "mock-key" } } },
  permissions: { "*": "allow" },
}, null, 2));
const env = {
  ...process.env,
  XDG_CONFIG_HOME: path.join(home, "config"), XDG_DATA_HOME: path.join(home, "data"), XDG_STATE_HOME: path.join(home, "state"), XDG_CACHE_HOME: path.join(home, "cache"),
  OPENCODE_PASSWORD: "smoke",
};
const server = spawn(binary, ["serve", "--port", String(port)], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = "";
server.stdout.on("data", (d) => { serverLog += d; });
server.stderr.on("data", (d) => { serverLog += d; });
const api = async (method: string, route: string, body?: unknown) => {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: { authorization: `Basic ${Buffer.from("opencode:smoke").toString("base64")}`, "x-opencode-directory": project, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${route}: ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : undefined;
};
{
  const deadline = Date.now() + 60_000;
  for (;;) {
    const r = await api("GET", "/api/plugin").catch(() => undefined);
    if (r?.data?.some((p: any) => p.id === "herdr" && p.state?.status === "active")) break;
    if (Date.now() > deadline) throw new Error(`server half not active\n${serverLog.slice(-3000)}`);
    await sleep(500);
  }
  console.log("ok   server half active");
}

const session = `opencode-herdr-chain-${process.pid}`;
const tmux = (...a: string[]) => spawnSync("tmux", ["-L", session, ...a], { encoding: "utf8" });
let failed = false;
try {
  // 4. The parent session, shown by a TUI inside the "herdr pane".
  const parent = (await api("POST", "/api/session", { title: "chain parent", location: { directory: project } })).data ?? (await api("GET", "/api/session")).data[0];
  const parentID: string = parent.id;
  console.log("ok   parent session", parentID);
  tmux("kill-server");
  const paneEnv = [`HERDR_ENV=1`, `HERDR_SOCKET_PATH=${sock}`, `HERDR_PANE_ID=w1:p1`, `OPENCODE_PASSWORD=smoke`, `PI_HERDR_PR=0`, ...Object.entries(env).filter(([k]) => k.startsWith("XDG_")).map(([k, v]) => `${k}=${v}`)];
  tmux("new-session", "-d", "-s", session, "-x", "200", "-y", "50", "env", ...paneEnv, binary, "--server", `http://127.0.0.1:${port}`, "--session", parentID, project);
  await waitFor("the CLI half reports the pane's presentation", () => of("pane.report_metadata").some((c) => c.params.source === "opencode-herdr:tui" && c.params.display_agent?.startsWith("opencode")), 60_000);

  // 5. A token through the public RPC reaches the pane.
  await api("POST", `/api/rpc/herdr/token`, { input: { sessionID: parentID, key: "nb", value: "notebook", ttlMs: 60000 } });
  await waitFor("a `token` RPC call shows on the pane", () => of("pane.report_metadata").some((c) => c.params.tokens?.nb === "notebook"));
  const state = (await api("POST", `/api/rpc/herdr/state`, { input: { sessionID: parentID } }))?.output;
  if (!state?.tokens?.some((t: any) => t.key === "nb")) throw new Error(`state lacks the token: ${JSON.stringify(state)}`);
  console.log("ok   state returns it");

  // 6. herdr_child spawn from the parent's turn.
  await api("POST", `/api/session/${parentID}/prompt`, { text: "Start a herdr child that replies PONG." });
  await waitFor("agent.start --session <child> in the new tab", () => of("agent.start").some((c) => c.params.kind === "opencode" && c.params.args?.[0] === "--session" && c.params.pane_id === "w1:p2"), 90_000);
  const childID: string = of("agent.start")[0]!.params.args[1];
  const child = await api("GET", `/api/session/${childID}`);
  const model = child.data?.model ?? child.model;
  if (model?.providerID !== "anthropic" || model?.id !== "claude-opus-4-6") throw new Error(`child session model: ${JSON.stringify(model)}`);
  console.log("ok   child session", childID, "with the parent's model");
  await waitFor("the task prompt reaches the child's pane", () => of("agent.prompt").some((c) => /^\[You are a child opencode session/u.test(c.params.text) && c.params.text.endsWith("Reply with exactly PONG.")));
  await waitFor("the pane shows `bg` = child pong", () => of("pane.report_metadata").some((c) => c.params.tokens?.bg === "child pong"));

  // 7. The child answers (through the API, as the TUI in its pane would), herdr reports the turn done.
  agent.agent_status = "working";
  await api("POST", `/api/session/${childID}/prompt`, { text: "Reply with exactly PONG." });
  {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const ctx = await api("GET", `/api/session/${childID}/context`).catch(() => undefined);
      const msgs = ctx?.data ?? [];
      if (msgs.some((m: any) => m.type === "assistant" && m.content?.some((p: any) => p.type === "text" && /PONG/.test(p.text)))) break;
      if (Date.now() > deadline) throw new Error("the child never replied PONG");
      await sleep(500);
    }
    console.log("ok   the child replied PONG");
  }
  agent.agent_status = "done";
  agent.completion_seq = 2;
  {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const ctx = await api("GET", `/api/session/${parentID}/context`).catch(() => undefined);
      const msgs = ctx?.data ?? [];
      if (msgs.some((m: any) => m.type === "user" && /Herdr child "pong" \(tab, pane w1:p2\) replied:\n\nPONG/.test(m.text))) break;
      if (Date.now() > deadline) throw new Error(`the reply never reached the parent; parent messages: ${JSON.stringify(msgs.map((m: any) => [m.type, m.text ?? m.content]))}`);
      await sleep(500);
    }
    console.log("ok   the reply arrived in the parent session as a prompt");
  }
  await waitFor("the pane's `bg` cleared", () => { const last = of("pane.report_metadata").filter((c) => c.params.tokens && "bg" in c.params.tokens).at(-1); return last?.params.tokens.bg === null; });
} catch (e) {
  failed = true;
  console.error(`FAIL ${(e as Error).message}`);
  console.error(`herdr calls: ${JSON.stringify(calls.map((c) => [c.method, c.params.tokens ?? c.params.args ?? c.params.display_agent ?? ""]), null, 0).slice(0, 3000)}`);
  console.error(serverLog.split("\n").filter((l) => /\[herdr\]|ERROR/.test(l)).slice(-20).join("\n"));
} finally {
  tmux("kill-server");
  server.kill();
  mock.kill();
  herdr.close();
}
console.log(failed ? "FAIL" : "PASS", `run directory: ${run}`);
process.exit(failed ? 1 : 0);
