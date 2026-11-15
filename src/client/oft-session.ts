import { OscarDecodeError } from '../wire/bytes.js';
import { ICBM_CHARSET_UNICODE } from '../wire/constants.js';
import {
  OFT_ACK, OFT_CHECKSUM_START, OFT_DONE, OFT_PROMPT, OFT_RESUME, OFT_RESUME_ACK, OFT_RESUME_ANSWER, answerOftFrame, decodeOftFrame,
  decodeOftHeader, encodeOftHeader, latin1NameEncoding, oftChecksum, oftHeaderLength, sameOftChecksum,
} from '../wire/oft.js';
import type { OftFrame, OftHeader, OftNameForm } from '../wire/oft.js';
import { isAscii } from '../wire/text.js';
import type { FileSink, FileWriter, OutgoingFile, TransferProgress } from '../model/transfer.js';
import { PeerClosedError } from './peer-link.js';
import type { PeerLink } from './peer-link.js';

export type OftFailure =
  | 'peer-closed' | 'bad-cookie' | 'bad-header' | 'size-mismatch' | 'checksum-mismatch'
  | 'source-changed' | 'sink-failed' | 'cancelled';

export class OftError extends Error {
  readonly failure: OftFailure;

  constructor(failure: OftFailure, options?: ErrorOptions) {
    super(failure, options);
    this.name = 'OftError';
    this.failure = failure;
  }
}

export type OftSignal = { cancelled: boolean };

const WRITE_MAX_BYTES = 32 * 1024;
const READ_MAX_BYTES = 64 * 1024;
const PROGRESS_EVERY_MS = 100;
const HEAD_BYTES = 6;

async function headerBytes(link: PeerLink): Promise<Uint8Array> {
  const head = await link.read(HEAD_BYTES);
  const rest = await link.read(oftHeaderLength(head) - HEAD_BYTES);
  const whole = new Uint8Array(head.length + rest.length);
  whole.set(head);
  whole.set(rest, head.length);
  return whole;
}

/** Reads one header. It rejects with PeerClosedError or OscarDecodeError. */
export async function readOftHeader(link: PeerLink): Promise<OftHeader> {
  return decodeOftHeader(await headerBytes(link));
}

/** Reads one header and keeps the fields that an answer sends back. It rejects with PeerClosedError or OscarDecodeError. */
export async function readOftFrame(link: PeerLink): Promise<OftFrame> {
  return decodeOftFrame(await headerBytes(link));
}

// A stop that the user asked for is `cancelled`, whatever error it caused.
function failed(error: unknown, signal: OftSignal): unknown {
  if (signal.cancelled) return new OftError('cancelled');
  if (error instanceof OftError) return error;
  if (error instanceof PeerClosedError) return new OftError('peer-closed', { cause: error });
  if (error instanceof OscarDecodeError) return new OftError('bad-header', { cause: error });
  return error;
}

function live(signal: OftSignal): void {
  if (signal.cancelled) throw new OftError('cancelled');
}

// An error from the source is `source-changed`. An error from the loop body does not pass through here.
async function* fromSource(file: OutgoingFile): AsyncIterable<Uint8Array> {
  try {
    for await (const chunk of file.read()) yield chunk;
  } catch (error) {
    throw new OftError('source-changed', { cause: error });
  }
}

async function sourceChecksum(file: OutgoingFile, signal: OftSignal): Promise<number> {
  let check = OFT_CHECKSUM_START;
  let count = 0;
  for await (const chunk of fromSource(file)) {
    live(signal);
    check = oftChecksum(chunk, check, count);
    count += chunk.length;
    if (count > file.bytes) break;
  }
  if (count !== file.bytes) throw new OftError('source-changed');
  return check;
}

type Meter = { moved(progress: TransferProgress): void; ended(progress: TransferProgress): void };

function meter(on: (p: TransferProgress) => void, now: () => number): Meter {
  let last = now();
  return {
    moved(progress) {
      const at = now();
      if (at - last < PROGRESS_EVERY_MS) return;
      last = at;
      on(progress);
    },
    ended(progress) {
      last = now();
      on(progress);
    },
  };
}

/**
 * One file, and the link stays open after it. The progress counts this file only. A failure closes the link.
 * `nameForm` 'latin-1' writes a name that Latin-1 holds with the encoding 0 and one byte for each character.
 * `written` runs when the last byte of the file is out, before the answer of the peer.
 */
export async function sendFile(
  link: PeerLink,
  cookie: bigint,
  file: OutgoingFile,
  at: { index: number; count: number; totalBytes: number },
  on: (p: TransferProgress) => void,
  signal: OftSignal,
  now: () => number = Date.now,
  nameForm: OftNameForm = 'utf-8',
  written?: () => void,
): Promise<'sent' | 'not-taken'> {
  try {
    const progress = meter(on, now);
    live(signal);
    const checksum = await sourceChecksum(file, signal);
    const prompt: OftHeader = {
      type: OFT_PROMPT, cookie, totalFiles: at.count, filesLeft: at.count - at.index, totalParts: 1, partsLeft: 1,
      totalBytes: at.totalBytes, bytes: file.bytes, modifiedAt: Math.min(0xffff_ffff, Math.max(0, Math.trunc(file.modifiedAt))),
      checksum, received: 0, receivedChecksum: OFT_CHECKSUM_START,
      nameEncoding: nameForm === 'latin-1' ? latin1NameEncoding(file.name) : isAscii(file.name) ? 0 : ICBM_CHARSET_UNICODE, name: file.name,
    };
    await link.write(encodeOftHeader(prompt, nameForm));
    if (!(await answered(link, prompt, nameForm))) return 'not-taken';
    const step = (fileDone: number): TransferProgress => (
      { index: at.index, count: at.count, name: file.name, fileBytes: file.bytes, fileDone, bytesDone: fileDone, bytesTotal: file.bytes }
    );
    let check = OFT_CHECKSUM_START;
    let sent = 0;
    for await (const chunk of fromSource(file)) {
      if (sent + chunk.length > file.bytes) throw new OftError('source-changed');
      check = oftChecksum(chunk, check, sent);
      for (let from = 0; from < chunk.length; from += WRITE_MAX_BYTES) {
        live(signal);
        const part = chunk.subarray(from, from + WRITE_MAX_BYTES);
        await link.write(part);
        sent += part.length;
        if (sent < file.bytes) progress.moved(step(sent));
      }
    }
    if (sent !== file.bytes || !sameOftChecksum(check, checksum)) throw new OftError('source-changed');
    written?.();
    const done = await readOftHeader(link);
    if (done.cookie !== cookie) throw new OftError('bad-cookie');
    if (done.type !== OFT_DONE) throw new OftError('bad-header');
    progress.ended(step(file.bytes));
    return 'sent';
  } catch (error) {
    link.close();
    throw failed(error, signal);
  }
}

/** Sends the files in order and closes the link. It rejects with OftError. */
export async function sendFiles(
  link: PeerLink,
  cookie: bigint,
  files: readonly OutgoingFile[],
  on: (p: TransferProgress) => void,
  signal: OftSignal,
  now: () => number = Date.now,
): Promise<void> {
  try {
    if (files.length === 0) throw new RangeError('no file to send');
    const count = files.length;
    const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
    let bytesBefore = 0;
    for (const [index, file] of files.entries()) {
      const before = bytesBefore;
      const all = (p: TransferProgress): void => on({ ...p, bytesDone: before + p.fileDone, bytesTotal: totalBytes });
      const end = await sendFile(link, cookie, file, { index, count, totalBytes }, all, signal, now);
      if (end === 'not-taken') throw new OftError('bad-header');
      bytesBefore += file.bytes;
    }
  } catch (error) {
    throw failed(error, signal);
  } finally {
    link.close();
  }
}

// No file byte goes out before the peer shows the cookie. A resume request gets the answer "from byte 0", with the name bytes of the PROMPT.
// The result is false when the peer answers DONE: it does not take the file.
async function answered(link: PeerLink, prompt: OftHeader, nameForm: OftNameForm): Promise<boolean> {
  let resumed = false;
  for (;;) {
    const header = await readOftHeader(link);
    if (header.cookie !== prompt.cookie) throw new OftError('bad-cookie');
    if (header.type === OFT_ACK || (resumed && header.type === OFT_RESUME_ACK)) return true;
    if (header.type === OFT_DONE && !resumed) return false;
    if (header.type !== OFT_RESUME || resumed) throw new OftError('bad-header');
    resumed = true;
    await link.write(encodeOftHeader({ ...prompt, type: OFT_RESUME_ANSWER }, nameForm));
  }
}

type Receipt = { bytes: number; checksum: number };
// The bytes of the answer to the header of a file. `received` is given for the answer after the file.
type Answers = (type: number, received?: Receipt) => Uint8Array;

/**
 * One file, and the link stays open after it. The progress counts this file only. A failure closes the link.
 * `maxBytes` is the most bytes that the file has. `prompt` is the header of the file when the caller read it.
 */
export async function receiveFile(
  link: PeerLink,
  cookie: bigint,
  sink: FileSink,
  at: { index: number; count: number; maxBytes: number },
  on: (p: TransferProgress) => void,
  signal: OftSignal,
  now: () => number = Date.now,
  prompt?: OftHeader,
): Promise<void> {
  let first: OftHeader | null = null;
  // Each answer is a new header with the fields of the header of the file.
  const answers: Answers = (type, received) => encodeOftHeader({
    ...(first as OftHeader), type, ...(received && { received: received.bytes, receivedChecksum: received.checksum }),
  });
  await received(link, cookie, sink, at, on, signal, now, async () => (first = prompt ?? (await readOftHeader(link))), answers);
}

/**
 * One file of a Get File connection, and the link stays open after it. A failure closes the link.
 * Each answer is the header of the file as it came, with a different type. The result is the answer after the file.
 */
export async function receiveAnswered(
  link: PeerLink,
  cookie: bigint,
  sink: FileSink,
  at: { index: number; count: number; maxBytes: number },
  on: (p: TransferProgress) => void,
  signal: OftSignal,
  now: () => number,
  prompt: OftFrame,
): Promise<OftFrame> {
  let last = prompt;
  const answers: Answers = (type, came) => {
    last = answerOftFrame(prompt, came ? { type, received: came } : { type });
    return last.bytes;
  };
  await received(link, cookie, sink, at, on, signal, now, async () => prompt.header, answers);
  return last;
}

async function received(
  link: PeerLink,
  cookie: bigint,
  sink: FileSink,
  at: { index: number; count: number; maxBytes: number },
  on: (p: TransferProgress) => void,
  signal: OftSignal,
  now: () => number,
  header: () => Promise<OftHeader>,
  answers: Answers,
): Promise<void> {
  let writer: FileWriter | null = null;
  try {
    const progress = meter(on, now);
    live(signal);
    const first = await header();
    // The cookie comes before the sink and before each byte of the file.
    if (first.cookie !== cookie) throw new OftError('bad-cookie');
    if (first.type !== OFT_PROMPT) throw new OftError('bad-header');
    const { name, bytes } = first;
    if (bytes > at.maxBytes) throw new OftError('size-mismatch');
    try {
      writer = await sink.begin({ name, bytes, modifiedAt: first.modifiedAt, index: at.index, count: at.count });
    } catch (error) {
      throw new OftError('sink-failed', { cause: error });
    }
    await link.write(answers(OFT_ACK));
    const step = (fileDone: number): TransferProgress => (
      { index: at.index, count: at.count, name, fileBytes: bytes, fileDone, bytesDone: fileDone, bytesTotal: bytes }
    );
    let check = OFT_CHECKSUM_START;
    let got = 0;
    while (got < bytes) {
      live(signal);
      const chunk = await link.readSome(Math.min(READ_MAX_BYTES, bytes - got));
      if (chunk === null) throw new OftError('peer-closed');
      check = oftChecksum(chunk, check, got);
      got += chunk.length;
      try {
        await writer.write(chunk);
      } catch (error) {
        throw new OftError('sink-failed', { cause: error });
      }
      if (got < bytes) progress.moved(step(got));
    }
    live(signal);
    if (!sameOftChecksum(check, first.checksum)) throw new OftError('checksum-mismatch');
    try {
      await writer.finish();
    } catch (error) {
      throw new OftError('sink-failed', { cause: error });
    }
    writer = null;
    // The file is whole. A peer that closed here shows at the next header.
    await link.write(answers(OFT_DONE, { bytes: got, checksum: check })).catch(() => {});
    progress.ended(step(bytes));
  } catch (error) {
    link.close();
    if (writer) await writer.abort().catch(() => {});
    throw failed(error, signal);
  }
}

/** Receives each file into the sink and closes the link. It rejects with OftError. */
export async function receiveFiles(
  link: PeerLink,
  cookie: bigint,
  sink: FileSink,
  on: (p: TransferProgress) => void,
  signal: OftSignal,
  now: () => number = Date.now,
): Promise<void> {
  try {
    let count = 1;
    let offered = 0;
    let bytesBefore = 0;
    for (let index = 0; index < count; index++) {
      live(signal);
      const prompt = await readOftHeader(link);
      if (index === 0) {
        count = Math.max(1, prompt.totalFiles);
        offered = prompt.totalBytes;
      }
      const before = bytesBefore;
      const total = offered;
      const all = (p: TransferProgress): void => on({ ...p, bytesDone: before + p.fileDone, bytesTotal: total });
      // The files together stay inside the total of the first header.
      await receiveFile(link, cookie, sink, { index, count, maxBytes: offered - bytesBefore }, all, signal, now, prompt);
      bytesBefore += prompt.bytes;
    }
  } catch (error) {
    throw failed(error, signal);
  } finally {
    link.close();
  }
}
