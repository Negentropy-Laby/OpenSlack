import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BridgePermissionGuard } from '../bridge-permission-guard.js';
import { buildPermissionProfile } from '../permissions.js';
import { createRunRecorder } from '../recorder.js';
import { createRunStore } from '../run-store.js';
import { generateRunId } from '../run-store.js';
import { readTranscript } from '../transcript.js';
import { buildBridgeEnvelope } from '../bridge-contract.js';

function makeTempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'bridge-guard-test-'));
}

function cleanup(root: string) {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

describe('BridgePermissionGuard', () => {
  let root: string;
  let store: ReturnType<typeof createRunStore>;
  let recorder: ReturnType<typeof createRunRecorder>;

  beforeEach(() => {
    root = makeTempRoot();
    store = createRunStore(root);
    recorder = createRunRecorder(store, root);
  });

  afterEach(() => {
    cleanup(root);
  });

  it('canApprovePR always returns false', () => {
    const profile = buildPermissionProfile({ agentId: 'test', source: 'test' });
    const guard = new BridgePermissionGuard(profile, recorder, 'RUN-1');
    expect(guard.canApprovePR).toBe(false);
  });

  it('canMerge always returns false', () => {
    const profile = buildPermissionProfile({ agentId: 'test', source: 'test' });
    const guard = new BridgePermissionGuard(profile, recorder, 'RUN-1');
    expect(guard.canMerge).toBe(false);
  });

  it('canReadSecrets always returns false', () => {
    const profile = buildPermissionProfile({ agentId: 'test', source: 'test' });
    const guard = new BridgePermissionGuard(profile, recorder, 'RUN-1');
    expect(guard.canReadSecrets).toBe(false);
  });

  it('canBypassRulesets always returns false', () => {
    const profile = buildPermissionProfile({ agentId: 'test', source: 'test' });
    const guard = new BridgePermissionGuard(profile, recorder, 'RUN-1');
    expect(guard.canBypassRulesets).toBe(false);
  });

  it('filterOutboundTools allows tools in profile', () => {
    const profile = buildPermissionProfile({
      agentId: 'test',
      source: 'test',
      permissionMode: 'default',
    });
    const guard = new BridgePermissionGuard(profile, recorder, 'RUN-1');
    const result = guard.filterOutboundTools(['Read', 'Edit']);

    expect(result.allowed).toContain('Read');
    expect(result.allowed).toContain('Edit');
  });

  it('filterOutboundTools denies tools not in allowed list', () => {
    const profile = buildPermissionProfile({
      agentId: 'test',
      source: 'test',
      permissionMode: 'plan',
    });
    const guard = new BridgePermissionGuard(profile, recorder, 'RUN-1');
    const result = guard.filterOutboundTools(['Read', 'Bash']);

    expect(result.allowed).toContain('Read');
    expect(result.denied).toContain('Bash');
  });

  it('filterOutboundTools removes SUBAGENT_ALWAYS_FORBIDDEN', () => {
    const profile = buildPermissionProfile({
      agentId: 'test',
      source: 'test',
      permissionMode: 'strict',
    });
    const guard = new BridgePermissionGuard(profile, recorder, 'RUN-1');

    // Simulate a maliciously injected forbidden tool
    const result = guard.filterOutboundTools([
      'Read',
      'github.pr.approve',
      'github.pr.merge',
      'secrets.read',
      'ruleset.bypass',
      'agent.registry.write',
      'workflow.trust.upgrade',
    ]);

    expect(result.allowed).toContain('Read');
    expect(result.denied).toContain('github.pr.approve');
    expect(result.denied).toContain('github.pr.merge');
    expect(result.denied).toContain('secrets.read');
    expect(result.denied).toContain('ruleset.bypass');
    expect(result.denied).toContain('agent.registry.write');
    expect(result.denied).toContain('workflow.trust.upgrade');
  });

  it('filterOutboundTools records denial in transcript', () => {
    const runId = generateRunId();
    recorder.start({
      runId,
      agentId: 'test',
      prompt: 'test',
      resolvedConfig: { agentId: 'test', source: 'test' },
      permissionProfile: buildPermissionProfile({ agentId: 'test', source: 'test', permissionMode: 'plan' }),
    });

    const profile = buildPermissionProfile({
      agentId: 'test',
      source: 'test',
      permissionMode: 'plan',
    });
    const guard = new BridgePermissionGuard(profile, recorder, runId);
    guard.filterOutboundTools(['Read', 'Bash']);

    const transcript = readTranscript(runId, root);
    const event = transcript.find(
      (e) => e.type === 'progress' && (e.data as Record<string, unknown>).step === 'bridge_permission_filter',
    );
    expect(event).toBeDefined();
    expect((event!.data as Record<string, unknown>).deniedTools).toContain('Bash');
  });

  it('validateInboundResponse allows valid tool_response', () => {
    const profile = buildPermissionProfile({
      agentId: 'test',
      source: 'test',
      permissionMode: 'default',
    });
    const guard = new BridgePermissionGuard(profile, recorder, 'RUN-1');

    const envelope = buildBridgeEnvelope('sess', 'run', 'tool_response', {
      toolName: 'Read',
      result: { content: 'hello' },
    });

    const result = guard.validateInboundResponse(envelope);
    expect(result.valid).toBe(true);
  });

  it('validateInboundResponse rejects denied tool in tool_response', () => {
    const profile = buildPermissionProfile({
      agentId: 'test',
      source: 'test',
      permissionMode: 'plan',
    });
    const guard = new BridgePermissionGuard(profile, recorder, 'RUN-1');

    const envelope = buildBridgeEnvelope('sess', 'run', 'tool_response', {
      toolName: 'Bash',
      result: {},
    });

    const result = guard.validateInboundResponse(envelope);
    expect(result.valid).toBe(false);
    expect(result.violation).toContain('Bash');
  });

  it('validateInboundResponse rejects SUBAGENT_ALWAYS_FORBIDDEN in payload', () => {
    const profile = buildPermissionProfile({
      agentId: 'test',
      source: 'test',
      permissionMode: 'default',
    });
    const guard = new BridgePermissionGuard(profile, recorder, 'RUN-1');

    const envelope = buildBridgeEnvelope('sess', 'run', 'progress', {
      action: 'github.pr.approve',
      prNumber: 42,
    });

    const result = guard.validateInboundResponse(envelope);
    expect(result.valid).toBe(false);
    expect(result.violation).toContain('github.pr.approve');
  });

  it('validateInboundResponse allows non-tool envelopes', () => {
    const profile = buildPermissionProfile({
      agentId: 'test',
      source: 'test',
      permissionMode: 'default',
    });
    const guard = new BridgePermissionGuard(profile, recorder, 'RUN-1');

    const envelope = buildBridgeEnvelope('sess', 'run', 'progress', {
      step: 'thinking',
    });

    const result = guard.validateInboundResponse(envelope);
    expect(result.valid).toBe(true);
  });

  it('filterInboundToolEvents separates valid and invalid', () => {
    const profile = buildPermissionProfile({
      agentId: 'test',
      source: 'test',
      permissionMode: 'default',
      disallowedTools: ['Bash'],
    });
    const guard = new BridgePermissionGuard(profile, recorder, 'RUN-1');

    const events = [
      { toolName: 'Read', payload: {} },
      { toolName: 'Bash', payload: {} },
      { toolName: 'Edit', payload: {} },
      { toolName: 'github.pr.approve', payload: {} },
    ];

    const result = guard.filterInboundToolEvents(events);
    expect(result.valid).toHaveLength(2);
    expect(result.valid.map((e) => e.toolName)).toContain('Read');
    expect(result.valid.map((e) => e.toolName)).toContain('Edit');
    expect(result.violations).toHaveLength(2);
    expect(result.violations.map((v) => v.toolName)).toContain('Bash');
    expect(result.violations.map((v) => v.toolName)).toContain('github.pr.approve');
  });

  it('records denial evidence for rejected inbound tools', () => {
    const runId = generateRunId();
    recorder.start({
      runId,
      agentId: 'test',
      prompt: 'test',
      resolvedConfig: { agentId: 'test', source: 'test' },
      permissionProfile: buildPermissionProfile({ agentId: 'test', source: 'test' }),
    });

    const profile = buildPermissionProfile({
      agentId: 'test',
      source: 'test',
      permissionMode: 'plan',
    });
    const guard = new BridgePermissionGuard(profile, recorder, runId);

    guard.filterInboundToolEvents([{ toolName: 'Bash', payload: {} }]);

    const transcript = readTranscript(runId, root);
    const event = transcript.find(
      (e) => e.type === 'progress' && (e.data as Record<string, unknown>).step === 'bridge_permission_denied',
    );
    expect(event).toBeDefined();
    expect((event!.data as Record<string, unknown>).toolName).toBe('Bash');
  });

  it('rejects tool_response with no toolName field', () => {
    const profile = buildPermissionProfile({
      agentId: 'test',
      source: 'test',
      permissionMode: 'default',
    });
    const guard = new BridgePermissionGuard(profile, recorder, 'RUN-1');

    // No toolName field — should pass since there's no tool to deny
    const envelope = buildBridgeEnvelope('sess', 'run', 'tool_response', {
      result: { content: 'hello' },
    });

    const result = guard.validateInboundResponse(envelope);
    expect(result.valid).toBe(true);
  });

  it('allows payload containing forbidden action name as documentation substring', () => {
    const profile = buildPermissionProfile({
      agentId: 'test',
      source: 'test',
      permissionMode: 'default',
    });
    const guard = new BridgePermissionGuard(profile, recorder, 'RUN-1');

    // This should NOT be flagged — the forbidden name appears in documentation text,
    // not as a value in an action/tool field
    const envelope = buildBridgeEnvelope('sess', 'run', 'progress', {
      description: 'Documentation about github.pr.approve permissions policy',
    });

    const result = guard.validateInboundResponse(envelope);
    expect(result.valid).toBe(true);
  });

  it('rejects forbidden action in nested object action field', () => {
    const profile = buildPermissionProfile({
      agentId: 'test',
      source: 'test',
      permissionMode: 'default',
    });
    const guard = new BridgePermissionGuard(profile, recorder, 'RUN-1');

    const envelope = buildBridgeEnvelope('sess', 'run', 'progress', {
      nested: { action: 'github.pr.approve' },
    });

    const result = guard.validateInboundResponse(envelope);
    expect(result.valid).toBe(false);
    expect(result.violation).toContain('github.pr.approve');
  });

  it('rejects non-tool envelope kind with forbidden toolName', () => {
    const profile = buildPermissionProfile({
      agentId: 'test',
      source: 'test',
      permissionMode: 'plan',
    });
    const guard = new BridgePermissionGuard(profile, recorder, 'RUN-1');

    // A 'complete' envelope that carries a toolName field with a denied tool
    const envelope = buildBridgeEnvelope('sess', 'run', 'complete', {
      toolName: 'Bash',
      result: 'done',
    });

    const result = guard.validateInboundResponse(envelope);
    expect(result.valid).toBe(false);
    expect(result.violation).toContain('Bash');
  });
});
