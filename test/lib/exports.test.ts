import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as root from '../../lib/index.js';

const PUBLIC_MEMBERS = ['screenName', 'on', 'sendIm', 'buddies', 'signOff'];

describe('the root entry', () => {
  it('exports only the public API', () => {
    expect(Object.keys(root).sort()).toEqual(['Session', 'SignOnFailedError', 'VERSION', 'signOn']);
  });

  it('gives Session no public method other than its API', () => {
    const methods = Object.getOwnPropertyNames(root.Session.prototype).filter((name) => name !== 'constructor');
    expect(methods.sort()).toEqual(['buddies', 'on', 'sendIm', 'signOff']);
  });

  it('declares only the public members of Session', () => {
    const dts = readFileSync('dist/lib/session.d.ts', 'utf8');
    const body = /export declare class Session \{\n([\s\S]*?)\n\}/.exec(dts)?.[1];
    expect(body).toBeDefined();
    const members = (body ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('/') && !line.startsWith('*'));
    // Private and # members are not usable outside the class.
    const usable = members.filter((line) => !line.startsWith('private ') && !line.startsWith('#'));
    expect(usable.map((line) => /^(?:readonly )?(\w+)/.exec(line)?.[1])).toEqual(PUBLIC_MEMBERS);
    expect(members.filter((line) => line.startsWith('private '))).toEqual(['private constructor();']);
  });
});
