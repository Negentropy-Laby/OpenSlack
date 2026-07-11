import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRunStore } from '../run-store.js';
import type { AgentRunRequest } from '../types.js';

function makeTempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'agent-runtime-test-'));
}

function cleanup(root: string) {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function makeRequest(overrides?: Partial<AgentRunRequest>): AgentRunRequest {
  return {
    runId: 'RUN-20260101-TEST1234',
    agentId: 'test-agent',
    prompt: 'Test prompt',
    resolvedConfig: { agentId: 'test-agent', source: 'claude-project' },
    permissionProfile: {
      allowedTools: ['Read', 'Grep'],
      deniedTools: ['Bash'],
      permissionMode: 'default',
      canApprovePR: false,
      canMerge: false,
      canReadSecrets: false,
      canBypassRulesets: false,
      acceptEdits: false,
      isReadOnly: false,
    },
    ...overrides,
  } as AgentRunRequest;
}

describe('createRunStore', () => {
  let root: string;

  beforeEach(() => {
    root = makeTempRoot();
  });

  afterEach(() => {
    cleanup(root);
  });

  it('creates a run with correct initial state', () => {
    const store = createRunStore(root);
    const request = makeRequest();
    const state = store.createRun(request);

    expect(state.runId).toBe('RUN-20260101-TEST1234');
    expect(state.status).toBe('pending');
    expect(state.agentId).toBe('test-agent');
    expect(state.tokensUsed).toBe(0);
    expect(state.toolCalls).toBe(0);
    expect(state.transcriptPath).toContain('transcript.jsonl');
  });

  it('generates a runId if not provided', () => {
    const store = createRunStore(root);
    const request = makeRequest({ runId: undefined });
    const state = store.createRun(request);

    expect(state.runId).toMatch(/^RUN-\d{8}-[A-Z0-9]+$/);
  });

  it('creates run.json and metadata.json on disk', () => {
    const store = createRunStore(root);
    const request = makeRequest();
    store.createRun(request);

    const runDir = join(root, '.openslack.local', 'agents/runs', 'RUN-20260101-TEST1234');
    expect(existsSync(join(runDir, 'run.json'))).toBe(true);
    expect(existsSync(join(runDir, 'metadata.json'))).toBe(true);

    const meta = JSON.parse(readFileSync(join(runDir, 'metadata.json'), 'utf-8'));
    expect(meta.agentId).toBe('test-agent');
    expect(meta.resolvedConfig.agentId).toBe('test-agent');
  });

  it('retrieves a run by id', () => {
    const store = createRunStore(root);
    const request = makeRequest();
    store.createRun(request);

    const found = store.getRun('RUN-20260101-TEST1234');
    expect(found).not.toBeNull();
    expect(found!.agentId).toBe('test-agent');
  });

  it('returns null for nonexistent run', () => {
    const store = createRunStore(root);
    const found = store.getRun('RUN-20260101-NONEXIST');
    expect(found).toBeNull();
  });

  it('rejects invalid runId format', () => {
    const store = createRunStore(root);
    expect(() => store.getRun('../etc/passwd')).toThrow(/Invalid run ID/);
    expect(() => store.createRun(makeRequest({ runId: '../../../etc/passwd' }))).toThrow(
      /Invalid run ID/,
    );
  });

  it('returns null for corrupted run.json', () => {
    const store = createRunStore(root);
    store.createRun(makeRequest());

    // Corrupt the file
    const runDir = join(root, '.openslack.local', 'agents/runs', 'RUN-20260101-TEST1234');
    const runPath = join(runDir, 'run.json');
    writeFileSync(runPath, 'not-valid-json', 'utf-8');

    expect(() => store.getRun('RUN-20260101-TEST1234')).toThrow(/Corrupted run metadata/);
  });

  it('updates run state', () => {
    const store = createRunStore(root);
    store.createRun(makeRequest());

    const updated = store.updateRun('RUN-20260101-TEST1234', {
      status: 'running',
      tokensUsed: 100,
      toolCalls: 2,
    });

    expect(updated.status).toBe('running');
    expect(updated.tokensUsed).toBe(100);
    expect(updated.toolCalls).toBe(2);

    const found = store.getRun('RUN-20260101-TEST1234');
    expect(found!.status).toBe('running');
  });

  it('lists runs with optional filtering', () => {
    const store = createRunStore(root);
    store.createRun(makeRequest({ runId: 'RUN-20260101-A', agentId: 'agent-a' }));
    store.createRun(makeRequest({ runId: 'RUN-20260101-B', agentId: 'agent-b' }));

    const all = store.listRuns();
    expect(all.length).toBe(2);

    const agentA = store.listRuns({ agentId: 'agent-a' });
    expect(agentA.length).toBe(1);
    expect(agentA[0].agentId).toBe('agent-a');
  });

  it('respects worktreePath from request', () => {
    const store = createRunStore(root);
    const request = makeRequest({ worktreePath: '/tmp/wt-123' });
    const state = store.createRun(request);

    expect(state.worktreePath).toBe('/tmp/wt-123');
  });

  it('persists a rejected run directly in its terminal failed state', () => {
    const store = createRunStore(root);
    const state = store.createFailedRun(makeRequest(), {
      failureCode: 'RUNTIME_NOT_CONFIGURED',
      errorSummary: 'Agent runtime is not configured.',
    });

    expect(state).toMatchObject({
      status: 'failed',
      failureCode: 'RUNTIME_NOT_CONFIGURED',
      errorSummary: 'Agent runtime is not configured.',
    });
    expect(state.completedAt).toBeDefined();
    expect(store.getRun(state.runId)).toEqual(state);
  });

  it('does not persist prompt-bearing resolved config fields', () => {
    const store = createRunStore(root);
    store.createRun(
      makeRequest({
        prompt: 'TOP_LEVEL_PROMPT_SENTINEL',
        resolvedConfig: {
          agentId: 'test-agent',
          source: 'test',
          prompt: 'RESOLVED_PROMPT_SENTINEL',
          initialPrompt: 'INITIAL_PROMPT_SENTINEL',
          criticalSystemReminder: 'REMINDER_SENTINEL',
        },
      }),
    );

    const metadataPath = join(
      root,
      '.openslack.local',
      'agents/runs',
      'RUN-20260101-TEST1234',
      'metadata.json',
    );
    const raw = readFileSync(metadataPath, 'utf-8');
    expect(raw).not.toContain('TOP_LEVEL_PROMPT_SENTINEL');
    expect(raw).not.toContain('RESOLVED_PROMPT_SENTINEL');
    expect(raw).not.toContain('INITIAL_PROMPT_SENTINEL');
    expect(raw).not.toContain('REMINDER_SENTINEL');
  });

  it('secret-scans state and metadata before creating a run directory', () => {
    const store = createRunStore(root);
    const request = makeRequest();
    request.permissionProfile.allowedTools = ['ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ'];

    expect(() => store.createRun(request)).toThrow(/Refusing to persist/);
    expect(existsSync(join(root, '.openslack.local', 'agents/runs', 'RUN-20260101-TEST1234'))).toBe(
      false,
    );
  });
});
