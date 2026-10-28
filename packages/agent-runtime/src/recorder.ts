import type { AgentRunFailureCode, AgentRunState, AgentRunRequest, AgentRunEvent } from './types.js';
import { getAgentRunFailureCode, getAgentRunFailureSummary } from './types.js';
import type { AgentRunStore } from './run-store.js';
import { assertHarnessNotStopped } from './harness-stop.js';
import { hashHarnessInput } from './harness-admission.js';
import { assertHarnessToolEligibility, type HarnessToolEligibility } from './harness-eligibility.js';
import { randomUUID } from 'node:crypto';

declare const reservationReceiptBrand: unique symbol;
/** Process-private proof of a particular newly prepared reservation, not an execution grant. */
export interface ToolEvidenceReservationReceipt { readonly [reservationReceiptBrand]: never }

export interface ToolEvidenceReservation {
  callId: string;
  toolName: string;
  input: unknown;
  targetPath: string;
  generation: string;
  /** Upper bound for the complete serialized tool_result JSONL event, including its newline. */
  maxResultBytes: number;
}
export interface RunRecorder {
  start(request: AgentRunRequest): AgentRunState;
  reject(request: AgentRunRequest, error: Error, failureCode?: AgentRunFailureCode): AgentRunState;
  progress(runId: string, data: Record<string, unknown>): void;
  toolCall(runId: string, toolName: string, input?: unknown): void;
  toolResult(runId: string, toolName: string, output?: unknown): void;
  chargeUsage(runId: string, tokenUsage: number): AgentRunState;
  complete(runId: string, result: unknown, tokenUsage?: number, tokenUsageAlreadyCharged?: boolean): AgentRunState;
  fail(runId: string, error: Error, failureCode?: AgentRunFailureCode): AgentRunState;
  cancel(runId: string): AgentRunState;
  reserveToolEvidence?(runId: string, reservation: ToolEvidenceReservation, eligibility?: HarnessToolEligibility): ToolEvidenceReservationReceipt;
  markToolEvidenceAuthorizationAttempt?(receipt: ToolEvidenceReservationReceipt): void;
  releaseUndispatchedToolEvidence?(receipt: ToolEvidenceReservationReceipt): void;
  recordToolEvidenceCall?(runId: string, callId: string): void;
  recordToolEvidenceResult?(runId: string, callId: string, output: unknown): void;
}

const event = (type: AgentRunEvent['type'], data: Record<string, unknown>): AgentRunEvent => ({ timestamp: new Date().toISOString(), type, data });

/** Every state-derived update and transcript append is serialized by the store owner. */
export function createRunRecorder(store: AgentRunStore, root?: string): RunRecorder {
  const receipts = new WeakMap<object, { runId: string; callId: string; reservationId: string; generation: string; created: boolean; attempted: boolean; checkEligibility(): void }>();
  const ownedReservations = new Set<string>();
  const receiptBinding = (receipt: ToolEvidenceReservationReceipt, requireNew = true) => {
    const binding = receipt && receipts.get(receipt);
    if (!binding || !ownedReservations.has(binding.reservationId) || (requireNew && !binding.created)) throw new Error('Only the original new evidence reservation owner may settle its dispatch intent');
    return binding;
  };
  const releaseUndispatched = (receipt: ToolEvidenceReservationReceipt): void => {
    const value = receiptBinding(receipt);
    if (value.attempted) throw new Error('An attempted authorization must retain evidence capacity until reconciliation');
    store.withRunTransaction(value.runId, state => {
      const binding = state.harnessExecution, evidence = binding?.evidence, reserved = evidence?.calls[value.callId];
      if (!binding || !evidence || !reserved || reserved.generation !== value.generation || reserved.reservationId !== value.reservationId) {
        throw new Error('Evidence reservation ownership changed');
      }
      if (reserved.phase === 'not_dispatched') return {};
      if (reserved.phase !== 'prepared' || reserved.resultDigest) throw new Error('Evidence dispatch is not provably unattempted');
      return { patch: { harnessExecution: { ...binding, evidence: { ...evidence,
        reservedBytes: evidence.reservedBytes - reserved.maxResultBytes,
        calls: { ...evidence.calls, [value.callId]: { ...reserved, phase: 'not_dispatched' } },
      } } }, events: [event('progress', { step: 'tool_evidence_not_dispatched', callId: value.callId })] };
    });
  };
  const live = (state: Readonly<AgentRunState>): void => {
    assertHarnessNotStopped(root, state);
    if (!state.harnessExecution) return;
    const lifecycle = state.harnessExecution.lifecycle;
    const cutoff = Date.parse(lifecycle?.executionDeadlineAt ?? lifecycle?.deadlineAt ?? '');
    if (!lifecycle || lifecycle.phase !== 'started' || state.status !== 'running' || !Number.isFinite(cutoff) || Date.now() >= cutoff) {
      throw new Error('Harness tool evidence is not bound to a live execution');
    }
  };
  return {
    start(request) {
      const created = store.createRun(request);
      return store.withRunTransaction(created.runId, () => ({ patch: { status: 'running' }, events: [event('start', {
        agentId: request.agentId, model: request.resolvedConfig.model, runtime: request.resolvedConfig.runtime,
        runtimeProvider: request.resolvedConfig.runtimeProvider, provider: request.resolvedConfig.provider,
        bridgeMode: request.resolvedConfig.bridgeMode, permissionMode: request.permissionProfile.permissionMode,
        allowedTools: request.permissionProfile.allowedTools, requiredMcpServers: request.resolvedConfig.requiredMcpServers,
        mcpServers: request.resolvedConfig.mcpServers,
      })] }));
    },
    reject(request, error, code) {
      const failureCode = code ?? getAgentRunFailureCode(error);
      const errorSummary = getAgentRunFailureSummary(error, failureCode);
      const created = store.createFailedRun(request, { failureCode, errorSummary });
      return store.withRunTransaction(created.runId, () => ({ events: [event('fail', { failureCode, errorSummary })] }));
    },
    progress(runId, data) {
      // Trusted diagnostic recording is not a task callback or permission to perform another effect.
      store.withRunTransaction(runId, () => ({ events: [event('progress', data)] }));
    },
    toolCall(runId, toolName, input) {
      store.withRunTransaction(runId, state => {
        if (state.harnessExecution) throw new Error('Harness tools require a public call-ID evidence reservation before effects');
        return { patch: { toolCalls: state.toolCalls + 1, lastTool: toolName }, events: [event('tool_call', { toolName, input })] };
      });
    },
    toolResult(runId, toolName, output) {
      store.withRunTransaction(runId, state => {
        if (state.harnessExecution) throw new Error('Harness tool results require the reserved public call ID');
        return { events: [event('tool_result', { toolName, output })] };
      });
    },
    chargeUsage(runId, tokens) {
      if (!Number.isInteger(tokens) || tokens < 0) throw new Error('Provider token usage must be a non-negative integer.');
      return store.withRunTransaction(runId, state => ({ patch: {
        tokensUsed: state.tokensUsed + tokens, tokensRemaining: state.tokensRemaining === null ? null : state.tokensRemaining - tokens,
      } }));
    },
    complete(runId, result, tokens, charged = false) {
      return store.withRunTransaction(runId, state => {
        assertHarnessNotStopped(root, state);
        const patch: Partial<AgentRunState> = { status: 'completed', completedAt: new Date().toISOString() };
        if (tokens !== undefined && !charged) {
          patch.tokensUsed = state.tokensUsed + tokens;
          if (state.tokensRemaining !== null) patch.tokensRemaining = state.tokensRemaining - tokens;
        }
        if (state.harnessExecution && (state.harnessExecution.acceptance !== 'verified' || state.harnessExecution.evidence?.reservedBytes)) {
          throw new Error('Harness completion requires verified acceptance and settled tool evidence');
        }
        return { patch, events: [event('complete', { result, tokenUsage: tokens })] };
      });
    },
    fail(runId, error, code) {
      const failureCode = code ?? getAgentRunFailureCode(error);
      const errorSummary = getAgentRunFailureSummary(error, failureCode);
      return store.withRunTransaction(runId, () => ({ patch: { status: 'failed', completedAt: new Date().toISOString(),
        failureCode, errorSummary, error: errorSummary }, events: [event('fail', { failureCode, errorSummary })] }));
    },
    cancel(runId) {
      return store.withRunTransaction(runId, () => ({ patch: { status: 'cancelled', completedAt: new Date().toISOString() }, events: [event('cancel', {})] }));
    },
    reserveToolEvidence(runId, value, eligibility) {
      const input = structuredClone(value);
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.callId) || !input.toolName ||
        typeof input.targetPath !== 'string' || input.targetPath.length > 4096 ||
        !Number.isSafeInteger(input.maxResultBytes) || input.maxResultBytes < 128 || input.maxResultBytes > 16 * 1024 * 1024) {
        throw new TypeError('Tool evidence reservation is invalid');
      }
      const inputDigest = hashHarnessInput(input.input);
      if (Buffer.byteLength(JSON.stringify(event('tool_result', { callId: input.callId, toolName: input.toolName, output: {} })) + '\n') > input.maxResultBytes) {
        throw new TypeError('Tool evidence reservation cannot fit even its result envelope');
      }
      let checkEligibility: () => void = () => { throw new Error('Harness eligibility reservation was not observed'); };
      let created = false;
      let reservationId: string = randomUUID();
      store.withRunTransaction(runId, state => {
        checkEligibility = () => {
          live(state);
          assertHarnessToolEligibility(eligibility, { runId, requestHash: state.harnessExecution!.requestHash, principalHash: state.harnessExecution!.principalHash,
            generation: state.harnessExecution!.lifecycle!.ownerGeneration, toolName: input.toolName, targetPath: input.targetPath });
        };
        checkEligibility();
        const binding = state.harnessExecution!;
        if (binding.lifecycle!.ownerGeneration !== input.generation) throw new Error('Tool reservation belongs to another owner generation');
        const evidence = binding.evidence ?? { reservedBytes: 0, calls: {} };
        const existing = Object.hasOwn(evidence.calls, input.callId) ? evidence.calls[input.callId] : undefined;
        const reservation = { toolName: input.toolName, inputDigest, targetPath: input.targetPath, generation: input.generation, maxResultBytes: input.maxResultBytes };
        if (existing) {
          if (existing.resultDigest || existing.phase === 'not_dispatched') throw new Error('A settled tool call ID cannot authorize another effect');
          if (hashHarnessInput({ toolName: existing.toolName, inputDigest: existing.inputDigest, targetPath: existing.targetPath,
            generation: existing.generation, maxResultBytes: existing.maxResultBytes }) !== hashHarnessInput(reservation)) throw new Error('Tool call ID already binds another effect');
          reservationId = existing.reservationId ?? '';
          return { beforePublish: checkEligibility };
        }
        created = true;
        return { patch: { toolCalls: state.toolCalls + 1, lastTool: input.toolName, harnessExecution: { ...binding, evidence: {
          reservedBytes: evidence.reservedBytes + input.maxResultBytes,
          calls: { ...evidence.calls, [input.callId]: { ...reservation, reservationId, phase: 'prepared' } },
        } } }, events: [event('tool_call', { callId: input.callId, toolName: input.toolName, input: input.input,
          targetPath: input.targetPath, inputDigest })], beforePublish: checkEligibility };
      });
      const receipt = Object.freeze({}) as ToolEvidenceReservationReceipt;
      if (created) ownedReservations.add(reservationId);
      receipts.set(receipt, { runId, callId: input.callId, generation: input.generation, reservationId, created, attempted: false, checkEligibility });
      try { checkEligibility(); }
      catch (error) {
        if (created) {
          try { releaseUndispatched(receipt); }
          catch { if (error instanceof Error) Object.defineProperty(error, 'persistenceDiagnostic', { value: 'TOOL_RESERVATION_RELEASE_UNCONFIRMED' }); }
        }
        throw error;
      }
      return receipt;
    },
    releaseUndispatchedToolEvidence: releaseUndispatched,
    markToolEvidenceAuthorizationAttempt(receipt) {
      const value = receiptBinding(receipt, false);
      if (value.attempted) throw new Error('Authorization has already been attempted for this reservation');
      // Mark memory before publication: any publication/send uncertainty must retain capacity.
      value.attempted = true;
      store.withRunTransaction(value.runId, state => {
        live(state);
        const binding = state.harnessExecution!, evidence = binding.evidence, reserved = evidence?.calls[value.callId];
        if (!evidence || !reserved || reserved.reservationId !== value.reservationId || reserved.generation !== value.generation ||
          reserved.resultDigest) throw new Error('Evidence reservation cannot authorize a replay');
        if (!value.created) {
          // A live worker checks the SAME public tool call after preview and at
          // fs-intent. This is only revalidation of our already-attempted grant,
          // never a new owner's first grant or a recovered/replayed call.
          if (reserved.phase !== 'authorization_attempted') throw new Error('A repeated receipt cannot acquire first-dispatch authority');
          return { beforePublish: () => { live(state); value.checkEligibility(); } };
        }
        if (reserved.phase !== 'prepared') throw new Error('Evidence reservation cannot authorize a replay');
        return { patch: { harnessExecution: { ...binding, evidence: { ...evidence,
          calls: { ...evidence.calls, [value.callId]: { ...reserved, phase: 'authorization_attempted' } },
        } } }, beforePublish: () => { live(state); value.checkEligibility(); } };
      });
      value.checkEligibility();
    },
    recordToolEvidenceCall(runId, callId) {
      store.withRunTransaction(runId, state => {
        if (state.harnessExecution?.evidence?.calls[callId]?.phase !== 'authorization_attempted') throw new Error('Tool call was not authorized before effects');
        return {};
      });
    },
    recordToolEvidenceResult(runId, callId, output) {
      const result = structuredClone(output);
      const resultDigest = hashHarnessInput(result);
      store.withRunTransaction(runId, state => {
        const binding = state.harnessExecution;
        const evidence = binding?.evidence;
        const reserved = evidence && Object.hasOwn(evidence.calls, callId) ? evidence.calls[callId] : undefined;
        if (!binding || !evidence || !reserved) throw new Error('Tool result has no public call-ID reservation');
        if (reserved.resultDigest) {
          if (reserved.resultDigest !== resultDigest) throw new Error('Tool result differs from the persisted receipt');
          return {};
        }
        if (reserved.phase !== 'authorization_attempted') throw new Error('Tool result has no attempted authorization receipt');
        const observed = event('tool_result', { callId, toolName: reserved.toolName, output: result });
        if (Buffer.byteLength(JSON.stringify(observed) + '\n') > reserved.maxResultBytes) throw new Error('Tool result exceeds its pre-effect evidence reservation; outcome is unknown');
        return { patch: { harnessExecution: { ...binding, evidence: { reservedBytes: evidence.reservedBytes - reserved.maxResultBytes,
          calls: { ...evidence.calls, [callId]: { ...reserved, resultDigest, phase: 'settled' } } } } }, events: [observed] };
      });
    },
  };
}
