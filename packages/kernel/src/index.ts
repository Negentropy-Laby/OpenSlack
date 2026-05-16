export { classifyPaths } from './zones.js';
export { evaluatePolicy } from './policy-engine.js';
export { classifySelfEvolutionPR } from './self/classify-pr.js';
export { decideMerge } from './self/merge-decider.js';
export type { PRClassification } from './self/classify-pr.js';
export type { MergeInput, ReviewResult as MergeReviewResult } from './self/merge-decider.js';
export type { RiskZone, PolicyDefinition, PolicyResult, ZoneDefinition } from './types.js';

// Re-exports from merged self-evolution package (backward compat)
export { observeHealth } from './self/ops/observe.js';
export { triageObservations } from './self/ops/triage.js';
export { reviewPR } from './self/ops/review.js';
export { computeFitnessScore } from './self/ops/scorecard.js';
export { monitorPostMerge } from './self/ops/monitor.js';
export { createRollbackTask, executeRollback } from './self/ops/rollback.js';
export { validatePR } from './self/ops/validate.js';
export type { Observation } from './self/ops/observe.js';
export type { ReviewResult, ReviewCheck } from './self/ops/review.js';
export type { MonitorResult } from './self/ops/monitor.js';
export type {
  EvolutionTask, EvolutionExperiment, SelfValidationResult,
  FitnessScore, EvolutionStatus, EvolutionSource, ProblemStatement,
  Hypothesis, EvolutionRisk, EvolutionConstraints, ValidationPlan,
  OutputContract, RollbackPlan, CheckResult, ProtectedPathResult,
  MergeDecision,
} from './self/types.js';
