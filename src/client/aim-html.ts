import { attributeValue, decodeEntities, tagEnd } from '../wire/text.js';
import { HOST_NAME, LINK_NOISE } from '../model/found-links.js';
import type { RichText, RichTextRun } from '../model/rich-text.js';

type Format = Omit<RichTextRun, 'text'>;
type OpenTag = { name: string; format: Format };

const FORMAT_KEYS = ['bold', 'italic', 'underline', 'color', 'face', 'size', 'link'] as const;
const SIZES = [1, 2, 3, 4, 5, 6, 7] as const;
const FACE = /^[\p{L}\p{Nd} -]{1,64}$/u;
const LINK = /^(?:https?|mailto):/i;
// A link with no scheme to an ASCII host name, with or without a port, path, query or fragment, goes there over https.
const HOST = new RegExp(`^${HOST_NAME.source}(?::\\d{1,5})?(?:[/?#].*)?$`, 'i');
export const MAX_OPEN_TAGS = 32;

// A Map, not an object: a colour named "constructor" must find nothing.
const COLOR_NAMES = new Map([
  ['black', '#000000'], ['silver', '#c0c0c0'], ['gray', '#808080'], ['white', '#ffffff'],
  ['maroon', '#800000'], ['red', '#ff0000'], ['purple', '#800080'], ['fuchsia', '#ff00ff'],
  ['green', '#008000'], ['lime', '#00ff00'], ['olive', '#808000'], ['yellow', '#ffff00'],
  ['navy', '#000080'], ['blue', '#0000ff'], ['teal', '#008080'], ['aqua', '#00ffff'],
]);

function parseColor(raw: string): string | undefined {
  const value = raw.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(value)) return value;
  if (/^#[0-9a-f]{3}$/.test(value)) return value.replace(/[0-9a-f]/g, '$&$&');
  return COLOR_NAMES.get(value);
}

function parseSize(raw: string): RichTextRun['size'] {
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) return undefined;
  return SIZES[Math.min(7, Math.max(1, n)) - 1];
}

function parseLink(tag: string): string | undefined {
  const address = decodeEntities(attributeValue(tag, 'href')).replace(LINK_NOISE, '');
  if (LINK.test(address)) return address;
  return HOST.test(address) ? `https://${address}` : undefined;
}

function fontFormat(tag: string): Format {
  const format: Format = {};
  const color = parseColor(attributeValue(tag, 'color'));
  const face = attributeValue(tag, 'face');
  const size = parseSize(attributeValue(tag, 'size'));
  if (color !== undefined) format.color = color;
  if (FACE.test(face)) format.face = face;
  if (size !== undefined) format.size = size;
  return format;
}

function openFormat(name: string, tag: string): Format | null {
  if (name === 'b') return { bold: true };
  if (name === 'i') return { italic: true };
  if (name === 'u') return { underline: true };
  if (name === 'font') return fontFormat(tag);
  if (name === 'a') {
    const link = parseLink(tag);
    return link === undefined ? {} : { link };
  }
  return null;
}

function sameFormat(a: Format, b: Format): boolean {
  return FORMAT_KEYS.every((key) => a[key] === b[key]);
}

// This cuts out tags before it decodes entities: the other order turns a typed "&lt;b&gt;" into a tag.
export function parseAimHtml(html: string): RichText {
  const src = html.replace(/\r\n?/g, '\n');
  const runs: RichText = [];
  const open: OpenTag[] = [];
  const unkept = new Map<string, number>();
  const closeTag = (name: string): void => {
    const skipped = unkept.get(name) ?? 0;
    if (skipped > 0) {
      unkept.set(name, skipped - 1);
      return;
    }
    for (let at = open.length - 1; at >= 0; at--) {
      if (open[at]?.name === name) {
        open.splice(at, 1);
        return;
      }
    }
  };
  const openTag = (name: string, format: Format): void => {
    if (open.length < MAX_OPEN_TAGS) open.push({ name, format });
    else unkept.set(name, (unkept.get(name) ?? 0) + 1);
  };
  const add = (text: string): void => {
    if (text === '') return;
    const format: Format = Object.assign({}, ...open.map((entry) => entry.format));
    const last = runs.at(-1);
    if (last && sameFormat(last, format)) last.text += text;
    else runs.push({ text, ...format });
  };
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      add(decodeEntities(src.slice(i)));
      break;
    }
    if (!/[a-zA-Z/!?]/.test(src[lt + 1] ?? '')) {
      add(decodeEntities(src.slice(i, lt + 1)));
      i = lt + 1;
      continue;
    }
    add(decodeEntities(src.slice(i, lt)));
    const end = tagEnd(src, lt);
    if (end < 0) {
      add(decodeEntities(src.slice(lt)));
      break;
    }
    const tag = src.slice(lt, end + 1);
    const match = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)/.exec(tag);
    const name = (match?.[2] ?? '').toLowerCase();
    if (match?.[1] === '/') closeTag(name);
    else if (name === 'br') add('\n');
    else {
      const format = openFormat(name, tag);
      if (format) {
        if (name === 'a') closeTag('a');
        openTag(name, format);
      }
    }
    i = end + 1;
  }
  return runs;
}

function escapeText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<BR>');
}

function runToAimHtml(run: RichTextRun): string {
  let out = escapeText(run.text);
  if (run.underline) out = `<U>${out}</U>`;
  if (run.italic) out = `<I>${out}</I>`;
  if (run.bold) out = `<B>${out}</B>`;
  let font = '';
  if (run.color !== undefined && /^#[0-9a-fA-F]{6}$/.test(run.color)) font += ` COLOR="${run.color}"`;
  if (run.face !== undefined && FACE.test(run.face)) font += ` FACE="${run.face}"`;
  if (Number.isInteger(run.size)) font += ` SIZE="${Math.min(7, Math.max(1, run.size ?? 1))}"`;
  if (font !== '') out = `<FONT${font}>${out}</FONT>`;
  const link = run.link?.replace(LINK_NOISE, '');
  if (link !== undefined && LINK.test(link)) {
    out = `<A HREF="${link.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">${out}</A>`;
  }
  return out;
}

// No <HTML> or <BODY> wrapper: every byte counts against the 512-byte limit.
export function richTextToAimHtml(runs: RichText): string {
  return runs.map(runToAimHtml).join('');
}
