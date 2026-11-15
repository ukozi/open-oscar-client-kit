import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { main } from '../../lib/cli/main.js';
import { SCENARIOS } from '../../suite/scenarios.js';
import { runSuite } from '../../suite/runner.js';

const KIT_DRIVER = ['node', 'dist/suite/kit-driver.js'];
const ORDER = [
  'sign-on',
  'wrong-password',
  'refused-login',
  'receive-im',
  'send-im',
  'buddy-list',
  'warning',
  'rate-limited',
  'burst',
  'reconnect',
  'server-sign-off',
  'sign-off',
];

describe('runSuite', () => {
  it('lists the scenarios in order', () => {
    expect(SCENARIOS.map((s) => s.name)).toEqual(ORDER);
  });

  it('passes every scenario with the driver of open-oscar-client-kit', async () => {
    const result = await runSuite({ driver: KIT_DRIVER });
    expect(result.results.map((r) => r.name)).toEqual(ORDER);
    expect(result.results.filter((r) => !r.ok)).toEqual([]);
  }, 300_000);

  it('runs only the named scenarios and reports each as it ends', async () => {
    const heard: string[] = [];
    const result = await runSuite({ driver: KIT_DRIVER, only: ['sign-on'], onResult: (r) => heard.push(r.name) });
    expect(result.results.map((r) => r.name)).toEqual(['sign-on']);
    expect(heard).toEqual(['sign-on']);
  });

  it('refuses a name it does not know', async () => {
    await expect(runSuite({ driver: KIT_DRIVER, only: ['nope'] })).rejects.toThrow('unknown scenario "nope"');
  });
});

describe('suite command', () => {
  it('writes the result as JSON and returns 0', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'suite-')), 'out.json');
    expect(await main(['suite', '--only', 'sign-on', '--json', file, '--', ...KIT_DRIVER])).toBe(0);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    expect(saved.results).toHaveLength(1);
    expect(saved.results[0]).toMatchObject({ name: 'sign-on', ok: true });
  });

  it('returns 2 without a driver command', async () => {
    expect(await main(['suite'])).toBe(2);
  });
});
