import { describe, expect, it } from 'vitest';
import { aimVariableValues, expandAimVariables } from '../../../src/model/aim-variables.js';
import { shownBody } from '../../../src/model/found-links.js';
import type { ShownText } from '../../../src/model/found-links.js';
import type { RichText, RichTextRun } from '../../../src/model/rich-text.js';

const plainText = (body: readonly RichTextRun[]): string => body.map((run) => run.text).join('');

const VALUES = { name: 'Chimr Dev 1', date: '10/5/2026', time: '9:42 AM' };
const text = (input: string): string => expandAimVariables([{ text: input }], VALUES).map((run) => run.text).join('');

describe('expandAimVariables', () => {
  it.each([
    ['Hi %n!', 'Hi Chimr Dev 1!'],
    ['It is %t on %d.', 'It is 9:42 AM on 10/5/2026.'],
    ['%n', 'Chimr Dev 1'],
    ['%n%d', 'Chimr Dev 1%d'],
    ['%n %n', 'Chimr Dev 1 Chimr Dev 1'],
    ['(%n)', '(Chimr Dev 1)'],
    ["%n's day", "Chimr Dev 1's day"],
    ['%n\nback at %t', 'Chimr Dev 1\nback at 9:42 AM'],
  ])('puts the reader, the date and the time for %%n, %%d and %%t: %j', (input, output) => {
    expect(text(input)).toBe(output);
  });

  it.each([
    ['%N %D %T', '%N %D %T'],
    ['100%', '100%'],
    ['%', '%'],
    ['%s %x %i %e', '%s %x %i %e'],
    ['%%', '%%'],
    ['50% off', '50% off'],
  ])('leaves upper case, unknown tokens, a lone % and %% as typed: %j', (input, output) => {
    expect(text(input)).toBe(output);
  });

  it('has no escape: %%n is a % and then the reader, as Pidgin wrote it', () => {
    expect(text('%%n')).toBe('%Chimr Dev 1');
  });

  it.each([
    ['100%delicious', '100%delicious'],
    ['%nbsp', '%nbsp'],
    ['http://x/%d0%bf', 'http://x/%d0%bf'],
    ['a%n', 'a%n'],
    ['%n2', '%n2'],
    ['é%t', 'é%t'],
    ['%dé', '%dé'],
    // A combining mark is part of the letter it follows: a decomposed accent, or a vowel sign in Devanagari or Thai.
    ['café%n', 'café%n'],
    ['नमस्ते%n', 'नमस्ते%n'],
    ['%ń', '%ń'],
    ['%tी', '%tी'],
  ])('takes no token touching a letter, a combining mark or a digit on either side: %j', (input, output) => {
    expect(text(input)).toBe(output);
  });

  it('does not look again at what it put in', () => {
    expect(expandAimVariables([{ text: '%n' }], { name: '%t', date: '%n', time: 'x' })[0]?.text).toBe('%t');
  });

  it('changes only the text of each run, never a link, its formatting or how the runs are split', () => {
    const body: RichText = [
      { text: 'Hi ', bold: true },
      { text: '%n', link: 'https://example.com/?who=%n', color: '#ff0000' },
      { text: '%' , italic: true },
      { text: 'n at %t', size: 4 },
    ];
    expect(expandAimVariables(body, VALUES)).toEqual([
      { text: 'Hi ', bold: true },
      { text: 'Chimr Dev 1', link: 'https://example.com/?who=%n', color: '#ff0000' },
      { text: '%', italic: true },
      { text: 'n at 9:42 AM', size: 4 },
    ]);
  });

  it('never changes what it was given, and gives it back when there was nothing to put in', () => {
    const body: RichText = [{ text: 'plain' }, { text: 'Hi %n' }];
    const copy = structuredClone(body);
    const expanded = expandAimVariables(body, VALUES);
    expect(body).toEqual(copy);
    expect(expanded[0]).toBe(body[0]);
    const plain: RichText = [{ text: '100% plain' }];
    expect(expandAimVariables(plain, VALUES)).toBe(plain);
  });
});

describe('expandAimVariables and addresses written as text', () => {
  const V = { name: 'chimr dev 1', date: '10/14/2026', time: '9:42 AM' };
  const one = (input: string): string => plainText(expandAimVariables([{ text: input }], V));
  const linksOf = (shown: ShownText): string[] => shown.flatMap((run) => (run.link === undefined ? [] : [run.link]));

  it('leaves a token inside an address as typed, in its text and, through shownBody, in its link', () => {
    expect(one('www.example.com/~%n')).toBe('www.example.com/~%n');
    expect(linksOf(shownBody([{ text: 'www.example.com/~%n' }], V))).toEqual(['http://www.example.com/~%n']);
    expect(one('http://x.test/?d=%d&t=%t')).toBe('http://x.test/?d=%d&t=%t');
  });

  it('puts the name into what is no address as written, and what it puts in is never searched', () => {
    expect(one('www.%n.com')).toBe('www.chimr dev 1.com');
    expect(linksOf(shownBody([{ text: 'www.%n.com' }], V))).toEqual([]);
  });

  it('leaves a token straight after an address as typed: a letter stands before it', () => {
    expect(one('www.example.com%n')).toBe('www.example.com%n');
  });

  it("puts tokens in outside an address, and into a sender's link's text but never its address", () => {
    expect(one('hi %n, see www.example.com/~%n at %t')).toBe('hi chimr dev 1, see www.example.com/~%n at 9:42 AM');
    expect(expandAimVariables([{ text: '%n', link: 'https://example.com/?who=%n' }], V)).toEqual([{ text: 'chimr dev 1', link: 'https://example.com/?who=%n' }]);
  });

  it('adds no link, splits no run, keeps each run as given, and gives back the body itself with nothing to put in', () => {
    const body: RichText = [{ text: 'see www.example.net/%n ', bold: true }, { text: 'and %n', color: '#ff0000' }];
    const expanded = expandAimVariables(body, V);
    expect(expanded).toEqual([{ text: 'see www.example.net/%n ', bold: true }, { text: 'and chimr dev 1', color: '#ff0000' }]);
    expect(expanded).toHaveLength(body.length);
    expect(expanded[0]).toBe(body[0]);
    const inside: RichText = [{ text: 'see www.example.net/%n' }];
    expect(expandAimVariables(inside, V)).toBe(inside);
  });

  it.each<RichText>([
    [{ text: 'hi %n, www.example.com/~%n' }],
    [{ text: 'see http://exa', bold: true }, { text: 'mple.com/%n now %n' }],
    [{ text: 'mailto:bob@example.net?subject=%t and %d' }],
    [{ text: '%n ' }, { text: 'site %n', link: 'https://chimr.app/?%n' }, { text: ' bob@example.net %t' }],
    [{ text: 'www.%n.com and www.example.com%n' }],
    [{ text: 'nothing found, %n' }],
  ])('expandAimVariables and shownBody give the same plain text, %#', (...body) => {
    expect(plainText(expandAimVariables(body, V))).toBe(plainText(shownBody(body, V)));
  });
});

describe('aimVariableValues', () => {
  const at = new Date(2026, 9, 5, 21, 7).getTime();

  it('writes the date short and numeric and the time in the given locale and 24-hour setting', () => {
    expect(aimVariableValues('Chimr Dev 1', at, { locale: 'en-US', hour12: null })).toEqual({ name: 'Chimr Dev 1', date: '10/5/2026', time: '9:07 PM' });
    expect(aimVariableValues('Chimr Dev 1', at, { locale: 'en-GB', hour12: false })).toEqual({ name: 'Chimr Dev 1', date: '05/10/2026', time: '21:07' });
    expect(aimVariableValues('x', at, { locale: 'en-US', hour12: false }).time).toBe('21:07');
    expect(aimVariableValues('x', at, { locale: 'en-GB', hour12: true }).time).toBe('9:07 pm');
  });
});
