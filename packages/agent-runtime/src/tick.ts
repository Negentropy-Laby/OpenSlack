import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

interface AgentRegistry {
  agent_id: string;
  capabilities: { primary: string[]; secondary: string[] };
  execution: { max_parallel_tasks: number; lease_ttl_minutes: number; heartbeat_interval_minutes: number; max_task_runtime_minutes: number };
  workspace_permissions: { allow: string[]; deny: string[] };
}

interface OpenTask {
  id: string;
  filePath: string;
}

export interface TickResult {
  agentId: string;
  action: 'claimed' | 'idle' | 'error';
  taskId?: string;
  leaseId?: string;
  message: string;
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

function loadRegistry(root: string, agentId: string): AgentRegistry | null {
  const regPath = join(root, '.openslack', 'agents', 'registry', `${agentId}.yaml`);
  if (!existsSync(regPath)) return null;
  try {
    // Simple YAML extraction — avoids full parser dependency in agent-runtime
    const raw = readFileSync(regPath, 'utf-8');
    const caps: string[] = [];
    let agent_id = agentId;
    let lease_ttl = 60;
    let heartbeat = 10;
    let maxParallel = 1;
    let maxRuntime = 120;
    const allow: string[] = [];
    const deny: string[] = [];

    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('agent_id:')) agent_id = trimmed.split(':')[1].trim().replace(/"/g, '');
      if (trimmed.startsWith('- "') || trimmed.startsWith("- '") || trimmed.startsWith('- ')) {
        const cap = trimmed.replace(/^-\s*["']?/, '').replace(/["']$/, '').trim();
        caps.push(cap);
      }
      if (trimmed.startsWith('lease_ttl_minutes:')) lease_ttl = parseInt(trimmed.split(':')[1].trim(), 10);
      if (trimmed.startsWith('heartbeat_interval_minutes:')) heartbeat = parseInt(trimmed.split(':')[1].trim(), 10);
      if (trimmed.startsWith('max_parallel_tasks:')) maxParallel = parseInt(trimmed.split(':')[1].trim(), 10);
      if (trimmed.startsWith('max_task_runtime_minutes:')) maxRuntime = parseInt(trimmed.split(':')[1].trim(), 10);
    }

    return {
      agent_id,
      capabilities: { primary: caps, secondary: [] },
      execution: { max_parallel_tasks: maxParallel, lease_ttl_minutes: lease_ttl, heartbeat_interval_minutes: heartbeat, max_task_runtime_minutes: maxRuntime },
      workspace_permissions: { allow, deny },
    };
  } catch {
    return null;
  }
}

function getOpenTasks(root: string): OpenTask[] {
  const openDir = join(root, '.openslack', 'tasks', 'open');
  if (!existsSync(openDir)) return [];
  const tasks: OpenTask[] = [];
  try {
    const entries = readdirSync(openDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const taskDir = join(openDir, entry.name);
        const files = readdirSync(taskDir);
        const yamlFile = files.find((f) => f.endsWith('.yaml'));
        if (yamlFile) {
          tasks.push({ id: entry.name, filePath: join(taskDir, yamlFile) });
        }
      }
    }
  } catch {
    // Directory listing failed
  }
  return tasks;
}

export function tickAgent(agentId: string): TickResult {
  const root = findRepoRoot();

  // 1. Load registry
  const registry = loadRegistry(root, agentId);
  if (!registry) {
    return { agentId, action: 'error', message: `Registry not found for agent ${agentId}` };
  }

  // 2. Check for open tasks
  const openTasks = getOpenTasks(root);

  if (openTasks.length === 0) {
    return { agentId, action: 'idle', message: 'No open tasks available. Idle exit.' };
  }

  // 3. Select first task (in MVP, no capability matching — just pick first)
  const task = openTasks[0];

  // 4. Attempt claim via ClaimBroker would go here when GitHub Provider is wired
  // For MVP local mode: log that task was found
  return {
    agentId,
    action: 'claimed',
    taskId: task.id,
    message: `Found task ${task.id} at ${task.filePath}. Claim via Claim Broker would proceed.`,
  };
}
