import { sanitizeTerminalText } from '../sanitize.js'

export interface IssueItem {
  number: number
  title: string
  status: 'ready' | 'claimed' | 'running' | 'blocked' | 'review' | 'stale'
  assignee?: string
  labels: string[]
}

export interface PrItem {
  number: number
  title: string
  status: 'ready' | 'blocked' | 'pending' | 'checking'
  author: string
  riskZone: string
  blocker?: string
  nextAction?: string
}

export interface IssuesPrViewModel {
  tab: 'issues' | 'prs'
  issues: IssueItem[]
  prs: PrItem[]
  summary: {
    issues: { total: number; ready: number; claimed: number; blocked: number }
    prs: { total: number; ready: number; blocked: number; pending: number }
  }
}

export function mapIssuesPrToViewModel(data?: {
  issues?: Array<{
    number: number
    title: string
    status?: IssueItem['status']
    assignee?: string
    labels?: string[]
  }>
  prs?: Array<{
    number: number
    title: string
    status?: PrItem['status']
    author?: string
    riskZone?: string
    blocker?: string
    nextAction?: string
  }>
  tab?: 'issues' | 'prs'
}): IssuesPrViewModel {
  const s = sanitizeTerminalText

  const issues: IssueItem[] = (data?.issues ?? []).map(issue => ({
    number: issue.number,
    title: s(issue.title),
    status: issue.status ?? 'ready',
    assignee: issue.assignee ? s(issue.assignee) : undefined,
    labels: (issue.labels ?? []).map(s),
  }))

  const prs: PrItem[] = (data?.prs ?? []).map(pr => ({
    number: pr.number,
    title: s(pr.title),
    status: pr.status ?? 'pending',
    author: s(pr.author ?? ''),
    riskZone: s(pr.riskZone ?? 'unknown'),
    blocker: pr.blocker ? s(pr.blocker) : undefined,
    nextAction: pr.nextAction ? s(pr.nextAction) : undefined,
  }))

  return {
    tab: data?.tab ?? 'prs',
    issues,
    prs,
    summary: {
      issues: {
        total: issues.length,
        ready: issues.filter(i => i.status === 'ready').length,
        claimed: issues.filter(i => i.status === 'claimed').length,
        blocked: issues.filter(i => i.status === 'blocked').length,
      },
      prs: {
        total: prs.length,
        ready: prs.filter(p => p.status === 'ready').length,
        blocked: prs.filter(p => p.status === 'blocked').length,
        pending: prs.filter(p => p.status === 'pending').length,
      },
    },
  }
}
