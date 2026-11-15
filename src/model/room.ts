import type { RichText } from './rich-text.js';
import { normalizeScreenName } from './screen-name.js';
import type { InviteWire, MessageWire } from './wire-detail.js';

export type RoomState = 'joining' | 'joined' | 'rejoining' | 'disconnected' | 'notAvailable';
export type RoomJoinFailure = 'invalid-name' | 'room-limit' | 'name-too-long' | 'no-such-room' | 'unavailable';
export type RoomId = { exchange: 4 | 5; name: string };       // 4 buddy chat, 5 public room
export type RoomRef = RoomId;
export type Invite = {
  id: string; from: string; room: RoomId; text: RichText; at: number;
  /** The text as it came. Only the `wireDetail` option of the client sets it. */
  wire?: InviteWire;
};

export const ROOM_NAME_MAX = 100;
/** A public room's name stops here; a buddy chat's stops at ROOM_NAME_MAX. */
export const PUBLIC_ROOM_NAME_MAX = 50;
export const MAX_ROOMS = 10;
export const ROOM_MESSAGE_MAX_BYTES = 1024;
export const INVITE_TEXT = 'Join me in this room.';

export type AnyRoom = { exchange: number; name: string };

const ROOM_NAME = new RegExp(`^[\\x20-\\x7e]{1,${ROOM_NAME_MAX}}$`);

export function roomRemovedText(name: string): string {
  return `Removed #${name} from your buddy list.`;
}

export function isValidRoomName(name: string): boolean {
  return ROOM_NAME.test(name) && name === name.trim();
}

export type RoomNameProblem = 'empty' | 'too-long' | 'characters' | 'spaces';

/** What is wrong with a name typed to join `exchange`, or null when the client can send it. Saved rooms keep `isValidRoomName`. */
export function checkTypedRoomName(name: string, exchange: 4 | 5): RoomNameProblem | null {
  if (name === '') return 'empty';
  if (!/^[\x20-\x7e]*$/.test(name)) return 'characters';
  if (name !== name.trim()) return 'spaces';
  if (name.length > (exchange === 5 ? PUBLIC_ROOM_NAME_MAX : ROOM_NAME_MAX)) return 'too-long';
  return null;
}

export function roomKey(room: AnyRoom): string {
  return `${room.exchange}:${room.name.toLowerCase()}`;
}

export function roomConversationId(room: AnyRoom): string {
  return `room:${roomKey(room)}`;
}

export function imConversationId(screenName: string): string {
  return `im:${normalizeScreenName(screenName)}`;
}

export function rosterSpelling(occupants: readonly string[], screenName: string): string | undefined {
  const wanted = normalizeScreenName(screenName);
  return occupants.find((occupant) => normalizeScreenName(occupant) === wanted);
}

export function sameRoom(a: AnyRoom, b: AnyRoom): boolean {
  return roomKey(a) === roomKey(b);
}

export function parseRoomId(value: unknown): RoomId | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const { exchange, name } = value as Record<string, unknown>;
  if (exchange !== 4 && exchange !== 5) return null;
  if (typeof name !== 'string' || !isValidRoomName(name)) return null;
  return { exchange, name };
}

/** `occupants` start in the order the server sent them, which is arbitrary (`state/session_manager.go` `AllSessions` walks a Go map). */
export type RoomStatus = {
  id: string; exchange: 4 | 5; name: string; state: RoomState; occupants: string[];
  createdAt: number | null; maxOccupancy: number | null;
};
export type RoomOccupantChange = { roomId: string; screenName: string; change: 'joined' | 'left'; occupants: string[] };
/** Rooms sets `blocked` on a line or whisper from a sender on the Block list, never on a line the server wrote. */
export type RoomMessage = {
  roomId: string; from: string; body: RichText; at: number; whisper: boolean; fromServer: boolean; blocked?: true;
  /** The cookie and the HTML as they came. Only the `wireDetail` option of the client sets it. */
  wire?: MessageWire;
};
/** The rate state of the send class of one room connection, by the room's id. */
export type RoomRate = { roomId: string; status: 'clear' | 'alert' | 'limited' };
