import { sanitizeTerminalText } from '../sanitize.js'

export interface ProfilePostViewModel {
  title: string
  date: string
  summary: string
  sourcePath: string
  url: string
}

export interface ProfileViewModel {
  title: string
  targetRepo: string
  targetPath: string
  marker: string
  syncStatus: 'synced' | 'pending' | 'failed' | 'never'
  lastSyncDate?: string
  lastPrUrl?: string
  posts: ProfilePostViewModel[]
  validationSummary: {
    total: number
    published: number
    failed: number
  }
}

export function mapProfileToViewModel(data?: {
  targetRepo?: string
  targetPath?: string
  marker?: string
  syncStatus?: 'synced' | 'pending' | 'failed' | 'never'
  lastSyncDate?: string
  lastPrUrl?: string
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
}): ProfileViewModel {
  const s = sanitizeTerminalText

  const posts = (data?.posts ?? []).map((p) => ({
    title: s(p.title),
    date: s(p.date),
    summary: s(p.summary),
    sourcePath: s(p.sourcePath),
    url: s(p.url),
  }))

  return {
    title: 'Organization Profile',
    targetRepo: s(data?.targetRepo ?? 'Negentropy-Laby/.github'),
    targetPath: s(data?.targetPath ?? 'profile/README.md'),
    marker: s(data?.marker ?? 'latest-insights'),
    syncStatus: data?.syncStatus ?? 'never',
    lastSyncDate: data?.lastSyncDate ? s(data.lastSyncDate) : undefined,
    lastPrUrl: data?.lastPrUrl ? s(data.lastPrUrl) : undefined,
    posts,
    validationSummary: {
      total: data?.validationSummary?.total ?? 0,
      published: data?.validationSummary?.published ?? 0,
      failed: data?.validationSummary?.failed ?? 0,
    },
  }
}
