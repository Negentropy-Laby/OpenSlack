import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createBridgeRuntimeResolver,
  createOpenSlackAgentLauncher,
  createRunStore,
  diagnoseAbyRuntime,
} from '../index.js';
import { readTranscript } from '../transcript.js';

const shouldRunRealAbySmoke =
  process.env.OPENSLACK_RUN_REAL_ABY_SMOKE === '1' &&
  typeof process.env.OPENSLACK_ABY_ROOT === 'string' &&
  process.env.OPENSLACK_ABY_ROOT.length > 0;

function makeTempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'real-aby-smoke-test-'));
}

function cleanup(root: string): void {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

describe('real Aby bridge smoke', () => {
  const runIfConfigured = shouldRunRealAbySmoke ? it : it.skip;

  runIfConfigured('executes a read-only anthropic_architect_aby bridge run', async () => {
    const root = makeTempRoot();
    try {
      const report = diagnoseAbyRuntime({
        rootDir: root,
        env: process.env,
      });
      expect(report.status).toBe('PASS');
      expect(report.args.some((arg) => arg.endsWith('agentRunBridge.ts'))).toBe(true);

      const store = createRunStore(root);
      const launcher = createOpenSlackAgentLauncher({
        runStore: store,
        rootDir: root,
        bridgeRuntimeResolver: createBridgeRuntimeResolver({ rootDir: root, env: process.env }),
      });

      const result = await launcher('Summarize the current repository in one short paragraph.', {
        label: 'anthropic_architect_aby',
        phase: 'conversation',
        resolvedAgentConfig: {
          agentId: 'anthropic_architect_aby',
          source: 'manual-real-aby-smoke',
          runtime: 'aby_assistant',
          bridgeMode: 'process',
          permissionMode: 'plan',
        },
        threadId: 'CONV-REAL-ABY-SMOKE',
        correlationId: 'CONV-REAL-ABY-SMOKE',
      });

      const runDir = join(root, '.openslack.local', 'agents', 'runs', result.runId);
      expect(existsSync(join(runDir, 'run.json'))).toBe(true);
      expect(existsSync(join(runDir, 'metadata.json'))).toBe(true);
      expect(existsSync(join(runDir, 'transcript.jsonl'))).toBe(true);

      const run = store.getRun(result.runId);
      expect(run?.status).toBe('completed');
      const transcript = readTranscript(result.runId, root);
      expect(transcript.some((event) => event.type === 'progress' && event.data.step === 'bridge_session_started')).toBe(true);
      expect(transcript.some((event) => event.type === 'complete')).toBe(true);
    } finally {
      cleanup(root);
    }
  });
});
