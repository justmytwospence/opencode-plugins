// Load smoke test: a scratch OpenCode 2 server loads every component from this checkout.
//
// Installs @opencode/cli into .smoke/ (once, through npm, so the release-age policy applies),
// points isolated XDG directories at .smoke/home so the live configuration and data are never
// touched, lists every component directory under `plugins`, starts `opencode serve`, and polls
// the plugin list until every component's server half is active. Components without a server
// half (CLI-only) are skipped here. `--tui` instead opens the TUI in a detached tmux session,
// opens /plugins, and fails when a plugin failed or a component's CLI half is missing;
// `--keep` leaves that session running for a look.
//
//   node scripts/smoke.mjs [component ...] [--tui [--keep]]
//   OPENCODE2_VERSION=2.0.24 (default) picks the scratch release.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const smoke = join(root, '.smoke');
const version = process.env.OPENCODE2_VERSION ?? '2.0.24';
const args = process.argv.slice(2);
const tui = args.includes('--tui');
const only = args.filter(a => !a.startsWith('--'));

const components = readdirSync(join(root, 'packages'), { withFileTypes: true })
  .filter(e => e.isDirectory() && (only.length === 0 || only.includes(e.name)))
  .map(e => ({ name: e.name, dir: realpathSync(join(root, 'packages', e.name)) }));
const server = components.filter(c => existsSync(join(c.dir, 'index.ts')));

const binary = join(smoke, 'node_modules', '@opencode', `cli-${process.platform}-${process.arch}`, 'bin', 'opencode');
if (!existsSync(binary)) {
  mkdirSync(smoke, { recursive: true });
  if (!existsSync(join(smoke, 'package.json'))) writeFileSync(join(smoke, 'package.json'), '{"private":true}\n');
  const install = spawnSync('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', `@opencode/cli@${version}`], { cwd: smoke, stdio: 'inherit' });
  if (install.status !== 0 || !existsSync(binary)) throw new Error(`could not install @opencode/cli@${version} into .smoke/`);
}
if (args.includes('--install-only')) process.exit(0);

const home = join(smoke, 'home');
const project = join(smoke, 'project');
for (const dir of ['config/opencode', 'data', 'state', 'cache']) mkdirSync(join(home, dir), { recursive: true });
mkdirSync(project, { recursive: true });
if (!existsSync(join(project, '.git'))) spawnSync('git', ['init', '-q'], { cwd: project });
writeFileSync(join(home, 'config/opencode/opencode.json'), JSON.stringify({ plugins: components.map(c => c.dir) }, null, 2));

const env = {
  ...process.env,
  XDG_CONFIG_HOME: join(home, 'config'),
  XDG_DATA_HOME: join(home, 'data'),
  XDG_STATE_HOME: join(home, 'state'),
  XDG_CACHE_HOME: join(home, 'cache'),
  OPENCODE_PASSWORD: 'smoke',
};

if (tui) {
  const session = 'opencode-plugins-smoke';
  const tmux = (...a) => spawnSync('tmux', ['-L', session, ...a], { encoding: 'utf8' });
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  tmux('kill-server');
  tmux('new-session', '-d', '-s', session, '-x', '200', '-y', '60',
    'env', ...Object.entries(env).filter(([k]) => k.startsWith('XDG_')).map(([k, v]) => `${k}=${v}`), binary, '--standalone', realpathSync(project));
  await sleep(15_000);
  tmux('send-keys', '-t', session, '/plugins');
  await sleep(1_000);
  tmux('send-keys', '-t', session, 'Enter');
  await sleep(2_000);
  const screen = tmux('capture-pane', '-p', '-t', session).stdout;
  const lines = screen.split('\n').map(l => l.trim()).filter(Boolean);
  const start = lines.findIndex(l => l.startsWith('Plugins'));
  const listed = lines.slice(start, lines.findIndex((l, i) => i > start && l.startsWith('ctrl+a')) + 1);
  console.log(listed.join('\n'));
  const expected = components.filter(c => existsSync(join(c.dir, 'tui.ts'))).map(c => `${c.name.replace(/^opencode-/, '')}.tui`);
  const missing = expected.filter(id => !listed.some(l => l.split(/\s+/).includes(id)));
  const failures = listed.filter(l => /failed/.test(l));
  if (process.argv.includes('--keep')) console.log(`TUI running: tmux -L ${session} attach -t ${session}   (kill with tmux -L ${session} kill-server)`);
  else tmux('kill-server');
  if (missing.length) console.error(`missing CLI halves: ${missing.join(', ')}`);
  if (failures.length) console.error(`failed: ${failures.join(' | ')} (open with --keep, select it, Enter shows the error)`);
  console.log(missing.length || failures.length ? 'FAIL' : `PASS ${expected.length} CLI halves loaded in OpenCode ${version}`);
  process.exit(missing.length || failures.length ? 1 : 0);
}

const port = await new Promise(res => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
const child = spawn(binary, ['serve', '--port', String(port)], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
child.stdout.on('data', d => { log += d; });
child.stderr.on('data', d => { log += d; });

async function list() {
  const res = await fetch(`http://127.0.0.1:${port}/api/plugin`, {
    headers: { authorization: `Basic ${Buffer.from('opencode:smoke').toString('base64')}`, 'x-opencode-directory': realpathSync(project) },
  }).catch(() => undefined);
  if (!res?.ok) return undefined;
  return (await res.json()).data.filter(p => p.source?.type !== 'builtin');
}

let plugins;
const deadline = Date.now() + 60_000;
while (Date.now() < deadline) {
  plugins = await list();
  if (plugins && plugins.length >= server.length) break;
  await new Promise(r => setTimeout(r, 1000));
}
child.kill();

if (!plugins) {
  console.error(`server did not answer on port ${port}\n${log.slice(-4000)}`);
  process.exit(1);
}
let failed = false;
for (const p of plugins) {
  const ok = p.state?.status === 'active';
  failed ||= !ok;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${p.id.padEnd(28)} ${p.source?.path ?? p.source?.target ?? ''} ${ok ? '' : JSON.stringify(p.state)}`);
}
if (plugins.length < server.length) {
  failed = true;
  console.error(`expected ${server.length} server plugins, found ${plugins.length}`);
}
console.log(failed ? 'FAIL' : `PASS ${plugins.length} server plugins active in OpenCode ${version}`);
process.exitCode = failed ? 1 : 0;
