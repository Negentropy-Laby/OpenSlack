import { writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';

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

function getNextEvolutionNumber(root: string): number {
  const backlogDir = join(root, '.openslack', 'self', 'evolution_backlog');
  if (!existsSync(backlogDir)) return 1;
  let maxNum = 0;
  try {
    for (const f of readdirSync(backlogDir)) {
      const match = f.match(/^EVOL-\d{4}-(\d{6})\.yaml$/);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num > maxNum) maxNum = num;
      }
    }
  } catch { /* ignore */ }
  return maxNum + 1;
}

export function createRollbackTask(experimentId: string): string {
  const root = findRepoRoot();
  const seq = getNextEvolutionNumber(root);
  const year = new Date().getFullYear();
  const taskId = `EVOL-${year}-${String(seq).padStart(6, '0')}`;

  const task = {
    schema: 'openslack.evolution_task.v1',
    id: taskId,
    title: `[ROLLBACK] Revert ${experimentId} — post-merge regression detected`,
    status: 'rollback_proposed',
    created_at: new Date().toISOString(),
    created_by: 'agent:post_merge_monitor',
    depends_on: [],
    source: {
      type: 'post_merge_monitor',
      evidence: [
        `Post-merge monitoring detected regression for experiment ${experimentId}`,
        'Genesis validation or test suite failed after merge',
      ],
    },
    problem: {
      summary: `Regression detected after merging ${experimentId}`,
      affected_modules: ['all'],
    },
    hypothesis: {
      statement: `Reverting ${experimentId} will restore stability`,
      expected_metric_change: { typecheck: '1', tests: '1', genesis: '1' },
    },
    risk: {
      level: 'high',
      reasons: ['Post-merge regression detected', 'System stability compromised'],
      protected_paths_touched: false,
      human_approval_required: true,
    },
    constraints: {
      allowed_paths: ['**'],
      forbidden_paths: ['.env', 'secrets/**', 'credentials/**'],
    },
    validation: {
      required: ['pnpm typecheck', 'pnpm test', 'bash scripts/genesis-validate.sh'],
    },
    output_contract: {
      must_include: ['revert_pr', 'verification_result'],
    },
  };

  const backlogDir = join(root, '.openslack', 'self', 'evolution_backlog');
  mkdirSync(backlogDir, { recursive: true });
  const filePath = join(backlogDir, `${taskId}.yaml`);
  writeFileSync(filePath, stringifyYaml(task, { lineWidth: 120 }), 'utf-8');

  return taskId;
}

export function executeRollback(_experimentId: string): void {
  // Create rollback task and advise manual revert
  const taskId = createRollbackTask(_experimentId);
  console.log(`Rollback task created: ${taskId}`);
  console.log('To execute rollback:');
  console.log('  1. Review the rollback task YAML');
  console.log('  2. Run: bash scripts/genesis-rollback.sh');
  console.log('  3. Push the revert commit');
}
