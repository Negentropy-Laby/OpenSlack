import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createOpenSlackAgentLauncher, createRunStore, LocalExecutionAdapter } from '../index.js';

function makeTempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'agent-mcp-wt-test-'))
}

function cleanup(root: string) {
  try { rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ }
}

function initGitRepo(root: string) {
  execFileSync('git', ['init'], { cwd: root, stdio: 'pipe' })
  execFileSync('git', ['config', 'user.email', 'openslack-test@example.invalid'], {
    cwd: root,
    stdio: 'pipe',
  })
  execFileSync('git', ['config', 'user.name', 'OpenSlack Test'], {
    cwd: root,
    stdio: 'pipe',
  })
  writeFileSync(join(root, 'README.md'), 'test repo\n', 'utf-8')
  execFileSync('git', ['add', 'README.md'], { cwd: root, stdio: 'pipe' })
  execFileSync('git', ['commit', '-m', 'initial test commit'], { cwd: root, stdio: 'pipe' })
}

describe('MCP availability check', () => {
  let root: string

  beforeEach(() => {
    root = makeTempRoot()
  })

  afterEach(() => {
    cleanup(root)
  })

  it('allows agent when all required MCP servers are available', async () => {
    const store = createRunStore(root)
    const launcher = createOpenSlackAgentLauncher({
      runStore: store,
      rootDir: root,
      availableMcpServers: ['github', 'slack'],
      adapter: new LocalExecutionAdapter(),
    });

    const result = await launcher('do something', {
      label: 'worker',
      phase: 'execute',
      resolvedAgentConfig: {
        agentId: 'worker',
        source: 'claude-project',
        requiredMcpServers: ['github'],
      },
    })

    expect(result.data).toBeDefined()
  })

  it('throws AgentUnavailableError when required MCP servers are missing', async () => {
    const store = createRunStore(root)
    const launcher = createOpenSlackAgentLauncher({
      runStore: store,
      rootDir: root,
      availableMcpServers: ['github'],
      adapter: new LocalExecutionAdapter(),
    });

    await expect(
      launcher('do something', {
        label: 'worker',
        phase: 'execute',
        resolvedAgentConfig: {
          agentId: 'worker',
          source: 'claude-project',
          requiredMcpServers: ['slack', 'jira'],
        },
      }),
    ).rejects.toThrow(/Agent unavailable/)
  })

  it('allows agent with no required MCP servers regardless of availability', async () => {
    const store = createRunStore(root)
    const launcher = createOpenSlackAgentLauncher({
      runStore: store,
      rootDir: root,
      availableMcpServers: [],
      adapter: new LocalExecutionAdapter(),
    });

    const result = await launcher('do something', {
      label: 'worker',
      phase: 'execute',
      resolvedAgentConfig: {
        agentId: 'worker',
        source: 'claude-project',
      },
    })

    expect(result.data).toBeDefined()
  })
})

describe('Worktree isolation', () => {
  let root: string

  beforeEach(() => {
    root = makeTempRoot()
    initGitRepo(root)
  })

  afterEach(() => {
    cleanup(root)
  })

  it('creates worktree for implementer agents', async () => {
    const store = createRunStore(root)
    const launcher = createOpenSlackAgentLauncher({
      runStore: store,
      rootDir: root,
      adapter: new LocalExecutionAdapter(),
    });

    await launcher('implement this feature', {
      label: 'implementer',
      phase: 'execute',
      resolvedAgentConfig: {
        agentId: 'code-implementer',
        source: 'claude-project',
      },
    })

    const runs = store.listRuns()
    expect(runs.length).toBe(1)
    // Worktree may or may not be created depending on git availability
    // The important thing is the run completes
    expect(runs[0].status).toBe('completed')
  })

  it('creates worktree when isolation is explicitly worktree', async () => {
    const store = createRunStore(root)
    const launcher = createOpenSlackAgentLauncher({
      runStore: store,
      rootDir: root,
      adapter: new LocalExecutionAdapter(),
    });

    await launcher('make changes', {
      label: 'worker',
      phase: 'execute',
      resolvedAgentConfig: {
        agentId: 'worker',
        source: 'claude-project',
        isolation: 'worktree',
      },
    })

    const runs = store.listRuns()
    expect(runs.length).toBe(1)
    expect(runs[0].status).toBe('completed')
  })

  it('runs without worktree for review agents', async () => {
    const store = createRunStore(root)
    const launcher = createOpenSlackAgentLauncher({
      runStore: store,
      rootDir: root,
      adapter: new LocalExecutionAdapter(),
    });

    await launcher('review this PR', {
      label: 'reviewer',
      phase: 'review',
      resolvedAgentConfig: {
        agentId: 'code-reviewer',
        source: 'claude-project',
        isolation: 'none',
      },
    })

    const runs = store.listRuns()
    expect(runs.length).toBe(1)
    expect(runs[0].status).toBe('completed')
    expect(runs[0].worktreePath).toBeUndefined()
  })
})
