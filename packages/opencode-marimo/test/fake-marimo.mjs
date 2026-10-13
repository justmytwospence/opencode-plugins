// A fake marimo server for end-to-end runs: one notebook session, its kiosk stream replayed from
// the recorded fixture, registered the way `marimo edit --no-token` registers itself (a JSON file
// under $XDG_STATE_HOME/marimo/servers) so the plugin finds it without a real marimo.
//
//   node test/fake-marimo.mjs --file /path/nb.py --registry <state>/marimo/servers [--upto N]
//
// The registry directory may not exist yet (e2e.mjs recreates its state directory): the file is
// written as soon as the directory's grandparent (<state>) exists. Prints `listening <port>`.
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const file = arg("file");
const registry = arg("registry");
const upto = Number(arg("upto", "0")) || undefined;
if (!file || !registry) throw new Error("--file and --registry are required");

const events = readFileSync(new URL("./fixtures/kiosk-run.sse", import.meta.url), "utf8")
  .split("\n\n")
  .filter((e) => e.trim())
  .slice(0, upto);

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/api/sessions") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ browser1: { path: file } }));
    return;
  }
  if (url.pathname === "/sse") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    for (const e of events) res.write(`${e}\n\n`);
    const keep = setInterval(() => res.write(": keep-alive\n\n"), 5000);
    req.on("close", () => clearInterval(keep));
    return;
  }
  if (url.pathname === "/health") {
    res.writeHead(200);
    res.end("ok");
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  console.log(`listening ${port}`);
  const state = dirname(dirname(registry));
  const entry = JSON.stringify({ pid: process.pid, host: "127.0.0.1", port, base_url: "", started_at: Date.now() / 1000 });
  const write = () => {
    if (!existsSync(state)) return false;
    mkdirSync(registry, { recursive: true });
    writeFileSync(join(registry, `${process.pid}.json`), entry);
    console.log(`registered ${join(registry, `${process.pid}.json`)}`);
    return true;
  };
  if (!write()) {
    const timer = setInterval(() => {
      if (write()) clearInterval(timer);
    }, 200);
  }
});
