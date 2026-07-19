import type {
  WorkflowMeta,
  WorkflowRuntime,
  PreviewResult,
  RunResult,
  AgentOptions,
  WorkflowFormat,
} from './types.js';
import { createRuntime } from './runtime.js';
import type { RuntimeOptions } from './runtime.js';
import type { AgentLauncher, AgentCacheStore } from './agent-shim.js';
import type { PipelineCacheStore } from './pipeline-runner.js';

/**
 * Error thrown when preview execution encounters a disallowed operation.
 */
export class PreviewModeError extends Error {
  readonly operation: string;

  constructor(operation: string, detail: string) {
    super(`Preview mode error: ${operation} — ${detail}`);
    this.name = 'PreviewModeError';
    this.operation = operation;
  }
}

/**
 * Options for executePreview.
 */
export interface PreviewOptions {
  /** Workflow manifest */
  manifest: WorkflowMeta;
  /** Workflow arguments */
  args?: Record<string, unknown>;
  /** Budget limits for preview */
  budget?: { tokens: number; costUsd: number };
  /** Agent launcher for agent calls */
  agentLauncher?: AgentLauncher;
  /** Agent cache store */
  agentCache?: AgentCacheStore;
  /** Pipeline cache store */
  pipelineCache?: PipelineCacheStore;
}

/**
 * A read-only agent launcher wrapper that records calls but prevents
 * actual side effects. Used when no explicit launcher is provided.
 */
function createPreviewAgentLauncher(): AgentLauncher {
  return async <T>(prompt: string, options: AgentOptions) => {
    // Return a placeholder result — preview mode does not execute real agents
    return {
      data: {
        _preview: true,
        label: options.label,
        phase: options.phase,
        promptLength: prompt.length,
        message: 'Preview mode: agent call recorded but not executed',
      } as T,
      tokenUsage: 0,
    };
  };
}

/**
 * Execute a workflow in preview mode.
 *
 * Preview mode runs the workflow's `preview` function (if available) or
 * its `run` function with read-only agent calls. The runtime enforces:
 * - Trust level: untrusted (read-only permissions only)
 * - No write operations (openslack.task.createIssue, checkout, sync, etc.)
 * - No nested workflow calls
 * - Agent calls return placeholder data unless a real launcher is provided
 *
 * Returns a PreviewResult with findings and metadata.
 */
export async function executePreview(
  workflow: {
    meta: WorkflowMeta;
    preview?: (ctx: WorkflowRuntime, args: Record<string, unknown>) => Promise<PreviewResult>;
    run?: (ctx: WorkflowRuntime, args: Record<string, unknown>) => Promise<RunResult>;
    format?: WorkflowFormat;
    sourceBody?: string;
  },
  options: PreviewOptions,
): Promise<PreviewResult> {
  const { manifest, args = {}, budget } = options;

  // Generate a deterministic preview run ID
  const runId = `preview-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  // Create the runtime in preview mode with untrusted permissions
  const runtime = createRuntime({
    runId,
    mode: 'preview',
    manifest,
    budget: budget ?? { tokens: 10000, costUsd: 0 },
    permissions: {
      declared: {},
      granted: {},
      trustLevel: 'untrusted',
    },
    agentLauncher: options.agentLauncher ?? createPreviewAgentLauncher(),
    agentCache: options.agentCache,
    pipelineCache: options.pipelineCache,
  });

  // Execute the preview function if available, otherwise run
  let result: PreviewResult;

  // Handle claude-ambient workflows: execute sourceBody in sandbox
  if (workflow.format === 'claude-ambient' && workflow.sourceBody) {
    const { executeAmbientWorkflow } = await import('./ambient-runner.js');
    const ambientResult = await executeAmbientWorkflow(workflow.sourceBody, runtime, args);
    result = {
      preview: true,
      runId,
      workflowName: manifest.name,
      ...(typeof ambientResult === 'object' && ambientResult !== null
        ? (ambientResult as Record<string, unknown>)
        : { result: ambientResult }),
      budget: {
        tokensUsed: runtime.budget.tokensUsed,
        tokensRemaining: runtime.budget.tokensRemaining,
        agentCalls: runtime.budget.agentCalls,
      },
    };
  } else if (workflow.preview) {
    result = await workflow.preview(runtime, args);
  } else if (workflow.run) {
    // Running a workflow's `run` in preview mode — the runtime's preview
    // restrictions will prevent write operations
    const runResult = await workflow.run(runtime, args);
    result = {
      preview: true,
      ...runResult,
    };
  } else {
    // No preview or run function — return basic metadata
    result = {
      preview: true,
      mode: 'preview',
      runId,
      workflowName: manifest.name,
      phases: manifest.phases.map((p) => p.title),
      budget: {
        tokensUsed: runtime.budget.tokensUsed,
        tokensRemaining: runtime.budget.tokensRemaining,
        agentCalls: runtime.budget.agentCalls,
      },
    };
  }

  // Ensure the result has the preview flag
  return {
    ...result,
    preview: true,
    runId,
    workflowName: manifest.name,
    budget: {
      tokensUsed: runtime.budget.tokensUsed,
      tokensRemaining: runtime.budget.tokensRemaining,
      agentCalls: runtime.budget.agentCalls,
    },
  };
}
