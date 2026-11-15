export const DRIVER_COMMAND_EMPTY = 'the driver command is empty';
export const NO_REPLY = (op: string, ms: number): string => `no reply to ${op} within ${ms} ms`;
export const NO_EVENT = (ms: number): string => `no matching event within ${ms} ms`;
export const NOT_STARTED = (reason: string): string => `could not start the driver: ${reason}`;
export const EXITED_CODE = (code: number): string => `driver exited with code ${code}`;
export const EXITED_SIGNAL = (signal: string): string => `driver exited with signal ${signal}`;

export const DRIVER_APP = 'kit-driver';
export const NOT_SIGNED_ON = 'not signed on';

export const NOT_JSON = (line: string): string => `not JSON: ${line.slice(0, 80)}`;
export const NO_COMMAND = (line: string): string => `not a command with a numeric id: ${line.slice(0, 80)}`;
export const NOT_OBJECT = (line: string): string => `not an object: ${line.slice(0, 80)}`;
export const UNKNOWN_EVENT = (name: string): string => `unknown event "${name}"`;
export const EVENT_FIELD = (name: string, field: string, type: string): string =>
  `event "${name}" needs ${field} as a ${type}`;
export const NEITHER = (line: string): string => `neither a reply nor an event: ${line.slice(0, 80)}`;
export const FAILED_NEEDS_ERROR = 'a failed reply needs an error';
export const BAD_BUDDIES = 'a reply needs buddies as a list of screenName, online and away';

export const SUITE_HEADER = (version: string, protocol: number): string =>
  `suite ${version}, driver protocol ${protocol}`;
export const LINE_OK = (name: string, ms: number): string => `ok   ${name} (${(ms / 1000).toFixed(1)} s)`;
export const LINE_FAIL = (name: string, reason: string): string => `FAIL ${name}: ${reason}`;
export const SUMMARY = (passed: number, total: number): string => `${passed} of ${total} passed`;
export const UNKNOWN_SCENARIO = (name: string): string => `unknown scenario "${name}"`;
export const SCENARIO_TIMEOUT = (ms: number): string => `the scenario ran past ${ms / 1000} s`;
export const FAULTS = (detail: string): string => `the test server recorded a fault: ${detail}`;
export const DRIVER_SAID = (line: string): string => `the driver wrote: ${line}`;

export const EXPECTED_ERROR = (wanted: string, got: string): string => `signOn replied ${got}, not ${wanted}`;
export const REPLIED_OK = 'signOn replied ok, not an error';
export const REPLY_FAILED = (op: string, error: string): string => `${op} failed with ${error}`;
export const EXTRA_LOGINS = (count: number): string => `expected 1 login, saw ${count} logins`;
export const NO_PEER_IM = (ms: number): string => `the peer did not receive the IM within ${ms / 1000} s`;
export const BUDDY_MISSING = 'the buddy list has no Alice';
export const BUDDY_WRONG = (online: boolean): string => `Alice should be ${online ? 'online' : 'offline'}`;
export const BACKOFF_TOO_SHORT = (inMs: number): string => `reconnecting in ${inMs} ms, under 1000 ms`;
export const RECONNECTED_EARLY = (ms: number): string => `the second login came ${ms} ms after the drop, under 1000 ms`;
export const NEVER_RECONNECTED = 'the driver did not log in a second time';
export const DISCONNECTED = 'the burst left Bot without a BOS connection';
export const BURST_TOO_SLOW = (count: number, ms: number): string => `${count} IMs did not all reply within ${ms / 1000} s`;
export const WAITING_FOR = (what: string): string => `no ${what} within the time limit`;
