import { describe, expect, it } from 'vitest';
import type { RichText, RichTextRun } from '../../../src/model/rich-text.js';
import { sanitizeRichText } from '../../../src/model/rich-text.js';

describe('sanitizeRichText', () => {
  const full: RichTextRun = { text: 'a', bold: true, color: '#AABBCC', face: 'Comic Sans MS', size: 7, link: 'HTTPS://chimr.app' };
  const rows: [string, unknown, RichText | null][] = [
    ['a string', 'x', null],
    ['null', null, null],
    ['a run whose text is not a string', [{ text: 1 }], null],
    ['a run that is not an object', ['a'], null],
    ['a run that is null', [null], null],
    ['513 runs', Array.from({ length: 513 }, () => ({ text: 'a' })), null],
    ['512 runs', Array.from({ length: 512 }, () => ({ text: 'a' })), Array.from({ length: 512 }, () => ({ text: 'a' }))],
    [
      'attributes that are not allowed',
      [{ text: 'a', bold: 'yes', color: 'red', face: 'x;}', size: 9, link: 'javascript:alert(1)', evil: 1 }],
      [{ text: 'a' }],
    ],
    ['attributes that are allowed', [full], [{ ...full, color: '#aabbcc' }]],
    ['italic, underline and a mailto link', [{ text: 'a', italic: true, underline: true, link: 'mailto:a@chimr.app' }], [{ text: 'a', italic: true, underline: true, link: 'mailto:a@chimr.app' }]],
    ['flags that are false, a size of 0 and a fractional size', [{ text: 'a', bold: false, italic: 1, size: 0 }, { text: 'b', size: 2.5 }], [{ text: 'a' }, { text: 'b' }]],
    ['a face of 65 characters', [{ text: 'a', face: 'f'.repeat(65) }], [{ text: 'a' }]],
    ['an empty run', [{ text: '' }, { text: 'b' }], [{ text: 'b' }]],
    ['an empty array', [], []],
  ];
  it.each(rows)('%s', (_label, value, want) => {
    expect(sanitizeRichText(value)).toEqual(want);
  });
});
