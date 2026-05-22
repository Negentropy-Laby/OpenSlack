// Core (Red Zone — requires human approval to modify)
export { classifySelfEvolutionPR } from './core/classify-pr.js';
export type { PRClassification } from './core/classify-pr.js';
export { decideMerge } from './core/merge-decider.js';
export type { MergeInput, ReviewResult as MergeReviewResult } from './core/merge-decider.js';

// Types
export type {
  EvolutionTask, EvolutionExperiment, SelfValidationResult,
  FitnessScore, EvolutionStatus, EvolutionSource, ProblemStatement,
  Hypothesis, EvolutionRisk, EvolutionConstraints, ValidationPlan,
  OutputContract, RollbackPlan, CheckResult, ProtectedPathResult,
  MergeDecision,
} from './types.js';
