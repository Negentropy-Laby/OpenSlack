import { join } from 'node:path';
import {
  parseWorkflowControlAuthorityMessageBytes,
  type WorkflowControlAuthorityMessage,
  type WorkflowControlAuthorityPreparedMessage,
} from './workflow-control-authority-contract.js';
import { RunStore } from './run-store.js';
import { classifyWorkflowRunnerRunState } from './workflow-runner-run-state.js';
import type { WorkflowRunnerV2ExecutionDescriptor } from './workflow-runner-v2-descriptor.js';
import type { WorkflowRunnerV2RuntimeDeliveryPort } from './workflow-runner-v2-session.js';
import type { WorkflowRunnerV2RuntimeAdmissionPort } from './workflow-runner-v2-runtime-admission.js';
import type { WorkflowRunnerAuthorityBindingOperation } from './workflow-runner-authority-binding-contract.js';
import type {
  WorkflowRunnerAuthorityBindingRuntime,
  WorkflowRunnerAuthoritySourceAdapter,
} from './workflow-runner-authority-binding-runtime.js';

export interface WorkflowRunnerV2AuthoritySourceResolver {
  resolve(
    operation: WorkflowRunnerAuthorityBindingOperation,
    target: WorkflowControlAuthorityMessage,
  ): Promise<WorkflowRunnerAuthoritySourceAdapter>;
}

/**
 * Production composition between the frozen v2 session and the F2b companion
 * runtime. It derives every lease field from the already validated exact target
 * bytes; callers cannot supply a second, drifting identity object.
 */
export class WorkflowRunnerV2RuntimeDelivery implements WorkflowRunnerV2RuntimeDeliveryPort {
  readonly #runtime: WorkflowRunnerAuthorityBindingRuntime;
  readonly #sources: WorkflowRunnerV2AuthoritySourceResolver;
  readonly #workspaceRoot: string;
  readonly #runStoreFactory: (baseDir: string) => RunStore;
  readonly #admissions: WorkflowRunnerV2RuntimeAdmissionPort;

  constructor(options: {
    readonly runtime: WorkflowRunnerAuthorityBindingRuntime;
    readonly sources: WorkflowRunnerV2AuthoritySourceResolver;
    readonly workspaceRoot: string;
    readonly admissions: WorkflowRunnerV2RuntimeAdmissionPort;
    readonly runStoreFactory?: (baseDir: string) => RunStore;
  }) {
    this.#runtime = options.runtime;
    this.#sources = options.sources;
    this.#workspaceRoot = options.workspaceRoot;
    this.#admissions = options.admissions;
    this.#runStoreFactory = options.runStoreFactory ?? ((baseDir) => new RunStore({ baseDir }));
  }

  async initialize(): Promise<void> {
    await this.#runtime.initialize();
  }

  async isResume(
    descriptor: WorkflowRunnerV2ExecutionDescriptor,
    lease: Readonly<{
      workspaceId: string;
      jobId: string;
      workflowRunId: string;
      attemptId: string;
      leaseId: string;
      fencingToken: number;
      jobSpecHash: string;
      resumeGeneration: number;
    }>,
  ): Promise<boolean> {
    if (
      descriptor.workspaceId !== lease.workspaceId ||
      descriptor.workflowRunId !== lease.workflowRunId ||
      descriptor.resumeGeneration !== lease.resumeGeneration
    ) {
      throw new Error('Runtime-delivery resume probe differs from the sealed descriptor.');
    }
    await this.#runtime.assertRunReady(lease.workflowRunId);
    const store = this.#runStoreFactory(
      descriptor.authorityRoute.backend === 'go'
        ? join(this.#workspaceRoot, '.openslack.local', 'workflows', 'go-recovery-projections')
        : join(this.#workspaceRoot, '.openslack.local', 'workflows'),
    );
    const exists = await store.runExists(lease.workflowRunId);
    const status = exists ? await store.loadStatus(lease.workflowRunId) : null;
    const resume =
      classifyWorkflowRunnerRunState(lease.workflowRunId, exists, status?.status ?? null) ===
      'resume';
    await this.#admissions.seal({
      schema: 'openslack.workflow_runner_v2_runtime_admission.v1',
      workspaceId: lease.workspaceId,
      jobId: lease.jobId,
      workflowRunId: lease.workflowRunId,
      attemptId: lease.attemptId,
      leaseId: lease.leaseId,
      fencingToken: lease.fencingToken,
      jobSpecHash: lease.jobSpecHash,
      disposition: resume ? 'resume' : 'initial',
    });
    return resume;
  }

  async commit(
    operation: WorkflowRunnerAuthorityBindingOperation,
    target: WorkflowControlAuthorityPreparedMessage,
    sourceOverride?: WorkflowRunnerAuthoritySourceAdapter,
  ) {
    const message = parseWorkflowControlAuthorityMessageBytes(Buffer.from(target.body, 'utf8'));
    if (
      message.workspaceId === null ||
      message.jobId === null ||
      message.workflowRunId === null ||
      message.attemptId === null ||
      message.leaseId === null ||
      message.fencingToken === null ||
      message.authorityBackend === null ||
      message.authority === null ||
      message.routingEpoch === null ||
      message.authorityBuildHash === null ||
      message.runRevision === null ||
      message.resumeGeneration === null
    ) {
      throw new Error('Runtime-delivery target lacks its closed lease identity.');
    }
    const source = sourceOverride ?? (await this.#sources.resolve(operation, message));
    return this.#runtime.commit({
      operation,
      target,
      source,
      lease: {
        workspaceId: message.workspaceId,
        jobId: message.jobId,
        runId: message.workflowRunId,
        runnerAttemptId: message.attemptId,
        leaseId: message.leaseId,
        fencingToken: message.fencingToken,
        route: {
          backend: message.authorityBackend,
          authority: message.authority,
          routingEpoch: message.routingEpoch,
          authorityBuildHash: message.authorityBuildHash,
        },
        runnerAuthority: {
          expectedGlobalRunRevision: message.runRevision,
          expectedResumeGeneration: message.resumeGeneration,
        },
        correlationId: message.correlationId,
      },
    });
  }

  async acknowledgeControl(
    bindingId: string,
    message: WorkflowControlAuthorityMessage,
    context: Parameters<WorkflowRunnerV2RuntimeDeliveryPort['acknowledgeControl']>[2],
  ): Promise<void> {
    await this.#runtime.acknowledgeControl({
      bindingId,
      message,
      disposition: context.disposition,
      ...(context.budgetSourceResult === undefined
        ? {}
        : { budgetSourceResult: context.budgetSourceResult }),
    });
  }
}
