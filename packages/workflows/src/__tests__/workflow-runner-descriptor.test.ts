import { execFileSync } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createWorkflowRunnerExecutionDescriptor,
  hashWorkflowRunnerDescriptor,
  hashWorkflowRunnerInput,
  validateWorkflowRunnerExecutionDescriptor,
  WorkflowRunnerDescriptorError,
} from '../workflow-runner-descriptor.js';
import {
  WorkflowRunnerDescriptorStore,
  WorkflowRunnerDescriptorStoreError,
  type WorkflowRunnerDescriptorPathSecurity,
} from '../workflow-runner-descriptor-store.js';
import { WORKFLOW_RUNNER_CAPABILITIES } from '../workflow-runner-contract.js';
import {
  validateWorkflowRunnerV2ExecutionDescriptor,
  WORKFLOW_RUNNER_V2_DESCRIPTOR_CODEC,
  type WorkflowRunnerV2ExecutionDescriptor,
} from '../workflow-runner-v2-descriptor.js';
import { workflowRunnerV2DescriptorFixture } from './workflow-runner-v2-test-fixture.js';
import type { WorkflowMeta } from '../types.js';

const roots: string[] = [];
const now = '2026-08-04T01:00:00.000Z';
const later = '2026-08-04T02:00:00.000Z';
const manifest: WorkflowMeta = {
  name: 'sealed-test',
  version: '1.0.0',
  description: 'Sealed runner test.',
  phases: [{ title: 'Run', detail: 'Run once.' }],
  risk: 'low',
};
let cachedWindowsSid: string | undefined;

function currentWindowsSid(): string {
  if (cachedWindowsSid) return cachedWindowsSid;
  cachedWindowsSid = execFileSync(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 20_000 },
  ).trim();
  return cachedWindowsSid;
}

function hardenWindowsTestPath(path: string, directory: boolean): void {
  const rights = directory ? '(OI)(CI)F' : 'F';
  const sid = currentWindowsSid();
  execFileSync('icacls.exe', [path, '/reset'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20_000,
  });
  execFileSync('icacls.exe', [path, '/setowner', `*${sid}`], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20_000,
  });
  execFileSync(
    'icacls.exe',
    [path, '/inheritance:r', '/grant:r', `*${sid}:${rights}`, `*S-1-5-18:${rights}`],
    { encoding: 'utf8', windowsHide: true, timeout: 20_000 },
  );
}

function shortWindowsPath(path: string): string {
  const output = execFileSync(
    'cmd.exe',
    ['/d', '/c', 'for %I in ("%OPENSLACK_TEST_LONG_PATH%") do @echo %~sI'],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 20_000,
      env: { ...process.env, OPENSLACK_TEST_LONG_PATH: path },
    },
  ).trim();
  const windowsPaths = output.match(/[A-Za-z]:\\[^"\r\n]*/gu);
  return resolve(windowsPaths?.sort((left, right) => right.length - left.length)[0] ?? output);
}

const testSecurity: WorkflowRunnerDescriptorPathSecurity = {
  platform: process.platform,
  async harden() {},
  async assertOwnerOnly(_path, directory, stat) {
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) {
      throw new Error('unsafe test path');
    }
  },
};

function descriptor() {
  return createWorkflowRunnerExecutionDescriptor({
    descriptorRef: 'descriptor.test.1',
    workspaceId: 'workspace.test',
    workflowRunId: 'run.test.1',
    correlationId: 'correlation.test.1',
    workflowId: 'sealed-test',
    workflowVersion: '1.0.0',
    workflowSource: 'openslack-project',
    workflowSourceBytes: Buffer.from('export const meta = {};', 'utf8'),
    manifest,
    input: { issue: 42 },
    budget: { tokens: 1_000, costUsd: 1 },
    confirmationPolicy: {
      mode: 'unattended-explicit',
      actorId: 'test-actor',
      runId: 'run.test.1',
      allowUnattended: true,
      onUnexpectedEffect: 'fail',
    },
    createdAt: now,
    expiresAt: later,
  });
}

function v2Descriptor() {
  return workflowRunnerV2DescriptorFixture({
    descriptorRef: 'descriptor.v2.test.1',
    workspaceId: 'workspace.test',
    workflowRunId: 'run.v2.test.1',
    correlationId: 'correlation.v2.test.1',
    workflowId: 'sealed-test',
    workflowVersion: '1.0.0',
    workflowSource: 'openslack-project',
    workflowSourceBytes: Buffer.from('export const meta = {};', 'utf8'),
    manifest,
    input: { issue: 42 },
    confirmationPolicy: {
      mode: 'unattended-explicit',
      actorId: 'test-actor',
      runId: 'run.v2.test.1',
      allowUnattended: true,
      onUnexpectedEffect: 'fail',
    },
    requiredCapabilities: WORKFLOW_RUNNER_CAPABILITIES,
    authorityRoute: {
      backend: 'go',
      authority: 'workflow-control',
      routingEpoch: 1,
      authorityBuildHash: 'a'.repeat(64),
    },
    runRevision: 1,
    resumeGeneration: 0,
    budgetPolicy: {
      accountId: 'budget.v2.test',
      policyHash: 'b'.repeat(64),
      rateNanoUsdPerToken: '12.5',
      tokenLimit: '1000',
      costLimitNanoUsd: '12500',
      callLimit: '2',
    },
    createdAt: now,
    expiresAt: later,
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Windows descriptor identity query', () => {
  afterEach(() => {
    vi.doUnmock('node:child_process');
    vi.resetModules();
  });

  async function securityModule(query: typeof execFileSync, aclQuery = vi.fn()) {
    vi.resetModules();
    vi.doMock('node:child_process', () => ({ execFileSync: query, execFile: aclQuery }));
    return import('../workflow-runner-descriptor-store.js');
  }

  it('accepts one current-user CSV record and caches only its validated SID', async () => {
    const query = vi.fn().mockReturnValue('"domain\\worker, ""quoted""","S-1-5-21-42-1001"\r\n');
    const { createWorkflowRunnerDescriptorPathSecurity } = await securityModule(query);
    expect(createWorkflowRunnerDescriptorPathSecurity('win32').platform).toBe('win32');
    expect(createWorkflowRunnerDescriptorPathSecurity('win32').platform).toBe('win32');
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith('whoami.exe', ['/user', '/fo', 'csv', '/nh'], {
      encoding: 'utf8',
      timeout: 20_000,
      windowsHide: true,
      maxBuffer: 16 * 1024,
    });
  });

  it.each([
    'S-1-5-21-42-1001',
    '"domain\\worker","not-a-sid"',
    '"domain\\worker","S-1-5-21-42-1001"\n"other","S-1-5-21-99"',
    '"domain\\worker","S-1-5-21-42-1001","unexpected"',
  ])('refuses malformed current-user SID output %j', async (output) => {
    const query = vi.fn().mockReturnValue(output);
    const { createWorkflowRunnerDescriptorPathSecurity } = await securityModule(query);
    expect(() => createWorkflowRunnerDescriptorPathSecurity('win32')).toThrow(
      expect.objectContaining({ code: 'WORKFLOW_RUNNER_DESCRIPTOR_STORE_PERMISSION_DENIED' }),
    );
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('propagates a failed identity query without fallback or caching its result', async () => {
    const failure = new Error('owned current-user query failed');
    const query = vi
      .fn()
      .mockImplementationOnce(() => {
        throw failure;
      })
      .mockReturnValue('"domain\\worker","S-1-5-21-42-1001"');
    const { createWorkflowRunnerDescriptorPathSecurity } = await securityModule(query);
    expect(() => createWorkflowRunnerDescriptorPathSecurity('win32')).toThrow(failure);
    expect(query).toHaveBeenCalledTimes(1);
    expect(createWorkflowRunnerDescriptorPathSecurity('win32').platform).toBe('win32');
    expect(query).toHaveBeenCalledTimes(2);
  });

  async function aclFixture() {
    const root = await mkdtemp(join(tmpdir(), 'descriptor-acl-query-'));
    roots.push(root);
    const path = join(root, 'owned.json');
    await writeFile(path, '{}');
    return { path, stat: await lstat(path, { bigint: true }) };
  }

  const ownerOnlyAcl = () => JSON.stringify({
    owner: 'S-1-5-21-42-1001', protected: true, reparse: false,
    allow: ['S-1-5-21-42-1001', 'S-1-5-18'], deny: [],
  });

  it('awaits the asynchronous ACL query while unrelated event-loop work proceeds', async () => {
    const fixture = await aclFixture();
    const identity = vi.fn().mockReturnValue('"domain\\worker","S-1-5-21-42-1001"');
    let release: ((error: Error | null, stdout: string, stderr: string) => void) | undefined;
    const query = vi.fn((...args: unknown[]) => {
      release = args.at(-1) as typeof release;
      return {};
    });
    const { createWorkflowRunnerDescriptorPathSecurity } = await securityModule(identity, query);
    const security = createWorkflowRunnerDescriptorPathSecurity('win32');
    const inspecting = security.assertOwnerOnly(fixture.path, false, fixture.stat);
    let settled = false;
    void inspecting.then(() => { settled = true; }, () => { settled = true; });
    try {
      expect(query).toHaveBeenCalledTimes(1);
      expect(identity).toHaveBeenCalledTimes(1);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      const [executable, args, options] = query.mock.calls[0]! as [
        string, string[], { encoding: string; timeout: number; windowsHide: boolean; env: NodeJS.ProcessEnv },
      ];
      expect(executable).toBe('powershell.exe');
      expect(args?.slice(0, 4)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-Command']);
      expect(args?.[4]).toContain('Get-Acl -LiteralPath');
      expect(options).toMatchObject({ encoding: 'utf8', timeout: 20_000, windowsHide: true });
      expect(options?.env?.OPENSLACK_WORKFLOW_RUNNER_PATH).toBe(fixture.path);
      release!(null, ownerOnlyAcl(), '');
      await inspecting;
      expect(settled).toBe(true);
    } finally {
      release?.(new Error('fixture closed'), '', '');
      await inspecting.catch(() => undefined);
    }
  });

  it('propagates an asynchronous ACL query failure without a fallback query', async () => {
    const fixture = await aclFixture();
    const failure = Object.assign(new Error('ACL query deadline'), { code: 'ETIMEDOUT' });
    const identity = vi.fn().mockReturnValue('"domain\\worker","S-1-5-21-42-1001"');
    const query = vi.fn((...args: unknown[]) => {
      const callback = args.at(-1) as (error: Error) => void;
      queueMicrotask(() => callback(failure));
      return {};
    });
    const { createWorkflowRunnerDescriptorPathSecurity } = await securityModule(identity, query);
    await expect(createWorkflowRunnerDescriptorPathSecurity('win32')
      .assertOwnerOnly(fixture.path, false, fixture.stat)).rejects.toBe(failure);
    expect(query).toHaveBeenCalledTimes(1);
    expect(identity).toHaveBeenCalledTimes(1);
  });

  it('refuses malformed asynchronous ACL output', async () => {
    const fixture = await aclFixture();
    const identity = vi.fn().mockReturnValue('"domain\\worker","S-1-5-21-42-1001"');
    const query = vi.fn((...args: unknown[]) => {
      const callback = args.at(-1) as (error: null, stdout: string, stderr: string) => void;
      queueMicrotask(() => callback(null, '{not-json', ''));
      return {};
    });
    const { createWorkflowRunnerDescriptorPathSecurity } = await securityModule(identity, query);
    await expect(createWorkflowRunnerDescriptorPathSecurity('win32')
      .assertOwnerOnly(fixture.path, false, fixture.stat)).rejects.toMatchObject({
        code: 'WORKFLOW_RUNNER_DESCRIPTOR_STORE_PERMISSION_DENIED',
      });
    expect(query).toHaveBeenCalledTimes(1);
    expect(identity).toHaveBeenCalledTimes(1);
  });

  it('rechecks ACLs on every call and refuses a later grant to another SID', async () => {
    const fixture = await aclFixture();
    const identity = vi.fn().mockReturnValue('"domain\\worker","S-1-5-21-42-1001"');
    let calls = 0;
    const query = vi.fn((...args: unknown[]) => {
      const callback = args.at(-1) as (error: null, stdout: string, stderr: string) => void;
      const acl = JSON.parse(ownerOnlyAcl());
      if (++calls > 1) acl.allow.push('S-1-5-21-99-1001');
      queueMicrotask(() => callback(null, JSON.stringify(acl), ''));
      return {};
    });
    const { createWorkflowRunnerDescriptorPathSecurity } = await securityModule(identity, query);
    const security = createWorkflowRunnerDescriptorPathSecurity('win32');
    await security.assertOwnerOnly(fixture.path, false, fixture.stat);
    await expect(security.assertOwnerOnly(fixture.path, false, fixture.stat)).rejects.toMatchObject({
      code: 'WORKFLOW_RUNNER_DESCRIPTOR_STORE_PERMISSION_DENIED',
    });
    expect(query).toHaveBeenCalledTimes(2);
    expect(identity).toHaveBeenCalledTimes(1);
  });
});

describe('GS8-B sealed execution descriptor', () => {
  it('uses closed canonical data and independent full domain hashes', () => {
    if (false) {
      // @ts-expect-error non-v1 descriptor stores require an explicit security policy and codec
      new WorkflowRunnerDescriptorStore<WorkflowRunnerV2ExecutionDescriptor>('.');
    }
    const value = descriptor();
    expect(value.workflowSourceHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(value.manifestHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(value.inputHash).toBe(hashWorkflowRunnerInput({ issue: 42 }));
    expect(hashWorkflowRunnerDescriptor(value)).toMatch(/^[0-9a-f]{64}$/u);
    expect(() => validateWorkflowRunnerExecutionDescriptor({ ...value, command: 'node' })).toThrow(
      WorkflowRunnerDescriptorError,
    );
    expect(() =>
      validateWorkflowRunnerExecutionDescriptor({ ...value, inputHash: 'f'.repeat(64) }),
    ).toThrowError(expect.objectContaining({ code: 'WORKFLOW_RUNNER_DESCRIPTOR_HASH_MISMATCH' }));
    expect(() => validateWorkflowRunnerExecutionDescriptor(value, later)).toThrowError(
      expect.objectContaining({ code: 'WORKFLOW_RUNNER_DESCRIPTOR_EXPIRED' }),
    );
  });

  it('persists immutable owner-only exact bytes and rejects conflicts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openslack-runner-descriptor-'));
    roots.push(root);
    await chmod(root, 0o700);
    const store = new WorkflowRunnerDescriptorStore(root, testSecurity);
    const value = descriptor();
    const created = await store.create(value);
    expect(created.duplicate).toBe(false);
    expect((await store.create(value)).duplicate).toBe(true);
    expect(await store.read(value.descriptorRef, '2026-08-04T01:30:00.000Z')).toEqual(value);
    const bytes = await readFile(store.descriptorPath(value.descriptorRef), 'utf8');
    expect(bytes.endsWith('\n')).toBe(true);
    expect(bytes.endsWith('\n\n')).toBe(false);

    const conflicting = { ...value, budget: { tokens: 2_000, costUsd: 1 } };
    await expect(store.create(conflicting)).rejects.toMatchObject({
      code: 'WORKFLOW_RUNNER_DESCRIPTOR_STORE_CONFLICT',
    });
  });

  it('round-trips a v2 descriptor through the strict null-prototype JSON parser', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openslack-runner-v2-descriptor-'));
    roots.push(root);
    await chmod(root, 0o700);
    const store = new WorkflowRunnerDescriptorStore<WorkflowRunnerV2ExecutionDescriptor>(
      root,
      testSecurity,
      WORKFLOW_RUNNER_V2_DESCRIPTOR_CODEC,
    );
    const value = v2Descriptor();

    await store.create(value);

    await expect(store.read(value.descriptorRef, '2026-08-04T01:30:00.000Z')).resolves.toEqual(
      value,
    );

    const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, value);
    expect(validateWorkflowRunnerV2ExecutionDescriptor(nullPrototype)).toEqual(value);
    expect(() => validateWorkflowRunnerV2ExecutionDescriptor(new Proxy({ ...value }, {}))).toThrow(
      /inert object/u,
    );
    const accessor = { ...value } as Record<string, unknown>;
    Object.defineProperty(accessor, 'workspaceId', {
      enumerable: true,
      get: () => 'workspace.test',
    });
    expect(() => validateWorkflowRunnerV2ExecutionDescriptor(accessor)).toThrow(
      /enumerable data fields/u,
    );
    expect(() =>
      validateWorkflowRunnerV2ExecutionDescriptor({ ...value, [Symbol('unexpected')]: true }),
    ).toThrow(/missing or unknown fields/u);
  });

  it('fails closed when a descriptor file loses owner-only permissions', async () => {
    if (process.platform === 'win32') return;
    // Use the native POSIX temporary filesystem. A Windows-mounted workspace
    // can expose chmod as a no-op even when the test process itself is Linux.
    const root = await mkdtemp('/tmp/openslack-runner-descriptor-');
    roots.push(root);
    await chmod(root, 0o700);
    const store = new WorkflowRunnerDescriptorStore(root);
    const value = descriptor();
    await store.create(value);
    const path = store.descriptorPath(value.descriptorRef);
    await chmod(path, 0o644);
    await expect(store.read(value.descriptorRef)).rejects.toBeInstanceOf(
      WorkflowRunnerDescriptorStoreError,
    );
    // Prove the test did not replace or rewrite the immutable descriptor.
    expect((await readFile(path)).length).toBeGreaterThan(0);
  });

  it('hardens and verifies a newly created Windows descriptor store', async () => {
    if (process.platform !== 'win32') return;
    const root = await mkdtemp(join(tmpdir(), 'openslack-runner-descriptor-'));
    roots.push(root);
    execFileSync('icacls.exe', [root, '/grant', '*S-1-1-0:(OI)(CI)RX'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 20_000,
    });
    hardenWindowsTestPath(root, true);
    const store = new WorkflowRunnerDescriptorStore(root);
    const value = descriptor();

    await expect(store.create(value)).resolves.toMatchObject({ duplicate: false });
    await expect(store.read(value.descriptorRef)).resolves.toEqual(value);
  }, 60_000);

  it('accepts a Windows 8.3 alias for the same non-reparse descriptor root', async () => {
    if (process.platform !== 'win32') return;
    const root = await mkdtemp(join(tmpdir(), 'openslack-runner-long-descriptor-root-'));
    roots.push(root);
    hardenWindowsTestPath(root, true);
    const shortRoot = shortWindowsPath(root);
    if (shortRoot.toUpperCase() === root.toUpperCase()) return;
    expect(await realpath(shortRoot)).toBe(await realpath(root));

    const store = new WorkflowRunnerDescriptorStore(shortRoot);
    await expect(store.initialize()).resolves.toBeUndefined();
  }, 30_000);

  it('rejects inherited or foreign-principal Windows ACLs through the real inspector', async () => {
    if (process.platform !== 'win32') return;
    for (const mutation of ['inheritance', 'foreign-principal'] as const) {
      const root = await mkdtemp(join(tmpdir(), `openslack-runner-acl-${mutation}-`));
      roots.push(root);
      hardenWindowsTestPath(root, true);
      const store = new WorkflowRunnerDescriptorStore(root);
      await store.initialize();
      if (mutation === 'inheritance') {
        execFileSync('icacls.exe', [root, '/inheritance:e'], {
          windowsHide: true,
          timeout: 20_000,
        });
      } else {
        execFileSync('icacls.exe', [root, '/grant', '*S-1-1-0:(OI)(CI)RX'], {
          windowsHide: true,
          timeout: 20_000,
        });
      }
      await expect(store.initialize()).rejects.toMatchObject({
        code: 'WORKFLOW_RUNNER_DESCRIPTOR_STORE_PERMISSION_DENIED',
      });
    }
  }, 30_000);

  it('rejects an ancestor symlink or junction before creating a target child', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'openslack-runner-ancestor-'));
    roots.push(parent);
    const target = join(parent, 'target');
    const alias = join(parent, 'alias');
    await mkdir(target);
    await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const escapedChild = join(target, 'must-not-exist');
    const store = new WorkflowRunnerDescriptorStore(join(alias, 'must-not-exist'));

    await expect(store.initialize()).rejects.toMatchObject({
      code: 'WORKFLOW_RUNNER_DESCRIPTOR_STORE_PATH_UNSAFE',
    });
    await expect(readFile(escapedChild)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects an existing ordinary store below an ancestor symlink or junction', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'openslack-runner-existing-ancestor-'));
    roots.push(parent);
    const target = join(parent, 'target');
    const targetStore = join(target, 'existing-store');
    const alias = join(parent, 'alias');
    await mkdir(targetStore, { recursive: true });
    await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const store = new WorkflowRunnerDescriptorStore(join(alias, 'existing-store'), testSecurity);

    await expect(store.initialize()).rejects.toMatchObject({
      code: 'WORKFLOW_RUNNER_DESCRIPTOR_STORE_PATH_UNSAFE',
    });
  });

  it('rejects non-canonical files rather than normalizing them on read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openslack-runner-descriptor-'));
    roots.push(root);
    await chmod(root, 0o700);
    const store = new WorkflowRunnerDescriptorStore(root, testSecurity);
    await store.initialize();
    const value = descriptor();
    const path = store.descriptorPath(value.descriptorRef);
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await chmod(path, 0o600);
    await expect(store.read(value.descriptorRef)).rejects.toMatchObject({
      code: 'WORKFLOW_RUNNER_DESCRIPTOR_STORE_INVALID',
    });
  });
});
