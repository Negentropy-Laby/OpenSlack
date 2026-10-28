/** Bounded, provider-neutral Bridge transport. This leaf is also bundled into the external plugin. */
import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
/** Shared frozen governed cleanup durations, not clock readings. */
export const HARNESS_CLEANUP_BUDGET = Object.freeze({
  ownedMs: 24_000, graceMs: 25_000, forceMs: 5_000, totalMs: 30_000,
} as const);

export const BRIDGE_WIRE_VERSION = '2025-06-03';
export const BRIDGE_FRAME_MAX_BYTES = 1024 * 1024;
export const BRIDGE_MESSAGE_MAX_BYTES = 16 * 1024 * 1024;
export const BRIDGE_CHUNK_BYTES = 256 * 1024;
export const BRIDGE_QUEUE_MAX_BYTES = 32 * 1024 * 1024;
export const BRIDGE_CHUNK_EXTENSION = 'chunked-json.v1';

/** One source for native-MCP, normalized Bridge and local SDK callback names. */
export const HARNESS_CALLBACK_TOOLS = Object.freeze({
  query: Object.freeze({ bare: 'openslack_get_activity', bridge: 'mcp.openslack.openslack_get_activity', sdk: 'mcp__openslack__openslack_get_activity' }),
  preview: Object.freeze({ bare: 'openslack_preview_workflow', bridge: 'mcp.openslack.openslack_preview_workflow', sdk: 'mcp__openslack__openslack_preview_workflow' }),
  confirm: Object.freeze({ bare: 'openslack_confirm_plan', bridge: 'mcp.openslack.openslack_confirm_plan', sdk: 'mcp__openslack__openslack_confirm_plan' }),
  cancel: Object.freeze({ bare: 'openslack_cancel_plan', bridge: 'mcp.openslack.openslack_cancel_plan', sdk: 'mcp__openslack__openslack_cancel_plan' }),
});

export interface BridgeWireIdentity { sessionId: string; correlationId: string }
export interface BridgeWireEnvelope extends BridgeWireIdentity {
  protocolVersion: string;
  timestamp: string;
  kind: string;
  payload: Record<string, unknown>;
}

/** Safe protocol diagnostics contain no input, tool body or upstream exception. */
export class BridgeWireError extends Error {
  readonly code = 'BRIDGE_WIRE_INVALID';
  constructor(message: string) { super(message); this.name = 'BridgeWireError'; }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
const kinds = new Set(['handshake_request', 'handshake_response', 'run_request', 'run_started', 'assistant_text',
  'approval_required', 'tool_request', 'tool_response', 'progress', 'error', 'heartbeat', 'complete']);
const failures = new Set(['handshake_failed', 'session_unavailable', 'timeout', 'envelope_malformed', 'permission_denied',
  'worktree_boundary_violation', 'protocol_version_mismatch', 'process_crash', 'unknown']);

/** Reject JSON aliases, unsupported objects and unbounded nesting before serialization or delivery. */
function finiteJson(value: unknown, depth = 0, ancestors = new Set<object>()): void {
  if (depth > 64) throw new BridgeWireError('Bridge JSON nesting exceeds the supported bound');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || !value || ancestors.has(value)) throw new BridgeWireError('Bridge requires finite lossless JSON values');
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new BridgeWireError('Bridge requires plain JSON objects');
  }
  ancestors.add(value);
  if (Array.isArray(value)) for (const member of value) finiteJson(member, depth + 1, ancestors);
  else for (const member of Object.values(value)) if (member !== undefined) finiteJson(member, depth + 1, ancestors);
  ancestors.delete(value);
}

function header(value: unknown): asserts value is BridgeWireEnvelope {
  if (!object(value)) throw new BridgeWireError('Envelope must be an object');
  if (typeof value.protocolVersion !== 'string' || !value.protocolVersion) throw new BridgeWireError('Missing or invalid protocolVersion');
  if (value.protocolVersion !== BRIDGE_WIRE_VERSION) throw new BridgeWireError('Protocol version mismatch');
  for (const key of ['sessionId', 'correlationId'] as const) {
    if (typeof value[key] !== 'string' || !value[key] || value[key].length > 512) throw new BridgeWireError(`Missing or invalid ${key}`);
  }
  if (typeof value.timestamp !== 'string' || !Number.isFinite(Date.parse(value.timestamp))) throw new BridgeWireError('Missing or invalid timestamp');
  if (typeof value.kind !== 'string' || !value.kind) throw new BridgeWireError('Missing or invalid kind');
  if (!object(value.payload)) throw new BridgeWireError('Missing or invalid payload');
  if (Object.keys(value).sort().join(',') !== 'correlationId,kind,payload,protocolVersion,sessionId,timestamp') throw new BridgeWireError('Unknown Bridge envelope field');
}

/** Validate ordinary and reassembled envelopes identically; exit policy never weakens this check. */
export function validateBridgeWireEnvelope(value: unknown, identity?: BridgeWireIdentity): BridgeWireEnvelope {
  header(value);
  if (identity && (value.sessionId !== identity.sessionId || value.correlationId !== identity.correlationId)) {
    throw new BridgeWireError('Bridge frame belongs to another run');
  }
  if (!kinds.has(value.kind)) throw new BridgeWireError('Unknown envelope kind');
  finiteJson(value);
  const payload = value.payload;
  if (value.kind === 'complete' && (!Object.hasOwn(payload, 'data') || payload.data === undefined ||
    (payload.tokenUsage !== undefined && (!Number.isSafeInteger(payload.tokenUsage) || (payload.tokenUsage as number) < 0)) ||
    (payload.events !== undefined && !Array.isArray(payload.events)))) {
    throw new BridgeWireError('Bridge complete requires data and valid observed usage');
  }
  if (value.kind === 'handshake_request' && payload.protocolVersion !== BRIDGE_WIRE_VERSION) throw new BridgeWireError('Unsupported Bridge handshake version');
  if (value.kind === 'handshake_response' && (typeof payload.accepted !== 'boolean' ||
    (payload.protocolVersion !== undefined && payload.protocolVersion !== BRIDGE_WIRE_VERSION))) throw new BridgeWireError('Invalid Bridge handshake response');
  if (value.kind === 'error' && (typeof payload.kind !== 'string' || !failures.has(payload.kind) || typeof payload.message !== 'string')) {
    throw new BridgeWireError('Invalid Bridge error payload');
  }
  if ((value.kind === 'tool_request' || value.kind === 'tool_response') &&
    payload.phase !== 'authorize-response' && typeof payload.authorizationRequestId !== 'string' &&
    (typeof payload.toolName !== 'string' || !payload.toolName)) throw new BridgeWireError('Bridge tool frame requires a tool identity');
  return value;
}

function extensions(values: readonly string[]): boolean {
  if (!Array.isArray(values) || values.length > 1 || values.some(value => value !== BRIDGE_CHUNK_EXTENSION)) {
    throw new BridgeWireError('Unsupported Bridge extension advertisement');
  }
  return values.includes(BRIDGE_CHUNK_EXTENSION);
}

/** One encoder owns the monotonic chunk IDs for one connection direction. */
export class BridgeWireEncoder {
  private chunking = false;
  private nextMessage = 0;
  setExtensions(values: readonly string[]): void { this.chunking = extensions(values); }

  /** Serialize each logical envelope once; callers serialize complete returned message arrays. */
  encode(envelope: BridgeWireEnvelope): string[] {
    if (envelope.kind === 'chunk') throw new BridgeWireError('Nested Bridge chunks are forbidden');
    validateBridgeWireEnvelope(envelope);
    const bytes = Buffer.from(JSON.stringify(envelope), 'utf8');
    if (bytes.length <= BRIDGE_FRAME_MAX_BYTES) return [bytes.toString('utf8')];
    if (bytes.length > BRIDGE_MESSAGE_MAX_BYTES) throw new BridgeWireError('Bridge logical message exceeds 16 MiB');
    if (!this.chunking) throw new BridgeWireError('Large Bridge messages require negotiated chunked-json.v1');
    if (envelope.kind.startsWith('handshake_')) throw new BridgeWireError('Bridge handshakes cannot be chunked');
    if (!Number.isSafeInteger(++this.nextMessage)) throw new BridgeWireError('Bridge message identity exhausted');
    const messageId = String(this.nextMessage);
    const count = Math.ceil(bytes.length / BRIDGE_CHUNK_BYTES);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const output: string[] = [];
    for (let index = 0; index < count; index++) {
      output.push(JSON.stringify({ ...envelope, kind: 'chunk', payload: {
        extension: BRIDGE_CHUNK_EXTENSION, messageId, index, count, totalBytes: bytes.length, sha256,
        data: bytes.subarray(index * BRIDGE_CHUNK_BYTES, (index + 1) * BRIDGE_CHUNK_BYTES).toString('base64'),
      } }));
    }
    return output;
  }
}

interface Assembly { messageId: string; count: number; totalBytes: number; sha256: string; next: number; bytes: number; chunks: Buffer[] }

/** Bounded connection-local reassembly. No chunk authorizes or publishes a business action. */
export class BridgeWireDecoder {
  private identity: BridgeWireIdentity | undefined;
  private chunking = false;
  private assembly: Assembly | undefined;
  private lastMessage = 0;
  constructor(identity?: BridgeWireIdentity) { if (identity) this.bind(identity); }
  bind(identity: BridgeWireIdentity): void {
    if (this.identity && (this.identity.sessionId !== identity.sessionId || this.identity.correlationId !== identity.correlationId)) {
      throw new BridgeWireError('Bridge connection identity changed');
    }
    this.identity = { ...identity };
  }
  setExtensions(values: readonly string[]): void {
    if (this.assembly) throw new BridgeWireError('Bridge extensions changed during reassembly');
    this.chunking = extensions(values);
  }

  /** Return only a fully validated ordinary or reconstructed inner envelope. */
  receive(line: string): BridgeWireEnvelope | undefined {
    if (Buffer.byteLength(line) > BRIDGE_FRAME_MAX_BYTES) throw new BridgeWireError('Bridge frame exceeds 1 MiB');
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new BridgeWireError('Invalid JSON in Bridge output'); }
    header(value);
    if (this.identity && (value.sessionId !== this.identity.sessionId || value.correlationId !== this.identity.correlationId)) {
      throw new BridgeWireError('Bridge frame belongs to another run');
    }
    if (value.kind !== 'chunk') {
      if (this.assembly) throw new BridgeWireError('Interleaved Bridge message during chunk reassembly');
      return validateBridgeWireEnvelope(value, this.identity);
    }
    if (!this.chunking || !this.identity) throw new BridgeWireError('Bridge chunks were not negotiated for this connection');
    const p = value.payload;
    if (Object.keys(p).sort().join(',') !== 'count,data,extension,index,messageId,sha256,totalBytes' || p.extension !== BRIDGE_CHUNK_EXTENSION ||
      typeof p.messageId !== 'string' || !/^[1-9][0-9]{0,15}$/.test(p.messageId) || !Number.isSafeInteger(Number(p.messageId)) ||
      !Number.isSafeInteger(p.index) || !Number.isSafeInteger(p.count) || !Number.isSafeInteger(p.totalBytes) ||
      (p.totalBytes as number) <= BRIDGE_FRAME_MAX_BYTES || (p.totalBytes as number) > BRIDGE_MESSAGE_MAX_BYTES ||
      (p.count as number) !== Math.ceil((p.totalBytes as number) / BRIDGE_CHUNK_BYTES) ||
      (p.index as number) < 0 || (p.index as number) >= (p.count as number) ||
      typeof p.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(p.sha256) || typeof p.data !== 'string' ||
      p.data.length > Math.ceil(BRIDGE_CHUNK_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(p.data)) {
      throw new BridgeWireError('Invalid Bridge chunk bounds or metadata');
    }
    if (!this.assembly) {
      if (Number(p.messageId) !== this.lastMessage + 1) throw new BridgeWireError('Replayed or skipped Bridge message identity');
      if (p.index !== 0) throw new BridgeWireError('Invalid Bridge chunk order');
      this.assembly = { messageId: p.messageId, count: p.count as number, totalBytes: p.totalBytes as number,
        sha256: p.sha256, next: 0, bytes: 0, chunks: [] };
    }
    const a = this.assembly;
    if (p.messageId !== a.messageId || p.count !== a.count || p.totalBytes !== a.totalBytes || p.sha256 !== a.sha256 || p.index !== a.next) {
      throw new BridgeWireError('Invalid Bridge chunk order or changing metadata');
    }
    const bytes = Buffer.from(p.data, 'base64');
    const expected = a.next === a.count - 1 ? a.totalBytes - a.next * BRIDGE_CHUNK_BYTES : BRIDGE_CHUNK_BYTES;
    if (bytes.length !== expected || bytes.toString('base64') !== p.data) throw new BridgeWireError('Invalid Bridge chunk length or Base64');
    a.chunks.push(bytes); a.bytes += bytes.length; a.next++;
    if (a.next !== a.count) return undefined;
    const complete = Buffer.concat(a.chunks, a.totalBytes);
    this.assembly = undefined;
    if (a.bytes !== a.totalBytes || createHash('sha256').update(complete).digest('hex') !== a.sha256) throw new BridgeWireError('Bridge chunk digest mismatch');
    let inner: unknown;
    try { inner = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(complete)); }
    catch { throw new BridgeWireError('Invalid JSON or UTF-8 in reconstructed Bridge message'); }
    const envelope = validateBridgeWireEnvelope(inner, this.identity);
    if (envelope.kind.startsWith('handshake_')) throw new BridgeWireError('Bridge handshakes cannot be chunked');
    this.lastMessage = Number(a.messageId);
    return envelope;
  }
  /** EOF never silently discards a partial logical message. */
  finish(): void { if (this.assembly) throw new BridgeWireError('Truncated Bridge chunk stream'); }
}
