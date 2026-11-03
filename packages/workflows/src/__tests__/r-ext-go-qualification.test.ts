import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadWorkflowFile } from '../internal/workflow-file-loader.js';
import { assertWorkflowRunnerSourceIsSelfContained } from '../workflow-runner-source-policy.js';
import { checkpointEvidence } from '../internal/workflow-runner-checkpoint-evidence.js';
import { validateWorkflowCheckpointShadowEnvelope } from '../workflow-checkpoint-shadow-contract.js';
import { executeGoAuthorityRun } from '../execute.js';
import { createWorkflowCheckpointLeaseAuthority } from '../internal/workflow-checkpoint-lease-authority.js';
import { bindGoWorkflowResumeIdentity, validateGoWorkflowResumeContext } from '../resume.js';
import { WorkflowRunRouter } from '../workflow-run-routing.js';
import { workflowRunnerV2DescriptorFixture } from './workflow-runner-v2-test-fixture.js';
import {
  workflowControlAuthorityInitialRecord,
  type WorkflowControlAuthorityPort,
} from '../workflow-control-authority-client.js';
import { WorkflowRunnerV2GoProjectionRunStore } from '../workflow-runner-v2-go-projection-store.js';
import { resolveWorkflowRunProjectionRoot } from '../workflow-run-projection.js';
import { RunStore } from '../run-store.js';
import { createWorkflowRunnerV2EffectAuthorizationPort } from '../workflow-runner-v2-effect-authorization.js';
import { WorkflowEffectApprovalPendingError } from '../internal/workflow-effect-authorization-contract.js';
import type { WorkflowRunnerV2ExecutionContext } from '../workflow-runner-v2-session.js';
import { computeAgentCacheKey } from '../agent-shim.js';
import type { AgentOptions } from '../types.js';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const preparation = (name: string) =>
  import(pathToFileURL(join(root, 'scripts/r-ext-go-qualification', `${name}.ts`)).href);
const temporaryRoots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('R-EXT credential-free preparation', () => {
  it('loads a dedicated fixed-identity fixture without running a provider', async () => {
    const workflow = await loadWorkflowFile(
      join(root, '.openslack/workflows/r-ext-go-qualification.mjs'),
    );
    expect(workflow.meta.name).toBe('r-ext-go-qualification');
    expect(workflow.meta.phases.map((phase) => phase.title)).toEqual([
      'FirstCall',
      'Approval',
      'SecondCall',
      'Complete',
    ]);
    expect(workflow.sourceSnapshot).toBeDefined();
    expect(workflow.meta.budgetPolicy?.tokenBudget).toBe(16_384);
    expect(workflow.meta.isolationPolicy).toEqual({ codex_qualification_rext: 'none' });
    expect(await workflow.preview!({ phase() {} } as never, {})).toMatchObject({
      preview: true,
      agentId: 'codex_qualification_rext',
      providerCalls: 0,
    });
  });

  it('passes the actual sealed source-admission policy on the exact fixture bytes', async () => {
    const source = await readFile(join(root, '.openslack/workflows/r-ext-go-qualification.mjs'));
    expect(() => assertWorkflowRunnerSourceIsSelfContained(source)).not.toThrow();
  });

  it('counts failed and unknown attempts, preserves the main-chain slots, and never resets', async () => {
    const { newCampaign, beginAttempt, settleAttempt, validateCampaign } =
      await preparation('campaign');
    let campaign = newCampaign({
      candidate: 'b'.repeat(40),
      runId: 'run.rext.local',
      createdAt: '2026-11-03T09:00:00.000Z',
    });
    campaign = beginAttempt(campaign, 'preflight.1', 'preflight', '2026-11-03T09:00:01.000Z');
    campaign = settleAttempt(campaign, 'preflight.1', {
      outcome: 'failed',
      totalTokens: 1,
      receiptHash: 'a'.repeat(64),
    });
    campaign = beginAttempt(campaign, 'preflight.2', 'preflight', '2026-11-03T09:00:02.000Z');
    campaign = settleAttempt(campaign, 'preflight.2', {
      outcome: 'not_sent',
      totalTokens: 0,
    });
    expect(() =>
      beginAttempt(campaign, 'preflight.3', 'preflight', '2026-11-03T09:00:03.000Z'),
    ).toThrow(/main-chain/);
    campaign = beginAttempt(campaign, 'initial.1', 'initial', '2026-11-03T09:00:04.000Z');
    campaign = settleAttempt(campaign, 'initial.1', { outcome: 'unknown' });
    expect(() => beginAttempt(campaign, 'resume.1', 'resume', '2026-11-03T09:00:05.000Z')).toThrow(
      /reconciliation/,
    );
    expect(validateCampaign(JSON.parse(JSON.stringify(campaign))).attempts).toHaveLength(3);
    expect(() => validateCampaign({ ...campaign, limits: { attempts: 10 } })).toThrow();
  });

  it.each(['purpose', 'outcome'] as const)(
    'rejects persisted array-valued %s instead of coercing it into a budget grant',
    async (field) => {
      const { newCampaign, beginAttempt, settleAttempt, validateCampaign, readCampaignFile } =
        await preparation('campaign');
      const fresh = newCampaign({
        candidate: 'c'.repeat(40),
        runId: 'run.invalid-enum',
        createdAt: '2026-11-03T09:00:00.000Z',
      });
      const started = beginAttempt(fresh, 'initial.1', 'initial', '2026-11-03T09:00:01.000Z');
      const malformed = settleAttempt(started, 'initial.1', {
        outcome: 'reported',
        totalTokens: 0,
        receiptHash: 'a'.repeat(64),
      });
      if (field === 'purpose') malformed.attempts[0].purpose = ['initial'];
      else malformed.attempts[0].settlement.outcome = ['unknown'];
      // JSON serialization preserves the hostile data type; no custom getter
      // or mock parser is needed to reproduce the persisted-input boundary.
      const raw = JSON.stringify(malformed);
      expect(() => validateCampaign(JSON.parse(raw))).toThrow(/Invalid/);
      expect(() =>
        beginAttempt(JSON.parse(raw), 'resume.1', 'resume', '2026-11-03T09:00:02.000Z'),
      ).toThrow();
      const directory = await mkdtemp(join(tmpdir(), 'rext-invalid-enum-'));
      temporaryRoots.push(directory);
      const path = join(directory, 'campaign.json');
      await writeFile(path, raw);
      await expect(readCampaignFile(path)).rejects.toThrow(/Invalid/);
    },
  );

  it('preserves all four counted attempts and measured overage, while rejecting later execution', async () => {
    const { newCampaign, beginAttempt, settleAttempt } = await preparation('campaign');
    let campaign = newCampaign({
      candidate: 'c'.repeat(40),
      runId: 'run.limit',
      createdAt: '2026-11-03T09:00:00.000Z',
    });
    for (const [index, purpose] of ['initial', 'resume', 'preflight', 'preflight'].entries()) {
      const id = `${purpose}.${index}`;
      campaign = beginAttempt(campaign, id, purpose, '2026-11-03T09:00:01.000Z');
      const exceeded = settleAttempt(campaign, id, {
        outcome: 'reported',
        totalTokens: 8193,
        receiptHash: 'a'.repeat(64),
      });
      expect(exceeded.attempts.at(-1).settlement.totalTokens).toBe(8193);
      expect(() =>
        beginAttempt(exceeded, 'after-overage', 'preflight', '2026-11-03T09:00:02.000Z'),
      ).toThrow(/reconciliation/);
      campaign = settleAttempt(campaign, id, {
        outcome: 'reported',
        totalTokens: 8192,
        receiptHash: 'a'.repeat(64),
      });
      expect(() => settleAttempt(campaign, id, { outcome: 'not_sent', totalTokens: 0 })).toThrow();
    }
    expect(campaign.attempts).toHaveLength(4);
    expect(() =>
      beginAttempt(campaign, 'fifth', 'replacement', '2026-11-03T09:00:02.000Z'),
    ).toThrow();
  });

  it('allows a replacement only for an exact confirmed not-sent predecessor', async () => {
    const { newCampaign, beginAttempt, settleAttempt } = await preparation('campaign');
    let campaign = newCampaign({
      candidate: 'e'.repeat(40),
      runId: 'run.replacement',
      createdAt: '2026-11-03T09:00:00.000Z',
    });
    expect(() =>
      beginAttempt(campaign, 'replacement.1', 'replacement', '2026-11-03T09:00:01.000Z'),
    ).toThrow(/not-sent/);
    campaign = beginAttempt(campaign, 'preflight.1', 'preflight', '2026-11-03T09:00:01.000Z');
    campaign = settleAttempt(campaign, 'preflight.1', { outcome: 'not_sent', totalTokens: 0 });
    campaign = beginAttempt(
      campaign,
      'replacement.1',
      'replacement',
      '2026-11-03T09:00:02.000Z',
      'preflight.1',
    );
    expect(campaign.attempts[1].replacementOf).toBe('preflight.1');
  });

  it('never overwrites campaign evidence or treats corrupted evidence as a new allowance', async () => {
    const { newCampaign, createCampaignFile, readCampaignFile } = await preparation('campaign');
    const directory = await mkdtemp(join(tmpdir(), 'rext-campaign-'));
    temporaryRoots.push(directory);
    const path = join(directory, 'campaign.json');
    const campaign = newCampaign({
      candidate: 'd'.repeat(40),
      runId: 'run.files',
      createdAt: '2026-11-03T09:00:00.000Z',
    });
    await createCampaignFile(path, campaign);
    await expect(createCampaignFile(path, campaign)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readCampaignFile(path)).toEqual(campaign);
    await writeFile(path, '{"schema":');
    await expect(readCampaignFile(path)).rejects.toThrow();
    await writeFile(
      path,
      JSON.stringify(campaign).replace(
        '"candidate":',
        '"candidate":"' + '0'.repeat(40) + '","candidate":',
      ),
    );
    await expect(readCampaignFile(path)).rejects.toThrow();
  });

  it('fails before a provider when checkpoint or campaign evidence is missing', async () => {
    const workflow = await loadWorkflowFile(
      join(root, '.openslack/workflows/r-ext-go-qualification.mjs'),
    );
    const agent = vi.fn();
    await expect(
      workflow.run!({ args: { campaignId: 'local' }, agent } as never, {}),
    ).rejects.toThrow(/checkpoint/);
    await expect(workflow.run!({ args: {}, checkpoint: {}, agent } as never, {})).rejects.toThrow(
      /campaignId/,
    );
    expect(agent).not.toHaveBeenCalled();
  });

  it('initializes normally, persists the first call/checkpoint, and naturally pauses before any audit effect', async () => {
    const directory = await mkdtemp(
      join(process.platform === 'win32' ? tmpdir() : '/tmp', 'rext-initial-'),
    );
    temporaryRoots.push(directory);
    const workflowPath = join(root, '.openslack/workflows/r-ext-go-qualification.mjs');
    const workflow = await loadWorkflowFile(workflowPath);
    const sourceBytes = await readFile(workflowPath);
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.parse(createdAt) + 60 * 60_000).toISOString();
    const descriptor = workflowRunnerV2DescriptorFixture({
      workflowSourceBytes: sourceBytes,
      manifest: workflow.meta,
      input: { campaignId: 'campaign.local.normal' },
      budgetPolicy: {
        accountId: 'budget.rext.local',
        policyHash: 'b'.repeat(64),
        rateNanoUsdPerToken: '10',
        tokenLimit: '16384',
        costLimitNanoUsd: '163840',
        callLimit: '2',
      },
      authorityRoute: {
        backend: 'go',
        authority: 'workflow-control',
        routingEpoch: 9,
        authorityBuildHash: 'a'.repeat(64),
      },
      createdAt,
      expiresAt,
    });
    const route = new WorkflowRunRouter({
      schema: 'openslack.workflow_run_routing_policy.v1',
      workspaceId: descriptor.workspaceId,
      backend: 'go',
      routingEpoch: 9,
      authorityBuildHash: 'a'.repeat(64),
      qualificationEnvironmentId: 'rext.local.test',
      workflowAllowlist: [workflow.meta.name],
      runAllowlist: [],
      expiresAt,
    }).select({
      workspaceId: descriptor.workspaceId,
      runId: descriptor.workflowRunId,
      workflowId: descriptor.workflowId,
      workflowVersion: descriptor.workflowVersion,
      workflowSourceHash: descriptor.workflowSourceHash,
      manifestHash: descriptor.manifestHash,
      inputHash: descriptor.inputHash,
      correlationId: descriptor.correlationId,
      selectedAt: createdAt,
    });
    let record = workflowControlAuthorityInitialRecord(route);
    const authority: WorkflowControlAuthorityPort = {
      inspectBinding: vi.fn(),
      accept: vi.fn(),
      async read() {
        return {
          ...record,
          schema: 'openslack.workflow_control_authority_read.v2',
          recordHash: 'f'.repeat(64),
          record,
          updatedAt: createdAt,
        };
      },
      async readIfExists() {
        return this.read(descriptor.workflowRunId, route.route);
      },
      async transition(next, expected) {
        expect(expected).toMatchObject({ revision: record.revision, state: record.state });
        expect(next.revision).toBe(record.revision + 1);
        record = next;
        return {} as never;
      },
    };
    const baseDir = resolveWorkflowRunProjectionRoot(directory, 'go');
    const store = new WorkflowRunnerV2GoProjectionRunStore({ baseDir, descriptor, authority });
    const effects = await createWorkflowRunnerV2EffectAuthorizationPort({
      workspaceRoot: directory,
      descriptor,
      context: { resumeGeneration: 0 } as WorkflowRunnerV2ExecutionContext,
    });
    const checkpointAuthority = createWorkflowCheckpointLeaseAuthority({
      workspaceId: descriptor.workspaceId,
      jobId: 'job.rext.local',
      workflowRunId: descriptor.workflowRunId,
      attemptId: 'attempt.rext.local',
      leaseId: 'lease.rext.local',
      fencingToken: 1,
      correlationId: descriptor.correlationId,
      runnerBuildHash: descriptor.authorityRoute.authorityBuildHash,
      workflowSourceHash: descriptor.workflowSourceHash,
      manifestHash: descriptor.manifestHash,
      inputHash: descriptor.inputHash,
    });
    const launcher = vi.fn(async (_prompt: string, _options: AgentOptions) => ({
      data: { ok: true, stage: 'first' },
      tokenUsage: 7,
    }));
    let pending: WorkflowEffectApprovalPendingError | undefined;
    try {
      await executeGoAuthorityRun(
        bindGoWorkflowResumeIdentity(
          validateGoWorkflowResumeContext(descriptor.workflowRunId, route, descriptor.workspaceId),
          workflow,
          sourceBytes,
        ),
        {
          runId: descriptor.workflowRunId,
          manifest: workflow.meta,
          rootDir: directory,
          args: { campaignId: 'campaign.local.normal' },
          // Deterministic fixture rate, not a real provider pricing claim.
          budget: { tokens: 16_384, costUsd: 0.00016384 },
          allowUnattended: true,
          agentLauncher: launcher,
        },
        store,
        checkpointAuthority,
        effects,
      );
      throw new Error('The normal initial path must wait for exact approval.');
    } catch (error) {
      if (!(error instanceof WorkflowEffectApprovalPendingError)) throw error;
      pending = error;
    }
    expect(launcher).toHaveBeenCalledTimes(1);
    const [prompt, options] = launcher.mock.calls[0]!;
    expect(options).toMatchObject({
      agentType: 'codex_qualification_rext',
      label: 'r-ext:first',
      budget: { tokens: 8192 },
    });
    const reader = new RunStore({ baseDir, access: 'read-only' });
    expect(await reader.loadStatus(descriptor.workflowRunId)).toMatchObject({
      status: 'paused_waiting_approval',
    });
    expect(
      (await reader.loadCheckpointControl(descriptor.workflowRunId))?.checkpoints,
    ).toHaveLength(1);
    expect(await reader.loadBudgetSnapshot(descriptor.workflowRunId)).toMatchObject({
      usage: { agentCalls: 1, tokensUsed: 7 },
    });
    expect(await reader.readAuditRecords(descriptor.workflowRunId)).toHaveLength(0);
    expect(
      await reader.loadAgentResult(
        descriptor.workflowRunId,
        computeAgentCacheKey(workflow.meta.name, options.phase, options.label, prompt),
      ),
    ).toMatchObject({ data: { ok: true, stage: 'first' }, tokenUsage: 7 });
    const { inspectPendingApproval } = await preparation('approval');
    expect(
      await inspectPendingApproval(
        directory,
        descriptor.workflowRunId,
        pending!.approvalId,
        new Date().toISOString(),
      ),
    ).toMatchObject({
      runId: descriptor.workflowRunId,
      approvalId: pending!.approvalId,
      humanDecisionRequired: true,
      executionAllowed: false,
      blocker: '#433',
    });
    // Deliberately stop here: no test decision, seeded status or fake resume
    // obscures the separately reproduced sealed-worker checkpoint replay defect.
  });

  it('takes exactly forty fixed-deadline observations and does not fabricate missed slots', async () => {
    const { observeDrain } = await preparation('observe');
    let now = 0;
    const clock = {
      now: () => now,
      wallNow: () => new Date(Date.parse('2026-11-03T09:00:00.000Z') + now).toISOString(),
      sleep: async (ms: number) => {
        now += ms;
      },
    };
    const good = async () => ({
      admissionClosed: true,
      activeRuns: 0,
      pendingEffects: 0,
      openReservations: 0,
      reconciliationRequired: 0,
      authorityConsistent: true,
    });
    const complete = await observeDrain(good, clock);
    expect(complete.status).toBe('PASS');
    expect(complete.samples).toHaveLength(40);
    expect(complete.samples[0].scheduledOffsetMs).toBe(15_000);
    expect(complete.samples[39].actualOffsetMs).toBe(600_000);
    now = 0;
    let reads = 0;
    const missed = await observeDrain(async () => {
      reads += 1;
      if (reads === 2) now += 30_000;
      return good();
    }, clock);
    expect(missed.status).toBe('FAIL');
    expect(missed.samples.length).toBeLessThan(40);
    expect(missed.samples.some((sample: { valid: boolean }) => !sample.valid)).toBe(true);
  });

  it('rejects a failing authority read, open admission and backwards observation time', async () => {
    const { observeDrain } = await preparation('observe');
    let now = 0;
    let backwards = false;
    const clock = {
      now: () => now,
      wallNow: () =>
        new Date(Date.parse('2026-11-03T09:00:00.000Z') + (backwards ? -1 : now)).toISOString(),
      sleep: async (ms: number) => {
        now += ms;
      },
    };
    const good = {
      admissionClosed: true,
      activeRuns: 0,
      pendingEffects: 0,
      openReservations: 0,
      reconciliationRequired: 0,
      authorityConsistent: true,
    };
    const failedRead = await observeDrain(async () => {
      throw new Error('not archived');
    }, clock);
    expect(failedRead).toMatchObject({
      status: 'FAIL',
      samples: [{ valid: false, reason: 'authority_read_failed' }],
    });
    now = 0;
    expect(
      await observeDrain(async () => ({ ...good, admissionClosed: false }), clock),
    ).toMatchObject({ status: 'FAIL' });
    now = 0;
    const unsafe = await observeDrain(
      async () => ({ ...good, unapprovedPayload: 'must not be archived' }),
      clock,
    );
    expect(unsafe.status).toBe('FAIL');
    expect(JSON.stringify(unsafe)).not.toContain('must not be archived');
    now = 0;
    expect(
      await observeDrain(async () => {
        backwards = true;
        return good;
      }, clock),
    ).toMatchObject({ status: 'FAIL' });
  });

  it('bounds an authority read that never completes and does not fabricate its sample', async () => {
    const { observeDrain } = await preparation('observe');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let now = 0;
    let started = false;
    const clock = {
      now: () => now,
      wallNow: () => new Date(Date.parse('2026-11-03T09:00:00.000Z') + now).toISOString(),
      sleep: async (ms: number) => {
        now += ms;
      },
    };
    const pending = observeDrain(async () => {
      started = true;
      return new Promise<never>(() => {});
    }, clock);
    await Promise.resolve();
    expect(started).toBe(true);
    now += 15_000;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await pending).toMatchObject({
      status: 'FAIL',
      samples: [{ valid: false, reason: 'authority_read_timeout' }],
    });
  });

  it('does not infer live readiness or accept a different candidate in preflight', async () => {
    const { inspectPreparation } = await preparation('preflight');
    await expect(inspectPreparation(root, 'not-a-commit')).rejects.toThrow(/full candidate/);
    await expect(inspectPreparation(root, '0'.repeat(40))).rejects.toThrow(/Candidate changed/);
  });

  it('retains #433 as a reproduced runtime blocker rather than claiming resume passed', async () => {
    const golden = JSON.parse(
      await readFile(
        join(
          root,
          'packages/workflows/contracts/workflow-checkpoint-shadow/v1/golden-vectors.json',
        ),
        'utf8',
      ),
    );
    const initial = golden.vectors.checkpointCommit.value.observation;
    const resumed = golden.vectors.resumeAdvance.value.observation;
    const state = {
      runId: resumed.runId,
      revision: resumed.revision,
      resumeGeneration: resumed.resumeGeneration,
      activeBinding: {
        ...resumed.runner,
        workflowRunId: resumed.runId,
        workflowSourceHash: resumed.workflowSourceHash,
        manifestHash: resumed.manifestHash,
        inputHash: resumed.inputHash,
      },
      checkpoints: [initial.checkpoint],
    };
    const evidence = checkpointEvidence(state as never, resumed.runner.runnerBuildHash, 0);
    expect(() => validateWorkflowCheckpointShadowEnvelope(evidence.envelope)).toThrow(
      'Observation variant is invalid',
    );
    const { preparationStatus } = await preparation('evidence');
    expect(preparationStatus()).toMatchObject({
      fullSealedResume: 'BLOCKED',
      blocker: '#433',
      realProvider: 'NOT_RUN',
    });
  });
});
