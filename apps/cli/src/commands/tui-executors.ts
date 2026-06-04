import type { ConversationActionCard, TuiActionResult, TuiAskResult } from '@openslack/tui'
import type { WorkflowRunControlAction, WorkflowRunControlTarget } from '@openslack/workflows'
import { join } from 'node:path'
import {
  dispatchConversationAgentMessage,
  resolveWorkbenchThread,
} from './conversation-dispatch.js'

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ApprovalExecutionParams {
  id: string
  category: 'plan' | 'merge-request' | 'workflow-effect' | 'profile-sync' | 'github-review'
  title: string
  planId?: string
  prNumber?: number
  workflowName?: string
  runId?: string
}

export interface ProfileActionHandlers {
  checkProfileSync: () => Promise<TuiActionResult>
  previewProfileSync: () => Promise<TuiActionResult>
  dryRunProfileSync: () => Promise<TuiActionResult>
  createProfileSyncPR: () => Promise<TuiActionResult>
  openProfileSyncPR: (prUrl: string) => Promise<TuiActionResult>
  createProfileSyncFailureIssue: (error: string) => Promise<TuiActionResult>
}

export interface TuiActionHandlers {
  executeApproval: (params: ApprovalExecutionParams, isApprove: boolean) => Promise<TuiActionResult>
  executeTrustChange: (workflowName: string, fromLevel: string, toLevel: string) => Promise<TuiActionResult>
  executeWorkflowRun: (workflowName: string, mode: 'preview' | 'dry-run' | 'run') => Promise<TuiActionResult>
  startWorkflowFromPrompt?: (prompt: string) => Promise<TuiActionResult>
  startWorkflowFromPattern?: (patternId: string) => Promise<TuiActionResult>
  controlWorkflowRun?: (runId: string, action: WorkflowRunControlAction, target?: WorkflowRunControlTarget) => Promise<TuiActionResult>
  saveWorkflowRunScript?: (runId: string, target?: 'project' | 'user' | 'claude-project') => Promise<TuiActionResult>
  publishWorkflowAsIssue?: (workflowName: string) => Promise<TuiActionResult>
  requestWorkflowReview?: (workflowName: string) => Promise<TuiActionResult>
  splitWorkflowIntoIssues?: (workflowName: string, parentIssue?: number) => Promise<TuiActionResult>
  finalizeWorkflowPr?: (workflowName: string, prNumber: number) => Promise<TuiActionResult>
  submitWorkbenchAsk?: (input: string, threadId?: string) => Promise<TuiAskResult>
  recordWorkbenchAction?: (threadId: string, card: ConversationActionCard, message: string) => Promise<TuiActionResult>
  profileSync?: ProfileActionHandlers
}

// ── executeApproval ────────────────────────────────────────────────────────────

export async function executeApproval(
  params: ApprovalExecutionParams,
  isApprove: boolean,
  root: string,
  actorId: string,
): Promise<TuiActionResult> {
  const { category, title, planId, prNumber, workflowName } = params

  try {
    switch (category) {
      case 'plan': {
        if (!planId) {
          return {
            success: false,
            message: 'Plan ID not available. Use CLI: openslack collaboration decision record',
          }
        }

        const { updatePendingPlanState } = await import('@openslack/operator')
        const { recordDecision } = await import('@openslack/collaboration')

        const newState = isApprove ? 'approved' : 'cancelled'
        const updated = updatePendingPlanState(planId, newState, root)
        if (!updated) {
          return { success: false, message: 'Plan not found or expired' }
        }

        recordDecision({
          topic: title,
          decision: isApprove ? 'approved' : 'rejected',
          rationale: `${isApprove ? 'Approved' : 'Rejected'} via TUI for plan ${planId}`,
          decidedBy: actorId,
          tags: ['plan-approval', 'tui'],
        })

        return {
          success: true,
          message: `Plan ${planId} ${isApprove ? 'approved' : 'rejected'}`,
        }
      }

      case 'merge-request': {
        if (!prNumber) {
          return {
            success: false,
            message: 'PR number not available. Use CLI: openslack pr merge <pr-number>',
          }
        }

        const { recordDecision } = await import('@openslack/collaboration')

        if (isApprove) {
          const { mergeIfReady } = await import('@openslack/pr')
          const result = await mergeIfReady(prNumber, {
            no_auto_approval: true,
            no_self_review: true,
            red_zone_human_required: true,
            black_zone_never_merge: true,
          })

          recordDecision({
            topic: title,
            decision: result.merged ? 'approved' : 'blocked',
            rationale: result.reason,
            decidedBy: actorId,
            tags: ['merge-request', 'tui', `pr-${prNumber}`],
          })

          if (!result.merged) {
            return {
              success: false,
              message: `Merge blocked: ${result.reason}`,
              data: { decision: result.decision, reason: result.reason },
            }
          }

          return {
            success: true,
            message: result.message,
            data: { sha: result.sha },
          }
        }

        recordDecision({
          topic: title,
          decision: 'cancelled',
          rationale: `Merge request rejected via TUI for PR #${prNumber}`,
          decidedBy: actorId,
          tags: ['merge-request', 'tui', `pr-${prNumber}`],
        })

        return {
          success: true,
          message: `Merge request for PR #${prNumber} rejected`,
        }
      }

      case 'workflow-effect': {
        const { recordDecision } = await import('@openslack/collaboration')

        // If a runId is present, this is a paused workflow run awaiting approval
        if (params.runId) {
          const { RunStore, executeResume, findWorkflow, loadWorkflow } = await import('@openslack/workflows')
          const store = new RunStore({ baseDir: join(root, '.openslack.local', 'workflows') })

          const pending = await store.loadPendingApprovals(params.runId)
          const unresolved = pending.filter(p => p.status === 'pending')

          if (isApprove) {
            // Approve all pending effects for this run
            for (const approval of unresolved) {
              await store.resolvePendingApproval(params.runId, approval.id, 'approved')
            }

            // Resume the workflow
            const meta = await store.loadMeta(params.runId)
            if (meta) {
              const found = await findWorkflow(meta.workflowName, root)
              if (found) {
                const mod = await loadWorkflow(found.path)
                await executeResume(mod, {
                  runId: params.runId,
                  manifest: mod.meta,
                  args: meta.args,
                  budget: meta.budget ? { tokens: meta.budget.tokens, costUsd: meta.budget.costUsd ?? 0 } : undefined,
                  confirmationPolicy: {
                    mode: 'preapproved-manifest',
                    actorId,
                    runId: params.runId,
                    onUnexpectedEffect: 'pause',
                  },
                  rootDir: root,
                })
              }
            }

            recordDecision({
              topic: title,
              decision: 'approved',
              rationale: `Workflow effect approved via TUI, run ${params.runId} resumed`,
              decidedBy: actorId,
              tags: ['workflow-effect', 'tui', `run-${params.runId}`],
            })

            return { success: true, message: `Workflow resumed`, data: { runId: params.runId } }
          }

          // Reject: cancel the run
          for (const approval of unresolved) {
            await store.resolvePendingApproval(params.runId, approval.id, 'rejected')
          }
          await store.transitionStatus(params.runId, 'cancelled')

          recordDecision({
            topic: title,
            decision: 'cancelled',
            rationale: `Workflow effect rejected, run ${params.runId} cancelled`,
            decidedBy: actorId,
            tags: ['workflow-effect', 'tui', `run-${params.runId}`],
          })

          return { success: true, message: `Workflow run cancelled`, data: { runId: params.runId } }
        }

        // Fallback: no runId, just record decision (legacy handoff behavior)
        recordDecision({
          topic: title,
          decision: isApprove ? 'confirmed' : 'cancelled',
          rationale: `Workflow effect ${isApprove ? 'confirmed' : 'cancelled'} via TUI${workflowName ? ` for ${workflowName}` : ''}`,
          decidedBy: actorId,
          tags: ['workflow-effect', 'tui'],
        })

        return {
          success: true,
          message: `Workflow effect ${isApprove ? 'confirmed' : 'cancelled'}`,
        }
      }

      case 'github-review': {
        return {
          success: false,
          message: 'GitHub PR approval requires human GitHub identity. Use: gh pr review <PR> --approve',
          data: { cliCommand: 'gh pr review <PR> --approve' },
        }
      }

      case 'profile-sync': {
        return {
          success: false,
          message: 'Profile sync approval requires explicit human action. Use CLI: openslack collaboration workflow profile-sync run',
          data: { cliCommand: 'openslack collaboration workflow profile-sync run' },
        }
      }

      default:
        return { success: false, message: `Unknown approval category: ${category}` }
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return { success: false, message }
  }
}

// ── executeTrustChange ─────────────────────────────────────────────────────────

export async function executeTrustChange(
  workflowName: string,
  fromLevel: string,
  toLevel: string,
  root: string,
): Promise<TuiActionResult> {
  if (fromLevel === 'core' || fromLevel === 'builtin') {
    return {
      success: false,
      message: 'Protected workflows cannot have their trust level changed.',
    }
  }

  try {
    const { TrustStore } = await import('@openslack/workflows')
    const store = new TrustStore({ rootDir: root })
    store.set(workflowName, toLevel as 'untrusted' | 'trusted' | 'core')
    store.save()

    return {
      success: true,
      message: `Trust level for "${workflowName}" changed from ${fromLevel} to ${toLevel}`,
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return { success: false, message }
  }
}

// ── executeWorkflowRun ─────────────────────────────────────────────────────────

export async function startWorkflowFromPrompt(
  prompt: string,
  root: string,
): Promise<TuiActionResult> {
  try {
    const { generateWorkflowDraft } = await import('@openslack/workflows')
    const draft = await generateWorkflowDraft({ prompt, rootDir: root })
    return {
      success: true,
      message: `Workflow draft created: ${draft.draftId}`,
      data: { draftId: draft.draftId, path: draft.path, pattern: draft.pattern },
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return { success: false, message: `Workflow start failed: ${message}` }
  }
}

export async function startWorkflowFromPattern(
  patternId: string,
  root: string,
): Promise<TuiActionResult> {
  try {
    const { generateWorkflowDraft, getWorkflowPattern } = await import('@openslack/workflows')
    const pattern = getWorkflowPattern(patternId)
    if (!pattern) return { success: false, message: `Unknown workflow pattern: ${patternId}` }
    const draft = await generateWorkflowDraft({
      prompt: `Start ${pattern.name}: ${pattern.useCases[0] ?? pattern.description}`,
      pattern: patternId,
      rootDir: root,
    })
    return {
      success: true,
      message: `Pattern draft created: ${draft.draftId}`,
      data: { draftId: draft.draftId, path: draft.path, pattern: draft.pattern },
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return { success: false, message: `Pattern start failed: ${message}` }
  }
}

export async function executeWorkflowRun(
  workflowName: string,
  mode: 'preview' | 'dry-run' | 'run',
  root: string,
  actorId: string = 'tui-user',
): Promise<TuiActionResult> {
  const {
    findWorkflow,
    loadWorkflow,
    executePreview,
    executeDryRun,
    executeRun,
    TrustStore,
    buildApprovalManifest,
    WorkflowPausedError,
    WorkflowBudgetPausedError,
    hashString,
  } = await import('@openslack/workflows')

  const { recordEvent } = await import('@openslack/collaboration')

  const found = await findWorkflow(workflowName, root)
  if (!found) {
    return { success: false, message: `Workflow "${workflowName}" not found.` }
  }

  const mod = await loadWorkflow(found.path)

  try {
    if (mode === 'preview') {
      const result = await executePreview(mod, { manifest: mod.meta, args: {} })
      return {
        success: true,
        message: `Preview complete for "${workflowName}".`,
        data: { mode: 'preview', phases: mod.meta.phases.map(p => p.title), budget: result.budget },
      }
    }

    if (mode === 'dry-run') {
      const result = await executeDryRun(mod, { manifest: mod.meta, args: {} })
      return {
        success: true,
        message: `Dry-run complete for "${workflowName}". ${result.simulatedEffects.length} effect(s) simulated.`,
        data: { mode: 'dry-run', simulatedEffects: result.simulatedEffects, errors: result.errors },
      }
    }

    // mode === 'run'
    const trustStore = new TrustStore({ rootDir: root })
    const trustLevel = trustStore.get(workflowName) ?? 'untrusted'
    if (trustLevel === 'untrusted' && mod.meta.risk !== 'low') {
      return {
        success: false,
        message: `Workflow "${workflowName}" is untrusted. Elevate trust before running.`,
      }
    }

    // Step 1: Dry-run to discover side effects
    const dryResult = await executeDryRun(mod, { manifest: mod.meta, args: {} })

    // Step 2: Build approval manifest from dry-run simulated effects
    const inputHash = hashString(JSON.stringify({}))
    const approvalManifest = buildApprovalManifest(
      mod.meta.name,
      dryResult.runId,
      actorId,
      mod.hash,
      inputHash,
      mod.meta.risk ?? 'medium',
      dryResult.simulatedEffects,
    )

    // Step 3: Execute with manifest-based confirmation policy
    const agentEventEmitter = (event: import('@openslack/workflows').AgentConversationEvent) => {
      const severity = event.type === 'agent.conversation.failed' ? 'critical' : undefined
      const summary = event.type === 'agent.conversation.started'
        ? `Agent ${event.agentId} started conversation in phase "${event.phase}" (run ${event.runId})`
        : event.type === 'agent.conversation.completed'
          ? `Agent ${event.agentId} completed conversation in phase "${event.phase}" (run ${event.runId})`
          : `Agent ${event.agentId} failed in phase "${event.phase}" (run ${event.runId}): ${event.error ?? 'unknown error'}`
      recordEvent({
        type: event.type,
        actor: { id: event.agentId, kind: 'agent' },
        object: { kind: 'agent', id: event.resolvedAgentId ?? event.agentId },
        source: { kind: 'openslack', ref: event.runId },
        summary,
        visibility: 'local',
        redacted: false,
        containsSensitiveData: false,
        correlationId: event.runId,
        ...(severity ? { severity } : {}),
      })
    }

    const result = await executeRun(mod, {
      manifest: mod.meta,
      args: {},
      confirmationPolicy: {
        mode: 'preapproved-manifest',
        actorId,
        runId: dryResult.runId,
        approvalManifest,
        onUnexpectedEffect: 'pause',
      },
      agentEventEmitter,
      rootDir: root,
    })

    return {
      success: true,
      message: `Workflow "${workflowName}" executed successfully.`,
      data: { status: result.status, dryRunEffects: dryResult.simulatedEffects },
    }
  } catch (error: unknown) {
    if (error instanceof WorkflowPausedError) {
      return {
        success: false,
        message: `Workflow paused: unexpected effect "${error.operation}" requires approval in Approval Center.`,
        data: { runId: error.runId, operation: error.operation },
      }
    }
    if (error instanceof WorkflowBudgetPausedError) {
      return {
        success: false,
        message: `Workflow paused: budget exceeded and requires approval in Approval Center.`,
        data: { runId: error.runId, operation: 'workflow.budget.exceeded' },
      }
    }
    const message = error instanceof Error ? error.message : String(error)
    return { success: false, message: `Execution failed: ${message}` }
  }
}

// ── publishWorkflowAsIssue ────────────────────────────────────────────────────

export async function publishWorkflowAsIssue(
  workflowName: string,
  _root: string,
  actorId: string = 'tui-user',
): Promise<TuiActionResult> {
  try {
    const { findWorkflow, loadWorkflow } = await import('@openslack/workflows')
    const found = await findWorkflow(workflowName)
    if (!found) {
      return { success: false, message: `Workflow "${workflowName}" not found.` }
    }
    const mod = await loadWorkflow(found.path)
    const { publishWorkflowProposal } = await import('@openslack/github')
    const result = await publishWorkflowProposal(mod, { requestedBy: actorId })
    return {
      success: true,
      message: `Workflow proposal issue created: #${result.issueNumber}`,
      data: { issueNumber: result.issueNumber, url: result.url },
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return { success: false, message }
  }
}

// ── requestWorkflowReview ───────────────────────────────────────────────────────

export async function requestWorkflowReview(
  workflowName: string,
  root: string,
  actorId: string = 'tui-user',
): Promise<TuiActionResult> {
  try {
    const { findWorkflow, loadWorkflow, TrustStore, resolveTrustLevel } = await import('@openslack/workflows')
    const found = await findWorkflow(workflowName)
    if (!found) {
      return { success: false, message: `Workflow "${workflowName}" not found.` }
    }
    const mod = await loadWorkflow(found.path)
    const trustStore = new TrustStore({ rootDir: root })
    const isBuiltin = found.path.includes('/builtins/') || found.path.includes('\\builtins\\')
    const persistedLevel = trustStore.get(workflowName)
    const trustLevel = persistedLevel !== 'untrusted'
      ? persistedLevel
      : resolveTrustLevel({ isBuiltin })

    const { publishWorkflowReviewRequest } = await import('@openslack/github')
    const result = await publishWorkflowReviewRequest(mod, {
      requestedBy: actorId,
      trustLevel,
    })
    return {
      success: true,
      message: `Workflow review issue created: #${result.issueNumber}`,
      data: { issueNumber: result.issueNumber, url: result.url },
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return { success: false, message }
  }
}

// ── finalizeWorkflowPr ─────────────────────────────────────────────────────────

export async function finalizeWorkflowPr(
  workflowName: string,
  prNumber: number,
  root: string,
): Promise<TuiActionResult> {
  try {
    const { findWorkflow, loadWorkflow, TrustStore } = await import('@openslack/workflows')
    const found = await findWorkflow(workflowName)
    if (!found) {
      return { success: false, message: `Workflow "${workflowName}" not found.` }
    }
    const mod = await loadWorkflow(found.path)
    const trustStore = new TrustStore({ rootDir: root })
    const trustDecision = trustStore.get(workflowName) ?? 'untrusted'

    const { finalizeWorkflowPR, fetchWorkflowLifecycleIssues } = await import('@openslack/github')
    const lifecycle = await fetchWorkflowLifecycleIssues(workflowName)

    const result = await finalizeWorkflowPR(prNumber, {
      proposalIssue: lifecycle.proposalIssue?.number,
      reviewIssue: lifecycle.reviewIssue?.number,
      phaseIssues: lifecycle.phaseIssues.map((p) => p.number),
      workflowHash: mod.hash,
      trustDecision: trustDecision as 'trusted' | 'untrusted' | 'core',
    })

    if (result.errors.length > 0) {
      return {
        success: false,
        message: `Finalize completed with ${result.errors.length} error(s): ${result.errors.join('; ')}`,
        data: { closed: result.closedIssues, commented: result.commentedIssues, errors: result.errors },
      }
    }

    return {
      success: true,
      message: `Workflow PR #${prNumber} finalized. Closed ${result.closedIssues.length} issue(s), updated ${result.commentedIssues.length}.`,
      data: { closed: result.closedIssues, commented: result.commentedIssues },
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return { success: false, message }
  }
}

// ── splitWorkflowIntoIssues ─────────────────────────────────────────────────────

export async function splitWorkflowIntoIssues(
  workflowName: string,
  parentIssue: number | undefined,
  root: string,
): Promise<TuiActionResult> {
  try {
    const { findWorkflow, loadWorkflow } = await import('@openslack/workflows')
    const found = await findWorkflow(workflowName, root)
    if (!found) {
      return { success: false, message: `Workflow "${workflowName}" not found.` }
    }
    const mod = await loadWorkflow(found.path)
    const { publishWorkflowSplit } = await import('@openslack/github')
    const options = Number.isFinite(parentIssue) && (parentIssue ?? 0) > 0
      ? { parentIssue: parentIssue as number }
      : {}
    const result = await publishWorkflowSplit(mod, options)
    return {
      success: true,
      message: `Workflow split into ${result.subIssues.length} phase issues.`,
      data: {
        parentIssueNumber: result.parentIssueNumber,
        subIssues: result.subIssues.map((s) => ({ phase: s.phase, issueNumber: s.issueNumber, url: s.url })),
      },
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return { success: false, message }
  }
}

/** Build the full action handler set for injection into the TUI shell. */
// ── Profile Sync Action Handlers ──────────────────────────────────────────────

export function createProfileSyncHandlers(root: string) {
  return {
    checkProfileSync: async function profileSyncCheck(): Promise<TuiActionResult> {
      try {
        const { loadProfileSyncConfig, checkProfileSync } = await import('@openslack/github')
        const config = loadProfileSyncConfig(root)
        const result = await checkProfileSync(config)
        // Build structured check groups for the guided flow
        const checkGroups = [
          {
            key: 'source',
            label: 'Source repository',
            status: result.source.sourceCommit ? 'pass' as const : 'warn' as const,
            detail: result.source.sourceCommit
              ? `Commit ${result.source.sourceCommit} (${result.source.sourceDate ?? 'unknown date'})`
              : 'No source commit found',
          },
          {
            key: 'posts',
            label: 'Posts',
            status: result.posts.failed > 0 ? 'fail' as const : result.posts.total > 0 ? 'pass' as const : 'warn' as const,
            detail: `${result.posts.published}/${result.posts.total} published, ${result.posts.failed} failed`,
          },
          {
            key: 'target-marker',
            label: 'Target marker',
            status: result.target.markerExists ? 'pass' as const : 'fail' as const,
            detail: result.target.markerExists ? 'Marker present in target' : 'Marker not found in target',
          },
          {
            key: 'permissions',
            label: 'Permissions',
            status: result.ok ? 'pass' as const : 'warn' as const,
            detail: result.ok ? 'All checks passed' : result.errors.slice(0, 2).join('; '),
          },
        ]
        return {
          success: result.ok,
          message: result.ok
            ? 'Profile sync check passed'
            : `Check failed: ${result.errors.join('; ')}`,
          data: { posts: result.posts.published, marker: result.target.markerExists, checkGroups },
        }
      } catch (err: unknown) {
        return { success: false, message: `Check error: ${(err as Error).message}` }
      }
    },

    previewProfileSync: async function profileSyncPreview(): Promise<TuiActionResult> {
      try {
        const { loadProfileSyncConfig, previewProfileSync } = await import('@openslack/github')
        const config = loadProfileSyncConfig(root)
        const result = await previewProfileSync(config)
        return {
          success: result.ok,
          message: result.ok
            ? `Preview ready: ${result.renderedSection.length} chars, branch ${result.wouldCreateBranch}`
            : `Preview failed: ${result.checkResult.errors.join('; ')}`,
          data: { diffLength: result.diff.length, diff: result.diff },
        }
      } catch (err: unknown) {
        return { success: false, message: `Preview error: ${(err as Error).message}` }
      }
    },

    dryRunProfileSync: async function profileSyncDryRun(): Promise<TuiActionResult> {
      try {
        const { loadProfileSyncConfig, runProfileSync } = await import('@openslack/github')
        const config = loadProfileSyncConfig(root)
        const result = await runProfileSync({ config, dryRun: true })
        return {
          success: result.status === 'completed' || result.status === 'skipped',
          message: result.status === 'completed'
            ? `Dry-run would create PR: ${result.prUrl}`
            : result.status === 'skipped'
              ? `Skipped: ${result.reason}`
              : `Dry-run failed: ${result.error}`,
        }
      } catch (err: unknown) {
        return { success: false, message: `Dry-run error: ${(err as Error).message}` }
      }
    },

    createProfileSyncPR: async function profileSyncCreatePR(): Promise<TuiActionResult> {
      try {
        const { loadProfileSyncConfig, runProfileSync } = await import('@openslack/github')
        const config = loadProfileSyncConfig(root)
        const result = await runProfileSync({ config })
        return {
          success: result.status === 'completed',
          message: result.status === 'completed'
            ? `Created PR: ${result.prUrl}`
            : result.status === 'skipped'
              ? `Skipped: ${result.reason}`
              : `Failed: ${result.error}`,
          data: { prUrl: result.prUrl, prNumber: result.prNumber },
        }
      } catch (err: unknown) {
        return { success: false, message: `Run error: ${(err as Error).message}` }
      }
    },

    openProfileSyncPR: async function profileSyncOpenPR(prUrl: string): Promise<TuiActionResult> {
      try {
        const { execFile } = await import('node:child_process')
        const platform = process.platform
        const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'start' : 'xdg-open'
        execFile(command, [prUrl])
        return { success: true, message: `Opened ${prUrl}` }
      } catch (err: unknown) {
        return { success: false, message: `Open failed: ${(err as Error).message}` }
      }
    },

    createProfileSyncFailureIssue: async function profileSyncFailureIssue(error: string): Promise<TuiActionResult> {
      try {
        const { loadProfileSyncConfig, publishProfileSyncFailure } = await import('@openslack/github')
        const config = loadProfileSyncConfig(root)
        const result = await publishProfileSyncFailure({
          schema: 'openslack.profile_sync_failure.v1',
          sourceRepo: config.source.repo,
          targetRepo: config.target.repo,
          error,
          phase: 'manual',
        })
        return { success: true, message: `Created issue: ${result.url}`, data: { issueUrl: result.url } }
      } catch (err: unknown) {
        return { success: false, message: `Issue creation failed: ${(err as Error).message}` }
      }
    },
  }
}

export async function controlWorkflowRunFromTui(
  runId: string,
  action: WorkflowRunControlAction,
  root: string,
  target?: WorkflowRunControlTarget,
): Promise<TuiActionResult> {
  try {
    const { controlWorkflowRun } = await import('@openslack/workflows')
    const result = await controlWorkflowRun(runId, action, { rootDir: root, target })
    return {
      success: result.status === 'applied' || result.status === 'recorded',
      message: result.message,
      data: { runId, action, status: result.status, target },
    }
  } catch (err: unknown) {
    return { success: false, message: `Workflow run control failed: ${(err as Error).message}` }
  }
}

export async function saveWorkflowRunScriptFromTui(
  runId: string,
  root: string,
  target: 'project' | 'user' | 'claude-project' = 'project',
): Promise<TuiActionResult> {
  try {
    const { saveWorkflowRunScript } = await import('@openslack/workflows')
    const result = await saveWorkflowRunScript(runId, { rootDir: root, to: target })
    return {
      success: true,
      message: `Saved workflow "${result.workflowName}" to ${result.path}`,
      data: { runId, path: result.path, hash: result.scriptHash, target },
    }
  } catch (err: unknown) {
    return { success: false, message: `Workflow save failed: ${(err as Error).message}` }
  }
}

export async function submitWorkbenchAskFromTui(
  input: string,
  root: string,
  actorId: string = 'tui-user',
  threadId?: string,
): Promise<TuiAskResult> {
  const text = input.trim()
  if (!text) {
    return { threadId: threadId ?? '', status: 'error', message: 'Ask text is empty.', cards: [] }
  }

  const thread = resolveWorkbenchThread(threadId, root)
  const mentionMatch = text.match(/^@(\S+)\s+(.+)$/)
  if (mentionMatch) {
    const agentId = mentionMatch[1]
    const prompt = mentionMatch[2]
    const result = await dispatchConversationAgentMessage({
      rootDir: root,
      threadId: thread.id,
      authorId: actorId,
      agentId,
      prompt,
      originalText: text,
    })
    const cards: ConversationActionCard[] = result.runId
      ? [{
          id: `agent-run-${result.runId}`,
          label: 'Open Agent Run',
          detail: `Inspect run ${result.runId} created by ${agentId}.`,
          kind: 'agent_run',
          route: 'agent-run-detail',
          routeParams: { runId: result.runId },
          command: `openslack agent-runtime mcp status --run ${result.runId}`,
          riskLevel: 'low',
          confirmationRequired: false,
          linkedObject: { kind: 'workflow_run', id: result.runId },
        }]
      : []
    return {
      threadId: thread.id,
      status: result.dispatched ? 'agent_dispatched' : 'recorded',
      message: result.responseText,
      cards,
    }
  }

  const { appendMessage, getThread } = await import('@openslack/collaboration')
  appendMessage(
    thread.id,
    {
      kind: 'user_message',
      threadId: thread.id,
      authorId: actorId,
      text,
    },
    root,
  )
  const planMessageIndex = (getThread(thread.id, root)?.messages.length ?? 0) + 1

  const { buildTuiAskPlan } = await import('@openslack/operator')
  const planned = buildTuiAskPlan(text)
  appendMessage(
    thread.id,
    {
      kind: 'plan',
      threadId: thread.id,
      authorId: 'openslack',
      planId: `tui-${thread.id}-plan-${planMessageIndex}`,
      steps: planned.message.split('\n').filter(line => line.trim().length > 0),
    },
    root,
  )

  return {
    threadId: thread.id,
    status: 'planned',
    message: planned.message,
    cards: planned.cards,
  }
}

export async function recordWorkbenchActionFromTui(
  threadId: string,
  card: ConversationActionCard,
  message: string,
  root: string,
  actorId: string = 'tui-user',
): Promise<TuiActionResult> {
  try {
    const { appendMessage, linkObjectToThread } = await import('@openslack/collaboration')
    appendMessage(
      threadId,
      {
        kind: 'tool_event',
        threadId,
        authorId: actorId,
        toolName: 'tui.action_card',
        input: {
          id: card.id,
          label: card.label,
          kind: card.kind,
          route: card.route,
          command: card.command,
        },
        output: { message },
      },
      root,
    )
    if (card.linkedObject) {
      linkObjectToThread(threadId, card.linkedObject, root)
    }
    return { success: true, message: 'Action recorded in conversation thread.' }
  } catch (err: unknown) {
    return { success: false, message: `Conversation audit failed: ${(err as Error).message}` }
  }
}

export function createActionHandlers(root: string, actorId: string = 'tui-user'): TuiActionHandlers {
  return {
    executeApproval: (params, isApprove) => executeApproval(params, isApprove, root, actorId),
    executeTrustChange: (name, from, to) => executeTrustChange(name, from, to, root),
    executeWorkflowRun: (name, mode) => executeWorkflowRun(name, mode, root, actorId),
    startWorkflowFromPrompt: (prompt) => startWorkflowFromPrompt(prompt, root),
    startWorkflowFromPattern: (patternId) => startWorkflowFromPattern(patternId, root),
    controlWorkflowRun: (runId, action, target) => controlWorkflowRunFromTui(runId, action, root, target),
    saveWorkflowRunScript: (runId, target) => saveWorkflowRunScriptFromTui(runId, root, target),
    publishWorkflowAsIssue: (name) => publishWorkflowAsIssue(name, root, actorId),
    requestWorkflowReview: (name) => requestWorkflowReview(name, root, actorId),
    splitWorkflowIntoIssues: (name, parentIssue) => splitWorkflowIntoIssues(name, parentIssue, root),
    finalizeWorkflowPr: (name, prNumber) => finalizeWorkflowPr(name, prNumber, root),
    submitWorkbenchAsk: (input, threadId) => submitWorkbenchAskFromTui(input, root, actorId, threadId),
    recordWorkbenchAction: (threadId, card, message) => recordWorkbenchActionFromTui(threadId, card, message, root, actorId),
    profileSync: createProfileSyncHandlers(root),
  }
}
