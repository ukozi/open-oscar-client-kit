import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BART_CLEAR_HASH,
  decodeBartDownloadReply,
  decodeBartNotice,
  decodeBartUploadReply,
  encodeBartDownload,
  encodeBartId,
  encodeBartInfo,
  encodeBartUpload,
  userIcon,
} from '../../src/wire/bart.js';
import type { BartId } from '../../src/wire/bart.js';
import { toHex } from '../../src/wire/bytes.js';
import { USER_INFO_BART } from '../../src/wire/constants.js';
import {
  BART_ICON_ITEM_NAME,
  FEEDBAG_ATTR_BART_INFO,
  FEEDBAG_CLASS_BART,
  FEEDBAG_CLASS_BUDDY,
  decodeFeedbagStatus,
  encodeFeedbagItems,
} from '../../src/wire/feedbag.js';
import type { FeedbagItem } from '../../src/wire/feedbag.js';
import { decodeHostOnline, encodeClientOnline, encodeClientVersions } from '../../src/wire/oservice.js';
import { decodeRateParamsReply } from '../../src/wire/rate.js';
import { decodeUserInfo } from '../../src/wire/snac.js';
import type { Snac, UserInfo } from '../../src/wire/snac.js';
import { findTlv, tlv } from '../../src/wire/tlv.js';
import { sniffImage } from '../../src/model/icon.js';
import { RawClient, waitFor } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';
import type { FakePeer } from '../fake/oscar-server.js';
import { md5Hex, pngImage } from '../support/png.js';

const MULTI_SESSION = 0x01;
const SERVER_REQUEST_ID = 0x80000000;
const PASSWORDS: Record<string, string> = { Alice: 'alicepw1', Bob: 'bobpw1' };
const PNG = pngImage(4, 4);
const H = new Uint8Array(createHash('md5').update(PNG).digest());
const CLEAR_HEX = '0201d20472';
const ICON_ITEM_ID = 9;

const NOW = 1_800_000_000_000;
let fake: FakeOscarServer;
let bob: FakePeer;
let nextRequestId = 0x100;

beforeEach(async () => {
  fake = await FakeOscarServer.start({ now: () => NOW, notices: false });
  fake.addUser('Alice', 'alicepw1');
  fake.addUser('Bob', 'bobpw1');
  bob = fake.peer('Bob');
  bob.watch('Alice');
});
afterEach(async () => {
  await fake.stop();
});

function bos(name: string): Promise<RawClient> {
  const password = PASSWORDS[name];
  if (password === undefined) throw new Error(`no password for ${name}`);
  return RawClient.signOn(fake.port, name, password, MULTI_SESSION);
}

function iconEntry(itemId: number, flags: number, hash: Uint8Array): FeedbagItem {
  const attrs = [tlv.bytes(FEEDBAG_ATTR_BART_INFO, encodeBartInfo(flags, hash))];
  return { name: BART_ICON_ITEM_NAME, groupId: 0, itemId, classId: FEEDBAG_CLASS_BART, attrs };
}

function iconItem(itemId: number, flags: number, hash: Uint8Array): Uint8Array {
  return encodeFeedbagItems([iconEntry(itemId, flags, hash)]);
}

const buddyEntry = (name: string): FeedbagItem => ({ name, groupId: 0, itemId: 1, classId: FEEDBAG_CLASS_BUDDY, attrs: [] });

async function until(client: RawClient, family: number, subtype: number): Promise<Snac> {
  for (;;) {
    const snac = await client.nextSnac();
    if (snac.family === family && snac.subtype === subtype) return snac;
  }
}

const shown = (id: BartId | null): { type: number; flags: number; hash: string } | null =>
  id === null ? null : { type: id.type, flags: id.flags, hash: toHex(id.hash) };

const infoOf = (snac: Snac): UserInfo => decodeUserInfo(snac.body, 0).info;
const iconIn = (snac: Snac): ReturnType<typeof shown> => shown(userIcon(infoOf(snac)));

async function nextIsSelfInfo(client: RawClient): Promise<Snac> {
  const requestId = nextRequestId++;
  client.snac(0x01, 0x0e, requestId);
  const snac = await client.nextSnac();
  expect({ family: snac.family, subtype: snac.subtype, requestId: snac.requestId }).toEqual({ family: 0x01, subtype: 0x0f, requestId });
  return snac;
}

async function writeIconItem(client: RawClient, subtype: number, flags: number, hash: Uint8Array): Promise<{ status: Snac; notice: Snac; self: Snac }> {
  const requestId = nextRequestId++;
  client.snac(0x13, subtype, requestId, iconItem(ICON_ITEM_ID, flags, hash));
  const status = await client.nextSnac();
  expect({ family: status.family, subtype: status.subtype, requestId: status.requestId }).toEqual({ family: 0x13, subtype: 0x0e, requestId });
  expect(decodeFeedbagStatus(status.body)).toEqual([0]);
  const notice = await client.nextSnac();
  expect({ family: notice.family, subtype: notice.subtype, requestId: notice.requestId }).toEqual({ family: 0x01, subtype: 0x21, requestId: 0 });
  const self = await client.nextSnac();
  expect({ family: self.family, subtype: self.subtype, requestId: self.requestId }).toEqual({ family: 0x01, subtype: 0x0f, requestId: SERVER_REQUEST_ID });
  return { status, notice, self };
}

async function alicePending(): Promise<RawClient> {
  const alice = await bos('Alice');
  await writeIconItem(alice, 0x08, 0x01, H);
  return alice;
}

async function aliceWithHeldIcon(): Promise<RawClient> {
  fake.peer('Carol').setIcon(PNG);
  const alice = await bos('Alice');
  await writeIconItem(alice, 0x08, 0x01, H);
  return alice;
}

async function upload(client: RawClient, data: Uint8Array): Promise<number> {
  const requestId = nextRequestId++;
  client.snac(0x10, 0x02, requestId, encodeBartUpload(1, data));
  return requestId;
}

async function download(client: RawClient, id: BartId, screenName = 'carol'): Promise<ReturnType<typeof decodeBartDownloadReply>> {
  const requestId = nextRequestId++;
  client.snac(0x10, 0x04, requestId, encodeBartDownload(screenName, id));
  const snac = await client.nextSnac();
  expect({ family: snac.family, subtype: snac.subtype, requestId: snac.requestId }).toEqual({ family: 0x10, subtype: 0x05, requestId });
  return decodeBartDownloadReply(snac.body);
}

async function iconConnection(client: RawClient): Promise<RawClient> {
  const icons = await RawClient.service(fake.port, await client.requestService(0x0010));
  await until(client, 0x01, 0x05);
  const online = await icons.nextSnac();
  expect({ family: online.family, subtype: online.subtype }).toEqual({ family: 0x01, subtype: 0x03 });
  return icons;
}

describe('the test server: buddy icons', () => {
  it('puts the icon SNACs in rate class 1', async () => {
    const alice = await bos('Alice');
    alice.snac(0x01, 0x06, nextRequestId++);
    const reply = decodeRateParamsReply((await until(alice, 0x01, 0x07)).body);
    expect([reply.classOf(0x0010, 0x0002), reply.classOf(0x0010, 0x0004), reply.classOf(0x0010, 0x0006)]).toEqual([1, 1, 1]);
  });

  it('answers an icon item for a blob it lacks with the upload notice, tells every session, and tells no buddy', async () => {
    const alice = await bos('Alice');
    const seen = bob.sightings().length;
    const { notice, self } = await writeIconItem(alice, 0x08, 0x01, H);
    expect(shown(decodeBartNotice(notice.body))).toEqual({ type: 1, flags: 0x41, hash: toHex(H) });
    expect(iconIn(self)?.flags).toBe(0x41);
    expect(fake.iconOf('Alice')?.flags).toBe(0x41);
    expect(bob.sightings().length).toBe(seen);
  });

  it('takes an upload whose MD5 is the pending hash: stores it, clears the flag, tells every session and the buddies, then replies', async () => {
    const alice = await alicePending();
    const requestId = await upload(alice, PNG);
    const self = await alice.nextSnac();
    expect({ family: self.family, subtype: self.subtype }).toEqual({ family: 0x01, subtype: 0x0f });
    expect(iconIn(self)?.flags).toBe(0x01);
    const reply = await alice.nextSnac();
    expect({ family: reply.family, subtype: reply.subtype, requestId: reply.requestId }).toEqual({ family: 0x10, subtype: 0x03, requestId });
    const { code, id } = decodeBartUploadReply(reply.body);
    expect({ code, id: shown(id) }).toEqual({ code: 0, id: { type: 1, flags: 0x01, hash: toHex(H) } });
    expect(fake.bartBlob(md5Hex(PNG))).toEqual(PNG);
    expect(bob.sightings().at(-1)).toMatchObject({ name: 'Alice', event: 'arrived', icon: md5Hex(PNG) });
  });

  it('an upload whose MD5 is not the pending hash is stored and changes nothing', async () => {
    const alice = await alicePending();
    const seen = bob.sightings().length;
    const other = pngImage(5, 5);
    const requestId = await upload(alice, other);
    const reply = await alice.nextSnac();
    expect({ family: reply.family, subtype: reply.subtype, requestId: reply.requestId }).toEqual({ family: 0x10, subtype: 0x03, requestId });
    const { code, id } = decodeBartUploadReply(reply.body);
    expect({ code, id: shown(id) }).toEqual({ code: 0, id: { type: 1, flags: 0x01, hash: md5Hex(other) } });
    expect(shown(fake.iconOf('Alice'))).toEqual({ type: 1, flags: 0x41, hash: toHex(H) });
    expect(bob.sightings().length).toBe(seen);
    expect(fake.bartBlob(md5Hex(other))).toEqual(other);
    expect(fake.bartBlob(md5Hex(PNG))).toBeUndefined();
  });

  it('answers an icon item for a blob it holds without the flag and tells the buddies at once', async () => {
    fake.peer('Carol').setIcon(PNG);
    const alice = await bos('Alice');
    const { notice, self } = await writeIconItem(alice, 0x08, 0x01, H);
    expect(shown(decodeBartNotice(notice.body))).toEqual({ type: 1, flags: 0x01, hash: toHex(H) });
    expect(iconIn(self)?.flags).toBe(0x01);
    expect(bob.sightings().at(-1)).toMatchObject({ name: 'Alice', event: 'arrived', icon: md5Hex(PNG) });
    expect(fake.snacsFrom('Alice').filter((s) => s.family === 0x10)).toEqual([]);
  });

  it('the cleared hash on an update clears the icon: a notice without the flag, the buddies told, the item kept', async () => {
    const alice = await aliceWithHeldIcon();
    const { notice } = await writeIconItem(alice, 0x09, 0x00, BART_CLEAR_HASH);
    expect(shown(decodeBartNotice(notice.body))).toEqual({ type: 1, flags: 0x00, hash: CLEAR_HEX });
    expect(bob.sightings().at(-1)).toMatchObject({ name: 'Alice', event: 'arrived', icon: CLEAR_HEX });
    expect(fake.feedbagOf('Alice').filter((item) => item.itemId === ICON_ITEM_ID).map((item) => item.classId)).toEqual([FEEDBAG_CLASS_BART]);
  });

  it("deleting the icon item changes nothing until the account's last session ends", async () => {
    const alice = await aliceWithHeldIcon();
    const seen = bob.sightings().length;
    const requestId = nextRequestId++;
    alice.snac(0x13, 0x0a, requestId, iconItem(ICON_ITEM_ID, 0x01, H));
    const status = await alice.nextSnac();
    expect({ family: status.family, subtype: status.subtype, requestId: status.requestId }).toEqual({ family: 0x13, subtype: 0x0e, requestId });
    expect(decodeFeedbagStatus(status.body)).toEqual([0]);
    expect(iconIn(await nextIsSelfInfo(alice))).toEqual({ type: 1, flags: 0x01, hash: toHex(H) });
    // foodgroup/feedbag.go DeleteItem broadcasts visibility after every delete, so Bob hears again that Alice is here, with her icon.
    expect(bob.sightings().slice(seen)).toMatchObject([{ name: 'Alice', event: 'arrived', icon: md5Hex(PNG) }]);
    expect(fake.feedbagOf('Alice')).toEqual([]);

    alice.close();
    await waitFor(() => fake.instancesOf('Alice') === 0, "the end of Alice's session");
    const again = await bos('Alice');
    expect(findTlv(infoOf(await nextIsSelfInfo(again)).tlvs, USER_INFO_BART)).toBeUndefined();
  });

  it('a new session takes its icon from the feedbag item', async () => {
    fake.setFeedbag('Alice', [iconEntry(ICON_ITEM_ID, 0x01, H)]);
    const alice = await bos('Alice');
    expect(iconIn(await nextIsSelfInfo(alice))).toEqual({ type: 1, flags: 0x01, hash: toHex(H) });
  });

  it('downloads: the blob for a hash it holds, no data for one it does not, the blank GIF for the cleared hash', async () => {
    fake.peer('Carol').setIcon(PNG);
    const alice = await bos('Alice');
    const held = await download(alice, { type: 1, flags: 1, hash: H });
    expect({ screenName: held.screenName, id: shown(held.id) }).toEqual({ screenName: 'carol', id: { type: 1, flags: 1, hash: toHex(H) } });
    expect(new Uint8Array(held.data)).toEqual(PNG);

    const unknown = new Uint8Array(16).fill(0xee);
    const missing = await download(alice, { type: 1, flags: 1, hash: unknown });
    expect(shown(missing.id)).toEqual({ type: 1, flags: 1, hash: toHex(unknown) });
    expect(missing.data.length).toBe(0);

    const cleared = await download(alice, { type: 1, flags: 0, hash: BART_CLEAR_HASH });
    expect(cleared.data.length).toBe(43);
    expect(sniffImage(new Uint8Array(cleared.data))).toEqual({ type: 'gif', width: 50, height: 50 });
  });

  it('arrivals carry the icon', async () => {
    fake.setFeedbag('Alice', [buddyEntry('carol')]);
    const carol = fake.peer('Carol');
    const alice = await bos('Alice');
    carol.setIcon(PNG);
    const withIcon = await alice.nextSnac();
    expect({ family: withIcon.family, subtype: withIcon.subtype, name: infoOf(withIcon).name }).toEqual({ family: 0x03, subtype: 0x0b, name: 'Carol' });
    expect(iconIn(withIcon)).toEqual({ type: 1, flags: 0x01, hash: toHex(H) });
    carol.clearIcon();
    const cleared = await alice.nextSnac();
    expect({ family: cleared.family, subtype: cleared.subtype, name: infoOf(cleared).name }).toEqual({ family: 0x03, subtype: 0x0b, name: 'Carol' });
    expect(iconIn(cleared)).toEqual({ type: 1, flags: 0x00, hash: CLEAR_HEX });
  });

  it("pushes the icon item to the account's other sessions and sends the notice to the writer alone", async () => {
    const first = await bos('Alice');
    const second = await bos('Alice');
    await writeIconItem(first, 0x08, 0x01, H);
    const pushed = await second.nextSnac();
    expect({ family: pushed.family, subtype: pushed.subtype, requestId: pushed.requestId }).toEqual({ family: 0x13, subtype: 0x08, requestId: SERVER_REQUEST_ID });
    expect(toHex(pushed.body)).toBe(toHex(iconItem(ICON_ITEM_ID, 0x01, H)));
    const self = await second.nextSnac();
    expect({ family: self.family, subtype: self.subtype, requestId: self.requestId }).toEqual({ family: 0x01, subtype: 0x0f, requestId: SERVER_REQUEST_ID });
    expect(iconIn(self)?.flags).toBe(0x41);
    await nextIsSelfInfo(second);
  });

  it('an icon item without its icon attribute ends the connection', async () => {
    const alice = await bos('Alice');
    alice.snac(0x13, 0x08, nextRequestId++, encodeFeedbagItems([{ name: '1', groupId: 0, itemId: ICON_ITEM_ID, classId: FEEDBAG_CLASS_BART, attrs: [] }]));
    await alice.untilClosed();
    expect(fake.instancesOf('Alice')).toBe(0);
    expect(fake.iconOf('Alice')).toBeNull();
  });

  it('a peer can name a hash the server lacks: no buddy is told then, and a later arrival carries it with the flag', async () => {
    fake.setFeedbag('Alice', [buddyEntry('carol')]);
    const carol = fake.peer('Carol');
    const alice = await bos('Alice');
    carol.setIconId({ flags: 0x01, hash: H });
    expect(fake.iconOf('Carol')?.flags).toBe(0x41);
    await nextIsSelfInfo(alice);
    carol.setIdle(5);
    const arrival = await alice.nextSnac();
    expect({ family: arrival.family, subtype: arrival.subtype, name: infoOf(arrival).name }).toEqual({ family: 0x03, subtype: 0x0b, name: 'Carol' });
    expect(iconIn(arrival)).toEqual({ type: 1, flags: 0x41, hash: toHex(H) });

    expect(() => fake.setFeedbag('Dora', [iconEntry(ICON_ITEM_ID, 0x01, H)])).toThrow();
    fake.addUser('Dora', 'dorapw1');
    fake.setFeedbag('Dora', [iconEntry(ICON_ITEM_ID, 0x01, H)]);
    fake.peer('Dora');
    expect(fake.bartBlob(toHex(H))).toBeUndefined();
    expect(shown(fake.iconOf('Dora'))).toEqual({ type: 1, flags: 0x01, hash: toHex(H) });
  });

  it('issues a cookie for an icon connection, greets it as the icon service, and serves the icon SNACs on it', async () => {
    fake.peer('Carol').setIcon(pngImage(6, 6));
    const carolHash = new Uint8Array(createHash('md5').update(pngImage(6, 6)).digest());
    const alice = await bos('Alice');
    const cookie = await alice.requestService(0x0010);
    const icons = await RawClient.service(fake.port, cookie);
    const online = await icons.nextSnac();
    expect({ family: online.family, subtype: online.subtype, families: decodeHostOnline(online.body) }).toEqual({ family: 0x01, subtype: 0x03, families: [0x0010, 0x0001] });
    expect(fake.openConnections('Alice')).toEqual(['bart', 'bos']);

    const versions = encodeClientVersions([0x0001, 0x0010]);
    const versionsId = nextRequestId++;
    icons.snac(0x01, 0x17, versionsId, versions);
    const echoed = await icons.nextSnac();
    expect({ family: echoed.family, subtype: echoed.subtype, requestId: echoed.requestId, body: toHex(echoed.body) }).toEqual({ family: 0x01, subtype: 0x18, requestId: versionsId, body: toHex(versions) });

    icons.snac(0x01, 0x02, nextRequestId++, encodeClientOnline([0x0001, 0x0010]));
    expect(infoOf(await nextIsSelfInfo(icons)).name).toBe('Alice');
    expect(fake.snacsFrom('Alice').filter((s) => s.conn === 'bart').map((s) => [s.family, s.subtype])).toEqual([[0x01, 0x17], [0x01, 0x02], [0x01, 0x0e]]);

    expect(new Uint8Array((await download(icons, { type: 1, flags: 1, hash: carolHash })).data)).toEqual(pngImage(6, 6));

    alice.snac(0x13, 0x08, nextRequestId++, iconItem(ICON_ITEM_ID, 0x01, H));
    expect(iconIn(await until(alice, 0x01, 0x0f))?.flags).toBe(0x41);
    const uploadId = await upload(icons, PNG);
    const reply = await icons.nextSnac();
    expect({ family: reply.family, subtype: reply.subtype, requestId: reply.requestId }).toEqual({ family: 0x10, subtype: 0x03, requestId: uploadId });
    expect(decodeBartUploadReply(reply.body).code).toBe(0);
    const self = await alice.nextSnac();
    expect({ family: self.family, subtype: self.subtype }).toEqual({ family: 0x01, subtype: 0x0f });
    expect(iconIn(self)?.flags).toBe(0x01);
    expect(fake.snacsFrom('Alice').filter((s) => s.family === 0x10 && s.subtype === 0x02).map((s) => s.conn)).toEqual(['bart']);
  });

  it("counts an icon connection's SNACs against the account's rate class", async () => {
    const alice = await bos('Alice');
    const icons = await iconConnection(alice);
    await download(icons, { type: 1, flags: 1, hash: H });
    fake.setRateParams('Alice', 1, { clearLevel: 5990, alertLevel: 5950, limitLevel: 5900 });
    fake.spend('Alice', 1, 1);
    expect(fake.rateNotices('Alice').at(-1)).toMatchObject({ code: 3, classId: 1 });
    const dropped = fake.dropped('Alice');
    icons.snac(0x10, 0x04, nextRequestId++, encodeBartDownload('carol', { type: 1, flags: 1, hash: H }));
    // 0x10/0x08 is in no rate class and no route: its error is the next SNAC, so the query got no reply.
    const markerId = nextRequestId++;
    icons.snac(0x10, 0x08, markerId);
    const next = await icons.nextSnac();
    expect({ family: next.family, subtype: next.subtype, requestId: next.requestId }).toEqual({ family: 0x10, subtype: 0x01, requestId: markerId });
    expect(fake.dropped('Alice')).toBe(dropped + 1);
  });

  it('ends only the icon connection of the BOS instance that ended, and refuses a ticket whose instance is gone', async () => {
    const first = await bos('Alice');
    const second = await bos('Alice');
    const firstIcons = await iconConnection(first);
    const secondIcons = await iconConnection(second);
    const unused = await first.requestService(0x0010);

    fake.dropInstance('Alice', 0);
    await firstIcons.untilClosed();
    expect(firstIcons.frames.at(-1)?.type).toBe(4);
    expect(secondIcons.closed).toBe(false);
    expect((await download(secondIcons, { type: 1, flags: 1, hash: H })).data.length).toBe(0);
    expect(fake.openConnections('Alice')).toEqual(['bart', 'bos']);

    const late = await RawClient.service(fake.port, unused);
    await late.untilClosed();
    expect(late.frames.map((frame) => frame.type)).toEqual([1]);

    fake.dropInstance('Alice', 0);
    await secondIcons.untilClosed();
    expect(secondIcons.frames.at(-1)?.type).toBe(4);
    expect(fake.openConnections('Alice')).toEqual([]);
  });

  it('the test hooks do what they say', async () => {
    const alice = await bos('Alice');
    const icons = await iconConnection(alice);

    fake.refuseNextUpload(4);
    const refusedId = await upload(alice, PNG);
    const refused = await alice.nextSnac();
    expect({ family: refused.family, subtype: refused.subtype, requestId: refused.requestId }).toEqual({ family: 0x10, subtype: 0x03, requestId: refusedId });
    expect(decodeBartUploadReply(refused.body).code).toBe(4);
    expect(fake.bartBlob(md5Hex(PNG))).toBeUndefined();
    const takenId = await upload(alice, PNG);
    const taken = await alice.nextSnac();
    expect({ subtype: taken.subtype, requestId: taken.requestId, code: decodeBartUploadReply(taken.body).code }).toEqual({ subtype: 0x03, requestId: takenId, code: 0 });
    expect(fake.bartBlob(md5Hex(PNG))).toEqual(PNG);

    const body = encodeBartId({ type: 1, flags: 0x41, hash: H });
    fake.sendSnac('Alice', 0x01, 0x21, body);
    const sent = await alice.nextSnac();
    expect({ family: sent.family, subtype: sent.subtype, requestId: sent.requestId, body: toHex(sent.body) }).toEqual({ family: 0x01, subtype: 0x21, requestId: SERVER_REQUEST_ID, body: toHex(body) });

    fake.signOffBart('Alice');
    await icons.untilClosed();
    expect(icons.frames.at(-1)?.type).toBe(4);
    expect(fake.openConnections('Alice')).toEqual(['bos']);
    expect(alice.closed).toBe(false);
  });
});
