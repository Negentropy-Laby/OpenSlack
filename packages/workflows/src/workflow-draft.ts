import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { loadWorkflow } from './loader.js'
import { ALWAYS_FORBIDDEN } from './manifest-validator.js'
import { getWorkflowPattern } from './pattern-registry.js'
import type {
  WorkflowBudgetPolicy,
  WorkflowDraft,
  WorkflowDraftPreview,
  WorkflowMeta,
  WorkflowPatternManifest,
} from './types.js'

export interface GenerateWorkflowDraftOptions {
  prompt: string
  pattern?: string
  inputs?: Record<string, unknown>
  rootDir?: string
  draftId?: string
}

export interface PreviewWorkflowDraftOptions {
  draftIdOrPath: string
  rootDir?: string
}

function slugify(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 42)
  return slug || 'dynamic-workflow'
}

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16)
}

function selectPattern(prompt: string, requested?: string): WorkflowPatternManifest {
  if (requested) {
    const found = getWorkflowPattern(requested)
    if (!found) throw new Error(`Unknown workflow pattern: ${requested}`)
    return found
  }
  const q = prompt.toLowerCase()
  const inferred = q.includes('tournament') || q.includes('compare')
    ? 'tournament'
    : q.includes('triage') || q.includes('classify')
      ? 'classify-and-act'
      : q.includes('verify') || q.includes('review') || q.includes('audit')
        ? 'adversarial-verification'
        : q.includes('loop') || q.includes('until')
          ? 'loop-until-done'
          : q.includes('model')
            ? 'model-router'
            : q.includes('generate') || q.includes('filter')
              ? 'generate-filter'
              : 'fanout-synthesize'
  return getWorkflowPattern(inferred)!
}

function createManifest(prompt: string, pattern: WorkflowPatternManifest): WorkflowMeta {
  const name = `draft-${slugify(prompt)}`
  const budgetPolicy: WorkflowBudgetPolicy = {
    tokenBudget: 100000,
    maxAgents: pattern.id === 'loop-until-done' ? 100 : 1000,
    maxConcurrency: 16,
    onExceeded: 'pause',
  }
  return {
    name,
    version: '0.1.0',
    description: `Dynamic workflow draft for: ${prompt}`,
    dynamicPattern: pattern.id,
    whenToUse: `Use when the task benefits from the ${pattern.name} pattern and independent evidence collection.`,
    phases: pattern.phases,
    inputs: {
      scope: { type: 'string', description: 'Scope for the workflow run', default: '.' },
      objective: { type: 'string', description: 'Human-readable objective', default: prompt },
    },
    permissions: {
      filesystem: ['read'],
      openslack: ['collaboration.recordEvent'],
    },
    sideEffects: [],
    forbidden: [...ALWAYS_FORBIDDEN],
    risk: pattern.defaultRisk,
    modelRouting: {
      classify: 'cheap',
      verify: 'strong',
      synthesize: 'strong',
    },
    isolationPolicy: {
      scan: 'none',
      verify: 'none',
      implement: 'worktree',
    },
    budgetPolicy,
  }
}

function renderScript(meta: WorkflowMeta, prompt: string, pattern: WorkflowPatternManifest): string {
  return `export const meta = ${JSON.stringify(meta, null, 2)}

export async function preview(ctx, args) {
  ctx.phase(${JSON.stringify(meta.phases[0].title)})
  ctx.log('Dynamic workflow draft preview only. No side effects are performed.')
  return {
    preview: true,
    pattern: ${JSON.stringify(pattern.id)},
    prompt: ${JSON.stringify(prompt)},
    objective: args.objective ?? ${JSON.stringify(prompt)},
    phasePlan: meta.phases,
    budgetPolicy: meta.budgetPolicy
  }
}

export async function run(ctx, args) {
  ctx.phase(${JSON.stringify(meta.phases[0].title)})
  const route = ctx.workflow.routeModelAndIsolation({
    label: ${JSON.stringify(pattern.id)},
    purpose: ${JSON.stringify(pattern.description)},
    write: false
  })
  return {
    status: 'completed',
    pattern: ${JSON.stringify(pattern.id)},
    objective: args.objective ?? ${JSON.stringify(prompt)},
    route,
    note: 'This generated draft is a safe scaffold. Add task-specific agent calls before relying on execute mode.'
  }
}
`
}

export async function generateWorkflowDraft(options: GenerateWorkflowDraftOptions): Promise<WorkflowDraft> {
  const prompt = options.prompt.trim()
  if (!prompt) throw new Error('Workflow draft generation requires --prompt')
  const rootDir = options.rootDir ?? process.cwd()
  const pattern = selectPattern(prompt, options.pattern)
  const manifest = createManifest(prompt, pattern)
  const script = renderScript(manifest, prompt, pattern)
  const draftId = options.draftId ?? `${manifest.name}-${Date.now().toString(36)}`
  const dir = resolve(rootDir, '.openslack', 'workflows', 'drafts')
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${draftId}.mjs`)
  await writeFile(path, script, 'utf-8')
  return {
    draftId,
    path,
    prompt,
    pattern: pattern.id,
    manifest,
    scriptHash: hash(script),
    createdAt: new Date().toISOString(),
  }
}

export async function previewWorkflowDraft(options: PreviewWorkflowDraftOptions): Promise<WorkflowDraftPreview> {
  const rootDir = options.rootDir ?? process.cwd()
  const path = options.draftIdOrPath.includes('/') || options.draftIdOrPath.includes('\\')
    ? resolve(rootDir, options.draftIdOrPath)
    : resolve(rootDir, '.openslack', 'workflows', 'drafts', `${options.draftIdOrPath}.mjs`)
  const source = await readFile(path, 'utf-8')
  const loaded = await loadWorkflow(path)
  const draft: WorkflowDraft = {
    draftId: path.split(/[\\/]/).pop()?.replace(/\.(mjs|js|ts)$/, '') ?? 'draft',
    path,
    prompt: loaded.meta.description.replace(/^Dynamic workflow draft for:\s*/, ''),
    pattern: loaded.meta.dynamicPattern ?? 'fanout-synthesize',
    manifest: loaded.meta,
    scriptHash: hash(source),
    createdAt: new Date().toISOString(),
  }
  return {
    draft,
    phasePlan: loaded.meta.phases,
    requiredPermissions: loaded.meta.permissions ?? {},
    sideEffects: loaded.meta.sideEffects ?? [],
    budgetEstimate: loaded.meta.budgetPolicy ?? { tokenBudget: 100000, maxAgents: 1000, maxConcurrency: 16, onExceeded: 'pause' },
    trustRequirement: (loaded.meta.sideEffects?.length ?? 0) > 0 ? 'trusted' : 'untrusted',
  }
}

export function renderWorkflowDraftPreview(preview: WorkflowDraftPreview): string {
  const lines: string[] = []
  lines.push(`Draft: ${preview.draft.draftId}`)
  lines.push(`Pattern: ${preview.draft.pattern}`)
  lines.push(`Path: ${preview.draft.path}`)
  lines.push(`Hash: ${preview.draft.scriptHash}`)
  lines.push(`Trust: ${preview.trustRequirement}`)
  lines.push(`Budget: ${preview.budgetEstimate.tokenBudget ?? 'unlimited'} tokens, max agents ${preview.budgetEstimate.maxAgents ?? 'default'}, concurrency ${preview.budgetEstimate.maxConcurrency ?? 'default'}`)
  lines.push('')
  lines.push('Phases:')
  for (const phase of preview.phasePlan) lines.push(`  - ${phase.title}: ${phase.detail}`)
  lines.push('')
  lines.push(`Side effects: ${preview.sideEffects.length > 0 ? preview.sideEffects.join(', ') : 'none declared'}`)
  return lines.join('\n')
}
