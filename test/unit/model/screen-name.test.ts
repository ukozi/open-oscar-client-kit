import { describe, expect, it } from 'vitest';
import { normalizeScreenName as codecNormalizeScreenName } from '../../../src/wire/text.js';
import { isValidScreenName, normalizeScreenName, utf8ByteLength } from '../../../src/model/screen-name.js';

describe('isValidScreenName', () => {
  const rows: [string, boolean][] = [
    ['chimr dev 1', true],
    ['abc', true],
    ['a23', true],
    ['abcdefghijklmnop', true],           // 16 bytes
    ['abcdefghijklmnopq', false],         // 17 bytes
    ['ab cd ef gh ij kl', false],         // 17 bytes with spaces
    ['a  b', false],                      // 2 letters or digits
    ['ab', false],
    ['1abc', false],                      // starts with a digit
    [' abc', false],                      // starts with a space
    ['abc ', false],                      // ends with a space
    ['ab_c', false],
    ['ab.c', false],
    ['', false],
    ['éabc', true],                       // letters are any Unicode letter; 5 bytes
    ['ééééééééa', false],                 // 17 bytes
  ];
  it.each(rows)('%j -> %s', (name, want) => {
    expect(isValidScreenName(name)).toBe(want);
  });
});

describe('utf8ByteLength', () => {
  it.each([['abc', 3], ['é', 2], ['€', 3], ['🙂', 4], ['', 0]] as [string, number][])('%j is %i bytes', (s, n) => {
    expect(utf8ByteLength(s)).toBe(n);
  });
});

describe('normalizeScreenName', () => {
  it("normalizeScreenName agrees with the codec's for every input", () => {
    const inputs = ['Chimr Dev 2', 'chimrdev2', ' A  b ', '', 'ÀB c', 'tab\tname'];
    expect(inputs.map(normalizeScreenName)).toEqual(inputs.map(codecNormalizeScreenName));
    expect(normalizeScreenName('Chimr Dev 2')).toBe('chimrdev2');
  });
});
