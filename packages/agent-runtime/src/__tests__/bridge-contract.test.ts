import { describe, it, expect, vi } from 'vitest';
import {
  BRIDGE_PROTOCOL_VERSION,
  BridgeSessionStateMachine,
  BridgeStateError,
  buildBridgeEnvelope,
  validateBridgeEnvelope,
} from '../bridge-contract.js';
import type { BridgeEnvelope, BridgeEnvelopeKind, BridgeCapabilityDescriptor } from '../bridge-contract.js';

describe('BRIDGE_PROTOCOL_VERSION', () => {
  it('has a date-based version string', () => {
    expect(BRIDGE_PROTOCOL_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('BridgeSessionStateMachine', () => {
  it('starts in idle state', () => {
    const sm = new BridgeSessionStateMachine('sess-1');
    expect(sm.currentState).toBe('idle');
    expect(sm.id).toBe('sess-1');
  });

  it('transitions idle → initializing → ready → busy → ready → shutdown', () => {
    const sm = new BridgeSessionStateMachine('sess-1');
    expect(sm.transition('initializing')).toBe('initializing');
    expect(sm.transition('ready')).toBe('ready');
    expect(sm.transition('busy')).toBe('busy');
    expect(sm.transition('ready')).toBe('ready');
    expect(sm.transition('shutdown')).toBe('shutdown');
  });

  it('transitions idle → shutdown directly', () => {
    const sm = new BridgeSessionStateMachine('sess-1');
    expect(sm.transition('shutdown')).toBe('shutdown');
  });

  it('transitions initializing → shutdown', () => {
    const sm = new BridgeSessionStateMachine('sess-1');
    sm.transition('initializing');
    expect(sm.transition('shutdown')).toBe('shutdown');
  });

  it('transitions busy → shutdown', () => {
    const sm = new BridgeSessionStateMachine('sess-1');
    sm.transition('initializing');
    sm.transition('ready');
    sm.transition('busy');
    expect(sm.transition('shutdown')).toBe('shutdown');
  });

  it('rejects idle → ready (must pass through initializing)', () => {
    const sm = new BridgeSessionStateMachine('sess-1');
    expect(() => sm.transition('ready')).toThrow(BridgeStateError);
  });

  it('rejects idle → busy', () => {
    const sm = new BridgeSessionStateMachine('sess-1');
    expect(() => sm.transition('busy')).toThrow(BridgeStateError);
  });

  it('rejects initializing → busy (must pass through ready)', () => {
    const sm = new BridgeSessionStateMachine('sess-1');
    sm.transition('initializing');
    expect(() => sm.transition('busy')).toThrow(BridgeStateError);
  });

  it('rejects ready → initializing', () => {
    const sm = new BridgeSessionStateMachine('sess-1');
    sm.transition('initializing');
    sm.transition('ready');
    expect(() => sm.transition('initializing')).toThrow(BridgeStateError);
  });

  it('rejects shutdown → any state', () => {
    const sm = new BridgeSessionStateMachine('sess-1');
    sm.transition('shutdown');
    expect(() => sm.transition('idle')).toThrow(BridgeStateError);
    expect(() => sm.transition('ready')).toThrow(BridgeStateError);
  });

  it('no-op when transitioning to same state', () => {
    const sm = new BridgeSessionStateMachine('sess-1');
    expect(sm.transition('idle')).toBe('idle');
  });

  it('calls onTransition callback for each transition', () => {
    const transitions: Array<{ from: string; to: string }> = [];
    const sm = new BridgeSessionStateMachine('sess-1', (from, to) => {
      transitions.push({ from, to });
    });

    sm.transition('initializing');
    sm.transition('ready');
    sm.transition('busy');

    expect(transitions).toHaveLength(3);
    expect(transitions[0]).toEqual({ from: 'idle', to: 'initializing' });
    expect(transitions[1]).toEqual({ from: 'initializing', to: 'ready' });
    expect(transitions[2]).toEqual({ from: 'ready', to: 'busy' });
  });

  it('forceShutdown transitions from any state', () => {
    const sm = new BridgeSessionStateMachine('sess-1');
    sm.transition('initializing');
    sm.transition('ready');
    sm.transition('busy');
    expect(sm.forceShutdown()).toBe('shutdown');
    expect(sm.currentState).toBe('shutdown');
  });

  it('forceShutdown from idle state', () => {
    const sm = new BridgeSessionStateMachine('sess-1');
    expect(sm.forceShutdown()).toBe('shutdown');
    expect(sm.currentState).toBe('shutdown');
  });

  it('forceShutdown from initializing state', () => {
    const sm = new BridgeSessionStateMachine('sess-1');
    sm.transition('initializing');
    expect(sm.forceShutdown()).toBe('shutdown');
  });

  it('forceShutdown from ready state', () => {
    const sm = new BridgeSessionStateMachine('sess-1');
    sm.transition('initializing');
    sm.transition('ready');
    expect(sm.forceShutdown()).toBe('shutdown');
  });

  it('forceShutdown is no-op when already in shutdown state', () => {
    const transitions: Array<{ from: string; to: string }> = [];
    const sm = new BridgeSessionStateMachine('sess-1', (from, to) => {
      transitions.push({ from, to });
    });
    sm.forceShutdown();
    expect(transitions).toHaveLength(1);
    // Second forceShutdown should be a no-op (no callback fired)
    sm.forceShutdown();
    expect(transitions).toHaveLength(1);
  });

  it('forceShutdown calls onTransition', () => {
    let called = false;
    const sm = new BridgeSessionStateMachine('sess-1', () => {
      called = true;
    });
    sm.forceShutdown();
    expect(called).toBe(true);
  });

  it('BridgeStateError carries from/to states', () => {
    const sm = new BridgeSessionStateMachine('sess-1');
    try {
      sm.transition('ready');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(BridgeStateError);
      expect((err as BridgeStateError).from).toBe('idle');
      expect((err as BridgeStateError).to).toBe('ready');
      expect((err as BridgeStateError).message).toContain('idle');
      expect((err as BridgeStateError).message).toContain('ready');
    }
  });
});

describe('buildBridgeEnvelope', () => {
  it('creates envelope with all required fields', () => {
    const envelope = buildBridgeEnvelope('sess-1', 'run-123', 'progress', { step: 'hello' });

    expect(envelope.protocolVersion).toBe(BRIDGE_PROTOCOL_VERSION);
    expect(envelope.sessionId).toBe('sess-1');
    expect(envelope.correlationId).toBe('run-123');
    expect(envelope.kind).toBe('progress');
    expect(envelope.payload).toEqual({ step: 'hello' });
    expect(typeof envelope.timestamp).toBe('string');
    expect(envelope.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('creates different envelope kinds', () => {
    const kinds: BridgeEnvelopeKind[] = [
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

    for (const kind of kinds) {
      const envelope = buildBridgeEnvelope('sess', 'run', kind, {});
      expect(envelope.kind).toBe(kind);
    }
  });
});

describe('validateBridgeEnvelope', () => {
  it('validates a correct envelope', () => {
    const envelope = buildBridgeEnvelope('sess-1', 'run-123', 'progress', { step: 'hello' });
    const result = validateBridgeEnvelope(envelope);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('rejects null envelope', () => {
    const result = validateBridgeEnvelope(null);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('object');
  });

  it('rejects non-object envelope', () => {
    const result = validateBridgeEnvelope('string');
    expect(result.valid).toBe(false);
  });

  it('rejects missing protocolVersion', () => {
    const result = validateBridgeEnvelope({ sessionId: 's', correlationId: 'r', timestamp: 't', kind: 'progress', payload: {} });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('protocolVersion');
  });

  it('rejects missing sessionId', () => {
    const result = validateBridgeEnvelope({ protocolVersion: BRIDGE_PROTOCOL_VERSION, correlationId: 'r', timestamp: 't', kind: 'progress', payload: {} });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('sessionId');
  });

  it('rejects missing correlationId', () => {
    const result = validateBridgeEnvelope({ protocolVersion: BRIDGE_PROTOCOL_VERSION, sessionId: 's', timestamp: 't', kind: 'progress', payload: {} });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('correlationId');
  });

  it('rejects missing timestamp', () => {
    const result = validateBridgeEnvelope({ protocolVersion: BRIDGE_PROTOCOL_VERSION, sessionId: 's', correlationId: 'r', kind: 'progress', payload: {} });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('timestamp');
  });

  it('rejects missing kind', () => {
    const result = validateBridgeEnvelope({ protocolVersion: BRIDGE_PROTOCOL_VERSION, sessionId: 's', correlationId: 'r', timestamp: 't', payload: {} });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('kind');
  });

  it('rejects missing payload', () => {
    const result = validateBridgeEnvelope({ protocolVersion: BRIDGE_PROTOCOL_VERSION, sessionId: 's', correlationId: 'r', timestamp: 't', kind: 'progress' });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('payload');
  });

  it('rejects protocol version mismatch', () => {
    const envelope = {
      protocolVersion: '2024-01-01',
      sessionId: 's',
      correlationId: 'r',
      timestamp: '2025-01-01T00:00:00Z',
      kind: 'progress',
      payload: {},
    };
    const result = validateBridgeEnvelope(envelope);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('version mismatch');
  });

  it('rejects unknown envelope kind', () => {
    const envelope = {
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      sessionId: 's',
      correlationId: 'r',
      timestamp: '2025-01-01T00:00:00Z',
      kind: 'unknown_kind',
      payload: {},
    };
    const result = validateBridgeEnvelope(envelope);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Unknown envelope kind');
  });

  it('rejects empty sessionId', () => {
    const envelope = {
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      sessionId: '',
      correlationId: 'r',
      timestamp: '2025-01-01T00:00:00Z',
      kind: 'progress',
      payload: {},
    };
    const result = validateBridgeEnvelope(envelope);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('sessionId');
  });

  it('rejects empty correlationId', () => {
    const envelope = {
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      sessionId: 's',
      correlationId: '',
      timestamp: '2025-01-01T00:00:00Z',
      kind: 'progress',
      payload: {},
    };
    const result = validateBridgeEnvelope(envelope);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('correlationId');
  });

  it('rejects empty timestamp', () => {
    const envelope = {
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      sessionId: 's',
      correlationId: 'r',
      timestamp: '',
      kind: 'progress',
      payload: {},
    };
    const result = validateBridgeEnvelope(envelope);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('timestamp');
  });
});

describe('BridgeContract interface (type check)', () => {
  it('can be implemented by a concrete class with all methods', async () => {
    const mockContract = {
      bridgeId: 'test-bridge',
      negotiateCapabilities: vi.fn().mockResolvedValue([{ name: 'test-cap' }]),
      openSession: vi.fn().mockResolvedValue('ready'),
      closeSession: vi.fn().mockResolvedValue('shutdown'),
      sendEnvelope: vi.fn().mockResolvedValue(undefined),
      healthCheck: vi.fn().mockResolvedValue({ healthy: true }),
    };

    // Test all five interface methods
    const caps = await mockContract.negotiateCapabilities([{ name: 'test-cap' }]);
    expect(caps).toHaveLength(1);
    expect(mockContract.negotiateCapabilities).toHaveBeenCalled();

    const sessionState = await mockContract.openSession({ runId: 'r1', agentId: 'a1', prompt: 'test', permissionProfile: { allowedTools: [], deniedTools: [], permissionMode: 'plan' } });
    expect(sessionState).toBe('ready');
    expect(mockContract.openSession).toHaveBeenCalled();

    const closeState = await mockContract.closeSession('sess-1');
    expect(closeState).toBe('shutdown');
    expect(mockContract.closeSession).toHaveBeenCalled();

    await mockContract.sendEnvelope('sess-1', buildBridgeEnvelope('sess-1', 'run-1', 'progress', {}));
    expect(mockContract.sendEnvelope).toHaveBeenCalled();

    const health = await mockContract.healthCheck();
    expect(health.healthy).toBe(true);
    expect(mockContract.healthCheck).toHaveBeenCalled();
  });
});
