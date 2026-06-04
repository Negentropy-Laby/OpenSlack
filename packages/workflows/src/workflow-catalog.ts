import type { WorkflowPatternManifest } from './types.js'
import { getWorkflowPattern } from './pattern-registry.js'

export interface WorkflowCatalogEntry {
  id: string
  name: string
  description: string
  pattern: string
  risk: 'low' | 'medium' | 'high'
  prompt: string
  appropriateFor: string[]
  notFor: string[]
  requiredEvidence: string[]
  defaultInputs: Record<string, unknown>
}

const CATALOG: WorkflowCatalogEntry[] = [
  {
    id: 'deep-research',
    name: 'Deep Research',
    description: 'Parallel research with citation-backed synthesis.',
    pattern: 'fanout-synthesize',
    risk: 'low',
    prompt: 'deep research with independent source collection and citation-backed synthesis',
    appropriateFor: ['cross-checked research', 'external claim verification', 'design background analysis'],
    notFor: ['single source lookup', 'quick status question'],
    requiredEvidence: ['citations', 'source summaries', 'synthesis decision'],
    defaultInputs: { scope: '.', objective: 'Produce cited research findings.' },
  },
  {
    id: 'codebase-audit',
    name: 'Codebase Audit',
    description: 'Fan out over files or packages, then synthesize findings.',
    pattern: 'fanout-synthesize',
    risk: 'low',
    prompt: 'audit the codebase across multiple packages and synthesize file-backed findings',
    appropriateFor: ['multi-package audits', 'regression sweeps', 'API endpoint review'],
    notFor: ['one-file typo fix'],
    requiredEvidence: ['file paths', 'phase summaries', 'finding severity'],
    defaultInputs: { scope: 'packages', objective: 'Find codebase-wide risks.' },
  },
  {
    id: 'pr-deep-verification',
    name: 'PR Deep Verification',
    description: 'Adversarially verify pull-request findings with file and line evidence.',
    pattern: 'adversarial-verification',
    risk: 'medium',
    prompt: 'deep verify a pull request with adversarial reviewers and file line evidence',
    appropriateFor: ['high-risk PR review', 'PRMS gate validation', 'multi-reviewer verification'],
    notFor: ['format-only PRs'],
    requiredEvidence: ['file/line references', 'verifier verdicts', 'PRMS gate summary'],
    defaultInputs: { scope: 'pr', objective: 'Verify PR findings before merge.' },
  },
  {
    id: 'issue-triage',
    name: 'Issue Triage',
    description: 'Classify issues, route them to actions, and summarize next steps.',
    pattern: 'classify-and-act',
    risk: 'low',
    prompt: 'triage multiple issues and route each issue by category and urgency',
    appropriateFor: ['issue queues', 'support triage', 'label review'],
    notFor: ['single known issue fix'],
    requiredEvidence: ['classification', 'recommended action', 'routing reason'],
    defaultInputs: { scope: 'issues', objective: 'Classify and route issues.' },
  },
  {
    id: 'root-cause',
    name: 'Root Cause',
    description: 'Loop bounded investigation until a root-cause stop condition is met.',
    pattern: 'loop-until-done',
    risk: 'medium',
    prompt: 'root-cause investigation with bounded loop until no new causal evidence appears',
    appropriateFor: ['failing test investigation', 'incident analysis', 'unknown regression source'],
    notFor: ['known small fix'],
    requiredEvidence: ['hypotheses', 'eliminated causes', 'stop condition'],
    defaultInputs: { scope: '.', objective: 'Find root cause with bounded iterations.' },
  },
  {
    id: 'rule-mining',
    name: 'Rule Mining',
    description: 'Find recurring rules or memory adherence issues across artifacts.',
    pattern: 'generate-filter',
    risk: 'low',
    prompt: 'mine recurring rules and adherence evidence from many project artifacts',
    appropriateFor: ['memory/rule audits', 'policy consistency review', 'prompt guidance cleanup'],
    notFor: ['one document rewrite'],
    requiredEvidence: ['candidate rules', 'dedupe result', 'kept rules'],
    defaultInputs: { scope: 'docs', objective: 'Mine durable project rules.' },
  },
  {
    id: 'refactor-migration',
    name: 'Refactor Migration',
    description: 'Plan and verify a broad migration with worktree-isolated implementer phases.',
    pattern: 'model-router',
    risk: 'high',
    prompt: 'large refactor migration requiring worktree isolation and verifier phases',
    appropriateFor: ['large migrations', 'cross-package refactors', 'compatibility cutovers'],
    notFor: ['single-file rename'],
    requiredEvidence: ['worktree isolation', 'migration plan', 'verifier phase'],
    defaultInputs: { scope: 'packages', objective: 'Plan a migration without direct merge.' },
  },
  {
    id: 'tournament-decision',
    name: 'Tournament Decision',
    description: 'Compare alternatives pairwise until a winning strategy remains.',
    pattern: 'tournament',
    risk: 'low',
    prompt: 'compare implementation alternatives in a tournament and select the best strategy',
    appropriateFor: ['architecture alternatives', 'naming choices', 'strategy selection'],
    notFor: ['deterministic command execution'],
    requiredEvidence: ['bracket', 'judge criteria', 'winner rationale'],
    defaultInputs: { scope: 'alternatives', objective: 'Select the best alternative.' },
  },
  {
    id: 'eval-runner',
    name: 'Eval Runner',
    description: 'Generate, filter, and summarize evaluation cases.',
    pattern: 'generate-filter',
    risk: 'medium',
    prompt: 'generate and filter evaluation cases, then summarize quality and coverage',
    appropriateFor: ['golden eval expansion', 'regression test design', 'scenario coverage'],
    notFor: ['single unit test fix'],
    requiredEvidence: ['generated cases', 'filter rubric', 'coverage summary'],
    defaultInputs: { scope: 'evals', objective: 'Produce filtered eval cases.' },
  },
  {
    id: 'model-router',
    name: 'Model Router',
    description: 'Route tasks by model tier and worktree isolation needs.',
    pattern: 'model-router',
    risk: 'low',
    prompt: 'route workflow tasks by model tier and isolation policy',
    appropriateFor: ['mixed scan/verify/implement plans', 'cost-aware workflow design', 'isolation review'],
    notFor: ['single direct action'],
    requiredEvidence: ['model route', 'isolation route', 'routing reason'],
    defaultInputs: { scope: '.', objective: 'Route tasks by cost and isolation.' },
  },
]

export function listWorkflowCatalog(): WorkflowCatalogEntry[] {
  return [...CATALOG]
}

export function getWorkflowCatalogEntry(id: string): WorkflowCatalogEntry | undefined {
  return CATALOG.find((entry) => entry.id === id)
}

export function getWorkflowCatalogPattern(entry: WorkflowCatalogEntry): WorkflowPatternManifest {
  const pattern = getWorkflowPattern(entry.pattern)
  if (!pattern) throw new Error(`Catalog entry ${entry.id} references unknown pattern ${entry.pattern}`)
  return pattern
}

export function renderWorkflowCatalogList(entries = listWorkflowCatalog()): string {
  return [
    '| Catalog | Pattern | Risk | Description |',
    '|---------|---------|------|-------------|',
    ...entries.map((entry) => `| ${entry.id} | ${entry.pattern} | ${entry.risk} | ${entry.description} |`),
  ].join('\n')
}

export function renderWorkflowCatalogEntry(entry: WorkflowCatalogEntry): string {
  const lines: string[] = []
  lines.push(`Catalog: ${entry.id}`)
  lines.push(`Name: ${entry.name}`)
  lines.push(`Pattern: ${entry.pattern}`)
  lines.push(`Risk: ${entry.risk}`)
  lines.push(`Description: ${entry.description}`)
  lines.push('')
  lines.push('Appropriate for:')
  for (const item of entry.appropriateFor) lines.push(`  - ${item}`)
  lines.push('')
  lines.push('Not for:')
  for (const item of entry.notFor) lines.push(`  - ${item}`)
  lines.push('')
  lines.push('Required evidence:')
  for (const item of entry.requiredEvidence) lines.push(`  - ${item}`)
  return lines.join('\n')
}
