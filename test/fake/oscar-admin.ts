// foodgroup/admin.go at open-oscar-server 7af2464, with no socket: the test server hands it each Admin SNAC and a wire to answer on.
import {
  ADMIN_ERR,
  ADMIN_ERROR_INVALID,
  ADMIN_ERROR_LENGTH,
  ADMIN_ERROR_NOT_SAME,
  ADMIN_INFO_CHANGE,
  ADMIN_INFO_CHANGE_REPLY,
  ADMIN_INFO_QUERY,
  ADMIN_INFO_REPLY,
  ADMIN_TLV_EMAIL,
  ADMIN_TLV_ERROR,
  ADMIN_TLV_SCREEN_NAME,
  ADMIN_TLV_URL,
  FAMILY_ADMIN,
} from '../../src/wire/admin.js';
import { normalizeScreenName } from '../../src/wire/text.js';
import { decodeTlvs, encodeTlvBlock, findTlv, tlv } from '../../src/wire/tlv.js';
import type { Tlv } from '../../src/wire/tlv.js';

// foodgroup/oservice.go:402-415: the Admin connection's host online.
export const ADMIN_HOST_ONLINE: readonly number[] = [0x0001, 0x0007];

export type AdminWire = { send(family: number, subtype: number, requestId: number, body: Uint8Array): void };
export type SelfInfoOrder = 'before' | 'after' | 'none';

export interface FakeAdminCore<B> {
  display(ident: string): string;
  rename(ident: string, display: string): void;
  selfInfo(bos: B): void;
}

const TLV_REG_STATUS = 0x0013;
const PERMISSIONS_READ_WRITE = 0x0003;
const ERR_NOT_SUPPORTED_BY_HOST = 0x0008;
// foodgroup/oservice.go ServiceRequest: a food group with no case in its switch.
const ERR_SERVICE_UNAVAILABLE = 0x0005;
const MAX_HANDLE_BYTES = 16;

function u16(value: number): Uint8Array {
  return Uint8Array.of((value >> 8) & 0xff, value & 0xff);
}

function adminReply(tlvs: readonly Tlv[]): Uint8Array {
  return Uint8Array.from([...u16(PERMISSIONS_READ_WRITE), ...encodeTlvBlock(tlvs)]);
}

// state/user.go:70-95 ValidateAIMHandle, then the identity check of admin.go:158-176 validateProposedName.
function refusalOf(name: string, ident: string): number | null {
  const bytes = Buffer.from(name, 'utf8');
  if (bytes.length > MAX_HANDLE_BYTES) return ADMIN_ERROR_LENGTH;
  let counted = 0;
  for (const char of name) {
    if (/[\p{L}\p{Nd}]/u.test(char)) counted++;
    else if (char !== ' ') return ADMIN_ERROR_INVALID;
  }
  if (counted < 3) return ADMIN_ERROR_LENGTH;
  // unicode.IsLetter(rune(s[0])): the first byte read as one Latin-1 rune, so a Hebrew lead byte (0xD7, ×) fails.
  if (!/\p{L}/u.test(String.fromCharCode(bytes[0] ?? 0)) || bytes[bytes.length - 1] === 0x20) return ADMIN_ERROR_INVALID;
  if (normalizeScreenName(name) !== ident) return ADMIN_ERROR_NOT_SAME;
  return null;
}

/** Admin as foodgroup/admin.go:80-302 answers 0x07/0x02 and 0x07/0x04, plus the switches the tests use. */
export class FakeAdmin<B> {
  selfInfoOrder: SelfInfoOrder = 'before';
  private readonly emails = new Map<string, string>();
  private readonly regStatuses = new Map<string, number>();
  private refusingService = false;
  private adminErr: number | null = null;
  private nextChangeRefusal: number | null = null;
  private held: (() => void)[] | null = null;
  private dropping = false;
  private replacement: Uint8Array | null = null;

  constructor(private readonly core: FakeAdminCore<B>) {}

  setEmail(name: string, email: string): void {
    this.emails.set(normalizeScreenName(name), email);
  }

  emailOf(name: string): string {
    return this.emails.get(normalizeScreenName(name)) ?? '';
  }

  setRegStatus(name: string, status: number): void {
    this.regStatuses.set(normalizeScreenName(name), status);
  }

  serviceRefusal(): number | null {
    return this.refusingService ? ERR_SERVICE_UNAVAILABLE : null;
  }

  refuseService(on: boolean): void {
    this.refusingService = on;
  }

  answerAdminErr(code: number | null): void {
    this.adminErr = code;
  }

  refuseNextChange(code: number): void {
    this.nextChangeRefusal = code;
  }

  hold(): void {
    this.held ??= [];
  }

  release(): void {
    const held = this.held ?? [];
    this.held = null;
    for (const out of held) out();
  }

  dropNext(): void {
    this.dropping = true;
  }

  replaceNextReply(body: Uint8Array): void {
    this.replacement = body;
  }

  handle(wire: AdminWire, ident: string, bos: B, snac: { subtype: number; requestId: number; body: Uint8Array }): void {
    if (this.dropping) {
      this.dropping = false;
      return;
    }
    const reply = (subtype: number, body: Uint8Array, then?: () => void): void => {
      const replaced = this.replacement;
      this.replacement = null;
      const out = (): void => {
        wire.send(FAMILY_ADMIN, subtype, snac.requestId, replaced ?? body);
        then?.();
      };
      if (this.held) this.held.push(out);
      else out();
    };
    const notSupported = (): void => reply(ADMIN_ERR, u16(this.adminErr ?? ERR_NOT_SUPPORTED_BY_HOST));
    if (this.adminErr !== null) {
      notSupported();
      return;
    }
    const tlvs = decodeTlvs(snac.body);
    if (snac.subtype === ADMIN_INFO_QUERY) {
      const answer = this.infoQuery(ident, tlvs);
      // admin.go:127-136: a query for none of the three fields is AdminErr.
      if (answer) reply(ADMIN_INFO_REPLY, answer);
      else notSupported();
      return;
    }
    const name = snac.subtype === ADMIN_INFO_CHANGE ? findTlv(tlvs, ADMIN_TLV_SCREEN_NAME) : undefined;
    if (name !== undefined) {
      this.formatChange(ident, bos, Buffer.from(name).toString('utf8'), reply);
      return;
    }
    notSupported();
  }

  // admin.go:81-137 InfoQuery: one field, by priority, by the TLV's presence alone. null for none of them.
  private infoQuery(ident: string, tlvs: readonly Tlv[]): Uint8Array | null {
    if (findTlv(tlvs, TLV_REG_STATUS) !== undefined) return adminReply([tlv.u16(TLV_REG_STATUS, this.regStatuses.get(ident) ?? 0)]);
    if (findTlv(tlvs, ADMIN_TLV_EMAIL) !== undefined) return adminReply([tlv.str(ADMIN_TLV_EMAIL, this.emails.get(ident) ?? '')]);
    if (findTlv(tlvs, ADMIN_TLV_SCREEN_NAME) !== undefined) return adminReply([tlv.str(ADMIN_TLV_SCREEN_NAME, this.core.display(ident))]);
    return null;
  }

  // admin.go:140-218: the 0x01/0x0F and the reply leave on different goroutines, so selfInfoOrder can put the reply first.
  private formatChange(ident: string, bos: B, name: string, reply: (subtype: number, body: Uint8Array, then?: () => void) => void): void {
    const code = this.nextChangeRefusal ?? refusalOf(name, ident);
    this.nextChangeRefusal = null;
    if (code !== null) {
      reply(ADMIN_INFO_CHANGE_REPLY, adminReply([tlv.u16(ADMIN_TLV_ERROR, code), tlv.empty(ADMIN_TLV_URL)]));
      return;
    }
    this.core.rename(ident, name);
    if (this.selfInfoOrder === 'before') this.core.selfInfo(bos);
    const after = this.selfInfoOrder === 'after' ? () => this.core.selfInfo(bos) : undefined;
    reply(ADMIN_INFO_CHANGE_REPLY, adminReply([tlv.str(ADMIN_TLV_SCREEN_NAME, name)]), after);
  }
}
