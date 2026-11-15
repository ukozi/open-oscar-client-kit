import { setTimeout as sleep } from 'node:timers/promises';
import { SignOnFailedError, signOn } from '../dist/lib/index.js';

const options = {
  screenName: 'Bot',
  password: 'botpass1',
  app: 'image-smoke',
  server: { host: '127.0.0.1', port: 5190 },
  reconnect: false,
};
const deadline = Date.now() + 30_000;

let session;
for (;;) {
  try {
    session = await signOn(options);
    break;
  } catch (error) {
    // The container can still be starting.
    if (!(error instanceof SignOnFailedError && error.kind === 'unreachable') || Date.now() > deadline) throw error;
    await sleep(1000);
  }
}
await session.signOff();
