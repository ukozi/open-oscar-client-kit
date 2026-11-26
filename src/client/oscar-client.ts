import { OscarDecodeError } from '../wire/bytes.js';
import { ConnectionClosedError, RequestTimeoutError, openConnection } from '../wire/connection.js';
import type { CloseInfo, ConnectionLimits, OscarConnection } from '../wire/connection.js';
import { encodeNameList } from '../wire/buddy.js';
import {
  BUDDY_ADD_BUDDIES,
  BUDDY_DEL_BUDDIES,
  DIRECT_IM_MAX_ATTACHMENTS,
  DIRECT_IM_MAX_MESSAGE_BYTES,
  DIRECT_IM_MAX_SESSION_BYTES,
  DIRECT_IM_MAX_TEXT_BYTES,
  FAMILY_BUDDY,
  FAMILY_ICBM,
  FAMILY_OSERVICE,
  FAMILY_POPUP,
  GET_FILE_MAX_ENTRIES,
  GET_FILE_MAX_LISTING_BYTES,
  GET_FILE_MAX_SERVING,
  ICBM_ERR,
  ICBM_MSG_TO_HOST,
  OSERVICE_HOST_ONLINE,
  OSERVICE_MULTI_INSTANCE_VERSION,
  POPUP_DISPLAY,
  PROBE_TIMEOUT_MS,
  USER_FLAG_BOT,
} from '../wire/constants.js';
import type { DirListing, DirResult, KeywordGroup } from '../wire/odir.js';
import type { PeerAddress, RendezvousService } from '../wire/rendezvous.js';
import { ServiceRefusedError } from '../wire/oservice.js';
import { decodePopup } from '../wire/popup.js';
import type { Popup } from '../wire/popup.js';
import type { Snac, UserInfo } from '../wire/snac.js';
import type { Logger, TimerApi } from '../wire/types.js';
import { aimVariableValues } from '../model/aim-variables.js';
import { DEFAULT_TIME_FORMAT } from '../model/aim-variables.js';
import type { TimeFormat } from '../model/aim-variables.js';
import { awayBody } from '../model/away.js';
import type { AwayRecord } from '../model/away.js';
import type { DirectImOffer, DirectImStatus, DirectMessage, OutgoingDirectMessage } from '../model/direct-im.js';
import type { BrowseStatus, FileListing, ShareRequest, ShareStatus, ShareTaken, SharedSource } from '../model/get-file.js';
import { DEFAULT_IDLE_SETTINGS, idleAfterSeconds } from '../model/idle-settings.js';
import type { UserInfoSnapshot } from '../model/instances.js';
import { excludedSender, roomLineBlocked } from '../model/knock.js';
import type { BuddyList, BuddyPresence, BuddyRef, IncomingIm, UserInfoResult } from '../model/buddy-list.js';
import type { PrivacyMode } from '../model/privacy.js';
import type { RichText } from '../model/rich-text.js';
import { MAX_ROOMS } from '../model/room.js';
import { isHtmlBody } from '../model/wire-detail.js';
import type { ImBody } from '../model/wire-detail.js';
import type { Invite, RoomId, RoomMessage, RoomOccupantChange, RoomRate, RoomStatus } from '../model/room.js';
import { isValidScreenName, normalizeScreenName, utf8ByteLength } from '../model/screen-name.js';
import type { SelfInfo, SessionLimits, SessionState, SignOffReason, SignOnFailure } from '../model/session.js';
import type { FileOfferNotice, FileSink, OutgoingFile, TransferStatus } from '../model/transfer.js';
import { Account } from './account.js';
import { parseAimHtml } from './aim-html.js';
import { AwayRecords } from './away-record.js';
import type { AwayRecordOptions, AwaySignOn } from './away-record.js';
import { BosLink } from './bos-link.js';
import { connectionTls } from './connect-options.js';
import { Directory } from './directory.js';
import { OscarError, SignOnError } from './errors.js';
import { Feedbag, FeedbagCopy } from './feedbag.js';
import { guardTimers } from './guard.js';
import type { GuardSite } from './guard.js';
import { Icons, memoryIconStore } from './icons.js';
import type { IconChange, IconList, IconsFrom, IconStore } from './icons.js';
import { defaultLoginBudget } from './login-budget.js';
import type { LoginBudget } from './login-budget.js';
import { IM_FALLBACK_LIMIT_BYTES, Messaging } from './messaging.js';
import type { AutoResponse, AutoResponseDecision, SendImOptions, SentIm, TypingEvent } from './messaging.js';
import { Presence } from './presence.js';
import { Profiles } from './profiles.js';
import { desktopReconnectPolicy, dropEvidence } from './reconnect.js';
import type { DropEvidence, ReconnectDecision, ReconnectPolicy } from './reconnect.js';
import { DESKTOP_REJOIN } from './rejoin.js';
import type { RejoinPolicy, Siblings } from './rejoin.js';
import { Rooms } from './rooms.js';
import type { RoomsContext } from './rooms.js';
import { serviceResolver } from './service.js';
import { BART_FOOD_GROUP, SignOn } from './sign-on.js';
import type { Credentials, PreOnlinePlan, Restore, ServerAddress, SignOnDeps } from './sign-on.js';
import { SkipCounter, skippedSender } from './skips.js';
import { bucpTicketSource } from './tickets.js';
import type { IssuedTicket, TicketSource } from './tickets.js';
import { Transfers } from './transfers.js';
import { DirectIm } from './direct-im.js';
import { GetFile } from './get-file.js';
import { Rendezvous } from './rendezvous.js';

/** Bounds for a process that hosts many sessions. Each defaults to none. */
export type HostingLimits = {
  /** SNACs a connection holds before its first listener. */
  backlogMax?: number;
  /** Jobs waiting in one rate class of the BOS link. */
  classQueueMax?: number;
  /** Send no liveness probe on BOS while its rate class is held. */
  skipProbeWhileRateHeld?: boolean;
};
export type FileTransferOptions = {
  /** Asked before each dial to the address that a file offer names. The default allows every address. */
  allowDial?: (address: PeerAddress, context: { server: ServerAddress; bos: { host: string; port: number } }) => boolean | Promise<boolean>;
  /**
   * Asked one time for each file offer that comes, with the name of the sender. A blocked name is not shown to it.
   * The name has the letter case and the spaces that the sender set. Compare it after `normalizeScreenName`.
   * For true, the client keeps the offer. For false, the client drops the offer: it sends nothing, shows nothing and keeps nothing.
   * A later cancel for a dropped offer has no effect, and the client asks the rule again when the same offer comes again.
   * The client asks the rule before each answer, also before the cancel for an offer that it cannot take.
   * The rule gives its result at once. A result that is not true or false, such as a promise, drops the offer. A throw drops the offer.
   * The default allows each offer. Get File has no such rule.
   */
  allowOffer?: (from: string) => boolean;
};
export type DirectImOptions = {
  /** Asked before each dial to the address that a Direct IM offer names. The default is the rule of `fileTransfer`. */
  allowDial?: FileTransferOptions['allowDial'];
  /**
   * Asked one time for each Direct IM offer that comes, with the name of the sender. A blocked name is not shown to it.
   * The name has the letter case and the spaces that the sender set. Compare it after `normalizeScreenName`.
   * For true, the client keeps the offer. For false, the client drops the offer: it sends nothing, shows nothing and keeps nothing.
   * An offer of the same name that waits stays, and an offer of this client to that name stays.
   * A later cancel for a dropped offer has no effect, and the client asks the rule again when the same offer comes again.
   * The client asks the rule before each answer, also before the cancel for an offer that it cannot take.
   * The rule gives its result at once. A result that is not true or false, such as a promise, drops the offer. A throw drops the offer.
   * The default allows each offer. The rule of `fileTransfer` does not apply here.
   */
  allowOffer?: (from: string) => boolean;
  /** The largest payload of one frame. Default `DIRECT_IM_MAX_MESSAGE_BYTES`. */
  maxMessageBytes?: number;
  /** The most attachments of one message. Default `DIRECT_IM_MAX_ATTACHMENTS`. */
  maxAttachments?: number;
  /** The most bytes of text in one message that comes. A message with more text ends the session `too-large`. Default `DIRECT_IM_MAX_TEXT_BYTES`. */
  maxTextBytes?: number;
  /** The most payload bytes that one connection brings. The frame that passes the limit is read, then the session ends `too-large`. Default `DIRECT_IM_MAX_SESSION_BYTES`. */
  maxSessionBytes?: number;
  /** A message goes out after this wait when the peer stays silent. Default null: it waits for the cookie. */
  sendUnverifiedAfterMs?: number | null;
};
export type GetFileOptions = {
  /** Asked before each dial to the address that a Get File offer names. The default is the rule of `fileTransfer`. */
  allowDial?: FileTransferOptions['allowDial'];
  /** The most bytes of one listing that comes. A listing with more ends the browse `too-large`. Default `GET_FILE_MAX_LISTING_BYTES`. */
  maxListingBytes?: number;
  /** The most entries of one listing. A listing that comes with more is cut and marked `truncated`. A listing that goes out is cut. Default `GET_FILE_MAX_ENTRIES`. */
  maxEntries?: number;
  /** The most requesters served at one time. Default `GET_FILE_MAX_SERVING`. */
  maxServing?: number;
};
export type OscarClientOptions = {
  log?: Logger;
  now?: () => number;
  timers?: TimerApi;
  loginBudget?: LoginBudget;
  /** The client ID the login request carries (TLV 0x03). The default is `FALLBACK_CLIENT_ID`. */
  clientId?: string;
  /** The capabilities written to the Locate profile. The default is `[CAP_UTF8_MESSAGES, CAP_CHAT]`. */
  capabilities?: readonly Uint8Array[];
  /** The OService version asked for on BOS. The server can grant less. The default is 1. */
  oserviceVersion?: 1 | 4;
  /** The login cookie lifetime asked for (TLV 0x133A), from 1 to `TOKEN_TTL_MAX_SECONDS`. The default asks for none. */
  tokenTtlSeconds?: number;
  /** Where BOS and every service redirect (ChatNav, Chat, BART, Admin, ODir and `probeService`) go, whatever host the server advertises. The default follows a routable advertised host. */
  pinRedirects?: ServerAddress;
  /** From -1 to 1: how far the client varies a reconnect delay. The default is `Math.random() * 2 - 1`. */
  random?: () => number;
  /** Decides after each drop and each failed reconnect attempt whether to try again, and when. The default is `desktopReconnectPolicy(random)`. */
  reconnect?: ReconnectPolicy;
  /** Decides which rooms to rejoin after a reconnect and whether to rejoin one whose connection closed, knowing what it can of the other instances. The default is `DESKTOP_REJOIN`. A policy that throws or rejects acts as the default. */
  rejoin?: RejoinPolicy;
  /** Seconds since the last input, read when a sign-on reports idle before client online. The default is 0. */
  systemIdleSeconds?: () => number;
  /** Asked on every BOS connect, before client online, whether to write invisible and report idle. The default returns `held`. */
  preOnline?: (ctx: PreOnlineContext) => PreOnlinePlan;
  /** Where the client keeps icon bytes, by hash. The default is `memoryIconStore()`. */
  iconStore?: IconStore;
  /** Where the client learns icons. With `'none'` it asks for no icon and `iconOf` answers null. The default is `'buddies'`. */
  iconsFrom?: IconsFrom;
  /** The locale and clock of %d and %t. The default, and the fallback when it throws, is `DEFAULT_TIME_FORMAT`. */
  timeFormat?: () => TimeFormat;
  /** Bounds on backlogs and queues, and the probe under a rate alert. The default is none: no bounds, and the probe goes out on schedule. */
  limits?: HostingLimits;
  /** Asked when an auto-response is about to go out: away, the sender not yet answered and not held. `send` is the default; `count` marks the sender answered without sending, `skip` leaves it unanswered. A throw or rejection counts as `skip`. */
  autoRespond?: (ctx: { to: string; at: number }) => AutoResponseDecision | Promise<AutoResponseDecision>;
  /** A sender whose live IMs are server notices, besides any IM with a bare user-info block and no send time. The default is none. */
  noticeSender?: string | null;
  /**
   * Hears each throw from the client's own timers, tasks, listeners and sign-on code. The default logs a throwing listener,
   * ignores an unexpected sign-on failure and throws again at the other sites.
   */
  guard?: (error: unknown, site: GuardSite) => void;
  /** The account's away record in the feedbag, which this instance writes and follows, taking it at sign-on and reading the list again after client online. The default ignores it. */
  awayRecord?: AwayRecordOptions;
  /** The charset of text that has no charset field on the wire, as a popup's message. The server sets this charset. The default is `'windows-1252'`. A label that the runtime does not know throws a `RangeError`. */
  legacyCharset?: string;
  /** Turns file transfer on, and adds `CAP_SEND_FILE` to the capabilities written. The default is off: the client ignores each file offer and sends none. */
  fileTransfer?: FileTransferOptions;
  /** Turns Direct IM on, and adds `CAP_DIRECT_IM` to the capabilities written. The default is off. */
  directIm?: DirectImOptions;
  /** Turns Get File on, and adds `CAP_GET_FILE` to the capabilities written. Each request is declined while `shareFiles` has no source. The default is off. */
  getFile?: GetFileOptions;
  /** Adds `CAP_BUDDY_ICON` to the capabilities written. It changes nothing else: the client sets and gets icons with or without it. The default is off. */
  buddyIcon?: boolean;
  /** Opens each server connection with TLS: login, BOS and each service. `caFile` names a PEM file of the certificates to trust. Peer connections stay plain. The default is plain TCP. */
  tls?: { caFile?: string };
  /** Goes to each host that the server advertises for BOS and the services, also a loopback or unroutable one. `pinRedirects` comes first. The default is false. */
  followRedirects?: boolean;
  /**
   * The local address that the login, the BOS connection and each peer connection bind. The login binds it only when the client logs in itself.
   * Service connections (rooms, icons, admin, directory) do not bind. The default lets the system choose.
   */
  localAddress?: string;
  /**
   * Where the client dials for an address that a rendezvous message names. The client asks `allowDial` with the address first, then dials here.
   * The default is the address.
   */
  peerRoute?: (address: PeerAddress) => { host: string; port: number };
  /**
   * Gives the names to watch at each connect. The client sends them in 0x03/0x04 and does not hold or activate the server's list.
   * `buddyList` is empty. Each write to the list rejects with `invalid-argument`. Only `setOwnIcon` and `clearOwnIcon` can write.
   * It cannot go with `awayRecord`. The default is the server's list.
   */
  sessionBuddies?: () => readonly string[];
  /** Adds `wire`, the cookie and the HTML as they came, to each incoming IM, room line and invitation. The default is false. */
  wireDetail?: boolean;
  /** Writes each BOS send at once, with no pacing, when the user info of the account at a connect carries user flag 0x0400. Room sends stay paced. The default is false. */
  botFlagExempt?: boolean;
  /** The most rooms joined at one time, an integer of 1 or more. The default is `MAX_ROOMS`. */
  maxRooms?: number;
  /**
   * The pacing margin in milliseconds, 0 or more, for BOS and for each room connection. The server measures the time between the arrivals of two sends.
   * With the margin, a send can arrive this much nearer to the send before it and cause no rate alert.
   * The client keeps the level of a rate class above the alert level by `ceil(paceMarginMs / windowSize) + windowSize`.
   * The second part is for the rounding of the server, and it stays when the margin is 0.
   * The margin can move the first wait of a burst to an earlier send. In its first waits, a burst takes longer by approximately that number times `windowSize`, in milliseconds.
   * After that, each paced wait is longer by that number of milliseconds.
   * With the default, a burst in a class with a window of 20 takes approximately 660 ms longer. Then each wait is 33 ms longer.
   * A burst in a class with a window of 80 takes approximately 6720 ms longer. Then each wait is 84 ms longer.
   * The default is `PACE_MARGIN_MS`. A value that is not a number of 0 or more throws a `RangeError`.
   */
  paceMarginMs?: number;
};
/** The services that `setServices` turns on or off. A key that is not given stays as it is. */
export type ServiceSwitch = { fileTransfer?: boolean; directIm?: boolean; getFile?: boolean };
/** What a first sign-on puts back. Only a `restore` puts back the away it held, in its first Locate write, with the senders answered while away. */
export type ResumeState = { origin: 'start' | 'restore'; invisible: boolean; away: AwayRecord | null; answered: readonly string[]; reportIdle: boolean };
export type SignOnOptions = { profile?: RichText; resume?: ResumeState };
/** `userInfo` is null below OService 4; `held` is what the client does by itself. */
export type PreOnlineContext = { reconnect: boolean; userInfo: UserInfoSnapshot | null; held: PreOnlinePlan };
/** A notice from the server. `body` keeps the formatting of the message, and `message` is only its text. */
export type PopupNotice = Omit<Popup, 'html'> & { body: RichText };

export type OscarClientEvents = {
  state: { state: SessionState; reason?: SignOffReason; reconnect?: { attempt: number; nextRetryAt: number } };
  self: SelfInfo;
  buddyList: BuddyList;
  presence: BuddyPresence;
  im: IncomingIm;
  typing: { from: string; typing: boolean };
  autoResponse: AutoResponse;
  /** A sender answered in this away period, by normalised name; `sent` is false when the host counted the answer without sending it. */
  answered: { screenName: string; sent: boolean };
  rate: { limited: boolean };
  warned: { level: number; by: string | null };
  buddyInfo: { screenName: string; awayMessage?: RichText | null; profile?: RichText | null };
  room: RoomStatus;
  roomOccupant: RoomOccupantChange;
  roomMessage: RoomMessage;
  roomInvite: Invite;
  inviteDeclined: { roomId: string; by: string };
  /** The send class of a room connection changed its rate state. The `rate` event is only for the BOS connection. */
  roomRate: RoomRate;
  icon: IconChange;
  userInfo: UserInfoSnapshot;
  ticket: IssuedTicket;
  /** What this instance holds of the away record changed; `applied` when it took another instance's. */
  awayRecord: { record: AwayRecord | null; itemId: number | null; applied: boolean };
  /** A notice from the server. It has no sender. */
  popup: PopupNotice;
  /** A buddy offers one or more files. */
  fileOffer: FileOfferNotice;
  /** A transfer changed state or moved on. */
  transfer: TransferStatus;
  /** A buddy offers a Direct IM session. */
  directImOffer: DirectImOffer;
  /** A Direct IM session changed state. */
  directIm: DirectImStatus;
  directMessage: DirectMessage;
  /** Each file of the folder that a buddy shares. It comes one time for a browse. */
  fileListing: FileListing;
  /** A visit to the files of a buddy changed state. */
  browse: BrowseStatus;
  /** A person asks to see the shared files. */
  shareRequest: ShareRequest;
  /** A visit to the shared files changed state. */
  share: ShareStatus;
  /** A person took one shared file. */
  shareTaken: ShareTaken;
};

/** An IM or an info query writes the screen name's length in one byte. */
const MAX_RECIPIENT_BYTES = 255;
/** What the server documents for a client it told no limit. */
const AWAY_AND_PROFILE_FALLBACK_BYTES = 1000;
/** The whole of a service probe: the request on BOS, the connection and its host online. */
const SERVICE_PROBE_TIMEOUT_MS = 20_000;
// The time in which the error of the server for a proposal comes.
const PROPOSAL_ERROR_MS = 10_000;

type Listeners = { [E in keyof OscarClientEvents]: Set<(payload: OscarClientEvents[E]) => void> };
type Attempt = { cancelled: boolean; readonly conns: OscarConnection[] };
type Session = { readonly source: TicketSource; readonly server: ServerAddress; profile: RichText };
type Reconnect = { failures: number; readonly invisible: boolean; readonly droppedAt: number; timer: ReturnType<typeof setTimeout> | null };
type BringUp = { reconnect: boolean; held: PreOnlinePlan; restore: Restore; awayRecord: Pick<AwaySignOn, 'origin' | 'held'> };
type Up = { link: BosLink; limits: SessionLimits; oserviceVersion: number; issued: IssuedTicket };
type Evidenced = SignOnError & { readonly evidence: DropEvidence };

const SERVICE_KEYS = ['fileTransfer', 'directIm', 'getFile'] as const;

const silent: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function probeFailure(error: unknown): OscarError {
  if (error instanceof OscarError) return error;
  if (error instanceof ServiceRefusedError) return new OscarError({ kind: 'refused', code: error.code });
  return new OscarError({ kind: 'connection-lost' });
}

export class OscarClient {
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly timers: TimerApi;
  private readonly guard: (error: unknown, site: GuardSite) => void;
  private readonly hosting: HostingLimits;
  private readonly paceMarginMs: number | undefined;
  private readonly skips = new SkipCounter();
  private readonly random: () => number;
  private readonly policy: ReconnectPolicy;
  private readonly rejoinPolicy: RejoinPolicy;
  private readonly systemIdleSeconds: () => number;
  private readonly preOnline: (ctx: PreOnlineContext) => PreOnlinePlan;
  private idleAfterSeconds: number | null = idleAfterSeconds(DEFAULT_IDLE_SETTINGS);
  private readonly signOnDeps: SignOnDeps;
  // Which service options were given, and which of those services are on.
  private readonly given: Required<ServiceSwitch>;
  private readonly switched: Required<ServiceSwitch>;
  private readonly signOnService: SignOn;
  private readonly feedbag: Feedbag;
  private readonly presence: Presence;
  private readonly messaging: Messaging;
  private readonly profiles: Profiles;
  private readonly roomService: Rooms;
  private readonly rendezvous: Rendezvous;
  private readonly transfers: Transfers;
  private readonly directIm: DirectIm;
  private readonly getFile: GetFile;
  private readonly icons: Icons;
  private readonly account: Account;
  private readonly directory: Directory;
  private readonly awayRecords: AwayRecords | null;
  private iconsFrom: IconsFrom;
  private readonly legacyCharset: string;
  private readonly listeners: Listeners = {
    state: new Set(), self: new Set(), buddyList: new Set(), presence: new Set(), im: new Set(), typing: new Set(), autoResponse: new Set(),
    answered: new Set(), rate: new Set(), buddyInfo: new Set(), warned: new Set(), room: new Set(), roomOccupant: new Set(), roomMessage: new Set(),
    roomInvite: new Set(), inviteDeclined: new Set(), roomRate: new Set(), icon: new Set(), userInfo: new Set(), ticket: new Set(), awayRecord: new Set(),
    popup: new Set(), fileOffer: new Set(), transfer: new Set(),
    directImOffer: new Set(), directIm: new Set(), directMessage: new Set(),
    fileListing: new Set(), browse: new Set(), shareRequest: new Set(), share: new Set(), shareTaken: new Set(),
  };
  private current: SessionState = 'offline';
  private attempt: Attempt | null = null;
  private session: Session | null = null;
  private reconnect: Reconnect | null = null;
  private link: BosLink | null = null;
  private sessionLimits: SessionLimits | null = null;
  private negotiatedOserviceVersion: number | null = null;
  private issued: IssuedTicket | null = null;
  private onlineAt = 0;
  private imLimited = false;
  // A copy of the server's list that lives for one write of the icon item. Null without `sessionBuddies`.
  private readonly iconList: FeedbagCopy | null;
  // The names sent on the current connection, normalised. Null without `sessionBuddies`.
  private watched: ReadonlySet<string> | null;

  constructor(opts: OscarClientOptions = {}) {
    const maxRooms = roomLimit(opts.maxRooms);
    this.paceMarginMs = paceMargin(opts.paceMarginMs);
    if (opts.sessionBuddies && opts.awayRecord) throw new RangeError('sessionBuddies cannot go with awayRecord');
    this.watched = opts.sessionBuddies ? new Set() : null;
    this.given = { fileTransfer: opts.fileTransfer !== undefined, directIm: opts.directIm !== undefined, getFile: opts.getFile !== undefined };
    this.switched = { ...this.given };
    this.legacyCharset = new TextDecoder(opts.legacyCharset ?? 'windows-1252').encoding;
    this.log = opts.log ?? silent;
    this.iconList = opts.sessionBuddies ? new FeedbagCopy({ log: this.log }) : null;
    this.now = opts.now ?? Date.now;
    this.guard = opts.guard ?? ((error, site) => this.defaultGuard(error, site));
    this.timers = guardTimers(opts.timers ?? { setTimeout, clearTimeout }, (error) => this.guard(error, { kind: 'timer' }));
    this.hosting = opts.limits ?? {};
    this.iconsFrom = opts.iconsFrom ?? 'buddies';
    const connectionLimits: ConnectionLimits = { backlogMax: this.hosting.backlogMax };
    this.random = opts.random ?? (() => Math.random() * 2 - 1);
    this.policy = opts.reconnect ?? desktopReconnectPolicy(this.random);
    this.rejoinPolicy = opts.rejoin ?? DESKTOP_REJOIN;
    this.systemIdleSeconds = opts.systemIdleSeconds ?? (() => 0);
    this.preOnline = opts.preOnline ?? ((ctx) => ctx.held);
    const timeFormat = opts.timeFormat ?? (() => DEFAULT_TIME_FORMAT);
    const autoRespond = opts.autoRespond ?? (() => 'send');
    this.feedbag = new Feedbag({ log: this.log, changed: () => this.listChanged() });
    this.profiles = new Profiles({
      log: this.log,
      now: this.now,
      isBuddy: (name) => this.isBuddy(name),
      presenceOf: (screenName) => this.presence.get(screenName),
      emit: (info) => this.emit('buddyInfo', info),
    });
    this.presence = new Presence({
      now: this.now,
      watched: opts.sessionBuddies ? (name) => this.watched?.has(name) === true : undefined,
      emit: (presence) => {
        // The cache first: it must not answer a `presence` listener's info request from what this update discarded.
        this.profiles.onPresence(presence);
        this.emit('presence', presence);
      },
    });
    this.messaging = new Messaging({
      now: this.now,
      log: this.log,
      imLimit: () => this.imLimit(),
      emit: (im) => this.emit('im', im),
      emitTyping: (typing) => this.emit('typing', typing),
      emitAutoResponse: (sent) => this.emit('autoResponse', sent),
      decide: autoRespond,
      emitAnswered: (answered) => this.emit('answered', answered),
      variables: (to, at) => aimVariableValues(to, at, this.timeFormatNow(timeFormat)),
      presenceOf: (screenName) => this.presence.get(screenName),
      noticeSender: opts.noticeSender ?? null,
      wireDetail: opts.wireDetail === true,
    });
    this.roomService = new Rooms({
      log: this.log,
      now: this.now,
      timers: this.timers,
      random: () => (this.random() + 1) / 2,
      limits: connectionLimits,
      spawn: (task, run) => this.spawn(task, run),
      emitRoom: (status) => this.emit('room', status),
      emitOccupant: (change) => this.emit('roomOccupant', change),
      emitMessage: (message) => this.emit('roomMessage', message),
      isBlocked: (name) => roomLineBlocked(this.feedbag.buddyList().privacy, name),
      emitInvite: (invite) => this.emit('roomInvite', invite),
      emitDeclined: (declined) => this.emit('inviteDeclined', declined),
      emitRate: (rate) => this.emit('roomRate', rate),
      bosAlive: () => (this.current === 'online' && this.link ? this.link.alive(PROBE_TIMEOUT_MS) : Promise.resolve(false)),
      sawUser: (info) => this.sawRoomUser(info),
      afterClosed: (room, close) => this.afterRoomClosed(room, close),
      context: () => this.currentRoomsContext(),
      wireDetail: opts.wireDetail === true,
      maxRooms,
      paceMarginMs: this.paceMarginMs,
      tls: opts.tls,
      followRedirects: opts.followRedirects === true,
    });
    const toHost = async (body: Uint8Array): Promise<void> => this.onlineLink().send(FAMILY_ICBM, ICBM_MSG_TO_HOST, body);
    const fileRule = opts.fileTransfer?.allowDial;
    const directImRule = opts.directIm?.allowDial ?? fileRule;
    const getFileRule = opts.getFile?.allowDial ?? fileRule;
    const dialRule = (service: RendezvousService): FileTransferOptions['allowDial'] => {
      if (service === 'direct-im') return directImRule;
      return service === 'get-file' ? getFileRule : fileRule;
    };
    // One Rendezvous for each service: one meeting with the relay runs at a time.
    this.rendezvous = new Rendezvous({
      log: this.log,
      now: this.now,
      timers: this.timers,
      send: toHost,
      propose: (body, refused) => this.propose(body, refused),
      allowDial: (address, service) => this.mayDial(dialRule(service), address),
      route: opts.peerRoute,
      localAddress: opts.localAddress,
    });
    this.transfers = new Transfers({
      log: this.log,
      now: this.now,
      timers: this.timers,
      enabled: () => this.switched.fileTransfer,
      rendezvous: this.rendezvous,
      send: toHost,
      isBlocked: (name) => this.excluded(name),
      allowOffer: opts.fileTransfer?.allowOffer ?? (() => true),
      emitOffer: (offer) => this.emit('fileOffer', offer),
      emitTransfer: (status) => this.emit('transfer', status),
    });
    this.directIm = new DirectIm({
      log: this.log,
      now: this.now,
      timers: this.timers,
      enabled: () => this.switched.directIm,
      rendezvous: this.rendezvous,
      self: () => this.signOnService.self?.screenName ?? '',
      send: toHost,
      isBlocked: (name) => this.excluded(name),
      allowOffer: opts.directIm?.allowOffer ?? (() => true),
      maxMessageBytes: opts.directIm?.maxMessageBytes ?? DIRECT_IM_MAX_MESSAGE_BYTES,
      maxAttachments: opts.directIm?.maxAttachments ?? DIRECT_IM_MAX_ATTACHMENTS,
      maxTextBytes: opts.directIm?.maxTextBytes ?? DIRECT_IM_MAX_TEXT_BYTES,
      maxSessionBytes: opts.directIm?.maxSessionBytes ?? DIRECT_IM_MAX_SESSION_BYTES,
      sendUnverifiedAfterMs: opts.directIm?.sendUnverifiedAfterMs ?? null,
      emitOffer: (offer) => this.emit('directImOffer', offer),
      emitStatus: (status) => this.emit('directIm', status),
      emitMessage: (message) => this.emit('directMessage', message),
      emitTyping: (typing) => this.emit('typing', typing),
    });
    this.getFile = new GetFile({
      log: this.log,
      now: this.now,
      timers: this.timers,
      enabled: () => this.switched.getFile,
      rendezvous: this.rendezvous,
      send: toHost,
      isBlocked: (name) => this.excluded(name),
      maxListingBytes: opts.getFile?.maxListingBytes ?? GET_FILE_MAX_LISTING_BYTES,
      maxEntries: opts.getFile?.maxEntries ?? GET_FILE_MAX_ENTRIES,
      maxServing: opts.getFile?.maxServing ?? GET_FILE_MAX_SERVING,
      emitListing: (listing) => this.emit('fileListing', listing),
      emitBrowse: (status) => this.emit('browse', status),
      emitTransfer: (status) => this.emit('transfer', status),
      emitRequest: (request) => this.emit('shareRequest', request),
      emitShare: (status) => this.emit('share', status),
      emitTaken: (taken) => this.emit('shareTaken', taken),
    });
    this.icons = new Icons({
      log: this.log,
      now: this.now,
      timers: this.timers,
      store: opts.iconStore ?? memoryIconStore(),
      limits: connectionLimits,
      from: () => this.iconsFrom,
      tls: opts.tls,
      followRedirects: opts.followRedirects === true,
      self: () => this.signOnService.self?.screenName ?? null,
      emit: (change) => this.emit('icon', change),
    });
    this.signOnDeps = {
      log: this.log,
      now: this.now,
      timers: this.timers,
      budget: opts.loginBudget ?? defaultLoginBudget,
      clientId: opts.clientId,
      capabilities: opts.capabilities,
      sendFile: () => this.switched.fileTransfer,
      directIm: () => this.switched.directIm,
      getFile: () => this.switched.getFile,
      buddyIcon: opts.buddyIcon === true,
      oserviceVersion: opts.oserviceVersion,
      tokenTtlSeconds: opts.tokenTtlSeconds,
      pinRedirects: opts.pinRedirects,
      localAddress: opts.localAddress,
      tls: opts.tls,
      followRedirects: opts.followRedirects === true,
      sessionBuddies: opts.sessionBuddies,
      botFlagExempt: opts.botFlagExempt === true,
      limits: connectionLimits,
      emitSelf: (self) => this.emit('self', self),
      emitWarned: (warned) => this.emit('warned', warned),
      emitUserInfo: (snapshot) => this.emit('userInfo', snapshot),
    };
    this.signOnService = new SignOn(this.signOnDeps);
    const transport = { tls: opts.tls, followRedirects: opts.followRedirects === true };
    this.account = new Account({ log: this.log, now: this.now, timers: this.timers, limits: connectionLimits, renamed: (name) => this.signOnService.renamed(name), ...transport });
    this.directory = new Directory({ log: this.log, now: this.now, timers: this.timers, limits: connectionLimits, pin: opts.pinRedirects, ...transport });
    this.awayRecords = opts.awayRecord
      ? new AwayRecords(opts.awayRecord, {
          log: this.log,
          now: this.now,
          feedbag: this.feedbag,
          ownAway: () => this.profiles.awayMessage,
          setAway: (link, message, limit) => this.writeAway(link, message, limit),
          spawn: (task, run) => this.spawn(task, run),
          emit: (event) => this.emit('awayRecord', event),
        })
      : null;
  }

  on<E extends keyof OscarClientEvents>(event: E, fn: (payload: OscarClientEvents[E]) => void): () => void {
    const set: Set<(payload: OscarClientEvents[E]) => void> = this.listeners[event];
    set.add(fn);
    return () => {
      set.delete(fn);
    };
  }

  get state(): SessionState {
    return this.current;
  }

  get self(): SelfInfo | null {
    return this.signOnService.self;
  }

  get limits(): SessionLimits | null {
    return this.sessionLimits;
  }

  /** What the current BOS connection negotiated; null unless online. */
  get oserviceVersion(): number | null {
    return this.negotiatedOserviceVersion;
  }

  /** When the last SNAC arrived on the current BOS connection; null unless online. */
  get lastHeardAt(): number | null {
    return this.current === 'online' && this.link ? this.link.lastHeardAt : null;
  }

  /** SNACs skipped because the client cannot handle them, by sender over the client's lifetime: `''` for an unknown sender, `*` for every one past the cap. */
  skippedSnacs(): ReadonlyMap<string, number> {
    return this.skips.snapshot();
  }

  /** The ticket of the current or last online connection. */
  get ticket(): IssuedTicket | null {
    return this.issued;
  }

  /** The latest reply to this client's own user info query on BOS; null once the connection is gone. */
  userInfo(): UserInfoSnapshot | null {
    return this.signOnService.userInfo;
  }

  buddyList(): BuddyList {
    return this.feedbag.buddyList();
  }

  denyItems(): number {
    return this.feedbag.denyItems;
  }

  presenceOf(screenName: string): BuddyPresence | undefined {
    return this.presence.get(screenName);
  }

  private timeFormatNow(read: () => TimeFormat): TimeFormat {
    try {
      return read();
    } catch (error) {
      this.log.warn('could not read the time format', { error: error instanceof Error ? error.name : typeof error });
      return DEFAULT_TIME_FORMAT;
    }
  }

  get awayMessage(): RichText | null {
    return this.profiles.awayMessage;
  }

  /** The away record this instance holds, or the one it took with none stored; null without the `awayRecord` option. */
  get awayRecord(): AwayRecord | null {
    return this.awayRecords?.held ?? null;
  }

  /** Once online, the session reconnects by itself until it succeeds, the reconnect policy stops it or the host calls `signOff`. */
  async signOn(credentials: Credentials, server: ServerAddress, opts: SignOnOptions = {}): Promise<'online' | 'cancelled'> {
    if (!isValidScreenName(credentials.screenName)) throw new OscarError({ kind: 'local', code: 'invalid-screen-name' });
    return this.signOnWith(bucpTicketSource({ ...this.signOnDeps, credentials, server }), server, opts);
  }

  /** As `signOn`, with the BOS ticket of every connect taken from `source`; services resolve against `server`. */
  async signOnWith(source: TicketSource, server: ServerAddress, opts: SignOnOptions = {}): Promise<'online' | 'cancelled'> {
    if (this.current !== 'offline') throw new OscarError({ kind: 'local', code: 'not-offline' });
    const attempt: Attempt = { cancelled: false, conns: [] };
    const session: Session = { source, server, profile: opts.profile ?? [] };
    const resume = opts.resume;
    const restoring = resume?.origin === 'restore';
    const away = restoring && resume.away?.away ? awayBody(resume.away.text) : null;
    if (restoring) {
      this.profiles.adoptAway(away);
      this.messaging.setAway(away);
      this.messaging.restoreAnswered(resume.answered);
    }
    const held: PreOnlinePlan = { invisible: resume?.invisible ?? false, reportIdle: resume?.reportIdle ?? false };
    this.attempt = attempt;
    this.session = session;
    this.awayRecords?.beginSession();
    this.setState('connecting');
    try {
      const listLoaded = (): void => {
        if (!attempt.cancelled) this.emit('buddyList', this.feedbag.buddyList());
      };
      const awayRecord: BringUp['awayRecord'] = { origin: resume?.origin ?? 'start', held: resume?.away ?? null };
      const up = await this.connect(attempt, session, listLoaded, { reconnect: false, held, restore: this.restoreOf(away, held.invisible), awayRecord });
      if (attempt.cancelled) return 'cancelled';
      this.goOnline(up);
      this.afterOnline(up.link);
      return 'online';
    } catch (error) {
      if (attempt.cancelled) return 'cancelled';
      const failed = this.failed(attempt, error, 'sign-on failed');
      this.goOffline(failed.failure);
      throw failed;
    }
  }

  async signOff(): Promise<void> {
    const attempt = this.attempt;
    const link = this.link;
    if ((this.current === 'connecting' && attempt) || this.current === 'reconnecting') {
      if (attempt) {
        attempt.cancelled = true;
        for (const conn of attempt.conns) conn.destroy();
      }
      this.goOffline();
    } else if (this.current === 'online' && link) {
      this.link = null;
      link.close();
      this.goOffline();
    }
  }

  /** Ends the BOS connection as a drop, which the reconnect policy hears as `{ kind: 'local' }`. Does nothing unless online. */
  dropConnection(): void {
    if (this.current === 'online') this.link?.destroy();
  }

  /**
   * Sends an IM and resolves when the server acknowledges it. An HTML body goes out as it is, and must only fit one frame.
   * With no options, the IM asks the server to store it, and it is not an auto-response.
   * With `store: 'when-offline'`, error 0x0004 causes a second send with the store TLV, and each send has its own wait for the acknowledgement.
   */
  async sendIm(to: string, body: ImBody, opts: SendImOptions = {}): Promise<SentIm> {
    const link = this.link;
    if (this.current !== 'online' || !link) throw new OscarError({ kind: 'not-signed-on' });
    requireRecipient(to);
    return this.messaging.send(link, to, body, this.imLimit(), opts);
  }

  async sendTyping(to: string, event: TypingEvent): Promise<void> {
    const link = this.onlineLink();
    requireRecipient(to);
    return this.messaging.sendTyping(link, to, event);
  }

  async warn(screenName: string): Promise<{ level: number }> {
    const link = this.onlineLink();
    requireRecipient(screenName);
    return this.messaging.warn(link, screenName);
  }

  holdAutoResponse(screenName: string): void {
    this.messaging.hold(screenName);
  }

  releaseAutoResponse(screenName: string, answer: boolean): void {
    this.messaging.release(this.current === 'online' ? this.link : null, screenName, answer);
  }

  /** The normalised names answered in this away period. */
  answeredSenders(): string[] {
    return this.messaging.answeredSenders();
  }

  /** Counts a sender as answered, as when another instance answered it. Away ending or beginning clears every such mark. */
  markAnswered(screenName: string): void {
    this.messaging.markAnswered(screenName);
  }

  canWarn(screenName: string): boolean {
    return this.messaging.canWarn(screenName);
  }

  // List writes change the list, and emit `buddyList`, only once the server has confirmed them.

  async addBuddy(input: { screenName: string; groupId: number; alias: string | null }): Promise<void> {
    return this.feedbag.addBuddy(this.listLink(), input);
  }

  async removeBuddy(ref: BuddyRef): Promise<void> {
    return this.feedbag.removeBuddy(this.listLink(), ref);
  }

  async moveBuddy(ref: BuddyRef, toGroupId: number): Promise<void> {
    return this.feedbag.moveBuddy(this.listLink(), ref, toGroupId);
  }

  async setAlias(ref: BuddyRef, alias: string | null): Promise<void> {
    return this.feedbag.setAlias(this.listLink(), ref, alias);
  }

  async addGroup(name: string): Promise<number> {
    return this.feedbag.addGroup(this.listLink(), name);
  }

  async renameGroup(groupId: number, name: string): Promise<void> {
    return this.feedbag.renameGroup(this.listLink(), groupId, name);
  }

  async deleteGroup(groupId: number): Promise<void> {
    return this.feedbag.deleteGroup(this.listLink(), groupId);
  }

  async block(screenName: string, options: { convert?: boolean } = {}): Promise<{ alsoBlocked: number }> {
    return this.feedbag.block(this.listLink(), screenName, this.ownScreenName(), options);
  }

  async unblock(screenName: string, options: { convert?: boolean } = {}): Promise<void> {
    return this.feedbag.unblock(this.listLink(), screenName, options);
  }

  async setPrivacyMode(mode: Exclude<PrivacyMode, 'unknown'>): Promise<void> {
    return this.feedbag.setPrivacyMode(this.listLink(), mode);
  }

  async setAcceptNonListIcons(on: boolean): Promise<void> {
    return this.feedbag.setAcceptNonListIcons(this.listLink(), on);
  }

  async allow(screenName: string): Promise<void> {
    return this.feedbag.allow(this.listLink(), screenName, this.ownScreenName());
  }

  async disallow(screenName: string): Promise<void> {
    return this.feedbag.disallow(this.listLink(), screenName);
  }

  async addBlocked(screenName: string, options: { fromServer?: boolean } = {}): Promise<void> {
    return this.feedbag.addBlocked(this.listLink(), screenName, this.ownScreenName(), options.fromServer === true);
  }

  async removeBlocked(screenName: string): Promise<void> {
    return this.feedbag.removeBlocked(this.listLink(), screenName);
  }

  /**
   * Asks `sessionBuddies` again. It sends the names added in 0x03/0x04 and the names removed in 0x03/0x05.
   * It forgets the presence of each name removed. It resolves when the client writes the changes.
   * Offline it rejects `not-signed-on`. Without `sessionBuddies` it resolves and sends nothing.
   */
  async refreshSessionBuddies(): Promise<void> {
    const link = this.onlineLink();
    const before = this.watched;
    if (!before) return;
    const next = this.sessionNames();
    const added = [...next].filter((name) => !before.has(name));
    const removed = [...before].filter((name) => !next.has(name));
    this.watched = next;
    for (const name of removed) this.presence.forget(name);
    if (added.length > 0) await link.send(FAMILY_BUDDY, BUDDY_ADD_BUDDIES, encodeNameList(added));
    if (removed.length > 0) await link.send(FAMILY_BUDDY, BUDDY_DEL_BUDDIES, encodeNameList(removed));
  }

  /**
   * With the `awayRecord` option, writes the plain text to Locate, then the record with `source`, by default the option's.
   * An HTML body goes to Locate as it is, and `awayMessage` then holds the text of that HTML. An HTML body cannot go with `awayRecord`.
   */
  async setAway(message: ImBody | null, opts: { source?: string } = {}): Promise<void> {
    const link = this.onlineLink();
    if (!this.awayRecords) return this.writeAway(link, message);
    if (message !== null && isHtmlBody(message)) throw new OscarError({ kind: 'local', code: 'invalid-argument' });
    return this.awayRecords.ownChange(link, message, opts.source);
  }

  async setProfile(profile: RichText): Promise<void> {
    const session = this.session;
    await this.profiles.setProfile(this.onlineLink(), profile, this.awayAndProfileLimit());
    if (session) session.profile = profile;
  }

  async getInfo(screenName: string): Promise<UserInfoResult> {
    const link = this.onlineLink();
    requireRecipient(screenName);
    return this.profiles.getInfo(link, screenName);
  }

  // Search and the keyword list go over an ODir connection opened at first use. They reject with `NoDirectoryError`
  // once the server refused it; the listing and interests go over BOS.
  directoryAvailable(): boolean | null {
    return this.directory.available();
  }

  async directoryKeywords(): Promise<KeywordGroup[]> {
    const { link, server } = this.adminContext();
    return this.directory.keywords(link, server);
  }

  async findByName(first: string, last: string): Promise<DirResult[]> {
    const { link, server } = this.adminContext();
    return this.directory.searchByName(link, server, first, last);
  }

  async findByInterest(keyword: string): Promise<DirResult[]> {
    const { link, server } = this.adminContext();
    return this.directory.searchByInterest(link, server, keyword);
  }

  async ownListing(): Promise<DirListing> {
    const link = this.onlineLink();
    return this.directory.ownListing(link, this.ownScreenName());
  }

  async setListing(listing: DirListing): Promise<void> {
    return this.directory.setListing(this.onlineLink(), listing);
  }

  async setInterests(interests: readonly string[]): Promise<void> {
    return this.directory.setInterests(this.onlineLink(), interests);
  }

  async fetchAway(screenName: string): Promise<void> {
    const link = this.link;
    if (this.current !== 'online' || !link) return;
    return this.profiles.fetchAway(link, screenName);
  }

  /**
   * Turns file transfer, Direct IM and Get File on or off. A key that is not given changes nothing.
   * True for a service whose option the client did not get throws a `RangeError`.
   * While a service is off, the client ignores its offers and refuses to start one, as without its option. A session or transfer that runs goes on.
   * Offline, the next connect writes the capabilities. Online, one Locate write holds only the capabilities, and the result resolves when it is written.
   */
  setServices(on: ServiceSwitch): Promise<void> {
    for (const key of SERVICE_KEYS) {
      const value = on[key];
      if (value !== undefined && typeof value !== 'boolean') throw new RangeError(`${key} must be a boolean`);
      if (value === true && !this.given[key]) throw new RangeError(`${key} has no option`);
    }
    for (const key of SERVICE_KEYS) this.switched[key] = on[key] ?? this.switched[key];
    const link = this.link;
    if (this.current !== 'online' || !link) return Promise.resolve();
    return this.signOnService.writeCapabilities(link);
  }

  /** Which services are on now. */
  services(): Required<ServiceSwitch> {
    return { ...this.switched };
  }

  async setInvisible(on: boolean): Promise<void> {
    return this.signOnService.setInvisible(this.onlineLink(), on);
  }

  async queryUserInfo(): Promise<UserInfoSnapshot> {
    return this.signOnService.queryUserInfo(this.onlineLink());
  }

  setIdleAfter(seconds: number | null): void {
    this.idleAfterSeconds = seconds;
  }

  async reportIdle(seconds: number): Promise<void> {
    const link = this.onlineLink();
    // The wire field is 32 bits of whole seconds.
    if (!Number.isInteger(seconds) || seconds < 0 || seconds > 0xffff_ffff) throw new OscarError({ kind: 'local', code: 'invalid-argument' });
    return this.signOnService.reportIdle(link, seconds);
  }

  async joinRoom(room: RoomId): Promise<RoomStatus> {
    return this.roomService.join(this.roomsContext(), room);
  }

  async leaveRoom(roomId: string): Promise<void> {
    this.roomService.leave(roomId);
  }

  /** Resolves when the room echoes the line. An HTML body goes out as it is. `id` is the id of the line. */
  async sendRoomMessage(roomId: string, body: ImBody, opts: { whisperTo?: string } = {}): Promise<{ replacedBy: RichText | null; id: string }> {
    this.onlineLink();
    return this.roomService.send(roomId, body, opts);
  }

  async inviteToRoom(roomId: string, screenName: string): Promise<void> {
    const ctx = this.roomsContext();
    requireRecipient(screenName);
    return this.roomService.invite(ctx, roomId, screenName);
  }

  async declineInvite(inviteId: string): Promise<void> {
    return this.roomService.declineInvite(this.roomsContext(), inviteId);
  }

  /** Resolves to the id of the transfer. */
  async sendFiles(screenName: string, files: readonly OutgoingFile[]): Promise<string> {
    this.onlineLink();
    requireRecipient(screenName);
    return this.transfers.sendFiles(screenName, files);
  }

  /** The `transfer` events tell how the transfer goes. It rejects for an offer that does not wait for an answer. */
  async acceptFileOffer(id: string, sink: FileSink): Promise<void> {
    this.onlineLink();
    this.transfers.accept(id, sink);
  }

  async declineFileOffer(id: string): Promise<void> {
    this.onlineLink();
    return this.transfers.decline(id);
  }

  /** Ends a transfer in each state. An offer that waits for an answer is declined. A file of a browse that has its turn ends the browse too. */
  async cancelTransfer(id: string): Promise<void> {
    this.onlineLink();
    if (this.getFile.cancelTransfer(id)) return;
    return this.transfers.cancel(id);
  }

  /** Resolves to the id of the session. For a peer with a session that is live, it is the id of that session and nothing is sent. */
  async openDirectIm(screenName: string): Promise<string> {
    this.onlineLink();
    requireRecipient(screenName);
    return this.directIm.open(screenName);
  }

  /** The `directIm` events tell how the session goes. It rejects for an offer that does not wait for an answer. */
  async acceptDirectIm(id: string): Promise<void> {
    this.onlineLink();
    this.directIm.accept(id);
  }

  async declineDirectIm(id: string): Promise<void> {
    this.onlineLink();
    return this.directIm.decline(id);
  }

  /** Ends a session in each state. An offer that waits for an answer is declined. */
  async closeDirectIm(id: string): Promise<void> {
    this.onlineLink();
    return this.directIm.close(id);
  }

  /** Resolves when the message is written. It rejects with `OdcError` when the connection ends first. */
  async sendDirectMessage(id: string, message: OutgoingDirectMessage): Promise<void> {
    this.onlineLink();
    return this.directIm.sendMessage(id, message);
  }

  /**
   * Resolves to the id of the browse. For a peer with a browse that is live, it is the id of that browse.
   * One `fileListing` event comes when the browse opens. It holds each file of the whole shared folder.
   */
  async browseFiles(screenName: string): Promise<string> {
    this.onlineLink();
    requireRecipient(screenName);
    return this.getFile.browse(screenName);
  }

  /**
   * Resolves to the id of the transfer. The `transfer` events tell how it goes, and one can come before the id.
   * A path that the listing of the browse did not name fails with `file-problem`, and nothing is sent.
   * A holder that does not have the file closes the connection: the transfer fails with `file-problem` and the browse ends `not-there`.
   */
  async takeFile(browseId: string, path: readonly string[], sink: FileSink): Promise<string> {
    this.onlineLink();
    return this.getFile.take(browseId, path, sink);
  }

  /** Ends a browse in each state. It ignores an id that is not live. */
  async closeBrowse(browseId: string): Promise<void> {
    this.onlineLink();
    return this.getFile.close(browseId);
  }

  /**
   * Shares the files of the source until sign-off. Null stops the sharing, and each request is then declined.
   * A source that is not the source in use closes each connection of a requester. Nothing is written to the server.
   */
  async shareFiles(source: SharedSource | null): Promise<void> {
    this.onlineLink();
    this.getFile.share(source);
  }

  /** Lets the requester of a `shareRequest` connect. The `share` events tell how it goes. It rejects for a request that does not wait for an answer. */
  async allowShare(requestId: string): Promise<void> {
    this.onlineLink();
    this.getFile.allow(requestId);
  }

  /** Ends a share in each state. A request that waits for an answer is declined. It ignores an id that is not live. */
  async refuseShare(requestId: string): Promise<void> {
    this.onlineLink();
    return this.getFile.refuse(requestId);
  }

  forgetInvite(inviteId: string): void {
    this.roomService.forgetInvite(inviteId);
  }

  rooms(): RoomStatus[] {
    return this.roomService.list();
  }

  iconOf(screenName: string): string | null {
    return this.icons.iconOf(screenName);
  }

  /** It takes effect at once and holds across reconnects until the next call. */
  setIconsFrom(from: IconsFrom): void {
    this.iconsFrom = from;
  }

  async discardIcon(hash: string): Promise<void> {
    return this.icons.discard(hash);
  }

  /**
   * Sets the icon of the account: a GIF or JPEG that fits the limits of `isOwnIcon`, or the call rejects with `invalid-argument`.
   * The client writes the MD5 to the icon item of the server's list and sends the bytes only if the server asks for them.
   * The server keeps the icon across connections, so one call is enough. A second call with the same bytes sends no bytes.
   * A call during a different call rejects with `busy`. If the server refuses the write, the call rejects with a `ListWriteError`.
   * If the upload fails, the client writes the previous icon back to the item and the call rejects.
   * If the connection ends during the call, the call rejects and the client writes the previous icon back on the next connection.
   *
   * With `sessionBuddies`, each call first reads the server's list one time (0x13/0x04) to find the icon item.
   * The client updates that item with the id it has. If there is no such item, the client adds one with an id that no other item has.
   * The client changes no other item and keeps no copy of the list after the call: `buddyList` stays empty and no `buddyList` event occurs.
   * If the server refuses the read, the call rejects with that refusal and the client writes nothing.
   */
  async setOwnIcon(bytes: Uint8Array): Promise<void> {
    const link = this.onlineLink();
    const self = this.ownScreenName();
    return this.withIconList(link, (list) => this.icons.setOwn(link, list, self, bytes));
  }

  /**
   * Removes the icon of the account: the client writes the hash of no icon to the icon item and does not delete the item.
   * If the list has no icon item, the client writes nothing and the call resolves.
   * With `sessionBuddies`, each call first reads the server's list one time, as `setOwnIcon` does.
   */
  async clearOwnIcon(): Promise<void> {
    const link = this.onlineLink();
    const self = this.ownScreenName();
    return this.withIconList(link, (list) => this.icons.clearOwn(link, list, self));
  }

  async formatScreenName(name: string): Promise<string> {
    const { link, server } = this.adminContext();
    return this.account.format(link, server, name, this.signOnDeps.pinRedirects);
  }

  async accountEmail(): Promise<string | null> {
    const { link, server } = this.adminContext();
    return this.account.email(link, server, this.signOnDeps.pinRedirects);
  }

  /** Asks BOS for `family`'s service, connects to it with the cookie, waits for its host online and closes it again. */
  async probeService(family: number): Promise<{ host: string; port: number; pinned: boolean }> {
    const { link, server } = this.adminContext();
    const opened: OscarConnection[] = [];
    let over = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_resolve, reject) => {
      deadline = this.timers.setTimeout(() => reject(new OscarError({ kind: 'timeout', rateLimited: false })), SERVICE_PROBE_TIMEOUT_MS);
    });
    const probe = (async () => {
      const { log, now, timers, limits, pinRedirects: pin, tls, followRedirects: follow } = this.signOnDeps;
      const grant = await serviceResolver(link, server, this.now, { pin, tls, follow })(family);
      const conn = await openConnection({ host: grant.host, port: grant.port, cookie: grant.cookie, ...connectionTls(tls), label: 'probe', log, now, timers, ...limits });
      opened.push(conn);
      if (over) {
        conn.close();
        throw new OscarError({ kind: 'timeout', rateLimited: false });
      }
      await new Promise<void>((resolve, reject) => {
        conn.onSnac((snac) => {
          if (snac.family === FAMILY_OSERVICE && snac.subtype === OSERVICE_HOST_ONLINE) resolve();
        });
        conn.onClose(() => reject(new OscarError({ kind: 'connection-lost' })));
      });
      return { host: grant.host, port: grant.port, pinned: grant.pinned };
    })();
    // The probe can lose the race and still run; its late failure is nobody's to hear.
    probe.catch(() => {});
    expired.catch(() => {});
    try {
      return await Promise.race([probe, expired]);
    } catch (error) {
      throw probeFailure(error);
    } finally {
      over = true;
      if (deadline !== undefined) this.timers.clearTimeout(deadline);
      for (const conn of opened) conn.close();
    }
  }

  private ownScreenName(): string {
    const self = this.signOnService.self;
    if (!self) throw new OscarError({ kind: 'not-signed-on' });
    return self.screenName;
  }

  private async writeAway(link: BosLink, message: ImBody | null, limit = this.awayAndProfileLimit()): Promise<void> {
    await this.profiles.setAway(link, message, limit);
    this.messaging.setAway(this.profiles.awayMessage);
  }

  private listChanged(): void {
    this.emit('buddyList', this.feedbag.buddyList());
    const link = this.current === 'online' ? this.link : null;
    if (link) this.awayRecords?.listChanged(link);
  }

  private imLimit(): number {
    return this.sessionLimits?.imBytes ?? IM_FALLBACK_LIMIT_BYTES;
  }

  private awayAndProfileLimit(): number {
    return this.sessionLimits?.awayAndProfileBytes ?? AWAY_AND_PROFILE_FALLBACK_BYTES;
  }

  private isBuddy(name: string): boolean {
    if (this.watched) return this.watched.has(name);
    return this.feedbag.buddyList().groups.some((group) => group.buddies.some((buddy) => normalizeScreenName(buddy.screenName) === name));
  }

  // The link for a write to the server's list.
  private listLink(): BosLink {
    if (this.watched) throw new OscarError({ kind: 'local', code: 'invalid-argument' });
    return this.onlineLink();
  }

  // The list for a write of the icon item. With `sessionBuddies` it is a function that reads a copy of the server's list.
  private withIconList<T>(link: BosLink, run: (list: IconList) => Promise<T>): Promise<T> {
    return this.iconList ? this.iconList.during(link, run) : run(this.feedbag);
  }

  // What `sessionBuddies` gives, normalised, each name one time. It leaves out an empty name and a name longer than 255 bytes.
  private sessionNames(): Set<string> {
    const names = new Set<string>();
    for (const name of this.signOnDeps.sessionBuddies?.() ?? []) {
      const key = normalizeScreenName(name);
      if (key !== '' && utf8ByteLength(key) <= MAX_RECIPIENT_BYTES) names.add(key);
    }
    return names;
  }

  private onlineLink(): BosLink {
    const link = this.link;
    if (this.current !== 'online' || !link) throw new OscarError({ kind: 'not-signed-on' });
    return link;
  }

  private roomsContext(): RoomsContext {
    const ctx = this.currentRoomsContext();
    if (!ctx) throw new OscarError({ kind: 'not-signed-on' });
    return ctx;
  }

  private currentRoomsContext(): RoomsContext | null {
    const { link, session } = this;
    const self = this.signOnService.self;
    if (this.current !== 'online' || !link || !session || !self) return null;
    return { link, server: session.server, self: self.screenName, pin: this.signOnDeps.pinRedirects };
  }

  private async siblings(): Promise<Siblings> {
    if ((this.negotiatedOserviceVersion ?? 0) < OSERVICE_MULTI_INSTANCE_VERSION) return { known: false };
    try {
      const { instances } = await this.queryUserInfo();
      return { known: true, others: Math.max(0, instances.length - 1) };
    } catch (error) {
      this.log.debug('could not ask for the other instances', { error: error instanceof Error ? error.name : typeof error });
      return { known: false };
    }
  }

  private async afterRoomClosed(room: RoomStatus, close: CloseInfo['kind']): Promise<'rejoin' | 'stay'> {
    const input = { room, close, siblings: () => this.siblings() };
    try {
      return (await this.rejoinPolicy.afterRoomClosed(input)) === 'rejoin' ? 'rejoin' : 'stay';
    } catch (error) {
      this.rejoinPolicyFailed('afterRoomClosed', error);
      return DESKTOP_REJOIN.afterRoomClosed(input);
    }
  }

  private async rejoinRooms(link: BosLink, absentMs: number): Promise<void> {
    const rooms = this.roomService.list().filter((room) => room.state === 'rejoining');
    if (rooms.length === 0) return;
    const input = { rooms, absentMs, siblings: () => this.siblings() };
    let ids: ReadonlySet<string>;
    try {
      ids = new Set(await this.rejoinPolicy.afterReconnect(input));
    } catch (error) {
      this.rejoinPolicyFailed('afterReconnect', error);
      ids = new Set(await DESKTOP_REJOIN.afterReconnect(input));
    }
    const ctx = this.link === link ? this.currentRoomsContext() : null;
    if (ctx) this.roomService.rejoin(ctx, ids);
  }

  private rejoinPolicyFailed(hook: 'afterReconnect' | 'afterRoomClosed', error: unknown): void {
    this.log.warn('the rejoin policy failed', { hook, error: error instanceof Error ? error.name : typeof error });
  }

  private excluded(name: string): boolean {
    const { groups, privacy } = this.feedbag.buddyList();
    return excludedSender({ groups, privacy, self: this.signOnService.self?.screenName ?? null }, name, false);
  }

  // Resolves when the proposal is written. The server answers only a proposal that it cannot give to the peer.
  private propose(body: Uint8Array, refused: () => void): Promise<void> {
    return new Promise((written, failed) => {
      const error = (snac: Snac): boolean => snac.family === FAMILY_ICBM && snac.subtype === ICBM_ERR;
      let link: BosLink;
      try {
        link = this.onlineLink();
      } catch (cause) {
        failed(cause);
        return;
      }
      // No answer in this time is no error.
      link.requestMatching(FAMILY_ICBM, ICBM_MSG_TO_HOST, body, PROPOSAL_ERROR_MS, error, { onWritten: written }).then(refused, failed);
    });
  }

  // The parts end what they hold first. Then the offers end and each connection closes.
  private resetOffers(): void {
    this.transfers.reset();
    this.directIm.reset();
    this.getFile.reset();
    this.rendezvous.reset();
  }

  // The answer is no when the session has no server to compare the address with.
  private async mayDial(rule: FileTransferOptions['allowDial'], address: PeerAddress): Promise<boolean> {
    const { session, issued } = this;
    if (this.current !== 'online' || !session || !issued) return false;
    if (!rule) return true;
    return rule(address, { server: session.server, bos: { host: issued.ticket.host, port: issued.ticket.port } });
  }

  private adminContext(): { link: BosLink; server: ServerAddress } {
    const link = this.onlineLink();
    const session = this.session;
    if (!session) throw new OscarError({ kind: 'not-signed-on' });
    return { link, server: session.server };
  }

  private sawRoomUser(info: UserInfo): void {
    if (this.iconsFrom === 'everyone' && this.current === 'online' && this.link) this.icons.seenUser(this.link, info);
  }

  private dispatch(link: BosLink, snac: Snac): void {
    try {
      this.offer(link, snac);
    } catch (error) {
      this.skipped(snac, 'skipped a SNAC that could not be handled', error);
    }
    try {
      this.icons.see(link, snac);
    } catch (error) {
      this.skipped(snac, 'skipped a SNAC whose icon could not be read', error);
    }
  }

  private skipped(snac: Snac, what: string, error: unknown): void {
    this.skips.add(skippedSender(snac));
    this.log.warn(what, { family: snac.family, subtype: snac.subtype, error: (error as Error).message });
  }

  private offer(link: BosLink, snac: Snac): void {
    if (this.signOnService.handle(snac)) return;
    if (this.presence.handle(snac)) return;
    this.iconList?.handle(snac);
    if (this.feedbag.handle(snac)) return;
    if (this.transfers.handle(snac)) return;
    if (this.directIm.handle(snac)) return;
    if (this.getFile.handle(snac)) return;
    if (this.roomService.handle(snac)) return;
    if (snac.family === FAMILY_POPUP && snac.subtype === POPUP_DISPLAY) {
      const popup = decodePopup(snac.body, this.legacyCharset);
      if (popup) {
        const { html, ...notice } = popup;
        this.emit('popup', { ...notice, body: parseAimHtml(html) });
      } else this.log.warn('skipped a popup with no message');
      return;
    }
    this.messaging.handle(link, snac);
  }

  private restoreOf(away: RichText | null, invisible: boolean): Restore {
    return { away, invisible, systemIdleSeconds: this.systemIdleSeconds, idleAfterSeconds: this.idleAfterSeconds };
  }

  private async connect(attempt: Attempt, session: Session, listLoaded: () => void, bring: BringUp): Promise<Up> {
    const track = (conn: OscarConnection): void => {
      if (attempt.cancelled) conn.destroy();
      else attempt.conns.push(conn);
    };
    let bosClose = null as CloseInfo | null;
    let hostOnline = false;
    let userInfo = null as UserInfoSnapshot | null;
    const records = this.awayRecords;
    try {
      const issued = await session.source.ticket({ reconnect: bring.reconnect, track });
      const conn = await this.signOnService.openBos(issued.ticket, track);
      // No await between here and bringUp's first wait: host online must find its listener.
      const link = new BosLink(conn, {
        now: this.now,
        timers: this.timers,
        log: this.log,
        classQueueMax: this.hosting.classQueueMax,
        skipProbeWhileRateHeld: this.hosting.skipProbeWhileRateHeld,
        paceMarginMs: this.paceMarginMs,
      });
      link.onSnac((snac) => {
        if (snac.family === FAMILY_OSERVICE && snac.subtype === OSERVICE_HOST_ONLINE) hostOnline = true;
        this.dispatch(link, snac);
      });
      link.onClose((info) => {
        bosClose = info;
        this.onBosClosed(link, info);
      });
      link.onRateChange((classId, limited) => {
        if (classId === link.classOf(FAMILY_ICBM, ICBM_MSG_TO_HOST)) this.emitRate(limited);
      });
      const ownList = this.watched !== null;
      const hooks = {
        loadFeedbag: async () => {
          if (ownList) await this.watch(link);
          else await this.feedbag.load(link);
          listLoaded();
        },
        // The name list, also an empty one, makes the server announce the account as the activation does.
        useFeedbag: () => (ownList ? Promise.resolve() : this.feedbag.use(link)),
        hostOnline: (families: number[]) =>
          this.icons.connected({ onBos: families.includes(BART_FOOD_GROUP), server: session.server, pin: this.signOnDeps.pinRedirects }),
        preOnline: (info: UserInfoSnapshot | null) => {
          userInfo = info;
          return this.preOnline({ reconnect: bring.reconnect, userInfo: info, held: bring.held });
        },
        awayWrite: records ? (limits: { awayAndProfileBytes: number }) => records.preOnline(link, { ...bring.awayRecord, userInfo, limits }) : undefined,
      };
      const up = await this.signOnService.bringUp(link, hooks, session.profile, bring.restore);
      // A sign-off read with the last reply closes the connection before this line runs, and no close follows it.
      if (!attempt.cancelled && !conn.isOpen) throw new OscarError({ kind: 'connection-lost' });
      if (this.signOnDeps.botFlagExempt === true && (up.userFlags & USER_FLAG_BOT) !== 0) link.setExempt(true);
      const limits = { imBytes: up.imBytes, awayAndProfileBytes: up.awayAndProfileBytes, ...this.feedbag.limits };
      return { link, limits, oserviceVersion: up.oserviceVersion, issued };
    } catch (error) {
      throw connectFailure(error, bosClose, hostOnline);
    }
  }

  private async watch(link: BosLink): Promise<void> {
    const names = this.sessionNames();
    this.watched = names;
    await link.send(FAMILY_BUDDY, BUDDY_ADD_BUDDIES, encodeNameList([...names]));
  }

  private failed(attempt: Attempt, error: unknown, what: string): Evidenced {
    for (const conn of attempt.conns) conn.destroy();
    const failed = connectFailure(error, null, false);
    // The cause of a sign-on error from the client or a ticket source is detail. Only the cause of an unknown error can be a defect.
    const cause = unknownFailures.has(failed) ? (failed.cause ?? failed) : failed;
    this.log.warn(what, { ...failed.failure, evidence: failed.evidence.kind, cause: cause instanceof Error ? cause.message : String(cause) });
    if (!isExpectedFailure(cause)) this.guard(cause, { kind: 'sign-on' });
    return failed;
  }

  private goOnline(up: Up): void {
    this.attempt = null;
    this.reconnect = null;
    this.link = up.link;
    this.sessionLimits = up.limits;
    this.negotiatedOserviceVersion = up.oserviceVersion;
    this.issued = up.issued;
    this.onlineAt = this.now();
    this.emit('ticket', up.issued);
    this.setState('online');
  }

  private afterOnline(link: BosLink): void {
    if (this.link !== link) return;
    // A change during the connect can come after its Locate write.
    if (this.signOnService.capabilitiesChanged) {
      void this.signOnService.writeCapabilities(link).catch((error: unknown) => {
        this.log.warn('the capabilities were not written', { error: error instanceof Error ? error.name : typeof error });
      });
    }
    this.awayRecords?.afterOnline(link);
    if (!this.watched) this.feedbag.ensureTypingPref(link);
    const self = this.signOnService.self;
    if (self) this.spawn('resume-icons', () => this.withIconList(link, (list) => this.icons.resume(link, list, self.screenName)));
    this.spawn('retrieve-offline', () => this.messaging.retrieveOffline(link));
  }

  // A stop ends the session at once, with no reconnecting state.
  private onBosClosed(link: BosLink, info: CloseInfo): void {
    if (this.link !== link || this.current !== 'online') return;
    this.resetOffers();
    const evidence = dropEvidence(info, true);
    const decision = this.decide({ phase: 'drop', evidence, attempt: 1, onlineAt: this.onlineAt, now: this.now() });
    if (!decision.retry) {
      this.log.warn('the session ended', { ...decision.reason, evidence: evidence.kind, close: info.kind });
      this.goOffline(decision.reason);
      return;
    }
    this.log.warn('the connection dropped', { close: info.kind });
    this.link = null;
    this.negotiatedOserviceVersion = null;
    const reconnect: Reconnect = { failures: 1, invisible: this.signOnService.self?.invisible ?? false, droppedAt: this.now(), timer: null };
    this.reconnect = reconnect;
    this.current = 'reconnecting';
    this.forgetConnection();
    if (this.reconnect !== reconnect) return;
    this.scheduleRetry(reconnect, decision.delayMs);
    if (this.reconnect !== reconnect) return;
    this.roomService.bosLost();
  }

  private decide(input: Parameters<ReconnectPolicy['next']>[0]): ReconnectDecision {
    try {
      return this.policy.next(input);
    } catch (error) {
      this.log.warn('the reconnect policy threw', {
        phase: input.phase,
        evidence: input.evidence.kind,
        error: error instanceof Error ? error.message : String(error),
      });
      return { retry: false, reason: { kind: 'unreachable' } };
    }
  }

  private forgetConnection(): void {
    this.resetOffers();
    this.presence.reset();
    this.profiles.forgetBuddies();
    this.signOnService.dropped();
    this.icons.bosLost();
    this.account.bosLost();
    this.directory.bosLost();
    if (this.imLimited) this.emitRate(false);
  }

  private scheduleRetry(reconnect: Reconnect, delayMs: number): void {
    const nextRetryAt = this.now() + delayMs;
    reconnect.timer = this.timers.setTimeout(() => {
      reconnect.timer = null;
      this.spawn('reconnect', () => this.retry(reconnect));
    }, delayMs);
    this.current = 'reconnecting';
    this.emit('state', { state: 'reconnecting', reconnect: { attempt: reconnect.failures, nextRetryAt } });
  }

  // A BUCP source takes from the sign-on budget like any sign-on, so the attempt can start later than planned.
  private async retry(reconnect: Reconnect): Promise<void> {
    const session = this.session;
    if (this.reconnect !== reconnect || !session) return;
    const attempt: Attempt = { cancelled: false, conns: [] };
    this.attempt = attempt;
    const held: PreOnlinePlan = { invisible: reconnect.invisible, reportIdle: this.signOnService.idleReported };
    try {
      const awayRecord: BringUp['awayRecord'] = { origin: 'restore', held: this.awayRecords?.held ?? null };
      const restore = this.restoreOf(this.profiles.awayMessage, held.invisible);
      const up = await this.connect(attempt, session, () => {}, { reconnect: true, held, restore, awayRecord });
      if (attempt.cancelled) return;
      this.goOnline(up);
      if (this.link === up.link) this.emit('buddyList', this.feedbag.buddyList());
      this.afterOnline(up.link);
      if (this.link === up.link) {
        const absentMs = this.onlineAt - reconnect.droppedAt;
        this.spawn('rejoin', () => this.rejoinRooms(up.link, absentMs));
      }
    } catch (error) {
      if (attempt.cancelled) return;
      const { evidence } = this.failed(attempt, error, 'reconnect attempt failed');
      this.attempt = null;
      this.forgetConnection();
      if (this.reconnect !== reconnect) return;
      const decision = this.decide({ phase: 'attempt', evidence, attempt: reconnect.failures + 1, onlineAt: this.onlineAt, now: this.now() });
      if (!decision.retry) {
        this.log.warn('the session ended', { ...decision.reason, evidence: evidence.kind });
        this.goOffline(decision.reason);
        return;
      }
      reconnect.failures++;
      this.scheduleRetry(reconnect, decision.delayMs);
    }
  }

  private goOffline(reason?: SignOffReason): void {
    const timer = this.reconnect?.timer ?? null;
    if (timer !== null) this.timers.clearTimeout(timer);
    this.reconnect = null;
    this.attempt = null;
    this.session = null;
    this.link = null;
    this.sessionLimits = null;
    this.negotiatedOserviceVersion = null;
    if (this.watched) this.watched = new Set();
    this.feedbag.reset();
    this.presence.reset();
    this.profiles.reset();
    this.messaging.reset();
    this.roomService.reset();
    this.resetOffers();
    // The next sign-on, of this name or another, shares nothing.
    this.getFile.forget();
    this.signOnService.reset();
    this.icons.reset();
    this.account.reset();
    this.directory.close();
    this.awayRecords?.reset();
    if (this.imLimited) this.emitRate(false);
    this.setState('offline', reason);
  }

  private emitRate(limited: boolean): void {
    this.imLimited = limited;
    this.emit('rate', { limited });
  }

  private setState(state: SessionState, reason?: SignOffReason): void {
    this.current = state;
    this.emit('state', reason ? { state, reason } : { state });
  }

  private emit<E extends keyof OscarClientEvents>(event: E, payload: OscarClientEvents[E]): void {
    const set: Set<(payload: OscarClientEvents[E]) => void> = this.listeners[event];
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (error) {
        this.guard(error, { kind: 'listener', event });
      }
    }
  }

  private defaultGuard(error: unknown, site: GuardSite): void {
    if (site.kind === 'listener') this.log.warn('a listener threw', { event: site.event, error: error instanceof Error ? error.name : typeof error });
    else if (site.kind !== 'sign-on') throw error;
  }

  private spawn(task: string, run: () => Promise<unknown>): void {
    void run().catch((error: unknown) => this.guard(error, { kind: 'task', task }));
  }
}

function paceMargin(ms: number | undefined): number | undefined {
  if (ms !== undefined && !(Number.isFinite(ms) && ms >= 0)) throw new RangeError(`paceMarginMs ${ms} is not a number of 0 or more`);
  return ms;
}

function roomLimit(max: number | undefined): number {
  if (max === undefined) return MAX_ROOMS;
  if (!Number.isInteger(max) || max < 1) throw new RangeError(`maxRooms ${max} is not an integer of 1 or more`);
  return max;
}

// The sign-on errors that connectFailure made from an error of another class.
const unknownFailures = new WeakSet<SignOnError>();

// A sign-off that ends the session or meets the cap outweighs a refusal read before it; any other close does not.
function connectFailure(error: unknown, close: CloseInfo | null, hostOnline: boolean): Evidenced {
  if (error instanceof SignOnError) {
    if (error.evidence) return error as Evidenced;
    const { failure } = error;
    const evidence: DropEvidence = failure.kind === 'unreachable' ? { kind: 'unreachable' } : { kind: 'refused', failure };
    return new SignOnError(failure, evidence, error.cause === undefined ? undefined : { cause: error.cause }) as Evidenced;
  }
  const step: SignOnFailure | null = error instanceof OscarError && error.info.kind === 'refused' ? { kind: 'refused', code: error.info.code } : null;
  const dropped = close === null ? null : dropEvidence(close, hostOnline);
  const ends = dropped?.kind === 'signed-off' || dropped?.kind === 'session-cap';
  const evidence: DropEvidence = step && !ends ? { kind: 'refused', failure: step } : (dropped ?? { kind: 'unreachable' });
  const failure: SignOnFailure = dropped?.kind === 'session-cap' ? { kind: 'too-many-sessions' } : (step ?? { kind: 'unreachable' });
  const failed = new SignOnError(failure, evidence, { cause: error }) as Evidenced;
  unknownFailures.add(failed);
  return failed;
}

function isExpectedFailure(error: unknown): boolean {
  return (
    error instanceof OscarError ||
    error instanceof SignOnError ||
    error instanceof ConnectionClosedError ||
    error instanceof RequestTimeoutError ||
    error instanceof OscarDecodeError
  );
}

function requireRecipient(screenName: string): void {
  if (normalizeScreenName(screenName) === '' || utf8ByteLength(screenName) > MAX_RECIPIENT_BYTES) {
    throw new OscarError({ kind: 'local', code: 'invalid-screen-name' });
  }
}
