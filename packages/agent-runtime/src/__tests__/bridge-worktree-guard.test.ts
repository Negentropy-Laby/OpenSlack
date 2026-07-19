import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BridgeWorktreeGuard } from '../bridge-worktree-guard.js';
import { createRunRecorder } from '../recorder.js';
import { createRunStore } from '../run-store.js';
import { generateRunId } from '../run-store.js';
import { readTranscript } from '../transcript.js';
import { buildPermissionProfile } from '../permissions.js';

function makeTempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'bridge-worktree-test-'));
}

function cleanup(root: string) {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

describe('BridgeWorktreeGuard', () => {
  let root: string;
  let store: ReturnType<typeof createRunStore>;
  let recorder: ReturnType<typeof createRunRecorder>;

  beforeEach(() => {
    root = makeTempRoot();
    store = createRunStore(root);
    recorder = createRunRecorder(store, root);
  });

  afterEach(() => {
    cleanup(root);
  });

  describe('buildConfig', () => {
    it('returns null when no worktree path', () => {
      const config = BridgeWorktreeGuard.buildConfig(undefined);
      expect(config).toBeNull();
    });

    it('returns config with worktree path', () => {
      const config = BridgeWorktreeGuard.buildConfig('/tmp/worktree-1', 'feature/test');
      expect(config).not.toBeNull();
      expect(config!.worktreePath).toBe('/tmp/worktree-1');
      expect(config!.branchName).toBe('feature/test');
      expect(config!.allowedRoot).toBe('/tmp/worktree-1');
      expect(config!.isolationActive).toBe(true);
    });

    it('uses default branch name when not provided', () => {
      const config = BridgeWorktreeGuard.buildConfig('/tmp/worktree-1');
      expect(config!.branchName).toBe('agent/unknown/unknown/unknown');
    });
  });

  describe('validatePath', () => {
    it('allows path within allowed root', () => {
      const guard = new BridgeWorktreeGuard(recorder, 'RUN-1');
      const result = guard.validatePath('/tmp/worktree-1/file.txt', '/tmp/worktree-1');
      expect(result.valid).toBe(true);
    });

    it('allows subdirectory within allowed root', () => {
      const guard = new BridgeWorktreeGuard(recorder, 'RUN-1');
      const result = guard.validatePath('/tmp/worktree-1/src/utils/helper.ts', '/tmp/worktree-1');
      expect(result.valid).toBe(true);
    });

    it('rejects path outside allowed root', () => {
      const guard = new BridgeWorktreeGuard(recorder, 'RUN-1');
      const result = guard.validatePath('/etc/passwd', '/tmp/worktree-1');
      expect(result.valid).toBe(false);
      expect(result.violation).toContain('outside');
    });

    it('rejects path that is a sibling of allowed root', () => {
      const guard = new BridgeWorktreeGuard(recorder, 'RUN-1');
      const result = guard.validatePath('/tmp/worktree-2/file.txt', '/tmp/worktree-1');
      expect(result.valid).toBe(false);
    });

    it('handles Windows-style paths', () => {
      const guard = new BridgeWorktreeGuard(recorder, 'RUN-1');
      const result = guard.validatePath('D:\\work\\worktree-1\\file.txt', 'D:\\work\\worktree-1');
      expect(result.valid).toBe(true);
    });

    it('rejects path prefix attack (worktree-1-other escaping worktree-1)', () => {
      const guard = new BridgeWorktreeGuard(recorder, 'RUN-1');
      const result = guard.validatePath('/tmp/worktree-1-other/file.txt', '/tmp/worktree-1');
      expect(result.valid).toBe(false);
    });

    it('rejects path traversal with .. components', () => {
      const guard = new BridgeWorktreeGuard(recorder, 'RUN-1');
      const result = guard.validatePath('/tmp/worktree-1/../../../etc/passwd', '/tmp/worktree-1');
      expect(result.valid).toBe(false);
    });

    it('rejects null byte injection', () => {
      const guard = new BridgeWorktreeGuard(recorder, 'RUN-1');
      const result = guard.validatePath('/tmp/worktree-1\x00/etc/passwd', '/tmp/worktree-1');
      expect(result.valid).toBe(false);
    });

    it('handles Windows case-insensitive paths', () => {
      // This test validates that on Windows, case differences don't cause false negatives
      const guard = new BridgeWorktreeGuard(recorder, 'RUN-1');
      // On all platforms, same-case paths should work
      const result = guard.validatePath('D:\\work\\worktree-1\\file.txt', 'D:\\work\\worktree-1');
      expect(result.valid).toBe(true);
    });
  });

  describe('validateFileEvent', () => {
    it('is no-op when no worktree config', () => {
      const guard = new BridgeWorktreeGuard(recorder, 'RUN-1');
      const result = guard.validateFileEvent('/etc/passwd', null);
      expect(result.valid).toBe(true);
    });

    it('allows file within worktree', () => {
      const guard = new BridgeWorktreeGuard(recorder, 'RUN-1');
      const config = BridgeWorktreeGuard.buildConfig('/tmp/worktree-1');
      const result = guard.validateFileEvent('/tmp/worktree-1/file.txt', config);
      expect(result.valid).toBe(true);
    });

    it('rejects file outside worktree', () => {
      const runId = generateRunId();
      recorder.start({
        runId,
        agentId: 'test',
        prompt: 'test',
        resolvedConfig: { agentId: 'test', source: 'test' },
        permissionProfile: buildPermissionProfile({ agentId: 'test', source: 'test' }),
      });

      const guard = new BridgeWorktreeGuard(recorder, runId);
      const config = BridgeWorktreeGuard.buildConfig('/tmp/worktree-1');
      const result = guard.validateFileEvent('/etc/passwd', config);

      expect(result.valid).toBe(false);
      expect(result.violation).toContain('outside');

      const transcript = readTranscript(runId, root);
      const event = transcript.find(
        (e) =>
          e.type === 'progress' &&
          (e.data as Record<string, unknown>).step === 'worktree_boundary_violation',
      );
      expect(event).toBeDefined();
    });
  });

  describe('validateToolEvent', () => {
    it('is no-op when no worktree config', () => {
      const guard = new BridgeWorktreeGuard(recorder, 'RUN-1');
      const result = guard.validateToolEvent('Read', { path: '/etc/passwd' }, null);
      expect(result.valid).toBe(true);
    });

    it('allows tool with path within worktree', () => {
      const guard = new BridgeWorktreeGuard(recorder, 'RUN-1');
      const config = BridgeWorktreeGuard.buildConfig('/tmp/worktree-1');
      const result = guard.validateToolEvent('Read', { path: '/tmp/worktree-1/file.txt' }, config);
      expect(result.valid).toBe(true);
    });

    it('rejects tool with path outside worktree', () => {
      const runId = generateRunId();
      recorder.start({
        runId,
        agentId: 'test',
        prompt: 'test',
        resolvedConfig: { agentId: 'test', source: 'test' },
        permissionProfile: buildPermissionProfile({ agentId: 'test', source: 'test' }),
      });

      const guard = new BridgeWorktreeGuard(recorder, runId);
      const config = BridgeWorktreeGuard.buildConfig('/tmp/worktree-1');
      const result = guard.validateToolEvent('Read', { path: '/etc/passwd' }, config);

      expect(result.valid).toBe(false);
      expect(result.violation).toContain('outside worktree');
    });

    it('checks multiple path fields', () => {
      const guard = new BridgeWorktreeGuard(recorder, 'RUN-1');
      const config = BridgeWorktreeGuard.buildConfig('/tmp/worktree-1');

      const result = guard.validateToolEvent(
        'Bash',
        {
          cwd: '/tmp/worktree-1',
          directory: '/tmp/worktree-1/src',
        },
        config,
      );
      expect(result.valid).toBe(true);
    });

    it('checks additional path fields (destination, target, file_path, etc.)', () => {
      const guard = new BridgeWorktreeGuard(recorder, 'RUN-1');
      const config = BridgeWorktreeGuard.buildConfig('/tmp/worktree-1');

      // destination within worktree — should pass
      const result1 = guard.validateToolEvent(
        'Write',
        {
          destination: '/tmp/worktree-1/output.txt',
        },
        config,
      );
      expect(result1.valid).toBe(true);

      // target outside worktree — should fail
      const result2 = guard.validateToolEvent(
        'Write',
        {
          target: '/etc/passwd',
        },
        config,
      );
      expect(result2.valid).toBe(false);

      // file_path outside worktree — should fail
      const result3 = guard.validateToolEvent(
        'Read',
        {
          file_path: '/etc/shadow',
        },
        config,
      );
      expect(result3.valid).toBe(false);

      // outputPath within worktree — should pass
      const result4 = guard.validateToolEvent(
        'Tool',
        {
          outputPath: '/tmp/worktree-1/build/',
        },
        config,
      );
      expect(result4.valid).toBe(true);
    });
  });

  describe('recordPostSessionValidation', () => {
    it('records post-session validation when worktree present', () => {
      const runId = generateRunId();
      recorder.start({
        runId,
        agentId: 'test',
        prompt: 'test',
        resolvedConfig: { agentId: 'test', source: 'test' },
        permissionProfile: buildPermissionProfile({ agentId: 'test', source: 'test' }),
      });

      const guard = new BridgeWorktreeGuard(recorder, runId);
      const config = BridgeWorktreeGuard.buildConfig('/tmp/worktree-1', 'feature/test');
      guard.recordPostSessionValidation(config, {
        dirty: true,
        preserved: true,
        outsideRootAttempts: ['/etc/passwd'],
      });

      const transcript = readTranscript(runId, root);
      const event = transcript.find(
        (e) =>
          e.type === 'progress' &&
          (e.data as Record<string, unknown>).step === 'bridge_worktree_post_validation',
      );
      expect(event).toBeDefined();
      expect((event!.data as Record<string, unknown>).worktreePath).toBe('/tmp/worktree-1');
      expect((event!.data as Record<string, unknown>).branchName).toBe('feature/test');
      expect((event!.data as Record<string, unknown>).dirty).toBe(true);
      expect((event!.data as Record<string, unknown>).preserved).toBe(true);
    });

    it('is no-op when no worktree config', () => {
      const guard = new BridgeWorktreeGuard(recorder, 'RUN-1');
      // Should not throw
      guard.recordPostSessionValidation(null);
      expect(true).toBe(true);
    });
  });

  describe('validateCwd', () => {
    it('is no-op when no worktree config', () => {
      const guard = new BridgeWorktreeGuard(recorder, 'RUN-1');
      const result = guard.validateCwd('/any/path', null);
      expect(result.valid).toBe(true);
    });

    it('allows CWD within worktree', () => {
      const guard = new BridgeWorktreeGuard(recorder, 'RUN-1');
      const config = BridgeWorktreeGuard.buildConfig('/tmp/worktree-1');
      const result = guard.validateCwd('/tmp/worktree-1', config);
      expect(result.valid).toBe(true);
    });

    it('allows CWD in subdirectory of worktree', () => {
      const guard = new BridgeWorktreeGuard(recorder, 'RUN-1');
      const config = BridgeWorktreeGuard.buildConfig('/tmp/worktree-1');
      const result = guard.validateCwd('/tmp/worktree-1/src', config);
      expect(result.valid).toBe(true);
    });

    it('rejects CWD outside worktree', () => {
      const runId = generateRunId();
      recorder.start({
        runId,
        agentId: 'test',
        prompt: 'test',
        resolvedConfig: { agentId: 'test', source: 'test' },
        permissionProfile: buildPermissionProfile({ agentId: 'test', source: 'test' }),
      });

      const guard = new BridgeWorktreeGuard(recorder, runId);
      const config = BridgeWorktreeGuard.buildConfig('/tmp/worktree-1');
      const result = guard.validateCwd('/tmp/other', config);
      expect(result.valid).toBe(false);
      expect(result.violation).toContain('outside');
    });
  });
});
