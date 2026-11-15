import { describe, expect, it } from 'vitest';
import { parseAimHtml, richTextToAimHtml } from '../../../src/client/aim-html.js';
import { HOST_NAME, LINK_NOISE } from '../../../src/model/found-links.js';
import type { RichText } from '../../../src/model/rich-text.js';

describe('parseAimHtml', () => {
  const rows: [string, string, RichText][] = [
    ['plain text', 'hello', [{ text: 'hello' }]],
    ['empty', '', []],
    ['classic wrapper', '<HTML><BODY BGCOLOR="#ffffff"><FONT FACE="Arial" SIZE=2 COLOR="#FF0000">hi</FONT></BODY></HTML>', [{ text: 'hi', color: '#ff0000', face: 'Arial', size: 2 }]],
    ['bold, italic, underline', '<B>a</B><I>b</I><U>c</U>', [{ text: 'a', bold: true }, { text: 'b', italic: true }, { text: 'c', underline: true }]],
    ['nesting', '<B>a<I>b</I>c</B>', [{ text: 'a', bold: true }, { text: 'b', bold: true, italic: true }, { text: 'c', bold: true }]],
    ['line break', 'a<BR>b<br/>c', [{ text: 'a\nb\nc' }]],
    ['CRLF', 'a\r\nb', [{ text: 'a\nb' }]],
    ['link', '<A HREF="https://chimr.app/">site</A>', [{ text: 'site', link: 'https://chimr.app/' }]],
    ['mailto link, upper-case scheme', '<a href="MAILTO:a@b.test">mail</a>', [{ text: 'mail', link: 'MAILTO:a@b.test' }]],
    ['entities, once', 'a &amp;lt; b &#233; &#x1F642; &quot;q&quot;', [{ text: 'a &lt; b é 🙂 "q"' }]],
    ['nested font overrides only what it carries', '<FONT COLOR="red" SIZE=3>a<FONT SIZE=5>b</FONT>c</FONT>', [{ text: 'a', color: '#ff0000', size: 3 }, { text: 'b', color: '#ff0000', size: 5 }, { text: 'c', color: '#ff0000', size: 3 }]],
    ['short hex colour', '<FONT COLOR="#0F8">x</FONT>', [{ text: 'x', color: '#00ff88' }]],
    ['adjacent runs with the same formatting merge', '<B>a</B><B>b</B>', [{ text: 'ab', bold: true }]],
    // An address another client wrote without a scheme is a link when it is a host name, and goes to it over https.
    ['a link to a www host with no scheme', '<A HREF="www.example.net">x</A>', [{ text: 'x', link: 'https://www.example.net' }]],
    ['a link to a bare host with a port, path, query and fragment', '<A HREF="Example.co.uk:8080/a/b?c=d#e">x</A>', [{ text: 'x', link: 'https://Example.co.uk:8080/a/b?c=d#e' }]],
    ['a link to a punycode host', '<A HREF="xn--bcher-kva.xn--p1ai/">x</A>', [{ text: 'x', link: 'https://xn--bcher-kva.xn--p1ai/' }]],
    // Quote marks and invisible characters, the text-direction marks among them, are no part of an address.
    ['quote marks and invisible characters are taken out of an address', '<A HREF=\'https://a.test/\u202Egnp.exe"?q=\u201Cx\u201D\u200B&#8207;\'>x</A>', [{ text: 'x', link: 'https://a.test/gnp.exe?q=x' }]],
    ["an apostrophe stays: addresses use it", '<A HREF="https://en.wikipedia.org/wiki/O\'Brien">x</A>', [{ text: 'x', link: "https://en.wikipedia.org/wiki/O'Brien" }]],
  ];
  it.each(rows)('%s', (_name, html, want) => {
    expect(parseAimHtml(html)).toEqual(want);
  });

  const hostile: [string, string, RichText][] = [
    ['a script link keeps its text and loses the link', '<A HREF="javascript:alert(1)">click</A>', [{ text: 'click' }]],
    ['a scheme hidden by entities and whitespace', '<A HREF="java&#115;cript:&#10;alert(1)">x</A>', [{ text: 'x' }]],
    ['a link with no scheme that is no host name', '<A HREF="example">a</A><A HREF="/path">b</A><A HREF="user@example.net">c</A><A HREF="1.2.3.4">d</A>', [{ text: 'abcd' }]],
    ['a scheme-less address with a scheme of its own further on', '<A HREF="example.net:alert(1)">x</A>', [{ text: 'x' }]],
    ['a host name in letters other than ASCII is not taken for one', '<A HREF="www.exаmple.net">x</A>', [{ text: 'x' }]],
    ['other schemes', '<A HREF="aim:goim?screenname=a">a</A><A HREF="ftp://h/">b</A><A HREF="file:///etc/passwd">c</A>', [{ text: 'abc' }]],
    ['an unknown tag is dropped and its text kept', '<SCRIPT>alert(1)</SCRIPT><IMG SRC="x" ONERROR="y">ok<MARQUEE>z</MARQUEE>', [{ text: 'alert(1)okz' }]],
    ['a typed tag stays text', '&lt;b&gt;not bold&lt;/b&gt;', [{ text: '<b>not bold</b>' }]],
    ['an unclosed tag closes at the end', '<B>a<I>b', [{ text: 'a', bold: true }, { text: 'b', bold: true, italic: true }]],
    ['a stray closing tag is ignored', 'a</B>b</FONT>', [{ text: 'ab' }]],
    ['a tag that never ends is text', 'a <B oops', [{ text: 'a <B oops' }]],
    ['a lone < is text', '1 < 2 <3', [{ text: '1 < 2 <3' }]],
    ['> inside a quoted attribute', '<A HREF="https://a.test/?q=1>2">x</A>', [{ text: 'x', link: 'https://a.test/?q=1>2' }]],
    ['an invalid colour', '<FONT COLOR="expression(1)">x</FONT><FONT COLOR="#12">y</FONT>', [{ text: 'xy' }]],
    ['an invalid face', '<FONT FACE="Arial;}body{">x</FONT>', [{ text: 'x' }]],
    ['a face of 65 characters', `<FONT FACE="${'a'.repeat(65)}">x</FONT>`, [{ text: 'x' }]],
    ['sizes are clamped', '<FONT SIZE=0>a</FONT><FONT SIZE=99>b</FONT><FONT SIZE="-3">c</FONT><FONT SIZE="big">d</FONT>', [{ text: 'a', size: 1 }, { text: 'b', size: 7 }, { text: 'c', size: 1 }, { text: 'd' }]],
    ['a comment is dropped', 'a<!-- <B> -->b', [{ text: 'ab' }]],
    ['an invalid code point reference', '&#0;&#xD800;', [{ text: '��' }]],
  ];
  it.each(hostile)('hostile input: %s', (_name, html, want) => {
    expect(parseAimHtml(html)).toEqual(want);
  });

  // One IM body can fill a 64 KB FLAP frame, and the socket's data handler parses it, so the work must stay linear.
  const timed = (html: string): { runs: RichText; ms: number } => {
    const start = performance.now();
    const runs = parseAimHtml(html);
    return { runs, ms: performance.now() - start };
  };

  it('parses 16,000 unclosed tags in linear time', () => {
    const { runs, ms } = timed('<b>x'.repeat(16000));
    expect(runs).toEqual([{ text: 'x'.repeat(16000), bold: true }]);
    expect(ms).toBeLessThan(200);
  });

  it('parses 9,000 closing tags that match nothing over 9,000 open ones in linear time', () => {
    const { runs, ms } = timed(`${'<b>'.repeat(9000)}${'</i>'.repeat(9000)}x`);
    expect(runs).toEqual([{ text: 'x', bold: true }]);
    expect(ms).toBeLessThan(200);
  });

  const colour = (n: number): string => `#0000${n.toString(16).padStart(2, '0')}`;
  const fonts = (n: number): string => Array.from({ length: n }, (_, i) => `<FONT COLOR="${colour(i + 1)}">`).join('');

  it('keeps the first 32 open tags and reads past deeper ones, text included', () => {
    expect(parseAimHtml(`${fonts(40)}deep`)).toEqual([{ text: 'deep', color: colour(32) }]);
  });

  it('pairs a closing tag with the open tag it belongs to when that one was past the cap', () => {
    // Eight closes end the eight tags that were not kept; the ninth ends the 32nd.
    const html = `${fonts(40)}a${'</FONT>'.repeat(8)}b</FONT>c${'</FONT>'.repeat(31)}d`;
    expect(parseAimHtml(html)).toEqual([{ text: 'ab', color: colour(32) }, { text: 'c', color: colour(31) }, { text: 'd' }]);
  });
});

describe('richTextToAimHtml', () => {
  it('writes each run with its markup, link outermost', () => {
    expect(richTextToAimHtml([{ text: 'hi', bold: true, italic: true, underline: true, color: '#ff0000', face: 'Arial', size: 4, link: 'https://x.test/?a=1&b=2' }]))
      .toBe('<A HREF="https://x.test/?a=1&amp;b=2"><FONT COLOR="#ff0000" FACE="Arial" SIZE="4"><B><I><U>hi</U></I></B></FONT></A>');
  });
  it('escapes text and writes line breaks', () => {
    expect(richTextToAimHtml([{ text: 'a < b & c > d\ne' }])).toBe('a &lt; b &amp; c &gt; d<BR>e');
  });
  it('leaves out a link, face or colour that the rules refuse', () => {
    expect(richTextToAimHtml([{ text: 'x', link: 'javascript:1', face: 'a"b', color: 'red' }])).toBe('x');
  });
  it('writes one line break for a carriage return and line feed', () => {
    expect(richTextToAimHtml([{ text: 'a\r\nb\rc' }])).toBe('a<BR>b<BR>c');
  });
  it('keeps SIZE inside 1 to 7 and leaves out a size that is not a whole number', () => {
    const sized = (size: number): string => richTextToAimHtml([{ text: 'x', size: size as unknown as 1 }]);
    expect([sized(9), sized(0), sized(2.5)]).toEqual(['<FONT SIZE="7">x</FONT>', '<FONT SIZE="1">x</FONT>', 'x']);
  });
  it('strips whitespace and control characters from a link so it reads back the same', () => {
    const html = richTextToAimHtml([{ text: 'x', link: 'https://exa mple.com/\n\tp' }]);
    expect(html).toContain('HREF="https://example.com/p"');
    expect(parseAimHtml(html)).toEqual([{ text: 'x', link: 'https://example.com/p' }]);
  });
  it('strips quote marks and invisible characters from a link as the parser does', () => {
    const html = richTextToAimHtml([{ text: 'x', link: 'https://a.test/\u202E"q"\u200F\u00AB\u00BB' }]);
    expect(html).toBe('<A HREF="https://a.test/q">x</A>');
    expect(parseAimHtml(html)).toEqual([{ text: 'x', link: 'https://a.test/q' }]);
  });
  it('writes plain text with no wrapper', () => {
    expect(richTextToAimHtml([{ text: 'plain' }])).toBe('plain');
    expect(richTextToAimHtml([])).toBe('');
  });
  it('round-trips through the parser', () => {
    const runs: RichText = [
      { text: 'a <b> & ' }, { text: 'bold', bold: true }, { text: ' line\nnext 🙂 привет', italic: true, color: '#0000ff' },
      { text: 'link', link: "https://chimr.app/?q='x'&y=1", size: 7, face: 'Comic Sans MS' },
    ];
    expect(parseAimHtml(richTextToAimHtml(runs))).toEqual(runs);
  });
});

describe('the link rule', () => {
  it('is the host part of the rule, and the noise, unchanged', () => {
    expect([HOST_NAME.source, HOST_NAME.flags]).toEqual(['(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})', 'i']);
    expect(LINK_NOISE.flags).toBe('gu');
    expect('a "b\u201cc\u202e\u200bd'.replace(LINK_NOISE, '')).toBe('abcd');
  });

  it('writes no link for an address typed as text', () => {
    expect(richTextToAimHtml([{ text: 'see www.example.net and bob@example.net' }])).not.toMatch(/<A/i);
  });
});
