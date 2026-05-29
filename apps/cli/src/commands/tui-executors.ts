import type { TuiActionResult } from '@openslack/tui'

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ApprovalExecutionParams {
  id: string
  category: 'plan' | 'merge-request' | 'workflow-effect' | 'github-review'
  title: string
  planId?: string
  prNumber?: number
  workflowName?: string
}

export interface TuiActionHandlers {
  executeApproval: (params: ApprovalExecutionParams, isApprove: boolean) => Promise<TuiActionResult>
  executeTrustChange: (workflowName: string, fromLevel: string, toLevel: string) => Promise<TuiActionResult>
  executeWorkflowRun: (workflowName: string, mode: 'preview' | 'dry-run' | 'run') => Promise<TuiActionResult>
}

// ── executeApproval ────────────────────────────────────────────────────────────

export async function executeApproval(
  params: ApprovalExecutionParams,
  isApprove: boolean,
  root: string,
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
          decidedBy: 'tui-user',
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
            decidedBy: 'tui-user',
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
          decidedBy: 'tui-user',
          tags: ['merge-request', 'tui', `pr-${prNumber}`],
        })

        return {
          success: true,
          message: `Merge request for PR #${prNumber} rejected`,
        }
      }

      case 'workflow-effect': {
        const { recordDecision } = await import('@openslack/collaboration')

        recordDecision({
          topic: title,
          decision: isApprove ? 'confirmed' : 'cancelled',
          rationale: `Workflow effect ${isApprove ? 'confirmed' : 'cancelled'} via TUI${workflowName ? ` for ${workflowName}` : ''}`,
          decidedBy: 'tui-user',
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
): Promise<TuiActionResult> {
  const { findWorkflow, loadWorkflow, executePreview, executeDryRun, executeRun, TrustStore } =
    await import('@openslack/workflows')

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

    // For TUI runs, use confirmationPolicy with auto-confirm after TUI confirmation dialog
    // In a full implementation, this would build a manifest from dry-run first.
    // For now, use allowUnattended since the TUI confirmation dialog already showed risks.
    const result = await executeRun(mod, {
      manifest: mod.meta,
      args: {},
      allowUnattended: true,
    })

    return {
      success: true,
      message: `Workflow "${workflowName}" executed successfully.`,
      data: { status: result.status },
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return { success: false, message: `Execution failed: ${message}` }
  }
}

/** Build the full action handler set for injection into the TUI shell. */
export function createActionHandlers(root: string): TuiActionHandlers {
  return {
    executeApproval: (params, isApprove) => executeApproval(params, isApprove, root),
    executeTrustChange: (name, from, to) => executeTrustChange(name, from, to, root),
    executeWorkflowRun: (name, mode) => executeWorkflowRun(name, mode, root),
  }
}
