import { putInVariablesAsHeld } from './found-links.js';
import type { RichText } from './rich-text.js';

/** `%n` the reader's screen name, `%d` the date, `%t` the time, each already written. */
export type AimVariableValues = { name: string; date: string; time: string };
/** A BCP 47 locale, its 24-hour setting (`null` leaves the hour cycle to the locale) and an IANA time zone. An unknown zone counts as none. */
export type TimeFormat = { locale: string; hour12: boolean | null; timeZone?: string };
export const DEFAULT_TIME_FORMAT: TimeFormat = { locale: 'en-US', hour12: null };

/** AIM's text variables put in, in one pass; a token inside an address written as text, or in a link's address, stays as typed. */
export function expandAimVariables(body: RichText, values: AimVariableValues): RichText {
  return body.some((run) => run.text.includes('%')) ? putInVariablesAsHeld(body, values) : body;
}

type Formats = { date: Intl.DateTimeFormat; time: Intl.DateTimeFormat };
// Any spelling of a locale or zone makes a key, so the cache keeps only the latest.
const FORMATS_KEPT = 64;
const made = new Map<string, Formats>();

function formatsFor(locale: string, hour12: boolean | null, timeZone: string | undefined): Formats {
  const key = `${locale} ${hour12} ${timeZone ?? ''}`;
  let formats = made.get(key);
  if (formats !== undefined) made.delete(key);
  else {
    const cycle: Intl.DateTimeFormatOptions = hour12 === null ? {} : hour12 ? { hour12: true } : { hourCycle: 'h23' };
    formats = {
      date: new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'numeric', day: 'numeric', timeZone }),
      time: new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', ...cycle, timeZone }),
    };
    const oldest = made.keys().next();
    if (made.size >= FORMATS_KEPT && !oldest.done) made.delete(oldest.value);
  }
  made.set(key, formats);
  return formats;
}

export function aimVariableValues(viewer: string, at: number, format: TimeFormat): AimVariableValues {
  const { locale, hour12, timeZone } = format;
  let formats: Formats;
  try {
    formats = formatsFor(locale, hour12, timeZone);
  } catch (error) {
    if (timeZone === undefined || !(error instanceof RangeError)) throw error;
    formats = formatsFor(locale, hour12, undefined);
  }
  return { name: viewer, date: formats.date.format(at), time: formats.time.format(at).replace(/[\u00a0\u202f]/g, ' ') };
}
