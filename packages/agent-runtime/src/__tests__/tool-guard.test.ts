import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createOpenSlackAgentLauncher,
  createRunStore,
  ToolGuard,
  PermissionDeniedError,
} from '../index.js';
import type {
  AgentExecutionAdapter,
  AdapterExecutionContext,
  AdapterExecutionResult,
} from '../index.js';
import { readTranscript } from '../transcript.js';

function makeTempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'tool-guard-test-'));
}

function cleanup(root: string) {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

describe('ToolGuard', () => {
  it('check() returns true for allowed tools', () => {
    const mockRecorder = { progress: vi.fn() } as any;
    const profile = {
      allowedTools: ['Read', 'Grep', 'Glob'],
      deniedTools: ['Bash', 'github.pr.approve'],
      permissionMode: 'plan' as const,
      canApprovePR: false as const,
      canMerge: false as const,
      canReadSecrets: false as const,
      canBypassRulesets: false as const,
      acceptEdits: false,
      isReadOnly: true,
    };

    const guard = new ToolGuard(profile, mockRecorder, 'RUN-TEST');
    expect(guard.check('Read')).toBe(true);
    expect(guard.check('Grep')).toBe(true);
    expect(mockRecorder.progress).not.toHaveBeenCalled();
  });

  it('check() throws PermissionDeniedError for denied tools', () => {
    const mockRecorder = { progress: vi.fn() } as any;
    const profile = {
      allowedTools: ['Read'],
      deniedTools: ['Bash', 'github.pr.merge'],
      permissionMode: 'plan' as const,
      canApprovePR: false as const,
      canMerge: false as const,
      canReadSecrets: false as const,
      canBypassRulesets: false as const,
      acceptEdits: false,
      isReadOnly: true,
    };

    const guard = new ToolGuard(profile, mockRecorder, 'RUN-TEST');

    expect(() => guard.check('Bash')).toThrow(PermissionDeniedError);
    expect(mockRecorder.progress).toHaveBeenCalledWith(
      'RUN-TEST',
      expect.objectContaining({ step: 'tool_denied', toolName: 'Bash' }),
    );
  });

  it('check() throws for hardcoded forbidden actions', () => {
    const mockRecorder = { progress: vi.fn() } as any;
    const profile = {
      allowedTools: ['Read', 'github.pr.approve'], // Even if somehow in allowed
      deniedTools: [],
      permissionMode: 'plan' as const,
      canApprovePR: false as const,
      canMerge: false as const,
      canReadSecrets: false as const,
      canBypassRulesets: false as const,
      acceptEdits: false,
      isReadOnly: true,
    };

    const guard = new ToolGuard(profile, mockRecorder, 'RUN-TEST');

    // github.pr.approve is in SUBAGENT_ALWAYS_FORBIDDEN, even if in allowedTools
    expect(() => guard.check('github.pr.approve')).toThrow(PermissionDeniedError);
    expect(() => guard.check('secrets.read')).toThrow(PermissionDeniedError);
    expect(() => guard.check('github.pr.merge')).toThrow(PermissionDeniedError);
    expect(() => guard.check('ruleset.bypass')).toThrow(PermissionDeniedError);
    expect(() => guard.check('agent.registry.write')).toThrow(PermissionDeniedError);
    expect(() => guard.check('workflow.trust.upgrade')).toThrow(PermissionDeniedError);
  });

  it('isAllowed() returns boolean without throwing', () => {
    const mockRecorder = { progress: vi.fn() } as any;
    const profile = {
      allowedTools: ['Read'],
      deniedTools: ['Bash'],
      permissionMode: 'plan' as const,
      canApprovePR: false as const,
      canMerge: false as const,
      canReadSecrets: false as const,
      canBypassRulesets: false as const,
      acceptEdits: false,
      isReadOnly: true,
    };

    const guard = new ToolGuard(profile, mockRecorder, 'RUN-TEST');
    expect(guard.isAllowed('Read')).toBe(true);
    expect(guard.isAllowed('Bash')).toBe(false);
    expect(guard.isAllowed('secrets.read')).toBe(false);
    // No transcript events for isAllowed (non-throwing)
    expect(mockRecorder.progress).not.toHaveBeenCalled();
  });

  it('enforceScope() returns allowed/denied and writes transcript for denied', () => {
    const mockRecorder = { progress: vi.fn() } as any;
    const profile = {
      allowedTools: ['Read', 'Grep'],
      deniedTools: ['Bash'],
      permissionMode: 'plan' as const,
      canApprovePR: false as const,
      canMerge: false as const,
      canReadSecrets: false as const,
      canBypassRulesets: false as const,
      acceptEdits: false,
      isReadOnly: true,
    };

    const guard = new ToolGuard(profile, mockRecorder, 'RUN-TEST');
    const result = guard.enforceScope(['Read', 'Bash', 'secrets.read']);

    expect(result.allowed).toEqual(['Read']);
    expect(result.denied).toEqual(['Bash', 'secrets.read']);

    // Should have written a tool_scope_enforced event for the denied tools
    expect(mockRecorder.progress).toHaveBeenCalledWith(
      'RUN-TEST',
      expect.objectContaining({
        step: 'tool_scope_enforced',
        deniedTools: ['Bash', 'secrets.read'],
      }),
    );
  });
});

describe('ToolGuard in adapter execution', () => {
  let root: string;

  beforeEach(() => {
    root = makeTempRoot();
  });

  afterEach(() => {
    cleanup(root);
  });

  it('adapter that requests denied tool via guard.check gets PermissionDeniedError', async () => {
    const guardCheckingAdapter: AgentExecutionAdapter = {
      adapterId: 'test-guard-check',
      async execute<T>(context: AdapterExecutionContext): Promise<AdapterExecutionResult<T>> {
        // Try to check a forbidden tool — should throw
        context.toolGuard.check('github.pr.merge');
        return { data: { ok: true } as T };
      },
    };

    const store = createRunStore(root);
    const launcher = createOpenSlackAgentLauncher({
      runStore: store,
      rootDir: root,
      adapter: guardCheckingAdapter,
    });

    await expect(
      launcher('test prompt', {
        label: 'worker',
        phase: 'execute',
        resolvedAgentConfig: {
          agentId: 'worker',
          source: 'test',
          permissionMode: 'plan',
        },
      }),
    ).rejects.toThrow(PermissionDeniedError);

    // Run should be recorded as failed
    const runs = store.listRuns();
    expect(runs[0].status).toBe('failed');

    // Transcript should have tool_denied event
    const transcript = readTranscript(runs[0].runId, root);
    const deniedEvent = transcript.find(
      (e) => e.type === 'progress' && (e.data as Record<string, unknown>).step === 'tool_denied',
    );
    expect(deniedEvent).toBeDefined();
    expect((deniedEvent!.data as Record<string, unknown>).toolName).toBe('github.pr.merge');
  });

  it('adapter that uses enforceScope can filter tools before use', async () => {
    let capturedAllowed: string[] | undefined;
    let capturedDenied: string[] | undefined;

    const scopeCheckingAdapter: AgentExecutionAdapter = {
      adapterId: 'test-scope',
      async execute<T>(context: AdapterExecutionContext): Promise<AdapterExecutionResult<T>> {
        const scope = context.toolGuard.enforceScope(['Read', 'Bash', 'secrets.read']);
        capturedAllowed = scope.allowed;
        capturedDenied = scope.denied;
        return { data: { ok: true } as T };
      },
    };

    const store = createRunStore(root);
    const launcher = createOpenSlackAgentLauncher({
      runStore: store,
      rootDir: root,
      adapter: scopeCheckingAdapter,
    });

    await launcher('test prompt', {
      label: 'worker',
      phase: 'execute',
      resolvedAgentConfig: {
        agentId: 'worker',
        source: 'test',
        permissionMode: 'plan',
        tools: ['Read', 'Grep'],
      },
    });

    expect(capturedAllowed).toEqual(['Read']);
    expect(capturedDenied).toEqual(['Bash', 'secrets.read']);
  });

  it('local adapter uses tool guard for simulated tool calls', async () => {
    const store = createRunStore(root);
    const launcher = createOpenSlackAgentLauncher({
      runStore: store,
      rootDir: root,
    });

    // plan mode — only Read, Grep, Glob, Find allowed
    await launcher('review this code', {
      label: 'reviewer',
      phase: 'review',
      resolvedAgentConfig: {
        agentId: 'reviewer',
        source: 'test',
        permissionMode: 'plan',
        tools: ['Read', 'Grep'],
      },
    });

    const run = store.listRuns()[0];
    const transcript = readTranscript(run.runId, root);

    // Should have tool_call events only for allowed tools
    const toolCalls = transcript.filter((e) => e.type === 'tool_call');
    for (const tc of toolCalls) {
      const toolName = (tc.data as Record<string, unknown>).toolName as string;
      expect(['Read', 'Grep']).toContain(toolName);
      expect(toolName).not.toBe('Bash');
    }
  });
});
