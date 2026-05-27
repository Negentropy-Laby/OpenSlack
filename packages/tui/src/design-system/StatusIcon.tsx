import React from 'react'
import { useTheme } from './ThemeProvider.js'
import ThemedText from './ThemedText.js'

export type StatusCategory = 'pass' | 'warn' | 'fail' | 'blocked' | 'info'

const STATUS_MAP: Record<string, StatusCategory> = {
  PASS: 'pass',
  ok: 'pass',
  success: 'pass',
  active: 'pass',
  READY_TO_MERGE: 'pass',
  MERGED: 'pass',
  HUMAN_APPROVED: 'pass',

  WARN: 'warn',
  fixable_by_command: 'warn',
  ATTENTION: 'warn',

  FAIL: 'fail',
  error: 'fail',
  failed: 'fail',
  requires_github_admin: 'fail',
  requires_human_approval: 'fail',
  closed: 'fail',
  CHECKS_FAILED: 'fail',

  blocker: 'blocked',
  BLOCKED: 'blocked',
  BLOCKED_BY_GOVERNANCE: 'blocked',
  BLOCKED_BY_AUTHOR_RISK: 'blocked',
  BLOCKED_BY_CONFLICTS: 'blocked',
  BLOCKED_BY_REVIEWS: 'blocked',
  BLOCKED_BY_CHECKS: 'blocked',
  NEEDS_HUMAN_APPROVAL: 'blocked',
  NEEDS_CODEOWNER_APPROVAL: 'blocked',
  NEEDS_CHANGES: 'blocked',
  BOT_APPROVAL_IGNORED: 'blocked',

  informational: 'info',
  superseded: 'info',
  DISCOVERED: 'info',
  CLASSIFIED: 'info',
  PENDING: 'info',
  CHECKS_PENDING: 'warn',
  open: 'info',
}

const SYMBOLS: Record<StatusCategory, string> = {
  pass: '✓',
  warn: '⚠',
  fail: '✗',
  blocked: '⊘',
  info: '●',
}

const THEME_KEYS: Record<StatusCategory, 'pass' | 'warning' | 'error' | 'blocker' | 'info'> = {
  pass: 'pass',
  warn: 'warning',
  fail: 'error',
  blocked: 'blocker',
  info: 'info',
}

export function categorizeStatus(status: string): StatusCategory {
  if (STATUS_MAP[status]) return STATUS_MAP[status]
  if (status.startsWith('BLOCKED_')) return 'blocked'
  return 'info'
}

export type StatusIconProps = {
  status?: string
  category?: StatusCategory
}

export default function StatusIcon({ status, category }: StatusIconProps): React.JSX.Element {
  const cat = category ?? (status ? categorizeStatus(status) : 'info')
  const symbol = SYMBOLS[cat]
  const themeKey = THEME_KEYS[cat]

  return React.createElement(ThemedText, { colorTheme: themeKey, bold: true }, symbol)
}
