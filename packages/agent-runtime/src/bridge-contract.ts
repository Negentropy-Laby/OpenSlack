/**
 * Bridge Contract — formal interface between OpenSlack agent-runtime and
 * external agent runtimes. Runtime-agnostic: no Aby-specific types.
 *
 * AR-2.5A: Bridge Contract
 */

import type { PermissionMode } from '@openslack/kernel';

/**
 * Protocol version for bridge envelope compatibility.
 * Date reflects the original protocol design date, not the current year.
 */
export const BRIDGE_PROTOCOL_VERSION = '2025-06-03';

/**
 * Bridge session state machine states.
 */
export type BridgeSessionState = 'idle' | 'initializing' | 'ready' | 'busy' | 'shutdown';

/**
 * Bridge error taxonomy for structured failure reporting.
 */
export type BridgeErrorKind =
  | 'handshake_failed'
  | 'session_unavailable'
  | 'timeout'
  | 'envelope_malformed'
  | 'permission_denied'
  | 'worktree_boundary_violation'
  | 'protocol_version_mismatch'
  | 'process_crash'
  | 'unknown';

/**
 * Describes a capability offered by a bridge runtime.
 */
export interface BridgeCapabilityDescriptor {
  name: string;
  version?: string;
  supportedTools?: string[];
  supportedMcpServers?: string[];
}

/**
 * Generic bridge envelope carrying typed payload.
 */
export interface BridgeEnvelope<T = unknown> {
  /** Protocol version for compatibility checking. */
  protocolVersion: string;
  /** Unique session identifier. */
  sessionId: string;
  /** Client correlation ID — maps to OpenSlack runId. */
  correlationId: string;
  /** ISO-8601 timestamp. */
  timestamp: string;
  /** Envelope kind for routing. */
  kind: BridgeEnvelopeKind;
  /** Typed payload. */
  payload: T;
}

export type BridgeEnvelopeKind =
  | 'handshake_request'
  | 'handshake_response'
  | 'run_request'
  | 'run_started'
  | 'assistant_text'
  | 'approval_required'
  | 'tool_request'
  | 'tool_response'
  | 'progress'
  | 'error'
  | 'heartbeat'
  | 'complete';

/**
 * Bridge error payload.
 */
export interface BridgeErrorPayload {
  kind: BridgeErrorKind;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * Generic L3 Agent Run Bridge request sent to external runtimes.
 * OpenSlack-specific governance fields stay outside this wire payload and
 * are enforced locally by BridgePermissionGuard and ToolGuard.
 */
export interface AgentRunBridgeRequestPayload {
  runId: string;
  agentId: string;
  sessionId?: string;
  input: Array<{ role: 'user' | 'system' | 'tool'; content: unknown }>;
  worktreePath?: string;
  allowedTools: string[];
  deniedTools: string[];
  permissionMode: PermissionMode;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | number;
  maxTurns?: number;
  mcp?: {
    required: string[];
    available: string[];
  };
  metadata?: Record<string, unknown>;
}

/**
 * MCP server descriptor for bridge capability negotiation.
 */
export interface BridgeMcpServerDescriptor {
  name: string;
  version?: string;
  required?: boolean;
  tools?: string[];
}

/**
 * Bridge contract — implemented by both OpenSlack launcher and external runtime.
 *
 * The contract is symmetric: OpenSlack calls negotiateCapabilities and openSession,
 * then sends envelopes via sendEnvelope. The external runtime sends envelopes back
 * over the same channel (stdout, event pipe, or callback).
 */
export interface BridgeContract {
  /** Unique identifier for this bridge contract instance. */
  readonly bridgeId: string;

  /**
   * Negotiate capabilities before opening a session.
   * Returns the intersection of requested and available capabilities.
   */
  negotiateCapabilities(
    requested: BridgeCapabilityDescriptor[],
  ): Promise<BridgeCapabilityDescriptor[]>;

  /**
   * Open a new bridge session.
   * Transitions state: idle → initializing → ready.
   */
  openSession(config: BridgeSessionConfig): Promise<BridgeSessionState>;

  /**
   * Close an active bridge session.
   * Transitions state: ready|busy → shutdown.
   */
  closeSession(sessionId: string): Promise<BridgeSessionState>;

  /**
   * Send an envelope to the bridge.
   * Valid only when state is 'ready' or 'busy'.
   */
  sendEnvelope<T>(sessionId: string, envelope: BridgeEnvelope<T>): Promise<void>;

  /**
   * Health check for the bridge runtime.
   */
  healthCheck(): Promise<{ healthy: boolean; details?: Record<string, unknown> }>;
}

/**
 * Configuration for opening a bridge session.
 */
export interface BridgeSessionConfig {
  runId: string;
  agentId: string;
  prompt: string;
  permissionProfile: {
    allowedTools: string[];
    deniedTools: string[];
    permissionMode: PermissionMode;
  };
  worktreePath?: string;
  timeout?: number;
  metadata?: {
    model?: string;
    correlationId?: string;
    threadId?: string;
    budget?: { tokens: number; costUsd: number };
    resolvedConfig?: Record<string, unknown>;
    worktree?: BridgeWorktreeConfig | null;
  };
}

/**
 * Worktree configuration passed to the bridge session.
 */
export interface BridgeWorktreeConfig {
  /** Filesystem path to the worktree. */
  worktreePath: string;
  /** Git branch name of the worktree. */
  branchName: string;
  /** Root directory that the bridge runtime must not escape. */
  allowedRoot: string;
  /** Whether worktree isolation is active. */
  isolationActive: boolean;
}

/**
 * Bridge session state machine.
 *
 * Enforces valid transitions:
 *   idle → initializing → ready → busy → ready → shutdown
 *   Any state → shutdown (forced close)
 */
export class BridgeSessionStateMachine {
  private state: BridgeSessionState = 'idle';
  private readonly sessionId: string;
  private readonly onTransition?: (from: BridgeSessionState, to: BridgeSessionState) => void;

  constructor(
    sessionId: string,
    onTransition?: (from: BridgeSessionState, to: BridgeSessionState) => void,
  ) {
    this.sessionId = sessionId;
    this.onTransition = onTransition;
  }

  get currentState(): BridgeSessionState {
    return this.state;
  }

  get id(): string {
    return this.sessionId;
  }

  /**
   * Attempt to transition to a new state.
   * Returns the new state on success, throws on invalid transition.
   */
  transition(to: BridgeSessionState): BridgeSessionState {
    const from = this.state;

    if (from === to) return this.state;

    const valid = isValidTransition(from, to);
    if (!valid) {
      throw new BridgeStateError(
        `Invalid bridge session transition: ${from} → ${to} (session=${this.sessionId})`,
        from,
        to,
      );
    }

    this.state = to;
    this.onTransition?.(from, to);
    return this.state;
  }

  /**
   * Force shutdown from any state. No-op if already in shutdown state,
   * matching the same-state behavior of transition().
   */
  forceShutdown(): BridgeSessionState {
    const from = this.state;
    if (from === 'shutdown') return this.state;
    this.state = 'shutdown';
    this.onTransition?.(from, 'shutdown');
    return this.state;
  }
}

function isValidTransition(from: BridgeSessionState, to: BridgeSessionState): boolean {
  const transitions: Record<BridgeSessionState, BridgeSessionState[]> = {
    idle: ['initializing', 'shutdown'],
    initializing: ['ready', 'shutdown'],
    ready: ['busy', 'shutdown'],
    busy: ['ready', 'shutdown'],
    shutdown: [],
  };
  return transitions[from]?.includes(to) ?? false;
}

/**
 * Error thrown for invalid bridge session state transitions.
 */
export class BridgeStateError extends Error {
  readonly from: BridgeSessionState;
  readonly to: BridgeSessionState;

  constructor(message: string, from: BridgeSessionState, to: BridgeSessionState) {
    super(message);
    this.name = 'BridgeStateError';
    this.from = from;
    this.to = to;
  }
}

/**
 * Build a standard bridge envelope with current timestamp and protocol version.
 */
export function buildBridgeEnvelope<T>(
  sessionId: string,
  correlationId: string,
  kind: BridgeEnvelopeKind,
  payload: T,
): BridgeEnvelope<T> {
  return {
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    sessionId,
    correlationId,
    timestamp: new Date().toISOString(),
    kind,
    payload,
  };
}

/**
 * Validate a received bridge envelope for structural correctness.
 * Returns validation result; does not throw.
 */
export function validateBridgeEnvelope(envelope: unknown): { valid: boolean; error?: string } {
  if (!envelope || typeof envelope !== 'object') {
    return { valid: false, error: 'Envelope must be an object' };
  }

  const e = envelope as Record<string, unknown>;

  if (typeof e.protocolVersion !== 'string' || e.protocolVersion.length === 0) {
    return { valid: false, error: 'Missing or invalid protocolVersion' };
  }

  if (typeof e.sessionId !== 'string' || e.sessionId.length === 0) {
    return { valid: false, error: 'Missing or invalid sessionId' };
  }

  if (typeof e.correlationId !== 'string' || e.correlationId.length === 0) {
    return { valid: false, error: 'Missing or invalid correlationId' };
  }

  if (typeof e.timestamp !== 'string' || e.timestamp.length === 0) {
    return { valid: false, error: 'Missing or invalid timestamp' };
  }

  if (typeof e.kind !== 'string' || e.kind.length === 0) {
    return { valid: false, error: 'Missing or invalid kind' };
  }

  if (!e.payload || typeof e.payload !== 'object') {
    return { valid: false, error: 'Missing or invalid payload' };
  }

  if (e.protocolVersion !== BRIDGE_PROTOCOL_VERSION) {
    return {
      valid: false,
      error: `Protocol version mismatch: got ${e.protocolVersion}, expected ${BRIDGE_PROTOCOL_VERSION}`,
    };
  }

  const validKinds: BridgeEnvelopeKind[] = [
    'handshake_request',
    'handshake_response',
    'run_request',
    'run_started',
    'assistant_text',
    'approval_required',
    'tool_request',
    'tool_response',
    'progress',
    'error',
    'heartbeat',
    'complete',
  ];
  if (!validKinds.includes(e.kind as BridgeEnvelopeKind)) {
    return { valid: false, error: `Unknown envelope kind: ${e.kind}` };
  }

  return { valid: true };
}
