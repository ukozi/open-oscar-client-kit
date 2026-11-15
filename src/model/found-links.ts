import type { AimVariableValues } from './aim-variables.js';
import type { RichText, RichTextRun } from './rich-text.js';

// Typed without the DOM and Node; both give the WHATWG URL parser, which turns a host in other letters into its xn-- form.
declare const URL: new (input: string) => { readonly hostname: string; readonly protocol: string };

export const HOST_NAME = /(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})/i;

// For `replace` only: the `g` flag keeps a `lastIndex`, which the stop test below must not share.
export const LINK_NOISE = /[\s\p{Cc}\p{Cf}"«»‘-‟‹›]+/gu;

/** As Adium 1.3 reads them: lower case, no letter, mark or digit touching either side, and no escape. */
export const TOKEN = /(?<![\p{L}\p{M}\p{N}])%([ndt])(?![\p{L}\p{M}\p{N}])/gu;

export type FoundAddress = { start: number; end: number; link: string };
export type ShownRun = RichTextRun & { found?: true; source: number; at: number };
export type ShownText = readonly ShownRun[];

const STOP = /^[\s\p{Cc}\p{Cf}"<>«»‘-‟‹›]$/u;
const NOT_BEFORE = /^[\p{L}\p{M}\p{N}.\-+%@/:=&?#~\\]$/u;
const HOST_CHAR = /^[A-Za-z0-9.\-\p{L}\p{M}\p{N}]$/u;
const NAME_CHAR = /^[A-Za-z0-9._+-]$/;
const MAX_NAME = 64;
const ASCII_LABEL = /^[A-Za-z0-9-]*$/;
const WHOLE_HOST = new RegExp(`^${HOST_NAME.source}$`, 'i');
const MAX_HOST = 253;
const TRAILING = ".,:;!?'*_~";
const CLOSERS = ')]}';
const OPENERS = '([{';
const PROTOCOLS: readonly string[] = ['http:', 'https:', 'mailto:'];

function charAt(text: string, at: number): string {
  const code = text.charCodeAt(at);
  return code >= 0xd800 && code <= 0xdbff ? text.slice(at, at + 2) : text.charAt(at);
}

function charBefore(text: string, at: number): string {
  const code = text.charCodeAt(at - 1);
  if (code >= 0xdc00 && code <= 0xdfff && at >= 2) {
    const high = text.charCodeAt(at - 2);
    if (high >= 0xd800 && high <= 0xdbff) return text.slice(at - 2, at);
  }
  return text.charAt(at - 1);
}

const stopsAt = (text: string, at: number): boolean => STOP.test(charAt(text, at));

const FORMAT = /^\p{Cf}$/u;

/** A host or port cut by format characters with more of it after them reads as one address and opens another. */
function cutByFormat(text: string, end: number): boolean {
  let at = end;
  while (at < text.length && (text[at] === '.' || text[at] === '-')) at += 1;
  const marks = at;
  while (at < text.length && FORMAT.test(charAt(text, at))) at += charAt(text, at).length;
  return at > marks && at < text.length && HOST_CHAR.test(charAt(text, at));
}
const startsWith = (text: string, at: number, prefix: string): boolean => text.slice(at, at + prefix.length).toLowerCase() === prefix;

function fencesOf(text: string): Int32Array {
  const fences = new Int32Array(text.length + 1);
  fences[text.length] = text.length;
  for (let at = text.length - 1; at >= 0; at -= 1) {
    const ch = text.charAt(at);
    fences[at] = ch === '@' || ch === '/' || ch === '?' || ch === '#' || stopsAt(text, at) ? at : (fences[at + 1] ?? text.length);
  }
  return fences;
}

function readHost(text: string, start: number): { end: number; link: string } | null {
  let end = start;
  while (end < text.length) {
    const ch = charAt(text, end);
    if (!HOST_CHAR.test(ch)) break;
    end += ch.length;
  }
  while (end > start && (text[end - 1] === '.' || text[end - 1] === '-')) end -= 1;
  if (end === start) return null;
  const written = text.slice(start, end);
  let converted: string;
  try {
    converted = new URL(`http://${written}/`).hostname;
  } catch {
    return null;
  }
  if (converted.length > MAX_HOST || !WHOLE_HOST.test(converted)) return null;
  const labels = written.split('.');
  const out = converted.split('.');
  if (labels.length !== out.length) return null;
  let ascii = true;
  for (const [index, label] of labels.entries()) {
    const back = out[index] ?? '';
    if (ASCII_LABEL.test(label)) {
      if (label.toLowerCase() !== back) return null;
    } else {
      ascii = false;
      if (!back.startsWith('xn--')) return null;
    }
  }
  return { end, link: ascii ? written : converted };
}

function nameAt(text: string, start: number): number {
  let at = start;
  while (at < text.length && at - start <= MAX_NAME && NAME_CHAR.test(text.charAt(at))) at += 1;
  if (text[at] !== '@' || at === start || at - start > MAX_NAME) return -1;
  const name = text.slice(start, at);
  return name.startsWith('.') || name.endsWith('.') || name.includes('..') ? -1 : at;
}

function tailEnd(text: string, from: number): number {
  const open = [0, 0, 0];
  const close = [0, 0, 0];
  let end = from;
  while (end < text.length && !stopsAt(text, end)) {
    const ch = charAt(text, end);
    const opener = OPENERS.indexOf(ch);
    const closer = CLOSERS.indexOf(ch);
    if (opener >= 0) open[opener] = (open[opener] ?? 0) + 1;
    if (closer >= 0) close[closer] = (close[closer] ?? 0) + 1;
    end += ch.length;
  }
  while (end > from) {
    const ch = text.charAt(end - 1);
    const closer = CLOSERS.indexOf(ch);
    if (TRAILING.includes(ch)) end -= 1;
    else if (closer >= 0 && (close[closer] ?? 0) > (open[closer] ?? 0)) {
      close[closer] = (close[closer] ?? 0) - 1;
      end -= 1;
    } else break;
  }
  return end;
}

function opens(link: string): boolean {
  try {
    return PROTOCOLS.includes(new URL(link).protocol);
  } catch {
    return false;
  }
}

type Fence = (at: number) => number;
type Found = { end: number; link: string } | null;

function webAt(text: string, start: number, schemeEnd: number, fence: Fence): Found {
  const host = readHost(text, schemeEnd);
  if (host === null) return null;
  if (text[fence(schemeEnd)] === '@') return null;
  let end = host.end;
  if (cutByFormat(text, end)) return null;
  if (text[end] === ':' && /[0-9]/.test(text[end + 1] ?? '')) {
    let digits = end + 1;
    while (/[0-9]/.test(text[digits] ?? '')) digits += 1;
    const port = text.slice(end + 1, digits);
    if (port.length > 5 || Number(port) < 1 || Number(port) > 65_535) return null;
    end = digits;
    if (cutByFormat(text, end)) return null;
  }
  if (text[end] === '/' || text[end] === '?' || text[end] === '#') end = tailEnd(text, end);
  const scheme = schemeEnd === start ? 'http://' : text.slice(start, schemeEnd);
  return { end, link: `${scheme}${host.link}${text.slice(host.end, end)}` };
}

function mailAt(text: string, start: number, nameStart: number, mailto: boolean): Found {
  const at = nameAt(text, nameStart);
  if (at < 0) return null;
  const host = readHost(text, at + 1);
  if (host === null || cutByFormat(text, host.end)) return null;
  const end = mailto && text[host.end] === '?' ? tailEnd(text, host.end) : host.end;
  return { end, link: `${mailto ? '' : 'mailto:'}${text.slice(start, at + 1)}${host.link}${text.slice(host.end, end)}` };
}

function addressAt(text: string, start: number, fence: Fence): FoundAddress | null {
  const tries: (() => Found)[] = [
    () => (startsWith(text, start, 'http://') ? webAt(text, start, start + 7, fence) : startsWith(text, start, 'https://') ? webAt(text, start, start + 8, fence) : null),
    () => (startsWith(text, start, 'mailto:') ? mailAt(text, start, start + 7, true) : null),
    () => (startsWith(text, start, 'www.') ? webAt(text, start, start, fence) : null),
    // A bare e-mail address starts only where reading its name back from the `@` stops.
    () => (start === 0 || !NAME_CHAR.test(text.charAt(start - 1)) ? mailAt(text, start, start, false) : null),
  ];
  for (const attempt of tries) {
    const found = attempt();
    if (found !== null && opens(found.link)) return { start, end: found.end, link: found.link };
  }
  return null;
}

export function findAddresses(text: string): FoundAddress[] {
  const found: FoundAddress[] = [];
  let fences: Int32Array | undefined;
  const fence: Fence = (at) => {
    fences ??= fencesOf(text);
    return fences[at] ?? text.length;
  };
  let at = 0;
  while (at < text.length) {
    const first = NAME_CHAR.test(text.charAt(at)) && (at === 0 || !NOT_BEFORE.test(charBefore(text, at)));
    const address = first ? addressAt(text, at, fence) : null;
    if (address === null) at += 1;
    else {
      found.push(address);
      at = address.end;
    }
  }
  return found;
}

const asShown = (body: RichText): ShownText => body as unknown as ShownText;

const cache = new WeakMap<RichText, ShownText>();

export function linkAddresses(body: RichText): ShownText {
  const kept = cache.get(body);
  if (kept !== undefined) return kept;
  const shown: ShownRun[] = [];
  let anything = false;
  let first = 0;
  while (first < body.length) {
    let last = first;
    while (last < body.length && body[last]?.link === undefined) last += 1;
    if (last === first) {
      const run = body[first] as RichTextRun;
      shown.push({ ...run, source: first, at: 0 });
      first += 1;
      continue;
    }
    const addresses = findAddresses(body.slice(first, last).map((run) => run.text).join(''));
    if (addresses.length > 0) anything = true;
    let offset = 0;
    let next = 0;
    for (let source = first; source < last; source += 1) {
      const run = body[source] as RichTextRun;
      const runEnd = offset + run.text.length;
      let at = 0;
      while (next < addresses.length && (addresses[next]?.end ?? 0) <= offset) next += 1;
      if (run.text === '' || next >= addresses.length || (addresses[next]?.start ?? 0) >= runEnd) shown.push({ ...run, source, at: 0 });
      else {
        while (at < run.text.length) {
          const address = addresses[next];
          if (address === undefined || address.start >= runEnd) {
            shown.push({ ...run, text: run.text.slice(at), source, at });
            break;
          }
          if (address.start > offset + at) {
            const to = address.start - offset;
            shown.push({ ...run, text: run.text.slice(at, to), source, at });
            at = to;
            continue;
          }
          const to = Math.min(address.end, runEnd) - offset;
          shown.push({ ...run, text: run.text.slice(at, to), link: address.link, found: true, source, at });
          at = to;
          if (address.end <= runEnd) next += 1;
        }
      }
      offset = runEnd;
    }
    first = last;
  }
  const result = anything ? shown : asShown(body);
  cache.set(body, result);
  return result;
}

type Range = readonly [from: number, to: number];

function putIn(text: string, values: AimVariableValues, skip: readonly Range[], pieces: readonly Range[]): string[] {
  const tokens: { at: number; value: string }[] = [];
  let s = 0;
  for (const match of text.matchAll(TOKEN)) {
    const at = match.index;
    while (s < skip.length && (skip[s]?.[1] ?? 0) <= at) s += 1;
    const range = skip[s];
    if (range !== undefined && range[0] < at + 2) continue;
    tokens.push({ at, value: match[1] === 'n' ? values.name : match[1] === 'd' ? values.date : values.time });
  }
  let t = 0;
  return pieces.map(([from, to]) => {
    let out = '';
    let copied = from;
    while (t < tokens.length && (tokens[t]?.at ?? 0) < from) t += 1;
    for (let token = tokens[t]; token !== undefined && token.at + 2 <= to; token = tokens[t]) {
      out += text.slice(copied, token.at) + token.value;
      copied = token.at + 2;
      t += 1;
    }
    return out + text.slice(copied, to);
  });
}

function foundRanges(shown: ShownText): Map<number, Range[]> {
  const ranges = new Map<number, Range[]>();
  for (const piece of shown) {
    if (piece.found !== true) continue;
    const list = ranges.get(piece.source) ?? [];
    list.push([piece.at, piece.at + piece.text.length]);
    ranges.set(piece.source, list);
  }
  return ranges;
}

function putInRuns(body: RichText, values: AimVariableValues, found: ReadonlyMap<number, readonly Range[]>): RichText {
  let changed = false;
  const runs = body.map((run, source) => {
    if (!run.text.includes('%')) return run;
    const [text = run.text] = putIn(run.text, values, found.get(source) ?? [], [[0, run.text.length]]);
    if (text === run.text) return run;
    changed = true;
    return { ...run, text };
  });
  return changed ? runs : body;
}

export function putInVariablesAsHeld(body: RichText, values: AimVariableValues): RichText {
  return putInRuns(body, values, foundRanges(linkAddresses(body)));
}

export function putInVariables(body: RichText, shown: ShownText, values: AimVariableValues): ShownText {
  if (shown === asShown(body)) return asShown(putInRuns(body, values, new Map()));
  const found = foundRanges(shown);
  const out: ShownRun[] = [];
  let changed = false;
  let first = 0;
  while (first < shown.length) {
    const source = shown[first]?.source ?? 0;
    let last = first;
    while (last < shown.length && shown[last]?.source === source) last += 1;
    const pieces = shown.slice(first, last);
    const text = body[source]?.text ?? '';
    const texts = text.includes('%') ? putIn(text, values, found.get(source) ?? [], pieces.map((piece) => [piece.at, piece.at + piece.text.length] as const)) : null;
    for (const [index, piece] of pieces.entries()) {
      const put = texts?.[index] ?? piece.text;
      if (put === piece.text) out.push(piece);
      else {
        changed = true;
        out.push({ ...piece, text: put });
      }
    }
    first = last;
  }
  return changed ? out : shown;
}

export function shownBody(body: RichText, values?: AimVariableValues): ShownText {
  const linked = linkAddresses(body);
  return values === undefined ? linked : putInVariables(body, linked, values);
}
