import {
  classifyPaths,
  compilePathGlob,
  highestRiskZone,
  isTaskRiskLevel,
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
  const forbidden = (manifest.forbidden_paths ?? []).map((pattern) => ({
    pattern,
    matches: compilePathGlob(pattern),
  }));
  for (const path of declaredScope) {
    for (const { pattern, matches } of forbidden) {
      if (matches(path)) {
        return { allowed: false, reason: `Path "${path}" matches forbidden pattern "${pattern}"` };
      }
    }
    if (classifyPaths([path]) === 'black') {
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

export interface AutoClaimGateResult {
  allowed: boolean;
  reason: string;
  manifest: IssueTaskManifest | null;
  riskZone: RiskZone;
  declaredScope: string[];
}

function rejectedGate(
  reason: string,
  options: {
    manifest?: IssueTaskManifest | null;
    riskZone?: RiskZone;
    declaredScope?: string[];
  } = {},
): AutoClaimGateResult {
  return {
    allowed: false,
    reason,
    manifest: options.manifest ?? null,
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
    return rejectedGate('Issue is not open');
  }
  if (
    !args.candidate.labels.includes('openslack:task') ||
    !args.candidate.labels.includes('openslack:ready')
  ) {
    return rejectedGate('Issue must have openslack:task and openslack:ready labels');
  }

  const parseResult = parseIssueTaskManifest(args.candidate.body);
  if (!parseResult.valid || !parseResult.manifest) {
    return rejectedGate(parseResult.errors.join('; ') || 'Task manifest is invalid');
  }
  const manifest = parseResult.manifest;
  const declaredScope = [...(manifest.allowed_paths ?? [])];
  const declaredRiskZone = taskRiskLevelToZone(manifest.risk_level);
  const pathRiskZone = declaredScope.length > 0 ? classifyPaths(declaredScope) : undefined;
  const effectiveRiskZone = highestRiskZone(declaredRiskZone, pathRiskZone)!;

  if (manifest.status !== 'ready') {
    return rejectedGate(`Task manifest status must be ready; got ${manifest.status}`, {
      manifest,
      riskZone: effectiveRiskZone,
      declaredScope,
    });
  }
  if (pathRiskZone && RISK_ZONES.indexOf(pathRiskZone) > RISK_ZONES.indexOf(declaredRiskZone)) {
    return rejectedGate(
      `Task risk ${manifest.risk_level} understates declared path scope ${pathRiskZone}`,
      { manifest, riskZone: effectiveRiskZone, declaredScope },
    );
  }

  const riskResult = filterByRisk(manifest, args.agentMaxRiskLevel, effectiveRiskZone);
  if (!riskResult.allowed) {
    return rejectedGate(riskResult.reason ?? 'Task risk gate rejected the issue', {
      manifest,
      riskZone: effectiveRiskZone,
      declaredScope,
    });
  }
  const capabilityResult = filterByCapability(manifest, args.agentCapabilities);
  if (!capabilityResult.allowed) {
    return rejectedGate(capabilityResult.reason ?? 'Task capability gate rejected the issue', {
      manifest,
      riskZone: effectiveRiskZone,
      declaredScope,
    });
  }
  const pathResult = filterByPath(manifest, declaredScope);
  if (!pathResult.allowed) {
    return rejectedGate(pathResult.reason ?? 'Task path gate rejected the issue', {
      manifest,
      riskZone: effectiveRiskZone,
      declaredScope,
    });
  }

  return {
    allowed: true,
    reason: '',
    manifest,
    riskZone: effectiveRiskZone,
    declaredScope,
  };
}
