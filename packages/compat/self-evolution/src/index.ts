// Re-export shim — pure kernel logic from @openslack/kernel, ops from @openslack/runtime
export {
  classifySelfEvolutionPR,
  decideMerge,
} from '@openslack/kernel';
export {
  observeHealth,
  triageObservations,
  validatePR,
  reviewPR,
  computeFitnessScore,
  monitorPostMerge,
  createRollbackTask,
  executeRollback,
} from '@openslack/runtime';
export type {
  EvolutionTask, EvolutionExperiment, SelfValidationResult,
  FitnessScore, EvolutionStatus, EvolutionSource, ProblemStatement,
  Hypothesis, EvolutionRisk, EvolutionConstraints, ValidationPlan,
  OutputContract, RollbackPlan, CheckResult, ProtectedPathResult,
  MergeDecision,
} from '@openslack/kernel';
export type { Observation } from '@openslack/runtime';
export type { ReviewResult, ReviewCheck } from '@openslack/runtime';
export type { MonitorResult } from '@openslack/runtime';
