import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const api = resolve(root, 'docs/api');

function pages(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

beforeAll(() => {
  const run = spawnSync('pnpm', ['docs:api'], { cwd: root, encoding: 'utf8' });
  expect(run.status, run.stderr + run.stdout).toBe(0);
}, 300_000);

describe('docs:api', () => {
  it('writes the index page', () => {
    expect(existsSync(resolve(api, 'README.md'))).toBe(true);
  });

  it('documents signOn and its options', () => {
    const texts = pages(api).map((page) => readFileSync(page, 'utf8'));
    expect(texts.some((text) => text.includes('signOn') && text.includes('SignOnOptions'))).toBe(true);
  });

  it('lists the modules by their import paths', () => {
    const index = readFileSync(resolve(api, 'README.md'), 'utf8');
    for (const name of [
      'open-oscar-client-kit',
      'open-oscar-client-kit/client',
      'open-oscar-client-kit/model',
      'open-oscar-client-kit/wire',
      'open-oscar-client-kit/testing',
    ]) {
      expect(index, name).toContain(`[${name}]`);
    }
    expect(index).not.toMatch(/\[(lib|src\/\w+|test\/fake)\]/);
  });

  it('has a page for each link from a written page into the reference', () => {
    const written = pages(resolve(root, 'docs')).filter((page) => page.endsWith('.md') && !page.startsWith(`${api}/`));
    const broken = written.flatMap((page) =>
      [...readFileSync(page, 'utf8').matchAll(/\]\(([^)\s#]+\.md)(?:#[^)]*)?\)/g)]
        .map((match) => resolve(dirname(page), match[1] ?? ''))
        .filter((target) => target.startsWith(`${api}/`) && !existsSync(target))
        .map((target) => `${relative(root, page)} -> ${relative(root, target)}`),
    );
    expect(broken).toEqual([]);
  });

  it('warns of no type that is used and not exported', () => {
    const run = spawnSync('pnpm', ['docs:api'], { cwd: root, encoding: 'utf8' });
    expect(run.stdout + run.stderr).not.toMatch(/referenced .* but not included/);
  }, 300_000);
});
