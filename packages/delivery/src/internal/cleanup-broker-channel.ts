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

// Reject duplicate keys before JSON.parse can apply last-key-wins semantics.
// This parser checks structure; JSON.parse still validates complete JSON syntax.
function decode(bytes: Buffer): unknown {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return invalid();
  }
  let offset = 0;
  const space = () => {
    while (/\s/.test(text[offset] ?? '') && offset < text.length) offset++;
  };
  const string = (): string => {
    if (text[offset] !== '"') invalid();
    const start = offset++;
    while (offset < text.length) {
      const c = text[offset++];
      if (c === '\\') {
        offset++;
        continue;
      }
      if (c === '"') {
        const value: unknown = JSON.parse(text.slice(start, offset));
        if (typeof value !== 'string' || Buffer.from(value).toString('utf8') !== value) invalid();
        return value;
      }
    }
    return invalid();
  };
  const value = (depth: number): void => {
    if (depth > 64) invalid();
    space();
    const c = text[offset];
    if (c === '"') {
      string();
      return;
    }
    if (c === '{') {
      offset++;
      space();
      const keys = new Set<string>();
      if (text[offset] === '}') {
        offset++;
        return;
      }
      while (offset < text.length) {
        space();
        const key = string();
        if (keys.has(key)) invalid();
        keys.add(key);
        space();
        if (text[offset++] !== ':') invalid();
        value(depth + 1);
        space();
        const delimiter = text[offset++];
        if (delimiter === '}') return;
        if (delimiter !== ',') invalid();
      }
      invalid();
    }
    if (c === '[') {
      offset++;
      space();
      if (text[offset] === ']') {
        offset++;
        return;
      }
      while (offset < text.length) {
        value(depth + 1);
        space();
        const delimiter = text[offset++];
        if (delimiter === ']') return;
        if (delimiter !== ',') invalid();
      }
      invalid();
    }
    const start = offset;
    while (offset < text.length && !/[\s,}\]]/.test(text[offset]!)) offset++;
    if (offset === start) invalid();
  };
  try {
    value(0);
    space();
    if (offset !== text.length) invalid();
    return JSON.parse(text);
  } catch {
    return invalid();
  }
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
          const value = decode(buffered.subarray(0, newline));
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
        decode(frame.subarray(0, -1));
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
