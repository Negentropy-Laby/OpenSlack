import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

export interface TaskEntry {
  id: string;
  title: string;
  status: string;
  category: string; // open, claimed, running, review, blocked, done
  filePath: string;
}

export interface EvolEntry {
  id: string;
  title: string;
  status: string;
  filePath: string;
}

export interface AgentEntry {
  agentId: string;
  displayName: string;
  status: string;
  department: string;
  filePath: string;
}

export interface WorkspaceIndex {
  tasks: TaskEntry[];
  evolutions: EvolEntry[];
  agents: AgentEntry[];
  indexedAt: string;
  taskCounts: Record<string, number>;
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

function scanYamlFiles(dir: string): string[] {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      files.push(fullPath);
    }
    return files.filter((f) => f.endsWith('.yaml'));
  } catch {
    return [];
  }
}

function scanTaskDirs(root: string): TaskEntry[] {
  const tasksDir = join(root, '.openslack', 'tasks');
  const categories = ['open', 'claimed', 'running', 'review', 'blocked', 'done'];
  const tasks: TaskEntry[] = [];

  for (const category of categories) {
    const categoryDir = join(tasksDir, category);
    if (!existsSync(categoryDir)) continue;
    try {
      const entries = readdirSync(categoryDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const taskDir = join(categoryDir, entry.name);
          const yamlFiles = scanYamlFiles(taskDir);
          for (const yf of yamlFiles) {
            try {
              const raw = readFileSync(yf, 'utf-8');
              const titleMatch = raw.match(/^title:\s*["']?(.+?)["']?\s*$/m);
              const idMatch = raw.match(/^id:\s*(.+?)\s*$/m);
              tasks.push({
                id: idMatch?.[1]?.trim() || entry.name,
                title: titleMatch?.[1]?.trim() || entry.name,
                status: category,
                category,
                filePath: yf,
              });
            } catch {
              tasks.push({
                id: entry.name,
                title: entry.name,
                status: category,
                category,
                filePath: yf,
              });
            }
          }
        }
      }
    } catch {
      /* ignore */
    }
  }
  return tasks;
}

function scanEvolutionBacklog(root: string): EvolEntry[] {
  const backlogDir = join(root, '.openslack', 'self', 'evolution_backlog');
  if (!existsSync(backlogDir)) return [];
  const yamlFiles = scanYamlFiles(backlogDir);
  return yamlFiles.map((f) => {
    try {
      const raw = readFileSync(f, 'utf-8');
      const idMatch = raw.match(/^id:\s*(.+?)\s*$/m);
      const titleMatch = raw.match(/^title:\s*["']?(.+?)["']?\s*$/m);
      const statusMatch = raw.match(/^status:\s*(.+?)\s*$/m);
      return {
        id: idMatch?.[1]?.trim() || '',
        title: titleMatch?.[1]?.trim() || '',
        status: statusMatch?.[1]?.trim() || 'unknown',
        filePath: f,
      };
    } catch {
      return { id: '', title: '', status: 'unknown', filePath: f };
    }
  });
}

function scanAgentRegistry(root: string): AgentEntry[] {
  const registryDir = join(root, '.openslack', 'agents', 'registry');
  if (!existsSync(registryDir)) return [];
  const yamlFiles = scanYamlFiles(registryDir);
  return yamlFiles.map((f) => {
    try {
      const raw = readFileSync(f, 'utf-8');
      const idMatch = raw.match(/^agent_id:\s*["']?(.+?)["']?\s*$/m);
      const nameMatch = raw.match(/^display_name:\s*["']?(.+?)["']?\s*$/m);
      const deptMatch = raw.match(/^\s+department:\s*["']?(.+?)["']?\s*$/m);
      const statusMatch = raw.match(/^\s+status:\s*["']?(.+?)["']?\s*$/m);
      return {
        agentId: idMatch?.[1]?.trim() || '',
        displayName: nameMatch?.[1]?.trim() || '',
        status: statusMatch?.[1]?.trim() || 'unknown',
        department: deptMatch?.[1]?.trim() || '',
        filePath: f,
      };
    } catch {
      return { agentId: '', displayName: '', status: 'unknown', department: '', filePath: f };
    }
  });
}

export function buildIndex(rootPath?: string): WorkspaceIndex {
  const root = rootPath || findRepoRoot();
  const tasks = scanTaskDirs(root);
  const evolutions = scanEvolutionBacklog(root);
  const agents = scanAgentRegistry(root);

  const taskCounts: Record<string, number> = {};
  for (const t of tasks) {
    taskCounts[t.category] = (taskCounts[t.category] || 0) + 1;
  }

  const index: WorkspaceIndex = {
    tasks,
    evolutions,
    agents,
    indexedAt: new Date().toISOString(),
    taskCounts,
  };

  // Write to .openslack/index.json
  const indexPath = join(root, '.openslack', 'index.json');
  mkdirSync(dirname(indexPath), { recursive: true });
  writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf-8');

  return index;
}
