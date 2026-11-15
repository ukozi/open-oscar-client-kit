import { decodePresence } from '../wire/buddy.js';
import { FAMILY_LOCATE, LOCATE_SET_INFO } from '../wire/constants.js';
import {
  LOCATE_ERR,
  LOCATE_ERROR_NOT_LOGGED_ON,
  LOCATE_QUERY_AWAY,
  LOCATE_QUERY_PROFILE,
  LOCATE_USER_INFO_QUERY2,
  LOCATE_USER_INFO_REPLY,
  decodeUserInfoReply,
  encodeLocateInfo,
  encodeUserInfoQuery,
  mimeCharset,
} from '../wire/locate.js';
import type { Snac, UserInfo } from '../wire/snac.js';
import { decodeWireText, normalizeScreenName, toAsciiEntities } from '../wire/text.js';
import type { Logger } from '../wire/types.js';
import type { BuddyPresence, UserInfoResult } from '../model/buddy-list.js';
import type { RichText } from '../model/rich-text.js';
import { isHtmlBody } from '../model/wire-detail.js';
import type { ImBody } from '../model/wire-detail.js';
import { parseAimHtml, richTextToAimHtml } from './aim-html.js';
import type { BosLink } from './bos-link.js';
import { OscarError } from './errors.js';

export const INFO_TIMEOUT_MS = 15_000;

/** AIM HTML in 7-bit ASCII, every other character as `&#N;`, one per code point. */
export function locateText(body: RichText): string {
  return toAsciiEntities(richTextToAimHtml(body));
}

export function encodedLocateLength(body: RichText): number {
  return locateText(body).length;
}

export type BuddyInfo = { screenName: string; awayMessage?: RichText | null; profile?: RichText | null };
export type ProfilesDeps = {
  log: Logger;
  now: () => number;
  isBuddy: (name: string) => boolean;
  presenceOf: (screenName: string) => BuddyPresence | undefined;
  emit: (info: BuddyInfo) => void;
};

type Held = { profile?: RichText; away?: { message: RichText | null; stale: boolean } };
type Reply = { info: UserInfo; profile: RichText; awayMessage: RichText | null };

const PROFILE_CHARSETS = new Set(['us-ascii', 'iso-8859-1', 'utf-8', 'unicode-2-0']);

const isInfoReply = (snac: Snac): boolean =>
  snac.family === FAMILY_LOCATE && (snac.subtype === LOCATE_USER_INFO_REPLY || snac.subtype === LOCATE_ERR);

function errorCode(body: Uint8Array): number {
  return body.length >= 2 ? ((body[0] ?? 0) << 8) | (body[1] ?? 0) : 0;
}

function readReply(body: Uint8Array): Reply {
  const reply = decodeUserInfoReply(body);
  const charset = mimeCharset(reply.profile?.mime ?? '');
  const profile = reply.profile
    ? parseAimHtml(decodeWireText(reply.profile.bytes, charset !== undefined && PROFILE_CHARSETS.has(charset) ? charset : 'us-ascii'))
    : [];
  // The server labels every away message US-ASCII whatever its author sent.
  const awayMessage = reply.away ? parseAimHtml(decodeWireText(reply.away, 'us-ascii')) : null;
  return { info: reply.info, profile, awayMessage };
}

export class Profiles {
  private own: RichText | null = null;
  private readonly held = new Map<string, Held>();
  private readonly fetching = new Set<string>();
  private session = 0;

  constructor(private readonly deps: ProfilesDeps) {}

  get awayMessage(): RichText | null {
    return this.own;
  }

  reset(): void {
    this.forgetBuddies();
    this.own = null;
  }

  forgetBuddies(): void {
    this.session++;
    this.held.clear();
    this.fetching.clear();
  }

  adoptAway(message: RichText | null): void {
    this.own = message;
  }

  /** An HTML body goes to the server as it is, and the away message held is its parsed text. */
  async setAway(link: BosLink, message: ImBody | null, limit: number): Promise<void> {
    const session = this.session;
    let text = '';
    let own: RichText | null = null;
    if (message !== null) {
      text = isHtmlBody(message) ? message.html : locateText(message);
      own = isHtmlBody(message) ? parseAimHtml(message.html) : message;
      // An empty away message is how a client tells the server the user is back.
      if (text === '') throw new OscarError({ kind: 'local', code: 'invalid-argument' });
      if (Buffer.byteLength(text, 'utf8') > limit) throw new OscarError({ kind: 'local', code: 'text-too-long' });
    }
    await link.send(FAMILY_LOCATE, LOCATE_SET_INFO, encodeLocateInfo({ away: text }));
    if (session === this.session) this.own = own;
  }

  async setProfile(link: BosLink, profile: RichText, limit: number): Promise<void> {
    const text = locateText(profile);
    if (text.length > limit) throw new OscarError({ kind: 'local', code: 'text-too-long' });
    await link.send(FAMILY_LOCATE, LOCATE_SET_INFO, encodeLocateInfo({ profile: text }));
  }

  async getInfo(link: BosLink, screenName: string): Promise<UserInfoResult> {
    const key = normalizeScreenName(screenName);
    const buddy = this.deps.isBuddy(key);
    // This never asks about a buddy shown offline. It asks about anyone else every time: a profile changed on the server
    // sends no presence update, so the cache can be stale. The reply still refreshes it.
    if (buddy && !this.deps.presenceOf(screenName)?.online) return { status: 'unavailable' };
    const session = this.session;
    const reply = await this.query(link, LOCATE_QUERY_PROFILE | LOCATE_QUERY_AWAY, screenName, false).catch((error: unknown) => {
      this.logFailure('get info failed', error);
      throw error;
    });
    if (reply === null) return { status: 'unavailable' };
    const { away, idleMinutes, signedOnAt, warnLevel, mobile } = decodePresence(reply.info);
    if (session === this.session && this.deps.isBuddy(key)) {
      this.held.set(key, { profile: reply.profile, away: { message: reply.awayMessage, stale: false } });
      this.deps.emit({ screenName: reply.info.name, profile: reply.profile, awayMessage: reply.awayMessage });
    }
    return {
      status: 'ok',
      screenName: reply.info.name,
      away,
      idleSince: idleMinutes === undefined ? null : this.deps.now() - idleMinutes * 60_000,
      signedOnAt: signedOnAt === undefined ? null : signedOnAt * 1000,
      warnLevel,
      profile: reply.profile,
      awayMessage: reply.awayMessage,
      ...(mobile && { mobile }),
    };
  }

  async fetchAway(link: BosLink, screenName: string): Promise<void> {
    const key = normalizeScreenName(screenName);
    if (!this.deps.isBuddy(key)) return;
    const presence = this.deps.presenceOf(screenName);
    if (!presence?.online || !presence.away) return;
    if (this.fetching.has(key)) return;
    const away = this.held.get(key)?.away;
    if (away && !away.stale) return;
    if (link.isHeld(FAMILY_LOCATE, LOCATE_USER_INFO_QUERY2)) return;
    const session = this.session;
    this.fetching.add(key);
    try {
      const reply = await this.query(link, LOCATE_QUERY_AWAY, screenName, true);
      if (reply === null || session !== this.session || !this.deps.isBuddy(key)) return;
      this.held.set(key, { ...this.held.get(key), away: { message: reply.awayMessage, stale: false } });
      this.deps.emit({ screenName: reply.info.name, awayMessage: reply.awayMessage });
    } catch (error) {
      this.logFailure('away message fetch failed', error);
    } finally {
      if (session === this.session) this.fetching.delete(key);
    }
  }

  onPresence(presence: BuddyPresence): void {
    const key = normalizeScreenName(presence.screenName);
    const held = this.held.get(key);
    if (!held) return;
    const gone: BuddyInfo = { screenName: presence.screenName };
    if (held.profile !== undefined) gone.profile = null;
    delete held.profile;
    if (presence.online && presence.away) {
      if (held.away) held.away.stale = true;
    } else {
      if (held.away && held.away.message !== null) gone.awayMessage = null;
      delete held.away;
    }
    if (held.away === undefined) this.held.delete(key);
    if (gone.profile !== undefined || gone.awayMessage !== undefined) this.deps.emit(gone);
  }

  // 0x02/0x15, never 0x02/0x05, which the server counts against the IM budget; null is its "not available".
  private async query(link: BosLink, types: number, screenName: string, low: boolean): Promise<Reply | null> {
    const snac = await link.requestMatching(
      FAMILY_LOCATE,
      LOCATE_USER_INFO_QUERY2,
      encodeUserInfoQuery(types, screenName),
      INFO_TIMEOUT_MS,
      isInfoReply,
      { low },
    );
    if (snac.subtype === LOCATE_ERR) {
      const code = errorCode(snac.body);
      if (code === LOCATE_ERROR_NOT_LOGGED_ON) return null;
      throw new OscarError({ kind: 'refused', code });
    }
    try {
      return readReply(snac.body);
    } catch {
      throw new OscarError({ kind: 'refused', code: 0 });
    }
  }

  private logFailure(what: string, error: unknown): void {
    if (error instanceof OscarError) this.deps.log.warn(what, { ...error.info });
    else this.deps.log.warn(what, { error: error instanceof Error ? error.name : typeof error });
  }
}
