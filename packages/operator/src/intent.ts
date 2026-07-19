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
  const m =
    q.match(/--agent-id\s+(\S+)/) || q.match(/agent[:\s]+(\w+)/i) || q.match(/for\s+(\w+)$/i);
  return m?.[1];
}

function extractPaths(q: string): string | undefined {
  const m = q.match(/--paths\s+"([^"]+)"/);
  return m?.[1];
}

function extractTitle(text: string): string | undefined {
  const quoted = text.match(/["“](.+?)["”]/);
  if (quoted) return quoted[1].trim();
  const flag = text.match(/--title\s+"([^"]+)"/i) || text.match(/--title\s+(.+)$/i);
  return flag?.[1]?.trim();
}

function looksProfileSync(q: string): boolean {
  return (
    /\bprofile[- ]?sync\b|\bprofile\b.*\b(drift|sync|preview|check)\b|\bgithub\b.*\bprofile\b/i.test(
      q,
    ) || /主页|主頁|个人主页|個人主頁|画像|档案|檔案/.test(q)
  );
}

function extractProfileSyncAction(q: string): 'check' | 'preview' | 'create-pr' {
  if (q.includes('preview') || q.includes('预览') || q.includes('預覽')) return 'preview';
  if (q.includes('run') || q.includes('create pr') || q.includes('创建') || q.includes('建立'))
    return 'create-pr';
  return 'check';
}

function looksWorkflowShaped(q: string): boolean {
  if (/\bpr\s*#?\d+|\bpull request\s*#?\d+/i.test(q)) return false;
  const broadScope =
    /\b(all|every|across|multiple|many|open prs?|prs|pull requests?|issues?|endpoints?|packages?|codebase|migration)\b/i.test(
      q,
    ) || /全部|所有|多个|批量|迁移|端点|包|代码库/i.test(q);
  const workflowWork =
    /\b(review|audit|verify|verification|triage|research|scan|root[- ]cause|governance|end to end)\b/i.test(
      q,
    ) || /审查|验证|研究|扫描|根因|治理|端到端/i.test(q);
  return broadScope && workflowWork;
}

function looksFirstCheckRecommendation(q: string): boolean {
  const asksWhatToCheck =
    /先检查|優先檢查|优先检查|先看哪|先看哪里|先看哪裏|检查哪|檢查哪/.test(q) ||
    (/最值得|值得|应该|應該|应当|應當/.test(q) && /检查|檢查|排查|看哪/.test(q));
  const repoScope =
    /\brepo\b|\brepository\b|\bcodebase\b|\bworkspace\b/.test(q) ||
    /仓库|倉庫|项目|專案|工程|代码库|代碼庫|系统|系統/.test(q);
  return asksWhatToCheck && repoScope;
}

export function parseIntent(text: string): Intent {
  const q = text.toLowerCase().trim();

  if (q.includes('ultracode')) {
    return { kind: 'workflow_draft_required', slots: { query: text }, confidence: 0.95 };
  }

  if (/\buse (a )?workflow\b/i.test(text)) {
    return { kind: 'workflow_recommended', slots: { query: text }, confidence: 0.9 };
  }

  if (looksWorkflowShaped(q)) {
    return { kind: 'workflow_recommended', slots: { query: text }, confidence: 0.85 };
  }

  if (looksProfileSync(q)) {
    return {
      kind: 'profile_sync',
      slots: { action: extractProfileSyncAction(q), query: text },
      confidence: 0.85,
    };
  }

  // ── PRMS ─────────────────────────────────────────────────
  // Detect PR context even without a number (for clarification)
  const hasPRContext = /\bpr\b|\bpull request\b/i.test(text);
  const prNumber = extractPRNumber(text, q);

  if (
    (q.includes('pr') || q.includes('pull request')) &&
    (q.includes('queue') || q.includes('队列'))
  ) {
    return { kind: 'pr_queue', slots: {}, confidence: 0.9 };
  }

  if (
    !prNumber &&
    hasPRContext &&
    (q.includes('check') ||
      q.includes('检查') ||
      q.includes('status') ||
      q.includes('状态') ||
      q.includes('review') ||
      q.includes('审查'))
  ) {
    return { kind: 'pr_queue', slots: {}, confidence: 0.8 };
  }

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
    if (
      q.includes('why') ||
      q.includes('不能') ||
      q.includes('block') ||
      q.includes('doctor') ||
      q.includes('诊断') ||
      q.includes('diagnose')
    ) {
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
  if (
    q.includes('issue') &&
    (q.includes('done') || q.includes('complete') || q.includes('finish'))
  ) {
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
  if (looksFirstCheckRecommendation(q)) {
    return { kind: 'doctor', slots: { scope: 'recommendation' }, confidence: 0.78 };
  }

  // Exact "doctor" match
  if (q === 'doctor' || q === 'check health' || q === 'health check') {
    return { kind: 'doctor', slots: {}, confidence: 0.95 };
  }

  // Chinese doctor keywords
  if (q === '健康检查' || q === '系统诊断' || q === '健康檢查' || q === '系統診斷') {
    return { kind: 'doctor', slots: {}, confidence: 0.9 };
  }

  // Check + health/doctor/诊断 (but NOT "check status")
  if (
    (q.includes('check') || q.includes('检查') || q.includes('诊断')) &&
    (q.includes('health') || q.includes('doctor') || q.includes('诊断')) &&
    !q.includes('status') &&
    !q.includes('状态')
  ) {
    return { kind: 'doctor', slots: {}, confidence: 0.9 };
  }

  // Status queries (not health-related)
  if (
    q.includes('status') &&
    (q.includes('workspace') || q.includes('overview') || q.includes('index'))
  ) {
    return { kind: 'status', slots: { scope: 'workspace' }, confidence: 0.85 };
  }

  if (q === 'status' || q === 'check status' || q.includes('overview')) {
    return { kind: 'status', slots: {}, confidence: 0.9 };
  }

  // Chinese status keywords
  if (
    q === '检查系统状态' ||
    q === '系统状态' ||
    q === '当前状态' ||
    q === '檢查系統狀態' ||
    q === '系統狀態' ||
    q === '當前狀態'
  ) {
    return { kind: 'status', slots: {}, confidence: 0.9 };
  }

  if (
    q.includes('metrics') ||
    q.includes('stats') ||
    q.includes('count') ||
    q.includes('digest') ||
    q.includes('summary') ||
    q.includes('report') ||
    q.includes('today')
  ) {
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
    return { kind: 'create_task', slots: { title: extractTitle(text) }, confidence: 0.85 };
  }

  // ── Agent operations ─────────────────────────────────────
  if (
    q.includes('claim') ||
    q.includes('tick') ||
    q.includes('pick up') ||
    q.includes('get task')
  ) {
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
    return { kind: 'github_repair_labels', slots: {}, confidence: 0.8 };
  }
  if (
    q.includes('repair') &&
    (q.includes('claim') || q.includes('claims') || q.includes('stale'))
  ) {
    return { kind: 'github_repair_claims', slots: {}, confidence: 0.8 };
  }
  if (q.includes('repair') && (q.includes('worktree') || q.includes('worktrees'))) {
    return { kind: 'task_repair_worktrees', slots: {}, confidence: 0.8 };
  }

  // ── PR classification (no PR number) ─────────────────────
  if (q.includes('classify') || q.includes('risk') || q.includes('zone')) {
    return {
      kind: 'unknown',
      slots: { reason: 'classify_pr', paths: extractPaths(q) },
      confidence: 0.6,
    };
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
