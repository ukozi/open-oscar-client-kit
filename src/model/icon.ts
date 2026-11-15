export type ImageType = 'gif' | 'jpeg' | 'png' | 'bmp';
export type ImageInfo = { type: ImageType; width: number; height: number };

export const ICON_MAX_BYTES = 65_536;
export const ICON_MAX_PIXELS = 256;
export const OWN_ICON_PIXELS = 48;
export const OWN_ICON_MAX_BYTES = 7_168;
export const OWN_ICON_GIF_MAX_PIXELS = 64;

export const IMAGE_MIME: Readonly<Record<ImageType, string>> = {
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  png: 'image/png',
  bmp: 'image/bmp',
};

function hasBytes(view: DataView, offset: number, expected: readonly number[]): boolean {
  if (view.byteLength < offset + expected.length) return false;
  return expected.every((byte, i) => view.getUint8(offset + i) === byte);
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_IHDR = [0x49, 0x48, 0x44, 0x52];

function sniffPng(view: DataView): ImageInfo | null {
  if (view.byteLength < 24) return null;
  if (!hasBytes(view, 12, PNG_IHDR)) return null;
  return { type: 'png', width: view.getUint32(16), height: view.getUint32(20) };
}

const GIF87A = [0x47, 0x49, 0x46, 0x38, 0x37, 0x61];
const GIF89A = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];

function gifFirstFrame(view: DataView): { width: number; height: number } | null {
  const end = view.byteLength;
  if (end < 13) return null;
  const packed = view.getUint8(10);
  let at = 13;
  if ((packed & 0x80) !== 0) at += 3 * 2 ** ((packed & 7) + 1);
  while (at < end) {
    const introducer = view.getUint8(at);
    if (introducer === 0x2c) {
      if (end < at + 9) return null;
      return { width: view.getUint16(at + 5, true), height: view.getUint16(at + 7, true) };
    }
    if (introducer !== 0x21) return null;
    at += 2;
    for (;;) {
      if (at >= end) return null;
      const size = view.getUint8(at);
      at += 1 + size;
      if (size === 0) break;
    }
  }
  return null;
}

export function gifFrameCount(bytes: Uint8Array): number {
  if (imageTypeOf(bytes) !== 'gif') return 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = view.byteLength;
  if (end < 13) return 0;
  const packed = view.getUint8(10);
  let at = 13;
  if ((packed & 0x80) !== 0) at += 3 * 2 ** ((packed & 7) + 1);
  let count = 0;
  const skipSubBlocks = (): boolean => {
    for (;;) {
      if (at >= end) return false;
      const size = view.getUint8(at);
      at += 1 + size;
      if (size === 0) return true;
    }
  };
  while (at < end) {
    const introducer = view.getUint8(at);
    if (introducer === 0x2c) {
      if (end < at + 10) return count;
      count += 1;
      const local = view.getUint8(at + 9);
      at += 10;
      if ((local & 0x80) !== 0) at += 3 * 2 ** ((local & 7) + 1);
      at += 1;
      if (!skipSubBlocks()) return count;
    } else if (introducer === 0x21) {
      at += 2;
      if (!skipSubBlocks()) return count;
    } else {
      return count;
    }
  }
  return count;
}

function sniffGif(view: DataView): ImageInfo | null {
  if (view.byteLength < 10) return null;
  const frame = gifFirstFrame(view);
  // Browsers enlarge the canvas to a first frame that exceeds the screen.
  return {
    type: 'gif',
    width: Math.max(view.getUint16(6, true), frame?.width ?? 0),
    height: Math.max(view.getUint16(8, true), frame?.height ?? 0),
  };
}

function sniffBmp(view: DataView): ImageInfo | null {
  if (view.byteLength < 18) return null;
  const headerSize = view.getUint32(14, true);
  if (headerSize === 12) {
    if (view.byteLength < 22) return null;
    return { type: 'bmp', width: view.getUint16(18, true), height: view.getUint16(20, true) };
  }
  if (headerSize >= 40) {
    if (view.byteLength < 26) return null;
    // A negative height is a top-down bitmap.
    return { type: 'bmp', width: view.getInt32(18, true), height: Math.abs(view.getInt32(22, true)) };
  }
  return null;
}

function sniffJpeg(view: DataView): ImageInfo | null {
  const end = view.byteLength;
  let at = 2;
  for (;;) {
    if (at >= end || view.getUint8(at) !== 0xff) return null;
    while (at < end && view.getUint8(at) === 0xff) at += 1;
    if (at >= end) return null;
    const marker = view.getUint8(at);
    at += 1;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xda || marker === 0xd9) return null;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (end < at + 7) return null;
      return { type: 'jpeg', width: view.getUint16(at + 5), height: view.getUint16(at + 3) };
    }
    if (end < at + 2) return null;
    const length = view.getUint16(at);
    if (length < 2) return null;
    at += length;
  }
}

export const IMAGE_SIGNATURE_BYTES = 8;

export function imageTypeOf(bytes: Uint8Array): ImageType | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (hasBytes(view, 0, PNG_SIGNATURE)) return 'png';
  if (hasBytes(view, 0, GIF87A) || hasBytes(view, 0, GIF89A)) return 'gif';
  if (hasBytes(view, 0, [0x42, 0x4d])) return 'bmp';
  if (hasBytes(view, 0, [0xff, 0xd8, 0xff])) return 'jpeg';
  return null;
}

const SNIFF: Readonly<Record<ImageType, (view: DataView) => ImageInfo | null>> = { png: sniffPng, gif: sniffGif, bmp: sniffBmp, jpeg: sniffJpeg };

export function sniffImage(bytes: Uint8Array): ImageInfo | null {
  const type = imageTypeOf(bytes);
  if (type === null) return null;
  const info = SNIFF[type](new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  if (info === null || info.width <= 0 || info.height <= 0) return null;
  return info;
}

export function acceptIcon(bytes: Uint8Array): ImageInfo | null {
  if (bytes.length < 1 || bytes.length > ICON_MAX_BYTES) return null;
  const info = sniffImage(bytes);
  if (info === null || info.width > ICON_MAX_PIXELS || info.height > ICON_MAX_PIXELS) return null;
  return info;
}

export function isOwnGif(bytes: Uint8Array): boolean {
  if (bytes.length > OWN_ICON_MAX_BYTES) return false;
  const info = sniffImage(bytes);
  return info !== null && info.type === 'gif' && info.width <= OWN_ICON_GIF_MAX_PIXELS && info.height <= OWN_ICON_GIF_MAX_PIXELS;
}

export function isOwnIcon(bytes: Uint8Array): boolean {
  if (bytes.length > OWN_ICON_MAX_BYTES) return false;
  const info = sniffImage(bytes);
  if (info === null) return false;
  if (info.type === 'jpeg') return info.width === OWN_ICON_PIXELS && info.height === OWN_ICON_PIXELS;
  return isOwnGif(bytes);
}

export function isIconHash(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
}
