import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runAbyRuntimeSmoke } from '../index.js';
import { resolveTestBunExecutable } from './test-executable.js';

const BUN = resolveTestBunExecutable();

function makeTempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'agent-runtime-smoke-test-'));
}

function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true });
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
      "import { stdin, stdout } from 'node:process';",
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
      "    if (input.kind === 'handshake_request') stdout.write(envelope(input, 'handshake_response', { accepted: true }));",
      "    if (input.kind === 'run_request') {",
      "      stdout.write(envelope(input, 'run_started', { runId: input.payload.runId }));",
      "      stdout.write(envelope(input, 'assistant_text', { text: 'fake smoke ok' }));",
      "      stdout.write(envelope(input, 'complete', { data: { ok: true }, tokenUsage: 1 }));",
      "    }",
      "  }",
      "});",
    ].join('\n'),
    'utf-8',
  );
  return abyRoot;
}

describe('runAbyRuntimeSmoke', () => {
  let root: string;

  beforeEach(() => {
    root = makeTempRoot();
  });

  afterEach(() => {
    cleanup(root);
  });

  it('short-circuits when doctor fails', async () => {
    const report = await runAbyRuntimeSmoke({
      rootDir: root,
      env: {},
      diagnose: () => ({
        provider: 'aby',
        status: 'FAIL',
        readiness: 'not_configured',
        configSource: 'none',
        configPath: join(root, '.openslack.local', 'agent-runtime.json'),
        args: [],
        env: { allowedKeys: [], rejectedKeys: [] },
        checks: [],
        remediations: ['Set OPENSLACK_ABY_ROOT.'],
        remediation: 'Set OPENSLACK_ABY_ROOT.',
      }),
    });

    expect(report.status).toBe('FAIL');
    expect(report.terminalReason).toBe('doctor_failed');
    expect(report.runId).toBeUndefined();
  });

  it('runs a fake Aby bridge and returns evidence paths', async () => {
    const abyRoot = createFakeAbyRoot(root);
    mkdirSync(join(root, '.openslack.local'), { recursive: true });
    writeFileSync(
      join(root, '.openslack.local', 'agent-runtime.json'),
      JSON.stringify({ aby: { root: abyRoot, command: BUN, timeoutMs: 15_000 } }),
      'utf-8',
    );

    const report = await runAbyRuntimeSmoke({
      rootDir: root,
      env: {},
      agentId: 'anthropic_architect_aby',
    });

    expect(report.status, JSON.stringify(report, null, 2)).toBe('PASS');
    expect(report.runId).toMatch(/^RUN-/);
    expect(report.checks.find((check) => check.name === 'bridge_session_started')?.status).toBe('PASS');
    expect(report.checks.find((check) => check.name === 'terminal_event')?.status).toBe('PASS');
    expect(report.evidence.runJson).toContain('run.json');
    expect(report.evidence.metadataJson).toContain('metadata.json');
    expect(report.evidence.transcriptJsonl).toContain('transcript.jsonl');
  });
});
