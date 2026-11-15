import {
  FAMILY_ICBM,
  FLAP_MAX_PAYLOAD,
  ICBM_CHANNEL_IM,
  ICBM_CLIENT_EVENT,
  ICBM_ERR,
  ICBM_ERROR_NOT_LOGGED_ON,
  ICBM_ERROR_REQUEST_DENIED,
  ICBM_EVENT_NONE,
  ICBM_EVENT_TYPED,
  ICBM_EVENT_TYPING,
  ICBM_EVIL_REPLY,
  ICBM_EVIL_REQUEST,
  ICBM_HOST_ACK,
  ICBM_MSG_TO_CLIENT,
  ICBM_MSG_TO_HOST,
  ICBM_OFFLINE_RETRIEVE,
  ICBM_OFFLINE_RETRIEVE_REPLY,
  ICBM_TLV_AUTO_RESPONSE,
  ICBM_TLV_IM_DATA,
  ICBM_TLV_SEND_TIME,
} from '../wire/constants.js';
import {
  ICBM_ERROR_SENDER_BLOCKS,
  ICBM_SUBERROR_OFFLINE_FULL,
  decodeHostAck,
  decodeIcbmError,
  decodeImFragments,
  decodeImToClient,
  decodeTyping,
  decodeWarnReply,
  encodeImToHost,
  encodeTyping,
  encodeWarn,
  newCookie,
} from '../wire/icbm.js';
import type { Snac, UserInfo } from '../wire/snac.js';
import { decodeWireText, encodeImText } from '../wire/text.js';
import { findTlv, hasTlv, tlvU32 } from '../wire/tlv.js';
import type { Logger } from '../wire/types.js';
import { expandAimVariables } from '../model/aim-variables.js';
import type { AimVariableValues } from '../model/aim-variables.js';
import type { BuddyPresence, IncomingIm } from '../model/buddy-list.js';
import type { RichText } from '../model/rich-text.js';
import { normalizeScreenName } from '../model/screen-name.js';
import type { CommandError, ImFailureReason } from '../model/session.js';
import { isHtmlBody } from '../model/wire-detail.js';
import type { ImBody } from '../model/wire-detail.js';
import { parseAimHtml, richTextToAimHtml } from './aim-html.js';
import type { BosLink } from './bos-link.js';
import { OscarError } from './errors.js';

export const IM_ACK_TIMEOUT_MS = 15_000;
export const IM_FALLBACK_LIMIT_BYTES = 512;
export const WARN_TIMEOUT_MS = 10_000;
export const WARN_WINDOW_MS = 3_600_000;
export const OFFLINE_RETRIEVE_TIMEOUT_MS = 20_000;
/** The bytes of one frame that an HTML body leaves for the rest of the IM. */
const IM_FRAME_RESERVE_BYTES = 512;
/** The server remembers this many IMs, and this many warnings back, per pair of users. */
const WARN_MEMORY = 3;

export type TypingEvent = 'typing' | 'typed' | 'stopped';
const TYPING_EVENT_CODE: Record<TypingEvent, number> = { typing: ICBM_EVENT_TYPING, typed: ICBM_EVENT_TYPED, stopped: ICBM_EVENT_NONE };

export type AutoResponse = { to: string; body: RichText; at: number; done: Promise<void> };
/** What the host says to an auto-response about to go out: `count` marks the sender answered without sending. */
export type AutoResponseDecision = 'send' | 'skip' | 'count';
/** How `sendIm` sends one IM. With no options, the IM is not an auto-response, and it asks the server to store it. */
export type SendImOptions = {
  /** Marks the IM as an auto-response (TLV 0x04). The default is false. */
  automatic?: boolean;
  /**
   * Sets when the IM asks the server to store it for a recipient who is offline. `'when-offline'` asks only when the presence of the recipient is offline.
   * After error 0x0004 to an IM without the store TLV, the client sends the IM once more with it and the same cookie. The default is `'always'`.
   */
  store?: 'always' | 'when-offline';
};
/** The IM that the server acknowledged. `id` is its cookie as 16 lowercase hex digits. `stored` is true when it asked the server to store it. */
export type SentIm = { id: string; stored: boolean };

type Encoded = { charset: number; bytes: Uint8Array };
// The message as it goes on the wire: ASCII when every character is 7-bit, otherwise UTF-16BE.
const encodeBody = (body: RichText): Encoded => encodeImText(richTextToAimHtml(body));
const cookieId = (cookie: bigint): string => cookie.toString(16).padStart(16, '0');

export function encodedImLength(body: RichText): number {
  return encodeBody(body).bytes.length;
}

export function truncateToFit(body: RichText, limitBytes: number): RichText {
  if (encodedImLength(body) <= limitBytes) return body;
  const cuts: { run: number; end: number }[] = [];
  body.forEach((run, index) => {
    let end = 0;
    for (const character of run.text) {
      end += character.length;
      cuts.push({ run: index, end });
    }
  });
  const prefix = (count: number): RichText => {
    const cut = cuts[count - 1];
    if (!cut) return [];
    const whole = body.slice(0, cut.run);
    const last = body[cut.run];
    return last ? [...whole, { ...last, text: last.text.slice(0, cut.end) }] : whole;
  };
  // The encoded length never shrinks as the prefix grows, so halving finds the longest that fits.
  let fits = 0;
  let over = cuts.length;
  while (over - fits > 1) {
    const middle = Math.floor((fits + over) / 2);
    if (encodedImLength(prefix(middle)) <= limitBytes) fits = middle;
    else over = middle;
  }
  return prefix(fits);
}

export function imFailureReason(error: unknown): { reason: ImFailureReason; code?: number } {
  if (!(error instanceof OscarError)) return { reason: 'other' };
  const info = error.info;
  switch (info.kind) {
    case 'refused':
      if (info.code === ICBM_ERROR_SENDER_BLOCKS) return { reason: 'youBlocked' };
      if (info.code === ICBM_ERROR_NOT_LOGGED_ON) {
        return { reason: info.subcode === ICBM_SUBERROR_OFFLINE_FULL ? 'offlineInboxFull' : 'unavailable' };
      }
      return { reason: 'other', code: info.code };
    case 'timeout':
      return { reason: info.rateLimited ? 'rateLimited' : 'unconfirmed' };
    case 'connection-lost':
    case 'not-signed-on':
      return { reason: 'connectionLost' };
    default:
      return { reason: 'other' };
  }
}

export function warnRefusalKind(error: unknown): 'not-allowed' | 'not-available' | 'other' {
  if (!(error instanceof OscarError) || error.info.kind !== 'refused') return 'other';
  if (error.info.code === ICBM_ERROR_REQUEST_DENIED) return 'not-allowed';
  if (error.info.code === ICBM_ERROR_NOT_LOGGED_ON) return 'not-available';
  return 'other';
}

/** The server's error (0x04/0x01) with its code; code 0 for a body too short to carry one. */
export function refusalOf(reply: Snac): CommandError {
  try {
    return { kind: 'refused', ...decodeIcbmError(reply.body) };
  } catch {
    return { kind: 'refused', code: 0 };
  }
}

function failureFields(error: unknown): Record<string, unknown> {
  if (!(error instanceof OscarError)) return { kind: 'unexpected' };
  const info = error.info;
  return 'code' in info ? { kind: info.kind, code: info.code } : { kind: info.kind };
}

/** A server notice has a bare user-info block and no send time; the configured sender, when there is one, counts with TLVs too. */
export function isServerNotice(sender: UserInfo, sentAt: number | undefined, noticeSender: string | null): boolean {
  if (sentAt !== undefined) return false;
  return sender.tlvs.length === 0 || (noticeSender !== null && normalizeScreenName(sender.name) === normalizeScreenName(noticeSender));
}

const isIcbm = (snac: Snac, ...subtypes: number[]): boolean => snac.family === FAMILY_ICBM && subtypes.includes(snac.subtype);

/** The server's error or the acknowledgement naming the cookie; anything else on the request id is another client's SNAC. */
export function isReplyTo(cookie: bigint, snac: Snac): boolean {
  if (snac.family !== FAMILY_ICBM) return false;
  if (snac.subtype === ICBM_ERR) return true;
  if (snac.subtype !== ICBM_HOST_ACK) return false;
  try {
    return decodeHostAck(snac.body).cookie === cookie;
  } catch {
    return false;
  }
}

export type MessagingDeps = {
  now: () => number;
  log: Logger;
  imLimit: () => number;
  emit: (im: IncomingIm) => void;
  emitTyping: (typing: { from: string; typing: boolean }) => void;
  emitAutoResponse: (sent: AutoResponse) => void;
  decide: (ctx: { to: string; at: number }) => AutoResponseDecision | Promise<AutoResponseDecision>;
  emitAnswered: (answered: { screenName: string; sent: boolean }) => void;
  variables: (to: string, at: number) => AimVariableValues;
  noticeSender: string | null;
  /** Gives the presence that the `'when-offline'` store rule reads. Without it, the rule finds no presence. */
  presenceOf?: (screenName: string) => BuddyPresence | undefined;
  /** Adds `wire`, the cookie and the HTML as they came, to each incoming IM. The default is false. */
  wireDetail?: boolean;
};

type Exchange = { ims: number[]; warnings: number[] };

export class Messaging {
  private away: RichText | null = null;
  private readonly answered = new Set<string>();
  private readonly held = new Set<string>();
  private readonly exchanges = new Map<string, Exchange>();
  private session = 0;
  private period = 0;

  constructor(private readonly deps: MessagingDeps) {}

  reset(): void {
    this.session++;
    this.away = null;
    this.clearAnswered();
    this.held.clear();
    this.exchanges.clear();
  }

  hold(screenName: string): void {
    this.held.add(normalizeScreenName(screenName));
  }

  release(link: BosLink | null, screenName: string, answer: boolean): void {
    if (!this.held.delete(normalizeScreenName(screenName)) || !answer || link === null) return;
    this.autoRespond(link, screenName);
  }

  setAway(message: RichText | null): void {
    if ((this.away === null) !== (message === null)) this.clearAnswered();
    this.away = message;
  }

  /** The normalised names answered in this away period. */
  answeredSenders(): string[] {
    return [...this.answered];
  }

  markAnswered(screenName: string): void {
    const key = normalizeScreenName(screenName);
    if (key !== '') this.answered.add(key);
  }

  restoreAnswered(names: readonly string[]): void {
    for (const name of names) this.markAnswered(name);
  }

  /** The limit is for rich text. An HTML body must only fit one frame. */
  async send(link: BosLink, to: string, body: ImBody, limitBytes: number, opts: SendImOptions = {}): Promise<SentIm> {
    const encoded = isHtmlBody(body) ? encodeImText(body.html) : encodeBody(body);
    const limit = isHtmlBody(body) ? FLAP_MAX_PAYLOAD - IM_FRAME_RESERVE_BYTES : limitBytes;
    if (encoded.bytes.length > limit) throw new OscarError({ kind: 'local', code: 'message-too-long' });
    const automatic = opts.automatic === true;
    const whenOffline = opts.store === 'when-offline';
    const stored = !whenOffline || this.deps.presenceOf?.(to)?.online === false;
    const cookie = newCookie();
    let written = false;
    const onWritten = (): void => {
      written = true;
    };
    try {
      try {
        await this.deliver(link, to, encoded, { cookie, store: stored, automatic }, onWritten);
        return { id: cookieId(cookie), stored };
      } catch (error) {
        // The server did not find the recipient online: the same IM goes once more, and asks the server to store it.
        if (stored || !(error instanceof OscarError) || error.info.kind !== 'refused' || error.info.code !== ICBM_ERROR_NOT_LOGGED_ON) throw error;
      }
      // The server refused the first copy, so that copy cannot arrive.
      written = false;
      await this.deliver(link, to, encoded, { cookie, store: true, automatic }, onWritten);
      return { id: cookieId(cookie), stored: true };
    } catch (error) {
      if (written && error instanceof OscarError && error.info.kind === 'connection-lost') throw new OscarError(error.info, { sent: true });
      throw error;
    }
  }

  async sendTyping(link: BosLink, to: string, event: TypingEvent): Promise<void> {
    return link.send(FAMILY_ICBM, ICBM_CLIENT_EVENT, encodeTyping(to, TYPING_EVENT_CODE[event]));
  }

  /** Stored messages arrive as IMs before the reply that ends the retrieval. */
  async retrieveOffline(link: BosLink): Promise<void> {
    try {
      const reply = await link.requestMatching(FAMILY_ICBM, ICBM_OFFLINE_RETRIEVE, undefined, OFFLINE_RETRIEVE_TIMEOUT_MS, (snac) =>
        isIcbm(snac, ICBM_OFFLINE_RETRIEVE_REPLY, ICBM_ERR),
      );
      if (reply.subtype === ICBM_ERR) throw new OscarError(refusalOf(reply));
    } catch (error) {
      this.deps.log.warn('could not fetch the stored messages', failureFields(error));
    }
  }

  async warn(link: BosLink, screenName: string): Promise<{ level: number }> {
    const session = this.session;
    const reply = await link.requestMatching(FAMILY_ICBM, ICBM_EVIL_REQUEST, encodeWarn(screenName), WARN_TIMEOUT_MS, (snac) =>
      isIcbm(snac, ICBM_EVIL_REPLY, ICBM_ERR),
    );
    if (reply.subtype === ICBM_ERR) throw new OscarError(refusalOf(reply));
    const { level } = decodeWarnReply(reply.body);
    if (session === this.session) {
      const exchange = this.exchange(screenName);
      exchange.warnings = [...exchange.warnings, this.deps.now()].slice(-WARN_MEMORY);
    }
    return { level };
  }

  /** The server accepts a warning for more live IMs from that name in the last hour, counted to three, than warnings sent back. */
  canWarn(screenName: string): boolean {
    const exchange = this.exchanges.get(normalizeScreenName(screenName));
    if (!exchange) return false;
    const windowStart = this.deps.now() - WARN_WINDOW_MS;
    const within = (times: number[]): number => times.filter((at) => at > windowStart).length;
    return within(exchange.ims) > within(exchange.warnings);
  }

  handle(link: BosLink, snac: Snac): boolean {
    if (isIcbm(snac, ICBM_CLIENT_EVENT)) {
      const { screenName, event } = decodeTyping(snac.body);
      this.deps.emitTyping({ from: screenName, typing: event === ICBM_EVENT_TYPING });
      return true;
    }
    if (!isIcbm(snac, ICBM_MSG_TO_CLIENT)) return false;
    const { cookie, channel, sender, tlvs } = decodeImToClient(snac.body);
    if (channel !== ICBM_CHANNEL_IM) return true;
    const data = findTlv(tlvs, ICBM_TLV_IM_DATA);
    if (!data) return true;
    const html = decodeImFragments(data)
      .map((fragment) => decodeWireText(fragment.text, fragment.charset))
      .join('');
    // A stored message carries its send time, in seconds.
    const sentAt = tlvU32(tlvs, ICBM_TLV_SEND_TIME);
    const offline = sentAt !== undefined;
    const now = this.deps.now();
    const autoResponse = hasTlv(tlvs, ICBM_TLV_AUTO_RESPONSE);
    const serverNotice = isServerNotice(sender, sentAt, this.deps.noticeSender);
    if (!offline && !serverNotice) {
      const exchange = this.exchange(sender.name);
      exchange.ims = [...exchange.ims, now].slice(-WARN_MEMORY);
    }
    this.deps.emit({
      from: sender.name,
      body: parseAimHtml(html),
      autoResponse,
      at: offline ? sentAt * 1000 : now,
      offline,
      serverNotice,
      ...(this.deps.wireDetail ? { wire: { cookie: cookieId(cookie), html } } : {}),
    });
    if (!autoResponse && !offline && !serverNotice) this.autoRespond(link, sender.name);
    return true;
  }

  private autoRespond(link: BosLink, to: string): void {
    const key = normalizeScreenName(to);
    if (this.away === null || this.answered.has(key) || this.held.has(key)) return;
    // The sender counts as answered while the host decides, so a second IM meanwhile asks nothing.
    this.answered.add(key);
    const at = this.deps.now();
    const period = this.period;
    const conclude = (decision: AutoResponseDecision): void => this.conclude(link, to, at, period, decision);
    const failed = (error: unknown): void => {
      this.deps.log.warn('the auto-response check failed', { error: error instanceof Error ? error.name : typeof error });
      conclude('skip');
    };
    let decision: AutoResponseDecision | Promise<AutoResponseDecision>;
    try {
      decision = this.deps.decide({ to, at });
    } catch (error) {
      failed(error);
      return;
    }
    // A synchronous answer acts at once, so the events come in the same order as with no hook.
    if (typeof decision === 'string') conclude(decision);
    else decision.then(conclude, failed).catch((error: unknown) => this.deps.log.warn('the auto-response was not sent', failureFields(error)));
  }

  private conclude(link: BosLink, to: string, at: number, period: number, decision: AutoResponseDecision): void {
    const away = this.away;
    // The away period ended, or the session did, while the host was deciding.
    if (period !== this.period || away === null) return;
    const key = normalizeScreenName(to);
    if (decision !== 'send' && decision !== 'count') {
      this.answered.delete(key);
      return;
    }
    if (decision === 'send') {
      // The sender puts in %n, %d and %t for the one who IMed, as AIM's clients did; then truncateToFit cuts the body to fit.
      const body = truncateToFit(expandAimVariables(away, this.deps.variables(to, at)), this.deps.imLimit());
      const done = this.deliver(link, to, encodeBody(body), { cookie: newCookie(), store: true, automatic: true });
      done.catch((error: unknown) => this.deps.log.warn('the auto-response was not sent', failureFields(error)));
      this.deps.emitAutoResponse({ to, body, at, done });
    }
    this.deps.emitAnswered({ screenName: key, sent: decision === 'send' });
  }

  private clearAnswered(): void {
    this.answered.clear();
    this.period++;
  }

  private async deliver(
    link: BosLink,
    to: string,
    { charset, bytes }: Encoded,
    { cookie, store, automatic }: { cookie: bigint; store: boolean; automatic: boolean },
    onWritten?: () => void,
  ): Promise<void> {
    const reply = await link.requestMatching(
      FAMILY_ICBM,
      ICBM_MSG_TO_HOST,
      encodeImToHost(cookie, to, charset, bytes, store, automatic),
      IM_ACK_TIMEOUT_MS,
      (snac) => isReplyTo(cookie, snac),
      { onWritten },
    );
    if (reply.subtype === ICBM_HOST_ACK) return;
    throw new OscarError(refusalOf(reply));
  }

  private exchange(screenName: string): Exchange {
    const key = normalizeScreenName(screenName);
    let exchange = this.exchanges.get(key);
    if (!exchange) {
      exchange = { ims: [], warnings: [] };
      this.exchanges.set(key, exchange);
    }
    return exchange;
  }
}
