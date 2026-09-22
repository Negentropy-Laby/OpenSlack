import { createHash, generateKeyPairSync } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  openSync,
  closeSync,
  constants,
  readFileSync,
  readSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeAll } from 'vitest';
import {
  parseCleanupExecutorBootstrap,
  checkTaskView,
} from '../internal/cleanup-broker-executor.js';
import { cleanupPRBranchThroughBroker } from '../cleanup-branch.js';

function fixture() {
  const request = {
    schema: 'openslack.cleanup_request.v1',
    mode: 'preview',
    agentId: 'cleanup',
    principalId: 'principal:cleanup',
    runtimeUid: 'runtime-1',
    runId: 'run-1',
    repo: 'example/qualification',
    remote: 'qualification',
    prNumber: 1,
    permitId: 'permit-1',
    operationId: '',
  };
  const target = {
    workspaceId: 'qualification',
    host: 'github.com',
    repositoryId: '123',
    repository: request.repo,
    prNodeId: 'PR_test',
    prNumber: 1,
    ref: 'refs/heads/fixture',
    expectedSha: 'a'.repeat(40),
  };
  return {
    schema: 'openslack.cleanup_executor_bootstrap.v1',
    type: 'start',
    mode: 'preview',
    request,
    binding: {
      workerId: 'worker-1',
      operationId: '',
      requestDigest: createHash('sha256')
        .update(
          JSON.stringify([
            'openslack.cleanup_execution_digest.v1',
            request.agentId,
            request.principalId,
            request.runtimeUid,
            request.runId,
            request.repo,
            request.remote,
            String(request.prNumber),
            request.permitId,
            request.operationId,
          ]),
        )
        .digest('hex'),
      target,
      instance: { brokerId: 'broker', generation: '1', bootNonce: 'b'.repeat(64) },
    },
    registry: 'not-used-by-structural-parser',
    taskView: {
      schema: 'openslack.cleanup_task_view.v1',
      workspaceId: target.workspaceId,
      repository: target.repository,
      repositoryId: target.repositoryId,
      notBefore: new Date(Date.now() - 60_000).toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      tasks: [],
    },
    app: { appId: 1, installationId: 2, privateKey: 'fixture-not-a-key' },
    network: { httpsProxy: '', noProxy: '' },
    deadlineMs: Date.now() + 30_000,
  };
}
describe('fixed executor boundary', () => {
  it('owns structural input without claiming registry authentication', () => {
    const input = fixture();
    const result = parseCleanupExecutorBootstrap(input);
    input.binding.target.expectedSha = 'c'.repeat(40);
    expect(result.binding.target.expectedSha).toBe('a'.repeat(40));
  });
  it.each(['workspaceId', 'repositoryId', 'repository'])(
    'rejects task view target mismatch %s',
    (field) => {
      const input = fixture();
      Object.assign(input.taskView, { [field]: 'other' });
      expect(() => parseCleanupExecutorBootstrap(input)).toThrow('CLEANUP_EXECUTOR_INPUT_INVALID');
    },
  );
  it('rechecks expiry rather than treating a view as a permanent ticket', () => {
    const input = parseCleanupExecutorBootstrap(fixture());
    input.taskView.expiresAt = '2000-01-01T00:00:00Z';
    expect(() => checkTaskView(input.taskView, input.binding.target)).toThrow();
  });
  it.each(['unknown', 'expired', 'digest', 'proxyCredentials', 'operation', 'tasksUnknown'])(
    'rejects malformed %s before execution',
    (kind) => {
      const input = fixture();
      if (kind === 'unknown') Object.assign(input, { callerAuthorize: true });
      if (kind === 'expired') input.deadlineMs = Date.now() - 1;
      if (kind === 'digest') input.binding.requestDigest = '0'.repeat(64);
      if (kind === 'proxyCredentials') input.network.httpsProxy = 'http://user:secret@example.com';
      if (kind === 'operation') input.request.operationId = 'unexpected';
      if (kind === 'tasksUnknown') Object.assign(input.taskView, { allowAll: true });
      expect(() => parseCleanupExecutorBootstrap(input)).toThrow();
    },
  );
  it('rejects fabricated internal session before invoking any dependency', async () => {
    let reads = 0;
    await expect(
      cleanupPRBranchThroughBroker(
        {
          owner: 'example',
          repo: 'qualification',
          prNumber: 1,
          context: { kind: 'human-cli' },
          rootDir: '/tmp/not-used',
        } as never,
        {},
        {
          fetchPR: async () => {
            reads++;
            throw new Error('must not run');
          },
        } as never,
      ),
    ).rejects.toThrow();
    expect(reads).toBe(0);
  });
});

// The broker is Linux-only. These tests use actual inherited FIFO descriptors,
// real PRMS and real conditional Git deletion; only remote API evidence and
// fixed executable location are changed in the explicitly TEST-ONLY bundle.
describe.runIf(process.platform === 'linux')(
  'private FD fixture composition (not GitHub qualification)',
  () => {
    let bundle: string;
    beforeAll(() => {
      bundle = join(mkdtempSync(join(tmpdir(), 'cleanup-fixture-build-')), 'fixture.mjs');
      const built = spawnSync('bun', ['scripts/cleanup-broker/build-test-fixture.ts', bundle], {
        cwd: process.cwd(),
        encoding: 'utf8',
      });
      expect(built.status, built.stderr).toBe(0);
    });
    async function run(
      mode: 'preview' | 'execute',
      disposition: 'grant' | 'deny' | 'unknown' = 'grant',
    ) {
      const directory = mkdtempSync(join(tmpdir(), 'cleanup-executor-fd-'));
      const git = (...args: string[]) => {
        const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
        expect(result.status, result.stderr).toBe(0);
        return result.stdout.trim();
      };
      git('init', '--bare', 'remote.git');
      git('init', 'work');
      git(
        '-C',
        'work',
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '--allow-empty',
        '-m',
        'fixture',
      );
      const sha = git('-C', 'work', 'rev-parse', 'HEAD');
      git('-C', 'work', 'push', join(directory, 'remote.git'), 'HEAD:refs/heads/fixture');
      const input = join(directory, 'input'),
        output = join(directory, 'output');
      expect(spawnSync('mkfifo', [input, output]).status).toBe(0);
      const readFd = openSync(output, constants.O_RDWR | constants.O_NONBLOCK),
        writeFd = openSync(input, constants.O_RDWR);
      const log = join(directory, 'calls.log');
      const request = fixture();
      request.mode = mode;
      request.request.mode = mode;
      request.request.operationId = mode === 'execute' ? 'operation-1' : '';
      request.binding.operationId = request.request.operationId;
      request.binding.target.expectedSha = sha;
      request.binding.requestDigest = createHash('sha256')
        .update(
          JSON.stringify([
            'openslack.cleanup_execution_digest.v1',
            request.request.agentId,
            request.request.principalId,
            request.request.runtimeUid,
            request.request.runId,
            request.request.repo,
            request.request.remote,
            '1',
            request.request.permitId,
            request.request.operationId,
          ]),
        )
        .digest('hex');
      request.registry = JSON.stringify({
        schema: 'openslack.agent_registry.v2',
        agent_id: 'cleanup',
        display_name: 'Cleanup',
        employee_type: 'ai_agent',
        identity: { uid: 'runtime-1', principal_id: 'principal:cleanup', status: 'active' },
        vendor: { provider: 'openai', runtime: 'codex' },
        employment: { status: 'active', hired_at: '2026-09-21T00:00:00Z' },
        capabilities: { primary: ['typescript'] },
        repositories: {
          workspace_repo: { owner: 'example', repo: 'qualification', default_branch: 'main' },
        },
        permissions: {
          paths: { allow: [], deny: [] },
          actions: { 'pr.cleanup_branch_scoped.v1': 'allow', 'pr.cleanup_branch': 'deny' },
          github: {
            can_create_pr: false,
            can_comment: false,
            can_approve: false,
            can_merge: false,
          },
          max_risk_zone: 'yellow',
        },
        execution: {},
        output_contract: { must_create: [], may_create: [], must_not_create: [] },
        approval_rules: { require_human_approval_for: ['merge_to_main'] },
      });
      request.app.privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
        .privateKey.export({ type: 'pkcs8', format: 'pem' })
        .toString();
      const child = spawn('node', [bundle], {
        stdio: ['ignore', 'ignore', 'pipe', writeFd, readFd],
        env: {
          ...process.env,
          CLEANUP_FIXTURE_LOG: log,
          CLEANUP_FIXTURE_SHA: sha,
          CLEANUP_FIXTURE_BARE: join(directory, 'remote.git'),
          CLEANUP_FIXTURE_WORK: join(directory, 'work'),
          CLEANUP_FIXTURE_UNKNOWN: disposition === 'unknown' ? '1' : '0',
          CLEANUP_FIXTURE_PROTECTED: mode === 'preview' && disposition === 'deny' ? '1' : '0',
        },
      });
      let stderr = '';
      child.stderr!.on('data', (data) => {
        stderr += data;
      });
      const frames: Record<string, unknown>[] = [];
      let finalPreviewState: unknown;
      let responseFailure: unknown;
      const onLine = async (line: string) => {
        const frame = JSON.parse(line) as Record<string, unknown>;
        frames.push(frame);
        if (frame.type === 'admit') {
          if (disposition === 'deny') {
            const preview = await run('preview', 'deny');
            finalPreviewState = preview.frames[0]?.state;
            expect(finalPreviewState).toBe('BLOCKED_BRANCH_RESERVED');
            expect(preview.calls).not.toContain('push');
          }
          writeSync(
            writeFd,
            JSON.stringify({
              ...frame,
              type: disposition === 'deny' ? 'rejected' : 'admitted',
              ...(disposition === 'deny' ? { reason: 'FINAL_SEND_DENIED' } : {}),
            }) + '\n',
          );
        }
      };
      let buffered = '';
      const poll = () => {
        const chunk = Buffer.alloc(32768);
        try {
          const count = readSync(readFd, chunk);
          buffered += chunk.subarray(0, count).toString();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EAGAIN') throw error;
        }
        let newline: number;
        while ((newline = buffered.indexOf('\n')) >= 0) {
          void onLine(buffered.slice(0, newline)).catch((error) => {
            responseFailure = error;
            child.kill('SIGKILL');
          });
          buffered = buffered.slice(newline + 1);
        }
      };
      const polling = setInterval(poll, 5);
      writeSync(writeFd, JSON.stringify(request) + '\n');
      const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
      const code = await new Promise<number | null>((done) => child.once('exit', done));
      clearTimeout(timer);
      clearInterval(polling);
      poll();
      closeSync(writeFd);
      closeSync(readFd);
      if (responseFailure) throw responseFailure;
      expect(code, stderr).toBe(0);
      const calls = readFileSync(log, 'utf8').split('\n');
      return {
        frames,
        calls,
        ref: git(
          '--git-dir',
          'remote.git',
          'for-each-ref',
          '--format=%(objectname)',
          'refs/heads/fixture',
        ),
        sha,
        finalPreviewState,
      };
    }
    it('preview reaches CLEANUP_READY through real PRMS without admission or push', async () => {
      const result = await run('preview');
      expect(result.frames).toHaveLength(1);
      expect(result.frames[0]).toMatchObject({
        type: 'result',
        state: 'CLEANUP_READY',
        attempted: false,
      });
      expect(result.calls).toContain('protected');
      expect(result.calls).toContain('dependencies');
      expect(result.calls).not.toContain('push');
      expect(result.ref).toBe(result.sha);
    });
    it('execute waits for bound grant then performs one real conditional bare Git deletion', async () => {
      const result = await run('execute');
      expect(result.frames.map((f) => f.type)).toEqual(['admit', 'result']);
      expect(result.frames[1]).toMatchObject({ state: 'DELETED', attempted: true });
      expect(result.calls.filter((c) => c === 'push')).toHaveLength(1);
      expect(result.ref).toBe('');
    });
    it('final broker rejection produces zero pushes and preserves ref', async () => {
      const result = await run('execute', 'deny');
      expect(result.frames[1]).toMatchObject({ state: 'BLOCKED_AUTHORIZATION', attempted: false });
      expect(result.finalPreviewState).toBe('BLOCKED_BRANCH_RESERVED');
      expect(result.calls).not.toContain('push');
      expect(result.ref).toBe(result.sha);
    });
    it('unknown post-send result never repeats the push', async () => {
      const result = await run('execute', 'unknown');
      expect(result.frames[1]).toMatchObject({ attempted: true });
      expect(result.frames[1]?.state).not.toBe('DELETED');
      expect(result.calls.filter((c) => c === 'push')).toHaveLength(1);
    });
  },
);
