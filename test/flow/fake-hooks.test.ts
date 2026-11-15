import { afterEach, describe, expect, it } from 'vitest';
import { encodeLocateInfo } from '../../src/wire/locate.js';
import { RawClient, waitFor } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';

let fake: FakeOscarServer | undefined;
const open: RawClient[] = [];
afterEach(async () => {
  for (const client of open.splice(0)) client.close();
  await fake?.stop();
  fake = undefined;
});

async function start(): Promise<FakeOscarServer> {
  fake = await FakeOscarServer.start();
  fake.addUser('Alice', 'alicepw1');
  fake.addUser('Bob', 'bobpw1');
  return fake;
}

async function signOn(server: FakeOscarServer, name: string, password: string): Promise<RawClient> {
  const client = await RawClient.signOn(server.port, name, password);
  open.push(client);
  return client;
}

let marker = 0x7000;
function writeAway(client: RawClient, text: string): void {
  client.snac(2, 0x04, marker++, encodeLocateInfo({ away: text }));
}

describe("the test server's hooks", () => {
  it('awayOf reads the away text the account wrote, and null after an empty write', async () => {
    const server = await start();
    const alice = await signOn(server, 'Alice', 'alicepw1');
    expect(server.awayOf('alice')).toBeNull();
    writeAway(alice, 'Working on something.');
    await waitFor(() => server.awayOf('Alice') === 'Working on something.', 'the away text');
    writeAway(alice, '');
    await waitFor(() => server.awayOf('alice') === null, 'the away text cleared');
  });

  it('awayOf reads the latest write and keeps text that is not ASCII', async () => {
    const server = await start();
    const alice = await signOn(server, 'Alice', 'alicepw1');
    writeAway(alice, 'one');
    writeAway(alice, '<B>café</B>');
    await waitFor(() => server.awayOf('alice') === '<B>café</B>', 'the second away text');
  });

  it('awayOf reads the away text of a peer', async () => {
    const server = await start();
    server.peer('Bob').setAwayMessage('Out to lunch');
    expect(server.awayOf('bob')).toBe('Out to lunch');
  });

  it('awayOf is null for an account that is not signed on and for a name with no account', async () => {
    const server = await start();
    const alice = await signOn(server, 'Alice', 'alicepw1');
    writeAway(alice, 'Back soon');
    await waitFor(() => server.awayOf('alice') === 'Back soon', 'the away text');
    alice.close();
    await waitFor(() => server.instancesOf('alice') === 0, 'the instance to go');
    expect(server.awayOf('alice')).toBeNull();
    expect(server.awayOf('nobody')).toBeNull();
  });
});
