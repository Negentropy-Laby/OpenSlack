// Re-exports from agent-runtime (backward compat)
export { bootstrapAgent } from './bootstrap.js';
export type { BootstrapCheck, BootstrapResult } from './bootstrap.js';
export { tickAgent } from './tick.js';
export type { TickResult } from './tick.js';

// Re-exports from git-sync (backward compat)
export { proposeWorkspacePR } from './propose.js';
export type { PRProposalInput, PRProposalResult } from './propose.js';
export { createWorktree, cleanupWorktree, checkDirty } from './worktree.js';
export { buildSetupReport, detectGenesisShell, findRepoRoot, renderSetupReport } from './setup-report.js';
export type { SetupFinding, SetupFindingStatus, SetupReport } from './setup-report.js';
export { repairWorktrees, renderWorktreeRepair } from './repair.js';
export type { WorktreeRepairItem, WorktreeRepairResult } from './repair.js';
export type { WorktreeResult } from './worktree.js';

// Self-evolution ops (moved from kernel to runtime to break circular dependency)
export { observeHealth } from './self/ops/observe.js';
export type { Observation } from './self/ops/observe.js';
export { triageObservations } from './self/ops/triage.js';
export { validatePR } from './self/ops/validate.js';
export { reviewPR } from './self/ops/review.js';
export type { ReviewResult, ReviewCheck } from './self/ops/review.js';
export { computeFitnessScore } from './self/ops/scorecard.js';
export { monitorPostMerge } from './self/ops/monitor.js';
export type { MonitorResult } from './self/ops/monitor.js';
export {
  createRollbackTask,
  executeRollback,
  expireStaleRollbackTasks,
  ROLLBACK_TTL_DAYS,
  ROLLBACK_RATE_LIMIT_MS,
} from './self/ops/rollback.js';
export type { CreateRollbackTaskOptions, RollbackTaskResult, ExpireRollbackTasksResult } from './self/ops/rollback.js';

// Golden Evals (moved from workspace to runtime to break circular dependency)
export { runEvalSuite, runGoldenEval, generateScorecard } from './evals/runner.js';
export { loadGoldenSuite } from './evals/suites/golden.js';
export type { EvalCase, EvalSuite, EvalResult, EvalAssertion, EvalSetup, EvalScenario } from './evals/types.js';
