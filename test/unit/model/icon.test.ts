import { describe, expect, it } from 'vitest';
import {
  IMAGE_SIGNATURE_BYTES,
  OWN_ICON_GIF_MAX_PIXELS,
  acceptIcon,
  gifFrameCount,
  imageTypeOf,
  isIconHash,
  isOwnGif,
  isOwnIcon,
  sniffImage,
} from '../../../src/model/icon.js';
import {
  animatedGif,
  bmpHeader,
  gifHeader,
  jpegHeader,
  OWN_ICON_JPEG,
  paddedGif,
  pngHeader,
  screenGif,
  stillGif,
  withJpegComment,
} from '../../support/images.js';
import { md5Hex, pngImage } from '../../support/png.js';

const ascii = (text: string): Uint8Array => new TextEncoder().encode(text);

const bytesOf = (...parts: (Uint8Array | number[])[]): Uint8Array => Uint8Array.from(parts.flatMap((part) => [...part]));

/** The bytes followed by zero bytes up to `length`. */
const padded = (bytes: Uint8Array, length: number): Uint8Array => {
  const out = new Uint8Array(length);
  out.set(bytes);
  return out;
};

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const gif87a = (): Uint8Array => {
  const bytes = gifHeader(50, 50);
  bytes[4] = 0x37;
  return bytes;
};

/** `GIF89a`, a 5 × 5 screen, a global table of 2 colours, a graphic control extension, a 9 × 7 frame. */
const gifWithTableAndExtension = (): Uint8Array =>
  bytesOf(
    ascii('GIF89a'),
    [5, 0, 5, 0, 0x80, 0, 0],
    [0, 0, 0, 0, 0, 0],
    [0x21, 0xf9, 0x04, 0, 0, 0, 0, 0],
    [0x2c, 0, 0, 0, 0, 9, 0, 7, 0, 0],
  );

const bmpWithHeaderSize = (size: number): Uint8Array => {
  const bytes = bmpHeader(10, 20);
  bytes[14] = size;
  return bytes;
};

describe('imageTypeOf', () => {
  it('names the type from the first eight bytes alone', () => {
    expect(IMAGE_SIGNATURE_BYTES).toBe(8);
    expect(imageTypeOf(pngHeader(10, 10).subarray(0, 8))).toBe('png');
    expect(imageTypeOf(gifHeader(10, 10).subarray(0, 8))).toBe('gif');
    expect(imageTypeOf(bmpHeader(10, 10).subarray(0, 8))).toBe('bmp');
    expect(imageTypeOf(jpegHeader(10, 10).subarray(0, 8))).toBe('jpeg');
  });

  it('is null for anything else, and for fewer bytes than a signature', () => {
    expect(imageTypeOf(new TextEncoder().encode('<svg xmlns'))).toBeNull();
    expect(imageTypeOf(new Uint8Array(0))).toBeNull();
    expect(imageTypeOf(pngHeader(10, 10).subarray(0, 7))).toBeNull();
    expect(imageTypeOf(jpegHeader(10, 10).subarray(0, 2))).toBeNull();
  });
});

describe('sniffImage', () => {
  it.each([
    ['a PNG', pngHeader(64, 48), { type: 'png', width: 64, height: 48 }],
    ['a GIF89a', gifHeader(50, 50), { type: 'gif', width: 50, height: 50 }],
    ['a GIF87a', gif87a(), { type: 'gif', width: 50, height: 50 }],
    ['a BMP', bmpHeader(10, 20), { type: 'bmp', width: 10, height: 20 }],
    ['a top-down BMP', bmpHeader(10, -20), { type: 'bmp', width: 10, height: 20 }],
    ['a BMP with a core header', bmpHeader(7, 9, { core: true }), { type: 'bmp', width: 7, height: 9 }],
    ['a JPEG', jpegHeader(48, 32), { type: 'jpeg', width: 48, height: 32 }],
    ['a progressive JPEG', jpegHeader(48, 32, 0xc2), { type: 'jpeg', width: 48, height: 32 }],
    ['a JPEG with Exif and Photoshop segments', OWN_ICON_JPEG, { type: 'jpeg', width: 48, height: 48 }],
    ['a JPEG with a comment', withJpegComment(OWN_ICON_JPEG, 'run 1'), { type: 'jpeg', width: 48, height: 48 }],
    ['a whole PNG', pngImage(3, 2), { type: 'png', width: 3, height: 2 }],
  ])('reads the type and size of %s', (_name, bytes, expected) => {
    expect(sniffImage(bytes)).toEqual(expected);
  });

  it('a GIF is as large as its first frame when that is larger than its screen', () => {
    const hidden = gifHeader(1, 1, { width: 300, height: 20 });
    expect(sniffImage(hidden)).toEqual({ type: 'gif', width: 300, height: 20 });
    expect(acceptIcon(hidden)).toBeNull();
    expect(sniffImage(gifHeader(40, 40, { width: 10, height: 10 }))).toEqual({ type: 'gif', width: 40, height: 40 });
  });

  it("finds a GIF's first frame behind a colour table and an extension", () => {
    expect(sniffImage(gifWithTableAndExtension())).toEqual({ type: 'gif', width: 9, height: 7 });
  });

  it.each([
    ['no bytes', new Uint8Array(0)],
    ['an SVG', ascii('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')],
    ['HTML', ascii('<html>')],
    ['a GIF signature with no size', ascii('GIF89a')],
    ['a PNG cut before its size', pngHeader(64, 48).subarray(0, 20)],
    ['a PNG whose first chunk is not IHDR', bytesOf(PNG_SIGNATURE, [0, 0, 0, 13], ascii('tEXt'), new Uint8Array(17))],
    ['a PNG 0 pixels wide', pngHeader(0, 48)],
    ['a BMP 0 pixels wide', bmpHeader(0, 5)],
    ['a BMP with a header size of 13', bmpWithHeaderSize(13)],
    ['a JPEG with a table where its frame should be', jpegHeader(48, 32, 0xc4)],
    ['a JPEG scan with no frame', bytesOf([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02])],
    ['a JPEG segment length that runs past the end', bytesOf([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff])],
    ['a WebP', bytesOf(ascii('RIFF'), [0x24, 0, 0, 0], ascii('WEBPVP8 '))],
  ])('gives null for %s', (_name, bytes) => {
    expect(sniffImage(bytes)).toBeNull();
  });

  it('sniffImage never throws on truncated input', () => {
    const cases: [Uint8Array, number][] = [
      [OWN_ICON_JPEG.subarray(0, 200), 165],
      [pngImage(3, 2), 24],
      [gifWithTableAndExtension(), 10],
    ];
    for (const [bytes, sizeEnd] of cases) {
      for (let length = 0; length <= bytes.length; length++) {
        const prefix = bytes.subarray(0, length);
        let result: ReturnType<typeof sniffImage> | undefined;
        expect(() => {
          result = sniffImage(prefix);
        }).not.toThrow();
        if (length < sizeEnd) expect(result, `prefix of ${length} bytes`).toBeNull();
      }
      // The boundary is where the size ends, not somewhere past it.
      expect(sniffImage(bytes.subarray(0, sizeEnd))).not.toBeNull();
    }
  });
});

describe('acceptIcon', () => {
  it('accepts an icon up to 256 pixels a side and 65,536 bytes and nothing past either', () => {
    expect(acceptIcon(pngHeader(256, 256))).toEqual({ type: 'png', width: 256, height: 256 });
    expect(acceptIcon(pngHeader(257, 256))).toBeNull();
    expect(acceptIcon(pngHeader(256, 257))).toBeNull();
    expect(acceptIcon(padded(pngHeader(8, 8), 65_536))).toEqual({ type: 'png', width: 8, height: 8 });
    expect(acceptIcon(padded(pngHeader(8, 8), 65_537))).toBeNull();
    expect(acceptIcon(new Uint8Array(0))).toBeNull();
  });
});

describe('isOwnIcon', () => {
  it('an own icon is a 48 × 48 JPEG of at most 7,168 bytes', () => {
    expect(isOwnIcon(OWN_ICON_JPEG)).toBe(true);
    expect(isOwnIcon(jpegHeader(64, 64))).toBe(false);
    expect(isOwnIcon(pngHeader(48, 48))).toBe(false);
    expect(isOwnIcon(padded(jpegHeader(48, 48), 7_169))).toBe(false);
    expect(isOwnIcon(padded(jpegHeader(48, 48), 7_168))).toBe(true);
  });

  const wave = (): Uint8Array => animatedGif([220, 30, 30], [30, 30, 220], 10);

  it.each<[string, () => Uint8Array]>([
    ['an animated GIF of 1 × 1', wave],
    ['a GIF of 64 × 64', () => gifHeader(64, 64, { width: 64, height: 64 })],
    ['a still GIF of 48 × 48', () => stillGif(48, 48)],
    ['an animated GIF of exactly 7,168 bytes', () => paddedGif(wave(), 7_168)],
  ])('an own icon is also %s', (_what, make) => {
    expect(OWN_ICON_GIF_MAX_PIXELS).toBe(64);
    expect(isOwnIcon(make())).toBe(true);
    expect(isOwnGif(make())).toBe(true);
  });

  it.each<[string, () => Uint8Array]>([
    ['an animated GIF whose screen is 65 × 65', () => screenGif(wave(), 65, 65)],
    ['a GIF of 65 × 64', () => gifHeader(65, 64, { width: 65, height: 64 })],
    ['a GIF of 64 × 65', () => gifHeader(64, 65, { width: 64, height: 65 })],
    ['a GIF whose first frame is wider than its screen', () => gifHeader(1, 1, { width: 65, height: 1 })],
    ['an animated GIF of 7,169 bytes', () => paddedGif(wave(), 7_169)],
  ])('an own icon is not %s', (_what, make) => {
    expect(isOwnIcon(make())).toBe(false);
    expect(isOwnGif(make())).toBe(false);
  });

  it('a GIF is no JPEG and a PNG is neither', () => {
    expect(isOwnIcon(pngHeader(48, 48))).toBe(false);
    expect(isOwnGif(pngHeader(48, 48))).toBe(false);
    expect(isOwnGif(OWN_ICON_JPEG)).toBe(false);
  });
});

describe('gifFrameCount', () => {
  const wave = (): Uint8Array => animatedGif([220, 30, 30], [30, 30, 220], 10);

  it('counts the image descriptors of a GIF, and is 0 for anything else', () => {
    expect(gifFrameCount(wave())).toBe(2);
    expect(gifFrameCount(gifHeader(48, 48, { width: 48, height: 48 }))).toBe(1);
    expect(gifFrameCount(gifHeader(48, 48))).toBe(0);
    expect(gifFrameCount(stillGif(100, 100))).toBe(1);
    expect(gifFrameCount(pngHeader(48, 48))).toBe(0);
    expect(gifFrameCount(new Uint8Array(0))).toBe(0);
  });

  it('counts the frames before the cut of a file cut short, and never throws', () => {
    const whole = wave();
    for (let n = 0; n <= whole.length; n += 1) {
      const count = gifFrameCount(whole.subarray(0, n));
      expect(count, `${n} bytes`).toBeGreaterThanOrEqual(0);
      expect(count, `${n} bytes`).toBeLessThanOrEqual(2);
    }
    expect(gifFrameCount(whole.subarray(0, whole.length - 1))).toBe(2);
  });

  it('walks past a frame\'s local colour table and its image data', () => {
    const frame = (data: number): number[] => [
      // An image descriptor with a local table of 4 colours (packed 0x81), then the table.
      0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0x81,
      ...new Array<number>(12).fill(0x2c),
      // The LZW code size, a sub-block whose bytes look like introducers, and the block of size 0.
      0x02, 0x03, 0x2c, 0x21, data, 0x00,
    ];
    const gif = Uint8Array.from([...gifHeader(1, 1), ...frame(0x44), ...frame(0x4c), ...frame(0x44), 0x3b]);
    expect(gifFrameCount(gif)).toBe(3);
  });

  it('reads the frames of a GIF whose screen was changed: screenGif keeps them', () => {
    const big = screenGif(wave(), 65, 65);
    expect(sniffImage(big)).toEqual({ type: 'gif', width: 65, height: 65 });
    expect(gifFrameCount(big)).toBe(2);
    expect(paddedGif(wave(), 7_169)).toHaveLength(7_169);
    expect(gifFrameCount(paddedGif(wave(), 7_169))).toBe(2);
  });
});

describe('isIconHash', () => {
  it('a hash is 32 lower-case hex characters', () => {
    const hash = md5Hex(OWN_ICON_JPEG);
    expect(isIconHash(hash)).toBe(true);
    expect(isIconHash(hash.toUpperCase())).toBe(false);
    expect(isIconHash(hash.slice(0, 31))).toBe(false);
    expect(isIconHash(`${hash}0`)).toBe(false);
    expect(isIconHash('../../settings.json')).toBe(false);
    expect(isIconHash(`${hash.slice(0, 15)}/${hash.slice(16)}`)).toBe(false);
    expect(isIconHash(5)).toBe(false);
    expect(isIconHash(null)).toBe(false);
    expect(isIconHash(new Uint8Array(16))).toBe(false);
  });
});

describe('the test images', () => {
  it('the JPEG fixture is what its comment says', () => {
    expect(md5Hex(OWN_ICON_JPEG)).toBe('0b40f19917484bab1ef5a45cc0c6c381');
    expect(OWN_ICON_JPEG).toHaveLength(819);
    const a = md5Hex(withJpegComment(OWN_ICON_JPEG, 'a'));
    const b = md5Hex(withJpegComment(OWN_ICON_JPEG, 'b'));
    expect(a).not.toBe(b);
    expect(a).not.toBe(md5Hex(OWN_ICON_JPEG));
    expect(b).not.toBe(md5Hex(OWN_ICON_JPEG));
  });
});
