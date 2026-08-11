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

import { classifyDeclaredScopes, classifyPaths } from './zones.js';
import { compilePathGlob, pathGlobCovers, pathGlobsIntersect } from './path-glob.js';
import { highestRiskZone, isRiskZone, RISK_ZONES } from './risk.js';

function riskRank(zone: RiskZone): number {
  return RISK_ZONES.indexOf(zone);
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

  const principal: AgentPrincipal = Object.freeze({
    registry_id: registry.agent_id,
    runtime_uid: runtimeIdentity.agent_uid,
    run_id: runtimeIdentity.run_id,
    provider: runtimeIdentity.provider,
    ...(runtimeIdentity.authenticated_github_identity
      ? {
          authenticated_github_identity: Object.freeze({
            login: runtimeIdentity.authenticated_github_identity.login,
            is_bot: runtimeIdentity.authenticated_github_identity.is_bot,
          }),
        }
      : {}),
  });
  const permissions = {
    paths: {
      allow: [...registry.permissions.paths.allow],
      deny: [...registry.permissions.paths.deny],
    },
    actions: { ...registry.permissions.actions },
    github: { ...registry.permissions.github },
    max_risk_zone: registry.permissions.max_risk_zone,
  } satisfies AgentPermissions;
  Object.freeze(permissions.paths.allow);
  Object.freeze(permissions.paths.deny);
  Object.freeze(permissions.paths);
  Object.freeze(permissions.actions);
  Object.freeze(permissions.github);
  Object.freeze(permissions);

  return Object.freeze({
    principal,
    registry_entry_agent_id: registry.agent_id,
    permissions,
    resolved_at: new Date().toISOString(),
    source: registry.schema === 'openslack.agent_registry.v2' ? 'registry_v2' : 'registry_v1',
  });
}

export function authorizeAgentAction(args: {
  snapshot: AgentPermissionSnapshot | null;
  action: string;
  changedPaths?: string[];
  declaredScope?: string[];
  riskZone?: RiskZone;
}): AuthorizationResult {
  const { snapshot, action, riskZone } = args;
  const diagnostics: string[] = [`Authorizing action="${action}"`];

  // 1. Unknown principal
  if (!snapshot) {
    diagnostics.push('DENY: no permission snapshot (unknown principal)');
    return {
      decision: 'deny',
      evidence: denyEvidence(
        'unknown_principal',
        `No permission snapshot resolved for action "${action}"`,
        'unknown',
        action,
      ),
      diagnostics,
    };
  }

  const { permissions, principal } = snapshot;
  const agentId = principal.registry_id;
  const baseEvidence = { identity_verified: true, registry_active: true };

  if (args.changedPaths !== undefined && args.declaredScope !== undefined) {
    diagnostics.push('DENY: changedPaths and declaredScope cannot both be supplied');
    return {
      decision: 'deny',
      evidence: denyEvidence(
        'ambiguous_path_scope',
        'Authorization input cannot contain both changed paths and a declared scope',
        agentId,
        action,
        baseEvidence,
      ),
      diagnostics,
    };
  }

  if (riskZone !== undefined && !isRiskZone(riskZone)) {
    diagnostics.push(`DENY: invalid requested risk zone "${String(riskZone)}"`);
    return {
      decision: 'deny',
      evidence: denyEvidence(
        'invalid_risk_zone',
        `Authorization input has unsupported risk zone "${String(riskZone)}"`,
        agentId,
        action,
        baseEvidence,
      ),
      diagnostics,
    };
  }

  if (!isRiskZone(permissions.max_risk_zone)) {
    diagnostics.push(
      `DENY: invalid permission max_risk_zone "${String(permissions.max_risk_zone)}"`,
    );
    return {
      decision: 'deny',
      evidence: denyEvidence(
        'invalid_permission_risk_zone',
        `Agent "${agentId}" has unsupported max_risk_zone "${String(permissions.max_risk_zone)}"`,
        agentId,
        action,
        baseEvidence,
      ),
      diagnostics,
    };
  }

  const authorizedPaths = args.declaredScope ?? args.changedPaths ?? [];
  const derivedRiskZone =
    authorizedPaths.length > 0
      ? args.declaredScope
        ? classifyDeclaredScopes(authorizedPaths)
        : classifyPaths(authorizedPaths)
      : undefined;
  const effectiveRiskZone = highestRiskZone(riskZone, derivedRiskZone);
  if (derivedRiskZone) {
    diagnostics.push(
      `Derived risk zone "${derivedRiskZone}" from ${args.declaredScope ? 'declared scope' : 'changed paths'}`,
    );
  }

  // 2. Suspended/retired identity — checked via registry employment status passed through
  //    (the identity.status is set during registry parse from employment.status)

  // 3. Black zone
  if (effectiveRiskZone === 'black') {
    diagnostics.push('DENY: black zone — unconditional');
    return {
      decision: 'deny',
      evidence: denyEvidence(
        'black_zone',
        `Black zone paths can never be acted on directly by agent "${agentId}"`,
        agentId,
        action,
        { ...baseEvidence, risk_zone: 'black' },
      ),
      diagnostics,
    };
  }

  // 4. Risk ceiling
  if (effectiveRiskZone && riskRank(effectiveRiskZone) > riskRank(permissions.max_risk_zone)) {
    diagnostics.push(
      `DENY: risk zone "${effectiveRiskZone}" exceeds max_risk_zone "${permissions.max_risk_zone}"`,
    );
    return {
      decision: 'deny',
      evidence: denyEvidence(
        'risk_ceiling',
        `Action requires "${effectiveRiskZone}" zone but agent "${agentId}" ceiling is "${permissions.max_risk_zone}"`,
        agentId,
        action,
        { ...baseEvidence, risk_zone: effectiveRiskZone },
      ),
      diagnostics,
    };
  }

  // 5. Path deny (deny overrides allow)
  if (authorizedPaths.length > 0) {
    const denyMatchers = permissions.paths.deny.map((glob) => ({
      glob,
      matches: compilePathGlob(glob),
    }));
    const allowMatchers = permissions.paths.allow.map((glob) => ({
      glob,
      matches: compilePathGlob(glob),
    }));
    for (const p of authorizedPaths) {
      for (const { glob: denyGlob, matches } of denyMatchers) {
        if (args.declaredScope ? pathGlobsIntersect(p, denyGlob) : matches(p)) {
          diagnostics.push(`DENY: path "${p}" matches deny glob "${denyGlob}"`);
          return {
            decision: 'deny',
            evidence: denyEvidence(
              'path_denied',
              `Path "${p}" is denied by pattern "${denyGlob}" for agent "${agentId}"`,
              agentId,
              action,
              { ...baseEvidence, risk_zone: effectiveRiskZone },
            ),
            diagnostics,
          };
        }
      }
    }

    // 6. Path allow check
    for (const p of authorizedPaths) {
      const allowed = allowMatchers.some(({ glob, matches }) =>
        args.declaredScope ? pathGlobCovers(glob, p) : matches(p),
      );
      if (!allowed) {
        diagnostics.push(`DENY: path "${p}" not in allow list`);
        return {
          decision: 'deny',
          evidence: denyEvidence(
            'path_not_allowed',
            `Path "${p}" is outside allowed paths for agent "${agentId}"`,
            agentId,
            action,
            { ...baseEvidence, risk_zone: effectiveRiskZone },
          ),
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
      evidence: denyEvidence(
        'github_approve_forbidden',
        `Agent "${agentId}" cannot approve PRs — agents never hold approval authority`,
        agentId,
        action,
        baseEvidence,
      ),
      diagnostics,
    };
  }

  // 8. GitHub merge check
  if (action === 'github.merge' && !permissions.github.can_merge) {
    diagnostics.push('DENY: agent cannot merge');
    return {
      decision: 'deny',
      evidence: denyEvidence(
        'github_merge_forbidden',
        `Agent "${agentId}" does not have merge permission`,
        agentId,
        action,
        baseEvidence,
      ),
      diagnostics,
    };
  }

  // 9-11. Action verdict
  const actionVerdict = permissions.actions[action];
  if (actionVerdict === 'deny') {
    diagnostics.push(`DENY: action "${action}" is explicitly denied`);
    return {
      decision: 'deny',
      evidence: denyEvidence(
        'action_denied',
        `Action "${action}" is denied for agent "${agentId}"`,
        agentId,
        action,
        { ...baseEvidence, risk_zone: effectiveRiskZone },
      ),
      diagnostics,
    };
  }
  if (actionVerdict === 'ask') {
    diagnostics.push(`ASK: action "${action}" requires human confirmation`);
    return {
      decision: 'ask',
      evidence: {
        rule: 'action_ask',
        reason: `Action "${action}" requires confirmation for agent "${agentId}"`,
        agent_id: agentId,
        action,
        ...baseEvidence,
        risk_zone: effectiveRiskZone,
      },
      prompt_message: `Agent "${agentId}" requests permission to execute "${action}". Allow?`,
      diagnostics,
    };
  }
  if (actionVerdict === 'allow') {
    diagnostics.push(`ALLOW: action "${action}" is explicitly allowed`);
    return {
      decision: 'allow',
      evidence: {
        rule: 'action_allowed',
        reason: `Action "${action}" is allowed for agent "${agentId}"`,
        agent_id: agentId,
        action,
        ...baseEvidence,
        risk_zone: effectiveRiskZone,
      },
      diagnostics,
    };
  }

  // 12. Unknown action — fail closed
  diagnostics.push(`DENY: unknown action "${action}"`);
  return {
    decision: 'deny',
    evidence: denyEvidence(
      'unknown_action',
      `Action "${action}" is not in the permissions list for agent "${agentId}"`,
      agentId,
      action,
      { ...baseEvidence, risk_zone: effectiveRiskZone },
    ),
    diagnostics,
  };
}
