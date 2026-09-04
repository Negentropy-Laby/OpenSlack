import type { RunStatus } from './types.js';
import { isRunStatusTransitionAllowed, RunStore, type RunMeta } from './run-store.js';
import type {
  WorkflowControlAuthorityExpectedHead,
  WorkflowControlAuthorityPort,
  WorkflowControlAuthorityRunRead,
  WorkflowControlAuthorityRunRecord,
} from './workflow-control-authority-client.js';
import type { WorkflowRunnerV2ExecutionDescriptor } from './workflow-runner-v2-descriptor.js';

/**
 * Recovery projection for a Go-owned run. The local files remain worker cache
 * and output artifacts; every lifecycle mutation commits to Workflow Control
 * first and only then updates the projection.
 */
export class WorkflowRunnerV2GoProjectionRunStore extends RunStore {
  readonly #descriptor: WorkflowRunnerV2ExecutionDescriptor;
  readonly #authority?: WorkflowControlAuthorityPort;
  #head: Promise<WorkflowControlAuthorityRunRead> | undefined;

  constructor(
    options: {
      readonly baseDir: string;
      readonly descriptor: WorkflowRunnerV2ExecutionDescriptor;
    } & (
      | { readonly mode: 'qualification'; readonly authority?: never }
      | { readonly mode: 'authority'; readonly authority: WorkflowControlAuthorityPort }
    ),
  ) {
    super({ baseDir: options.baseDir });
    this.#descriptor = options.descriptor;
    this.#authority = options.authority;
    if ((options.mode === 'authority') !== (this.#authority !== undefined)) {
      throw new TypeError(
        'Go recovery projection mode and Workflow Control authority must be paired.',
      );
    }
  }

  override async runExists(runId: string): Promise<boolean> {
    const local = await super.runExists(runId);
    if (!this.#authority) return local;
    const remote = await this.#read(runId);
    // A committed created -> running transition may survive a worker crash
    // before its local recovery projection is created. Let initRun rebuild
    // only those two non-terminal initialization states.
    if (!local) {
      if (remote.state === 'created' || remote.state === 'running') return false;
      throw projectionFailure(
        'WORKFLOW_RUNNER_GO_PROJECTION_RECONCILIATION_REQUIRED',
        'Go authority is not safely reconstructable from a missing recovery projection.',
      );
    }
    const status = await super.loadStatus(runId);
    // Retain recovery for projections written by an interrupted older worker
    // before the authority-first ordering was established.
    if (remote.state === 'created' && status?.status === 'running') return false;
    if (!status) {
      throw projectionFailure(
        'WORKFLOW_RUNNER_GO_PROJECTION_RECONCILIATION_REQUIRED',
        'Go-owned recovery projection exists without readable status.',
      );
    }
    if (remote.state !== status.status) {
      if (
        (remote.state === 'paused' ||
          remote.state === 'paused_waiting_approval' ||
          remote.state === 'resuming' ||
          remote.state === 'running') &&
        isRunStatusTransitionAllowed(status.status, remote.state)
      ) {
        await super.transitionStatus(runId, remote.state);
      } else {
        throw projectionFailure(
          'WORKFLOW_RUNNER_GO_PROJECTION_RECONCILIATION_REQUIRED',
          'Go authority head and recovery projection cannot be safely synchronized.',
        );
      }
    }
    return true;
  }

  override async initRun(runId: string, meta: RunMeta): Promise<void> {
    if (!this.#authority) return super.initRun(runId, meta);
    this.#assertRun(runId);
    const remote = await this.#read(runId);
    if (
      (remote.state !== 'created' && remote.state !== 'running') ||
      (remote.state === 'created' && remote.revision !== 1) ||
      remote.resumeGeneration !== 0
    ) {
      throw projectionFailure(
        'WORKFLOW_RUNNER_GO_PROJECTION_RECONCILIATION_REQUIRED',
        'Go-owned run is not at its durable accepted initial head.',
      );
    }
    const projected = await super.runExists(runId);
    if (projected) {
      const [existingMeta, status] = await Promise.all([
        super.loadMeta(runId),
        super.loadStatus(runId),
      ]);
      if (
        existingMeta?.runId !== meta.runId ||
        existingMeta.workflowName !== meta.workflowName ||
        status?.status !== 'running'
      ) {
        throw projectionFailure(
          'WORKFLOW_RUNNER_GO_PROJECTION_RECONCILIATION_REQUIRED',
          'Go-owned recovery projection conflicts with the accepted run.',
        );
      }
    }
    // The Go authority is the writer. Commit its transition before creating
    // any local RunStore-shaped recovery artifact. A crash after this point is
    // closed by the remote=running/local=missing case above.
    if (remote.state === 'created') await this.#transitionRemote(remote, 'running');
    if (!projected) await super.initRun(runId, meta);
  }

  override async transitionStatus(runId: string, newStatus: RunStatus['status']): Promise<void> {
    if (!this.#authority) return super.transitionStatus(runId, newStatus);
    this.#assertRun(runId);
    // Checkpoint, effect, and budget authorities may legitimately advance the
    // same Workflow authority revision while the lifecycle state stays put.
    // A lifecycle CAS must therefore use a fresh head, not the initialization
    // read cached before those runtime bindings completed.
    this.#head = undefined;
    const [remote, local] = await Promise.all([this.#read(runId), super.loadStatus(runId)]);
    if (!local)
      throw projectionFailure(
        'WORKFLOW_RUNNER_GO_PROJECTION_RECONCILIATION_REQUIRED',
        'Go-owned recovery projection is missing its local status cache.',
      );
    if (remote.state === newStatus) {
      if (local.status !== newStatus) await super.transitionStatus(runId, newStatus);
      return;
    }
    if (remote.state !== local.status) {
      throw projectionFailure(
        'WORKFLOW_RUNNER_GO_PROJECTION_RECONCILIATION_REQUIRED',
        'Go authority head and recovery projection lifecycle have drifted.',
      );
    }
    await this.#transitionRemote(remote, newStatus);
    await super.transitionStatus(runId, newStatus);
  }

  async #read(runId: string): Promise<WorkflowControlAuthorityRunRead> {
    this.#assertRun(runId);
    this.#head ??= this.#authority!.readIfExists(runId, this.#descriptor.authorityRoute).then(
      (head) => {
        if (!head) {
          throw projectionFailure(
            'WORKFLOW_RUNNER_GO_PROJECTION_RECONCILIATION_REQUIRED',
            'Go authority run does not exist for the sealed descriptor.',
          );
        }
        return head;
      },
    );
    return this.#head;
  }

  async #transitionRemote(
    head: WorkflowControlAuthorityRunRead,
    state: RunStatus['status'],
  ): Promise<void> {
    const expected: WorkflowControlAuthorityExpectedHead = {
      revision: head.revision,
      state: head.state,
      currentPhaseId: head.currentPhaseId,
      currentPhaseIndex: head.currentPhaseIndex,
      resumeGeneration: head.resumeGeneration,
    };
    const record: WorkflowControlAuthorityRunRecord = {
      ...head.record,
      state,
      revision: head.revision + 1,
    };
    try {
      await this.#authority!.transition(record, expected, this.#descriptor.correlationId);
    } catch (error) {
      this.#head = undefined;
      throw projectionFailure(
        'WORKFLOW_RUNNER_GO_PROJECTION_RECONCILIATION_REQUIRED',
        'Go authority lifecycle transition did not commit.',
        error,
      );
    }
    this.#head = undefined;
  }

  #assertRun(runId: string): void {
    if (runId !== this.#descriptor.workflowRunId) {
      throw projectionFailure(
        'WORKFLOW_RUNNER_GO_PROJECTION_IDENTITY_INVALID',
        'Go recovery projection run does not match the sealed descriptor.',
      );
    }
  }
}

export class WorkflowRunnerGoProjectionError extends Error {
  constructor(
    readonly code:
      | 'WORKFLOW_RUNNER_GO_PROJECTION_RECONCILIATION_REQUIRED'
      | 'WORKFLOW_RUNNER_GO_PROJECTION_IDENTITY_INVALID',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'WorkflowRunnerGoProjectionError';
  }
}

function projectionFailure(
  code: WorkflowRunnerGoProjectionError['code'],
  message: string,
  cause?: unknown,
): WorkflowRunnerGoProjectionError {
  return new WorkflowRunnerGoProjectionError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}
