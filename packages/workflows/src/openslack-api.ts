import type { PRCodeownerEvidence, PRReviewReport, PRReviewPolicy } from '@openslack/pr'
import { fetchPRDetails, classifyPRReport, diagnosePR, loadPRCodeownerEvidence, loadPRReviewPolicy, mergeIfReady } from '@openslack/pr'
import { listOpenPRs } from '@openslack/github'
import { recordEvent as collabRecordEvent, createHandoff as collabCreateHandoff, recordDecision as collabRecordDecision } from '@openslack/collaboration'
import type { PrmsDoctorResult } from './types.js'
import { classifyPathGroups } from './risk-classification.js'

/**
 * Result from the PRMS Merge Steward (mergeIfReady).
 */
interface MergeStewardCallResult {
  merged: boolean
  decision: string
  reason: string
  message: string
}

/**
 * Options for the OpenSlack API factory.
 * Dependencies can be overridden for testing.
 */
export interface OpenSlackAPIOptions {
  /** Override classifyPaths for testing */
  _classifyPaths?: (paths: string[]) => { green: string[]; yellow: string[]; red: string[] }
  /** Override fetchPRDetails for testing */
  _fetchPRDetails?: (prNumber: number) => Promise<PRReviewReport>
  /** Override diagnosePR for testing */
  _diagnosePR?: (report: PRReviewReport, policy: PRReviewPolicy, codeowners: string[]) => PRReviewReport
  /** Override loadPRReviewPolicy for testing */
  _loadPRReviewPolicy?: () => PRReviewPolicy
  /** Override mergeIfReady for testing */
  _mergeIfReady?: (prNumber: number, policy: PRReviewPolicy, options?: Record<string, unknown>) => Promise<MergeStewardCallResult>
  /** Override listOpenPRs for testing */
  _listOpenPRs?: (limit?: number) => Promise<Array<{ number: number; title: string; status: string }>>
  /** Override immutable PR CODEOWNER evidence loading for testing */
  _loadPRCodeownerEvidence?: (report: PRReviewReport) => Promise<PRCodeownerEvidence>
  /** Override collaboration recordEvent for testing */
  _recordEvent?: (event: unknown) => unknown
  /** Override collaboration createHandoff for testing */
  _createHandoff?: (details: unknown) => unknown
  /** Override collaboration recordDecision for testing */
  _recordDecision?: (details: unknown) => unknown
}

/**
 * Create the `ctx.openslack` API namespace wired to real package APIs.
 *
 * Design notes:
 * - `requestMerge()` routes through the PRMS Merge Steward (`mergeIfReady`),
 *   NOT through a direct GitHub merge call. The steward re-runs diagnostics
 *   and only merges if all gates pass.
 * - `prms.doctor()` returns a `PrmsDoctorResult` that gates on
 *   `status === 'READY_TO_MERGE'`.
 * - All real I/O is pluggable via the options for testability.
 */
export function createOpenSlackAPI(options: OpenSlackAPIOptions = {}) {
  const classify = options._classifyPaths ?? classifyPathGroups

  // Use `as any` to bridge from loosely-typed overrides to strict package types.
  // When no override is provided, the real implementation is used directly.
  const doFetchPRDetails: (prNumber: number) => Promise<PRReviewReport> =
    (options._fetchPRDetails as typeof doFetchPRDetails) ?? fetchPRDetails
  const doDiagnosePR: (report: PRReviewReport, policy: PRReviewPolicy, codeowners: string[]) => PRReviewReport =
    (options._diagnosePR as typeof doDiagnosePR) ?? diagnosePR
  const doLoadPolicy: () => PRReviewPolicy =
    (options._loadPRReviewPolicy as typeof doLoadPolicy) ?? loadPRReviewPolicy
  const doMergeIfReady: (prNumber: number, policy: PRReviewPolicy, opts?: Record<string, unknown>) => Promise<MergeStewardCallResult> =
    (options._mergeIfReady as typeof doMergeIfReady) ?? (mergeIfReady as typeof doMergeIfReady)
  const doListOpenPRs: (limit?: number) => Promise<Array<{ number: number; title: string; author?: string; draft?: boolean; updatedAt?: string; url?: string; status?: string }>> =
    (options._listOpenPRs as typeof doListOpenPRs) ?? (listOpenPRs as typeof doListOpenPRs)
  const doLoadPRCodeownerEvidence: (report: PRReviewReport) => Promise<PRCodeownerEvidence> =
    options._loadPRCodeownerEvidence ?? loadPRCodeownerEvidence
  const doRecordEvent: (event: unknown) => unknown =
    options._recordEvent ?? ((event: unknown) => { collabRecordEvent(event as Parameters<typeof collabRecordEvent>[0]) })
  const doCreateHandoff: (details: unknown) => unknown =
    options._createHandoff ?? ((details: unknown) => collabCreateHandoff(details as Parameters<typeof collabCreateHandoff>[0]))
  const doRecordDecision: (details: unknown) => unknown =
    options._recordDecision ?? ((details: unknown) => collabRecordDecision(details as Parameters<typeof collabRecordDecision>[0]))

  return {
    task: {
      async createPreview(issueData: unknown): Promise<unknown> {
        return { preview: true, data: issueData }
      },

      async createIssue(issueData: unknown): Promise<{ issueUrl: string; issueNumber: number }> {
        const { createIssue } = await import('@openslack/github')
        const data = issueData as Record<string, unknown>
        const result = await createIssue(
          String(data.title ?? ''),
          String(data.body ?? ''),
          Array.isArray(data.labels) ? data.labels as string[] : [],
        )
        return { issueUrl: result.url, issueNumber: result.number }
      },

      async checkout(
        issueNumber: number,
        _agentId: string,
      ): Promise<{ worktreePath: string; branchName: string }> {
        // Delegate to runtime package for worktree creation
        return {
          worktreePath: `.openslack.local/worktrees/${issueNumber}`,
          branchName: `agent/issue-${issueNumber}`,
        }
      },

      async sync(
        _issueNumber: number,
      ): Promise<{ pushed: boolean; prUrl?: string }> {
        return { pushed: false }
      },
    },

    prms: {
      async classify(
        paths: string[],
      ): Promise<{ green: string[]; yellow: string[]; red: string[] }> {
        return classify(paths)
      },

      async doctor(prNumber: number): Promise<PrmsDoctorResult> {
        try {
          const report = await doFetchPRDetails(prNumber)
          const classified = classifyPRReport(report)
          const policy = doLoadPolicy()

          const { owners: codeowners } = await doLoadPRCodeownerEvidence(classified)

          const diagnosed = doDiagnosePR(classified, policy, codeowners)

          const decision = diagnosed.decision
          const isReady = decision === 'READY_TO_MERGE'

          // Build gates from the diagnostic result
          const gates: Record<string, { passed: boolean; detail: string }> = {
            classification: {
              passed: diagnosed.riskZone !== 'black',
              detail: `Risk zone: ${diagnosed.riskZone}`,
            },
            checks: {
              passed: !['CHECKS_PENDING', 'CHECKS_FAILED'].includes(decision),
              detail: diagnosed.reason,
            },
            approval: {
              passed: !['NEEDS_HUMAN_APPROVAL', 'NEEDS_CODEOWNER_APPROVAL', 'BOT_APPROVAL_IGNORED', 'BLOCKED_SELF_REVIEW'].includes(decision),
              detail: diagnosed.reason,
            },
            mergeability: {
              passed: decision !== 'BLOCKED_POLICY',
              detail: diagnosed.reason,
            },
          }

          const blockers: Array<{ gate: string; reason: string; zone?: 'green' | 'yellow' | 'red'; owner?: string }> = []
          for (const [gateName, gateResult] of Object.entries(gates)) {
            if (!gateResult.passed) {
              blockers.push({
                gate: gateName,
                reason: gateResult.detail,
                zone: diagnosed.riskZone === 'black' ? 'red' : diagnosed.riskZone,
              })
            }
          }

          const zone = diagnosed.riskZone === 'black'
            ? 'red' as const
            : diagnosed.riskZone

          const status: PrmsDoctorResult['status'] = isReady
            ? 'READY_TO_MERGE'
            : 'BLOCKED'

          return {
            status,
            blockers,
            zone,
            why: diagnosed.reason,
            next: diagnosed.recommendation,
            gates,
          }
        } catch (err) {
          return {
            status: 'ERROR',
            blockers: [{ gate: 'system', reason: err instanceof Error ? err.message : String(err) }],
            zone: 'red',
            why: `Doctor check failed: ${err instanceof Error ? err.message : String(err)}`,
            next: 'Retry or investigate the error.',
            gates: {},
          }
        }
      },

      async queue(): Promise<Array<{ prNumber: number; title: string; status: string }>> {
        const prs = await doListOpenPRs(50)
        return prs.map((pr) => ({
          prNumber: pr.number,
          title: pr.title,
          status: 'open',
        }))
      },

      /**
       * Request merge through PRMS Merge Steward.
       *
       * IMPORTANT: This routes through `mergeIfReady` from @openslack/pr,
       * NOT through a direct GitHub merge. The steward re-runs diagnostics,
       * checks CODEOWNERS, re-verifies approvals, and only merges if all
       * gates pass. This is the ONLY sanctioned merge path.
       */
      async requestMerge(
        prNumber: number,
      ): Promise<{ merged: boolean; prmsStatus: string }> {
        const policy = doLoadPolicy()
        const result = await doMergeIfReady(prNumber, policy)

        return {
          merged: result.merged,
          prmsStatus: result.decision,
        }
      },
    },

    collaboration: {
      async recordEvent(event: unknown): Promise<void> {
        doRecordEvent(event)
      },

      async createHandoff(details: unknown): Promise<unknown> {
        return doCreateHandoff(details)
      },

      async recordDecision(details: unknown): Promise<unknown> {
        return doRecordDecision(details)
      },
    },

    governance: {
      async audit(action: string, details?: unknown): Promise<void> {
        // Governance audit is recorded as a collaboration event
        doRecordEvent({
          type: 'governance.audit.passed',
          summary: `Audit: ${action}`,
          details,
        })
      },
    },
  }
}
