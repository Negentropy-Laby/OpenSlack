import { WORKFLOW_RUNNER_CAPABILITIES } from '../workflow-runner-contract.js';
import { bindGoWorkflowResumeIdentity, validateGoWorkflowResumeContext } from '../resume.js';
import { createWorkflowSourceSnapshot } from '../internal/workflow-source-snapshot.js';
import type { WorkflowMeta } from '../types.js';
import { expect, vi } from 'vitest';
import {
  workflowControlAuthorityInitialRecord,
  type WorkflowControlAuthorityPort,
} from '../workflow-control-authority-client.js';
import { WorkflowRunnerV2GoProjectionRunStore } from '../workflow-runner-v2-go-projection-store.js';
import { resolveWorkflowRunProjectionRoot } from '../workflow-run-projection.js';
import {
  validateWorkflowRunRouteReceipt,
  WorkflowRunRouter,
  type WorkflowRunRouteReceipt,
} from '../workflow-run-routing.js';

export function routeReceiptFixture(
  overrides: Partial<WorkflowRunRouteReceipt> = {},
): WorkflowRunRouteReceipt {
  return validateWorkflowRunRouteReceipt({
    schema: 'openslack.workflow_run_route_receipt.v1',
    workspaceId: 'workspace.test',
    runId: 'run-001',
    workflowId: 'test-scan',
    workflowVersion: '0.0.0',
    workflowSourceHash: 'a'.repeat(64),
    manifestHash: 'b'.repeat(64),
    inputHash: 'c'.repeat(64),
    route: {
      backend: 'go',
      authority: 'workflow-control',
      routingEpoch: 1,
      authorityBuildHash: 'd'.repeat(64),
    },
    policyHash: 'e'.repeat(64),
    correlationId: 'correlation.test',
    qualificationEnvironmentId: 'test',
    selectedAt: '2020-01-01T00:00:00.000Z',
    expiresAt: '2020-01-02T00:00:00.000Z',
    ...overrides,
  });
}

export function boundResumeIdentityFixture(
  meta: WorkflowMeta,
  source = 'a'.repeat(64),
  runId = 'run-001',
) {
  const bytes = Buffer.from(source);
  const snapshot = createWorkflowSourceSnapshot(bytes, meta);
  const route = routeReceiptFixture({
    runId,
    workflowId: meta.name,
    workflowVersion: meta.version ?? '0.0.0',
    workflowSourceHash: snapshot.workflowSourceHash,
    manifestHash: snapshot.manifestHash,
  });
  return bindGoWorkflowResumeIdentity(
    validateGoWorkflowResumeContext(runId, route, route.workspaceId),
    {
      meta,
      format: 'openslack-native',
      hash: snapshot.rawHash,
      sourceSnapshot: snapshot,
      run: async () => ({ status: 'completed' }),
    },
    bytes,
  );
}
import {
  createWorkflowRunnerV2ExecutionDescriptor,
  type CreateWorkflowRunnerV2ExecutionDescriptorInput,
  type WorkflowRunnerV2ExecutionDescriptor,
} from '../workflow-runner-v2-descriptor.js';

const DEFAULT_CREATED_AT = '2026-08-15T02:00:00.000Z';
const DEFAULT_EXPIRES_AT = '2026-08-15T03:00:00.000Z';

/** Shared test composition only: real route/projection checks, deterministic authority I/O. */
export function workflowRunnerGoAuthorityFixture(input: {
  rootDir: string;
  descriptor: WorkflowRunnerV2ExecutionDescriptor;
  qualificationEnvironmentId: string;
  runner: { jobId: string; attemptId: string; leaseId: string; fencingToken: number };
}) {
  const { descriptor } = input;
  if (descriptor.authorityRoute.backend !== 'go')
    throw new Error('Go authority fixture requires an explicit Go descriptor.');
  const runId = descriptor.workflowRunId;
  const route = new WorkflowRunRouter({
    schema: 'openslack.workflow_run_routing_policy.v1',
    workspaceId: descriptor.workspaceId,
    backend: 'go',
    routingEpoch: descriptor.authorityRoute.routingEpoch,
    authorityBuildHash: descriptor.authorityRoute.authorityBuildHash,
    qualificationEnvironmentId: input.qualificationEnvironmentId,
    workflowAllowlist: [descriptor.workflowId],
    runAllowlist: [],
    expiresAt: descriptor.expiresAt,
  }).select({
    workspaceId: descriptor.workspaceId,
    runId,
    workflowId: descriptor.workflowId,
    workflowVersion: descriptor.workflowVersion,
    workflowSourceHash: descriptor.workflowSourceHash,
    manifestHash: descriptor.manifestHash,
    inputHash: descriptor.inputHash,
    correlationId: descriptor.correlationId,
    selectedAt: descriptor.createdAt,
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
        updatedAt: descriptor.createdAt,
      };
    },
    async readIfExists() {
      return this.read(runId, route.route);
    },
    async transition(next, expected) {
      expect(expected).toMatchObject({ revision: record.revision, state: record.state });
      expect(next.revision).toBe(record.revision + 1);
      record = next;
      return {} as never;
    },
  };
  const baseDir = resolveWorkflowRunProjectionRoot(input.rootDir, 'go');
  const store = new WorkflowRunnerV2GoProjectionRunStore({ baseDir, descriptor, authority });
  const binding = {
    ...input.runner,
    workspaceId: descriptor.workspaceId,
    workflowRunId: runId,
    correlationId: descriptor.correlationId,
    runnerBuildHash: descriptor.authorityRoute.authorityBuildHash,
    workflowSourceHash: descriptor.workflowSourceHash,
    manifestHash: descriptor.manifestHash,
    inputHash: descriptor.inputHash,
  };
  return { route, authority, baseDir, store, binding, runId };
}

export function workflowRunnerV2DescriptorFixture(
  overrides: Partial<CreateWorkflowRunnerV2ExecutionDescriptorInput> = {},
): WorkflowRunnerV2ExecutionDescriptor {
  const workflowRunId = overrides.workflowRunId ?? 'run.v2.fixture';
  const manifest = overrides.manifest ?? {
    name: 'workflow-v2',
    version: '1.0.0',
    description: 'Shared Workflow Runner v2 test fixture.',
    phases: [{ title: 'Run', detail: 'Exercise the v2 qualification lane.' }],
    risk: 'low',
  };
  return createWorkflowRunnerV2ExecutionDescriptor({
    descriptorRef: overrides.descriptorRef ?? 'descriptor.v2.fixture',
    workspaceId: overrides.workspaceId ?? 'workspace.v2',
    workflowRunId,
    correlationId: overrides.correlationId ?? 'correlation.v2.fixture',
    workflowId: overrides.workflowId ?? manifest.name,
    workflowVersion: overrides.workflowVersion ?? manifest.version ?? '1.0.0',
    workflowSource: overrides.workflowSource ?? 'openslack-project',
    workflowSourceBytes:
      overrides.workflowSourceBytes ?? Buffer.from('export const workflow = true;', 'utf8'),
    manifest,
    input: overrides.input ?? {},
    confirmationPolicy: overrides.confirmationPolicy ?? {
      mode: 'unattended-explicit',
      actorId: 'qualification-host',
      runId: workflowRunId,
      allowUnattended: true,
      onUnexpectedEffect: 'fail',
    },
    requiredCapabilities: overrides.requiredCapabilities ?? WORKFLOW_RUNNER_CAPABILITIES,
    authorityRoute: overrides.authorityRoute ?? {
      backend: 'ts-local',
      authority: 'typescript',
      routingEpoch: 1,
      authorityBuildHash: 'a'.repeat(64),
    },
    runRevision: overrides.runRevision ?? 1,
    resumeGeneration: overrides.resumeGeneration ?? 0,
    budgetPolicy: overrides.budgetPolicy ?? {
      accountId: 'budget.v2',
      policyHash: 'b'.repeat(64),
      rateNanoUsdPerToken: '10',
      tokenLimit: '1000',
      costLimitNanoUsd: '10000',
      callLimit: '2',
    },
    createdAt: overrides.createdAt ?? DEFAULT_CREATED_AT,
    expiresAt: overrides.expiresAt ?? DEFAULT_EXPIRES_AT,
  });
}
