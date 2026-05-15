// Core (Red Zone — requires human approval to modify)
export { classifySelfEvolutionPR } from './core/classify-pr.js';
export type { PRClassification } from './core/classify-pr.js';
export { decideMerge } from './core/merge-decider.js';
export type { MergeInput, ReviewResult as MergeReviewResult } from './core/merge-decider.js';

// Ops (Yellow Zone — agent-modifiable with review)
export { observeHealth } from './ops/observe.js';
export type { Observation } from './ops/observe.js';
export { triageObservations } from './ops/triage.js';
export { reviewPR } from './ops/review.js';
export type { ReviewResult, ReviewCheck } from './ops/review.js';
export { computeFitnessScore } from './ops/scorecard.js';
export { monitorPostMerge } from './ops/monitor.js';
export type { MonitorResult } from './ops/monitor.js';
export { createRollbackTask, executeRollback } from './ops/rollback.js';
export { validatePR } from './ops/validate.js';

// Types
export type {
  EvolutionTask, EvolutionExperiment, SelfValidationResult,
  FitnessScore, EvolutionStatus, EvolutionSource, ProblemStatement,
  Hypothesis, EvolutionRisk, EvolutionConstraints, ValidationPlan,
  OutputContract, RollbackPlan, CheckResult, ProtectedPathResult,
  MergeDecision,
} from './types.js';
