import { sanitizeTerminalText } from '../sanitize.js'

export interface StatusViewModel {
  title: string
  version: string
  commit: string
  commitSubject: string
  modules: Array<{
    name: string
    status: string
    tests: number | null
  }>
  gitHub: {
    available: boolean
    tasksReady: number
    tasksClaimed: number
    tasksBlocked: number
    prsOpen: number
    prsBlocked: number
    prsReady: number
  }
  testSuite: {
    totalTests: number
    totalFiles: number
  }
  recommendations: Array<{
    title: string
    action: string
    command: string | null
  }>
  attentionItems: Array<{
    type: string
    description: string
    action: string
    priority: 'high' | 'medium' | 'low'
  }>
  nextAction: string
}

export function mapStatusToViewModel(data: {
  commit: string
  commitSubject: string
  modules: Array<{ name: string; status: string; tests?: number }>
  gitHub: {
    available: boolean
    tasksReady: number
    tasksClaimed: number
    tasksBlocked: number
    prsOpen: number
    prsBlocked: number
    prsReady: number
  }
  testSuite: { totalTests: number; totalFiles: number }
  recommendations: Array<{ title: string; action: string; command?: string }>
  attentionItems: Array<{
    type: string
    description: string
    action: string
    priority: 'high' | 'medium' | 'low'
  }>
  nextAction: string
}): StatusViewModel {
  const s = sanitizeTerminalText

  return {
    title: 'OpenSlack Status',
    version: 'v0.1 Developer Preview',
    commit: s(data.commit),
    commitSubject: s(data.commitSubject),
    modules: data.modules.map(m => ({
      name: s(m.name),
      status: s(m.status),
      tests: m.tests ?? null,
    })),
    gitHub: data.gitHub,
    testSuite: data.testSuite,
    recommendations: data.recommendations.map(r => ({
      title: s(r.title),
      action: s(r.action),
      command: r.command ? s(r.command) : null,
    })),
    attentionItems: data.attentionItems.map(a => ({
      type: s(a.type),
      description: s(a.description),
      action: s(a.action),
      priority: a.priority,
    })),
    nextAction: s(data.nextAction),
  }
}
