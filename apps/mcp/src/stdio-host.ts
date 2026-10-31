import { canonicalHarnessRoot, createConfiguredHarnessTaskHost, createHarnessHostCloser,
  type HarnessTaskHost } from '@openslack/agent-runtime/internal/harness';
import type { OpenSlackMcpContext } from './context.js';
import { createOpenSlackMcpServer } from './server.js';

export class McpStdioProfileError extends Error {
  readonly code = 'OPENSLACK_MCP_PROFILE_ARGUMENT_INVALID';
}
export class McpStdioLifecycleError extends Error {
  constructor(readonly phase: 'start' | 'shutdown', cause: unknown) {
    super('The owned MCP stdio lifecycle did not complete safely.', { cause });
    this.name = 'McpStdioLifecycleError';
  }
}

export interface McpHarnessOwnerOptions {
  workspaceRoot: string;
  profile: string;
  principalRef?: string;
  harnessTaskHost?: HarnessTaskHost;
  configuredDispatcher?: boolean;
  workerBinding?: string;
  createConfiguredHost?: typeof createConfiguredHarnessTaskHost;
}
export interface McpHarnessOwner { readonly workspaceRoot: string; readonly harnessTaskHost?: HarnessTaskHost }

/** Host-only selection: model input cannot choose a root, principal or owner. */
export function selectMcpHarnessOwner(options: McpHarnessOwnerOptions): McpHarnessOwner {
  const sources = [options.harnessTaskHost !== undefined, !!options.configuredDispatcher, options.workerBinding !== undefined];
  if (sources.filter(Boolean).length > 1) throw new McpStdioProfileError('Select exactly one injected, configured dispatcher, or worker-bound Harness owner.');
  if (sources.some(Boolean) && options.profile !== 'agent-bound') throw new McpStdioProfileError('Harness callbacks require agent-bound.');
  const configured = !!options.configuredDispatcher || options.workerBinding !== undefined;
  if (configured && !options.principalRef) throw new McpStdioProfileError('agent-bound requires --principal-ref.');
  const host = options.profile === 'agent-bound' ? options.harnessTaskHost ?? (configured && options.principalRef
    ? (options.createConfiguredHost ?? createConfiguredHarnessTaskHost)(options.workspaceRoot, options.principalRef, options.workerBinding) : undefined) : undefined;
  if (configured && !host) throw new Error('The explicitly selected Harness owner is unavailable');
  return Object.freeze({ workspaceRoot: host ? canonicalHarnessRoot(options.workspaceRoot) : options.workspaceRoot,
    ...(host ? { harnessTaskHost: host } : {}) });
}

export interface McpStdioHostOptions extends McpHarnessOwnerOptions {
  createContext(owner: McpHarnessOwner): Promise<OpenSlackMcpContext>;
  createServer?: typeof createOpenSlackMcpServer;
}

/** Owns one server lifecycle. Signal wiring and rendering stay with the caller. */
export async function createOpenSlackMcpStdioHost(options: McpStdioHostOptions) {
  const owner = selectMcpHarnessOwner(options);
  const closeOwnedResources = owner.harnessTaskHost ? createHarnessHostCloser(owner.harnessTaskHost) : undefined;
  let server: ReturnType<typeof createOpenSlackMcpServer>;
  try {
    const context = await options.createContext(owner);
    const createServer = options.createServer ?? createOpenSlackMcpServer;
    server = closeOwnedResources ? createServer(context, {}, { closeOwnedResources }) : createServer(context);
  } catch (error) {
    try { await closeOwnedResources?.(); }
    catch (cleanup) { throw new McpStdioLifecycleError('start', new AggregateError([error, cleanup], 'MCP setup and owned cleanup failed')); }
    throw error;
  }
  let state: 'created' | 'starting' | 'serving' | 'closing' | 'closed' | 'failed' = 'created';
  let serveTask: Promise<void> | undefined;
  let closeTask: Promise<void> | undefined;
  let phase: 'start' | 'shutdown' = 'start';
  const currentState = () => state;
  const close = (): Promise<void> => {
    closeTask ??= (async () => {
      if (state === 'closed') return;
      const closingPhase = phase;
      state = 'closing';
      try { await server.close(); if (currentState() !== 'failed') state = 'closed'; }
      catch (error) { state = 'failed'; throw new McpStdioLifecycleError(closingPhase, error); }
    })();
    return closeTask;
  };
  return Object.freeze({
    get state() { return state; },
    serve(): Promise<void> {
      if (serveTask) return serveTask;
      if (state !== 'created') return closeTask ?? Promise.resolve();
      state = 'starting';
      serveTask = (async () => {
        try {
          await server.serveStdio();
          if (state === 'starting') { state = 'serving'; phase = 'shutdown'; }
          await server.whenClosed;
          if (currentState() !== 'failed') state = 'closed';
        } catch (error) {
          const failedPhase = phase;
          try { await close(); }
          catch (cleanup) { state = 'failed'; throw new McpStdioLifecycleError(failedPhase, new AggregateError([error, cleanup], 'MCP transport and owned cleanup failed')); }
          state = 'failed';
          throw new McpStdioLifecycleError(failedPhase, error);
        }
      })();
      return serveTask;
    },
    close,
  });
}
