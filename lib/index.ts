/**
 * The simple API: it signs on with one call and gives a session that sends IMs, receives IMs and shows the buddy list.
 *
 * @module open-oscar-client-kit
 */
import { openSession } from './session.js';
import type { Session, SignOnOptions } from './session.js';

export { Session, SignOnFailedError } from './session.js';
export type { Buddy, Im, SessionEvents, SignOnOptions } from './session.js';
export { VERSION } from './version.js';

export function signOn(options: SignOnOptions): Promise<Session> {
  return openSession(options);
}
