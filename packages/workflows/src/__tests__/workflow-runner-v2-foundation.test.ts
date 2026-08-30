import { describe, expect, it } from 'vitest';
import {
  prepareWorkflowControlAuthorityMessage,
  validateWorkflowControlAuthorityRoute,
  validateWorkflowControlAuthorityMessage,
  WORKFLOW_CONTROL_AUTHORITY_MESSAGE_SCHEMA,
  WORKFLOW_CONTROL_AUTHORITY_PROTOCOL_VERSION,
} from '../workflow-control-authority-contract.js';
import {
  WORKFLOW_RUNNER_CAPABILITIES,
  isWorkflowRunnerCapabilitySet,
  WORKFLOW_RUNNER_PROTOCOL_VERSION,
  WORKFLOW_RUNNER_RUNTIME_NAME,
} from '../workflow-runner-contract.js';
import {
  prepareWorkflowRunnerV2JobSpec,
  WORKFLOW_RUNNER_V2_JOB_RECEIPT_SCHEMA,
  WORKFLOW_RUNNER_V2_JOB_SPEC_SCHEMA,
  WorkflowRunnerV2ControlClient,
} from '../workflow-runner-v2-control-client.js';
import {
  hashWorkflowRunnerV2Descriptor,
  validateWorkflowRunnerV2ExecutionDescriptor,
} from '../workflow-runner-v2-descriptor.js';
import {
  decodeWorkflowRunnerV2Frame,
  WorkflowRunnerV2FramingError,
  WorkflowRunnerV2JsonlDecoder,
} from '../workflow-runner-v2-framing.js';
import { canonicalWorkflowEffectJson } from '../workflow-effect-json.js';
import { workflowRunnerV2DescriptorFixture } from './workflow-runner-v2-test-fixture.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const NOW = '2026-08-15T02:00:00.000Z';

function descriptor(
  input: Readonly<Record<string, unknown>> = { qualification: 'foundation-only' },
) {
  return workflowRunnerV2DescriptorFixture({
    descriptorRef: 'descriptor.v2.foundation',
    workspaceId: 'workspace.v2',
    workflowRunId: 'run.v2.foundation',
    correlationId: 'correlation.v2.foundation',
    workflowId: 'workflow-v2',
    workflowVersion: '1.0.0',
    workflowSource: 'openslack-project',
    workflowSourceBytes: Buffer.from('export const workflow = true;'),
    manifest: {
      name: 'workflow-v2',
      version: '1.0.0',
      description: 'GS9-F1 foundation fixture.',
      phases: [{ title: 'Foundation', detail: 'Use no checkpoint or effect boundary.' }],
      risk: 'low',
    },
    input,
    confirmationPolicy: {
      mode: 'unattended-explicit',
      actorId: 'qualification-host',
      runId: 'run.v2.foundation',
      allowUnattended: true,
      onUnexpectedEffect: 'fail',
    },
    requiredCapabilities: WORKFLOW_RUNNER_CAPABILITIES,
    authorityRoute: {
      backend: 'ts-local',
      authority: 'typescript',
      routingEpoch: 1,
      authorityBuildHash: HASH_A,
    },
    runRevision: 1,
    resumeGeneration: 0,
    budgetPolicy: {
      accountId: 'budget.v2',
      policyHash: HASH_B,
      rateNanoUsdPerToken: '12.5',
      tokenLimit: '1000',
      costLimitNanoUsd: '12500',
      callLimit: '2',
    },
    createdAt: NOW,
    expiresAt: '2026-08-15T03:00:00.000Z',
  });
}

function jobSpec(sealed = descriptor()) {
  return {
    schema: WORKFLOW_RUNNER_V2_JOB_SPEC_SCHEMA,
    workspaceId: sealed.workspaceId,
    jobId: 'job.v2.foundation',
    workflowRunId: sealed.workflowRunId,
    correlationId: sealed.correlationId,
    executionDescriptorRef: sealed.descriptorRef,
    executionDescriptorHash: hashWorkflowRunnerV2Descriptor(sealed),
    workflowId: sealed.workflowId,
    workflowVersion: sealed.workflowVersion,
    workflowSourceHash: sealed.workflowSourceHash,
    manifestHash: sealed.manifestHash,
    inputHash: sealed.inputHash,
    wholeTimeoutMs: 60_000,
    submittedAt: NOW,
    requiredProtocolVersion: WORKFLOW_CONTROL_AUTHORITY_PROTOCOL_VERSION,
    requiredCapabilities: WORKFLOW_RUNNER_CAPABILITIES,
    authorityRoute: sealed.authorityRoute,
    runRevision: sealed.runRevision,
    resumeGeneration: sealed.resumeGeneration,
  } as const;
}

describe('GS9-F1 Workflow runner v2 foundation', () => {
  it('binds a closed decimal budget policy without binary-float wire fields', () => {
    const sealed = descriptor();
    expect(sealed.budgetPolicy).toEqual({
      accountId: 'budget.v2',
      policyHash: HASH_B,
      rateNanoUsdPerToken: '12.5',
      tokenLimit: '1000',
      costLimitNanoUsd: '12500',
      callLimit: '2',
    });
    expect(JSON.stringify(sealed)).not.toContain('costUsd');
    expect(hashWorkflowRunnerV2Descriptor(sealed)).toMatch(/^[0-9a-f]{64}$/u);
    expect(() =>
      validateWorkflowRunnerV2ExecutionDescriptor({
        ...sealed,
        budgetPolicy: { ...sealed.budgetPolicy, costLimitNanoUsd: 12.5 },
      }),
    ).toThrowError(/costLimitNanoUsd/u);
  });

  it('copies and deeply freezes canonical descriptor input before hashing', () => {
    const input = {
      nested: { value: 'sealed' },
      items: [{ enabled: true }],
    };
    const sealed = descriptor(input);
    const originalHash = hashWorkflowRunnerV2Descriptor(sealed);

    input.nested.value = 'source-mutated';
    expect((sealed.input.nested as { value: string }).value).toBe('sealed');
    expect(Object.isFrozen(sealed.input)).toBe(true);
    expect(Object.isFrozen(sealed.input.nested)).toBe(true);
    expect(Object.isFrozen(sealed.input.items)).toBe(true);
    expect(Object.isFrozen((sealed.input.items as unknown[])[0])).toBe(true);
    expect(() => {
      (sealed.input.nested as { value: string }).value = 'post-hash-mutated';
    }).toThrow(TypeError);
    expect(hashWorkflowRunnerV2Descriptor(sealed)).toBe(originalHash);
  });

  it('prepares a closed v2 job spec while keeping route/revision/generation in the spec', () => {
    const prepared = prepareWorkflowRunnerV2JobSpec(jobSpec());

    expect(prepared.exactBody.endsWith('\n')).toBe(false);
    expect(prepared.exactBody).toContain('"authorityRoute"');
    expect(prepared.exactBody).toContain('"resumeGeneration":0');
    expect(prepared.jobSpecHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(prepared.idempotencyKey).toMatch(/^openslack\.workflow-runner-job\.v2\.[0-9a-f]{64}$/u);
    expect(isWorkflowRunnerCapabilitySet(prepared.spec.requiredCapabilities)).toBe(true);
    expect(validateWorkflowControlAuthorityRoute(prepared.spec.authorityRoute, '$/route')).toEqual(
      prepared.spec.authorityRoute,
    );
    expect(() =>
      prepareWorkflowRunnerV2JobSpec({ ...jobSpec(), workflowVersion: 'not-semver' }),
    ).toThrowError(/workflowVersion/u);
    expect(() =>
      prepareWorkflowRunnerV2JobSpec({
        ...jobSpec(),
        workflowVersion: `1.0.0-${'a'.repeat(59)}`,
      }),
    ).toThrowError(/workflowVersion/u);
  });

  it('accepts an exact replay only as the unchanged original accepted body', async () => {
    const prepared = prepareWorkflowRunnerV2JobSpec(jobSpec());
    const acceptedReceipt = {
      schema: WORKFLOW_RUNNER_V2_JOB_RECEIPT_SCHEMA,
      status: 'accepted',
      workspaceId: prepared.spec.workspaceId,
      jobId: prepared.spec.jobId,
      workflowRunId: prepared.spec.workflowRunId,
      state: 'queued',
      revision: 1,
      jobSpecHash: prepared.jobSpecHash,
      idempotencyKey: prepared.idempotencyKey,
      requestFingerprint: prepared.requestFingerprint,
      committedAt: NOW,
      reconciliationId: null,
    } as const;
    const acceptedBody = `${canonicalWorkflowEffectJson(acceptedReceipt)}\n`;
    const servedBodies: string[] = [];
    const seenKeys: string[] = [];
    const seenWorkspaces: string[] = [];
    let request = 0;
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      request += 1;
      seenKeys.push(new Headers(init?.headers).get('Idempotency-Key') ?? '');
      seenWorkspaces.push(new Headers(init?.headers).get('X-OpenSlack-Workspace-ID') ?? '');
      expect(init?.redirect).toBe('error');
      servedBodies.push(acceptedBody);
      return new Response(acceptedBody, {
        status: request === 1 ? 201 : 200,
        headers: {
          'Content-Type': 'application/json',
          ...(request === 1 ? {} : { 'Idempotency-Replayed': 'true' }),
        },
      });
    }) as typeof fetch;
    const client = new WorkflowRunnerV2ControlClient(
      {
        origin: 'http://127.0.0.1:8080',
        workspaceId: prepared.spec.workspaceId,
        bearerToken: 'test-only-bearer-value-000000000000',
        descriptorRoot: process.cwd(),
      },
      fetchImpl,
    );

    const accepted = await client.submit(prepared);
    const replay = await client.submit(prepared);
    expect(replay).toEqual(accepted);
    expect(replay.status).toBe('accepted');
    expect(servedBodies).toEqual([acceptedBody, acceptedBody]);
    expect(seenKeys).toEqual([prepared.idempotencyKey, prepared.idempotencyKey]);
    expect(seenWorkspaces).toEqual([prepared.spec.workspaceId, prepared.spec.workspaceId]);
  });

  it('recovers one lost submit response only by replaying the exact idempotent v2 request', async () => {
    const prepared = prepareWorkflowRunnerV2JobSpec(jobSpec());
    const receipt = {
      schema: WORKFLOW_RUNNER_V2_JOB_RECEIPT_SCHEMA,
      status: 'accepted',
      workspaceId: prepared.spec.workspaceId,
      jobId: prepared.spec.jobId,
      workflowRunId: prepared.spec.workflowRunId,
      state: 'queued',
      revision: 1,
      jobSpecHash: prepared.jobSpecHash,
      idempotencyKey: prepared.idempotencyKey,
      requestFingerprint: prepared.requestFingerprint,
      committedAt: NOW,
      reconciliationId: null,
    } as const;
    const exact = `${canonicalWorkflowEffectJson(receipt)}\n`;
    const bodies: string[] = [];
    const keys: string[] = [];
    let attempt = 0;
    const client = new WorkflowRunnerV2ControlClient(
      {
        origin: 'http://127.0.0.1:8080',
        workspaceId: prepared.spec.workspaceId,
        bearerToken: 'test-only-bearer-value-000000000000',
        descriptorRoot: process.cwd(),
      },
      (async (_request, init) => {
        bodies.push(String(init?.body));
        keys.push(new Headers(init?.headers).get('Idempotency-Key') ?? '');
        attempt += 1;
        if (attempt === 1) throw new TypeError('response lost after durable commit');
        return new Response(exact, {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Replayed': 'true',
          },
        });
      }) as typeof fetch,
    );

    await expect(client.submit(prepared)).resolves.toEqual(receipt);
    expect(bodies).toEqual([prepared.exactBody, prepared.exactBody]);
    expect(keys).toEqual([prepared.idempotencyKey, prepared.idempotencyKey]);
  });

  it('preserves reconciliation-required semantics on an exact replay', async () => {
    const prepared = prepareWorkflowRunnerV2JobSpec(jobSpec());
    const reconciliationReceipt = {
      schema: WORKFLOW_RUNNER_V2_JOB_RECEIPT_SCHEMA,
      status: 'reconciliation_required',
      workspaceId: prepared.spec.workspaceId,
      jobId: prepared.spec.jobId,
      workflowRunId: prepared.spec.workflowRunId,
      state: 'reconciliation_required',
      revision: 1,
      jobSpecHash: prepared.jobSpecHash,
      idempotencyKey: prepared.idempotencyKey,
      requestFingerprint: prepared.requestFingerprint,
      committedAt: NOW,
      reconciliationId: 'reconciliation.v2.foundation',
    } as const;
    const body = `${canonicalWorkflowEffectJson(reconciliationReceipt)}\n`;
    const client = new WorkflowRunnerV2ControlClient(
      {
        origin: 'http://127.0.0.1:8080',
        workspaceId: prepared.spec.workspaceId,
        bearerToken: 'test-only-bearer-value-000000000000',
        descriptorRoot: process.cwd(),
      },
      (async () =>
        new Response(body, {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Replayed': 'true',
          },
        })) as typeof fetch,
    );

    await expect(client.submit(prepared)).rejects.toMatchObject({
      code: 'WORKFLOW_RUNNER_V2_CONTROL_RECONCILIATION_REQUIRED',
    });
  });

  it('confines the submit client to an exact loopback origin', () => {
    const prepared = prepareWorkflowRunnerV2JobSpec(jobSpec());
    for (const origin of [
      'https://127.0.0.1:8080',
      'http://localhost:8080',
      'http://127.0.0.1:8080/path',
      'http://user:password@127.0.0.1:8080',
    ]) {
      expect(
        () =>
          new WorkflowRunnerV2ControlClient({
            origin,
            workspaceId: prepared.spec.workspaceId,
            bearerToken: 'test-only-bearer-value-000000000000',
            descriptorRoot: process.cwd(),
          }),
      ).toThrowError(/exact loopback/u);
    }
  });

  it('rejects replay metadata, content-type, canonical-byte, and receipt-status drift', async () => {
    const prepared = prepareWorkflowRunnerV2JobSpec(jobSpec());
    const base = {
      schema: WORKFLOW_RUNNER_V2_JOB_RECEIPT_SCHEMA,
      status: 'accepted',
      workspaceId: prepared.spec.workspaceId,
      jobId: prepared.spec.jobId,
      workflowRunId: prepared.spec.workflowRunId,
      state: 'queued',
      revision: 1,
      jobSpecHash: prepared.jobSpecHash,
      idempotencyKey: prepared.idempotencyKey,
      requestFingerprint: prepared.requestFingerprint,
      committedAt: NOW,
      reconciliationId: null,
    } as const;
    const exact = `${canonicalWorkflowEffectJson(base)}\n`;
    const cases: Array<{
      readonly status: number;
      readonly body: string;
      readonly headers: Record<string, string>;
    }> = [
      { status: 200, body: exact, headers: { 'Content-Type': 'application/json' } },
      {
        status: 201,
        body: exact,
        headers: { 'Content-Type': 'application/json', 'Idempotency-Replayed': 'true' },
      },
      {
        status: 201,
        body: exact,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      },
      {
        status: 201,
        body: ` ${exact}`,
        headers: { 'Content-Type': 'application/json' },
      },
      {
        status: 201,
        body: `${canonicalWorkflowEffectJson({ ...base, status: 'duplicate' })}\n`,
        headers: { 'Content-Type': 'application/json' },
      },
      {
        status: 201,
        body: `${canonicalWorkflowEffectJson({ ...base, revision: 2 })}\n`,
        headers: { 'Content-Type': 'application/json' },
      },
      {
        status: 201,
        body: exact,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(exact, 'utf8') + 1),
        },
      },
      {
        status: 201,
        body: 'x'.repeat(2 * 1024 * 1024 + 1),
        headers: { 'Content-Type': 'application/json' },
      },
      {
        status: 302,
        body: exact,
        headers: { 'Content-Type': 'application/json', Location: '/elsewhere' },
      },
    ];

    for (const item of cases) {
      const client = new WorkflowRunnerV2ControlClient(
        {
          origin: 'http://127.0.0.1:8080',
          workspaceId: prepared.spec.workspaceId,
          bearerToken: 'test-only-bearer-value-000000000000',
          descriptorRoot: process.cwd(),
        },
        (async () => new Response(item.body, item)) as typeof fetch,
      );
      await expect(client.submit(prepared)).rejects.toMatchObject({
        code: expect.stringMatching(/^WORKFLOW_RUNNER_V2_CONTROL_(?:REJECTED|RESPONSE_INVALID)$/u),
      });
    }
  });

  it('cancels every early-rejected response body before returning', async () => {
    const prepared = prepareWorkflowRunnerV2JobSpec(jobSpec());
    const cases = [
      { status: 401, headers: { 'Content-Type': 'application/json' } },
      {
        status: 201,
        headers: { 'Content-Type': 'application/json', 'Idempotency-Replayed': 'true' },
      },
      { status: 201, headers: { 'Content-Type': 'text/plain' } },
    ] as const;

    for (const item of cases) {
      let cancellations = 0;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Buffer.from('{}\n'));
        },
        cancel() {
          cancellations += 1;
        },
      });
      const client = new WorkflowRunnerV2ControlClient(
        {
          origin: 'http://127.0.0.1:8080',
          workspaceId: prepared.spec.workspaceId,
          bearerToken: 'test-only-bearer-value-000000000000',
          descriptorRoot: process.cwd(),
        },
        (async () => new Response(body, item)) as typeof fetch,
      );

      await expect(client.submit(prepared)).rejects.toBeInstanceOf(Error);
      expect(cancellations).toBe(1);
    }
  });

  it('classifies persistent service failure as an unknown transport outcome and cancels both bodies', async () => {
    const prepared = prepareWorkflowRunnerV2JobSpec(jobSpec());
    let cancellations = 0;
    let attempts = 0;
    const client = new WorkflowRunnerV2ControlClient(
      {
        origin: 'http://127.0.0.1:8080',
        workspaceId: prepared.spec.workspaceId,
        bearerToken: 'test-only-bearer-value-000000000000',
        descriptorRoot: process.cwd(),
      },
      (async () => {
        attempts += 1;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(Buffer.from('{"code":"temporarily_unavailable"}\n'));
            },
            cancel() {
              cancellations += 1;
            },
          }),
          { status: 503, headers: { 'Content-Type': 'application/json' } },
        );
      }) as typeof fetch,
    );

    await expect(client.submit(prepared)).rejects.toMatchObject({
      code: 'WORKFLOW_RUNNER_V2_CONTROL_TRANSPORT_FAILED',
    });
    expect(attempts).toBe(2);
    expect(cancellations).toBe(2);
  });

  it('accepts only exact canonical v2 authority JSONL frames', () => {
    const message = validateWorkflowControlAuthorityMessage({
      schema: WORKFLOW_CONTROL_AUTHORITY_MESSAGE_SCHEMA,
      protocolVersion: WORKFLOW_CONTROL_AUTHORITY_PROTOCOL_VERSION,
      kind: 'hello',
      workspaceId: 'workspace.v2',
      jobId: null,
      workflowRunId: null,
      attemptId: null,
      leaseId: null,
      fencingToken: null,
      sequence: null,
      authorityBackend: null,
      authority: null,
      routingEpoch: null,
      authorityBuildHash: null,
      runRevision: null,
      resumeGeneration: null,
      eventId: 'hello.v2.foundation',
      correlationId: 'correlation.v2.foundation',
      sentAt: NOW,
      payload: {
        runtimeName: WORKFLOW_RUNNER_RUNTIME_NAME,
        runtimeVersion: '22.14.0',
        runnerBuildHash: HASH_A,
        supportedProtocolVersions: [
          WORKFLOW_RUNNER_PROTOCOL_VERSION,
          WORKFLOW_CONTROL_AUTHORITY_PROTOCOL_VERSION,
        ],
        capabilities: WORKFLOW_RUNNER_CAPABILITIES,
        maxConcurrentJobs: 1,
      },
    });
    const exact = prepareWorkflowControlAuthorityMessage(message).body;
    const decoder = new WorkflowRunnerV2JsonlDecoder();
    expect(decoder.push(Buffer.from(exact.slice(0, 19)))).toEqual([]);
    const frames = decoder.push(Buffer.from(exact.slice(19)));
    expect(frames).toHaveLength(1);
    expect(decodeWorkflowRunnerV2Frame(frames[0]!)).toEqual(message);
    decoder.finish();

    const nonCanonical = Buffer.from(` ${exact}`);
    expect(() => decodeWorkflowRunnerV2Frame(nonCanonical)).toThrow(WorkflowRunnerV2FramingError);
  });
});
