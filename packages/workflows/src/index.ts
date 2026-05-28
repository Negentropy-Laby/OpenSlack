// ── Types ─────────────────────────────────────────────────────────────────────
export type {
  JSONSchemaDefinition,
  WorkflowPhase,
  WorkflowInput,
  WorkflowPermissions,
  WorkflowMeta,
  BudgetState,
  AgentOptions,
  ParallelOptions,
  PhaseCheckpoint,
  RunStatus,
  ExecutionMode,
  PrmsDoctorBlocker,
  PrmsDoctorResult,
  WorkflowRuntime,
  PreviewResult,
  RunResult,
  OpenSlackWorkflow,
  TrustLevel,
  PermissionDeclaration,
  WorkflowFormat,
  WorkflowModule,
  PipelineOptions,
  WorkflowRunInfo,
  AgentResult,
} from './types.js'

// ── Manifest ──────────────────────────────────────────────────────────────────
export {
  parseManifest,
  validateManifest,
  computeManifestHash,
} from './manifest.js'

// ── Loader ────────────────────────────────────────────────────────────────────
export {
  DISCOVERY_PATHS,
  discoverWorkflows,
  findWorkflow,
  loadWorkflow,
  detectFormat,
  analyzeStaticMeta,
  discoverYamlTemplates,
  discoverJsWorkflows,
} from './loader.js'
export type { WorkflowSummary } from './loader.js'

// ── Runtime ───────────────────────────────────────────────────────────────────
export { createRuntime, ExecuteDeniedError } from './runtime.js'
export type { RuntimeOptions, RuntimeInternals, ConfirmCallback } from './runtime.js'

// ── Permission Checker ────────────────────────────────────────────────────────
export {
  ALWAYS_FORBIDDEN,
  resolvePermissions,
  checkPermission,
  intersectPermissions,
  resolveTrustLevel,
  getPermissionsForTrustLevel,
  fullCheckPermission,
} from './permission-checker.js'
export type { PermissionCheckResult } from './permission-checker.js'

// ── Nesting Guard ─────────────────────────────────────────────────────────────
export {
  MAX_NESTING_DEPTH,
  checkNestingDepth,
  NestingDepthError,
  createNestingGuard,
} from './nesting.js'

// ── Agent Shim ────────────────────────────────────────────────────────────────
export {
  SchemaValidationError,
  executeAgentCall,
  computeAgentCacheKey,
  validateAgainstSchema,
} from './agent-shim.js'
export type { AgentCacheStore, AgentLauncher } from './agent-shim.js'

// ── Parallel Runner ───────────────────────────────────────────────────────────
export { runParallel } from './parallel-runner.js'

// ── Pipeline Runner ───────────────────────────────────────────────────────────
export { runPipeline } from './pipeline-runner.js'
export type { PipelineCacheStore } from './pipeline-runner.js'

// ── Run Store ─────────────────────────────────────────────────────────────────
export { RunStore } from './run-store.js'
export type { RunStoreFs, RunStoreOptions, RunMeta, RunStatusFile, LogEntry as RunLogEntry } from './run-store.js'

// ── Cache ─────────────────────────────────────────────────────────────────────
export {
  computeCacheKey,
  hashString,
  getCacheEntry,
  setCacheEntry,
  invalidateCacheEntry,
  invalidateByManifestHash,
  createCacheStore,
  MemoryCacheStore,
} from './cache.js'
export type { CacheStore, CacheEntry } from './cache.js'

// ── Resume ────────────────────────────────────────────────────────────────────
export {
  checkResumable,
  prepareResume,
  forceResume,
  replayCachedPhases,
} from './resume.js'
export type { ResumeCheckResult, ResumeState } from './resume.js'

// ── Anthropic Compat ──────────────────────────────────────────────────────────
export {
  createAnthropicCompatSandbox,
  createAnthropicCompatRunner,
  AnthropicCompatError,
} from './anthropic-compat.js'
export type { AnthropicCompatSandbox } from './anthropic-compat.js'

// ── Preview ───────────────────────────────────────────────────────────────────
export {
  executePreview,
  PreviewModeError,
} from './preview.js'
export type { PreviewOptions } from './preview.js'

// ── Execute ───────────────────────────────────────────────────────────────────
export {
  executeDryRun,
  executeRun,
  executeResume,
  DryRunError,
} from './execute.js'
export type { DryRunOptions, DryRunResult, ExecuteRunOptions, SimulatedEffect } from './execute.js'

// ── OpenSlack API ─────────────────────────────────────────────────────────────
export { createOpenSlackAPI } from './openslack-api.js'
export type { OpenSlackAPIOptions } from './openslack-api.js'

// ── Redaction ────────────────────────────────────────────────────────────────
export {
  stripSourceCode,
  truncateContext,
  stripPrompt,
  redactAgentCall,
  stripTokensAndCredentials,
  remapAbsolutePaths,
  redactFailedSchemaOutput,
  redactString,
  redactDeep,
  redactRunStatus,
  redactPhaseCheckpoint,
  redactRunBundle,
} from './redact.js'
export type { RedactionEntry, RedactionResult, RedactionOptions } from './redact.js'

// ── HTML Renderer ────────────────────────────────────────────────────────────
export {
  escapeHtml,
  escapeJsonInHtml,
  renderRunHtml,
  renderRunJson,
  renderRunMarkdown,
} from './html-renderer.js'
export type { HtmlRenderOptions } from './html-renderer.js'
