import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { OftError, receiveFile, receiveFiles, sendFile, sendFiles } from '../../../src/client/oft-session.js';
import type { OftFailure } from '../../../src/client/oft-session.js';
import { PeerClosedError, openPeerLink } from '../../../src/client/peer-link.js';
import type { PeerLink } from '../../../src/client/peer-link.js';
import type { FileSink, IncomingFile, OutgoingFile, TransferProgress } from '../../../src/model/transfer.js';
import {
  OFT_ACK, OFT_CHECKSUM_START, OFT_DONE, OFT_PROMPT, OFT_RESUME, OFT_RESUME_ACK, OFT_RESUME_ANSWER, decodeOftHeader,
  encodeOftHeader, oftChecksum, oftHeaderLength, sameOftChecksum,
} from '../../../src/wire/oft.js';
import type { OftHeader } from '../../../src/wire/oft.js';
import { ManualTimers, captureLog } from '../../fake/oscar-client.js';

const COOKIE = 0x0102030405060708n;
const OTHER_COOKIE = 0x1112131415161718n;
const CHUNK_MAX = 32 * 1024;

// One end of a connection in memory. `sent` holds each write of this end.
class MemoryLink implements PeerLink {
  readonly sent: Uint8Array[] = [];
  peer!: MemoryLink;
  private inbox: Uint8Array[] = [];
  private buffered = 0;
  private ended = false;
  private shut = false;
  private wake: (() => void) | null = null;

  get closed(): boolean {
    return this.shut;
  }

  write(bytes: Uint8Array): Promise<void> {
    if (this.shut || this.peer.shut) return Promise.reject(new PeerClosedError());
    const copy = bytes.slice();
    this.sent.push(copy);
    if (copy.length > 0) this.peer.put(copy);
    return Promise.resolve();
  }

  async read(n: number): Promise<Uint8Array> {
    while (this.buffered < n) {
      if (this.ended) throw new PeerClosedError();
      await this.more();
    }
    return this.take(n);
  }

  async readSome(max: number): Promise<Uint8Array | null> {
    while (this.buffered === 0) {
      if (this.shut) throw new PeerClosedError();
      if (this.ended) return null;
      await this.more();
    }
    return this.take(Math.min(max, this.buffered));
  }

  close(): void {
    if (this.shut) return;
    this.shut = true;
    this.ended = true;
    this.inbox = [];
    this.buffered = 0;
    this.woken();
    this.peer.end();
  }

  private put(bytes: Uint8Array): void {
    if (this.shut) return;
    this.inbox.push(bytes);
    this.buffered += bytes.length;
    this.woken();
  }

  private end(): void {
    this.ended = true;
    this.woken();
  }

  private woken(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  private more(): Promise<void> {
    if (this.wake) return Promise.reject(new Error('a read is in progress'));
    return new Promise((resolve) => {
      this.wake = resolve;
    });
  }

  private take(n: number): Uint8Array {
    const out = new Uint8Array(n);
    let at = 0;
    while (at < n) {
      const chunk = this.inbox[0] as Uint8Array;
      const part = Math.min(chunk.length, n - at);
      out.set(chunk.subarray(0, part), at);
      at += part;
      if (part === chunk.length) this.inbox.shift();
      else this.inbox[0] = chunk.subarray(part);
    }
    this.buffered -= n;
    return out;
  }
}

function pair(): [MemoryLink, MemoryLink] {
  const a = new MemoryLink();
  const b = new MemoryLink();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

function content(bytes: number, seed = 7): Uint8Array {
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) out[i] = (i * 31 + seed) & 0xff;
  return out;
}

function joined(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

async function* pieces(data: Uint8Array, size: number): AsyncIterable<Uint8Array> {
  for (let at = 0; at < data.length; at += size) yield data.subarray(at, at + size);
}

// A source in memory. `passes` counts the calls to read.
function source(name: string, data: Uint8Array, size = 5000): OutgoingFile & { passes: number } {
  const file = {
    name,
    bytes: data.length,
    modifiedAt: 1_700_000_000,
    passes: 0,
    read(): AsyncIterable<Uint8Array> {
      file.passes += 1;
      return pieces(data, size);
    },
  };
  return file;
}

type Taken = { file: IncomingFile; chunks: Uint8Array[]; finished: number; aborted: number };

// A sink in memory. `onWrite` runs before each chunk is kept.
function memorySink(onWrite?: (taken: Taken) => void | Promise<void>): FileSink & { files: Taken[] } {
  const files: Taken[] = [];
  return {
    files,
    begin: async (file) => {
      const taken: Taken = { file, chunks: [], finished: 0, aborted: 0 };
      files.push(taken);
      return {
        write: async (chunk) => {
          await onWrite?.(taken);
          taken.chunks.push(chunk.slice());
        },
        finish: async () => {
          taken.finished += 1;
        },
        abort: async () => {
          taken.aborted += 1;
        },
      };
    },
  };
}

function prompt(data: Uint8Array, over: Partial<OftHeader> = {}): OftHeader {
  return {
    type: OFT_PROMPT, cookie: COOKIE, totalFiles: 1, filesLeft: 1, totalParts: 1, partsLeft: 1, totalBytes: data.length,
    bytes: data.length, modifiedAt: 1_700_000_000, checksum: oftChecksum(data), received: 0, receivedChecksum: OFT_CHECKSUM_START,
    nameEncoding: 0, name: 'notes.txt', ...over,
  };
}

async function header(link: PeerLink): Promise<OftHeader> {
  const first = await link.read(6);
  return decodeOftHeader(joined([first, await link.read(oftHeaderLength(first) - 6)]));
}

async function failure(run: Promise<void>): Promise<OftFailure | 'resolved' | 'other'> {
  try {
    await run;
    return 'resolved';
  } catch (error) {
    return error instanceof OftError ? error.failure : 'other';
  }
}

// Two connections to one listener on loopback. The listener copies each one to the other.
async function socketPair(): Promise<{ a: PeerLink; b: PeerLink; stop(): Promise<void> }> {
  const sockets: net.Socket[] = [];
  const listener = net.createServer((socket) => {
    socket.on('error', () => {});
    sockets.push(socket);
    const [first, second] = sockets;
    if (!first || !second) return;
    first.pipe(second);
    second.pipe(first);
  });
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as net.AddressInfo).port;
  const dial = { host: '127.0.0.1', port, log: captureLog().log, timers: new ManualTimers().api };
  const a = await openPeerLink(dial);
  const b = await openPeerLink(dial);
  return {
    a,
    b,
    stop: async () => {
      a.close();
      b.close();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => listener.close(resolve));
    },
  };
}

const quiet = (): void => {};
const live = (): { cancelled: boolean } => ({ cancelled: false });

describe('files over a peer link', () => {
  it('one file arrives whole: writer got every byte, finish called once, DONE carries size and checksum', async () => {
    const [a, b] = pair();
    const data = content(100_000);
    const sink = memorySink();
    await Promise.all([
      sendFiles(a, COOKIE, [source('notes.txt', data)], quiet, live()),
      receiveFiles(b, COOKIE, sink, quiet, live()),
    ]);
    expect(sink.files).toHaveLength(1);
    const taken = sink.files[0] as Taken;
    expect(taken.file).toEqual({ name: 'notes.txt', bytes: data.length, modifiedAt: 1_700_000_000, index: 0, count: 1 });
    expect(joined(taken.chunks)).toEqual(data);
    expect(taken.finished).toBe(1);
    expect(taken.aborted).toBe(0);
    const done = decodeOftHeader(b.sent.at(-1) as Uint8Array);
    expect(done.type).toBe(OFT_DONE);
    expect(done.cookie).toBe(COOKIE);
    expect(done.received).toBe(data.length);
    expect(sameOftChecksum(done.receivedChecksum, oftChecksum(data))).toBe(true);
    expect(a.closed).toBe(true);
    expect(b.closed).toBe(true);
  });

  it('three files arrive in order with index 0..2 and count 3', async () => {
    const [a, b] = pair();
    const names = ['one.txt', 'zwölf 日本.bin', 'three.gif'];
    const parts = [content(40_000, 1), content(70_001, 2), content(9, 3)];
    const sink = memorySink();
    await Promise.all([
      sendFiles(a, COOKIE, parts.map((data, i) => source(names[i] as string, data)), quiet, live()),
      receiveFiles(b, COOKIE, sink, quiet, live()),
    ]);
    expect(sink.files.map((taken) => taken.file.index)).toEqual([0, 1, 2]);
    expect(sink.files.map((taken) => taken.file.count)).toEqual([3, 3, 3]);
    expect(sink.files.map((taken) => taken.file.name)).toEqual(names);
    expect(sink.files.map((taken) => joined(taken.chunks))).toEqual(parts);
    expect(sink.files.map((taken) => taken.finished)).toEqual([1, 1, 1]);
  });

  it('a zero-byte file arrives as begin + finish with no write', async () => {
    const [a, b] = pair();
    const sink = memorySink();
    await Promise.all([
      sendFiles(a, COOKIE, [source('empty.txt', new Uint8Array(0))], quiet, live()),
      receiveFiles(b, COOKIE, sink, quiet, live()),
    ]);
    expect(sink.files).toHaveLength(1);
    const taken = sink.files[0] as Taken;
    expect(taken.file.bytes).toBe(0);
    expect(taken.chunks).toEqual([]);
    expect(taken.finished).toBe(1);
    expect(taken.aborted).toBe(0);
  });

  it('sender: an ACK with another cookie rejects bad-cookie and no data byte was written', async () => {
    const [a, b] = pair();
    const run = failure(sendFiles(a, COOKIE, [source('notes.txt', content(50_000))], quiet, live()));
    const asked = await header(b);
    expect(asked.type).toBe(OFT_PROMPT);
    await b.write(encodeOftHeader({ ...asked, type: OFT_ACK, cookie: OTHER_COOKIE }));
    expect(await run).toBe('bad-cookie');
    expect(a.sent).toHaveLength(1);
    expect(decodeOftHeader(a.sent[0] as Uint8Array).type).toBe(OFT_PROMPT);
    expect(a.closed).toBe(true);
  });

  it('receiver: a PROMPT with another cookie rejects bad-cookie and sink.begin was not called', async () => {
    const [a, b] = pair();
    const sink = memorySink();
    const run = failure(receiveFiles(b, COOKIE, sink, quiet, live()));
    await a.write(encodeOftHeader(prompt(content(100), { cookie: OTHER_COOKIE })));
    expect(await run).toBe('bad-cookie');
    expect(sink.files).toEqual([]);
    expect(b.sent).toEqual([]);
    expect(b.closed).toBe(true);
  });

  it('receiver: the peer closes at half: writer.abort called, rejects peer-closed', async () => {
    const [a, b] = pair();
    const data = content(60_000);
    const sink = memorySink();
    const run = failure(receiveFiles(b, COOKIE, sink, quiet, live()));
    await a.write(encodeOftHeader(prompt(data)));
    expect((await header(a)).type).toBe(OFT_ACK);
    await a.write(data.subarray(0, 30_000));
    a.close();
    expect(await run).toBe('peer-closed');
    const taken = sink.files[0] as Taken;
    expect(taken.aborted).toBe(1);
    expect(taken.finished).toBe(0);
  });

  it('receiver: checksum differs from the header: abort, rejects checksum-mismatch', async () => {
    const [a, b] = pair();
    const data = content(20_000);
    const sink = memorySink();
    const run = failure(receiveFiles(b, COOKIE, sink, quiet, live()));
    await a.write(encodeOftHeader(prompt(data, { checksum: oftChecksum(content(20_000, 8)) })));
    await header(a);
    await a.write(data);
    expect(await run).toBe('checksum-mismatch');
    const taken = sink.files[0] as Taken;
    expect(taken.aborted).toBe(1);
    expect(taken.finished).toBe(0);
    expect(b.sent.map((bytes) => decodeOftHeader(bytes).type)).toEqual([OFT_ACK]);
    expect(b.closed).toBe(true);
  });

  it('receiver: bytes after a file that are not a header reject bad-header and no second file begins', async () => {
    const [a, b] = pair();
    const data = content(1000);
    const sink = memorySink();
    const run = failure(receiveFiles(b, COOKIE, sink, quiet, live()));
    await a.write(encodeOftHeader(prompt(data, { totalFiles: 2, filesLeft: 2, totalBytes: 2000 })));
    await header(a);
    await a.write(joined([data, content(300, 9)]));
    expect(await run).toBe('bad-header');
    expect(sink.files).toHaveLength(1);
    expect(b.closed).toBe(true);
  });

  it('receiver: files larger than the total of the first header reject size-mismatch before sink.begin', async () => {
    const [a, b] = pair();
    const sink = memorySink();
    const run = failure(receiveFiles(b, COOKIE, sink, quiet, live()));
    await a.write(encodeOftHeader(prompt(content(5000), { totalBytes: 100 })));
    expect(await run).toBe('size-mismatch');
    expect(sink.files).toEqual([]);
    expect(b.sent).toEqual([]);
  });

  it('receiver: a header that is not a PROMPT rejects bad-header and sink.begin was not called', async () => {
    const [a, b] = pair();
    const sink = memorySink();
    const run = failure(receiveFiles(b, COOKIE, sink, quiet, live()));
    await a.write(encodeOftHeader(prompt(content(10), { type: OFT_DONE })));
    expect(await run).toBe('bad-header');
    expect(sink.files).toEqual([]);
  });

  it('receiver: a write that rejects midway: abort, the link closes, rejects sink-failed', async () => {
    const [a, b] = pair();
    const data = content(200_000);
    const sink = memorySink((taken) => {
      if (taken.chunks.length === 1) throw new Error('no space');
    });
    const sending = failure(sendFiles(a, COOKIE, [source('notes.txt', data)], quiet, live()));
    expect(await failure(receiveFiles(b, COOKIE, sink, quiet, live()))).toBe('sink-failed');
    const taken = sink.files[0] as Taken;
    expect(taken.aborted).toBe(1);
    expect(taken.finished).toBe(0);
    expect(b.closed).toBe(true);
    expect(await sending).toBe('peer-closed');
  });

  it('receiver: finish rejects: abort, no DONE is sent, rejects sink-failed', async () => {
    const [a, b] = pair();
    const data = content(100);
    let aborted = 0;
    const sink: FileSink = {
      begin: async () => ({
        write: async () => {},
        finish: async () => {
          throw new Error('the name is taken');
        },
        abort: async () => {
          aborted += 1;
        },
      }),
    };
    const sending = failure(sendFiles(a, COOKIE, [source('notes.txt', data)], quiet, live()));
    expect(await failure(receiveFiles(b, COOKIE, sink, quiet, live()))).toBe('sink-failed');
    expect(aborted).toBe(1);
    expect(b.sent.map((bytes) => decodeOftHeader(bytes).type)).toEqual([OFT_ACK]);
    expect(await sending).toBe('peer-closed');
  });

  it('sender: read() yields fewer bytes than `bytes`: rejects source-changed and closes the link', async () => {
    const [a] = pair();
    const file = { ...source('notes.txt', content(900)), bytes: 1000 };
    expect(await failure(sendFiles(a, COOKIE, [file], quiet, live()))).toBe('source-changed');
    expect(a.closed).toBe(true);
    expect(a.sent).toEqual([]);
  });

  it('sender: read() throws on the second pass: rejects source-changed', async () => {
    const [a, b] = pair();
    const data = content(10_000);
    let passes = 0;
    const file: OutgoingFile = {
      name: 'notes.txt',
      bytes: data.length,
      modifiedAt: 1,
      read() {
        passes += 1;
        if (passes === 1) return pieces(data, 4000);
        return (async function* (): AsyncIterable<Uint8Array> {
          yield data.subarray(0, 4000);
          throw new Error('the file is gone');
        })();
      },
    };
    const run = failure(sendFiles(a, COOKIE, [file], quiet, live()));
    const receiving = failure(receiveFiles(b, COOKIE, memorySink(), quiet, live()));
    expect(await run).toBe('source-changed');
    expect(a.closed).toBe(true);
    expect(await receiving).toBe('peer-closed');
  });

  it.each([
    ['shorter', 7000],
    ['longer', 13_000],
  ])('sender: the second pass is %s than the first: rejects source-changed and the receiver keeps no file', async (_, second) => {
    const [a, b] = pair();
    const data = content(10_000);
    let passes = 0;
    const file: OutgoingFile = {
      name: 'notes.txt',
      bytes: data.length,
      modifiedAt: 1,
      read() {
        passes += 1;
        return pieces(passes === 1 ? data : content(second), 4000);
      },
    };
    const sink = memorySink();
    const run = failure(sendFiles(a, COOKIE, [file], quiet, live()));
    const receiving = failure(receiveFiles(b, COOKIE, sink, quiet, live()));
    expect(await run).toBe('source-changed');
    expect(a.closed).toBe(true);
    expect(a.sent.slice(1).reduce((sum, bytes) => sum + bytes.length, 0)).toBeLessThanOrEqual(data.length);
    expect(await receiving).not.toBe('resolved');
    expect((sink.files[0] as Taken).finished).toBe(0);
    expect((sink.files[0] as Taken).aborted).toBe(1);
  });

  it('sender: the second pass has other bytes of the same count: rejects source-changed', async () => {
    const [a, b] = pair();
    let passes = 0;
    const file: OutgoingFile = {
      name: 'notes.txt',
      bytes: 10_000,
      modifiedAt: 1,
      read() {
        passes += 1;
        return pieces(content(10_000, passes), 4000);
      },
    };
    const sink = memorySink();
    const run = failure(sendFiles(a, COOKIE, [file], quiet, live()));
    const receiving = failure(receiveFiles(b, COOKIE, sink, quiet, live()));
    expect(await run).toBe('source-changed');
    expect(await receiving).toBe('checksum-mismatch');
    expect((sink.files[0] as Taken).finished).toBe(0);
  });

  it('sink.begin rejects: receiver closes the link and rejects sink-failed', async () => {
    const [a, b] = pair();
    const sink: FileSink = {
      begin: async () => {
        throw new Error('no folder');
      },
    };
    const sending = failure(sendFiles(a, COOKIE, [source('notes.txt', content(5000))], quiet, live()));
    expect(await failure(receiveFiles(b, COOKIE, sink, quiet, live()))).toBe('sink-failed');
    expect(b.closed).toBe(true);
    expect(b.sent).toEqual([]);
    expect(await sending).toBe('peer-closed');
    expect(a.sent).toHaveLength(1);
  });

  it('signal.cancelled set midway: both sides stop, writer.abort called, rejects cancelled', async () => {
    const [a, b] = pair();
    const signal = live();
    const data = content(400_000);
    const sink = memorySink((taken) => {
      if (taken.chunks.length === 2) signal.cancelled = true;
    });
    const sending = failure(sendFiles(a, COOKIE, [source('notes.txt', data)], quiet, signal));
    const receiving = failure(receiveFiles(b, COOKIE, sink, quiet, signal));
    expect(await receiving).toBe('cancelled');
    expect(await sending).toBe('cancelled');
    const taken = sink.files[0] as Taken;
    expect(taken.aborted).toBe(1);
    expect(taken.finished).toBe(0);
    expect(a.closed).toBe(true);
    expect(b.closed).toBe(true);
  });

  it('sender: signal.cancelled set between chunks stops the writes and rejects cancelled', async () => {
    const [a, b] = pair();
    const signal = live();
    const data = content(200_000);
    let passes = 0;
    const file: OutgoingFile = {
      name: 'notes.txt',
      bytes: data.length,
      modifiedAt: 1,
      read() {
        passes += 1;
        const second = passes === 2;
        return (async function* (): AsyncIterable<Uint8Array> {
          for (let at = 0; at < data.length; at += 10_000) {
            if (second && at === 50_000) signal.cancelled = true;
            yield data.subarray(at, at + 10_000);
          }
        })();
      },
    };
    const sink = memorySink();
    const receiving = failure(receiveFiles(b, COOKIE, sink, quiet, live()));
    expect(await failure(sendFiles(a, COOKIE, [file], quiet, signal))).toBe('cancelled');
    expect(a.sent.slice(1).reduce((sum, bytes) => sum + bytes.length, 0)).toBeLessThanOrEqual(60_000);
    expect(await receiving).toBe('peer-closed');
    expect((sink.files[0] as Taken).aborted).toBe(1);
  });

  it('a RESUME from the receiver is answered and the file is sent from byte 0', async () => {
    const [a, b] = pair();
    const data = content(50_000);
    const run = sendFiles(a, COOKIE, [source('notes.txt', data)], quiet, live());
    const asked = await header(b);
    await b.write(encodeOftHeader({ ...asked, type: OFT_RESUME, received: 20_000, receivedChecksum: oftChecksum(data.subarray(0, 20_000)) }));
    const answer = await header(b);
    expect(answer.type).toBe(OFT_RESUME_ANSWER);
    expect(answer.cookie).toBe(COOKIE);
    expect(answer.received).toBe(0);
    expect(answer.bytes).toBe(data.length);
    await b.write(encodeOftHeader({ ...answer, type: OFT_RESUME_ACK }));
    expect(await b.read(data.length)).toEqual(data);
    await b.write(encodeOftHeader({ ...asked, type: OFT_DONE, received: data.length, receivedChecksum: oftChecksum(data) }));
    await run;
    expect(a.closed).toBe(true);
  });

  it('sender: a DONE with another cookie rejects bad-cookie', async () => {
    const [a, b] = pair();
    const data = content(100);
    const run = failure(sendFiles(a, COOKIE, [source('notes.txt', data)], quiet, live()));
    const asked = await header(b);
    await b.write(encodeOftHeader({ ...asked, type: OFT_ACK }));
    await b.read(data.length);
    await b.write(encodeOftHeader({ ...asked, type: OFT_DONE, cookie: OTHER_COOKIE }));
    expect(await run).toBe('bad-cookie');
  });

  it('sender: bytes that are not a header in place of the ACK reject bad-header and no data byte was written', async () => {
    const [a, b] = pair();
    const run = failure(sendFiles(a, COOKIE, [source('notes.txt', content(100))], quiet, live()));
    await header(b);
    await b.write(content(300));
    expect(await run).toBe('bad-header');
    expect(a.sent).toHaveLength(1);
  });

  it('sender: no write to the link is larger than 32 KB', async () => {
    const [a, b] = pair();
    const data = content(300_000);
    await Promise.all([
      sendFiles(a, COOKIE, [source('notes.txt', data, 100_000)], quiet, live()),
      receiveFiles(b, COOKIE, memorySink(), quiet, live()),
    ]);
    expect(Math.max(...a.sent.map((bytes) => bytes.length))).toBeLessThanOrEqual(CHUNK_MAX);
    expect(joined(a.sent.slice(1))).toEqual(data);
  });

  it('two files cross real connections and each side ends after the last DONE', async () => {
    const { a, b, stop } = await socketPair();
    try {
      const parts = [content(1_000_000, 1), content(0, 2)];
      const sink = memorySink();
      await Promise.all([
        sendFiles(a, COOKIE, parts.map((data, i) => source(`file${i}.bin`, data, 200_000)), quiet, live()),
        receiveFiles(b, COOKIE, sink, quiet, live()),
      ]);
      expect(sink.files.map((taken) => joined(taken.chunks))).toEqual(parts);
      expect(sink.files.map((taken) => taken.finished)).toEqual([1, 1]);
    } finally {
      await stop();
    }
  });

  it('progress ends at bytesDone === bytesTotal', async () => {
    const [a, b] = pair();
    const parts = [content(40_000, 1), content(0, 2), content(70_000, 3)];
    const total = 110_000;
    const out: TransferProgress[] = [];
    const into: TransferProgress[] = [];
    await Promise.all([
      sendFiles(a, COOKIE, parts.map((data, i) => source(`file${i}.bin`, data)), (p) => out.push(p), live()),
      receiveFiles(b, COOKIE, memorySink(), (p) => into.push(p), live()),
    ]);
    for (const seen of [out, into]) {
      const last = seen.at(-1) as TransferProgress;
      expect(last).toEqual({ index: 2, count: 3, name: 'file2.bin', fileBytes: 70_000, fileDone: 70_000, bytesDone: total, bytesTotal: total });
      const ends = seen.filter((p) => p.fileDone === p.fileBytes);
      expect(ends.map((p) => p.index)).toEqual([0, 1, 2]);
      const done = seen.map((p) => p.bytesDone);
      expect(done).toEqual([...done].sort((x, y) => x - y));
    }
  });

  it('progress comes at most every 100 ms, and one time at the end of each file', async () => {
    const [a, b] = pair();
    const data = content(500_000);
    let clock = 0;
    const out: TransferProgress[] = [];
    const into: TransferProgress[] = [];
    await Promise.all([
      sendFiles(a, COOKIE, [source('notes.txt', data)], (p) => out.push(p), live(), () => clock),
      receiveFiles(b, COOKIE, memorySink(), (p) => into.push(p), live(), () => clock),
    ]);
    expect(out).toHaveLength(1);
    expect(into).toHaveLength(1);

    const [c, d] = pair();
    const stamps: number[] = [];
    await Promise.all([
      sendFiles(c, COOKIE, [source('notes.txt', data)], () => stamps.push(clock), live(), () => (clock += 30)),
      receiveFiles(d, COOKIE, memorySink(), quiet, live()),
    ]);
    expect(stamps.length).toBeGreaterThan(2);
    const gaps = stamps.slice(1, -1).map((at, i) => at - (stamps[i] as number));
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(100);
  });
});

describe('one file over a link that stays open', () => {
  it('sendFile answered by DONE in place of ACK resolves not-taken and sends no file byte', async () => {
    const [a, b] = pair();
    const file = source('notes.txt', content(50_000));
    const steps: TransferProgress[] = [];
    const run = sendFile(a, COOKIE, file, { index: 0, count: 1, totalBytes: 50_000 }, (p) => steps.push(p), live());
    const asked = await header(b);
    expect(asked.type).toBe(OFT_PROMPT);
    await b.write(encodeOftHeader({ ...asked, type: OFT_DONE }));
    expect(await run).toBe('not-taken');
    expect(a.sent).toHaveLength(1);
    expect(steps).toEqual([]);
    expect(a.closed).toBe(false);
  });

  it('sendFiles answered by DONE in place of ACK rejects bad-header, as before', async () => {
    const [a, b] = pair();
    const run = failure(sendFiles(a, COOKIE, [source('notes.txt', content(50_000))], quiet, live()));
    const asked = await header(b);
    await b.write(encodeOftHeader({ ...asked, type: OFT_DONE }));
    expect(await run).toBe('bad-header');
    expect(a.sent).toHaveLength(1);
    expect(a.closed).toBe(true);
  });

  it('sendFile and receiveFile move two files on one link and leave it open', async () => {
    const [a, b] = pair();
    const first = content(70_000, 1);
    const second = content(999, 2);
    const sink = memorySink();
    const out: TransferProgress[] = [];
    const into: TransferProgress[] = [];
    const sending = (async () => {
      const one = await sendFile(a, COOKIE, source('one.bin', first), { index: 0, count: 1, totalBytes: first.length }, (p) => out.push(p), live());
      const two = await sendFile(a, COOKIE, source('two.bin', second), { index: 0, count: 1, totalBytes: second.length }, (p) => out.push(p), live());
      return [one, two];
    })();
    await receiveFile(b, COOKIE, sink, { index: 0, count: 1, maxBytes: first.length }, (p) => into.push(p), live());
    await receiveFile(b, COOKIE, sink, { index: 0, count: 1, maxBytes: second.length }, (p) => into.push(p), live());
    expect(await sending).toEqual(['sent', 'sent']);
    expect(sink.files.map((taken) => joined(taken.chunks))).toEqual([first, second]);
    expect(sink.files.map((taken) => taken.file)).toEqual([
      { name: 'one.bin', bytes: first.length, modifiedAt: 1_700_000_000, index: 0, count: 1 },
      { name: 'two.bin', bytes: second.length, modifiedAt: 1_700_000_000, index: 0, count: 1 },
    ]);
    expect(out.at(-1)).toEqual({ index: 0, count: 1, name: 'two.bin', fileBytes: 999, fileDone: 999, bytesDone: 999, bytesTotal: 999 });
    expect(into.at(-1)).toEqual({ index: 0, count: 1, name: 'two.bin', fileBytes: 999, fileDone: 999, bytesDone: 999, bytesTotal: 999 });
    expect(a.closed).toBe(false);
    expect(b.closed).toBe(false);
  });

  it('sendFile writes the place of the file and the total into the PROMPT', async () => {
    const [a, b] = pair();
    const run = sendFile(a, COOKIE, source('notes.txt', content(10)), { index: 1, count: 3, totalBytes: 5000 }, quiet, live());
    const asked = await header(b);
    expect(asked).toMatchObject({ type: OFT_PROMPT, totalFiles: 3, filesLeft: 2, totalBytes: 5000, bytes: 10 });
    await b.write(encodeOftHeader({ ...asked, type: OFT_DONE }));
    await run;
  });

  it('receiveFile: a PROMPT of more than maxBytes rejects size-mismatch, the sink got no byte and the link closes', async () => {
    const [a, b] = pair();
    const sink = memorySink();
    const run = failure(receiveFile(b, COOKIE, sink, { index: 0, count: 1, maxBytes: 1024 }, quiet, live()));
    await a.write(encodeOftHeader(prompt(content(2048))));
    expect(await run).toBe('size-mismatch');
    expect(sink.files).toHaveLength(0);
    expect(b.sent).toHaveLength(0);
    expect(b.closed).toBe(true);
  });

  it('receiveFile: a file of fewer bytes than maxBytes arrives', async () => {
    const [a, b] = pair();
    const data = content(500);
    const sink = memorySink();
    const run = receiveFile(b, COOKIE, sink, { index: 2, count: 5, maxBytes: 1024 }, quiet, live());
    await a.write(encodeOftHeader(prompt(data)));
    expect((await header(a)).type).toBe(OFT_ACK);
    await a.write(data);
    expect((await header(a)).type).toBe(OFT_DONE);
    await run;
    expect(sink.files[0]?.file).toMatchObject({ bytes: 500, index: 2, count: 5 });
    expect(sink.files[0]?.finished).toBe(1);
  });

  it('receiveFile: the header that the caller read is not read again', async () => {
    const [a, b] = pair();
    const data = content(500);
    const sink = memorySink();
    const run = receiveFile(b, COOKIE, sink, { index: 0, count: 1, maxBytes: 500 }, quiet, live(), Date.now, prompt(data));
    expect((await header(a)).type).toBe(OFT_ACK);
    await a.write(data);
    await run;
    expect(joined(sink.files[0]?.chunks ?? [])).toEqual(data);
  });

  it('receiveFile: a failure closes the link and aborts the writer', async () => {
    const [a, b] = pair();
    const data = content(5000);
    const sink = memorySink();
    const run = failure(receiveFile(b, COOKIE, sink, { index: 0, count: 1, maxBytes: 5000 }, quiet, live()));
    await a.write(encodeOftHeader(prompt(data, { checksum: 0x1234_0000 })));
    await header(a);
    await a.write(data);
    expect(await run).toBe('checksum-mismatch');
    expect(sink.files[0]?.aborted).toBe(1);
    expect(b.closed).toBe(true);
  });
});

describe('a file with a given checksum', () => {
  it('sends a file with a given checksum and reads it one time', async () => {
    const [a, b] = pair();
    const data = content(100_000);
    const file = Object.assign(source('notes.txt', data), { checksum: oftChecksum(data) });
    const sink = memorySink();
    const receiving = (async () => {
      const asked = await header(b);
      await receiveFile(b, COOKIE, sink, { index: 0, count: 1, maxBytes: data.length }, quiet, live(), Date.now, asked);
      return asked;
    })();
    expect(await sendFile(a, COOKIE, file, { index: 0, count: 1, totalBytes: data.length }, quiet, live())).toBe('sent');
    const asked = await receiving;
    expect(file.passes).toBe(1);
    expect(asked.checksum).toBe(oftChecksum(data));
    expect(joined(sink.files[0]?.chunks ?? [])).toEqual(data);
    expect(sink.files[0]?.finished).toBe(1);
  });

  it('fails source-changed when a given checksum does not match the bytes', async () => {
    const [a, b] = pair();
    const data = content(10_000);
    const file = Object.assign(source('notes.txt', data), { checksum: (oftChecksum(data) + 1) >>> 0 });
    const sink = memorySink();
    const receiving = failure(receiveFiles(b, COOKIE, sink, quiet, live()));
    expect(await failure(sendFiles(a, COOKIE, [file], quiet, live()))).toBe('source-changed');
    expect(file.passes).toBe(1);
    expect(a.closed).toBe(true);
    expect(await receiving).not.toBe('resolved');
    expect(sink.files[0]?.finished).toBe(0);
  });

  it('fails source-changed when the one read gives fewer bytes than `bytes`', async () => {
    const [a, b] = pair();
    const data = content(900);
    const file = Object.assign(source('notes.txt', data), { bytes: 1000, checksum: oftChecksum(data) });
    const receiving = failure(receiveFiles(b, COOKIE, memorySink(), quiet, live()));
    expect(await failure(sendFiles(a, COOKIE, [file], quiet, live()))).toBe('source-changed');
    expect(file.passes).toBe(1);
    expect(await receiving).not.toBe('resolved');
  });
});
