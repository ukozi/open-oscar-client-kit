import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

type Entry = { types: string; default: string };
type Pkg = {
  dependencies?: unknown;
  peerDependencies?: unknown;
  optionalDependencies?: unknown;
  exports: Record<string, Entry>;
  bin: Record<string, string>;
  files: string[];
  repository?: { type?: string; url?: string };
};

const root = resolve(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as Pkg;

describe('package.json', () => {
  it('has no runtime dependency', () => {
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.peerDependencies).toBeUndefined();
    expect(pkg.optionalDependencies).toBeUndefined();
  });

  it('exports the root and the core units', () => {
    expect(Object.keys(pkg.exports).sort()).toEqual(['.', './client', './model', './testing', './wire']);
  });

  it('points every export at a built file that imports', async () => {
    for (const entry of Object.values(pkg.exports)) {
      expect(existsSync(resolve(root, entry.types)), entry.types).toBe(true);
      expect(existsSync(resolve(root, entry.default)), entry.default).toBe(true);
      await import(pathToFileURL(resolve(root, entry.default)).href);
    }
    const main = await import(pathToFileURL(resolve(root, pkg.exports['.']?.default ?? '')).href);
    expect(typeof main.signOn).toBe('function');
    const testing = await import(pathToFileURL(resolve(root, pkg.exports['./testing']?.default ?? '')).href);
    expect(typeof testing.FakeOscarServer).toBe('function');
  });

  it('points bin at a built script with a node shebang', () => {
    const bins = Object.values(pkg.bin);
    expect(bins).toHaveLength(1);
    for (const bin of bins) {
      expect(readFileSync(resolve(root, bin), 'utf8').startsWith('#!/usr/bin/env node\n')).toBe(true);
    }
  });

  it('publishes only the built files, the docs and the notices', () => {
    expect(pkg.files).toEqual(['dist', 'docs', 'LICENSE', 'NOTICE', 'README.md']);
  });

  // npm provenance refuses a publish whose repository does not match the building repository.
  it('names the GitHub repository that builds it', () => {
    expect(pkg.repository).toEqual({ type: 'git', url: 'git+https://github.com/ukozi/open-oscar-client-kit.git' });
  });

  it('builds the vectors into dist', () => {
    expect(existsSync(resolve(root, 'dist/test/vectors/hand-session.json'))).toBe(true);
  });
});
