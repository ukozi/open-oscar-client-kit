import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { tlvStr } from '../../src/wire/tlv.js';
import { RawClient } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';

let fake: FakeOscarServer | undefined;
afterEach(async () => {
  await fake?.stop();
  fake = undefined;
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

describe('the test server address', () => {
  it('listens on the port it is given', async () => {
    const port = await freePort();
    fake = await FakeOscarServer.start({ port });
    fake.addUser('Alice', 'alicepw1');
    expect(fake.port).toBe(port);
    const bos = await RawClient.signOn(port, 'Alice', 'alicepw1');
    bos.close();
  });

  it('advertises loopback when it listens on every address', async () => {
    fake = await FakeOscarServer.start({ host: '0.0.0.0' });
    fake.addUser('Alice', 'alicepw1');
    const { tlvs, client } = await RawClient.login(fake.port, 'Alice', 'alicepw1');
    client.close();
    expect(tlvStr(tlvs, 0x05)).toBe(`127.0.0.1:${fake.port}`);
  });

  it('keeps its address across resume', async () => {
    const port = await freePort();
    fake = await FakeOscarServer.start({ port });
    await fake.shutdown();
    await fake.resume();
    expect(fake.port).toBe(port);
  });
});
