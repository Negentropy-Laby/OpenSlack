import {
  WORKFLOW_RUN_READ_POLICIES,
  WorkflowRunReadError,
  type WorkflowRunReadCode,
} from './workflow-run-read-errors.js';
import {
  parseWorkflowControlAuthorityMessageBytes,
  type WorkflowControlAuthorityMessage,
  type WorkflowControlAuthorityPreparedMessage,
} from './workflow-control-authority-contract.js';
import type { WorkflowRunnerV2ExecutionDescriptor } from './workflow-runner-v2-descriptor.js';
import type { WorkflowRunnerV2RuntimeDeliveryPort } from './workflow-runner-v2-session.js';
import type { WorkflowRunnerV2RuntimeAdmissionPort } from './workflow-runner-v2-runtime-admission.js';
import {
  hashWorkflowRunnerAuthorityBindingEvidence,
  type WorkflowRunnerAuthorityBindingOperation,
} from './workflow-runner-authority-binding-contract.js';
import type {
  WorkflowRunnerAuthorityBindingRuntime,
  WorkflowRunnerAuthoritySourceAdapter,
} from './workflow-runner-authority-binding-runtime.js';
import { WorkflowRunRecoveryError } from './workflow-run-recovery-evidence.js';

export interface WorkflowRunnerV2AuthoritySourceResolver {
  resolve(
    operation: WorkflowRunnerAuthorityBindingOperation,
    target: WorkflowControlAuthorityMessage,
  ): Promise<WorkflowRunnerAuthoritySourceAdapter>;
}

export interface WorkflowRunnerV2ProjectionPort {
  classify(descriptor: WorkflowRunnerV2ExecutionDescriptor): Promise<'initial' | 'resume'>;
}

/**
 * Production composition between the frozen v2 session and the F2b companion
 * runtime. It derives every lease field from the already validated exact target
 * bytes; callers cannot supply a second, drifting identity object.
 */
export class WorkflowRunnerV2RuntimeDelivery implements WorkflowRunnerV2RuntimeDeliveryPort {
  readonly #runtime: WorkflowRunnerAuthorityBindingRuntime;
  readonly #sources: WorkflowRunnerV2AuthoritySourceResolver;
  readonly #projection: WorkflowRunnerV2ProjectionPort;
  readonly #admissions: WorkflowRunnerV2RuntimeAdmissionPort;

  constructor(options: {
    readonly runtime: WorkflowRunnerAuthorityBindingRuntime;
    readonly sources: WorkflowRunnerV2AuthoritySourceResolver;
    readonly projection: WorkflowRunnerV2ProjectionPort;
    readonly admissions: WorkflowRunnerV2RuntimeAdmissionPort;
  }) {
    this.#runtime = options.runtime;
    this.#sources = options.sources;
    this.#projection = options.projection;
    this.#admissions = options.admissions;
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
    const resume = (await this.#projection.classify(descriptor)) === 'resume';
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
    signal?: AbortSignal,
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
    const committed = await this.#runtime.commit({
      operation,
      target,
      source,
      signal,
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
    if (operation === 'resume_advance' || operation === 'checkpoint_commit') {
      const proof = await source.probe(committed.stage, signal);
      if (
        proof.state !== 'committed' ||
        proof.readiness?.state === 'blocked' ||
        hashWorkflowRunnerAuthorityBindingEvidence(proof.evidence, operation) !==
          hashWorkflowRunnerAuthorityBindingEvidence(committed.resolution.evidence, operation)
      ) {
        if (
          proof.state === 'committed' &&
          proof.readiness?.state === 'blocked' &&
          Object.hasOwn(WORKFLOW_RUN_READ_POLICIES, proof.readiness.code)
        )
          throw new WorkflowRunReadError([
            {
              scope: 'run',
              backend: 'go',
              runId: committed.stage.runId,
              code: proof.readiness.code as WorkflowRunReadCode,
            },
          ]);
        throw new WorkflowRunRecoveryError(
          proof.state === 'unknown'
            ? 'WORKFLOW_RUN_RECOVERY_UNKNOWN'
            : proof.state === 'committed' &&
                proof.readiness?.state === 'blocked' &&
                (proof.readiness.code === 'WORKFLOW_RUN_RECOVERY_SUPERSEDED' ||
                  proof.readiness.code === 'WORKFLOW_RUN_RECOVERY_RECONCILIATION_REQUIRED')
              ? proof.readiness.code
              : 'WORKFLOW_RUN_RECOVERY_CACHE_REPAIR_REQUIRED',
          proof.state === 'committed' && proof.readiness?.state === 'blocked'
            ? proof.readiness.message
            : 'Committed checkpoint evidence needs an available cache before event delivery; use runs repair-checkpoints.',
        );
      }
    }
    return committed;
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
