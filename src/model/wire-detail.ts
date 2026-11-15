import type { RichText } from './rich-text.js';

/** A body that goes out as this AIM HTML, byte for byte, with no rich-text render. */
export type HtmlBody = { html: string };
/** The body of an IM, a room line or an away message: rich text, or HTML as it is. */
export type ImBody = RichText | HtmlBody;

/** True when the body is HTML to send as it is, false when it is rich text. */
export function isHtmlBody(body: ImBody): body is HtmlBody {
  return !Array.isArray(body);
}

/** A message as it came on the wire. `cookie` is the message cookie as 16 lowercase hex digits; `html` is the decoded text before the parse. */
export type MessageWire = { cookie: string; html: string };
/** An invitation as it came on the wire. `html` is the decoded text of the invitation before the parse. */
export type InviteWire = { html: string };
