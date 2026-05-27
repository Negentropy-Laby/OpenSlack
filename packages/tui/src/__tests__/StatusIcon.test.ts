import { describe, it, expect } from 'vitest'
import { categorizeStatus } from '../design-system/StatusIcon.js'

describe('categorizeStatus', () => {
  // pass category
  it('maps PASS -> pass', () => {
    expect(categorizeStatus('PASS')).toBe('pass')
  })

  it('maps ok -> pass', () => {
    expect(categorizeStatus('ok')).toBe('pass')
  })

  it('maps success -> pass', () => {
    expect(categorizeStatus('success')).toBe('pass')
  })

  it('maps active -> pass', () => {
    expect(categorizeStatus('active')).toBe('pass')
  })

  // warn category
  it('maps WARN -> warn', () => {
    expect(categorizeStatus('WARN')).toBe('warn')
  })

  it('maps fixable_by_command -> warn', () => {
    expect(categorizeStatus('fixable_by_command')).toBe('warn')
  })

  // fail category
  it('maps FAIL -> fail', () => {
    expect(categorizeStatus('FAIL')).toBe('fail')
  })

  it('maps error -> fail', () => {
    expect(categorizeStatus('error')).toBe('fail')
  })

  it('maps failed -> fail', () => {
    expect(categorizeStatus('failed')).toBe('fail')
  })

  it('maps requires_github_admin -> fail', () => {
    expect(categorizeStatus('requires_github_admin')).toBe('fail')
  })

  it('maps requires_human_approval -> fail', () => {
    expect(categorizeStatus('requires_human_approval')).toBe('fail')
  })

  // blocked category
  it('maps BLOCKED -> blocked', () => {
    expect(categorizeStatus('BLOCKED')).toBe('blocked')
  })

  it('maps BLOCKED_BY_GOVERNANCE -> blocked', () => {
    expect(categorizeStatus('BLOCKED_BY_GOVERNANCE')).toBe('blocked')
  })

  it('maps BLOCKED_BY_CHECKS -> blocked', () => {
    expect(categorizeStatus('BLOCKED_BY_CHECKS')).toBe('blocked')
  })

  it('maps blocker -> blocked', () => {
    expect(categorizeStatus('blocker')).toBe('blocked')
  })

  it('maps NEEDS_HUMAN_APPROVAL -> blocked', () => {
    expect(categorizeStatus('NEEDS_HUMAN_APPROVAL')).toBe('blocked')
  })

  it('maps NEEDS_CODEOWNER_APPROVAL -> blocked', () => {
    expect(categorizeStatus('NEEDS_CODEOWNER_APPROVAL')).toBe('blocked')
  })

  it('maps NEEDS_CHANGES -> blocked', () => {
    expect(categorizeStatus('NEEDS_CHANGES')).toBe('blocked')
  })

  it('maps BOT_APPROVAL_IGNORED -> blocked', () => {
    expect(categorizeStatus('BOT_APPROVAL_IGNORED')).toBe('blocked')
  })

  // info category
  it('maps informational -> info', () => {
    expect(categorizeStatus('informational')).toBe('info')
  })

  it('maps DISCOVERED -> info', () => {
    expect(categorizeStatus('DISCOVERED')).toBe('info')
  })

  it('maps CLASSIFIED -> info', () => {
    expect(categorizeStatus('CLASSIFIED')).toBe('info')
  })

  it('maps CHECKS_PENDING -> info', () => {
    expect(categorizeStatus('CHECKS_PENDING')).toBe('info')
  })

  it('maps unknown_status -> info (default)', () => {
    expect(categorizeStatus('unknown_status')).toBe('info')
  })

  it('maps empty string -> info (default)', () => {
    expect(categorizeStatus('')).toBe('info')
  })
})
