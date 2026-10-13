// Suite contracts every component keeps, whatever it does: suite metadata, its own license,
// runtime independence from siblings (each installs alone through a `::path:` Git spec), unique
// plugin ids, and the helper files deliberately kept as identical copies.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const components = readdirSync(resolve(root, 'packages'), { withFileTypes: true })
  .filter(entry => entry.isDirectory() && existsSync(resolve(root, 'packages', entry.name, 'package.json')))
  .map(entry => entry.name)
  .sort();

// Helper copies that must not drift. A component that diverges on purpose leaves its group.
const identical = [
  ['opencode-auto-effort', 'opencode-copy', 'opencode-next-prompt', 'opencode-tool-gate'].map(p => `packages/${p}/src/jev.ts`),
  ['opencode-auto-effort', 'opencode-copy', 'opencode-next-prompt', 'opencode-tool-gate'].map(p => `packages/${p}/src/settings.ts`),
  ['opencode-auto-effort', 'opencode-status-footer'].map(p => `packages/${p}/src/limits.ts`),
  ['opencode-bg', 'opencode-cache-guard', 'opencode-herdr', 'opencode-marimo'].map(p => `packages/${p}/src/herdr-rpc.ts`),
];
for (const group of identical) {
  const expected = readFileSync(resolve(root, group[0]), 'utf8');
  for (const file of group.slice(1)) {
    assert.equal(readFileSync(resolve(root, file), 'utf8'), expected, `intentional helper copy drift: ${file} (vs ${group[0]})`);
  }
}

function* sources(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (!['node_modules', '.git', 'test', 'tests'].includes(entry.name)) yield* sources(path);
    } else if (/\.(?:ts|tsx|js|mjs)$/.test(entry.name)) yield path;
  }
}

const ids = new Map();
for (const name of components) {
  const component = resolve(root, 'packages', name);
  const pkg = JSON.parse(readFileSync(resolve(component, 'package.json'), 'utf8'));
  assert.equal(pkg.name, name, `${name}: package name matches its directory`);
  assert(existsSync(resolve(component, 'LICENSE')), `${name} keeps its license`);
  assert(existsSync(resolve(component, 'README.md')), `${name} has a README`);
  assert.equal(pkg.version, manifest.version, `${name} must use the suite version`);
  assert.equal(pkg.repository?.url, manifest.repository.url, `${name} repository metadata`);
  assert.equal(pkg.repository?.directory, `packages/${name}`, `${name} repository directory`);
  assert(pkg.exports && Object.keys(pkg.exports).length > 0, `${name} exports an entry point`);

  for (const file of sources(resolve(component, 'src'))) {
    const code = readFileSync(file, 'utf8');
    for (const match of code.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g)) {
      const spec = match[1];
      if (spec.startsWith('.')) {
        const dest = resolve(dirname(file), spec);
        assert(!relative(component, dest).startsWith('..'), `${name} imports a sibling at runtime: ${relative(root, file)} -> ${spec}`);
      }
      assert(!/^opencode-[a-z-]+(\/|$)/.test(spec) || spec.startsWith(`${name}/`), `${name} imports another component package: ${spec}`);
    }
    // Plugin ids: Plugin.define({ id: "..." }) must be unique across the suite.
    for (const match of code.matchAll(/Plugin\.define\(\s*\{\s*id:\s*["']([^"']+)["']/g)) {
      const owner = ids.get(match[1]);
      assert(!owner || owner === `${name}:${relative(component, file)}`, `duplicate plugin id ${match[1]} in ${name} and ${owner}`);
      ids.set(match[1], `${name}:${relative(component, file)}`);
    }
  }

  const lockPath = resolve(component, 'package-lock.json');
  if (existsSync(lockPath)) {
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    assert.equal(lock.packages?.['']?.version, manifest.version, `${name} lock root version`);
  }
}

const catalog = resolve(root, 'site/src/data/plugins.mjs');
if (existsSync(catalog)) {
  const { plugins } = await import(catalog);
  assert.deepEqual(new Set(plugins.map(p => p.name)), new Set(components), 'public catalog matches packages/');
}
console.log(`PASS ${components.length} components: metadata, licenses, runtime independence, unique ids, helper parity${existsSync(catalog) ? ', catalog' : ''}`);
