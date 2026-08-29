import type { RunStatus } from './types.js';
import { RunStore, type RunMeta } from './run-store.js';
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

  constructor(options: {
    readonly baseDir: string;
    readonly descriptor: WorkflowRunnerV2ExecutionDescriptor;
    readonly authority?: WorkflowControlAuthorityPort;
    readonly qualificationOnly?: boolean;
  }) {
    super({ baseDir: options.baseDir });
    this.#descriptor = options.descriptor;
    this.#authority = options.authority;
    const goOwned =
      this.#descriptor.authorityRoute.backend === 'go' && options.qualificationOnly !== true;
    if (goOwned !== (this.#authority !== undefined)) {
      throw new TypeError('Go recovery projection and Workflow Control authority must be paired.');
    }
  }

  override async runExists(runId: string): Promise<boolean> {
    const local = await super.runExists(runId);
    if (!this.#authority) return local;
    const remote = await this.#read(runId);
    // A committed created -> running transition may survive a worker crash
    // before its local recovery projection is created. Let initRun rebuild
    // only those two non-terminal initialization states.
    if (!local) return remote.state !== 'created' && remote.state !== 'running';
    const status = await super.loadStatus(runId);
    // Retain recovery for projections written by an interrupted older worker
    // before the authority-first ordering was established.
    if (remote.state === 'created' && status?.status === 'running') return false;
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
      throw new Error('Go-owned run is not at its durable accepted initial head.');
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
        throw new Error('Go-owned recovery projection conflicts with the accepted run.');
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
    const [remote, local] = await Promise.all([this.#read(runId), super.loadStatus(runId)]);
    if (!local) throw new Error('Go-owned recovery projection is missing its local status cache.');
    if (remote.state === newStatus) {
      if (local.status !== newStatus) await super.transitionStatus(runId, newStatus);
      return;
    }
    if (remote.state !== local.status) {
      throw new Error('Go authority head and recovery projection lifecycle have drifted.');
    }
    await this.#transitionRemote(remote, newStatus);
    await super.transitionStatus(runId, newStatus);
  }

  async #read(runId: string): Promise<WorkflowControlAuthorityRunRead> {
    this.#assertRun(runId);
    return this.#authority!.read(runId, this.#descriptor.authorityRoute);
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
    await this.#authority!.transition(record, expected, this.#descriptor.correlationId);
  }

  #assertRun(runId: string): void {
    if (runId !== this.#descriptor.workflowRunId) {
      throw new Error('Go recovery projection run does not match the sealed descriptor.');
    }
  }
}
