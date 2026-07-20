import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { validateWorkspace } from './validate.js';
import { createEmbeddedAssetResolver, type AssetResolver } from './workspace-context.js';
import type { ValidationResult, WorkspaceConfig } from './types.js';

export type WorkspaceAttachMode = 'read-only-monitor' | 'full-agent';

export interface WorkspaceAttachInput {
  targetRoot: string;
  owner: string;
  repo: string;
  mode: WorkspaceAttachMode;
  name?: string;
  defaultBranch?: string;
  assetResolver?: AssetResolver;
  now?: () => Date;
}

export type WorkspaceAttachOperationAction = 'create' | 'replace' | 'unchanged' | 'conflict';

export interface WorkspaceAttachRollbackData {
  existed: boolean;
  bytesBase64: string | null;
  mode: number | null;
}

export interface WorkspaceAttachOperation {
  path: string;
  action: WorkspaceAttachOperationAction;
  beforeSha256: string | null;
  beforeMode: number | null;
  afterSha256: string | null;
  contentBase64: string | null;
  rollback: WorkspaceAttachRollbackData;
  detail: string;
}

export interface WorkspaceAttachPlan {
  schema: 'openslack.workspace_attach_plan.v1';
  transactionId: string;
  planHash: string;
  plannedAt: string;
  targetRoot: string;
  targetRootRealpath: string;
  mode: WorkspaceAttachMode;
  repository: {
    owner: string;
    repo: string;
    fullName: string;
  };
  operations: WorkspaceAttachOperation[];
  conflicts: string[];
  validationErrors: string[];
  applicable: boolean;
}

export interface WorkspaceAttachResult {
  schema: 'openslack.workspace_attach_result.v1';
  transactionId: string;
  targetRoot: string;
  mode: WorkspaceAttachMode;
  changed: boolean;
  changedPaths: string[];
  recoveredTransaction: boolean;
  journalCleanupDeferred: boolean;
  validation: ValidationResult;
}

/**
 * Test and embedding hooks. Product CLI callers do not need to provide these.
 * A process exit inside a hook intentionally exercises durable crash recovery.
 */
export interface WorkspaceAttachApplyOptions {
  hooks?: {
    beforeWrite?: (path: string, completedWrites: number) => void;
    afterWrite?: (path: string, completedWrites: number) => void;
    beforePostValidation?: () => void;
    beforeJournalCleanup?: () => void;
  };
  validate?: (root: string) => ValidationResult;
}

interface WorkspaceAttachJournal {
  schema: 'openslack.workspace_attach_rollback.v1';
  transactionId: string;
  planHash: string;
  targetRootRealpath: string;
  createdAt: string;
  operations: Array<{
    path: string;
    rollback: WorkspaceAttachRollbackData;
  }>;
}

interface AttachLock {
  schema: 'openslack.workspace_attach_lock.v1';
  pid: number;
  transactionId: string;
  createdAt: string;
}

const ATTACH_AGENT_PATH = '.openslack/agents/registry/openslack_agent_operator.yaml';
const ATTACH_PROVIDER_PATH = '.openslack/templates/agent-runtime.example.json';
const ATTACH_WORKFLOW_PATH = '.openslack/workflows/first-task.yaml';
const ATTACH_WATCH_PATH = '.openslack/monitors/github-watch.yaml';
const ATTACH_JOURNAL_PATH = '.openslack.local/transactions/attach.rollback.json';
const ATTACH_COMMITTED_JOURNAL_PATH = '.openslack.local/transactions/attach.committed.json';
const ATTACH_LOCK_PATH = '.openslack.local/locks/attach.lock';
const GENERATED_FILE_MODE = 0o644;
const MAX_JOURNAL_BYTES = 4 * 1024 * 1024;

const REQUIRED_STATE_DIRECTORIES = [
  '.openslack/agents/registry',
  '.openslack/agents/prompts',
  '.openslack/policies',
  '.openslack/tasks',
  '.openslack/leases',
  '.openslack/audit',
  '.openslack/collaboration',
] as const;

const WATCH_EVENTS = [
  'issues.opened',
  'issues.reopened',
  'issues.labeled',
  'push',
  'pull_request.opened',
  'pull_request.synchronize',
  'pull_request.reopened',
  'pull_request.closed',
  'pull_request.ready_for_review',
  'pull_request_review.submitted',
  'pull_request_review.dismissed',
  'check_run.completed',
  'check_suite.completed',
] as const;

export function planWorkspaceAttach(input: WorkspaceAttachInput): WorkspaceAttachPlan {
  const targetRoot = resolve(input.targetRoot);
  assertGitRepository(targetRoot);
  const targetRootRealpath = realpathSync.native(targetRoot);
  const repository = normalizeRepository(input.owner, input.repo);
  assertAttachMode(input.mode);
  const now = input.now?.() ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new TypeError('Workspace attach time is invalid.');
  const assets = input.assetResolver ?? createEmbeddedAssetResolver();
  const existingWorkspace = readExistingWorkspaceConfig(targetRoot);
  const conflicts: string[] = [];

  if (existingWorkspace.kind === 'invalid') conflicts.push(existingWorkspace.message);
  if (existingWorkspace.kind === 'valid') {
    if (existingWorkspace.config.mode !== 'normal') {
      conflicts.push('Existing openslack.yaml is not an ordinary managed workspace.');
    }
    const existingRemote = existingWorkspace.config.canonical_remote;
    if (
      existingRemote.owner.toLocaleLowerCase('en-US') !==
        repository.owner.toLocaleLowerCase('en-US') ||
      existingRemote.repo.toLocaleLowerCase('en-US') !== repository.repo.toLocaleLowerCase('en-US')
    ) {
      conflicts.push('Existing openslack.yaml targets a different canonical repository.');
    }
  }

  const workspaceConfig = renderWorkspaceConfig({
    input,
    repository,
    existing: existingWorkspace.kind === 'valid' ? existingWorkspace.config : undefined,
  });
  const files = new Map<string, { content: Buffer; replace: boolean }>();
  files.set('openslack.yaml', {
    content: utf8(workspaceConfig),
    replace: existingWorkspace.kind === 'valid',
  });
  files.set(ATTACH_WATCH_PATH, {
    content: utf8(renderWatchConfig(repository.owner, repository.repo)),
    replace: isCompatibleWatchConfig(targetRoot, repository),
  });
  for (const directory of REQUIRED_STATE_DIRECTORIES) {
    files.set(`${directory}/.gitkeep`, { content: Buffer.alloc(0), replace: false });
  }
  if (input.mode === 'full-agent') {
    const existingHiredAt = readGeneratedAgentHiredAt(targetRoot);
    files.set(ATTACH_AGENT_PATH, {
      content: utf8(
        renderFullAgent({
          owner: repository.owner,
          repo: repository.repo,
          defaultBranch:
            input.defaultBranch ??
            (existingWorkspace.kind === 'valid'
              ? existingWorkspace.config.canonical_remote.default_branch
              : 'main'),
          hiredAt: existingHiredAt ?? now.toISOString(),
        }),
      ),
      replace: existingHiredAt !== null,
    });
    files.set(ATTACH_PROVIDER_PATH, {
      content: utf8(assets.readText('workspace.provider-template')),
      replace: isExactEmbeddedAsset(
        targetRoot,
        ATTACH_PROVIDER_PATH,
        assets.readText('workspace.provider-template'),
      ),
    });
    files.set(ATTACH_WORKFLOW_PATH, {
      content: utf8(assets.readText('workspace.workflow-template')),
      replace: isExactEmbeddedAsset(
        targetRoot,
        ATTACH_WORKFLOW_PATH,
        assets.readText('workspace.workflow-template'),
      ),
    });
  }

  const operations = [...files.entries()].map(([path, desired]) =>
    planFile(targetRoot, path, desired.content, desired.replace),
  );
  operations.push(planGitignore(targetRoot));

  if (input.mode === 'read-only-monitor') {
    for (const path of [ATTACH_AGENT_PATH, ATTACH_PROVIDER_PATH, ATTACH_WORKFLOW_PATH]) {
      if (existsSync(join(targetRoot, path))) {
        const conflict = planExistingConflict(
          targetRoot,
          path,
          'executable full-agent artifact exists',
        );
        operations.push(conflict);
        conflicts.push(`${path}: ${conflict.detail}`);
      }
    }
  }
  for (const operation of operations) {
    if (operation.action === 'conflict') conflicts.push(`${operation.path}: ${operation.detail}`);
  }

  const validationErrors =
    conflicts.length === 0
      ? validateVirtualAttachSnapshot(
          input.mode,
          new Map([...files].map(([path, value]) => [path, value.content])),
          planGitignoreContent(targetRoot),
        )
      : [];
  const planWithoutHash = {
    schema: 'openslack.workspace_attach_plan.v1' as const,
    transactionId: randomUUID(),
    plannedAt: now.toISOString(),
    targetRoot,
    targetRootRealpath,
    mode: input.mode,
    repository,
    operations: sortOperations(operations),
    conflicts: unique(conflicts),
    validationErrors,
    applicable: conflicts.length === 0 && validationErrors.length === 0,
  };
  return {
    ...planWithoutHash,
    planHash: hashPlan(planWithoutHash),
  };
}

export function applyWorkspaceAttach(
  plan: WorkspaceAttachPlan,
  options: WorkspaceAttachApplyOptions = {},
): WorkspaceAttachResult {
  assertPlanIntegrity(plan);
  if (!plan.applicable || plan.conflicts.length > 0 || plan.validationErrors.length > 0) {
    throw new Error(
      'Workspace attach plan has conflicts or validation errors and cannot be applied.',
    );
  }
  const lockPath = join(plan.targetRoot, ATTACH_LOCK_PATH);
  const journalPath = join(plan.targetRoot, ATTACH_JOURNAL_PATH);
  const committedJournalPath = join(plan.targetRoot, ATTACH_COMMITTED_JOURNAL_PATH);
  acquireAttachLock(lockPath, plan.transactionId);
  let journalWritten = false;
  let recoveredTransaction = false;
  try {
    recoveredTransaction = recoverIncompleteAttach(
      plan.targetRoot,
      journalPath,
      committedJournalPath,
    );
    assertRootIdentity(plan);
    for (const operation of plan.operations) assertOperationCurrent(plan.targetRoot, operation);
    const changes = plan.operations.filter(
      (operation) => operation.action === 'create' || operation.action === 'replace',
    );
    if (changes.length === 0) {
      const validation = postValidate(plan, options);
      return {
        schema: 'openslack.workspace_attach_result.v1',
        transactionId: plan.transactionId,
        targetRoot: plan.targetRoot,
        mode: plan.mode,
        changed: false,
        changedPaths: [],
        recoveredTransaction,
        journalCleanupDeferred: false,
        validation,
      };
    }

    const journal: WorkspaceAttachJournal = {
      schema: 'openslack.workspace_attach_rollback.v1',
      transactionId: plan.transactionId,
      planHash: plan.planHash,
      targetRootRealpath: plan.targetRootRealpath,
      createdAt: new Date().toISOString(),
      operations: changes.map((operation) => ({
        path: operation.path,
        rollback: operation.rollback,
      })),
    };
    atomicWrite(journalPath, utf8(`${JSON.stringify(journal, null, 2)}\n`), 0o600, plan.targetRoot);
    journalWritten = true;

    let completedWrites = 0;
    for (const operation of changes) {
      options.hooks?.beforeWrite?.(operation.path, completedWrites);
      assertOperationCurrent(plan.targetRoot, operation);
      const content = decodeOperationContent(operation);
      atomicWrite(
        join(plan.targetRoot, operation.path),
        content,
        operation.beforeMode ?? GENERATED_FILE_MODE,
        plan.targetRoot,
      );
      completedWrites += 1;
      options.hooks?.afterWrite?.(operation.path, completedWrites);
    }
    options.hooks?.beforePostValidation?.();
    const validation = postValidate(plan, options);
    renameSync(journalPath, committedJournalPath);
    journalWritten = false;
    let journalCleanupDeferred = false;
    try {
      syncDirectory(dirname(committedJournalPath));
      options.hooks?.beforeJournalCleanup?.();
      removeCommittedJournal(plan.targetRoot, committedJournalPath);
    } catch {
      journalCleanupDeferred = true;
    }
    return {
      schema: 'openslack.workspace_attach_result.v1',
      transactionId: plan.transactionId,
      targetRoot: plan.targetRoot,
      mode: plan.mode,
      changed: true,
      changedPaths: changes.map((operation) => operation.path),
      recoveredTransaction,
      journalCleanupDeferred,
      validation,
    };
  } catch (error) {
    if (journalWritten && existsSync(journalPath)) {
      try {
        restoreJournal(plan.targetRoot, journalPath);
        journalWritten = false;
      } catch (rollbackError) {
        throw new AggregateError(
          [asError(error), asError(rollbackError)],
          'Workspace attach failed and rollback could not be completed. The journal was preserved.',
        );
      }
    }
    throw error;
  } finally {
    releaseAttachLock(lockPath);
  }
}

export function renderWorkspaceAttachPlan(plan: WorkspaceAttachPlan): string {
  return [
    `Workspace attach preview: ${plan.targetRoot}`,
    `Mode: ${plan.mode}`,
    `Repository: ${plan.repository.fullName}`,
    ...plan.operations.map(
      (operation) => `[${operation.action.toUpperCase()}] ${operation.path} — ${operation.detail}`,
    ),
    ...plan.validationErrors.map((error) => `[VALIDATION] ${error}`),
    plan.applicable
      ? 'Preview only. Re-run with --apply to commit this transaction.'
      : 'Conflicts detected. No workspace files were changed.',
  ].join('\n');
}

function renderWorkspaceConfig(input: {
  input: WorkspaceAttachInput;
  repository: { owner: string; repo: string; fullName: string };
  existing?: WorkspaceConfig;
}): string {
  const derivedWorkspaceId =
    input.repository.repo
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'openslack-workspace';
  const workspaceId = input.existing?.workspace_id ?? derivedWorkspaceId;
  const config: WorkspaceConfig = {
    schema: 'openslack.workspace.v1',
    workspace_id: workspaceId,
    name: input.input.name ?? input.existing?.name ?? basename(resolve(input.input.targetRoot)),
    ...(input.existing?.description ? { description: input.existing.description } : {}),
    mode: 'normal',
    canonical_remote: {
      provider: 'github',
      owner: input.repository.owner,
      repo: input.repository.repo,
      default_branch:
        input.input.defaultBranch ?? input.existing?.canonical_remote.default_branch ?? 'main',
    },
    workspace: { root: '.', state_root: '.openslack' },
    product: input.existing?.product ?? {
      repo_role: 'managed',
      source_roots: ['.'],
      protected_roots: [
        '.github',
        '.openslack/policies',
        '.openslack/agents/registry',
        '.openslack/agents/prompts',
      ],
    },
    sidecar: {
      attach_mode: input.input.mode,
      auto_claim: false,
    },
  };
  return stringifyYaml(config);
}

function renderWatchConfig(owner: string, repo: string): string {
  return stringifyYaml({
    schema: 'openslack.github_watch.v1',
    repositories: [
      {
        owner,
        repo,
        events: [...WATCH_EVENTS],
        routes: [{ sink: 'console' }],
        auto_claim: { enabled: false, agent_ids: [] },
      },
    ],
  });
}

function renderFullAgent(input: {
  owner: string;
  repo: string;
  defaultBranch: string;
  hiredAt: string;
}): string {
  return stringifyYaml({
    schema: 'openslack.agent_registry.v2',
    agent_id: 'openslack_agent_operator',
    display_name: 'OpenSlack Operator',
    employee_type: 'ai_agent',
    identity: {
      uid: 'openslack-agent-operator',
      principal_id: 'principal:openslack-agent-operator',
      public_key_jwk: null,
      key_id: null,
      key_rotation: {
        last_rotated_at: null,
        rotation_interval_days: 90,
      },
      status: 'active',
    },
    vendor: {
      provider: 'openai-compatible',
      runtime: 'openslack',
      model: 'default',
    },
    employment: {
      status: 'onboarding',
      hired_at: input.hiredAt,
      hired_by: 'human:owner',
      department: 'engineering',
      role: 'developer',
      manager: 'human:owner',
    },
    capabilities: {
      primary: ['task-claim', 'repository-edit', 'pull-request-delivery'],
      secondary: ['documentation'],
    },
    repositories: {
      workspace_repo: {
        owner: input.owner,
        repo: input.repo,
        default_branch: input.defaultBranch,
      },
    },
    permissions: {
      paths: {
        allow: ['**'],
        deny: [
          '.git/**',
          '.openslack.local/**',
          '.openslack/agents/**',
          '.openslack/policies/**',
          '.github/**',
        ],
      },
      actions: {
        'task.claim': 'allow',
        'task.sync': 'allow',
        'repo.read': 'allow',
        'repo.search': 'allow',
        'repo.diff': 'allow',
        'repo.edit': 'allow',
        'pr.propose': 'allow',
        'pr.comment': 'allow',
        'pr.approve': 'deny',
        'pr.merge': 'deny',
      },
      github: {
        can_create_pr: true,
        can_comment: true,
        can_approve: false,
        can_merge: false,
      },
      max_risk_zone: 'yellow',
    },
    execution: {
      max_parallel_tasks: 1,
      lease_ttl_minutes: 60,
      heartbeat_interval_minutes: 10,
      max_task_runtime_minutes: 120,
    },
    output_contract: {
      must_create: ['workspace_run_record'],
      may_create: ['workspace_pr', 'review_comment'],
      must_not_create: ['direct_main_push', 'production_deploy', 'github_approval', 'github_merge'],
    },
    approval_rules: {
      require_human_approval_for: [
        'merge_to_main',
        'policy_change',
        'permission_change',
        'agent_registry_change',
      ],
    },
  });
}

function readExistingWorkspaceConfig(
  root: string,
):
  | { kind: 'missing' }
  | { kind: 'valid'; config: WorkspaceConfig }
  | { kind: 'invalid'; message: string } {
  const path = join(root, 'openslack.yaml');
  if (!existsSync(path)) return { kind: 'missing' };
  try {
    assertRegularFileWithoutSymlink(root, 'openslack.yaml');
    const parsed = parseYaml(decodeUtf8(readFileSync(path))) as unknown;
    if (!isWorkspaceConfigShape(parsed)) {
      return { kind: 'invalid', message: 'Existing openslack.yaml is not a supported workspace.' };
    }
    return { kind: 'valid', config: parsed };
  } catch {
    return { kind: 'invalid', message: 'Existing openslack.yaml cannot be safely parsed.' };
  }
}

function isWorkspaceConfigShape(value: unknown): value is WorkspaceConfig {
  if (!isRecord(value)) return false;
  const canonical = value.canonical_remote;
  const workspace = value.workspace;
  const product = value.product;
  return (
    value.schema === 'openslack.workspace.v1' &&
    typeof value.workspace_id === 'string' &&
    typeof value.name === 'string' &&
    (value.mode === 'normal' || value.mode === 'self_project') &&
    isRecord(canonical) &&
    canonical.provider === 'github' &&
    typeof canonical.owner === 'string' &&
    typeof canonical.repo === 'string' &&
    typeof canonical.default_branch === 'string' &&
    isRecord(workspace) &&
    workspace.root === '.' &&
    typeof workspace.state_root === 'string' &&
    isRecord(product) &&
    (product.repo_role === 'managed' || product.repo_role === 'self') &&
    Array.isArray(product.source_roots) &&
    product.source_roots.every((item) => typeof item === 'string') &&
    Array.isArray(product.protected_roots) &&
    product.protected_roots.every((item) => typeof item === 'string')
  );
}

function isCompatibleWatchConfig(
  root: string,
  repository: { owner: string; repo: string },
): boolean {
  const path = join(root, ATTACH_WATCH_PATH);
  if (!existsSync(path)) return false;
  try {
    assertRegularFileWithoutSymlink(root, ATTACH_WATCH_PATH);
    const parsed = parseYaml(decodeUtf8(readFileSync(path))) as unknown;
    if (!isRecord(parsed) || parsed.schema !== 'openslack.github_watch.v1') return false;
    if (!Array.isArray(parsed.repositories) || parsed.repositories.length !== 1) return false;
    const entry = parsed.repositories[0];
    return Boolean(
      isRecord(entry) &&
      typeof entry.owner === 'string' &&
      typeof entry.repo === 'string' &&
      entry.owner.toLocaleLowerCase('en-US') === repository.owner.toLocaleLowerCase('en-US') &&
      entry.repo.toLocaleLowerCase('en-US') === repository.repo.toLocaleLowerCase('en-US'),
    );
  } catch {
    return false;
  }
}

function readGeneratedAgentHiredAt(root: string): string | null {
  const path = join(root, ATTACH_AGENT_PATH);
  if (!existsSync(path)) return null;
  try {
    assertRegularFileWithoutSymlink(root, ATTACH_AGENT_PATH);
    const parsed = parseYaml(decodeUtf8(readFileSync(path))) as unknown;
    if (
      !isRecord(parsed) ||
      parsed.schema !== 'openslack.agent_registry.v2' ||
      parsed.agent_id !== 'openslack_agent_operator' ||
      !isRecord(parsed.permissions) ||
      !isRecord(parsed.permissions.github) ||
      parsed.permissions.github.can_approve !== false ||
      parsed.permissions.github.can_merge !== false ||
      !isRecord(parsed.employment) ||
      typeof parsed.employment.hired_at !== 'string'
    ) {
      return null;
    }
    return parsed.employment.hired_at;
  } catch {
    return null;
  }
}

function isExactEmbeddedAsset(root: string, path: string, content: string): boolean {
  try {
    return existsSync(join(root, path)) && readFileSync(join(root, path)).equals(utf8(content));
  } catch {
    return false;
  }
}

function planFile(
  root: string,
  path: string,
  desired: Buffer,
  allowReplace: boolean,
): WorkspaceAttachOperation {
  const absolute = join(root, path);
  if (!existsSync(absolute)) {
    return operation(path, 'create', null, null, desired, 'new managed file');
  }
  try {
    assertRegularFileWithoutSymlink(root, path);
    const current = readFileSync(absolute);
    const mode = fileMode(absolute);
    if (current.equals(desired)) {
      return operation(path, 'unchanged', current, mode, desired, 'already matches');
    }
    if (!allowReplace) {
      return operation(
        path,
        'conflict',
        current,
        mode,
        null,
        'existing content is not attach-managed',
      );
    }
    return operation(path, 'replace', current, mode, desired, 'update attach-managed file');
  } catch {
    return operation(path, 'conflict', null, null, null, 'path is not a safe regular file');
  }
}

function planExistingConflict(
  root: string,
  path: string,
  detail: string,
): WorkspaceAttachOperation {
  try {
    assertRegularFileWithoutSymlink(root, path);
    const current = readFileSync(join(root, path));
    return operation(path, 'conflict', current, fileMode(join(root, path)), null, detail);
  } catch {
    return operation(path, 'conflict', null, null, null, `${detail}; path is unsafe`);
  }
}

function planGitignore(root: string): WorkspaceAttachOperation {
  const path = '.gitignore';
  const absolute = join(root, path);
  if (!existsSync(absolute)) {
    const desired = utf8('.openslack.local/\n');
    return operation(path, 'create', null, null, desired, 'ignore machine-local state');
  }
  try {
    assertRegularFileWithoutSymlink(root, path);
    const current = readFileSync(absolute);
    const text = decodeUtf8(current);
    if (text.split(/\r?\n/u).some((line) => line.trim() === '.openslack.local/')) {
      return operation(
        path,
        'unchanged',
        current,
        fileMode(absolute),
        current,
        'local state already ignored',
      );
    }
    const newline = text.includes('\r\n') ? '\r\n' : '\n';
    const prefix = text.length > 0 && !text.endsWith('\n') ? newline : '';
    const desired = utf8(`${text}${prefix}.openslack.local/${newline}`);
    return operation(
      path,
      'replace',
      current,
      fileMode(absolute),
      desired,
      'append local-state ignore',
    );
  } catch {
    return operation(path, 'conflict', null, null, null, 'existing .gitignore is not safe UTF-8');
  }
}

function planGitignoreContent(root: string): Buffer {
  const planned = planGitignore(root);
  return planned.contentBase64 ? Buffer.from(planned.contentBase64, 'base64') : Buffer.alloc(0);
}

function operation(
  path: string,
  action: WorkspaceAttachOperationAction,
  before: Buffer | null,
  beforeMode: number | null,
  after: Buffer | null,
  detail: string,
): WorkspaceAttachOperation {
  return {
    path,
    action,
    beforeSha256: before ? sha256(before) : null,
    beforeMode,
    afterSha256: after ? sha256(after) : null,
    contentBase64: after ? after.toString('base64') : null,
    rollback: {
      existed: before !== null,
      bytesBase64: before ? before.toString('base64') : null,
      mode: beforeMode,
    },
    detail,
  };
}

function validateVirtualAttachSnapshot(
  mode: WorkspaceAttachMode,
  files: Map<string, Buffer>,
  gitignore: Buffer,
): string[] {
  const errors: string[] = [];
  const workspace = parseYamlBuffer(files.get('openslack.yaml'));
  if (!isWorkspaceConfigShape(workspace))
    errors.push('openslack.yaml virtual schema validation failed.');
  if (
    isRecord(workspace) &&
    (!isRecord(workspace.sidecar) ||
      workspace.sidecar.attach_mode !== mode ||
      workspace.sidecar.auto_claim !== false)
  ) {
    errors.push('openslack.yaml sidecar mode or auto-claim invariant is invalid.');
  }
  const watch = parseYamlBuffer(files.get(ATTACH_WATCH_PATH));
  if (!isAttachWatchShape(watch)) errors.push('GitHub Watch virtual schema validation failed.');
  for (const directory of REQUIRED_STATE_DIRECTORIES) {
    if (!files.has(`${directory}/.gitkeep`)) {
      errors.push(`Virtual workspace is missing ${directory}.`);
    }
  }
  if (!decodeUtf8(gitignore).split(/\r?\n/u).includes('.openslack.local/')) {
    errors.push('.gitignore virtual projection does not ignore .openslack.local/.');
  }
  if (mode === 'full-agent') {
    const agent = parseYamlBuffer(files.get(ATTACH_AGENT_PATH));
    if (!isSafeFullAgent(agent))
      errors.push('Generated full-agent registry violates its authority invariant.');
    if (!files.has(ATTACH_PROVIDER_PATH) || !files.has(ATTACH_WORKFLOW_PATH)) {
      errors.push('Full-agent mode is missing provider or workflow templates.');
    }
  } else if (
    files.has(ATTACH_AGENT_PATH) ||
    files.has(ATTACH_PROVIDER_PATH) ||
    files.has(ATTACH_WORKFLOW_PATH)
  ) {
    errors.push('Read-only monitor mode contains executable agent artifacts.');
  }
  return errors;
}

function isAttachWatchShape(value: unknown): boolean {
  if (!isRecord(value) || value.schema !== 'openslack.github_watch.v1') return false;
  if (!Array.isArray(value.repositories) || value.repositories.length !== 1) return false;
  const repository = value.repositories[0];
  if (!isRecord(repository)) return false;
  const events = repository.events;
  return (
    typeof repository.owner === 'string' &&
    typeof repository.repo === 'string' &&
    Array.isArray(events) &&
    WATCH_EVENTS.every((event) => events.includes(event)) &&
    Array.isArray(repository.routes) &&
    repository.routes.some((route) => isRecord(route) && route.sink === 'console') &&
    isRecord(repository.auto_claim) &&
    repository.auto_claim.enabled === false
  );
}

function isSafeFullAgent(value: unknown): boolean {
  if (
    !isRecord(value) ||
    value.schema !== 'openslack.agent_registry.v2' ||
    value.agent_id !== 'openslack_agent_operator' ||
    !isRecord(value.permissions) ||
    !isRecord(value.permissions.github) ||
    value.permissions.github.can_create_pr !== true ||
    value.permissions.github.can_approve !== false ||
    value.permissions.github.can_merge !== false ||
    !isRecord(value.permissions.actions)
  ) {
    return false;
  }
  return (
    value.permissions.actions['pr.approve'] === 'deny' &&
    value.permissions.actions['pr.merge'] === 'deny'
  );
}

function postValidate(
  plan: WorkspaceAttachPlan,
  options: WorkspaceAttachApplyOptions,
): ValidationResult {
  const validation = (options.validate ?? validateWorkspace)(plan.targetRoot);
  if (!validation.valid) {
    throw new Error(
      `Workspace attach post-validation failed: ${validation.errors
        .filter((error) => error.severity === 'error')
        .map((error) => error.message)
        .join('; ')}`,
    );
  }
  const actualFiles = new Map<string, Buffer>();
  for (const operation of plan.operations) {
    if (operation.action === 'conflict') continue;
    const absolute = join(plan.targetRoot, operation.path);
    if (!existsSync(absolute) || operation.afterSha256 === null) {
      throw new Error(`Workspace attach post-validation failed: ${operation.path} is missing.`);
    }
    assertRegularFileWithoutSymlink(plan.targetRoot, operation.path);
    const bytes = readFileSync(absolute);
    if (sha256(bytes) !== operation.afterSha256) {
      throw new Error(
        `Workspace attach post-validation failed: ${operation.path} bytes do not match the plan.`,
      );
    }
    actualFiles.set(operation.path, bytes);
  }
  const errors = validateVirtualAttachSnapshot(
    plan.mode,
    actualFiles,
    readFileSync(join(plan.targetRoot, '.gitignore')),
  );
  if (errors.length > 0) {
    throw new Error(`Workspace attach post-validation failed: ${errors.join('; ')}`);
  }
  return validation;
}

function assertPlanIntegrity(plan: WorkspaceAttachPlan): void {
  if (!plan || plan.schema !== 'openslack.workspace_attach_plan.v1') {
    throw new Error('Workspace attach plan schema is invalid.');
  }
  const { planHash, ...withoutHash } = plan;
  if (!/^[a-f0-9]{64}$/u.test(planHash) || hashPlan(withoutHash) !== planHash) {
    throw new Error('Workspace attach plan integrity check failed.');
  }
}

function assertRootIdentity(plan: WorkspaceAttachPlan): void {
  const current = realpathSync.native(plan.targetRoot);
  if (current !== plan.targetRootRealpath) {
    throw new Error('Workspace root realpath changed after attach preview.');
  }
}

function assertOperationCurrent(root: string, operation: WorkspaceAttachOperation): void {
  assertSafeRelativePath(operation.path);
  const absolute = join(root, operation.path);
  assertContainedByRealpath(root, absolute);
  if (!existsSync(absolute)) {
    if (operation.beforeSha256 !== null || operation.beforeMode !== null)
      throw changedAfterPreview(operation.path);
    return;
  }
  assertRegularFileWithoutSymlink(root, operation.path);
  const bytes = readFileSync(absolute);
  if (sha256(bytes) !== operation.beforeSha256 || fileMode(absolute) !== operation.beforeMode) {
    throw changedAfterPreview(operation.path);
  }
}

function acquireAttachLock(path: string, transactionId: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lock: AttachLock = {
    schema: 'openslack.workspace_attach_lock.v1',
    pid: process.pid,
    transactionId,
    createdAt: new Date().toISOString(),
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = openSync(path, 'wx', 0o600);
      try {
        writeFileSync(descriptor, `${JSON.stringify(lock)}\n`, 'utf8');
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      return;
    } catch (error) {
      if (!isNodeError(error, 'EEXIST')) throw error;
      const current = readLock(path);
      if (current && isProcessAlive(current.pid)) {
        throw new Error(`Workspace attach is already locked by process ${current.pid}.`);
      }
      rmSync(path, { force: true });
    }
  }
  throw new Error('Workspace attach lock could not be acquired.');
}

function readLock(path: string): AttachLock | null {
  try {
    const parsed = JSON.parse(decodeUtf8(readFileSync(path))) as unknown;
    if (
      !isRecord(parsed) ||
      parsed.schema !== 'openslack.workspace_attach_lock.v1' ||
      typeof parsed.pid !== 'number' ||
      !Number.isSafeInteger(parsed.pid)
    ) {
      return null;
    }
    return parsed as unknown as AttachLock;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error, 'EPERM');
  }
}

function releaseAttachLock(path: string): void {
  rmSync(path, { force: true });
}

function recoverIncompleteAttach(
  root: string,
  journalPath: string,
  committedJournalPath: string,
): boolean {
  const hasRollback = existsSync(journalPath);
  const hasCommitted = existsSync(committedJournalPath);
  if (hasRollback && hasCommitted) {
    throw new Error('Workspace attach has conflicting rollback and committed journals.');
  }
  if (hasCommitted) {
    removeCommittedJournal(root, committedJournalPath);
    return true;
  }
  if (!hasRollback) return false;
  restoreJournal(root, journalPath);
  return true;
}

function removeCommittedJournal(root: string, committedJournalPath: string): void {
  readJournal(root, committedJournalPath);
  rmSync(committedJournalPath, { force: true });
  syncDirectory(dirname(committedJournalPath));
}

function restoreJournal(root: string, journalPath: string): void {
  const journal = readJournal(root, journalPath);
  for (const entry of [...journal.operations].reverse()) {
    assertSafeRelativePath(entry.path);
    const absolute = join(root, entry.path);
    assertContainedByRealpath(root, absolute);
    if (entry.rollback.existed) {
      if (entry.rollback.bytesBase64 === null || entry.rollback.mode === null) {
        throw new Error(`Rollback journal is incomplete for ${entry.path}.`);
      }
      const bytes = strictBase64(entry.rollback.bytesBase64);
      atomicWrite(absolute, bytes, entry.rollback.mode, root);
    } else {
      if (existsSync(absolute)) {
        assertRegularFileWithoutSymlink(root, entry.path);
        unlinkSync(absolute);
      }
      pruneEmptyParents(root, dirname(absolute));
    }
  }
  rmSync(journalPath, { force: true });
  syncDirectory(dirname(journalPath));
}

function readJournal(root: string, path: string): WorkspaceAttachJournal {
  assertContainedByRealpath(root, path);
  const bytes = readFileSync(path);
  if (bytes.byteLength > MAX_JOURNAL_BYTES)
    throw new Error('Workspace attach rollback journal is oversized.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeUtf8(bytes));
  } catch {
    throw new Error('Workspace attach rollback journal is invalid.');
  }
  if (
    !isRecord(parsed) ||
    parsed.schema !== 'openslack.workspace_attach_rollback.v1' ||
    typeof parsed.transactionId !== 'string' ||
    typeof parsed.planHash !== 'string' ||
    parsed.targetRootRealpath !== realpathSync.native(root) ||
    !Array.isArray(parsed.operations)
  ) {
    throw new Error('Workspace attach rollback journal is invalid.');
  }
  const operations: WorkspaceAttachJournal['operations'] = [];
  const paths = new Set<string>();
  for (const value of parsed.operations) {
    if (
      !isRecord(value) ||
      typeof value.path !== 'string' ||
      paths.has(value.path) ||
      !isRollbackData(value.rollback)
    ) {
      throw new Error('Workspace attach rollback journal contains an invalid operation.');
    }
    assertSafeRelativePath(value.path);
    paths.add(value.path);
    operations.push({ path: value.path, rollback: value.rollback });
  }
  return {
    schema: 'openslack.workspace_attach_rollback.v1',
    transactionId: parsed.transactionId,
    planHash: parsed.planHash,
    targetRootRealpath: parsed.targetRootRealpath,
    createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : '',
    operations,
  };
}

function isRollbackData(value: unknown): value is WorkspaceAttachRollbackData {
  if (!isRecord(value) || typeof value.existed !== 'boolean') return false;
  if (value.existed) {
    return (
      typeof value.bytesBase64 === 'string' &&
      typeof value.mode === 'number' &&
      Number.isSafeInteger(value.mode)
    );
  }
  return value.bytesBase64 === null && value.mode === null;
}

function atomicWrite(path: string, bytes: Buffer, mode: number, root: string): void {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  assertContainedByRealpath(root, parent);
  const tempPath = join(parent, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(tempPath, 'wx', mode);
    let offset = 0;
    while (offset < bytes.byteLength) offset += writeSync(descriptor, bytes, offset);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(tempPath, mode);
    assertContainedByRealpath(root, parent);
    if (existsSync(path)) assertRegularFileWithoutSymlink(root, relative(root, path));
    renameSync(tempPath, path);
    chmodSync(path, mode);
    syncDirectory(parent);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(tempPath, { force: true });
  }
}

function syncDirectory(path: string): void {
  if (process.platform === 'win32' || !existsSync(path)) return;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, 'r');
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function pruneEmptyParents(root: string, start: string): void {
  let current = start;
  const resolvedRoot = resolve(root);
  while (current !== resolvedRoot && isContained(resolvedRoot, current)) {
    try {
      rmSync(current);
    } catch {
      return;
    }
    current = dirname(current);
  }
}

function assertRegularFileWithoutSymlink(root: string, path: string): void {
  assertSafeRelativePath(path);
  let current = resolve(root);
  for (const segment of normalize(path).split(sep)) {
    current = join(current, segment);
    if (!existsSync(current)) continue;
    const status = lstatSync(current);
    if (status.isSymbolicLink())
      throw new Error(`Workspace attach refuses symlinked paths: ${path}`);
    if (current === join(resolve(root), normalize(path)) && !status.isFile()) {
      throw new Error(`Workspace attach requires a regular file: ${path}`);
    }
  }
  assertContainedByRealpath(root, dirname(join(root, path)));
}

function assertContainedByRealpath(root: string, candidate: string): void {
  const rootReal = realpathSync.native(resolve(root));
  let existing = resolve(candidate);
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) throw new Error('Workspace attach path has no existing ancestor.');
    existing = parent;
  }
  const existingReal = realpathSync.native(existing);
  if (!isContained(rootReal, existingReal))
    throw new Error('Workspace attach path escapes the workspace root.');
}

function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function assertSafeRelativePath(path: string): void {
  const normalized = normalize(path);
  if (
    !path ||
    path.includes('\0') ||
    isAbsolute(normalized) ||
    normalized === '..' ||
    normalized.startsWith(`..${sep}`)
  ) {
    throw new Error(`Workspace attach path escapes the target root: ${path}`);
  }
}

function assertGitRepository(root: string): void {
  try {
    const topLevel = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (resolve(topLevel) !== root) throw new Error('nested target');
  } catch {
    throw new Error('Workspace attach requires the root of an existing Git repository.');
  }
}

function normalizeRepository(
  owner: string,
  repo: string,
): { owner: string; repo: string; fullName: string } {
  const normalizedOwner = owner.trim();
  const normalizedRepo = repo.trim();
  const segment = /^[A-Za-z0-9_.-]+$/u;
  if (
    !segment.test(normalizedOwner) ||
    !segment.test(normalizedRepo) ||
    normalizedOwner === '.' ||
    normalizedOwner === '..' ||
    normalizedRepo === '.' ||
    normalizedRepo === '..'
  ) {
    throw new TypeError('Workspace attach requires a valid GitHub owner/repository.');
  }
  return {
    owner: normalizedOwner,
    repo: normalizedRepo,
    fullName: `${normalizedOwner}/${normalizedRepo}`,
  };
}

function assertAttachMode(mode: string): asserts mode is WorkspaceAttachMode {
  if (mode !== 'read-only-monitor' && mode !== 'full-agent') {
    throw new TypeError('Workspace attach mode must be read-only-monitor or full-agent.');
  }
}

function hashPlan(value: Omit<WorkspaceAttachPlan, 'planHash'>): string {
  return sha256(utf8(JSON.stringify(value)));
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function utf8(value: string): Buffer {
  return Buffer.from(value, 'utf8');
}

function decodeUtf8(value: Buffer): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(value);
}

function strictBase64(value: string): Buffer {
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value)
    throw new Error('Rollback journal contains invalid base64.');
  return decoded;
}

function decodeOperationContent(operation: WorkspaceAttachOperation): Buffer {
  if (operation.contentBase64 === null || operation.afterSha256 === null) {
    throw new Error(`Workspace attach operation has no content: ${operation.path}`);
  }
  const content = strictBase64(operation.contentBase64);
  if (sha256(content) !== operation.afterSha256) {
    throw new Error(`Workspace attach operation content hash is invalid: ${operation.path}`);
  }
  return content;
}

function parseYamlBuffer(value: Buffer | undefined): unknown {
  if (!value) return null;
  try {
    return parseYaml(decodeUtf8(value));
  } catch {
    return null;
  }
}

function fileMode(path: string): number {
  return statSync(path).mode & 0o777;
}

function changedAfterPreview(path: string): Error {
  return new Error(`Workspace changed after attach preview; regenerate the plan: ${path}`);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function sortOperations(operations: WorkspaceAttachOperation[]): WorkspaceAttachOperation[] {
  return [...operations].sort((left, right) => left.path.localeCompare(right.path, 'en-US'));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function isNodeError(value: unknown, code: string): boolean {
  return (
    value instanceof Error && 'code' in value && (value as NodeJS.ErrnoException).code === code
  );
}
