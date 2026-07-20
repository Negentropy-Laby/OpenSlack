import { sanitizeTerminalText } from '../sanitize.js';

export interface LifecycleStage {
  name: string;
  label: string;
  status: string;
  icon: string;
  issueNumber?: number;
  issueUrl?: string;
  detail: string;
  /** Who is responsible for this stage (e.g. "team-lead", "agent-a") */
  owner?: string;
}

/** A specific missing workflow gate item. */
export interface BlockedGateItem {
  /** Gate name, e.g. "Coverage", "Review" */
  gate: string;
  /** What is missing */
  detail: string;
  /** How to resolve */
  action?: string;
}

export interface PhaseIssueItem {
  phase: string;
  issueNumber?: number;
  status: string;
  blockedBy?: string[];
  /** How this phase is tracked: native sub-issue or fallback comment-based */
  trackingMode?: 'native' | 'fallback';
}

export interface WorkflowLifecycleViewModel {
  workflowName: string;
  workflowHash: string;
  trustLevel: string;
  risk: string;
  sourcePath: string;
  stages: LifecycleStage[];
  phaseIssues: PhaseIssueItem[];
  currentRun?: {
    runId: string;
    status: string;
    startedAt: string;
    phaseIndex: number;
  };
  prNumber?: number;
  prStatus?: string;
  nextAction?: string;
  subIssueMode?: 'native' | 'fallback' | 'mixed' | 'unknown';
  dependencyMode?: 'native' | 'fallback' | 'mixed' | 'none';
  fallbackReasons?: string[];
  /** Specific blocked gate items for actionable display */
  blockedGateItems?: BlockedGateItem[];
  /** One-line status summary answering where/who/what */
  statusSummary?: string;
  /** The parent GitHub issue number for the relationship map tree */
  parentIssueNumber?: number;
}

/** Canonical stage keys for the 5-slot horizontal progress bar. */
export type CanonicalStageKey = 'proposal' | 'review' | 'run' | 'pr' | 'merged';

/** Status values for canonical stage slots. */
export type CanonicalStageStatus = 'complete' | 'current' | 'pending' | 'failed';

/** A single slot in the horizontal 5-stage progress bar. */
export interface CanonicalStageSlot {
  key: CanonicalStageKey;
  label: string;
  status: CanonicalStageStatus;
  issueNumber?: number;
}

const CANONICAL_KEYS: CanonicalStageKey[] = ['proposal', 'review', 'run', 'pr', 'merged'];

const CANONICAL_LABELS: Record<CanonicalStageKey, string> = {
  proposal: 'Proposal',
  review: 'Review',
  run: 'Run',
  pr: 'PR',
  merged: 'Merged',
};

/**
 * Map a stage name from LifecycleStage to a canonical key.
 * Uses prefix matching and common aliases.
 */
export function classifyStageName(name: string): CanonicalStageKey | null {
  const lower = name.toLowerCase().replace(/[_-]/g, '');
  if (lower.includes('proposal') || lower.includes('propose') || lower.includes('draft'))
    return 'proposal';
  if (lower.includes('review') || lower.includes('approve') || lower.includes('approval'))
    return 'review';
  if (
    lower.includes('run') ||
    lower.includes('exec') ||
    lower.includes('execute') ||
    lower.includes('build') ||
    lower.includes('impl')
  )
    return 'run';
  if (lower.includes('pr') || lower.includes('pullrequest')) return 'pr';
  if (
    lower.includes('done') ||
    lower.includes('complet') ||
    lower.includes('finish') ||
    lower.includes('success') ||
    lower.includes('merge')
  )
    return 'merged';
  return null;
}

/**
 * Map a LifecycleStage status to a CanonicalStageStatus.
 */
function classifyStageStatus(status: string): CanonicalStageStatus {
  const lower = status.toLowerCase();
  if (lower === 'complete' || lower === 'done' || lower === 'merged' || lower === 'approved')
    return 'complete';
  if (lower === 'failed' || lower === 'error' || lower === 'rejected') return 'failed';
  if (lower === 'in-progress' || lower === 'running' || lower === 'active') return 'current';
  return 'pending';
}

/**
 * Determine overall canonical status from which stages have completed.
 * All slots up to the first non-complete get 'complete', the next gets 'current',
 * and remaining get 'pending'. Any 'failed' stage propagates 'failed'.
 */
function resolveCanonicalStatus(
  matchedStages: Map<CanonicalStageKey, { status: CanonicalStageStatus; issueNumber?: number }>,
): CanonicalStageStatus[] {
  const result: CanonicalStageStatus[] = CANONICAL_KEYS.map(
    () => 'pending' as CanonicalStageStatus,
  );

  // Find the farthest progress point
  let farthestComplete = -1;
  let hasFailed = false;
  let failedIndex = -1;

  for (let i = 0; i < CANONICAL_KEYS.length; i++) {
    const key = CANONICAL_KEYS[i]!;
    const matched = matchedStages.get(key);
    if (matched) {
      if (matched.status === 'failed') {
        hasFailed = true;
        failedIndex = i;
        break;
      }
      if (matched.status === 'complete') {
        farthestComplete = Math.max(farthestComplete, i);
      } else if (matched.status === 'current') {
        // current stage implies all before it are complete
        farthestComplete = Math.max(farthestComplete, i - 1);
        result[i] = 'current';
      }
    }
  }

  if (hasFailed && failedIndex >= 0) {
    for (let i = 0; i <= farthestComplete; i++) {
      result[i] = 'complete';
    }
    result[failedIndex] = 'failed';
    return result;
  }

  // Fill complete stages up to farthest
  for (let i = 0; i <= farthestComplete; i++) {
    if (result[i] !== 'current') {
      result[i] = 'complete';
    }
  }

  // If we have a current stage already set, the ones after remain pending
  // If no current was set and we have some complete, the next one becomes current
  const hasCurrent = result.some((s) => s === 'current');
  if (!hasCurrent && farthestComplete >= 0 && farthestComplete < CANONICAL_KEYS.length - 1) {
    result[farthestComplete + 1] = 'current';
  }

  // If no stages matched at all but we have stages, mark first as current
  if (farthestComplete === -1 && !hasCurrent && matchedStages.size === 0) {
    result[0] = 'current';
  }

  return result;
}

/**
 * Map an array of LifecycleStage objects to exactly 5 CanonicalStageSlots
 * for the horizontal progress bar.
 *
 * The mapping works by:
 * 1. Classifying each LifecycleStage name to a canonical key
 * 2. Determining which canonical slots are complete/current/pending/failed
 * 3. Producing the 5 slots with labels and issue numbers
 */
export function mapCanonicalStages(stages: LifecycleStage[]): CanonicalStageSlot[] {
  if (stages.length === 0) {
    return CANONICAL_KEYS.map((key, i) => ({
      key,
      label: CANONICAL_LABELS[key],
      status: i === 0 ? ('current' as CanonicalStageStatus) : ('pending' as CanonicalStageStatus),
    }));
  }

  const matchedStages = new Map<
    CanonicalStageKey,
    { status: CanonicalStageStatus; issueNumber?: number }
  >();

  for (const stage of stages) {
    const key = classifyStageName(stage.name);
    if (key) {
      const status = classifyStageStatus(stage.status);
      const existing = matchedStages.get(key);
      // Keep the more advanced status, or the failed status
      if (!existing) {
        matchedStages.set(key, { status, issueNumber: stage.issueNumber });
      } else {
        // Prefer complete > current > pending, and always prefer failed
        const order: Record<CanonicalStageStatus, number> = {
          failed: 0,
          complete: 1,
          current: 2,
          pending: 3,
        };
        if (order[status] < order[existing.status]) {
          matchedStages.set(key, {
            status,
            issueNumber: stage.issueNumber ?? existing.issueNumber,
          });
        }
      }
    }
  }

  // If no stages matched any canonical key, fall back to simple sequential mapping
  if (matchedStages.size === 0) {
    // Use first 5 stages in order
    const result: CanonicalStageSlot[] = CANONICAL_KEYS.map((key, i) => {
      const stage = stages[i];
      if (stage) {
        return {
          key,
          label: CANONICAL_LABELS[key],
          status: classifyStageStatus(stage.status),
          issueNumber: stage.issueNumber,
        };
      }
      return {
        key,
        label: CANONICAL_LABELS[key],
        status: i === 0 ? 'current' : 'pending',
      };
    });
    return result;
  }

  const resolvedStatuses = resolveCanonicalStatus(matchedStages);

  return CANONICAL_KEYS.map((key, i) => ({
    key,
    label: CANONICAL_LABELS[key],
    status: resolvedStatuses[i] ?? 'pending',
    issueNumber: matchedStages.get(key)?.issueNumber,
  }));
}

export function mapWorkflowLifecycleToViewModel(data?: {
  workflowName?: string;
  workflowHash?: string;
  trustLevel?: string;
  risk?: string;
  sourcePath?: string;
  stages?: Array<{
    name?: string;
    label?: string;
    status?: string;
    icon?: string;
    issueNumber?: number;
    issueUrl?: string;
    detail?: string;
    owner?: string;
  }>;
  phaseIssues?: Array<{
    phase?: string;
    issueNumber?: number;
    status?: string;
    blockedBy?: string[];
    trackingMode?: 'native' | 'fallback';
  }>;
  currentRun?: {
    runId?: string;
    status?: string;
    startedAt?: string;
    phaseIndex?: number;
  };
  prNumber?: number;
  prStatus?: string;
  nextAction?: string;
  subIssueMode?: 'native' | 'fallback' | 'mixed' | 'unknown';
  dependencyMode?: 'native' | 'fallback' | 'mixed' | 'none';
  fallbackReasons?: string[];
  blockedGateItems?: Array<{ gate: string; detail: string; action?: string }>;
  statusSummary?: string;
  parentIssueNumber?: number;
}): WorkflowLifecycleViewModel {
  const s = sanitizeTerminalText;

  const stages: LifecycleStage[] = (data?.stages ?? []).map((stage) => ({
    name: s(stage.name ?? ''),
    label: s(stage.label ?? ''),
    status: s(stage.status ?? 'pending'),
    icon: s(stage.icon ?? '●'),
    issueNumber: stage.issueNumber,
    issueUrl: stage.issueUrl ? s(stage.issueUrl) : undefined,
    detail: s(stage.detail ?? ''),
    owner: stage.owner ? s(stage.owner) : undefined,
  }));

  const phaseIssues: PhaseIssueItem[] = (data?.phaseIssues ?? []).map((pi) => ({
    phase: s(pi.phase ?? ''),
    issueNumber: pi.issueNumber,
    status: s(pi.status ?? 'open'),
    blockedBy: (pi.blockedBy ?? []).map(s),
    trackingMode: pi.trackingMode,
  }));

  return {
    workflowName: s(data?.workflowName ?? ''),
    workflowHash: s(data?.workflowHash ?? ''),
    trustLevel: s(data?.trustLevel ?? 'untrusted'),
    risk: s(data?.risk ?? 'unknown'),
    sourcePath: s(data?.sourcePath ?? ''),
    stages,
    phaseIssues,
    currentRun: data?.currentRun
      ? {
          runId: s(data.currentRun.runId ?? ''),
          status: s(data.currentRun.status ?? ''),
          startedAt: s(data.currentRun.startedAt ?? ''),
          phaseIndex: data.currentRun.phaseIndex ?? 0,
        }
      : undefined,
    prNumber: data?.prNumber,
    prStatus: data?.prStatus ? s(data.prStatus) : undefined,
    nextAction: data?.nextAction ? s(data.nextAction) : undefined,
    subIssueMode: data?.subIssueMode,
    dependencyMode: data?.dependencyMode,
    fallbackReasons: (data?.fallbackReasons ?? []).map(s),
    blockedGateItems: data?.blockedGateItems?.map((g) => ({
      gate: s(g.gate),
      detail: s(g.detail),
      action: g.action ? s(g.action) : undefined,
    })),
    statusSummary: data?.statusSummary ? s(data.statusSummary) : undefined,
    parentIssueNumber: data?.parentIssueNumber,
  };
}
