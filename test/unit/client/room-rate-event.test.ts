import { describe, expect, it } from 'vitest';
import { OscarClient } from '../../../src/client/oscar-client.js';
import type { RoomRate } from '../../../src/model/index.js';

describe('the roomRate event', () => {
  it('takes a listener and gives a function that removes it', () => {
    const client = new OscarClient();
    const heard: RoomRate[] = [];
    const off = client.on('roomRate', (rate) => heard.push(rate));
    expect(() => off()).not.toThrow();
    expect(heard).toEqual([]);
  });
});
