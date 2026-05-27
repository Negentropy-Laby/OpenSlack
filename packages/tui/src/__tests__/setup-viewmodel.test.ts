import { describe, it, expect } from 'vitest'
import { mapSetupToViewModel } from '../view-models/setup.js'
import type { SetupReport, SetupFinding } from '@openslack/runtime'

function makeFinding(overrides?: Partial<SetupFinding>): SetupFinding {
  return {
    id: 'repo-root',
    title: 'Workspace root',
    status: 'ok',
    detail: '/path/to/repo',
    ...overrides,
  }
}

function makeReport(findings?: SetupFinding[]): SetupReport {
  return {
    root: '/path/to/repo',
    generatedAt: '2026-05-27T12:00:00Z',
    dryRun: true,
    findings: findings ?? [
      makeFinding(),
      makeFinding({ id: 'git-remote', title: 'Git remote', status: 'ok', detail: 'origin configured' }),
    ],
  }
}

describe('mapSetupToViewModel', () => {
  it('maps an all-ok report to ready readiness', () => {
    const model = mapSetupToViewModel(makeReport())
    expect(model.readiness).toBe('ready')
    expect(model.passedChecks).toBe(2)
    expect(model.totalChecks).toBe(2)
    expect(model.fixable).toHaveLength(0)
    expect(model.needsAction).toHaveLength(0)
    expect(model.ok).toHaveLength(2)
  })

  it('classifies fixable findings as almost ready', () => {
    const model = mapSetupToViewModel(makeReport([
      makeFinding({ id: 'repo-root', status: 'ok', title: 'Root', detail: 'ok' }),
      makeFinding({ id: 'github-labels', status: 'fixable_by_command', title: 'Labels', detail: 'Can repair' }),
    ]))
    expect(model.readiness).toBe('almost ready')
    expect(model.fixable).toHaveLength(1)
    expect(model.fixable[0].status).toBe('WARN')
  })

  it('classifies unfixable findings as needs setup help', () => {
    const model = mapSetupToViewModel(makeReport([
      makeFinding({ id: 'branch-protection', status: 'requires_github_admin', title: 'Branch protection', detail: 'Manual check' }),
    ]))
    expect(model.readiness).toBe('needs setup help')
    expect(model.needsAction).toHaveLength(1)
    expect(model.needsAction[0].status).toBe('FAIL')
  })

  it('classifies mixed fixable+unfixable as needs setup help', () => {
    const model = mapSetupToViewModel(makeReport([
      makeFinding({ id: 'github-labels', status: 'fixable_by_command', title: 'Labels', detail: 'Can repair' }),
      makeFinding({ id: 'branch-protection', status: 'requires_github_admin', title: 'Branch protection', detail: 'Manual check' }),
    ]))
    expect(model.readiness).toBe('needs setup help')
    expect(model.fixable).toHaveLength(1)
    expect(model.needsAction).toHaveLength(1)
  })

  it('maps requires_human_approval to FAIL', () => {
    const model = mapSetupToViewModel(makeReport([
      makeFinding({ id: 'codeowners', status: 'requires_human_approval', title: 'CODEOWNERS', detail: 'Missing' }),
    ]))
    expect(model.needsAction).toHaveLength(1)
    expect(model.needsAction[0].status).toBe('FAIL')
  })

  it('sanitizes escape sequences from fields', () => {
    const model = mapSetupToViewModel(makeReport([
      makeFinding({ id: 'test', title: 'Bad\x1b[31m inject', status: 'ok', detail: 'ok' }),
    ]))
    expect(model.ok[0].title).toBe('Bad inject')
  })

  it('maps informational to info status', () => {
    const model = mapSetupToViewModel(makeReport([
      makeFinding({ id: 'github-token', status: 'informational', title: 'PAT fallback', detail: 'Token set' }),
    ]))
    expect(model.ok).toHaveLength(1)
    expect(model.ok[0].status).toBe('info')
  })
})
