import { describe, expect, it } from 'vitest';
import { parseAimHtml } from '../../../src/client/aim-html.js';
import { encodedLocateLength, locateText } from '../../../src/client/profiles.js';
import type { RichText } from '../../../src/model/rich-text.js';

describe('locateText', () => {
  it('writes every character above U+007F as one decimal reference per code point', () => {
    const body: RichText = [{ text: 'café 😀', bold: true }];
    expect(locateText(body)).toBe('<B>caf&#233; &#128512;</B>');
    expect(encodedLocateLength(body)).toBe(26);
  });

  it('an emoji and an accent survive the round trip', () => {
    const body: RichText = [{ text: 'naïve 😀 日本' }];
    expect(parseAimHtml(locateText(body))).toEqual(body);
  });
});
