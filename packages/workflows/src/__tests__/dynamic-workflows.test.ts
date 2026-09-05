import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  estimateWorkflowAgentCost,
  exportWorkflowSkill,
  generateWorkflowDraft,
  getWorkflowCatalogEntry,
  getWorkflowRunProgress,
  getWorkflowPattern,
  inferWorkflowPatternId,
  listWorkflowCatalog,
  listWorkflowPatterns,
  loadWorkflowCostConfig,
  previewWorkflowDraft,
  readWorkflowPolicy,
  renderWorkflowRunProgress,
  renderWorkflowDraftPreview,
  RunStore,
  saveWorkflow,
  saveWorkflowRunScript,
  WorkflowBudgetExceededError,
  WorkflowBudgetPausedError,
  writeWorkflowPolicy,
} from '../index.js';
import { executeAgentCall } from '../agent-shim.js';
import { AgentRunRestartRequestedError } from '@openslack/agent-runtime';

describe('dynamic workflow pattern registry', () => {
  it('lists Anthropic dynamic workflow patterns', () => {
    const ids = listWorkflowPatterns().map((pattern) => pattern.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'classify-and-act',
        'fanout-synthesize',
        'adversarial-verification',
        'generate-filter',
        'tournament',
        'loop-until-done',
        'model-router',
      ]),
    );
  });

  it('returns a pattern manifest with phases', () => {
    const pattern = getWorkflowPattern('tournament');
    expect(pattern?.phases.length).toBeGreaterThan(0);
    expect(pattern?.requiredCapabilities).toContain('judging');
  });

  it('uses one pattern inference helper for generated drafts and operator recommendations', () => {
    expect(inferWorkflowPatternId('compare three implementation alternatives')).toBe('tournament');
    expect(inferWorkflowPatternId('研究所有 package 边界')).toBe('fanout-synthesize');
  });

  it('lists workflow catalog entries backed by dynamic patterns', () => {
    const ids = listWorkflowCatalog().map((entry) => entry.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'deep-research',
        'codebase-audit',
        'pr-deep-verification',
        'refactor-migration',
      ]),
    );
    expect(getWorkflowCatalogEntry('deep-research')?.requiredEvidence).toContain('citations');
    expect(getWorkflowCatalogEntry('pr-deep-verification')?.requiredEvidence).toContain(
      'file/line references',
    );
  });
});

describe('dynamic workflow drafts and policy', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'openslack-dwp-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('generates and previews a workflow draft', async () => {
    const draft = await generateWorkflowDraft({
      prompt: 'audit every API endpoint',
      pattern: 'fanout-synthesize',
      rootDir: root,
      draftId: 'draft-test',
    });
    expect(existsSync(draft.path)).toBe(true);
    expect(draft.pattern).toBe('fanout-synthesize');

    const preview = await previewWorkflowDraft({ draftIdOrPath: 'draft-test', rootDir: root });
    expect(preview.draft.pattern).toBe('fanout-synthesize');
    expect(preview.draft.createdAt).toBe(draft.createdAt);
    expect(preview.trustRequirement).toBe('untrusted');
    expect(renderWorkflowDraftPreview(preview)).toContain('Budget:');
  });

  it('fails closed for unknown patterns', async () => {
    await expect(
      generateWorkflowDraft({
        prompt: 'audit',
        pattern: 'unknown',
        rootDir: root,
      }),
    ).rejects.toThrow('Unknown workflow pattern');
  });

  it('reads and writes workflow policy', () => {
    expect(readWorkflowPolicy({ rootDir: root }).enabled).toBe(true);
    const disabled = writeWorkflowPolicy({ enabled: false, reason: 'test' }, { rootDir: root });
    expect(disabled.enabled).toBe(false);
    expect(readWorkflowPolicy({ rootDir: root }).reason).toBe('test');
  });

  it('saves and exports generated workflows without run-local evidence', async () => {
    const draft = await generateWorkflowDraft({
      prompt: 'compare implementation strategies',
      pattern: 'tournament',
      rootDir: root,
      draftId: 'draft-save',
    });
    const saved = await saveWorkflow('draft-compare-implementation-strategies', {
      rootDir: root,
      to: 'project',
      sourcePath: draft.path,
    });
    expect(existsSync(saved.path)).toBe(true);

    const exported = await exportWorkflowSkill(saved.workflowName, {
      rootDir: root,
      outDir: 'skills/compare-strategy',
    });
    expect(existsSync(exported.skillPath)).toBe(true);
    const skill = readFileSync(exported.skillPath, 'utf-8');
    expect(skill).toContain('Workflow script:');
    expect(skill).not.toContain('.openslack.local');
  });

  it('saves the workflow source associated with a recorded run', async () => {
    writeWorkflowSource(root, 'test-workflow');
    writeWorkflowRunStatus(root, 'run-save', 'completed');

    const result = await saveWorkflowRunScript('run-save', { rootDir: root, to: 'claude-project' });

    expect(result.sourceRunId).toBe('run-save');
    expect(result.source).toBe('claude-project');
    expect(result.path).toContain(join('.claude', 'workflows'));
    expect(existsSync(result.path)).toBe(true);
  });

  it('builds workflow run progress from phase, agent, transcript, and budget evidence', async () => {
    writeWorkflowSource(root, 'test-workflow');
    writeWorkflowRunStatus(root, 'run-progress', 'running');
    writeFileSync(
      join(root, '.openslack.local', 'workflows', 'runs', 'run-progress', 'status.json'),
      JSON.stringify(
        {
          status: 'running',
          currentPhase: 'Scan',
          updatedAt: '2026-01-01T00:01:00.000Z',
          phases: [
            {
              phase: 'Scan',
              timestamp: '2026-01-01T00:00:30.000Z',
              status: 'completed',
              result: { files: 2 },
            },
          ],
        },
        null,
        2,
      ),
    );
    const agentsDir = join(root, '.openslack.local', 'workflows', 'runs', 'run-progress', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, 'agent-1.json'),
      JSON.stringify(
        {
          data: { finding: 'ok' },
          runId: 'RUN-20260101-ABCDEFGH',
          tokenUsage: 12,
          workflowEvidence: {
            label: 'scan-api',
            phase: 'Scan',
            agentRunId: 'RUN-20260101-ABCDEFGH',
            model: 'cheap',
            isolation: 'none',
            promptSummary: 'scan all api endpoints',
            promptHash: 'abc123',
            startedAt: '2026-01-01T00:00:10.000Z',
            completedAt: '2026-01-01T00:00:20.000Z',
            tokenUsage: 12,
          },
        },
        null,
        2,
      ),
    );
    const agentDir = join(root, '.openslack.local', 'agents', 'runs', 'RUN-20260101-ABCDEFGH');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, 'run.json'),
      JSON.stringify(
        {
          runId: 'RUN-20260101-ABCDEFGH',
          status: 'completed',
          agentId: 'architect',
          model: 'cheap',
          startedAt: '2026-01-01T00:00:10.000Z',
          completedAt: '2026-01-01T00:00:20.000Z',
          tokensUsed: 12,
          tokensRemaining: 88,
          toolCalls: 1,
          transcriptPath: join(agentDir, 'transcript.jsonl'),
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(agentDir, 'transcript.jsonl'),
      [
        JSON.stringify({
          timestamp: '2026-01-01T00:00:10.000Z',
          type: 'start',
          data: { provider: 'local' },
        }),
        JSON.stringify({
          timestamp: '2026-01-01T00:00:11.000Z',
          type: 'tool_call',
          data: { tool: 'read_file', path: 'packages/api.ts' },
        }),
        JSON.stringify({
          timestamp: '2026-01-01T00:00:20.000Z',
          type: 'complete',
          data: { result: { ok: true }, terminalReason: 'completed' },
        }),
      ].join('\n'),
    );

    const progress = await getWorkflowRunProgress('run-progress', { rootDir: root });

    expect(progress?.agentCount).toBe(1);
    expect(progress?.budget.tokensUsed).toBe(12);
    expect(progress?.phases[0].agents[0].recentTools[0].name).toBe('read_file');
    expect(renderWorkflowRunProgress(progress!)).toContain('scan-api');
  });

  it('blocks a matching future agent launch after pending stopAgent', async () => {
    const statusPath = writeWorkflowRunStatus(root, 'run-block-agent', 'running');
    const status = JSON.parse(readFileSync(statusPath, 'utf-8')) as Record<string, unknown>;
    status.pendingAgentControls = [
      {
        action: 'stopAgent',
        timestamp: '2026-01-01T00:00:00.000Z',
        target: {
          runId: 'run-block-agent',
          phase: 'Scan',
          agentRunId: 'RUN-20260101-BLOCKED',
          agentId: 'scan-api',
        },
        status: 'recorded',
        message: 'Pending stop recorded for test.',
      },
    ];
    writeFileSync(statusPath, JSON.stringify(status, null, 2));

    await expect(
      executeAgentCall(
        'scan packages/api.ts',
        {
          label: 'scan-api',
          phase: 'Scan',
        },
        {
          runId: 'run-block-agent',
          mode: 'execute',
          budget: { tokensUsed: 0, tokensRemaining: 100, costUsd: 0, agentCalls: 0 },
          permissions: new Set(),
          cache: {
            async load() {
              return null;
            },
            async save() {},
          },
          launcher: async () => ({ data: { ok: true }, tokenUsage: 1 }),
          log: () => {},
          cacheKey: 'cache-key',
          agentRunId: 'RUN-20260101-BLOCKED',
          rootDir: root,
        },
      ),
    ).rejects.toThrow(/Pending stop recorded/);
  });

  it('loads configured workflow cost rates and leaves unknown rates unknown', async () => {
    writeCostConfig(root);

    const config = await loadWorkflowCostConfig(root);
    const known = estimateWorkflowAgentCost({
      config,
      provider: 'test-provider',
      model: 'test-model',
      tokens: 500_000,
    });
    const unknown = estimateWorkflowAgentCost({
      config,
      provider: 'test-provider',
      model: 'other-model',
      tokens: 500_000,
    });

    expect(known).toMatchObject({
      known: true,
      estimatedUsd: 1,
      source: 'config',
    });
    expect(unknown).toMatchObject({
      known: false,
      source: 'unknown-rate',
    });
  });

  it('records budget threshold warnings with configured cost estimates', async () => {
    writeCostConfig(root);
    const runStore = await initWorkflowRunStore(root, 'run-budget-warning', {
      tokenBudget: 100,
      maxAgents: 4,
      maxConcurrency: 2,
      onExceeded: 'pause',
    });
    const budget = { tokensUsed: 0, tokensRemaining: 100, costUsd: 0, agentCalls: 0 };

    await executeAgentCall(
      'scan api endpoints',
      {
        label: 'scan-api',
        phase: 'Scan',
        model: 'test-model',
      },
      {
        runId: 'run-budget-warning',
        mode: 'execute',
        budget,
        budgetPolicy: { tokenBudget: 100, onExceeded: 'pause' },
        permissions: new Set(),
        cache: {
          async load() {
            return null;
          },
          async save(runId, cacheKey, result) {
            await runStore.saveAgentResult(runId, cacheKey, result);
          },
        },
        launcher: async () => ({ data: { ok: true }, tokenUsage: 80, runId: 'RUN-BUDGET-WARN' }),
        log: () => {},
        cacheKey: 'budget-warning',
        rootDir: root,
        runStore,
        resolvedAgent: {
          agentId: 'scan-api',
          source: 'test',
          provider: 'test-provider',
          model: 'test-model',
        },
      },
    );

    const status = await runStore.loadStatus('run-budget-warning');
    expect(status?.budgetWarnings?.[0]).toMatchObject({
      kind: 'threshold',
      tokensUsed: 80,
      tokenBudget: 100,
      costUsd: 0.00016,
    });
    expect(budget.costUsd).toBe(0.00016);
  });

  it('pauses and creates approval evidence when budget policy is exceeded with pause', async () => {
    const runStore = await initWorkflowRunStore(root, 'run-budget-pause', {
      tokenBudget: 100,
      onExceeded: 'pause',
    });

    await expect(
      executeAgentCall(
        'scan beyond budget',
        {
          label: 'scan-api',
          phase: 'Scan',
        },
        {
          runId: 'run-budget-pause',
          mode: 'execute',
          budget: { tokensUsed: 0, tokensRemaining: 100, costUsd: 0, agentCalls: 0 },
          budgetPolicy: { tokenBudget: 100, onExceeded: 'pause' },
          permissions: new Set(),
          cache: {
            async load() {
              return null;
            },
            async save(runId, cacheKey, result) {
              await runStore.saveAgentResult(runId, cacheKey, result);
            },
          },
          launcher: async () => ({
            data: { ok: true },
            tokenUsage: 101,
            runId: 'RUN-BUDGET-PAUSE',
          }),
          log: () => {},
          cacheKey: 'budget-pause',
          rootDir: root,
          runStore,
        },
      ),
    ).rejects.toBeInstanceOf(WorkflowBudgetPausedError);

    const status = await runStore.loadStatus('run-budget-pause');
    const approvals = await runStore.loadPendingApprovals('run-budget-pause');
    // The agent settlement owns durable usage and approval evidence. The
    // execution boundary performs the status transition after observing the
    // typed pause error, so direct shim calls cannot publish a false pause.
    expect(status?.status).toBe('running');
    expect(approvals[0]).toMatchObject({
      operation: 'workflow.budget.exceeded',
      status: 'pending',
    });
  });

  it('fails closed when budget policy is exceeded with fail', async () => {
    const runStore = await initWorkflowRunStore(root, 'run-budget-fail', {
      tokenBudget: 100,
      onExceeded: 'fail',
    });

    await expect(
      executeAgentCall(
        'scan beyond budget',
        {
          label: 'scan-api',
          phase: 'Scan',
        },
        {
          runId: 'run-budget-fail',
          mode: 'execute',
          budget: { tokensUsed: 0, tokensRemaining: 100, costUsd: 0, agentCalls: 0 },
          budgetPolicy: { tokenBudget: 100, onExceeded: 'fail' },
          permissions: new Set(),
          cache: {
            async load() {
              return null;
            },
            async save(runId, cacheKey, result) {
              await runStore.saveAgentResult(runId, cacheKey, result);
            },
          },
          launcher: async () => ({ data: { ok: true }, tokenUsage: 101, runId: 'RUN-BUDGET-FAIL' }),
          log: () => {},
          cacheKey: 'budget-fail',
          rootDir: root,
          runStore,
        },
      ),
    ).rejects.toBeInstanceOf(WorkflowBudgetExceededError);
  });

  it('rejects before launching an agent when token budget is already exhausted', async () => {
    let launches = 0;

    await expect(
      executeAgentCall(
        'scan after exhausted budget',
        {
          label: 'scan-api',
          phase: 'Scan',
        },
        {
          runId: 'run-budget-prelaunch',
          mode: 'execute',
          budget: { tokensUsed: 100, tokensRemaining: 0, costUsd: 0, agentCalls: 1 },
          budgetPolicy: { tokenBudget: 100, onExceeded: 'fail' },
          permissions: new Set(),
          cache: {
            async load() {
              return null;
            },
            async save() {},
          },
          launcher: async () => {
            launches += 1;
            return { data: { ok: true }, tokenUsage: 1 };
          },
          log: () => {},
          cacheKey: 'budget-prelaunch',
          rootDir: root,
        },
      ),
    ).rejects.toThrow(/Budget exhausted/);

    expect(launches).toBe(0);
  });

  it('restarts an active agent call from persisted replay input', async () => {
    const runStore = await initWorkflowRunStore(root, 'run-replay', {
      tokenBudget: 100,
      onExceeded: 'pause',
    });
    let calls = 0;

    const result = await executeAgentCall(
      'scan packages',
      {
        label: 'scan-api',
        phase: 'Scan',
        agentRunId: 'RUN-REPLAY-ORIGINAL',
      },
      {
        runId: 'run-replay',
        mode: 'execute',
        budget: { tokensUsed: 0, tokensRemaining: 100, costUsd: 0, agentCalls: 0 },
        permissions: new Set(),
        cache: {
          async load() {
            return null;
          },
          async save(runId, cacheKey, value) {
            await runStore.saveAgentResult(runId, cacheKey, value);
          },
        },
        launcher: async () => {
          calls += 1;
          if (calls === 1) {
            throw new AgentRunRestartRequestedError('RUN-REPLAY-ORIGINAL', 'test restart');
          }
          return { data: { ok: true, calls }, tokenUsage: 5, runId: 'RUN-REPLAY-REPLACEMENT' };
        },
        log: () => {},
        cacheKey: 'replay-cache',
        agentRunId: 'RUN-REPLAY-ORIGINAL',
        rootDir: root,
        runStore,
      },
    );

    expect(result).toEqual({ ok: true, calls: 2 });
    expect(calls).toBe(2);
    expect(await runStore.loadAgentReplayInput('run-replay', 'RUN-REPLAY-ORIGINAL')).toMatchObject({
      available: true,
    });
    const cached = (await runStore.loadAgentResult('run-replay', 'replay-cache')) as {
      workflowEvidence?: { agentRunId?: string; replayAvailable?: boolean };
    };
    expect(cached.workflowEvidence).toMatchObject({
      agentRunId: 'RUN-REPLAY-REPLACEMENT',
      replayAvailable: true,
    });
  });

  it('restarts from a replay whose sensitive prompt assignment was redacted before persistence', async () => {
    const runStore = await initWorkflowRunStore(root, 'run-replay-secret', {
      tokenBudget: 100,
      onExceeded: 'pause',
    });
    let calls = 0;

    const result = await executeAgentCall(
      'scan with OPENSLACK_TEST_SECRET=placeholder',
      {
        label: 'scan-api',
        phase: 'Scan',
        agentRunId: 'RUN-REPLAY-SECRET',
      },
      {
        runId: 'run-replay-secret',
        mode: 'execute',
        budget: { tokensUsed: 0, tokensRemaining: 100, costUsd: 0, agentCalls: 0 },
        permissions: new Set(),
        cache: {
          async load() {
            return null;
          },
          async save() {},
        },
        launcher: async () => {
          calls += 1;
          if (calls === 1) {
            throw new AgentRunRestartRequestedError('RUN-REPLAY-SECRET', 'test restart');
          }
          return { data: { ok: true }, tokenUsage: 1 };
        },
        log: () => {},
        cacheKey: 'replay-secret',
        agentRunId: 'RUN-REPLAY-SECRET',
        rootDir: root,
        runStore,
      },
    );

    expect(result).toEqual({ ok: true });
    const replay = await runStore.loadAgentReplayInput('run-replay-secret', 'RUN-REPLAY-SECRET');
    expect(replay).toMatchObject({ available: true });
    if (!replay?.available) throw new Error('Expected replay input to be available');
    expect(replay?.input.prompt).toContain('[redacted-secret-assignment]');
    expect(replay?.input.prompt).not.toContain('OPENSLACK_TEST_SECRET=');
  });
});

function writeWorkflowRunStatus(root: string, runId: string, status: string): string {
  const runDir = join(root, '.openslack.local', 'workflows', 'runs', runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, 'meta.json'),
    JSON.stringify(
      {
        runId,
        workflowName: 'test-workflow',
        mode: 'execute',
        manifestHash: 'a'.repeat(64),
        args: {},
        startedAt: '2026-01-01T00:00:00.000Z',
      },
      null,
      2,
    ),
  );
  const statusPath = join(runDir, 'status.json');
  writeFileSync(
    statusPath,
    JSON.stringify(
      {
        runId,
        status,
        updatedAt: '2026-01-01T00:00:00.000Z',
        phases: [],
      },
      null,
      2,
    ),
  );
  return statusPath;
}

function writeWorkflowSource(root: string, name: string): string {
  const dir = join(root, '.openslack', 'workflows');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.mjs`);
  writeFileSync(
    path,
    `export const meta = {
  name: ${JSON.stringify(name)},
  description: 'Test workflow',
  phases: [{ title: 'Scan', detail: 'Scan evidence' }],
  risk: 'low',
  budgetPolicy: { tokenBudget: 100, maxAgents: 10, maxConcurrency: 2, onExceeded: 'pause' }
}

export async function preview() {
  return { preview: true }
}
`,
    'utf-8',
  );
  return path;
}

function writeCostConfig(root: string): void {
  const dir = join(root, '.openslack', 'workflows');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'cost.yaml'),
    [
      'schema: openslack.workflow_cost.v1',
      'warning_threshold: 0.8',
      'rates:',
      '  - provider: test-provider',
      '    model: test-model',
      '    total_per_1m_tokens_usd: 2',
    ].join('\n'),
    'utf-8',
  );
}

async function initWorkflowRunStore(
  root: string,
  runId: string,
  budgetPolicy: {
    tokenBudget: number;
    maxAgents?: number;
    maxConcurrency?: number;
    onExceeded: 'pause' | 'fail';
  },
): Promise<RunStore> {
  const runStore = new RunStore({ baseDir: join(root, '.openslack.local', 'workflows') });
  await runStore.initRun(runId, {
    runId,
    workflowName: 'test-workflow',
    mode: 'execute',
    manifestHash: 'a'.repeat(64),
    args: {},
    startedAt: '2026-01-01T00:00:00.000Z',
    budget: { tokens: budgetPolicy.tokenBudget, costUsd: 0 },
    budgetPolicy,
  });
  return runStore;
}
