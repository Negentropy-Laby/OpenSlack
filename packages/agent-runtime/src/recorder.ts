import type { AgentRunFailureCode, AgentRunState, AgentRunRequest, AgentRunEvent } from './types.js';
import { getAgentRunFailureCode, getAgentRunFailureSummary } from './types.js';
import type { AgentRunStore } from './run-store.js';
import { assertHarnessNotStopped } from './harness-stop.js';
import { hashHarnessInput } from './harness-admission.js';
import { assertHarnessToolEligibility, type HarnessToolEligibility } from './harness-eligibility.js';

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
  reserveToolEvidence?(runId: string, reservation: ToolEvidenceReservation, eligibility?: HarnessToolEligibility): void;
  recordToolEvidenceCall?(runId: string, callId: string): void;
  recordToolEvidenceResult?(runId: string, callId: string, output: unknown): void;
}

const event = (type: AgentRunEvent['type'], data: Record<string, unknown>): AgentRunEvent => ({ timestamp: new Date().toISOString(), type, data });

/** Every state-derived update and transcript append is serialized by the store owner. */
export function createRunRecorder(store: AgentRunStore, root?: string): RunRecorder {
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
          if (existing.resultDigest) throw new Error('A settled tool call ID cannot authorize another effect');
          if (hashHarnessInput({ ...existing, resultDigest: undefined }) !== hashHarnessInput(reservation)) throw new Error('Tool call ID already binds another effect');
          return { beforePublish: checkEligibility };
        }
        return { patch: { toolCalls: state.toolCalls + 1, lastTool: input.toolName, harnessExecution: { ...binding, evidence: {
          reservedBytes: evidence.reservedBytes + input.maxResultBytes, calls: { ...evidence.calls, [input.callId]: reservation },
        } } }, events: [event('tool_call', { callId: input.callId, toolName: input.toolName, input: input.input,
          targetPath: input.targetPath, inputDigest })], beforePublish: checkEligibility };
      });
      checkEligibility();
    },
    recordToolEvidenceCall(runId, callId) {
      store.withRunTransaction(runId, state => {
        if (!state.harnessExecution?.evidence || !Object.hasOwn(state.harnessExecution.evidence.calls, callId)) throw new Error('Tool call was not reserved before effects');
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
        const observed = event('tool_result', { callId, toolName: reserved.toolName, output: result });
        if (Buffer.byteLength(JSON.stringify(observed) + '\n') > reserved.maxResultBytes) throw new Error('Tool result exceeds its pre-effect evidence reservation; outcome is unknown');
        return { patch: { harnessExecution: { ...binding, evidence: { reservedBytes: evidence.reservedBytes - reserved.maxResultBytes,
          calls: { ...evidence.calls, [callId]: { ...reserved, resultDigest } } } } }, events: [observed] };
      });
    },
  };
}
