import { describe, expect, it } from 'vitest';
import { encodeAdminEmailQuery, encodeAdminFormat } from '../../src/wire/admin.js';
import { toHex } from '../../src/wire/bytes.js';
import { encodeTlvs, tlv } from '../../src/wire/tlv.js';
import { ADMIN_HOST_ONLINE, FakeAdmin } from '../fake/oscar-admin.js';
import type { AdminWire, FakeAdminCore } from '../fake/oscar-admin.js';
import { bytesOf, loadVectors } from '../support/vectors.js';

const v = loadVectors('hand-admin.json');

type Sent = { family: number; subtype: number; requestId: number; body: string };

function harness() {
  const events: string[] = [];
  const sent: Sent[] = [];
  const displays = new Map<string, string>([
    ['alice', 'alice'],
    ['bob', 'Bob'],
  ]);
  const wire: AdminWire = {
    send(family, subtype, requestId, body) {
      events.push(`send:${family}/${subtype}`);
      sent.push({ family, subtype, requestId, body: toHex(body) });
    },
  };
  const core: FakeAdminCore<string> = {
    display: (ident) => displays.get(ident) ?? ident,
    rename(ident, display) {
      events.push(`rename:${ident}:${display}`);
      displays.set(ident, display);
    },
    selfInfo(bos) {
      events.push(`selfInfo:${bos}`);
    },
  };
  const admin = new FakeAdmin(core);
  let next = 1;
  const query = (body: Uint8Array, ident = 'alice'): void => admin.handle(wire, ident, `bos-${ident}`, { subtype: 0x0002, requestId: next++, body });
  const change = (name: string, ident = 'alice'): void =>
    admin.handle(wire, ident, `bos-${ident}`, { subtype: 0x0004, requestId: next++, body: encodeAdminFormat(name) });
  return { admin, events, sent, displays, query, change };
}

const hexOf = (name: string): string => toHex(bytesOf(v, name));
// A change reply: permissions 3, then a count and TLV 0x01 holding the name; or TLV 0x08 with the code and an empty TLV 0x04.
const success = (name: string): string => toHex(Buffer.concat([Buffer.from('000300010001', 'hex'), u16(Buffer.byteLength(name)), Buffer.from(name)]));
const refusal = (code: number): string => `0003000200080002${code.toString(16).padStart(4, '0')}00040000`;

function u16(value: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(value, 0);
  return b;
}

describe('FakeAdmin', () => {
  it('lists OService and Admin in the host online of its connection', () => {
    expect(ADMIN_HOST_ONLINE).toEqual([0x0001, 0x0007]);
  });

  it('answers an email query with TLV 0x11, and none as zero length', () => {
    const h = harness();
    h.admin.setEmail('Alice', 'dev2@example.com');
    expect(h.admin.emailOf('a lice')).toBe('dev2@example.com');
    h.query(bytesOf(v, 'admin email query body'));
    h.query(bytesOf(v, 'admin email query body'), 'bob');
    expect(h.sent).toEqual([
      { family: 0x0007, subtype: 0x0003, requestId: 1, body: hexOf('admin info reply body, email dev2@example.com') },
      { family: 0x0007, subtype: 0x0003, requestId: 2, body: hexOf('admin info reply body, no email') },
    ]);
    h.admin.setEmail('alice', '');
    h.query(encodeAdminEmailQuery());
    expect(h.sent[2]?.body).toBe(hexOf('admin info reply body, no email'));
  });

  it('answers one field by priority: 0x13, then 0x11, then 0x01, and AdminErr 8 with none of them', () => {
    const h = harness();
    h.admin.setEmail('alice', 'dev2@example.com');
    h.admin.setRegStatus('alice', 0x0002);
    h.query(encodeTlvs([tlv.empty(0x0013), tlv.empty(0x0011), tlv.empty(0x0001)]));
    h.query(encodeTlvs([tlv.empty(0x0011), tlv.empty(0x0001)]));
    h.query(encodeTlvs([tlv.empty(0x0001)]));
    h.query(Uint8Array.of(0x00, 0x05, 0x00, 0x00));
    h.query(encodeTlvs([tlv.empty(0x0013)]), 'bob');
    expect(h.sent.map((s) => [s.subtype, s.body])).toEqual([
      [0x0003, '00030001001300020002'],
      [0x0003, hexOf('admin info reply body, email dev2@example.com')],
      [0x0003, success('alice')],
      [0x0001, '0008'],
      [0x0003, '00030001001300020000'],
    ]);
    expect(h.events.filter((e) => !e.startsWith('send:'))).toEqual([]);
  });

  it("formats a name that normalises to the account, in the server's order", () => {
    const h = harness();
    h.change('A Lice');
    expect(h.events).toEqual(['rename:alice:A Lice', 'selfInfo:bos-alice', 'send:7/5']);
    expect(h.sent).toEqual([{ family: 0x0007, subtype: 0x0005, requestId: 1, body: success('A Lice') }]);
    expect(h.displays.get('alice')).toBe('A Lice');

    const after = harness();
    after.admin.selfInfoOrder = 'after';
    after.change('A Lice');
    expect(after.events).toEqual(['rename:alice:A Lice', 'send:7/5', 'selfInfo:bos-alice']);

    const none = harness();
    none.admin.selfInfoOrder = 'none';
    none.change('A Lice');
    expect(none.events).toEqual(['rename:alice:A Lice', 'send:7/5']);

    const dev2 = harness();
    dev2.change('Chimr Dev 2', 'chimrdev2');
    expect(dev2.sent[0]?.body).toBe(hexOf('admin change reply body, success, Chimr Dev 2'));
  });

  it('refuses with 0x000B, 0x0006 and 0x0001 as ValidateAIMHandle and the identity check do', () => {
    const cases: [string, string, number][] = [
      ['abcdefghijklmnopq', 'abcdefghijklmnopq', 0x000b],
      ['a 1', 'a1', 0x000b],
      ['al!ce', 'al!ce', 0x0006],
      ['1alice', '1alice', 0x0006],
      ['alice ', 'alice', 0x0006],
      ['שab', 'שab', 0x0006],
      ['Bob', 'alice', 0x0001],
    ];
    for (const [name, ident, code] of cases) {
      const h = harness();
      h.change(name, ident);
      expect(h.sent, name).toEqual([{ family: 0x0007, subtype: 0x0005, requestId: 1, body: refusal(code) }]);
      expect(h.events, name).toEqual(['send:7/5']);
    }
    expect(refusal(0x0001)).toBe(hexOf('admin change reply body, failure 0x0001'));
  });

  it('follows each switch', () => {
    const h = harness();
    expect(h.admin.serviceRefusal()).toBeNull();
    h.admin.refuseService(true);
    expect(h.admin.serviceRefusal()).toBe(0x0005);
    h.admin.refuseService(false);
    expect(h.admin.serviceRefusal()).toBeNull();

    h.admin.answerAdminErr(0x0008);
    h.query(encodeAdminEmailQuery());
    h.change('A Lice');
    h.admin.answerAdminErr(null);
    expect(h.sent.map((s) => [s.subtype, s.body])).toEqual([
      [0x0001, '0008'],
      [0x0001, '0008'],
    ]);
    expect(h.events.filter((e) => e.startsWith('rename:'))).toEqual([]);

    h.sent.length = 0;
    h.events.length = 0;
    h.admin.refuseNextChange(0x0004);
    h.change('A Lice');
    h.change('A Lice');
    expect(h.sent.map((s) => s.body)).toEqual([refusal(0x0004), success('A Lice')]);
    expect(h.events.filter((e) => e.startsWith('rename:'))).toEqual(['rename:alice:A Lice']);

    h.sent.length = 0;
    h.events.length = 0;
    h.admin.hold();
    h.query(encodeAdminEmailQuery());
    h.change('Al Ice');
    expect(h.sent).toEqual([]);
    expect(h.events).toEqual(['rename:alice:Al Ice', 'selfInfo:bos-alice']);
    h.admin.release();
    expect(h.sent.map((s) => [s.subtype, s.requestId])).toEqual([
      [0x0003, 5],
      [0x0005, 6],
    ]);
    h.query(encodeAdminEmailQuery());
    expect(h.sent).toHaveLength(3);

    h.sent.length = 0;
    h.events.length = 0;
    h.admin.dropNext();
    h.change('A Lice');
    expect(h.sent).toEqual([]);
    expect(h.events).toEqual([]);
    h.change('A Lice');
    expect(h.sent.map((s) => s.body)).toEqual([success('A Lice')]);

    h.sent.length = 0;
    h.events.length = 0;
    h.admin.replaceNextReply(Uint8Array.of(0x00, 0x03));
    h.change('Ali Ce');
    h.change('Ali Ce');
    expect(h.sent.map((s) => [s.subtype, s.body])).toEqual([
      [0x0005, '0003'],
      [0x0005, success('Ali Ce')],
    ]);
    expect(h.events.filter((e) => e.startsWith('rename:'))).toEqual(['rename:alice:Ali Ce', 'rename:alice:Ali Ce']);
  });
});
