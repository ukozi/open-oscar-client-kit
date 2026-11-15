export const DEFAULT_AWAY_TEXT = 'I am away from my computer right now.';
export type SessionState = 'offline' | 'connecting' | 'online' | 'reconnecting';
export type SignOnFailure =
  | { kind: 'unknown-screen-name' }
  | { kind: 'wrong-password' }
  | { kind: 'account-unavailable'; code: number }
  | { kind: 'login-rate-limited' }
  | { kind: 'too-many-sessions' }
  | { kind: 'refused'; code: number }
  | { kind: 'unreachable' };
export type SignOffReason =
  | SignOnFailure
  | { kind: 'signed-off-by-server' };
export type LocalRefusal =
  | 'invalid-screen-name' | 'message-too-long' | 'not-offline' | 'invalid-argument' | 'unknown-conversation'
  | 'buddy-limit' | 'group-limit' | 'group-full' | 'block-limit' | 'duplicate-buddy' | 'duplicate-group' | 'invalid-group-name'
  | 'own-screen-name' | 'busy' | 'unknown-item' | 'text-too-long' | 'cannot-warn' | 'blocked' | 'rate-held'
  | 'not-in-room' | 'unknown-invite' | 'settings-not-saved'
  | 'allow-limit' | 'already-listed' | 'needs-conversion' | 'whisper-target-left' | 'whisper-roll' | 'not-same-screen-name'
  | 'no-directory';
export type CommandError =
  | { kind: 'refused'; code: number; subcode?: number }
  | { kind: 'timeout'; rateLimited: boolean }
  | { kind: 'connection-lost' }
  | { kind: 'not-signed-on' }
  | { kind: 'local'; code: LocalRefusal }
  | { kind: 'account'; reason: 'not-offered' | 'not-same' | 'invalid' };   // the Admin service's refusal of a format or an email read
export type ImFailureReason =
  | 'unavailable' | 'youBlocked' | 'offlineInboxFull' | 'unconfirmed'
  | 'connectionLost' | 'rateLimited' | 'notInRoom' | 'whisperTargetLeft' | 'other';   // whisperTargetLeft: a whisper's person left the room
export type SelfInfo = { screenName: string; signedOnAt: number; warnLevel: number; invisible: boolean }; // signedOnAt in ms
export type SessionLimits = {
  imBytes: number; awayAndProfileBytes: number;
  buddies: number; groups: number; permits: number; denies: number;
  buddiesPerGroup: number; itemNameBytes: number;
};
