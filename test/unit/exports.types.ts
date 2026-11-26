import type {
  AutoResponseDecision,
  AwayRecordOptions,
  BringUpHooks,
  ClientLoginResult,
  DirectImDeps,
  DirectImOptions,
  DropEvidence,
  FileTransferOptions,
  GetFileOptions,
  GuardSite,
  HostingLimits,
  IconStore,
  IconsFrom,
  IssuedTicket,
  OftFailure,
  OftSignal,
  OscarClientEvents,
  OscarClientOptions,
  PeerLink,
  PreOnlineContext,
  PreOnlinePlan,
  ReconnectDecision,
  ReconnectPolicy,
  RejoinPolicy,
  RendezvousDeps,
  RendezvousEnd,
  RendezvousOutcome,
  ResumeState,
  SendImOptions,
  SentIm,
  ServiceSwitch,
  Siblings,
  SignOnOptions,
  StoredTicketSource,
  TicketRequest,
  TicketSource,
  TransfersDeps,
} from '../../src/client/index.js';
import { DIRECT_IM_CAPABILITY, GET_FILE_CAPABILITY, SEND_FILE_CAPABILITY, isHtmlBody, roomConversationId } from '../../src/model/index.js';
import type {
  AnyRoom,
  AwayAttr,
  AwayChange,
  AwayItem,
  AwayRecord,
  AwaySignOnPlan,
  AwayState,
  BrowseStatus,
  BuddyList,
  BuddyPresence,
  ChosenMode,
  DirectAttachment,
  DirectImEnd,
  DirectImOffer,
  DirectImState,
  DirectImStatus,
  DirectMessage,
  DirectPart,
  FileListing,
  FileOfferNotice,
  FileSink,
  FileWriter,
  GetFileEnd,
  HtmlBody,
  ImBody,
  IncomingFile,
  IncomingIm,
  InstanceInfo,
  Invite,
  InviteWire,
  LocalRefusal,
  MessageWire,
  OutgoingDirectMessage,
  OutgoingFile,
  OutgoingPicture,
  PrivacyChange,
  RichText,
  RoomMessage,
  RoomRate,
  RoomRef,
  RoomStatus,
  ShareRequest,
  ShareStatus,
  ShareTaken,
  SharedEntry,
  SharedSource,
  SignOffReason,
  SignOnFailure,
  TimeFormat,
  TransferFailure,
  TransferProgress,
  TransferState,
  TransferStatus,
  UserInfoResult,
  UserInfoSnapshot,
} from '../../src/model/index.js';
import type { Endpoint, LogFn, PeerAddress } from '../../src/wire/index.js';
import type { ClientHarness, CloseHow, FakeOscarServer, PeerDirectIm, PeerTypingEvent, Relayed, StartOptions } from '../fake/index.js';

export const presence: BuddyPresence = { screenName: 'Bob', online: true, away: false, idleSince: null, signedOnAt: null, warnLevel: 0, mobile: true };
export const sendsFiles: BuddyPresence = { ...presence, capabilities: [SEND_FILE_CAPABILITY] };
export const address: PeerAddress = { ip: '192.0.2.1', port: 5190 };
export const transferOptions: OscarClientOptions = { fileTransfer: { allowDial: (to) => to.port === address.port } };
export const offerHeard: OscarClientEvents['fileOffer'] = { id: 'bob:0000000000000001', from: 'Bob', count: 1, totalBytes: 3, name: 'a.txt', folder: null, at: 0 };
export const transferHeard: OscarClientEvents['transfer'] = {
  id: offerHeard.id, direction: 'in', peer: 'Bob', state: 'failed', failure: 'peer-closed', count: 1, index: 0, name: 'a.txt', bytesDone: 0, bytesTotal: 3,
};
export const collected: [ClientHarness['fileOffers'], ClientHarness['transfers']] = [[offerHeard], [transferHeard]];
export const sendsPictures: BuddyPresence = { ...presence, capabilities: [DIRECT_IM_CAPABILITY] };
export const directImOptions: OscarClientOptions = {
  directIm: { allowDial: (to) => to.port === address.port, maxMessageBytes: 1024, maxAttachments: 2, maxTextBytes: 512, maxSessionBytes: 4096, sendUnverifiedAfterMs: null },
};
export const directImOfferHeard: OscarClientEvents['directImOffer'] = { id: 'bob:0000000000000002', from: 'Bob', at: 0 };
export const directImHeard: OscarClientEvents['directIm'] = {
  id: directImOfferHeard.id, peer: 'Bob', role: 'receiving', state: 'closed', end: 'peer-closed', by: 'peer', verified: false,
};
export const directMessageHeard: OscarClientEvents['directMessage'] = {
  id: directImOfferHeard.id, from: 'Bob', at: 0, autoResponse: false,
  parts: [{ kind: 'text', body: [{ text: 'hello' }] }, { kind: 'attachment', index: 0 }, { kind: 'missing' }],
  attachments: [{ id: 1, name: 'a.png', bytes: new Uint8Array(1) }], unreferenced: 0, damaged: false,
};
export const directMessageOut: OutgoingDirectMessage = { pictures: [{ name: 'a.png', bytes: new Uint8Array(1), width: 1, height: 1 }] };
export const directImCollected: [ClientHarness['directImOffers'], ClientHarness['directIms'], ClientHarness['directMessages']] = [
  [directImOfferHeard], [directImHeard], [directMessageHeard],
];
export const sharesFiles: BuddyPresence = { ...presence, capabilities: [GET_FILE_CAPABILITY] };
export const getFileOptions: OscarClientOptions = {
  getFile: { allowDial: (to) => to.port === address.port, maxListingBytes: 4096, maxEntries: 100, maxServing: 2 },
};
export const buddyIconOptions: OscarClientOptions = { buddyIcon: true };
export const someServices: ServiceSwitch = { fileTransfer: true, getFile: false };
export const sharedEntry: SharedEntry = { path: ['a.txt'], folder: false, bytes: 3, modifiedAt: 0 };
export const sharedSource: SharedSource = { list: async (folder) => (folder.length === 0 ? [sharedEntry] : null), open: async () => null };
export const getFileEnd: GetFileEnd = 'peer-closed';
export const fileListingHeard: OscarClientEvents['fileListing'] = {
  browseId: 'bob:0000000000000003', from: 'Bob', folder: [], entries: [sharedEntry], truncated: false, damaged: false,
};
export const browseHeard: OscarClientEvents['browse'] = { id: fileListingHeard.browseId, peer: 'Bob', state: 'closed', end: getFileEnd, by: 'peer' };
export const shareRequestHeard: OscarClientEvents['shareRequest'] = { id: 'bob:0000000000000004', from: 'Bob', at: 0 };
export const shareHeard: OscarClientEvents['share'] = { id: shareRequestHeard.id, peer: 'Bob', state: 'asked' };
export const shareTakenHeard: OscarClientEvents['shareTaken'] = { id: shareRequestHeard.id, peer: 'Bob', path: sharedEntry.path, bytes: 3, at: 0 };
export const getFileCollected: [
  ClientHarness['fileListings'], ClientHarness['browses'], ClientHarness['shareRequests'], ClientHarness['shares'], ClientHarness['sharesTaken'],
] = [[fileListingHeard], [browseHeard], [shareRequestHeard], [shareHeard], [shareTakenHeard]];
export const relayOn: StartOptions = { relay: true };
export const ref: RoomRef = { exchange: 4, name: 'Lobby' };
export const key: string = roomConversationId(ref); // 'room:4:lobby'
export const failure: SignOnFailure[] = [{ kind: 'login-rate-limited' }, { kind: 'too-many-sessions' }];
export const sessionOptions: OscarClientOptions = {
  tls: { caFile: 'x' }, followRedirects: true, sessionBuddies: () => [], wireDetail: true, botFlagExempt: true, maxRooms: 20, iconsFrom: 'none',
};
export const htmlBody: ImBody = { html: '' };
export const richBody: ImBody = [{ text: 'x' }];
export const isHtml: boolean = isHtmlBody(htmlBody);
export const sendOptions: SendImOptions = { automatic: true, store: 'when-offline' };
export const sentIm: SentIm = { id: '0000000000000001', stored: true };
export const roomRate: RoomRate = { roomId: key, status: 'limited' };
export const roomRateHeard: OscarClientEvents['roomRate'] = roomRate;
export const imWire: IncomingIm['wire'] = { cookie: '0000000000000001', html: '<B>x</B>' };
export const roomWire: RoomMessage['wire'] = imWire;
export const inviteWire: Invite['wire'] = { html: '' };
export const fakeOptions: StartOptions = { tls: true, sslHost: false, generation: 'v0.24', checkPasswords: false };
export const botUser: Parameters<FakeOscarServer['addUser']>[2] = { bot: true };
export const endpoint: Endpoint = { host: '192.0.2.1', port: 5190 };
export const logFn: LogFn = () => {};
export const awayState: AwayState = { away: true, text: 'out' };
export const anyRoom: AnyRoom = ref;
export const chosenMode: ChosenMode = 'allow-buddies';
export const bringUpHooks: BringUpHooks | null = null;
export const closeHow: CloseHow = 'kick';
export const peerTyping: PeerTypingEvent = { from: 'Bob', event: 2 };
// @ts-expect-error
export const r: SignOffReason = { kind: 'keyring-locked' };
// @ts-expect-error
export const l: LocalRefusal = 'no-saved-password';

export type ModelTypes = [
  AwayAttr,
  AwayChange,
  AwayItem,
  AwayRecord,
  AwaySignOnPlan,
  BrowseStatus,
  BuddyList,
  DirectAttachment,
  DirectImEnd,
  DirectImOffer,
  DirectImState,
  DirectImStatus,
  DirectMessage,
  DirectPart,
  FileListing,
  FileOfferNotice,
  FileSink,
  FileWriter,
  GetFileEnd,
  HtmlBody,
  IncomingFile,
  InstanceInfo,
  InviteWire,
  MessageWire,
  OutgoingDirectMessage,
  OutgoingFile,
  OutgoingPicture,
  PrivacyChange,
  RichText,
  RoomMessage,
  RoomStatus,
  ShareRequest,
  ShareStatus,
  ShareTaken,
  SharedEntry,
  SharedSource,
  SignOffReason,
  TimeFormat,
  TransferFailure,
  TransferProgress,
  TransferState,
  TransferStatus,
  UserInfoResult,
  UserInfoSnapshot,
];

export type ClientTypes = [
  AutoResponseDecision,
  AwayRecordOptions,
  ClientLoginResult,
  DirectImDeps,
  DirectImOptions,
  DropEvidence,
  FileTransferOptions,
  GetFileOptions,
  GuardSite,
  HostingLimits,
  IconStore,
  IconsFrom,
  IssuedTicket,
  OftFailure,
  OftSignal,
  OscarClientEvents,
  OscarClientOptions,
  PeerLink,
  PreOnlineContext,
  PreOnlinePlan,
  ReconnectDecision,
  ReconnectPolicy,
  RejoinPolicy,
  RendezvousDeps,
  RendezvousEnd,
  RendezvousOutcome,
  ResumeState,
  ServiceSwitch,
  Siblings,
  SignOnOptions,
  StoredTicketSource,
  TicketRequest,
  TicketSource,
  TransfersDeps,
];

export type TestingTypes = [StartOptions, Relayed, PeerDirectIm];
