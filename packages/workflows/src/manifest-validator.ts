import type { ConfirmationPolicy, WorkflowApprovalManifest } from './types.js'

/**
 * Effects that are permanently forbidden regardless of manifest.
 */
export const ALWAYS_FORBIDDEN = new Set([
  'github.pr.approve',
  'ruleset.bypass',
  'secrets.read',
  'github.pr.merge',
])

/**
 * Validate a side effect against the confirmation policy and its approval manifest.
 *
 * Returns { allowed: true } if the effect is auto-confirmed by the manifest,
 * or { allowed: false, reason } if denied.
 */
export function validateEffectAgainstManifest(
  operation: string,
  _detail: string,
  policy: ConfirmationPolicy,
): { allowed: boolean; reason: string } {
  if (ALWAYS_FORBIDDEN.has(operation)) {
    return { allowed: false, reason: 'Effect is permanently forbidden' }
  }

  const manifest = policy.approvalManifest
  if (!manifest) {
    return { allowed: false, reason: 'No approval manifest' }
  }

  if (new Date(manifest.expiresAt) < new Date()) {
    return { allowed: false, reason: 'Approval manifest expired' }
  }

  const isApproved = manifest.approvedEffects.some(e => e.kind === operation)
  if (isApproved) {
    return { allowed: true, reason: 'Auto-confirmed by manifest' }
  }

  return { allowed: false, reason: 'Effect not in approved manifest' }
}

/**
 * Build an approval manifest from a dry-run result's simulated effects.
 */
export function buildApprovalManifest(
  workflowName: string,
  runId: string,
  actorId: string,
  workflowHash: string,
  inputHash: string,
  risk: 'low' | 'medium' | 'high',
  effects: Array<{ operation: string; detail: string }>,
): WorkflowApprovalManifest {
  const approvedEffects = effects.map(e => ({
    kind: e.operation,
    summary: e.detail,
    risk: 'low' as const,
  }))

  const now = new Date()
  const expiresAt = new Date(now.getTime() + 30 * 60 * 1000) // 30 minutes

  return {
    workflowName,
    runId,
    actorId,
    workflowHash,
    inputHash,
    risk,
    approvedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    approvedEffects,
  }
}
