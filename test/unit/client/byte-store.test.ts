import { describe, expect, it } from 'vitest';
import { ByteStore } from '../../../src/client/byte-store.js';

function content(bytes: number): Uint8Array {
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) out[i] = (i * 31 + 7) & 0xff;
  return out;
}

describe('ByteStore', () => {
  it('a limit of 16 MiB with no bytes holds at most 4096 bytes', () => {
    const store = new ByteStore(16 * 1024 * 1024);
    expect(store.capacity).toBeLessThanOrEqual(4096);
    expect(store.length).toBe(0);
  });

  it('300 KB in pieces of one byte: the capacity is never more than twice the bytes that came, and the bytes are equal', () => {
    const data = content(300 * 1024);
    const store = new ByteStore(16 * 1024 * 1024);
    const first = store.capacity;
    let grown = 0;
    let before = store.capacity;
    for (let i = 0; i < data.length; i++) {
      store.add(data.subarray(i, i + 1));
      if (store.capacity !== before) grown += 1;
      before = store.capacity;
      if (store.capacity > Math.max(first, 2 * (i + 1))) throw new Error(`capacity ${store.capacity} at ${i + 1} bytes`);
    }
    expect(grown).toBeLessThanOrEqual(8);
    expect(store.length).toBe(data.length);
    expect(store.bytes()).toEqual(data);
  });

  it('the capacity is never more than the limit', () => {
    const store = new ByteStore(5000);
    store.add(content(4096));
    store.add(content(904));
    expect(store.capacity).toBe(5000);
    expect(store.bytes()).toEqual(new Uint8Array([...content(4096), ...content(904)]));
  });

  it('a limit below 4096 sizes the first buffer', () => {
    expect(new ByteStore(2).capacity).toBe(2);
    expect(new ByteStore(0).bytes()).toEqual(new Uint8Array(0));
  });

  it('a piece that passes the limit throws a RangeError and adds nothing', () => {
    const store = new ByteStore(3);
    store.add(content(2));
    expect(() => store.add(content(2))).toThrow(RangeError);
    expect(store.length).toBe(2);
  });

  it('a piece that the caller changes later does not change the bytes', () => {
    const store = new ByteStore(10);
    const piece = new Uint8Array([1, 2, 3]);
    store.add(piece);
    piece[0] = 9;
    store.add(piece);
    expect(store.bytes()).toEqual(new Uint8Array([1, 2, 3, 9, 2, 3]));
  });

  it('one piece of 64 KB grows the buffer to hold it', () => {
    const store = new ByteStore(1024 * 1024);
    store.add(content(64 * 1024));
    expect(store.capacity).toBeLessThanOrEqual(2 * 64 * 1024);
    expect(store.bytes()).toEqual(content(64 * 1024));
  });
});
