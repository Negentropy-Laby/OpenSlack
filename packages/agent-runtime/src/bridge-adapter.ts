/**
 * Bridge Adapter — BridgeProcessAdapter for external runtimes and
 * FakeBridgeAdapter for CI. Generic over any BridgeContract-compliant
 * external process.
 *
 * AR-2.5B: Aby External Adapter
 */

import { spawn, type ChildProcess } from 'node:child_process';
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

const DEFAULT_BRIDGE_TIMEOUT_MS = 120_000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
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

  constructor(options: BridgeProcessAdapterOptions) {
    this.options = options;
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
    if ((this.process && !this.process.killed) ||
        (this.sessionMachine && this.sessionMachine.currentState !== 'shutdown')) {
      throw new BridgeAdapterError('session_unavailable', 'Session already active — close the current session first');
    }

    const sessionId = `bridge-${config.runId}`;
    this.processExited = false;
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

    this.killProcess();
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
    if (json.length > (this.options.maxEnvelopeSizeBytes ?? MAX_ENVELOPE_SIZE_BYTES)) {
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
    const { prompt, runId, agentId, resolvedConfig, permissionProfile, worktreePath, recorder, toolGuard } =
      context;

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
      timeout: this.options.timeoutMs ?? DEFAULT_BRIDGE_TIMEOUT_MS,
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
      // Open session (spawns process + handshake)
      const sessionState = await this.openSession(sessionConfig);
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

      await this.sendEnvelope(this.sessionMachine!.id, execEnvelope);

      // Multi-envelope event loop: process intermediate envelopes until
      // a terminal envelope (complete or error) arrives. This handles
      // real bridge runtimes that emit progress/tool events before
      // producing a final result.
      const totalTimeoutMs = this.options.timeoutMs ?? DEFAULT_BRIDGE_TIMEOUT_MS;
      let finalResult: { data: T; tokenUsage?: number } | null = null;
      const reconciliationEvents: Array<{ kind: string; payload: unknown }> = [];

      while (finalResult === null) {
        // Track elapsed time so the total budget is shared across all
        // envelopes, not multiplied per envelope.
        const elapsed = Date.now() - startTime;
        const remaining = Math.max(totalTimeoutMs - elapsed, 1000); // min 1s for final envelope
        const envelope = await this.waitForResponse(remaining);

        // Validate every incoming envelope
        const validation = validateBridgeEnvelope(envelope);
        if (!validation.valid) {
          throw new BridgeAdapterError('envelope_malformed', validation.error ?? 'Invalid envelope');
        }

        // Permission guard on every inbound envelope
        const permCheck = guard.validateInboundResponse(envelope);
        if (!permCheck.valid) {
          throw new BridgeAdapterError('permission_denied', permCheck.violation ?? 'Permission denied');
        }

        // Process by kind
        switch (envelope.kind) {
          case 'run_started': {
            lifecycle.onBridgeProgress('run_started', envelope.payload as Record<string, unknown>);
            reconciliationEvents.push({ kind: envelope.kind, payload: envelope.payload });
            break;
          }

          case 'assistant_text': {
            lifecycle.onBridgeProgress('assistant_text', envelope.payload as Record<string, unknown>);
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
            // Validate worktree boundary on tool events
            if (worktreeConfig) {
              const wtCheck = worktreeGuard.validateToolEvent(toolName, tp, worktreeConfig);
              if (!wtCheck.valid) {
                throw new BridgeAdapterError('worktree_boundary_violation', wtCheck.violation ?? 'Worktree boundary violation');
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
                throw new BridgeAdapterError('worktree_boundary_violation', wtCheck.violation ?? 'Worktree boundary violation');
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
              reason: 'External bridge requested approval; OpenSlack does not accept external approval decisions',
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

            // Reconcile any events reported in the complete payload
            if (payload.events && Array.isArray(payload.events)) {
              for (const evt of payload.events) {
                reconciliationEvents.push(evt);
              }
            }

            finalResult = {
              data: payload.data ?? ({} as T),
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
      const sessionId = this.sessionMachine?.id ?? 'unknown';
      const errorKind = err instanceof BridgeAdapterError ? err.kind : 'unknown';
      const errorMessage = err instanceof Error ? err.message : String(err);

      lifecycle.onSessionError({
        kind: errorKind,
        message: errorMessage,
        sessionId,
      });

      throw err;
    } finally {
      // Post-session worktree validation: record boundary evidence only.
      // Dirty-state detection and worktree cleanup are the launcher's
      // responsibility — the bridge adapter must not fabricate dirty=false
      // evidence that would conflict with the launcher's real check.
      if (worktreeConfig) {
        worktreeGuard.recordPostSessionValidation(worktreeConfig);
      }
      // Always close session
      if (this.sessionMachine) {
        await this.closeSession(this.sessionMachine.id).catch(() => {
          // Ignore cleanup errors
        });
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

      this.process.on('error', (err) => {
        reject(new BridgeAdapterError('process_crash', `Failed to spawn bridge process: ${err.message}`));
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
      this.options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
    );

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
    this.responseBuffer += chunk.toString('utf-8');

    // Process complete lines (JSONL)
    const lines = this.responseBuffer.split('\n');
    this.responseBuffer = lines.pop() ?? ''; // Keep incomplete line

    for (const line of lines) {
      if (!line.trim()) continue;

      // Inbound envelope size limit — prevents OOM from malicious runtimes
      if (line.length > (this.options.maxEnvelopeSizeBytes ?? MAX_ENVELOPE_SIZE_BYTES)) {
        if (this.pendingReject) {
          this.pendingReject(new BridgeAdapterError('envelope_malformed', 'Inbound envelope exceeds maximum size'));
          this.pendingResponse = null;
          this.pendingReject = null;
        }
        continue;
      }

      try {
        const envelope = JSON.parse(line) as BridgeEnvelope;
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
        // Invalid JSON line — record as malformed
        if (this.pendingReject) {
          this.pendingReject(new BridgeAdapterError('envelope_malformed', 'Invalid JSON in bridge response'));
          this.pendingResponse = null;
          this.pendingReject = null;
        }
        // Malformed lines with no pending waiter are silently dropped
        // (no recorder available in handleStdoutChunk to log them)
      }
    }
  }

  private waitForResponse(timeoutMs: number): Promise<BridgeEnvelope> {
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

  private killProcess(): void {
    const proc = this.process;
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
    if (context.resolvedConfig.requiredMcpServers && context.resolvedConfig.requiredMcpServers.length > 0) {
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

    if (lowerPrompt.includes('research') || lowerPrompt.includes('find') || lowerPrompt.includes('search')) {
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
          plan: ['Step 1: Analyze requirements', 'Step 2: Implement changes', 'Step 3: Validate results'],
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
