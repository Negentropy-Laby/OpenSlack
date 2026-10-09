import { decodeStrictJSON } from '@openslack/core';
import { fstatSync, readSync, writeSync } from 'node:fs';

const INPUT_FD = 3;
const OUTPUT_FD = 4;
const MAX_BOOTSTRAP = 256 * 1024;
const MAX_CONTROL = 16 * 1024;
const owned = new WeakSet<object>();

export class CleanupBrokerChannelError extends Error {
  constructor() {
    super('CLEANUP_BROKER_CHANNEL_INVALID');
    this.name = 'CleanupBrokerChannelError';
  }
}

function invalid(): never {
  throw new CleanupBrokerChannelError();
}

/** One private inherited-pipe conversation, never configurable by request/env. */
export interface CleanupBrokerChannel {
  readBootstrap(): unknown;
  readControl(): unknown;
  writeControl(value: unknown): void;
}

export function openCleanupBrokerChannel(): CleanupBrokerChannel {
  if (process.platform !== 'linux') invalid();
  for (const fd of [INPUT_FD, OUTPUT_FD]) if (!fstatSync(fd).isFIFO()) invalid();
  // One bounded allocation. Repeated tiny pipe reads must not recopy or rescan
  // the complete frame: a 256 KiB bootstrap may arrive one byte at a time.
  const buffered = Buffer.alloc(MAX_BOOTSTRAP + 1);
  let used = 0;
  let scanned = 0;
  let bootstrapRead = false;
  let poisoned = false;
  const read = (limit: number): unknown => {
    if (poisoned) invalid();
    try {
      for (;;) {
        const newline = buffered.subarray(0, used).indexOf(10, scanned);
        if (newline >= 0) {
          if (newline > limit) invalid();
          const value = decodeStrictJSON(buffered.subarray(0, newline), limit);
          buffered.copyWithin(0, newline + 1, used);
          used -= newline + 1;
          scanned = 0;
          return value;
        }
        scanned = used;
        if (used > limit) invalid();
        const available = Math.min(4096, limit + 1 - used);
        const count = readSync(INPUT_FD, buffered, used, available, null);
        if (count <= 0 || count > available) invalid();
        used += count;
      }
    } catch {
      poisoned = true;
      return invalid();
    }
  };
  const channel = Object.freeze({
    readBootstrap(): unknown {
      if (bootstrapRead || poisoned) invalid();
      bootstrapRead = true;
      return read(MAX_BOOTSTRAP);
    },
    readControl(): unknown {
      if (!bootstrapRead) invalid();
      return read(MAX_CONTROL);
    },
    writeControl(value: unknown): void {
      if (!bootstrapRead || poisoned) invalid();
      try {
        const frame = Buffer.from(`${JSON.stringify(value)}\n`);
        if (frame.length - 1 > MAX_CONTROL) invalid();
        decodeStrictJSON(frame.subarray(0, -1), MAX_CONTROL);
        let offset = 0;
        while (offset < frame.length) {
          const n = writeSync(OUTPUT_FD, frame, offset, frame.length - offset);
          if (n <= 0) invalid();
          offset += n;
        }
      } catch {
        poisoned = true;
        invalid();
      }
    },
  });
  owned.add(channel);
  return channel;
}

export function isCleanupBrokerChannel(value: object): value is CleanupBrokerChannel {
  return owned.has(value);
}
