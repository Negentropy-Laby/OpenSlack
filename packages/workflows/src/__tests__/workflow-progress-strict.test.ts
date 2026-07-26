import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getWorkflowRunProgress } from '../workflow-progress.js';

const roots: string[] = [];
const WORKFLOW_RUN_ID = 'RUN-STRICT-WORKFLOW';
const AGENT_RUN_ID = 'RUN-20260726-STRICT01';

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(): { root: string; runDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'openslack-workflow-progress-'));
  roots.push(root);
  const runDir = join(root, '.openslack.local', 'workflows', 'runs', WORKFLOW_RUN_ID);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, 'meta.json'),
    JSON.stringify({
      runId: WORKFLOW_RUN_ID,
      workflowName: 'strict-fixture',
      mode: 'dry-run',
      manifestHash: 'fixture-manifest-hash',
      args: {},
      startedAt: '2026-07-26T00:00:00.000Z',
    }),
  );
  writeFileSync(
    join(runDir, 'status.json'),
    JSON.stringify({
      runId: WORKFLOW_RUN_ID,
      status: 'running',
      updatedAt: '2026-07-26T00:01:00.000Z',
      phases: [],
    }),
  );
  return { root, runDir };
}

function writeValidAgentRun(root: string, tokensRemaining = 9): string {
  const agentDir = join(root, '.openslack.local', 'agents', 'runs', AGENT_RUN_ID);
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, 'run.json'),
    JSON.stringify({
      runId: AGENT_RUN_ID,
      status: 'running',
      agentId: 'strict-agent',
      startedAt: '2026-07-26T00:00:00.000Z',
      tokensUsed: 1,
      tokensRemaining,
      toolCalls: 0,
      transcriptPath: join(agentDir, 'transcript.jsonl'),
    }),
  );
  return agentDir;
}

function writeValidAgentResult(runDir: string): void {
  const resultDir = join(runDir, 'agents');
  mkdirSync(resultDir, { recursive: true });
  writeFileSync(
    join(resultDir, 'strict-agent.json'),
    JSON.stringify({
      runId: AGENT_RUN_ID,
      data: { ok: true },
      workflowEvidence: {
        label: 'strict-agent',
        phase: 'Discover',
        agentRunId: AGENT_RUN_ID,
        promptSummary: 'Inspect evidence.',
        promptHash: 'fixture-prompt-hash',
        startedAt: '2026-07-26T00:00:00.000Z',
        tokenUsage: 1,
      },
    }),
  );
}

async function expectStrictFailure(root: string): Promise<void> {
  await expect(
    getWorkflowRunProgress(WORKFLOW_RUN_ID, {
      rootDir: root,
      loadWorkflowManifest: false,
      loadCostConfig: false,
      strictRead: true,
    }),
  ).rejects.toThrow('WORKFLOW_PROGRESS_LOCAL_EVIDENCE_INVALID');
}

describe('strict workflow progress evidence', () => {
  it('accepts structurally valid bounded run evidence', async () => {
    const { root } = fixtureRoot();

    await expect(
      getWorkflowRunProgress(WORKFLOW_RUN_ID, {
        rootDir: root,
        loadWorkflowManifest: false,
        loadCostConfig: false,
        strictRead: true,
      }),
    ).resolves.toMatchObject({
      runId: WORKFLOW_RUN_ID,
      workflowName: 'strict-fixture',
      status: 'running',
    });
  });

  it('rejects valid JSON with structurally invalid meta and status', async () => {
    const meta = fixtureRoot();
    writeFileSync(join(meta.runDir, 'meta.json'), JSON.stringify({}));
    await expectStrictFailure(meta.root);

    const status = fixtureRoot();
    writeFileSync(
      join(status.runDir, 'status.json'),
      JSON.stringify({
        runId: WORKFLOW_RUN_ID,
        status: 'invented',
        updatedAt: 'not-a-timestamp',
        phases: {},
      }),
    );
    await expectStrictFailure(status.root);

    const nullMeta = fixtureRoot();
    writeFileSync(join(nullMeta.runDir, 'meta.json'), 'null');
    await expectStrictFailure(nullMeta.root);

    const nullStatus = fixtureRoot();
    writeFileSync(join(nullStatus.runDir, 'status.json'), 'null');
    await expectStrictFailure(nullStatus.root);
  });

  it('rejects structurally invalid pending approvals and log entries', async () => {
    const pending = fixtureRoot();
    writeFileSync(join(pending.runDir, 'pending-approvals.json'), JSON.stringify([{}]));
    await expectStrictFailure(pending.root);

    const nullPending = fixtureRoot();
    writeFileSync(join(nullPending.runDir, 'pending-approvals.json'), 'null');
    await expectStrictFailure(nullPending.root);

    const log = fixtureRoot();
    writeFileSync(
      join(log.runDir, 'log.jsonl'),
      `${JSON.stringify({
        ts: 'not-a-timestamp',
        runId: WORKFLOW_RUN_ID,
        message: 42,
      })}\n`,
    );
    await expectStrictFailure(log.root);
  });

  it('rejects structurally invalid agent results, run state, and transcript events', async () => {
    const result = fixtureRoot();
    const invalidResultDir = join(result.runDir, 'agents');
    mkdirSync(invalidResultDir, { recursive: true });
    writeFileSync(join(invalidResultDir, 'invalid.json'), JSON.stringify({}));
    await expectStrictFailure(result.root);

    const nullResult = fixtureRoot();
    const nullResultDir = join(nullResult.runDir, 'agents');
    mkdirSync(nullResultDir, { recursive: true });
    writeFileSync(join(nullResultDir, 'invalid.json'), 'null');
    await expectStrictFailure(nullResult.root);

    const state = fixtureRoot();
    writeValidAgentResult(state.runDir);
    const stateDir = writeValidAgentRun(state.root);
    writeFileSync(
      join(stateDir, 'run.json'),
      JSON.stringify({
        runId: AGENT_RUN_ID,
        status: 'invented',
        agentId: 42,
        startedAt: 'not-a-timestamp',
        tokensUsed: -1,
        tokensRemaining: 'many',
        toolCalls: -1,
        transcriptPath: 42,
      }),
    );
    await expectStrictFailure(state.root);

    const transcript = fixtureRoot();
    writeValidAgentResult(transcript.runDir);
    const transcriptDir = writeValidAgentRun(transcript.root);
    writeFileSync(join(transcriptDir, 'transcript.jsonl'), `${JSON.stringify({})}\n`);
    await expectStrictFailure(transcript.root);
  });

  it('accepts persisted negative over-budget tokensRemaining values', async () => {
    const overBudget = fixtureRoot();
    writeValidAgentResult(overBudget.runDir);
    writeValidAgentRun(overBudget.root, -1);
    await expect(
      getWorkflowRunProgress(WORKFLOW_RUN_ID, {
        rootDir: overBudget.root,
        loadWorkflowManifest: false,
        loadCostConfig: false,
        strictRead: true,
      }),
    ).resolves.toMatchObject({ agentCount: 1 });

    const furtherOverBudget = fixtureRoot();
    writeValidAgentResult(furtherOverBudget.runDir);
    writeValidAgentRun(furtherOverBudget.root, -2);
    await expect(
      getWorkflowRunProgress(WORKFLOW_RUN_ID, {
        rootDir: furtherOverBudget.root,
        loadWorkflowManifest: false,
        loadCostConfig: false,
        strictRead: true,
      }),
    ).resolves.toMatchObject({ agentCount: 1 });
  });
});
