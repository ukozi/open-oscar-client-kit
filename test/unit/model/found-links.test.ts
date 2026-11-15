import { describe, expect, it } from 'vitest';
import { parseAimHtml } from '../../../src/client/aim-html.js';
import { expandAimVariables } from '../../../src/model/aim-variables.js';
import { findAddresses, linkAddresses, putInVariables, shownBody } from '../../../src/model/found-links.js';
import type { ShownText } from '../../../src/model/found-links.js';
import type { RichText } from '../../../src/model/rich-text.js';

// Web and e-mail addresses written as plain text, found when they are shown.

const links = (text: string): [string, string][] => findAddresses(text).map(({ start, end, link }) => [text.slice(start, end), link]);
/** Every link this file sees found, for the last check below. */
const seen: string[] = [];
function checked(text: string): [string, string][] {
  const found = links(text);
  for (const [, link] of found) seen.push(link);
  return found;
}

const VALUES = { name: 'chimr dev 1', date: '10/14/2026', time: '9:42 AM' };

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const each of Object.values(value)) deepFreeze(each);
    Object.freeze(value);
  }
  return value;
}

function timed<T>(fn: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
}

describe('findAddresses', () => {
  it.each([
    ['see https://chimr.app.', [['https://chimr.app', 'https://chimr.app']]],
    ['look at www.example.net/a).', [['www.example.net/a', 'http://www.example.net/a']]],
    ['https://en.wikipedia.org/wiki/Foo_(bar)', [['https://en.wikipedia.org/wiki/Foo_(bar)', 'https://en.wikipedia.org/wiki/Foo_(bar)']]],
    ['(see www.example.net)', [['www.example.net', 'http://www.example.net']]],
    ['HTTPS://EXAMPLE.NET/A', [['HTTPS://EXAMPLE.NET/A', 'HTTPS://EXAMPLE.NET/A']]],
    ['www.example.net:8080/x', [['www.example.net:8080/x', 'http://www.example.net:8080/x']]],
    ["www.chimr.app's", [['www.chimr.app', 'http://www.chimr.app']]],
    ["see www.chimr.app: it's new", [['www.chimr.app', 'http://www.chimr.app']]],
    ['www.example.net./a', [['www.example.net', 'http://www.example.net']]],
    ['mailto:bob@example.net?subject=hi', [['mailto:bob@example.net?subject=hi', 'mailto:bob@example.net?subject=hi']]],
    ['bob@example.net.', [['bob@example.net', 'mailto:bob@example.net']]],
    ['www.bob@example.net', [['www.bob@example.net', 'mailto:www.bob@example.net']]],
    ['https://bücher.example/x', [['https://bücher.example/x', 'https://xn--bcher-kva.example/x']]],
    ['bob@bücher.example', [['bob@bücher.example', 'mailto:bob@xn--bcher-kva.example']]],
    ['www.a.example@b.test', [['www.a.example@b.test', 'mailto:www.a.example@b.test']]],
    ['www.example.com/~%n', [['www.example.com/~%n', 'http://www.example.com/~%n']]],
  ] as [string, [string, string][]][])('finds %j', (written, want) => {
    expect(checked(written)).toEqual(want);
  });

  it('finds each address where it was written, the text around it untouched', () => {
    expect(findAddresses('see https://chimr.app.')).toEqual([{ start: 4, end: 21, link: 'https://chimr.app' }]);
    expect(findAddresses('look at www.example.net/a).')).toEqual([{ start: 8, end: 25, link: 'http://www.example.net/a' }]);
  });

  it.each([
    'example.com', 'example.com/page', 'node.js', 'e.g.',
    'http://192.168.1.1', 'http://[::1]/', 'http://localhost:8080',
    'http://bank.example@evil.test', 'https://ｅｘａｍｐｌｅ.com',
    'http://example.net:99999', 'http://example.net:0',
    'awww.example.net', 'foo.www.example.net', 'x/bob@example.net', '%n@example.net',
    'javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'ftp://example.net', 'aim:goim?screenname=x',
    'www.%n.com',
  ])('%j finds nothing', (written) => {
    expect(links(written)).toEqual([]);
  });

  it.each([
    ['HTTP://example.net/a', 'HTTP://example.net/a'],
    ['Https://example.net/a', 'Https://example.net/a'],
    ['WWW.EXAMPLE.NET', 'http://WWW.EXAMPLE.NET'],
    ['Www.Example.net', 'http://Www.Example.net'],
    ['MAILTO:bob@example.net', 'MAILTO:bob@example.net'],
    ['Mailto:Bob@Example.net', 'Mailto:Bob@Example.net'],
    ['BOB@EXAMPLE.NET', 'mailto:BOB@EXAMPLE.NET'],
  ])('finds each form in upper and mixed case, and keeps its case: %j', (written, link) => {
    expect(checked(written)).toEqual([[written, link]]);
  });

  it.each([' ', '\n', '　', '<', '>', '"', '“', '”', '‘', '’', '«', '»', '‹', '›', '‮', '​'])(
    'ends an address before the stop character U+%s',
    (stop) => {
      expect(checked(`https://example.net/a${stop}b`)).toEqual([['https://example.net/a', 'https://example.net/a']]);
    },
  );

  it.each(['.', ',', ':', ';', '!', '?', "'", '*', '_', '~'])('leaves out a trailing %j', (trailing) => {
    expect(checked(`https://example.net/a${trailing}`)).toEqual([['https://example.net/a', 'https://example.net/a']]);
  });

  it('leaves out a closing bracket with no partner, and keeps one with', () => {
    expect(checked('(www.example.net)')).toEqual([['www.example.net', 'http://www.example.net']]);
    expect(checked('www.example.net/a)b')).toEqual([['www.example.net/a)b', 'http://www.example.net/a)b']]);
    expect(checked('[x](https://example.net)')).toEqual([['https://example.net', 'https://example.net']]);
    expect(checked('{https://example.net}')).toEqual([['https://example.net', 'https://example.net']]);
    expect(checked('see https://example.net/a(b)c(d).')).toEqual([['https://example.net/a(b)c(d)', 'https://example.net/a(b)c(d)']]);
    expect(checked('https://example.net/[a]}')).toEqual([['https://example.net/[a]', 'https://example.net/[a]']]);
  });

  it.each(['', ' ', '(', '"', '_', '*'])('finds an address after %j', (before) => {
    expect(checked(`${before}www.example.net`)).toEqual([['www.example.net', 'http://www.example.net']]);
  });

  it.each(['x', '1', 'ा', '.', '/', '%', '@', '='])('finds no address straight after %j', (before) => {
    expect(links(` ${before}www.example.net`)).toEqual([]);
  });

  it("reads a bare e-mail address's name back from its @", () => {
    expect(checked('a_b@example.net')).toEqual([['a_b@example.net', 'mailto:a_b@example.net']]);
    // The name read back is `a_b`, after a `/`; no address starts at the `b` after `_`.
    expect(links('x/a_b@example.net')).toEqual([]);
  });

  describe('hosts', () => {
    it('takes no numeric host, no localhost and no one-letter top-level name', () => {
      expect(links('http://10.0.0.1/a')).toEqual([]);
      expect(links('https://[2001:db8::1]/')).toEqual([]);
      expect(links('http://localhost/')).toEqual([]);
      expect(links('www.example.x')).toEqual([]);
    });

    it('takes a label of 63 characters and not of 64', () => {
      expect(checked(`https://${'a'.repeat(63)}.example`)).toEqual([[`https://${'a'.repeat(63)}.example`, `https://${'a'.repeat(63)}.example`]]);
      expect(links(`https://${'a'.repeat(64)}.example`)).toEqual([]);
    });

    it('takes a host of 253 characters and not of 254', () => {
      const host = (length: number): string => ['a'.repeat(63), 'b'.repeat(63), 'c'.repeat(63), 'd'.repeat(length - 192)].join('.');
      expect(host(253)).toHaveLength(253);
      expect(checked(`https://${host(253)}/`)).toEqual([[`https://${host(253)}/`, `https://${host(253)}/`]]);
      expect(links(`https://${host(254)}/`)).toEqual([]);
    });

    it('takes no empty label, and a host loses a dot at its end', () => {
      expect(links('www..example.net')).toEqual([]);
      expect(checked('www.example.net./a')).toEqual([['www.example.net', 'http://www.example.net']]);
      expect(checked('www.example.net.')).toEqual([['www.example.net', 'http://www.example.net']]);
    });

    it('takes a port of 1 to 65535, and a colon with no digit after it ends the address', () => {
      expect(links('www.example.net:0')).toEqual([]);
      expect(checked('www.example.net:65535')).toEqual([['www.example.net:65535', 'http://www.example.net:65535']]);
      expect(links('www.example.net:65536')).toEqual([]);
      expect(links('www.example.net:123456')).toEqual([]);
      expect(checked('www.chimr.app: x')).toEqual([['www.chimr.app', 'http://www.chimr.app']]);
    });

    it('links a host in other letters through its xn-- form, and keeps the text as written', () => {
      expect(checked('https://bücher.example/')).toEqual([['https://bücher.example/', 'https://xn--bcher-kva.example/']]);
      expect(checked('https://пример.рф/')).toEqual([['https://пример.рф/', 'https://xn--e1afmkfd.xn--p1ai/']]);
      expect(checked('https://xn--bcher-kva.example/')).toEqual([['https://xn--bcher-kva.example/', 'https://xn--bcher-kva.example/']]);
      expect(links('www.ｅｘａｍｐｌｅ.com')).toEqual([]);
      expect(checked('https://Example.bücher.example/')).toEqual([['https://Example.bücher.example/', 'https://example.xn--bcher-kva.example/']]);
    });
  });

  it('takes no user name before the host, and links no part of an address that has one', () => {
    expect(links('http://a.example@b.test')).toEqual([]);
    expect(links('http://a.example:1@b.test')).toEqual([]);
    expect(links('https://a.example:pw@b.test/')).toEqual([]);
    expect(checked('www.a.example@b.test')).toEqual([['www.a.example@b.test', 'mailto:www.a.example@b.test']]);
  });

  // A host that ends at a format character shows one address and opens another: with more host after it, the address is text.
  describe('a format character inside a host', () => {
    const FORMAT: [string, string][] = [['00AD', '­'], ['200B', '​'], ['200D', '‍'], ['2060', '⁠']];

    it.each(FORMAT)('U+%s between two host labels, or inside one, makes the whole address text', (_code, mark) => {
      expect(links(`https://paypal${mark}.com/login`)).toEqual([]);
      expect(links(`https://paypal.co${mark}m/login`)).toEqual([]);
      expect(links(`www.paypal${mark}.com`)).toEqual([]);
      expect(links(`bob@paypal${mark}.com`)).toEqual([]);
      expect(links(`mailto:bob@paypal.co${mark}m?subject=hi`)).toEqual([]);
      expect(links(`https://paypal.co${mark}${mark}m/`)).toEqual([]);
    });

    it.each(FORMAT)('U+%s after a dot or a hyphen the host would end on, with more of a host after it, makes the whole address text', (_code, mark) => {
      expect(links(`https://paypal.co.${mark}uk/login`)).toEqual([]);
      expect(links(`https://paypal.co-${mark}uk.com/login`)).toEqual([]);
      expect(links(`https://pay-${mark}pal.com/`)).toEqual([]);
      expect(links(`www.paypal.co.${mark}uk`)).toEqual([]);
      expect(links(`bob@paypal.co.${mark}uk`)).toEqual([]);
      expect(links(`mailto:bob@paypal.co.${mark}uk?subject=x`)).toEqual([]);
    });

    it.each(FORMAT)('U+%s between a port and more digits makes the whole address text', (_code, mark) => {
      expect(links(`www.example.net:80${mark}80/x`)).toEqual([]);
    });

    it.each(FORMAT)('U+%s after a whole host with nothing of a host after it still ends the address there', (_code, mark) => {
      expect(checked(`https://example.net${mark} more`)).toEqual([['https://example.net', 'https://example.net']]);
      expect(checked(`https://example.net.${mark} more`)).toEqual([['https://example.net', 'https://example.net']]);
      expect(checked(`bob@example.net${mark}, hi`)).toEqual([['bob@example.net', 'mailto:bob@example.net']]);
      expect(checked(`https://example.net/a${mark}b`)).toEqual([['https://example.net/a', 'https://example.net/a']]);
    });

    it('stays linear with a long run of format characters after hosts', () => {
      expect(timed(() => findAddresses(`www.a.net${'​'.repeat(65_536)}x`)).ms).toBeLessThan(200);
      expect(timed(() => findAddresses('www.a.net​'.repeat(6_500))).ms).toBeLessThan(200);
    });
  });

  describe('e-mail', () => {
    it.each(['bob@example.net', 'bob.smith+tag@example.net', `${'a'.repeat(64)}@example.net`])('links %j', (written) => {
      expect(checked(written)).toEqual([[written, `mailto:${written}`]]);
    });

    it.each(['.bob@example.net', 'bob.@example.net', 'bo..b@example.net', `${'a'.repeat(65)}@example.net`, 'bob@localhost', 'bob@192.168.1.1', 'mailto:bob', 'mailto:'])(
      'finds nothing in %j',
      (written) => {
        expect(links(written)).toEqual([]);
      },
    );

    it('links mailto: with its query, and a bare address up to its host', () => {
      expect(checked('mailto:bob@example.net?subject=hi')).toEqual([['mailto:bob@example.net?subject=hi', 'mailto:bob@example.net?subject=hi']]);
      expect(checked('bob@example.net/path')).toEqual([['bob@example.net', 'mailto:bob@example.net']]);
      expect(checked('bob@example.net:25')).toEqual([['bob@example.net', 'mailto:bob@example.net']]);
    });
  });

  it('finds every address, left to right, and never one inside another', () => {
    expect(checked('see www.example.net or bob@example.net, then https://chimr.app/a?b=c@d.')).toEqual([
      ['www.example.net', 'http://www.example.net'],
      ['bob@example.net', 'mailto:bob@example.net'],
      ['https://chimr.app/a?b=c@d', 'https://chimr.app/a?b=c@d'],
    ]);
  });

  describe('in linear time', () => {
    it.each([
      ['a 64 KB run with no space', 'a'.repeat(65_536)],
      ["10,000 'www.' in one run", 'www.'.repeat(10_000)],
      ["10,000 '@'", '@'.repeat(10_000)],
      ["10,000 '('", '('.repeat(10_000)],
      ['5,000 addresses joined by commas', 'http://a.net,'.repeat(5_000)],
      // Each address ends at its host, and nothing after it is a stop or a `/`. The search for a user name must not run to the end each time.
      ['6,500 www addresses joined by commas, with no stop after them', 'www.a.net,'.repeat(6_500)],
      ['a 64 KB run of names and @', 'a_b@'.repeat(16_384)],
    ])('%s', (_name, text) => {
      expect(timed(() => findAddresses(text)).ms).toBeLessThan(200);
    });

    it('a 64 KB address', () => {
      const text = `https://example.net/${'a'.repeat(65_536)}`;
      const { value, ms } = timed(() => findAddresses(text));
      expect(value).toEqual([{ start: 0, end: text.length, link: text }]);
      expect(ms).toBeLessThan(200);
    });

    // Trimming runs in linear time, and the address stops at the right character.
    it('trims 32,768 unpaired closing brackets and full stops', () => {
      const text = `https://example.net/a${').'.repeat(32_768)}`;
      const { value, ms } = timed(() => links(text));
      expect(value).toEqual([['https://example.net/a', 'https://example.net/a']]);
      expect(ms).toBeLessThan(200);
    });

    it('links through the last balanced bracket and no further', () => {
      const address = `www.example.net/${'(a)'.repeat(10_000)}`;
      const text = `${address}${')'.repeat(10_000)}`;
      const { value, ms } = timed(() => links(text));
      expect(value).toEqual([[address, `http://${address}`]]);
      expect(ms).toBeLessThan(200);
    });

    it('finds one address in a line full of punctuation and brackets, and nothing else', () => {
      const noise = `.,:;!?'*_~()[]{}<>"`.repeat(14);
      const text = `${noise.slice(0, 243)} see www.example.net/x). ${noise.slice(0, 244)}`;
      expect(text).toHaveLength(512);
      expect(checked(text)).toEqual([['www.example.net/x', 'http://www.example.net/x']]);
    });
  });
});

describe('linkAddresses', () => {
  it('finds an address across two formatted runs: each piece keeps its formatting and both take one link', () => {
    const body: RichText = [{ text: 'see http://exa', bold: true }, { text: 'mple.com/a now' }];
    expect(linkAddresses(body)).toEqual([
      { text: 'see ', bold: true, source: 0, at: 0 },
      { text: 'http://exa', bold: true, link: 'http://example.com/a', found: true, source: 0, at: 4 },
      { text: 'mple.com/a', link: 'http://example.com/a', found: true, source: 1, at: 0 },
      { text: ' now', source: 1, at: 10 },
    ]);
  });

  it("never searches, splits or extends a sender's link, and an address before it ends at it", () => {
    const sender = { text: 'site', link: 'https://chimr.app' };
    const body: RichText = [{ text: 'see www.example.net' }, sender, { text: '/a' }];
    const shown = linkAddresses(body);
    expect(shown).toEqual([
      { text: 'see ', source: 0, at: 0 },
      { text: 'www.example.net', link: 'http://www.example.net', found: true, source: 0, at: 4 },
      { text: 'site', link: 'https://chimr.app', source: 1, at: 0 },
      { text: '/a', source: 2, at: 0 },
    ]);
    // Never inside a sender's link: its text is the sender's, not a found address.
    const linked: RichText = [{ text: 'https://example.net', link: 'https://chimr.app' }];
    expect(linkAddresses(linked)).toBe(linked);
    expect(linkAddresses(linked)[0]).toBe(linked[0]);
  });

  it("finds an address in the text of an anchor whose scheme was refused", () => {
    const body = parseAimHtml('<A HREF="javascript:x">https://example.net</A>');
    expect(body).toEqual([{ text: 'https://example.net' }]);
    expect(linkAddresses(body)).toEqual([{ text: 'https://example.net', link: 'https://example.net', found: true, source: 0, at: 0 }]);
  });

  it('gives back the body itself when nothing is found, never changes what it was given, and keeps one result per body', () => {
    const plain: RichText = [{ text: 'nothing here' }, { text: 'example.com', bold: true }];
    expect(linkAddresses(plain)).toBe(plain);
    const body = deepFreeze<RichText>([{ text: 'see www.example.net', italic: true }, { text: ' and %n' }]);
    const copy = structuredClone(body);
    const first = linkAddresses(body);
    expect(body).toEqual(copy);
    expect(linkAddresses(body)).toBe(first);
    const equal: RichText = structuredClone(copy);
    expect(linkAddresses(equal)).not.toBe(first);
    expect(linkAddresses(equal)).toEqual(first);
  });
});

describe('putInVariables and shownBody', () => {
  const text = (shown: ShownText): string => shown.map((run) => run.text).join('');
  const linksOf = (shown: ShownText): string[] => shown.flatMap((run) => (run.link === undefined ? [] : [run.link]));

  it('matches a token in the text as written: one straight after an address stays as typed', () => {
    const shown = shownBody([{ text: 'www.example.com%n' }], VALUES);
    expect(shown).toEqual([
      { text: 'www.example.com', link: 'http://www.example.com', found: true, source: 0, at: 0 },
      { text: '%n', source: 0, at: 15 },
    ]);
  });

  it('puts the tokens in outside an address and leaves one inside it as typed, in its text and its link', () => {
    const shown = shownBody([{ text: 'hi %n, www.example.com/~%n' }], VALUES);
    expect(text(shown)).toBe('hi chimr dev 1, www.example.com/~%n');
    expect(linksOf(shown)).toEqual(['http://www.example.com/~%n']);
    expect(shown.find((run) => run.found === true)?.text).toBe('www.example.com/~%n');
  });

  it('is expandAimVariables when nothing is found', () => {
    const body: RichText = [{ text: 'hi %n at %t' }, { text: '%d', bold: true }];
    const shown = linkAddresses(body);
    expect(shown).toBe(body);
    expect(putInVariables(body, shown, VALUES)).toEqual(expandAimVariables(body, VALUES));
    expect(shownBody(body, VALUES)).toEqual(expandAimVariables(body, VALUES));
    const none: RichText = [{ text: 'nothing to put in' }];
    expect(putInVariables(none, linkAddresses(none), VALUES)).toBe(none);
  });

  it('gives back what it was shown when there is nothing to put in', () => {
    const body: RichText = [{ text: 'see www.example.net 100%' }];
    const shown = linkAddresses(body);
    expect(putInVariables(body, shown, VALUES)).toBe(shown);
    expect(shownBody(body)).toBe(shown);
  });

  // The reader's name never reaches a found address.
  it.each([
    'www.example.com/~%n',
    'www.example.com/%n',
    'https://example.net/?who=%n',
    'https://example.net/#%n',
    'mailto:bob@example.net?subject=%n',
    '%n www.example.net/%n %n',
    'www.%n.com',
    '%n@example.net',
    'bob@example.net %n',
    'www.example.com%n',
    'see (www.example.net/%n) and %n',
    '%n https://example.net/a/%n/b/%d/%t',
  ])("never puts the reader's name into a found address: %j", (written) => {
    const shown = shownBody([{ text: written }], VALUES);
    for (const run of shown) {
      expect(run.link ?? '').not.toContain('chimr dev 1');
      if (run.found === true) expect(run.text).not.toContain('chimr dev 1');
    }
  });
});

it('every link found here parses as a URL with the protocol http:, https: or mailto:', () => {
  // The cases above fill it: run alone (-t, .only), this fails rather than checking nothing.
  expect(seen.length).toBeGreaterThan(0);
  for (const link of seen) expect(['http:', 'https:', 'mailto:']).toContain(new URL(link).protocol);
});
