import { createHash } from 'node:crypto';
import { getClient } from './client.js';
import type { Octokit } from '@octokit/rest';

export interface FinalizeWorkflowPROpts {
  governanceIssue?: number;
  proposalIssue?: number;
  reviewIssue?: number;
  phaseIssues?: number[];
  workflowHash?: string;
  trustDecision?: 'trusted' | 'untrusted' | 'core';
  trustReviewer?: string;
  trustReviewCommitOid?: string;
  /** Repository evidence observed by the gate, rechecked immediately before writes. */
  expectedHeadSha?: string;
  expectedBaseSha?: string;
}

export type FinalizeWorkflowFailureCode =
  | 'INVALID_TARGET'
  | 'PR_QUERY_FAILED'
  | 'PR_NOT_MERGED'
  | 'GOVERNANCE_EVIDENCE_MISSING'
  | 'PR_EVIDENCE_DRIFT'
  | 'COMMENT_LOOKUP_FAILED'
  | 'COMMENT_RESULT_UNKNOWN'
  | 'LIFECYCLE_WRITE_FAILED';
export interface FinalizeWorkflowFailure {
  code: FinalizeWorkflowFailureCode;
  stage: 'preflight' | 'comment' | 'labels' | 'close';
  issueNumber?: number;
}
export interface FinalizeWorkflowPRResult {
  closedIssues: number[];
  commentedIssues: number[];
  updatedLabels: number[];
  errors: string[];
  failures?: FinalizeWorkflowFailure[];
  dryRun?: boolean;
}

/** Preparation only: a preview never queries a PR or enters the write boundary. */
export async function previewWorkflowFinalization(
  prNumber: number,
): Promise<FinalizeWorkflowPRResult | undefined> {
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0)
    throw new TypeError('PR number must be a positive safe integer.');
  const client = await getClient();
  return client.isDryRun
    ? {
        closedIssues: [],
        commentedIssues: [],
        updatedLabels: [],
        errors: [],
        failures: [],
        dryRun: true,
      }
    : undefined;
}

export async function finalizeWorkflowPR(
  prNumber: number,
  opts: FinalizeWorkflowPROpts,
): Promise<FinalizeWorkflowPRResult> {
  const result: FinalizeWorkflowPRResult & { failures: FinalizeWorkflowFailure[] } = {
    closedIssues: [],
    commentedIssues: [],
    updatedLabels: [],
    errors: [],
    failures: [],
  };
  const refuse = (code: FinalizeWorkflowFailureCode, message: string) => {
    result.failures.push({ code, stage: 'preflight' });
    result.errors.push(message);
    return result;
  };
  if (
    [
      prNumber,
      opts.governanceIssue,
      opts.proposalIssue,
      opts.reviewIssue,
      ...(opts.phaseIssues ?? []),
    ].some((value) => value !== undefined && (!Number.isSafeInteger(value) || value <= 0))
  ) {
    return refuse(
      'INVALID_TARGET',
      'Cannot finalize: PR and Issue numbers must be positive safe integers.',
    );
  }
  let client: Awaited<ReturnType<typeof getClient>>;
  try {
    client = await getClient();
  } catch {
    return refuse(
      'PR_QUERY_FAILED',
      'Cannot finalize: GitHub client is unavailable; restore access and retry the read-only gate.',
    );
  }
  if (client.isDryRun) {
    console.log(
      `[DRY RUN] Preview only for workflow PR #${prNumber}; live merge and evidence checks not performed.`,
    );
    return { ...result, dryRun: true };
  }
  let pr;
  try {
    pr = (
      await client.octokit.pulls.get({
        owner: client.owner,
        repo: client.repo,
        pull_number: prNumber,
      })
    ).data;
  } catch {
    return refuse(
      'PR_QUERY_FAILED',
      'Cannot finalize: live PR query failed; restore GitHub access and retry the read-only gate.',
    );
  }
  if (pr.merged !== true)
    return refuse(
      'PR_NOT_MERGED',
      `Cannot finalize: PR #${prNumber} is not merged. Complete its governed merge first.`,
    );
  if (
    opts.governanceIssue &&
    (!opts.expectedHeadSha ||
      !opts.expectedBaseSha ||
      !opts.workflowHash ||
      !opts.trustReviewer ||
      !opts.trustDecision ||
      opts.trustReviewCommitOid !== opts.expectedHeadSha)
  ) {
    return refuse(
      'GOVERNANCE_EVIDENCE_MISSING',
      'Cannot finalize: repository governance evidence is incomplete. Re-run the repository gate.',
    );
  }
  if (
    (opts.expectedHeadSha !== undefined && pr.head.sha !== opts.expectedHeadSha) ||
    (opts.expectedBaseSha !== undefined && pr.base.sha !== opts.expectedBaseSha)
  ) {
    return refuse(
      'PR_EVIDENCE_DRIFT',
      'Cannot finalize: live PR head/base differs from reviewed evidence. Re-run the repository gate; do not substitute another base.',
    );
  }

  // Comments are keyed by their exact target/evidence, not by mutable workflow names.
  // A failed POST is never retried here: callers must reconcile its unknown result.
  async function commentOnce(issueNumber: number, lines: string[]): Promise<void> {
    const plainBody = lines.join('\n');
    const key = createHash('sha256')
      .update(
        JSON.stringify([
          prNumber,
          issueNumber,
          opts.expectedHeadSha ?? null,
          opts.expectedBaseSha ?? null,
          plainBody,
        ]),
      )
      .digest('hex');
    const body = `${plainBody}\n\n<!-- openslack-workflow-finalize:${key} -->`;
    for (let page = 1; page <= 100; page++) {
      let comments;
      try {
        comments = (
          await client.octokit.issues.listComments({
            owner: client.owner,
            repo: client.repo,
            issue_number: issueNumber,
            per_page: 100,
            page,
          })
        ).data;
      } catch {
        throw new Error('COMMENT_LOOKUP_FAILED');
      }
      if (comments.some((comment) => comment.body === body || comment.body === plainBody)) {
        result.commentedIssues.push(issueNumber);
        return;
      }
      if (comments.length < 100) {
        try {
          await client.octokit.issues.createComment({
            owner: client.owner,
            repo: client.repo,
            issue_number: issueNumber,
            body,
          });
        } catch {
          throw new Error('COMMENT_RESULT_UNKNOWN');
        }
        result.commentedIssues.push(issueNumber);
        return;
      }
    }
    throw new Error('COMMENT_LOOKUP_FAILED');
  }

  async function target(
    kind: 'governance' | 'proposal' | 'review' | 'phase',
    issueNumber: number,
  ): Promise<boolean> {
    let stage: FinalizeWorkflowFailure['stage'] = 'comment';
    try {
      if (kind === 'governance') {
        await commentOnce(issueNumber, [
          '## Workflow Governance Completed',
          '',
          `Merged via PR #${prNumber}.`,
          `- **Evidence Hash**: ${opts.workflowHash}`,
          `- **Trust Decision**: ${opts.trustDecision}`,
          `- **Reviewer**: @${opts.trustReviewer}`,
          `- **Reviewed Commit**: ${opts.trustReviewCommitOid}`,
        ]);
      } else if (kind === 'review') {
        await commentOnce(issueNumber, [
          '## Workflow Merged',
          '',
          `This workflow was merged via PR #${prNumber}.`,
          ...(opts.workflowHash ? [`- **Hash**: ${opts.workflowHash}`] : []),
          ...(opts.trustDecision ? [`- **Trust Decision**: ${opts.trustDecision}`] : []),
        ]);
      }
      if (kind === 'proposal' || kind === 'phase') {
        stage = 'close';
        await client.octokit.issues.update({
          owner: client.owner,
          repo: client.repo,
          issue_number: issueNumber,
          state: 'closed',
          state_reason: 'completed',
        });
        result.closedIssues.push(issueNumber);
      }
      stage = 'labels';
      const labels =
        kind === 'governance'
          ? ['lifecycle:accepted', `workflow:${opts.trustDecision}`]
          : kind === 'review'
            ? [
                'lifecycle:accepted',
                ...(opts.trustDecision === 'trusted' || opts.trustDecision === 'untrusted'
                  ? [`workflow:${opts.trustDecision}`]
                  : []),
              ]
            : ['result:completed', kind === 'phase' ? 'lifecycle:completed' : 'lifecycle:accepted'];
      await client.octokit.issues.addLabels({
        owner: client.owner,
        repo: client.repo,
        issue_number: issueNumber,
        labels,
      });
      result.updatedLabels.push(issueNumber);
      if (kind === 'governance') {
        stage = 'close';
        await client.octokit.issues.update({
          owner: client.owner,
          repo: client.repo,
          issue_number: issueNumber,
          state: 'closed',
          state_reason: 'completed',
        });
        result.closedIssues.push(issueNumber);
      }
      return true;
    } catch (error) {
      const code =
        error instanceof Error &&
        (error.message === 'COMMENT_LOOKUP_FAILED' || error.message === 'COMMENT_RESULT_UNKNOWN')
          ? error.message
          : 'LIFECYCLE_WRITE_FAILED';
      result.failures.push({ code, stage, issueNumber });
      result.errors.push(
        `Failed to finalize ${kind} issue #${issueNumber}: ${code === 'COMMENT_RESULT_UNKNOWN' ? 'comment result unknown; reconcile before retrying' : code === 'COMMENT_LOOKUP_FAILED' ? 'comment lookup failed; no comment sent' : 'write failed'}`,
      );
      return false;
    }
  }
  if (opts.governanceIssue && !(await target('governance', opts.governanceIssue))) return result;
  if (opts.proposalIssue && !(await target('proposal', opts.proposalIssue))) return result;
  if (opts.reviewIssue && !(await target('review', opts.reviewIssue))) return result;
  for (const issueNumber of opts.phaseIssues ?? [])
    if (!(await target('phase', issueNumber))) return result;
  return result;
}

export async function transitionWorkflowIssue(
  issueNumber: number,
  addLabels: string[],
  removeLabels?: string[],
): Promise<{ success: boolean; error?: string }> {
  const client = await getClient();

  if (client.isDryRun) {
    console.log(
      `[DRY RUN] Would transition issue #${issueNumber}: +${addLabels.join(',')} ${removeLabels ? `-${removeLabels.join(',')}` : ''}`,
    );
    return { success: true };
  }

  try {
    // Add new labels
    await client.octokit.issues.addLabels({
      owner: client.owner,
      repo: client.repo,
      issue_number: issueNumber,
      labels: addLabels,
    });

    // Remove old labels if specified
    if (removeLabels) {
      for (const label of removeLabels) {
        try {
          await client.octokit.issues.removeLabel({
            owner: client.owner,
            repo: client.repo,
            issue_number: issueNumber,
            name: label,
          });
        } catch {
          // Label may not exist; ignore removal errors
        }
      }
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

export interface WorkflowLifecycleQueryResult {
  proposalIssue?: { number: number; state: string; url: string };
  reviewIssue?: { number: number; state: string; url: string };
  splitIssue?: { number: number; state: string; url: string };
  phaseIssues: Array<{
    number: number;
    phase: string;
    state: string;
    url: string;
    blockedBy?: number[];
    trackingMode?: 'native' | 'fallback';
  }>;
  runIssues: Array<{ number: number; runId: string; state: string; url: string; status: string }>;
  improvementIssues: Array<{ number: number; state: string; url: string }>;
  linkedPRs: Array<{ number: number; state: string; url: string }>;
  subIssueMode: 'native' | 'fallback' | 'mixed' | 'unknown';
  dependencyMode: 'native' | 'fallback' | 'mixed' | 'none';
  fallbackReasons: string[];
}

interface RawIssue {
  number: number;
  title: string;
  html_url: string;
  state: 'open' | 'closed';
  body: string | null;
  pull_request?: unknown;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function titleContainsWorkflowName(title: string, workflowName: string): boolean {
  return new RegExp(`\\b${escapeRegex(workflowName)}\\b`, 'i').test(title);
}

function extractPhaseFromTitle(title: string, workflowName: string): string | null {
  const match = title.match(
    new RegExp(`^\\s*\\[Workflow Phase\\]\\s+${escapeRegex(workflowName)}\\s*/\\s*(.+)$`, 'i'),
  );
  return match ? match[1].trim() : null;
}

function extractRunIdFromTitle(title: string, workflowName: string): string | null {
  const match = title.match(
    new RegExp(`^\\s*\\[Workflow Run\\]\\s+${escapeRegex(workflowName)}\\s*/\\s*(.+)$`, 'i'),
  );
  return match ? match[1].trim() : null;
}

function extractStatusFromBody(body: string | null): string {
  if (!body) return 'unknown';
  const match = body.match(/status:\s*(\w+)/i);
  return match?.[1]?.toLowerCase() ?? 'unknown';
}

function extractBlockedByFromBody(body: string | null): number[] | undefined {
  if (!body) return undefined;
  const match = body.match(/blocked_by:\s*#?(\d+(?:\s*,\s*#?\d+)*)/i);
  if (!match) return undefined;
  return match[1].split(',').map((s) => parseInt(s.trim().replace(/^#/, ''), 10));
}

function hasFallbackDependencyMarker(body: string | null): boolean {
  return body?.includes('workflow-dependency') ?? false;
}

function hasFallbackSubIssueMarker(body: string | null): boolean {
  return body?.includes('workflow-link-fallback') || body?.includes('## Phase Sub-Issues') || false;
}

function extractFallbackReasons(text: string | null | undefined): string[] {
  if (!text) return [];
  const reasons: string[] = [];
  for (const line of text.split('\n')) {
    const match = line.match(/^-\s+([^:]+):\s*(.+)$/);
    if (match) reasons.push(`${match[1]!.trim()}: ${match[2]!.trim()}`);
  }
  return reasons;
}

/** Fetch all issues with a given label, paginating up to maxPages. */
async function fetchAllIssuesByLabel(
  octokit: Octokit,
  owner: string,
  repo: string,
  label: string,
  maxPages = 5,
): Promise<RawIssue[]> {
  const all: RawIssue[] = [];
  let page = 1;
  while (page <= maxPages) {
    const { data } = await octokit.issues.listForRepo({
      owner,
      repo,
      labels: label,
      state: 'all',
      per_page: 100,
      page,
    });
    const issues = (data as unknown as Array<RawIssue & { pull_request?: unknown }>).filter(
      (item) => !item.pull_request,
    );
    all.push(...(issues as RawIssue[]));
    if (issues.length < 100) break;
    page++;
  }
  return all;
}

export async function fetchWorkflowLifecycleIssues(
  workflowName: string,
): Promise<WorkflowLifecycleQueryResult> {
  const client = await getClient();
  const { owner, repo, octokit } = client;

  const result: WorkflowLifecycleQueryResult = {
    phaseIssues: [],
    runIssues: [],
    improvementIssues: [],
    linkedPRs: [],
    subIssueMode: 'unknown',
    dependencyMode: 'none',
    fallbackReasons: [],
  };

  if (client.isDryRun) {
    console.log(`[DRY RUN] Would fetch workflow lifecycle issues for "${workflowName}"`);
    return result;
  }

  const labelQueries = [
    { label: 'workflow:proposal', key: 'proposal' as const },
    { label: 'workflow:review', key: 'review' as const },
    { label: 'workflow:split', key: 'split' as const },
    { label: 'workflow:phase', key: 'phase' as const },
    { label: 'workflow:run', key: 'run' as const },
    { label: 'workflow:improvement', key: 'improvement' as const },
  ];

  const rawResults = new Map<string, RawIssue[]>();

  // Fire all label queries + PR query concurrently
  await Promise.all([
    // 6 label queries (paginated up to 5 pages = 500 issues per label)
    ...labelQueries.map(({ label, key }) =>
      fetchAllIssuesByLabel(octokit, owner, repo, label)
        .then((issues) => {
          rawResults.set(
            key,
            issues.filter((item) => titleContainsWorkflowName(item.title, workflowName)),
          );
        })
        .catch((err: unknown) => {
          console.warn(`Failed to query issues with label ${label}: ${(err as Error).message}`);
          rawResults.set(key, []);
        }),
    ),
    // PR query
    octokit.pulls
      .list({ owner, repo, state: 'all', per_page: 100 })
      .then(({ data: prData }) => {
        const prs = prData as unknown as Array<{
          number: number;
          title: string;
          html_url: string;
          state: string;
        }>;
        for (const pr of prs) {
          if (titleContainsWorkflowName(pr.title, workflowName)) {
            result.linkedPRs.push({ number: pr.number, state: pr.state, url: pr.html_url });
          }
        }
      })
      .catch((err: unknown) => {
        console.warn(`Failed to query linked PRs: ${(err as Error).message}`);
      }),
  ]);

  // Proposal
  const proposals = rawResults.get('proposal') ?? [];
  if (proposals.length > 0) {
    const p = proposals[0]!;
    result.proposalIssue = { number: p.number, state: p.state, url: p.html_url };
  }

  // Review
  const reviews = rawResults.get('review') ?? [];
  if (reviews.length > 0) {
    const r = reviews[0]!;
    result.reviewIssue = { number: r.number, state: r.state, url: r.html_url };
  }

  // Split
  const splits = rawResults.get('split') ?? [];
  if (splits.length > 0) {
    const s = splits[0]!;
    result.splitIssue = { number: s.number, state: s.state, url: s.html_url };
  }

  // Phase issues
  const phases = rawResults.get('phase') ?? [];
  let hasFallbackDependency = false;
  let hasNativeDependency = false;
  for (const issue of phases) {
    const phase = extractPhaseFromTitle(issue.title, workflowName);
    if (!phase) continue;
    const blockedBy = extractBlockedByFromBody(issue.body);
    if (hasFallbackDependencyMarker(issue.body)) {
      hasFallbackDependency = true;
    }
    result.phaseIssues.push({
      number: issue.number,
      phase,
      state: issue.state,
      url: issue.html_url,
      blockedBy,
    });
  }

  await Promise.all(
    result.phaseIssues.map(async (phaseIssue) => {
      try {
        const { data: comments } = await octokit.issues.listComments({
          owner,
          repo,
          issue_number: phaseIssue.number,
          per_page: 100,
        });
        const commentBodies = comments.map((c) => c.body ?? '').join('\n');
        const fallbackBlockedBy = extractBlockedByFromBody(commentBodies);
        if (fallbackBlockedBy && fallbackBlockedBy.length > 0) {
          phaseIssue.blockedBy = Array.from(
            new Set([...(phaseIssue.blockedBy ?? []), ...fallbackBlockedBy]),
          );
          hasFallbackDependency = true;
        }
        if (commentBodies.includes('workflow-dependency')) {
          result.fallbackReasons.push(...extractFallbackReasons(commentBodies));
        }
      } catch {
        // Comment enrichment is best-effort.
      }

      try {
        const { data } = await (
          octokit as unknown as {
            request: (
              route: string,
              params: Record<string, unknown>,
            ) => Promise<{ data: Array<{ number?: number }> }>;
          }
        ).request('GET /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by', {
          owner,
          repo,
          issue_number: phaseIssue.number,
        });
        const nativeBlockedBy = data
          .map((item) => item.number)
          .filter((number): number is number => typeof number === 'number');
        if (nativeBlockedBy.length > 0) {
          phaseIssue.blockedBy = Array.from(
            new Set([...(phaseIssue.blockedBy ?? []), ...nativeBlockedBy]),
          );
          hasNativeDependency = true;
        }
      } catch {
        // Native dependency API may be unavailable; fallback comments remain authoritative.
      }
    }),
  );

  // Detect sub-issue mode after both split and phase issues are known
  if (result.splitIssue) {
    const splitBody = splits[0]!.body ?? '';
    let fallbackMarker = hasFallbackSubIssueMarker(splitBody);
    let nativeSubIssueNumbers = new Set<number>();

    try {
      const { data } = await (
        octokit as unknown as {
          request: (
            route: string,
            params: Record<string, unknown>,
          ) => Promise<{ data: Array<{ number?: number }> }>;
        }
      ).request('GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues', {
        owner,
        repo,
        issue_number: result.splitIssue.number,
      });
      nativeSubIssueNumbers = new Set(
        data
          .map((item) => item.number)
          .filter((number): number is number => typeof number === 'number'),
      );
    } catch {
      // Native sub-issues may be unavailable; fallback markers below still apply.
    }

    try {
      const { data: comments } = await octokit.issues.listComments({
        owner,
        repo,
        issue_number: result.splitIssue.number,
        per_page: 100,
      });
      const commentBodies = comments.map((c) => c.body ?? '').join('\n');
      if (commentBodies.includes('workflow-link-fallback')) {
        fallbackMarker = true;
        result.fallbackReasons.push(...extractFallbackReasons(commentBodies));
      }
    } catch {
      // Fallback reasons are best-effort audit metadata.
    }

    if (result.phaseIssues.length > 0) {
      for (const phaseIssue of result.phaseIssues) {
        const hasNativeRef =
          nativeSubIssueNumbers.has(phaseIssue.number) ||
          splitBody.includes(`#${phaseIssue.number}`);
        if (hasNativeRef) {
          phaseIssue.trackingMode = 'native';
        } else if (fallbackMarker) {
          phaseIssue.trackingMode = 'fallback';
        }
      }

      const nativeRefs = result.phaseIssues.filter((pi) => pi.trackingMode === 'native').length;

      if (nativeRefs === result.phaseIssues.length && !fallbackMarker) {
        result.subIssueMode = 'native';
      } else if (nativeRefs > 0 && fallbackMarker) {
        result.subIssueMode = 'mixed';
      } else if (fallbackMarker) {
        result.subIssueMode = 'fallback';
      }
      // else stays 'unknown'
    } else if (fallbackMarker) {
      result.subIssueMode = 'fallback';
    }
  }

  // Run issues
  const runs = rawResults.get('run') ?? [];
  for (const issue of runs) {
    const runId = extractRunIdFromTitle(issue.title, workflowName);
    if (!runId) continue;
    const status = extractStatusFromBody(issue.body);
    result.runIssues.push({
      number: issue.number,
      runId,
      state: issue.state,
      url: issue.html_url,
      status,
    });
  }

  // Improvement issues
  const improvements = rawResults.get('improvement') ?? [];
  for (const issue of improvements) {
    result.improvementIssues.push({
      number: issue.number,
      state: issue.state,
      url: issue.html_url,
    });
  }

  // Determine dependency mode
  if (hasNativeDependency && hasFallbackDependency) {
    result.dependencyMode = 'mixed';
  } else if (hasFallbackDependency) {
    result.dependencyMode = 'fallback';
  } else if (
    hasNativeDependency ||
    result.phaseIssues.some((p) => p.blockedBy && p.blockedBy.length > 0)
  ) {
    // If any phase has blocked_by but no fallback marker, it could be native
    result.dependencyMode = 'native';
  }

  // If split issue has fallback markers but we also see native patterns, mark as mixed
  if (result.splitIssue && result.subIssueMode === 'fallback') {
    // Keep fallback; no native detection implemented yet
  }

  return result;
}
