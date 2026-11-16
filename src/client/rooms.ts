import { requestService, resolveRoom } from '../wire/chatnav.js';
import type { RoomInfo } from '../wire/chatnav.js';
import { ChatRoom, newRoomCookie } from '../wire/chatroom.js';
import { openConnection } from '../wire/connection.js';
import type { CloseInfo, ConnectionLimits, OscarConnection } from '../wire/connection.js';
import {
  CAP_CHAT,
  FAMILY_CHAT,
  FAMILY_CHATNAV,
  FAMILY_ICBM,
  ICBM_CHANNEL_RENDEZVOUS,
  ICBM_HOST_ACK,
  ICBM_MSG_TO_CLIENT,
  ICBM_MSG_TO_HOST,
} from '../wire/constants.js';
import { decodeImToClient, encodeChatInvite, encodeChatInviteCancel, newCookie, parseInvite, parseInviteCancel } from '../wire/icbm.js';
import type { ChatInvite, ChatInviteCancel } from '../wire/icbm.js';
import { createRoomPacer } from '../wire/rate.js';
import { rendezvousCapability } from '../wire/rendezvous.js';
import type { Snac, UserInfo } from '../wire/snac.js';
import { isRollCommand, toAsciiEntities } from '../wire/text.js';
import { OscarRoomError, OscarSendError } from '../wire/types.js';
import type { Logger, ServiceGrant, SnacLink, TimerApi } from '../wire/types.js';
import type { RichText } from '../model/rich-text.js';
import { isHtmlBody } from '../model/wire-detail.js';
import type { ImBody } from '../model/wire-detail.js';
import { INVITE_TEXT, MAX_ROOMS, ROOM_MESSAGE_MAX_BYTES, isValidRoomName, roomConversationId, roomKey } from '../model/room.js';
import type { Invite, RoomId, RoomJoinFailure, RoomMessage, RoomOccupantChange, RoomRate, RoomStatus } from '../model/room.js';
import { normalizeScreenName } from '../model/screen-name.js';
import type { ImFailureReason } from '../model/session.js';
import { parseAimHtml, richTextToAimHtml } from './aim-html.js';
import type { BosLink } from './bos-link.js';
import { OscarError, RoomJoinError } from './errors.js';
import { isReplyTo, refusalOf } from './messaging.js';
import { serviceResolver } from './service.js';
import { strayRate } from './stray-rate.js';
import { connectionTls } from './connect-options.js';
import type { ServerAddress } from './sign-on.js';

export const INVITE_ACK_TIMEOUT_MS = 15_000;
/** The server ends room connections with the last BOS session (server/oscar/server.go OnSessionClose): either close can come first. */
export const ROOM_CLOSE_SETTLE_MS = 2_000;

/** Anyone can send an invite, and each needs an answer: past this many, Rooms drops a new one unanswered. */
export const MAX_PENDING_INVITES = 16;
export const INVITE_TEXT_MAX = 1024;

export type RoomsDeps = {
  log: Logger;
  now: () => number;
  timers: TimerApi;
  random: () => number;
  limits?: ConnectionLimits;
  spawn?(task: string, run: () => Promise<unknown>): void;
  emitRoom(status: RoomStatus): void;
  emitOccupant(change: RoomOccupantChange): void;
  emitMessage(message: RoomMessage): void;
  isBlocked(name: string): boolean;
  emitInvite(invite: Invite): void;
  emitDeclined(declined: { roomId: string; by: string }): void;
  bosAlive(): Promise<boolean>;
  /** Hears each user info a room connection carries. */
  sawUser(info: UserInfo): void;
  /** Asked when a closed room is about to become `disconnected`; it must not reject. Without it, the room does become so. */
  afterClosed?(room: RoomStatus, close: CloseInfo['kind']): Promise<'rejoin' | 'stay'>;
  /** The context of the online session, or null when there is none. */
  context?(): RoomsContext | null;
  /** Gets each change of the rate state of the send class of a room connection. */
  emitRate?(rate: RoomRate): void;
  /** Adds `wire`, the cookie and the HTML as they came, to each room line and invitation. The default is false. */
  wireDetail?: boolean;
  /** The most rooms joined at one time. The default is `MAX_ROOMS`. */
  maxRooms?: number;
  /** The pacing margin of each room connection. The default is `PACE_MARGIN_MS`. */
  paceMarginMs?: number | undefined;
  /** Opens the ChatNav and Chat connections with TLS. `caFile` names a PEM file of the certificates to trust. The default is plain TCP. */
  tls?: { caFile?: string };
  /** Goes to each host that the server advertises for ChatNav and Chat, also a loopback or unroutable one. `RoomsContext.pin` comes first. The default is false. */
  followRedirects?: boolean;
};
export type RoomsContext = { link: BosLink; server: ServerAddress; self: string; pin?: ServerAddress };

type Held = { status: RoomStatus; chat: ChatRoom | null; lines: OwnLines; cookie: string; hold: Hold | null };
type Hold = { timer: ReturnType<typeof setTimeout> | null; close: CloseInfo['kind'] };
type OwnLines = { drawn: bigint | null; readonly pending: Map<bigint, RichText | null> };
type Join = { abandoned: boolean; readonly conns: Set<OscarConnection>; wake: (() => void) | null };
type Seat = { info: RoomInfo; chat: ChatRoom; conn: OscarConnection; lines: OwnLines; ended: () => CloseInfo | null };

const copy = (status: RoomStatus): RoomStatus => ({ ...status, occupants: [...status.occupants] });
const abandoned = (): OscarRoomError => new OscarRoomError('unavailable', 'the join was abandoned');

function failureOf(error: unknown): RoomJoinFailure {
  if (error instanceof OscarRoomError && error.code === 'no-such-room') return 'no-such-room';
  if (error instanceof OscarRoomError && error.code === 'too-long') return 'name-too-long';
  return 'unavailable';
}

function clip(body: RichText, max: number): RichText {
  const out: RichText = [];
  let left = max;
  for (const run of body) {
    if (left <= 0) break;
    out.push(run.text.length > left ? { ...run, text: run.text.slice(0, left) } : run);
    left -= run.text.length;
  }
  return out;
}

export function encodedRoomLength(body: RichText): number {
  // What `toAsciiEntities` returns is US-ASCII: one byte per character.
  return toAsciiEntities(richTextToAimHtml(body)).length;
}

export function isRoomRoll(body: RichText): boolean {
  return isRollCommand(richTextToAimHtml(body));
}

export function roomFailureReason(error: unknown): ImFailureReason {
  if (error instanceof OscarError && error.info.kind === 'timeout' && error.info.rateLimited) return 'rateLimited';
  if (error instanceof OscarError && error.info.kind === 'local' && error.info.code === 'whisper-target-left') return 'whisperTargetLeft';
  return 'notInRoom';
}

function sendFailure(error: unknown): unknown {
  if (!(error instanceof OscarSendError)) return error;
  if (error.code === 'rate-limited') return new OscarError({ kind: 'timeout', rateLimited: true });
  if (error.code === 'too-long') return new OscarError({ kind: 'local', code: 'message-too-long' });
  if (error.code === 'recipient-unavailable') return new OscarError({ kind: 'local', code: 'whisper-target-left' });
  return new OscarError({ kind: 'local', code: 'not-in-room' });
}

/** A join sends on BOS only the room cookie ChatNav returned in that join: the server answers an unknown cookie by closing BOS. */
export class Rooms {
  private readonly held = new Map<string, Held>();
  private readonly joins = new Map<string, { join: Join; promise: Promise<RoomStatus> }>();
  private readonly invited = new Map<bigint, { roomId: string; to: string }>();
  private readonly invites = new Map<string, { cookie: bigint; from: string; key: string; at: number }>();

  private asking: Promise<boolean> | null = null;

  constructor(private readonly deps: RoomsDeps) {}

  list(): RoomStatus[] {
    return [...this.held.values()].map((held) => copy(held.status));
  }

  join(ctx: RoomsContext, room: RoomId): Promise<RoomStatus> {
    const target: RoomId = { exchange: room.exchange, name: room.name.trim() };
    if (!isValidRoomName(target.name)) return Promise.reject(new RoomJoinError('invalid-name'));
    const id = roomConversationId(target);
    // A second connection for the room takes the seat and ends the first (state/session_manager.go AddSession).
    const running = this.joins.get(id);
    if (running) return running.promise;
    const held = this.held.get(id);
    if (held?.status.state === 'joined') return Promise.resolve(copy(held.status));
    if (this.seats() >= (this.deps.maxRooms ?? MAX_ROOMS)) return Promise.reject(new RoomJoinError('room-limit'));
    const join: Join = { abandoned: false, conns: new Set(), wake: null };
    const promise = this.run(ctx, id, target, join);
    this.joins.set(id, { join, promise });
    return promise;
  }

  /** Resolves once the room echoed the line, the only proof of delivery. An HTML body goes out as it is. `id` is the id of the line. */
  async send(roomId: string, body: ImBody, opts: { whisperTo?: string } = {}): Promise<{ replacedBy: RichText | null; id: string }> {
    const held = this.held.get(roomId);
    const chat = held?.chat;
    if (!held || !chat || held.status.state !== 'joined') throw this.refused(held, new OscarError({ kind: 'local', code: 'not-in-room' }));
    if (!isHtmlBody(body) && encodedRoomLength(body) > ROOM_MESSAGE_MAX_BYTES) {
      throw this.refused(held, new OscarError({ kind: 'local', code: 'message-too-long' }));
    }
    const lines = held.lines;
    lines.drawn = null;
    const html = isHtmlBody(body) ? body.html : richTextToAimHtml(body);
    const sending = opts.whisperTo === undefined ? chat.send(html) : chat.send(html, { whisperTo: opts.whisperTo });
    const cookie = lines.drawn;
    try {
      const { id } = await sending;
      return { replacedBy: (cookie === null ? null : lines.pending.get(cookie)) ?? null, id };
    } catch (error) {
      throw this.refused(held, sendFailure(error));
    } finally {
      if (cookie !== null) lines.pending.delete(cookie);
    }
  }

  leave(roomId: string): void {
    this.abandon(roomId);
    const held = this.held.get(roomId);
    if (!held) return;
    this.held.delete(roomId);
    this.unhold(held);
    this.release(held);
  }

  bosLost(): void {
    for (const id of [...this.joins.keys()]) {
      this.abandon(id);
      const held = this.held.get(id);
      if (held) this.setState(held, 'disconnected', 'bos-lost');
    }
    for (const held of [...this.held.values()]) {
      if (this.held.get(held.status.id) !== held || held.status.state !== 'joined') continue;
      const close = held.hold?.close ?? 'bos-lost';
      this.unhold(held);
      this.release(held);
      held.status = { ...held.status, occupants: [] };
      this.setState(held, 'rejoining', close);
    }
  }

  /** Rooms reading `rejoining` get one join each if their id is in `ids`, and become `disconnected` if it is not. */
  rejoin(ctx: RoomsContext, ids: ReadonlySet<string>): void {
    for (const held of [...this.held.values()]) {
      if (held.status.state !== 'rejoining' || this.joins.has(held.status.id)) continue;
      if (ids.has(held.status.id)) this.rejoinOne(ctx, held);
      else this.setState(held, 'disconnected', 'bos-lost');
    }
  }

  async invite(ctx: RoomsContext, roomId: string, screenName: string): Promise<void> {
    const held = this.held.get(roomId);
    if (held?.status.state !== 'joined' || !held.chat) throw this.unsent(held, new OscarError({ kind: 'local', code: 'not-in-room' }));
    const cookie = newCookie();
    this.invited.set(cookie, { roomId, to: normalizeScreenName(screenName) });
    try {
      const body = encodeChatInvite(cookie, screenName, { exchange: held.status.exchange, cookie: held.cookie }, INVITE_TEXT);
      const reply = await ctx.link.requestMatching(FAMILY_ICBM, ICBM_MSG_TO_HOST, body, INVITE_ACK_TIMEOUT_MS, (snac) => isReplyTo(cookie, snac));
      if (reply.subtype !== ICBM_HOST_ACK) throw new OscarError(refusalOf(reply));
    } catch (error) {
      throw this.unsent(held, error);
    }
  }

  async declineInvite(ctx: RoomsContext, inviteId: string): Promise<void> {
    const invite = this.invites.get(inviteId);
    if (!invite) return;
    this.invites.delete(inviteId);
    return ctx.link.send(FAMILY_ICBM, ICBM_MSG_TO_HOST, encodeChatInviteCancel(invite.cookie, invite.from));
  }

  forgetInvite(inviteId: string): void {
    this.invites.delete(inviteId);
  }

  handle(snac: Snac): boolean {
    if (snac.family !== FAMILY_ICBM || snac.subtype !== ICBM_MSG_TO_CLIENT) return false;
    if (decodeImToClient(snac.body).channel !== ICBM_CHANNEL_RENDEZVOUS) return false;
    // A message for another capability belongs to another part of the client.
    const capability = rendezvousCapability(snac.body);
    if (capability && !Buffer.from(capability).equals(Buffer.from(CAP_CHAT))) return false;
    const proposal = parseInvite(snac.body);
    const cancel = proposal ? null : parseInviteCancel(snac.body);
    if (proposal) this.proposed(proposal);
    else if (cancel) this.declined(cancel);
    else this.deps.log.debug('ignored a channel 2 message that is not a room invitation');
    return true;
  }

  reset(): void {
    this.invited.clear();
    this.invites.clear();
    for (const id of [...this.joins.keys()]) this.abandon(id);
    const all = [...this.held.values()];
    this.held.clear();
    for (const held of all) {
      this.unhold(held);
      this.release(held);
    }
  }

  private seats(): number {
    const ids = new Set(this.joins.keys());
    for (const [id, held] of this.held) {
      const state = held.status.state;
      if (state === 'joined' || state === 'joining' || state === 'rejoining') ids.add(id);
    }
    return ids.size;
  }

  private proposed(proposal: ChatInvite): void {
    const exchange = proposal.room.exchange;
    const name = proposal.roomCookie.split('-').slice(2).join('-');
    if ((exchange !== 4 && exchange !== 5) || !isValidRoomName(name)) {
      this.deps.log.debug('ignored a room invitation outside the rules', { exchange });
      return;
    }
    const text = clip(parseAimHtml(proposal.html), INVITE_TEXT_MAX);
    const wire = this.deps.wireDetail ? { wire: { html: proposal.html } } : {};
    const key = `${proposal.from}\n${roomKey({ exchange, name })}`;
    for (const [id, pending] of this.invites) {
      if (pending.key !== key) continue;
      // The same invitation again, as the server delivers it to each session's reader.
      if (pending.cookie === proposal.cookie) return;
      pending.cookie = proposal.cookie;
      pending.from = proposal.fromDisplay;
      this.deps.emitInvite({ id, from: proposal.fromDisplay, room: { exchange, name }, text, at: pending.at, ...wire });
      return;
    }
    if (this.invites.size >= MAX_PENDING_INVITES) {
      this.deps.log.debug('ignored a room invitation: too many are pending', { exchange });
      return;
    }
    const id = `${proposal.from}:${proposal.cookie.toString(16).padStart(16, '0')}`;
    const at = this.deps.now();
    this.invites.set(id, { cookie: proposal.cookie, from: proposal.fromDisplay, key, at });
    this.deps.emitInvite({ id, from: proposal.fromDisplay, room: { exchange, name }, text, at, ...wire });
  }

  private declined(cancel: ChatInviteCancel): void {
    const sent = this.invited.get(cancel.cookie);
    if (!sent || sent.to !== cancel.from) {
      this.deps.log.debug('ignored a decline of no invitation of this session');
      return;
    }
    this.invited.delete(cancel.cookie);
    this.deps.emitDeclined({ roomId: sent.roomId, by: cancel.fromDisplay });
  }

  private unsent(held: Held | undefined, error: unknown): unknown {
    this.deps.log.warn('a room invite failed', {
      ...(held ? { exchange: held.status.exchange } : {}),
      error: error instanceof Error ? error.name : typeof error,
      ...(error instanceof OscarError ? { kind: error.info.kind } : {}),
      ...(error instanceof OscarError && 'code' in error.info ? { code: error.info.code } : {}),
    });
    return error;
  }

  private refused(held: Held | undefined, error: unknown): unknown {
    this.deps.log.warn('a room send failed', {
      ...(held ? { exchange: held.status.exchange } : {}),
      error: error instanceof Error ? error.name : typeof error,
      ...(error instanceof OscarError ? { kind: error.info.kind } : {}),
      ...(error instanceof OscarError && 'code' in error.info ? { code: error.info.code } : {}),
      ...(error instanceof OscarError && error.info.kind === 'timeout' ? { rateLimited: error.info.rateLimited } : {}),
    });
    return error;
  }

  private release(held: Held): void {
    const chat = held.chat;
    held.chat = null;
    chat?.close();
  }

  private unhold(held: Held): void {
    if (held.hold?.timer) this.deps.timers.clearTimeout(held.hold.timer);
    held.hold = null;
  }

  private roomClosed(held: Held, close: CloseInfo['kind']): void {
    this.deps.log.info('a room connection closed', { exchange: held.status.exchange, close });
    const hold: Hold = { timer: null, close };
    if (close === 'probe-timeout' || close === 'error') {
      // Each connection learns of a dead network on its own timer, up to 90 s apart: this asks BOS, and an answer means Disconnected.
      held.hold = hold;
      void this.bosAnswers().then((alive) => {
        if (!alive || held.hold !== hold || this.held.get(held.status.id) !== held) return;
        this.settled(held, hold);
      });
      return;
    }
    hold.timer = this.deps.timers.setTimeout(() => {
      hold.timer = null;
      this.settled(held, hold);
    }, ROOM_CLOSE_SETTLE_MS);
    held.hold = hold;
  }

  // The close stays on the room while the host decides, so a loss of BOS in the meantime still takes it in.
  private settled(held: Held, hold: Hold): void {
    const { afterClosed, context } = this.deps;
    if (!afterClosed) {
      held.hold = null;
      this.setState(held, 'disconnected', hold.close);
      return;
    }
    void afterClosed(copy(held.status), hold.close).then((choice) => {
      if (held.hold !== hold || this.held.get(held.status.id) !== held) return;
      held.hold = null;
      const ctx = choice === 'rejoin' ? (context?.() ?? null) : null;
      if (!ctx) {
        this.setState(held, 'disconnected', hold.close);
        return;
      }
      this.setState(held, 'rejoining', hold.close);
      this.rejoinOne(ctx, held);
    });
  }

  private rejoinOne(ctx: RoomsContext, held: Held): void {
    const id = held.status.id;
    const join: Join = { abandoned: false, conns: new Set(), wake: null };
    const promise = this.run(ctx, id, { exchange: held.status.exchange, name: held.status.name }, join, true);
    this.joins.set(id, { join, promise });
    const rejoined = promise.catch((error: unknown) => {
      if (!(error instanceof RoomJoinError)) throw error;
    });
    if (this.deps.spawn) this.deps.spawn('rejoin', () => rejoined);
    else rejoined.catch(() => undefined);
  }

  private bosAnswers(): Promise<boolean> {
    if (this.asking) return this.asking;
    const asking = this.deps.bosAlive().then(
      (alive) => alive,
      () => false,
    );
    this.asking = asking;
    const done = (): void => {
      if (this.asking === asking) this.asking = null;
    };
    void asking.then(done);
    return asking;
  }

  private abandon(id: string): void {
    const running = this.joins.get(id);
    if (!running) return;
    this.joins.delete(id);
    running.join.abandoned = true;
    for (const conn of [...running.join.conns]) conn.close();
    running.join.wake?.();
  }

  private async run(ctx: RoomsContext, id: string, target: RoomId, join: Join, rejoin = false): Promise<RoomStatus> {
    try {
      const before = this.held.get(id);
      if (before && !rejoin) this.setState(before, 'joining');
      const seat = await this.seat(ctx, target, join);
      if (join.abandoned || !seat.conn.isOpen) {
        seat.chat.close();
        throw abandoned();
      }
      join.conns.delete(seat.conn);
      const { info } = seat;
      const status: RoomStatus = {
        id, exchange: target.exchange, name: info.name, state: 'joined', occupants: seat.chat.roster(),
        createdAt: info.createdAt === undefined ? null : info.createdAt * 1000, maxOccupancy: info.maxOccupancy ?? null,
      };
      const held: Held = { status, chat: seat.chat, lines: seat.lines, cookie: seat.info.cookie, hold: null };
      this.held.set(id, held);
      this.listen(held, seat);
      this.deps.emitRoom(copy(status));
      return copy(status);
    } catch (error) {
      for (const conn of [...join.conns]) conn.close();
      const reason = failureOf(error);
      this.deps.log.warn('a room join failed', {
        reason,
        exchange: target.exchange,
        error: error instanceof Error ? error.name : typeof error,
        ...(error instanceof OscarRoomError ? { code: error.code } : {}),
      });
      const held = this.held.get(id);
      if (held && !join.abandoned) this.setState(held, reason === 'no-such-room' ? 'notAvailable' : 'disconnected', 'join-failed');
      throw new RoomJoinError(reason);
    } finally {
      if (this.joins.get(id)?.join === join) this.joins.delete(id);
    }
  }

  private setState(held: Held, state: RoomStatus['state'], close?: CloseInfo['kind'] | 'bos-lost' | 'join-failed'): void {
    held.status = { ...held.status, state };
    this.deps.log.info('a room changed state', { exchange: held.status.exchange, state, ...(close ? { close } : {}) });
    this.deps.emitRoom(copy(held.status));
  }

  // Closed before the server wrote anything: a stale cookie (server/oscar/server.go connectToOSCARService). Resolve again, once.
  private async seat(ctx: RoomsContext, target: RoomId, join: Join): Promise<Seat> {
    const { log, now, timers, random } = this.deps;
    const resolver = serviceResolver(ctx.link, ctx.server, this.deps.now, { pin: ctx.pin, tls: this.deps.tls, follow: this.deps.followRedirects });
    const sleep = (ms: number): Promise<void> =>
      new Promise((resolve, reject) => {
        if (join.abandoned) {
          reject(abandoned());
          return;
        }
        const timer = timers.setTimeout(() => {
          join.wake = null;
          resolve();
        }, ms);
        join.wake = () => {
          join.wake = null;
          timers.clearTimeout(timer);
          reject(abandoned());
        };
      });
    const openNav = async (): Promise<SnacLink> => {
      if (join.abandoned) throw abandoned();
      return this.open(await requestService(resolver, { foodGroup: FAMILY_CHATNAV, screenName: ctx.self }), 'chatnav', join);
    };
    for (let round = 1; ; round++) {
      const info = await resolveRoom({ kind: 'create', room: target }, { open: openNav, sleep, random, log, onStrayRate: (body) => strayRate(ctx.link, body) });
      if (join.abandoned) throw abandoned();
      const grant = await requestService(resolver, { foodGroup: FAMILY_CHAT, room: info, screenName: ctx.self });
      if (join.abandoned) throw abandoned();
      const conn = await this.open(grant, 'chat', join);
      let heard = false;
      let ended: CloseInfo | null = null;
      conn.onClose((close) => {
        ended = close;
      });
      const link: SnacLink = {
        send: (family, subtype, body) => conn.send(family, subtype, body),
        request: (family, subtype, body, timeoutMs) => conn.request(family, subtype, body, timeoutMs),
        onSnac: (fn) =>
          conn.onSnac((snac) => {
            heard = true;
            fn(snac);
          }),
        onClose: (fn) => conn.onClose(fn),
        close: () => conn.close(),
      };
      const lines: OwnLines = { drawn: null, pending: new Map() };
      const chat = new ChatRoom({
        room: { exchange: info.exchange, name: info.name },
        link,
        self: ctx.self,
        pacer: createRoomPacer(now, this.deps.paceMarginMs),
        log,
        now,
        timers,
        newCookie: () => {
          const cookie = newRoomCookie();
          lines.drawn = cookie;
          lines.pending.set(cookie, null);
          return cookie;
        },
      });
      // Before start: the first roster comes in during it.
      chat.on('user', (user) => this.deps.sawUser(user));
      try {
        await chat.start();
        return { info, chat, conn, lines, ended: () => ended };
      } catch (error) {
        const close = ended as CloseInfo | null;
        const refused = !heard && close !== null && close.kind !== 'local';
        if (round > 1 || !refused || join.abandoned) throw error;
        log.info('the room connection was refused at sign-on; resolving again', { exchange: target.exchange });
      }
    }
  }

  private async open(grant: ServiceGrant, label: 'chatnav' | 'chat', join: Join): Promise<OscarConnection> {
    const { log, now, timers, limits } = this.deps;
    const conn = await openConnection({ host: grant.host, port: grant.port, ...connectionTls(this.deps.tls), cookie: grant.cookie, label, log, now, timers, ...limits });
    if (join.abandoned) {
      conn.close();
      throw abandoned();
    }
    join.conns.add(conn);
    conn.onClose(() => join.conns.delete(conn));
    return conn;
  }

  private listen(held: Held, seat: Seat): void {
    const chat = seat.chat;
    const changed = (screenName: string, change: RoomOccupantChange['change']): void => {
      if (held.chat !== chat) return;
      held.status = { ...held.status, occupants: chat.roster() };
      this.deps.emitOccupant({ roomId: held.status.id, screenName, change, occupants: chat.roster() });
    };
    chat.on('join', (who) => changed(who.display, 'joined'));
    chat.on('leave', (who) => changed(who.display, 'left'));
    chat.on('message', (message) => {
      if (held.chat !== chat) return;
      const body = parseAimHtml(message.html);
      // A server line under the id of the user's own line replaced it (foodgroup/chat.go ChannelMsgToHost): the send resolves with it.
      if (message.serverGenerated && held.lines.pending.has(message.cookie)) {
        held.lines.pending.set(message.cookie, body);
        return;
      }
      this.deps.emitMessage({
        roomId: held.status.id,
        from: message.fromDisplay,
        body,
        at: this.deps.now(),
        whisper: message.whisper,
        fromServer: message.serverGenerated,
        ...(!message.serverGenerated && this.deps.isBlocked(message.fromDisplay) ? { blocked: true as const } : {}),
        ...(this.deps.wireDetail ? { wire: { cookie: message.cookie.toString(16).padStart(16, '0'), html: message.html } } : {}),
      });
    });
    chat.on('rate', (status) => {
      if (held.chat !== chat) return;
      this.deps.emitRate?.({ roomId: held.status.id, status });
    });
    chat.on('closed', () => {
      if (held.chat !== chat) return;
      held.chat = null;
      this.roomClosed(held, seat.ended()?.kind ?? 'local');
    });
  }
}
