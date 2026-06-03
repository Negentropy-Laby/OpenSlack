import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parse, stringify } from 'yaml'
import type { WorkflowDisablePolicy } from './types.js'

export interface WorkflowPolicyOptions {
  rootDir?: string
}

const DEFAULT_POLICY: WorkflowDisablePolicy = {
  enabled: true,
  ultracode: false,
  maxConcurrency: 16,
  maxAgentsPerRun: 1000,
  source: 'default',
}

function configPath(rootDir: string): string {
  return resolve(rootDir, '.openslack', 'workflows', 'config.yaml')
}

function normalize(raw: unknown, source: WorkflowDisablePolicy['source']): WorkflowDisablePolicy {
  const obj = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const workflows = obj.workflows && typeof obj.workflows === 'object'
    ? obj.workflows as Record<string, unknown>
    : obj
  return {
    enabled: typeof workflows.enabled === 'boolean' ? workflows.enabled : DEFAULT_POLICY.enabled,
    ultracode: typeof workflows.ultracode === 'boolean' ? workflows.ultracode : DEFAULT_POLICY.ultracode,
    maxConcurrency: typeof workflows.max_concurrency === 'number' ? workflows.max_concurrency : DEFAULT_POLICY.maxConcurrency,
    maxAgentsPerRun: typeof workflows.max_agents_per_run === 'number' ? workflows.max_agents_per_run : DEFAULT_POLICY.maxAgentsPerRun,
    source,
    reason: typeof workflows.reason === 'string' ? workflows.reason : undefined,
  }
}

export function readWorkflowPolicy(options: WorkflowPolicyOptions = {}): WorkflowDisablePolicy {
  if (process.env.OPENSLACK_DISABLE_WORKFLOWS === '1') {
    return { ...DEFAULT_POLICY, enabled: false, source: 'env', reason: 'OPENSLACK_DISABLE_WORKFLOWS=1' }
  }
  const rootDir = options.rootDir ?? process.cwd()
  const path = configPath(rootDir)
  if (!existsSync(path)) return { ...DEFAULT_POLICY }
  const parsed = parse(readFileSync(path, 'utf-8'))
  return normalize(parsed, 'project')
}

export function writeWorkflowPolicy(
  policy: Partial<WorkflowDisablePolicy>,
  options: WorkflowPolicyOptions = {},
): WorkflowDisablePolicy {
  const rootDir = options.rootDir ?? process.cwd()
  const current = readWorkflowPolicy({ rootDir })
  const next: WorkflowDisablePolicy = {
    ...current,
    ...policy,
    source: 'project',
  }
  const path = configPath(rootDir)
  mkdirSync(join(rootDir, '.openslack', 'workflows'), { recursive: true })
  writeFileSync(path, stringify({
    workflows: {
      enabled: next.enabled,
      ultracode: next.ultracode,
      max_concurrency: next.maxConcurrency,
      max_agents_per_run: next.maxAgentsPerRun,
      ...(next.reason ? { reason: next.reason } : {}),
    },
  }), 'utf-8')
  return next
}

export function renderWorkflowPolicy(policy: WorkflowDisablePolicy): string {
  return [
    'Workflow Policy',
    `  Enabled: ${policy.enabled ? 'yes' : 'no'}`,
    `  Ultracode: ${policy.ultracode ? 'yes' : 'no'}`,
    `  Max concurrency: ${policy.maxConcurrency}`,
    `  Max agents per run: ${policy.maxAgentsPerRun}`,
    `  Source: ${policy.source}`,
    ...(policy.reason ? [`  Reason: ${policy.reason}`] : []),
  ].join('\n')
}
