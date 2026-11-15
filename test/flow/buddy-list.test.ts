import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FEEDBAG_ATTR_PD_MODE, FEEDBAG_ATTR_PENDING, encodeFeedbagItems, orderAttr } from '../../src/wire/feedbag.js';
import type { FeedbagItem } from '../../src/wire/feedbag.js';
import { tlv } from '../../src/wire/tlv.js';
import type { Tlv } from '../../src/wire/tlv.js';
import { makeClient, sampleFeedbag, stopAllClients, withTypingPref } from '../fake/harness.js';
import type { ClientHarness } from '../fake/harness.js';
import { RawClient, settle, waitFor } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';

let server: FakeOscarServer;
let h: ClientHarness;

beforeEach(async () => {
  server = await FakeOscarServer.start();
  server.addUser('Alice', 'alicepw1');
  h = makeClient(server);
});

afterEach(async () => {
  await stopAllClients();
  await server.stop();
});

describe('buddy list', () => {
  it('emits the buddy list before going online, in server order', async () => {
    server.setFeedbag('alice', sampleFeedbag());
    const listsWhenOnline: number[] = [];
    h.client.on('state', ({ state }) => {
      if (state === 'online') listsWhenOnline.push(h.lists.length);
    });
    await h.signOn();
    expect(listsWhenOnline).toEqual([1]);
    // The client emits the list again once the server confirms the typing preference, so the test compares the first and the last.
    expect(h.lists[0]).toEqual({
      groups: [
        { id: 2, name: 'Work', buddies: [] },
        { id: 1, name: 'Buddies', buddies: [{ itemId: 11, screenName: 'alice', alias: null, pending: false }, { itemId: 10, screenName: 'chimrdev2', alias: 'Dev Two', pending: false }] },
      ],
      privacy: { mode: 'allow-all', allow: [], block: [] },
      acceptNonListIcons: null,
    });
    expect(h.lists.at(-1)).toEqual(h.lists[0]);
    expect(h.client.buddyList()).toEqual(h.lists[0]);
  });

  it('signs on with an empty buddy list', async () => {
    await h.signOn();
    expect(h.lists[0]).toEqual({ groups: [], privacy: { mode: 'allow-all', allow: [], block: [] }, acceptNonListIcons: null });
    expect(h.lists.at(-1)).toEqual({ groups: [], privacy: { mode: 'allow-all', allow: [], block: [] }, acceptNonListIcons: null });
  });

  it('forgets the list at sign-off', async () => {
    server.setFeedbag('alice', sampleFeedbag());
    await h.signOn();
    await h.client.signOff();
    expect(h.client.buddyList()).toEqual({ groups: [], privacy: { mode: 'allow-all', allow: [], block: [] }, acceptNonListIcons: null });
  });

  it('compares screen names in normalised form at sign-on', async () => {
    expect(await h.signOn('a l i c e', 'alicepw1')).toBe('online');
    expect(h.client.self?.screenName).toBe('Alice');
  });
});

describe('the privacy setting in the buddy list', () => {
  const item = (classId: number, name: string, groupId: number, itemId: number, attrs: Tlv[] = []): FeedbagItem => ({ name, groupId, itemId, classId, attrs });
  const buddy = (itemId: number, name: string, attrs: Tlv[] = []): FeedbagItem => item(0, name, 1, itemId, attrs);
  const permit = (itemId: number, name: string): FeedbagItem => item(2, name, 0, itemId);
  const deny = (itemId: number, name: string): FeedbagItem => item(3, name, 0, itemId);
  const privacy = (itemId: number, mode: number): FeedbagItem => item(4, '', 0, itemId, [tlv.u8(FEEDBAG_ATTR_PD_MODE, mode)]);
  const PENDING = tlv.bytes(FEEDBAG_ATTR_PENDING, new Uint8Array(0));
  const lists = (): FeedbagItem[] => [
    item(1, 'Buddies', 1, 0, [orderAttr([1, 2])]), buddy(1, 'bob'), buddy(2, 'Pat', [PENDING]),
    permit(10, 'Car Ol'), deny(20, 'zed'), permit(11, 'amy'), deny(21, 'Mal Lory'), permit(12, 'carol'), deny(22, 'AMY'),
  ];

  it.each<[string, FeedbagItem[], string]>([
    ['mode 1', [privacy(30, 1)], 'allow-all'],
    ['mode 2', [privacy(30, 2)], 'block-all'],
    ['mode 3', [privacy(30, 3)], 'allow-list'],
    ['mode 4', [privacy(30, 4)], 'block-list'],
    ['mode 5', [privacy(30, 5)], 'allow-buddies'],
    ['no privacy item', [], 'allow-all'],
    ['mode 0', [privacy(30, 0)], 'unknown'],
    ['mode 6', [privacy(30, 6)], 'unknown'],
  ])('reads the Allow and Block lists whatever the mode, each name once, normalised, in server order: %s', async (_case, more, mode) => {
    server.setFeedbag('alice', withTypingPref([...lists(), ...more]));
    await h.signOn();
    expect(h.client.buddyList().privacy).toEqual({ mode, allow: ['carol', 'amy'], block: ['zed', 'mallory', 'amy'] });
  });

  it('marks a buddy item with TLV 0x0066 pending, and the others not', async () => {
    server.setFeedbag('alice', withTypingPref(lists()));
    await h.signOn();
    expect(h.client.buddyList().groups[0]?.buddies).toEqual([
      { itemId: 1, screenName: 'bob', alias: null, pending: false },
      { itemId: 2, screenName: 'Pat', alias: null, pending: true },
    ]);
  });

  it("applies a permit insert, a deny delete and a privacy update pushed from another session in the next list", async () => {
    server.setFeedbag('alice', withTypingPref([...lists(), privacy(30, 1)]));
    await h.signOn();
    const other = await RawClient.signOn(server.port, 'Alice', 'alicepw1', 0x01);
    let marker = 0x7000;
    const push = async (subtype: number, items: FeedbagItem[]): Promise<void> => {
      const count = h.lists.length;
      other.snac(0x13, subtype, marker++, encodeFeedbagItems(items));
      await waitFor(() => h.lists.length > count, `the push 0x${subtype.toString(16)}`);
      await settle(server.port);
    };
    await push(0x08, [permit(13, 'Dave')]);
    expect(h.lists.at(-1)?.privacy).toEqual({ mode: 'allow-all', allow: ['carol', 'amy', 'dave'], block: ['zed', 'mallory', 'amy'] });
    await push(0x0a, [deny(20, 'zed')]);
    expect(h.lists.at(-1)?.privacy).toEqual({ mode: 'allow-all', allow: ['carol', 'amy', 'dave'], block: ['mallory', 'amy'] });
    await push(0x09, [privacy(30, 2)]);
    expect(h.lists.at(-1)?.privacy).toEqual({ mode: 'block-all', allow: ['carol', 'amy', 'dave'], block: ['mallory', 'amy'] });
    expect(h.client.buddyList()).toEqual(h.lists.at(-1));
  });
});
