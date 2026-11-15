import { describe, expect, it } from 'vitest';
import { FALLBACK_CLIENT_ID, clientIdFor, platformToken } from '../../../src/client/client-id.js';

describe('platformToken', () => {
  it('names the three platforms as AIM did', () => {
    expect(platformToken('darwin')).toBe('MAC');
    expect(platformToken('win32')).toBe('WIN32');
    expect(platformToken('linux')).toBe('LINUX');
  });

  it('upper-cases any other platform rather than throwing', () => {
    expect(platformToken('freebsd')).toBe('FREEBSD');
  });
});

describe('clientIdFor', () => {
  it('builds the client ID byte for byte', () => {
    expect(clientIdFor('Chimr', '0.2.3', 'darwin')).toBe('Chimr, version 0.2.3/MAC');
    expect(clientIdFor('Chimr', '0.2.3', 'win32')).toBe('Chimr, version 0.2.3/WIN32');
    expect(clientIdFor('Chimr', '0.2.3', 'linux')).toBe('Chimr, version 0.2.3/LINUX');
    expect(clientIdFor('Chimr', '0.2.3-beta.1', 'darwin')).toBe('Chimr, version 0.2.3-beta.1/MAC');
    expect(clientIdFor('Echo', '1.0.0', 'linux')).toBe('Echo, version 1.0.0/LINUX');
  });
});

describe('FALLBACK_CLIENT_ID', () => {
  it('is a well-formed client ID for version 0.0.0 on no platform, whatever platform runs the test', () => {
    expect(FALLBACK_CLIENT_ID).toBe('OSCAR client, version 0.0.0/UNKNOWN');
  });
});
