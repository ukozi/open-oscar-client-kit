import type { CloseInfo } from '../wire/connection.js';
import type { RoomStatus } from '../model/room.js';

/** What the session knows of the account's other instances; `others` is the instances listed less one. */
export type Siblings = { known: false } | { known: true; others: number };
export interface RejoinPolicy {
  /** Once a reconnected session is online. `rooms` read `rejoining` and `absentMs` runs from the drop to now. Returns the ids to rejoin; every other room becomes `disconnected`. */
  afterReconnect(input: { rooms: readonly RoomStatus[]; absentMs: number; siblings: () => Promise<Siblings> }): Promise<readonly string[]>;
  /** When a closed room is about to become `disconnected`: `rejoin` makes one join, `stay` leaves it disconnected. */
  afterRoomClosed(input: { room: RoomStatus; close: CloseInfo['kind']; siblings: () => Promise<Siblings> }): Promise<'rejoin' | 'stay'>;
}

/** Every lost room once after a reconnect, and none after a close. */
export const DESKTOP_REJOIN: RejoinPolicy = {
  afterReconnect: async ({ rooms }) => rooms.map((room) => room.id),
  afterRoomClosed: async () => 'stay',
};
