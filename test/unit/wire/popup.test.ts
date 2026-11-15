import { describe, expect, it } from 'vitest';
import { OscarDecodeError } from '../../../src/wire/bytes.js';
import { decodePopup } from '../../../src/wire/popup.js';
import { encodeTlvs, tlv } from '../../../src/wire/tlv.js';

const CHARSET = 'windows-1252';
const ascii = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'latin1'));

describe('decodePopup', () => {
  it('reads the four TLVs', () => {
    const body = encodeTlvs([tlv.bytes(0x0001, ascii('hello')), tlv.str(0x0002, 'https://example.com/a'), tlv.u16(0x0003, 480), tlv.u16(0x0004, 320)]);
    expect(decodePopup(body, CHARSET)).toEqual({ message: 'hello', html: 'hello', url: 'https://example.com/a', width: 480, height: 320 });
  });

  it('leaves url, width and height null when they are absent', () => {
    const body = encodeTlvs([tlv.bytes(0x0001, ascii('hello'))]);
    expect(decodePopup(body, CHARSET)).toEqual({ message: 'hello', html: 'hello', url: null, width: null, height: null });
  });

  it('decodes the message as the charset names it', () => {
    const message = (...bytes: number[]) => decodePopup(encodeTlvs([tlv.bytes(0x0001, Uint8Array.from(bytes))]), CHARSET)?.message;
    expect(message(0x63, 0x61, 0x66, 0xe9)).toBe('café');
    expect(message(0x93, 0x68, 0x69, 0x94)).toBe('“hi”');
  });

  it('turns the HTML into text', () => {
    const body = encodeTlvs([tlv.bytes(0x0001, ascii('a<br>b &amp; c'))]);
    expect(decodePopup(body, CHARSET)?.message).toBe('a\nb & c');
  });

  it('answers null for no message, and for one that is empty', () => {
    expect(decodePopup(encodeTlvs([tlv.str(0x0002, 'https://example.com/')]), CHARSET)).toBeNull();
    expect(decodePopup(encodeTlvs([tlv.empty(0x0001)]), CHARSET)).toBeNull();
    expect(decodePopup(encodeTlvs([tlv.bytes(0x0001, ascii('<b> <br></b>'))]), CHARSET)).toBeNull();
  });

  it('reads an empty URL as null', () => {
    const body = encodeTlvs([tlv.bytes(0x0001, ascii('hello')), tlv.empty(0x0002)]);
    expect(decodePopup(body, CHARSET)?.url).toBeNull();
  });

  it('throws on a truncated TLV', () => {
    const body = Uint8Array.of(0x00, 0x01, 0x00, 0x05, 0x61);
    expect(() => decodePopup(body, CHARSET)).toThrow(OscarDecodeError);
  });
});
