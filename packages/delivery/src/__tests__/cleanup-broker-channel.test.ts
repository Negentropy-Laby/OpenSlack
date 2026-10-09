import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FileSystem from 'node:fs';
const fixture = vi.hoisted(() => ({
  input: Buffer.alloc(0),
  output: [] as Buffer[],
  fifo: true,
  fragment: 7,
  reads: 0,
}));
vi.mock('node:fs', async (original) => ({
  ...(await original<typeof FileSystem>()),
  fstatSync: (fd: number) => {
    if (![3, 4].includes(fd)) throw Error('unexpected fd');
    return { isFIFO: () => fixture.fifo };
  },
  readSync: (fd: number, buffer: Buffer, offset: number, length: number) => {
    if (fd !== 3) throw Error('unexpected input fd');
    fixture.reads++;
    const count = Math.min(length, fixture.input.length, fixture.fragment);
    fixture.input.copy(buffer, offset, 0, count);
    fixture.input = fixture.input.subarray(count);
    return count;
  },
  writeSync: (fd: number, buffer: Buffer, offset: number, length: number) => {
    expect(fd).toBe(4);
    const count = Math.min(length, 5);
    fixture.output.push(Buffer.from(buffer.subarray(offset, offset + count)));
    return count;
  },
}));
import {
  isCleanupBrokerChannel,
  openCleanupBrokerChannel,
} from '../internal/cleanup-broker-channel.js';

beforeEach(() => {
  fixture.input = Buffer.alloc(0);
  fixture.output = [];
  fixture.fifo = true;
  fixture.fragment = 7;
  fixture.reads = 0;
});
function supported(): boolean {
  if (process.platform === 'linux') return true;
  expect(() => openCleanupBrokerChannel()).toThrow('CLEANUP_BROKER_CHANNEL_INVALID');
  return false;
}
describe('fixed inherited broker channel', () => {
  it('accepts exact limits with one-byte fragments and preserves following control frames', () => {
    if (!supported()) return;
    fixture.fragment = 1;
    const payload = 'x'.repeat(256 * 1024 - 2);
    fixture.input = Buffer.from(`${JSON.stringify(payload)}\n{}\n`);
    const channel = openCleanupBrokerChannel();
    expect(channel.readBootstrap()).toBe(payload);
    expect(fixture.reads).toBe(256 * 1024 + 1);
    fixture.fragment = 4096;
    expect(channel.readControl()).toEqual({});
  });
  it('retains multiple controls already read with the bootstrap without extra reads', () => {
    if (!supported()) return;
    fixture.fragment = 4096;
    fixture.input = Buffer.from('{}\n{"a":1}\n{"b":2}\n');
    const channel = openCleanupBrokerChannel();
    expect(channel.readBootstrap()).toEqual({});
    expect(channel.readControl()).toEqual({ a: 1 });
    expect(channel.readControl()).toEqual({ b: 2 });
    expect(fixture.reads).toBe(1);
  });
  it('owns one buffered reader and handles fragmented private frames and writes', () => {
    if (!supported()) return;
    fixture.input = Buffer.from('{"bootstrap":true}\n{"admitted":true}\n');
    const channel = openCleanupBrokerChannel();
    expect(isCleanupBrokerChannel(channel)).toBe(true);
    expect(isCleanupBrokerChannel({ ...channel })).toBe(false);
    expect(channel.readBootstrap()).toEqual({ bootstrap: true });
    expect(channel.readControl()).toEqual({ admitted: true });
    channel.writeControl({ complete: true });
    expect(Buffer.concat(fixture.output).toString()).toBe('{"complete":true}\n');
    expect(() => channel.readBootstrap()).toThrow();
  });
  it('requires private pipe descriptors and bootstrap before controls', () => {
    if (!supported()) return;
    fixture.fifo = false;
    expect(() => openCleanupBrokerChannel()).toThrow();
    fixture.fifo = true;
    const channel = openCleanupBrokerChannel();
    expect(() => channel.readControl()).toThrow();
    expect(() => channel.writeControl({})).toThrow();
  });
  it.each([
    '{"x":1,"x":2}\n',
    '{"x":{"a":1,"a":2}}\n',
    '{"x":"\\ud800"}\n',
    '{"x":1}{}\n',
    '{"x":1',
    '\n',
    `${'['.repeat(66)}0${']'.repeat(66)}\n`,
    `${' '.repeat(256 * 1024 + 1)}\n`,
  ])('rejects malformed or unbounded bootstrap', (input) => {
    if (!supported()) return;
    fixture.input = Buffer.from(input);
    const channel = openCleanupBrokerChannel();
    expect(() => channel.readBootstrap()).toThrow();
    expect(() => channel.writeControl({})).toThrow();
  });
  it('rejects invalid UTF-8 and poisons further reads', () => {
    if (!supported()) return;
    fixture.input = Buffer.from([0x22, 0xff, 0x22, 0x0a]);
    const channel = openCleanupBrokerChannel();
    expect(() => channel.readBootstrap()).toThrow();
    fixture.input = Buffer.from('{}\n');
    expect(() => channel.readControl()).toThrow();
  });
  it('uses the smaller control limit after bootstrap', () => {
    if (!supported()) return;
    fixture.input = Buffer.from(`{}\n${' '.repeat(16 * 1024 + 1)}\n`);
    const channel = openCleanupBrokerChannel();
    channel.readBootstrap();
    expect(() => channel.readControl()).toThrow();
  });
});
