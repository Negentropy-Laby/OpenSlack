import { createHash } from 'node:crypto'
import type { WorkflowMeta, WorkflowPhase } from './types.js'

const NAME_PATTERN = /^[a-z][a-z0-9-]*$/
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/
const SIDE_EFFECT_PATTERN = /^[a-zA-Z_*]+\.[a-zA-Z_*]+\.[a-zA-Z_*]+$/

/**
 * Parse an unknown value into a WorkflowMeta, applying structural defaults.
 * Returns a normalized WorkflowMeta or throws on structural issues.
 */
export function parseManifest(raw: unknown): WorkflowMeta {
  if (raw === null || raw === undefined || typeof raw !== 'object') {
    throw new Error('Manifest must be a non-null object')
  }

  const obj = raw as Record<string, unknown>

  // Required string fields
  if (typeof obj.name !== 'string' || obj.name.length === 0) {
    throw new Error('Manifest "name" must be a non-empty string')
  }
  if (typeof obj.description !== 'string' || obj.description.length === 0) {
    throw new Error('Manifest "description" must be a non-empty string')
  }

  // Phases
  if (!Array.isArray(obj.phases) || obj.phases.length === 0) {
    throw new Error('Manifest "phases" must be a non-empty array')
  }

  const phases: WorkflowPhase[] = obj.phases.map((p: unknown, i: number) => {
    if (p === null || typeof p !== 'object') {
      throw new Error(`Phase at index ${i} must be an object`)
    }
    const phase = p as Record<string, unknown>
    if (typeof phase.title !== 'string' || phase.title.length === 0) {
      throw new Error(`Phase at index ${i} must have a non-empty "title"`)
    }
    if (typeof phase.detail !== 'string') {
      throw new Error(`Phase at index ${i} must have a string "detail"`)
    }
    return { title: phase.title, detail: phase.detail }
  })

  const meta: WorkflowMeta = {
    name: obj.name,
    description: obj.description,
    phases,
  }

  // Optional string fields
  if (obj.version !== undefined) {
    if (typeof obj.version !== 'string') {
      throw new Error('Manifest "version" must be a string')
    }
    meta.version = obj.version
  }

  if (obj.whenToUse !== undefined) {
    if (typeof obj.whenToUse !== 'string') {
      throw new Error('Manifest "whenToUse" must be a string')
    }
    meta.whenToUse = obj.whenToUse
  }

  if (obj.dynamicPattern !== undefined) {
    if (typeof obj.dynamicPattern !== 'string') {
      throw new Error('Manifest "dynamicPattern" must be a string')
    }
    meta.dynamicPattern = obj.dynamicPattern
  }

  // Optional risk
  if (obj.risk !== undefined) {
    if (obj.risk !== 'low' && obj.risk !== 'medium' && obj.risk !== 'high') {
      throw new Error('Manifest "risk" must be "low", "medium", or "high"')
    }
    meta.risk = obj.risk
  }

  // Optional inputs
  if (obj.inputs !== undefined) {
    if (typeof obj.inputs !== 'object' || obj.inputs === null) {
      throw new Error('Manifest "inputs" must be an object')
    }
    meta.inputs = obj.inputs as Record<string, { type: 'string' | 'number' | 'boolean'; default?: unknown; description: string }>
  }

  // Optional permissions
  if (obj.permissions !== undefined) {
    if (typeof obj.permissions !== 'object' || obj.permissions === null) {
      throw new Error('Manifest "permissions" must be an object')
    }
    meta.permissions = obj.permissions as { github?: string[]; git?: string[]; filesystem?: string[]; openslack?: string[] }
  }

  // Optional sideEffects
  if (obj.sideEffects !== undefined) {
    if (!Array.isArray(obj.sideEffects)) {
      throw new Error('Manifest "sideEffects" must be an array')
    }
    meta.sideEffects = obj.sideEffects as string[]
  }

  // Optional forbidden
  if (obj.forbidden !== undefined) {
    if (!Array.isArray(obj.forbidden)) {
      throw new Error('Manifest "forbidden" must be an array')
    }
    meta.forbidden = obj.forbidden as string[]
  }

  if (obj.modelRouting !== undefined) {
    if (typeof obj.modelRouting !== 'object' || obj.modelRouting === null) {
      throw new Error('Manifest "modelRouting" must be an object')
    }
    meta.modelRouting = obj.modelRouting as Record<string, string>
  }

  if (obj.isolationPolicy !== undefined) {
    if (typeof obj.isolationPolicy !== 'object' || obj.isolationPolicy === null) {
      throw new Error('Manifest "isolationPolicy" must be an object')
    }
    meta.isolationPolicy = obj.isolationPolicy as Record<string, 'none' | 'worktree'>
  }

  if (obj.budgetPolicy !== undefined) {
    if (typeof obj.budgetPolicy !== 'object' || obj.budgetPolicy === null) {
      throw new Error('Manifest "budgetPolicy" must be an object')
    }
    meta.budgetPolicy = obj.budgetPolicy as WorkflowMeta['budgetPolicy']
  }

  return meta
}

/**
 * Validate a parsed WorkflowMeta, returning an array of error strings.
 * Returns an empty array if valid.
 */
export function validateManifest(meta: WorkflowMeta): string[] {
  const errors: string[] = []

  // Name pattern
  if (!NAME_PATTERN.test(meta.name)) {
    errors.push(`Manifest "name" must match ${NAME_PATTERN.source}`)
  }

  // Version semver
  if (meta.version !== undefined && !SEMVER_PATTERN.test(meta.version)) {
    errors.push('Manifest "version" must be a valid semver string (e.g. "1.0.0")')
  }

  // Phases
  if (!Array.isArray(meta.phases) || meta.phases.length === 0) {
    errors.push('Manifest must have at least one phase')
  } else {
    for (const [i, phase] of meta.phases.entries()) {
      if (typeof phase.title !== 'string' || phase.title.length === 0) {
        errors.push(`Phase ${i} must have a non-empty "title"`)
      }
      if (typeof phase.detail !== 'string') {
        errors.push(`Phase ${i} must have a string "detail"`)
      }
    }
  }

  // Side effects pattern
  if (meta.sideEffects) {
    for (const se of meta.sideEffects) {
      if (typeof se !== 'string' || !SIDE_EFFECT_PATTERN.test(se)) {
        errors.push(`Side effect "${se}" must match pattern *.scope.action`)
      }
    }
  }

  // Forbidden entries
  if (meta.forbidden) {
    for (const f of meta.forbidden) {
      if (typeof f !== 'string' || f.length === 0) {
        errors.push(`Forbidden entry must be a non-empty string`)
      }
    }
  }

  // Permissions must have string array values
  if (meta.permissions) {
    for (const [cat, actions] of Object.entries(meta.permissions)) {
      if (!Array.isArray(actions)) {
        errors.push(`Permissions category "${cat}" must be an array`)
      } else {
        for (const action of actions) {
          if (typeof action !== 'string') {
            errors.push(`Permission action in "${cat}" must be a string`)
          }
        }
      }
    }
  }

  // Inputs validation
  if (meta.inputs) {
    for (const [key, input] of Object.entries(meta.inputs)) {
      if (input.type !== 'string' && input.type !== 'number' && input.type !== 'boolean') {
        errors.push(`Input "${key}" type must be "string", "number", or "boolean"`)
      }
      if (typeof input.description !== 'string') {
        errors.push(`Input "${key}" must have a string "description"`)
      }
    }
  }

  return errors
}

/**
 * Compute a deterministic SHA-256 hash of the manifest for cache/integrity checks.
 * Returns the first 16 hex characters.
 */
export function computeManifestHash(meta: WorkflowMeta): string {
  const sortedKeys = Object.keys(meta).sort()
  const canonical = JSON.stringify(meta, sortedKeys)
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16)
}
