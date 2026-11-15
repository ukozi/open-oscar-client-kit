import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const docs = resolve(root, 'docs');
const server = 'github.com/mk6i/open-oscar-server';
// The commit the vectors cite. A link to a branch moves when the server changes.
const pinned = '/blob/7bdd674afc482d700cc733be7c0b86a51f65883a/';

// Inline links `[text](url)` and reference definitions `[label]: url`.
const LINK = /\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)|^\s*\[[^\]]+\]:\s*<?(\S+?)>?(?:\s+"[^"]*")?\s*$/gm;

// TypeDoc writes docs/api again while the tests run, and it has no authored links.
const generated = resolve(docs, 'api');

function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return path === generated ? [] : markdownFiles(path);
    return entry.isFile() && entry.name.endsWith('.md') ? [path] : [];
  });
}

function serverLinks(): { file: string; url: string }[] {
  return markdownFiles(docs).flatMap((file) =>
    [...readFileSync(file, 'utf8').matchAll(LINK)]
      .map((match) => match[1] ?? match[2] ?? '')
      .filter((url) => url.includes(server))
      .map((url) => ({ file: relative(root, file), url })),
  );
}

describe('links to the server source', () => {
  it('finds the links in the docs', () => {
    expect(serverLinks().length).toBeGreaterThan(0);
  });

  it('names the pinned commit in each link', () => {
    expect(serverLinks().filter(({ url }) => !url.includes(pinned))).toEqual([]);
  });
});
