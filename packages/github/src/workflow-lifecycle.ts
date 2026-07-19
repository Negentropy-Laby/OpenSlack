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
}

export async function finalizeWorkflowPR(
  prNumber: number,
  opts: FinalizeWorkflowPROpts,
): Promise<{
  closedIssues: number[];
  commentedIssues: number[];
  updatedLabels: number[];
  errors: string[];
}> {
  const client = await getClient();
  const closedIssues: number[] = [];
  const commentedIssues: number[] = [];
  const updatedLabels: number[] = [];
  const errors: string[] = [];

  if (client.isDryRun) {
    console.log(`[DRY RUN] Would finalize workflow PR #${prNumber}`);
    return { closedIssues, commentedIssues, updatedLabels, errors };
  }

  if (opts.governanceIssue) {
    try {
      const lines = [
        '## Workflow Governance Completed',
        '',
        `Merged via PR #${prNumber}.`,
        opts.workflowHash ? `- **Evidence Hash**: ${opts.workflowHash}` : undefined,
        opts.trustDecision ? `- **Trust Decision**: ${opts.trustDecision}` : undefined,
        opts.trustReviewer ? `- **Reviewer**: @${opts.trustReviewer}` : undefined,
        opts.trustReviewCommitOid
          ? `- **Reviewed Commit**: ${opts.trustReviewCommitOid}`
          : undefined,
      ].filter((line): line is string => line !== undefined);
      await client.octokit.issues.createComment({
        owner: client.owner,
        repo: client.repo,
        issue_number: opts.governanceIssue,
        body: lines.join('\n'),
      });
      const labels = ['lifecycle:accepted', `workflow:${opts.trustDecision ?? 'untrusted'}`];
      await client.octokit.issues.addLabels({
        owner: client.owner,
        repo: client.repo,
        issue_number: opts.governanceIssue,
        labels,
      });
      await client.octokit.issues.update({
        owner: client.owner,
        repo: client.repo,
        issue_number: opts.governanceIssue,
        state: 'closed',
        state_reason: 'completed',
      });
      commentedIssues.push(opts.governanceIssue);
      updatedLabels.push(opts.governanceIssue);
      closedIssues.push(opts.governanceIssue);
    } catch (err) {
      errors.push(
        `Failed to finalize governance issue #${opts.governanceIssue}: ${(err as Error).message}`,
      );
    }
  }

  // Close proposal issue
  if (opts.proposalIssue) {
    try {
      await client.octokit.issues.update({
        owner: client.owner,
        repo: client.repo,
        issue_number: opts.proposalIssue,
        state: 'closed',
        state_reason: 'completed',
      });
      await client.octokit.issues.addLabels({
        owner: client.owner,
        repo: client.repo,
        issue_number: opts.proposalIssue,
        labels: ['result:completed', 'lifecycle:accepted'],
      });
      closedIssues.push(opts.proposalIssue);
      updatedLabels.push(opts.proposalIssue);
    } catch (err) {
      errors.push(
        `Failed to close proposal issue #${opts.proposalIssue}: ${(err as Error).message}`,
      );
    }
  }

  // Comment on review issue with merge info
  if (opts.reviewIssue) {
    try {
      const lines: string[] = [
        '## Workflow Merged',
        '',
        `This workflow was merged via PR #${prNumber}.`,
      ];
      if (opts.workflowHash) {
        lines.push(`- **Hash**: ${opts.workflowHash}`);
      }
      if (opts.trustDecision) {
        lines.push(`- **Trust Decision**: ${opts.trustDecision}`);
      }

      await client.octokit.issues.createComment({
        owner: client.owner,
        repo: client.repo,
        issue_number: opts.reviewIssue,
        body: lines.join('\n'),
      });

      // Update review issue labels based on trust decision
      const labels = ['lifecycle:accepted'];
      if (opts.trustDecision === 'trusted') labels.push('workflow:trusted');
      else if (opts.trustDecision === 'untrusted') labels.push('workflow:untrusted');

      await client.octokit.issues.addLabels({
        owner: client.owner,
        repo: client.repo,
        issue_number: opts.reviewIssue,
        labels,
      });
      commentedIssues.push(opts.reviewIssue);
      updatedLabels.push(opts.reviewIssue);
    } catch (err) {
      errors.push(`Failed to update review issue #${opts.reviewIssue}: ${(err as Error).message}`);
    }
  }

  // Close phase issues
  if (opts.phaseIssues && opts.phaseIssues.length > 0) {
    for (const issueNum of opts.phaseIssues) {
      try {
        await client.octokit.issues.update({
          owner: client.owner,
          repo: client.repo,
          issue_number: issueNum,
          state: 'closed',
          state_reason: 'completed',
        });
        await client.octokit.issues.addLabels({
          owner: client.owner,
          repo: client.repo,
          issue_number: issueNum,
          labels: ['result:completed', 'lifecycle:completed'],
        });
        closedIssues.push(issueNum);
        updatedLabels.push(issueNum);
      } catch (err) {
        errors.push(`Failed to close phase issue #${issueNum}: ${(err as Error).message}`);
      }
    }
  }

  return { closedIssues, commentedIssues, updatedLabels, errors };
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
