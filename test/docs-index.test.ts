import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const docs = resolve(root, 'docs');
const api = resolve(docs, 'api');

type Page = { slug: string; title: string; file: string; generated?: true };
type Index = { version: number; sections: { title: string; pages: Page[] }[] };

const index = JSON.parse(readFileSync(resolve(docs, 'index.json'), 'utf8')) as Index;
const pages = index.sections.flatMap((section) => section.pages);

// Inline links `[text](url)` and reference definitions `[label]: url`.
const LINK = /\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)|^\s*\[[^\]]+\]:\s*<?(\S+?)>?(?:\s+"[^"]*")?\s*$/gm;

// docs/api is generated and not in git.
function written(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return path === api ? [] : written(path);
    return entry.isFile() && entry.name.endsWith('.md') ? [path] : [];
  });
}

function localLinks(file: string): string[] {
  return [...readFileSync(file, 'utf8').matchAll(LINK)]
    .map((match) => match[1] ?? match[2] ?? '')
    .filter((url) => !/^[a-z]+:/i.test(url) && !url.startsWith('#'))
    .map((url) => url.split('#')[0] ?? '')
    .filter((url) => url.endsWith('.md'));
}

describe('docs/index.json', () => {
  it('names a file that exists for each page, or marks the page generated', () => {
    const missing = pages.filter((page) => page.generated !== true && !existsSync(resolve(docs, page.file)));
    expect(missing).toEqual([]);
  });

  it('lists each written page one time', () => {
    const listed = pages.map((page) => page.file).sort();
    expect(new Set(listed).size).toBe(listed.length);
    const files = written(docs).map((file) => relative(docs, file).split('\\').join('/'));
    expect(listed.filter((file) => !file.startsWith('api/'))).toEqual(files.sort());
  });

  it('gives each page its own slug in lower case', () => {
    const slugs = pages.map((page) => page.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) expect(slug).toMatch(/^[a-z0-9-]+(\/[a-z0-9-]+)*$/);
  });

  it('has a listed target for each relative link of each page', () => {
    const listed = new Set(pages.map((page) => resolve(docs, page.file)));
    const broken = written(docs).flatMap((file) =>
      localLinks(file)
        .map((url) => resolve(dirname(file), url))
        .filter((target) => !listed.has(target) && !target.startsWith(`${api}/`))
        .map((target) => `${relative(root, file)} -> ${relative(docs, target)}`),
    );
    expect(broken).toEqual([]);
  });
});
