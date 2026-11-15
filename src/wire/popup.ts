import { POPUP_TLV_HEIGHT, POPUP_TLV_MESSAGE, POPUP_TLV_URL, POPUP_TLV_WIDTH } from './constants.js';
import { htmlToText } from './text.js';
import { decodeTlvs, findTlv, tlvStr, tlvU16 } from './tlv.js';

/**
 * A notice from the server. `html` is the message as the server sent it, and `message` is its text.
 * A field that the SNAC does not hold is null.
 */
export type Popup = { message: string; html: string; url: string | null; width: number | null; height: number | null };

/** Reads the body of a popup SNAC. The message is HTML in `charset`. The result is null when the message has no text. */
export function decodePopup(body: Uint8Array, charset: string): Popup | null {
  const tlvs = decodeTlvs(body);
  const bytes = findTlv(tlvs, POPUP_TLV_MESSAGE);
  if (!bytes) return null;
  const html = new TextDecoder(charset).decode(bytes);
  const message = htmlToText(html);
  if (message.trim() === '') return null;
  return {
    message,
    html,
    url: tlvStr(tlvs, POPUP_TLV_URL) || null,
    width: tlvU16(tlvs, POPUP_TLV_WIDTH) ?? null,
    height: tlvU16(tlvs, POPUP_TLV_HEIGHT) ?? null,
  };
}
