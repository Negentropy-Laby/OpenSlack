import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { WorkspaceConfig } from './types.js';

export type ProductAssetId =
  | 'workspace.agent-template'
  | 'workspace.provider-template'
  | 'workspace.workflow-template';

export interface AssetResolver {
  readText(assetId: ProductAssetId): string;
}

export interface WorkspaceContext {
  productHome: string;
  workspaceRoot: string;
  projectStateRoot: string;
  localStateRoot: string;
  sourceCheckout: boolean;
  assetResolver: AssetResolver;
  config?: WorkspaceConfig;
}

export interface ResolveWorkspaceContextOptions {
  startDir?: string;
  workspaceRoot?: string;
  productHome?: string;
  requireWorkspace?: boolean;
  assetResolver?: AssetResolver;
}

export class WorkspaceContextError extends Error {
  constructor(
    readonly code: 'WORKSPACE_NOT_FOUND' | 'WORKSPACE_CONFIG_INVALID' | 'WORKSPACE_PATH_ESCAPE',
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceContextError';
  }
}

export function resolveWorkspaceContext(
  options: ResolveWorkspaceContextOptions = {},
): WorkspaceContext {
  const startDir = resolve(options.startDir ?? process.cwd());
  const discovered = options.workspaceRoot
    ? resolve(options.workspaceRoot)
    : findWorkspaceRoot(startDir);
  if (!discovered && options.requireWorkspace !== false) {
    throw new WorkspaceContextError(
      'WORKSPACE_NOT_FOUND',
      'No openslack.yaml was found from the selected directory.',
    );
  }
  const workspaceRoot = discovered ?? startDir;
  const config = readWorkspaceConfig(workspaceRoot);
  const projectStateRoot = resolveContained(
    workspaceRoot,
    config?.workspace?.state_root ?? '.openslack',
  );
  const localStateRoot = resolveContained(workspaceRoot, '.openslack.local');
  const sourceCheckout = isSourceCheckout(workspaceRoot);
  const productHome = resolve(
    options.productHome ??
      process.env.OPENSLACK_PRODUCT_HOME ??
      (sourceCheckout ? workspaceRoot : dirname(process.execPath)),
  );
  return {
    productHome,
    workspaceRoot,
    projectStateRoot,
    localStateRoot,
    sourceCheckout,
    assetResolver: options.assetResolver ?? createEmbeddedAssetResolver(),
    config,
  };
}

export function findWorkspaceRoot(startDir = process.cwd()): string | null {
  let current = resolve(startDir);
  for (;;) {
    if (existsSync(join(current, 'openslack.yaml'))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function createEmbeddedAssetResolver(): AssetResolver {
  return {
    readText(assetId) {
      const value = EMBEDDED_ASSETS[assetId];
      if (value === undefined) throw new Error(`Unknown embedded product asset: ${assetId}`);
      return value;
    },
  };
}

function readWorkspaceConfig(workspaceRoot: string): WorkspaceConfig | undefined {
  const path = join(workspaceRoot, 'openslack.yaml');
  if (!existsSync(path)) return undefined;
  try {
    const parsed = parseYaml(readFileSync(path, 'utf-8')) as WorkspaceConfig;
    if (!parsed || typeof parsed !== 'object') throw new Error('empty config');
    return parsed;
  } catch {
    throw new WorkspaceContextError(
      'WORKSPACE_CONFIG_INVALID',
      'openslack.yaml could not be parsed as a workspace configuration.',
    );
  }
}

function resolveContained(root: string, path: string): string {
  const candidate = resolve(root, path);
  const rel = relative(root, candidate);
  if (
    isAbsolute(rel) ||
    rel === '..' ||
    rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
  ) {
    throw new WorkspaceContextError(
      'WORKSPACE_PATH_ESCAPE',
      'Workspace state paths must remain inside the workspace root.',
    );
  }
  return candidate;
}

function isSourceCheckout(root: string): boolean {
  return (
    existsSync(join(root, 'package.json')) &&
    existsSync(join(root, 'apps', 'cli')) &&
    existsSync(join(root, 'packages', 'workspace'))
  );
}

const EMBEDDED_ASSETS: Record<ProductAssetId, string> = {
  'workspace.agent-template': `schema: openslack.agent_registry.v1
agent_id: operator
display_name: OpenSlack Operator
employee_type: ai_agent
vendor:
  provider: openai-compatible
  runtime: openslack
  model: default
employment:
  status: onboarding
  hired_by: human:owner
  department: engineering
  role: developer
  manager: human:owner
workspace_permissions:
  allow:
    - "**"
  deny:
    - ".git/**"
    - ".openslack.local/**"
execution:
  max_parallel_tasks: 1
  lease_ttl_minutes: 60
  heartbeat_interval_minutes: 10
  max_task_runtime_minutes: 120
output_contract:
  must_create:
    - workspace_run_record
  may_create:
    - workspace_pr
  must_not_create:
    - direct_main_push
approval_rules:
  require_human_approval_for:
    - merge_to_main
    - policy_change
`,
  'workspace.provider-template': `${JSON.stringify(
    {
      schemaVersion: 1,
      defaultProvider: 'openai-compatible',
      providers: {
        'openai-compatible': {
          baseUrl: 'http://127.0.0.1:11434/v1',
          model: 'configure-me',
          credentialRef: 'env:OPENSLACK_MODEL_API_KEY',
          timeoutMs: 30000,
        },
      },
    },
    null,
    2,
  )}\n`,
  'workspace.workflow-template': `schema: openslack.workflow_template.v1
id: first-task
name: First governed task
description: Preview and deliver a small repository change through OpenSlack.
riskLevel: medium
tags:
  - onboarding
  - governed-delivery
inputs:
  - name: title
    type: string
    required: true
    description: Task title
phases:
  - name: Plan
    steps:
      - type: action
        actionId: task.create.preview
        title: Preview the task
        input:
          title: "{{inputs.title}}"
          template: investigation
`,
};
