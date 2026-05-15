export type RiskZone = 'green' | 'yellow' | 'red' | 'black';

export interface ZoneDefinition {
  zone: RiskZone;
  paths: string[];
  auto_merge_allowed: boolean;
  requires_independent_agent_review?: boolean;
  requires_human_approval?: boolean;
  requires_security_review?: boolean;
  requires_all_checks?: boolean;
}

export interface PolicyDefinition {
  zones: Record<RiskZone, ZoneDefinition>;
  agent_rules: Record<string, boolean>;
  merge_rules: Record<RiskZone, MergeRule>;
}

export interface MergeRule {
  required_checks: string[];
  required_agent_reviews: number;
  human_required: boolean;
}

export interface PolicyResult {
  passed: boolean;
  zone: RiskZone;
  violations: string[];
  requiredActions: string[];
}

// Self-evolution types needed by kernel
export interface MergeDecision {
  decision: 'merge_queue' | 'deny' | 'require_human' | 'wait';
  reason: string;
  riskZone: RiskZone;
}

export interface SelfValidationResult {
  experimentId: string;
  prNumber: number;
  headSha: string;
  checks: Record<string, { result: 'pass' | 'fail' | 'skip'; command: string }>;
  protectedPathCheck: { result: 'pass' | 'fail'; red_zone_touched: boolean; black_zone_touched: boolean };
  score: { overall: number; decision: 'pass' | 'review' | 'block'; dimensions: Record<string, unknown> };
  decision: 'pass' | 'fail' | 'requires_human';
}
