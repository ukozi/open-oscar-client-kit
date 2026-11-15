import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NoDirectoryError } from '../../src/client/directory.js';
import { ByteReader } from '../../src/wire/bytes.js';
import type { KeywordGroup } from '../../src/wire/odir.js';
import { makeClient, stopAllClients } from '../fake/harness.js';
import type { ClientHarness } from '../fake/harness.js';
import { ManualTimers } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';
import type { SnacRecord } from '../fake/oscar-server.js';

const ODIR = 0x000f;
const KEYWORDS: KeywordGroup[] = [
  { category: 'Music', keywords: ['Jazz', 'Rock'] },
  { category: 'Sports', keywords: ['Tennis'] },
  { category: null, keywords: ['Hiking'] },
];
const EMPTY_LISTING = { firstName: '', lastName: '', city: '', state: '', country: '' };
const EMPTY_EXTRAS = { middleName: '', maidenName: '', nickName: '', zip: '', address: '' };

let timers: ManualTimers;
let fake: FakeOscarServer;
let h: ClientHarness;

beforeEach(async () => {
  timers = new ManualTimers();
  fake = await FakeOscarServer.start({ now: timers.now });
  fake.addUser('Alice', 'alicepw1');
  fake.addUser('Bob Smith', 'bobpw1');
  fake.addUser('Carol', 'carolpw1');
  fake.setKeywordList(KEYWORDS);
  h = makeClient(fake, { timers });
});

afterEach(async () => {
  await stopAllClients();
  await fake.stop();
});

const is = (family: number, subtype: number) => (s: SnacRecord): boolean => s.family === family && s.subtype === subtype;
// The service requests Alice sent for the ODir food group.
const odirServiceRequests = (): SnacRecord[] => fake.snacsFrom('Alice').filter((s) => is(0x01, 0x04)(s) && new ByteReader(s.body).u16() === ODIR);

describe('the directory against the test server', () => {
  it('saves a listing and reads it back, and the five fields outside a DirListing are cleared', async () => {
    fake.setListing('Alice', { firstName: 'Old', middleName: 'Middle', nickName: 'Nick', zip: '12345', address: '1 Road' });
    await h.signOn();
    expect(await h.client.ownListing()).toEqual({ ...EMPTY_LISTING, firstName: 'Old' });

    const listing = { firstName: 'Ada', lastName: 'Lovelace', city: 'Marylebone', state: 'London', country: 'UK' };
    await h.client.setListing(listing);
    expect(fake.listingOf('alice')).toEqual({ ...listing, ...EMPTY_EXTRAS });
    expect(await h.client.ownListing()).toEqual(listing);
    // Listing and interests go over BOS.
    expect(fake.snacsFrom('Alice').filter((s) => s.family === 0x02 && [0x09, 0x0b].includes(s.subtype)).map((s) => s.conn)).toEqual([
      'bos',
      'bos',
      'bos',
    ]);
  });

  it('gives the keyword list over an ODir connection, opened once for the session', async () => {
    await h.signOn();
    expect(await h.client.directoryKeywords()).toEqual(KEYWORDS);
    expect(await h.client.directoryKeywords()).toEqual(KEYWORDS);
    expect(h.client.directoryAvailable()).toBe(true);
    expect(odirServiceRequests().map((s) => s.conn)).toEqual(['bos']);
    expect(fake.openConnections('Alice')).toEqual(['bos', 'odir']);
    expect(fake.snacsFrom('Alice').filter((s) => s.family === ODIR).map((s) => s.conn)).toEqual(['odir', 'odir']);
  });

  it('saves interests, keeps only those the server offers, and finds a member by one of them', async () => {
    await h.signOn();
    await h.client.setListing({ firstName: 'Ada', lastName: 'Lovelace', city: '', state: 'London', country: 'UK' });
    await h.client.setInterests(['Rock', 'Knitting', 'Hiking']);
    expect(fake.keywordsOf('Alice')).toEqual(['Rock', 'Hiking']);
    expect(fake.keywordWrites('Alice')).toEqual([['Rock', 'Knitting', 'Hiking']]);
    fake.setKeywords('Carol', ['Jazz']);

    expect(await h.client.findByInterest('Hiking')).toEqual([
      { screenName: 'Alice', firstName: 'Ada', lastName: 'Lovelace', city: '', state: 'London', country: 'UK' },
    ]);
    // Exact: another case is another keyword.
    expect(await h.client.findByInterest('rock')).toEqual([]);
    expect((await h.client.findByInterest('Jazz')).map((r) => r.screenName)).toEqual(['Carol']);
    expect(await h.client.findByInterest('Knitting')).toEqual([]);
  });

  it('finds a member by last name in other capitals, and by every name given', async () => {
    fake.setListing('Bob Smith', { firstName: 'Bob', lastName: 'Smith', city: 'Leeds', country: 'UK' });
    fake.setListing('Carol', { firstName: 'Carol', lastName: 'Smith' });
    await h.signOn();
    const bob = { screenName: 'Bob Smith', firstName: 'Bob', lastName: 'Smith', city: 'Leeds', state: '', country: 'UK' };
    const carol = { screenName: 'Carol', firstName: 'Carol', lastName: 'Smith', city: '', state: '', country: '' };
    expect(await h.client.findByName('', 'sMITH')).toEqual([bob, carol]);
    expect(await h.client.findByName('  bob ', 'smith')).toEqual([bob]);
    expect(await h.client.findByName('Bo', '')).toEqual([]);
    expect(await h.client.findByName('Dave', '')).toEqual([]);
  });

  it('leaves interests set on another computer alone when only the listing is saved', async () => {
    fake.setKeywords('Alice', ['Jazz', 'Tennis']);
    await h.signOn();
    await h.client.setListing({ firstName: 'Ada', lastName: '', city: '', state: '', country: '' });
    expect(fake.keywordsOf('Alice')).toEqual(['Jazz', 'Tennis']);
    expect(fake.keywordWrites('Alice')).toEqual([]);
    expect((await h.client.findByInterest('Tennis')).map((r) => r.screenName)).toEqual(['Alice']);
  });

  it('has no directory when the server refuses the ODir service as not supported', async () => {
    fake.setOdirRefusal(0x0008);
    await h.signOn();
    await expect(h.client.findByName('Ada', '')).rejects.toBeInstanceOf(NoDirectoryError);
    expect(h.client.directoryAvailable()).toBe(false);
    await expect(h.client.directoryKeywords()).rejects.toBeInstanceOf(NoDirectoryError);
    expect(odirServiceRequests()).toHaveLength(1);
    expect(fake.openConnections('Alice')).toEqual(['bos']);
  });

  it('has no directory when the server refuses the ODir service as not available', async () => {
    fake.setOdirRefusal(0x0005);
    await h.signOn();
    await expect(h.client.findByInterest('Rock')).rejects.toBeInstanceOf(NoDirectoryError);
    expect(h.client.directoryAvailable()).toBe(false);
  });
});
