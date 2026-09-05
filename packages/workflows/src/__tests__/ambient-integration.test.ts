import { describe, it, expect, vi } from 'vitest';
import { executePreview } from '../preview.js';
import { executeDryRun } from '../execute.js';
import type { WorkflowModule } from '../types.js';
import type { AgentLauncher } from '../agent-shim.js';

const ambientManifest = {
  name: 'ambient-test',
  description: 'Test ambient workflow integration',
  phases: [
    { title: 'Scan', detail: 'Scan phase' },
    { title: 'Verify', detail: 'Verify phase' },
  ],
};

const ambientSource = `
export const meta = {
  name: 'ambient-test',
  description: 'Test ambient workflow integration',
  phases: [
    { title: 'Scan', detail: 'Scan phase' },
    { title: 'Verify', detail: 'Verify phase' },
  ],
}

phase('Scan')
log('Scanning started')
const results = await pipeline([1, 2],
  async (_prev, item) => item * 2,
  async (prev, _item) => prev + 10
)
log('Results: ' + JSON.stringify(results))
`;

const ambientModule: WorkflowModule = {
  meta: ambientManifest,
  format: 'claude-ambient',
  hash: 'a'.repeat(64),
  sourceBody: ambientSource,
};

const ambientWithAgentSource = `
export const meta = {
  name: 'ambient-agent-test',
  description: 'Test ambient agent call',
  phases: [
    { title: 'Scan', detail: 'Scan phase' },
  ],
}

phase('Scan')
const result = await agent('Test prompt', { label: 'test-agent', phase: 'Scan' })
log('Agent result: ' + JSON.stringify(result))
`;

const ambientWithParallelSource = `
export const meta = {
  name: 'ambient-parallel-test',
  description: 'Test ambient parallel',
  phases: [
    { title: 'Scan', detail: 'Scan phase' },
  ],
}

phase('Scan')
const results = await parallel([
  async () => 'a',
  async () => 'b',
])
log('Parallel results: ' + JSON.stringify(results))
`;

describe('ambient integration — executePreview', () => {
  it('executes claude-ambient workflow in preview mode', async () => {
    const result = await executePreview(ambientModule, {
      manifest: ambientManifest,
      args: {},
    });

    expect(result.preview).toBe(true);
    expect(result.workflowName).toBe('ambient-test');
    expect(result.runId).toMatch(/^preview-/);
  });

  it('executes ambient workflow with agent in preview mode', async () => {
    const mod: WorkflowModule = {
      meta: {
        name: 'ambient-agent-test',
        description: 'Test ambient agent call',
        phases: [{ title: 'Scan', detail: 'Scan phase' }],
      },
      format: 'claude-ambient',
      hash: 'a'.repeat(64),
      sourceBody: ambientWithAgentSource,
    };

    const launcher: AgentLauncher = vi.fn(async () => ({
      data: { result: 'ok' },
      tokenUsage: 10,
    }));

    const result = await executePreview(mod, {
      manifest: mod.meta,
      args: {},
      agentLauncher: launcher,
    });

    expect(result.preview).toBe(true);
    expect(launcher).toHaveBeenCalledTimes(1);
  });

  it('executes ambient workflow with parallel in preview mode', async () => {
    const mod: WorkflowModule = {
      meta: {
        name: 'ambient-parallel-test',
        description: 'Test ambient parallel',
        phases: [{ title: 'Scan', detail: 'Scan phase' }],
      },
      format: 'claude-ambient',
      hash: 'a'.repeat(64),
      sourceBody: ambientWithParallelSource,
    };

    const result = await executePreview(mod, {
      manifest: mod.meta,
      args: {},
    });

    expect(result.preview).toBe(true);
  });
});

describe('ambient integration — executeDryRun', () => {
  it('executes claude-ambient workflow in dry-run mode', async () => {
    const result = await executeDryRun(ambientModule, {
      manifest: ambientManifest,
      args: {},
    });

    expect(result.dryRun).toBe(true);
    expect(result.workflowName).toBe('ambient-test');
    expect(result.errors).toEqual([]);
    expect(result.simulatedEffects.length).toBeGreaterThanOrEqual(0);
  });

  it('executes ambient workflow with openslack API in dry-run mode', async () => {
    const mod: WorkflowModule = {
      meta: {
        name: 'ambient-sideeffect-test',
        description: 'Test ambient side effects',
        phases: [{ title: 'Scan', detail: 'Scan phase' }],
        sideEffects: ['openslack.task.createIssue'],
      },
      format: 'claude-ambient',
      hash: 'a'.repeat(64),
      sourceBody: `
export const meta = {
  name: 'ambient-sideeffect-test',
  description: 'Test ambient side effects',
  phases: [{ title: 'Scan', detail: 'Scan phase' }],
  sideEffects: ['openslack.task.createIssue'],
}

phase('Scan')
await openslack.task.createIssue({ title: 'Test' })
`,
    };

    const result = await executeDryRun(mod, {
      manifest: mod.meta,
      args: {},
    });

    expect(result.dryRun).toBe(true);
    expect(result.errors).toEqual([]);
    // Dry-run mode returns placeholder data for side effects
    expect(result.result?.status).toBe('completed');
  });
});
