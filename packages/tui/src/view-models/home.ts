import { sanitizeTerminalText } from '../sanitize.js'

export interface HomeViewModel {
  menuItems: Array<{
    label: string
    key: string
    badge?: string
  }>
  systemStatus: string
}

export function mapHomeToViewModel(data?: {
  systemStatus?: string
}): HomeViewModel {
  const s = sanitizeTerminalText

  const menuItems: HomeViewModel['menuItems'] = [
    { label: 'Dashboard', key: 'dashboard', badge: 'collaboration overview' },
    { label: 'PRs', key: 'pr-queue' },
    { label: 'Workflows', key: 'workflows' },
    { label: 'Approvals', key: 'approvals' },
    { label: 'Status', key: 'status' },
    { label: 'Activity', key: 'activity' },
  ]

  return {
    menuItems,
    systemStatus: s(data?.systemStatus ?? 'ready'),
  }
}
