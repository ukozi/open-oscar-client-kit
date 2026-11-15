import { describe, expect, it } from 'vitest';
import { LineSplitter, ProtocolError, encodeLine, parseDriverLine } from '../../suite/protocol.js';

describe('LineSplitter', () => {
  it('joins a line that arrives in two chunks and keeps the rest', () => {
    const splitter = new LineSplitter();
    expect(splitter.push('{"id":1,')).toEqual([]);
    expect(splitter.push('"ok":true}\n{"ev')).toEqual(['{"id":1,"ok":true}']);
    expect(splitter.push('ent":"online"}\n')).toEqual(['{"event":"online"}']);
  });
});

describe('encodeLine', () => {
  it('writes JSON and a newline', () => {
    expect(encodeLine({ id: 3, op: 'buddies' })).toBe('{"id":3,"op":"buddies"}\n');
  });
});

describe('parseDriverLine', () => {
  const good = [
    '{"id":1,"ok":true}',
    '{"id":1,"ok":false,"error":"wrong-password"}',
    '{"id":3,"ok":true,"buddies":[{"screenName":"Alice","online":true,"away":false}]}',
    '{"event":"online"}',
    '{"event":"im","from":"Alice","text":"hello"}',
    '{"event":"buddy","screenName":"Alice","online":true,"away":false}',
    '{"event":"warned","level":100}',
    '{"event":"rateLimited","limited":true}',
    '{"event":"reconnecting","attempt":1,"inMs":2000}',
    '{"event":"signedOff","reason":"signed-off-by-server"}',
  ];
  it.each(good)('accepts %s', (line) => {
    expect(parseDriverLine(line)).toEqual(JSON.parse(line));
  });

  it.each([
    'nope',
    '{"id":1}',
    '{"event":"dance"}',
    '{"id":3,"ok":true,"buddies":"x"}',
    '{"id":3,"ok":true,"buddies":[{"screenName":"Alice"}]}',
    '{"id":3,"ok":true,"buddies":[null]}',
  ])('rejects %s', (line) => {
    expect(() => parseDriverLine(line)).toThrow(ProtocolError);
  });
});
