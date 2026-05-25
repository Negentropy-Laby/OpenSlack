import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { FileClaimBroker } from '@openslack/core';
import type { ClaimResult } from '@openslack/core';
import type { IssueClaimResult } from '@openslack/github';
import { authorizeAgentAction } from '@openslack/kernel';
import type { AgentPrincipal, AgentPermissionSnapshot } from '@openslack/kernel';
import { resolveAgentPrincipal } from './identity.js';

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
  principal?: AgentPrincipal;
}

export interface TickOptions {
  source?: 'local' | 'github-issues';
}

export async function tickAgent(agentId: string, options: TickOptions = {}): Promise<TickResult> {
  const root = findRepoRoot();
  const source = options.source || 'local';

  // Resolve agent principal and permission snapshot
  const resolved = resolveAgentPrincipal({ root, agentId, provider: 'cli' });
  if ('error' in resolved) {
    return { agentId, action: 'error', message: resolved.error };
  }

  const { principal, snapshot } = resolved;

  // Authorize task.claim action
  const auth = authorizeAgentAction({ snapshot, action: 'task.claim' });
  if (auth.decision !== 'allow') {
    return {
      agentId,
      action: 'error',
      principal,
      message: auth.decision === 'ask'
        ? `Authorization requires confirmation: ${auth.evidence.reason}`
        : `Authorization denied: ${auth.evidence.reason}`,
    };
  }

  // Extract typed capabilities from the parsed registry
  const { parseAgentRegistry } = await import('@openslack/workspace');
  const registry = parseAgentRegistry(root, agentId);
  const typedCapabilities = registry
    ? [...registry.capabilities.primary, ...registry.capabilities.secondary]
    : [];

  // --- GitHub Issues path ---
  if (source === 'github-issues') {
    try {
      const { queryReadyIssueTasks, claimIssueTask } = await import('@openslack/github');

      const tasks = await queryReadyIssueTasks({ capabilities: typedCapabilities });
      if (tasks.length === 0) {
        return { agentId, action: 'idle', principal, message: 'No ready issues on GitHub. Idle exit.' };
      }

      for (const task of tasks) {
        const result = await claimIssueTask({
          issueNumber: task.issueNumber,
          agentId,
          ttlMinutes: 60,
          capabilities: typedCapabilities,
          principal,
        });
        if (result.claimStatus === 'granted') {
          return {
            agentId,
            action: 'claimed',
            taskId: `#${task.issueNumber}`,
            leaseId: result.claimRef,
            principal,
            message: `Claimed issue #${task.issueNumber} via ref ${result.claimRef}`,
          };
        }
      }

      return { agentId, action: 'idle', principal, message: 'All ready issues already claimed.' };
    } catch (e) {
      return { agentId, action: 'error', principal, message: `GitHub claim failed: ${(e as Error).message}` };
    }
  }

  // --- Local path (default) ---
  const openTasks = getOpenTasks(root);
  if (openTasks.length === 0) {
    return { agentId, action: 'idle', principal, message: 'No open tasks available. Idle exit.' };
  }

  const broker = new FileClaimBroker(root);
  for (const task of openTasks) {
    broker.setTaskReady(task.id);
    const result = broker.claimTask({ agentId, taskId: task.id, ttlMinutes: 60, capabilities: typedCapabilities });
    if (result.claimStatus === 'granted') {
      return {
        agentId,
        action: 'claimed',
        taskId: task.id,
        leaseId: result.leaseId,
        claimResult: result,
        principal,
        message: `Claimed task ${task.id} — lease ${result.leaseId} expires ${result.expiresAt}`,
      };
    }
  }

  return { agentId, action: 'idle', principal, message: 'No claimable tasks found.' };
}
