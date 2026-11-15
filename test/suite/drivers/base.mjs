import { createInterface } from 'node:readline';
import { openSession } from '../../../dist/lib/session.js';

export const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

// Without a login budget, each login goes out at once.
const noBudget = { take: async () => {} };

// Runs a driver on the simple API; `hooks` change how it handles sign-on and drops.
export async function run(hooks = {}) {
  let session;
  const open = (cmd) =>
    openSession(
      {
        screenName: cmd.screenName,
        password: cmd.password,
        app: 'bad-driver',
        server: { host: cmd.host, port: cmd.port },
        reconnect: false,
      },
      { loginBudget: noBudget },
    );
  for await (const line of createInterface({ input: process.stdin })) {
    const cmd = JSON.parse(line);
    try {
      if (cmd.op === 'signOn') {
        session = await (hooks.signOn ?? open)(cmd, open);
        session.on('online', () => write({ event: 'online' }));
        session.on('signedOff', () => hooks.onDrop?.(cmd, open, (s) => (session = s)));
        setImmediate(() => write({ event: 'online' }));
      } else if (cmd.op === 'sendIm') await session.sendIm(cmd.to, cmd.text);
      else if (cmd.op === 'signOff') await session.signOff();
      else if (cmd.op === 'exit') {
        write({ id: cmd.id, ok: true });
        process.exit(0);
      }
      write({ id: cmd.id, ok: true, ...(cmd.op === 'buddies' ? { buddies: [] } : {}) });
    } catch (error) {
      write({ id: cmd.id, ok: false, error: error.kind ?? 'other' });
    }
  }
}
