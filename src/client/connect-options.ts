import type { ConnectionOptions, RedirectMode } from '../wire/connection.js';
import type { ServerAddress } from './sign-on.js';

/** The TLS part of the options of a server connection. With no `tls`, the connection is plain TCP. */
export function connectionTls(tls: { caFile?: string } | undefined): Pick<ConnectionOptions, 'tls' | 'caFile'> {
  return tls ? { tls: true, caFile: tls.caFile } : { tls: false };
}

/** The rule for an advertised host: a pin comes first, then `follow`. */
export function redirectMode(pin: ServerAddress | undefined, follow: boolean | undefined): RedirectMode {
  if (pin) return 'pin';
  return follow === true ? 'follow' : 'auto';
}
