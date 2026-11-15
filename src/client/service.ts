import { decodeSnacErrorCode } from '../wire/chatnav.js';
import type { ServiceResolver } from '../wire/chatnav.js';
import { decideRedirect } from '../wire/connection.js';
import {
  FAMILY_OSERVICE,
  OSERVICE_ERR,
  OSERVICE_SERVICE_REQUEST,
  OSERVICE_SERVICE_RESPONSE,
  SERVICE_COOKIE_TTL_MS,
  SERVICE_REQUEST_TIMEOUT_MS,
} from '../wire/constants.js';
import { ServiceRefusedError, decodeServiceResponse, encodeServiceRequest } from '../wire/oservice.js';
import type { Snac } from '../wire/snac.js';
import type { BosLink } from './bos-link.js';
import { OscarError } from './errors.js';
import { redirectMode } from './connect-options.js';
import type { ServerAddress } from './sign-on.js';

/**
 * The service request on the BOS connection (0x01/0x04) and where its answer says to connect: for ChatNav, a room, the icon service.
 * With `pin`, always `pin`. With `tls`, the request asks for the SSL address. With `follow`, each advertised host is good. The default is none of them.
 */
export function serviceResolver(
  link: BosLink,
  server: ServerAddress,
  now: () => number,
  opts: { pin?: ServerAddress; tls?: { caFile?: string }; follow?: boolean } = {},
): ServiceResolver {
  const { pin } = opts;
  const secure = opts.tls !== undefined;
  const configured = { ...(pin ?? server), tls: secure };
  return async (family, roomInfo) => {
    const ask = (useSsl: boolean): Promise<Snac> =>
      link.requestMatching(
        FAMILY_OSERVICE,
        OSERVICE_SERVICE_REQUEST,
        encodeServiceRequest(family, { useSsl, roomInfo }),
        SERVICE_REQUEST_TIMEOUT_MS,
        (snac) => snac.family === FAMILY_OSERVICE && (snac.subtype === OSERVICE_SERVICE_RESPONSE || snac.subtype === OSERVICE_ERR),
      );
    let reply = await ask(secure);
    // A server that has no SSL address refuses the request. The plain request gives a cookie for the configured address.
    const plain = secure && reply.subtype === OSERVICE_ERR;
    if (plain) reply = await ask(false);
    if (reply.subtype === OSERVICE_ERR) throw new ServiceRefusedError(decodeSnacErrorCode(reply.body));
    const advertised = decodeServiceResponse(reply.body, server.port);
    const where = decideRedirect(plain ? 'pin' : redirectMode(pin, opts.follow), configured, advertised);
    if (where.refused) throw new OscarError({ kind: 'refused', code: 0 });
    return { host: where.host, port: where.port, cookie: advertised.cookie, pinned: where.pinned, expiresAt: now() + SERVICE_COOKIE_TTL_MS };
  };
}
