import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { FileClaimBroker } from '@openslack/core';
import type { ClaimResult } from '@openslack/core';
import type { IssueClaimResult } from '@openslack/github-provider';

function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'openslack.yaml'))) return dir;
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

function loadAgentCapabilities(root: string, agentId: string): string[] {
  const regPath = join(root, '.openslack', 'agents', 'registry', `${agentId}.yaml`);
  if (!existsSync(regPath)) return [];
  try {
    const raw = readFileSync(regPath, 'utf-8');
    const caps: string[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('- "') || trimmed.startsWith("- '") || trimmed.startsWith('- ')) {
        caps.push(trimmed.replace(/^-\s*["']?/, '').replace(/["']$/, '').trim());
      }
    }
    return caps;
  } catch {
    return [];
  }
}

function getOpenTasks(root: string): Array<{ id: string; filePath: string }> {
  const openDir = join(root, '.openslack', 'tasks', 'open');
  if (!existsSync(openDir)) return [];
  try {
    const entries = readdirSync(openDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => ({ id: e.name, filePath: join(openDir, e.name) }));
  } catch {
    return [];
  }
}

export interface TickResult {
  agentId: string;
  action: 'claimed' | 'idle' | 'error';
  taskId?: string;
  leaseId?: string;
  claimResult?: ClaimResult;
  message: string;
}

export interface TickOptions {
  source?: 'local' | 'github-issues';
}

export async function tickAgent(agentId: string, options: TickOptions = {}): Promise<TickResult> {
  const root = findRepoRoot();
  const capabilities = loadAgentCapabilities(root, agentId);
  const source = options.source || 'local';

  // --- GitHub Issues path ---
  if (source === 'github-issues') {
    try {
      const { queryReadyIssueTasks, claimIssueTask } = await import('@openslack/github-provider');

      const tasks = await queryReadyIssueTasks({ capabilities });
      if (tasks.length === 0) {
        return { agentId, action: 'idle', message: 'No ready issues on GitHub. Idle exit.' };
      }

      for (const task of tasks) {
        const result = await claimIssueTask({ issueNumber: task.issueNumber, agentId, ttlMinutes: 60, capabilities });
        if (result.claimStatus === 'granted') {
          return {
            agentId,
            action: 'claimed',
            taskId: `#${task.issueNumber}`,
            leaseId: result.claimRef,
            message: `Claimed issue #${task.issueNumber} via ref ${result.claimRef}`,
          };
        }
      }

      return { agentId, action: 'idle', message: 'All ready issues already claimed.' };
    } catch (e) {
      return { agentId, action: 'error', message: `GitHub claim failed: ${(e as Error).message}` };
    }
  }

  // --- Local path (default) ---
  const openTasks = getOpenTasks(root);
  if (openTasks.length === 0) {
    return { agentId, action: 'idle', message: 'No open tasks available. Idle exit.' };
  }

  const broker = new FileClaimBroker(root);
  for (const task of openTasks) {
    broker.setTaskReady(task.id);
    const result = broker.claimTask({ agentId, taskId: task.id, ttlMinutes: 60, capabilities });
    if (result.claimStatus === 'granted') {
      return {
        agentId,
        action: 'claimed',
        taskId: task.id,
        leaseId: result.leaseId,
        claimResult: result,
        message: `Claimed task ${task.id} — lease ${result.leaseId} expires ${result.expiresAt}`,
      };
    }
  }

  return { agentId, action: 'idle', message: 'No claimable tasks found.' };
}
