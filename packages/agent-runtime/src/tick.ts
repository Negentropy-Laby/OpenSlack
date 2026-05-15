import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { FileClaimBroker } from '@openslack/core';
import type { ClaimResult } from '@openslack/core';

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

export function tickAgent(agentId: string): TickResult {
  const root = findRepoRoot();

  // Load capabilities
  const capabilities = loadAgentCapabilities(root, agentId);

  // Check for open tasks
  const openTasks = getOpenTasks(root);
  if (openTasks.length === 0) {
    return { agentId, action: 'idle', message: 'No open tasks available. Idle exit.' };
  }

  // Load persistent claim broker
  const broker = new FileClaimBroker(root);

  // Try to claim each task until one succeeds
  for (const task of openTasks) {
    broker.setTaskReady(task.id);
    const result = broker.claimTask({
      agentId,
      taskId: task.id,
      ttlMinutes: 60,
      capabilities,
    });

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
    // If denied, try next task
  }

  return { agentId, action: 'idle', message: 'No claimable tasks found.' };
}
