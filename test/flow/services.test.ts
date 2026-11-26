import { afterEach, describe, expect, it } from 'vitest';
import { concatBytes, toHex } from '../../src/wire/bytes.js';
import { CAP_CHAT, CAP_DIRECT_IM, CAP_GET_FILE, CAP_SEND_FILE, CAP_UTF8_MESSAGES, LOCATE_TLV_CAPABILITIES } from '../../src/wire/constants.js';
import { decodeTlvs, findTlv } from '../../src/wire/tlv.js';
import type { OscarClientOptions } from '../../src/client/oscar-client.js';
import type { FileSink, IncomingFile, OutgoingFile } from '../../src/model/transfer.js';
import { imRoundTrip, makeClient, stopAllClients } from '../fake/harness.js';
import { treeSource } from '../fake/peer-get-file.js';
import type { ClientHarness } from '../fake/harness.js';
import { ManualTimers, waitFor } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';

const INVALID = { name: 'OscarError', info: { kind: 'local', code: 'invalid-argument' } };
const ALL: Services = { fileTransfer: {}, directIm: {}, getFile: {} };
type Services = Pick<OscarClientOptions, 'fileTransfer' | 'directIm' | 'getFile'>;
const DEFAULT_TWO = [CAP_UTF8_MESSAGES, CAP_CHAT];

let timers: ManualTimers;
let fake: FakeOscarServer;
let alice: ClientHarness;
let bob: ClientHarness;
const gates: (() => void)[] = [];

async function start(bobOptions: Services = ALL, aliceOptions: Services = { fileTransfer: {} }): Promise<void> {
  timers = new ManualTimers();
  fake = await FakeOscarServer.start({ now: timers.now, timers: timers.api, relay: true });
  fake.addUser('Alice', 'alicepw1');
  fake.addUser('Bob', 'bobpw123');
  alice = makeClient(fake, { timers, ...aliceOptions });
  bob = makeClient(fake, { timers, ...bobOptions });
  await alice.signOn();
}

afterEach(async () => {
  for (const open of gates.splice(0)) open();
  await stopAllClients();
  await fake.stop();
});

// Each Locate set-info that Bob wrote on BOS, in order.
function locateWrites(): Uint8Array[] {
  return fake.snacsFrom('bob').filter((s) => s.conn === 'bos' && s.family === 2 && s.subtype === 0x04).map((s) => s.body);
}

function capsOf(body: Uint8Array | undefined): string {
  return toHex(findTlv(decodeTlvs(body ?? new Uint8Array(0)), LOCATE_TLV_CAPABILITIES) ?? new Uint8Array(0));
}

function file(bytes: number): OutgoingFile {
  const data = new Uint8Array(bytes).fill(7);
  return { name: 'notes.txt', bytes, modifiedAt: 1_700_000_000, read: async function* () { yield data; } };
}

// A sink in memory whose first write waits for the gate.
function heldSink(): { sink: FileSink; writing: () => boolean; finished: () => boolean } {
  let open: () => void = () => {};
  const gate = new Promise<void>((resolve) => (open = resolve));
  gates.push(open);
  let writing = false;
  let finished = false;
  return {
    writing: () => writing,
    finished: () => finished,
    sink: {
      begin: async (_file: IncomingFile) => ({
        write: async () => {
          writing = true;
          await gate;
        },
        finish: async () => {
          finished = true;
        },
        abort: async () => {},
      }),
    },
  };
}

describe('services after sign-on', () => {
  it('starts with each given service on and each other one off', async () => {
    await start({ fileTransfer: {}, getFile: {} });
    expect(bob.client.services()).toEqual({ fileTransfer: true, directIm: false, getFile: true });
  });

  it('leaves a service that is off out of the first Locate write', async () => {
    await start();
    await bob.client.setServices({ fileTransfer: false, directIm: false, getFile: false });
    expect(bob.client.services()).toEqual({ fileTransfer: false, directIm: false, getFile: false });
    await bob.signOn('Bob', 'bobpw123');
    const writes = locateWrites();
    expect(writes).toHaveLength(1);
    expect(capsOf(writes[0])).toBe(toHex(concatBytes(DEFAULT_TWO)));
  });

  it('writes the capabilities again, and nothing else, when services turn on after sign-on', async () => {
    await start();
    await bob.client.setServices({ fileTransfer: false, directIm: false, getFile: false });
    await bob.signOn('Bob', 'bobpw123');
    await bob.client.setServices({ fileTransfer: true, directIm: true, getFile: true });
    await waitFor(() => locateWrites().length === 2, 'the second Locate write');
    const second = locateWrites()[1] ?? new Uint8Array(0);
    expect(capsOf(second)).toBe(toHex(concatBytes([...DEFAULT_TWO, CAP_SEND_FILE, CAP_DIRECT_IM, CAP_GET_FILE])));
    expect(decodeTlvs(second).map((t) => t.tag)).toEqual([LOCATE_TLV_CAPABILITIES]);
  });

  it('writes the capabilities again after online when they changed during the connect', async () => {
    timers = new ManualTimers();
    fake = await FakeOscarServer.start({ now: timers.now, timers: timers.api, relay: true });
    fake.addUser('Bob', 'bobpw123');
    bob = makeClient(fake, {
      timers,
      ...ALL,
      preOnline: (ctx) => {
        void bob.client.setServices({ directIm: false, getFile: false });
        return ctx.held;
      },
    });
    await bob.signOn('Bob', 'bobpw123');
    await waitFor(() => locateWrites().length === 2, 'the second Locate write');
    expect(capsOf(locateWrites()[0])).toBe(toHex(concatBytes([...DEFAULT_TWO, CAP_SEND_FILE, CAP_DIRECT_IM, CAP_GET_FILE])));
    expect(capsOf(locateWrites()[1])).toBe(toHex(concatBytes([...DEFAULT_TWO, CAP_SEND_FILE])));
  });

  it('a key that is not given leaves its service as it is', async () => {
    await start();
    await bob.client.setServices({ directIm: false });
    expect(bob.client.services()).toEqual({ fileTransfer: true, directIm: false, getFile: true });
    await bob.client.setServices({});
    expect(bob.client.services()).toEqual({ fileTransfer: true, directIm: false, getFile: true });
  });

  it('ignores a file offer while fileTransfer is off, and takes one after it turns on', async () => {
    await start();
    await bob.signOn('Bob', 'bobpw123');
    await bob.client.setServices({ fileTransfer: false });
    await expect(bob.client.sendFiles('Alice', [file(1)])).rejects.toMatchObject(INVALID);
    await alice.client.sendFiles('Bob', [file(100)]);
    await waitFor(() => fake.relaySessions().length === 1, 'the first offer reaches the server');
    await imRoundTrip(fake, alice);
    await imRoundTrip(fake, bob);
    expect(bob.fileOffers).toEqual([]);
    expect(bob.transfers).toEqual([]);

    await bob.client.setServices({ fileTransfer: true });
    await alice.client.sendFiles('Bob', [file(100)]);
    await waitFor(() => bob.fileOffers.length === 1, 'the second offer');
  });

  it('a transfer that runs goes on to the end when fileTransfer turns off', async () => {
    await start();
    await bob.signOn('Bob', 'bobpw123');
    const id = await alice.client.sendFiles('Bob', [file(64 * 1024)]);
    await waitFor(() => bob.fileOffers.length === 1, 'the offer');
    const into = heldSink();
    await bob.client.acceptFileOffer(bob.fileOffers[0]?.id ?? '', into.sink);
    await waitFor(into.writing, 'the first write');
    await bob.client.setServices({ fileTransfer: false });
    for (const open of gates.splice(0)) open();
    await waitFor(() => alice.transfers.some((t) => t.id === id && t.state === 'done'), 'Alice ends done');
    expect(into.finished()).toBe(true);
  });

  it('a transfer that runs still hears the cancel of the peer while fileTransfer is off', async () => {
    await start();
    await bob.signOn('Bob', 'bobpw123');
    const id = await alice.client.sendFiles('Bob', [file(64 * 1024)]);
    await waitFor(() => bob.fileOffers.length === 1, 'the offer');
    const into = heldSink();
    const offer = bob.fileOffers[0]?.id ?? '';
    await bob.client.acceptFileOffer(offer, into.sink);
    await waitFor(into.writing, 'the first write');
    await bob.client.setServices({ fileTransfer: false });
    await alice.client.cancelTransfer(id);
    await waitFor(() => bob.transfers.some((t) => t.id === offer && t.state === 'cancelled' && t.by === 'peer'), 'Bob ends cancelled by peer');
  });

  it('a Direct IM session that runs goes on when directIm turns off, and a new offer is ignored', async () => {
    await start(ALL, ALL);
    await bob.signOn('Bob', 'bobpw123');
    const id = await bob.client.openDirectIm('Alice');
    await waitFor(() => alice.directImOffers.length === 1, 'the offer at Alice');
    await bob.client.setServices({ directIm: false });
    const offer = alice.directImOffers[0]?.id ?? '';
    await alice.client.acceptDirectIm(offer);
    await waitFor(() => bob.directIms.some((s) => s.id === id && s.verified), 'the cookie of Alice at Bob');
    await alice.client.sendDirectMessage(offer, { body: [{ text: 'hi' }], pictures: [] });
    await waitFor(() => bob.directMessages.length === 1, 'the message at Bob');

    fake.addUser('Carol', 'carolpw1');
    const carol = makeClient(fake, { timers, ...ALL });
    await carol.signOn('Carol', 'carolpw1');
    await carol.client.openDirectIm('Bob');
    await imRoundTrip(fake, carol);
    await imRoundTrip(fake, bob);
    expect(bob.directImOffers).toEqual([]);
    expect(carol.directIms.at(-1)?.state).toBe('waiting');

    await alice.client.closeDirectIm(offer);
    await waitFor(() => bob.directIms.at(-1)?.state === 'closed', 'the session ends at Bob');
    expect(bob.directIms.at(-1)).toMatchObject({ id, end: 'peer-closed', by: 'peer' });
  });

  it('a browse that runs goes on when getFile turns off, and a new Get File proposal is ignored', async () => {
    await start(ALL, ALL);
    await bob.signOn('Bob', 'bobpw123');
    await alice.client.shareFiles(treeSource([{ path: ['a.txt'], bytes: new Uint8Array(3).fill(1) }]));
    const id = await bob.client.browseFiles('Alice');
    await waitFor(() => alice.shareRequests.length === 1, 'the request at Alice');
    await bob.client.setServices({ getFile: false });
    await alice.client.allowShare(alice.shareRequests[0]?.id ?? '');
    await waitFor(() => bob.fileListings.length === 1, 'the listing at Bob');
    expect(bob.fileListings[0]).toMatchObject({ browseId: id, from: 'Alice' });
    expect(bob.fileListings[0]?.entries.map((entry) => entry.path)).toEqual([['a.txt']]);

    const asking = await alice.client.browseFiles('Bob');
    await imRoundTrip(fake, alice);
    await imRoundTrip(fake, bob);
    expect([bob.shareRequests, bob.shares]).toEqual([[], []]);
    expect(alice.browses.filter((s) => s.id === asking).at(-1)?.state).toBe('waiting');
  });

  it('throws for a service whose option was not given', async () => {
    await start({ fileTransfer: {} });
    expect(() => bob.client.setServices({ getFile: true })).toThrow(RangeError);
    expect(() => bob.client.setServices({ fileTransfer: true, directIm: true })).toThrow(RangeError);
    expect(bob.client.services()).toEqual({ fileTransfer: true, directIm: false, getFile: false });
    await bob.client.setServices({ getFile: false });
    expect(bob.client.services()).toEqual({ fileTransfer: true, directIm: false, getFile: false });
  });
});
