import type { AgentRunRequest, AgentRunState } from './types.js';
import type { AgentRunStore } from './run-store.js';
import { readRunStateSnapshot, RunStateSnapshotChangedError } from './run-store.js';
import { createRunRecorder } from './recorder.js';
import { assertAgentResultSchema } from './schema-validation.js';
import { HarnessAdmissionError, HarnessAdmissionStore, hashHarnessInput } from './harness-admission.js';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Read-only storage guard; missing directories stay missing and aliases never route task records elsewhere. */
export function assertHarnessRunStorage(root: string, runId?: string): void {
  const parts = ['.openslack.local', 'agents', 'runs'];
  if (runId !== undefined) {
    if (!/^RUN-[A-Z0-9-]+$/.test(runId)) throw new Error('Invalid Harness run route');
    parts.push(runId);
  }
  let path = root;
  for (const part of ['', ...parts]) {
    if (part) path = join(path, part);
    try {
      const entry = lstatSync(path);
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Harness run storage is unsafe');
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return;
      throw error;
    }
  }
}

/** Immutable input from a production task resolver, not from dispatch arguments. */
export interface ApprovedHarnessTask {
  taskId: string;
  idempotencyKey?: string;
  principalHash: string;
  sourceDigest?: string;
  principalId?: string;
  executionBuildHash?: string;
  verificationHash?: string;
  deploymentHash?: string;
  baseline: string;
  request: Omit<AgentRunRequest, 'runId'>;
  scope: { readPaths: string[]; writePaths: string[]; forbiddenPaths: string[] };
  outputSchema: unknown;
  timeoutMs: number;
}

export interface HarnessTaskReport { runId: string; reportId: string; summary: string; evidenceRefs: string[] }

export interface HarnessAcceptance {
  outcome: 'verified' | 'rejected' | 'indeterminate';
  summary: string;
  evidenceRefs: string[];
}

/** All effects remain owned by this host; prepare must not prompt or complete the pending run. */
export interface PreparedHarnessExecution {
  execute(signal: AbortSignal): Promise<{ data: unknown; exitConfirmed: true; tokenUsage?: number }>;
  /** Host-owned definitions inspect Git, artifacts, tool evidence and fixed checks; model text is not executable. */
  accept(data: unknown, signal: AbortSignal): Promise<HarnessAcceptance>;
  /** Pure final read guard after authorization awaits; production file executors must detect artifact drift. */
  revalidateAccepted?(): void;
}

export interface HarnessTaskHostOptions {
  identityRoot: string;
  workspaceId: string;
  /** Worker callback servers bind this from trusted deployment, never from MCP arguments. */
  callbackRunId?: string;
  store: AgentRunStore;
  readTask(taskId: string): Promise<ApprovedHarnessTask>;
  /** Must resolve current principal/task/claim permissions independently at each requested phase. */
  authorize(task: ApprovedHarnessTask, phase: 'dispatch' | 'execute' | 'report' | 'accept'): Promise<void>;
  prepare(task: ApprovedHarnessTask, runId: string, signal: AbortSignal): Promise<PreparedHarnessExecution>;
  /** Persist a visible event anchor before exposing the run receipt. */
  publish(state: AgentRunState): Promise<void>;
}

/** Instance-owned admission and execution. No daemon, replay, automatic claim, or task completion. */
export class HarnessTaskHost {
  private readonly admissions: HarnessAdmissionStore;
  private readonly recorder;
  private readonly active = new Map<string, { controller: AbortController; work: Promise<void>; release: () => void }>();
  private readonly uncertainPersistence = new Set<string>();
  private readonly unknownExits = new Set<string>();
  private closing = false;
  private readonly callbackRunId: string | undefined;

  constructor(private readonly options: HarnessTaskHostOptions) {
    assertHarnessRunStorage(options.identityRoot);
    this.callbackRunId = options.callbackRunId;
    this.admissions = new HarnessAdmissionStore(options.identityRoot);
    this.recorder = createRunRecorder(options.store, options.identityRoot);
  }

  /** Returns durable admission, never an unverified business-completion receipt. requestId is correlation only. */
  async dispatch(taskId: string, requestId: string, waitForCommittedConfirmation = false): Promise<{ taskId: string; runId: string; status: AgentRunState['status']; acceptance: string }> {
    if (this.callbackRunId) throw new Error('Worker callbacks cannot dispatch another task');
    if (this.closing) throw new Error('Harness task host is closing');
    if (!safeId(taskId) || !safeId(requestId)) throw new TypeError('Invalid task or request ID');
    const task = structuredClone(await this.options.readTask(taskId));
    if (task.taskId !== taskId || !/^[a-f0-9]{64}$/.test(task.principalHash) ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(task.baseline) || !Number.isSafeInteger(task.timeoutMs) || task.timeoutMs <= 0) {
      throw new TypeError('Approved task input is invalid');
    }
    const requestHash = hashHarnessTask(task);
    await this.options.authorize(structuredClone(task), 'dispatch');
    if (this.closing) throw new Error('Harness task host is closing');
    const key = hashHarnessInput([this.options.workspaceId, task.taskId, task.idempotencyKey ?? taskId]);
    const admission = this.admissions.admit(key, requestHash);
    const { runId } = admission.record;
    if (!admission.created) {
      const existing = await this.waitForVisibleAdmission(runId, requestHash);
      return { taskId, runId, status: existing.status, acceptance: existing.harnessExecution.acceptance };
    }
    const request = { ...task.request, runId };
    if (this.read(runId)) throw new HarnessAdmissionError('INDETERMINATE', 'Canonical run already exists');
    this.options.store.createRun(request);
    const state = this.options.store.updateRun(runId, { harnessExecution: {
      schema: 'openslack.harness_execution.v1', taskId, requestHash, principalHash: task.principalHash,
      baseline: task.baseline, acceptance: 'pending', summary: 'Task admitted; execution and acceptance are pending.',
      evidenceRefs: [], reports: {}, visible: false,
    } });
    this.recorder.progress(runId, { step: 'harness_admitted', taskId, requestId, requestHash });
    await this.options.publish(state);
    this.admissions.withRunLock(runId, () => {
      const current = this.boundRun(runId, task);
      this.options.store.updateRun(runId, { harnessExecution: { ...current.harnessExecution!, visible: true } });
    });
    if (this.closing) return { taskId, runId, status: 'pending', acceptance: 'pending' };
    const controller = new AbortController();
    // Release the governed admission response before expensive preparation. The promise remains
    // owned immediately, including the scheduled-before-start cancellation window.
    let release!: () => void;
    const work = new Promise<void>(resolve => { release = resolve; })
      .then(() => this.execute(task, runId, controller))
      .catch(() => { this.uncertainPersistence.add(runId); })
      .finally(() => { this.active.delete(runId); });
    this.active.set(runId, { controller, work, release });
    if (!waitForCommittedConfirmation) this.releaseConfirmedAdmission(runId);
    return { taskId, runId, status: 'pending', acceptance: 'pending' };
  }

  /** Trusted post-confirmation hook. Only this instance's owned admission can start; historical runs are never reconstructed. */
  releaseConfirmedAdmission(runId: string): void {
    const owned = this.active.get(runId);
    if (!owned || this.closing) return;
    setImmediate(owned.release);
  }

  /** Current-task progress only. Never accepts an acceptance or completion status from the caller. */
  async report(input: HarnessTaskReport): Promise<{ runId: string; reportId: string; recorded: true }> {
    const report = structuredClone(input);
    if (this.closing || !this.callbackRunId || report.runId !== this.callbackRunId) {
      throw new Error('Report is not bound to this worker callback host');
    }
    if (Object.keys(report).sort().join(',') !== 'evidenceRefs,reportId,runId,summary' ||
      !safeId(report.reportId) || typeof report.summary !== 'string' || Buffer.byteLength(report.summary) > 4096 ||
      !Array.isArray(report.evidenceRefs) || report.evidenceRefs.length > 32 ||
      report.evidenceRefs.some(ref => typeof ref !== 'string' || !/^[a-z][a-z0-9-]*:[A-Za-z0-9._/-]{1,256}$/.test(ref))) {
      throw new TypeError('Invalid current-task report');
    }
    const before = this.read(report.runId);
    if (!before?.harnessExecution) throw new Error('Run is not a bound Harness task');
    const task = structuredClone(await this.options.readTask(before.harnessExecution.taskId));
    await this.options.authorize(structuredClone(task), 'report');
    this.admissions.withRunLock(report.runId, () => {
      const state = this.boundRun(report.runId, task);
      this.assertReportCurrent(state, task);
      const binding = state.harnessExecution!;
      const hash = hashHarnessInput(report);
      const existing = Object.hasOwn(binding.reports, report.reportId) ? binding.reports[report.reportId] : undefined;
      if (existing) {
        if (existing !== hash) throw new HarnessAdmissionError('CONFLICT', 'Report ID already binds different evidence');
        return;
      }
      if (!['pending', 'running'].includes(state.status) || binding.acceptance !== 'pending' ||
        Object.keys(binding.reports).length >= 128) throw new Error('Task no longer accepts progress');
      this.recorder.progress(report.runId, { step: 'harness_task_report', ...report });
      this.options.store.updateRun(report.runId, { harnessExecution: { ...binding, summary: report.summary,
        evidenceRefs: [...new Set([...binding.evidenceRefs, ...report.evidenceRefs])].slice(-128),
        reports: { ...binding.reports, [report.reportId]: hash },
      } });
    });
    return { runId: report.runId, reportId: report.reportId, recorded: true };
  }

  /** Bounded, maintenance-free read. Restart reconciliation never creates a store, Session, or prompt. */
  read(runId: string): AgentRunState | null {
    // Atomic writers may replace/unlink an opened inode during observation.
    // Re-read only rejected version-conflict snapshots, with every check intact;
    // this path never admits, repairs, publishes, or executes any work.
    let conflict: RunStateSnapshotChangedError | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      assertHarnessRunStorage(this.options.identityRoot, runId);
      try { return readRunStateSnapshot(runId, this.options.identityRoot); }
      catch (error) {
        if (!(error instanceof RunStateSnapshotChangedError) || error.runId !== runId) throw error;
        conflict = error;
      }
    }
    throw conflict;
  }

  /** Preview/confirm binding only; no admission, execution, or task-state mutation. */
  async observe(target: 'harness.task.dispatch' | 'harness.task.report', input: Readonly<Record<string, unknown>>): Promise<Readonly<Record<string, unknown>>> {
    const value = structuredClone(input);
    if (this.closing) throw new Error('Harness host is closing');
    let taskId: string;
    if (target === 'harness.task.dispatch') {
      if (this.callbackRunId || Object.keys(value).sort().join(',') !== 'requestId,taskId' ||
        !safeId(value.taskId) || !safeId(value.requestId)) throw new TypeError('Invalid task dispatch intent');
      taskId = value.taskId;
    } else {
      if (!this.callbackRunId || value.runId !== this.callbackRunId ||
        Object.keys(value).sort().join(',') !== 'evidenceRefs,reportId,runId,summary' ||
        !safeId(value.reportId) || typeof value.summary !== 'string' || Buffer.byteLength(value.summary) > 4096 ||
        !Array.isArray(value.evidenceRefs) || value.evidenceRefs.length > 32 ||
        value.evidenceRefs.some(ref => typeof ref !== 'string' || !/^[a-z][a-z0-9-]*:[A-Za-z0-9._/-]{1,256}$/.test(ref))) {
        throw new TypeError('Invalid current-task report intent');
      }
      const run = this.read(this.callbackRunId);
      if (!run?.harnessExecution || !['pending', 'running'].includes(run.status)) throw new Error('Callback run is not writable');
      taskId = run.harnessExecution.taskId;
    }
    const task = structuredClone(await this.options.readTask(taskId));
    if (task.taskId !== taskId) throw new Error('Approved task source returned another task');
    await this.options.authorize(structuredClone(task), target === 'harness.task.dispatch' ? 'dispatch' : 'report');
    if (target === 'harness.task.report') this.assertReportCurrent(this.boundRun(this.callbackRunId!, task), task);
    const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
    const source = createHash('sha256');
    for (const name of ['harness', 'harness-task-host', 'harness-admission', 'bridge-adapter', 'deepseek-harness-provider',
      'harness-task-authority', 'harness-task-execution', 'harness-deployment', 'harness-artifacts', 'harness-permissions', 'harness-reconciliation', 'recorder', 'run-store', 'permissions', 'schema-validation', 'sensitive-data', 'types']) {
      source.update(readFileSync(new URL(`./${name}.${extension}`, import.meta.url)));
    }
    return Object.freeze({ target, taskId, taskHash: hashHarnessTask(task), principalHash: task.principalHash,
      baseline: task.baseline, hostSourceHash: source.digest('hex') });
  }

  /** Stop admission and request cancellation. Unknown quiescence is reported, never called cancelled. */
  async close(timeoutMs: number): Promise<{ stopped: boolean; unknownRunIds: string[] }> {
    this.closing = true;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError('Close timeout must be positive');
    for (const [runId, { controller, release }] of this.active) {
      try {
        this.admissions.withRunLock(runId, () => {
          const state = this.read(runId);
          if (!state?.harnessExecution || !['pending', 'running'].includes(state.status) || state.harnessExecution.stopRequestedAt) return;
          this.options.store.updateRun(runId, { harnessExecution: { ...state.harnessExecution,
            stopRequestedAt: new Date().toISOString(), summary: 'Cancellation requested; process and side effects are not yet confirmed.' } });
          this.recorder.progress(runId, { step: 'harness_cancel_requested' });
        });
      } catch { this.uncertainPersistence.add(runId); }
      controller.abort(new Error('Harness host closing'));
      release();
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled([...this.active.values()].map(item => item.work)),
        new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
    const unknownRunIds = [...new Set([...this.active.keys(), ...this.uncertainPersistence, ...this.unknownExits])];
    return { stopped: unknownRunIds.length === 0, unknownRunIds };
  }

  private boundRun(runId: string, task: ApprovedHarnessTask): AgentRunState {
    const state = this.read(runId);
    if (!state?.harnessExecution || state.harnessExecution.taskId !== task.taskId ||
      state.harnessExecution.requestHash !== hashHarnessTask(task) ||
      state.harnessExecution.principalHash !== task.principalHash) throw new Error('Task input or principal binding changed');
    return state;
  }

  private assertReportCurrent(state: AgentRunState, task: ApprovedHarnessTask): void {
    const deadline = Date.parse(state.startedAt) + task.timeoutMs;
    if (state.harnessExecution?.stopRequestedAt || !['pending', 'running'].includes(state.status) || !Number.isFinite(deadline) || Date.now() >= deadline) {
      throw new Error('Harness callback deadline expired; preserve and reconcile read-only');
    }
  }

  private async waitForVisibleAdmission(runId: string, requestHash: string): Promise<AgentRunState & { harnessExecution: NonNullable<AgentRunState['harnessExecution']> }> {
    // Concurrent admissions may observe the owner between its exclusive route and its visible-anchor
    // commit. Wait only for that receipt; never execute, publish, repair, or replace the owner's work.
    for (let attempt = 0; attempt < 40 && !this.closing; attempt++) {
      let state: AgentRunState | null = null;
      try { state = this.read(runId); }
      catch (error) {
        if (!(error instanceof RunStateSnapshotChangedError) || error.runId !== runId) throw error;
      }
      if (state?.harnessExecution?.requestHash === requestHash && state.harnessExecution.visible === true) {
        return { ...state, harnessExecution: state.harnessExecution };
      }
      if (state?.harnessExecution && state.harnessExecution.requestHash !== requestHash) break;
      await new Promise<void>(resolve => setTimeout(resolve, 25));
    }
    throw new HarnessAdmissionError('INDETERMINATE', 'Admission exists without a matching visible canonical run; do not redispatch');
  }

  private async execute(task: ApprovedHarnessTask, runId: string, controller: AbortController): Promise<void> {
    const deadline = Date.parse(this.read(runId)?.startedAt ?? '') + task.timeoutMs;
    const check = (): void => {
      if (!Number.isFinite(deadline) || Date.now() >= deadline) controller.abort(new Error('Harness total deadline exceeded'));
      controller.signal.throwIfAborted();
    };
    const timer = setTimeout(() => controller.abort(new Error('Harness total deadline exceeded')), Math.max(1, deadline - Date.now()));
    let started = false;
    let exitConfirmed = false;
    try {
      await this.options.authorize(structuredClone(task), 'execute');
      check();
      this.boundRun(runId, structuredClone(await this.options.readTask(task.taskId)));
      const execution = await this.options.prepare(structuredClone(task), runId, controller.signal);
      await this.options.authorize(structuredClone(task), 'execute');
      this.boundRun(runId, structuredClone(await this.options.readTask(task.taskId)));
      check();
      this.admissions.withRunLock(runId, () => {
        this.boundRun(runId, task);
        this.options.store.updateRun(runId, { status: 'running' });
        this.recorder.progress(runId, { step: 'harness_execution_started' });
      });
      started = true;
      const result = await execution.execute(controller.signal);
      if (result.exitConfirmed !== true) throw new Error('Harness process exit is unconfirmed');
      exitConfirmed = true;
      this.admissions.withRunLock(runId, () => {
        const current = this.boundRun(runId, task);
        this.options.store.updateRun(runId, { harnessExecution: { ...current.harnessExecution!, processExit: 'confirmed' } });
      });
      check();
      assertAgentResultSchema(result.data, task.outputSchema);
      await this.options.authorize(structuredClone(task), 'accept');
      this.boundRun(runId, structuredClone(await this.options.readTask(task.taskId)));
      const acceptance = await execution.accept(result.data, controller.signal);
      await this.options.authorize(structuredClone(task), 'accept');
      this.boundRun(runId, structuredClone(await this.options.readTask(task.taskId)));
      check();
      if (acceptance.outcome === 'verified') execution.revalidateAccepted?.();
      check();
      this.admissions.withRunLock(runId, () => {
        const state = this.boundRun(runId, task);
        this.options.store.updateRun(runId, { harnessExecution: { ...state.harnessExecution!,
          acceptance: acceptance.outcome, summary: acceptance.summary, evidenceRefs: [...acceptance.evidenceRefs],
        } });
        if (acceptance.outcome !== 'verified') throw new Error('Host acceptance did not verify this task');
        this.recorder.complete(runId, result.data, result.tokenUsage);
      });
    } catch {
      if (started && !exitConfirmed) this.unknownExits.add(runId);
      // Do not copy untrusted provider messages into durable diagnostics or call an unknown exit cancelled.
      this.admissions.withRunLock(runId, () => {
        const state = this.read(runId);
        if (!state?.harnessExecution) return;
        const acceptance = state.harnessExecution.acceptance === 'pending' ? 'indeterminate' : state.harnessExecution.acceptance;
        this.options.store.updateRun(runId, { harnessExecution: { ...state.harnessExecution, acceptance,
          summary: 'Execution stopped without verified acceptance; preserve artifacts and reconcile without replay.',
        } });
        this.recorder.fail(runId, new Error('Harness task did not reach verified acceptance'), 'EXECUTION_FAILED');
      });
    } finally { clearTimeout(timer); }
  }
}

/** Semantic input hash shared by admission and live tool authorization. */
export function hashHarnessTask(task: ApprovedHarnessTask): string {
  return hashHarnessInput({ ...task, idempotencyKey: task.idempotencyKey ?? task.taskId,
    request: { ...task.request, correlationId: undefined, worktreePath: undefined },
  });
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}
