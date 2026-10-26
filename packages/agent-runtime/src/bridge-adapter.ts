/**
 * Bridge Adapter — BridgeProcessAdapter for external runtimes and
 * FakeBridgeAdapter for CI. Generic over any BridgeContract-compliant
 * external process.
 *
 * AR-2.5B: Aby External Adapter
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { TextDecoder } from 'node:util';
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
  /** Require a matching frame identity and confirmed child exit before returning. */
  confirmProcessExit?: boolean;
  /** Grace per shutdown phase when exit confirmation is required. */
  exitGraceMs?: number;
  /** Live host authorization for a peer's pre-effect tool request; absence always rejects it. */
  authorizeTool?: (context: AdapterExecutionContext, toolName: string, input: unknown) => Promise<void>;
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

  /** Last observed OS process exit, not merely a signal request. */
  get processExitReceipt() {
    return this.exitReceipt ? { ...this.exitReceipt } : null;
  }

  constructor(options: BridgeProcessAdapterOptions) {
    this.options = options;
    this.responseDecoder = new TextDecoder('utf-8', { fatal: options.confirmProcessExit === true });
  }

  // ---------------------------------------------------------------------------
  // BridgeContract implementation
  // ---------------------------------------------------------------------------

  async negotiateCapabilities(
    requested: BridgeCapabilityDescriptor[],
  ): Promise<BridgeCapabilityDescriptor[]> {
    // For process-based bridges, capabilities are negotiated during handshake
    // Return intersection of requested and runtime-supported caps
    // Actual negotiation happens in the handshake envelope exchange
    return requested;
  }

  async openSession(config: BridgeSessionConfig): Promise<BridgeSessionState> {
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
    this.responseDecoder = new TextDecoder('utf-8', { fatal: this.options.confirmProcessExit === true });
    this.inboundFailure = null;
    this.terminalFrames = 0;
    this.envelopeQueue = [];
    this.stderrBuffer = '';
    this.sessionMachine = new BridgeSessionStateMachine(sessionId);

    // Spawn the external process
    await this.spawnProcess(config);

    this.sessionMachine.transition('initializing');

    // Perform handshake
    await this.performHandshake(sessionId, config);

    this.sessionMachine.transition('ready');
    return this.sessionMachine.currentState;
  }

  async closeSession(_sessionId: string): Promise<BridgeSessionState> {
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
    this.pendingResponse = null;
    this.pendingReject = null;
    this.envelopeQueue = [];

    if (this.options.confirmProcessExit) {
      await this.confirmExit();
    } else {
      this.killProcess();
    }
    return 'shutdown';
  }

  async sendEnvelope<T>(_sessionId: string, envelope: BridgeEnvelope<T>): Promise<void> {
    if (!this.process || this.process.killed) {
      throw new BridgeAdapterError('process_crash', 'Bridge process not running');
    }

    if (!this.sessionMachine || this.sessionMachine.currentState === 'shutdown') {
      throw new BridgeAdapterError('session_unavailable', 'Bridge session not active');
    }

    const json = JSON.stringify(envelope);
    if (Buffer.byteLength(json) > (this.options.maxEnvelopeSizeBytes ?? MAX_ENVELOPE_SIZE_BYTES)) {
      throw new BridgeAdapterError('envelope_malformed', 'Envelope exceeds maximum size');
    }

    const stdin = this.process.stdin;
    if (!stdin) {
      throw new BridgeAdapterError('process_crash', 'Bridge process stdin not available');
    }
    const flushed = stdin.write(json + '\n');
    if (!flushed) {
      // Backpressure: data is queued but not flushed. Not an error, but note it.
      // If stdin is closed (EPIPE), the 'error' event will fire on the stream.
    }
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
    let deadline: AbortSignal | undefined;
    let executionError: Error | undefined;
    if (this.options.confirmProcessExit) {
      deadline = AbortSignal.timeout(this.options.timeoutMs ?? ABY_BRIDGE_RUNTIME_LIMITS.timeoutMs.default);
      context = { ...context, signal: context.signal ? AbortSignal.any([context.signal, deadline]) : deadline };
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

    const lifecycle = new BridgeLifecycleMapper(recorder, runId);
    const guard = new BridgePermissionGuard(permissionProfile, recorder, runId);
    const worktreeGuard = new BridgeWorktreeGuard(recorder, runId);
    const startTime = Date.now();

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
      timeout: this.options.timeoutMs ?? ABY_BRIDGE_RUNTIME_LIMITS.timeoutMs.default,
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

    try {
      context.signal?.throwIfAborted();
      if (context.signal) {
        this.abortListener = () => {
          lifecycle.onBridgeProgress('agent_cancel_requested', { runId, reason: 'AbortSignal' });
          this.killProcess();
        };
        if (context.signal.aborted) {
          this.abortListener();
        } else {
          context.signal.addEventListener('abort', this.abortListener, { once: true });
        }
      }
      // Open session (spawns process + handshake)
      const sessionState = await this.openSession(sessionConfig);
      context.signal?.throwIfAborted();
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

      context.signal?.throwIfAborted();
      await this.sendEnvelope(this.sessionMachine!.id, execEnvelope);

      // Multi-envelope event loop: process intermediate envelopes until
      // a terminal envelope (complete or error) arrives. This handles
      // real bridge runtimes that emit progress/tool events before
      // producing a final result.
      const totalTimeoutMs = this.options.timeoutMs ?? ABY_BRIDGE_RUNTIME_LIMITS.timeoutMs.default;
      let finalResult: { data: T; tokenUsage?: number } | null = null;
      const reconciliationEvents: Array<{ kind: string; payload: unknown }> = [];

      while (finalResult === null) {
        // Track elapsed time so the total budget is shared across all
        // envelopes, not multiplied per envelope.
        const elapsed = Date.now() - startTime;
        const remaining = totalTimeoutMs - elapsed;
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
        if (this.options.confirmProcessExit &&
          (envelope.sessionId !== sessionId || envelope.correlationId !== runId)) {
          throw new BridgeAdapterError('envelope_malformed', 'Bridge frame belongs to another run');
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
            reconciliationEvents.push({ kind: envelope.kind, payload: envelope.payload });
            break;
          }

          case 'assistant_text': {
            lifecycle.onBridgeProgress(
              'assistant_text',
              envelope.payload as Record<string, unknown>,
            );
            reconciliationEvents.push({ kind: envelope.kind, payload: envelope.payload });
            break;
          }

          case 'progress': {
            lifecycle.onBridgeProgress('event', envelope.payload as Record<string, unknown>);
            reconciliationEvents.push({ kind: envelope.kind, payload: envelope.payload });
            break;
          }

          case 'tool_request': {
            const tp = envelope.payload as Record<string, unknown>;
            const toolName = (tp.toolName as string) ?? 'unknown';
            if (tp.phase === 'authorize') {
              let allowed = false;
              try {
                context.signal?.throwIfAborted();
                toolGuard.check(toolName);
                if (!this.options.authorizeTool || typeof tp.authorizationRequestId !== 'string') {
                  throw new Error('Live authorization port is not configured');
                }
                await this.authorizePeerTool(context, toolName, structuredClone(tp.input));
                context.signal?.throwIfAborted();
                allowed = true;
              } catch {
                // Return no principal, path or upstream exception text to the untrusted caller.
              }
              await this.sendEnvelope(sessionId, buildBridgeEnvelope(sessionId, runId, 'tool_response', {
                authorizationRequestId: tp.authorizationRequestId, allowed,
              }));
              recorder.progress(runId, { step: 'harness_tool_authorization', toolName, allowed });
              if (!allowed) throw new BridgeAdapterError('permission_denied', 'Live host tool authorization denied');
              break;
            }
            // Validate worktree boundary on tool events
            if (worktreeConfig) {
              const wtCheck = worktreeGuard.validateToolEvent(toolName, tp, worktreeConfig);
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
            recorder.toolCall(runId, toolName, tp.input);
            // Also record bridge-specific progress for observability
            lifecycle.onBridgeToolCall(toolName, tp.input);
            reconciliationEvents.push({ kind: envelope.kind, payload: envelope.payload });
            break;
          }

          case 'tool_response': {
            const tp = envelope.payload as Record<string, unknown>;
            const toolName = (tp.toolName as string) ?? 'unknown';
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
            recorder.toolResult(runId, toolName, tp.output);
            // Also record bridge-specific progress for observability
            lifecycle.onBridgeToolResult(toolName, tp.output);
            reconciliationEvents.push({ kind: envelope.kind, payload: envelope.payload });
            break;
          }

          case 'heartbeat': {
            // Liveness signal — no action needed, just prevents timeout
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
            // Terminal envelope — extract final result
            const payload = envelope.payload as {
              data?: T;
              tokenUsage?: number;
              toolStats?: Record<string, unknown>;
              events?: Array<{ kind: string; payload: unknown }>;
            };
            if (this.options.confirmProcessExit && (!Object.hasOwn(payload, 'data') ||
              (payload.tokenUsage !== undefined && (!Number.isSafeInteger(payload.tokenUsage) || payload.tokenUsage < 0)))) {
              throw new BridgeAdapterError('envelope_malformed', 'Bridge complete requires data and valid observed usage');
            }
            if (this.options.confirmProcessExit) recorder.progress(runId, {
              step: 'harness_usage', status: payload.tokenUsage === undefined ? 'unknown' : 'observed',
            });

            // Reconcile any events reported in the complete payload
            if (payload.events && Array.isArray(payload.events)) {
              for (const evt of payload.events) {
                reconciliationEvents.push(evt);
              }
            }

            finalResult = {
              data: this.options.confirmProcessExit ? payload.data as T : payload.data ?? ({} as T),
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
      const summary = BridgeLifecycleMapper.buildSummary(runId, sessionId, {
        tokenUsage: finalResult.tokenUsage,
        durationMs,
        resultSummary: { eventsProcessed: reconciliationEvents.length },
      });
      lifecycle.onSessionClose(summary);

      return {
        data: finalResult.data,
        tokenUsage: finalResult.tokenUsage,
      };
    } catch (err) {
      executionError = deadline?.aborted
        ? new BridgeAdapterError('timeout', 'Bridge total deadline exceeded')
        : err instanceof Error ? err : new BridgeAdapterError('unknown', 'Bridge execution failed');
      const sessionId = this.sessionMachine?.id ?? 'unknown';
      const errorKind = executionError instanceof BridgeAdapterError ? executionError.kind : 'unknown';
      const errorMessage = executionError.message;

      lifecycle.onSessionError({
        kind: errorKind,
        message: errorMessage,
        sessionId,
      });

      throw executionError;
    } finally {
      // Post-session worktree validation: record boundary evidence only.
      // Dirty-state detection and worktree cleanup are the launcher's
      // responsibility — the bridge adapter must not fabricate dirty=false
      // evidence that would conflict with the launcher's real check.
      if (worktreeConfig) {
        worktreeGuard.recordPostSessionValidation(worktreeConfig);
      }
      if (context.signal && this.abortListener) {
        context.signal.removeEventListener('abort', this.abortListener);
        this.abortListener = null;
      }
      // Always close session
      if (this.sessionMachine) {
        if (this.options.confirmProcessExit) {
          // An unconfirmed exit invalidates success, even after a complete frame.
          try { await this.closeSession(this.sessionMachine.id); }
          catch (shutdownError) {
            if (!executionError) throw shutdownError;
            if (executionError instanceof BridgeAdapterError) {
              executionError.shutdownEvidence = { exit: this.processExitReceipt, clean: false };
            }
            throw executionError;
          }
          const expired = deadline?.aborted || Date.now() - startTime >= (this.options.timeoutMs ?? ABY_BRIDGE_RUNTIME_LIMITS.timeoutMs.default);
          if (!executionError && (expired || context.signal?.aborted)) {
            const error = new BridgeAdapterError(expired ? 'timeout' : 'unknown',
              expired ? 'Bridge total deadline exceeded during shutdown' : 'Bridge invocation cancelled during shutdown');
            error.shutdownEvidence = { exit: this.processExitReceipt, clean: true };
            throw error;
          }
        } else {
          await this.closeSession(this.sessionMachine.id).catch(() => {
            // Preserve the legacy Aby cleanup contract.
          });
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async spawnProcess(config: BridgeSessionConfig): Promise<void> {
    const { command, args = [], env: extraEnv } = this.options;

    const env = buildBridgeProcessEnv(config, extraEnv);

    const spawnOpts: Parameters<typeof spawn>[2] = {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    };

    if (config.worktreePath) {
      spawnOpts.cwd = config.worktreePath;
    }

    return new Promise((resolve, reject) => {
      this.process = spawn(command, args, spawnOpts);
      const child = this.process;
      this.exitPromise = new Promise((settle) => {
        child.once('close', (code, signal) => {
          this.exitReceipt = { code, signal };
          settle(this.exitReceipt);
        });
      });

      this.process.on('error', (err) => {
        reject(
          new BridgeAdapterError('process_crash', `Failed to spawn bridge process: ${err.message}`),
        );
      });

      this.process.on('spawn', () => {
        resolve();
      });

      // Set up stdout data handler for envelope responses
      this.process.stdout?.on('data', (chunk: Buffer) => {
        this.handleStdoutChunk(chunk);
      });

      this.process.stderr?.on('data', (chunk: Buffer) => {
        this.captureStderr(chunk);
      });

      // Handle process exit — set flag so future waitForResponse calls detect it
      this.process.on('close', (code, signal) => {
        try {
          this.responseBuffer += this.responseDecoder.decode();
          if (this.options.confirmProcessExit && this.responseBuffer.trim()) {
            this.inboundFailure = new BridgeAdapterError('envelope_malformed', 'Truncated Bridge frame');
          }
        } catch {
          this.inboundFailure = new BridgeAdapterError('envelope_malformed', 'Invalid UTF-8 Bridge output');
        }
        this.processExited = true;
        if (this.pendingReject) {
          this.pendingReject(
            new BridgeAdapterError(
              'process_crash',
              `Bridge process exited with code ${code}, signal ${signal}`,
              this.getStderrSummary(),
            ),
          );
          this.pendingResponse = null;
          this.pendingReject = null;
        }
      });
    });
  }

  private async performHandshake(sessionId: string, config: BridgeSessionConfig): Promise<void> {
    const handshakeEnvelope = buildBridgeEnvelope(sessionId, config.runId, 'handshake_request', {
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      requestedCapabilities: config.permissionProfile.allowedTools.map((tool) => ({ name: tool })),
    });

    await this.sendEnvelope(sessionId, handshakeEnvelope);

    const response = await this.waitForResponse(
      this.options.handshakeTimeoutMs ?? ABY_BRIDGE_RUNTIME_LIMITS.handshakeTimeoutMs.default,
    );

    if (this.options.confirmProcessExit) {
      const validation = validateBridgeEnvelope(response);
      if (!validation.valid || response.sessionId !== sessionId ||
          response.correlationId !== config.runId) {
        throw new BridgeAdapterError('handshake_failed', 'Bridge handshake identity mismatch');
      }
    }

    if (response.kind !== 'handshake_response') {
      throw new BridgeAdapterError(
        'handshake_failed',
        `Expected handshake_response, got ${response.kind}`,
      );
    }

    const payload = response.payload as { accepted: boolean; reason?: string };
    if (!payload.accepted) {
      throw new BridgeAdapterError(
        'handshake_failed',
        payload.reason ?? 'Handshake rejected by bridge runtime',
      );
    }
  }

  private handleStdoutChunk(chunk: Buffer): void {
    try { this.responseBuffer += this.responseDecoder.decode(chunk, { stream: true }); }
    catch { this.rejectInbound(new BridgeAdapterError('envelope_malformed', 'Invalid UTF-8 Bridge output')); return; }

    // Process complete lines (JSONL)
    const lines = this.responseBuffer.split('\n');
    this.responseBuffer = lines.pop() ?? ''; // Keep incomplete line
    if (this.options.confirmProcessExit && Buffer.byteLength(this.responseBuffer) > (this.options.maxEnvelopeSizeBytes ?? MAX_ENVELOPE_SIZE_BYTES)) {
      this.rejectInbound(new BridgeAdapterError('envelope_malformed', 'Unterminated Bridge frame exceeds maximum size'));
      return;
    }

    for (const line of lines) {
      if (!line.trim()) continue;

      // Inbound envelope size limit — prevents OOM from malicious runtimes
      if (Buffer.byteLength(line) > (this.options.maxEnvelopeSizeBytes ?? MAX_ENVELOPE_SIZE_BYTES)) {
        if (this.options.confirmProcessExit) this.rejectInbound(new BridgeAdapterError('envelope_malformed', 'Inbound envelope exceeds maximum size'));
        if (this.pendingReject) {
          this.pendingReject(
            new BridgeAdapterError('envelope_malformed', 'Inbound envelope exceeds maximum size'),
          );
          this.pendingResponse = null;
          this.pendingReject = null;
        }
        continue;
      }

      try {
        const envelope = JSON.parse(line) as BridgeEnvelope;
        if (this.options.confirmProcessExit) {
          if (envelope.kind === 'complete' || envelope.kind === 'error') this.terminalFrames++;
          if (this.terminalFrames > 1 || this.envelopeQueue.length >= 256) {
            this.rejectInbound(new BridgeAdapterError('envelope_malformed', 'Duplicate terminal or excessive queued Bridge frames'));
            continue;
          }
        }
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
          this.envelopeQueue.push(envelope);
        }
      } catch {
        if (this.options.confirmProcessExit) this.rejectInbound(new BridgeAdapterError('envelope_malformed', 'Invalid JSON in Bridge output'));
        // Invalid JSON line — record as malformed
        if (this.pendingReject) {
          this.pendingReject(
            new BridgeAdapterError('envelope_malformed', 'Invalid JSON in bridge response'),
          );
          this.pendingResponse = null;
          this.pendingReject = null;
        }
        // Malformed lines with no pending waiter are silently dropped
        // (no recorder available in handleStdoutChunk to log them)
      }
    }
  }

  private rejectInbound(error: BridgeAdapterError): void {
    this.inboundFailure ??= error;
    this.pendingReject?.(this.inboundFailure);
    this.pendingReject = null;
    this.pendingResponse = null;
    if (this.responseTimer) clearTimeout(this.responseTimer);
    this.responseTimer = null;
  }

  private waitForResponse(timeoutMs: number): Promise<BridgeEnvelope> {
    if (this.inboundFailure) return Promise.reject(this.inboundFailure);
    if (this.options.confirmProcessExit && this.envelopeQueue.length > 0) {
      return Promise.resolve(this.envelopeQueue.shift()!);
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

    // Check queue first — may already have a response from a previous chunk
    if (this.envelopeQueue.length > 0) {
      const envelope = this.envelopeQueue.shift()!;
      return Promise.resolve(envelope);
    }

    return new Promise((resolve, reject) => {
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
    child.stdin?.end();
    const grace = this.options.exitGraceMs ?? 5_000;
    const wait = async (): Promise<boolean> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          exited.then(() => true),
          new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), grace); }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    let forced = false;
    if (!await wait()) {
      forced = true;
      child.kill('SIGTERM');
      if (!await wait()) {
        child.kill('SIGKILL');
        if (!await wait()) {
          throw new BridgeAdapterError('process_crash', 'Bridge exit and side effects remain unknown');
        }
      }
    }
    this.process = null;
    if (this.inboundFailure) throw this.inboundFailure;
    if (forced || this.exitReceipt?.code !== 0 || this.exitReceipt.signal !== null) {
      throw new BridgeAdapterError('process_crash', 'Bridge did not confirm a clean owned shutdown');
    }
  }

  private async authorizePeerTool(context: AdapterExecutionContext, toolName: string, input: unknown): Promise<void> {
    const signal = context.signal;
    let aborted: (() => void) | undefined;
    try {
      const check = this.options.authorizeTool!(context, toolName, input);
      if (!signal) return await check;
      signal.throwIfAborted();
      await Promise.race([check, new Promise<never>((_resolve, reject) => {
        aborted = () => reject(signal.reason);
        signal.addEventListener('abort', aborted, { once: true });
      })]);
    } finally {
      if (signal && aborted) signal.removeEventListener('abort', aborted);
    }
  }

  private killProcess(): void {
    const proc = this.process;
    if (this.options.confirmProcessExit) {
      // Keep the process reference and exit listener until closeSession observes exit.
      proc?.stdin?.end();
      proc?.kill('SIGTERM');
      return;
    }
    this.process = null;

    if (proc && !proc.killed) {
      proc.kill('SIGTERM');
      // Capture process reference in local variable so SIGKILL escalation works
      // even after this.process is nulled
      setTimeout(() => {
        if (!proc.killed) {
          proc.kill('SIGKILL');
        }
      }, 5000);
    }
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

  constructor(kind: BridgeErrorKind, message: string, stderrSummary?: string) {
    super(message);
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
