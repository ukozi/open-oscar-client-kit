import { describe, expect, it } from 'vitest';
import * as client from '../../src/client/index.js';
import * as model from '../../src/model/index.js';
import * as wire from '../../src/wire/index.js';
import * as testing from '../fake/index.js';

const MODEL = [
  'AWAY_RECORD_CLASS', 'AWAY_RECORD_GROUP', 'AWAY_RECORD_VERSION', 'AWAY_TAG', 'AWAY_ITEM_ID_MIN', 'AWAY_ITEM_ID_MAX',
  'encodeAwayAttrs', 'decodeAwayAttrs', 'awayRecordItem', 'isAwayRecordItem', 'compareAwayRecords', 'chooseAwayItem', 'freeAwayItemId',
  'placeholderAwayRecord', 'nextAwayRecord', 'followAwayRecord', 'signOnAway', 'awayText', 'awayBody',
  'MOBILE_CAPABILITY', 'DIRECT_IM_CAPABILITY', 'GET_FILE_CAPABILITY', 'otherInstances', 'privacyChange', 'settledBuddies', 'roomConversationId', 'roomLineBlocked', 'aimVariableValues',
  'isHtmlBody',
];

const CLIENT = [
  'OscarClient', 'bucpTicketSource', 'storedTicketSource', 'adapterTicketSource', 'clientLogin', 'desktopReconnectPolicy', 'dropEvidence',
  'DESKTOP_REJOIN', 'SKIPPED_SENDERS_MAX', 'SignOnError', 'OscarError', 'createLoginBudget', 'memoryIconStore',
  'Rendezvous', 'rendezvousEnded', 'OFFER_ACCEPT_MS', 'COUNTER_DIAL_MS', 'openPeerLink', 'PeerClosedError', 'PEER_CONNECT_TIMEOUT_MS',
  'sendFiles', 'receiveFiles', 'OftError', 'Transfers', 'MAX_OFFER_BYTES', 'MAX_WAITING_OFFERS', 'PEER_CANCEL_WAIT_MS',
  'OdcSession', 'OdcError', 'DirectIm',
  'sendFile', 'receiveFile', 'receiveAnswered', 'readOftHeader', 'readOftFrame', 'BrowseSession', 'ServeSession', 'GetFileError', 'GetFile', 'NOT_THERE_CLOSE_MS',
];

const WIRE = [
  'CAP_MOBILE_CLIENT', 'CAP_UTF8_MESSAGES', 'CAP_CHAT', 'readOosCookieExpiry', 'TOKEN_TTL_MAX_SECONDS', 'decodePopup', 'FAMILY_POPUP',
  'CAP_SEND_FILE', 'CAP_DIRECT_IM', 'CAP_GET_FILE', 'CAP_BUDDY_ICON', 'RDV_TYPE_ACCEPT', 'RDV_TLV_RDV_IP', 'RDV_TLV_REQUESTER_IP', 'RDV_TLV_VERIFIED_IP',
  'RDV_TLV_PORT', 'RDV_TLV_USE_PROXY', 'RDV_TLV_IP_XOR', 'RDV_TLV_PORT_XOR', 'RDV_CANCEL_TIMEOUT', 'RDV_CANCEL_ELSEWHERE', 'ICBM_CLIENT_ERR',
  'MAX_OFFER_BYTES', 'tolerantTlvs', 'serviceOf', 'capabilityOf', 'parseRendezvous', 'encodeFileProposal', 'encodeDirectImProposal', 'encodeGetFileProposal', 'encodeRendezvousAccept',
  'encodeRendezvousCancel', 'decodeClientError', 'rendezvousCapability', 'offeredFolder',
  'OFT_PROMPT', 'OFT_ACK', 'OFT_DONE', 'OFT_RESUME', 'OFT_RESUME_ANSWER', 'OFT_RESUME_ACK', 'OFT_HEADER_MIN', 'OFT_CHECKSUM_START',
  'encodeOftHeader', 'oftHeaderLength', 'decodeOftHeader', 'oftChecksum', 'sameOftChecksum',
  'OFT_LISTING', 'OFT_LISTING_ACK', 'OFT_LISTING_DONE', 'OFT_FILE_REQUEST',
  'GET_FILE_MAX_LISTING_BYTES', 'GET_FILE_MAX_ENTRIES', 'GET_FILE_MAX_SERVING', 'GET_FILE_MAX_NAME_BYTES',
  'OFT_NAME_OFFSET', 'OFT_SIZE_OFFSET', 'OFT_FLAG_RECEIVED', 'decodeOftFrame', 'answerOftFrame',
  'decodeListing', 'encodeListing', 'pathParts', 'listingHeader', 'listingLength', 'listingAck', 'listingDone', 'requestHeader', 'requestedPath',
  'LISTING_COLUMNS', 'LISTING_NAME',
  'ODC_HEADER_BYTES', 'ODC_HEADER_MAX_BYTES', 'ODC_FLAG_AUTO', 'ODC_FLAG_TYPING_NOTICE', 'ODC_FLAG_TYPING', 'ODC_FLAG_TYPED', 'ODC_FLAG_HELLO',
  'DIRECT_IM_MAX_MESSAGE_BYTES', 'DIRECT_IM_MAX_ATTACHMENTS', 'DIRECT_IM_MAX_TEXT_BYTES', 'DIRECT_IM_MAX_SESSION_BYTES',
  'odcHeaderLength', 'decodeOdcHeader', 'encodeOdcHeader', 'odcKind', 'odcTextBytes', 'decodeOdcMessage', 'encodeOdcMessage',
];

const TESTING = [
  'FakeOscarServer', 'startClientLoginFake', 'makeClient', 'ManualTimers', 'RawClient', 'waitFor', 'settle', 'captureLog', 'withTypingPref', 'sampleFeedbag',
  'FakeRelay', 'RELAY_SILENCE_MS', 'PeerGetFile', 'treeSource',
];

const surface: [string, Record<string, unknown>, string[]][] = [
  ['model', model, MODEL],
  ['client', client, CLIENT],
  ['wire', wire, WIRE],
  ['testing', testing, TESTING],
];

describe('the barrels', () => {
  it.each(surface)('%s exports every name the host builds on', (_entry, barrel, names) => {
    for (const name of names) expect(typeof barrel[name], name).not.toBe('undefined');
  });

  it('the client does not export the helpers of a server connection', () => {
    const names: Record<string, unknown> = client;
    expect([names.connectionTls, names.redirectMode]).toEqual([undefined, undefined]);
  });

  it('the client does not export the entry for a rate notice from a different connection', () => {
    const names: Record<string, unknown> = client;
    expect([names.strayRate, names.takesStrayRate]).toEqual([undefined, undefined]);
  });

  it('the testing entry exports the server side of a connection as a type only', () => {
    const names: Record<string, unknown> = testing;
    expect([names.Conn, names.PeerControl]).toEqual([undefined, undefined]);
  });

  it('the client has the calls that choose icons', () => {
    expect(typeof client.OscarClient.prototype.setIconsFrom).toBe('function');
    expect(typeof client.OscarClient.prototype.setAcceptNonListIcons).toBe('function');
  });

  it('the client has the Direct IM calls', () => {
    for (const name of ['openDirectIm', 'acceptDirectIm', 'declineDirectIm', 'closeDirectIm', 'sendDirectMessage'] as const) {
      expect(typeof client.OscarClient.prototype[name], name).toBe('function');
    }
  });

  it('the client has the Get File calls', () => {
    for (const name of ['browseFiles', 'takeFile', 'closeBrowse', 'shareFiles', 'allowShare', 'refuseShare'] as const) {
      expect(typeof client.OscarClient.prototype[name], name).toBe('function');
    }
    // One listing holds the whole shared folder, thus the client has no call that asks for a folder.
    expect('listFolder' in client.OscarClient.prototype).toBe(false);
  });
});
