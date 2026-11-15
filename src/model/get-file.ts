import type { OutgoingFile } from './transfer.js';

/** `path`: the names from the shared folder down. An empty path is the shared folder. `modifiedAt` is in seconds. */
export type SharedEntry = { path: readonly string[]; folder: boolean; bytes: number; modifiedAt: number };
export type SharedSource = {
  /**
   * The name of the shared folder, not its path. A listing of the second form has it as the first part of each path.
   * A name that such a path cannot hold, or no name, becomes a default name.
   */
  name?: string;
  /**
   * The entries of one folder, or null when no such folder is shared. The client asks for the empty path first.
   * The answer for the empty path can hold each file of the whole tree and no folder. The client asks again for each folder that an answer holds.
   * One listing goes out for the whole tree. The entries after the limit of the client are not in it.
   */
  list(folder: readonly string[]): Promise<readonly SharedEntry[] | null>;
  /**
   * The file, or null when it is not shared. The client asks only for a path that the listing of the connection held.
   * Thus the limit of the listing is the limit of the files that go out.
   */
  open(path: readonly string[]): Promise<OutgoingFile | null>;
};
/**
 * The one listing of a browse: each file of the whole shared folder. `folder` is empty and no entry is a folder.
 * Each path is the path that the holder wrote. Some holders write the name of their folder as the first part of each path.
 * `truncated`: the listing passed a limit and was cut. `damaged`: a part of the listing did not decode.
 */
export type FileListing = { browseId: string; from: string; folder: readonly string[]; entries: readonly SharedEntry[]; truncated: boolean; damaged: boolean };
/** 'not-there': the holder closed the connection in answer to a request for a file. A holder does this for a name that it does not have. */
export type GetFileEnd =
  | 'closed' | 'declined' | 'cancelled' | 'timed-out' | 'refused-address' | 'taken-elsewhere'
  | 'peer-closed' | 'bad-cookie' | 'bad-frame' | 'too-large' | 'not-there' | 'signed-off';
export type BrowseStatus = { id: string; peer: string; state: 'waiting' | 'connecting' | 'open' | 'closed'; end?: GetFileEnd; by?: 'self' | 'peer' };
export type ShareRequest = { id: string; from: string; at: number };
export type ShareStatus = { id: string; peer: string; state: 'asked' | 'connecting' | 'open' | 'closed'; end?: GetFileEnd; by?: 'self' | 'peer' };
export type ShareTaken = { id: string; peer: string; path: readonly string[]; bytes: number; at: number };
