import { FakeOscarServer } from '../fake/oscar-server.js';
import { buddyListFeedbag } from '../../lib/feedbag.js';

export async function startFake(): Promise<{ fake: FakeOscarServer; server: { host: string; port: number } }> {
  const fake = await FakeOscarServer.start();
  fake.addUser('Bot', 'botpass1');
  fake.setFeedbag('bot', buddyListFeedbag([{ name: 'Buddies', buddies: ['Alice'] }]));
  return { fake, server: { host: '127.0.0.1', port: fake.port } };
}

// The fake maps ICBM 0x04/0x06 to this rate class.
export const IM_RATE_CLASS = 3;
