import type { TuiActionResult } from '@openslack/tui'
import { join } from 'node:path'

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ApprovalExecutionParams {
  id: string
  category: 'plan' | 'merge-request' | 'workflow-effect' | 'github-review'
  title: string
  planId?: string
  prNumber?: number
  workflowName?: string
  runId?: string
}

export interface TuiActionHandlers {
  executeApproval: (params: ApprovalExecutionParams, isApprove: boolean) => Promise<TuiActionResult>
  executeTrustChange: (workflowName: string, fromLevel: string, toLevel: string) => Promise<TuiActionResult>
  executeWorkflowRun: (workflowName: string, mode: 'preview' | 'dry-run' | 'run') => Promise<TuiActionResult>
  publishWorkflowAsIssue?: (workflowName: string) => Promise<TuiActionResult>
  requestWorkflowReview?: (workflowName: string) => Promise<TuiActionResult>
  splitWorkflowIntoIssues?: (workflowName: string, parentIssue: number) => Promise<TuiActionResult>
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
                  confirmationPolicy: {
                    mode: 'preapproved-manifest',
                    actorId,
                    runId: params.runId,
                    onUnexpectedEffect: 'pause',
                  },
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
    hashString,
  } = await import('@openslack/workflows')

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

// ── splitWorkflowIntoIssues ─────────────────────────────────────────────────────

export async function splitWorkflowIntoIssues(
  workflowName: string,
  parentIssue: number,
  _root: string,
): Promise<TuiActionResult> {
  try {
    const { findWorkflow, loadWorkflow } = await import('@openslack/workflows')
    const found = await findWorkflow(workflowName)
    if (!found) {
      return { success: false, message: `Workflow "${workflowName}" not found.` }
    }
    const mod = await loadWorkflow(found.path)
    const { publishWorkflowSplit } = await import('@openslack/github')
    const result = await publishWorkflowSplit(mod, { parentIssue })
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
export function createActionHandlers(root: string, actorId: string = 'tui-user'): TuiActionHandlers {
  return {
    executeApproval: (params, isApprove) => executeApproval(params, isApprove, root, actorId),
    executeTrustChange: (name, from, to) => executeTrustChange(name, from, to, root),
    executeWorkflowRun: (name, mode) => executeWorkflowRun(name, mode, root, actorId),
    publishWorkflowAsIssue: (name) => publishWorkflowAsIssue(name, root, actorId),
    requestWorkflowReview: (name) => requestWorkflowReview(name, root, actorId),
    splitWorkflowIntoIssues: (name, parentIssue) => splitWorkflowIntoIssues(name, parentIssue, root),
  }
}
