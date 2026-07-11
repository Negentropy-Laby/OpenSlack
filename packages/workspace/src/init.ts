import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import {
  createEmbeddedAssetResolver,
  resolveWorkspaceContext,
  type AssetResolver,
} from './workspace-context.js';

export interface WorkspaceInitInput {
  targetRoot: string;
  name: string;
  owner: string;
  repo: string;
  defaultBranch?: string;
  assetResolver?: AssetResolver;
}

export interface WorkspaceInitOperation {
  path: string;
  action: 'create' | 'append' | 'unchanged' | 'conflict';
  content?: string;
  beforeHash: string | null;
  detail: string;
}

export interface WorkspaceInitPlan {
  targetRoot: string;
  operations: WorkspaceInitOperation[];
  applicable: boolean;
}

export function planWorkspaceInit(input: WorkspaceInitInput): WorkspaceInitPlan {
  const targetRoot = resolve(input.targetRoot);
  assertGitRepository(targetRoot);
  const assets = input.assetResolver ?? createEmbeddedAssetResolver();
  const files = new Map<string, string>([
    ['openslack.yaml', renderWorkspaceConfig(input)],
    ['.openslack/agents/registry/operator.yaml', assets.readText('workspace.agent-template')],
    [
      '.openslack/templates/agent-runtime.example.json',
      assets.readText('workspace.provider-template'),
    ],
    ['.openslack/workflows/first-task.yaml', assets.readText('workspace.workflow-template')],
  ]);
  for (const directory of REQUIRED_STATE_DIRECTORIES) {
    files.set(`${directory}/.gitkeep`, '');
  }
  const operations = [...files].map(([path, content]) => planFile(targetRoot, path, content));
  operations.push(planGitignore(targetRoot));
  return {
    targetRoot,
    operations,
    applicable: operations.every((operation) => operation.action !== 'conflict'),
  };
}

export function applyWorkspaceInit(plan: WorkspaceInitPlan): void {
  if (!plan.applicable) {
    throw new Error('Workspace initialization has conflicts and cannot be applied.');
  }
  for (const operation of plan.operations) assertOperationCurrent(plan.targetRoot, operation);
  const created: string[] = [];
  try {
    for (const operation of plan.operations) {
      if (operation.action === 'unchanged') continue;
      const path = join(plan.targetRoot, operation.path);
      mkdirSync(dirname(path), { recursive: true });
      assertNoSymlinkAncestor(plan.targetRoot, operation.path);
      if (operation.action === 'create') {
        writeFileSync(path, operation.content ?? '', { encoding: 'utf-8', flag: 'wx' });
        created.push(path);
      } else if (operation.action === 'append') {
        const current = readFileSync(path, 'utf-8');
        if (hashText(current) !== operation.beforeHash) throw changedAfterPreview(operation.path);
        const prefix = current.length > 0 && !current.endsWith('\n') ? '\n' : '';
        appendFileSync(path, `${prefix}${operation.content ?? ''}`, 'utf-8');
      }
    }
    mkdirSync(join(plan.targetRoot, '.openslack.local'), { recursive: true });
    resolveWorkspaceContext({ workspaceRoot: plan.targetRoot });
  } catch (error) {
    for (const path of created.reverse()) rmSync(path, { force: true });
    throw error;
  }
}

export function renderWorkspaceInitPlan(plan: WorkspaceInitPlan): string {
  return [
    `Workspace init preview: ${plan.targetRoot}`,
    ...plan.operations.map(
      (operation) => `[${operation.action.toUpperCase()}] ${operation.path} — ${operation.detail}`,
    ),
    plan.applicable
      ? 'No files changed. Re-run with --apply to create this workspace.'
      : 'Conflicts detected. Existing files will not be overwritten.',
  ].join('\n');
}

function renderWorkspaceConfig(input: WorkspaceInitInput): string {
  const workspaceId = input.repo
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return stringifyYaml({
    schema: 'openslack.workspace.v1',
    workspace_id: workspaceId || 'openslack-workspace',
    name: input.name,
    mode: 'normal',
    canonical_remote: {
      provider: 'github',
      owner: input.owner,
      repo: input.repo,
      default_branch: input.defaultBranch ?? 'main',
    },
    workspace: { root: '.', state_root: '.openslack' },
    product: {
      repo_role: 'managed',
      source_roots: ['.'],
      protected_roots: [
        '.github',
        '.openslack/policies',
        '.openslack/agents/registry',
        '.openslack/agents/prompts',
      ],
    },
  });
}

function planFile(root: string, path: string, content: string): WorkspaceInitOperation {
  const absolute = join(root, path);
  if (!existsSync(absolute)) {
    return { path, action: 'create', content, beforeHash: null, detail: 'new file' };
  }
  const current = readFileSync(absolute, 'utf-8');
  if (current === content) {
    return { path, action: 'unchanged', beforeHash: hashText(current), detail: 'already matches' };
  }
  return {
    path,
    action: 'conflict',
    beforeHash: hashText(current),
    detail: 'existing content differs',
  };
}

function planGitignore(root: string): WorkspaceInitOperation {
  const path = '.gitignore';
  const absolute = join(root, path);
  const content = existsSync(absolute) ? readFileSync(absolute, 'utf-8') : '';
  if (content.split(/\r?\n/).some((line) => line.trim() === '.openslack.local/')) {
    return {
      path,
      action: 'unchanged',
      beforeHash: hashText(content),
      detail: 'local state already ignored',
    };
  }
  return {
    path,
    action: existsSync(absolute) ? 'append' : 'create',
    content: '.openslack.local/\n',
    beforeHash: existsSync(absolute) ? hashText(content) : null,
    detail: 'ignore machine-local state',
  };
}

function assertOperationCurrent(root: string, operation: WorkspaceInitOperation): void {
  assertNoSymlinkAncestor(root, operation.path);
  const absolute = join(root, operation.path);
  const currentHash = existsSync(absolute) ? hashText(readFileSync(absolute, 'utf-8')) : null;
  if (currentHash !== operation.beforeHash) throw changedAfterPreview(operation.path);
}

function assertNoSymlinkAncestor(root: string, path: string): void {
  const normalized = normalize(path);
  if (isAbsolute(normalized) || normalized === '..' || normalized.startsWith(`..${sep}`)) {
    throw new Error(`Workspace initialization path escapes the target root: ${path}`);
  }
  let current = root;
  for (const segment of normalized.split(sep)) {
    current = join(current, segment);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new Error(`Workspace initialization refuses symlinked paths: ${path}`);
    }
  }
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function changedAfterPreview(path: string): Error {
  return new Error(`Workspace changed after preview; regenerate the plan before applying: ${path}`);
}

function assertGitRepository(root: string): void {
  try {
    const topLevel = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (resolve(topLevel) !== root) throw new Error('nested target');
  } catch {
    throw new Error('openslack init requires the root of an existing Git repository.');
  }
}

const REQUIRED_STATE_DIRECTORIES = [
  '.openslack/agents/prompts',
  '.openslack/policies',
  '.openslack/tasks',
  '.openslack/leases',
  '.openslack/audit',
  '.openslack/collaboration',
];
