import type { IssueTaskManifest } from './manifest.js';

interface AgentCapabilities {
  primary?: string[];
  secondary?: string[];
}

interface AgentRegistry {
  agent_id: string;
  capabilities?: { primary?: string[]; secondary?: string[] };
  employment?: { status?: string };
  task_matching?: { max_risk_level?: string };
}

export interface FilterResult {
  allowed: boolean;
  reason?: string;
}

export function filterByCapability(
  manifest: IssueTaskManifest,
  agentCapabilities: AgentCapabilities,
): FilterResult {
  const required = manifest.required_capabilities || [];
  if (required.length === 0) return { allowed: true };

  const agentCaps = new Set([
    ...(agentCapabilities.primary || []),
    ...(agentCapabilities.secondary || []),
  ]);

  const missing = required.filter((c) => !agentCaps.has(c));
  if (missing.length > 0) {
    return { allowed: false, reason: `Agent lacks required capabilities: ${missing.join(', ')}` };
  }
  return { allowed: true };
}

const RISK_ORDER: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };

export function filterByRisk(
  manifest: IssueTaskManifest,
  maxRiskLevel: string = 'medium',
): FilterResult {
  const taskRisk = RISK_ORDER[manifest.risk_level] ?? 0;
  const maxRisk = RISK_ORDER[maxRiskLevel] ?? 1;

  if (taskRisk > maxRisk) {
    return {
      allowed: false,
      reason: `Task risk ${manifest.risk_level} exceeds agent max ${maxRiskLevel}`,
    };
  }

  if (manifest.risk_level === 'critical') {
    return {
      allowed: false,
      reason: 'Critical risk tasks require human assignment — not auto-claimable',
    };
  }

  return { allowed: true };
}

export function filterByPath(
  manifest: IssueTaskManifest,
  changedPaths: string[],
): FilterResult {
  const forbidden = manifest.forbidden_paths || [];

  for (const path of changedPaths) {
    for (const fp of forbidden) {
      const pattern = fp.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*');
      if (new RegExp(`^${pattern}$`).test(path)) {
        return { allowed: false, reason: `Path "${path}" matches forbidden pattern "${fp}"` };
      }
    }
  }

  // Check Black Zone (always forbidden regardless of manifest)
  const blackPatterns = [/^\.env$/, /\.pem$/, /\.key$/, /^secrets\//, /^credentials\//];
  for (const path of changedPaths) {
    for (const bp of blackPatterns) {
      if (bp.test(path)) {
        return { allowed: false, reason: `Path "${path}" is in Black Zone — rejected unconditionally` };
      }
    }
  }

  return { allowed: true };
}

export function filterRedZonePaths(changedPaths: string[]): string[] {
  const redPatterns = [
    /^\.github\//, /^\.openslack\/policies\//, /^\.openslack\/agents\/registry\//,
    /^\.openslack\/agents\/prompts\//, /^\.openslack\/self\/constitution/,
    /^\.openslack\/self\/invariants/, /^packages\/kernel\/src\//,
    /^packages\/self-evolution\/src\/core\//,
  ];
  return changedPaths.filter((p) => redPatterns.some((rp) => rp.test(p)));
}
