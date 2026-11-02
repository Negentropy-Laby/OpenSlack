import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  BRIDGE_CHUNK_EXTENSION, BRIDGE_CHUNK_BYTES, BRIDGE_MESSAGE_MAX_BYTES, BRIDGE_FRAME_MAX_BYTES,
  BridgeWireDecoder, BridgeWireEncoder,
} from '../bridge-wire.js';

const envelope = (kind = 'complete', payload: Record<string, unknown> = { data: '双向闭环' }) => ({
  protocolVersion: '2025-06-03', sessionId: 'bridge-RUN-WIRE', correlationId: 'RUN-WIRE',
  timestamp: '2026-10-27T00:00:00.000Z', kind, payload,
});
const binding = { sessionId: 'bridge-RUN-WIRE', correlationId: 'RUN-WIRE' };
function pair() {
  const encoder = new BridgeWireEncoder();
  const decoder = new BridgeWireDecoder(binding);
  encoder.setExtensions([BRIDGE_CHUNK_EXTENSION]);
  decoder.setExtensions([BRIDGE_CHUNK_EXTENSION]);
  return { encoder, decoder };
}
function rawChunks(bytes: Buffer): string[] {
  const count = Math.ceil(bytes.length / BRIDGE_CHUNK_BYTES);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return Array.from({ length: count }, (_, index) => JSON.stringify(envelope('chunk', {
    extension: BRIDGE_CHUNK_EXTENSION, messageId: '1', count, index, totalBytes: bytes.length, sha256,
    data: bytes.subarray(index * BRIDGE_CHUNK_BYTES, (index + 1) * BRIDGE_CHUNK_BYTES).toString('base64'),
  })));
}

describe('bounded full Bridge wire', () => {
  it('keeps ordinary frames unchanged and preserves complete null data', () => {
    const { encoder, decoder } = pair();
    const source = envelope('complete', { data: null, tokenUsage: 0 });
    const lines = encoder.encode(source);
    expect(lines).toEqual([JSON.stringify(source)]);
    expect(decoder.receive(lines[0]!)).toEqual(source);
  });

  it('preserves the complete large escaped input and metadata without partial delivery', () => {
    const { encoder, decoder } = pair();
    const source = envelope('tool_request', { phase: 'observed', callId: 'call-1', toolName: 'Edit',
      input: { file_path: 'fixture.txt', old_string: '\u0001'.repeat(200_000), new_string: '双'.repeat(300_000) },
      metadata: { keep: true } });
    const lines = encoder.encode(source);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines.slice(0, -1)) expect(decoder.receive(line)).toBeUndefined();
    expect(decoder.receive(lines.at(-1)!)).toEqual(source);
    expect(lines.every(line => Buffer.byteLength(line) <= 1024 * 1024)).toBe(true);
  });

  it('splits UTF-8 only as bytes and decodes it after verified reassembly', () => {
    const { encoder, decoder } = pair();
    const source = envelope('complete', { data: '双'.repeat(BRIDGE_CHUNK_BYTES * 2) });
    // Include the JSON header in the size: this intentionally cuts a multibyte sequence.
    const lines = encoder.encode(source);
    let decoded;
    for (const line of lines) decoded = decoder.receive(line) ?? decoded;
    expect(decoded).toEqual(source);
  });

  it.each(['digest', 'order', 'count', 'length', 'identity', 'base64'])(
    'rejects a corrupt %s chunk before delivering any inner effect', problem => {
      const { encoder, decoder } = pair();
      const lines = encoder.encode(envelope('tool_request', { toolName: 'Write', input: { content: 'x'.repeat(1_100_000) } }));
      const first = JSON.parse(lines[0]!);
      if (problem === 'digest') first.payload.sha256 = '0'.repeat(64);
      if (problem === 'order') first.payload.index = 1;
      if (problem === 'count') first.payload.count++;
      if (problem === 'length') first.payload.totalBytes++;
      if (problem === 'identity') first.correlationId = 'RUN-OTHER';
      if (problem === 'base64') first.payload.data += '!';
      expect(() => {
        decoder.receive(JSON.stringify(first));
        for (const line of lines.slice(1)) {
          const next = JSON.parse(line);
          if (problem === 'digest') next.payload.sha256 = '0'.repeat(64);
          decoder.receive(JSON.stringify(next));
        }
      }).toThrow(problem === 'digest' ? /digest mismatch/ : undefined);
    },
  );

  it('rejects unnegotiated chunks, incomplete streams, duplicate chunks and replayed message IDs', () => {
    const source = envelope('complete', { data: 'x'.repeat(1_100_000) });
    const { encoder, decoder } = pair();
    const lines = encoder.encode(source);
    expect(() => new BridgeWireDecoder(binding).receive(lines[0]!)).toThrow(/negotiated/);
    decoder.receive(lines[0]!);
    expect(() => decoder.finish()).toThrow(/Truncated/);
    const duplicate = pair().decoder;
    duplicate.receive(lines[0]!);
    expect(() => duplicate.receive(lines[0]!)).toThrow(/order/);
    const replay = pair().decoder;
    for (const line of lines) replay.receive(line);
    expect(() => replay.receive(lines[0]!)).toThrow(/replay/i);
  });

  it('does not invent chunk support, permit nested chunks or exceed the logical byte cap', () => {
    expect(() => new BridgeWireEncoder().encode(envelope('complete', { data: 'x'.repeat(1_100_000) }))).toThrow(/negotiated/);
    const { encoder } = pair();
    expect(() => encoder.encode(envelope('chunk', {}))).toThrow(/Nested/);
    expect(() => encoder.encode(envelope('complete', { data: 'x'.repeat(BRIDGE_MESSAGE_MAX_BYTES) }))).toThrow(/16 MiB/);
  });

  it.each([
    envelope('complete', { result: 'not-data' }), envelope('complete', { data: {}, tokenUsage: -1 }),
    { ...envelope(), payload: [] }, { ...envelope(), timestamp: 'not-time' },
    { ...envelope(), kind: 'unreviewed-action' }, { ...envelope(), correlationId: 'RUN-OTHER' },
  ])('validates ordinary and reconstructed envelopes with the same strict rules %#', source => {
    expect(() => new BridgeWireDecoder(binding).receive(JSON.stringify(source))).toThrow();
  });

  it('rejects non-finite values and unsupported extension advertisements', () => {
    const { encoder, decoder } = pair();
    expect(() => encoder.encode(envelope('progress', { numeric: Number.NaN }))).toThrow();
    expect(() => decoder.setExtensions(['unknown.v1'])).toThrow();
  });

  it('handles the exact ordinary 1 MiB boundary and the exact 16 MiB/64-chunk boundary', () => {
    const overhead = Buffer.byteLength(JSON.stringify(envelope('complete', { data: '' })));
    const first = pair();
    const exactFrame = envelope('complete', { data: 'x'.repeat(BRIDGE_FRAME_MAX_BYTES - overhead) });
    const ordinary = first.encoder.encode(exactFrame);
    expect(ordinary).toHaveLength(1);
    expect(Buffer.byteLength(ordinary[0]!)).toBe(BRIDGE_FRAME_MAX_BYTES);
    expect(first.decoder.receive(ordinary[0]!)).toEqual(exactFrame);
    const second = pair();
    const exactMessage = envelope('complete', { data: 'x'.repeat(BRIDGE_MESSAGE_MAX_BYTES - overhead) });
    const chunks = second.encoder.encode(exactMessage);
    expect(chunks).toHaveLength(64);
    expect(JSON.parse(chunks.at(-1)!).payload.totalBytes).toBe(BRIDGE_MESSAGE_MAX_BYTES);
    let actual;
    for (const chunk of chunks) actual = second.decoder.receive(chunk) ?? actual;
    expect(actual).toEqual(exactMessage);
  });

  it.each(['pad-bits', 'extra-padding', 'missing-padding'])('rejects decodable but noncanonical Base64: %s', corruption => {
    const { encoder, decoder } = pair();
    const overhead = Buffer.byteLength(JSON.stringify(envelope('complete', { data: '' })));
    const lines = encoder.encode(envelope('complete', { data: 'x'.repeat(BRIDGE_CHUNK_BYTES * 4 + 100 - overhead) }));
    const last = JSON.parse(lines.at(-1)!);
    const original = last.payload.data as string;
    expect(original.endsWith('==')).toBe(true);
    if (corruption === 'pad-bits') {
      const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
      const index = original.length - 3;
      last.payload.data = original.slice(0, index) + alphabet[alphabet.indexOf(original[index]!) ^ 1] + original.slice(index + 1);
      expect(Buffer.from(last.payload.data, 'base64')).toEqual(Buffer.from(original, 'base64'));
    } else if (corruption === 'extra-padding') last.payload.data += '=';
    else last.payload.data = original.replace(/=+$/, '');
    for (const line of lines.slice(0, -1)) expect(decoder.receive(line)).toBeUndefined();
    expect(() => decoder.receive(JSON.stringify(last))).toThrow(/Base64|bounds/);
  });

  it('checks the final UTF-8 decoder after a matching digest and refuses incomplete ordinary interleaving', () => {
    const source = Buffer.from(JSON.stringify(envelope('complete', { data: 'x'.repeat(1_100_000) })));
    const start = source.indexOf(Buffer.from('"data":"')) + 8;
    source[start] = 0xc3; source[start + 1] = 0x28;
    const { decoder } = pair();
    const chunks = rawChunks(source);
    for (const chunk of chunks.slice(0, -1)) expect(decoder.receive(chunk)).toBeUndefined();
    expect(() => decoder.receive(chunks.at(-1)!)).toThrow(/UTF-8/);
    const interleaved = pair();
    const good = interleaved.encoder.encode(envelope('complete', { data: 'x'.repeat(1_100_000) }));
    interleaved.decoder.receive(good[0]!);
    expect(() => interleaved.decoder.receive(JSON.stringify(envelope('progress', { step: 'interleaved' })))).toThrow(/Interleaved/);
  });

  it.each(['chunk', 'handshake_request'])('rejects a reconstructed inner %s even with correct chunks and digest', kind => {
    const bytes = Buffer.from(JSON.stringify(envelope(kind, { protocolVersion: '2025-06-03', filler: 'x'.repeat(1_100_000) })));
    const { decoder } = pair();
    const chunks = rawChunks(bytes);
    for (const chunk of chunks.slice(0, -1)) expect(decoder.receive(chunk)).toBeUndefined();
    expect(() => decoder.receive(chunks.at(-1)!)).toThrow(/Unknown envelope kind|handshakes/);
  });
});
