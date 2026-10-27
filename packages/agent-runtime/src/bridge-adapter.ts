/**
 * Bridge Adapter — BridgeProcessAdapter for external runtimes and
 * FakeBridgeAdapter for CI. Generic over any BridgeContract-compliant
 * external process.
 *
 * AR-2.5B: Aby External Adapter
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { TextDecoder, isDeepStrictEqual } from 'node:util';
import type {
  AgentExecutionAdapter,
  AdapterExecutionContext,
  AdapterExecutionResult,
} from './adapter.js';
import type {
  BridgeContract,
  BridgeCapabilityDescriptor,
  BridgeEnvelope,
  BridgeErrorKind,
  BridgeErrorPayload,
  BridgeSessionConfig,
  BridgeSessionState,
} from './bridge-contract.js';
import {
  BridgeSessionStateMachine,
  buildBridgeEnvelope,
  validateBridgeEnvelope,
  BRIDGE_PROTOCOL_VERSION,
} from './bridge-contract.js';
import { buildAgentRunBridgeRequestPayload } from './agent-run-bridge-request.js';
import { BridgeLifecycleMapper } from './bridge-lifecycle.js';
import { BridgePermissionGuard } from './bridge-permission-guard.js';
import { BridgeWorktreeGuard } from './bridge-worktree-guard.js';
import {
  validateRequiredMcpServers,
  extractMcpToolsFromProfile,
  validateMcpToolNamespace,
  buildMcpServerDescriptors,
} from './bridge-mcp-scope.js';
import { buildBridgeProcessEnv } from './bridge-env.js';
import { ABY_BRIDGE_RUNTIME_LIMITS } from './runtime-config-file.js';
import { assertHarnessToolEligibility, harnessToolEligibilityRestriction, assertHarnessRunStartEligibility, harnessRunStartEligibilityRestriction,
  type HarnessToolEligibility, type HarnessEligibilityRestriction } from './harness-eligibility.js';
import {
  BRIDGE_FRAME_MAX_BYTES, BRIDGE_QUEUE_MAX_BYTES, BRIDGE_CHUNK_EXTENSION,
  BridgeWireEncoder, BridgeWireDecoder, HARNESS_CALLBACK_TOOLS, BRIDGE_MESSAGE_MAX_BYTES,
} from './bridge-wire.js';

const MAX_ENVELOPE_SIZE_BYTES = 1024 * 1024; // 1MB

/**
 * Options for configuring the bridge process adapter.
 */
export interface BridgeProcessAdapterOptions {
  /** Command to spawn the external runtime. */
  command: string;
  /** Arguments to pass to the command. */
  args?: string[];
  /** Safe bridge env variables added to the child process allowlist. */
  env?: Record<string, string>;
  /** Session timeout in milliseconds. */
  timeoutMs?: number;
  /** Handshake timeout in milliseconds. */
  handshakeTimeoutMs?: number;
  /** Maximum envelope size in bytes. */
  maxEnvelopeSizeBytes?: number;
  /** Optional Aby root path (read from OPENSLACK_ABY_ROOT or config). */
  abyRoot?: string;
  /** List of available MCP server names for capability negotiation. */
  availableMcpServers?: string[];
  /** Require clean child exit in addition to every provider's strict wire finalization. */
  confirmProcessExit?: boolean;
  /** One total cleanup budget for peers without the governed/native 30s reserve. */
  exitGraceMs?: number;
  /** Live host authorization for a peer's pre-effect tool request; absence always rejects it. */
  authorizeTool?: (context: AdapterExecutionContext, toolName: string, input: unknown) => Promise<void | HarnessToolEligibility>;
  /** Explicit trusted support. Absence never claims unsupported capabilities. */
  availableCapabilities?: readonly BridgeCapabilityDescriptor[];
  /** Transport extensions supported by this provider, never inferred from a tool list. */
  wireExtensions?: readonly string[];
  /** One absolute completion-only grace; legacy Aby defaults to 1s, owned Harness to zero. */
  completionGraceMs?: number;
  /** A trusted native supervisor wraps child bytes separately from non-forgeable OS receipts. */
  supervisor?: { protocol: 'openslack.windows_job.v1'; runId: string; generation: string };
  /** The governed Harness provider requires durable full-evidence reservations before every effect. */
  requireToolEvidence?: boolean;
}

/**
 * BridgeProcessAdapter implements both AgentExecutionAdapter and BridgeContract.
 *
 * Spawns a child process, performs bridge handshake, sends session config
 * via JSONL envelopes over stdin, and reads responses from stdout.
 *
 * Process spawn is a runtime-owned adapter capability — it does NOT require
 * the `Bash` tool in the permission profile.
 */
export class BridgeProcessAdapter implements AgentExecutionAdapter, BridgeContract {
  readonly adapterId = 'bridge-process';
  readonly bridgeId = 'bridge-process';
  /** Exposes this adapter as a BridgeContract for consumers of AgentExecutionAdapter. */
  readonly bridgeContract = this;

  private readonly options: BridgeProcessAdapterOptions;
  private process: ChildProcess | null = null;
  private sessionMachine: BridgeSessionStateMachine | null = null;
  private responseBuffer = '';
  private pendingResponse: ((envelope: BridgeEnvelope) => void) | null = null;
  private pendingReject: ((error: Error) => void) | null = null;
  private responseTimer: ReturnType<typeof setTimeout> | null = null;
  private processExited = false;
  private envelopeQueue: BridgeEnvelope[] = [];
  private stderrBuffer = '';
  private abortListener: (() => void) | null = null;
  private exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | null = null;
  private exitReceipt: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  private responseDecoder: TextDecoder;
  private inboundFailure: BridgeAdapterError | null = null;
  private terminalFrames = 0;
  private readonly wireEncoder = new BridgeWireEncoder();
  private wireDecoder = new BridgeWireDecoder();
  private queueBytes = 0;
  private deferredEnvelope: BridgeEnvelope | undefined;
  private supervisorBuffer = '';
  private readonly supervisorDecoder = new TextDecoder('utf-8', { fatal: true });
  private supervisorPid: number | undefined;
  private supervisorReceipt: { pid: number; rootExitCode: number; jobEmpty: boolean; streamsDrained: boolean;
    terminationRequested: boolean; graceful: boolean; timedOut: boolean } | undefined;
  private cleanupStartedAt: number | undefined;
  private cleanupDeadline: number | undefined;
  private outbound: Promise<void> = Promise.resolve();
  private outboundBytes = 0;
  private sessionClose: Promise<BridgeSessionState> | undefined;
  private activeSignal: AbortSignal | undefined;
  private invocationAbortError: BridgeAdapterError | undefined;
  private activeExecutionDeadline: number | undefined;
  private startEligibilityCheck: (() => Readonly<{ runId: string; generation: string; restriction: HarnessEligibilityRestriction }>) | undefined;
  private transportAbort = new AbortController();

  /** Last observed OS process exit, not merely a signal request. */
  get processExitReceipt() {
    return this.exitReceipt ? { ...this.exitReceipt } : null;
  }

  constructor(options: BridgeProcessAdapterOptions) {
    this.options = options;
    this.responseDecoder = new TextDecoder('utf-8', { fatal: true });
  }

  // ---------------------------------------------------------------------------
  // BridgeContract implementation
  // ---------------------------------------------------------------------------

  async negotiateCapabilities(
    requested: BridgeCapabilityDescriptor[],
  ): Promise<BridgeCapabilityDescriptor[]> {
    const available = this.options.availableCapabilities ?? [];
    return structuredClone(requested.filter(cap => available.some(supported => supported.name === cap.name &&
      (cap.version === undefined || cap.version === supported.version) &&
      (cap.supportedTools ?? []).every(tool => supported.supportedTools?.includes(tool)) &&
      (cap.supportedMcpServers ?? []).every(server => supported.supportedMcpServers?.includes(server)))));
  }

  async openSession(config: BridgeSessionConfig): Promise<BridgeSessionState> {
    this.assertExecutionWindow();
    this.assertStartEligibility();
    // Guard against double-open — prevents orphaned child processes
    if (
      (this.process && !this.process.killed) ||
      (this.sessionMachine && this.sessionMachine.currentState !== 'shutdown')
    ) {
      throw new BridgeAdapterError(
        'session_unavailable',
        'Session already active — close the current session first',
      );
    }

    const sessionId = `bridge-${config.runId}`;
    this.processExited = false;
    this.exitReceipt = null;
    this.responseBuffer = '';
    this.responseDecoder = new TextDecoder('utf-8', { fatal: true });
    this.wireDecoder = new BridgeWireDecoder({ sessionId, correlationId: config.runId });
    this.wireEncoder.setExtensions([]);
    this.queueBytes = 0;
    this.deferredEnvelope = undefined;
    this.supervisorBuffer = '';
    this.supervisorPid = undefined;
    this.supervisorReceipt = undefined;
    this.cleanupStartedAt = undefined;
    this.cleanupDeadline = undefined;
    this.outbound = Promise.resolve();
    this.outboundBytes = 0;
    this.sessionClose = undefined;
    this.inboundFailure = null;
    this.terminalFrames = 0;
    this.envelopeQueue = [];
    this.stderrBuffer = '';
    this.sessionMachine = new BridgeSessionStateMachine(sessionId);

    // Spawn the external process
    await this.spawnProcess(config);
    this.assertExecutionWindow();

    this.sessionMachine.transition('initializing');

    // Perform handshake
    await this.performHandshake(sessionId, config);

    this.sessionMachine.transition('ready');
    return this.sessionMachine.currentState;
  }

  closeSession(_sessionId: string): Promise<BridgeSessionState> {
    this.sessionClose ??= this.closeActiveSession();
    return this.sessionClose;
  }

  private async closeActiveSession(): Promise<BridgeSessionState> {
    if (!this.sessionMachine) return 'shutdown';

    try {
      this.sessionMachine.transition('shutdown');
    } catch {
      // Already shutting down
      this.sessionMachine.forceShutdown();
    }

    // Clear any pending response timer to prevent leaks
    if (this.responseTimer !== null) {
      clearTimeout(this.responseTimer);
      this.responseTimer = null;
    }
    this.pendingReject?.(new BridgeAdapterError('session_unavailable', 'Bridge session closed while awaiting a response'));
    this.pendingResponse = null;
    this.pendingReject = null;
    this.envelopeQueue = [];
    this.queueBytes = 0;
    this.deferredEnvelope = undefined;
    if (this.responseBuffer.includes('\n')) this.handleStdoutChunk(Buffer.alloc(0));
    this.process?.stdout?.resume();

    // Wire finalization applies to every provider. Legacy policy may ignore a
    // nonzero/forced exit, never malformed/truncated output or missing EOF.
    await this.confirmExit();
    return 'shutdown';
  }

  async sendEnvelope<T>(_sessionId: string, envelope: BridgeEnvelope<T>): Promise<void> {
    this.assertInvocationSignal();
    if (!this.process || this.process.killed) {
      throw new BridgeAdapterError('process_crash', 'Bridge process not running');
    }

    if (!this.sessionMachine || this.sessionMachine.currentState === 'shutdown') {
      throw new BridgeAdapterError('session_unavailable', 'Bridge session not active');
    }

    const stdin = this.process.stdin;
    if (!stdin) {
      throw new BridgeAdapterError('process_crash', 'Bridge process stdin not available');
    }
    const child = this.process;
    const session = this.sessionMachine;
    const signal = this.activeSignal;
    // This decision belongs to the bytes encoded for this send, not to a
    // caller-owned envelope that could change while another send is pending.
    const isRunRequest = envelope.kind === 'run_request';
    let capturedCancellation: unknown;
    const cancellation = () => capturedCancellation ??= (this.activeSignal === signal ? this.invocationAbortError : undefined) ?? signal?.reason;
    const assertOwner = () => {
      if (signal?.aborted) throw cancellation();
      if (this.process !== child || this.sessionMachine !== session || session.currentState === 'shutdown') {
        throw new BridgeAdapterError('session_unavailable', 'Bridge send owner is no longer active');
      }
    };
    let frames: string[];
    try { frames = this.wireEncoder.encode(envelope as unknown as Parameters<BridgeWireEncoder['encode']>[0]); }
    catch (error) { throw new BridgeAdapterError('envelope_malformed', error instanceof Error ? error.message : 'Invalid Bridge output'); }
    const bytes = frames.reduce((sum, frame) => sum + Buffer.byteLength(frame) + 1, 0);
    if (this.outboundBytes + bytes > BRIDGE_QUEUE_MAX_BYTES) {
      throw new BridgeAdapterError('envelope_malformed', 'Bridge outbound byte queue is full');
    }
    this.outboundBytes += bytes;
    const operation = this.awaitSendBoundary(this.outbound, signal, cancellation).then(async () => {
      for (const json of frames) {
        assertOwner();
        if (isRunRequest) {
          this.assertExecutionWindow();
          this.assertStartEligibility();
        }
        if (Buffer.byteLength(json) > Math.min(this.options.maxEnvelopeSizeBytes ?? MAX_ENVELOPE_SIZE_BYTES, BRIDGE_FRAME_MAX_BYTES)) {
          throw new BridgeAdapterError('envelope_malformed', 'Envelope exceeds maximum size');
        }
        const written = new Promise<void>((resolve, reject) => {
          const failed = (error: Error) => {
            const failure = new BridgeAdapterError('process_crash', 'Bridge stdin write failed', undefined, { cause: error });
            if (signal?.aborted) {
              const primary = cancellation();
              this.recordSecondaryPipeFailure(primary, error);
              reject(primary);
            } else {
              if (this.process === child && this.sessionMachine === session) this.rejectInbound(failure);
              reject(failure);
            }
          };
          try { stdin.write(json + '\n', error => {
            if (!error) { resolve(); return; }
            failed(error);
          }); } catch (error) { failed(error instanceof Error ? error : new Error('Bridge stdin write failed')); }
        });
        // A paused reader may never invoke write's callback before its own
        // exit. Abort the wait, not the owned cleanup budget; the raw callback
        // stays handled and may add secondary EPIPE evidence during shutdown.
        await this.awaitSendBoundary(written, signal, cancellation);
      }
    }).finally(() => { this.outboundBytes -= bytes; });
    this.outbound = operation.catch(() => {});
    return operation;
  }

  async healthCheck(): Promise<{ healthy: boolean; details?: Record<string, unknown> }> {
    if (!this.process || this.process.killed) {
      return { healthy: false, details: { reason: 'process_not_running' } };
    }
    return { healthy: true };
  }

  // ---------------------------------------------------------------------------
  // AgentExecutionAdapter implementation
  // ---------------------------------------------------------------------------

  async execute<T>(context: AdapterExecutionContext): Promise<AdapterExecutionResult<T>> {
    const startTime = Date.now();
    // Keep the caller's signal separate: AbortSignal.any retains its first
    // reason and can hide a later explicit cancellation behind an inner cutoff.
    const callerSignal = context.signal;
    let deadline: AbortSignal | undefined;
    let executionError: Error | undefined;
    let diagnosticFailure: unknown;
    let successfulSummary: ReturnType<typeof BridgeLifecycleMapper.buildSummary> | undefined;
    const totalTimeoutMs = this.options.timeoutMs ?? ABY_BRIDGE_RUNTIME_LIMITS.timeoutMs.default;
    const completionGrace = this.options.completionGraceMs ?? (this.options.confirmProcessExit ? 0 : 1000);
    if (!Number.isSafeInteger(completionGrace) || completionGrace < 0 || completionGrace > 1000) {
      throw new BridgeAdapterError('session_unavailable', 'Invalid trusted completion grace');
    }
    if (context.executionDeadline !== undefined && (!Number.isSafeInteger(context.executionDeadline) || context.executionDeadline < 0)) {
      throw new BridgeAdapterError('session_unavailable', 'Invalid trusted execution deadline');
    }
    const executionDeadline = Math.min(startTime + totalTimeoutMs, context.executionDeadline ?? Infinity);
    const completionDeadline = executionDeadline + completionGrace;
    this.transportAbort = new AbortController();
    this.invocationAbortError = undefined;
    {
      deadline = AbortSignal.timeout(Math.max(0, completionDeadline - Date.now()));
      context = { ...context, signal: AbortSignal.any([...(callerSignal ? [callerSignal] : []), deadline, this.transportAbort.signal]) };
    }
    const {
      prompt,
      runId,
      agentId,
      resolvedConfig,
      permissionProfile,
      worktreePath,
      recorder,
      toolGuard,
    } = context;
    this.startEligibilityCheck = undefined;
    if (this.options.requireToolEvidence) {
      const binding = context.runState.harnessExecution;
      if (!binding?.lifecycle) throw new BridgeAdapterError('permission_denied', 'Known Harness start eligibility is unavailable');
      const expected = { runId, requestHash: binding.requestHash, principalHash: binding.principalHash, generation: binding.lifecycle.ownerGeneration };
      this.startEligibilityCheck = () => {
        assertHarnessRunStartEligibility(context.startEligibility, expected);
        return Object.freeze({ runId, generation: expected.generation, restriction: harnessRunStartEligibilityRestriction(context.startEligibility) });
      };
    }

    const lifecycle = new BridgeLifecycleMapper(recorder, runId);
    const guard = new BridgePermissionGuard(permissionProfile, recorder, runId);
    const worktreeGuard = new BridgeWorktreeGuard(recorder, runId);

    // Validate MCP servers if configured
    const availableMcpServers = this.options.availableMcpServers ?? [];
    recorder.progress(runId, {
      step: 'bridge_mcp_availability',
      required: resolvedConfig.requiredMcpServers ?? [],
      available: availableMcpServers,
    });
    if (resolvedConfig.requiredMcpServers && resolvedConfig.requiredMcpServers.length > 0) {
      const mcpDescriptors = buildMcpServerDescriptors(resolvedConfig.requiredMcpServers);
      validateRequiredMcpServers(mcpDescriptors, availableMcpServers);
    }

    // Validate MCP namespaced tools in permission profile
    const { mcpTools } = extractMcpToolsFromProfile(permissionProfile.allowedTools);
    if (mcpTools.length > 0) {
      const namespaceValidation = validateMcpToolNamespace(mcpTools, availableMcpServers);
      if (namespaceValidation.invalid.length > 0) {
        recorder.progress(runId, {
          step: 'bridge_mcp_namespace_invalid',
          invalidTools: namespaceValidation.invalid,
        });
      }
    }

    // Filter outbound tools through BridgePermissionGuard
    const outboundFiltered = guard.filterOutboundTools(permissionProfile.allowedTools);

    // Build worktree config if available
    const worktreeConfig = BridgeWorktreeGuard.buildConfig(worktreePath);

    const bridgePermissionProfile = {
      ...permissionProfile,
      allowedTools: outboundFiltered.allowed,
      deniedTools: [...permissionProfile.deniedTools, ...outboundFiltered.denied],
      permissionMode: permissionProfile.permissionMode,
    };

    const sessionConfig: BridgeSessionConfig = {
      runId,
      agentId,
      prompt,
      permissionProfile: bridgePermissionProfile,
      worktreePath,
      timeout: Math.max(0, executionDeadline - Date.now()),
      metadata: {
        model: resolvedConfig.model,
        correlationId: context.correlationId ?? runId,
        threadId: context.threadId,
        budget: context.runState.tokensRemaining
          ? { tokens: context.runState.tokensRemaining, costUsd: 0 }
          : undefined,
        resolvedConfig: resolvedConfig as unknown as Record<string, unknown>,
        worktree: worktreeConfig,
      },
    };

    this.activeSignal = context.signal;
    this.activeExecutionDeadline = executionDeadline;
    try {
      this.assertExecutionWindow();
      if (context.signal) {
        this.activeSignal = context.signal;
        this.abortListener = () => {
          // An EventTarget callback must still stop the owned process when
          // diagnostic persistence fails; never throw from this listener.
          try { lifecycle.onBridgeProgress('agent_cancel_requested', { runId, reason: 'AbortSignal' }); }
          catch (error) { diagnosticFailure ??= error; }
          this.invocationAbortError ??= this.inboundFailure ?? (deadline?.aborted
            ? new BridgeAdapterError('timeout', 'Bridge total deadline exceeded', undefined, { cause: context.signal?.reason })
            : new BridgeAdapterError('session_unavailable', 'Bridge invocation cancelled', undefined, { cause: context.signal?.reason }));
          this.pendingReject?.(this.invocationAbortError);
          this.pendingReject = null;
          this.pendingResponse = null;
          if (this.responseTimer) clearTimeout(this.responseTimer);
          this.responseTimer = null;
          this.killProcess();
        };
        if (context.signal.aborted) {
          this.abortListener();
        } else {
          context.signal.addEventListener('abort', this.abortListener, { once: true });
        }
      }
      // Open session (spawns process + handshake)
      this.assertExecutionWindow();
      const sessionState = await this.openSession(sessionConfig);
      this.assertExecutionWindow();
      const sessionId = this.sessionMachine!.id;
      lifecycle.onSessionOpen(sessionId, { sessionState });

      if (this.sessionMachine) {
        this.sessionMachine.transition('busy');
      }

      // Send the execution envelope
      const execEnvelope = buildBridgeEnvelope(
        sessionId,
        runId,
        'run_request',
        buildAgentRunBridgeRequestPayload({
          sessionId,
          config: sessionConfig,
          resolvedConfig,
          availableMcpServers,
        }),
      );

      this.assertExecutionWindow();
      await this.sendEnvelope(this.sessionMachine!.id, execEnvelope);
      this.assertInvocationSignal();

      // Multi-envelope event loop: process intermediate envelopes until
      // a terminal envelope (complete or error) arrives. This handles
      // real bridge runtimes that emit progress/tool events before
      // producing a final result.
      let finalResult: { data: T; tokenUsage?: number } | null = null;
      let reconciliationEventCount = 0;
      const evidenceCalls = new Map<string, { input: unknown; targetPath: string; toolName: string }>();

      while (finalResult === null) {
        this.assertInvocationSignal();
        // Track elapsed time so the total budget is shared across all
        // envelopes, not multiplied per envelope.
        const remaining = completionDeadline - Date.now();
        if (remaining <= 0) throw new BridgeAdapterError('timeout', 'Bridge total deadline exceeded');
        const envelope = await this.waitForResponse(remaining);

        // Validate every incoming envelope
        const validation = validateBridgeEnvelope(envelope);
        if (!validation.valid) {
          throw new BridgeAdapterError(
            'envelope_malformed',
            validation.error ?? 'Invalid envelope',
          );
        }
        if (envelope.sessionId !== sessionId || envelope.correlationId !== runId) {
          throw new BridgeAdapterError('envelope_malformed', 'Bridge frame belongs to another run');
        }
        if (Date.now() >= completionDeadline) throw new BridgeAdapterError('timeout', 'Bridge total deadline exceeded');
        if (Date.now() >= executionDeadline && !['complete', 'error', 'heartbeat'].includes(envelope.kind)) {
          throw new BridgeAdapterError('timeout', 'Bridge completion grace cannot authorize further actions');
        }

        // Permission guard on every inbound envelope
        const permCheck = guard.validateInboundResponse(envelope);
        if (!permCheck.valid) {
          throw new BridgeAdapterError(
            'permission_denied',
            permCheck.violation ?? 'Permission denied',
          );
        }

        // Process by kind
        switch (envelope.kind) {
          case 'run_started': {
            lifecycle.onBridgeProgress('run_started', envelope.payload as Record<string, unknown>);
            reconciliationEventCount++;
            break;
          }

          case 'assistant_text': {
            lifecycle.onBridgeProgress(
              'assistant_text',
              envelope.payload as Record<string, unknown>,
            );
            reconciliationEventCount++;
            break;
          }

          case 'progress': {
            lifecycle.onBridgeProgress('event', envelope.payload as Record<string, unknown>);
            reconciliationEventCount++;
            break;
          }

          case 'tool_request': {
            const tp = envelope.payload as Record<string, unknown>;
            const toolName = (tp.toolName as string) ?? 'unknown';
            if (tp.phase === 'authorize') {
              let allowed = false;
              let authorizationError: BridgeAdapterError | undefined;
              let restriction: HarnessEligibilityRestriction | undefined;
              try {
                this.assertExecutionWindow();
                toolGuard.check(toolName);
                const callback = Object.values(HARNESS_CALLBACK_TOOLS).some(item => item.bridge === toolName);
                if (!this.options.authorizeTool || typeof tp.authorizationRequestId !== 'string') {
                  throw new Error('Live authorization port is not configured');
                }
                if (callback && !this.options.requireToolEvidence) throw new Error('Task callback evidence is not configured');
                const eligibility = await this.authorizePeerTool(context, toolName, structuredClone(tp.input));
                this.assertExecutionWindow();
                if (this.options.requireToolEvidence) {
                  const evidence = tp.evidence as Record<string, unknown> | undefined;
                  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence) ||
                    Object.keys(evidence).sort().join(',') !== 'callId,generation,input,maxResultBytes,targetPath' ||
                    typeof evidence.callId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(evidence.callId) ||
                    typeof evidence.generation !== 'string' || !evidence.generation || typeof evidence.targetPath !== 'string' ||
                    !Number.isSafeInteger(evidence.maxResultBytes) || (evidence.maxResultBytes as number) < 1 || (evidence.maxResultBytes as number) > BRIDGE_MESSAGE_MAX_BYTES ||
                    (!callback && (!tp.input || typeof tp.input !== 'object' || !('file_path' in tp.input) || tp.input.file_path !== evidence.targetPath)) ||
                    (callback && evidence.targetPath !== `mcp:${toolName}`) || !recorder.reserveToolEvidence) throw new Error('Unsupported canonical evidence reservation');
                  const binding = context.runState.harnessExecution;
                  if (!binding || !binding.lifecycle) throw new Error('Canonical Harness evidence owner is missing');
                  const expected = { runId, requestHash: binding.requestHash, principalHash: binding.principalHash,
                    generation: binding.lifecycle.ownerGeneration, toolName, targetPath: evidence.targetPath };
                  assertHarnessToolEligibility(eligibility, expected);
                  recorder.reserveToolEvidence(runId, { callId: evidence.callId, toolName, input: evidence.input,
                    targetPath: evidence.targetPath, generation: evidence.generation, maxResultBytes: evidence.maxResultBytes as number }, eligibility);
                  assertHarnessToolEligibility(eligibility, expected);
                  restriction = harnessToolEligibilityRestriction(eligibility);
                  evidenceCalls.set(evidence.callId, { input: structuredClone(evidence.input), toolName, targetPath: evidence.targetPath });
                }
                allowed = true;
              } catch (error) {
                // Return no principal, path or upstream exception text to the untrusted caller.
                authorizationError = error instanceof BridgeAdapterError ? error
                  : deadline?.aborted && error === context.signal?.reason
                    ? new BridgeAdapterError('timeout', 'Bridge authorization exceeded the execution deadline', undefined, { cause: error })
                    : new BridgeAdapterError('permission_denied', 'Live host tool authorization denied', undefined, { cause: error });
              }
              if (context.signal?.aborted) throw authorizationError ?? new BridgeAdapterError('session_unavailable', 'Bridge authorization was cancelled');
              await this.sendEnvelope(sessionId, buildBridgeEnvelope(sessionId, runId, 'tool_response', {
                authorizationRequestId: tp.authorizationRequestId, allowed, ...(allowed && restriction ? { restriction } : {}),
              }));
              this.assertInvocationSignal();
              recorder.progress(runId, { step: 'harness_tool_authorization', toolName, allowed });
              if (!allowed) throw authorizationError ?? new BridgeAdapterError('permission_denied', 'Live host tool authorization denied');
              break;
            }
            const reserved = typeof tp.callId === 'string' ? evidenceCalls.get(tp.callId) : undefined;
            if (this.options.requireToolEvidence && (!reserved || reserved.toolName !== toolName || !isDeepStrictEqual(reserved.input, tp.input))) {
              throw new BridgeAdapterError('envelope_malformed', 'Observed tool call differs from its durable reservation');
            }
            // Validate worktree boundary on tool events
            if (worktreeConfig) {
              const checked = reserved && ['Read', 'Write', 'Edit'].includes(toolName)
                ? { ...tp, input: { file_path: reserved.targetPath } } : tp;
              const wtCheck = worktreeGuard.validateToolEvent(toolName, checked, worktreeConfig);
              if (!wtCheck.valid) {
                throw new BridgeAdapterError(
                  'worktree_boundary_violation',
                  wtCheck.violation ?? 'Worktree boundary violation',
                );
              }
            }
            // Enforce permission: ToolGuard.check() throws PermissionDeniedError
            // if the tool is not allowed. This is the per-call enforcement that
            // complements BridgePermissionGuard's envelope-level check.
            toolGuard.check(toolName);
            // Write canonical tool_call transcript event
            if (this.options.requireToolEvidence) {
              if (!recorder.recordToolEvidenceCall || typeof tp.callId !== 'string') throw new BridgeAdapterError('envelope_malformed', 'Canonical call evidence is unavailable');
              recorder.recordToolEvidenceCall(runId, tp.callId);
            } else recorder.toolCall(runId, toolName, tp.input);
            // Also record bridge-specific progress for observability
            lifecycle.onBridgeProgress('tool_call', { toolName, callId: tp.callId });
            reconciliationEventCount++;
            break;
          }

          case 'tool_response': {
            const tp = envelope.payload as Record<string, unknown>;
            const toolName = (tp.toolName as string) ?? 'unknown';
            if (this.options.requireToolEvidence && (typeof tp.callId !== 'string' || evidenceCalls.get(tp.callId)?.toolName !== toolName)) {
              throw new BridgeAdapterError('envelope_malformed', 'Unreserved or repeated tool result');
            }
            if (worktreeConfig) {
              const wtCheck = worktreeGuard.validateToolEvent(toolName, tp, worktreeConfig);
              if (!wtCheck.valid) {
                throw new BridgeAdapterError(
                  'worktree_boundary_violation',
                  wtCheck.violation ?? 'Worktree boundary violation',
                );
              }
            }
            // Write canonical tool_result transcript event
            if (this.options.requireToolEvidence) {
              if (!recorder.recordToolEvidenceResult || typeof tp.callId !== 'string') throw new BridgeAdapterError('envelope_malformed', 'Canonical result evidence is unavailable');
              recorder.recordToolEvidenceResult(runId, tp.callId, tp.output);
              evidenceCalls.delete(tp.callId);
            } else recorder.toolResult(runId, toolName, tp.output);
            // Also record bridge-specific progress for observability
            lifecycle.onBridgeProgress('tool_result', { toolName, callId: tp.callId });
            reconciliationEventCount++;
            break;
          }

          case 'heartbeat': {
            // Liveness only. It neither consumes the business queue nor renews a deadline.
            break;
          }

          case 'approval_required': {
            recorder.progress(runId, {
              step: 'bridge_approval_required',
              payload: envelope.payload,
              reason:
                'External bridge requested approval; OpenSlack does not accept external approval decisions',
            });
            throw new BridgeAdapterError(
              'permission_denied',
              'Bridge runtime requested approval, which is not allowed for subagent runs',
            );
          }

          case 'complete': {
            if (evidenceCalls.size) throw new BridgeAdapterError('envelope_malformed', 'Bridge completed with unresolved full tool evidence');
            // Terminal envelope — extract final result
            const payload = envelope.payload as {
              data?: T;
              tokenUsage?: number;
              toolStats?: Record<string, unknown>;
              events?: Array<{ kind: string; payload: unknown }>;
            };
            if (!Object.hasOwn(payload, 'data') ||
              (payload.tokenUsage !== undefined && (!Number.isSafeInteger(payload.tokenUsage) || payload.tokenUsage < 0))) {
              throw new BridgeAdapterError('envelope_malformed', 'Bridge complete requires data and valid observed usage');
            }
            if (this.options.confirmProcessExit) recorder.progress(runId, {
              step: 'harness_usage', status: payload.tokenUsage === undefined ? 'unknown' : 'observed',
            });

            // Reconcile any events reported in the complete payload
            if (payload.events && Array.isArray(payload.events)) {
              reconciliationEventCount += payload.events.length;
            }

            finalResult = {
              data: payload.data as T,
              tokenUsage: payload.tokenUsage,
            };
            break;
          }

          case 'error': {
            const errorPayload = envelope.payload as BridgeErrorPayload;
            throw new BridgeAdapterError(errorPayload.kind, errorPayload.message);
          }

          default: {
            // Unknown envelope kind — record but continue
            lifecycle.onBridgeProgress('unknown_envelope', { kind: envelope.kind });
            break;
          }
        }
      }

      if (this.sessionMachine) {
        this.sessionMachine.transition('ready');
      }

      const durationMs = Date.now() - startTime;
      successfulSummary = BridgeLifecycleMapper.buildSummary(runId, sessionId, {
        tokenUsage: finalResult.tokenUsage,
        durationMs,
        resultSummary: { eventsProcessed: reconciliationEventCount },
      });
      return {
        data: finalResult.data,
        tokenUsage: finalResult.tokenUsage,
      };
    } catch (err) {
      executionError = err instanceof BridgeAdapterError ? err
        : deadline?.aborted && (err === context.signal?.reason || (err instanceof Error && err.name === 'TimeoutError'))
          ? new BridgeAdapterError('timeout', 'Bridge total deadline exceeded', undefined, { cause: err })
          : err instanceof Error ? err : new BridgeAdapterError('unknown', 'Bridge execution failed');
      if (executionError instanceof BridgeAdapterError && deadline?.aborted) executionError.deadlineExceeded = true;
      const sessionId = this.sessionMachine?.id ?? 'unknown';
      const errorKind = executionError instanceof BridgeAdapterError ? executionError.kind : 'unknown';
      const errorMessage = executionError.message;

      try {
        lifecycle.onSessionError({ kind: errorKind, message: errorMessage, sessionId });
      } catch (error) { diagnosticFailure ??= error; }

      throw executionError;
    } finally {
      // Post-session worktree validation: record boundary evidence only.
      // Dirty-state detection and worktree cleanup are the launcher's
      // responsibility — the bridge adapter must not fabricate dirty=false
      // evidence that would conflict with the launcher's real check.
      if (worktreeConfig) {
        try { worktreeGuard.recordPostSessionValidation(worktreeConfig); }
        catch (error) { diagnosticFailure ??= error; }
      }
      if (context.signal && this.abortListener) {
        context.signal.removeEventListener('abort', this.abortListener);
        this.abortListener = null;
      }
      this.activeSignal = undefined;
      this.activeExecutionDeadline = undefined;
      this.startEligibilityCheck = undefined;
      // Always close session
      if (this.sessionMachine) {
        // An unconfirmed exit invalidates success, even after a complete frame.
        try { await this.closeSession(this.sessionMachine.id); }
        catch (shutdownError) {
          if (!executionError) executionError = shutdownError instanceof Error ? shutdownError
            : new BridgeAdapterError('unknown', 'Bridge shutdown failed');
          if (executionError instanceof BridgeAdapterError) executionError.shutdownEvidence = { exit: this.processExitReceipt, clean: false };
        }
        // Explicit caller cancellation invalidates every provider's success,
        // including one whose complete frame arrived before clean EOF. Internal
        // completion/cleanup timing remains a separate trusted provider policy.
        const cancelled = callerSignal?.aborted === true;
        // Governed callers reserve cleanup inside their outer lifetime; an
        // already accepted complete may cross the inner business cutoff only.
        const expired = this.options.confirmProcessExit && context.executionDeadline === undefined &&
          (deadline?.aborted || Date.now() >= executionDeadline);
        if (!executionError && (cancelled || expired)) {
          const error = new BridgeAdapterError(cancelled ? 'unknown' : 'timeout',
            cancelled ? 'Bridge invocation cancelled during shutdown' : 'Bridge total deadline exceeded during shutdown',
            undefined, { cause: cancelled ? callerSignal?.reason : deadline?.reason });
          error.shutdownEvidence = { exit: this.processExitReceipt, clean: true };
          executionError = error;
        }
      }
      if (diagnosticFailure !== undefined) {
        if (!executionError) executionError = new BridgeAdapterError('unknown', 'Required Bridge evidence persistence failed', undefined, { cause: diagnosticFailure });
        if (executionError instanceof BridgeAdapterError) executionError.diagnosticPersistenceFailed = true;
      }
      if (executionError) throw executionError;
      // A completed lifecycle record must never precede strict stdout EOF and
      // the provider's exit policy. Failed persistence cannot create success.
      if (successfulSummary) {
        try { lifecycle.onSessionClose(successfulSummary); }
        catch (error) {
          const failure = new BridgeAdapterError('unknown', 'Required Bridge completion evidence persistence failed', undefined, { cause: error });
          failure.diagnosticPersistenceFailed = true;
          throw failure;
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async spawnProcess(config: BridgeSessionConfig): Promise<void> {
    this.assertExecutionWindow();
    const { command, args: configuredArgs = [], env: extraEnv } = this.options;

    const env = buildBridgeProcessEnv(config, extraEnv);

    const spawnOpts: Parameters<typeof spawn>[2] = {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    };

    if (config.worktreePath) {
      spawnOpts.cwd = config.worktreePath;
    }

    const spawnSignal = this.activeSignal;
    return new Promise((resolve, reject) => {
      this.assertExecutionWindow();
      const restriction = this.assertStartEligibility();
      if (restriction && restriction.runId !== config.runId) throw new BridgeAdapterError('permission_denied', 'Harness start belongs to another run');
      const args = [...configuredArgs];
      if (restriction) args.push('--start-eligibility-json', JSON.stringify(restriction));
      // Materializing argv/transport restrictions is synchronous work, but it
      // still spends the independently bounded business and known lease clocks.
      // No await or preparation may remain between these checks and spawn.
      this.assertExecutionWindow();
      this.assertStartEligibility();
      this.process = spawn(command, args, spawnOpts);
      const child = this.process;
      this.exitPromise = new Promise((settle) => {
        child.once('close', (code, signal) => {
          this.exitReceipt = { code, signal };
          settle(this.exitReceipt);
        });
      });

      this.process.on('error', (err) => {
        const error = new BridgeAdapterError('process_crash', 'Failed to spawn bridge process', undefined, { cause: err });
        reject(error);
        this.rejectInbound(error);
      });
      // A broken pipe is a transport outcome, never an unhandled host-process error.
      child.stdin?.on('error', (error: Error) => {
        if (this.process !== child || this.processExited) return;
        if (spawnSignal?.aborted) this.recordSecondaryPipeFailure(this.invocationAbortError ?? spawnSignal.reason, error);
        else this.rejectInbound(new BridgeAdapterError('process_crash', 'Bridge stdin transport failed', undefined, { cause: error }));
      });

      this.process.on('spawn', () => {
        if (this.activeSignal?.aborted) { this.requestPeerStop(); reject(this.activeSignal.reason); return; }
        resolve();
      });

      // Set up stdout data handler for envelope responses
      this.process.stdout?.on('data', (chunk: Buffer) => {
        if (this.options.supervisor) this.handleSupervisorChunk(chunk);
        else this.handleStdoutChunk(chunk);
      });

      this.process.stderr?.on('data', (chunk: Buffer) => {
        this.captureStderr(chunk);
      });

      // Handle process exit — set flag so future waitForResponse calls detect it
      this.process.on('close', (code, signal) => {
        try {
          this.responseBuffer += this.responseDecoder.decode();
          this.wireDecoder.finish();
          if (this.options.supervisor) {
            this.supervisorBuffer += this.supervisorDecoder.decode();
            if (this.supervisorBuffer.trim()) throw new Error('Truncated supervisor frame');
          }
          if (this.responseBuffer.trim()) {
            this.inboundFailure ??= new BridgeAdapterError('envelope_malformed', 'Truncated Bridge frame');
          }
        } catch {
          this.inboundFailure ??= new BridgeAdapterError('envelope_malformed', 'Invalid UTF-8 or truncated Bridge output');
        }
        this.processExited = true;
        if (this.pendingReject) {
          this.pendingReject(
            this.inboundFailure ?? new BridgeAdapterError(
              'process_crash',
              `Bridge process exited with code ${code}, signal ${signal}`,
              this.getStderrSummary(),
            ),
          );
          this.pendingResponse = null;
          this.pendingReject = null;
          if (this.responseTimer) clearTimeout(this.responseTimer);
          this.responseTimer = null;
        }
      });
    });
  }

  private async performHandshake(sessionId: string, config: BridgeSessionConfig): Promise<void> {
    this.assertExecutionWindow();
    const handshakeEnvelope = buildBridgeEnvelope(sessionId, config.runId, 'handshake_request', {
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      requestedCapabilities: config.permissionProfile.allowedTools.map((tool) => ({ name: tool })),
      ...(this.options.wireExtensions?.length ? { extensions: [...this.options.wireExtensions] } : {}),
    });

    await this.sendEnvelope(sessionId, handshakeEnvelope);
    this.assertInvocationSignal();

    const response = await this.waitForResponse(
      this.options.handshakeTimeoutMs ?? ABY_BRIDGE_RUNTIME_LIMITS.handshakeTimeoutMs.default,
    );

    const validation = validateBridgeEnvelope(response);
    if (!validation.valid || response.sessionId !== sessionId || response.correlationId !== config.runId) {
      throw new BridgeAdapterError('handshake_failed', 'Bridge handshake identity mismatch');
    }

    if (response.kind !== 'handshake_response') {
      throw new BridgeAdapterError(
        'handshake_failed',
        `Expected handshake_response, got ${response.kind}`,
      );
    }

    const payload = response.payload as { accepted: boolean; reason?: string; extensions?: unknown };
    if (!payload.accepted) {
      throw new BridgeAdapterError(
        'handshake_failed',
        payload.reason ?? 'Handshake rejected by bridge runtime',
      );
    }
    if (payload.extensions !== undefined && (!Array.isArray(payload.extensions) ||
      payload.extensions.some(value => value !== BRIDGE_CHUNK_EXTENSION || !this.options.wireExtensions?.includes(value)))) {
      throw new BridgeAdapterError('handshake_failed', 'Peer advertised an unrequested Bridge extension');
    }
    const negotiated = (payload.extensions ?? []) as string[];
    this.wireEncoder.setExtensions(negotiated);
    this.wireDecoder.setExtensions(negotiated);
  }

  private handleStdoutChunk(chunk: Buffer): void {
    // The first malformed stream already forbids success. Drain/discard further
    // child bytes without growing a buffer while a live authority port settles.
    if (this.inboundFailure) return;
    try { this.responseBuffer += this.responseDecoder.decode(chunk, { stream: true }); }
    catch { this.rejectInbound(new BridgeAdapterError('envelope_malformed', 'Invalid UTF-8 Bridge output')); return; }
    // A completed deferred message keeps its original position. Bytes already
    // delivered in this OS read stay bounded as raw input until it is dequeued.
    if (this.deferredEnvelope) {
      if (Buffer.byteLength(this.responseBuffer) > BRIDGE_FRAME_MAX_BYTES) this.rejectInbound(new BridgeAdapterError('envelope_malformed', 'Bridge producer exceeded paused-input bounds'));
      return;
    }

    // Process complete lines (JSONL)
    const lines = this.responseBuffer.split('\n');
    this.responseBuffer = lines.pop() ?? ''; // Keep incomplete line
    if (Buffer.byteLength(this.responseBuffer) > Math.min(this.options.maxEnvelopeSizeBytes ?? MAX_ENVELOPE_SIZE_BYTES, BRIDGE_FRAME_MAX_BYTES)) {
      this.rejectInbound(new BridgeAdapterError('envelope_malformed', 'Unterminated Bridge frame exceeds maximum size'));
      return;
    }

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex]!;
      if (!line.trim()) continue;

      try {
        if (Buffer.byteLength(line) > Math.min(this.options.maxEnvelopeSizeBytes ?? MAX_ENVELOPE_SIZE_BYTES, BRIDGE_FRAME_MAX_BYTES)) {
          throw new Error('Inbound envelope exceeds maximum size');
        }
        const decoded = this.wireDecoder.receive(line);
        if (!decoded) continue;
        const envelope = decoded as unknown as BridgeEnvelope;
        if (envelope.kind === 'heartbeat') continue;
        if (this.terminalFrames && envelope.kind !== 'complete' && envelope.kind !== 'error') throw new Error('Bridge business frame followed a terminal envelope');
        if (envelope.kind === 'complete' || envelope.kind === 'error') this.terminalFrames++;
        if (this.terminalFrames > 1) throw new Error('Duplicate terminal Bridge frame');
        // Queue-based processing: if a waiter exists, resolve immediately;
        // otherwise enqueue for the next waitForResponse call
        if (this.pendingResponse) {
          // Clear the timer first to prevent leaks
          if (this.responseTimer !== null) {
            clearTimeout(this.responseTimer);
            this.responseTimer = null;
          }
          this.pendingResponse(envelope);
          this.pendingResponse = null;
          this.pendingReject = null;
        } else {
          const bytes = Buffer.byteLength(JSON.stringify(envelope));
          if (this.queueBytes + bytes > BRIDGE_QUEUE_MAX_BYTES) {
            if (this.deferredEnvelope) throw new Error('Bridge producer exceeded byte backpressure');
            this.deferredEnvelope = envelope;
            this.process?.stdout?.pause();
            const remaining = lines.slice(lineIndex + 1);
            this.responseBuffer = (remaining.length ? remaining.join('\n') + '\n' : '') + this.responseBuffer;
            break;
          } else {
            this.envelopeQueue.push(envelope);
            this.queueBytes += bytes;
          }
        }
      } catch (error) {
        this.rejectInbound(new BridgeAdapterError('envelope_malformed', error instanceof Error ? error.message : 'Invalid Bridge output'));
        return;
      }
    }
  }

  private handleSupervisorChunk(chunk: Buffer): void {
    try {
      this.supervisorBuffer += this.supervisorDecoder.decode(chunk, { stream: true });
      const lines = this.supervisorBuffer.split('\n');
      this.supervisorBuffer = lines.pop() ?? '';
      if (Buffer.byteLength(this.supervisorBuffer) > BRIDGE_FRAME_MAX_BYTES) throw new Error('Supervisor frame exceeds bound');
      for (const line of lines) {
        if (!line || Buffer.byteLength(line) > BRIDGE_FRAME_MAX_BYTES) throw new Error('Invalid supervisor frame');
        const value = JSON.parse(line) as Record<string, unknown>;
        const scope = this.options.supervisor!;
        if (!value || typeof value !== 'object' || Array.isArray(value) || value.protocol !== scope.protocol ||
          value.runId !== scope.runId || value.generation !== scope.generation || this.supervisorReceipt) throw new Error('Unrelated supervisor frame');
        if (value.kind === 'spawned') {
          if (this.supervisorPid || Object.keys(value).sort().join(',') !== 'generation,kind,pid,protocol,runId' ||
            !Number.isSafeInteger(value.pid) || (value.pid as number) <= 0) throw new Error('Invalid supervisor spawn receipt');
          this.supervisorPid = value.pid as number;
        } else if (value.kind === 'bridge-bytes') {
          if (!this.supervisorPid || Object.keys(value).sort().join(',') !== 'data,generation,kind,protocol,runId' ||
            typeof value.data !== 'string' || value.data.length > Math.ceil(65536 / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.data)) throw new Error('Invalid supervised byte frame');
          const bytes = Buffer.from(value.data, 'base64');
          if (!bytes.length || bytes.length > 65536 || bytes.toString('base64') !== value.data) throw new Error('Invalid supervised Base64 bytes');
          this.handleStdoutChunk(bytes);
        } else if (value.kind === 'exit-receipt') {
          if (!this.supervisorPid || value.pid !== this.supervisorPid ||
            Object.keys(value).sort().join(',') !== 'generation,graceful,jobEmpty,kind,pid,protocol,rootExitCode,runId,streamsDrained,terminationRequested,timedOut' ||
            !Number.isSafeInteger(value.rootExitCode) || ['jobEmpty', 'streamsDrained', 'terminationRequested', 'graceful', 'timedOut'].some(key => typeof value[key] !== 'boolean')) {
            throw new Error('Invalid supervisor exit receipt');
          }
          this.supervisorReceipt = value as unknown as NonNullable<typeof this.supervisorReceipt>;
        } else throw new Error('Unknown supervisor frame');
      }
    } catch (error) {
      this.supervisorBuffer = '';
      this.rejectInbound(new BridgeAdapterError('process_crash', error instanceof Error ? error.message : 'Supervisor observation failed'));
    }
  }

  private rejectInbound(error: BridgeAdapterError): void {
    this.inboundFailure ??= error;
    this.transportAbort.abort(this.inboundFailure);
    this.pendingReject?.(this.inboundFailure);
    this.pendingReject = null;
    this.pendingResponse = null;
    if (this.responseTimer) clearTimeout(this.responseTimer);
    this.responseTimer = null;
  }

  private waitForResponse(timeoutMs: number): Promise<BridgeEnvelope> {
    // Abort may have fired after an async send while there was no waiter for
    // its listener to reject. Never register a fresh waiter for that signal.
    // This is the invocation signal (including bounded completion grace), not
    // the stricter business-action cutoff checked before tool effects.
    this.assertInvocationSignal();
    if (this.inboundFailure) return Promise.reject(this.inboundFailure);
    // Validated queued frames precede process-close: close may follow a complete in the same OS read.
    if (this.envelopeQueue.length > 0) {
      const envelope = this.envelopeQueue.shift()!;
      this.queueBytes -= Buffer.byteLength(JSON.stringify(envelope));
      if (this.deferredEnvelope) {
        const bytes = Buffer.byteLength(JSON.stringify(this.deferredEnvelope));
        if (this.queueBytes + bytes <= BRIDGE_QUEUE_MAX_BYTES) {
          this.envelopeQueue.push(this.deferredEnvelope); this.queueBytes += bytes;
          this.deferredEnvelope = undefined;
          this.handleStdoutChunk(Buffer.alloc(0));
          if (!this.deferredEnvelope) this.process?.stdout?.resume();
        }
      }
      return Promise.resolve(envelope);
    }
    // Check if process already exited before waiting
    if (this.processExited) {
      return Promise.reject(
        new BridgeAdapterError(
          'process_crash',
          'Bridge process has already exited',
          this.getStderrSummary(),
        ),
      );
    }

    return new Promise((resolve, reject) => {
      if (this.activeSignal?.aborted) { reject(this.invocationAbortError ?? this.activeSignal.reason); return; }
      this.pendingResponse = resolve;
      this.pendingReject = reject;

      this.responseTimer = setTimeout(() => {
        if (this.pendingReject) {
          this.pendingReject(
            new BridgeAdapterError(
              'timeout',
              `Bridge response timed out after ${timeoutMs}ms`,
              this.getStderrSummary(),
            ),
          );
          this.pendingResponse = null;
          this.pendingReject = null;
        }
        this.responseTimer = null;
      }, timeoutMs);
    });
  }

  private captureStderr(chunk: Buffer): void {
    this.stderrBuffer += chunk.toString('utf-8');
    if (this.stderrBuffer.length > 4096) {
      this.stderrBuffer = this.stderrBuffer.slice(this.stderrBuffer.length - 4096);
    }
  }

  private getStderrSummary(): string | undefined {
    const lines = this.stderrBuffer
      .split(/\r?\n/)
      .map((line) => redactStderrLine(line.trim()))
      .filter(Boolean)
      .slice(-5);
    return lines.length > 0 ? lines.join(' | ') : undefined;
  }

  private async confirmExit(): Promise<void> {
    const child = this.process;
    const exited = this.exitPromise;
    if (!child || !exited) return;
    this.requestPeerStop();
    const deadline = this.cleanupDeadline!;
    const started = this.cleanupStartedAt!;
    const wait = async (until: number): Promise<boolean> => {
      if (this.exitReceipt) return true;
      const remaining = Math.max(0, Math.min(until, deadline) - Date.now());
      if (!remaining) return false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          exited.then(() => true),
          new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), remaining); }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    let forced = false;
    // The native helper owns its 25s+5s ladder. The host never grants a new
    // grace after the first EOF, nor a second 30s window after killing it.
    if (this.options.supervisor) {
      if (!await wait(deadline)) {
        child.kill('SIGKILL');
        throw new BridgeAdapterError('process_crash', 'Supervisor cleanup deadline exceeded; process-tree exit remains unknown');
      }
    } else if (!await wait(started + (deadline - started) * 5 / 6)) {
      forced = true;
      // Windows signals are forceful: only the owned Job helper may coordinate descendants.
      child.kill(this.options.supervisor || process.platform === 'win32' ? 'SIGKILL' : 'SIGTERM');
      if (!await wait(started + (deadline - started) * 11 / 12)) {
        child.kill('SIGKILL');
        if (!await wait(deadline)) {
          throw new BridgeAdapterError('process_crash', 'Bridge exit and side effects remain unknown');
        }
      }
    }
    this.process = null;
    if (this.inboundFailure) throw this.inboundFailure;
    const receipt = this.supervisorReceipt;
    if (this.options.supervisor && (!receipt || !receipt.jobEmpty || !receipt.streamsDrained || receipt.rootExitCode !== 0 ||
      receipt.terminationRequested || !receipt.graceful || receipt.timedOut)) {
      throw new BridgeAdapterError('process_crash', 'Windows owned process-tree shutdown is unconfirmed or forced');
    }
    if (this.options.confirmProcessExit && (forced || Date.now() > deadline || this.exitReceipt?.code !== 0 || this.exitReceipt.signal !== null)) {
      throw new BridgeAdapterError('process_crash', 'Bridge did not confirm a clean owned shutdown');
    }
  }

  private async authorizePeerTool(context: AdapterExecutionContext, toolName: string, input: unknown): Promise<void | HarnessToolEligibility> {
    const signal = context.signal;
    let aborted: (() => void) | undefined;
    try {
      signal?.throwIfAborted();
      const check = this.options.authorizeTool!(context, toolName, input);
      if (!signal) return await check;
      return await Promise.race([check, new Promise<never>((_resolve, reject) => {
        if (signal.aborted) { reject(signal.reason); return; }
        aborted = () => reject(signal.reason);
        signal.addEventListener('abort', aborted, { once: true });
      })]);
    } finally {
      if (signal && aborted) signal.removeEventListener('abort', aborted);
    }
  }

  private assertExecutionWindow(): void {
    this.assertInvocationSignal();
    if (this.activeExecutionDeadline !== undefined && Date.now() >= this.activeExecutionDeadline) {
      throw new BridgeAdapterError('timeout', 'Bridge execution cutoff exceeded');
    }
  }

  private assertInvocationSignal(): void {
    if (this.activeSignal?.aborted) throw this.invocationAbortError ?? this.activeSignal.reason;
  }

  private assertStartEligibility(): Readonly<{ runId: string; generation: string; restriction: HarnessEligibilityRestriction }> | undefined {
    if (!this.options.requireToolEvidence) return undefined;
    try {
      if (!this.startEligibilityCheck) throw new Error('Missing nominal start observation');
      return this.startEligibilityCheck();
    } catch (cause) {
      throw new BridgeAdapterError('permission_denied', 'Known Harness start eligibility is missing, mismatched or its lease expired', undefined, { cause });
    }
  }

  private awaitSendBoundary(work: Promise<void>, signal: AbortSignal | undefined, cancellation: () => unknown): Promise<void> {
    if (!signal) return work;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: { value: unknown }) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', aborted);
        if (error) reject(error.value); else resolve();
      };
      const aborted = () => finish({ value: cancellation() });
      // Always consume work's eventual failure, including after cancellation.
      work.then(() => finish(), error => finish({ value: error }));
      signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) aborted();
    });
  }

  private recordSecondaryPipeFailure(primary: unknown, error: Error): void {
    if (!(primary instanceof BridgeAdapterError)) return;
    try {
      const code: unknown = Object.getOwnPropertyDescriptor(error, 'code')?.value;
      primary.secondaryTransportFailure ??= Object.freeze({ kind: 'process_crash',
        ...(typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? { code } : {}) });
    } catch { /* Secondary evidence never replaces the cancellation or throws from an event listener. */ }
  }

  private killProcess(): void {
    // Retain every provider's process until EOF and exit are observed. EOF is
    // the cooperative request; confirmExit owns the single bounded escalation.
    // In particular, Windows SIGTERM bypasses peer shutdown handlers.
    this.requestPeerStop();
  }

  private requestPeerStop(): void {
    if (this.cleanupDeadline === undefined) {
      this.cleanupStartedAt = Date.now();
      const budget = this.options.requireToolEvidence || this.options.supervisor ? 30_000 : this.options.exitGraceMs ?? 5_000;
      this.cleanupDeadline = this.cleanupStartedAt + budget;
    }
    this.process?.stdin?.end();
  }
}

/**
 * Error thrown by bridge adapters with structured error kind.
 */
export class BridgeAdapterError extends Error {
  readonly kind: BridgeErrorKind;
  readonly stderrSummary?: string;
  /** Orthogonal exit facts retained without replacing the original failure. */
  shutdownEvidence?: { exit: { code: number | null; signal: NodeJS.Signals | null } | null; clean: boolean };
  /** Orthogonal deadline fact; it never overwrites an already captured primary failure kind. */
  deadlineExceeded?: boolean;
  /** Evidence failures remain orthogonal to an earlier transport/permission error. */
  diagnosticPersistenceFailed?: boolean;
  /** A late pipe failure is secondary to the already captured invocation cancellation. */
  secondaryTransportFailure?: Readonly<{ kind: 'process_crash'; code?: string }>;

  constructor(kind: BridgeErrorKind, message: string, stderrSummary?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'BridgeAdapterError';
    this.kind = kind;
    this.stderrSummary = stderrSummary;
  }
}

function redactStderrLine(line: string): string {
  return line.replace(
    /([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PRIVATE|PEM|CREDENTIAL|KEY)[A-Z0-9_]*\s*[:=]\s*)\S+/gi,
    '$1[redacted]',
  );
}

/**
 * FakeBridgeAdapter — in-memory bridge for CI and testing.
 *
 * Implements BridgeContract + AgentExecutionAdapter without spawning processes.
 * Produces deterministic responses wrapped in BridgeEnvelope format.
 */
export interface FakeBridgeAdapterOptions {
  /** Simulated response delay in milliseconds. */
  responseDelayMs?: number;
  /** Force the adapter to fail. */
  shouldFail?: boolean;
  /** Custom response template function. */
  customResponseTemplate?: (prompt: string) => Record<string, unknown>;
  /** List of MCP servers this fake bridge reports as available. */
  availableMcpServers?: string[];
}

export class FakeBridgeAdapter implements AgentExecutionAdapter, BridgeContract {
  readonly adapterId = 'fake-bridge';
  readonly bridgeId = 'fake-bridge';
  /** Exposes this adapter as a BridgeContract for consumers of AgentExecutionAdapter. */
  readonly bridgeContract = this;

  private readonly options: FakeBridgeAdapterOptions;
  private sessionMachine: BridgeSessionStateMachine | null = null;
  private negotiatedCaps: BridgeCapabilityDescriptor[] = [];

  constructor(options: FakeBridgeAdapterOptions = {}) {
    this.options = options;
  }

  // ---------------------------------------------------------------------------
  // BridgeContract implementation
  // ---------------------------------------------------------------------------

  async negotiateCapabilities(
    requested: BridgeCapabilityDescriptor[],
  ): Promise<BridgeCapabilityDescriptor[]> {
    // Report only available MCP servers, don't claim all requested
    const mcpServers = this.options.availableMcpServers ?? [];
    this.negotiatedCaps = requested.filter((cap) => {
      if (cap.name.startsWith('mcp.')) {
        const serverName = cap.name.split('.')[1];
        return mcpServers.includes(serverName);
      }
      return true; // Non-MCP capabilities are always "supported" in fake mode
    });
    return this.negotiatedCaps;
  }

  async openSession(config: BridgeSessionConfig): Promise<BridgeSessionState> {
    const sessionId = `fake-${config.runId}`;
    this.sessionMachine = new BridgeSessionStateMachine(sessionId);
    this.sessionMachine.transition('initializing');
    this.sessionMachine.transition('ready');
    return this.sessionMachine.currentState;
  }

  async closeSession(_sessionId: string): Promise<BridgeSessionState> {
    if (!this.sessionMachine) return 'shutdown';
    this.sessionMachine.forceShutdown();
    return 'shutdown';
  }

  async sendEnvelope<T>(_sessionId: string, _envelope: BridgeEnvelope<T>): Promise<void> {
    if (!this.sessionMachine || this.sessionMachine.currentState === 'shutdown') {
      throw new BridgeAdapterError('session_unavailable', 'Fake bridge session not active');
    }
    // In-memory: envelopes are processed synchronously by execute()
    // No actual I/O needed
  }

  async healthCheck(): Promise<{ healthy: boolean; details?: Record<string, unknown> }> {
    return { healthy: true, details: { mode: 'fake' } };
  }

  // ---------------------------------------------------------------------------
  // AgentExecutionAdapter implementation
  // ---------------------------------------------------------------------------

  async execute<T>(context: AdapterExecutionContext): Promise<AdapterExecutionResult<T>> {
    const { prompt, runId, permissionProfile, recorder, toolGuard } = context;

    const lifecycle = new BridgeLifecycleMapper(recorder, runId);
    const guard = new BridgePermissionGuard(permissionProfile, recorder, runId);
    const worktreeGuard = new BridgeWorktreeGuard(recorder, runId);
    const startTime = Date.now();

    // Validate MCP servers if configured
    const availableMcpServers = this.options.availableMcpServers ?? [];
    recorder.progress(runId, {
      step: 'bridge_mcp_availability',
      required: context.resolvedConfig.requiredMcpServers ?? [],
      available: availableMcpServers,
    });
    if (
      context.resolvedConfig.requiredMcpServers &&
      context.resolvedConfig.requiredMcpServers.length > 0
    ) {
      const mcpDescriptors = buildMcpServerDescriptors(context.resolvedConfig.requiredMcpServers);
      validateRequiredMcpServers(mcpDescriptors, availableMcpServers);
    }

    // Filter outbound tools through BridgePermissionGuard
    const outboundFiltered = guard.filterOutboundTools(permissionProfile.allowedTools);

    // Build worktree config if available
    const worktreeConfig = BridgeWorktreeGuard.buildConfig(context.worktreePath);

    const sessionConfig: BridgeSessionConfig = {
      runId,
      agentId: context.agentId,
      prompt,
      permissionProfile: {
        allowedTools: outboundFiltered.allowed,
        deniedTools: [...permissionProfile.deniedTools, ...outboundFiltered.denied],
        permissionMode: permissionProfile.permissionMode,
      },
      worktreePath: context.worktreePath,
      metadata: {
        worktree: worktreeConfig,
      },
    };

    // Open session
    await this.openSession(sessionConfig);
    const sessionId = this.sessionMachine!.id;
    lifecycle.onSessionOpen(sessionId);

    // Check shouldFail AFTER session open so lifecycle is symmetric (started -> failed)
    if (this.options.shouldFail) {
      lifecycle.onSessionError({
        kind: 'unknown',
        message: 'Fake bridge configured to fail',
        sessionId,
      });
      if (this.sessionMachine) {
        await this.closeSession(this.sessionMachine.id);
      }
      throw new BridgeAdapterError('unknown', 'Fake bridge configured to fail');
    }

    // Simulate tool usage: only tools that pass the guard
    const candidateTools = permissionProfile.allowedTools.slice(0, 3);
    const simulatedTools: string[] = [];
    for (const tool of candidateTools) {
      if (toolGuard.isAllowed(tool)) {
        toolGuard.check(tool);
        simulatedTools.push(tool);
        recorder.toolCall(runId, tool, { query: prompt.slice(0, 50) });
        recorder.toolResult(runId, tool, { found: true, matches: 1 });
      }
    }

    // Simulate delay
    if (this.options.responseDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, this.options.responseDelayMs));
    }

    // Generate deterministic response based on prompt
    const response = this.generateResponse(prompt, simulatedTools);

    const durationMs = Date.now() - startTime;
    const summary = BridgeLifecycleMapper.buildSummary(runId, sessionId, {
      tokenUsage: response.tokenUsage,
      durationMs,
    });
    lifecycle.onSessionClose(summary);

    // Post-session worktree validation: boundary evidence only.
    // Dirty-state detection is the launcher's responsibility.
    if (worktreeConfig) {
      worktreeGuard.recordPostSessionValidation(worktreeConfig);
    }

    // Close session
    if (this.sessionMachine) {
      await this.closeSession(this.sessionMachine.id);
    }

    return {
      data: response.data as T,
      tokenUsage: response.tokenUsage,
    };
  }

  private generateResponse(
    prompt: string,
    toolsUsed: string[],
  ): { data: Record<string, unknown>; tokenUsage: number } {
    if (this.options.customResponseTemplate) {
      const data = this.options.customResponseTemplate(prompt);
      return { data, tokenUsage: estimateTokenUsage(prompt, data) };
    }

    const lowerPrompt = prompt.toLowerCase();

    if (lowerPrompt.includes('review') || lowerPrompt.includes('check')) {
      return {
        data: {
          review: 'Fake bridge review: no issues found in analyzed scope.',
          findings: [],
          approved: true,
        },
        tokenUsage: estimateTokenUsage(prompt, { review: 'placeholder' }),
      };
    }

    if (
      lowerPrompt.includes('research') ||
      lowerPrompt.includes('find') ||
      lowerPrompt.includes('search')
    ) {
      return {
        data: {
          summary: 'Fake bridge research: analyzed available context.',
          sources: ['fake-bridge-context'],
          confidence: 'medium',
        },
        tokenUsage: estimateTokenUsage(prompt, { summary: 'placeholder' }),
      };
    }

    if (lowerPrompt.includes('plan') || lowerPrompt.includes('design')) {
      return {
        data: {
          plan: [
            'Step 1: Analyze requirements',
            'Step 2: Implement changes',
            'Step 3: Validate results',
          ],
          estimatedEffort: 'medium',
        },
        tokenUsage: estimateTokenUsage(prompt, { plan: 'placeholder' }),
      };
    }

    return {
      data: {
        response: 'Fake bridge executed successfully.',
        promptAnalyzed: true,
        toolsUsed,
      },
      tokenUsage: estimateTokenUsage(prompt, { response: 'placeholder' }),
    };
  }
}

function estimateTokenUsage(prompt: string, result: unknown): number {
  const promptTokens = Math.ceil(prompt.length / 4);
  const resultTokens = Math.ceil(JSON.stringify(result).length / 4);
  return promptTokens + resultTokens + 50;
}
