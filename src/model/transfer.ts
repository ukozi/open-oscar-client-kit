export type OutgoingFile = {
  name: string;
  bytes: number;
  modifiedAt: number;          // seconds
  /** Yields the file from the start. The client calls it two times: for the checksum, then to send. */
  read(): AsyncIterable<Uint8Array>;
};
/** `name` is the name in the header of the file. The byte 0x01 in it divides folders. */
export type IncomingFile = { name: string; bytes: number; modifiedAt: number; index: number; count: number };
export type FileWriter = { write(chunk: Uint8Array): Promise<void>; finish(): Promise<void>; abort(): Promise<void> };
/** A rejection from `begin` stops the transfer. */
export type FileSink = { begin(file: IncomingFile): Promise<FileWriter> };
export type TransferProgress = { index: number; count: number; name: string; fileBytes: number; fileDone: number; bytesDone: number; bytesTotal: number };
/**
 * `name` is the one name the offer carries, also when `count` is more than 1.
 * `folder` is the folder that the offer names, or null for an offer of loose files. Each file then has a name relative to it.
 */
export type FileOfferNotice = { id: string; from: string; count: number; totalBytes: number; name: string; folder: string | null; at: number };
export type TransferState = 'waiting' | 'connecting' | 'transferring' | 'done' | 'declined' | 'cancelled' | 'failed';
export type TransferFailure =
  | 'peer-closed' | 'timed-out' | 'refused-address' | 'file-problem'
  | 'source-changed' | 'folder-problem' | 'taken-elsewhere' | 'signed-off';
export type TransferStatus = {
  id: string;
  direction: 'in' | 'out';
  peer: string;
  state: TransferState;
  failure?: TransferFailure;
  by?: 'self' | 'peer';
  count: number;
  index: number;
  name: string;
  bytesDone: number;
  bytesTotal: number;
};
