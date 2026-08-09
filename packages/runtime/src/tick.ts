import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { FileClaimBroker } from '@openslack/core';
import type { ClaimResult } from '@openslack/core';
import type { IssueTask } from '@openslack/github';
import { authorizeAgentAction } from '@openslack/kernel';
import type { AgentPrincipal } from '@openslack/kernel';
import { resolveAgentPrincipal } from './identity.js';

type GitHubClaimModule = Pick<
  typeof import('@openslack/github'),
  'claimIssueTask' | 'getIssueTaskByNumber' | 'queryReadyIssueTasks' | 'runAutoClaimGates'
>;

export interface TickDependencies {
  resolveAgentPrincipal?: typeof resolveAgentPrincipal;
  authorizeAgentAction?: typeof authorizeAgentAction;
  parseAgentRegistry?: (typeof import('@openslack/workspace'))['parseAgentRegistry'];
  github?: GitHubClaimModule;
}

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
  issueNumber?: number;
}

export interface TickTargetOptionsInput {
  source?: TickOptions['source'];
  issueNumber?: string | number;
}

export type TickTargetOptionsValidation =
  | { readonly valid: true; readonly issueNumber?: number }
  | { readonly valid: false; readonly message: string };

export function validateTickTargetOptions(
  input: TickTargetOptionsInput,
): TickTargetOptionsValidation {
  if (input.issueNumber === undefined) return { valid: true };

  let issueNumber: number;
  if (typeof input.issueNumber === 'string') {
    if (!/^[1-9]\d*$/u.test(input.issueNumber)) {
      return {
        valid: false,
        message: 'TARGET_ISSUE_NOT_CLAIMABLE: issue number must be a positive integer',
      };
    }
    issueNumber = Number(input.issueNumber);
  } else {
    issueNumber = input.issueNumber;
  }
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
    return {
      valid: false,
      message: 'TARGET_ISSUE_NOT_CLAIMABLE: issue number must be a positive integer',
    };
  }
  if ((input.source ?? 'local') !== 'github-issues') {
    return {
      valid: false,
      message: 'TARGET_ISSUE_NOT_CLAIMABLE: --issue-number requires --source github-issues',
    };
  }
  return { valid: true, issueNumber };
}

function targetFailure(issueNumber: number, reason: string): string {
  return `TARGET_ISSUE_NOT_CLAIMABLE: issue #${issueNumber}: ${reason.trim() || 'claim was denied'}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return 'unknown error';
}

export async function tickAgent(
  agentId: string,
  options: TickOptions = {},
  dependencies: TickDependencies = {},
): Promise<TickResult> {
  const root = findRepoRoot();
  const source = options.source || 'local';
  const targetOptions = validateTickTargetOptions({ source, issueNumber: options.issueNumber });
  if (!targetOptions.valid) {
    return {
      agentId,
      action: 'error',
      message: targetOptions.message,
    };
  }
  const issueNumber = targetOptions.issueNumber;

  // Resolve agent principal and permission snapshot
  const resolved = (dependencies.resolveAgentPrincipal ?? resolveAgentPrincipal)({
    root,
    agentId,
    provider: 'cli',
  });
  if ('error' in resolved) {
    return { agentId, action: 'error', message: resolved.error };
  }

  const { principal, snapshot } = resolved;

  // Authorize task.claim action
  const authorize = dependencies.authorizeAgentAction ?? authorizeAgentAction;
  const auth = authorize({ snapshot, action: 'task.claim' });
  if (auth.decision !== 'allow') {
    return {
      agentId,
      action: 'error',
      principal,
      message:
        auth.decision === 'ask'
          ? `Authorization requires confirmation: ${auth.evidence.reason}`
          : `Authorization denied: ${auth.evidence.reason}`,
    };
  }

  // Extract typed capabilities from the parsed registry
  const parseAgentRegistry =
    dependencies.parseAgentRegistry ?? (await import('@openslack/workspace')).parseAgentRegistry;
  const registry = parseAgentRegistry(root, agentId);
  const typedCapabilities = registry
    ? [...registry.capabilities.primary, ...registry.capabilities.secondary]
    : [];

  // --- GitHub Issues path ---
  if (source === 'github-issues') {
    try {
      const { claimIssueTask, getIssueTaskByNumber, queryReadyIssueTasks, runAutoClaimGates } =
        dependencies.github ?? (await import('@openslack/github'));

      let tasks: IssueTask[];
      if (issueNumber !== undefined) {
        const lookup = await getIssueTaskByNumber(issueNumber);
        if (lookup.status === 'not_found') {
          return {
            agentId,
            action: 'error',
            principal,
            message: targetFailure(issueNumber, 'issue was not found'),
          };
        }
        if (lookup.status === 'pull_request') {
          return {
            agentId,
            action: 'error',
            principal,
            message: targetFailure(issueNumber, 'number refers to a pull request'),
          };
        }
        tasks = [lookup.task];
      } else {
        tasks = await queryReadyIssueTasks({ capabilities: typedCapabilities });
      }
      if (tasks.length === 0) {
        return {
          agentId,
          action: 'idle',
          principal,
          message: 'No ready issues on GitHub. Idle exit.',
        };
      }

      for (const task of tasks) {
        const reject = (reason: string): TickResult | undefined => {
          if (issueNumber === undefined) return undefined;
          return {
            agentId,
            action: 'error',
            principal,
            message: targetFailure(task.issueNumber, reason),
          };
        };

        if (task.state !== 'open') {
          const result = reject('issue is not open');
          if (result) return result;
          continue;
        }
        if (!task.labels.includes('openslack:task') || !task.labels.includes('openslack:ready')) {
          const result = reject('issue must have openslack:task and openslack:ready labels');
          if (result) return result;
          continue;
        }

        let gate: ReturnType<typeof runAutoClaimGates>;
        try {
          gate = runAutoClaimGates({
            body: task.body,
            agentCapabilities: registry
              ? {
                  primary: registry.capabilities.primary,
                  secondary: registry.capabilities.secondary,
                }
              : {},
            agentMaxRiskLevel: registry?.task_matching?.max_risk_level ?? 'medium',
          });
        } catch (error) {
          const result = reject(`task manifest gate failed: ${errorMessage(error)}`);
          if (result) return result;
          continue;
        }
        if (!gate.allowed || !gate.manifest) {
          const result = reject(gate.reason || 'task manifest gate rejected the issue');
          if (result) return result;
          continue;
        }

        const candidateAuth = authorize({
          snapshot,
          action: 'task.claim',
          changedPaths: gate.changedPaths,
          riskZone: gate.riskZone,
        });
        if (candidateAuth.decision !== 'allow') {
          const result = reject(`authorization denied: ${candidateAuth.evidence.reason}`);
          if (result) return result;
          continue;
        }

        const result = await claimIssueTask({
          issueNumber: task.issueNumber,
          agentId,
          ttlMinutes: gate.manifest.lease?.ttl_minutes ?? 60,
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
        if (issueNumber !== undefined) {
          return {
            agentId,
            action: 'error',
            principal,
            message: targetFailure(task.issueNumber, result.reason || 'claim was denied'),
          };
        }
        if (result.reason !== 'ALREADY_CLAIMED') {
          return {
            agentId,
            action: 'error',
            principal,
            message: `GitHub claim failed for issue #${task.issueNumber}: ${result.reason ?? 'claim was denied'}`,
          };
        }
      }

      return {
        agentId,
        action: 'idle',
        principal,
        message: 'No eligible unclaimed ready issues on GitHub. Idle exit.',
      };
    } catch (e) {
      return {
        agentId,
        action: 'error',
        principal,
        message:
          issueNumber === undefined
            ? `GitHub claim failed: ${errorMessage(e)}`
            : targetFailure(issueNumber, errorMessage(e)),
      };
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
    const result = broker.claimTask({
      agentId,
      taskId: task.id,
      ttlMinutes: 60,
      capabilities: typedCapabilities,
    });
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
