import {
  classifyDeclaredScopes,
  classifyPaths,
  highestRiskZone,
  isTaskRiskLevel,
  pathGlobCovers,
  RISK_ZONES,
  taskRiskLevelToZone,
  type RiskZone,
  type TaskRiskLevel,
} from '@openslack/kernel';
import type { IssueTaskManifest } from './manifest.js';
import { parseIssueTaskManifest } from './manifest.js';

interface AgentCapabilities {
  primary?: string[];
  secondary?: string[];
}

export interface AutoClaimCandidate {
  body: string;
  labels: readonly string[];
  state?: 'open' | 'closed' | 'unknown';
}

export type AutoClaimGateRejectionCode =
  | 'ISSUE_NOT_OPEN'
  | 'ISSUE_NOT_READY'
  | 'MANIFEST_INVALID'
  | 'AGENT_TYPE_LABEL_INVALID'
  | 'MANIFEST_NOT_READY'
  | 'RISK_UNDERSTATED'
  | 'RISK_DENIED'
  | 'CAPABILITY_DENIED'
  | 'PATH_DENIED';

export interface FilterResult {
  allowed: boolean;
  reason?: string;
}

export function filterByCapability(
  manifest: IssueTaskManifest,
  agentCapabilities: AgentCapabilities,
): FilterResult {
  const required = manifest.required_capabilities ?? [];
  if (required.length === 0) return { allowed: true };

  const agentCaps = new Set([
    ...(agentCapabilities.primary ?? []),
    ...(agentCapabilities.secondary ?? []),
  ]);
  const missing = required.filter((capability) => !agentCaps.has(capability));
  return missing.length > 0
    ? { allowed: false, reason: `Agent lacks required capabilities: ${missing.join(', ')}` }
    : { allowed: true };
}

export function filterByRisk(
  manifest: IssueTaskManifest,
  maxRiskLevel: unknown = 'medium',
  effectiveRiskZone?: RiskZone,
): FilterResult {
  if (!isTaskRiskLevel(maxRiskLevel)) {
    return {
      allowed: false,
      reason: `Agent max risk level is unsupported: ${String(maxRiskLevel)}`,
    };
  }
  if (!isTaskRiskLevel(manifest.risk_level)) {
    return {
      allowed: false,
      reason: `Task risk level is unsupported: ${String(manifest.risk_level)}`,
    };
  }

  const taskZone = effectiveRiskZone ?? taskRiskLevelToZone(manifest.risk_level);
  const maxZone = taskRiskLevelToZone(maxRiskLevel);
  if (RISK_ZONES.indexOf(taskZone) > RISK_ZONES.indexOf(maxZone)) {
    return {
      allowed: false,
      reason: `Task risk ${manifest.risk_level} (${taskZone}) exceeds agent max ${maxRiskLevel}`,
    };
  }
  if (taskZone === 'black') {
    return {
      allowed: false,
      reason: 'Critical or Black Zone tasks require human assignment — not auto-claimable',
    };
  }
  return { allowed: true };
}

export function filterByPath(manifest: IssueTaskManifest, declaredScope: string[]): FilterResult {
  const forbidden = manifest.forbidden_paths ?? [];
  for (const path of declaredScope) {
    for (const pattern of forbidden) {
      if (pathGlobCovers(pattern, path)) {
        return { allowed: false, reason: `Path "${path}" matches forbidden pattern "${pattern}"` };
      }
    }
    const pathZone = path.includes('*') ? classifyDeclaredScopes([path]) : classifyPaths([path]);
    if (pathZone === 'black') {
      return {
        allowed: false,
        reason: `Path "${path}" is in Black Zone — rejected unconditionally`,
      };
    }
  }
  return { allowed: true };
}

export function riskLevelToZone(level: TaskRiskLevel): RiskZone {
  return taskRiskLevelToZone(level);
}

export type AutoClaimGateResult =
  | {
      allowed: true;
      code: 'ALLOWED';
      reason: '';
      manifest: IssueTaskManifest;
      riskZone: RiskZone;
      declaredScope: string[];
    }
  | {
      allowed: false;
      code: AutoClaimGateRejectionCode;
      reason: string;
      manifest: null;
      riskZone: RiskZone;
      declaredScope: string[];
    };

function rejectedGate(
  code: AutoClaimGateRejectionCode,
  reason: string,
  options: {
    riskZone?: RiskZone;
    declaredScope?: string[];
  } = {},
): AutoClaimGateResult {
  return {
    allowed: false,
    code,
    reason,
    manifest: null,
    riskZone: options.riskZone ?? 'green',
    declaredScope: options.declaredScope ?? [],
  };
}

export function runAutoClaimGates(args: {
  candidate: AutoClaimCandidate;
  agentCapabilities: AgentCapabilities;
  agentMaxRiskLevel: unknown;
}): AutoClaimGateResult {
  if (args.candidate.state !== 'open') {
    return rejectedGate('ISSUE_NOT_OPEN', 'Issue is not open');
  }
  if (
    !args.candidate.labels.includes('openslack:task') ||
    !args.candidate.labels.includes('openslack:ready')
  ) {
    return rejectedGate(
      'ISSUE_NOT_READY',
      'Issue must have openslack:task and openslack:ready labels',
    );
  }

  const parseResult = parseIssueTaskManifest(args.candidate.body);
  if (!parseResult.valid || !parseResult.manifest) {
    return rejectedGate(
      'MANIFEST_INVALID',
      parseResult.errors.join('; ') || 'Task manifest is invalid',
    );
  }
  const manifest = parseResult.manifest;
  const declaredScope = [...(manifest.allowed_paths ?? [])];
  const declaredRiskZone = taskRiskLevelToZone(manifest.risk_level);
  const pathRiskZone = declaredScope.length > 0 ? classifyDeclaredScopes(declaredScope) : undefined;
  const effectiveRiskZone = highestRiskZone(declaredRiskZone, pathRiskZone)!;

  const agentTypeLabels = args.candidate.labels.filter((label) => label.startsWith('agent-type:'));
  const expectedAgentTypeLabel = `agent-type:${manifest.agent_type}`;
  if (agentTypeLabels.length !== 1 || agentTypeLabels[0] !== expectedAgentTypeLabel) {
    return rejectedGate(
      'AGENT_TYPE_LABEL_INVALID',
      `Issue must have exactly one agent type label matching ${expectedAgentTypeLabel}`,
      { riskZone: effectiveRiskZone, declaredScope },
    );
  }

  if (manifest.status !== 'ready') {
    return rejectedGate(
      'MANIFEST_NOT_READY',
      `Task manifest status must be ready; got ${manifest.status}`,
      {
        riskZone: effectiveRiskZone,
        declaredScope,
      },
    );
  }
  if (pathRiskZone && RISK_ZONES.indexOf(pathRiskZone) > RISK_ZONES.indexOf(declaredRiskZone)) {
    return rejectedGate(
      'RISK_UNDERSTATED',
      `Task risk ${manifest.risk_level} understates declared path scope ${pathRiskZone}`,
      { riskZone: effectiveRiskZone, declaredScope },
    );
  }

  const riskResult = filterByRisk(manifest, args.agentMaxRiskLevel, effectiveRiskZone);
  if (!riskResult.allowed) {
    return rejectedGate('RISK_DENIED', riskResult.reason ?? 'Task risk gate rejected the issue', {
      riskZone: effectiveRiskZone,
      declaredScope,
    });
  }
  const capabilityResult = filterByCapability(manifest, args.agentCapabilities);
  if (!capabilityResult.allowed) {
    return rejectedGate(
      'CAPABILITY_DENIED',
      capabilityResult.reason ?? 'Task capability gate rejected the issue',
      {
        riskZone: effectiveRiskZone,
        declaredScope,
      },
    );
  }
  const pathResult = filterByPath(manifest, declaredScope);
  if (!pathResult.allowed) {
    return rejectedGate('PATH_DENIED', pathResult.reason ?? 'Task path gate rejected the issue', {
      riskZone: effectiveRiskZone,
      declaredScope,
    });
  }

  return {
    allowed: true,
    code: 'ALLOWED',
    reason: '',
    manifest,
    riskZone: effectiveRiskZone,
    declaredScope,
  };
}
