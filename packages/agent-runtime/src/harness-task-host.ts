import type { AgentRunRequest, AgentRunState, AgentRunEvent } from './types.js';
import type { AgentRunStore } from './run-store.js';
import { readRunStateSnapshot, readRunStateSnapshotWhenAvailable, RunStateSnapshotChangedError } from './run-store.js';
import { assertAgentResultSchema } from './schema-validation.js';
import { HarnessAdmissionError, HarnessAdmissionStore, hashHarnessInput, type HarnessAdmissionRecord } from './harness-admission.js';
import { assertHarnessNotStopped, publishHarnessStopIntent, readHarnessStopIntent, type HarnessStopIntent } from './harness-stop.js';
import { canonicalHarnessRoot } from './harness-read.js';
import { HarnessHostSourceObserver } from './harness-source.js';
import { assertHarnessTaskEligibility, type HarnessEligibilityPhase, type HarnessTaskEligibility } from './harness-eligibility.js';
import { validateRunId } from './run-id.js';
import { randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Read-only storage guard; it never creates missing storage. */
export function assertHarnessRunStorage(root: string, runId?: string): void {
  const parts = ['.openslack.local', 'agents', 'runs'];
  if (runId !== undefined) { validateRunId(runId); parts.push(runId); }
  let path = root;
  for (const part of ['', ...parts]) {
    if (part) path = join(path, part);
    try { const entry = lstatSync(path); if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Harness run storage is unsafe'); }
    catch (error) { if (isCode(error, 'ENOENT')) return; throw error; }
  }
}
export interface ApprovedHarnessTask {
  taskId: string; idempotencyKey?: string; principalHash: string; sourceDigest?: string; principalId?: string;
  executionBuildHash?: string; verificationHash?: string; deploymentHash?: string; baseline: string;
  request: Omit<AgentRunRequest, 'runId'>;
  scope: { readPaths: string[]; writePaths: string[]; forbiddenPaths: string[] };
  outputSchema: unknown; timeoutMs: number;
}
export interface HarnessTaskReport { runId: string; reportId: string; summary: string; evidenceRefs: string[] }
export interface HarnessAcceptance { outcome: 'verified' | 'rejected' | 'indeterminate'; summary: string; evidenceRefs: string[] }
export interface PreparedHarnessExecution {
  execute(signal: AbortSignal, eligibility?: HarnessTaskEligibility): Promise<{ data: unknown; exitConfirmed: true; tokenUsage?: number }>;
  accept(data: unknown, signal: AbortSignal, eligibility?: HarnessTaskEligibility): Promise<HarnessAcceptance>;
  revalidateAccepted?(): void;
}
export interface HarnessGovernedBinding { planId: string; executionId: string; confirmationAttemptId?: string }
export interface HarnessTaskHostOptions {
  identityRoot: string; workspaceId: string; principalId?: string; callbackRunId?: string; store: AgentRunStore;
  readTask(taskId: string): Promise<ApprovedHarnessTask>;
  authorize(task: ApprovedHarnessTask, phase: HarnessEligibilityPhase): Promise<void | HarnessTaskEligibility>;
  /** May prepare host worktree/bindings, never start SDK, peer, model or a tool-capable process. */
  prepare(task: ApprovedHarnessTask, runId: string, signal: AbortSignal): Promise<PreparedHarnessExecution>;
  publish(state: AgentRunState): Promise<void>;
}
export interface HarnessTaskReceipt {
  taskId: string; runId: string; status: AgentRunState['status']; acceptance: string;
  disposition?: 'preserve_and_reconcile';
}
interface OwnedAdmission {
  task: ApprovedHarnessTask; route: HarnessAdmissionRecord; controller: AbortController;
  work: Promise<void>; release: () => void; ready: ReturnType<typeof Promise.withResolvers<HarnessTaskReceipt>>;
  governed?: HarnessGovernedBinding; started: boolean; exitConfirmed: boolean;
  dispatchEligibility?: HarnessTaskEligibility;
  stopReason?: HarnessStopIntent['reason'];
  timer: ReturnType<typeof setTimeout>;
}

const event = (type: AgentRunEvent['type'], data: Record<string, unknown>): AgentRunEvent => ({ timestamp: new Date().toISOString(), type, data });

/** Instance-owned execution; persistent routing never authorizes historical replay. */
export class HarnessTaskHost {
  private readonly options: HarnessTaskHostOptions;
  private readonly admissions: HarnessAdmissionStore;
  private readonly active = new Map<string, OwnedAdmission>();
  private readonly uncertainPersistence = new Set<string>();
  private readonly unknownExits = new Set<string>();
  private closing = false;
  private readonly sourceObserver = new HarnessHostSourceObserver(dirname(fileURLToPath(import.meta.url)), import.meta.url.endsWith('.ts') ? '.ts' : '.js');

  constructor(options: HarnessTaskHostOptions) {
    this.options = { ...options, identityRoot: canonicalHarnessRoot(options.identityRoot) };
    assertHarnessRunStorage(this.options.identityRoot);
    this.admissions = new HarnessAdmissionStore(this.options.identityRoot);
  }

  governanceBinding(): Readonly<{ identityRoot: string; workspaceId: string; principalId?: string; targets: readonly string[] }> {
    return Object.freeze({ identityRoot: this.options.identityRoot, workspaceId: this.options.workspaceId, principalId: this.options.principalId,
      targets: Object.freeze([this.options.callbackRunId ? 'harness.task.report' : 'harness.task.dispatch']) });
  }

  async dispatch(taskId: string, requestId: string, waitForCommittedConfirmation = false, governed?: HarnessGovernedBinding): Promise<HarnessTaskReceipt> {
    if (this.options.callbackRunId) throw new Error('Worker callbacks cannot dispatch another task');
    if (this.closing) throw new Error('Harness task host is closing');
    if (!safeId(taskId) || !safeId(requestId)) throw new TypeError('Invalid task or request ID');
    const governedIntent = waitForCommittedConfirmation && governed && safeId(governed.planId) && governed.planId.startsWith('GPLAN-') &&
      safeId(governed.executionId) && governed.executionId.startsWith('GEXEC-') && safeId(governed.confirmationAttemptId);
    if (this.options.principalId && !governedIntent) throw new Error('Principal-bound Harness dispatch requires its originating governed confirmation binding');
    const task = structuredClone(await this.options.readTask(taskId));
    if (task.principalId && !governedIntent) throw new Error('Principal-bound Harness task requires its originating governed confirmation binding');
    if (task.taskId !== taskId || !/^[a-f0-9]{64}$/.test(task.principalHash) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(task.baseline) ||
      !Number.isSafeInteger(task.timeoutMs) || task.timeoutMs <= 0) throw new TypeError('Approved task input is invalid');
    const eligibility = await this.options.authorize(structuredClone(task), 'dispatch');
    const checkEligibility = this.eligibility(eligibility, task, 'dispatch');
    checkEligibility();
    if (this.closing) throw new Error('Harness task host is closing');
    assertHarnessRunStorage(this.options.identityRoot);
    const requestHash = hashHarnessTask(task);
    const admittedAt = new Date().toISOString();
    checkEligibility();
    const admission = this.admissions.admit(hashHarnessInput([this.options.workspaceId, taskId, task.idempotencyKey ?? taskId]), requestHash, {
      ownerGeneration: randomUUID(), admittedAt, deadlineAt: new Date(Date.parse(admittedAt) + task.timeoutMs).toISOString(),
    });
    if (!admission.created) return this.receipt(taskId, await this.waitForVisibleAdmission(admission.record));
    const ready = Promise.withResolvers<HarnessTaskReceipt>();
    const done = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const route = admission.record;
    const owned: OwnedAdmission = { task, route, ready, work: done.promise, release: gate.resolve, controller: new AbortController(),
      started: false, exitConfirmed: false, ...(governed ? { governed: structuredClone(governed) } : {}),
      ...(eligibility ? { dispatchEligibility: eligibility } : {}),
      timer: setTimeout(() => this.stopOwned(owned, 'deadline'), Math.max(1, Date.parse(route.deadlineAt!) - Date.now())),
    };
    // Register before create/publish can throw or await. close owns the entire acceptance, not only execute.
    this.active.set(route.runId, owned);
    void this.ownAdmission(owned, gate.promise, waitForCommittedConfirmation).catch(error => {
      this.uncertainPersistence.add(route.runId); ready.reject(error);
    }).finally(() => { clearTimeout(owned.timer); this.active.delete(route.runId); done.resolve(); });
    return ready.promise;
  }

  /** Trusted completion observer. It starts only this process's route bound to the real execution identity. */
  settleConfirmedAdmissions(planId: string, result: { state: string; executionId?: string; confirmationAttemptId?: string }): void {
    for (const owned of this.active.values()) {
      if (owned.governed?.planId !== planId) continue;
      if (owned.governed.confirmationAttemptId !== result.confirmationAttemptId) continue;
      if (result.state === 'succeeded' && result.executionId === owned.governed.executionId) this.authorizeOwned(owned);
      else this.stopOwned(owned, 'confirmation_failed');
    }
  }

  /** Trusted fixture/non-governed host path; it never activates a historical route. */
  releaseConfirmedAdmission(runId: string): void {
    const owned = this.active.get(runId);
    if (owned && !owned.governed) this.authorizeOwned(owned);
  }

  private authorizeOwned(owned: OwnedAdmission): void {
    if (this.closing || owned.controller.signal.aborted) return;
    try {
      const checkEligibility = this.eligibility(owned.dispatchEligibility, owned.task, 'dispatch');
      this.options.store.withRunTransaction(owned.route.runId, state => {
        const current = this.boundState(state, owned.task);
        this.checkOwned(owned, current);
        checkEligibility();
        const binding = current.harnessExecution!;
        const lifecycle = binding.lifecycle;
        if (!lifecycle || lifecycle.ownerGeneration !== owned.route.ownerGeneration || lifecycle.phase !== 'awaiting_confirmation') {
          if (binding.lifecycle?.phase === 'authorized' || binding.lifecycle?.phase === 'started') return {};
          throw new Error('Admission no longer awaits this confirmation');
        }
        return { patch: { harnessExecution: { ...binding, lifecycle: { ...lifecycle, phase: 'authorized' } } }, beforePublish: () => { this.checkOwned(owned, current); checkEligibility(); } };
      });
      setImmediate(owned.release);
    } catch { this.stopOwned(owned, 'confirmation_failed'); }
  }

  private async ownAdmission(owned: OwnedAdmission, gate: Promise<void>, governed: boolean): Promise<void> {
    const { task, route } = owned;
    try {
      const checkEligibility = this.eligibility(owned.dispatchEligibility, task, 'dispatch');
      checkEligibility();
      assertHarnessRunStorage(this.options.identityRoot, route.runId);
      this.options.store.createRun({ ...task.request, runId: route.runId });
      const state = this.options.store.withRunTransaction(route.runId, () => ({ patch: { startedAt: route.admittedAt!, harnessExecution: {
        schema: 'openslack.harness_execution.v1', taskId: task.taskId, requestHash: route.requestHash, principalHash: task.principalHash,
        baseline: task.baseline, acceptance: 'pending', summary: 'Task admitted; execution and acceptance are pending.', evidenceRefs: [], reports: {}, visible: false,
        lifecycle: { ownerGeneration: route.ownerGeneration!, deadlineAt: route.deadlineAt!, phase: 'awaiting_confirmation',
          ...(owned.governed ? { governed: owned.governed } : {}) }, evidence: { reservedBytes: 0, calls: {} },
      } }, events: [event('progress', { step: 'harness_admitted', taskId: task.taskId, requestHash: route.requestHash })], beforePublish: checkEligibility }));
      this.checkOwned(owned, state);
      await this.options.publish(state);
      this.checkOwned(owned);
      const visible = this.options.store.withRunTransaction(route.runId, current => {
        this.checkOwned(owned, this.boundState(current, task));
        return { patch: { harnessExecution: { ...current.harnessExecution!, visible: true } } };
      });
      owned.ready.resolve(this.receipt(task.taskId, visible));
      // Compatibility is deliberately confined to a trusted fixture host whose
      // configuration and task have no production principal binding.
      if (!governed) this.authorizeOwned(owned);
      await gate;
      this.checkOwned(owned);
      await this.execute(owned);
    } catch (error) {
      owned.ready.reject(error);
      this.failOwned(owned, owned.stopReason ?? 'execution_failed');
    }
  }

  async report(input: HarnessTaskReport): Promise<{ runId: string; reportId: string; recorded: true }> {
    const report = structuredClone(input);
    if (this.closing || !this.options.callbackRunId || report.runId !== this.options.callbackRunId) throw new Error('Report is not bound to this worker callback host');
    this.validateReport(report);
    const before = await this.readCurrent(report.runId);
    if (!before?.harnessExecution) throw new Error('Run is not a bound Harness task');
    const task = structuredClone(await this.options.readTask(before.harnessExecution.taskId));
    const eligibility = await this.options.authorize(structuredClone(task), 'report');
    const checkEligibility = this.eligibility(eligibility, task, 'report');
    this.options.store.withRunTransaction(report.runId, state => {
      this.boundState(state, task); this.assertReportCurrent(state, task);
      checkEligibility();
      const binding = state.harnessExecution!;
      const hash = hashHarnessInput(report);
      const existing = Object.hasOwn(binding.reports, report.reportId) ? binding.reports[report.reportId] : undefined;
      if (existing) { if (existing !== hash) throw new HarnessAdmissionError('CONFLICT', 'Report ID already binds different evidence'); return {}; }
      if (binding.acceptance !== 'pending' || Object.keys(binding.reports).length >= 128) throw new Error('Task no longer accepts progress');
      return { patch: { harnessExecution: { ...binding, summary: report.summary,
        evidenceRefs: [...new Set([...binding.evidenceRefs, ...report.evidenceRefs])].slice(-128), reports: { ...binding.reports, [report.reportId]: hash },
      } }, events: [event('progress', { step: 'harness_task_report', ...report })],
      beforePublish: () => { this.assertReportCurrent(state, task); checkEligibility(); } };
    });
    return { runId: report.runId, reportId: report.reportId, recorded: true };
  }

  read(runId: string): AgentRunState | null {
    let conflict: RunStateSnapshotChangedError | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      assertHarnessRunStorage(this.options.identityRoot, runId);
      try { return readRunStateSnapshot(runId, this.options.identityRoot); }
      catch (error) { if (!(error instanceof RunStateSnapshotChangedError) || error.runId !== runId) throw error; conflict = error; }
    }
    throw conflict;
  }

  async observe(target: 'harness.task.dispatch' | 'harness.task.report', input: Readonly<Record<string, unknown>>): Promise<Readonly<Record<string, unknown>>> {
    const value = structuredClone(input);
    if (this.closing) throw new Error('Harness host is closing');
    let taskId: string;
    if (target === 'harness.task.dispatch') {
      if (this.options.callbackRunId || Object.keys(value).sort().join(',') !== 'requestId,taskId' || !safeId(value.taskId) || !safeId(value.requestId)) throw new TypeError('Invalid task dispatch intent');
      taskId = value.taskId;
    } else {
      if (!this.options.callbackRunId || value.runId !== this.options.callbackRunId) throw new TypeError('Invalid current-task report intent');
      this.validateReport(value);
      const state = await this.readCurrent(this.options.callbackRunId);
      if (!state?.harnessExecution || !['pending', 'running'].includes(state.status)) throw new Error('Callback run is not writable');
      taskId = state.harnessExecution.taskId;
    }
    const task = structuredClone(await this.options.readTask(taskId));
    if (task.taskId !== taskId || (this.options.principalId && task.principalId !== this.options.principalId)) throw new Error('Approved task source returned another task or principal');
    await this.options.authorize(structuredClone(task), target === 'harness.task.dispatch' ? 'dispatch' : 'report');
    if (target === 'harness.task.report') this.assertReportCurrent(this.boundState((await this.readCurrent(this.options.callbackRunId!))!, task), task);
    const source = this.observeSource();
    return Object.freeze({ target, taskId, taskHash: hashHarnessTask(task), principalHash: task.principalHash,
      ...(task.principalId ? { principalId: task.principalId } : {}), baseline: task.baseline, hostSourceHash: source.hash, hostSourceDomain: source.domain });
  }

  async close(timeoutMs: number): Promise<{ stopped: boolean; unknownRunIds: string[] }> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError('Close timeout must be positive');
    this.closing = true;
    for (const owned of this.active.values()) this.stopOwned(owned, 'closing');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([Promise.allSettled([...this.active.values()].map(value => value.work)), new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); })]); }
    finally { if (timer) clearTimeout(timer); }
    const unknownRunIds = [...new Set([...this.active.keys(), ...this.uncertainPersistence, ...this.unknownExits])];
    return { stopped: unknownRunIds.length === 0, unknownRunIds };
  }

  private checkOwned(owned: OwnedAdmission, state?: Readonly<AgentRunState>): void {
    if (Date.now() >= Date.parse(owned.route.deadlineAt!)) { owned.stopReason ??= 'deadline'; owned.controller.abort(new Error('Harness total deadline exceeded')); }
    if (this.closing) { owned.stopReason ??= 'closing'; owned.controller.abort(new Error('Harness host closing')); }
    owned.controller.signal.throwIfAborted();
    if (state) assertHarnessNotStopped(this.options.identityRoot, state);
    else if (readHarnessStopIntent(this.options.identityRoot, owned.route.runId)) throw new Error('Harness stop requested');
  }

  private stopOwned(owned: OwnedAdmission, reason: HarnessStopIntent['reason']): void {
    if (owned.exitConfirmed) {
      try { if (this.read(owned.route.runId)?.status === 'completed') return; }
      catch { /* Unconfirmed persistence remains a stop, never a guessed success. */ }
    }
    owned.stopReason ??= reason;
    owned.controller.abort(new Error('Harness execution stopped; preserve and reconcile'));
    owned.release();
    try { publishHarnessStopIntent(this.options.identityRoot, { schema: 'openslack.harness_stop_intent.v1', runId: owned.route.runId,
      requestHash: owned.route.requestHash, ownerGeneration: owned.route.ownerGeneration!, reason: owned.stopReason, requestedAt: new Date().toISOString() }); }
    catch { this.uncertainPersistence.add(owned.route.runId); }
    this.failOwned(owned, owned.stopReason);
  }

  private failOwned(owned: OwnedAdmission, reason: HarnessStopIntent['reason']): void {
    if (owned.started && !owned.exitConfirmed) this.unknownExits.add(owned.route.runId);
    try {
      if (!readHarnessStopIntent(this.options.identityRoot, owned.route.runId)) publishHarnessStopIntent(this.options.identityRoot, {
        schema: 'openslack.harness_stop_intent.v1', runId: owned.route.runId, requestHash: owned.route.requestHash,
        ownerGeneration: owned.route.ownerGeneration!, reason, requestedAt: new Date().toISOString(),
      });
      this.options.store.withRunTransaction(owned.route.runId, state => {
        const binding = state.harnessExecution;
        if (!binding || ['completed', 'failed', 'cancelled'].includes(state.status)) return {};
        return { patch: { status: 'failed', completedAt: new Date().toISOString(), failureCode: 'EXECUTION_FAILED',
          errorSummary: 'Harness task did not reach verified acceptance', error: 'Harness task did not reach verified acceptance', harnessExecution: { ...binding,
            acceptance: binding.acceptance === 'pending' ? 'indeterminate' : binding.acceptance, stopRequestedAt: new Date().toISOString(),
            summary: 'Execution stopped without verified acceptance; preserve artifacts and reconcile without replay.',
            ...(binding.lifecycle ? { lifecycle: { ...binding.lifecycle, phase: owned.started ? 'indeterminate' as const : 'stopped_before_start' as const } } : {}),
          } }, events: [event('fail', { failureCode: 'EXECUTION_FAILED', reason })] };
      });
    } catch { this.uncertainPersistence.add(owned.route.runId); }
  }

  private async execute(owned: OwnedAdmission): Promise<void> {
    const { task, route, controller } = owned;
    const preparationEligibility = await this.options.authorize(structuredClone(task), 'execute');
    this.checkOwned(owned);
    this.boundState((await this.readCurrent(route.runId))!, structuredClone(await this.options.readTask(task.taskId)));
    this.eligibility(preparationEligibility, task, 'execute')();
    const execution = await this.options.prepare(structuredClone(task), route.runId, controller.signal);
    const startEligibility = await this.options.authorize(structuredClone(task), 'execute');
    const checkStartEligibility = this.eligibility(startEligibility, task, 'execute');
    this.boundState((await this.readCurrent(route.runId))!, structuredClone(await this.options.readTask(task.taskId)));
    this.checkOwned(owned);
    this.options.store.withRunTransaction(route.runId, state => {
      this.boundState(state, task); this.checkOwned(owned, state);
      checkStartEligibility();
      const cutoff = Date.parse(state.harnessExecution!.lifecycle?.executionDeadlineAt ?? state.harnessExecution!.lifecycle!.deadlineAt);
      if (!Number.isFinite(cutoff) || Date.now() >= cutoff) throw new Error('Harness business cutoff elapsed before execution start');
      if (state.harnessExecution!.lifecycle?.phase !== 'authorized') throw new Error('Execution lacks durable confirmation');
      return { patch: { status: 'running', harnessExecution: { ...state.harnessExecution!, lifecycle: { ...state.harnessExecution!.lifecycle!, phase: 'started' } } },
        events: [event('progress', { step: 'harness_execution_started' })], beforePublish: () => { this.checkOwned(owned, state); checkStartEligibility(); if (Date.now() >= cutoff) throw new Error('Harness business cutoff elapsed before execution publication'); } };
    });
    this.checkOwned(owned);
    checkStartEligibility();
    owned.started = true;
    const result = await execution.execute(controller.signal, startEligibility || undefined);
    if (result.exitConfirmed !== true) throw new Error('Harness process exit is unconfirmed');
    owned.exitConfirmed = true;
    this.options.store.withRunTransaction(route.runId, state => ({ patch: { harnessExecution: { ...this.boundState(state, task).harnessExecution!, processExit: 'confirmed' } } }));
    this.checkOwned(owned);
    assertAgentResultSchema(result.data, task.outputSchema);
    const acceptanceEligibility = await this.options.authorize(structuredClone(task), 'accept');
    this.boundState((await this.readCurrent(route.runId))!, structuredClone(await this.options.readTask(task.taskId)));
    this.checkOwned(owned);
    this.eligibility(acceptanceEligibility, task, 'accept')();
    const acceptance = await execution.accept(result.data, controller.signal, acceptanceEligibility || undefined);
    const completionEligibility = await this.options.authorize(structuredClone(task), 'accept');
    const checkCompletionEligibility = this.eligibility(completionEligibility, task, 'accept');
    this.boundState((await this.readCurrent(route.runId))!, structuredClone(await this.options.readTask(task.taskId)));
    this.checkOwned(owned);
    if (acceptance.outcome !== 'verified') {
      this.options.store.withRunTransaction(route.runId, state => ({ patch: { status: 'failed', completedAt: new Date().toISOString(),
        failureCode: 'EXECUTION_FAILED', errorSummary: 'Host acceptance did not verify this task',
        harnessExecution: { ...state.harnessExecution!, acceptance: acceptance.outcome, summary: acceptance.summary, evidenceRefs: [...acceptance.evidenceRefs] },
      }, events: [event('fail', { failureCode: 'EXECUTION_FAILED', acceptance: acceptance.outcome })] }));
      return;
    }
    this.options.store.withRunTransaction(route.runId, state => {
      this.boundState(state, task); this.checkOwned(owned, state);
      checkCompletionEligibility();
      execution.revalidateAccepted?.();
      this.checkOwned(owned, state); checkCompletionEligibility();
      if (acceptance.outcome !== 'verified' || state.harnessExecution!.evidence?.reservedBytes) throw new Error('Host acceptance or tool evidence is not verified');
      return { patch: { status: 'completed', completedAt: new Date().toISOString(),
        ...(result.tokenUsage === undefined ? {} : { tokensUsed: state.tokensUsed + result.tokenUsage,
          tokensRemaining: state.tokensRemaining === null ? null : state.tokensRemaining - result.tokenUsage }),
        harnessExecution: { ...state.harnessExecution!, acceptance: acceptance.outcome, summary: acceptance.summary, evidenceRefs: [...acceptance.evidenceRefs] },
      }, events: [event('complete', { result: result.data, tokenUsage: result.tokenUsage })], beforePublish: () => {
        this.checkOwned(owned, state); checkCompletionEligibility(); execution.revalidateAccepted?.();
        this.checkOwned(owned, state); checkCompletionEligibility();
      } };
    });
  }

  private boundState(state: Readonly<AgentRunState>, task: ApprovedHarnessTask): Readonly<AgentRunState> {
    if (!state?.harnessExecution || state.harnessExecution.taskId !== task.taskId || state.harnessExecution.requestHash !== hashHarnessTask(task) ||
      state.harnessExecution.principalHash !== task.principalHash) throw new Error('Task input or principal binding changed');
    return state;
  }
  private eligibility(value: void | HarnessTaskEligibility, task: ApprovedHarnessTask, phase: HarnessEligibilityPhase): () => void {
    const principalId = task.principalId ?? this.options.principalId;
    if (!principalId && value === undefined) return () => {}; // Explicitly unbound host-only fixture, not a production fallback.
    const expected = { taskId: task.taskId, taskHash: hashHarnessTask(task), principalId: principalId ?? '', principalHash: task.principalHash, phase };
    return () => assertHarnessTaskEligibility(value, expected);
  }
  private async readCurrent(runId: string): Promise<AgentRunState | null> {
    assertHarnessRunStorage(this.options.identityRoot, runId);
    return readRunStateSnapshotWhenAvailable(runId, this.options.identityRoot,
      Date.parse(this.active.get(runId)?.route.deadlineAt ?? '') || Infinity);
  }
  private assertReportCurrent(state: Readonly<AgentRunState>, task: ApprovedHarnessTask): void {
    assertHarnessNotStopped(this.options.identityRoot, state);
    const lifecycle = state.harnessExecution?.lifecycle;
    const total = Date.parse(lifecycle?.deadlineAt ?? '');
    const deadline = Date.parse(lifecycle?.executionDeadlineAt ?? lifecycle?.deadlineAt ?? '');
    if (!Number.isFinite(deadline) || total !== Date.parse(state.startedAt) + task.timeoutMs || deadline > total || Date.now() >= deadline) throw new Error('Harness callback deadline expired; preserve and reconcile read-only');
    if (state.status !== 'running' || lifecycle?.phase !== 'started' || !lifecycle.ownerGeneration) throw new Error('Harness callback is not bound to a confirmed started execution; preserve and reconcile');
  }
  private validateReport(value: Record<string, unknown> | HarnessTaskReport): void {
    if (Object.keys(value).sort().join(',') !== 'evidenceRefs,reportId,runId,summary' || !safeId(value.reportId) ||
      typeof value.summary !== 'string' || Buffer.byteLength(value.summary) > 4096 || !Array.isArray(value.evidenceRefs) || value.evidenceRefs.length > 32 ||
      value.evidenceRefs.some(ref => typeof ref !== 'string' || !/^[a-z][a-z0-9-]*:[A-Za-z0-9._/-]{1,256}$/.test(ref))) throw new TypeError('Invalid current-task report');
  }
  private receipt(taskId: string, state: AgentRunState): HarnessTaskReceipt {
    const binding = state.harnessExecution!;
    const uncertain = !!readHarnessStopIntent(this.options.identityRoot, state.runId) ||
      (['pending', 'running'].includes(state.status) && (!binding.lifecycle || Date.now() >= Date.parse(binding.lifecycle.deadlineAt)));
    return { taskId, runId: state.runId, status: state.status, acceptance: uncertain ? 'indeterminate' : binding.acceptance,
      ...(uncertain ? { disposition: 'preserve_and_reconcile' as const } : {}) };
  }
  private async waitForVisibleAdmission(route: HarnessAdmissionRecord): Promise<AgentRunState> {
    let canonicalRunPresent = false;
    for (let attempt = 0; attempt < 40 && !this.closing; attempt++) {
      let state: AgentRunState | null = null;
      try { state = this.read(route.runId); } catch (error) { if (!(error instanceof RunStateSnapshotChangedError)) throw error; }
      canonicalRunPresent = !!state;
      if (state?.harnessExecution?.requestHash === route.requestHash && state.harnessExecution.visible) return state;
      if (state?.harnessExecution && state.harnessExecution.requestHash !== route.requestHash) throw new HarnessAdmissionError('CONFLICT', 'Admission input changed');
      await new Promise<void>(resolve => setTimeout(resolve, 25));
    }
    const progressing = !!route.ownerGeneration && !!route.deadlineAt && Date.now() < Date.parse(route.deadlineAt) &&
      !readHarnessStopIntent(this.options.identityRoot, route.runId);
    throw new HarnessAdmissionError(progressing ? 'IN_PROGRESS' : 'INDETERMINATE', progressing ? 'Admission publication is in progress; query the same route.' : 'Admission requires read-only reconciliation; do not redispatch', {
      kind: 'admission', runId: route.runId, requestHash: route.requestHash, canonicalRunPresent, disposition: progressing ? 'in_progress' : 'reconcile_required',
    });
  }
  private observeSource(): { hash: string; domain: string } {
    return this.sourceObserver.observe();
  }
}

export function hashHarnessTask(task: ApprovedHarnessTask): string {
  return hashHarnessInput({ ...task, idempotencyKey: task.idempotencyKey ?? task.taskId, request: { ...task.request, correlationId: undefined, worktreePath: undefined } });
}
function safeId(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value); }
function isCode(value: unknown, code: string): boolean { return !!value && typeof value === 'object' && 'code' in value && value.code === code; }
