import { normalizeScreenName } from '../src/model/screen-name.js';
import { FakeOscarServer } from '../test/fake/oscar-server.js';
import { buddyListFeedbag } from '../lib/feedbag.js';
import { VERSION } from '../lib/version.js';
import { DriverProcess } from './driver-process.js';
import { PROTOCOL_VERSION } from './protocol.js';
import { SCENARIOS } from './scenarios.js';
import type { Scenario, ScenarioContext } from './scenarios.js';
import * as text from './text.js';

export type ScenarioResult = { name: string; ok: boolean; reason?: string; ms: number };
export type SuiteResult = { suite: string; protocol: number; results: ScenarioResult[] };
export type RunSuiteOptions = {
  driver: string[];
  only?: string[];
  cwd?: string;
  onResult?: (result: ScenarioResult) => void;
};

const SCENARIO_LIMIT_MS = 60_000;
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

async function runOne(scenario: Scenario, driverCommand: string[], cwd: string | undefined): Promise<void> {
  // The rate monitor reports each clear, as a real server does.
  const fake = await FakeOscarServer.start({ rateMonitor: true });
  fake.addUser('Bot', 'botpass1');
  fake.setFeedbag(normalizeScreenName('Bot'), buddyListFeedbag([{ name: 'Buddies', buddies: ['Alice'] }]));
  const peer = fake.peer('Alice');
  peer.signOn();
  const server = { host: '127.0.0.1', port: fake.port };
  let driver: DriverProcess | undefined;
  let failure: unknown;
  let timer: NodeJS.Timeout | undefined;
  try {
    driver = DriverProcess.start(driverCommand, { cwd });
    const started = driver;
    const ctx: ScenarioContext = {
      fake,
      server,
      driver: started,
      peer,
      signOn: (password = 'botpass1') =>
        started.request({ op: 'signOn', ...server, screenName: 'Bot', password }),
    };
    const limitMs = scenario.limitMs ?? SCENARIO_LIMIT_MS;
    const limit = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(text.SCENARIO_TIMEOUT(limitMs))), limitMs);
    });
    await Promise.race([scenario.run(ctx), limit]);
  } catch (error) {
    failure = error;
  } finally {
    clearTimeout(timer);
  }
  const said = driver?.stderr().trim().split('\n')[0];
  await driver?.close();
  try {
    await fake.stop();
  } catch (error) {
    failure ??= new Error(text.FAULTS(messageOf(error)));
  }
  if (failure === undefined) return;
  const reason = messageOf(failure);
  throw new Error(said ? `${reason} (${text.DRIVER_SAID(said)})` : reason);
}

export async function runSuite(opts: RunSuiteOptions): Promise<SuiteResult> {
  for (const name of opts.only ?? []) {
    if (!SCENARIOS.some((s) => s.name === name)) throw new Error(text.UNKNOWN_SCENARIO(name));
  }
  const chosen = SCENARIOS.filter((s) => !opts.only || opts.only.includes(s.name));
  const results: ScenarioResult[] = [];
  for (const scenario of chosen) {
    const started = Date.now();
    let result: ScenarioResult;
    try {
      await runOne(scenario, opts.driver, opts.cwd);
      result = { name: scenario.name, ok: true, ms: Date.now() - started };
    } catch (error) {
      result = { name: scenario.name, ok: false, reason: messageOf(error), ms: Date.now() - started };
    }
    results.push(result);
    opts.onResult?.(result);
  }
  return { suite: VERSION, protocol: PROTOCOL_VERSION, results };
}
