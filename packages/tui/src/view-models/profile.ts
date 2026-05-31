import { sanitizeTerminalText } from '../sanitize.js'

export interface ProfilePostViewModel {
  title: string
  date: string
  summary: string
  sourcePath: string
  url: string
}

export interface ProfileActionViewModel {
  id: string
  key: string
  label: string
  description: string
  risk: 'low' | 'medium' | 'high'
}

export type ProfileSyncMode = 'manual' | 'watch' | 'auto-pr'

export interface ProfileSyncDetails {
  sourceCommit?: string
  sourceDate?: string
  targetHash?: string
  pendingPR?: {
    number: number
    status: string
  }
  lastSync?: {
    timestamp: string
    result: 'success' | 'failed' | 'unknown'
  }
  mode: ProfileSyncMode
}

export interface ProfileFailureDetails {
  reason: string
  nextAction: string
}

export interface ProfileViewModel {
  title: string
  targetRepo: string
  targetPath: string
  marker: string
  syncStatus: 'synced' | 'pending' | 'failed' | 'never'
  lastSyncDate?: string
  lastPrUrl?: string
  markerStatus: 'present' | 'missing' | 'unknown'
  pendingPR?: { number: number; url: string; branch: string }
  posts: ProfilePostViewModel[]
  validationSummary: {
    total: number
    published: number
    failed: number
  }
  syncDetails?: ProfileSyncDetails
  failureDetails?: ProfileFailureDetails
  mode: ProfileSyncMode
  diffOutput?: string
  actions: ProfileActionViewModel[]
  actionResult?: {
    actionId: string
    success: boolean
    message: string
  }
}

export function mapProfileToViewModel(data?: {
  targetRepo?: string
  targetPath?: string
  marker?: string
  syncStatus?: 'synced' | 'pending' | 'failed' | 'never'
  lastSyncDate?: string
  lastPrUrl?: string
  markerStatus?: 'present' | 'missing' | 'unknown'
  pendingPR?: { number: number; url: string; branch: string }
  posts?: Array<{
    title: string
    date: string
    summary: string
    sourcePath: string
    url: string
  }>
  validationSummary?: {
    total: number
    published: number
    failed: number
  }
  syncDetails?: ProfileSyncDetails
  failureDetails?: ProfileFailureDetails
  mode?: ProfileSyncMode
  diffOutput?: string
  actionResult?: {
    actionId: string
    success: boolean
    message: string
  }
}): ProfileViewModel {
  const s = sanitizeTerminalText

  const posts = (data?.posts ?? []).map((p) => ({
    title: s(p.title),
    date: s(p.date),
    summary: s(p.summary),
    sourcePath: s(p.sourcePath),
    url: s(p.url),
  }))

  const actions: ProfileActionViewModel[] = [
    { id: 'check', key: 'c', label: 'Check', description: 'Check sync readiness', risk: 'low' },
    { id: 'preview', key: 'p', label: 'Preview', description: 'Preview diff patch', risk: 'low' },
    { id: 'dryrun', key: 'd', label: 'Dry-run', description: 'Simulate sync run', risk: 'low' },
    { id: 'create-pr', key: 'r', label: 'Create PR', description: 'Run profile sync and create PR', risk: 'medium' },
    { id: 'open-pr', key: 'o', label: 'Open PR', description: 'Open pending PR in browser', risk: 'low' },
    { id: 'failure-issue', key: 'i', label: 'Failure Issue', description: 'Create failure issue', risk: 'low' },
  ]

  return {
    title: 'Organization Profile',
    targetRepo: s(data?.targetRepo ?? 'Negentropy-Laby/.github'),
    targetPath: s(data?.targetPath ?? 'profile/README.md'),
    marker: s(data?.marker ?? 'latest-insights'),
    syncStatus: data?.syncStatus ?? 'never',
    lastSyncDate: data?.lastSyncDate ? s(data.lastSyncDate) : undefined,
    lastPrUrl: data?.lastPrUrl ? s(data.lastPrUrl) : undefined,
    markerStatus: data?.markerStatus ?? 'unknown',
    pendingPR: data?.pendingPR
      ? {
          number: data.pendingPR.number,
          url: s(data.pendingPR.url),
          branch: s(data.pendingPR.branch),
        }
      : undefined,
    posts,
    validationSummary: {
      total: data?.validationSummary?.total ?? 0,
      published: data?.validationSummary?.published ?? 0,
      failed: data?.validationSummary?.failed ?? 0,
    },
    syncDetails: data?.syncDetails
      ? {
          sourceCommit: data.syncDetails.sourceCommit ? s(data.syncDetails.sourceCommit) : undefined,
          sourceDate: data.syncDetails.sourceDate ? s(data.syncDetails.sourceDate) : undefined,
          targetHash: data.syncDetails.targetHash ? s(data.syncDetails.targetHash) : undefined,
          pendingPR: data.syncDetails.pendingPR
            ? { number: data.syncDetails.pendingPR.number, status: s(data.syncDetails.pendingPR.status) }
            : undefined,
          lastSync: data.syncDetails.lastSync
            ? { timestamp: s(data.syncDetails.lastSync.timestamp), result: data.syncDetails.lastSync.result }
            : undefined,
          mode: data.syncDetails.mode,
        }
      : undefined,
    failureDetails: data?.failureDetails
      ? {
          reason: s(data.failureDetails.reason),
          nextAction: s(data.failureDetails.nextAction),
        }
      : undefined,
    mode: data?.mode ?? 'manual',
    diffOutput: data?.diffOutput ? s(data.diffOutput) : undefined,
    actions,
    actionResult: data?.actionResult,
  }
}
