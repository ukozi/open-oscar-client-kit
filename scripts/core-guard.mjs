import { execFileSync } from 'node:child_process';
import { CORE_GUARD_MESSAGE, CORE_GUARD_USAGE } from '../lib/cli/text.ts';

const base = process.argv[2];
if (base === undefined || process.argv.length > 3) {
  process.stderr.write(`${CORE_GUARD_USAGE}\n`);
  process.exit(2);
}

const LIST = '.github/core-paths.txt';

let list;
let diff;
try {
  // The list comes from the base ref, so a branch cannot change it.
  list = execFileSync('git', ['show', `${base}:${LIST}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  // Without rename detection, a move out of the core shows its old path.
  diff = execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', `${base}...HEAD`], { encoding: 'utf8' });
} catch {
  process.exit(2);
}

const core = list
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line !== '' && !line.startsWith('#'));
core.push(LIST);

const changed = diff
  .split('\0')
  .filter((path) => path !== '' && core.some((line) => path === line || path.startsWith(`${line}/`)));

if (changed.length > 0) {
  process.stdout.write(`${changed.join('\n')}\n\n${CORE_GUARD_MESSAGE}\n`);
  process.exit(1);
}
