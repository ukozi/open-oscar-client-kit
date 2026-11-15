export const MAX_SCREEN_NAME_BYTES = 16;

export function utf8ByteLength(s: string): number {
  let bytes = 0;
  for (const char of s) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint < 0x80) bytes += 1;
    else if (codePoint < 0x800) bytes += 2;
    else if (codePoint > 0xffff) bytes += 4;
    else bytes += 3;
  }
  return bytes;
}

/** A copy of the wire codec's, since the model imports nothing outside itself; a test keeps them equal. */
export function normalizeScreenName(raw: string): string {
  return raw.replace(/ /g, '').toLowerCase();
}

export function isValidScreenName(name: string): boolean {
  if (utf8ByteLength(name) > MAX_SCREEN_NAME_BYTES) return false;
  if (!/^[\p{L}\p{Nd} ]+$/u.test(name)) return false;
  const chars = [...name];
  if (chars.filter((char) => /[\p{L}\p{Nd}]/u.test(char)).length < 3) return false;
  if (!/\p{L}/u.test(chars[0] ?? '')) return false;
  return chars[chars.length - 1] !== ' ';
}
