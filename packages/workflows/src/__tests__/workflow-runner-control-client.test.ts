import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { canonicalWorkflowEffectJson } from '../workflow-effect-json.js';
import {
  loadWorkflowRunnerControlConfig,
  prepareWorkflowRunnerJobSpec,
  validateWorkflowRunnerJobView,
  WorkflowRunnerControlClient,
  WorkflowRunnerControlError,
  WORKFLOW_RUNNER_JOB_SPEC_SCHEMA,
} from '../workflow-runner-control-client.js';

const HASH = '1'.repeat(64);
const WORKSPACE = 'workspace-1';
const TOKEN = 't'.repeat(32);

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(`${canonicalWorkflowEffectJson(value)}\n`, {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function prepared() {
  return prepareWorkflowRunnerJobSpec({
    schema: WORKFLOW_RUNNER_JOB_SPEC_SCHEMA,
    workspaceId: WORKSPACE,
    jobId: 'job-1',
    workflowRunId: 'run-1',
    correlationId: 'correlation-1',
    executionDescriptorRef: 'descriptor-1',
    executionDescriptorHash: HASH,
    workflowId: 'workflow-1',
    workflowVersion: '1.0.0',
    workflowSourceHash: HASH,
    manifestHash: HASH,
    inputHash: HASH,
    wholeTimeoutMs: 60_000,
    submittedAt: '2026-08-13T00:00:00.000Z',
  });
}

function config() {
  return {
    origin: 'http://127.0.0.1:18183',
    workspaceId: WORKSPACE,
    bearerToken: TOKEN,
    descriptorRoot: resolve('runner-descriptors'),
  } as const;
}

describe('WorkflowRunnerControlClient', () => {
  it('requires the complete loopback-only transport configuration', () => {
    expect(() => loadWorkflowRunnerControlConfig({})).toThrow(
      /OPENSLACK_WORKFLOW_RUNNER_CONTROL_ORIGIN/u,
    );
    expect(() =>
      loadWorkflowRunnerControlConfig({
        OPENSLACK_WORKFLOW_RUNNER_CONTROL_ORIGIN: 'http://localhost:18183',
        OPENSLACK_WORKFLOW_RUNNER_CONTROL_WORKSPACE_ID: WORKSPACE,
        OPENSLACK_WORKFLOW_RUNNER_CONTROL_BEARER_TOKEN: TOKEN,
        OPENSLACK_WORKFLOW_RUNNER_DESCRIPTOR_ROOT: resolve('runner-descriptors'),
      }),
    ).toThrow(/exact loopback HTTP origin/u);
    for (const origin of [
      'https://127.0.0.1:18183',
      'http://user@127.0.0.1:18183',
      'http://127.0.0.1:18183/path',
      'http://127.0.0.1:18183?query=1',
      'http://127.0.0.1:18183/#fragment',
      'http://[0:0:0:0:0:0:0:1]:18183',
    ]) {
      expect(() =>
        loadWorkflowRunnerControlConfig({
          OPENSLACK_WORKFLOW_RUNNER_CONTROL_ORIGIN: origin,
          OPENSLACK_WORKFLOW_RUNNER_CONTROL_WORKSPACE_ID: WORKSPACE,
          OPENSLACK_WORKFLOW_RUNNER_CONTROL_BEARER_TOKEN: TOKEN,
          OPENSLACK_WORKFLOW_RUNNER_DESCRIPTOR_ROOT: resolve('runner-descriptors'),
        }),
      ).toThrow(/exact loopback HTTP origin/u);
    }
    expect(
      loadWorkflowRunnerControlConfig({
        OPENSLACK_WORKFLOW_RUNNER_CONTROL_ORIGIN: 'http://[::1]:18183',
        OPENSLACK_WORKFLOW_RUNNER_CONTROL_WORKSPACE_ID: WORKSPACE,
        OPENSLACK_WORKFLOW_RUNNER_CONTROL_BEARER_TOKEN: TOKEN,
        OPENSLACK_WORKFLOW_RUNNER_DESCRIPTOR_ROOT: resolve('runner-descriptors'),
      }).origin,
    ).toBe('http://[::1]:18183');
    expect(
      () =>
        new WorkflowRunnerControlClient({
          ...config(),
          bearerToken: undefined as never,
        }),
    ).toThrow(WorkflowRunnerControlError);
  });

  it('binds the exact canonical JobSpec to Go-compatible admission headers', async () => {
    const value = prepared();
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init?.redirect).toBe('error');
      expect(init?.body).toBe(value.exactBody);
      const headers = new Headers(init?.headers);
      expect(headers.get('Authorization')).toBe(`Bearer ${TOKEN}`);
      expect(headers.get('Idempotency-Key')).toBe(value.idempotencyKey);
      expect(headers.get('X-OpenSlack-Request-Fingerprint')).toBe(value.requestFingerprint);
      return jsonResponse(
        {
          schema: 'openslack.workflow_runner_job_receipt.v1',
          status: 'accepted',
          workspaceId: WORKSPACE,
          jobId: 'job-1',
          workflowRunId: 'run-1',
          state: 'queued',
          revision: 1,
          jobSpecHash: value.jobSpecHash,
          idempotencyKey: value.idempotencyKey,
          requestFingerprint: value.requestFingerprint,
          committedAt: '2026-08-13T00:00:01.000Z',
          reconciliationId: null,
        },
        201,
      );
    });
    const receipt = await new WorkflowRunnerControlClient(config(), {
      fetch: fetchMock,
    }).submit(value);
    expect(receipt.status).toBe('accepted');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:18183/v1/runner/jobs',
      expect.any(Object),
    );
  });

  it('strictly validates every terminal JobView field and result binding shape', () => {
    const view = validateWorkflowRunnerJobView({
      schema: 'openslack.workflow_runner_job_view.v1',
      workspaceId: WORKSPACE,
      jobId: 'job-1',
      workflowRunId: 'run-1',
      correlationId: 'correlation-1',
      state: 'terminal',
      revision: 4,
      fencingToken: 1,
      attemptId: 'attempt-1',
      leaseId: 'lease-1',
      attemptState: 'terminal',
      leaseExpiresAt: '2026-08-13T00:01:00.000Z',
      terminalStatus: 'completed',
      terminalReason: null,
      resultHash: HASH,
      openEffectCount: 0,
      reconciliationId: null,
      reconciliationCode: null,
      executionStarted: true,
      createdAt: '2026-08-13T00:00:00.000Z',
      updatedAt: '2026-08-13T00:00:02.000Z',
    });
    expect(view.resultHash).toBe(HASH);
    expect(() => validateWorkflowRunnerJobView({ ...view, unknown: true })).toThrow(
      /missing or unknown fields/u,
    );
    expect(() => validateWorkflowRunnerJobView({ ...view, resultHash: null })).toThrow(
      /inconsistent/u,
    );
    expect(() =>
      validateWorkflowRunnerJobView({
        ...view,
        terminalStatus: 'failed',
        terminalReason: 'workflow_failed',
      }),
    ).toThrow(/inconsistent/u);
  });

  it('accepts the reconciliation terminal shape emitted by the Go authority', () => {
    const view = validateWorkflowRunnerJobView({
      schema: 'openslack.workflow_runner_job_view.v1',
      workspaceId: WORKSPACE,
      jobId: 'job-1',
      workflowRunId: 'run-1',
      correlationId: 'correlation-1',
      state: 'reconciliation_required',
      revision: 4,
      fencingToken: 1,
      attemptId: 'attempt-1',
      leaseId: null,
      attemptState: 'crashed',
      leaseExpiresAt: null,
      terminalStatus: 'reconciliation_required',
      terminalReason: 'commit_outcome_unknown',
      resultHash: null,
      openEffectCount: 0,
      reconciliationId: 'reconciliation-1',
      reconciliationCode: 'WORKFLOW_RUNNER_RECONCILIATION_REQUIRED',
      executionStarted: false,
      createdAt: '2026-08-13T00:00:00.000Z',
      updatedAt: '2026-08-13T00:00:02.000Z',
    });

    expect(view.terminalStatus).toBe('reconciliation_required');
    expect(() => validateWorkflowRunnerJobView({ ...view, terminalStatus: null })).toThrow(
      /inconsistent/u,
    );
  });

  it('does not expose the bearer token when transport fails', async () => {
    const client = new WorkflowRunnerControlClient(config(), {
      fetch: vi.fn<typeof fetch>(async () => {
        throw new Error(`request contained ${TOKEN}`);
      }),
    });
    const error = await client.submit(prepared()).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(WorkflowRunnerControlError);
    expect(String((error as Error).message)).not.toContain(TOKEN);
  });

  it('maps a 202 error envelope to reconciliation instead of accepting it as a receipt', async () => {
    const client = new WorkflowRunnerControlClient(config(), {
      fetch: vi.fn<typeof fetch>(async () =>
        jsonResponse(
          {
            schema: 'openslack.workflow_runner_control_error.v1',
            code: 'WORKFLOW_RUNNER_RECONCILIATION_REQUIRED',
            message: 'sanitized',
          },
          202,
        ),
      ),
    });
    await expect(client.submit(prepared())).rejects.toMatchObject({
      code: 'WORKFLOW_RUNNER_CONTROL_RECONCILIATION_REQUIRED',
    });
  });

  it('keeps the timeout active while reading a stalled response body', async () => {
    const client = new WorkflowRunnerControlClient(config(), {
      requestTimeoutMs: 25,
      fetch: vi.fn<typeof fetch>(
        async () =>
          new Response(new ReadableStream<Uint8Array>({ start() {} }), {
            status: 201,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    });
    await expect(client.submit(prepared())).rejects.toMatchObject({
      code: 'WORKFLOW_RUNNER_CONTROL_TIMEOUT',
    });
  });

  it('bounds the complete polling operation even while one response body is stalled', async () => {
    const client = new WorkflowRunnerControlClient(config(), {
      requestTimeoutMs: 10_000,
      fetch: vi.fn<typeof fetch>(
        async () =>
          new Response(new ReadableStream<Uint8Array>({ start() {} }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    });
    await expect(
      client.waitForTerminal('job-1', { timeoutMs: 25, pollIntervalMs: 25 }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_RUNNER_CONTROL_TIMEOUT' });
  });
});
