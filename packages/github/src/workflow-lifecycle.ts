import { createHash } from 'node:crypto';
import { getClient, type GitHubClient, type GitHubClientOptions } from './client.js';
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
  | 'COMMENT_LOOKUP_LIMIT_EXCEEDED'
  | 'COMMENT_LOOKUP_DEADLINE_EXCEEDED'
  | 'COMMENT_BINDING_UNCONFIRMED'
  | 'COMMENT_RESULT_UNKNOWN'
  | 'LIFECYCLE_CANCELLED'
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

type FinalizationKind = 'governance' | 'proposal' | 'review' | 'phase';
type CommentFailureCode = Extract<FinalizeWorkflowFailureCode, `COMMENT_${string}`>;
interface FinalizationCommentBinding {
  repository: string;
  pr: number;
  issue: number;
  kind: 'governance' | 'review';
  head: string;
  base: string;
  evidenceHash: string | null;
}

const commentFailures = new WeakMap<object, CommentFailureCode>();
const FINALIZATION_STEPS = {
  governance: ['comment', 'labels', 'close'],
  review: ['comment', 'labels'],
  proposal: ['close', 'labels'],
  phase: ['close', 'labels'],
} as const;

function commentFailure(code: CommentFailureCode): Error {
  const error = new Error(code);
  commentFailures.set(error, code);
  return error;
}

function commentFailureCode(error: unknown): CommentFailureCode | undefined {
  return error !== null && typeof error === 'object' ? commentFailures.get(error) : undefined;
}

function neutralReviewer(
  body: string,
  kind: FinalizationCommentBinding['kind'],
): string | undefined {
  if (kind !== 'governance') return body;
  const lines = body.split('\n');
  if (lines.length !== 7 || !/^- \*\*Reviewer\*\*: @[a-z\d][a-z\d-]{0,38}$/iu.test(lines[5]!))
    return undefined;
  return [...lines.slice(0, 5), '- **Reviewer**: @<recorded>', lines[6]!].join('\n');
}

/** A marker is an identity hint, never a substitute for its complete canonical evidence body. */
function matchesFinalizationComment(
  body: string,
  plainBody: string,
  binding: FinalizationCommentBinding,
  options: FinalizeWorkflowPROpts,
): 'match' | 'unrelated' | 'unconfirmed' {
  const start = body.lastIndexOf('\n\n<!-- openslack-workflow-finalize:');
  const plain = start < 0 ? body : body.slice(0, start);
  const neutral = neutralReviewer(plain, binding.kind);
  const expected = neutralReviewer(plainBody, binding.kind);
  const matchesBody = expected !== undefined && neutral === expected;
  const title =
    binding.kind === 'governance' ? '## Workflow Governance Completed' : '## Workflow Merged';
  const prLine =
    binding.kind === 'governance'
      ? `Merged via PR #${binding.pr}.`
      : `This workflow was merged via PR #${binding.pr}.`;
  const relevant = plain.startsWith(`${title}\n\n${prLine}`);
  if (start < 0) return matchesBody ? 'match' : relevant ? 'unconfirmed' : 'unrelated';
  const marker = body.slice(start + 2);
  const modern = marker.match(/^<!-- openslack-workflow-finalize:v2\n([^\n]*)\n-->$/u);
  if (modern) {
    let record: unknown;
    try {
      record = JSON.parse(modern[1]!);
    } catch {
      return relevant ? 'unconfirmed' : 'unrelated';
    }
    if (!record || typeof record !== 'object' || Array.isArray(record)) return 'unconfirmed';
    const entries = Object.entries(binding);
    const value = record as Record<string, unknown>;
    if (value.pr !== binding.pr && !relevant) return 'unrelated';
    return matchesBody &&
      Object.keys(value).length === entries.length &&
      entries.every(([key, expectedValue]) => value[key] === expectedValue)
      ? 'match'
      : 'unconfirmed';
  }
  const legacy = marker.match(/^<!-- openslack-workflow-finalize:([a-f\d]{64}) -->$/u);
  if (!relevant) return 'unrelated';
  // Old review callers could omit either expected SHA. Only their actual live-or-null
  // historical combinations are compatible; arbitrary foreign digests are not.
  const heads =
    binding.kind === 'review' ? [binding.head, null] : [options.expectedHeadSha ?? null];
  const bases =
    binding.kind === 'review' ? [binding.base, null] : [options.expectedBaseSha ?? null];
  const matchesLegacy =
    legacy &&
    heads.some((head) =>
      bases.some(
        (base) =>
          createHash('sha256')
            .update(JSON.stringify([binding.pr, binding.issue, head, base, plain]))
            .digest('hex') === legacy[1],
      ),
    );
  return matchesBody && matchesLegacy ? 'match' : 'unconfirmed';
}

function mergedCommentLowerBound(mergedAt: unknown): string | undefined {
  if (
    typeof mergedAt !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/u.test(mergedAt)
  )
    return undefined;
  const time = Date.parse(mergedAt);
  return Number.isFinite(time) && time >= 1_000 ? new Date(time - 1_000).toISOString() : undefined;
}

/** The local deadline also settles a stalled transport; aborting does not prove request execution. */
function readFinalizationCommentPage(
  client: GitHubClient,
  issue: number,
  page: number,
  since: string | undefined,
  signal: AbortSignal,
): Promise<ReadonlyArray<{ body?: string | null }>> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (effect: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', aborted);
      effect();
    };
    const aborted = () => finish(() => reject(commentFailure('COMMENT_LOOKUP_DEADLINE_EXCEEDED')));
    if (signal.aborted) {
      aborted();
      return;
    }
    signal.addEventListener('abort', aborted, { once: true });
    try {
      void client.octokit.issues
        .listComments({
          owner: client.owner,
          repo: client.repo,
          issue_number: issue,
          per_page: 100,
          page,
          ...(since ? { since } : {}),
          request: { signal },
        })
        .then(
          (response) => finish(() => resolve(response.data)),
          (error) => finish(() => reject(error)),
        );
    } catch (error) {
      finish(() => reject(error));
    }
  });
}

async function findFinalizationComment(
  client: GitHubClient,
  binding: FinalizationCommentBinding,
  plainBody: string,
  options: FinalizeWorkflowPROpts,
  since: string | undefined,
  parent?: AbortSignal,
): Promise<boolean> {
  const deadline = performance.now() + 30_000;
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, 30_000);
  timer.unref();
  parent?.addEventListener('abort', abort, { once: true });
  let unconfirmed = false;
  try {
    for (let page = 1; page <= 100; page++) {
      if (parent?.aborted || controller.signal.aborted || performance.now() >= deadline)
        throw commentFailure('COMMENT_LOOKUP_DEADLINE_EXCEEDED');
      const comments = await readFinalizationCommentPage(
        client,
        binding.issue,
        page,
        since,
        controller.signal,
      );
      if (parent?.aborted || controller.signal.aborted || performance.now() >= deadline)
        throw commentFailure('COMMENT_LOOKUP_DEADLINE_EXCEEDED');
      const matches = comments.map((comment) =>
        matchesFinalizationComment(comment.body ?? '', plainBody, binding, options),
      );
      // Synchronous classification can exhaust the budget without yielding to the timer.
      if (parent?.aborted || controller.signal.aborted || performance.now() >= deadline)
        throw commentFailure('COMMENT_LOOKUP_DEADLINE_EXCEEDED');
      if (matches.includes('match')) return true;
      unconfirmed ||= matches.includes('unconfirmed');
      if (comments.length < 100) {
        if (unconfirmed) throw commentFailure('COMMENT_BINDING_UNCONFIRMED');
        return false;
      }
    }
    throw commentFailure('COMMENT_LOOKUP_LIMIT_EXCEEDED');
  } catch (error) {
    throw commentFailureCode(error) ? error : commentFailure('COMMENT_LOOKUP_FAILED');
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener('abort', abort);
  }
}

function finalizationCommentLines(
  kind: 'governance' | 'review',
  pr: number,
  opts: FinalizeWorkflowPROpts,
): string[] {
  return kind === 'governance'
    ? [
        '## Workflow Governance Completed',
        '',
        `Merged via PR #${pr}.`,
        `- **Evidence Hash**: ${opts.workflowHash}`,
        `- **Trust Decision**: ${opts.trustDecision}`,
        `- **Reviewer**: @${opts.trustReviewer}`,
        `- **Reviewed Commit**: ${opts.trustReviewCommitOid}`,
      ]
    : [
        '## Workflow Merged',
        '',
        `This workflow was merged via PR #${pr}.`,
        ...(opts.workflowHash ? [`- **Hash**: ${opts.workflowHash}`] : []),
        ...(opts.trustDecision ? [`- **Trust Decision**: ${opts.trustDecision}`] : []),
      ];
}

function finalizationLabels(kind: FinalizationKind, opts: FinalizeWorkflowPROpts): string[] {
  if (kind === 'governance') return ['lifecycle:accepted', `workflow:${opts.trustDecision}`];
  if (kind === 'review')
    return [
      'lifecycle:accepted',
      ...(opts.trustDecision === 'trusted' || opts.trustDecision === 'untrusted'
        ? [`workflow:${opts.trustDecision}`]
        : []),
    ];
  return ['result:completed', kind === 'phase' ? 'lifecycle:completed' : 'lifecycle:accepted'];
}

function finalizationFailureMessage(code: FinalizeWorkflowFailureCode): string {
  switch (code) {
    case 'LIFECYCLE_CANCELLED':
      return 'cancelled; confirmed effects retained';
    case 'COMMENT_RESULT_UNKNOWN':
      return 'comment result unknown; reconcile before retrying';
    case 'COMMENT_BINDING_UNCONFIRMED':
      return 'existing comment binding unconfirmed; reconcile before retrying';
    case 'COMMENT_LOOKUP_LIMIT_EXCEEDED':
      return 'comment lookup capacity exceeded; no comment sent';
    case 'COMMENT_LOOKUP_DEADLINE_EXCEEDED':
      return 'comment lookup deadline exceeded or cancelled; no comment sent';
    case 'COMMENT_LOOKUP_FAILED':
      return 'comment lookup failed; no comment sent';
    default:
      return 'write failed';
  }
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
  clientOptions?: GitHubClientOptions,
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
  if (clientOptions?.signal?.aborted)
    return refuse(
      'LIFECYCLE_CANCELLED',
      'Cannot finalize: the caller cancelled before live verification.',
    );
  let client: Awaited<ReturnType<typeof getClient>>;
  try {
    client = await getClient(clientOptions);
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
  let pr: Awaited<ReturnType<Octokit['pulls']['get']>>['data'];
  try {
    pr = (
      await client.octokit.pulls.get({
        owner: client.owner,
        repo: client.repo,
        pull_number: prNumber,
        ...(clientOptions?.signal ? { request: { signal: clientOptions.signal } } : {}),
      })
    ).data;
  } catch {
    return refuse(
      'PR_QUERY_FAILED',
      'Cannot finalize: live PR query failed; restore GitHub access and retry the read-only gate.',
    );
  }
  if (clientOptions?.signal?.aborted)
    return refuse(
      'LIFECYCLE_CANCELLED',
      'Cannot finalize: the caller cancelled during live verification.',
    );
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

  async function commentOnce(kind: 'governance' | 'review', issueNumber: number): Promise<void> {
    const binding: FinalizationCommentBinding = {
      repository: `${client.owner}/${client.repo}`,
      pr: prNumber,
      issue: issueNumber,
      kind,
      head: pr.head.sha,
      base: pr.base.sha,
      evidenceHash: opts.workflowHash ?? null,
    };
    const plainBody = finalizationCommentLines(kind, prNumber, opts).join('\n');
    const exists = await findFinalizationComment(
      client,
      binding,
      plainBody,
      opts,
      mergedCommentLowerBound(pr.merged_at),
      clientOptions?.signal,
    );
    // Cancellation can arrive after lookup resolution and before this continuation.
    if (clientOptions?.signal?.aborted) throw commentFailure('COMMENT_LOOKUP_DEADLINE_EXCEEDED');
    if (!exists) {
      // POST is attempted only once. Its failure proves neither delivery nor absence.
      try {
        await client.octokit.issues.createComment({
          owner: client.owner,
          repo: client.repo,
          issue_number: issueNumber,
          body: `${plainBody}\n\n<!-- openslack-workflow-finalize:v2\n${JSON.stringify(binding)}\n-->`,
          ...(clientOptions?.signal ? { request: { signal: clientOptions.signal } } : {}),
        });
      } catch {
        throw commentFailure('COMMENT_RESULT_UNKNOWN');
      }
    }
    result.commentedIssues.push(issueNumber);
  }

  async function closeIssue(issueNumber: number): Promise<void> {
    await client.octokit.issues.update({
      owner: client.owner,
      repo: client.repo,
      issue_number: issueNumber,
      state: 'closed',
      state_reason: 'completed',
      ...(clientOptions?.signal ? { request: { signal: clientOptions.signal } } : {}),
    });
    result.closedIssues.push(issueNumber);
  }

  async function target(kind: FinalizationKind, issueNumber: number): Promise<boolean> {
    for (const stage of FINALIZATION_STEPS[kind]) {
      if (clientOptions?.signal?.aborted) {
        result.failures.push({ code: 'LIFECYCLE_CANCELLED', stage, issueNumber });
        result.errors.push(
          `Failed to finalize ${kind} issue #${issueNumber}: ${finalizationFailureMessage('LIFECYCLE_CANCELLED')}`,
        );
        return false;
      }
      try {
        if (stage === 'comment' && (kind === 'governance' || kind === 'review'))
          await commentOnce(kind, issueNumber);
        else if (stage === 'close') await closeIssue(issueNumber);
        else {
          await client.octokit.issues.addLabels({
            owner: client.owner,
            repo: client.repo,
            issue_number: issueNumber,
            labels: finalizationLabels(kind, opts),
            ...(clientOptions?.signal ? { request: { signal: clientOptions.signal } } : {}),
          });
          result.updatedLabels.push(issueNumber);
        }
      } catch (error) {
        const code = commentFailureCode(error) ?? 'LIFECYCLE_WRITE_FAILED';
        result.failures.push({ code, stage, issueNumber });
        result.errors.push(
          `Failed to finalize ${kind} issue #${issueNumber}: ${finalizationFailureMessage(code)}`,
        );
        return false;
      }
    }
    return true;
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
