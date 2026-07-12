import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildPermissionProfile,
  createRunRecorder,
  createRunStore,
  PermissionDeniedError,
  ProviderTimeoutError,
  readTranscript,
  RepositoryToolExecutor,
  type RepositoryToolExecutorOptions,
  ToolArgumentInvalidError,
  ToolGuard,
} from '../index.js';
import type { PermissionMode } from '@openslack/kernel';

function git(root: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf-8' });
  if (result.status !== 0) throw new Error(String(result.stderr));
}

function createExecutor(
  root: string,
  mode: PermissionMode = 'default',
  limits: Partial<
    Pick<
      RepositoryToolExecutorOptions,
      'maxReadBytes' | 'maxPatchBytes' | 'maxDiffBytes' | 'maxSearchFiles' | 'maxSearchMatches'
    >
  > = {},
) {
  const runId = 'RUN-20260711-TOOLEXEC';
  const store = createRunStore(root);
  const recorder = createRunRecorder(store, root);
  const profile = buildPermissionProfile({
    agentId: 'tool-test',
    source: 'test',
    permissionMode: mode,
  });
  recorder.start({
    runId,
    agentId: 'tool-test',
    prompt: 'test',
    resolvedConfig: { agentId: 'tool-test', source: 'test' },
    permissionProfile: profile,
  });
  const toolGuard = new ToolGuard(profile, recorder, runId);
  return {
    runId,
    executor: new RepositoryToolExecutor({
      rootPath: root,
      toolGuard,
      recorder,
      runId,
      ...limits,
    }),
  };
}

describe('RepositoryToolExecutor', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'openslack-tool-executor-'));
    git(root, ['init', '--quiet']);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('reads, searches, edits, and reports tracked and untracked diff evidence', async () => {
    writeFileSync(join(root, 'tracked.txt'), 'alpha\n', 'utf-8');
    git(root, ['add', 'tracked.txt']);
    const { executor } = createExecutor(root);

    const read = await executor.execute('repo.read', { path: 'tracked.txt' });
    expect(read.data.content).toBe('alpha\n');

    const search = await executor.execute('repo.search', { query: 'alpha' });
    expect(search.data.matches).toEqual([
      expect.objectContaining({ path: 'tracked.txt', line: 1, text: 'alpha' }),
    ]);

    await executor.execute('repo.apply_patch', {
      path: 'tracked.txt',
      oldText: 'alpha',
      newText: 'beta',
    });
    await executor.execute('repo.apply_patch', {
      path: 'new.txt',
      oldText: '',
      newText: 'created\n',
    });
    const diff = await executor.execute('repo.diff', {});
    expect(diff.data.diff).toContain('-alpha');
    expect(diff.data.diff).toContain('+beta');
    expect(diff.data.untrackedFiles).toContainEqual({ path: 'new.txt', bytes: 8 });
  });

  it.each([
    '../outside.txt',
    '.git/config',
    '.openslack.local/agent-runtime.json',
    'nested/.env',
    'nested/token.pem',
    'credentials/service.json',
    'nested/../packages/kernel/src/zones.ts',
  ])('rejects inaccessible path %s', async (path) => {
    const { executor } = createExecutor(root);
    await expect(executor.execute('repo.read', { path })).rejects.toBeInstanceOf(
      ToolArgumentInvalidError,
    );
  });

  it.each([
    'AGENTS.md',
    'CLAUDE.md',
    '.openslack/agents/prompts/worker.md',
    '.openslack/agents/registry/worker.yaml',
    '.openslack/policies/merge.yaml',
    'packages/kernel/src/zones.ts',
  ])('rejects model writes to Red Zone path %s', async (path) => {
    const { executor } = createExecutor(root);
    await expect(
      executor.execute('repo.apply_patch', { path, oldText: '', newText: 'blocked' }),
    ).rejects.toBeInstanceOf(ToolArgumentInvalidError);
  });

  it('rejects absolute paths and symlinks that resolve outside the worktree', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'openslack-tool-outside-'));
    try {
      writeFileSync(join(outside, 'secret.txt'), 'outside', 'utf-8');
      let symlinkAvailable = true;
      try {
        symlinkSync(outside, join(root, 'escape'), 'dir');
      } catch {
        symlinkAvailable = false;
      }
      const { executor } = createExecutor(root);
      await expect(
        executor.execute('repo.read', { path: join(outside, 'secret.txt') }),
      ).rejects.toBeInstanceOf(ToolArgumentInvalidError);
      if (symlinkAvailable) {
        await expect(
          executor.execute('repo.read', { path: 'escape/secret.txt' }),
        ).rejects.toBeInstanceOf(ToolArgumentInvalidError);
      }
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('validates exact arguments before checking authorization', async () => {
    const { executor, runId } = createExecutor(root, 'plan');
    await expect(
      executor.execute('repo.apply_patch', {
        path: 'blocked.txt',
        oldText: '',
        newText: 'blocked',
        extra: true,
      }),
    ).rejects.toBeInstanceOf(ToolArgumentInvalidError);
    expect(readTranscript(runId, root).some((event) => event.data.step === 'tool_denied')).toBe(
      false,
    );
  });

  it('checks authorization before a write side effect', async () => {
    const { executor } = createExecutor(root, 'plan');
    await expect(
      executor.execute('repo.apply_patch', {
        path: 'blocked.txt',
        oldText: '',
        newText: 'blocked',
      }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(() => readFileSync(join(root, 'blocked.txt'), 'utf-8')).toThrow();
  });

  it('returns and records only redacted sensitive text', async () => {
    const fakeToken = `sk-${'a'.repeat(24)}`;
    const fakeAccessKey = 'test-only-access-value';
    const fakeJsonKey = 'test-only-json-key-value';
    writeFileSync(
      join(root, 'example.txt'),
      `token=${fakeToken}\nAWS_SECRET_ACCESS_KEY=${fakeAccessKey}\n{"apiKey":"${fakeJsonKey}"}\n`,
      'utf-8',
    );
    const { executor, runId } = createExecutor(root);
    const result = await executor.execute('repo.read', { path: 'example.txt' });
    expect(String(result.data.content)).toContain('[redacted-token]');
    expect(String(result.data.content)).not.toContain(fakeAccessKey);
    expect(String(result.data.content)).not.toContain(fakeJsonKey);
    expect(JSON.stringify(readTranscript(runId, root))).not.toContain(fakeToken);
    expect(JSON.stringify(readTranscript(runId, root))).not.toContain(fakeAccessKey);
    expect(JSON.stringify(readTranscript(runId, root))).not.toContain(fakeJsonKey);
  });

  it('rejects binary edits and non-unique replacements', async () => {
    writeFileSync(join(root, 'binary.bin'), Buffer.from([1, 0, 2]));
    writeFileSync(join(root, 'repeat.txt'), 'same same', 'utf-8');
    const { executor } = createExecutor(root);
    await expect(
      executor.execute('repo.apply_patch', {
        path: 'binary.bin',
        oldText: 'x',
        newText: 'y',
      }),
    ).rejects.toBeInstanceOf(ToolArgumentInvalidError);
    await expect(
      executor.execute('repo.apply_patch', {
        path: 'repeat.txt',
        oldText: 'same',
        newText: 'other',
      }),
    ).rejects.toBeInstanceOf(ToolArgumentInvalidError);
  });

  it('enforces file byte limits before reading or editing full contents', async () => {
    writeFileSync(join(root, 'large.txt'), '0123456789abcdef', 'utf-8');
    const { executor } = createExecutor(root, 'default', {
      maxReadBytes: 8,
      maxPatchBytes: 8,
    });
    const read = await executor.execute('repo.read', { path: 'large.txt' });
    expect(read).toMatchObject({ truncated: true, data: { content: '01234567', bytes: 16 } });
    const search = await executor.execute('repo.search', { query: '0123' });
    expect(search.data.matches).toEqual([]);
    await expect(
      executor.execute('repo.apply_patch', {
        path: 'large.txt',
        oldText: '0',
        newText: 'x',
      }),
    ).rejects.toBeInstanceOf(ToolArgumentInvalidError);
  });

  it('bounds a redacted tool result before transcript persistence and provider reuse', async () => {
    const marker = 'bounded-result-marker';
    writeFileSync(join(root, 'large-result.txt'), marker.repeat(200), 'utf-8');
    const { executor, runId } = createExecutor(root);
    const result = await executor.execute(
      'repo.read',
      { path: 'large-result.txt' },
      { maxResultBytes: 256 },
    );
    expect(result).toMatchObject({ truncated: true });
    expect(JSON.stringify(result)).not.toContain(marker);
    expect(JSON.stringify(readTranscript(runId, root))).not.toContain(marker);
  });

  it('enforces cancellation and wall-clock deadlines inside the tool plane', async () => {
    const { executor } = createExecutor(root);
    await expect(
      executor.execute('repo.search', { query: 'anything' }, { deadlineAt: Date.now() - 1 }),
    ).rejects.toBeInstanceOf(ProviderTimeoutError);

    const controller = new AbortController();
    controller.abort(new Error('operator cancelled'));
    await expect(
      executor.execute('repo.search', { query: 'anything' }, { signal: controller.signal }),
    ).rejects.toThrow('operator cancelled');
  });

  it('preserves an existing executable mode when editing', async () => {
    const path = join(root, 'script.sh');
    writeFileSync(path, '#!/bin/sh\necho old\n', 'utf-8');
    chmodSync(path, 0o755);
    const before = lstatSync(path).mode & 0o777;
    const { executor } = createExecutor(root);
    await executor.execute('repo.apply_patch', {
      path: 'script.sh',
      oldText: 'old',
      newText: 'new',
    });
    expect(lstatSync(path).mode & 0o777).toBe(before);
  });

  it('skips credential-equivalent trees during repository search', async () => {
    mkdirSync(join(root, 'nested'), { recursive: true });
    writeFileSync(join(root, 'visible.txt'), 'needle', 'utf-8');
    writeFileSync(join(root, 'nested', '.env'), 'needle', 'utf-8');
    const { executor } = createExecutor(root);
    const result = await executor.execute('repo.search', { query: 'needle' });
    const paths = (result.data.matches as Array<{ path: string }>).map((match) => match.path);
    expect(paths).toContain('visible.txt');
    expect(paths).not.toContain('nested/.env');
  });

  it('omits tracked Black-path contents from whole-worktree diff evidence', async () => {
    writeFileSync(join(root, '.env'), 'PRIVATE_VALUE=before\n', 'utf-8');
    writeFileSync(join(root, 'safe.txt'), 'before\n', 'utf-8');
    git(root, ['add', '.env', 'safe.txt']);
    writeFileSync(join(root, '.env'), 'PRIVATE_VALUE=after\n', 'utf-8');
    writeFileSync(join(root, 'safe.txt'), 'after\n', 'utf-8');
    const { executor } = createExecutor(root);
    const result = await executor.execute('repo.diff', {});
    expect(result.data.diff).toContain('safe.txt');
    expect(result.data.diff).not.toContain('PRIVATE_VALUE');
    expect(result.data.diff).not.toContain('.env');

    mkdirSync(join(root, 'nested'), { recursive: true });
    writeFileSync(join(root, 'nested', '.env'), 'NESTED_SECRET=before\n', 'utf-8');
    writeFileSync(join(root, 'nested', 'visible.txt'), 'before\n', 'utf-8');
    git(root, ['add', 'nested/.env', 'nested/visible.txt']);
    writeFileSync(join(root, 'nested', '.env'), 'NESTED_SECRET=after\n', 'utf-8');
    writeFileSync(join(root, 'nested', 'visible.txt'), 'after\n', 'utf-8');
    const scoped = await executor.execute('repo.diff', { path: 'nested' });
    expect(scoped.data.diff).toContain('nested/visible.txt');
    expect(scoped.data.diff).not.toContain('NESTED_SECRET');
  });
});
