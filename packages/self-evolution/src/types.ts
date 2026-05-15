import type { RiskZone } from '@openslack/policy';

export type EvolutionStatus =
  | 'observed'
  | 'diagnosed'
  | 'proposed'
  | 'planned'
  | 'claimable'
  | 'claimed'
  | 'implementing'
  | 'validating'
  | 'validated'
  | 'reviewing'
  | 'approved'
  | 'merge_queued'
  | 'merged'
  | 'canary_monitoring'
  | 'stable'
  | 'learned'
  | 'validation_failed'
  | 'rejected'
  | 'regression_detected'
  | 'rollback_proposed'
  | 'rolled_back';

export interface EvolutionTask {
  id: string;
  title: string;
  status: EvolutionStatus;
  source: EvolutionSource;
  problem: ProblemStatement;
  hypothesis: Hypothesis;
  risk: EvolutionRisk;
  constraints: EvolutionConstraints;
  validation: ValidationPlan;
  outputContract: OutputContract;
  depends_on: string[];
}

export interface EvolutionSource {
  type: string;
  evidence: string[];
}

export interface ProblemStatement {
  summary: string;
  affected_modules: string[];
}

export interface Hypothesis {
  statement: string;
  expected_metric_change: Record<string, string>;
}

export interface EvolutionRisk {
  level: 'low' | 'medium' | 'high' | 'critical';
  reasons: string[];
  protected_paths_touched: boolean;
  human_approval_required: boolean;
}

export interface EvolutionConstraints {
  allowed_paths: string[];
  forbidden_paths: string[];
}

export interface ValidationPlan {
  required: string[];
}

export interface OutputContract {
  must_include: string[];
}

export interface EvolutionExperiment {
  id: string;
  linkedTaskId: string;
  implementationAgent: string;
  reviewAgents: string[];
  hypothesis: Hypothesis;
  changedPaths: string[];
  risk: EvolutionRisk;
  validationPlan: ValidationPlan;
  rollback: RollbackPlan;
}

export interface RollbackPlan {
  strategy: 'revert_pr' | 'manual';
  command: string;
}

export interface SelfValidationResult {
  experimentId: string;
  prNumber: number;
  headSha: string;
  checks: Record<string, CheckResult>;
  protectedPathCheck: ProtectedPathResult;
  score: FitnessScore;
  decision: 'pass' | 'fail' | 'requires_human';
}

export interface CheckResult {
  result: 'pass' | 'fail' | 'skip';
  command: string;
  metrics?: Record<string, number | string>;
  findings?: string[];
}

export interface ProtectedPathResult {
  result: 'pass' | 'fail';
  red_zone_touched: boolean;
  black_zone_touched: boolean;
}

export interface FitnessScore {
  dimensions: Record<string, { weight: number; score: number; evidence: string[] }>;
  overall: number;
  decision: 'pass' | 'review' | 'block';
}

export interface MergeDecision {
  decision: 'merge_queue' | 'deny' | 'require_human' | 'wait';
  reason: string;
  riskZone: RiskZone;
}
