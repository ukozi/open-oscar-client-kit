import { createInterface } from 'node:readline';
import { parseAimHtml } from '../../src/client/aim-html.js';
import { normalizeScreenName } from '../../src/model/screen-name.js';
import { FakeOscarServer } from '../../test/fake/oscar-server.js';
import { buddyListFeedbag } from '../feedbag.js';
import type { TestServerArgs } from './args.js';
import * as text from './text.js';

export type RunTestServerOptions = TestServerArgs & { input: NodeJS.ReadableStream; output: NodeJS.WritableStream };

const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function runTestServer(opts: RunTestServerOptions): Promise<{ port: number; stop(): Promise<void> }> {
  const { host, users, peer: peerName, input, output } = opts;
  const server = await FakeOscarServer.start({ host, port: opts.port, rateMonitor: true });
  const say = (line: string): void => {
    output.write(`${line}\n`);
  };
  for (const user of users) {
    server.addUser(user.screenName, user.password);
    server.setFeedbag(normalizeScreenName(user.screenName), buddyListFeedbag([{ name: 'Buddies', buddies: [peerName] }]));
  }
  const peer = server.peer(peerName);
  peer.signOn();

  const first = (users[0] as TestServerArgs['users'][number]).screenName;
  say(text.STARTED(host, server.port));
  say(text.ACCOUNTS(users));
  say(text.PEER_HELP(peerName));

  const online = new Map(users.map((u) => [u.screenName, false]));
  let recent = first;
  let seenIms = 0;
  const poll = setInterval(() => {
    for (const user of users) {
      const isOn = server.instancesOf(user.screenName) > 0;
      if (isOn === online.get(user.screenName)) continue;
      online.set(user.screenName, isOn);
      if (isOn) recent = user.screenName;
      say(isOn ? text.SIGNED_ON(user.screenName) : text.SIGNED_OFF(user.screenName));
    }
    const ims = peer.ims();
    for (const im of ims.slice(seenIms)) {
      say(text.IM_TO_PEER(im.from, parseAimHtml(im.html).map((run) => run.text).join('')));
    }
    seenIms = ims.length;
  }, 100);

  // The server keeps running when the input ends.
  const lines = createInterface({ input });
  lines.on('line', (line) => {
    if (line.trim() === '') return;
    let target = recent;
    let body = line;
    const addressed = /^@(\S+)\s+(\S.*)$/.exec(line);
    if (addressed) {
      target = addressed[1] as string;
      body = addressed[2] as string;
    }
    if (server.instancesOf(target) === 0) {
      say(text.OFFLINE(target));
      return;
    }
    peer.sendIm(target, escapeHtml(body));
  });

  let stopped: Promise<void> | undefined;
  return {
    port: server.port,
    stop: () => {
      stopped ??= (async () => {
        clearInterval(poll);
        lines.close();
        await server.stop();
      })();
      return stopped;
    },
  };
}
