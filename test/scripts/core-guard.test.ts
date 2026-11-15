import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CORE_GUARD_MESSAGE } from '../../lib/cli/text.js';

const GUARD = resolve(import.meta.dirname, '../../scripts/core-guard.mjs');

let repo: string;

function git(...args: string[]): string {
  const run = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`);
  return run.stdout;
}

function write(path: string, body: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), body);
}

function guard(base: string) {
  return spawnSync('node', [GUARD, base], { cwd: repo, encoding: 'utf8' });
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'core-guard-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  write('.github/core-paths.txt', '# core\nsrc/wire\n');
  write('src/wire/a.ts', 'export const a = 1;\n');
  write('lib/x.ts', 'export const x = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'Start');
  git('switch', '-q', '-c', 'topic');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('core-guard', () => {
  it('fails a branch that changes a core file and names it', () => {
    write('src/wire/a.ts', 'export const a = 2;\n');
    git('commit', '-q', '-am', 'Change the core');
    const run = guard('main');
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('src/wire/a.ts');
    expect(run.stdout).toContain(CORE_GUARD_MESSAGE);
  });

  it('passes a branch that changes only the public layers', () => {
    write('lib/x.ts', 'export const x = 2;\n');
    git('commit', '-q', '-am', 'Change lib');
    const run = guard('main');
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('');
  });

  it('fails a branch that moves a file out of the core', () => {
    git('mv', 'src/wire/a.ts', 'lib/a.ts');
    git('commit', '-q', '-m', 'Move a file');
    const run = guard('main');
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('src/wire/a.ts');
  });

  it('does not take a path that only starts with a core line', () => {
    write('src/wirex/b.ts', 'export const b = 1;\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'Add a file');
    expect(guard('main').status).toBe(0);
  });

  it('fails a branch that takes a line off the list and changes that path', () => {
    write('.github/core-paths.txt', '# core\n');
    write('src/wire/a.ts', 'export const a = 2;\n');
    git('commit', '-q', '-am', 'Change the list and the core');
    const run = guard('main');
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('src/wire/a.ts');
    expect(run.stdout).toContain('.github/core-paths.txt');
    expect(run.stdout).toContain(CORE_GUARD_MESSAGE);
  });

  it('fails a branch that changes only the list', () => {
    write('.github/core-paths.txt', '# core\nsrc/wire\nlib\n');
    git('commit', '-q', '-am', 'Change the list');
    const run = guard('main');
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('.github/core-paths.txt');
    expect(run.stdout).toContain(CORE_GUARD_MESSAGE);
  });

  it('exits 2 for a base ref that has no list', () => {
    git('switch', '-q', '--orphan', 'empty');
    git('commit', '-q', '--allow-empty', '-m', 'Empty');
    git('switch', '-q', 'topic');
    expect(guard('empty').status).toBe(2);
  });

  it('exits 2 without a base ref', () => {
    const run = spawnSync('node', [GUARD], { cwd: repo, encoding: 'utf8' });
    expect(run.status).toBe(2);
  });
});
