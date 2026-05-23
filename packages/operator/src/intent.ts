import type { Intent } from './types.js';

function extractPRNumber(text: string, q: string): number | undefined {
  // If explicitly about an issue, do not treat as PR
  if (q.includes('issue')) return undefined;

  const m = text.match(/pr\s*#?(\d+)|pull\s*request\s*#?(\d+)/i);
  if (m) return Number(m[1] || m[2]);

  return undefined;
}

function extractIssueNumber(q: string): number | undefined {
  // Only match when preceded by "issue" to avoid clashing with PR numbers
  const m = q.match(/issue\s*#?(\d+)/);
  if (m) return Number(m[1]);

  // Fallback: standalone #N only if no PR context
  const bare = q.match(/\b#(\d+)\b/);
  if (bare) return Number(bare[1]);

  return undefined;
}

function extractAgentId(q: string): string | undefined {
  const m = q.match(/--agent-id\s+(\S+)/) || q.match(/agent[:\s]+(\w+)/i) || q.match(/for\s+(\w+)$/i);
  return m?.[1];
}

function extractPaths(q: string): string | undefined {
  const m = q.match(/--paths\s+"([^"]+)"/);
  return m?.[1];
}

export function parseIntent(text: string): Intent {
  const q = text.toLowerCase().trim();

  // ── PRMS ─────────────────────────────────────────────────
  // Detect PR context even without a number (for clarification)
  const hasPRContext = /\bpr\b|\bpull request\b/i.test(text);
  const prNumber = extractPRNumber(text, q);

  // "merge PR" without number → still recognize intent
  if ((q.includes('merge') || q.includes('合并')) && hasPRContext && !prNumber) {
    return { kind: 'pr_merge', slots: { prNumber: undefined }, confidence: 0.8 };
  }

  if (prNumber) {
    const slots: Record<string, string | number | undefined> = { prNumber };

    // "为什么不能合并" = diagnosis, not merge request
    if ((q.includes('merge') || q.includes('合并')) && !q.includes('不能') && !q.includes('why')) {
      return { kind: 'pr_merge', slots, confidence: 0.9 };
    }
    if (q.includes('why') || q.includes('不能') || q.includes('block') || q.includes('doctor') || q.includes('诊断') || q.includes('diagnose')) {
      return { kind: 'pr_doctor', slots, confidence: 0.9 };
    }
    if (q.includes('review') || q.includes('审查') || q.includes('report') || q.includes('报告')) {
      return { kind: 'pr_review', slots, confidence: 0.85 };
    }
    if (q.includes('watch') || q.includes('poll') || q.includes('wait')) {
      return { kind: 'pr_watch', slots, confidence: 0.85 };
    }
    if (q.includes('status') || q.includes('check') || q.includes('检查') || q.includes('状态')) {
      return { kind: 'pr_status', slots, confidence: 0.85 };
    }
    // Ambiguous PR query → doctor (most informative)
    return { kind: 'pr_doctor', slots, confidence: 0.7 };
  }

  // ── Issue lifecycle (must come before bare #N routing) ───
  if (q.includes('issue') && (q.includes('done') || q.includes('complete') || q.includes('finish'))) {
    const issueNumber = extractIssueNumber(q);
    return { kind: 'issue_done', slots: { issueNumber }, confidence: issueNumber ? 0.9 : 0.6 };
  }

  // ── Worktree + sync ──────────────────────────────────────
  if (q.includes('checkout') || q.includes('worktree') || q.includes('work on')) {
    const issueNumber = extractIssueNumber(q);
    const agentId = extractAgentId(q);
    return {
      kind: 'checkout_task',
      slots: { issueNumber, agentId },
      confidence: issueNumber && agentId ? 0.9 : 0.6,
    };
  }

  if (q.includes('sync') || q.includes('submit')) {
    const issueNumber = extractIssueNumber(q);
    const agentId = extractAgentId(q);
    const paths = extractPaths(q);
    return {
      kind: 'sync_task',
      slots: { issueNumber, agentId, paths },
      confidence: issueNumber && agentId && paths ? 0.9 : 0.5,
    };
  }

  // ── Diagnostics ──────────────────────────────────────────
  // Exact "doctor" match
  if (q === 'doctor' || q === 'check health' || q === 'health check') {
    return { kind: 'doctor', slots: {}, confidence: 0.95 };
  }

  // Check + health/doctor/诊断 (but NOT "check status")
  if ((q.includes('check') || q.includes('检查') || q.includes('诊断')) &&
      (q.includes('health') || q.includes('doctor') || q.includes('诊断')) &&
      !q.includes('status') && !q.includes('状态')) {
    return { kind: 'doctor', slots: {}, confidence: 0.9 };
  }

  // Status queries (not health-related)
  if (q.includes('status') && (q.includes('workspace') || q.includes('overview') || q.includes('index'))) {
    return { kind: 'status', slots: { scope: 'workspace' }, confidence: 0.85 };
  }

  if (q === 'status' || q === 'check status' || q.includes('overview')) {
    return { kind: 'status', slots: {}, confidence: 0.9 };
  }

  if (q.includes('metrics') || q.includes('stats') || q.includes('count') ||
      q.includes('digest') || q.includes('summary') || q.includes('report') || q.includes('today')) {
    return { kind: 'status', slots: { scope: 'metrics' }, confidence: 0.7 };
  }

  if (q.includes('workspace') && q.includes('validate')) {
    return { kind: 'doctor', slots: { scope: 'workspace' }, confidence: 0.85 };
  }

  if (q.includes('governance') || q.includes('audit')) {
    return { kind: 'governance_audit', slots: {}, confidence: 0.9 };
  }

  // ── Task creation ────────────────────────────────────────
  if (q.includes('create') && (q.includes('task') || q.includes('issue'))) {
    return { kind: 'create_task', slots: {}, confidence: 0.85 };
  }

  // ── Agent operations ─────────────────────────────────────
  if (q.includes('claim') || q.includes('tick') || q.includes('pick up') || q.includes('get task')) {
    const agentId = extractAgentId(q);
    return { kind: 'claim_task', slots: { agentId }, confidence: agentId ? 0.9 : 0.7 };
  }

  if (q.includes('hire') || q.includes('bootstrap')) {
    const agentId = extractAgentId(q);
    return { kind: 'unknown', slots: { reason: 'need_agent_id', agentId }, confidence: 0.5 };
  }

  // ── Eval ─────────────────────────────────────────────────
  if (q.includes('eval') || q.includes('evaluate') || q.includes('test') || q.includes('golden')) {
    return { kind: 'doctor', slots: { scope: 'eval' }, confidence: 0.8 };
  }

  if (q.includes('scorecard') || q.includes('fitness')) {
    return { kind: 'status', slots: { scope: 'scorecard' }, confidence: 0.7 };
  }

  // ── Repair ───────────────────────────────────────────────
  if (q.includes('repair') && (q.includes('label') || q.includes('labels'))) {
    return { kind: 'unknown', slots: { reason: 'repair_labels' }, confidence: 0.8 };
  }
  if (q.includes('repair') && (q.includes('claim') || q.includes('claims') || q.includes('stale'))) {
    return { kind: 'unknown', slots: { reason: 'repair_claims' }, confidence: 0.8 };
  }
  if (q.includes('repair all') || q.includes('fix all') || q.includes('repair-all')) {
    return { kind: 'unknown', slots: { reason: 'repair_all' }, confidence: 0.8 };
  }

  // ── PR classification (no PR number) ─────────────────────
  if (q.includes('classify') || q.includes('risk') || q.includes('zone')) {
    return { kind: 'unknown', slots: { reason: 'classify_pr', paths: extractPaths(q) }, confidence: 0.6 };
  }

  // ── Index ────────────────────────────────────────────────
  if (q.includes('index')) {
    return { kind: 'status', slots: { scope: 'index' }, confidence: 0.7 };
  }

  // ── Observe ──────────────────────────────────────────────
  if (q.includes('observe') || q.includes('monitor health')) {
    return { kind: 'doctor', slots: { scope: 'observe' }, confidence: 0.7 };
  }

  // Catch-all
  return { kind: 'unknown', slots: { query: text }, confidence: 0.0 };
}
