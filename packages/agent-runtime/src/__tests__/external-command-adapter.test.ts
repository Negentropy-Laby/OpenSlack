import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createOpenSlackAgentLauncher,
  createRunStore,
  ExternalCommandAdapter,
} from '../index.js';
import { readTranscript } from '../transcript.js';
import { buildPermissionProfile } from '../permissions.js';
import { createRunRecorder } from '../recorder.js';
import { generateRunId } from '../run-store.js';
import { ToolGuard } from '../adapter.js';

function makeTempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'ext-cmd-test-'));
}

function cleanup(root: string) {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

// Use node -e for cross-platform command execution in tests
// Use 'bun' directly since tests run under bun and it's in PATH without spaces.
// process.execPath on Windows may contain spaces (e.g. C:\Program Files\nodejs\node.exe)
// which bun's spawn with shell:false cannot resolve.
const NODE = 'bun';

describe('ExternalCommandAdapter', () => {
  let root: string;

  beforeEach(() => {
    root = makeTempRoot();
  });

  afterEach(() => {
    cleanup(root);
  });

  it('has adapterId "external-command"', () => {
    const adapter = new ExternalCommandAdapter({ command: NODE });
    expect(adapter.adapterId).toBe('external-command');
  });

  it('executes a command and captures JSON stdout', async () => {
    const store = createRunStore(root);
    const recorder = createRunRecorder(store, root);
    const profile = buildPermissionProfile({
      agentId: 'test',
      source: 'test',
      permissionMode: 'default',
    });

    const adapter = new ExternalCommandAdapter({
      command: NODE,
      args: ['-e', 'console.log(JSON.stringify({status:"ok"}))'],
      timeoutMs: 5000,
    });

    const runId = generateRunId();
    const state = recorder.start({
      runId,
      agentId: 'test',
      prompt: 'test',
      resolvedConfig: { agentId: 'test', source: 'test' },
      permissionProfile: profile,
    });

    const result = await adapter.execute<{ status: string }>({
      prompt: 'test',
      runId,
      agentId: 'test',
      resolvedConfig: { agentId: 'test', source: 'test' },
      permissionProfile: profile,
      recorder,
      runState: state,
      toolGuard: new ToolGuard(profile, recorder, runId),
    });

    expect(result.data.status).toBe('ok');
    expect(result.tokenUsage).toBeGreaterThan(0);
  });

  it('throws when command exits with non-zero code', async () => {
    const store = createRunStore(root);
    const recorder = createRunRecorder(store, root);
    const profile = buildPermissionProfile({
      agentId: 'test',
      source: 'test',
      permissionMode: 'default',
    });

    const adapter = new ExternalCommandAdapter({
      command: NODE,
      args: ['-e', 'process.exit(1)'],
      timeoutMs: 5000,
    });

    const runId = generateRunId();
    const state = recorder.start({
      runId,
      agentId: 'test',
      prompt: 'test',
      resolvedConfig: { agentId: 'test', source: 'test' },
      permissionProfile: profile,
    });

    await expect(
      adapter.execute({
        prompt: 'test',
        runId,
        agentId: 'test',
        resolvedConfig: { agentId: 'test', source: 'test' },
        permissionProfile: profile,
        recorder,
        runState: state,
        toolGuard: new ToolGuard(profile, recorder, runId),
      }),
    ).rejects.toThrow(/exited with code 1/);
  });

  it('throws PermissionDeniedError when Bash is not in allowed tools', async () => {
    const store = createRunStore(root);
    const recorder = createRunRecorder(store, root);
    // plan mode: only Read, Grep, Glob, Find — no Bash
    const profile = buildPermissionProfile({
      agentId: 'test',
      source: 'test',
      permissionMode: 'plan',
    });

    const adapter = new ExternalCommandAdapter({
      command: NODE,
      args: ['-e', 'console.log("hello")'],
      timeoutMs: 5000,
    });

    const runId = generateRunId();
    const state = recorder.start({
      runId,
      agentId: 'test',
      prompt: 'test',
      resolvedConfig: { agentId: 'test', source: 'test' },
      permissionProfile: profile,
    });

    await expect(
      adapter.execute({
        prompt: 'test',
        runId,
        agentId: 'test',
        resolvedConfig: { agentId: 'test', source: 'test' },
        permissionProfile: profile,
        recorder,
        runState: state,
        toolGuard: new ToolGuard(profile, recorder, runId),
      }),
    ).rejects.toThrow(/Permission denied/);

    // Transcript should have tool_denied event
    const transcript = readTranscript(runId, root);
    const deniedEvent = transcript.find(
      (e) => e.type === 'progress' && (e.data as Record<string, unknown>).step === 'tool_denied',
    );
    expect(deniedEvent).toBeDefined();
  });

  it('times out when command runs longer than timeoutMs', async () => {
    const store = createRunStore(root);
    const recorder = createRunRecorder(store, root);
    const profile = buildPermissionProfile({
      agentId: 'test',
      source: 'test',
      permissionMode: 'default',
    });

    // Command that sleeps for 10 seconds
    const adapter = new ExternalCommandAdapter({
      command: NODE,
      args: ['-e', 'setTimeout(() => {}, 10000)'],
      timeoutMs: 500, // 500ms timeout
    });

    const runId = generateRunId();
    const state = recorder.start({
      runId,
      agentId: 'test',
      prompt: 'test',
      resolvedConfig: { agentId: 'test', source: 'test' },
      permissionProfile: profile,
    });

    await expect(
      adapter.execute({
        prompt: 'test',
        runId,
        agentId: 'test',
        resolvedConfig: { agentId: 'test', source: 'test' },
        permissionProfile: profile,
        recorder,
        runState: state,
        toolGuard: new ToolGuard(profile, recorder, runId),
      }),
    ).rejects.toThrow(/timed out/);

    // Transcript should have timeout info
    const transcript = readTranscript(runId, root);
    const failedEvent = transcript.find(
      (e) => e.type === 'progress' && (e.data as Record<string, unknown>).step === 'external_command_failed',
    );
    expect(failedEvent).toBeDefined();
  }, 10000); // Allow up to 10s for this test

  it('works through the launcher with adapter injection', async () => {
    const adapter = new ExternalCommandAdapter({
      command: NODE,
      args: ['-e', 'console.log(JSON.stringify({review:"ok",findings:[]}))'],
      timeoutMs: 5000,
    });

    const store = createRunStore(root);
    const launcher = createOpenSlackAgentLauncher({
      runStore: store,
      rootDir: root,
      adapter,
    });

    const result = await launcher('review this code', {
      label: 'reviewer',
      phase: 'review',
      resolvedAgentConfig: {
        agentId: 'reviewer',
        source: 'test',
        permissionMode: 'default',
      },
    });

    expect((result.data as Record<string, unknown>).review).toBe('ok');

    const runs = store.listRuns();
    expect(runs[0].status).toBe('completed');
  });

  it('records external_command_start and external_command_complete in transcript', async () => {
    const adapter = new ExternalCommandAdapter({
      command: NODE,
      args: ['-e', 'console.log("hello")'],
      timeoutMs: 5000,
      parseJson: false,
    });

    const store = createRunStore(root);
    const launcher = createOpenSlackAgentLauncher({
      runStore: store,
      rootDir: root,
      adapter,
    });

    await launcher('test prompt', {
      label: 'worker',
      phase: 'execute',
      resolvedAgentConfig: {
        agentId: 'worker',
        source: 'test',
        permissionMode: 'default',
      },
    });

    const run = store.listRuns()[0];
    const transcript = readTranscript(run.runId, root);

    const startEvent = transcript.find(
      (e) => e.type === 'progress' && (e.data as Record<string, unknown>).step === 'external_command_start',
    );
    expect(startEvent).toBeDefined();

    const completeEvent = transcript.find(
      (e) => e.type === 'progress' && (e.data as Record<string, unknown>).step === 'external_command_complete',
    );
    expect(completeEvent).toBeDefined();
    expect((completeEvent!.data as Record<string, unknown>).exitCode).toBe(0);
  });

  it('passes prompt to child process via OPENSLACK_AGENT_PROMPT env var', async () => {
    // Command that echoes back the prompt env var
    const adapter = new ExternalCommandAdapter({
      command: NODE,
      args: ['-e', 'console.log(JSON.stringify({prompt: process.env.OPENSLACK_AGENT_PROMPT, agentId: process.env.OPENSLACK_AGENT_ID}))'],
      timeoutMs: 5000,
    });

    const store = createRunStore(root);
    const launcher = createOpenSlackAgentLauncher({
      runStore: store,
      rootDir: root,
      adapter,
    });

    const result = await launcher('review the authentication module', {
      label: 'reviewer',
      phase: 'review',
      resolvedAgentConfig: {
        agentId: 'reviewer',
        source: 'test',
        permissionMode: 'default',
      },
    });

    const data = result.data as Record<string, unknown>;
    expect(data.prompt).toBe('review the authentication module');
    expect(data.agentId).toBe('reviewer');
  });
});
