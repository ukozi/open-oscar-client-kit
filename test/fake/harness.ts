import { OscarClient } from '../../src/client/oscar-client.js';
import type { IconChange } from '../../src/client/icons.js';
import type { OscarClientEvents, OscarClientOptions } from '../../src/client/oscar-client.js';
import { ByteReader } from '../../src/wire/bytes.js';
import { decodeFeedbagReply, readFeedbagItem } from '../../src/wire/feedbag.js';
import type { FeedbagItem } from '../../src/wire/feedbag.js';
import type { BuddyList, BuddyPresence, IncomingIm } from '../../src/model/buddy-list.js';
import type { DirectImOffer, DirectImStatus, DirectMessage } from '../../src/model/direct-im.js';
import type { BrowseStatus, FileListing, ShareRequest, ShareStatus, ShareTaken } from '../../src/model/get-file.js';
import type { Invite, RoomMessage, RoomOccupantChange, RoomStatus } from '../../src/model/room.js';
import type { SelfInfo } from '../../src/model/session.js';
import type { FileOfferNotice, TransferStatus } from '../../src/model/transfer.js';
import { bytesOf, loadVectors } from '../support/vectors.js';
import { ManualTimers, captureLog } from './oscar-client.js';
import type { FakeOscarServer } from './oscar-server.js';

export type ClientHarness = {
  client: OscarClient;
  timers: ManualTimers;
  logs: ReturnType<typeof captureLog>;
  states: OscarClientEvents['state'][];
  selves: SelfInfo[];
  lists: BuddyList[];
  presence: BuddyPresence[];
  ims: IncomingIm[];
  rates: { limited: boolean }[];
  infos: OscarClientEvents['buddyInfo'][];
  warnings: OscarClientEvents['warned'][];
  typings: OscarClientEvents['typing'][];
  autoResponses: OscarClientEvents['autoResponse'][];
  /** Every `room` and `roomOccupant` event, in order. */
  rooms: RoomStatus[];
  occupantChanges: RoomOccupantChange[];
  roomMessages: RoomMessage[];
  invites: Invite[];
  declines: { roomId: string; by: string }[];
  /** Every `icon` event, in order. */
  icons: IconChange[];
  fileOffers: FileOfferNotice[];
  transfers: TransferStatus[];
  directImOffers: DirectImOffer[];
  directIms: DirectImStatus[];
  directMessages: DirectMessage[];
  fileListings: FileListing[];
  browses: BrowseStatus[];
  shareRequests: ShareRequest[];
  shares: ShareStatus[];
  sharesTaken: ShareTaken[];
  signOn(screenName?: string, password?: string): Promise<'online' | 'cancelled'>;
};

const clients: OscarClient[] = [];

export function makeClient(
  server: FakeOscarServer,
  over: Omit<Partial<OscarClientOptions>, 'now' | 'timers'> & { timers?: ManualTimers } = {},
): ClientHarness {
  const { timers: given, ...rest } = over;
  const timers = given ?? new ManualTimers();
  const logs = captureLog();
  const client = new OscarClient({
    ...rest,
    log: over.log ?? logs.log,
    // The shared default budget adds real 2 s waits between sign-ons.
    loginBudget: over.loginBudget ?? { take: async () => {} },
    now: timers.now,
    timers: timers.api,
  });
  clients.push(client);
  const harness: ClientHarness = {
    client,
    timers,
    logs,
    states: [],
    selves: [],
    lists: [],
    presence: [],
    ims: [],
    rates: [],
    infos: [],
    warnings: [],
    typings: [],
    autoResponses: [],
    rooms: [],
    occupantChanges: [],
    roomMessages: [],
    invites: [],
    declines: [],
    icons: [],
    fileOffers: [],
    transfers: [],
    directImOffers: [],
    directIms: [],
    directMessages: [],
    fileListings: [],
    browses: [],
    shareRequests: [],
    shares: [],
    sharesTaken: [],
    signOn: (screenName = 'Alice', password = 'alicepw1') =>
      client.signOn({ screenName, password }, { host: '127.0.0.1', port: server.port }),
  };
  client.on('state', (state) => harness.states.push(state));
  client.on('self', (self) => harness.selves.push(self));
  client.on('buddyList', (list) => harness.lists.push(list));
  client.on('presence', (presence) => harness.presence.push(presence));
  client.on('im', (im) => harness.ims.push(im));
  client.on('rate', (rate) => harness.rates.push(rate));
  client.on('buddyInfo', (info) => harness.infos.push(info));
  client.on('warned', (warned) => harness.warnings.push(warned));
  client.on('typing', (typing) => harness.typings.push(typing));
  client.on('autoResponse', (sent) => harness.autoResponses.push(sent));
  client.on('room', (status) => harness.rooms.push(status));
  client.on('roomOccupant', (change) => harness.occupantChanges.push(change));
  client.on('roomMessage', (message) => harness.roomMessages.push(message));
  client.on('roomInvite', (invite) => harness.invites.push(invite));
  client.on('inviteDeclined', (declined) => harness.declines.push(declined));
  client.on('icon', (change) => harness.icons.push(change));
  client.on('fileOffer', (offer) => harness.fileOffers.push(offer));
  client.on('transfer', (status) => harness.transfers.push(status));
  client.on('directImOffer', (offer) => harness.directImOffers.push(offer));
  client.on('directIm', (status) => harness.directIms.push(status));
  client.on('directMessage', (message) => harness.directMessages.push(message));
  client.on('fileListing', (listing) => harness.fileListings.push(listing));
  client.on('browse', (status) => harness.browses.push(status));
  client.on('shareRequest', (request) => harness.shareRequests.push(request));
  client.on('share', (status) => harness.shares.push(status));
  client.on('shareTaken', (taken) => harness.sharesTaken.push(taken));
  return harness;
}

// An IM's acknowledgement arrives in order, so when it resolves the client and the test server have each read all the other wrote before it.
export async function imRoundTrip(fake: FakeOscarServer, h: ClientHarness): Promise<void> {
  fake.peer('Echo');
  await h.client.sendIm('Echo', [{ text: 'ping' }]);
}

export async function stopAllClients(): Promise<void> {
  for (const client of clients.splice(0)) await client.signOff();
}

/** The six items of the feedbag reply vector. */
export function sampleFeedbag(): FeedbagItem[] {
  return decodeFeedbagReply(bytesOf(loadVectors('hand-session.json'), 'feedbag reply body, six items')).items;
}

/** The items plus the preference item with typing enabled (class 5, group 0, item id 9), so sign-on writes nothing. */
export function withTypingPref(items: readonly FeedbagItem[]): FeedbagItem[] {
  const pref = readFeedbagItem(new ByteReader(bytesOf(loadVectors('hand-lists-info.json'), 'feedbag item, buddy preferences with typing enabled')));
  return [...items, pref];
}
