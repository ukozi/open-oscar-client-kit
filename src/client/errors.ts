import type { RoomJoinFailure } from '../model/room.js';
import type { CommandError, SignOnFailure } from '../model/session.js';
import type { DropEvidence } from './reconnect.js';

function describe(value: { kind: string; code?: number | string }): string {
  if (value.code === undefined) return value.kind;
  const code = typeof value.code === 'number' ? `0x${value.code.toString(16).padStart(4, '0')}` : value.code;
  return `${value.kind} (${code})`;
}

export class OscarError extends Error {
  readonly info: CommandError;
  /** `sendIm` only: the message went out on the connection before it closed, so delivery is possible. */
  declare readonly sent?: true;

  constructor(info: CommandError, opts: { sent?: true } = {}) {
    super(describe(info));
    this.name = 'OscarError';
    this.info = info;
    if (opts.sent) this.sent = true;
  }
}

export class SignOnError extends Error {
  readonly failure: SignOnFailure;
  declare readonly evidence?: DropEvidence;

  constructor(failure: SignOnFailure, evidence?: DropEvidence, options?: ErrorOptions) {
    super(describe(failure), options);
    this.name = 'SignOnError';
    this.failure = failure;
    if (evidence !== undefined) this.evidence = evidence;
  }
}

export class ListWriteError extends OscarError {
  /** After the failure, the feedbag queried the list again and replaced it. */
  readonly reloaded: boolean;

  constructor(info: CommandError, reloaded: boolean) {
    super(info);
    this.name = 'ListWriteError';
    this.reloaded = reloaded;
  }
}

export class RoomJoinError extends Error {
  readonly reason: RoomJoinFailure;

  constructor(reason: RoomJoinFailure) {
    super(reason);
    this.name = 'RoomJoinError';
    this.reason = reason;
  }
}
