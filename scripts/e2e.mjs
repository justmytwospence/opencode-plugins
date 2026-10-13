// End-to-end run: a scratch OpenCode 2 (see smoke.mjs; isolated XDG directories under .smoke/)
// with the given components loaded and a scripted Anthropic-compatible mock provider, runs one
// prompt with `opencode run --standalone`, and prints the run's output, the plugin log lines and
// what reached the provider. Jev calls go to the mock too (TYPESAFE_ENDPOINT), unless --live-jev,
// which uses your TYPESAFE_API_KEY and costs money; never use it without authorization.
//
//   node scripts/e2e.mjs [component ...] [--script script.json] [--variant high] [--json]
//                        [--config extra.json] [--live-jev] -- <prompt>
//
// The built-in `anthropic` provider is pointed at the mock (its catalog model
// anthropic/claude-opus-4-6 by default: variants low, medium, high, max, E2E_MODEL to change), so provider-specific code paths
// run as they would against Anthropic. Requests land in
// .smoke/runs/e2e-<pid>/requests.jsonl (or --dir); `--json` prints them in full instead of a summary.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODEL = process.env.E2E_MODEL ?? 'anthropic/claude-opus-4-6';
const smoke = join(root, '.smoke');
// Each run gets its own directory (kept for inspection; .smoke/ is gitignored), so parallel runs
// never collide. --dir picks it.
const e2e = process.argv.includes('--dir') ? resolve(process.argv[process.argv.indexOf('--dir') + 1]) : join(smoke, 'runs', `e2e-${process.pid}`);
const dash = process.argv.indexOf('--');
const args = dash >= 0 ? process.argv.slice(2, dash) : process.argv.slice(2);
const prompt = dash >= 0 ? process.argv.slice(dash + 1).join(' ') : 'say hello';
const opt = name => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const flags = new Set(['--script', '--variant', '--config', '--dir']);
const only = args.filter((a, i) => !a.startsWith('--') && !flags.has(args[i - 1]));

const binary = join(smoke, 'node_modules', '@opencode', `cli-${process.platform}-${process.arch}`, 'bin', 'opencode');
if (!existsSync(binary)) {
  const r = spawnSync('node', [join(root, 'scripts/smoke.mjs'), '--install-only'], { stdio: 'inherit' });
  if (r.status !== 0 || !existsSync(binary)) throw new Error('run node scripts/smoke.mjs once to install the scratch OpenCode');
}

const components = readdirSync(join(root, 'packages'), { withFileTypes: true })
  .filter(e => e.isDirectory() && only.includes(e.name))
  .map(e => realpathSync(join(root, 'packages', e.name)));

rmSync(e2e, { recursive: true, force: true });
const home = join(e2e, 'home');
const project = join(e2e, 'project');
for (const dir of ['config/opencode', 'data', 'state', 'cache']) mkdirSync(join(home, dir), { recursive: true });
mkdirSync(project, { recursive: true });
spawnSync('git', ['init', '-q'], { cwd: project });
writeFileSync(join(project, 'README.md'), '# scratch project\n');
spawnSync('git', ['add', '-A'], { cwd: project });
spawnSync('git', ['-c', 'user.email=e2e@local', '-c', 'user.name=e2e', 'commit', '-qm', 'init'], { cwd: project });

const requests = join(e2e, 'requests.jsonl');
const mock = spawn('node', [join(root, 'scripts/mock-anthropic.mjs'), '--log', requests, ...(opt('script') ? ['--script', resolve(opt('script'))] : [])], { stdio: ['ignore', 'pipe', 'inherit'] });
const port = await new Promise((res, rej) => {
  mock.stdout.on('data', d => { const m = /listening (\d+)/.exec(String(d)); if (m) res(Number(m[1])); });
  mock.on('exit', code => rej(new Error(`mock exited ${code}`)));
});

const config = {
  $schema: 'https://opencode.ai/config.json',
  plugins: components,
  model: MODEL,
  providers: {
    anthropic: {
      settings: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'mock-key' },
    },
  },
  ...(opt('config') ? JSON.parse(readFileSync(resolve(opt('config')), 'utf8')) : {}),
};
writeFileSync(join(home, 'config/opencode/opencode.json'), JSON.stringify(config, null, 2));

const env = {
  ...process.env,
  // Jev goes to the mock unless --live-jev (paid) is given.
  ...(args.includes('--live-jev') ? {} : { TYPESAFE_ENDPOINT: `http://127.0.0.1:${port}/v1/systemone`, TYPESAFE_API_KEY: 'mock-jev' }),
  PWD: realpathSync(project),
  XDG_CONFIG_HOME: join(home, 'config'),
  XDG_DATA_HOME: join(home, 'data'),
  XDG_STATE_HOME: join(home, 'state'),
  XDG_CACHE_HOME: join(home, 'cache'),
};
const model = `${MODEL}${opt('variant') ? `#${opt('variant')}` : ''}`;
const run = spawnSync(binary, ['run', '--standalone', '--auto', '--print-logs', '--model', model, prompt], {
  cwd: realpathSync(project), env, encoding: 'utf8', timeout: 120_000,
});
mock.kill();

const logs = (run.stderr ?? '').split('\n');
console.log('=== output');
console.log((run.stdout ?? '').trim());
console.log('=== plugin and error log lines');
for (const line of logs) {
  if (/level=(WARN|ERROR)|plugin|^\[/.test(line) && !/watcher|spawning process/.test(line)) console.log(line.slice(0, 400));
}
console.log('=== provider requests');
const lines = existsSync(requests) ? readFileSync(requests, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
for (const r of lines) {
  if (args.includes('--json')) { console.log(JSON.stringify(r, null, 2)); continue; }
  const b = r.body ?? {};
  const keys = Object.keys(b).filter(k => !['messages', 'system', 'tools'].includes(k));
  console.log(`${r.method} ${r.path} messages=${b.messages?.length ?? 0} tools=${b.tools?.length ?? 0} ${keys.map(k => `${k}=${JSON.stringify(b[k])}`).join(' ')}`);
}
console.log(`exit ${run.status}${run.error ? ` (${run.error.message})` : ''}   run directory: ${e2e}`);
process.exitCode = run.status ?? 1;
