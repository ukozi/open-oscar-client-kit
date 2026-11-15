import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { KIT_UNITS, specifiers, violations } from './import-boundary.js';
import type { KitUnit } from './import-boundary.js';
import { toPosix } from '../support/platform.js';

const src = fileURLToPath(new URL('../../src/', import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && /\.(ts|tsx)$/.test(e.name))
    .map((e) => join(e.parentPath, e.name));
}

describe('import rule', () => {
  const rows: [KitUnit, string, string, number][] = [
    ['wire', 'src/wire/a.ts', "import net from 'node:net';\nimport { x } from './bytes.js';", 0],
    ['wire', 'src/wire/a.ts', "import { x } from '../client/errors.js';", 1],
    ['wire', 'src/wire/a.ts', "import { x } from '../model/rich-text.js';", 1],
    ['wire', 'src/wire/a.ts', "import { x } from './bytes';", 1],
    ['wire', 'src/wire/a.ts', "import { z } from 'zod';", 1],
    ['client', 'src/client/a.ts', "import { x } from '../wire/tlv.js';\nimport type { R } from '../model/rich-text.js';\nimport { randomBytes } from 'node:crypto';", 0],
    ['client', 'src/client/a.ts', "import { app } from 'electron';", 1],
    ['client', 'src/client/a.ts', "import { h } from '../../test/fake/harness.js';", 1],
    ['client', 'src/client/a.ts', "const s = \"import x from 'electron'\";", 0],
    ['model', 'src/model/a.ts', "import type { R } from './rich-text.js';", 0],
    ['model', 'src/model/a.ts', "import { x } from 'node:util';", 1],
    ['model', 'src/model/a.ts', "import { x } from '../wire/text.js';", 1],
    ['model', 'src/model/a.ts', "import { x } from '../client/errors.js';", 1],
    ['model', 'src/model/a.ts', "// import fs from 'node:fs'\nexport const a = 1;", 0],
  ];
  it.each(rows)('%s: %s importing %j has %i violations', (unit, file, source, count) => {
    expect(violations(unit, file, source)).toHaveLength(count);
  });
  it('names an unclosed template as the reason a file could not be scanned', () => {
    expect(violations('client', 'src/client/a.ts', "const a = `press now;\nimport { app } from 'electron';")).toEqual([
      'unterminated template or comment: client file could not be scanned to its end',
    ]);
  });
  it('src imports no Node built-in but node:net, node:tls, node:crypto and node:fs/promises', () => {
    const used = new Set(sources(src).flatMap((f) => specifiers(readFileSync(f, 'utf8'))).filter((s) => s.startsWith('node:')));
    expect(used).toContain('node:net');
    expect([...used].filter((s) => !['node:net', 'node:tls', 'node:crypto', 'node:fs/promises'].includes(s))).toEqual([]);
  });
});

describe('every file under src/ keeps to its unit', () => {
  for (const unit of KIT_UNITS) {
    it(`src/${unit}`, () => {
      const files = sources(join(src, unit));
      expect(files.length).toBeGreaterThan(0);
      const found = files.flatMap((file) =>
        violations(unit, `src/${toPosix(relative(src, file))}`, readFileSync(file, 'utf8')).map((v) => `${relative(src, file)}: ${v}`),
      );
      expect(found).toEqual([]);
    });
  }
});
