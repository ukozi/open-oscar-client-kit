const FIRST_BYTES = 4096;

/** Bytes that come in pieces, in one buffer. The buffer doubles, and the limit is the most it holds. */
export class ByteStore {
  private buffer: Uint8Array;
  private have = 0;

  constructor(private readonly limit: number) {
    this.buffer = new Uint8Array(Math.min(FIRST_BYTES, limit));
  }

  get length(): number {
    return this.have;
  }

  get capacity(): number {
    return this.buffer.length;
  }

  /** Copies the piece. The caller can use the piece again. */
  add(piece: Uint8Array): void {
    const need = this.have + piece.length;
    if (need > this.limit) throw new RangeError('the piece passes the limit');
    if (need > this.buffer.length) {
      let size = Math.max(this.buffer.length, 1);
      while (size < need) size *= 2;
      const next = new Uint8Array(Math.min(size, this.limit));
      next.set(this.buffer.subarray(0, this.have));
      this.buffer = next;
    }
    this.buffer.set(piece, this.have);
    this.have = need;
  }

  bytes(): Uint8Array {
    return this.buffer.subarray(0, this.have);
  }
}
