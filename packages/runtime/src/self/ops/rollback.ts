import { writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export const ROLLBACK_TTL_DAYS = 7;
export const ROLLBACK_RATE_LIMIT_MS = 60 * 60 * 1000;

const ACTIVE_ROLLBACK_STATUS = 'rollback_proposed';
const STALE_ROLLBACK_STATUS = 'rejected';

export interface CreateRollbackTaskOptions {
  root?: string;
  now?: Date;
  sourceType?: string;
}

export interface RollbackTaskResult {
  taskId: string | null;
  created: boolean;
  updatedExisting: boolean;
  reason: 'created' | 'deduplicated' | 'rate_limited' | 'test_artifact';
}

export interface ExpireRollbackTasksResult {
  expiredTaskIds: string[];
}

interface RollbackTaskYaml {
  id?: string;
  status?: string;
  created_at?: string;
  last_seen_at?: string;
  rollback_signature?: string;
  detection_count?: number;
  source?: {
    type?: string;
    evidence?: string[];
  };
  [key: string]: unknown;
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

function getBacklogDir(root: string): string {
  return join(root, '.openslack', 'self', 'evolution_backlog');
}

function getRollbackSignature(sourceType: string, experimentId: string): string {
  return `${sourceType}:${experimentId}`;
}

function isTestExperiment(experimentId: string): boolean {
  return /^EXP-TEST(?:\b|[-_])/i.test(experimentId) || /^EXP-TEST$/i.test(experimentId);
}

function readRollbackTasks(root: string): Array<{ filePath: string; task: RollbackTaskYaml }> {
  const backlogDir = getBacklogDir(root);
  if (!existsSync(backlogDir)) return [];

  const tasks: Array<{ filePath: string; task: RollbackTaskYaml }> = [];
  for (const f of readdirSync(backlogDir)) {
    if (!/^EVOL-\d{4}-\d{6}\.yaml$/.test(f)) continue;
    const filePath = join(backlogDir, f);
    try {
      const task = parseYaml(readFileSync(filePath, 'utf-8')) as RollbackTaskYaml;
      tasks.push({ filePath, task });
    } catch {
      // Ignore malformed files here; workspace validation reports them elsewhere.
    }
  }
  return tasks;
}

function taskMatchesRollback(task: RollbackTaskYaml, signature: string, sourceType: string, experimentId: string): boolean {
  if (task.rollback_signature === signature) return true;
  if (task.source?.type !== sourceType) return false;
  const evidence = task.source.evidence ?? [];
  return evidence.some((entry) => entry.includes(`experiment ${experimentId}`) || entry.includes(experimentId));
}

function findMatchingRollback(
  root: string,
  signature: string,
  sourceType: string,
  experimentId: string,
): { filePath: string; task: RollbackTaskYaml } | undefined {
  return readRollbackTasks(root).find(({ task }) =>
    task.status === ACTIVE_ROLLBACK_STATUS && taskMatchesRollback(task, signature, sourceType, experimentId),
  );
}

function findRecentRollback(
  root: string,
  signature: string,
  sourceType: string,
  experimentId: string,
  now: Date,
): { filePath: string; task: RollbackTaskYaml } | undefined {
  return readRollbackTasks(root).find(({ task }) => {
    if (!taskMatchesRollback(task, signature, sourceType, experimentId)) return false;
    const ts = task.last_seen_at ?? task.created_at;
    if (!ts) return false;
    const parsed = Date.parse(ts);
    return Number.isFinite(parsed) && now.getTime() - parsed < ROLLBACK_RATE_LIMIT_MS;
  });
}

function updateExistingRollback(
  filePath: string,
  task: RollbackTaskYaml,
  now: Date,
  signature: string,
  experimentId: string,
): void {
  const evidence = task.source?.evidence ?? [];
  const seen = new Set(evidence);
  const repeatedEvidence = `Repeated post-merge regression detected for experiment ${experimentId}`;
  if (!seen.has(repeatedEvidence)) evidence.push(repeatedEvidence);

  task.source = {
    ...(task.source ?? {}),
    evidence,
  };
  task.rollback_signature = signature;
  task.last_seen_at = now.toISOString();
  task.detection_count = Math.max(1, task.detection_count ?? 1) + 1;
  writeFileSync(filePath, stringifyYaml(task, { lineWidth: 120 }), 'utf-8');
}

export function createRollbackTask(
  experimentId: string,
  options: CreateRollbackTaskOptions = {},
): RollbackTaskResult {
  if (isTestExperiment(experimentId)) {
    return { taskId: null, created: false, updatedExisting: false, reason: 'test_artifact' };
  }

  const root = options.root ?? findRepoRoot();
  const now = options.now ?? new Date();
  const sourceType = options.sourceType ?? 'post_merge_monitor';
  const signature = getRollbackSignature(sourceType, experimentId);
  const existing = findMatchingRollback(root, signature, sourceType, experimentId);
  if (existing) {
    updateExistingRollback(existing.filePath, existing.task, now, signature, experimentId);
    return {
      taskId: existing.task.id ?? null,
      created: false,
      updatedExisting: true,
      reason: 'deduplicated',
    };
  }

  const recent = findRecentRollback(root, signature, sourceType, experimentId, now);
  if (recent) {
    return {
      taskId: recent.task.id ?? null,
      created: false,
      updatedExisting: false,
      reason: 'rate_limited',
    };
  }

  const seq = getNextEvolutionNumber(root);
  const year = now.getFullYear();
  const taskId = `EVOL-${year}-${String(seq).padStart(6, '0')}`;

  const task = {
    schema: 'openslack.evolution_task.v1',
    id: taskId,
    title: `[ROLLBACK] Revert ${experimentId} — post-merge regression detected`,
    status: ACTIVE_ROLLBACK_STATUS,
    created_at: now.toISOString(),
    created_by: 'agent:post_merge_monitor',
    rollback_signature: signature,
    last_seen_at: now.toISOString(),
    detection_count: 1,
    depends_on: [],
    source: {
      type: sourceType,
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

  const backlogDir = getBacklogDir(root);
  mkdirSync(backlogDir, { recursive: true });
  const filePath = join(backlogDir, `${taskId}.yaml`);
  writeFileSync(filePath, stringifyYaml(task, { lineWidth: 120 }), 'utf-8');

  return { taskId, created: true, updatedExisting: false, reason: 'created' };
}

export function expireStaleRollbackTasks(options: CreateRollbackTaskOptions = {}): ExpireRollbackTasksResult {
  const root = options.root ?? findRepoRoot();
  const now = options.now ?? new Date();
  const maxAgeMs = ROLLBACK_TTL_DAYS * 24 * 60 * 60 * 1000;
  const expiredTaskIds: string[] = [];

  for (const { filePath, task } of readRollbackTasks(root)) {
    if (task.status !== ACTIVE_ROLLBACK_STATUS || !task.created_at) continue;
    const createdAt = Date.parse(task.created_at);
    if (!Number.isFinite(createdAt) || now.getTime() - createdAt <= maxAgeMs) continue;

    task.status = STALE_ROLLBACK_STATUS;
    task.last_seen_at = now.toISOString();
    task.source = {
      ...(task.source ?? {}),
      evidence: [
        ...(task.source?.evidence ?? []),
        `Rollback proposal expired after ${ROLLBACK_TTL_DAYS} days without execution`,
      ],
    };
    writeFileSync(filePath, stringifyYaml(task, { lineWidth: 120 }), 'utf-8');
    if (task.id) expiredTaskIds.push(task.id);
  }

  return { expiredTaskIds };
}

export function executeRollback(_experimentId: string): void {
  // Create rollback task and advise manual revert
  const result = createRollbackTask(_experimentId);
  if (!result.taskId) {
    console.log(`Rollback task skipped: ${result.reason}`);
    return;
  }
  console.log(`Rollback task ${result.created ? 'created' : 'updated'}: ${result.taskId}`);
  console.log('To execute rollback:');
  console.log('  1. Review the rollback task YAML');
  console.log('  2. Run: bash scripts/genesis-rollback.sh');
  console.log('  3. Push the revert commit');
}
