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
