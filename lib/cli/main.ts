#!/usr/bin/env node
import { realpathSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { PROTOCOL_VERSION } from '../../suite/protocol.js';
import { runSuite } from '../../suite/runner.js';
import * as suiteText from '../../suite/text.js';
import { VERSION } from '../version.js';
import { parseTestServerArgs, parseSuiteArgs, UsageError } from './args.js';
import type { TestServerArgs, SuiteArgs } from './args.js';
import { runTestServer } from './test-server.js';
import * as text from './text.js';

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === 'test-server') {
    let args: TestServerArgs;
    try {
      args = parseTestServerArgs(rest);
    } catch (error) {
      if (!(error instanceof UsageError)) throw error;
      process.stderr.write(`${error.message}\n`);
      return 2;
    }
    const running = await runTestServer({ ...args, input: process.stdin, output: process.stdout });
    await new Promise<void>((resolve) => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
    });
    await running.stop();
    return 0;
  }
  if (command === 'suite') {
    let args: SuiteArgs;
    try {
      args = parseSuiteArgs(rest);
    } catch (error) {
      if (!(error instanceof UsageError)) throw error;
      process.stderr.write(`${error.message}\n`);
      return 2;
    }
    process.stdout.write(`${suiteText.SUITE_HEADER(VERSION, PROTOCOL_VERSION)}\n`);
    try {
      const result = await runSuite({
        driver: args.driver,
        only: args.only,
        onResult: (r) =>
          process.stdout.write(`${r.ok ? suiteText.LINE_OK(r.name, r.ms) : suiteText.LINE_FAIL(r.name, r.reason ?? '')}\n`),
      });
      const passed = result.results.filter((r) => r.ok).length;
      process.stdout.write(`${suiteText.SUMMARY(passed, result.results.length)}\n`);
      if (args.json) writeFileSync(args.json, `${JSON.stringify(result, null, 2)}\n`);
      return passed === result.results.length ? 0 : 1;
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 2;
    }
  }
  process.stderr.write(`${text.USAGE}\n`);
  return 2;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(realpathSync(entry)).href) {
  process.exitCode = await main(process.argv.slice(2));
}
