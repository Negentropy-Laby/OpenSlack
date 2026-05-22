import { existsSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import type { Observation } from './observe.js';

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

function generateSignature(obs: Observation): string {
  return `${obs.type}:${obs.module}:${obs.summary.slice(0, 50)}`;
}

function getNextEvolutionNumber(root: string): number {
  const backlogDir = join(root, '.openslack', 'self', 'evolution_backlog');
  if (!existsSync(backlogDir)) return 1;

  // Count existing EVOL files
  let maxNum = 0;
  try {
    const files = readdirSync(backlogDir);
    for (const f of files) {
      const match = f.match(/^EVOL-\d{4}-(\d{6})\.yaml$/);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num > maxNum) maxNum = num;
      }
    }
  } catch {
    // ignore
  }
  return maxNum + 1;
}

function getSeverityOrder(severity: string): number {
  const order: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };
  return order[severity] || 0;
}

export function triageObservations(observations: Observation[]): string[] {
  const root = findRepoRoot();
  const createdTasks: string[] = [];

  if (observations.length === 0) return createdTasks;

  // Deduplicate by signature
  const seen = new Set<string>();
  const unique: Observation[] = [];
  for (const obs of observations) {
    const sig = generateSignature(obs);
    if (!seen.has(sig)) {
      seen.add(sig);
      unique.push(obs);
    }
  }

  // Sort by severity (highest first)
  unique.sort((a, b) => getSeverityOrder(b.severity) - getSeverityOrder(a.severity));

  // Create evolution tasks for unique observations
  for (const obs of unique) {
    const seq = getNextEvolutionNumber(root);
    const year = new Date().getFullYear();
    const taskId = `EVOL-${year}-${String(seq).padStart(6, '0')}`;

    const task = {
      schema: 'openslack.evolution_task.v1',
      id: taskId,
      title: `[AUTO] ${obs.summary}`,
      status: 'observed',
      created_at: obs.timestamp,
      created_by: 'agent:self_observer',
      depends_on: [],
      source: {
        type: obs.type,
        evidence: obs.evidence,
      },
      problem: {
        summary: obs.summary,
        affected_modules: [obs.module],
      },
      hypothesis: {
        statement: 'Auto-detected issue requires diagnosis',
        expected_metric_change: {},
      },
      risk: {
        level: obs.severity === 'critical' ? 'high' : obs.severity,
        reasons: [`Auto-detected via ${obs.source}`],
        protected_paths_touched: false,
        human_approval_required: obs.severity === 'critical',
      },
      constraints: {
        allowed_paths: ['**'],
        forbidden_paths: ['.env', 'secrets/**', 'credentials/**'],
      },
      validation: {
        required: ['pnpm typecheck', 'pnpm test'],
      },
      output_contract: {
        must_include: ['implementation_pr', 'rollback_plan'],
      },
    };

    const backlogDir = join(root, '.openslack', 'self', 'evolution_backlog');
    mkdirSync(backlogDir, { recursive: true });
    const filePath = join(backlogDir, `${taskId}.yaml`);
    writeFileSync(filePath, stringifyYaml(task, { lineWidth: 120 }), 'utf-8');
    createdTasks.push(taskId);
  }

  return createdTasks;
}
