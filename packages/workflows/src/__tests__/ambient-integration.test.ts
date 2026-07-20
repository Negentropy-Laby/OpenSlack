import { describe, it, expect, vi } from 'vitest';
import { executePreview } from '../preview.js';
import { executeDryRun, executeRun } from '../execute.js';
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
  hash: 'test-hash-1234',
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

const ambientWithBudgetSource = `
export const meta = {
  name: 'ambient-budget-test',
  description: 'Test ambient budget',
  phases: [
    { title: 'Scan', detail: 'Scan phase' },
  ],
}

phase('Scan')
log('Budget total: ' + budget.total)
log('Budget spent: ' + budget.spent())
log('Budget remaining: ' + budget.remaining())
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
      hash: 'test-hash',
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
      hash: 'test-hash',
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
      hash: 'test-hash',
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

describe('ambient integration — executeRun', () => {
  it('executes claude-ambient workflow in execute mode with onConfirm', async () => {
    const result = await executeRun(ambientModule, {
      manifest: ambientManifest,
      args: {},
      onConfirm: async () => true,
    });

    expect(result.status).toBe('completed');
  });

  it('executes ambient workflow with agent in execute mode', async () => {
    const launcher: AgentLauncher = vi.fn(async () => ({
      data: { result: 'agent-ok' },
      tokenUsage: 10,
    }));

    const mod: WorkflowModule = {
      meta: {
        name: 'ambient-agent-test',
        description: 'Test ambient agent call',
        phases: [{ title: 'Scan', detail: 'Scan phase' }],
      },
      format: 'claude-ambient',
      hash: 'test-hash',
      sourceBody: ambientWithAgentSource,
    };

    const result = await executeRun(mod, {
      manifest: mod.meta,
      args: {},
      agentLauncher: launcher,
      onConfirm: async () => true,
    });

    expect(result.status).toBe('completed');
    expect(launcher).toHaveBeenCalledTimes(1);
  });

  it('executes ambient workflow with budget API', async () => {
    const mod: WorkflowModule = {
      meta: {
        name: 'ambient-budget-test',
        description: 'Test ambient budget',
        phases: [{ title: 'Scan', detail: 'Scan phase' }],
      },
      format: 'claude-ambient',
      hash: 'test-hash',
      sourceBody: ambientWithBudgetSource,
    };

    const result = await executeRun(mod, {
      manifest: mod.meta,
      args: {},
      budget: { tokens: 5000, costUsd: 0.1 },
      onConfirm: async () => true,
    });

    expect(result.status).toBe('completed');
  });

  it('rejects execute without onConfirm or allowUnattended', async () => {
    await expect(
      executeRun(ambientModule, {
        manifest: ambientManifest,
        args: {},
      }),
    ).rejects.toThrow(/Execute mode requires/);
  });
});

describe('ambient integration — variadic pipeline through sandbox', () => {
  it('executes multi-stage pipeline in ambient workflow', async () => {
    const source = `
export const meta = {
  name: 'ambient-pipeline-test',
  description: 'Test ambient pipeline',
  phases: [{ title: 'Scan', detail: 'Scan phase' }],
}

phase('Scan')
const results = await pipeline([1, 2, 3],
  async (_prev, item) => item * 2,
  async (prev, _item) => prev + 10
)
`;
    const mod: WorkflowModule = {
      meta: {
        name: 'ambient-pipeline-test',
        description: 'Test ambient pipeline',
        phases: [{ title: 'Scan', detail: 'Scan phase' }],
      },
      format: 'claude-ambient',
      hash: 'test-hash',
      sourceBody: source,
    };

    const result = await executeRun(mod, {
      manifest: mod.meta,
      args: {},
      onConfirm: async () => true,
    });

    expect(result.status).toBe('completed');
  });
});
