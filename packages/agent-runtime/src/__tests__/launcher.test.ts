import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createOpenSlackAgentLauncher,
  createRunStore,
  readTranscript,
  requestAgentRunCancellation,
  requestAgentRunRestart,
  AgentRunRestartRequestedError,
  attachProviderUsageEvidence,
  buildProviderUsageReceipt,
  LocalExecutionAdapter,
  getProviderUsageEvidence,
  AgentExecutionFailedError,
  AgentResultSchemaError,
  RuntimeNotConfiguredError,
} from '../index.js';
import type { AdapterExecutionContext, AgentExecutionAdapter } from '../index.js';

function makeTempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'agent-launcher-test-'));
}

function cleanup(root: string) {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

describe('createOpenSlackAgentLauncher', () => {
  let root: string;

  beforeEach(() => {
    root = makeTempRoot();
  });

  afterEach(() => {
    cleanup(root);
  });

  it('fails closed with an auditable terminal run when no provider is configured', async () => {
    const store = createRunStore(root);
    const launcher = createOpenSlackAgentLauncher({ runStore: store, rootDir: root });

    let failure: RuntimeNotConfiguredError | undefined;
    try {
      await launcher('review this code SECRET_PROMPT_SENTINEL', {
        label: 'reviewer',
        phase: 'review',
        isolation: 'worktree',
      });
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeNotConfiguredError);
      failure = error as RuntimeNotConfiguredError;
    }

    expect(failure?.code).toBe('RUNTIME_NOT_CONFIGURED');
    expect(failure?.runId).toMatch(/^RUN-/);
    const runs = store.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      status: 'failed',
      failureCode: 'RUNTIME_NOT_CONFIGURED',
    });
    expect(runs[0]).not.toHaveProperty('worktreePath');
    expect(runs[0].completedAt).toBeDefined();
    expect(readTranscript(runs[0].runId, root)).toEqual([
      expect.objectContaining({
        type: 'fail',
        data: expect.objectContaining({ failureCode: 'RUNTIME_NOT_CONFIGURED' }),
      }),
    ]);
    expect(JSON.stringify(readTranscript(runs[0].runId, root))).not.toContain(
      'SECRET_PROMPT_SENTINEL',
    );
    expect(existsSync(join(root, '.worktrees'))).toBe(false);
  });

  it('records process runtime misconfiguration before creating a worktree', async () => {
    const store = createRunStore(root);
    const launcher = createOpenSlackAgentLauncher({
      runStore: store,
      rootDir: root,
      bridgeRuntimeResolver: {
        resolve() {
          throw new Error('bridge config unavailable');
        },
      },
    });

    await expect(
      launcher('implement the change', {
        label: 'aby-implementer',
        phase: 'execute',
        isolation: 'worktree',
        resolvedAgentConfig: {
          agentId: 'aby-implementer',
          source: 'test',
          runtime: 'aby_assistant',
          runtimeProvider: 'aby',
          bridgeMode: 'process',
        },
      }),
    ).rejects.toMatchObject({ code: 'RUNTIME_MISCONFIGURED' });

    expect(store.listRuns()[0]).toMatchObject({
      status: 'failed',
      failureCode: 'RUNTIME_MISCONFIGURED',
    });
    expect(existsSync(join(root, '.worktrees'))).toBe(false);
  });

  it('does not let missing MCP prerequisites mask a missing execution provider', async () => {
    const store = createRunStore(root);
    const launcher = createOpenSlackAgentLauncher({
      runStore: store,
      rootDir: root,
      availableMcpServers: [],
    });

    await expect(
      launcher('review this', {
        label: 'reviewer',
        phase: 'review',
        resolvedAgentConfig: {
          agentId: 'reviewer',
          source: 'test',
          requiredMcpServers: ['github'],
        },
      }),
    ).rejects.toMatchObject({ code: 'RUNTIME_NOT_CONFIGURED' });

    expect(store.listRuns()).toEqual([
      expect.objectContaining({ failureCode: 'RUNTIME_NOT_CONFIGURED', status: 'failed' }),
    ]);
  });

  it('uses the shared preparation path to audit preflight prerequisite failures', async () => {
    const store = createRunStore(root);
    const launcher = createOpenSlackAgentLauncher({
      runStore: store,
      rootDir: root,
      availableMcpServers: [],
      adapter: new LocalExecutionAdapter(),
    });

    await expect(
      launcher.preflight('review this', {
        label: 'reviewer',
        phase: 'review',
        agentRunId: 'RUN-20260101-PREFLIGHT',
        resolvedAgentConfig: {
          agentId: 'reviewer',
          source: 'test',
          requiredMcpServers: ['github'],
        },
      }),
    ).rejects.toThrow(/Agent unavailable/);

    expect(store.getRun('RUN-20260101-PREFLIGHT')).toMatchObject({
      status: 'failed',
      failureCode: 'PROVIDER_UNAVAILABLE',
    });
  });

  it('persists an allowlisted summary instead of raw provider errors', async () => {
    const store = createRunStore(root);
    const launcher = createOpenSlackAgentLauncher({
      runStore: store,
      rootDir: root,
      bridgeRuntimeResolver: {
        resolve() {
          throw new Error('request failed for https://user:secret@example.test with sk-sensitive');
        },
      },
    });

    await expect(
      launcher('run', {
        label: 'aby',
        phase: 'execute',
        resolvedAgentConfig: {
          agentId: 'aby',
          source: 'test',
          runtimeProvider: 'aby',
        },
      }),
    ).rejects.toMatchObject({ code: 'RUNTIME_MISCONFIGURED' });

    const persisted = JSON.stringify({
      run: store.listRuns()[0],
      transcript: readTranscript(store.listRuns()[0].runId, root),
    });
    expect(persisted).toContain('Agent runtime configuration is invalid');
    expect(persisted).not.toContain('secret');
    expect(persisted).not.toContain('sk-sensitive');
  });

  it('fails closed with a typed safe result when provider execution fails', async () => {
    const canary = 'provider-execution-secret-canary';
    const failures = [
      {
        error: new Error(`upstream failed with ${canary}`),
        code: 'EXECUTION_FAILED',
        summary: 'Agent execution failed. Inspect runtime diagnostics for details.',
      },
      {
        error: new AgentResultSchemaError([`${canary}: forged provider diagnostic`]),
        code: 'PROVIDER_INVALID_RESPONSE',
        summary: 'Agent execution provider returned an invalid response.',
      },
    ] as const;

    for (const [index, providerFailure] of failures.entries()) {
      const caseRoot = join(root, `provider-failure-${index}`);
      const store = createRunStore(caseRoot);
      const launcher = createOpenSlackAgentLauncher({
        runStore: store,
        rootDir: caseRoot,
        adapter: {
          adapterId: 'failing-provider',
          async execute() {
            throw providerFailure.error;
          },
        },
      });

      const failure = await launcher('execute safely', {
        label: 'failing-agent',
        phase: 'execute',
      }).catch((error: unknown) => error);

      expect(failure).toMatchObject({
        code: providerFailure.code,
        runId: expect.stringMatching(/^RUN-/),
        message: providerFailure.summary,
      });
      const run = store.listRuns()[0];
      expect(run).toMatchObject({
        status: 'failed',
        failureCode: providerFailure.code,
        errorSummary: providerFailure.summary,
      });
      const transcript = readTranscript(run.runId, caseRoot);
      const evidence = JSON.stringify({ failure, run, transcript });
      expect(evidence).not.toContain(canary);
      expect(transcript.some((event) => event.type === 'complete')).toBe(false);
    }
  });

  it('preserves bounded operator-safe schema diagnostics without provider payload data', async () => {
    const store = createRunStore(root);
    const required = [
      'runId',
      ...Array.from({ length: 80 }, (_, index) => `requiredQualificationField${index}`),
    ];
    const schema = {
      type: 'object',
      properties: Object.fromEntries(required.map((key) => [key, { type: 'string' }])),
      required,
      additionalProperties: false,
    };
    const launcher = createOpenSlackAgentLauncher({
      runStore: store,
      rootDir: root,
      adapter: {
        adapterId: 'invalid-schema-provider',
        async execute<T>() {
          return {
            data: { 'sk-sensitive-provider-field': 'raw-provider-secret-value' } as T,
          };
        },
      },
    });

    const failure = await launcher('return qualification evidence', {
      label: 'schema-diagnostic',
      phase: 'validate',
      schema,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AgentExecutionFailedError);
    expect(failure).toMatchObject({
      code: 'PROVIDER_INVALID_RESPONSE',
      cause: expect.any(AgentResultSchemaError),
    });
    const summary = (failure as AgentExecutionFailedError).message;
    expect(summary).toContain('root.runId: required property missing');
    expect(summary).toContain('violations; truncated]');
    expect(Buffer.byteLength(summary, 'utf8')).toBeLessThanOrEqual(1024);
    expect(summary).not.toContain('sk-sensitive-provider-field');
    expect(summary).not.toContain('raw-provider-secret-value');

    const run = store.listRuns()[0];
    expect(run.errorSummary).toBe(summary);
    const evidence = JSON.stringify({ run, transcript: readTranscript(run.runId, root) });
    expect(evidence).toContain('root.runId: required property missing');
    expect(evidence).not.toContain('sk-sensitive-provider-field');
    expect(evidence).not.toContain('raw-provider-secret-value');
  });

  it('preserves charged usage receipts across the safe launcher failure wrapper', async () => {
    const store = createRunStore(root);
    const launcher = createOpenSlackAgentLauncher({
      runStore: store,
      rootDir: root,
      adapter: {
        adapterId: 'usage-reporting-provider',
        async execute(context) {
          const receipt = buildProviderUsageReceipt({
            providerId: 'openai-compatible',
            modelId: 'qualification-model',
            runId: context.runId,
            attempt: 1,
            status: 'reported',
            usage: { totalTokens: 5 },
            outcome: 'provider_response_accepted',
            requestBytes: 'raw request stays hash-only',
            outcomeBytes: 'raw response stays hash-only',
          });
          context.recorder.chargeUsage(context.runId, 5);
          const error = new Error('provider result failed downstream validation');
          attachProviderUsageEvidence(error, [receipt]);
          throw error;
        },
      },
    });

    let failure: unknown;
    try {
      await launcher('execute safely', { label: 'usage-agent', phase: 'execute' });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ code: 'EXECUTION_FAILED' });
    expect((failure as { tokenUsage?: unknown }).tokenUsage).toBe(5);
    expect(getProviderUsageEvidence(failure)).toHaveLength(1);
    expect(getProviderUsageEvidence(failure)[0]?.totalTokens).toBe('5');
    expect(Object.keys(failure as object)).not.toContain('usageEvidence');
    expect(Object.keys(failure as object)).not.toContain('tokenUsage');
    expect(store.listRuns()[0]).toMatchObject({ tokensUsed: 5 });
  });

  it('keeps a successful adapter result when optional usage evidence is malformed', async () => {
    const store = createRunStore(root);
    const launcher = createOpenSlackAgentLauncher({
      runStore: store,
      rootDir: root,
      adapter: {
        adapterId: 'malformed-success-evidence',
        async execute<T>(context: AdapterExecutionContext) {
          context.recorder.chargeUsage(context.runId, 4);
          return {
            data: { ok: true } as T,
            tokenUsage: 4,
            tokenUsageRecorded: true,
            usageEvidence: [{ schema: 'not-a-provider-receipt' }] as never,
          };
        },
      },
    });

    const result = await launcher<{ ok: boolean }>('execute safely', {
      label: 'usage-agent',
      phase: 'execute',
    });

    expect(result).toMatchObject({ data: { ok: true }, tokenUsage: 4 });
    expect(result.usageEvidence).toBeUndefined();
    expect(store.getRun(result.runId)).toMatchObject({ status: 'completed', tokensUsed: 4 });
    expect(readTranscript(result.runId, root)).toContainEqual(
      expect.objectContaining({
        type: 'progress',
        data: { step: 'provider_usage_evidence_invalid', source: 'adapter_result' },
      }),
    );
  });

  it('reserves and settles an Aby process attempt around its reported bridge usage', async () => {
    const store = createRunStore(root);
    const ordering: string[] = [];
    const settled: Array<{ reservationId: string; totalTokens: string | null }> = [];
    const launcher = createOpenSlackAgentLauncher({
      runStore: store,
      rootDir: root,
      bridgeMode: 'process',
      providerAttemptPort: {
        async reserve(input) {
          ordering.push('reserve');
          expect(input).toMatchObject({
            providerId: 'aby',
            modelId: 'default',
            providerAttempt: '1',
            requestedTokens: '128',
          });
          return {
            reservationId: 'reservation.aby.1',
            callId: 'call.aby.1',
            authorizedTokens: input.requestedTokens,
          };
        },
        async settle(reservation, usage) {
          ordering.push('settle');
          settled.push({
            reservationId: reservation.reservationId,
            totalTokens: usage.totalTokens,
          });
        },
      },
      adapter: {
        adapterId: 'aby-process-test',
        async execute<T>() {
          ordering.push('execute');
          return { data: { ok: true } as T, tokenUsage: 17 };
        },
      },
    });

    const result = await launcher<{ ok: boolean }>('run through Aby', {
      label: 'aby-agent',
      phase: 'execute',
      budget: { tokens: 128 },
      resolvedAgentConfig: {
        agentId: 'aby-agent',
        source: 'test',
        runtimeProvider: 'aby',
      },
    });

    expect(ordering).toEqual(['reserve', 'execute', 'settle']);
    expect(settled).toEqual([{ reservationId: 'reservation.aby.1', totalTokens: '17' }]);
    expect(result.usageEvidence).toEqual([
      expect.objectContaining({
        schema: 'openslack.provider_usage_receipt.v1',
        status: 'reported',
        outcome: 'provider_response_accepted',
        attempt: '1',
        totalTokens: '17',
      }),
    ]);
    expect(store.getRun(result.runId)).toMatchObject({ status: 'completed', tokensUsed: 17 });
  });

  it('settles an Aby process failure as unreported before propagating it', async () => {
    const store = createRunStore(root);
    const ordering: string[] = [];
    const launcher = createOpenSlackAgentLauncher({
      runStore: store,
      rootDir: root,
      bridgeMode: 'process',
      providerAttemptPort: {
        async reserve(input) {
          ordering.push('reserve');
          return {
            reservationId: 'reservation.aby.failure',
            callId: 'call.aby.failure',
            authorizedTokens: input.requestedTokens,
          };
        },
        async settle(_reservation, usage) {
          ordering.push(`settle:${usage.status}:${usage.outcome}`);
        },
      },
      adapter: {
        adapterId: 'aby-process-failure-test',
        async execute() {
          ordering.push('execute');
          throw new Error('bridge failed');
        },
      },
    });

    const failure = await launcher('run through Aby', {
      label: 'aby-agent',
      phase: 'execute',
      budget: { tokens: 64 },
      resolvedAgentConfig: {
        agentId: 'aby-agent',
        source: 'test',
        runtimeProvider: 'aby',
      },
    }).catch((error: unknown) => error);

    expect(ordering).toEqual(['reserve', 'execute', 'settle:unreported:provider_attempt_failed']);
    expect(failure).toMatchObject({ code: 'EXECUTION_FAILED' });
    expect(getProviderUsageEvidence(failure)).toEqual([
      expect.objectContaining({
        status: 'unreported',
        outcome: 'provider_attempt_failed',
        totalTokens: null,
      }),
    ]);
  });

  it('does not execute or settle an Aby process attempt when reserve fails', async () => {
    const store = createRunStore(root);
    const ordering: string[] = [];
    const launcher = createOpenSlackAgentLauncher({
      runStore: store,
      rootDir: root,
      bridgeMode: 'process',
      providerAttemptPort: {
        async reserve() {
          ordering.push('reserve');
          throw new Error('reserve unavailable');
        },
        async settle() {
          ordering.push('settle');
        },
      },
      adapter: {
        adapterId: 'aby-process-reserve-failure-test',
        async execute<T>() {
          ordering.push('execute');
          return { data: { ok: true } as T };
        },
      },
    });

    const failure = await launcher('run through Aby', {
      label: 'aby-agent',
      phase: 'execute',
      budget: { tokens: 64 },
      resolvedAgentConfig: {
        agentId: 'aby-agent',
        source: 'test',
        runtimeProvider: 'aby',
      },
    }).catch((error: unknown) => error);

    expect(ordering).toEqual(['reserve']);
    expect(failure).toMatchObject({ code: 'EXECUTION_FAILED' });
    expect(readTranscript(store.listRuns()[0]!.runId, root)).toContainEqual(
      expect.objectContaining({
        type: 'progress',
        data: expect.objectContaining({ step: 'provider_attempt_reserve_failed' }),
      }),
    );
  });

  it('fails closed with wrapper evidence when Aby attempt settlement fails', async () => {
    const store = createRunStore(root);
    const ordering: string[] = [];
    const launcher = createOpenSlackAgentLauncher({
      runStore: store,
      rootDir: root,
      bridgeMode: 'process',
      providerAttemptPort: {
        async reserve(input) {
          ordering.push('reserve');
          return {
            reservationId: 'reservation.aby.settle-failure',
            callId: 'call.aby.settle-failure',
            authorizedTokens: input.requestedTokens,
          };
        },
        async settle() {
          ordering.push('settle');
          throw new Error('settlement unavailable');
        },
      },
      adapter: {
        adapterId: 'aby-process-settle-failure-test',
        async execute<T>() {
          ordering.push('execute');
          return { data: { ok: true } as T, tokenUsage: 11 };
        },
      },
    });

    const failure = await launcher('run through Aby', {
      label: 'aby-agent',
      phase: 'execute',
      budget: { tokens: 64 },
      resolvedAgentConfig: {
        agentId: 'aby-agent',
        source: 'test',
        runtimeProvider: 'aby',
      },
    }).catch((error: unknown) => error);

    expect(ordering).toEqual(['reserve', 'execute', 'settle']);
    expect(failure).toMatchObject({ code: 'EXECUTION_FAILED' });
    expect(getProviderUsageEvidence(failure)).toEqual([
      expect.objectContaining({
        status: 'reported',
        outcome: 'provider_response_accepted',
        totalTokens: '11',
      }),
    ]);
  });

  it('settles a malformed Aby reservation as unreported without executing the bridge', async () => {
    const store = createRunStore(root);
    const ordering: string[] = [];
    const launcher = createOpenSlackAgentLauncher({
      runStore: store,
      rootDir: root,
      bridgeMode: 'process',
      providerAttemptPort: {
        async reserve(input) {
          ordering.push('reserve');
          return {
            reservationId: 'invalid reservation id',
            callId: 'call.aby.invalid',
            authorizedTokens: input.requestedTokens,
          };
        },
        async settle(_reservation, usage) {
          ordering.push(`settle:${usage.status}`);
        },
      },
      adapter: {
        adapterId: 'aby-process-invalid-reservation-test',
        async execute<T>() {
          ordering.push('execute');
          return { data: { ok: true } as T };
        },
      },
    });

    const failure = await launcher('run through Aby', {
      label: 'aby-agent',
      phase: 'execute',
      budget: { tokens: 64 },
      resolvedAgentConfig: {
        agentId: 'aby-agent',
        source: 'test',
        runtimeProvider: 'aby',
      },
    }).catch((error: unknown) => error);

    expect(ordering).toEqual(['reserve', 'settle:unreported']);
    expect(failure).toMatchObject({ code: 'RUNTIME_MISCONFIGURED' });
    expect(getProviderUsageEvidence(failure)).toEqual([
      expect.objectContaining({ status: 'unreported', outcome: 'provider_attempt_failed' }),
    ]);
  });

  it('rejects partial Aby authorization and settles it before bridge execution', async () => {
    const store = createRunStore(root);
    const ordering: string[] = [];
    const launcher = createOpenSlackAgentLauncher({
      runStore: store,
      rootDir: root,
      bridgeMode: 'process',
      providerAttemptPort: {
        async reserve() {
          ordering.push('reserve');
          return {
            reservationId: 'reservation.aby.partial',
            callId: 'call.aby.partial',
            authorizedTokens: '63',
          };
        },
        async settle(_reservation, usage) {
          ordering.push(`settle:${usage.status}`);
        },
      },
      adapter: {
        adapterId: 'aby-process-partial-authorization-test',
        async execute<T>() {
          ordering.push('execute');
          return { data: { ok: true } as T };
        },
      },
    });

    const failure = await launcher('run through Aby', {
      label: 'aby-agent',
      phase: 'execute',
      budget: { tokens: 64 },
      resolvedAgentConfig: {
        agentId: 'aby-agent',
        source: 'test',
        runtimeProvider: 'aby',
      },
    }).catch((error: unknown) => error);

    expect(ordering).toEqual(['reserve', 'settle:unreported']);
    expect(failure).toMatchObject({ code: 'RUNTIME_MISCONFIGURED' });
  });

  it('keeps launcher-minted Aby usage evidence authoritative over adapter evidence', async () => {
    const store = createRunStore(root);
    const launcher = createOpenSlackAgentLauncher({
      runStore: store,
      rootDir: root,
      bridgeMode: 'process',
      providerAttemptPort: {
        async reserve(input) {
          return {
            reservationId: 'reservation.aby.authoritative',
            callId: 'call.aby.authoritative',
            authorizedTokens: input.requestedTokens,
          };
        },
        async settle() {},
      },
      adapter: {
        adapterId: 'aby-process-adapter-evidence-test',
        async execute<T>(context: AdapterExecutionContext) {
          return {
            data: { ok: true } as T,
            tokenUsage: 17,
            usageEvidence: [
              buildProviderUsageReceipt({
                providerId: 'aby',
                modelId: 'default',
                runId: context.runId,
                attempt: 99,
                status: 'reported',
                usage: { totalTokens: 3 },
                outcome: 'provider_response_accepted',
                requestBytes: 'adapter request',
                outcomeBytes: 'adapter response',
              }),
            ],
          };
        },
      },
    });

    const result = await launcher<{ ok: boolean }>('run through Aby', {
      label: 'aby-agent',
      phase: 'execute',
      budget: { tokens: 64 },
      resolvedAgentConfig: {
        agentId: 'aby-agent',
        source: 'test',
        runtimeProvider: 'aby',
      },
    });

    expect(result.usageEvidence).toEqual([
      expect.objectContaining({ attempt: '1', totalTokens: '17' }),
    ]);
  });

  it('terminates runs without masking hostile thrown errors or malformed evidence', async () => {
    const hostileErrors = (() => {
      const frozen = new Error('frozen provider failure');
      Object.defineProperty(frozen, 'usageEvidence', {
        value: [{ schema: 'invalid-frozen-evidence' }],
        configurable: true,
      });
      const nonExtensible = new Error('non-extensible provider failure');
      Object.defineProperty(nonExtensible, 'usageEvidence', {
        value: [{ schema: 'invalid-non-extensible-evidence' }],
        configurable: true,
      });
      const proxiedTarget = new Error('proxied provider failure');
      Object.defineProperty(proxiedTarget, 'usageEvidence', {
        value: [{ schema: 'invalid-proxy-evidence' }],
        configurable: true,
      });
      return [
        Object.freeze(frozen),
        Object.preventExtensions(nonExtensible),
        new Proxy(proxiedTarget, {
          defineProperty() {
            throw new Error('defineProperty trap must not escape');
          },
          getPrototypeOf() {
            throw new Error('getPrototypeOf trap must not escape');
          },
        }),
      ];
    })();

    for (const hostile of hostileErrors) {
      const store = createRunStore(root);
      const launcher = createOpenSlackAgentLauncher({
        runStore: store,
        rootDir: root,
        adapter: {
          adapterId: 'hostile-error-evidence',
          async execute(context) {
            context.recorder.chargeUsage(context.runId, 3);
            throw hostile;
          },
        },
      });
      let failure: unknown;
      try {
        await launcher('execute safely', { label: 'usage-agent', phase: 'execute' });
      } catch (error) {
        failure = error;
      }

      expect(failure).toMatchObject({ code: 'EXECUTION_FAILED', tokenUsage: 3 });
      const runId = (failure as { runId: string }).runId;
      expect(store.getRun(runId)).toMatchObject({ status: 'failed', tokensUsed: 3 });
      expect(readTranscript(runId, root)).toContainEqual(
        expect.objectContaining({
          type: 'progress',
          data: { step: 'provider_usage_evidence_invalid', source: 'thrown_error' },
        }),
      );
    }
  });

  it('creates a run record', async () => {
    const store = createRunStore(root);
    const launcher = createOpenSlackAgentLauncher({
      runStore: store,
      rootDir: root,
      adapter: new LocalExecutionAdapter(),
    });

    await launcher('research something', {
      label: 'researcher',
      phase: 'research',
      agentType: 'research-agent',
      resolvedAgentConfig: {
        agentId: 'research-agent',
        source: 'claude-project',
        model: 'sonnet',
        permissionMode: 'plan',
      },
    });

    const runs = store.listRuns();
    expect(runs.length).toBe(1);
    expect(runs[0].agentId).toBe('research-agent');
    expect(runs[0].status).toBe('completed');
    expect(runs[0].model).toBe('sonnet');
  });

  it('cancels a live adapter run through the runtime control registry', async () => {
    const store = createRunStore(root);
    let activeRunId: string | undefined;
    const adapter: AgentExecutionAdapter = {
      adapterId: 'blocking-test',
      async execute<T>(context: AdapterExecutionContext) {
        activeRunId = context.runId;
        await new Promise((_resolve, reject) => {
          context.signal?.addEventListener(
            'abort',
            () => {
              reject(context.signal?.reason ?? new Error('cancelled'));
            },
            { once: true },
          );
        });
        return { data: { ok: true } as T };
      },
    };
    const launcher = createOpenSlackAgentLauncher({ runStore: store, rootDir: root, adapter });

    const runPromise = launcher('wait until cancelled', {
      label: 'blocked-agent',
      phase: 'execute',
      resolvedAgentConfig: {
        agentId: 'blocked-agent',
        source: 'test',
        permissionMode: 'plan',
      },
    });

    while (!activeRunId) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    const cancel = requestAgentRunCancellation(activeRunId, 'test requested stopAgent');

    expect(cancel.status).toBe('cancelled');
    await expect(runPromise).rejects.toThrow(/cancelled|test requested stopAgent/);
    expect(store.getRun(activeRunId)?.status).toBe('cancelled');
    expect(readTranscript(activeRunId, root).at(-1)?.type).toBe('cancel');
  });

  it('requests restart for a live adapter run through the runtime control registry', async () => {
    const store = createRunStore(root);
    let activeRunId: string | undefined;
    const adapter: AgentExecutionAdapter = {
      adapterId: 'restart-blocking-test',
      async execute<T>(context: AdapterExecutionContext) {
        activeRunId = context.runId;
        await new Promise((_resolve, reject) => {
          context.signal?.addEventListener(
            'abort',
            () => {
              reject(context.signal?.reason ?? new Error('restart requested'));
            },
            { once: true },
          );
        });
        return { data: { ok: true } as T };
      },
    };
    const launcher = createOpenSlackAgentLauncher({ runStore: store, rootDir: root, adapter });

    const runPromise = launcher('wait until restart', {
      label: 'restart-agent',
      phase: 'execute',
      resolvedAgentConfig: {
        agentId: 'restart-agent',
        source: 'test',
        permissionMode: 'plan',
      },
    });

    while (!activeRunId) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    const restart = requestAgentRunRestart(activeRunId, 'test requested restartAgent');

    expect(restart.status).toBe('restart_requested');
    await expect(runPromise).rejects.toBeInstanceOf(AgentRunRestartRequestedError);
    expect(store.getRun(activeRunId)?.status).toBe('cancelled');
    const transcript = readTranscript(activeRunId, root);
    expect(
      transcript.some(
        (entry) =>
          entry.type === 'progress' &&
          (entry.data as Record<string, unknown>).step === 'agent_restart_requested',
      ),
    ).toBe(true);
    expect(
      transcript.some(
        (entry) =>
          entry.type === 'progress' &&
          (entry.data as Record<string, unknown>).step === 'agent_restart_handoff',
      ),
    ).toBe(true);
  });

  it('writes transcript events', async () => {
    const store = createRunStore(root);
    const launcher = createOpenSlackAgentLauncher({
      runStore: store,
      rootDir: root,
      adapter: new LocalExecutionAdapter(),
    });

    await launcher('plan this feature', {
      label: 'planner',
      phase: 'plan',
      resolvedAgentConfig: {
        agentId: 'planner',
        source: 'claude-project',
        permissionMode: 'plan',
      },
    });

    const run = store.listRuns()[0];
    const { readTranscript } = await import('../transcript.js');
    const transcript = readTranscript(run.runId, root);

    expect(transcript.length).toBeGreaterThan(0);
    expect(transcript[0].type).toBe('start');
    expect(transcript.some((e) => e.type === 'complete')).toBe(true);
  });

  it('respects permission mode in profile', async () => {
    const store = createRunStore(root);
    const launcher = createOpenSlackAgentLauncher({
      runStore: store,
      rootDir: root,
      adapter: new LocalExecutionAdapter(),
    });

    await launcher('do something', {
      label: 'worker',
      phase: 'execute',
      resolvedAgentConfig: {
        agentId: 'worker',
        source: 'claude-project',
        permissionMode: 'plan',
        tools: ['Read', 'Grep'],
      },
    });

    const run = store.listRuns()[0];
    const { readTranscript } = await import('../transcript.js');
    const transcript = readTranscript(run.runId, root);
    const startEvent = transcript.find((e) => e.type === 'start');

    expect(startEvent).toBeDefined();
    expect(startEvent!.data.permissionMode).toBe('plan');
    expect(startEvent!.data.allowedTools).toContain('Read');
    expect(startEvent!.data.allowedTools).not.toContain('Bash');
  });

  it('returns different result shapes based on prompt', async () => {
    const store = createRunStore(root);
    const launcher = createOpenSlackAgentLauncher({
      runStore: store,
      rootDir: root,
      adapter: new LocalExecutionAdapter(),
    });

    const reviewResult = await launcher('review PR #42', {
      label: 'reviewer',
      phase: 'review',
    });
    expect((reviewResult.data as any).review).toBeDefined();

    const researchResult = await launcher('research this topic', {
      label: 'researcher',
      phase: 'research',
    });
    expect((researchResult.data as any).summary).toBeDefined();

    const planResult = await launcher('plan this feature', {
      label: 'planner',
      phase: 'plan',
    });
    expect((planResult.data as any).plan).toBeDefined();
  });

  it('does not allow per-run fake mode to bypass provider configuration', async () => {
    const store = createRunStore(root);
    const launcher = createOpenSlackAgentLauncher({ runStore: store, rootDir: root });

    await expect(
      launcher('review this code', {
        label: 'bridge-test',
        phase: 'review',
        resolvedAgentConfig: {
          agentId: 'bridge-test',
          source: 'openslack-registry',
          bridgeMode: 'fake',
        },
      }),
    ).rejects.toMatchObject({ code: 'RUNTIME_NOT_CONFIGURED' });
    expect(store.listRuns()[0].status).toBe('failed');
  });

  it('does not emit bridge_lifecycle_complete for local adapter runs', async () => {
    const store = createRunStore(root);
    const launcher = createOpenSlackAgentLauncher({
      runStore: store,
      rootDir: root,
      adapter: new LocalExecutionAdapter(),
    });

    // Fixture behavior is available only through explicit adapter injection.
    await launcher('review this code', {
      label: 'local-test',
      phase: 'review',
      resolvedAgentConfig: {
        agentId: 'local-test',
        source: 'test',
      },
    });

    const run = store.listRuns()[0];
    const { readTranscript } = await import('../transcript.js');
    const transcript = readTranscript(run.runId, root);

    const lifecycleEvent = transcript.find(
      (e) =>
        e.type === 'progress' &&
        (e.data as Record<string, unknown>).step === 'bridge_lifecycle_complete',
    );
    expect(lifecycleEvent).toBeUndefined();
  });

  it('uses the runtime resolver for per-run process bridge agents', async () => {
    const store = createRunStore(root);
    const bridgeScript = join(root, 'fake-bridge.mjs');
    writeFileSync(
      bridgeScript,
      [
        "import { stdin, stdout } from 'node:process';",
        "let buffer = '';",
        "stdin.setEncoding('utf8');",
        'function envelope(input, kind, payload) {',
        "  return JSON.stringify({ protocolVersion: input.protocolVersion, sessionId: input.sessionId, correlationId: input.correlationId, timestamp: new Date().toISOString(), kind, payload }) + '\\n';",
        '}',
        "stdin.on('data', chunk => {",
        '  buffer += chunk;',
        "  const lines = buffer.split('\\n');",
        "  buffer = lines.pop() ?? '';",
        '  for (const line of lines) {',
        '    if (!line.trim()) continue;',
        '    const input = JSON.parse(line);',
        "    if (input.kind === 'handshake_request') stdout.write(envelope(input, 'handshake_response', { accepted: true }));",
        "    if (input.kind === 'run_request') stdout.write(envelope(input, 'complete', { data: { ok: true, payload: input.payload, env: { prompt: process.env.OPENSLACK_AGENT_PROMPT ?? null, anthropicKey: process.env.ANTHROPIC_API_KEY ?? null, runner: process.env.AGENT_RUN_BRIDGE_RUNNER ?? null, safeTrace: process.env.AGENT_RUN_SAFE_TRACE ?? null, oldRunId: process.env.OPENSLACK_RUN_ID ?? null, oldAgentId: process.env.OPENSLACK_AGENT_ID ?? null, runId: process.env.AGENT_RUN_ID ?? null, agentId: process.env.AGENT_ID ?? null } }, tokenUsage: 7 }));",
        '  }',
        '});',
      ].join('\n'),
      'utf-8',
    );

    const launcher = createOpenSlackAgentLauncher({
      runStore: store,
      rootDir: root,
      availableMcpServers: ['github'],
      bridgeRuntimeResolver: {
        resolve: () => ({
          command: process.execPath,
          args: [bridgeScript],
          env: {
            ANTHROPIC_API_KEY: 'must-not-leak',
            AGENT_RUN_BRIDGE_RUNNER: 'fake',
            AGENT_RUN_SAFE_TRACE: '1',
          },
        }),
      },
    });

    const result = await launcher('hello bridge', {
      label: 'aby',
      phase: 'execute',
      resolvedAgentConfig: {
        agentId: 'aby',
        source: 'test',
        runtime: 'aby_assistant',
        bridgeMode: 'process',
        permissionMode: 'plan',
        model: 'sonnet',
        effort: 'high',
        maxTurns: 4,
        requiredMcpServers: ['github'],
      },
    });

    expect((result.data as any).ok).toBe(true);
    expect((result.data as any).payload.input).toEqual([{ role: 'user', content: 'hello bridge' }]);
    expect((result.data as any).payload.runId).toBe(result.runId);
    expect((result.data as any).payload.agentId).toBe('aby');
    expect((result.data as any).payload.model).toBe('sonnet');
    expect((result.data as any).payload.effort).toBe('high');
    expect((result.data as any).payload.maxTurns).toBe(4);
    expect((result.data as any).payload.allowedTools).toContain('Read');
    expect((result.data as any).payload.permissionMode).toBe('plan');
    expect((result.data as any).payload.mcp).toEqual({
      required: ['github'],
      available: ['github'],
    });
    expect((result.data as any).payload.metadata.integrationId).toBe('openslack');
    expect((result.data as any).payload.metadata.resolvedConfig.model).toBe('sonnet');
    expect((result.data as any).env).toMatchObject({
      prompt: null,
      anthropicKey: null,
      runner: 'fake',
      safeTrace: '1',
      oldRunId: null,
      oldAgentId: null,
      runId: result.runId,
      agentId: 'aby',
    });
    expect(result.tokenUsage).toBe(7);
  });
});
