import type { IssueTaskManifest } from './manifest.js';
import { extractTaskBlock, parseIssueTaskManifest } from './manifest.js';
import type { RiskZone } from '@openslack/kernel';

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

type PathGlobToken =
  | { readonly kind: 'literal'; readonly value: string }
  | { readonly kind: 'star' }
  | { readonly kind: 'globstar' }
  | { readonly kind: 'globstar-directories' };

function tokenizePathGlob(pattern: string): PathGlobToken[] {
  const tokens: PathGlobToken[] = [];
  for (let index = 0; index < pattern.length; ) {
    if (pattern[index] !== '*') {
      tokens.push({ kind: 'literal', value: pattern[index]! });
      index += 1;
      continue;
    }

    let end = index;
    while (pattern[end] === '*') end += 1;
    if (end - index === 1) {
      tokens.push({ kind: 'star' });
      index = end;
      continue;
    }

    if (pattern[end] === '/') {
      tokens.push({ kind: 'globstar-directories' });
      index = end + 1;
      continue;
    }

    tokens.push({ kind: 'globstar' });
    index = end;
  }
  return tokens;
}

function matchesPathGlob(pattern: string, path: string): boolean {
  const tokens = tokenizePathGlob(pattern);
  type MatchState = {
    readonly tokenIndex: number;
    readonly pathIndex: number;
    readonly scanningDirectory: boolean;
  };
  const pending: MatchState[] = [{ tokenIndex: 0, pathIndex: 0, scanningDirectory: false }];
  const visited = new Set<string>();

  while (pending.length > 0) {
    const state = pending.pop()!;
    const key = `${state.tokenIndex}:${state.pathIndex}:${state.scanningDirectory ? 1 : 0}`;
    if (visited.has(key)) continue;
    visited.add(key);

    if (state.scanningDirectory) {
      if (state.pathIndex >= path.length) continue;
      if (path[state.pathIndex] === '/') {
        pending.push({
          tokenIndex: state.tokenIndex,
          pathIndex: state.pathIndex + 1,
          scanningDirectory: false,
        });
      } else {
        pending.push({ ...state, pathIndex: state.pathIndex + 1 });
      }
      continue;
    }

    const token = tokens[state.tokenIndex];
    if (!token) {
      if (state.pathIndex === path.length) return true;
      continue;
    }

    if (token.kind === 'literal') {
      if (path[state.pathIndex] === token.value) {
        pending.push({
          tokenIndex: state.tokenIndex + 1,
          pathIndex: state.pathIndex + 1,
          scanningDirectory: false,
        });
      }
      continue;
    }

    pending.push({
      tokenIndex: state.tokenIndex + 1,
      pathIndex: state.pathIndex,
      scanningDirectory: false,
    });
    if (token.kind === 'globstar-directories') {
      pending.push({ ...state, scanningDirectory: true });
    } else if (
      state.pathIndex < path.length &&
      (token.kind === 'globstar' || path[state.pathIndex] !== '/')
    ) {
      pending.push({ ...state, pathIndex: state.pathIndex + 1 });
    }
  }

  return false;
}

export function filterByPath(manifest: IssueTaskManifest, changedPaths: string[]): FilterResult {
  const forbidden = manifest.forbidden_paths || [];

  for (const path of changedPaths) {
    for (const fp of forbidden) {
      if (matchesPathGlob(fp, path)) {
        return { allowed: false, reason: `Path "${path}" matches forbidden pattern "${fp}"` };
      }
    }
  }

  // Check Black Zone (always forbidden regardless of manifest)
  const blackPatterns = [/^\.env$/, /\.pem$/, /\.key$/, /^secrets\//, /^credentials\//];
  for (const path of changedPaths) {
    for (const bp of blackPatterns) {
      if (bp.test(path)) {
        return {
          allowed: false,
          reason: `Path "${path}" is in Black Zone — rejected unconditionally`,
        };
      }
    }
  }

  return { allowed: true };
}

export function filterRedZonePaths(changedPaths: string[]): string[] {
  const redPatterns = [
    /^\.github\//,
    /^\.openslack\/policies\//,
    /^\.openslack\/agents\/registry\//,
    /^\.openslack\/agents\/prompts\//,
    /^\.openslack\/self\/constitution/,
    /^\.openslack\/self\/invariants/,
    /^packages\/kernel\/src\//,
    /^packages\/self-evolution\/src\/core\//,
  ];
  return changedPaths.filter((p) => redPatterns.some((rp) => rp.test(p)));
}

const RISK_LEVEL_TO_ZONE: Record<IssueTaskManifest['risk_level'], RiskZone> = {
  low: 'green',
  medium: 'yellow',
  high: 'red',
  critical: 'black',
};

export function riskLevelToZone(level: IssueTaskManifest['risk_level']): RiskZone {
  return RISK_LEVEL_TO_ZONE[level] ?? 'green';
}

export interface AutoClaimGateResult {
  allowed: boolean;
  reason: string;
  manifest: IssueTaskManifest | null;
  riskZone: RiskZone;
  changedPaths: string[];
}

export function runAutoClaimGates(args: {
  body: string;
  agentCapabilities: { primary?: string[]; secondary?: string[] };
  agentMaxRiskLevel: string;
}): AutoClaimGateResult {
  const block = extractTaskBlock(args.body);
  if (!block) {
    return {
      allowed: false,
      reason: 'No openslack-task block found in issue body',
      manifest: null,
      riskZone: 'green',
      changedPaths: [],
    };
  }

  const parseResult = parseIssueTaskManifest(args.body);
  if (!parseResult.valid) {
    return {
      allowed: false,
      reason: parseResult.errors.join('; '),
      manifest: null,
      riskZone: 'green',
      changedPaths: [],
    };
  }
  const manifest = parseResult.manifest!;

  if (manifest.status !== 'ready') {
    return {
      allowed: false,
      reason: `Task manifest status must be ready; got ${manifest.status ?? 'missing'}`,
      manifest,
      riskZone: riskLevelToZone(manifest.risk_level),
      changedPaths: manifest.allowed_paths ?? [],
    };
  }

  const riskResult = filterByRisk(manifest, args.agentMaxRiskLevel);
  if (!riskResult.allowed) {
    return {
      allowed: false,
      reason: riskResult.reason!,
      manifest,
      riskZone: riskLevelToZone(manifest.risk_level),
      changedPaths: [],
    };
  }

  const capResult = filterByCapability(manifest, args.agentCapabilities);
  if (!capResult.allowed) {
    return {
      allowed: false,
      reason: capResult.reason!,
      manifest,
      riskZone: riskLevelToZone(manifest.risk_level),
      changedPaths: [],
    };
  }

  const changedPaths = manifest.allowed_paths ?? [];
  const pathResult = filterByPath(manifest, changedPaths);
  if (!pathResult.allowed) {
    return {
      allowed: false,
      reason: pathResult.reason!,
      manifest,
      riskZone: riskLevelToZone(manifest.risk_level),
      changedPaths,
    };
  }

  return {
    allowed: true,
    reason: '',
    manifest,
    riskZone: riskLevelToZone(manifest.risk_level),
    changedPaths,
  };
}
