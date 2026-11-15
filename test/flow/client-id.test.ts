import { afterEach, describe, expect, it } from 'vitest';
import { decodeTlvs, tlvStr } from '../../src/wire/tlv.js';
import { makeClient, stopAllClients } from '../fake/harness.js';
import { FakeOscarServer } from '../fake/oscar-server.js';

let fake: FakeOscarServer;

afterEach(async () => {
  await stopAllClients();
  await fake?.stop();
});

describe('OscarClient and the client ID', () => {
  it('sends the clientId option in TLV 0x03 of the login request, once', async () => {
    fake = await FakeOscarServer.start();
    fake.addUser('Alice', 'alicepw1');
    await makeClient(fake, { clientId: 'Chimr, version 9.9.9/MAC' }).signOn();
    const logins = fake.snacsFrom('alice').filter((s) => s.conn === 'auth' && s.family === 0x17 && s.subtype === 0x02);
    expect(logins).toHaveLength(1);
    expect(tlvStr(decodeTlvs(logins[0]?.body ?? new Uint8Array(0)), 0x03)).toBe('Chimr, version 9.9.9/MAC');
  });
});
