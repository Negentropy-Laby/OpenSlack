import type {
  RiskZone,
  AgentRegistryEntry,
  AgentRuntimeIdentity,
  AgentPermissionSnapshot,
  AgentPrincipal,
  AgentPermissions,
  AuthorizationResult,
  AuthorizationEvidence,
} from './types.js';

import { classifyPaths } from './zones.js';

const RISK_ZONE_ORDER: RiskZone[] = ['green', 'yellow', 'red', 'black'];

function riskRank(zone: RiskZone): number {
  return RISK_ZONE_ORDER.indexOf(zone);
}

function matchesGlob(path: string, glob: string): boolean {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '<<GLOBSTAR_SLASH>>')
    .replace(/\*\*/g, '<<GLOBSTAR>>')
    .replace(/\*/g, '[^/]*')
    .replace(/<<GLOBSTAR_SLASH>>/g, '(.*/)?')
    .replace(/<<GLOBSTAR>>/g, '.*');
  const regex = new RegExp(`^${escaped}$`);
  return regex.test(path);
}

function denyEvidence(
  rule: string,
  reason: string,
  agentId: string,
  action: string,
  extras: Partial<AuthorizationEvidence> = {},
): AuthorizationEvidence {
  return {
    rule,
    reason,
    agent_id: agentId,
    action,
    identity_verified: extras.identity_verified ?? false,
    registry_active: extras.registry_active ?? false,
    ...extras,
  };
}

export function resolvePermissionSnapshot(args: {
  registry: AgentRegistryEntry | null;
  runtimeIdentity: AgentRuntimeIdentity | null;
}): AgentPermissionSnapshot | null {
  const { registry, runtimeIdentity } = args;
  if (!registry || !runtimeIdentity) return null;

  const principal: AgentPrincipal = {
    registry_id: registry.agent_id,
    runtime_uid: runtimeIdentity.agent_uid,
    run_id: runtimeIdentity.run_id,
    provider: runtimeIdentity.provider,
    authenticated_github_identity: runtimeIdentity.authenticated_github_identity,
  };

  return {
    principal,
    registry_entry_agent_id: registry.agent_id,
    permissions: registry.permissions,
    resolved_at: new Date().toISOString(),
    source: registry.schema === 'openslack.agent_registry.v2' ? 'registry_v2' : 'registry_v1',
  };
}

export function authorizeAgentAction(args: {
  snapshot: AgentPermissionSnapshot | null;
  action: string;
  changedPaths?: string[];
  riskZone?: RiskZone;
}): AuthorizationResult {
  const { snapshot, action, changedPaths = [], riskZone } = args;
  const diagnostics: string[] = [`Authorizing action="${action}"`];

  // 1. Unknown principal
  if (!snapshot) {
    diagnostics.push('DENY: no permission snapshot (unknown principal)');
    return {
      decision: 'deny',
      evidence: denyEvidence('unknown_principal', `No permission snapshot resolved for action "${action}"`, 'unknown', action),
      diagnostics,
    };
  }

  const { permissions, principal } = snapshot;
  const agentId = principal.registry_id;
  const baseEvidence = { identity_verified: true, registry_active: true };

  // 2. Suspended/retired identity — checked via registry employment status passed through
  //    (the identity.status is set during registry parse from employment.status)

  // 3. Black zone
  if (riskZone === 'black') {
    diagnostics.push('DENY: black zone — unconditional');
    return {
      decision: 'deny',
      evidence: denyEvidence('black_zone', `Black zone paths can never be acted on directly by agent "${agentId}"`, agentId, action, { ...baseEvidence, risk_zone: 'black' }),
      diagnostics,
    };
  }

  // 4. Risk ceiling
  if (riskZone && riskRank(riskZone) > riskRank(permissions.max_risk_zone)) {
    diagnostics.push(`DENY: risk zone "${riskZone}" exceeds max_risk_zone "${permissions.max_risk_zone}"`);
    return {
      decision: 'deny',
      evidence: denyEvidence('risk_ceiling', `Action requires "${riskZone}" zone but agent "${agentId}" ceiling is "${permissions.max_risk_zone}"`, agentId, action, { ...baseEvidence, risk_zone: riskZone }),
      diagnostics,
    };
  }

  // 5. Path deny (deny overrides allow)
  if (changedPaths.length > 0) {
    for (const p of changedPaths) {
      for (const denyGlob of permissions.paths.deny) {
        if (matchesGlob(p, denyGlob)) {
          diagnostics.push(`DENY: path "${p}" matches deny glob "${denyGlob}"`);
          return {
            decision: 'deny',
            evidence: denyEvidence('path_denied', `Path "${p}" is denied by pattern "${denyGlob}" for agent "${agentId}"`, agentId, action, { ...baseEvidence, risk_zone: riskZone }),
            diagnostics,
          };
        }
      }
    }

    // 6. Path allow check
    for (const p of changedPaths) {
      const allowed = permissions.paths.allow.some((glob) => matchesGlob(p, glob));
      if (!allowed) {
        diagnostics.push(`DENY: path "${p}" not in allow list`);
        return {
          decision: 'deny',
          evidence: denyEvidence('path_not_allowed', `Path "${p}" is outside allowed paths for agent "${agentId}"`, agentId, action, { ...baseEvidence, risk_zone: riskZone }),
          diagnostics,
        };
      }
    }
  }

  // 7. GitHub approve — agents never approve
  if (action === 'github.approve') {
    diagnostics.push('DENY: agents can never submit GitHub APPROVE reviews');
    return {
      decision: 'deny',
      evidence: denyEvidence('github_approve_forbidden', `Agent "${agentId}" cannot approve PRs — agents never hold approval authority`, agentId, action, baseEvidence),
      diagnostics,
    };
  }

  // 8. GitHub merge check
  if (action === 'github.merge' && !permissions.github.can_merge) {
    diagnostics.push('DENY: agent cannot merge');
    return {
      decision: 'deny',
      evidence: denyEvidence('github_merge_forbidden', `Agent "${agentId}" does not have merge permission`, agentId, action, baseEvidence),
      diagnostics,
    };
  }

  // 9-11. Action verdict
  const actionVerdict = permissions.actions[action];
  if (actionVerdict === 'deny') {
    diagnostics.push(`DENY: action "${action}" is explicitly denied`);
    return {
      decision: 'deny',
      evidence: denyEvidence('action_denied', `Action "${action}" is denied for agent "${agentId}"`, agentId, action, { ...baseEvidence, risk_zone: riskZone }),
      diagnostics,
    };
  }
  if (actionVerdict === 'ask') {
    diagnostics.push(`ASK: action "${action}" requires human confirmation`);
    return {
      decision: 'ask',
      evidence: { rule: 'action_ask', reason: `Action "${action}" requires confirmation for agent "${agentId}"`, agent_id: agentId, action, ...baseEvidence, risk_zone: riskZone },
      prompt_message: `Agent "${agentId}" requests permission to execute "${action}". Allow?`,
      diagnostics,
    };
  }
  if (actionVerdict === 'allow') {
    diagnostics.push(`ALLOW: action "${action}" is explicitly allowed`);
    return {
      decision: 'allow',
      evidence: { rule: 'action_allowed', reason: `Action "${action}" is allowed for agent "${agentId}"`, agent_id: agentId, action, ...baseEvidence, risk_zone: riskZone },
      diagnostics,
    };
  }

  // 12. Unknown action — fail closed
  diagnostics.push(`DENY: unknown action "${action}"`);
  return {
    decision: 'deny',
    evidence: denyEvidence('unknown_action', `Action "${action}" is not in the permissions list for agent "${agentId}"`, agentId, action, { ...baseEvidence, risk_zone: riskZone }),
    diagnostics,
  };
}
