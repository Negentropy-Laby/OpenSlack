import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorkflowRunnerExecutionDescriptor } from '../workflow-runner-descriptor.js';
import { getEmbeddedBuiltin } from '../embedded-builtins.js';
import {
  createSealedWorkflowRunnerV2SourceLoader,
  createSealedWorkflowRunnerSourceLoader,
  loadWorkflowRunnerV2QualificationWorkerConfig,
  loadWorkflowRunnerWorkerConfig,
  prepareWorkflowRunnerV2BudgetReserveSource,
  createWorkflowRunnerV2ProviderAttemptPort,
  executeWorkflowRunnerV2QualificationJob,
  type WorkflowRunnerV2BudgetAuthorityBoundary,
  WorkflowRunnerV2RuntimeBoundaryUnavailableError,
  WorkflowRunnerWorkerConfigError,
} from '../workflow-runner-worker.js';
import {
  parseWorkflowBudgetAuthorityBytes,
  type WorkflowBudgetAccount,
  type WorkflowBudgetReserveRequest,
} from '../workflow-budget-authority-contract.js';
import { type WorkflowRunnerV2ExecutionDescriptor } from '../workflow-runner-v2-descriptor.js';
import { workflowRunnerV2DescriptorFixture } from './workflow-runner-v2-test-fixture.js';
import { WORKFLOW_RUNNER_CAPABILITIES } from '../workflow-runner-contract.js';
import type { WorkflowRunnerV2ExecutionContext } from '../workflow-runner-v2-session.js';
import type { WorkflowRunnerAuthoritySourceAdapter } from '../workflow-runner-authority-binding-runtime.js';
import type { WorkflowRunnerAuthorityBindingStage } from '../workflow-runner-authority-binding-contract.js';
import { createWorkflowRunnerV2EffectAuthorizationPort } from '../workflow-runner-v2-effect-authorization.js';
import { createWorkflowEffectDecisionAuthority } from '../workflow-effect-approval.js';
import { LocalWorkflowEffectApprovalStore } from '../workflow-effect-approval-store.js';
import {
  WorkflowEffectApprovalPendingError,
  WorkflowEffectReconciliationRequiredError,
} from '../internal/workflow-effect-authorization-contract.js';
import { createWorkflowCheckpointLeaseAuthority } from '../internal/workflow-checkpoint-lease-authority.js';
import { RunStore } from '../run-store.js';
import {
  classifyWorkflowRunnerRunState,
  WorkflowRunnerRunStateError,
} from '../workflow-runner-run-state.js';
import type { WorkflowMeta, WorkflowModule } from '../types.js';

const roots: string[] = [];
const sourceBytes = Buffer.from('this is deliberately not valid JavaScript', 'utf8');
const manifest: WorkflowMeta = {
  name: 'sealed-test',
  version: '1.0.0',
  description: 'Sealed runner worker test.',
  phases: [{ title: 'Run', detail: 'Run once.' }],
  risk: 'low',
};

function shortWindowsPath(path: string): string {
  const output = execFileSync(
    'cmd.exe',
    ['/d', '/c', 'for %I in ("%OPENSLACK_TEST_LONG_PATH%") do @echo %~sI'],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 20_000,
      env: { ...process.env, OPENSLACK_TEST_LONG_PATH: path },
    },
  ).trim();
  const windowsPaths = output.match(/[A-Za-z]:\\[^"\r\n]*/gu);
  return resolve(windowsPaths?.sort((left, right) => right.length - left.length)[0] ?? output);
}

function descriptor(workflowSourceBytes: Uint8Array = sourceBytes, workflowRunId = 'run.worker.1') {
  return createWorkflowRunnerExecutionDescriptor({
    descriptorRef: 'descriptor.worker.1',
    workspaceId: 'workspace.test',
    workflowRunId,
    correlationId: 'correlation.worker.1',
    workflowId: 'sealed-test',
    workflowVersion: '1.0.0',
    workflowSource: 'openslack-project',
    workflowSourceBytes,
    manifest,
    input: {},
    budget: { tokens: 1_000, costUsd: 1 },
    confirmationPolicy: {
      mode: 'unattended-explicit',
      actorId: 'test-actor',
      runId: workflowRunId,
      allowUnattended: true,
      onUnexpectedEffect: 'fail',
    },
    createdAt: '2026-08-04T01:00:00.000Z',
    expiresAt: '2026-08-04T02:00:00.000Z',
  });
}

function v2Descriptor(resumeGeneration: number): WorkflowRunnerV2ExecutionDescriptor {
  return workflowRunnerV2DescriptorFixture({
    descriptorRef: `descriptor.worker.v2.${resumeGeneration}`,
    workspaceId: 'workspace.test',
    workflowRunId: `run.worker.v2.${resumeGeneration}`,
    correlationId: `correlation.worker.v2.${resumeGeneration}`,
    workflowId: 'sealed-test',
    workflowVersion: '1.0.0',
    workflowSource: 'openslack-project',
    workflowSourceBytes: sourceBytes,
    manifest,
    input: {},
    confirmationPolicy: {
      mode: 'unattended-explicit',
      actorId: 'test-actor',
      runId: `run.worker.v2.${resumeGeneration}`,
      allowUnattended: true,
      onUnexpectedEffect: 'fail',
    },
    requiredCapabilities: WORKFLOW_RUNNER_CAPABILITIES,
    authorityRoute: {
      backend: 'ts-local',
      authority: 'typescript',
      routingEpoch: 1,
      authorityBuildHash: 'a'.repeat(64),
    },
    runRevision: 1,
    resumeGeneration,
    budgetPolicy: {
      accountId: 'budget.worker.v2',
      policyHash: 'b'.repeat(64),
      rateNanoUsdPerToken: '10',
      tokenLimit: '1000',
      costLimitNanoUsd: '10000',
      callLimit: '2',
    },
    createdAt: '2026-08-04T01:00:00.000Z',
    expiresAt: '2026-08-04T02:00:00.000Z',
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('GS8-B workflow runner worker', () => {
  it('binds budget E1 to provider/model/run/attempt and independent E account revisions', () => {
    const base = v2Descriptor(0);
    const sealed = {
      ...base,
      runRevision: 9,
      authorityRoute: {
        backend: 'go' as const,
        authority: 'workflow-control' as const,
        routingEpoch: 1,
        authorityBuildHash: 'a'.repeat(64),
      },
    };
    const provider = {
      providerId: 'provider.one',
      modelId: 'model.one',
      providerRunId: 'provider-run.one',
      providerAttempt: '1',
      requestedTokens: '100',
    };
    const prepare = (override: Partial<typeof provider> = {}) =>
      prepareWorkflowRunnerV2BudgetReserveSource({
        descriptor: sealed,
        provider: { ...provider, ...override },
        reservationId: 'reservation.identity.1',
        callId: 'call.identity.1',
        expectedAccountRevision: 2,
        expectedRunRevision: 5,
        callerId: 'workflow-runner-v2',
        requestedAt: '2026-08-22T00:00:00.000Z',
      });
    const exact = prepare();
    const request = parseWorkflowBudgetAuthorityBytes(
      Buffer.from(exact.body, 'utf8'),
    ) as WorkflowBudgetReserveRequest;
    expect(request).toMatchObject({
      providerAttempt: '1',
      accountId: sealed.budgetPolicy.accountId,
      policyHash: sealed.budgetPolicy.policyHash,
      rateNanoUsdPerToken: sealed.budgetPolicy.rateNanoUsdPerToken,
      expectedAccountRevision: 2,
      expectedRunRevision: 5,
    });
    expect(request.expectedRunRevision).not.toBe(sealed.runRevision);
    for (const splice of [
      { providerId: 'provider.two' },
      { modelId: 'model.two' },
      { providerRunId: 'provider-run.two' },
      { providerAttempt: '2' },
    ]) {
      expect(prepare(splice).requestHash).not.toBe(exact.requestHash);
    }
  });

  it('stamps first-resume budget evidence with accepted generation 1 rather than offer generation 0', async () => {
    const base = v2Descriptor(0);
    const sealed = {
      ...base,
      authorityRoute: {
        backend: 'go' as const,
        authority: 'workflow-control' as const,
        routingEpoch: 1,
        authorityBuildHash: 'a'.repeat(64),
      },
    };
    let observedGeneration: number | undefined;
    const stop = new Error('generation captured');
    const context = {
      resumeOffer: { resumeGeneration: 0, payload: { newResumeGeneration: 1 } },
      resumeGeneration: 1,
      async reserveBudget(
        _payload: Readonly<Record<string, unknown>>,
        source?: WorkflowRunnerAuthoritySourceAdapter,
      ) {
        const probe = await source!.probe({
          operation: 'budget_reserve',
        } as WorkflowRunnerAuthorityBindingStage);
        if (
          probe.state !== 'committed' ||
          probe.evidence.schema !== 'openslack.workflow_runner_budget_authority_evidence.v1'
        ) {
          throw new Error('prepared reserve evidence unavailable');
        }
        observedGeneration = probe.evidence.sourceAuthority.expectedResumeGeneration;
        throw stop;
      },
    } as unknown as WorkflowRunnerV2ExecutionContext;
    const account = {
      accountId: sealed.budgetPolicy.accountId,
      policyHash: sealed.budgetPolicy.policyHash,
      accountRevision: 2,
      runRevision: 5,
    } as unknown as WorkflowBudgetAccount;
    const budgetAuthority: WorkflowRunnerV2BudgetAuthorityBoundary = {
      callerId: 'workflow-runner-v2',
      client: {
        async readAccount() {
          return account;
        },
        async mutate() {
          throw new Error('E2 mutation must not run before the generation assertion');
        },
        async pointRead() {
          return null;
        },
      },
      now: () => '2026-08-22T00:00:00.000Z',
    };
    const port = createWorkflowRunnerV2ProviderAttemptPort(sealed, context, budgetAuthority);
    await expect(
      port.reserve({
        providerId: 'provider.one',
        modelId: 'model.one',
        providerRunId: 'provider-run.one',
        providerAttempt: '1',
        requestedTokens: '100',
      }),
    ).rejects.toBe(stop);
    expect(observedGeneration).toBe(1);
  });

  it(
    'executes the bundled v2 effect path and preserves durable replay across outcome response loss',
    async () => {
      for (const responseLost of [false, true]) {
        const secureTemporaryRoot = process.platform === 'win32' ? tmpdir() : '/tmp';
        const workspaceRoot = await mkdtemp(
          join(secureTemporaryRoot, 'openslack-runner-v2-effect-'),
        );
        roots.push(workspaceRoot);
        const suffix = responseLost ? 'lost' : 'accepted';
        const workflowRunId = `run.worker.v2.effect.${suffix}`;
        const current = Date.now();
        const base = v2Descriptor(0);
        const sealed: WorkflowRunnerV2ExecutionDescriptor = {
          ...base,
          descriptorRef: `descriptor.worker.v2.effect.${suffix}`,
          workflowRunId,
          correlationId: `correlation.worker.v2.effect.${suffix}`,
          confirmationPolicy: {
            ...base.confirmationPolicy,
            runId: workflowRunId,
          },
          createdAt: new Date(current - 60_000).toISOString(),
          expiresAt: new Date(current + 60 * 60_000).toISOString(),
        };
        const checkpointAuthority = createWorkflowCheckpointLeaseAuthority({
          workspaceId: sealed.workspaceId,
          jobId: `job.effect.${suffix}`,
          workflowRunId,
          attemptId: `attempt.effect.${suffix}`,
          leaseId: `lease.effect.${suffix}`,
          fencingToken: 1,
          correlationId: sealed.correlationId,
          runnerBuildHash: sealed.authorityRoute.authorityBuildHash,
          workflowSourceHash: sealed.workflowSourceHash,
          manifestHash: sealed.manifestHash,
          inputHash: sealed.inputHash,
        });
        let authorizationCalls = 0;
        let completionCalls = 0;
        const commit = async (
          operation: WorkflowRunnerAuthorityBindingStage['operation'],
          source?: WorkflowRunnerAuthoritySourceAdapter,
        ) => {
          if (!source) throw new Error(`Missing ${operation} source adapter.`);
          const stage = { operation } as WorkflowRunnerAuthorityBindingStage;
          const probe = await source.probe(stage);
          return probe.state === 'committed' ? probe.evidence : source.commit(stage, {} as never);
        };
        const context = {
          signal: new AbortController().signal,
          resumeOffer: null,
          resumeGeneration: 0,
          checkpointAuthority,
          async checkpointCommit(
            _payload: Readonly<Record<string, unknown>>,
            source?: WorkflowRunnerAuthoritySourceAdapter,
          ) {
            await commit('checkpoint_commit', source);
          },
          async reserveBudget() {
            throw new Error('Budget reserve is outside this effect-only execution.');
          },
          async reportBudgetUsage() {
            throw new Error('Budget settlement is outside this effect-only execution.');
          },
          async authorizeEffect(
            _payload: Readonly<Record<string, unknown>>,
            source?: WorkflowRunnerAuthoritySourceAdapter,
          ) {
            authorizationCalls += 1;
            const evidence = await commit('effect_authorize', source);
            expect(evidence.schema).toBe('openslack.workflow_runner_effect_authority_evidence.v1');
            return { payload: { approvalStatus: 'approved' } } as never;
          },
          async reportEffectOutcome(
            payload: Readonly<Record<string, unknown>>,
            source?: WorkflowRunnerAuthoritySourceAdapter,
          ) {
            completionCalls += 1;
            const evidence = await commit('effect_complete', source);
            expect(evidence.schema).toBe('openslack.workflow_runner_effect_completion_evidence.v1');
            if (evidence.schema !== 'openslack.workflow_runner_effect_completion_evidence.v1') {
              throw new Error('Effect completion returned a different authority evidence kind.');
            }
            expect(evidence.status).toBe(payload.status);
            if (responseLost && payload.status === 'executed') {
              throw new Error('simulated effect outcome response loss');
            }
          },
        } as unknown as WorkflowRunnerV2ExecutionContext;

        const seed = await createWorkflowRunnerV2EffectAuthorizationPort({
          workspaceRoot,
          descriptor: sealed,
          context,
        });
        const prepared = await seed.prepare({
          runId: workflowRunId,
          evaluationIndex: 1,
          operation: 'openslack.governance.audit',
          detail: 'bounded audit',
        });
        let approvalId: string | undefined;
        try {
          await seed.authorize(prepared);
        } catch (error) {
          if (error instanceof WorkflowEffectApprovalPendingError) approvalId = error.approvalId;
          else throw error;
        }
        expect(approvalId).toBeDefined();
        const decisionAuthority = createWorkflowEffectDecisionAuthority({
          workspaceId: sealed.workspaceId,
          humanPrincipalIds: ['wsman'],
          capabilities: ['workflow.effect.decide'],
          maxBindingTtlMs: 60_000,
        });
        let decisionNow = new Date().toISOString();
        const approvals = new LocalWorkflowEffectApprovalStore(
          join(workspaceRoot, '.openslack.local', 'workflows', 'effect-approvals'),
          decisionAuthority,
          () => decisionNow,
        );
        const pending = await approvals.read(workflowRunId, approvalId!);
        expect(pending?.status).toBe('pending');
        const binding = decisionAuthority.issueHumanDecisionBinding({
          principalId: 'wsman',
          capability: 'workflow.effect.decide',
          runId: workflowRunId,
          approvalId: approvalId!,
          correlationId: sealed.correlationId,
          approvalExpiresAt: pending!.expiresAt,
          decision: 'approved',
          reasonHash: '5'.repeat(64),
          expiresAt: new Date(
            Math.min(Date.now() + 30_000, Date.parse(pending!.expiresAt) - 1),
          ).toISOString(),
        });
        decisionNow = binding.issuedAt;
        await approvals.decide({
          runId: workflowRunId,
          approvalId: approvalId!,
          expectedRevision: 0,
          decision: 'approved',
          reasonHash: '5'.repeat(64),
          binding,
        });

        const workflow: WorkflowModule = {
          format: 'openslack-native',
          hash: sealed.workflowSourceHash,
          meta: manifest,
          async run(runtime) {
            await runtime.openslack.governance.audit('bounded audit');
            return { status: 'completed' };
          },
        };
        const execution = executeWorkflowRunnerV2QualificationJob(
          workflow,
          sealed,
          context,
          workspaceRoot,
          true,
        );
        if (responseLost) {
          await expect(execution).rejects.toBeInstanceOf(WorkflowEffectReconciliationRequiredError);
        } else {
          await expect(execution).resolves.toMatchObject({
            status: 'completed',
            runId: workflowRunId,
          });
        }
        expect(authorizationCalls).toBe(1);
        expect(completionCalls).toBe(1);
        const runStore = new RunStore({
          baseDir: join(workspaceRoot, '.openslack.local', 'workflows'),
        });
        expect(await runStore.readAuditRecords(workflowRunId)).toHaveLength(1);

        const restarted = await createWorkflowRunnerV2EffectAuthorizationPort({
          workspaceRoot,
          descriptor: sealed,
          context,
        });
        const replayPrepared = await restarted.prepare({
          runId: workflowRunId,
          evaluationIndex: 1,
          operation: 'openslack.governance.audit',
          detail: 'bounded audit',
        });
        await expect(restarted.authorize(replayPrepared)).resolves.toMatchObject({
          disposition: 'replay',
        });
        const crossSpliced = await restarted.prepare({
          runId: workflowRunId,
          evaluationIndex: 1,
          operation: 'openslack.governance.audit',
          detail: 'different audit at the same durable occurrence',
        });
        await expect(restarted.authorize(crossSpliced)).rejects.toBeInstanceOf(
          WorkflowEffectReconciliationRequiredError,
        );
        expect(authorizationCalls).toBe(1);
        expect(await runStore.readAuditRecords(workflowRunId)).toHaveLength(1);
      }
    },
    process.platform === 'win32' ? 120_000 : 20_000,
  );

  it('is default-off and requires a closed valid startup configuration', () => {
    expect(() => loadWorkflowRunnerWorkerConfig({})).toThrow(WorkflowRunnerWorkerConfigError);
    expect(() =>
      loadWorkflowRunnerWorkerConfig({ OPENSLACK_WORKFLOW_RUNNER_ENABLED: 'true' }),
    ).toThrowError(/explicit enablement/u);
  });

  it('keeps v2 qualification default-off and mutually exclusive with v1 execution', () => {
    const workspaceRoot = resolve('workflow-runner-v2-config-workspace');
    const base = {
      OPENSLACK_WORKFLOW_RUNNER_V2_QUALIFICATION_ENABLED: '1',
      OPENSLACK_WORKFLOW_RUNNER_WORKSPACE_ID: 'workspace.v2',
      OPENSLACK_WORKFLOW_RUNNER_WORKSPACE_ROOT: workspaceRoot,
      OPENSLACK_WORKFLOW_RUNNER_DESCRIPTOR_ROOT: join(workspaceRoot, 'descriptors-v2'),
      OPENSLACK_WORKFLOW_RUNNER_BUILD_HASH: 'a'.repeat(64),
    } satisfies NodeJS.ProcessEnv;

    expect(() => loadWorkflowRunnerV2QualificationWorkerConfig({})).toThrowError(/default-off/u);
    expect(loadWorkflowRunnerV2QualificationWorkerConfig(base)).toMatchObject({
      enabled: true,
      mode: 'qualification',
      workspaceId: 'workspace.v2',
      workspaceRoot,
    });
    expect(() =>
      loadWorkflowRunnerV2QualificationWorkerConfig({
        ...base,
        OPENSLACK_WORKFLOW_RUNNER_ENABLED: '1',
      }),
    ).toThrowError(/cannot be enabled together/u);
    expect(() =>
      loadWorkflowRunnerV2QualificationWorkerConfig({
        ...base,
        OPENSLACK_WORKFLOW_EFFECT_SHADOW_ENABLED: '1',
      }),
    ).toThrowError(/cannot configure checkpoint or effect authority boundaries/u);

    const companionToken = 'c'.repeat(48);
    const runtimeEnvironment = {
      WORKFLOW_RUNNER_CONTROL_V2_RUNTIME_DELIVERY_ENABLED: '1',
      OPENSLACK_WORKFLOW_RUNNER_V2_RUNTIME_DELIVERY_ORIGIN: 'http://127.0.0.1:8088',
      OPENSLACK_WORKFLOW_RUNNER_V2_RUNTIME_DELIVERY_BEARER_TOKEN: companionToken,
      OPENSLACK_WORKFLOW_RUNNER_V2_RUNTIME_DELIVERY_BEARER_SHA256: createHash('sha256')
        .update(companionToken, 'utf8')
        .digest('hex'),
      OPENSLACK_WORKFLOW_RUNNER_V2_RUNTIME_DELIVERY_JOURNAL_ROOT: join(
        workspaceRoot,
        '.openslack.local',
        'workflow-runner-v2-authority-bindings',
      ),
      OPENSLACK_WORKFLOW_RUNNER_V2_BUDGET_ORIGIN: 'http://127.0.0.1:8089',
      OPENSLACK_WORKFLOW_RUNNER_V2_BUDGET_BEARER_TOKEN: 'b'.repeat(48),
      OPENSLACK_WORKFLOW_RUNNER_V2_BUDGET_CALLER_ID: 'workflow-runner-v2',
    } satisfies NodeJS.ProcessEnv;
    expect(() =>
      loadWorkflowRunnerV2QualificationWorkerConfig({
        ...base,
        ...runtimeEnvironment,
      }),
    ).toThrowError(/requires the complete Go-authority profile/u);
    expect(() =>
      loadWorkflowRunnerV2QualificationWorkerConfig({
        ...base,
        OPENSLACK_WORKFLOW_RUNNER_V2_RUNTIME_DELIVERY_ORIGIN: 'http://127.0.0.1:8088',
      }),
    ).toThrowError(/must be empty/u);

    const runAuthorityToken = 'r'.repeat(48);
    expect(
      loadWorkflowRunnerV2QualificationWorkerConfig({
        ...base,
        ...runtimeEnvironment,
        OPENSLACK_WORKFLOW_RUNNER_V2_RUN_AUTHORITY_ENABLED: '1',
        OPENSLACK_WORKFLOW_RUNNER_V2_RUN_AUTHORITY_ORIGIN: 'http://127.0.0.1:8082',
        OPENSLACK_WORKFLOW_RUNNER_V2_RUN_AUTHORITY_BEARER_TOKEN: runAuthorityToken,
        OPENSLACK_WORKFLOW_RUNNER_V2_RUN_AUTHORITY_BEARER_SHA256: createHash('sha256')
          .update(runAuthorityToken, 'utf8')
          .digest('hex'),
        OPENSLACK_WORKFLOW_RUNNER_V2_RUN_AUTHORITY_CALLER_ID: 'workflow-runner-v2',
        OPENSLACK_WORKFLOW_RUNNER_V2_RUN_AUTHORITY_BUILD_SHA: 'd'.repeat(64),
      }),
    ).toMatchObject({
      mode: 'go-authority',
      runAuthority: {
        origin: 'http://127.0.0.1:8082',
        callerId: 'workflow-runner-v2',
        expectedBuildHash: 'd'.repeat(64),
      },
    });
    expect(() =>
      loadWorkflowRunnerV2QualificationWorkerConfig({
        ...base,
        OPENSLACK_WORKFLOW_RUNNER_V2_RUN_AUTHORITY_ENABLED: '1',
      }),
    ).toThrowError(/requires the complete runtime-delivery profile/u);
  });

  it('keeps the production canary single-writer boundary distinct from F2 qualification', async () => {
    const tsDescriptor = v2Descriptor(0);
    const goDescriptor: WorkflowRunnerV2ExecutionDescriptor = {
      ...tsDescriptor,
      authorityRoute: {
        backend: 'go',
        authority: 'workflow-control',
        routingEpoch: 17,
        authorityBuildHash: 'd'.repeat(64),
      },
    };
    const workflow = { meta: manifest } as WorkflowModule;
    const context = {} as WorkflowRunnerV2ExecutionContext;

    await expect(
      executeWorkflowRunnerV2QualificationJob(
        workflow,
        tsDescriptor,
        context,
        resolve('.'),
        true,
        undefined,
        undefined,
        'go-authority',
      ),
    ).rejects.toThrowError(/accepts only Go-owned/u);
    await expect(
      executeWorkflowRunnerV2QualificationJob(
        workflow,
        goDescriptor,
        context,
        resolve('.'),
        true,
        undefined,
        undefined,
        'go-authority',
      ),
    ).rejects.toThrowError(/requires the Workflow Control run authority/u);
  });

  it('rejects v2 resume delivery before source preparation in the F1 worker', async () => {
    await expect(
      createSealedWorkflowRunnerV2SourceLoader(resolve('.')).prepare(v2Descriptor(1)),
    ).rejects.toMatchObject({
      code: 'WORKFLOW_RUNNER_V2_RUNTIME_BOUNDARY_UNAVAILABLE',
      name: WorkflowRunnerV2RuntimeBoundaryUnavailableError.name,
    });
  });

  it('confines the checkpoint shadow journal to the canonical local-state root', () => {
    const workspaceRoot = resolve('workflow-runner-config-workspace');
    const base = {
      OPENSLACK_WORKFLOW_RUNNER_ENABLED: '1',
      OPENSLACK_WORKFLOW_RUNNER_WORKSPACE_ID: 'workspace.test',
      OPENSLACK_WORKFLOW_RUNNER_WORKSPACE_ROOT: workspaceRoot,
      OPENSLACK_WORKFLOW_RUNNER_DESCRIPTOR_ROOT: join(workspaceRoot, 'descriptors'),
      OPENSLACK_WORKFLOW_RUNNER_BUILD_HASH: 'a'.repeat(64),
      OPENSLACK_WORKFLOW_CHECKPOINT_SHADOW_ENABLED: '1',
      OPENSLACK_WORKFLOW_CHECKPOINT_SHADOW_ENDPOINT: 'http://127.0.0.1:8085',
      OPENSLACK_WORKFLOW_CHECKPOINT_SHADOW_BEARER_TOKEN: 'b'.repeat(32),
      OPENSLACK_WORKFLOW_CHECKPOINT_SHADOW_CALLER_ID: 'runner.test',
    } satisfies NodeJS.ProcessEnv;

    expect(
      loadWorkflowRunnerWorkerConfig({
        ...base,
        OPENSLACK_WORKFLOW_CHECKPOINT_SHADOW_JOURNAL_ROOT: join(
          workspaceRoot,
          '.openslack.local',
          'checkpoint-shadow',
        ),
      }).checkpointShadow?.journalRoot,
    ).toBe(join(workspaceRoot, '.openslack.local', 'checkpoint-shadow'));

    expect(() =>
      loadWorkflowRunnerWorkerConfig({
        ...base,
        OPENSLACK_WORKFLOW_CHECKPOINT_SHADOW_JOURNAL_ROOT: join(
          workspaceRoot,
          'nested',
          '.openslack.local',
          'checkpoint-shadow',
        ),
      }),
    ).toThrowError(/workspace-local journal/u);
  });

  it('keeps the effect shadow default-off and confines its exact route and journal', () => {
    const workspaceRoot = resolve('workflow-runner-effect-shadow-workspace');
    const base = {
      OPENSLACK_WORKFLOW_RUNNER_ENABLED: '1',
      OPENSLACK_WORKFLOW_RUNNER_WORKSPACE_ID: 'workspace.test',
      OPENSLACK_WORKFLOW_RUNNER_WORKSPACE_ROOT: workspaceRoot,
      OPENSLACK_WORKFLOW_RUNNER_DESCRIPTOR_ROOT: join(workspaceRoot, 'descriptors'),
      OPENSLACK_WORKFLOW_RUNNER_BUILD_HASH: 'a'.repeat(64),
    } satisfies NodeJS.ProcessEnv;
    const enabled = {
      ...base,
      OPENSLACK_WORKFLOW_EFFECT_SHADOW_ENABLED: '1',
      OPENSLACK_WORKFLOW_EFFECT_SHADOW_ENDPOINT:
        'http://127.0.0.1:8084/v1/shadow/workflow-control/effect-events',
      OPENSLACK_WORKFLOW_EFFECT_SHADOW_BEARER_TOKEN: 'b'.repeat(32),
      OPENSLACK_WORKFLOW_EFFECT_SHADOW_CALLER_ID: 'runner.test',
      OPENSLACK_WORKFLOW_EFFECT_SHADOW_JOURNAL_ROOT: join(
        workspaceRoot,
        '.openslack.local',
        'workflow-effect-shadow',
      ),
    } satisfies NodeJS.ProcessEnv;

    expect(loadWorkflowRunnerWorkerConfig(base).effectShadow).toBeUndefined();
    expect(loadWorkflowRunnerWorkerConfig(enabled).effectShadow).toMatchObject({
      endpoint: 'http://127.0.0.1:8084/v1/shadow/workflow-control/effect-events',
      journalRoot: join(workspaceRoot, '.openslack.local', 'workflow-effect-shadow'),
    });
    expect(() =>
      loadWorkflowRunnerWorkerConfig({
        ...base,
        OPENSLACK_WORKFLOW_EFFECT_SHADOW_BEARER_TOKEN: 'b'.repeat(32),
      }),
    ).toThrowError(/Disabled Workflow effect shadow configuration must be empty/u);
    for (const endpoint of [
      'https://127.0.0.1:8084/v1/shadow/workflow-control/effect-events',
      'http://example.com:8084/v1/shadow/workflow-control/effect-events',
      'http://127.0.0.1:8084/v1/shadow/workflow-control/checkpoints',
      'http://user:pass@127.0.0.1:8084/v1/shadow/workflow-control/effect-events',
    ]) {
      expect(() =>
        loadWorkflowRunnerWorkerConfig({
          ...enabled,
          OPENSLACK_WORKFLOW_EFFECT_SHADOW_ENDPOINT: endpoint,
        }),
      ).toThrowError(/exact loopback route/u);
    }
    expect(() =>
      loadWorkflowRunnerWorkerConfig({
        ...enabled,
        OPENSLACK_WORKFLOW_EFFECT_SHADOW_JOURNAL_ROOT: join(workspaceRoot, 'outside-local-state'),
      }),
    ).toThrowError(/workspace-local journal/u);
    for (const journalRoot of [
      join(workspaceRoot, '.openslack.local', 'workflows'),
      join(workspaceRoot, '.openslack.local', 'workflows', 'effect-approvals', 'shadow'),
      join(workspaceRoot, '.openslack.local', 'workflows', 'effect-authority', 'shadow'),
    ]) {
      expect(() =>
        loadWorkflowRunnerWorkerConfig({
          ...enabled,
          OPENSLACK_WORKFLOW_EFFECT_SHADOW_JOURNAL_ROOT: journalRoot,
        }),
      ).toThrowError(/workspace-local journal/u);
    }
  });

  it('reads and hashes the sealed source during prepare without dynamically importing it', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'openslack-runner-worker-'));
    roots.push(workspaceRoot);
    const sourceDirectory = join(workspaceRoot, '.openslack', 'workflows');
    const sourcePath = join(sourceDirectory, 'sealed-test.js');
    await mkdir(sourceDirectory, { recursive: true });
    await writeFile(sourcePath, sourceBytes);

    const loader = createSealedWorkflowRunnerSourceLoader(workspaceRoot);
    const prepared = await loader.prepare(descriptor());

    expect(prepared).toMatchObject({
      path: await realpath(sourcePath),
      bytes: sourceBytes,
    });
  });

  it('accepts a hash-bound reviewed builtin while project catalogs remain self-contained', async () => {
    const workflow = getEmbeddedBuiltin('openslack:builtin/profile-sync');
    expect(workflow).toBeDefined();
    const bytes = await readFile(join(import.meta.dirname, '..', 'builtins', 'profile-sync.ts'));
    const builtinDescriptor = createWorkflowRunnerExecutionDescriptor({
      descriptorRef: 'descriptor.worker.builtin',
      workspaceId: 'workspace.test',
      workflowRunId: 'run.worker.builtin',
      correlationId: 'correlation.worker.builtin',
      workflowId: workflow!.meta.name,
      workflowVersion: workflow!.meta.version ?? '0.0.0',
      workflowSource: 'builtin',
      workflowSourceBytes: bytes,
      manifest: workflow!.meta,
      input: {},
      budget: { tokens: 1_000, costUsd: 1 },
      confirmationPolicy: {
        mode: 'unattended-explicit',
        actorId: 'test-actor',
        runId: 'run.worker.builtin',
        allowUnattended: true,
        onUnexpectedEffect: 'fail',
      },
      createdAt: '2026-08-04T01:00:00.000Z',
      expiresAt: '2026-08-04T02:00:00.000Z',
    });

    await expect(
      createSealedWorkflowRunnerSourceLoader(resolve('.')).prepare(builtinDescriptor),
    ).resolves.toMatchObject({ bytes });
  });

  it('initializes only missing runs, resumes paused states, and rejects automatic replay', () => {
    expect(classifyWorkflowRunnerRunState('run.worker.1', false, null)).toBe('initialize');
    for (const status of ['paused', 'paused_waiting_approval', 'resuming'] as const) {
      expect(classifyWorkflowRunnerRunState('run.worker.1', true, status)).toBe('resume');
    }
    for (const status of ['running', 'completed', 'failed', 'cancelled'] as const) {
      expect(() => classifyWorkflowRunnerRunState('run.worker.1', true, status)).toThrowError(
        WorkflowRunnerRunStateError,
      );
    }
    expect(() => classifyWorkflowRunnerRunState('run.worker.1', true, null)).toThrow(
      /operator recovery/u,
    );
  });

  it('accepts a Windows 8.3 alias for the same non-reparse workflow catalog', async () => {
    if (process.platform !== 'win32') return;
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'openslack-runner-long-worker-root-'));
    roots.push(workspaceRoot);
    const sourceDirectory = join(workspaceRoot, '.openslack', 'workflows');
    await mkdir(sourceDirectory, { recursive: true });
    await writeFile(join(sourceDirectory, 'sealed-test.js'), sourceBytes);
    const shortRoot = shortWindowsPath(workspaceRoot);
    if (shortRoot.toUpperCase() === workspaceRoot.toUpperCase()) return;

    const prepared = await createSealedWorkflowRunnerSourceLoader(shortRoot).prepare(descriptor());
    expect(prepared).toMatchObject({
      path: join(await realpath(workspaceRoot), '.openslack', 'workflows', 'sealed-test.js'),
      bytes: sourceBytes,
    });
  }, 30_000);

  it.each([
    ['static import', 'import value from "./unbound.js";'],
    ['side-effect import', 'import "./unbound.js";'],
    ['type import', 'import type { Value } from "./unbound.js";'],
    ['dynamic import', 'const value = import("./unbound.js");'],
    ['comment-separated dynamic import', 'const value = import/* gap */("./unbound.js");'],
    ['require call', 'const value = require("./unbound.cjs");'],
    ['escaped require call', 'const value = requ\\u0069re("./unbound.cjs");'],
    ['export-from', 'export { value } from "./unbound.js";'],
    ['comment-separated export-from', 'export/* gap */{ value }/* gap */from "./unbound.js";'],
    ['star export-from', 'export * as values from "./unbound.js";'],
    ['template-expression import', 'const value = `${import("./unbound.js")}`;'],
    ['eval import string', 'eval("import(\\\"./unbound.js\\\")");'],
    ['Function import string', 'Function("return import(\\\"./unbound.js\\\")")();'],
    ['eval require string', 'eval("require(\\\"./unbound.cjs\\\")");'],
    ['Node builtin module loader', 'const fs = process.getBuiltinModule("node:fs");'],
    [
      'global Node builtin module loader',
      'const childProcess = globalThis.process.getBuiltinModule("node:child_process");',
    ],
    ['escaped Node builtin module loader', 'const fs = pro\\u0063ess.getBuiltinModule("node:fs");'],
  ])('rejects %s during prepare before lease acceptance', async (_name, source) => {
    const sourceBytes = Buffer.from(source, 'utf8');
    const { loader } = await sealedSourceLoader(sourceBytes);

    await expect(loader.prepare(descriptor(sourceBytes))).rejects.toThrow(
      /may not (?:contain static or dynamic imports|dynamically evaluate|reference (?:Node process or global module-loader surfaces|require)|re-export)/u,
    );
  });

  it('does not mistake comments, string/template bodies, regexes, or import.meta for imports', async () => {
    const inert = Buffer.from(
      [
        '// import value from "./comment.js"; require("./comment.cjs")',
        '/* export { value } from "./comment.js"; */',
        'const quoted = "import(\\\"./string.js\\\") require(\\\"./string.cjs\\\")";',
        'const templated = `export { value } from "./template.js"; import("./template.js")`;',
        'const pattern = /import\\(require\\(export from/gu;',
        'const location = import.meta.url;',
        `export const meta = ${JSON.stringify(manifest)};`,
        'export async function run() { return { status: "completed" }; }',
      ].join('\n'),
      'utf8',
    );
    const { loader, sourcePath } = await sealedSourceLoader(inert);

    await expect(loader.prepare(descriptor(inert))).resolves.toMatchObject({
      path: sourcePath,
      bytes: inert,
    });
  });

  it('rejects an ordinary workflow catalog below an ancestor reparse or symlink', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'openslack-runner-worker-ancestor-'));
    roots.push(parent);
    const target = join(parent, 'target');
    const targetWorkspace = join(target, 'workspace');
    const sourceDirectory = join(targetWorkspace, '.openslack', 'workflows');
    const alias = join(parent, 'alias');
    await mkdir(sourceDirectory, { recursive: true });
    await writeFile(join(sourceDirectory, 'sealed-test.js'), sourceBytes);
    await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');

    const loader = createSealedWorkflowRunnerSourceLoader(join(alias, 'workspace'));
    await expect(loader.prepare(descriptor())).rejects.toThrow(
      /(?:reparse component|canonical and non-symlinked)/u,
    );
  });

  it('rejects a source replacement between prepare and post-receipt load', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'openslack-runner-worker-'));
    roots.push(workspaceRoot);
    const sourceDirectory = join(workspaceRoot, '.openslack', 'workflows');
    const sourcePath = join(sourceDirectory, 'sealed-test.js');
    await mkdir(sourceDirectory, { recursive: true });
    const first = workflowSource(1);
    await writeFile(sourcePath, first);

    const loader = createSealedWorkflowRunnerSourceLoader(workspaceRoot);
    const prepared = await loader.prepare(descriptor(first));
    await writeFile(sourcePath, workflowSource(2));

    await expect(loader.load(descriptor(first), prepared)).rejects.toThrow(
      'changed after lease acceptance',
    );
  });

  it('cache-busts ESM by full source hash across sequential source revisions', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'openslack-runner-worker-'));
    roots.push(workspaceRoot);
    const sourceDirectory = join(workspaceRoot, '.openslack', 'workflows');
    const sourcePath = join(sourceDirectory, 'sealed-test.js');
    await mkdir(sourceDirectory, { recursive: true });
    const loader = createSealedWorkflowRunnerSourceLoader(workspaceRoot);

    const first = workflowSource(1);
    await writeFile(sourcePath, first);
    const firstDescriptor = descriptor(first);
    const firstWorkflow = await loader.load(firstDescriptor, await loader.prepare(firstDescriptor));
    expect(await firstWorkflow.run!({} as never, {})).toMatchObject({ revision: 1 });

    const second = workflowSource(2);
    await writeFile(sourcePath, second);
    const secondDescriptor = descriptor(second);
    const secondWorkflow = await loader.load(
      secondDescriptor,
      await loader.prepare(secondDescriptor),
    );
    expect(await secondWorkflow.run!({} as never, {})).toMatchObject({ revision: 2 });
  }, 15_000);
});

async function sealedSourceLoader(source: Uint8Array) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'openslack-runner-worker-'));
  roots.push(workspaceRoot);
  const sourceDirectory = join(workspaceRoot, '.openslack', 'workflows');
  const sourcePath = join(sourceDirectory, 'sealed-test.js');
  await mkdir(sourceDirectory, { recursive: true });
  await writeFile(sourcePath, source);
  return {
    loader: createSealedWorkflowRunnerSourceLoader(workspaceRoot),
    sourcePath: await realpath(sourcePath),
  };
}

function workflowSource(revision: number): Buffer {
  return Buffer.from(
    `export const meta = ${JSON.stringify(manifest)};\n` +
      `export async function run() { return { status: "completed", revision: ${revision} }; }\n`,
    'utf8',
  );
}
