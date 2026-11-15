import { createInterface } from 'node:readline';
import { encodeImToHost } from '../../../dist/src/wire/icbm.js';
import { encodeImText } from '../../../dist/src/wire/text.js';
import { RawClient } from '../../../dist/test/fake/oscar-client.js';

const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

// Writes each IM at once and ignores the rate classes.
let bos;
for await (const line of createInterface({ input: process.stdin })) {
  const cmd = JSON.parse(line);
  if (cmd.op === 'signOn') {
    bos = await RawClient.signOn(cmd.port, cmd.screenName, cmd.password);
    write({ id: cmd.id, ok: true });
    write({ event: 'online' });
  } else if (cmd.op === 'sendIm') {
    const { charset, bytes } = encodeImText(cmd.text);
    bos.snac(0x04, 0x06, cmd.id, encodeImToHost(BigInt(cmd.id), cmd.to, charset, bytes, false));
    write({ id: cmd.id, ok: true });
  } else if (cmd.op === 'exit') {
    bos?.close();
    write({ id: cmd.id, ok: true });
    process.exit(0);
  } else write({ id: cmd.id, ok: true });
}
