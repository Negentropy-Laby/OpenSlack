import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createBridgeRuntimeResolver,
  createOpenSlackAgentLauncher,
  createRunStore,
} from '../index.js';
import { readTranscript } from '../transcript.js';
import { resolveTestBunExecutable } from './test-executable.js';

const BUN = resolveTestBunExecutable();

function makeTempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'bridge-process-smoke-test-'));
}

function cleanup(root: string): void {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function createFakeAbyRoot(root: string): string {
  const abyRoot = join(root, 'fake-aby');
  const entrypointDir = join(abyRoot, 'src', 'sidecar', 'entrypoints');
  mkdirSync(entrypointDir, { recursive: true });

  writeFileSync(
    join(entrypointDir, 'runEntrypoint.ts'),
    [
      "const target = process.argv[2];",
      "if (!target) throw new Error('missing entrypoint target');",
      "await import(target);",
    ].join('\n'),
    'utf-8',
  );

  writeFileSync(
    join(entrypointDir, 'agentRunBridge.ts'),
    [
      "import { stdin, stdout, env } from 'node:process';",
      "let buffer = '';",
      "stdin.setEncoding('utf8');",
      "function envelope(input, kind, payload) {",
      "  return JSON.stringify({ protocolVersion: input.protocolVersion, sessionId: input.sessionId, correlationId: input.correlationId, timestamp: new Date().toISOString(), kind, payload }) + '\\n';",
      "}",
      "stdin.on('data', chunk => {",
      "  buffer += chunk;",
      "  const lines = buffer.split('\\n');",
      "  buffer = lines.pop() ?? '';",
      "  for (const line of lines) {",
      "    if (!line.trim()) continue;",
      "    const input = JSON.parse(line);",
      "    if (input.kind === 'handshake_request') {",
      "      stdout.write(envelope(input, 'handshake_response', { accepted: true }));",
      "    }",
      "    if (input.kind === 'run_request') {",
      "      stdout.write(envelope(input, 'run_started', { runId: input.payload.runId }));",
      "      stdout.write(envelope(input, 'assistant_text', { text: 'fake aby response' }));",
      "      stdout.write(envelope(input, 'progress', { step: 'fake_aby_progress' }));",
      "      stdout.write(envelope(input, 'tool_request', { toolName: 'Read', input: { path: 'README.md' } }));",
      "      stdout.write(envelope(input, 'tool_response', { toolName: 'Read', output: { found: true } }));",
      "      stdout.write(envelope(input, 'complete', { data: { response: 'fake aby complete', payload: input.payload, envAudit: { safeRunner: env.AGENT_RUN_BRIDGE_RUNNER, unsafePresent: Boolean(env.OPENSLACK_PRIVATE_KEY) } }, tokenUsage: 7 }));",
      "    }",
      "  }",
      "});",
    ].join('\n'),
    'utf-8',
  );

  return abyRoot;
}

describe('Aby process bridge smoke', () => {
  let root: string;

  beforeEach(() => {
    root = makeTempRoot();
  });

  afterEach(() => {
    cleanup(root);
  });

  it('runs a generic run_request through a fake Aby root and records transcript evidence', async () => {
    const abyRoot = createFakeAbyRoot(root);
    mkdirSync(join(root, '.openslack.local'), { recursive: true });
    writeFileSync(
      join(root, '.openslack.local', 'agent-runtime.json'),
      JSON.stringify({
        aby: {
          root: abyRoot,
          command: BUN,
          timeoutMs: 15_000,
          env: {
            AGENT_RUN_BRIDGE_RUNNER: 'fake',
            OPENSLACK_PRIVATE_KEY: 'blocked',
          },
        },
      }),
      'utf-8',
    );

    const store = createRunStore(root);
    const launcher = createOpenSlackAgentLauncher({
      runStore: store,
      rootDir: root,
      availableMcpServers: ['github'],
      bridgeRuntimeResolver: createBridgeRuntimeResolver({ rootDir: root, env: {} }),
    });

    let result;
    try {
      result = await launcher<{
        response: string;
        payload: Record<string, unknown>;
        envAudit: { safeRunner?: string; unsafePresent: boolean };
      }>('inspect README', {
        label: 'anthropic_architect_aby',
        phase: 'conversation',
        resolvedAgentConfig: {
          agentId: 'anthropic_architect_aby',
          source: 'test',
          runtime: 'aby_assistant',
          bridgeMode: 'process',
          permissionMode: 'plan',
          requiredMcpServers: ['github'],
        },
        threadId: 'CONV-20260603-ABCDEFGH',
        correlationId: 'CONV-20260603-ABCDEFGH',
      });
    } catch (error) {
      const stderr = (error as { stderrSummary?: string }).stderrSummary;
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${stderr ?? ''}`);
    }

    expect(result.data.response).toBe('fake aby complete');
    expect(result.data.payload.input).toEqual([{ role: 'user', content: 'inspect README' }]);
    expect(result.data.payload.mcp).toEqual({ required: ['github'], available: ['github'] });
    expect((result.data.payload.metadata as Record<string, unknown>).integrationId).toBe('openslack');
    expect((result.data.payload.metadata as Record<string, unknown>).threadId).toBe('CONV-20260603-ABCDEFGH');
    expect(result.data.envAudit.safeRunner).toBe('fake');
    expect(result.data.envAudit.unsafePresent).toBe(false);

    const transcript = readTranscript(result.runId, root);
    expect(transcript.some((event) => event.type === 'progress' && event.data.step === 'bridge_session_started')).toBe(true);
    expect(transcript.some((event) => event.type === 'progress' && event.data.step === 'bridge_run_started')).toBe(true);
    expect(transcript.some((event) => event.type === 'progress' && event.data.step === 'bridge_assistant_text')).toBe(true);
    expect(transcript.some((event) => event.type === 'tool_call' && event.data.toolName === 'Read')).toBe(true);
    expect(transcript.some((event) => event.type === 'tool_result' && event.data.toolName === 'Read')).toBe(true);
    expect(transcript.some((event) => event.type === 'complete')).toBe(true);

    const run = store.getRun(result.runId);
    expect(run?.status).toBe('completed');
  });
});
