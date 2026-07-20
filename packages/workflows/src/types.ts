// ── JSON Schema type (lightweight inline to avoid external dep) ────────────────

/**
 * Minimal JSON Schema definition used by AgentOptions.schema.
 * Matches the JSONSchema7 subset needed for agent result validation.
 */
export interface JSONSchemaDefinition {
  type?: string | string[];
  properties?: Record<string, JSONSchemaDefinition>;
  items?: JSONSchemaDefinition | JSONSchemaDefinition[];
  required?: string[];
  enum?: unknown[];
  description?: string;
  [key: string]: unknown;
}

// ── Manifest ──────────────────────────────────────────────────────────────────

export interface WorkflowPhase {
  title: string;
  detail: string;
}

export interface WorkflowInput {
  type: 'string' | 'number' | 'boolean';
  default?: unknown;
  description: string;
}

export interface WorkflowPermissions {
  github?: string[];
  git?: string[];
  filesystem?: string[];
  openslack?: string[];
}

export interface WorkflowMeta {
  name: string;
  version?: string;
  description: string;
  draftCreatedAt?: string;
  whenToUse?: string;
  phases: WorkflowPhase[];
  inputs?: Record<string, WorkflowInput>;
  permissions?: WorkflowPermissions;
  sideEffects?: string[];
  forbidden?: string[];
  risk?: 'low' | 'medium' | 'high';
  dynamicPattern?: string;
  modelRouting?: Record<string, string>;
  isolationPolicy?: Record<string, 'none' | 'worktree'>;
  budgetPolicy?: WorkflowBudgetPolicy;
}

// ── Runtime ───────────────────────────────────────────────────────────────────

export interface BudgetState {
  tokensUsed: number;
  tokensRemaining: number | null; // null = unlimited
  costUsd: number;
  agentCalls: number;
}

export interface ClaudeBudgetAPI {
  readonly total: number | null;
  spent(): number;
  remaining(): number;
}

export interface AgentOptions {
  label: string;
  phase: string;
  schema?: JSONSchemaDefinition;
  isolation?: 'none' | 'worktree';
  budget?: { tokens: number; costUsd?: number };
  model?: string;
  agentType?: string;
  resolvedAgentId?: string;
  /** Resolved agent config from agent-resolver. Passed through to launcher. */
  resolvedAgentConfig?: import('./agent-resolver.js').ResolvedAgentConfig;
  /** Pre-generated agent runtime run ID. Passed through to launcher for stable correlation. */
  agentRunId?: string;
  /** Bridge mode for adapter selection (e.g., 'fake', 'process', 'local'). */
  bridgeMode?: 'local' | 'external-command' | 'process' | 'fake';
}

export interface ParallelOptions {
  concurrency?: number;
}

export interface PhaseCheckpoint {
  phase: string;
  timestamp: string;
  status: 'completed' | 'failed' | 'skipped';
  result?: unknown;
  cacheKey?: string;
}

export type RunStatusState =
  | 'created'
  | 'previewed'
  | 'confirmed'
  | 'running'
  | 'paused'
  | 'paused_waiting_approval'
  | 'resuming'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface PendingApproval {
  id: string;
  operation: string;
  detail: string;
  timestamp: string;
  status: 'pending' | 'approved' | 'rejected';
}

export interface RunStatus {
  runId: string;
  workflowName: string;
  mode: ExecutionMode;
  status: RunStatusState;
  startedAt: string;
  updatedAt: string;
  currentPhase?: string;
  phases: PhaseCheckpoint[];
  args: Record<string, unknown>;
  pendingApprovals?: PendingApproval[];
}

/**
 * Execution mode for a workflow run.
 *
 * - 'validate': Schema and manifest validation only. No side effects.
 * - 'preview': Read-only exploration. No side effects.
 * - 'dry-run': Simulated side effects. Nothing is written externally.
 * - 'execute': Real side effects. REQUIRES human confirmation via onConfirm
 *   callback or explicit allowUnattended flag. Never proceeds without one.
 *
 * @see docs/product/approval-vocabulary.md for the full approval/confirmation vocabulary
 */
export type ExecutionMode = 'validate' | 'preview' | 'dry-run' | 'execute';

// ── Confirmation Policy ───────────────────────────────────────────────────────

export type ConfirmationMode =
  | 'interactive'
  | 'preapproved-manifest'
  | 'unattended-explicit'
  | 'dry-run';

export interface ApprovedEffect {
  kind: string;
  objectHint?: string;
  risk: 'low' | 'medium' | 'high';
  summary: string;
}

export interface WorkflowApprovalManifest {
  workflowName: string;
  runId: string;
  actorId: string;
  workflowHash: string;
  inputHash: string;
  risk: 'low' | 'medium' | 'high';
  approvedAt: string;
  expiresAt: string;
  approvedEffects: ApprovedEffect[];
}

export interface ConfirmationPolicy {
  mode: ConfirmationMode;
  actorId: string;
  runId: string;
  approvalManifest?: WorkflowApprovalManifest;
  allowUnattended?: boolean;
  onUnexpectedEffect?: 'pause' | 'fail';
}

// ── PRMS ──────────────────────────────────────────────────────────────────────

export interface PrmsDoctorBlocker {
  gate: string;
  reason: string;
  zone?: 'green' | 'yellow' | 'red';
  owner?: string;
}

export interface PrmsDoctorResult {
  status: 'READY_TO_MERGE' | 'BLOCKED' | 'ERROR';
  blockers: PrmsDoctorBlocker[];
  zone: 'green' | 'yellow' | 'red';
  why: string;
  next: string;
  gates: Record<string, { passed: boolean; detail: string }>;
}

export interface WorkflowRuntime {
  readonly runId: string;
  readonly mode: ExecutionMode;
  readonly budget: BudgetState & ClaudeBudgetAPI;
  readonly args: Record<string, unknown>;

  phase(name: string): void;
  log(message: string): void;
  agent<T>(prompt: string, options: AgentOptions): Promise<T>;
  parallel<T>(tasks: Array<() => Promise<T>>, options?: ParallelOptions): Promise<T[]>;
  pipeline<T, R>(
    items: T[],
    fnOrStages:
      | ((item: T, index: number) => Promise<R>)
      | Array<(prev: unknown, item: T, index: number) => Promise<unknown>>,
    options?: PipelineOptions,
  ): Promise<R[]>;
  workflow: WorkflowCall;

  openslack: {
    task: {
      createPreview(issueData: unknown): Promise<unknown>;
      createIssue(issueData: unknown): Promise<{ issueUrl: string; issueNumber: number }>;
      checkout(
        issueNumber: number,
        agentId: string,
      ): Promise<{ worktreePath: string; branchName: string }>;
      sync(issueNumber: number): Promise<{ pushed: boolean; prUrl?: string }>;
    };
    prms: {
      classify(paths: string[]): Promise<{ green: string[]; yellow: string[]; red: string[] }>;
      doctor(prNumber: number): Promise<PrmsDoctorResult>;
      queue(): Promise<Array<{ prNumber: number; title: string; status: string }>>;
      requestMerge(prNumber: number): Promise<{ merged: boolean; prmsStatus: string }>;
    };
    collaboration: {
      recordEvent(event: unknown): Promise<void>;
      createHandoff(details: unknown): Promise<unknown>;
      recordDecision(details: unknown): Promise<unknown>;
    };
    governance: {
      audit(action: string, details?: unknown): Promise<void>;
    };
  };
}

export interface FanoutSynthesizeOptions<T, R, S> {
  items: T[];
  worker: (item: T, index: number) => Promise<R> | R;
  synthesizer: (results: R[]) => Promise<S> | S;
}

export interface FanoutSynthesizeResult<R, S> {
  pattern: 'fanout-synthesize';
  itemCount: number;
  results: R[];
  synthesis: S;
}

export interface AdversarialVerifyOptions<T> {
  candidates: T[];
  verifier: (
    candidate: T,
    index: number,
  ) =>
    | Promise<'confirmed' | 'refuted' | 'needs-human-review'>
    | 'confirmed'
    | 'refuted'
    | 'needs-human-review';
}

export interface AdversarialVerifyResult<T> {
  pattern: 'adversarial-verification';
  decisions: Array<{ candidate: T; verdict: 'confirmed' | 'refuted' | 'needs-human-review' }>;
}

export interface GenerateAndFilterOptions<T> {
  generate: () => Promise<T[]> | T[];
  filter: (items: T[]) => Promise<T[]> | T[];
  topK?: number;
}

export interface TournamentOptions<T> {
  contestants: T[];
  judge: (a: T, b: T) => Promise<T> | T;
}

export interface TournamentResult<T> {
  pattern: 'tournament';
  rounds: Array<{ left: T; right: T; winner: T }>;
  winner: T | null;
}

export interface LoopUntilDoneOptions<T> {
  maxIterations: number;
  step: (iteration: number, previous: T | undefined) => Promise<T> | T;
  done: (value: T, iteration: number) => boolean;
}

export interface LoopUntilDoneResult<T> {
  pattern: 'loop-until-done';
  iterations: number;
  completed: boolean;
  result?: T;
}

export interface ModelIsolationRoute {
  label: string;
  model: string;
  isolation: 'none' | 'worktree';
  reason: string;
}

export interface WorkflowHelperAPI {
  fanoutSynthesize<T, R, S>(
    options: FanoutSynthesizeOptions<T, R, S>,
  ): Promise<FanoutSynthesizeResult<R, S>>;
  adversarialVerify<T>(options: AdversarialVerifyOptions<T>): Promise<AdversarialVerifyResult<T>>;
  generateAndFilter<T>(
    options: GenerateAndFilterOptions<T>,
  ): Promise<{ pattern: 'generate-filter'; generated: number; kept: T[] }>;
  tournament<T>(options: TournamentOptions<T>): Promise<TournamentResult<T>>;
  loopUntilDone<T>(options: LoopUntilDoneOptions<T>): Promise<LoopUntilDoneResult<T>>;
  routeModelAndIsolation(task: {
    label: string;
    purpose?: string;
    write?: boolean;
  }): ModelIsolationRoute;
}

export type WorkflowCall = ((name: string, args?: Record<string, unknown>) => Promise<unknown>) &
  WorkflowHelperAPI;

export interface WorkflowBudgetPolicy {
  maxAgents?: number;
  maxConcurrency?: number;
  tokenBudget?: number;
  onExceeded?: 'pause' | 'fail';
}

export interface WorkflowDisablePolicy {
  enabled: boolean;
  ultracode: boolean;
  maxConcurrency: number;
  maxAgentsPerRun: number;
  source: 'default' | 'env' | 'project';
  reason?: string;
}

export interface WorkflowPatternManifest {
  id: string;
  name: string;
  description: string;
  argsSchema: Record<string, unknown>;
  defaultRisk: 'low' | 'medium' | 'high';
  phases: WorkflowPhase[];
  requiredCapabilities: string[];
  useCases: string[];
}

export interface WorkflowDraft {
  draftId: string;
  path: string;
  prompt: string;
  pattern: string;
  manifest: WorkflowMeta;
  scriptHash: string;
  createdAt: string;
}

export interface WorkflowDraftPreview {
  draft: WorkflowDraft;
  phasePlan: WorkflowPhase[];
  requiredPermissions: WorkflowPermissions;
  sideEffects: string[];
  budgetEstimate: WorkflowBudgetPolicy;
  trustRequirement: 'untrusted' | 'trusted';
}

export interface WorkflowRecommendation {
  decision: 'workflow_recommended' | 'workflow_not_needed' | 'workflow_draft_required';
  reason: string;
  confidence: number;
  suggestedPattern?: string;
  risk: 'none' | 'low' | 'medium' | 'high';
  nextAction: string;
}

export type WorkflowRunControlAction =
  | 'pause'
  | 'resume'
  | 'stopRun'
  | 'stopAgent'
  | 'restartAgent'
  | 'saveScript';

export interface WorkflowRunControlResult {
  runId: string;
  action: WorkflowRunControlAction;
  status: 'applied' | 'recorded' | 'rejected';
  message: string;
  target?: WorkflowRunControlTarget;
}

// ── Results ───────────────────────────────────────────────────────────────────

export interface PreviewResult {
  preview: true;
  findings?: unknown[];
  triaged?: unknown[];
  [key: string]: unknown;
}

export interface RunResult {
  status: string;
  [key: string]: unknown;
}

// ── Workflow Module ───────────────────────────────────────────────────────────

export interface OpenSlackWorkflow {
  meta: WorkflowMeta;
  preview?: (ctx: WorkflowRuntime, args: Record<string, unknown>) => Promise<PreviewResult>;
  run?: (ctx: WorkflowRuntime, args: Record<string, unknown>) => Promise<RunResult>;
}

// ── Permissions ───────────────────────────────────────────────────────────────

export type TrustLevel = 'untrusted' | 'trusted' | 'core';

export type WorkflowSource = 'openslack-project' | 'claude-project' | 'claude-user' | 'builtin';

export interface PermissionDeclaration {
  declared: WorkflowPermissions;
  granted: WorkflowPermissions;
  trustLevel: TrustLevel;
}

// ── Loader types ──────────────────────────────────────────────────────────────

export type WorkflowFormat =
  | 'openslack-native'
  | 'anthropic-compatible'
  | 'claude-ambient'
  | 'invalid';

export interface WorkflowModule {
  meta: WorkflowMeta;
  preview?: OpenSlackWorkflow['preview'];
  run?: OpenSlackWorkflow['run'];
  format: WorkflowFormat;
  hash: string;
  sourceBody?: string; // Raw source for claude-ambient workflows (no import needed)
  source?: WorkflowSource; // Where the workflow was discovered
}

// ── Pipeline ──────────────────────────────────────────────────────────────────

export interface PipelineOptions {
  concurrency?: number;
}

// ── Run Info ──────────────────────────────────────────────────────────────────

export interface WorkflowRunInfo {
  runId: string;
  workflowName: string;
  mode: ExecutionMode;
  status: RunStatus['status'];
  startedAt: string;
  updatedAt: string;
}

// ── Agent Result ──────────────────────────────────────────────────────────────

export interface AgentResult<T = unknown> {
  data: T;
  tokenUsage?: number;
  schemaVersion?: string;
  runId?: string;
  workflowEvidence?: {
    label: string;
    phase: string;
    agentRunId?: string;
    model?: string;
    isolation?: 'none' | 'worktree';
    agentType?: string;
    bridgeMode?: 'local' | 'external-command' | 'process' | 'fake';
    promptSummary: string;
    promptHash: string;
    startedAt: string;
    completedAt?: string;
    tokenUsage?: number;
    replayAvailable?: boolean;
    replayUnavailableReason?: string;
  };
}

// ── Workflow Run Progress ───────────────────────────────────────────────────

export interface WorkflowToolEvidence {
  type: 'tool_call' | 'tool_result' | 'progress';
  name: string;
  timestamp?: string;
  summary: string;
}

export interface WorkflowBudgetUsage {
  tokenBudget: number | null;
  tokensUsed: number;
  tokensRemaining: number | null;
  costUsd?: number;
  costEstimateUsd?: number;
  costSource: 'config' | 'unknown' | 'not-recorded';
  tokenBudgetPercent?: number;
  warningThreshold: number;
  status: 'ok' | 'warning' | 'exceeded' | 'unknown';
  warnings: string[];
  agentCalls: number;
  maxAgents?: number;
  maxConcurrency?: number;
  onExceeded?: 'pause' | 'fail';
  source: 'manifest' | 'runtime' | 'agent-results' | 'not-recorded';
}

export interface WorkflowAgentProgress {
  id: string;
  label: string;
  phase: string;
  status: string;
  cached: boolean;
  agentRunId?: string;
  model?: string;
  runtimeProvider?: string;
  bridgeMode?: string;
  isolation?: 'none' | 'worktree';
  worktreePath?: string;
  promptSummary: string;
  transcriptPath?: string;
  resultSummary?: string;
  terminalReason?: string;
  replayAvailable?: boolean;
  replayUnavailableReason?: string;
  tokensUsed: number;
  tokensRemaining: number | null;
  recentTools: WorkflowToolEvidence[];
  warnings: string[];
}

export interface WorkflowPhaseProgress {
  phase: string;
  status: 'not-started' | 'running' | 'completed' | 'failed' | 'skipped' | 'unknown';
  timestamp?: string;
  elapsedMs?: number;
  agentCount: number;
  tokenTotal: number;
  cachedCount: number;
  liveCount: number;
  failedCount: number;
  agents: WorkflowAgentProgress[];
  resultSummary?: string;
  warnings: string[];
}

export interface WorkflowRunProgress {
  runId: string;
  workflowName: string;
  mode: ExecutionMode | 'not-recorded';
  status: RunStatusState | 'not-recorded';
  startedAt?: string;
  updatedAt?: string;
  elapsedMs?: number;
  currentPhase?: string;
  args: Record<string, unknown>;
  phaseCount: number;
  agentCount: number;
  pendingApprovalCount: number;
  budget: WorkflowBudgetUsage;
  phases: WorkflowPhaseProgress[];
  outputSummary?: string;
  logTail: string[];
  warnings: string[];
}

export interface WorkflowRunControlTarget {
  runId: string;
  phase?: string;
  agentRunId?: string;
  agentId?: string;
}

export interface WorkflowAgentControlResult {
  target: WorkflowRunControlTarget;
  action: WorkflowRunControlAction;
  status: 'applied' | 'recorded' | 'rejected';
  message: string;
}

export interface WorkflowRunScriptSource {
  runId: string;
  workflowName: string;
  sourcePath: string;
  scriptHash: string;
  savedPath?: string;
}
