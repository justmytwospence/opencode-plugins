// Runs every component's own `npm run check` (typecheck + tests). Install each component's
// lockfile dependencies first (`npm ci` in its directory).
import { readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const only = process.argv.slice(2);
const components = readdirSync(resolve(root, 'packages'), { withFileTypes: true })
  .filter(entry => entry.isDirectory() && existsSync(resolve(root, 'packages', entry.name, 'package.json')))
  .map(entry => entry.name)
  .filter(name => only.length === 0 || only.includes(name))
  .sort();

let failed = false;
for (const name of components) {
  console.log(`\n=== ${name} ===`);
  const result = spawnSync('npm', ['run', 'check'], { cwd: resolve(root, 'packages', name), stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    console.error(`${name} failed`, result.error ?? result.status);
    failed = true;
  }
}
process.exitCode = failed ? 1 : 0;
