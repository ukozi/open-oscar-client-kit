import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OscarClient } from '../../src/client/oscar-client.js';
import { FAMILY_POPUP, POPUP_DISPLAY } from '../../src/wire/constants.js';
import type { PopupNotice } from '../../src/client/oscar-client.js';
import { makeClient, stopAllClients } from '../fake/harness.js';
import type { ClientHarness } from '../fake/harness.js';
import { ManualTimers, waitFor } from '../fake/oscar-client.js';
import { FakeOscarServer } from '../fake/oscar-server.js';

const ascii = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'latin1'));

let timers: ManualTimers;
let server: FakeOscarServer;

beforeEach(async () => {
  timers = new ManualTimers();
  server = await FakeOscarServer.start({ now: timers.now });
  server.addUser('Alice', 'alicepw1');
});

afterEach(async () => {
  await stopAllClients();
  await server.stop();
});

async function signedOn(legacyCharset?: string): Promise<{ h: ClientHarness; popups: PopupNotice[] }> {
  const h = makeClient(server, { timers, legacyCharset });
  const popups: PopupNotice[] = [];
  h.client.on('popup', (popup) => popups.push(popup));
  await h.signOn();
  return { h, popups };
}

describe('a popup from the server', () => {
  it('emits popup for a SNAC from the server', async () => {
    const { popups } = await signedOn();
    server.sendPopup('Alice', { message: ascii('Back at <b>noon</b>'), url: 'https://example.com/', width: 640, height: 480 });
    await waitFor(() => popups.length === 1, 'the popup');
    expect(popups[0]).toEqual({
      message: 'Back at noon',
      body: [{ text: 'Back at ' }, { text: 'noon', bold: true }],
      url: 'https://example.com/',
      width: 640,
      height: 480,
    });
  });

  it('keeps the formatting of the HTML in the body, and only the text in the message', async () => {
    const { popups } = await signedOn();
    server.sendPopup('Alice', { message: ascii('<font color="#ff0000"><i>Hi</i></font><br><a href="https://example.com/">more</a>') });
    await waitFor(() => popups.length === 1, 'the popup');
    expect(popups[0]?.body).toEqual([{ text: 'Hi', italic: true, color: '#ff0000' }, { text: '\n' }, { text: 'more', link: 'https://example.com/' }]);
    expect(popups[0]?.message).toBe('Hi\nmore (https://example.com/)');
  });

  it('skips a malformed SNAC and stays signed on', async () => {
    const { h, popups } = await signedOn();
    server.sendSnac('Alice', FAMILY_POPUP, POPUP_DISPLAY, Uint8Array.of(0x00, 0x01, 0x00, 0x05, 0x61));
    server.peer('Bob').sendIm('Alice', 'still here');
    await waitFor(() => h.ims.length === 1, 'the IM after the bad SNAC');
    expect(popups).toEqual([]);
    expect(h.states.at(-1)?.state).toBe('online');
    expect(h.logs.text()).toContain('skipped a SNAC that could not be handled');
  });

  it('emits nothing for an empty message', async () => {
    const { h, popups } = await signedOn();
    server.sendPopup('Alice', { message: ascii('<b></b>'), url: 'https://secret.example/' });
    server.sendPopup('Alice', { message: ascii('after') });
    await waitFor(() => popups.length === 1, 'the popup after the empty one');
    expect(popups[0]?.message).toBe('after');
    expect(h.logs.lines.some((line) => line.level === 'warn' && line.msg.includes('popup'))).toBe(true);
    expect(h.logs.text()).not.toContain('secret.example');
  });

  it('takes legacyCharset from the options', async () => {
    const { popups } = await signedOn('iso-8859-2');
    server.sendPopup('Alice', { message: Uint8Array.of(0xb1) });
    await waitFor(() => popups.length === 1, 'the popup');
    expect(popups[0]?.message).toBe('ą');
  });

  it('throws RangeError for a charset the runtime does not know', () => {
    expect(() => new OscarClient({ legacyCharset: 'no-such-charset' })).toThrow(RangeError);
  });
});
