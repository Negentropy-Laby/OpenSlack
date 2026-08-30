import { WORKFLOW_RUNNER_CAPABILITIES } from '../workflow-runner-contract.js';
import {
  createWorkflowRunnerV2ExecutionDescriptor,
  type CreateWorkflowRunnerV2ExecutionDescriptorInput,
  type WorkflowRunnerV2ExecutionDescriptor,
} from '../workflow-runner-v2-descriptor.js';

const DEFAULT_CREATED_AT = '2026-08-15T02:00:00.000Z';
const DEFAULT_EXPIRES_AT = '2026-08-15T03:00:00.000Z';

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
