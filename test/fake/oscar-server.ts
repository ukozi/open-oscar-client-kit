import { createHash, randomBytes } from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import { FAMILY_ADMIN } from '../../src/wire/admin.js';
import { strongHash } from '../../src/wire/auth.js';
import {
  BART_CLEAR_HASH,
  BART_FLAG_CUSTOM,
  BART_FLAG_UNKNOWN,
  BART_TYPE_BUDDY_ICON,
  decodeBartInfo,
  encodeBartId,
  encodeBartInfo,
  isClearHash,
  readBartId,
} from '../../src/wire/bart.js';
import type { BartId } from '../../src/wire/bart.js';
import { ByteReader, ByteWriter, OscarDecodeError, concatBytes, toHex } from '../../src/wire/bytes.js';
import {
  CAP_DIRECT_IM,
  CAP_GET_FILE,
  CAP_MOBILE_CLIENT,
  CAP_SEND_FILE,
  FAMILY_OSERVICE,
  FAMILY_POPUP,
  ICBM_CHANNEL_IM,
  ICBM_CHANNEL_RENDEZVOUS,
  ICBM_TLV_AUTO_RESPONSE,
  ICBM_TLV_IM_DATA,
  ICBM_TLV_RENDEZVOUS,
  ICBM_TLV_REQUEST_HOST_ACK,
  ICBM_TLV_SEND_TIME,
  ICBM_TLV_STORE,
  LOCATE_TLV_AWAY_TEXT,
  LOCATE_TLV_CAPABILITIES,
  OSERVICE_BART_REPLY,
  OSERVICE_MULTI_INSTANCE_VERSION,
  POPUP_DISPLAY,
  POPUP_TLV_HEIGHT,
  POPUP_TLV_MESSAGE,
  POPUP_TLV_URL,
  POPUP_TLV_WIDTH,
  RATE_CODE_ALERT,
  RATE_CODE_CLEAR,
  RATE_CODE_LIMITED,
  RDV_FRAGMENT_MIN_BYTES,
  USER_FLAG_AWAY,
  USER_FLAG_BOT,
  USER_FLAG_WIRELESS,
  USER_INFO_BART,
  USER_INFO_CAPABILITIES,
  USER_INFO_EXTERNAL_IP,
  USER_INFO_EXTERNAL_IP_TEXT,
  USER_INFO_FLAGS,
  USER_INFO_INSTANCE,
  USER_INFO_PRIMARY_INSTANCE,
  USER_INFO_STATUS,
  USER_STATUS_INVISIBLE,
} from '../../src/wire/constants.js';
import {
  BART_ICON_ITEM_NAME,
  FEEDBAG_ATTR_BART_INFO,
  FEEDBAG_CLASS_BART,
  FEEDBAG_CLASS_BUDDY,
  FEEDBAG_CLASS_DENY,
  FEEDBAG_CLASS_PDINFO,
  FEEDBAG_CLASS_PERMIT,
  FEEDBAG_DELETE,
  FEEDBAG_END_CLUSTER,
  FEEDBAG_ERR,
  FEEDBAG_STATUS,
  encodeFeedbagItems,
  readFeedbagItem,
} from '../../src/wire/feedbag.js';
import type { FeedbagItem } from '../../src/wire/feedbag.js';
import { FlapDecoder, decodeSignonPayload, encodeFlap, encodeSignonPayload } from '../../src/wire/flap.js';
import {
  ICBM_ERROR_TLV_SUBCODE,
  ICBM_SUBERROR_OFFLINE_FULL,
  decodeImFragments,
  encodeChatInvite,
  encodeChatInviteCancel,
  encodeImFragments,
  newCookie,
  parseInvite,
  parseInviteCancel,
} from '../../src/wire/icbm.js';
import { LOCATE_MIME } from '../../src/wire/locate.js';
import { FAMILY_ODIR } from '../../src/wire/odir.js';
import type { DirListing, KeywordGroup } from '../../src/wire/odir.js';
import { checkRate } from '../../src/wire/rate.js';
import type { RateCheck, RateClassParams, RateStatus } from '../../src/wire/rate.js';
import { decodeSnac, encodeSnac, encodeUserInfo } from '../../src/wire/snac.js';
import type { Snac, UserInfo } from '../../src/wire/snac.js';
import { decodeWireText, encodeImText, normalizeScreenName } from '../../src/wire/text.js';
import { decodeTlvs, encodeTlvs, findTlv, hasTlv, tlv, tlvStr, tlvU32, tlvU8 } from '../../src/wire/tlv.js';
import type { Tlv } from '../../src/wire/tlv.js';
import { ADMIN_HOST_ONLINE, FakeAdmin } from './oscar-admin.js';
import type { Logger, TimerApi } from '../../src/wire/types.js';
import { Rendezvous } from '../../src/client/rendezvous.js';
import { FakeRelay } from './oscar-relay.js';
import { PeerFiles } from './peer-files.js';
import type { PeerFolderFile, PeerTransfer } from './peer-files.js';
import { PeerDirectIms } from './peer-direct-im.js';
import type { PeerDirectIm, PeerDirectImForm } from './peer-direct-im.js';
import { PeerGetFile } from './peer-get-file.js';
import type { PeerBrowse, PeerBrowseOdd, PeerClient, PeerShare, PeerShareForm, PeerShareOdd } from './peer-get-file.js';
import type { Relayed } from './oscar-relay.js';
import type { PeerAddress } from '../../src/wire/rendezvous.js';
import type { FileSink } from '../../src/model/transfer.js';
import { FakeRooms } from './oscar-rooms.js';
import { TEST_TLS_CERT, TEST_TLS_KEY } from './tls-fixture.js';
import type { FakeConn, FakeGeneration, ServiceTicket } from './oscar-rooms.js';
import { blocks, related } from './relationship.js';

export type ConnKind = 'auth' | 'bos' | 'chatnav' | 'chat' | 'bart' | 'admin' | 'odir';
export type SnacRecord = { family: number; subtype: number; requestId: number; body: Uint8Array; conn: ConnKind };
export type StartOptions = {
  host?: string;                            // the address the server listens on; default '127.0.0.1'
  port?: number;                            // the port the server listens on; default 0, any free port
  now?: () => number;                       // clock for cookies, the limiter and rate accounting; default Date.now
  advertisedHost?: string;                  // TLV 0x05 of the login reply; default `<host>:<port>`, with 127.0.0.1 for 0.0.0.0
  serviceHost?: string;                     // TLV 0x05 of every service response; default `<host>:<port>`, with 127.0.0.1 for 0.0.0.0
  loginLimit?: number;                      // auth connections allowed per minute; default 10
  limiterShape?: 'snac' | 'signoff';        // refusal past the limit; default 'snac'
  sixthSession?: 'bucp-error' | 'bos-signoff'; // default 'bucp-error'
  hostOnline?: number[];                    // family list of 0x01/0x03; default BOS_FAMILIES
  notices?: boolean;                        // default true: the server sends its own IMs
  noticeSender?: string;                    // the name the server's own IMs come from; default 'OOS System Msg'
  oserviceMax?: number;                     // the highest OService version granted; default 4
  wireless?: 'every-instance' | 'never';    // the wireless flag 0x0080 while every instance is mobile, or never; default 'every-instance'
  cookieLifetime?: 'requested' | 'one-minute'; // default 'requested': TLV 0x133A honoured, 60 s without it
  loginReplyName?: 'stored' | 'typed';      // TLV 0x01 of a successful login reply: the stored display name, or the name as typed, which open-oscar-server sends; default 'stored'
  preOnlineStatus?: 'broadcast' | 'silent'; // whether a status write before the instance's client online tells the watchers; default 'broadcast'
  relay?: true;                             // the server relays Direct IM and file offers through a listener of its own; default off
  timers?: TimerApi;                        // the timers of the relay's waits and of the rate monitor; default the system timers
  rateMonitor?: boolean;                    // the rate monitor runs each second; default off: a test calls rateTick
  tls?: true;                               // each listener uses TLS with TEST_TLS_KEY and TEST_TLS_CERT; default plain TCP
  sslHost?: boolean;                        // a TLS server states SSL in the login reply and in a service reply to TLV 0x8C; default true
  refuseSsl?: true;                         // the test server refuses each service request with TLV 0x8C (error 0x01/0x01), as the v0.24 release does; default off
  generation?: FakeGeneration;              // the server release the test server acts as, see FakeGeneration; default 'main'
  checkPasswords?: boolean;                 // false: a BUCP login accepts each password and makes an account that is missing; default true
};

const SERVER_REQUEST_ID = 0x80000000;
const DEFAULT_INVITE_TEXT = 'Join me in this room.';
const COOKIE_TTL_SECONDS = 60;
const MAX_TOKEN_TTL_SECONDS = 31_536_000;
const LIMITER_WINDOW_MS = 60_000;
const MAX_INSTANCES = 5;
const MULTI_SESSION = 0x01;
// state/cookie.go:25-38: the 256-byte cookie has room for 202 bytes of screen name plus client id.
const COOKIE_NAME_AND_CLIENT_ID_MAX = 202;
const LOGIN_ERR_UNKNOWN_NAME = 0x0001;
const LOGIN_ERR_BAD_PASSWORD = 0x0005;
const LOGIN_ERR_INTERNAL_CLIENT = 0x0006;
const LOGIN_ERR_RATE_LIMITED = 0x001d;
const SESSION_CAP_SIGNOFF = [tlv.u8(0x08, 0x18)];
const NEW_LOGIN_SIGNOFF = [tlv.u8(0x09, 0x01), tlv.str(0x0b, 'https://github.com/mk6i/open-oscar-server')];
const BOS_FAMILIES = [0x0018, 0x0010, 0x0003, 0x0013, 0x0004, 0x0015, 0x0002, 0x0001, 0x0009, 0x000a, 0x0006, 0x0008, 0x000b];
const BART_FAMILIES = [0x0010, 0x0001];
// foodgroup/oservice.go HostOnline, the wire.ODir case.
const ODIR_HOST_ONLINE = [0x000f, 0x0001];
// wire/snacs.go: SetDirReply's result, SetKeywordReply's unknown and GetDirReply's status, all 1; InfoReply's statuses;
// KeywordListReply's status; the keyword list's item types.
const LOCATE_DIR_OK = 0x0001;
const ODIR_SEARCH_OK = 0x0005;
const ODIR_SEARCH_NAME_MISSING = 0x0004;
const ODIR_KEYWORD_LIST_OK = 0x0001;
const ODIR_KEYWORD_CATEGORY = 0x01;
const ODIR_KEYWORD = 0x02;
// state/user_store.go SetKeywords: five slots.
const KEYWORD_SLOTS = 5;
// The ten fields of a listing (state/user.go AIMNameAndAddr) by their TLV tag (wire/snacs.go ODirTLV*), in the order
// foodgroup/locate.go DirInfo sends them.
const DIR_FIELDS = [
  ['firstName', 0x0001],
  ['lastName', 0x0002],
  ['middleName', 0x0003],
  ['maidenName', 0x0004],
  ['country', 0x0006],
  ['state', 0x0007],
  ['city', 0x0008],
  ['nickName', 0x000c],
  ['zip', 0x000d],
  ['address', 0x0021],
] as const;
const ODIR_TLV_EMAIL = 0x0005;
const ODIR_TLV_SCREEN_NAME = 0x0009;
const ODIR_TLV_INTEREST = 0x000b;
// wire/snacs.go BARTTypesBuddyIconSmall: with the buddy icon, the one other type that becomes the session's icon.
const BART_TYPE_BUDDY_ICON_SMALL = 0x0000;
const BLANK_GIF = Uint8Array.of(
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x32, 0x00, 0x32, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00,
  0x32, 0x00, 0x32, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b,
);

const RATE_CLASSES: RateClassParams[] = [
  { id: 1, windowSize: 80, clearLevel: 2500, alertLevel: 2000, limitLevel: 1500, disconnectLevel: 800, currentLevel: 6000, maxLevel: 6000 },
  { id: 2, windowSize: 80, clearLevel: 3000, alertLevel: 2000, limitLevel: 1500, disconnectLevel: 1000, currentLevel: 6000, maxLevel: 6000 },
  { id: 3, windowSize: 20, clearLevel: 5100, alertLevel: 5000, limitLevel: 4000, disconnectLevel: 3000, currentLevel: 6000, maxLevel: 6000 },
  { id: 4, windowSize: 20, clearLevel: 5500, alertLevel: 5300, limitLevel: 4200, disconnectLevel: 3000, currentLevel: 8000, maxLevel: 8000 },
  { id: 5, windowSize: 10, clearLevel: 5500, alertLevel: 5300, limitLevel: 4200, disconnectLevel: 3000, currentLevel: 8000, maxLevel: 8000 },
];
const RATE_GROUPS: Record<number, [number, number][]> = {
  1: [
    ...[0x02, 0x04, 0x06, 0x08, 0x0e, 0x11, 0x17, 0x1e].map((s): [number, number] => [0x01, s]),
    ...[0x02, 0x04, 0x15].map((s): [number, number] => [0x02, s]),
    ...[0x02, 0x04, 0x08, 0x10, 0x14].map((s): [number, number] => [0x04, s]),
    ...[0x02, 0x04, 0x05, 0x07, 0x08, 0x09, 0x0a, 0x11, 0x12].map((s): [number, number] => [0x13, s]),
    // wire/rate_limit.go:308-313: upload, download and the second download query.
    ...[0x02, 0x04, 0x06].map((s): [number, number] => [0x10, s]),
    // wire/rate_limit.go:236-246: every Admin subtype, 0x0001 to 0x0009.
    ...[0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09].map((s): [number, number] => [FAMILY_ADMIN, s]),
    // wire/rate_limit.go: SetKeywordInfo, and every ODir subtype.
    [0x02, 0x0f],
    ...[0x01, 0x02, 0x03, 0x04].map((s): [number, number] => [FAMILY_ODIR, s]),
  ],
  2: [],
  3: [[0x04, 0x06], [0x02, 0x05]],
  // wire/rate_limit.go: SetDirInfo and GetDirInfo.
  4: [[0x02, 0x09], [0x02, 0x0b]],
  5: [],
};

// 0x13/0x03: the advertised limits. The test server, like the real server, enforces none of them.
const FEEDBAG_MAX_BY_CLASS = [61, 61, 100, 100, 1, 1, 50, 0, 0, 3, 0, 0, 0, 128, 255, 20, 200, 1, 0, 1, 200];

const RATE_CODE_CHANGED = 1;
// foodgroup/oservice.go:64: the interval of MonitorRateLimits.
const RATE_MONITOR_INTERVAL_MS = 1000;
const IM_RATE_CLASS = 3;
// state/session.go:584-587: a warned class's limit, clear and alert levels stop this far short of its maximum.
const WARN_RATE_HEADROOM = 150;
const WARN_DELTA = 100;
const WARN_DELTA_ANONYMOUS = 30;
const WARN_MAX = 1000;
// foodgroup/icbm.go:947-954, 1020-1024: the server remembers IMs and warnings for an hour, three of each.
const WARN_WINDOW_MS = 3_600_000;
const WARN_MEMORY = 3;
const STATUS_UNAVAILABLE = 0x01 | 0x02 | 0x04 | 0x10;
const STATUS_AWAY = 0x01;
const USER_FLAG_OSCAR_FREE = 0x0010;
const LOCATE_QUERY_PROFILE = 0x01;
const LOCATE_QUERY_AWAY = 0x02;
const ERR_NOT_SUPPORTED_BY_HOST = 0x0008;
const ERR_REQUEST_DENIED = 0x000d;
const NOTICE_SENDER = 'OOS System Msg';
const offlineNotice = (count: number): string =>
  `You just received ${count} IM(s) while you were offline. If you do not wish to receive offline messages, please go to <a href="https://example.invalid/">IM Settings</a>.`;
const locationsNotice = (name: string, count: number): string =>
  `Your screen name (${name}) is now signed into Open OSCAR Server in ${count} locations. Click <a href="https://example.invalid/">here</a> for more information.`;
const RATE_CODE_OF: Record<RateStatus, number> = { alert: RATE_CODE_ALERT, limited: RATE_CODE_LIMITED, clear: RATE_CODE_CLEAR };
const OFFLINE_MAX_PER_SENDER = 10;
const ICBM_ERR_NOT_LOGGED_ON = 0x0004;
const ICBM_ERR_IN_LOCAL_PERMIT_DENY = 0x0010;
const NAMING_CLASSES = [FEEDBAG_CLASS_BUDDY, FEEDBAG_CLASS_PERMIT, FEEDBAG_CLASS_DENY];
const CLIENT_DEFINED_CLASS_MIN = 0x0400;
// The relay strips these from what the sender wrote: foodgroup/icbm.go:171-187.
const NOT_RELAYED = [ICBM_TLV_REQUEST_HOST_ACK, ICBM_TLV_STORE, ICBM_TLV_SEND_TIME];

function u16s(values: readonly number[]): Uint8Array {
  const w = new ByteWriter();
  for (const value of values) w.u16(value);
  return w.toBytes();
}

const latin1 = (text: string | Uint8Array): Uint8Array => (typeof text === 'string' ? new Uint8Array(Buffer.from(text, 'latin1')) : text);

const ipv4Bytes = (text: string): Uint8Array => (net.isIPv4(text) ? Uint8Array.from(text.split('.').map(Number)) : new Uint8Array(4));

const snacKey = (family: number, subtype: number): number => family * 0x10000 + subtype;

// strconv.ParseUint(name, 0, 16), as setBARTItem reads an icon item's name: decimal, or hex, binary or octal by prefix.
function bartTypeOf(name: string): number | null {
  if (!/^(0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO]?[0-7]+|[1-9][0-9]*|0)$/.test(name)) return null;
  const value = Number(/^0[0-7]+$/.test(name) ? `0o${name.slice(1)}` : name);
  return value <= 0xffff ? value : null;
}

const RATE_CLASS_OF = new Map<number, number>(
  Object.entries(RATE_GROUPS).flatMap(([id, pairs]) => pairs.map(([f, s]): [number, number] => [snacKey(f, s), Number(id)])),
);

// `subscribed` is the account's (state/session.go:605-613); `original` is what a warning scales away from (state/session.go:570-571).
type RateState = {
  params: RateClassParams;
  original: RateClassParams;
  level: number;
  lastAt: number;
  limited: boolean;
  status: RateCheck['status'];
  subscribed: boolean;
};

function freshRates(now: number, old?: Map<number, RateState>): Map<number, RateState> {
  return new Map(
    RATE_CLASSES.map((c): [number, RateState] => {
      const params = old?.get(c.id)?.params ?? { ...c };
      const original = old?.get(c.id)?.original ?? { ...c };
      return [c.id, { params, original, level: params.maxLevel, lastAt: now, limited: false, status: 'clear', subscribed: false }];
    }),
  );
}

type Held = (() => void)[];
type Gate = { turn: number; readonly withheld: Map<number, Held> };

type Account = {
  display: string;
  password: string;
  authKey: string;
  loginError?: number;
  bot: boolean;
  feedbag: FeedbagItem[];
  // The names of 0x03/0x04 and 0x03/0x05, normalised. The session ends them.
  sessionBuddies: Set<string>;
  peer: Presence;
  warning: number;
  signonAt: number;
  sessionFlag: number;
  instances: Instance[];
  lastInstanceNum: number;
  peerOnline: boolean;
  rates: Map<number, RateState>;
  dropped: number;
  notices: RateNotice[];
  stored: StoredMessage[];
  // state/user.go:202-203: the messages stored since the account was last told how many there are.
  offlineCount: number;
  inbox: Delivery[];
  // The script of the peer for each delivery and each client error, when it has one.
  peerHears: ((delivery: Delivery) => void) | null;
  peerRefused: ((cookie: bigint) => void) | null;
  peerCaps: Uint8Array[];
  typing: PeerTypingEvent[];
  sightings: Sighting[];
  icon: BartId | null;
  // The directory listing (the users table's aim_* columns), every field '' until set.
  listing: FakeDirInfo;
  // The five keyword slots (aim_keyword1 to 5): a name the keyword list did not hold when it was set is null.
  keywords: (string | null)[];
  // The interests of every 0x02/0x0F received, as sent.
  keywordWrites: string[][];
};
// The ten fields the server keeps for a listing: the five a client shows, and five it clears.
export type FakeDirInfo = DirListing & { middleName: string; maidenName: string; nickName: string; zip: string; address: string };
const emptyDirInfo = (): FakeDirInfo => ({
  firstName: '',
  lastName: '',
  middleName: '',
  maidenName: '',
  country: '',
  state: '',
  city: '',
  nickName: '',
  zip: '',
  address: '',
});
type Profile = { mime: string; bytes: Uint8Array; at: number };
// `awayAt` and `Profile.at` count changes, not milliseconds, so two changes in one millisecond keep their order.
type Presence = {
  awayFlag: boolean;
  awayMessage: Uint8Array;
  awayAt: number;
  profile: Profile | null;
  status: number;
  idle: { since: number } | { minutes: number } | null;
};
const freshPresence = (): Presence => ({ awayFlag: false, awayMessage: new Uint8Array(0), awayAt: 0, profile: null, status: 0, idle: null });
export type PeerTypingEvent = { from: string; event: number };
type Convo = { ims: number[]; warnings: number[] };
export type Sighting = { name: string; event: 'arrived' | 'departed'; away: boolean; idleMinutes: number | null; warning: number; icon: string | null };
type NotifyTxn = { shouldSend: boolean; names: Set<string> };
type RateNotice = { code: number; classId: number; level: number };
type StoredMessage = { sender: string; cookie: bigint; channel: number; tlvs: Tlv[]; sentAt: number };
type Delivery = { from: string; channel: number; tlvs: Tlv[] };
type Instance = {
  conn: Conn;
  complete: boolean;
  listInUse: boolean;
  subscribed: Set<number>;
  caps: Uint8Array[];
  txn: NotifyTxn | null;
  presence: Presence;
  oserviceVersion: number;
  num: number;
  signonAt: number;
};
type Cookie = { name: string; flag: number; expires: number; clientId: string };
export type CloseHow = 'destroy' | 'empty-signoff' | 'kick';
type PeerControl = {
  setAwayMessage(text: Uint8Array): void;
  setProfile(text: Uint8Array, mime: string): void;
  setInvisible(on: boolean): void;
  setIdle(minutes: number | null): void;
  setWarning(level: number): void;
  signOff(): void;
  signOn(): void;
  send(to: string, channel: number, tlvs: Tlv[], cookie: bigint): void;
  typing(to: string, event: number, requestId: number): void;
  clientError(to: string, code: number, requestId: number): void;
  warn(to: string, anonymous: boolean): void;
  inbox(): Delivery[];
  typingEvents(): PeerTypingEvent[];
  watch(name: string): void;
  sightings(): Sighting[];
  setIcon(bytes: Uint8Array): string;
  writeIconItem(flags: number, hash: Uint8Array): void;
  setCapabilities(caps: Uint8Array[]): void;
  // One ICBM 0x04/0x06 body from the peer. With the relay on, a rendezvous fragment in it passes the relay.
  sendThroughRelay(body: Uint8Array): void;
  hear(deliveries: (delivery: Delivery) => void, refusals: (cookie: bigint) => void): void;
  relayAddress(): PeerAddress | null;
  timers: TimerApi;
  now(): number;
};

function toHost(body: Uint8Array): { cookie: bigint; channel: number; to: string; tlvs: Tlv[] } {
  const r = new ByteReader(body);
  return { cookie: r.u64(), channel: r.u16(), to: r.str8(), tlvs: decodeTlvs(r.rest()) };
}

export type PeerInvite = { from: string; kind: 'proposal' | 'decline'; cookie: bigint; roomCookie?: string; exchange?: number; html?: string };

// A drop the real server makes too. The accept loop destroys the socket on it and records nothing.
class ModelledDrop extends Error {}

// Input the codec cannot decode makes the real server drop the connection; anything else thrown here is a bug.
function decoding<T>(decode: () => T): T {
  try {
    return decode();
  } catch (error) {
    if (error instanceof OscarDecodeError) throw new ModelledDrop(error.message, { cause: error });
    throw error;
  }
}

const FLAP_LENGTH_MAX = 0xffff;

/** The server side of one client connection. */
class Conn {
  kind: ConnKind = 'auth';
  name = '';
  readonly decoder = new FlapDecoder();
  private seq = 100;
  ignoreInput = false;
  private held: { queue: Held; turn: number } | null = null;

  constructor(
    readonly socket: net.Socket,
    private readonly gate: Gate,
    // The TCP socket under a TLS socket: a reset goes to it.
    private readonly raw: net.Socket = socket,
  ) {}

  flap(type: number, payload?: Uint8Array): void {
    if (this.socket.destroyed) return;
    if (payload && payload.length > FLAP_LENGTH_MAX) {
      // wire/frames.go SendSNAC: the server refuses no payload for its size; the length field is the length cast to uint16.
      const head = new ByteWriter().u8(0x2a).u8(type).u16(this.seq).u16(payload.length & 0xffff).toBytes();
      this.socket.write(head);
      this.socket.write(payload);
    } else {
      this.socket.write(encodeFlap(type, this.seq, payload));
    }
    this.seq = (this.seq + 1) & 0xffff;
  }

  snac(family: number, subtype: number, requestId: number, body?: Uint8Array): void {
    const send = (): void => this.flap(2, encodeSnac({ family, subtype, requestId }, body));
    const queue = this.gate.withheld.get(snacKey(family, subtype));
    if (!queue) {
      send();
      return;
    }
    queue.push(send);
    this.held = { queue, turn: this.gate.turn };
  }

  // A close that follows a withheld SNAC waits behind it, so the client sees silence and not a close.
  private close(act: () => void): void {
    this.ignoreInput = true;
    if (this.held?.turn === this.gate.turn) this.held.queue.push(act);
    else act();
  }

  // The real server writes this for an instance whose multi-conn flag is 0: no length field, then EOF.
  oldSignoff(): void {
    this.close(() => {
      if (!this.socket.destroyed) this.socket.end(Uint8Array.of(0x2a, 0x04, this.seq >>> 8, this.seq & 0xff));
    });
  }

  signoff(tlvs: Tlv[]): void {
    this.close(() => {
      this.flap(4, encodeTlvs(tlvs));
      this.socket.end();
    });
  }

  destroy(): void {
    this.close(() => this.socket.destroy());
  }

  reset(): void {
    this.close(() => this.raw.resetAndDestroy());
  }
}

export type { Conn };

class RoomConn implements FakeConn {
  constructor(
    readonly conn: Conn,
    // The BOS connection's screen name follows a format change: the services it asks for after it carry the new form.
    public display: string,
  ) {}

  get kind(): ConnKind {
    return this.conn.kind;
  }

  get name(): string {
    return this.conn.name;
  }

  send(family: number, subtype: number, body: Uint8Array, requestId = SERVER_REQUEST_ID): void {
    this.conn.snac(family, subtype, requestId, body);
  }

  destroy(): void {
    this.conn.destroy();
  }

  reset(): void {
    this.conn.reset();
  }

  signoffBare(): void {
    this.conn.oldSignoff();
  }
}

const SILENT_LOG: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

export class FakePeer {
  private files: PeerFiles | null = null;
  private directIm: PeerDirectIms | null = null;
  private getFile: PeerGetFile | null = null;
  private meetings: Rendezvous | null = null;
  private readonly shown: Uint8Array[] = [];
  private readonly hearers: { delivery(delivery: Delivery): void; refusal(cookie: bigint): void }[] = [];

  /** The server makes each peer. @internal */
  constructor(
    readonly name: string,
    private readonly control: PeerControl,
  ) {}

  /** Offers one file through the relay. The result tells how the transfer ended. */
  offerFile(to: string, name: string, bytes: Uint8Array): Promise<PeerTransfer> {
    return this.fileScript().offer(to, name, bytes);
  }

  /** Offers a folder through the relay, in one of the two forms of the old clients. Each path is below the folder. */
  offerFolder(to: string, folder: string, files: readonly PeerFolderFile[], form: 'star' | 'plain' = 'star'): Promise<PeerTransfer> {
    return this.fileScript().offerFolder(to, folder, files, form);
  }

  /** Shows the Send File capability and, from now on, accepts each Send File offer into the sink. */
  acceptOffers(sink: FileSink): void {
    this.fileScript().acceptInto(sink);
    this.show(CAP_SEND_FILE);
  }

  /** Each file transfer of this peer that ended, in order. */
  fileTransfers(): PeerTransfer[] {
    return this.files?.transfers() ?? [];
  }

  /** Ends each file offer and closes each file connection of this peer. */
  stopFiles(): void {
    this.files?.reset();
  }

  /** Offers Direct IM through the relay. The result comes when the connection opened or the offer ended. */
  openDirectIm(to: string, form: PeerDirectImForm = 'speaks'): Promise<PeerDirectIm> {
    return this.directImScript().open(to, form);
  }

  /** Shows the Direct IM capability and, from now on, accepts each Direct IM offer. */
  acceptDirectIm(form: PeerDirectImForm = 'speaks'): void {
    this.directImScript().acceptEach(form);
    this.show(CAP_DIRECT_IM);
  }

  /** Each Direct IM session of this peer, in order. */
  directIms(): PeerDirectIm[] {
    return this.directIm?.sessions() ?? [];
  }

  /**
   * Shows the Get File capability and, from now on, answers each Get File request with the files of the tree.
   * 'asks' accepts a request after `allowShare`. 'refuses' declines each request. `client` is the client that the holder acts as.
   */
  shareFiles(tree: readonly PeerFolderFile[], form: PeerShareForm = 'serves', odd: PeerShareOdd = {}, client: PeerClient = '5.1'): PeerShare {
    const share = this.getFileScript().share(tree, form, odd, client);
    this.show(CAP_GET_FILE);
    return {
      taken: share.taken,
      drop: share.drop,
      stop: () => {
        share.stop();
        this.hide(CAP_GET_FILE);
      },
    };
  }

  /** Accepts each Get File request that waits for an answer. */
  allowShare(): void {
    this.getFile?.allow();
  }

  /**
   * Asks a member for its files through the relay. The result comes when the first listing came or the offer ended.
   * `client` is the client that the requester acts as.
   */
  browseFiles(to: string, odd: PeerBrowseOdd = {}, client: PeerClient = '5.1'): Promise<PeerBrowse> {
    return this.getFileScript().browse(to, odd, client);
  }

  private show(capability: Uint8Array): void {
    if (!this.shown.includes(capability)) this.shown.push(capability);
    this.control.setCapabilities([...this.shown]);
  }

  private hide(capability: Uint8Array): void {
    const at = this.shown.indexOf(capability);
    if (at === -1) return;
    this.shown.splice(at, 1);
    this.control.setCapabilities([...this.shown]);
  }

  // Each script hears each channel 2 message and each refusal.
  private hear(delivery: (delivery: Delivery) => void, refusal: (cookie: bigint) => void): void {
    this.hearers.push({ delivery, refusal });
    if (this.hearers.length > 1) return;
    this.control.hear(
      (heard) => {
        if (heard.channel === ICBM_CHANNEL_RENDEZVOUS) for (const hearer of this.hearers) hearer.delivery(heard);
      },
      (cookie) => {
        for (const hearer of this.hearers) hearer.refusal(cookie);
      },
    );
  }

  private fileScript(): PeerFiles {
    if (this.files) return this.files;
    const { control } = this;
    const files = new PeerFiles({ rendezvous: this.rendezvous(), cookie: newCookie, now: () => control.now() });
    this.files = files;
    this.hear((delivery) => files.heard(delivery.from, delivery.tlvs), (cookie) => files.refused(cookie));
    return files;
  }

  // A peer is one client. Its scripts share one Rendezvous, thus the peer meets the relay for one offer at a time.
  private rendezvous(): Rendezvous {
    if (this.meetings) return this.meetings;
    const { control } = this;
    const meetings = new Rendezvous({
      log: SILENT_LOG,
      timers: control.timers,
      now: () => control.now(),
      // A script can write a proposal as the client that it acts as.
      send: async (body) => control.sendThroughRelay(this.getFile?.outgoing(body) ?? body),
      allowDial: async (address) => {
        const relay = control.relayAddress();
        return relay !== null && relay.ip === address.ip && relay.port === address.port;
      },
    });
    this.meetings = meetings;
    return meetings;
  }

  private directImScript(): PeerDirectIms {
    if (this.directIm) return this.directIm;
    const { control } = this;
    const directIm = new PeerDirectIms({ name: this.name, rendezvous: this.rendezvous(), cookie: newCookie, now: () => control.now() });
    this.directIm = directIm;
    this.hear((delivery) => directIm.heard(delivery.from, delivery.tlvs), (cookie) => directIm.refused(cookie));
    return directIm;
  }

  private getFileScript(): PeerGetFile {
    if (this.getFile) return this.getFile;
    const { control } = this;
    const getFile = new PeerGetFile({ rendezvous: this.rendezvous(), cookie: newCookie, now: () => control.now() });
    this.getFile = getFile;
    this.hear((delivery) => getFile.heard(delivery.from, delivery.tlvs), (cookie) => getFile.refused(cookie));
    return getFile;
  }

  setAway(away: boolean): void {
    this.setAwayMessage(away ? 'away' : '');
  }

  setAwayMessage(text: string | Uint8Array): void {
    this.control.setAwayMessage(latin1(text));
  }

  setProfile(text: string | Uint8Array, mime: string = LOCATE_MIME): void {
    this.control.setProfile(latin1(text), mime);
  }

  setInvisible(on: boolean): void {
    this.control.setInvisible(on);
  }

  setIdle(minutes: number | null): void {
    this.control.setIdle(minutes);
  }

  setWarning(level: number): void {
    this.control.setWarning(level);
  }

  signOff(): void {
    this.control.signOff();
    this.stopFiles();
    this.directIm?.reset();
    this.getFile?.reset();
    this.meetings?.reset();
  }

  signOn(): void {
    this.control.signOn();
  }

  sendIm(to: string, html: string, opts: { charset?: number; bytes?: Uint8Array; autoResponse?: boolean; cookie?: bigint } = {}): void {
    const text = encodeImText(html);
    const tlvs = [tlv.bytes(ICBM_TLV_IM_DATA, encodeImFragments(opts.charset ?? text.charset, opts.bytes ?? text.bytes))];
    if (opts.autoResponse) tlvs.push(tlv.empty(ICBM_TLV_AUTO_RESPONSE));
    this.sendRaw(to, ICBM_CHANNEL_IM, tlvs, opts.cookie);
  }

  sendRaw(to: string, channel: number, tlvs: Tlv[], cookie?: bigint): void {
    this.control.send(to, channel, tlvs, cookie ?? newCookie());
  }

  // Sent through the IM routing, so blocking, the active-instance rule and the stripping of TLV 0x03 apply. Returns the cookie.
  invite(to: string, room: { exchange: 4 | 5; cookie: string }, opts: { text?: string; cookie?: bigint } = {}): bigint {
    const cookie = opts.cookie ?? newCookie();
    const im = toHost(encodeChatInvite(cookie, to, room, opts.text ?? DEFAULT_INVITE_TEXT));
    this.control.send(im.to, im.channel, im.tlvs, im.cookie);
    return cookie;
  }

  declineInvite(to: string, cookie: bigint): void {
    const im = toHost(encodeChatInviteCancel(cookie, to));
    this.control.send(im.to, im.channel, im.tlvs, im.cookie);
  }

  invites(): PeerInvite[] {
    const out: PeerInvite[] = [];
    for (const { from, channel, tlvs } of this.control.inbox()) {
      if (channel !== ICBM_CHANNEL_RENDEZVOUS) continue;
      const sender = encodeUserInfo({ name: from, warning: 0, tlvs: [] });
      const body = new ByteWriter().u64(0n).u16(channel).bytes(sender).bytes(encodeTlvs(tlvs)).toBytes();
      const proposal = parseInvite(body);
      const decline = proposal ? null : parseInviteCancel(body);
      if (proposal) {
        out.push({ from, kind: 'proposal', cookie: proposal.cookie, roomCookie: proposal.roomCookie, exchange: proposal.room.exchange, html: proposal.html });
      } else if (decline) {
        out.push({ from, kind: 'decline', cookie: decline.cookie });
      }
    }
    return out;
  }

  // The real server relays typing events and client errors with the sender's request id (foodgroup/icbm.go:518-560).
  sendTyping(to: string, event: number, requestId: number): void {
    this.control.typing(to, event, requestId);
  }

  sendClientError(to: string, code: number, requestId: number): void {
    this.control.clientError(to, code, requestId);
  }

  warn(to: string, anonymous = false): void {
    this.control.warn(to, anonymous);
  }

  typingEvents(): PeerTypingEvent[] {
    return this.control.typingEvents();
  }

  watch(name: string): void {
    this.control.watch(name);
  }

  sightings(): Sighting[] {
    return this.control.sightings();
  }

  setIcon(bytes: Uint8Array): string {
    return this.control.setIcon(bytes);
  }

  setIconId(id: { flags: number; hash: Uint8Array }): void {
    this.control.writeIconItem(id.flags, id.hash);
  }

  clearIcon(): void {
    this.control.writeIconItem(0x00, BART_CLEAR_HASH);
  }

  ims(): { from: string; html: string; charset: number; tlvs: Tlv[] }[] {
    return this.control
      .inbox()
      .filter((delivery) => delivery.channel === ICBM_CHANNEL_IM)
      .map(({ from, tlvs }) => {
        const fragments = decodeImFragments(findTlv(tlvs, ICBM_TLV_IM_DATA) ?? new Uint8Array(0));
        return { from, html: fragments.map((f) => decodeWireText(f.text, f.charset)).join(''), charset: fragments[0]?.charset ?? 0, tlvs };
      });
  }
}

export type BucpLogin = { name: string; remoteAddress: string; multiConn: number | null; clientId: string | null; tokenTtl: number | null };

export class FakeOscarServer {
  readonly authSignons: Tlv[][] = [];
  // Every 0x17/0x02 read, whatever its answer, with the address it came from and none of the password hash.
  readonly bucpLogins: BucpLogin[] = [];
  // Errors thrown by the test server's own code while it handled a frame; stop() rejects with them.
  readonly faults: unknown[] = [];
  onSnacHook: ((snac: SnacRecord) => void) | null = null;
  readonly rooms: FakeRooms;
  readonly admin: FakeAdmin<Conn>;
  private readonly roomConns = new Map<Conn, RoomConn>();
  private readonly bartConns = new Map<Conn, Conn>();
  private readonly adminConns = new Map<Conn, Conn>();
  private readonly odirConns = new Map<Conn, Conn>();
  // The keyword list as the server holds it: empty until set.
  private keywordList: KeywordGroup[] = [];
  private odirRefusal: number | null = null;
  private sslHost: boolean;
  private readonly generation: FakeGeneration;
  private readonly blobs = new Map<string, Uint8Array>();
  private refusedUpload: number | null = null;
  private listenPort = 0;
  private readonly host: string;
  private readonly opts: StartOptions;
  private readonly now: () => number;
  private server: net.Server | null = null;
  private readonly sockets = new Set<net.Socket>();
  private readonly accounts = new Map<string, Account>();
  private readonly peers = new Map<string, FakePeer>();
  private readonly cookies = new Map<string, Cookie>();
  private readonly log = new Map<string, SnacRecord[]>();
  private readonly gate: Gate = { turn: 0, withheld: new Map() };
  private readonly closing = new Map<number, CloseHow>();
  private readonly failing = new Map<number, { code: number; tlvs?: Tlv[] }>();
  private failingStatus: number | null = null;
  private limiter: { count: number; windowStart: number | null } = { count: 0, windowStart: null };
  private readonly convos = new Map<string, Convo>();
  private changes = 0;
  private readonly relay: FakeRelay | null;
  private monitor: ReturnType<typeof setTimeout> | null = null;

  private constructor(opts: StartOptions) {
    this.opts = opts;
    this.sslHost = opts.sslHost !== false;
    this.generation = opts.generation ?? 'main';
    this.now = opts.now ?? Date.now;
    this.host = opts.host ?? '127.0.0.1';
    this.rooms = new FakeRooms({
      generation: () => this.generation,
      advertised: () => this.opts.serviceHost ?? this.ownAddress(),
      bosConn: (name) => {
        const first = this.accounts.get(normalizeScreenName(name))?.instances.find((i) => i.complete);
        return first ? this.roomConn(first.conn) : undefined;
      },
      bosUserInfo: (name) => this.userInfo(this.known(name)),
      sslState: (wantsSsl) => (wantsSsl && this.statesSsl() ? 0x02 : 0x00),
      refusesSsl: () => this.opts.refuseSsl === true,
      now: () => this.now(),
      adminRefusal: () => this.admin.serviceRefusal(),
      odirRefusal: () => this.odirRefusal,
    });
    this.relay = opts.relay
      ? new FakeRelay({
          host: this.relayHost(),
          timers: opts.timers ?? { setTimeout, clearTimeout },
          // broker.go counterOffer: to the offerer it reads as the recipient asking it to connect.
          counterOffer: ({ offerer, recipient, cookie, fragment }) => {
            const account = this.accounts.get(recipient);
            if (!account || !this.live(account)) return;
            const tlvs = [tlv.bytes(ICBM_TLV_RENDEZVOUS, fragment)];
            const scripted = [...this.accounts.values()].find((each) => each.peer === offerer);
            if (scripted) {
              this.toPeer(scripted, { from: account.display, channel: ICBM_CHANNEL_RENDEZVOUS, tlvs });
              return;
            }
            const body = new ByteWriter().u64(cookie).u16(ICBM_CHANNEL_RENDEZVOUS).bytes(this.userInfo(account)).bytes(encodeTlvs(tlvs)).toBytes();
            (offerer as Instance).conn.snac(4, 0x07, SERVER_REQUEST_ID, body);
          },
        })
      : null;
    this.admin = new FakeAdmin<Conn>({
      display: (ident) => this.known(ident).display,
      // foodgroup/admin.go:209-218: every instance takes the stored name, then the watchers get an arrival, none while invisible.
      rename: (ident, display) => {
        const account = this.known(ident);
        account.display = display;
        for (const instance of account.instances) {
          const held = this.roomConns.get(instance.conn);
          if (held) held.display = display;
        }
        if (this.online(account) && !this.invisible(account)) this.broadcastArrived(account);
      },
      selfInfo: (bos) => {
        const account = this.accounts.get(bos.name);
        const instance = account?.instances.find((i) => i.conn === bos);
        if (account && instance) bos.snac(1, 0x0f, SERVER_REQUEST_ID, this.userInfo(account, instance.presence.status));
      },
    });
  }

  static async start(opts: StartOptions = {}): Promise<FakeOscarServer> {
    const fake = new FakeOscarServer(opts);
    await fake.listen(opts.port ?? 0);
    await fake.relay?.listen();
    if (opts.rateMonitor) fake.monitorRates();
    return fake;
  }

  get port(): number {
    return this.listenPort;
  }

  /** The port of the relay's listener. It throws when the relay is off. */
  get relayPort(): number {
    if (!this.relay) throw new Error('the relay is off');
    return this.relay.port;
  }

  /** Each pair of connections the relay joined, in order. */
  relayed(): Relayed[] {
    return this.relay?.relayed() ?? [];
  }

  /** The cookie of each session the relay holds. */
  relaySessions(): bigint[] {
    return this.relay?.waiting() ?? [];
  }

  private ownAddress(): string {
    return `${this.host === '0.0.0.0' ? '127.0.0.1' : this.host}:${this.port}`;
  }

  // TLV 0x8E of the login reply, and of a service reply when the request asks for SSL.
  private statesSsl(): boolean {
    return this.opts.tls === true && this.sslHost && this.generation === 'main';
  }

  private listen(port: number): Promise<void> {
    const context = this.opts.tls ? tls.createSecureContext({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT }) : null;
    const server = net.createServer((raw) =>
      context ? this.accept(new tls.TLSSocket(raw, { isServer: true, secureContext: context }), raw) : this.accept(raw),
    );
    this.server = server;
    return new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, this.host, () => {
        this.listenPort = (server.address() as net.AddressInfo).port;
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (this.monitor !== null) (this.opts.timers ?? { clearTimeout }).clearTimeout(this.monitor);
    this.monitor = null;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    for (const peer of this.peers.values()) peer.stopFiles();
    const faults = this.faults.splice(0);
    const stopped = new Promise<void>((resolve, reject) => {
      const done = (): void => {
        if (faults.length === 0) resolve();
        else reject(new AggregateError(faults, `the test server threw while handling a frame: ${faults.map(String).join('; ')}`));
      };
      if (server) server.close(done);
      else done();
    });
    return (this.relay?.stop() ?? Promise.resolve()).then(() => stopped);
  }

  // Every cookie and service ticket issued so far stops cracking, as after a restart.
  voidCookies(): void {
    this.cookies.clear();
    this.rooms.voidTickets();
  }

  // server.go:660-669: shutting down writes an empty sign-off to every BOS instance; then nothing listens.
  async shutdown(): Promise<void> {
    for (const ident of [...this.accounts.keys()]) this.endSession(ident, (conn) => conn.signoff([]));
    const server = this.server;
    this.server = null;
    server?.close();
  }

  async resume(): Promise<void> {
    this.voidCookies();
    await this.listen(this.listenPort);
  }

  // `bot` gives the user flag 0x0400, and no warning reaches the account. The rate limiter counts its SNACs as for any account.
  addUser(name: string, password: string, opts: { loginError?: number; bot?: boolean } = {}): void {
    const ident = normalizeScreenName(name);
    const account: Account = this.accounts.get(ident) ?? {
      display: name,
      password,
      authKey: `salt-${ident}`,
      bot: false,
      feedbag: [],
      sessionBuddies: new Set(),
      peer: freshPresence(),
      warning: 0,
      signonAt: 0,
      sessionFlag: 0,
      instances: [],
      lastInstanceNum: 0,
      peerOnline: false,
      rates: freshRates(this.now()),
      dropped: 0,
      notices: [],
      stored: [],
      offlineCount: 0,
      inbox: [],
      peerHears: null,
      peerRefused: null,
      peerCaps: [],
      typing: [],
      sightings: [],
      icon: null,
      listing: emptyDirInfo(),
      keywords: [],
      keywordWrites: [],
    };
    account.display = name;
    account.password = password;
    account.bot = opts.bot === true;
    if (opts.loginError === undefined) delete account.loginError;
    else account.loginError = opts.loginError;
    this.accounts.set(ident, account);
  }

  checkPassword(name: string, password: string): boolean {
    return this.accounts.get(normalizeScreenName(name))?.password === password;
  }

  // Whether auth refuses a login that asks for multi-conn flag `multiConn` because the account already holds its limit of instances.
  atSessionCap(name: string, multiConn: number): boolean {
    const account = this.accounts.get(normalizeScreenName(name));
    return (
      account !== undefined &&
      this.opts.sixthSession !== 'bos-signoff' &&
      multiConn === MULTI_SESSION &&
      account.sessionFlag === MULTI_SESSION &&
      account.instances.length >= MAX_INSTANCES
    );
  }

  issueCookie(name: string, opts: { multiConn: number; ttlSeconds: number; clientId: string }): Uint8Array {
    const expires = Math.floor(this.now() / 1000) + opts.ttlSeconds;
    const cookie = this.mintCookie(expires);
    this.cookies.set(Buffer.from(cookie).toString('hex'), { name, flag: opts.multiConn, expires: expires * 1000, clientId: opts.clientId });
    return cookie;
  }

  setFeedbag(name: string, items: FeedbagItem[]): void {
    const account = this.accounts.get(normalizeScreenName(name));
    if (!account) throw new Error(`no account named "${name}"`);
    account.feedbag = [...items];
  }

  feedbagOf(name: string): FeedbagItem[] {
    return [...(this.accounts.get(normalizeScreenName(name))?.feedbag ?? [])];
  }

  // The names the account holds through 0x03/0x04 and 0x03/0x05, normalised, in the order added.
  sessionBuddiesOf(name: string): string[] {
    return [...(this.accounts.get(normalizeScreenName(name))?.sessionBuddies ?? [])];
  }

  // The text of the latest away write of a presence that is away, or null. The server labels each away text US-ASCII.
  awayOf(name: string): string | null {
    const account = this.accounts.get(normalizeScreenName(name));
    const text = account ? this.awayMessage(account) : new Uint8Array(0);
    return text.length > 0 ? decodeWireText(text, 'us-ascii') : null;
  }

  instancesOf(name: string): number {
    return this.accounts.get(normalizeScreenName(name))?.instances.length ?? 0;
  }

  // The OService version granted to the index-th BOS connection of the account.
  oserviceVersionOf(name: string, index: number): number {
    const instance = this.known(name).instances[index];
    if (!instance) throw new Error(`"${name}" has no instance ${index}`);
    return instance.oserviceVersion;
  }

  openConnections(name: string): ConnKind[] {
    const ident = normalizeScreenName(name);
    const bos = (this.accounts.get(ident)?.instances ?? []).map((i) => i.conn.kind);
    const service = [...this.roomConns.keys(), ...this.bartConns.keys(), ...this.adminConns.keys(), ...this.odirConns.keys()]
      .filter((conn) => conn.kind !== 'bos' && conn.name === ident)
      .map((conn) => conn.kind);
    return [...bos, ...service].sort();
  }

  setListing(name: string, listing: Partial<FakeDirInfo>): void {
    this.known(name).listing = { ...emptyDirInfo(), ...listing };
  }

  listingOf(name: string): FakeDirInfo {
    return { ...this.known(name).listing };
  }

  // Sets the interests as if from another computer, and records no write.
  setKeywords(name: string, interests: readonly string[]): void {
    this.storeKeywords(this.known(name), interests);
  }

  // The interests the server holds, in slot order, those it stored as nothing left out.
  keywordsOf(name: string): string[] {
    return this.known(name).keywords.filter((k): k is string => k !== null);
  }

  // The interests of every SetKeywordInfo received for that account, as sent.
  keywordWrites(name: string): string[][] {
    return this.known(name).keywordWrites.map((w) => [...w]);
  }

  // The group with a null category is the top-level keywords.
  setKeywordList(groups: readonly KeywordGroup[]): void {
    this.keywordList = groups.map((g) => ({ category: g.category, keywords: [...g.keywords] }));
  }

  // The code the server refuses a service request for ODir with (0x0008 not supported by host, 0x0005 not available), or null.
  setOdirRefusal(code: number | null): void {
    this.odirRefusal = code;
  }

  // The sslHost start option, changed while the test server runs.
  setSslHost(on: boolean): void {
    this.sslHost = on;
  }

  bartBlob(hashHex: string): Uint8Array | undefined {
    return this.blobs.get(hashHex);
  }

  iconOf(name: string): BartId | null {
    const icon = this.accounts.get(normalizeScreenName(name))?.icon;
    return icon ? { ...icon } : null;
  }

  sendSnac(name: string, family: number, subtype: number, body: Uint8Array): void {
    for (const instance of this.known(name).instances) instance.conn.snac(family, subtype, SERVER_REQUEST_ID, body);
  }

  // The message is bytes because the server encodes it in its legacy charset; a field left out is not on the wire.
  sendPopup(name: string, popup: { message: Uint8Array; url?: string; width?: number; height?: number }): void {
    const { message, url, width, height } = popup;
    const tlvs = [tlv.bytes(POPUP_TLV_MESSAGE, message)];
    if (url !== undefined) tlvs.push(tlv.str(POPUP_TLV_URL, url));
    if (width !== undefined) tlvs.push(tlv.u16(POPUP_TLV_WIDTH, width));
    if (height !== undefined) tlvs.push(tlv.u16(POPUP_TLV_HEIGHT, height));
    this.sendSnac(name, FAMILY_POPUP, POPUP_DISPLAY, encodeTlvs(tlvs));
  }

  // The test server refuses the next upload with this code; the real server never refuses one (foodgroup/bart.go UpsertItem).
  refuseNextUpload(code: number): void {
    this.refusedUpload = code;
  }

  signOffBart(name: string): void {
    const account = this.known(name);
    const ident = normalizeScreenName(name);
    this.gate.turn++;
    for (const icons of [...this.bartConns.keys()]) {
      if (icons.name !== ident) continue;
      this.bartConns.delete(icons);
      this.signOffIcons(account, icons);
    }
  }

  signOffAdmin(name: string): void {
    const account = this.known(name);
    const ident = normalizeScreenName(name);
    this.gate.turn++;
    for (const admin of [...this.adminConns.keys()]) {
      if (admin.name !== ident) continue;
      this.adminConns.delete(admin);
      this.signOffIcons(account, admin);
    }
  }

  dropAdmin(name: string): void {
    const ident = normalizeScreenName(name);
    this.gate.turn++;
    for (const admin of [...this.adminConns.keys()]) if (admin.name === ident) admin.destroy();
  }

  displayOf(name: string): string {
    return this.known(name).display;
  }

  dropInstance(name: string, which: number): void {
    const instance = this.known(name).instances[which];
    if (!instance) throw new Error(`"${name}" has no instance ${which}`);
    instance.conn.socket.destroy();
  }

  snacsFrom(name: string): SnacRecord[] {
    return [...(this.log.get(normalizeScreenName(name)) ?? [])];
  }

  peer(name: string): FakePeer {
    const ident = normalizeScreenName(name);
    const existing = this.peers.get(ident);
    if (existing) return existing;
    if (!this.accounts.has(ident)) this.addUser(name, 'peer-password');
    const account = this.accounts.get(ident);
    if (!account) throw new Error('no account');
    const signOn = (): void =>
      this.change(account, () => {
        if (!account.peerOnline) {
          account.signonAt = this.seconds();
          this.takeStoredIcon(account);
        }
        account.peerOnline = true;
      });
    const writeIconItem = (flags: number, hash: Uint8Array): void => {
      const at = account.feedbag.findIndex((stored) => stored.classId === FEEDBAG_CLASS_BART && stored.name === BART_ICON_ITEM_NAME);
      const itemId = account.feedbag[at]?.itemId ?? Math.max(0, ...account.feedbag.map((stored) => stored.itemId)) + 1;
      const attrs = [tlv.bytes(FEEDBAG_ATTR_BART_INFO, encodeBartInfo(flags, hash))];
      const item: FeedbagItem = { name: BART_ICON_ITEM_NAME, groupId: 0, itemId, classId: FEEDBAG_CLASS_BART, attrs };
      if (at >= 0) account.feedbag[at] = item;
      else account.feedbag.push(item);
      if (account.peerOnline) this.setBartItem(account, item);
    };
    const peer = new FakePeer(name, {
      setAwayMessage: (text) => {
        this.setAwayMessage(account.peer, text);
        this.announce(account);
      },
      setProfile: (bytes, mime) => {
        account.peer.profile = { mime, bytes, at: ++this.changes };
      },
      setInvisible: (on) => {
        account.peer.status = on ? account.peer.status | USER_STATUS_INVISIBLE : account.peer.status & ~USER_STATUS_INVISIBLE;
        if (account.peerOnline) this.announceStatus(account);
      },
      setIdle: (minutes) => {
        account.peer.idle = minutes === null ? null : { minutes };
        this.announce(account);
      },
      setWarning: (level) => {
        account.warning = level;
        this.announce(account);
      },
      signOff: () => {
        this.change(account, () => {
          account.peerOnline = false;
        });
        this.sessionEnded(account);
      },
      signOn,
      send: (to, channel, tlvs, cookie) => this.routeIm(account, { cookie, channel, to, tlvs }),
      typing: (to, event, requestId) => this.relayTyping(account, { cookie: 0n, channel: ICBM_CHANNEL_IM, to, event }, requestId),
      clientError: (to, code, requestId) => {
        const body = new ByteWriter().u64(0n).u16(ICBM_CHANNEL_IM).str8(account.display).u16(code).toBytes();
        const recipient = this.accounts.get(normalizeScreenName(to));
        for (const instance of recipient?.instances.filter((i) => i.complete) ?? []) instance.conn.snac(4, 0x0b, requestId, body);
      },
      warn: (to, anonymous) => this.warn(account, to, anonymous),
      inbox: () => [...account.inbox],
      typingEvents: () => [...account.typing],
      watch: (watched) => {
        const itemId = Math.max(0, ...account.feedbag.map((item) => item.itemId)) + 1;
        account.feedbag.push({ name: normalizeScreenName(watched), groupId: 0, itemId, classId: FEEDBAG_CLASS_BUDDY, attrs: [] });
        const them = this.accounts.get(normalizeScreenName(watched));
        if (them && this.online(them) && !this.blocked(account, them)) this.arrived(account, them);
      },
      sightings: () => [...account.sightings],
      setIcon: (bytes) => {
        const hash = this.storeBlob(bytes);
        writeIconItem(BART_FLAG_CUSTOM, hash);
        return toHex(hash);
      },
      writeIconItem,
      setCapabilities: (caps) => {
        account.peerCaps = caps;
        this.announce(account);
      },
      sendThroughRelay: (body) => {
        if (account.peerOnline) this.routeIm(account, toHost(body), undefined, true);
      },
      hear: (deliveries, refusals) => {
        account.peerHears = deliveries;
        account.peerRefused = refusals;
      },
      relayAddress: () => (this.relay ? { ip: this.relayHost(), port: this.relay.port } : null),
      timers: this.opts.timers ?? { setTimeout, clearTimeout },
      now: () => this.now(),
    });
    this.peers.set(ident, peer);
    signOn();
    return peer;
  }

  kick(name: string): void {
    this.endSession(name, (conn) => conn.signoff(NEW_LOGIN_SIGNOFF));
  }

  emptySignoff(name: string): void {
    this.endSession(name, (conn) => conn.signoff([]));
  }

  dropSocket(name: string): void {
    this.endSession(name, (conn) => conn.destroy());
  }

  // Writes what `act` sends to the live instances of `name` in one write. A sign-off then reaches the client in the same read
  // as the frames before it. This uncorks a socket still open afterwards.
  inOneWrite(name: string, act: () => void): void {
    const sockets = new Set((this.accounts.get(normalizeScreenName(name))?.instances ?? []).map((instance) => instance.conn.socket));
    for (const socket of sockets) socket.cork();
    try {
      act();
    } finally {
      for (const socket of sockets) if (!socket.destroyed && socket.writableCorked > 0) socket.uncork();
    }
  }

  // Ends every ChatNav, Chat, BART and Admin connection of the account as a dropped socket; BOS stays.
  dropServices(name: string): void {
    const ident = normalizeScreenName(name);
    this.gate.turn++;
    for (const conn of [...this.roomConns.keys(), ...this.bartConns.keys(), ...this.adminConns.keys()]) {
      if (conn.kind !== 'bos' && conn.name === ident) conn.destroy();
    }
  }

  // Holds back the server's SNACs of this type until the returned function sends them.
  withhold(family: number, subtype: number): () => void {
    const key = snacKey(family, subtype);
    const queue: Held = [];
    this.gate.withheld.set(key, queue);
    return () => {
      if (this.gate.withheld.get(key) === queue) this.gate.withheld.delete(key);
      this.gate.turn++;
      for (const send of queue.splice(0)) send();
    };
  }

  // The next client SNAC of this type closes its connection that way and goes no further.
  closeOn(family: number, subtype: number, how: CloseHow): void {
    this.closing.set(snacKey(family, subtype), how);
  }

  // The server answers the next client SNAC of this type with an error SNAC (subtype 0x01), and the SNAC goes no further.
  failNext(family: number, subtype: number, error: { code: number; tlvs?: Tlv[] }): void {
    this.failing.set(snacKey(family, subtype), error);
  }

  // The server answers 0x13/0x0E and stores nothing for a buddy that needs authorisation (foodgroup/feedbag.go:263-268,300-308).
  failNextStatus(code: number): void {
    this.failingStatus = code;
  }

  // foodgroup/icbm.go:842-859, initWarningDecay: the watchers get an arrival with the new level, the account gets nothing.
  decayWarning(name: string, level: number): void {
    const account = this.known(name);
    account.warning = level;
    this.broadcastArrived(account);
  }

  // foodgroup/oservice.go:1052-1069, sendUserInfoUpdateToAll: every instance gets 0x01/0x0F with its own status.
  sendSelfInfo(name: string): void {
    this.selfInfoToAll(this.known(name));
  }

  private selfInfoToAll(account: Account): void {
    for (const instance of account.instances) instance.conn.snac(1, 0x0f, SERVER_REQUEST_ID, this.userInfo(account, instance.presence.status));
  }

  storedFor(name: string): { sender: string; cookie: bigint; channel: number; tlvs: Tlv[] }[] {
    const stored = this.accounts.get(normalizeScreenName(name))?.stored ?? [];
    return stored.map(({ sender, cookie, channel, tlvs }) => ({ sender, cookie, channel, tlvs }));
  }

  storeOffline(to: string, from: string, html: string, sentAtSeconds: number): void {
    const text = encodeImText(html);
    const tlvs = [tlv.bytes(ICBM_TLV_IM_DATA, encodeImFragments(text.charset, text.bytes))];
    this.store(this.known(to), { sender: normalizeScreenName(from), cookie: newCookie(), channel: ICBM_CHANNEL_IM, tlvs, sentAt: sentAtSeconds });
  }

  // Counts `count` sends in the class as if another session of the account had made them.
  spend(name: string, classId: number, count: number): void {
    const account = this.known(name);
    const state = this.rateOf(account, classId);
    for (let i = 0; i < count; i++) if (this.rateSend(account, state) === 'disconnect') return;
  }

  // One pass of the server's rate observer: it announces a subscribed class whose status has changed.
  // state/session.go:477-510, ObserveRateChanges: it stores the level only from limited to clear; the last-send time never moves.
  rateTick(name: string): void {
    this.observeRates(this.known(name));
  }

  // foodgroup/oservice.go:540-586, MonitorRateLimits: one monitor for each account, until the account signs off.
  private monitorRates(): void {
    const timers = this.opts.timers ?? { setTimeout, clearTimeout };
    this.monitor = timers.setTimeout(() => {
      for (const account of this.accounts.values()) if (account.instances.length > 0) this.observeRates(account);
      this.monitorRates();
    }, RATE_MONITOR_INTERVAL_MS);
    // The monitor does not keep the process alive.
    (this.monitor as { unref?: () => void }).unref?.();
  }

  private observeRates(account: Account): void {
    const now = this.now();
    for (const state of account.rates.values()) {
      if (!state.subscribed) continue;
      const check = checkRate(state.params, state.level, now - state.lastAt, state.limited);
      if (state.limited && check.status === 'clear') {
        state.limited = false;
        state.level = check.level;
      }
      if (check.status === state.status) continue;
      state.status = check.status;
      // foodgroup/oservice.go:567-568: a disconnect status is not announced; the next send tears down.
      if (check.status !== 'disconnect') this.rateNotice(account, state, RATE_CODE_OF[check.status]);
    }
  }

  // Changes a class's parameters, and its level when the patch has one, and announces the change.
  setRateParams(name: string, classId: number, patch: Partial<RateClassParams>): void {
    const account = this.known(name);
    const state = this.rateOf(account, classId);
    state.params = { ...state.params, ...patch, id: classId };
    state.original = { ...state.original, ...patch, id: classId };
    if (patch.currentLevel !== undefined) state.level = patch.currentLevel;
    this.rateNotice(account, state, RATE_CODE_CHANGED);
  }

  // How many SNACs from the account the rate limiter has dropped.
  dropped(name: string): number {
    return this.accounts.get(normalizeScreenName(name))?.dropped ?? 0;
  }

  // Every rate notice made for the account, oldest first.
  rateNotices(name: string): { code: number; classId: number; level: number }[] {
    return [...(this.accounts.get(normalizeScreenName(name))?.notices ?? [])];
  }

  private known(name: string): Account {
    const account = this.accounts.get(normalizeScreenName(name));
    if (!account) throw new Error(`no account named "${name}"`);
    return account;
  }

  private seconds(): number {
    return Math.floor(this.now() / 1000);
  }

  private record(ident: string, snac: Snac, conn: ConnKind): void {
    const entry = { family: snac.family, subtype: snac.subtype, requestId: snac.requestId, body: snac.body, conn };
    this.log.set(ident, [...(this.log.get(ident) ?? []), entry]);
  }

  private accept(socket: net.Socket, raw: net.Socket = socket): void {
    this.sockets.add(socket);
    socket.setNoDelay(true);
    const conn = new Conn(socket, this.gate, raw);
    if (raw !== socket) raw.on('error', () => {});
    let first = true;
    socket.on('error', () => {});
    socket.on('close', () => {
      this.sockets.delete(socket);
      this.bartConns.delete(conn);
      this.adminConns.delete(conn);
      this.odirConns.delete(conn);
      this.endInstance(conn);
      const held = this.roomConns.get(conn);
      this.roomConns.delete(conn);
      if (held && conn.kind !== 'bos') this.rooms.detached(held);
    });
    socket.on('data', (chunk: Buffer) => {
      if (conn.ignoreInput) return;
      try {
        for (const frame of decoding(() => conn.decoder.push(new Uint8Array(chunk)))) {
          if (conn.ignoreInput) return;
          this.gate.turn++;
          if (first) {
            first = false;
            this.onSignon(conn, decoding(() => decodeSignonPayload(frame.payload)).tlvs);
          } else if (frame.type === 2) {
            this.onSnac(conn, decoding(() => decodeSnac(frame.payload)));
          } else if (frame.type === 4) {
            this.endInstance(conn);
            socket.end();
          }
        }
      } catch (error) {
        if (!(error instanceof ModelledDrop)) this.faults.push(error);
        socket.destroy();
      }
    });
    conn.flap(1, encodeSignonPayload());
  }

  private online(account: Account): boolean {
    return account.peerOnline || account.instances.some((i) => i.complete && i.listInUse);
  }

  // state/relationship.go: the feedbag and the session list together, a session name as a buddy item.
  private listsOf(account: Account): FeedbagItem[] {
    const session = [...account.sessionBuddies].map((name): FeedbagItem => ({ name, groupId: 0, itemId: 0, classId: FEEDBAG_CLASS_BUDDY, attrs: [] }));
    return [...account.feedbag, ...session];
  }

  private buddiesOf(account: Account): Set<string> {
    return new Set(this.listsOf(account).filter((item) => item.classId === 0).map((item) => normalizeScreenName(item.name)));
  }

  // state/relationship.go:110-124: with no row, which is when neither lists the other as buddy, permit or deny, nobody blocks.
  private blocked(a: Account, b: Account): boolean {
    const [aName, bName] = [normalizeScreenName(a.display), normalizeScreenName(b.display)];
    const [aLists, bLists] = [this.listsOf(a), this.listsOf(b)];
    if (!related(aLists, aName, bLists, bName)) return false;
    return blocks(aLists, bName) || blocks(bLists, aName);
  }

  private watchersOf(account: Account): Account[] {
    const ident = normalizeScreenName(account.display);
    return [...this.accounts.values()].filter((watcher) => this.buddiesOf(watcher).has(ident) && !this.blocked(watcher, account));
  }

  private presences(account: Account): Presence[] {
    return [...account.instances.map((i) => i.presence), ...(account.peerOnline ? [account.peer] : [])];
  }

  private mobileClient(instance: Instance): boolean {
    return instance.caps.some((cap) => Buffer.from(cap).equals(Buffer.from(CAP_MOBILE_CLIENT)));
  }

  // The session is wireless only when every presence is an instance that advertises CapMobileClient; a peer never does.
  private wireless(account: Account): boolean {
    if (this.opts.wireless === 'never' || account.peerOnline) return false;
    return account.instances.length > 0 && account.instances.every((i) => this.mobileClient(i));
  }

  private awayOne(presence: Presence): boolean {
    return presence.awayFlag || (presence.status & STATUS_AWAY) !== 0;
  }

  // state/session.go:327-342, 381-394: the account is away, or idle, only when every instance is.
  private away(account: Account): boolean {
    const all = this.presences(account);
    return all.length > 0 && all.every((p) => this.awayOne(p));
  }

  private awayMessage(account: Account): Uint8Array {
    let latest: Presence | null = null;
    for (const presence of this.presences(account)) {
      if (this.awayOne(presence) && (latest === null || presence.awayAt > latest.awayAt)) latest = presence;
    }
    return latest?.awayMessage ?? new Uint8Array(0);
  }

  private idleSince(presence: Presence, now: number): number | null {
    return presence.idle === null ? null : 'since' in presence.idle ? presence.idle.since : now - presence.idle.minutes * 60_000;
  }

  private idleMinutes(account: Account): number | null {
    const now = this.now();
    const since = this.presences(account).map((p) => this.idleSince(p, now));
    if (since.length === 0 || since.some((at) => at === null)) return null;
    return Math.floor((now - Math.max(...since.map((at) => at ?? 0))) / 60_000) & 0xffff;
  }

  private status(account: Account): number {
    const all = this.presences(account);
    return all.reduce((bits, p) => bits & p.status, all[0]?.status ?? 0) >>> 0;
  }

  private invisible(account: Account): boolean {
    return (this.status(account) & USER_STATUS_INVISIBLE) !== 0;
  }

  private profile(account: Account): Profile | null {
    let latest: Profile | null = null;
    for (const { profile } of this.presences(account)) {
      if (profile === null || profile.bytes.length === 0 || (profile.bytes.length === 1 && profile.bytes[0] === 0)) continue;
      if (latest === null || profile.at > latest.at) latest = profile;
    }
    return latest;
  }

  private active(presence: Presence): boolean {
    return !this.awayOne(presence) && presence.idle === null;
  }

  private setAwayMessage(presence: Presence, text: Uint8Array): void {
    presence.awayFlag = text.length > 0;
    if (presence.awayFlag) presence.awayAt = ++this.changes;
    presence.awayMessage = text;
  }

  // `status` is the account's for others, and the instance's own in what the server tells it of itself (oservice.go sessionUserInfo).
  private userInfo(account: Account, status = this.status(account)): Uint8Array {
    const tlvs = this.userInfoTlvs(account, status);
    const caps = this.capsOf(account);
    if (caps.length > 0) tlvs.push(tlv.bytes(USER_INFO_CAPABILITIES, concatBytes(caps)));
    return encodeUserInfo({ name: account.display, warning: account.warning, tlvs });
  }

  private userInfoTlvs(account: Account, status: number): Tlv[] {
    const flags =
      USER_FLAG_OSCAR_FREE | (this.wireless(account) ? USER_FLAG_WIRELESS : 0) | (this.away(account) ? USER_FLAG_AWAY : 0) | this.botFlag(account);
    const tlvs = [tlv.u32(0x03, account.signonAt), tlv.u16(USER_INFO_FLAGS, flags), tlv.u32(USER_INFO_STATUS, status)];
    const idle = this.idleMinutes(account);
    if (idle !== null) tlvs.push(tlv.u16(0x04, idle));
    const icon = this.shownIcon(account);
    if (icon) tlvs.push(tlv.bytes(USER_INFO_BART, encodeBartId(icon)));
    return tlvs;
  }

  // Each capability that a live instance wrote, one time, in sign-on order.
  private capsOf(account: Account): Uint8Array[] {
    const seen = new Map<string, Uint8Array>();
    for (const instance of this.liveInstances(account)) for (const cap of instance.caps) seen.set(toHex(cap), cap);
    if (account.peerOnline) for (const cap of account.peerCaps) seen.set(toHex(cap), cap);
    return [...seen.values()];
  }

  // foodgroup/oservice.go UserInfoQuery: from version 4 the session's block leads one block per instance, in sign-on order.
  private userInfoReply(account: Account, instance: Instance): Uint8Array {
    if (instance.oserviceVersion < OSERVICE_MULTI_INSTANCE_VERSION) return this.userInfo(account, instance.presence.status);
    const named = (tlvs: Tlv[]): Uint8Array => encodeUserInfo({ name: account.display, warning: account.warning, tlvs });
    const primary = tlv.u8(USER_INFO_PRIMARY_INSTANCE, account.instances[0]?.num ?? instance.num);
    const now = this.now();
    const blocks = account.instances.map((each) => {
      const flags =
        USER_FLAG_OSCAR_FREE |
        (this.opts.wireless !== 'never' && this.mobileClient(each) ? USER_FLAG_WIRELESS : 0) |
        (this.awayOne(each.presence) ? USER_FLAG_AWAY : 0) |
        this.botFlag(account);
      const tlvs = [...this.addressTlvs(each), tlv.u8(USER_INFO_INSTANCE, each.num)];
      if (each.caps.length > 0) tlvs.push(tlv.bytes(USER_INFO_CAPABILITIES, concatBytes(each.caps)));
      tlvs.push(tlv.u16(USER_INFO_FLAGS, flags), tlv.u32(USER_INFO_STATUS, each.presence.status));
      const since = this.idleSince(each.presence, now);
      if (since !== null) tlvs.push(tlv.u16(0x04, Math.floor((now - since) / 60_000) & 0xffff));
      tlvs.push(tlv.u32(0x03, each.signonAt));
      return named(tlvs);
    });
    return concatBytes([named([...this.addressTlvs(instance), primary, ...this.userInfoTlvs(account, instance.presence.status)]), ...blocks]);
  }

  // foodgroup/auth.go RegisterBOSSession: a bot account's session carries the user flag 0x0400.
  private botFlag(account: Account): number {
    return account.bot ? USER_FLAG_BOT : 0;
  }

  private addressTlvs(instance: Instance): Tlv[] {
    const ip = this.ipOf(instance);
    return [tlv.u32(0x1e, 0), tlv.bytes(USER_INFO_EXTERNAL_IP, ipv4Bytes(ip)), tlv.str(USER_INFO_EXTERNAL_IP_TEXT, ip)];
  }

  private shownIcon(account: Account): BartId | null {
    return account.icon !== null && account.icon.type !== 0 ? account.icon : null;
  }

  private tell(to: Account, subtype: 0x0b | 0x0c, body: Uint8Array, sighting: Sighting, except?: Instance): void {
    for (const instance of to.instances) {
      if (instance.complete && instance.listInUse && instance !== except) instance.conn.snac(3, subtype, SERVER_REQUEST_ID, body);
    }
    if (to.peerOnline) to.sightings.push(sighting);
  }

  private arrived(to: Account, about: Account, except?: Instance): void {
    if (this.invisible(about)) return;
    const sighting: Sighting = {
      name: about.display,
      event: 'arrived',
      away: this.away(about),
      idleMinutes: this.idleMinutes(about),
      warning: about.warning,
      icon: toHex(this.shownIcon(about)?.hash ?? new Uint8Array(0)) || null,
    };
    this.tell(to, 0x0b, this.userInfo(about), sighting, except);
  }

  private departed(to: Account, info: UserInfo): void {
    this.tell(to, 0x0c, encodeUserInfo(info), { name: info.name, event: 'departed', away: false, idleMinutes: null, warning: info.warning, icon: null });
  }

  private broadcastArrived(account: Account, except?: Instance): void {
    for (const watcher of this.watchersOf(account)) this.arrived(watcher, account, except);
  }

  // foodgroup/buddy.go BroadcastBuddyDeparted: the normalised name, level 0 and one TLV, flags 0.
  private broadcastDeparted(account: Account): void {
    const info = { name: normalizeScreenName(account.display), warning: 0, tlvs: [tlv.u16(USER_INFO_FLAGS, 0)] };
    for (const watcher of this.watchersOf(account)) this.departed(watcher, info);
  }

  private announce(account: Account, except?: Instance): void {
    if (this.online(account)) this.broadcastArrived(account, except);
  }

  // foodgroup/oservice.go:313-323: after a status change an invisible account departs, any other arrives.
  private announceStatus(account: Account): void {
    if (this.invisible(account)) this.broadcastDeparted(account);
    else this.broadcastArrived(account);
  }

  private change(account: Account, mutate: () => void, except?: Instance): void {
    const before = this.online(account);
    mutate();
    const after = this.online(account);
    if (!before && after) this.announce(account, except);
    if (before && !after) this.broadcastDeparted(account);
  }

  private advance(account: Account, instance: Instance, mutate: () => void): void {
    const ready = (): boolean => instance.complete && instance.listInUse;
    const before = ready();
    const wasOnline = this.online(account);
    this.change(account, mutate, instance);
    if (before || !ready()) return;
    // oservice.go:780-786: a second instance tells watchers the merged user info, so a non-idle new session ends the account's idle.
    if (wasOnline) this.broadcastArrived(account, instance);
    for (const ident of this.buddiesOf(account)) {
      const buddy = this.accounts.get(ident);
      if (!buddy || !this.online(buddy) || this.blocked(account, buddy) || this.invisible(buddy)) continue;
      instance.conn.snac(3, 0x0b, SERVER_REQUEST_ID, this.userInfo(buddy));
    }
  }

  // buddy.go BroadcastVisibility with departures: after a list write, the server tells both sides of each relationship again.
  private refreshVisibility(account: Account, names: Set<string> | 'all'): void {
    const me = normalizeScreenName(account.display);
    const mine = this.listsOf(account);
    for (const [ident, them] of this.accounts) {
      if (names !== 'all' && !names.has(ident)) continue;
      const theirs = this.listsOf(them);
      if (!related(mine, me, theirs, ident)) continue;
      if (blocks(theirs, me) || !this.online(them)) continue;
      const onTheirList = this.buddiesOf(them).has(me);
      const onMyList = this.buddiesOf(account).has(ident);
      if (!blocks(mine, ident)) {
        if (onTheirList) this.arrived(them, account);
        if (onMyList) this.arrived(account, them);
      } else {
        if (onTheirList) this.departed(them, { name: me, warning: account.warning, tlvs: [] });
        if (onMyList) this.departed(account, { name: ident, warning: them.warning, tlvs: [] });
      }
    }
  }

  private writeFeedbag(account: Account, instance: Instance, snac: Snac): void {
    const r = new ByteReader(snac.body);
    const items: FeedbagItem[] = [];
    while (r.remaining > 0) items.push(decoding(() => readFeedbagItem(r)));
    const me = normalizeScreenName(account.display);
    const deleting = snac.subtype === FEEDBAG_DELETE;
    if (!deleting && items.some((item) => item.classId === FEEDBAG_CLASS_DENY && normalizeScreenName(item.name) === me)) {
      instance.conn.snac(0x13, FEEDBAG_ERR, snac.requestId, new ByteWriter().u16(ERR_NOT_SUPPORTED_BY_HOST).toBytes());
      return;
    }
    const failed = this.failingStatus;
    this.failingStatus = null;
    const written = failed === null ? items : items.slice(1);
    for (const item of written) {
      // The key is (group id, item id) alone: a colliding id overwrites, class included (state/user_store.go:1000-1023).
      const at = account.feedbag.findIndex((stored) => stored.groupId === item.groupId && stored.itemId === item.itemId);
      if (deleting) {
        if (at >= 0) account.feedbag.splice(at, 1);
        continue;
      }
      const stored = NAMING_CLASSES.includes(item.classId) ? { ...item, name: normalizeScreenName(item.name) } : item;
      if (at >= 0) account.feedbag[at] = stored;
      else account.feedbag.push(stored);
    }
    instance.conn.snac(0x13, FEEDBAG_STATUS, snac.requestId, u16s(items.map((_, i) => (i === 0 && failed !== null ? failed : 0x0000))));
    for (const other of account.instances) {
      if (other === instance) continue;
      // A client-defined item reaches only the instances past client online.
      const relayed = other.complete ? written : written.filter((item) => item.classId < CLIENT_DEFINED_CLASS_MIN);
      if (relayed.length > 0 || written.length === 0) other.conn.snac(0x13, snac.subtype, SERVER_REQUEST_ID, encodeFeedbagItems(relayed));
    }
    // UpsertItem:337-340: an icon item goes to setBARTItem, whose error ends the connection after the status and the push are out.
    for (const item of deleting ? [] : written) {
      if (item.classId === FEEDBAG_CLASS_BART && !this.setBartItem(account, item, instance)) {
        instance.conn.destroy();
        return;
      }
    }
    // UpsertItem:331-344,393-404: named items filter the broadcast, a privacy item alone asks for everyone; DeleteItem:512-530 always does.
    const named = written.filter((item) => NAMING_CLASSES.includes(item.classId)).map((item) => normalizeScreenName(item.name));
    if (!deleting && named.length === 0 && !written.some((item) => item.classId === FEEDBAG_CLASS_PDINFO)) return;
    if (instance.txn) {
      instance.txn.shouldSend = true;
      for (const name of named) instance.txn.names.add(name);
    } else {
      this.refreshVisibility(account, named.length > 0 ? new Set(named) : 'all');
    }
  }

  // foodgroup/feedbag.go setBARTItem. False is its Go error: no attribute 0x00D5, one too short, or a name that is not a number.
  private setBartItem(account: Account, item: FeedbagItem, writer?: Instance): boolean {
    const info = decodeBartInfo(findTlv(item.attrs, FEEDBAG_ATTR_BART_INFO) ?? new Uint8Array(0));
    const type = bartTypeOf(item.name);
    if (info === null || type === null) return false;
    const id: BartId = { type, flags: info.flags, hash: info.hash };
    const isIcon = type === BART_TYPE_BUDDY_ICON_SMALL || type === BART_TYPE_BUDDY_ICON;
    const exists = isClearHash(id.hash) || (this.blobs.get(toHex(id.hash))?.length ?? 0) > 0;
    if (exists) {
      if (isIcon) {
        account.icon = id;
        this.broadcastArrived(account);
      }
    } else {
      id.flags |= BART_FLAG_UNKNOWN;
      if (isIcon) account.icon = id;
    }
    writer?.conn.snac(1, OSERVICE_BART_REPLY, 0, encodeBartId(id));
    if (isIcon) this.selfInfoToAll(account);
    return true;
  }

  // foodgroup/bart.go UpsertItem: the bartItem table is keyed by the MD5, and a hash already there keeps its blob.
  private storeBlob(data: Uint8Array): Uint8Array {
    const hash = new Uint8Array(createHash('md5').update(data).digest());
    const key = toHex(hash);
    if (!this.blobs.has(key)) this.blobs.set(key, Uint8Array.from(data));
    return hash;
  }

  // bart.go UpsertItem (0x10/0x02): an upload of the session icon's hash clears the unknown flag and tells everyone; else the server stores it.
  private bartUpload(account: Account, conn: Conn, snac: Snac): void {
    const { type, data } = decoding(() => {
      const r = new ByteReader(snac.body);
      return { type: r.u16(), data: r.bytes(r.u16()) };
    });
    const reply = (code: number, id: BartId): void => conn.snac(0x10, 0x03, snac.requestId, new ByteWriter().u8(code).bytes(encodeBartId(id)).toBytes());
    const refused = this.refusedUpload;
    if (refused !== null) {
      this.refusedUpload = null;
      reply(refused, { type, flags: BART_FLAG_CUSTOM, hash: new Uint8Array(createHash('md5').update(data).digest()) });
      return;
    }
    const hash = this.storeBlob(data);
    const icon = this.shownIcon(account);
    if (icon === null || toHex(icon.hash) !== toHex(hash)) {
      reply(0, { type, flags: BART_FLAG_CUSTOM, hash });
      return;
    }
    icon.flags &= ~BART_FLAG_UNKNOWN;
    this.selfInfoToAll(account);
    this.broadcastArrived(account);
    reply(0, icon);
  }

  // bart.go RetrieveItem (0x10/0x04): the blank GIF for the cleared hash, an empty data field for a hash nothing is held under.
  private bartDownload(conn: Conn, snac: Snac): void {
    const query = decoding(() => {
      const r = new ByteReader(snac.body);
      const screenName = r.str8();
      r.u8();
      return { screenName, id: readBartId(r) };
    });
    const data = isClearHash(query.id.hash) ? BLANK_GIF : (this.blobs.get(toHex(query.id.hash)) ?? new Uint8Array(0));
    conn.snac(0x10, 0x05, snac.requestId, new ByteWriter().str8(query.screenName).bytes(encodeBartId(query.id)).u16(data.length).bytes(data).toBytes());
  }

  // auth.go RegisterBOSSession:170-178: with no icon, a session takes feedbag item "1" of class 0x14, as type 1; unreadable is no icon here.
  private takeStoredIcon(account: Account): void {
    if (this.shownIcon(account)) return;
    const item = account.feedbag.find((stored) => stored.classId === FEEDBAG_CLASS_BART && stored.name === BART_ICON_ITEM_NAME);
    const info = item ? decodeBartInfo(findTlv(item.attrs, FEEDBAG_ATTR_BART_INFO) ?? new Uint8Array(0)) : null;
    if (info) account.icon = { type: BART_TYPE_BUDDY_ICON, flags: info.flags, hash: info.hash };
  }

  private sessionEnded(account: Account): void {
    if (account.instances.length === 0 && !account.peerOnline) account.icon = null;
  }

  // server.go:643-659: an icon or Admin connection runs on the BOS instance its cookie named, so that instance ending signs it off.
  private endIcons(account: Account, bos: Conn): void {
    for (const conns of [this.bartConns, this.adminConns, this.odirConns]) {
      for (const [service, owner] of [...conns]) {
        if (owner !== bos) continue;
        conns.delete(service);
        this.signOffIcons(account, service);
      }
    }
  }

  private signOffIcons(account: Account, icons: Conn): void {
    if (account.sessionFlag === 0) icons.oldSignoff();
    else icons.signoff(NEW_LOGIN_SIGNOFF);
  }

  private cluster(account: Account, instance: Instance, snac: Snac): void {
    const ending = snac.subtype === FEEDBAG_END_CLUSTER;
    for (const other of account.instances) {
      if (other !== instance) other.conn.snac(0x13, snac.subtype, snac.requestId, ending ? undefined : snac.body);
    }
    if (!ending) {
      instance.txn = { shouldSend: false, names: new Set() };
      return;
    }
    const txn = instance.txn;
    instance.txn = null;
    if (txn?.shouldSend) this.refreshVisibility(account, txn.names.size > 0 ? txn.names : 'all');
  }

  private rateOf(account: Account, classId: number): RateState {
    const state = account.rates.get(classId);
    if (!state) throw new Error(`no rate class ${classId}`);
    return state;
  }

  // One send through the server's moving average: state/session.go:455-474 (EvaluateRateLimit).
  private rateSend(account: Account, state: RateState): RateCheck['status'] {
    const now = this.now();
    const check = checkRate(state.params, state.level, now - state.lastAt, state.limited);
    state.level = check.level;
    state.limited = check.status === 'limited';
    state.lastAt = now;
    if (check.status === 'disconnect') {
      this.kick(account.display);
      return check.status;
    }
    if (check.status !== state.status) {
      state.status = check.status;
      this.rateNotice(account, state, RATE_CODE_OF[check.status]);
    }
    return check.status;
  }

  // foodgroup/oservice.go V2Params: above OService 1 a record also carries the last time and the dropping flag.
  private rateRecord(p: RateClassParams, level: number, v2: boolean): Uint8Array {
    const w = new ByteWriter()
      .u16(p.id)
      .u32(p.windowSize)
      .u32(p.clearLevel)
      .u32(p.alertLevel)
      .u32(p.limitLevel)
      .u32(p.disconnectLevel)
      .u32(level)
      .u32(p.maxLevel);
    if (v2) w.u32(this.seconds() - 1).u8(0);
    return w.toBytes();
  }

  private rateNotice(account: Account, state: RateState, code: number): void {
    account.notices.push({ code, classId: state.params.id, level: state.level });
    // The v0.24 release writes the notice to the account's ChatNav connection while it has one.
    const nav = this.generation === 'v0.24' ? this.rooms.navConn(normalizeScreenName(account.display)) : undefined;
    for (const instance of account.instances) {
      if (!instance.subscribed.has(state.params.id)) continue;
      const record = this.rateRecord(state.params, state.level, instance.oserviceVersion > 1);
      const body = new ByteWriter().u16(code).bytes(record).toBytes();
      if (nav) nav.send(1, 0x0a, body);
      else instance.conn.snac(1, 0x0a, SERVER_REQUEST_ID, body);
    }
  }

  // server/oscar/server.go:607-617: the limiter runs before the route. False means the SNAC goes no further.
  private admit(conn: Conn, snac: Snac): boolean {
    const account = this.accounts.get(conn.name);
    const classId = RATE_CLASS_OF.get(snacKey(snac.family, snac.subtype));
    if (!account || classId === undefined) return true;
    const status = this.rateSend(account, this.rateOf(account, classId));
    if (status === 'limited') account.dropped++;
    return status !== 'limited' && status !== 'disconnect';
  }

  private routeIm(
    sender: Account,
    im: { cookie: bigint; channel: number; to: string; tlvs: Tlv[] },
    reply?: { conn: Conn; requestId: number },
    scripted = false,
  ): void {
    const refuse = (tlvs: Tlv[] = [], code = ICBM_ERR_NOT_LOGGED_ON): void => {
      reply?.conn.snac(4, 0x01, reply.requestId, new ByteWriter().u16(code).bytes(encodeTlvs(tlvs)).toBytes());
    };
    const acknowledge = (): void => {
      if (!hasTlv(im.tlvs, ICBM_TLV_REQUEST_HOST_ACK)) return;
      reply?.conn.snac(4, 0x0c, reply.requestId, new ByteWriter().u64(im.cookie).u16(im.channel).str8(im.to).toBytes());
    };
    const recipient = this.accounts.get(normalizeScreenName(im.to));
    // foodgroup/icbm.go:109-119: the recipient blocks the sender, then the sender the recipient, before any delivery or storing.
    if (recipient && this.blocked(sender, recipient)) {
      const blocksYou = blocks(this.listsOf(recipient), normalizeScreenName(sender.display));
      refuse([], blocksYou ? ICBM_ERR_NOT_LOGGED_ON : ICBM_ERR_IN_LOCAL_PERMIT_DENY);
      return;
    }
    if (!recipient || !this.live(recipient)) {
      if (!recipient || !hasTlv(im.tlvs, ICBM_TLV_STORE)) {
        refuse();
        return;
      }
      const from = normalizeScreenName(sender.display);
      if (recipient.stored.filter((message) => message.sender === from).length >= OFFLINE_MAX_PER_SENDER) {
        refuse([tlv.u16(ICBM_ERROR_TLV_SUBCODE, ICBM_SUBERROR_OFFLINE_FULL)]);
        return;
      }
      this.store(recipient, { sender: from, cookie: im.cookie, channel: im.channel, tlvs: im.tlvs, sentAt: this.seconds() });
      acknowledge();
      return;
    }
    // foodgroup/icbm.go:188-192,416-420: a rendezvous fragment too short to parse ends the sender's connection; the server relays nothing.
    if (im.channel === ICBM_CHANNEL_RENDEZVOUS && im.tlvs.some((t) => t.tag === ICBM_TLV_RENDEZVOUS && t.value.length < RDV_FRAGMENT_MIN_BYTES)) {
      reply?.conn.destroy();
      return;
    }
    const routed = this.throughRelay(sender, recipient, im, reply?.conn, scripted);
    // foodgroup/icbm.go:199-204: the server keeps the recipient's Accept, relays nothing and acknowledges nothing.
    if (!routed) return;
    const tlvs = routed.filter((t) => !this.notRelayed().includes(t.tag));
    const body = new ByteWriter().u64(im.cookie).u16(im.channel).bytes(this.userInfo(sender)).bytes(encodeTlvs(tlvs)).toBytes();
    const anyActive = this.activeInstances(recipient).length > 0 || this.peerActive(recipient);
    for (const instance of anyActive ? this.activeInstances(recipient) : this.liveInstances(recipient)) {
      instance.conn.snac(4, 0x07, SERVER_REQUEST_ID, body);
    }
    if (recipient.peerOnline && (!anyActive || this.peerActive(recipient))) this.toPeer(recipient, { from: sender.display, channel: im.channel, tlvs });
    // foodgroup/icbm.go:242: a live IM is what later allows the recipient a warning. A stored one never gets here.
    const convo = this.convo(sender, recipient);
    convo.ims = [...convo.ims, this.now()].slice(-WARN_MEMORY);
    acknowledge();
  }

  // foodgroup/icbm.go rendezvousTLV: with the relay on, each rendezvous fragment of a signed-on sender passes the broker first.
  // A scripted peer counts as one instance at the address of the relay. Its presence record names it.
  private throughRelay(sender: Account, recipient: Account, im: { channel: number; tlvs: Tlv[] }, conn: Conn | undefined, scripted: boolean): Tlv[] | null {
    const instance = conn && sender.instances.find((i) => i.conn === conn);
    const source = instance ?? (scripted ? sender.peer : undefined);
    if (!this.relay || !source || im.channel !== ICBM_CHANNEL_RENDEZVOUS) return im.tlvs;
    const from = { instance: source, name: normalizeScreenName(sender.display), ip: instance ? this.ipOf(instance) : this.relayHost() };
    const ips = this.liveInstances(recipient).map((i) => this.ipOf(i));
    if (recipient.peerOnline) ips.push(this.relayHost());
    const to = { name: normalizeScreenName(recipient.display), ips };
    const out: Tlv[] = [];
    for (const t of im.tlvs) {
      const value = t.tag === ICBM_TLV_RENDEZVOUS ? this.relay.route(from, to, t.value) : t.value;
      if (value === 'held') return null;
      out.push({ tag: t.tag, value });
    }
    return out;
  }

  private relayHost(): string {
    return this.host === '0.0.0.0' ? '127.0.0.1' : this.host;
  }

  private toPeer(account: Account, delivery: Delivery): void {
    account.inbox.push(delivery);
    account.peerHears?.(delivery);
  }

  private ipOf(instance: Instance): string {
    return (instance.conn.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
  }

  // state/session.go:157-169: an account with no instance that finished signing on is offline to IMs, info queries and warnings.
  private live(account: Account): boolean {
    return account.peerOnline || this.liveInstances(account).length > 0;
  }

  private liveInstances(account: Account): Instance[] {
    return account.instances.filter((i) => i.complete);
  }

  private activeInstances(account: Account): Instance[] {
    return this.liveInstances(account).filter((i) => this.active(i.presence));
  }

  private peerActive(account: Account): boolean {
    return account.peerOnline && this.active(account.peer);
  }

  private store(recipient: Account, message: StoredMessage): void {
    recipient.stored.push(message);
    recipient.offlineCount++;
  }

  // The v0.24 release relays the store and send-time TLVs to the recipient.
  private notRelayed(): number[] {
    return this.generation === 'v0.24' ? [ICBM_TLV_REQUEST_HOST_ACK] : NOT_RELAYED;
  }

  private retrieveOffline(account: Account, conn: Conn, requestId: number): void {
    // The v0.24 release delivers stored messages only to an instance that sent client online. It deletes them in each case.
    const delivers = this.generation === 'main' || account.instances.some((i) => i.conn === conn && i.complete);
    for (const message of account.stored.splice(0)) {
      if (!delivers) continue;
      const tlvs = [...message.tlvs.filter((t) => t.tag !== ICBM_TLV_SEND_TIME), tlv.u32(ICBM_TLV_SEND_TIME, message.sentAt)];
      const sender = encodeUserInfo({ name: message.sender, warning: 0, tlvs: [] });
      const body = new ByteWriter().u64(message.cookie).u16(message.channel).bytes(sender).bytes(encodeTlvs(tlvs)).toBytes();
      conn.snac(4, 0x07, SERVER_REQUEST_ID, body);
    }
    conn.snac(4, 0x17, requestId);
  }

  // icbm.go ClientEvent: dropped when either blocks the other, else relayed with the sender's request id to the active instances.
  private relayTyping(sender: Account, typing: { cookie: bigint; channel: number; to: string; event: number }, requestId: number): void {
    const recipient = this.accounts.get(normalizeScreenName(typing.to));
    if (!recipient || this.blocked(sender, recipient)) return;
    const body = new ByteWriter().u64(typing.cookie).u16(typing.channel).str8(sender.display).u16(typing.event).toBytes();
    for (const instance of this.activeInstances(recipient)) instance.conn.snac(4, 0x14, requestId, body);
    if (this.peerActive(recipient)) recipient.typing.push({ from: sender.display, event: typing.event });
  }

  private convo(sender: Account, recipient: Account): Convo {
    const key = `${normalizeScreenName(sender.display)}\n${normalizeScreenName(recipient.display)}`;
    let convo = this.convos.get(key);
    if (!convo) {
      convo = { ims: [], warnings: [] };
      this.convos.set(key, convo);
    }
    return convo;
  }

  private warn(warner: Account, to: string, anonymous: boolean, reply?: { conn: Conn; requestId: number }): void {
    const delta = anonymous ? WARN_DELTA_ANONYMOUS : WARN_DELTA;
    const target = this.accounts.get(normalizeScreenName(to));
    const refusal = this.warnRefusal(warner, target, delta);
    if (!target || refusal !== null) {
      reply?.conn.snac(4, 0x01, reply.requestId, new ByteWriter().u16(refusal ?? ICBM_ERR_NOT_LOGGED_ON).toBytes());
      return;
    }
    target.warning += delta;
    // foodgroup/icbm.go:624-646: the frame has no request id. A normal warning names the warner.
    const notice = new ByteWriter().u16(target.warning);
    if (!anonymous) notice.bytes(encodeUserInfo({ name: warner.display, warning: warner.warning, tlvs: [] }));
    for (const instance of this.liveInstances(target)) instance.conn.snac(1, 0x10, 0, notice.toBytes());
    this.scaleImRate(target, delta);
    this.broadcastArrived(target);
    reply?.conn.snac(4, 0x09, reply.requestId, new ByteWriter().u16(delta).u16(target.warning).toBytes());
  }

  private warnRefusal(warner: Account, target: Account | undefined, delta: number): number | null {
    if (target === warner) return ERR_NOT_SUPPORTED_BY_HOST;
    if (!target || this.blocked(warner, target) || !this.live(target)) return ICBM_ERR_NOT_LOGGED_ON;
    // foodgroup/icbm.go EvilRequest: the server refuses a warning to a bot.
    if (target.bot) return ERR_REQUEST_DENIED;
    // trackWarn (foodgroup/icbm.go:973-1013): more IMs from the target in the last hour than warnings back.
    const convo = this.convo(target, warner);
    const windowStart = this.now() - WARN_WINDOW_MS;
    const within = (times: number[]): number => times.filter((at) => at > windowStart).length;
    if (within(convo.ims) <= within(convo.warnings)) return ERR_REQUEST_DENIED;
    convo.warnings = [...convo.warnings, this.now()].slice(-WARN_MEMORY);
    return target.warning + delta > WARN_MAX ? ERR_REQUEST_DENIED : null;
  }

  // state/session.go:553-598: limit, clear and alert each move by the warning's share of the way from the original to the maximum less 150.
  private scaleImRate(account: Account, delta: number): void {
    const state = this.rateOf(account, IM_RATE_CLASS);
    const { original } = state;
    const share = Math.fround(delta / 1000);
    const ceiling = original.maxLevel - WARN_RATE_HEADROOM;
    const scaled = (now: number, from: number): number => {
      const next = now + Math.trunc(Math.fround(Math.fround(ceiling - from) * share));
      return Math.min(original.maxLevel, Math.max(from, next));
    };
    state.params = {
      ...state.params,
      limitLevel: scaled(state.params.limitLevel, original.limitLevel),
      clearLevel: scaled(state.params.clearLevel, original.clearLevel),
      alertLevel: scaled(state.params.alertLevel, original.alertLevel),
    };
    this.rateNotice(account, state, RATE_CODE_CHANGED);
  }

  // foodgroup/oservice.go:887-913 (systemMessage): channel 1, no cookie, a sender with no TLVs, plain ASCII.
  private notice(text: string): Uint8Array {
    const sender = encodeUserInfo({ name: this.opts.noticeSender ?? NOTICE_SENDER, warning: 0, tlvs: [] });
    const data = tlv.bytes(ICBM_TLV_IM_DATA, encodeImFragments(0, new Uint8Array(Buffer.from(text, 'latin1'))));
    return new ByteWriter().u64(0n).u16(ICBM_CHANNEL_IM).bytes(sender).bytes(encodeTlvs([data])).toBytes();
  }

  // oservice.go:818-828, at every client online: the stored-message count to the account, the instance count to the earlier instances.
  private sendNotices(account: Account, instance: Instance): void {
    if (this.opts.notices === false) return;
    if (account.offlineCount > 0) {
      const body = this.notice(offlineNotice(account.offlineCount));
      account.offlineCount = 0;
      for (const each of this.liveInstances(account)) each.conn.snac(4, 0x07, SERVER_REQUEST_ID, body);
    }
    const count = this.presences(account).length;
    if (count <= 1) return;
    const body = this.notice(locationsNotice(account.display, count));
    for (const other of this.liveInstances(account)) if (other !== instance) other.conn.snac(4, 0x07, SERVER_REQUEST_ID, body);
  }

  // foodgroup/locate.go SetInfo: profile, away message, capabilities, in that order, and no reply.
  private setInfo(account: Account, instance: Instance, snac: Snac): void {
    const tlvs = decoding(() => decodeTlvs(snac.body));
    const profile = findTlv(tlvs, 0x02);
    if (profile) instance.presence.profile = { mime: tlvStr(tlvs, 0x01) ?? '', bytes: profile, at: ++this.changes };
    const away = findTlv(tlvs, LOCATE_TLV_AWAY_TEXT);
    if (away) {
      this.setAwayMessage(instance.presence, away);
      if (instance.complete) this.broadcastArrived(account);
    }
    const caps = findTlv(tlvs, LOCATE_TLV_CAPABILITIES);
    if (!caps) return;
    if (caps.length % 16 !== 0) {
      instance.conn.destroy();
      return;
    }
    instance.caps = [];
    for (let at = 0; at < caps.length; at += 16) instance.caps.push(caps.slice(at, at + 16));
  }

  // foodgroup/locate.go UserInfoQuery, for 0x02/0x05 and 0x02/0x15 alike. Invisibility is not looked at.
  private infoQuery(account: Account, instance: Instance, requestId: number, types: number, name: string): void {
    const target = this.accounts.get(normalizeScreenName(name));
    const self = target === account;
    if (!target || (!self && (this.blocked(account, target) || !this.live(target)))) {
      instance.conn.snac(2, 0x01, requestId, new ByteWriter().u16(ICBM_ERR_NOT_LOGGED_ON).toBytes());
      return;
    }
    const tlvs: Tlv[] = [];
    if (types & LOCATE_QUERY_PROFILE) {
      const profile = self ? instance.presence.profile : this.profile(target);
      tlvs.push(tlv.str(0x01, profile?.mime ?? ''), tlv.bytes(0x02, profile?.bytes ?? new Uint8Array(0)));
    }
    if (types & LOCATE_QUERY_AWAY && this.away(target)) {
      tlvs.push(tlv.str(0x03, LOCATE_MIME), tlv.bytes(LOCATE_TLV_AWAY_TEXT, this.awayMessage(target)));
    }
    instance.conn.snac(2, 0x06, requestId, new ByteWriter().bytes(this.userInfo(target)).bytes(encodeTlvs(tlvs)).toBytes());
  }

  private setStatus(account: Account, instance: Instance, snac: Snac): void {
    const status = tlvU32(decoding(() => decodeTlvs(snac.body)), USER_INFO_STATUS);
    const { presence } = instance;
    if (status !== undefined) {
      // oservice.go:279-286: an unavailable status marks the instance away; leaving one erases the away message.
      if (status & STATUS_UNAVAILABLE) {
        presence.awayFlag = true;
        presence.awayAt = ++this.changes;
      } else if (presence.status & STATUS_UNAVAILABLE) {
        presence.awayFlag = false;
        presence.awayMessage = new Uint8Array(0);
      }
      presence.status = status;
      // From open-oscar-server 43fb987 the watchers hear of it only after client online (foodgroup/oservice.go:313-323); 'broadcast' is the rule before.
      if (this.opts.preOnlineStatus !== 'silent' || instance.complete) this.announceStatus(account);
    }
    instance.conn.snac(1, 0x0f, SERVER_REQUEST_ID, this.userInfo(account, presence.status));
  }

  private roomConn(conn: Conn, display = this.accounts.get(conn.name)?.display ?? conn.name): RoomConn {
    let held = this.roomConns.get(conn);
    if (!held) {
      held = new RoomConn(conn, display);
      this.roomConns.set(conn, held);
    }
    return held;
  }

  // server.go connectToOSCARService: the last instance going closes the session and its room connections; another leaves them be.
  private instancesEnded(account: Account, ended: number): void {
    if (ended > 0 && account.instances.length === 0) {
      this.rooms.bosGone(normalizeScreenName(account.display));
      // server/oscar/server.go: the session's end unregisters its buddy list.
      account.sessionBuddies.clear();
    }
    this.sessionEnded(account);
  }

  private endInstance(conn: Conn): void {
    const account = this.accounts.get(conn.name);
    const index = account?.instances.findIndex((i) => i.conn === conn) ?? -1;
    if (!account || index < 0) return;
    this.change(account, () => account.instances.splice(index, 1));
    this.endIcons(account, conn);
    this.instancesEnded(account, 1);
  }

  private endSession(name: string, close: (conn: Conn) => void): void {
    const account = this.accounts.get(normalizeScreenName(name));
    if (!account) return;
    let ended: Instance[] = [];
    this.change(account, () => {
      ended = account.instances.splice(0);
    });
    this.gate.turn++;
    for (const instance of ended) {
      close(instance.conn);
      this.endIcons(account, instance.conn);
    }
    this.instancesEnded(account, ended.length);
  }

  private onSignon(conn: Conn, tlvs: Tlv[]): void {
    const cookieBytes = findTlv(tlvs, 0x06);
    if (cookieBytes) {
      this.onService(conn, cookieBytes);
      return;
    }
    this.authSignons.push(tlvs);
    const now = this.now();
    if (this.limiter.windowStart === null || now - this.limiter.windowStart > LIMITER_WINDOW_MS) this.limiter = { count: 0, windowStart: now };
    this.limiter.count++;
    if (this.limiter.count > (this.opts.loginLimit ?? 10)) {
      const refusal = [tlv.u16(0x08, LOGIN_ERR_RATE_LIMITED)];
      if (this.opts.limiterShape === 'signoff') {
        conn.signoff(refusal);
      } else {
        conn.snac(0x17, 0x03, 0, encodeTlvs(refusal));
        conn.signoff([]);
      }
      return;
    }
    if (hasTlv(tlvs, 0x01)) conn.destroy();
  }

  // server.go connectToOSCARService: a cookie that does not crack, or is past its 60 s, ends the connection with nothing written.
  private onService(conn: Conn, cookieBytes: Uint8Array): void {
    const ticket = this.rooms.claim(cookieBytes);
    if (ticket?.kind === 'bart') {
      this.onIconService(conn, ticket);
      return;
    }
    if (ticket?.kind === 'admin') {
      this.onAdminService(conn, ticket);
      return;
    }
    if (ticket?.kind === 'odir') {
      this.onDirectoryService(conn, ticket);
      return;
    }
    if (ticket) {
      conn.name = ticket.name;
      conn.kind = ticket.kind;
      this.rooms.attach(this.roomConn(conn, ticket.display), ticket);
      return;
    }
    const cookie = this.cookies.get(Buffer.from(cookieBytes).toString('hex'));
    const ident = normalizeScreenName(cookie?.name ?? '');
    const account = this.accounts.get(ident);
    if (!cookie || !account || cookie.expires < this.now()) {
      conn.destroy();
      return;
    }
    conn.name = ident;
    conn.kind = 'bos';
    const joins = cookie.flag === MULTI_SESSION && account.sessionFlag === MULTI_SESSION && account.instances.length > 0;
    if (joins && account.instances.length >= MAX_INSTANCES) {
      conn.signoff(SESSION_CAP_SIGNOFF);
      return;
    }
    if (!joins) {
      const old = account.sessionFlag === 0;
      let evicted: Instance[] = [];
      this.change(account, () => {
        evicted = account.instances.splice(0);
      });
      for (const instance of evicted) {
        if (old) instance.conn.oldSignoff();
        else instance.conn.signoff(NEW_LOGIN_SIGNOFF);
        this.endIcons(account, instance.conn);
      }
      this.instancesEnded(account, evicted.length);
      account.sessionFlag = cookie.flag;
      account.signonAt = this.seconds();
      account.rates = freshRates(this.now(), account.rates);
      account.lastInstanceNum = 0;
    }
    this.takeStoredIcon(account);
    account.instances.push({
      conn, complete: false, listInUse: false, subscribed: new Set(), caps: [], txn: null, presence: freshPresence(), oserviceVersion: 1,
      num: ++account.lastInstanceNum, signonAt: this.seconds(),
    });
    conn.snac(1, 0x03, SERVER_REQUEST_ID, u16s(this.opts.hostOnline ?? BOS_FAMILIES));
  }

  // server.go connectToOSCARService: a BART or Admin connection runs on its cookie's BOS instance; if that is gone, the server writes nothing.
  private onIconService(conn: Conn, ticket: ServiceTicket): void {
    const bos = this.ticketBos(ticket);
    if (!bos) {
      conn.destroy();
      return;
    }
    conn.name = ticket.name;
    conn.kind = 'bart';
    this.bartConns.set(conn, bos);
    conn.snac(1, 0x03, SERVER_REQUEST_ID, u16s(BART_FAMILIES));
  }

  private onAdminService(conn: Conn, ticket: ServiceTicket): void {
    const bos = this.ticketBos(ticket);
    if (!bos) {
      conn.destroy();
      return;
    }
    conn.name = ticket.name;
    conn.kind = 'admin';
    this.adminConns.set(conn, bos);
    conn.snac(1, 0x03, SERVER_REQUEST_ID, u16s(ADMIN_HOST_ONLINE));
  }

  // foodgroup/oservice.go HostOnline for ODir: ODir and OService.
  private onDirectoryService(conn: Conn, ticket: ServiceTicket): void {
    const bos = this.ticketBos(ticket);
    if (!bos) {
      conn.destroy();
      return;
    }
    conn.name = ticket.name;
    conn.kind = 'odir';
    this.odirConns.set(conn, bos);
    conn.snac(1, 0x03, SERVER_REQUEST_ID, u16s(ODIR_HOST_ONLINE));
  }

  private ticketBos(ticket: ServiceTicket): Conn | undefined {
    const bos = ticket.bos instanceof RoomConn ? ticket.bos.conn : undefined;
    return bos && this.accounts.get(ticket.name)?.instances.some((i) => i.conn === bos) ? bos : undefined;
  }

  private onSnac(conn: Conn, snac: Snac): void {
    if (conn.kind === 'auth') conn.name = normalizeScreenName(tlvStr(decoding(() => decodeTlvs(snac.body)), 0x01) ?? '');
    this.record(conn.name, snac, conn.kind);
    this.onSnacHook?.({ family: snac.family, subtype: snac.subtype, requestId: snac.requestId, body: snac.body, conn: conn.kind });
    if ((conn.kind === 'bos' || conn.kind === 'bart' || conn.kind === 'admin' || conn.kind === 'odir') && !this.admit(conn, snac)) return;
    const key = snacKey(snac.family, snac.subtype);
    const how = this.closing.get(key);
    if (how) {
      this.closing.delete(key);
      if (how === 'destroy') conn.destroy();
      else conn.signoff(how === 'kick' ? NEW_LOGIN_SIGNOFF : []);
      return;
    }
    const failure = this.failing.get(key);
    if (failure) {
      this.failing.delete(key);
      conn.snac(snac.family, 0x01, snac.requestId, new ByteWriter().u16(failure.code).bytes(encodeTlvs(failure.tlvs ?? [])).toBytes());
      return;
    }
    if (conn.kind === 'auth') this.onAuthSnac(conn, snac);
    else if (conn.kind === 'bos') this.onBosSnac(conn, snac);
    else if (conn.kind === 'bart') this.onBartSnac(conn, snac);
    else if (conn.kind === 'admin') this.onAdminSnac(conn, snac);
    else if (conn.kind === 'odir') this.onDirectorySnac(conn, snac);
    else this.onRoomSnac(conn, snac);
  }

  private onAdminSnac(conn: Conn, snac: Snac): void {
    const account = this.accounts.get(conn.name);
    const bos = this.adminConns.get(conn);
    const instance = account?.instances.find((i) => i.conn === bos);
    if (!account || !bos || !instance) return;
    switch (snacKey(snac.family, snac.subtype)) {
      case 0x0001_0017:
        conn.snac(1, 0x18, snac.requestId, snac.body);
        return;
      case 0x0001_000e:
        conn.snac(1, 0x0f, snac.requestId, this.userInfo(account, instance.presence.status));
        return;
      case 0x0001_0002:
        instance.complete = true;
        return;
    }
    if (snac.family !== FAMILY_ADMIN) {
      conn.snac(snac.family, 0x01, snac.requestId, new ByteWriter().u16(0x0001).toBytes());
      return;
    }
    const wire = { send: (family: number, subtype: number, requestId: number, body: Uint8Array): void => conn.snac(family, subtype, requestId, body) };
    decoding(() => this.admin.handle(wire, conn.name, bos, snac));
  }

  // OService as on an icon connection, from the BOS instance the connection belongs to; ODir as foodgroup/odir.go answers it.
  // A body the server cannot read, or a name search that leaves no clause, is a Go error there and ends the connection.
  private onDirectorySnac(conn: Conn, snac: Snac): void {
    const account = this.accounts.get(conn.name);
    const bos = this.odirConns.get(conn);
    const instance = account?.instances.find((i) => i.conn === bos);
    if (!account || !instance) return;
    switch (snacKey(snac.family, snac.subtype)) {
      case 0x0001_0017:
        conn.snac(1, 0x18, snac.requestId, snac.body);
        return;
      case 0x0001_000e:
        conn.snac(1, 0x0f, snac.requestId, this.userInfo(account, instance.presence.status));
        return;
      case 0x0001_0002:
        // foodgroup/oservice.go ClientOnline, for a service that is neither BOS nor Chat: the instance is complete, and no more.
        instance.complete = true;
        return;
      case 0x000f_0002:
        conn.snac(FAMILY_ODIR, 0x03, snac.requestId, this.directorySearch(decoding(() => decodeTlvs(snac.body))));
        return;
      case 0x000f_0004:
        conn.snac(FAMILY_ODIR, 0x05, snac.requestId, this.keywordListReply());
        return;
      default:
        conn.snac(snac.family, 0x01, snac.requestId, new ByteWriter().u16(0x0001).toBytes());
    }
  }

  // foodgroup/odir.go InfoQuery: email first, then interest, then first or last name; otherwise status 0x0004. The test server
  // holds no directory email addresses, so an email search finds no one.
  private directorySearch(tlvs: Tlv[]): Uint8Array {
    const reply = (status: number, found: Account[]): Uint8Array => {
      const w = new ByteWriter().u16(status).u16(0).u16(found.length);
      for (const account of found) {
        const l = account.listing;
        // foodgroup/odir.go searchResponse: first, last, state, city, country, screen name.
        const result = [
          tlv.str(0x0001, l.firstName),
          tlv.str(0x0002, l.lastName),
          tlv.str(0x0007, l.state),
          tlv.str(0x0008, l.city),
          tlv.str(0x0006, l.country),
          tlv.str(ODIR_TLV_SCREEN_NAME, account.display),
        ];
        w.u16(result.length).bytes(encodeTlvs(result));
      }
      return w.toBytes();
    };
    const everyone = [...this.accounts.values()];
    if (hasTlv(tlvs, ODIR_TLV_EMAIL)) return reply(ODIR_SEARCH_OK, []);
    const interest = tlvStr(tlvs, ODIR_TLV_INTEREST);
    if (interest !== undefined) {
      // state/user_store.go FindByAIMKeyword: the keyword's id, by its exact name, in one of the five slots.
      if (!this.offered(interest)) return reply(ODIR_SEARCH_OK, []);
      return reply(ODIR_SEARCH_OK, everyone.filter((account) => account.keywords.includes(interest)));
    }
    if (!hasTlv(tlvs, 0x0001) && !hasTlv(tlvs, 0x0002)) return reply(ODIR_SEARCH_NAME_MISSING, []);
    // state/user_store.go FindByAIMNameAndAddr: every field given and not empty, equal ignoring case. With none, the
    // WHERE clause is empty and the query a Go error.
    const wanted = DIR_FIELDS.map(([field, tag]) => [field, tlvStr(tlvs, tag) ?? ''] as const).filter(([, value]) => value !== '');
    if (wanted.length === 0) throw new ModelledDrop('a name search with no name builds an empty clause');
    return reply(
      ODIR_SEARCH_OK,
      everyone.filter((account) => wanted.every(([field, value]) => account.listing[field].toLowerCase() === value.toLowerCase())),
    );
  }

  // foodgroup/odir.go KeywordListQuery and state/user_store.go InterestList: u16 status, u16 count, then each item's u8
  // type, u8 id and u16-prefixed name. A category's keywords follow it under its id; a top-level keyword has id 0.
  private keywordListReply(): Uint8Array {
    const items: [number, number, string][] = [];
    let id = 0;
    for (const group of this.keywordList) {
      if (group.category === null) {
        for (const keyword of group.keywords) items.push([ODIR_KEYWORD, 0, keyword]);
        continue;
      }
      id++;
      items.push([ODIR_KEYWORD_CATEGORY, id, group.category]);
      for (const keyword of group.keywords) items.push([ODIR_KEYWORD, id, keyword]);
    }
    const w = new ByteWriter().u16(ODIR_KEYWORD_LIST_OK).u16(items.length);
    for (const [type, itemId, name] of items) w.u8(type).u8(itemId).str16(name);
    return w.toBytes();
  }

  // Whether the keyword list holds a keyword of that exact name.
  private offered(name: string): boolean {
    return this.keywordList.some((group) => group.keywords.includes(name));
  }

  // state/user_store.go SetKeywords: the first five TLV 0x000B fill the five slots in order; it stores a name the keyword list does
  // not hold as nothing.
  private storeKeywords(account: Account, interests: readonly string[]): void {
    account.keywords = interests.slice(0, KEYWORD_SLOTS).map((name) => (this.offered(name) ? name : null));
  }

  // foodgroup/locate.go SetDirInfo: all ten fields overwritten, a field not sent as ''.
  private setDirInfo(account: Account, conn: Conn, snac: Snac): void {
    const tlvs = decoding(() => decodeTlvs(snac.body));
    const listing = emptyDirInfo();
    for (const [field, tag] of DIR_FIELDS) listing[field] = tlvStr(tlvs, tag) ?? '';
    account.listing = listing;
    conn.snac(2, 0x0a, snac.requestId, new ByteWriter().u16(LOCATE_DIR_OK).toBytes());
  }

  // foodgroup/locate.go DirInfo: status OK, then the ten fields for a user the server knows, and none for one it does not.
  private getDirInfo(conn: Conn, snac: Snac): void {
    const name = decoding(() => new ByteReader(snac.body).str8());
    const listing = this.accounts.get(normalizeScreenName(name))?.listing;
    const tlvs = listing ? DIR_FIELDS.map(([field, tag]) => tlv.str(tag, listing[field])) : [];
    conn.snac(2, 0x0c, snac.requestId, new ByteWriter().u16(LOCATE_DIR_OK).u16(tlvs.length).bytes(encodeTlvs(tlvs)).toBytes());
  }

  // foodgroup/locate.go SetKeywordInfo: every TLV 0x000B, the first five stored; the reply's unknown is 1.
  private setKeywordInfo(account: Account, conn: Conn, snac: Snac): void {
    const interests = decoding(() => decodeTlvs(snac.body))
      .filter((t) => t.tag === ODIR_TLV_INTEREST)
      .map((t) => Buffer.from(t.value).toString('utf8'));
    account.keywordWrites.push(interests);
    this.storeKeywords(account, interests);
    conn.snac(2, 0x10, snac.requestId, new ByteWriter().u16(LOCATE_DIR_OK).toBytes());
  }

  // handler.go Handle: every SNAC goes through one table, so the server answers an icon connection's OService SNACs as on BOS.
  private onBartSnac(conn: Conn, snac: Snac): void {
    const account = this.accounts.get(conn.name);
    const bos = this.bartConns.get(conn);
    const instance = account?.instances.find((i) => i.conn === bos);
    if (!account || !instance) return;
    switch (snacKey(snac.family, snac.subtype)) {
      case 0x0001_0017:
        conn.snac(1, 0x18, snac.requestId, snac.body);
        return;
      case 0x0001_000e:
        conn.snac(1, 0x0f, snac.requestId, this.userInfo(account, instance.presence.status));
        return;
      case 0x0001_0002:
        instance.complete = true;
        return;
      case 0x0010_0002:
        this.bartUpload(account, conn, snac);
        return;
      case 0x0010_0004:
        this.bartDownload(conn, snac);
        return;
      default:
        conn.snac(snac.family, 0x01, snac.requestId, new ByteWriter().u16(0x0001).toBytes());
    }
  }

  private onRoomSnac(conn: Conn, snac: Snac): void {
    try {
      this.rooms.snac(this.roomConn(conn), snac.family, snac.subtype, snac.requestId, snac.body);
    } catch (error) {
      if (error instanceof RangeError || error instanceof OscarDecodeError) throw new ModelledDrop(error.message, { cause: error });
      throw error;
    }
  }

  private onAuthSnac(conn: Conn, snac: Snac): void {
    const tlvs = decoding(() => decodeTlvs(snac.body));
    const name = tlvStr(tlvs, 0x01) ?? '';
    let account = this.accounts.get(conn.name);
    const checks = this.opts.checkPasswords !== false;
    if (snac.family !== 0x17) {
      conn.destroy();
      return;
    }
    if (snac.subtype === 0x06) {
      // foodgroup/auth.go BUCPChallenge: with auth disabled, a name with no account gets a stub key.
      if (!account && !checks) {
        conn.snac(0x17, 0x07, snac.requestId, new ByteWriter().str16(`stub-${randomBytes(8).toString('hex')}`).toBytes());
        return;
      }
      if (!account) {
        // foodgroup/auth.go:264-281: the error code alone, no screen name.
        conn.snac(0x17, 0x03, snac.requestId, encodeTlvs([tlv.u16(0x08, LOGIN_ERR_UNKNOWN_NAME)]));
        conn.signoff([]);
        return;
      }
      conn.snac(0x17, 0x07, snac.requestId, new ByteWriter().str16(account.authKey).toBytes());
      return;
    }
    if (snac.subtype !== 0x02) {
      conn.destroy();
      return;
    }
    const refuse = (code: number): void => {
      conn.snac(0x17, 0x03, snac.requestId, encodeTlvs([tlv.str(0x01, name), tlv.u16(0x08, code)]));
      conn.signoff([]);
    };
    this.bucpLogins.push({
      name,
      remoteAddress: (conn.socket.remoteAddress ?? '').replace(/^::ffff:/, ''),
      multiConn: tlvU8(tlvs, 0x4a) ?? null,
      clientId: tlvStr(tlvs, 0x03) ?? null,
      tokenTtl: tlvU32(tlvs, 0x133a) ?? null,
    });
    // foodgroup/auth.go:514-536: the server refuses a lifetime out of range while it reads the TLVs, before it looks up the account.
    const lifetime = this.cookieLifetime(tlvs);
    if (lifetime === null) {
      refuse(LOGIN_ERR_INTERNAL_CLIENT);
      return;
    }
    const clientId = tlvStr(tlvs, 0x03) ?? '';
    // The 256-byte cookie cannot hold more; the real server drops the connection with no reply.
    if (Buffer.byteLength(name) + Buffer.byteLength(clientId) > COOKIE_NAME_AND_CLIENT_ID_MAX) {
      conn.destroy();
      return;
    }
    // foodgroup/auth.go:558-639: missing account, stored status, password, session cap, in that order.
    // With auth disabled, the test server makes a missing account with the password welcome1 and checks neither the password nor the cap.
    const flag = tlvU8(tlvs, 0x4a) ?? 0;
    const hash = findTlv(tlvs, 0x25) ?? new Uint8Array(0);
    if (!account && !checks) {
      this.addUser(name, 'welcome1');
      account = this.accounts.get(conn.name);
    }
    let refusal: number | undefined;
    if (!account) refusal = LOGIN_ERR_UNKNOWN_NAME;
    else if (account.loginError !== undefined) refusal = account.loginError;
    else if (checks && !Buffer.from(strongHash(account.password, account.authKey)).equals(Buffer.from(hash))) refusal = LOGIN_ERR_BAD_PASSWORD;
    else if (checks && this.atSessionCap(name, flag)) refusal = LOGIN_ERR_RATE_LIMITED;
    if (refusal !== undefined) {
      refuse(refusal);
      return;
    }
    const cookie = this.issueCookie(name, { multiConn: flag, ttlSeconds: lifetime, clientId });
    conn.snac(
      0x17,
      0x03,
      snac.requestId,
      encodeTlvs([tlv.str(0x01, this.opts.loginReplyName === 'typed' ? name : (account?.display ?? name)), tlv.str(0x05, this.opts.advertisedHost ?? this.ownAddress()), tlv.bytes(0x06, cookie), tlv.u8(0x8e, this.statesSsl() ? 0x02 : 0x00)]),
    );
    conn.signoff([]);
  }

  // The seconds a login cookie lasts, or null for a TLV 0x133A out of range.
  private cookieLifetime(tlvs: Tlv[]): number | null {
    if (this.opts.cookieLifetime === 'one-minute' || !hasTlv(tlvs, 0x133a)) return COOKIE_TTL_SECONDS;
    const asked = tlvU32(tlvs, 0x133a) ?? 0;
    return asked >= 1 && asked <= MAX_TOKEN_TTL_SECONDS ? asked : null;
  }

  // state/cookie.go hmacToken: the payload (expiry, then the session data) and its HMAC, each behind a u16 length.
  private mintCookie(expirySeconds: number): Uint8Array {
    const token = new ByteWriter().u16(22).u32(expirySeconds).u16(16).bytes(randomBytes(16)).u16(32).bytes(randomBytes(32)).toBytes();
    const cookie = new Uint8Array(256);
    cookie.set(token);
    return cookie;
  }

  private readNames(snac: Snac): string[] {
    return decoding(() => {
      const r = new ByteReader(snac.body);
      const names: string[] = [];
      while (r.remaining > 0) names.push(normalizeScreenName(r.str8()));
      return names;
    });
  }

  // foodgroup/buddy.go AddBuddies: no reply. Arrivals for the added names come at client online, or at once after it.
  // The test server counts the list as in use, as 0x13/0x07 does.
  private addSessionBuddies(account: Account, instance: Instance, snac: Snac): void {
    const names = this.readNames(snac);
    for (const name of names) account.sessionBuddies.add(name);
    if (!instance.listInUse) {
      this.advance(account, instance, () => {
        instance.listInUse = true;
      });
      return;
    }
    if (instance.complete && names.length > 0) this.refreshVisibility(account, new Set(names));
  }

  // foodgroup/buddy.go DelBuddies: no reply and no departure for a name it removes.
  private removeSessionBuddies(account: Account, snac: Snac): void {
    const names = this.readNames(snac);
    for (const name of names) account.sessionBuddies.delete(name);
    this.refreshVisibility(account, new Set(names));
  }

  private onBosSnac(conn: Conn, snac: Snac): void {
    const account = this.accounts.get(conn.name);
    const instance = account?.instances.find((i) => i.conn === conn);
    if (!account || !instance) return;
    switch (snacKey(snac.family, snac.subtype)) {
      case 0x0001_0017: {
        // The reply echoes the pairs, with OService at the lower of the version asked for and oserviceMax.
        const r = new ByteReader(snac.body);
        const w = new ByteWriter();
        while (r.remaining >= 4) {
          const family = r.u16();
          const version = r.u16();
          if (family === FAMILY_OSERVICE) instance.oserviceVersion = Math.min(version, this.opts.oserviceMax ?? OSERVICE_MULTI_INSTANCE_VERSION);
          w.u16(family).u16(family === FAMILY_OSERVICE ? instance.oserviceVersion : version);
        }
        conn.snac(1, 0x18, snac.requestId, w.bytes(r.rest()).toBytes());
        return;
      }
      case 0x0001_0004:
        // foodgroup/oservice.go ServiceRequest: a room cookie no room has is a Go error that ends this connection.
        this.rooms.serviceRequest(this.roomConn(conn), snac.requestId, snac.body);
        return;
      case 0x0001_0006: {
        const w = new ByteWriter().u16(RATE_CLASSES.length);
        for (const state of account.rates.values()) w.bytes(this.rateRecord(state.params, state.level, instance.oserviceVersion > 1));
        for (const c of RATE_CLASSES) {
          const pairs = RATE_GROUPS[c.id] ?? [];
          w.u16(c.id).u16(pairs.length);
          for (const [f, s] of pairs) w.u16(f).u16(s);
        }
        conn.snac(1, 0x07, snac.requestId, w.toBytes());
        return;
      }
      case 0x0001_0008: {
        const r = new ByteReader(snac.body);
        while (r.remaining >= 2) {
          const id = r.u16();
          instance.subscribed.add(id);
          const state = account.rates.get(id);
          if (state) state.subscribed = true;
        }
        return;
      }
      case 0x0001_000e:
        conn.snac(1, 0x0f, snac.requestId, this.userInfoReply(account, instance));
        return;
      case 0x0001_0002:
        this.advance(account, instance, () => {
          instance.complete = true;
        });
        this.sendNotices(account, instance);
        return;
      case 0x0001_0011: {
        // foodgroup/oservice.go IdleNotification: seconds, 0 clears; then an arrival, unconditionally.
        const seconds = decoding(() => new ByteReader(snac.body).u32());
        instance.presence.idle = seconds === 0 ? null : { since: this.now() - seconds * 1000 };
        this.broadcastArrived(account);
        return;
      }
      case 0x0001_001e:
        this.setStatus(account, instance, snac);
        return;
      case 0x0001_001f:
        // A fatal route: oservice.go:365 builds the ack with a nil body that wire/encode.go:15 cannot marshal, so the read loop ends.
        conn.destroy();
        return;
      case 0x0002_0002:
        conn.snac(2, 0x03, snac.requestId, encodeTlvs([1, 2, 3, 4, 5].map((tag) => tlv.u16(tag, 1000))));
        return;
      case 0x0002_0004:
        this.setInfo(account, instance, snac);
        return;
      case 0x0002_0009:
        this.setDirInfo(account, conn, snac);
        return;
      case 0x0002_000b:
        this.getDirInfo(conn, snac);
        return;
      case 0x0002_000f:
        this.setKeywordInfo(account, conn, snac);
        return;
      case 0x0002_0005:
      case 0x0002_0015: {
        // server/oscar/handler.go:774-781: the older query's type is 16 bits wide, the newer one's 32.
        const query = decoding(() => {
          const r = new ByteReader(snac.body);
          return { types: snac.subtype === 0x05 ? r.u16() : r.u32(), name: r.str8() };
        });
        this.infoQuery(account, instance, snac.requestId, query.types, query.name);
        return;
      }
      case 0x0004_0006: {
        const im = decoding(() => {
          const r = new ByteReader(snac.body);
          return { cookie: r.u64(), channel: r.u16(), to: r.str8(), tlvs: decodeTlvs(r.rest()) };
        });
        this.routeIm(account, im, { conn, requestId: snac.requestId });
        return;
      }
      case 0x0004_000b: {
        // foodgroup/icbm.go ClientErr: a channel 2 error ends the relay's session; the error goes on under the sender's name.
        const error = decoding(() => {
          const r = new ByteReader(snac.body);
          return { cookie: r.u64(), channel: r.u16(), to: r.str8(), rest: r.rest() };
        });
        if (error.channel === ICBM_CHANNEL_RENDEZVOUS) this.relay?.refuse(error.cookie);
        const body = new ByteWriter().u64(error.cookie).u16(error.channel).str8(account.display).bytes(error.rest).toBytes();
        const recipient = this.accounts.get(normalizeScreenName(error.to));
        for (const to of recipient ? this.liveInstances(recipient) : []) to.conn.snac(4, 0x0b, snac.requestId, body);
        if (recipient?.peerOnline && error.channel === ICBM_CHANNEL_RENDEZVOUS) recipient.peerRefused?.(error.cookie);
        return;
      }
      case 0x0004_0008: {
        const warning = decoding(() => {
          const r = new ByteReader(snac.body);
          return { anonymous: r.u16() === 1, to: r.str8() };
        });
        this.warn(account, warning.to, warning.anonymous, { conn, requestId: snac.requestId });
        return;
      }
      case 0x0004_0010:
        this.retrieveOffline(account, conn, snac.requestId);
        return;
      case 0x0004_0014: {
        const typing = decoding(() => {
          const r = new ByteReader(snac.body);
          return { cookie: r.u64(), channel: r.u16(), to: r.str8(), event: r.u16() };
        });
        this.relayTyping(account, typing, snac.requestId);
        return;
      }
      case 0x0010_0002:
        this.bartUpload(account, conn, snac);
        return;
      case 0x0010_0004:
        this.bartDownload(conn, snac);
        return;
      case 0x0003_0004:
        this.addSessionBuddies(account, instance, snac);
        return;
      case 0x0003_0005:
        this.removeSessionBuddies(account, snac);
        return;
      case 0x0004_0004:
        conn.snac(4, 0x05, snac.requestId, new ByteWriter().u16(100).u32(3).u16(512).u16(999).u16(999).u32(0).toBytes());
        return;
      case 0x0013_0002:
        conn.snac(
          0x13,
          0x03,
          snac.requestId,
          encodeTlvs([tlv.u16(0x03, 200), tlv.bytes(0x04, u16s(FEEDBAG_MAX_BY_CLASS)), tlv.u16(0x06, 200), tlv.u16(0x0c, 200)]),
        );
        return;
      case 0x0013_0004: {
        const w = new ByteWriter().u8(0).u16(account.feedbag.length).bytes(encodeFeedbagItems(account.feedbag)).u32(0);
        conn.snac(0x13, 0x06, snac.requestId, w.toBytes());
        return;
      }
      case 0x0013_0007:
        this.advance(account, instance, () => {
          instance.listInUse = true;
        });
        return;
      case 0x0013_0008:
      case 0x0013_0009:
      case 0x0013_000a:
        this.writeFeedbag(account, instance, snac);
        return;
      case 0x0013_0011:
      case 0x0013_0012:
        this.cluster(account, instance, snac);
        return;
      default:
        conn.snac(snac.family, 0x01, snac.requestId, new ByteWriter().u16(0x0001).toBytes());
    }
  }
}
