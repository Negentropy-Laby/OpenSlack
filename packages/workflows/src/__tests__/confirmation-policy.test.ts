import { describe, it, expect } from 'vitest'
import { validateEffectAgainstManifest, ALWAYS_FORBIDDEN, buildApprovalManifest } from '../manifest-validator.js'
import { createOnConfirmFromPolicy } from '../execute.js'
import { WorkflowPausedError } from '../runtime.js'
import type { ConfirmationPolicy, WorkflowApprovalManifest } from '../types.js'

function makePolicy(manifest?: WorkflowApprovalManifest, onUnexpectedEffect?: 'pause' | 'fail'): ConfirmationPolicy {
  return {
    mode: 'preapproved-manifest',
    actorId: 'test-actor',
    runId: 'test-run-001',
    approvalManifest: manifest,
    onUnexpectedEffect,
  }
}

function makeManifest(effects: Array<{ operation: string; detail: string }> = []): WorkflowApprovalManifest {
  return {
    workflowName: 'test-wf',
    runId: 'test-run-001',
    actorId: 'test-actor',
    workflowHash: 'abc123',
    inputHash: '',
    risk: 'medium',
    approvedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    approvedEffects: effects.map(e => ({
      kind: e.operation,
      summary: e.detail,
      risk: 'medium' as const,
    })),
  }
}

describe('validateEffectAgainstManifest', () => {
  it('allows approved effects', () => {
    const manifest = makeManifest([{ operation: 'openslack.task.createIssue', detail: 'Create issue' }])
    const policy = makePolicy(manifest)
    const result = validateEffectAgainstManifest('openslack.task.createIssue', 'Create issue', policy)

    expect(result.allowed).toBe(true)
    expect(result.reason).toBe('Auto-confirmed by manifest')
  })

  it('rejects effects not in manifest', () => {
    const manifest = makeManifest([{ operation: 'openslack.task.createIssue', detail: 'Create issue' }])
    const policy = makePolicy(manifest)
    const result = validateEffectAgainstManifest('openslack.task.checkout', 'Checkout', policy)

    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('Effect not in approved manifest')
  })

  it('rejects always-forbidden effects', () => {
    const manifest = makeManifest([{ operation: 'github.pr.approve', detail: 'Approve PR' }])
    const policy = makePolicy(manifest)
    const result = validateEffectAgainstManifest('github.pr.approve', 'Approve PR', policy)

    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('Effect is permanently forbidden')
  })

  it('rejects expired manifests', () => {
    const manifest = makeManifest([{ operation: 'openslack.task.createIssue', detail: 'Create issue' }])
    manifest.expiresAt = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const policy = makePolicy(manifest)
    const result = validateEffectAgainstManifest('openslack.task.createIssue', 'Create issue', policy)

    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('Approval manifest expired')
  })

  it('rejects when no manifest', () => {
    const policy = makePolicy(undefined)
    const result = validateEffectAgainstManifest('openslack.task.createIssue', 'Create issue', policy)

    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('No approval manifest')
  })
})

describe('createOnConfirmFromPolicy', () => {
  it('auto-confirms approved effects', async () => {
    const manifest = makeManifest([{ operation: 'openslack.task.createIssue', detail: 'Create issue' }])
    const policy = makePolicy(manifest, 'fail')
    const onConfirm = createOnConfirmFromPolicy(policy)

    const result = await onConfirm('openslack.task.createIssue', 'Create issue')
    expect(result).toBe(true)
  })

  it('returns false for unapproved effects when onUnexpectedEffect is fail', async () => {
    const manifest = makeManifest([{ operation: 'openslack.task.createIssue', detail: 'Create issue' }])
    const policy = makePolicy(manifest, 'fail')
    const onConfirm = createOnConfirmFromPolicy(policy)

    const result = await onConfirm('openslack.task.checkout', 'Checkout')
    expect(result).toBe(false)
  })

  it('throws WorkflowPausedError for unapproved effects when onUnexpectedEffect is pause', async () => {
    const manifest = makeManifest([{ operation: 'openslack.task.createIssue', detail: 'Create issue' }])
    const policy = makePolicy(manifest, 'pause')
    const onConfirm = createOnConfirmFromPolicy(policy)

    await expect(onConfirm('openslack.task.checkout', 'Checkout')).rejects.toThrow(WorkflowPausedError)
  })

  it('throws WorkflowPausedError with correct operation and runId', async () => {
    const manifest = makeManifest([{ operation: 'openslack.task.createIssue', detail: 'Create issue' }])
    const policy = makePolicy(manifest, 'pause')
    const onConfirm = createOnConfirmFromPolicy(policy)

    try {
      await onConfirm('openslack.task.checkout', 'Checkout')
      expect.fail('Should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowPausedError)
      expect((err as WorkflowPausedError).operation).toBe('openslack.task.checkout')
      expect((err as WorkflowPausedError).runId).toBe('test-run-001')
    }
  })
})

describe('buildApprovalManifest', () => {
  it('builds manifest from simulated effects', () => {
    const effects = [
      { operation: 'openslack.task.createIssue', detail: 'Create issue #1' },
      { operation: 'openslack.task.checkout', detail: 'Checkout #123' },
    ]

    const manifest = buildApprovalManifest(
      'test-wf',
      'run-001',
      'test-actor',
      'hash123',
      'input-hash',
      'medium',
      effects,
    )

    expect(manifest.workflowName).toBe('test-wf')
    expect(manifest.runId).toBe('run-001')
    expect(manifest.actorId).toBe('test-actor')
    expect(manifest.approvedEffects).toHaveLength(2)
    expect(manifest.approvedEffects[0].kind).toBe('openslack.task.createIssue')
    expect(manifest.approvedEffects[1].kind).toBe('openslack.task.checkout')
    expect(new Date(manifest.expiresAt) > new Date()).toBe(true)
  })
})

describe('ALWAYS_FORBIDDEN', () => {
  it('contains permanently forbidden effects', () => {
    expect(ALWAYS_FORBIDDEN.has('github.pr.approve')).toBe(true)
    expect(ALWAYS_FORBIDDEN.has('ruleset.bypass')).toBe(true)
    expect(ALWAYS_FORBIDDEN.has('secrets.read')).toBe(true)
    expect(ALWAYS_FORBIDDEN.has('github.pr.merge')).toBe(true)
  })
})
