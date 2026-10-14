import { readFile, readdir, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { plugins } from "../src/data/plugins.mjs";

const site = fileURLToPath(new URL("../", import.meta.url));
const root = path.resolve(site, "..");
const docs = path.join(site, "src/content/docs");
const repo = "https://github.com/justmytwospence/opencode-plugins";
const origin = "https://opencode-plugins.vercel.app";
const errors = [];
const fail = (message) => errors.push(message);
async function filesIn(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => entry.isDirectory() ? filesIn(path.join(dir, entry.name)) : path.join(dir, entry.name)))).flat();
}

// The suite is the set of component directories under packages/; the catalog must list exactly them.
const names = (await readdir(path.join(root, "packages"), { withFileTypes: true })).filter((entry) => entry.isDirectory() && entry.name.startsWith("opencode-")).map((entry) => entry.name).sort();
const catalog = plugins.map((plugin) => plugin.name).sort();
if (new Set(catalog).size !== catalog.length) fail("Duplicate plugin in catalog.");
if (JSON.stringify(names) !== JSON.stringify(catalog)) fail("Catalog does not match packages/: " + JSON.stringify({ packages: names, catalog }));

// A component with only a CLI half (no index.ts) is installed through cli.json, not opencode.jsonc.
const cliOnly = new Set();
for (const name of names) {
  try { await access(path.join(root, "packages", name, "index.ts")); } catch { cliOnly.add(name); }
}
const specFor = (name) => `${name}@github:justmytwospence/opencode-plugins#<commit>::path:packages/${name}`;
const specPattern = /"?(opencode-[\w-]+)@github:justmytwospence\/opencode-plugins#([^:"\s]+)::path:packages\/(opencode-[\w-]+)"?/g;

const paths = (await filesIn(docs)).filter((file) => /\.mdx?$/.test(file));
const routeFor = (file) => "/" + path.relative(docs, file).replaceAll(path.sep, "/").replace(/\.mdx?$/, "").replace(/(^|\/)index$/, "").replace(/\/$/, "") + "/";
const normalizedRoute = (route) => route.replace(/\/+/g, "/");
const routes = new Set(paths.map((file) => normalizedRoute(routeFor(file))));
const covered = new Set();

for (const file of paths) {
  const relative = path.relative(site, file);
  const raw = await readFile(file, "utf8");
  const front = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!front) { fail(relative + ": missing frontmatter."); continue; }
  let data;
  try { data = parse(front[1]); } catch (error) { fail(relative + ": invalid YAML: " + error.message); continue; }
  if (!data?.title || typeof data.title !== "string") fail(relative + ": missing title.");
  if (!data?.description || typeof data.description !== "string" || data.description.length < 30) fail(relative + ": missing useful description.");
  const body = raw.slice(front[0].length);
  if (data.plugin) {
    if (!names.includes(data.plugin)) fail(relative + ": unknown plugin " + data.plugin);
    if (covered.has(data.plugin)) fail(relative + ": duplicate plugin reference.");
    covered.add(data.plugin);
    if (path.basename(file, path.extname(file)) !== data.plugin) fail(relative + ": filename must match plugin.");
    if (!body.includes(specFor(data.plugin))) fail(relative + ": missing exact install entry " + specFor(data.plugin));
    const file_ = cliOnly.has(data.plugin) ? "cli.json" : "opencode.jsonc";
    if (!body.includes(file_)) fail(relative + ": a " + (cliOnly.has(data.plugin) ? "terminal-only" : "server") + " component is installed through " + file_ + ".");
    if ((body.match(/^## /gm) || []).length < 4) fail(relative + ": reference needs at least four sections.");
    if (body.split(/\s+/).length < 180) fail(relative + ": reference is too thin.");
    if (!/requirements|dependencies|costs/i.test(body)) fail(relative + ": spell out requirements/costs.");
    if (!body.includes(repo + "/tree/main/packages/" + data.plugin)) fail(relative + ": missing link to the component's source directory.");
  } else if (file.includes(path.sep + "plugins" + path.sep)) fail(relative + ": missing plugin frontmatter.");

  if (/\p{Extended_Pictographic}/u.test(body)) fail(relative + ": do not use emojis.");
  for (const spec of body.matchAll(specPattern)) {
    if (spec[1] !== spec[3]) fail(relative + ": install entry names " + spec[1] + " but selects packages/" + spec[3]);
    if (!names.includes(spec[3])) fail(relative + ": install entry for unknown component " + spec[3]);
    if (!/^(<commit>|[0-9a-f]{40})$/.test(spec[2])) fail(relative + ": pin a full commit hash or the <commit> placeholder, not " + spec[2]);
  }
  if (/\bpi (?:install|config|update|remove|list)\b|\bpi -e |all 26 (?:extensions|entries|plugins|components)|26 focused|tui\.jsonc?\b/i.test(body)) fail(relative + ": stale Pi or OpenCode 1 text.");
  // Plain ```json blocks must parse; ```jsonc blocks are fragments with comments and are not checked.
  for (const block of body.matchAll(/^```json[ \t]*\n([\s\S]*?)^```/gm)) {
    try { JSON.parse(block[1]); } catch (error) { fail(relative + ": invalid JSON example: " + error.message); }
  }

  // Fenced examples are not navigational links.
  const prose = body.replace(/^```[^\n]*\n[\s\S]*?^```/gm, "").replace(/^~~~[^\n]*\n[\s\S]*?^~~~/gm, "");
  for (const match of prose.matchAll(/\[[^\]\n]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
    const href = match[1];
    const source = href.match(new RegExp("^" + repo.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&") + "/(?:blob|tree)/main/([^#?]+)"));
    if (source) {
      try { await access(path.join(root, decodeURIComponent(source[1]))); }
      catch { fail(relative + ": missing repository source target " + href); }
    }
    if (href.startsWith("#") || /^(https?:|mailto:)/.test(href)) continue;
    const url = new URL(href, origin + normalizedRoute(routeFor(file)));
    const route = normalizedRoute(url.pathname.endsWith("/") ? url.pathname : url.pathname + "/");
    if (!routes.has(route)) {
      try { await access(path.join(site, "public", decodeURIComponent(url.pathname))); }
      catch { fail(relative + ": broken local link " + href); }
    }
  }
}
for (const name of names) if (!covered.has(name)) fail("Missing reference for " + name);
for (const required of ["/", "/guides/overview/", "/guides/install/", "/guides/releases/", "/guides/requirements/", "/guides/built-in/", "/guides/keyboard/", "/guides/troubleshooting/", "/recipes/background-work/", "/recipes/notebooks/", "/recipes/review-loop/", "/recipes/cache-cost/", "/development/", "/about/"]) {
  if (!routes.has(required)) fail("Missing required page: " + required);
}
if (errors.length) { console.error(errors.join("\n")); process.exitCode = 1; }
else console.log("PASS: " + paths.length + " authored pages; all " + covered.size + " components referenced (" + cliOnly.size + " terminal-only); frontmatter, JSON examples, install entries and source links checked. Rendered fragments are checked by npm run build.");
