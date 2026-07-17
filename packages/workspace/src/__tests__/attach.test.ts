import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyWorkspaceAttach,
  planWorkspaceAttach,
  type WorkspaceAttachPlan,
} from '../attach.js';
import { validateWorkspace } from '../validate.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('transactional workspace attach', () => {
  it('previews read-only monitor mode without writing and applies only observation state', () => {
    const root = gitRoot();
    const plan = attachPlan(root, 'read-only-monitor');

    expect(plan.applicable).toBe(true);
    expect(plan.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'openslack.yaml', action: 'create' }),
        expect.objectContaining({
          path: '.openslack/monitors/github-watch.yaml',
          action: 'create',
        }),
        expect.objectContaining({ path: '.gitignore', action: 'create' }),
      ]),
    );
    expect(existsSync(join(root, 'openslack.yaml'))).toBe(false);

    const result = applyWorkspaceAttach(plan);

    expect(result.changed).toBe(true);
    expect(result.validation.valid).toBe(true);
    expect(validateWorkspace(root).valid).toBe(true);
    expect(existsSync(join(root, '.openslack', 'agents', 'registry', 'openslack_agent_operator.yaml'))).toBe(false);
    expect(existsSync(join(root, '.openslack', 'templates', 'agent-runtime.example.json'))).toBe(false);
    expect(existsSync(join(root, '.openslack', 'workflows', 'first-task.yaml'))).toBe(false);
    const workspace = yaml(root, 'openslack.yaml');
    expect(workspace.sidecar).toEqual({
      attach_mode: 'read-only-monitor',
      auto_claim: false,
    });
    const watch = yaml(root, '.openslack/monitors/github-watch.yaml');
    expect(watch.repositories[0].auto_claim).toEqual({ enabled: false, agent_ids: [] });
    expect(watch.repositories[0].routes).toEqual([{ sink: 'console' }]);
    expect(watch.repositories[0].events).toContain('pull_request_review.submitted');
    expect(watch.repositories[0].events).toContain('check_suite.completed');
  });

  it('generates a full agent that can deliver PRs but can never approve or merge', () => {
    const root = gitRoot();
    const result = applyWorkspaceAttach(attachPlan(root, 'full-agent'));

    expect(result.validation.valid).toBe(true);
    const agent = yaml(root, '.openslack/agents/registry/openslack_agent_operator.yaml');
    expect(agent.permissions.github).toEqual({
      can_create_pr: true,
      can_comment: true,
      can_approve: false,
      can_merge: false,
    });
    expect(agent.permissions.actions['task.claim']).toBe('allow');
    expect(agent.permissions.actions['repo.edit']).toBe('allow');
    expect(agent.permissions.actions['pr.approve']).toBe('deny');
    expect(agent.permissions.actions['pr.merge']).toBe('deny');
    expect(agent.output_contract.must_not_create).toContain('github_approval');
    expect(agent.output_contract.must_not_create).toContain('github_merge');
    expect(
      readFileSync(join(root, '.openslack', 'templates', 'agent-runtime.example.json'), 'utf8'),
    ).toContain('env:OPENSLACK_MODEL_API_KEY');
    expect(existsSync(join(root, '.openslack', 'workflows', 'first-task.yaml'))).toBe(true);
  });

  it('is byte-idempotent on repeated full-agent apply', () => {
    const root = gitRoot();
    applyWorkspaceAttach(attachPlan(root, 'full-agent'));
    const before = snapshotGeneratedFiles(root);

    const rerun = attachPlan(root, 'full-agent');
    expect(rerun.operations.every((operation) => operation.action === 'unchanged')).toBe(true);
    const result = applyWorkspaceAttach(rerun);

    expect(result.changed).toBe(false);
    expect(snapshotGeneratedFiles(root)).toEqual(before);
  });

  it('fails before the journal when a file changes after preview', () => {
    const root = gitRoot();
    writeFileSync(join(root, '.gitignore'), 'node_modules/\n', 'utf8');
    const plan = attachPlan(root, 'read-only-monitor');
    writeFileSync(join(root, '.gitignore'), 'changed-after-preview\n', 'utf8');

    expect(() => applyWorkspaceAttach(plan)).toThrow(/changed after attach preview/u);
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('changed-after-preview\n');
    expect(existsSync(join(root, 'openslack.yaml'))).toBe(false);
    expect(existsSync(join(root, '.openslack.local', 'transactions', 'attach.rollback.json'))).toBe(false);
  });

  it('rejects a symlinked ancestor introduced after preview', () => {
    const root = gitRoot();
    const external = temporaryRoot('openslack-attach-external-');
    const plan = attachPlan(root, 'read-only-monitor');
    symlinkSync(external, join(root, '.openslack'), process.platform === 'win32' ? 'junction' : 'dir');

    expect(() => applyWorkspaceAttach(plan)).toThrow(/symlinked paths|escapes the workspace root/u);
    expect(lstatSync(join(root, '.openslack')).isSymbolicLink()).toBe(true);
    expect(existsSync(join(external, 'monitors', 'github-watch.yaml'))).toBe(false);
  });

  it('restores exact bytes and file mode when a later write fails', () => {
    const root = gitRoot();
    const original = Buffer.from('node_modules/\r\n# exact bytes\r\n', 'utf8');
    const gitignore = join(root, '.gitignore');
    writeFileSync(gitignore, original);
    chmodSync(gitignore, 0o640);
    const originalMode = mode(gitignore);
    const plan = attachPlan(root, 'full-agent');

    expect(() =>
      applyWorkspaceAttach(plan, {
        hooks: {
          beforeWrite(_path, completedWrites) {
            if (completedWrites === 2) throw new Error('injected write failure');
          },
        },
      }),
    ).toThrow('injected write failure');

    expect(readFileSync(gitignore)).toEqual(original);
    expect(mode(gitignore)).toBe(originalMode);
    expect(existsSync(join(root, 'openslack.yaml'))).toBe(false);
    expect(existsSync(join(root, '.openslack.local', 'transactions', 'attach.rollback.json'))).toBe(false);
  });

  it('rolls back every write when post-validation fails', () => {
    const root = gitRoot();
    const original = Buffer.from('# original\n', 'utf8');
    writeFileSync(join(root, '.gitignore'), original);
    const plan = attachPlan(root, 'read-only-monitor');

    expect(() =>
      applyWorkspaceAttach(plan, {
        validate: () => ({
          valid: false,
          errors: [{ severity: 'error', message: 'injected post-validation failure' }],
        }),
      }),
    ).toThrow(/post-validation failed/u);

    expect(readFileSync(join(root, '.gitignore'))).toEqual(original);
    expect(existsSync(join(root, 'openslack.yaml'))).toBe(false);
    expect(existsSync(join(root, '.openslack', 'monitors', 'github-watch.yaml'))).toBe(false);
  });

  it('recovers a durable journal and stale lock left by a crashed process', () => {
    const root = gitRoot();
    writeFileSync(join(root, '.gitignore'), 'node_modules/\n', 'utf8');
    const plan = attachPlan(root, 'full-agent');
    const scriptRoot = temporaryRoot('openslack-attach-child-');
    const planPath = join(scriptRoot, 'plan.json');
    const scriptPath = join(scriptRoot, 'crash.mjs');
    writeFileSync(planPath, JSON.stringify(plan), 'utf8');
    const attachUrl = pathToFileURL(
      join(process.cwd(), 'packages', 'workspace', 'src', 'attach.ts'),
    ).href;
    writeFileSync(
      scriptPath,
      `import { readFileSync } from 'node:fs';
import { applyWorkspaceAttach } from ${JSON.stringify(attachUrl)};
const plan = JSON.parse(readFileSync(${JSON.stringify(planPath)}, 'utf8'));
applyWorkspaceAttach(plan, { hooks: { afterWrite() { process.exit(77); } } });
`,
      'utf8',
    );
    const child = spawnSync(process.execPath, ['--import', 'tsx', scriptPath], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    expect(child.status).toBe(77);
    expect(existsSync(join(root, '.openslack.local', 'transactions', 'attach.rollback.json'))).toBe(true);
    expect(existsSync(join(root, '.openslack.local', 'locks', 'attach.lock'))).toBe(true);

    const result = applyWorkspaceAttach(plan);

    expect(result.recoveredTransaction).toBe(true);
    expect(result.validation.valid).toBe(true);
    expect(existsSync(join(root, '.openslack.local', 'transactions', 'attach.rollback.json'))).toBe(false);
    expect(existsSync(join(root, '.openslack.local', 'locks', 'attach.lock'))).toBe(false);
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe(
      'node_modules/\n.openslack.local/\n',
    );
  });

  it('rejects a tampered plan before writing', () => {
    const root = gitRoot();
    const plan = attachPlan(root, 'read-only-monitor');
    const tampered = structuredClone(plan) as WorkspaceAttachPlan;
    tampered.operations[0]!.contentBase64 = Buffer.from('tampered', 'utf8').toString('base64');

    expect(() => applyWorkspaceAttach(tampered)).toThrow(/integrity check failed/u);
    expect(existsSync(join(root, 'openslack.yaml'))).toBe(false);
  });

  it('reports conflicts instead of replacing unrelated managed-path content', () => {
    const root = gitRoot();
    mkdirSync(join(root, '.openslack', 'monitors'), { recursive: true });
    writeFileSync(
      join(root, '.openslack', 'monitors', 'github-watch.yaml'),
      'schema: unrelated.v1\n',
      'utf8',
    );

    const plan = attachPlan(root, 'read-only-monitor');

    expect(plan.applicable).toBe(false);
    expect(plan.operations).toContainEqual(
      expect.objectContaining({
        path: '.openslack/monitors/github-watch.yaml',
        action: 'conflict',
      }),
    );
    expect(() => applyWorkspaceAttach(plan)).toThrow(/conflicts or validation errors/u);
  });
});

function attachPlan(
  root: string,
  attachMode: 'read-only-monitor' | 'full-agent',
): WorkspaceAttachPlan {
  return planWorkspaceAttach({
    targetRoot: root,
    owner: 'Acme',
    repo: 'Project',
    mode: attachMode,
    name: 'Acme Project',
    defaultBranch: 'main',
    now: () => new Date('2026-07-17T00:00:00.000Z'),
  });
}

function gitRoot(): string {
  const root = temporaryRoot('openslack-attach-');
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  return root;
}

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function yaml(root: string, path: string): Record<string, any> {
  return parseYaml(readFileSync(join(root, path), 'utf8')) as Record<string, any>;
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

function snapshotGeneratedFiles(root: string): Record<string, string> {
  const paths = [
    'openslack.yaml',
    '.gitignore',
    '.openslack/monitors/github-watch.yaml',
    '.openslack/agents/registry/openslack_agent_operator.yaml',
    '.openslack/templates/agent-runtime.example.json',
    '.openslack/workflows/first-task.yaml',
  ];
  return Object.fromEntries(
    paths.map((path) => [path, readFileSync(join(root, path)).toString('base64')]),
  );
}
