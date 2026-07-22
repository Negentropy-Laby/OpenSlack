import type { PolicyDefinition, PolicyResult, RiskZone } from './types.js';

export function evaluatePolicy(
  policy: PolicyDefinition,
  context: { zone: RiskZone },
): PolicyResult {
  const zoneDef = policy.zones[context.zone];
  if (!zoneDef) {
    return {
      passed: false,
      zone: context.zone,
      violations: [`Unknown zone: ${context.zone}`],
      requiredActions: [],
    };
  }

  const violations: string[] = [];
  const requiredActions: string[] = [];

  if (!zoneDef.auto_merge_allowed) {
    requiredActions.push(
      context.zone === 'black' ? 'PR denied automatically' : 'Manual merge required',
    );
  }

  if (zoneDef.requires_independent_agent_review) {
    requiredActions.push(
      `Requires ${policy.merge_rules[context.zone]?.required_agent_reviews ?? 1} independent agent review(s)`,
    );
  }

  if (zoneDef.requires_human_approval) {
    requiredActions.push('Human approval required');
  }

  if (zoneDef.requires_security_review) {
    requiredActions.push('Security review required');
  }

  if (policy.agent_rules.no_self_prompt_edit || policy.agent_rules.no_self_registry_edit) {
    // These are enforced at the path level by zones.ts
  }

  return {
    passed: context.zone !== 'black' && violations.length === 0,
    zone: context.zone,
    violations,
    requiredActions,
  };
}
