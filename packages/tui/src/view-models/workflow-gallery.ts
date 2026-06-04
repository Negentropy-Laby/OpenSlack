import { sanitizeTerminalText } from '../sanitize.js'

export type WorkflowGalleryFormat =
  | 'openslack-native'
  | 'claude-ambient'
  | 'anthropic-compatible'
  | 'yaml'
  | string

export interface WorkflowGalleryItem {
  name: string
  description: string
  format: WorkflowGalleryFormat
  trustLevel: string
  risk: string
  phases: number
  lastRunStatus?: string
}

export interface WorkflowStartPatternItem {
  id: string
  name: string
  description: string
}

export interface WorkflowGalleryViewModel {
  workflows: WorkflowGalleryItem[]
  patterns?: WorkflowStartPatternItem[]
  summary: {
    total: number
    yaml: number
    js: number
  }
}

export function mapWorkflowGalleryToViewModel(data?: {
  workflows?: Array<{
    name: string
    description?: string
    format?: WorkflowGalleryFormat
    trustLevel?: string
    risk?: string
    phases?: number
    lastRunStatus?: string
  }>
  patterns?: Array<{
    id: string
    name: string
    description?: string
  }>
}): WorkflowGalleryViewModel {
  const s = sanitizeTerminalText

  const workflows: WorkflowGalleryItem[] = (data?.workflows ?? []).map(wf => ({
    name: s(wf.name),
    description: s(wf.description ?? ''),
    format: wf.format ?? 'yaml',
    trustLevel: s(wf.trustLevel ?? 'untrusted'),
    risk: s(wf.risk ?? 'unknown'),
    phases: wf.phases ?? 0,
    lastRunStatus: wf.lastRunStatus ? s(wf.lastRunStatus) : undefined,
  }))

  return {
    workflows,
    patterns: (data?.patterns ?? []).map((pattern) => ({
      id: s(pattern.id),
      name: s(pattern.name),
      description: s(pattern.description ?? ''),
    })),
    summary: {
      total: workflows.length,
      yaml: workflows.filter(w => w.format === 'yaml').length,
      js: workflows.filter(w => w.format !== 'yaml').length,
    },
  }
}

export interface WorkflowDetailViewModel {
  name: string
  description: string
  format: 'yaml' | 'js'
  trustLevel: string
  risk: string
  phases: Array<{ title: string; detail: string }>
  permissions: string[]
  inputs: string[]
}

export function mapWorkflowDetailToViewModel(data: {
  name: string
  description?: string
  format?: 'yaml' | 'js'
  trustLevel?: string
  risk?: string
  phases?: Array<{ title: string; detail?: string }>
  permissions?: string[]
  inputs?: Array<{ name: string }>
}): WorkflowDetailViewModel {
  const s = sanitizeTerminalText

  return {
    name: s(data.name),
    description: s(data.description ?? ''),
    format: data.format ?? 'yaml',
    trustLevel: s(data.trustLevel ?? 'untrusted'),
    risk: s(data.risk ?? 'unknown'),
    phases: (data.phases ?? []).map(p => ({
      title: s(p.title),
      detail: s(p.detail ?? ''),
    })),
    permissions: (data.permissions ?? []).map(s),
    inputs: (data.inputs ?? []).map(i => s(i.name)),
  }
}
