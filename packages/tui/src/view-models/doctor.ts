import { sanitizeTerminalText } from '../sanitize.js'

export interface DoctorReportInput {
  prNumber: number
  title: string
  author: string
  state: string
  draft: boolean
  riskZone: string
  mergeable: boolean
  decision: string
  reason: string
  recommendation: string
  checks: Array<{ name: string; status: string; conclusion: string | null }>
  reviews: Array<{ user: string; state: string }>
  humanApprovals: Array<{ user: string }>
}

export interface DoctorViewModel {
  prNumber: number
  title: string
  author: string
  state: string
  draft: boolean
  riskZone: string
  mergeable: boolean
  decision: string
  reason: string
  recommendation: string
  gates: Array<{ name: string; status: 'PASS' | 'FAIL' | 'WARN' | 'info'; detail: string }>
  checks: Array<{ name: string; status: 'PASS' | 'FAIL' | 'WARN'; conclusion: string }>
  reviews: Array<{ user: string; state: string; valid: boolean }>
  evidence: string[]
}

export function mapDoctorToViewModel(
  report: DoctorReportInput,
  evidence: string[] = [],
): DoctorViewModel {
  const failing = report.checks.filter(
    c => c.conclusion && c.conclusion !== 'success' && c.conclusion !== 'neutral' && c.conclusion !== 'skipped',
  )
  const pending = report.checks.filter(c => c.status !== 'completed')

  const validApprovalCount = report.humanApprovals.length

  const gates: DoctorViewModel['gates'] = [
    {
      name: 'Draft',
      status: report.draft ? 'FAIL' : 'PASS',
      detail: report.draft ? 'PR is in draft state' : 'Ready for review',
    },
    {
      name: 'State',
      status: report.state !== 'open' ? 'FAIL' : 'PASS',
      detail: report.state !== 'open' ? `PR is ${report.state}` : 'Open',
    },
    {
      name: 'Merge',
      status: report.mergeable === false ? 'FAIL' : 'PASS',
      detail: report.mergeable === false ? 'Has merge conflicts' : 'No merge conflicts',
    },
    {
      name: 'Checks',
      status: pending.length > 0 ? 'WARN' : failing.length > 0 ? 'FAIL' : 'PASS',
      detail: pending.length > 0
        ? `${pending.length} pending`
        : failing.length > 0
          ? `${failing.length} failing`
          : `All ${report.checks.length} passed`,
    },
    {
      name: 'Approvals',
      status: validApprovalCount === 0 && report.decision !== 'READY_TO_MERGE' ? 'FAIL' : 'PASS',
      detail: `${validApprovalCount} valid approval(s)`,
    },
    {
      name: 'Risk',
      status: report.riskZone === 'black' ? 'FAIL' : report.riskZone === 'red' ? 'WARN' : 'PASS',
      detail: `Zone: ${report.riskZone.toUpperCase()}`,
    },
  ]

  return {
    prNumber: report.prNumber,
    title: sanitizeTerminalText(report.title),
    author: sanitizeTerminalText(report.author),
    state: sanitizeTerminalText(report.state),
    draft: report.draft,
    riskZone: sanitizeTerminalText(report.riskZone),
    mergeable: report.mergeable,
    decision: sanitizeTerminalText(report.decision),
    reason: sanitizeTerminalText(report.reason),
    recommendation: sanitizeTerminalText(report.recommendation),
    gates,
    checks: report.checks.map(c => ({
      name: sanitizeTerminalText(c.name),
      status: c.conclusion === 'success' || c.conclusion === 'neutral' || c.conclusion === 'skipped'
        ? 'PASS'
        : c.conclusion === null || c.status !== 'completed'
          ? 'WARN'
          : 'FAIL',
      conclusion: c.conclusion ?? sanitizeTerminalText(c.status),
    })),
    reviews: report.reviews.map(r => ({
      user: sanitizeTerminalText(r.user),
      state: sanitizeTerminalText(r.state),
      valid: report.humanApprovals.some(h => h.user === r.user),
    })),
    evidence: evidence.map(sanitizeTerminalText),
  }
}
