import { randomBytes } from 'node:crypto';
import { FAMILY_ADMIN } from '../../src/wire/admin.js';
import { FAMILY_BART } from '../../src/wire/bart.js';
import { decodeRoomMessage } from '../../src/wire/chatroom.js';
import { str8 } from '../../src/wire/chatnav.js';
import {
  CHATNAV_CREATE_ROOM,
  CHATNAV_ERR,
  CHATNAV_ERR_NO_MATCH,
  CHATNAV_NAV_INFO,
  CHATNAV_REQUEST_ROOM_INFO,
  CHATNAV_TLV_ROOM_INFO,
  CHAT_MSG_TLV_ENCODING,
  CHAT_MSG_TLV_LANG,
  CHAT_MSG_TLV_TEXT,
  CHAT_MSG_TO_CLIENT,
  CHAT_MSG_TO_HOST,
  CHAT_ROOM_INFO_UPDATE,
  CHAT_SEND_RATE_CLASS,
  CHAT_TLV_MESSAGE,
  CHAT_TLV_PUBLIC,
  CHAT_TLV_REFLECT,
  CHAT_TLV_SENDER,
  CHAT_TLV_WHISPER_TO,
  CHAT_USERS_JOINED,
  CHAT_USERS_LEFT,
  FAMILY_CHAT,
  FAMILY_CHATNAV,
  FAMILY_OSERVICE,
  OSERVICE_CLIENT_ONLINE,
  OSERVICE_ERR,
  OSERVICE_HOST_ONLINE,
  OSERVICE_RATE_PARAMS_QUERY,
  OSERVICE_RATE_PARAMS_REPLY,
  OSERVICE_RATE_PARAMS_SUB_ADD,
  OSERVICE_RATE_PARAM_CHANGE,
  OSERVICE_SERVICE_REQUEST,
  OSERVICE_SERVICE_RESPONSE,
  OSERVICE_USER_INFO_QUERY,
  OSERVICE_USER_INFO_UPDATE,
  RATE_CODE_CLEAR,
  RATE_CODE_LIMITED,
  ROOM_TLV_NAME,
  SERVICE_COOKIE_TTL_MS,
  SERVICE_TLV_COOKIE,
  SERVICE_TLV_RECONNECT_HERE,
  SERVICE_TLV_ROOM_INFO,
  SERVICE_TLV_SSL_STATE,
  SERVICE_TLV_USE_SSL,
  USER_INFO_BART,
} from '../../src/wire/constants.js';
import { FAMILY_ODIR } from '../../src/wire/odir.js';
import { encodeUserInfo } from '../../src/wire/snac.js';
import { normalizeScreenName } from '../../src/wire/text.js';
import { decodeTlvBlock, decodeTlvs, encodeTlvBlock, encodeTlvs, findTlv, type Tlv } from '../../src/wire/tlv.js';
import type { RoomRef } from '../../src/wire/types.js';

// The server release the test server acts as. 'v0.24' differs from 'main' in four ways.
// The login reply states no SSL, and a service request with TLV 0x8C gets error 0x01/0x01.
// A relayed IM keeps its store TLV (0x06) and its send-time TLV (0x16).
// An offline retrieval before client online deletes the stored messages and delivers none.
// A BOS rate notice goes to the account's ChatNav connection while it has one.
export type FakeGeneration = 'v0.24' | 'main';
export type FakeConnKind = 'auth' | 'bos' | 'chatnav' | 'chat' | 'bart' | 'admin' | 'odir';

export interface FakeConn {
  readonly kind: FakeConnKind;
  readonly name: string;
  readonly display: string;
  send(family: number, subtype: number, body: Uint8Array, requestId?: number): void;
  destroy(): void;
  reset(): void;
  signoffBare(): void;
}

export interface FakeRoomsCore {
  generation(): FakeGeneration;
  advertised(): string;
  bosConn(name: string): FakeConn | undefined;
  bosUserInfo(name: string): Uint8Array;
  sslState(wantsSsl: boolean): number;
  /** True when the server refuses a service request that asks for SSL. */
  refusesSsl(): boolean;
  // cookie lifetimes follow the server's clock, not Date.now
  now(): number;
  /** The code the server refuses a service request for Admin with, or null to issue its ticket. */
  adminRefusal(): number | null;
  /** The code the server refuses a service request for ODir with, or null to issue its ticket. */
  odirRefusal(): number | null;
}

// `bos` (bart, admin and odir tickets): the BOS instance the cookie names (foodgroup/oservice.go ServiceRequest).
export type ServiceTicket = { kind: 'chatnav' | 'chat' | 'bart' | 'admin' | 'odir'; name: string; display: string; roomCookie?: string; bos?: FakeConn };
export type PeerLine = { from: string; text: string; whisper: boolean };

// `joined` orders the seeding roster; a `removed` room's record is deleted but its occupants stay.
type Occupant = { name: string; display: string; conn: FakeConn | null; live: boolean; subscribed: boolean; limited: boolean; joined: number };
// `createdAt`: Unix seconds, set when the room is inserted (state/user_store.go CreateChatRoom).
type Room = { exchange: 4 | 5; name: string; cookie: string; occupants: Map<string, Occupant>; removed: boolean; joins: number; createdAt: number };

const ERR_NOT_SUPPORTED = 0x0008;
const ERR_GENERAL_FAILURE = 0x001c;
const COOKIE_NAME_LIMIT = 202;
const PROBE_REQUEST = 0x001f;
const BOS_IM_RATE_CLASS = 3;
const CHAT_USER_FLAGS = 0x0010;
const CHAT_SIGNON_TIME = 0x886e0900;
const ROLL = /^\/\/roll(?:-(dice|sides)([0-9]{1,3}))?(?:-(dice|sides)([0-9]{1,3}))?\s*$/;
const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', sol: '/' };
const RATE_CLASSES = [
  [1, 80, 2500, 2000, 1500, 800, 6000],
  [2, 80, 3000, 2000, 1500, 1000, 6000],
  [3, 20, 5100, 5000, 4000, 3000, 6000],
  [4, 20, 5500, 5300, 4200, 3000, 8000],
  [5, 10, 5500, 5300, 4200, 3000, 8000],
] as const;

// foodgroup/chat.go:130-134, 177-191: a //roll line becomes OnlineHost's dice result, keeping its message id.
function diceLine(display: string): Tlv[] {
  return [
    { tag: CHAT_MSG_TLV_ENCODING, value: Buffer.from('us-ascii') },
    { tag: CHAT_MSG_TLV_LANG, value: Buffer.from('en') },
    { tag: CHAT_MSG_TLV_TEXT, value: Buffer.from(`<HTML><BODY>${display} rolled 2 6-sided dice: 3 4</BODY></HTML>`) },
  ];
}

function u16(value: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(value, 0);
  return b;
}

function u32(value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(value, 0);
  return b;
}

function rateClass(row: (typeof RATE_CLASSES)[number], current: number): Buffer {
  const [id, window, clear, alert, limit, disconnect, max] = row;
  return Buffer.concat([u16(id), u32(window), u32(clear), u32(alert), u32(limit), u32(disconnect), u32(current), u32(max)]);
}

function tagEnd(html: string, from: number): number {
  if (html.startsWith('<!--', from)) {
    const close = html.indexOf('-->', from + 4);
    return close < 0 ? -1 : close + 2;
  }
  // only a start tag has attribute values, and only they can hold a '>'
  const quotes = /[a-zA-Z]/.test(html[from + 1] ?? '');
  let quote = '';
  for (let i = from + 1; i < html.length; i++) {
    const ch = html[i] ?? '';
    if (quote !== '') {
      if (ch === quote) quote = '';
    } else if (quotes && (ch === '"' || ch === "'")) quote = ch;
    else if (ch === '>') return i;
  }
  return -1;
}

const opensTag = (html: string, at: number): boolean => html[at] === '<' && /[a-zA-Z\/!?]/.test(html[at + 1] ?? '');

// What extractChatMessage reads (foodgroup/chat.go:195-215), written apart from guardRoll to catch its faults.
export function firstTextToken(html: string): string {
  let at = 0;
  while (at < html.length && opensTag(html, at)) {
    const end = tagEnd(html, at);
    if (end < 0) return '';
    at = end + 1;
  }
  let stop = at;
  while (stop < html.length && !(stop > at && opensTag(html, stop))) stop += 1;
  return html
    .slice(at, stop)
    .replace(/\r\n?/g, '\n')
    .replace(/&(?:#([0-9]+);?|#[xX]([0-9a-fA-F]+);?|([a-zA-Z]+);)/g, (match, dec?: string, hex?: string, named?: string) => {
      if (named !== undefined) return NAMED_ENTITIES[named] ?? match;
      const cp = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex ?? '', 16);
      return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : '\ufffd';
    });
}

export function serverSeesRoll(html: string): boolean {
  const m = ROLL.exec(firstTextToken(html));
  if (!m) return false;
  // parseDiceCommand (foodgroup/chat.go:228-262): a repeated or out-of-range argument is no command
  if (m[1] !== undefined && m[1] === m[3]) return false;
  for (const [kind, value] of [[m[1], m[2]], [m[3], m[4]]]) {
    const n = Number(value);
    if (kind === 'dice' && (n < 1 || n > 15)) return false;
    if (kind === 'sides' && (n < 1 || n > 999)) return false;
  }
  return true;
}

export function fakeRateParamsReply(): Uint8Array {
  const groups = RATE_CLASSES.map(([id]) => {
    const pairs = id === CHAT_SEND_RATE_CLASS ? [[FAMILY_CHAT, CHAT_MSG_TO_HOST]] : [];
    return Buffer.concat([u16(id), u16(pairs.length), ...pairs.map(([f, s]) => Buffer.concat([u16(f ?? 0), u16(s ?? 0)]))]);
  });
  return Buffer.concat([u16(RATE_CLASSES.length), ...RATE_CLASSES.map((row) => rateClass(row, row[6])), ...groups]);
}

export function fakeRateChange(code: number, classId: number): Uint8Array {
  const row = RATE_CLASSES.find(([id]) => id === classId) ?? RATE_CLASSES[1];
  const current = code === RATE_CODE_LIMITED ? row[4] - 1 : row[6];
  return Buffer.concat([u16(code), rateClass(row, current)]);
}

export class FakeRooms {
  private readonly rooms = new Map<string, Room>();
  private readonly tickets = new Map<string, { ticket: ServiceTicket; expiresAt: number }>();
  private readonly attached = new Map<FakeConn, ServiceTicket>();
  private readonly lines = new Map<string, PeerLine[]>();
  private readonly silenced = new Set<FakeConn>();
  private readonly chatIcons = new Map<string, Uint8Array>();
  private raceArmed = false;
  private strayArmed = false;
  private createsToDrop = 0;
  private refuseTicket = false;

  constructor(private readonly core: FakeRoomsCore) {}

  addRoom(room: RoomRef): void {
    this.ensure(room.exchange, room.name);
  }

  raceNextCreate(): void {
    this.raceArmed = true;
  }

  // The next `count` 0x0D/0x08 requests close the ChatNav connection with no reply. The loser of a
  // create race sees this (foodgroup/chat_nav.go CreateRoom: errChatNavRoomCreateFailed is a Go error,
  // and server/oscar/server.go dispatchIncomingMessages leaves the read loop on it).
  dropCreates(count: number): void {
    this.createsToDrop = count;
  }

  // The next room connection cookie issued has already expired: presenting it closes the connection
  // with nothing sent (server/oscar/server.go connectToOSCARService: CrackCookie fails and it returns).
  refuseNextChatTicket(): void {
    this.refuseTicket = true;
  }

  // Test only: from now on the server sends that occupant's connection nothing and answers it nothing,
  // as a connection whose peer stopped without closing. The server has no such state of its own.
  silence(name: string, room: RoomRef): void {
    const conn = this.byName(room.exchange, room.name, true)?.occupants.get(normalizeScreenName(name))?.conn;
    if (!conn) throw new Error(`${name} has no socket in ${room.name}`);
    this.silenced.add(conn);
  }

  // The record goes, as after DELETE /chat/room/public (server/http/mgmt_api.go); its occupants keep relaying.
  removeRoom(room: RoomRef): void {
    const found = this.byName(room.exchange, room.name);
    if (!found) throw new Error(`no room named ${room.name}`);
    found.removed = true;
  }

  // Test only: pads the instance part of the room's cookie with zeros until the cookie is `bytes`
  // long. A server with a longer cookie format returns such a cookie. The server itself writes
  // "<exchange>-0-<name>" (state/chat.go Cookie).
  lengthenCookie(room: RoomRef, bytes: number): void {
    const found = this.byName(room.exchange, room.name);
    if (!found) throw new Error(`no room named ${room.name}`);
    const short = Buffer.byteLength(`${found.exchange}--${found.name}`);
    if (bytes <= short) throw new Error(`a cookie for ${room.name} is at least ${short + 1} bytes`);
    this.rooms.delete(found.cookie.toLowerCase());
    found.cookie = `${found.exchange}-${'0'.repeat(bytes - short)}-${found.name}`;
    this.rooms.set(found.cookie.toLowerCase(), found);
  }

  // The account's open ChatNav connection, if it has one.
  navConn(name: string): FakeConn | undefined {
    for (const [conn, ticket] of this.attached) if (ticket.kind === 'chatnav' && ticket.name === name) return conn;
    return undefined;
  }

  // With generation 'v0.24', the next ChatNav request also gets a BOS rate notice. With 'main' this does nothing.
  strayRateOnNextNav(): void {
    this.strayArmed = true;
  }

  occupants(room: RoomRef): string[] {
    const found = this.byName(room.exchange, room.name, true);
    return found ? [...found.occupants.values()].filter((o) => o.live).map((o) => o.name) : [];
  }

  dropChat(name: string, room: RoomRef): void {
    this.byName(room.exchange, room.name, true)?.occupants.get(normalizeScreenName(name))?.conn?.destroy();
  }

  // Test only: that occupant's connection ends with a TCP reset, as a path that died under it does.
  resetChat(name: string, room: RoomRef): void {
    const conn = this.byName(room.exchange, room.name, true)?.occupants.get(normalizeScreenName(name))?.conn;
    if (!conn) throw new Error(`${name} has no socket in ${room.name}`);
    conn.reset();
  }

  evict(name: string, room: RoomRef): void {
    const found = this.byName(room.exchange, room.name, true);
    const occupant = found?.occupants.get(normalizeScreenName(name));
    if (!found || !occupant?.conn) throw new Error(`${name} has no socket in ${room.name}`);
    this.remove(found, occupant);
    occupant.conn.signoffBare();
  }

  // open-oscar-server ends a room connection that overflowed its queue with the same bare sign-off (state/session_manager.go).
  overflow(name: string, room: RoomRef): void {
    this.evict(name, room);
  }

  setRoomRate(name: string, room: RoomRef, status: 'clear' | 'limited', silent = false): void {
    const occupant = this.byName(room.exchange, room.name, true)?.occupants.get(normalizeScreenName(name));
    if (!occupant) throw new Error(`${name} is not in ${room.name}`);
    occupant.limited = status === 'limited';
    // the server pushes 0x01/0x0A only for classes this socket subscribed to with 0x01/0x08
    if (silent || !occupant.subscribed || !occupant.conn || this.silenced.has(occupant.conn)) return;
    const code = status === 'limited' ? RATE_CODE_LIMITED : RATE_CODE_CLEAR;
    occupant.conn.send(FAMILY_OSERVICE, OSERVICE_RATE_PARAM_CHANGE, fakeRateChange(code, CHAT_SEND_RATE_CLASS));
  }

  serviceRequest(conn: FakeConn, requestId: number, body: Uint8Array): void {
    // foodgroup/oservice.go ServiceRequest: on any connection but BOS the answer is error 8.
    if (conn.kind !== 'bos') {
      conn.send(FAMILY_OSERVICE, OSERVICE_ERR, u16(ERR_NOT_SUPPORTED), requestId);
      return;
    }
    const group = Buffer.from(body).readUInt16BE(0);
    const tlvs = decodeTlvs(body.subarray(2));
    const wantsSsl = findTlv(tlvs, SERVICE_TLV_USE_SSL) !== undefined;
    if (wantsSsl && (this.core.generation() === 'v0.24' || this.core.refusesSsl())) {
      conn.send(FAMILY_OSERVICE, OSERVICE_ERR, u16(ERR_GENERAL_FAILURE), requestId);
      return;
    }
    let ticket: ServiceTicket;
    if (group === FAMILY_CHATNAV) {
      ticket = { kind: 'chatnav', name: conn.name, display: conn.display };
    } else if (group === FAMILY_BART) {
      // foodgroup/oservice.go ServiceRequest: BART gets a cookie as ChatNav does, for the instance that asked.
      ticket = { kind: 'bart', name: conn.name, display: conn.display, bos: conn };
    } else if (group === FAMILY_ADMIN) {
      // foodgroup/oservice.go:632, :656-661: Admin gets a cookie for the instance that asked, as BART does.
      const refusal = this.core.adminRefusal();
      if (refusal !== null) {
        conn.send(FAMILY_OSERVICE, OSERVICE_ERR, u16(refusal), requestId);
        return;
      }
      ticket = { kind: 'admin', name: conn.name, display: conn.display, bos: conn };
    } else if (group === FAMILY_ODIR) {
      // foodgroup/oservice.go:657: ODir gets a cookie for the instance that asked, as BART and Admin do. A server without it
      // answers 0x0008 or 0x0005, which the toggle stands for.
      const refusal = this.core.odirRefusal();
      if (refusal !== null) {
        conn.send(FAMILY_OSERVICE, OSERVICE_ERR, u16(refusal), requestId);
        return;
      }
      ticket = { kind: 'odir', name: conn.name, display: conn.display, bos: conn };
    } else if (group === FAMILY_CHAT) {
      const info = findTlv(tlvs, SERVICE_TLV_ROOM_INFO);
      const cookie = info && info.length >= 3 ? Buffer.from(info).toString('utf8', 3, 3 + (info[2] ?? 0)) : '';
      const room = this.known(cookie);
      // foodgroup/oservice.go ServiceRequest, the wire.Chat case: a missing TLV, an unknown cookie and a cookie too long to sign are Go errors: the server drops BOS
      if (!room || Buffer.byteLength(conn.display) + Buffer.byteLength(room.cookie) > COOKIE_NAME_LIMIT) {
        conn.destroy();
        return;
      }
      ticket = { kind: 'chat', name: conn.name, display: conn.display, roomCookie: room.cookie };
    } else {
      conn.send(FAMILY_OSERVICE, OSERVICE_ERR, u16(0x0005), requestId);
      return;
    }
    const cookie = randomBytes(256);
    const refused = ticket.kind === 'chat' && this.refuseTicket;
    if (refused) this.refuseTicket = false;
    // state.DefaultCookieTTL, on the server's clock
    this.tickets.set(cookie.toString('hex'), { ticket, expiresAt: refused ? this.core.now() - 1 : this.core.now() + SERVICE_COOKIE_TTL_MS });
    conn.send(
      FAMILY_OSERVICE,
      OSERVICE_SERVICE_RESPONSE,
      encodeTlvs([
        { tag: 0x000d, value: u16(group) },
        { tag: SERVICE_TLV_RECONNECT_HERE, value: Buffer.from(this.core.advertised()) },
        { tag: SERVICE_TLV_COOKIE, value: cookie },
        { tag: SERVICE_TLV_SSL_STATE, value: Uint8Array.from([this.core.sslState(wantsSsl)]) },
      ]),
      requestId,
    );
  }

  voidTickets(): void {
    this.tickets.clear();
  }

  claim(cookie: Uint8Array): ServiceTicket | null {
    const held = this.tickets.get(Buffer.from(cookie).toString('hex'));
    if (!held || held.expiresAt < this.core.now()) return null;
    return held.ticket;
  }

  attach(conn: FakeConn, ticket: ServiceTicket): void {
    this.attached.set(conn, ticket);
    if (ticket.kind === 'chatnav') {
      conn.send(FAMILY_OSERVICE, OSERVICE_HOST_ONLINE, Buffer.concat([u16(FAMILY_CHATNAV), u16(FAMILY_OSERVICE)]));
      return;
    }
    const room = this.rooms.get((ticket.roomCookie ?? '').toLowerCase());
    if (!room) {
      conn.destroy();
      return;
    }
    const before = room.occupants.get(ticket.name);
    if (before) {
      // One chat session per name per room (InMemoryChatSessionManager.AddSession); the old one signs off bare.
      this.remove(room, before);
      before.conn?.signoffBare();
    }
    room.occupants.set(ticket.name, this.occupant(room, ticket.display, conn, false));
    conn.send(FAMILY_OSERVICE, OSERVICE_HOST_ONLINE, Buffer.concat([u16(FAMILY_OSERVICE), u16(FAMILY_CHAT)]));
  }

  snac(conn: FakeConn, family: number, subtype: number, requestId: number, body: Uint8Array): void {
    const ticket = this.attached.get(conn);
    if (!ticket || this.silenced.has(conn)) return;
    if (family === FAMILY_OSERVICE && subtype === OSERVICE_USER_INFO_QUERY) {
      // foodgroup/oservice.go UserInfoQuery answers on every connection; ChatNav's comes from the BOS session.
      const info = ticket.kind === 'chat' ? this.chatUserInfo(ticket.display) : this.core.bosUserInfo(ticket.name);
      conn.send(FAMILY_OSERVICE, OSERVICE_USER_INFO_UPDATE, info, requestId);
    } else if (family === FAMILY_OSERVICE && subtype === PROBE_REQUEST) {
      // the server cannot marshal the probe's nil-bodied ack (foodgroup/oservice.go:365), so the socket dies
      conn.destroy();
    } else if (family === FAMILY_OSERVICE && subtype === OSERVICE_SERVICE_REQUEST) {
      this.serviceRequest(conn, requestId, body);
    } else if (ticket.kind === 'chatnav' && family === FAMILY_CHATNAV) {
      this.nav(conn, subtype, requestId, body);
    } else if (ticket.kind === 'chat') {
      this.chat(conn, ticket, family, subtype, requestId, body);
    }
  }

  detached(conn: FakeConn): void {
    const ticket = this.attached.get(conn);
    this.attached.delete(conn);
    this.silenced.delete(conn);
    if (!ticket || ticket.kind !== 'chat') return;
    const room = this.rooms.get((ticket.roomCookie ?? '').toLowerCase());
    const occupant = room?.occupants.get(ticket.name);
    if (room && occupant && occupant.conn === conn) this.remove(room, occupant);
  }

  // server/oscar/server.go connectToOSCARService, the BOS OnSessionClose: RemoveUserFromAllChats
  // (state/session_manager.go) closes the account's chat session in every room, and each of those
  // connections writes the bare sign-off.
  bosGone(name: string): void {
    for (const room of this.rooms.values()) {
      const occupant = room.occupants.get(normalizeScreenName(name));
      if (!occupant?.conn) continue;
      this.remove(room, occupant);
      occupant.conn.signoffBare();
    }
  }

  reset(): void {
    this.tickets.clear();
    this.attached.clear();
    this.silenced.clear();
    this.lines.clear();
    for (const room of this.rooms.values()) room.occupants.clear();
  }

  // The server gives a room session no icon. This stands for a server that does.
  setChatIcon(display: string, id: Uint8Array): void {
    this.chatIcons.set(normalizeScreenName(display), id);
  }

  peerJoin(display: string, room: RoomRef): void {
    const found = this.byName(room.exchange, room.name) ?? (room.exchange === 4 ? this.ensure(4, room.name) : undefined);
    if (!found) throw new Error(`public room ${room.name} does not exist; call addRoom first`);
    const occupant = this.occupant(found, display, null, true);
    found.occupants.set(occupant.name, occupant);
    this.toOthers(found, occupant.name, CHAT_USERS_JOINED, this.chatUserInfo(display));
  }

  peerLeave(display: string, room: RoomRef): void {
    const found = this.byName(room.exchange, room.name, true);
    const occupant = found?.occupants.get(normalizeScreenName(display));
    if (found && occupant) this.remove(found, occupant);
  }

  peerLeaveAll(display: string): void {
    for (const room of this.rooms.values()) {
      const occupant = room.occupants.get(normalizeScreenName(display));
      if (occupant && !occupant.conn) this.remove(room, occupant);
    }
  }

  peerSay(display: string, room: RoomRef, text: string, opts: { cookie?: bigint; whisperTo?: string; toc?: boolean } = {}): void {
    const found = this.byName(room.exchange, room.name, true);
    const name = normalizeScreenName(display);
    if (!found?.occupants.has(name)) throw new Error(`${display} is not in ${room.name}`);
    const ascii = /^[\x00-\x7f]*$/.test(text);
    // the TOC gateway sends cookie 0, no encoding TLV, and the raw bytes it was given
    const inner: Tlv[] = opts.toc
      ? [{ tag: CHAT_MSG_TLV_TEXT, value: Buffer.from(text, 'utf8') }]
      : [
          { tag: CHAT_MSG_TLV_ENCODING, value: Buffer.from(ascii ? 'us-ascii' : 'unicode-2-0') },
          { tag: CHAT_MSG_TLV_LANG, value: Buffer.from('en') },
          { tag: CHAT_MSG_TLV_TEXT, value: ascii ? Buffer.from(text, 'ascii') : Buffer.from(text, 'utf16le').swap16() },
        ];
    const cookie = opts.toc ? 0n : (opts.cookie ?? randomBytes(8).readBigUInt64BE(0) | 1n);
    const whisperTo = opts.toc ? undefined : opts.whisperTo;
    const rewritten = serverSeesRoll(text);
    this.relay(found, name, rewritten ? 'OnlineHost' : display, cookie, whisperTo === undefined, whisperTo, rewritten ? diceLine(display) : inner, text);
  }

  peerLines(display: string, room: RoomRef): PeerLine[] {
    return this.lines.get(`${normalizeScreenName(display)}|${room.exchange}:${room.name.toLowerCase()}`) ?? [];
  }

  private ensure(exchange: 4 | 5, name: string): Room {
    const found = this.byName(exchange, name);
    if (found) return found;
    const cookie = `${exchange}-0-${name}`;
    // The server keeps chat sessions by cookie, so a room made again under a removed one's cookie has its occupants.
    const left = this.rooms.get(cookie.toLowerCase());
    const room: Room = {
      exchange, name, cookie, occupants: left?.occupants ?? new Map(), removed: false, joins: left?.joins ?? 0,
      createdAt: Math.floor(this.core.now() / 1000),
    };
    this.rooms.set(cookie.toLowerCase(), room);
    return room;
  }

  // A removed room has no record: only what looks for the people still in it passes `withRemoved`.
  private byName(exchange: number, name: string, withRemoved = false): Room | undefined {
    for (const room of this.rooms.values()) {
      if (room.removed && !withRemoved) continue;
      if (room.exchange === exchange && room.name.toLowerCase() === name.toLowerCase()) return room;
    }
    return undefined;
  }

  // The room record a cookie names, as ChatRoomByCookie finds it.
  private known(cookie: string): Room | undefined {
    const room = this.rooms.get(cookie.toLowerCase());
    return room && !room.removed ? room : undefined;
  }

  private occupant(room: Room, display: string, conn: FakeConn | null, live: boolean): Occupant {
    room.joins += 1;
    return { name: normalizeScreenName(display), display, conn, live, subscribed: false, limited: false, joined: room.joins };
  }

  private deliver(occupant: Occupant, subtype: number, body: Uint8Array): void {
    if (occupant.conn && !this.silenced.has(occupant.conn)) occupant.conn.send(FAMILY_CHAT, subtype, body);
  }

  // state/chat.go TLVList: the same TLVs in the same order, the creation time the room's own.
  private roomInfo(room: Room): Buffer {
    const created = Buffer.alloc(4);
    created.writeUInt32BE(room.createdAt, 0);
    return Buffer.concat([
      u16(room.exchange),
      str8(room.cookie),
      u16(0),
      Buffer.from([0x02]),
      Buffer.from(
        encodeTlvBlock([
          { tag: 0x00c9, value: u16(15) },
          { tag: 0x00ca, value: created },
          { tag: 0x00d1, value: u16(1024) },
          { tag: 0x00d2, value: u16(100) },
          { tag: 0x00d5, value: Buffer.from([0x02]) },
          { tag: 0x006a, value: Buffer.from(room.name) },
          { tag: ROOM_TLV_NAME, value: Buffer.from(room.name) },
          { tag: 0x00da, value: u16(1024) },
        ]),
      ),
    ]);
  }

  private nav(conn: FakeConn, subtype: number, requestId: number, body: Uint8Array): void {
    const b = Buffer.from(body);
    const exchange = b.readUInt16BE(0);
    const cookieLen = b.readUInt8(2);
    const cookie = b.toString('utf8', 3, 3 + cookieLen);
    const navError = (code: number): void => conn.send(FAMILY_CHATNAV, CHATNAV_ERR, u16(code), requestId);
    const reply = (room: Room): void =>
      conn.send(FAMILY_CHATNAV, CHATNAV_NAV_INFO, encodeTlvs([{ tag: CHATNAV_TLV_ROOM_INFO, value: this.roomInfo(room) }]), requestId);
    if (exchange !== 4 && exchange !== 5) {
      navError(ERR_NOT_SUPPORTED);
      return;
    }
    if (this.strayArmed && this.core.generation() === 'v0.24') {
      // At v0.24 the ChatNav connection shares the BOS session, so a BOS rate notice can come out here.
      this.strayArmed = false;
      conn.send(FAMILY_OSERVICE, OSERVICE_RATE_PARAM_CHANGE, fakeRateChange(RATE_CODE_LIMITED, BOS_IM_RATE_CLASS));
    }
    if (subtype === CHATNAV_CREATE_ROOM) {
      if (this.createsToDrop > 0) {
        this.createsToDrop -= 1;
        conn.destroy();
        return;
      }
      const { tlvs } = decodeTlvBlock(body, 3 + cookieLen + 3);
      const name = findTlv(tlvs, ROOM_TLV_NAME);
      if (!name) {
        conn.destroy();
        return;
      }
      const wanted = Buffer.from(name).toString('utf8');
      const found = this.byName(exchange, wanted);
      if (found) {
        reply(found);
      } else if (exchange === 5) {
        navError(CHATNAV_ERR_NO_MATCH);
      } else if (this.raceArmed) {
        // lookup-then-insert is not transactional: the loser of a create race hits the primary key and its socket drops
        this.raceArmed = false;
        this.ensure(4, wanted);
        conn.destroy();
      } else {
        reply(this.ensure(4, wanted));
      }
      return;
    }
    if (subtype === CHATNAV_REQUEST_ROOM_INFO) {
      const found = this.known(cookie);
      if (!found || found.exchange !== exchange) conn.destroy();
      else reply(found);
    }
  }

  private chat(conn: FakeConn, ticket: ServiceTicket, family: number, subtype: number, requestId: number, body: Uint8Array): void {
    const room = this.rooms.get((ticket.roomCookie ?? '').toLowerCase());
    const occupant = room?.occupants.get(ticket.name);
    if (!room || !occupant || occupant.conn !== conn) return;
    if (family === FAMILY_OSERVICE && subtype === OSERVICE_RATE_PARAMS_QUERY) {
      conn.send(FAMILY_OSERVICE, OSERVICE_RATE_PARAMS_REPLY, fakeRateParamsReply(), requestId);
    } else if (family === FAMILY_OSERVICE && subtype === OSERVICE_RATE_PARAMS_SUB_ADD) {
      const ids = Buffer.from(body);
      for (let at = 0; at + 2 <= ids.length; at += 2) {
        if (ids.readUInt16BE(at) === CHAT_SEND_RATE_CLASS) occupant.subscribed = true;
      }
    } else if (family === FAMILY_OSERVICE && subtype === OSERVICE_CLIENT_ONLINE) {
      occupant.live = true;
      // setOnlineChatUsers walks a Go map (foodgroup/chat.go): the joiner first, then latest first, not join order.
      const others = [...room.occupants.values()].filter((o) => o.live && o !== occupant).sort((a, b) => b.joined - a.joined);
      const everyone = [occupant, ...others].map((o) => Buffer.from(this.chatUserInfo(o.display)));
      conn.send(FAMILY_CHAT, CHAT_USERS_JOINED, Buffer.concat(everyone));
      conn.send(FAMILY_CHAT, CHAT_ROOM_INFO_UPDATE, this.roomInfo(room));
      this.toOthers(room, occupant.name, CHAT_USERS_JOINED, this.chatUserInfo(occupant.display));
    } else if (family === FAMILY_CHAT && subtype === CHAT_MSG_TO_HOST) {
      this.fromClient(conn, room, occupant, requestId, body);
    }
  }

  private fromClient(conn: FakeConn, room: Room, occupant: Occupant, requestId: number, body: Uint8Array): void {
    const tlvs = decodeTlvs(body.subarray(10));
    const info = findTlv(tlvs, CHAT_TLV_MESSAGE);
    const inner = info ? decodeTlvs(info) : [];
    const text = findTlv(inner, CHAT_MSG_TLV_TEXT);
    if (!info || !text) {
      conn.destroy();
      return;
    }
    // the server drops a limited sender's SNAC without any reply
    if (occupant.limited) return;
    const cookie = Buffer.from(body).readBigUInt64BE(0);
    const isPublic = findTlv(tlvs, CHAT_TLV_PUBLIC) !== undefined;
    const target = findTlv(tlvs, CHAT_TLV_WHISPER_TO);
    const whisperTo = target && !isPublic ? Buffer.from(target).toString('utf8') : undefined;
    const kept = inner.filter((t) => t.tag === CHAT_MSG_TLV_TEXT || t.tag === CHAT_MSG_TLV_ENCODING || t.tag === CHAT_MSG_TLV_LANG);
    const plain = Buffer.from(text).toString('utf8');
    const reflect = findTlv(tlvs, CHAT_TLV_REFLECT) !== undefined;
    if (serverSeesRoll(plain)) {
      this.relay(room, occupant.name, 'OnlineHost', cookie, isPublic, whisperTo, diceLine(occupant.display), plain, reflect ? { conn, requestId } : undefined);
      return;
    }
    this.relay(room, occupant.name, occupant.display, cookie, isPublic, whisperTo, kept, plain, reflect ? { conn, requestId } : undefined);
  }

  private relay(
    room: Room,
    senderName: string,
    senderDisplay: string,
    cookie: bigint,
    isPublic: boolean,
    whisperTo: string | undefined,
    inner: Tlv[],
    plain: string,
    reflectTo?: { conn: FakeConn; requestId: number },
  ): void {
    const head = Buffer.alloc(10);
    head.writeBigUInt64BE(cookie, 0);
    head.writeUInt16BE(3, 8);
    const tlvs: Tlv[] = [{ tag: CHAT_TLV_SENDER, value: this.chatUserInfo(senderDisplay) }];
    if (isPublic) tlvs.push({ tag: CHAT_TLV_PUBLIC, value: new Uint8Array(0) });
    tlvs.push({ tag: CHAT_TLV_MESSAGE, value: encodeTlvs(inner) });
    const body = Buffer.concat([head, Buffer.from(encodeTlvs(tlvs))]);
    const targets =
      whisperTo === undefined
        ? [...room.occupants.values()].filter((o) => o.name !== senderName)
        : [room.occupants.get(normalizeScreenName(whisperTo))].filter((o): o is Occupant => o !== undefined);
    for (const occupant of targets) {
      if (!occupant.live) continue;
      if (occupant.conn) {
        this.deliver(occupant, CHAT_MSG_TO_CLIENT, body);
      } else {
        const key = `${occupant.name}|${room.exchange}:${room.name.toLowerCase()}`;
        const parsed = decodeRoomMessage(body);
        const seen = this.lines.get(key) ?? [];
        seen.push({ from: normalizeScreenName(senderDisplay), text: parsed ? Buffer.from(parsed.text).toString('utf8') : plain, whisper: !isPublic });
        this.lines.set(key, seen);
      }
    }
    reflectTo?.conn.send(FAMILY_CHAT, CHAT_MSG_TO_CLIENT, body, reflectTo.requestId);
  }

  private remove(room: Room, occupant: Occupant): void {
    if (room.occupants.get(occupant.name) !== occupant) return;
    room.occupants.delete(occupant.name);
    if (occupant.live) this.toOthers(room, occupant.name, CHAT_USERS_LEFT, this.chatUserInfo(occupant.display));
  }

  private toOthers(room: Room, except: string, subtype: number, body: Uint8Array): void {
    for (const other of room.occupants.values()) {
      if (other.name !== except && other.live) this.deliver(other, subtype, body);
    }
  }

  private chatUserInfo(display: string): Uint8Array {
    const icon = this.chatIcons.get(normalizeScreenName(display));
    // a chat session carries none of the BOS state: flags 0x0010, status 0, and a sign-on time from the zero time.Time
    return encodeUserInfo({
      name: display,
      warning: 0,
      tlvs: [
        { tag: 0x0003, value: u32(CHAT_SIGNON_TIME) },
        { tag: 0x0001, value: u16(CHAT_USER_FLAGS) },
        { tag: 0x0006, value: u32(0) },
        ...(icon ? [{ tag: USER_INFO_BART, value: icon }] : []),
      ],
    });
  }
}
