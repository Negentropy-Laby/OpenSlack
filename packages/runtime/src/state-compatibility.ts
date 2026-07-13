import {
  copyFileSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';

export type LocalStateCompatibilityStatus = 'compatible' | 'legacy' | 'incompatible';

export interface LocalStateCompatibilityCheck {
  file: string;
  status: LocalStateCompatibilityStatus;
  schema?: string;
  detail: string;
}

export interface LocalStateCompatibilityReport {
  compatible: boolean;
  checks: LocalStateCompatibilityCheck[];
}

export interface LocalStateMigrationAction {
  file: string;
  from: 'legacy-unversioned';
  to: 'openslack.agent_runtime.v1';
  backupPath?: string;
  applied: boolean;
}

export class LocalStateCompatibilityError extends Error {
  readonly code = 'LOCAL_STATE_INCOMPATIBLE';
  constructor(readonly report: LocalStateCompatibilityReport) {
    super(
      'Local OpenSlack state is corrupt or uses a newer unsupported schema. Unsafe continuation was refused.',
    );
    this.name = 'LocalStateCompatibilityError';
  }
}

const STATE_FILES = [
  { file: 'onboarding.json', schema: 'openslack.onboarding.v1', allowLegacy: false },
  { file: 'github-app.json', schema: 'openslack.github_app_local.v1', allowLegacy: false },
  { file: 'agent-runtime.json', schema: 'openslack.agent_runtime.v1', allowLegacy: true },
] as const;

export function diagnoseLocalStateCompatibility(
  localStateRoot: string,
): LocalStateCompatibilityReport {
  const checks: LocalStateCompatibilityCheck[] = [];
  for (const definition of STATE_FILES) {
    const path = join(localStateRoot, definition.file);
    if (!existsSync(path)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    } catch {
      checks.push({
        file: definition.file,
        status: 'incompatible',
        detail: 'State file is not valid JSON.',
      });
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      checks.push({
        file: definition.file,
        status: 'incompatible',
        detail: 'State file must contain a JSON object.',
      });
      continue;
    }
    const schema = (parsed as Record<string, unknown>).schema;
    if (schema === definition.schema) {
      checks.push({
        file: definition.file,
        status: 'compatible',
        schema: definition.schema,
        detail: 'Supported state schema.',
      });
    } else if (schema === undefined && definition.allowLegacy) {
      checks.push({
        file: definition.file,
        status: 'legacy',
        detail: 'Legacy unversioned state is readable and has an explicit backup-first migration.',
      });
    } else {
      checks.push({
        file: definition.file,
        status: 'incompatible',
        schema: typeof schema === 'string' ? schema : undefined,
        detail: `Expected ${definition.schema}.`,
      });
    }
  }
  return {
    compatible: checks.every((check) => check.status !== 'incompatible'),
    checks,
  };
}

export function assertLocalStateCompatibility(localStateRoot: string): void {
  const report = diagnoseLocalStateCompatibility(localStateRoot);
  if (!report.compatible) throw new LocalStateCompatibilityError(report);
}

export function migrateLocalStateSchemas(
  localStateRoot: string,
  options: { apply?: boolean; now?: () => Date } = {},
): LocalStateMigrationAction[] {
  const report = diagnoseLocalStateCompatibility(localStateRoot);
  if (!report.compatible) throw new LocalStateCompatibilityError(report);
  const legacy = report.checks.find(
    (check) => check.file === 'agent-runtime.json' && check.status === 'legacy',
  );
  if (!legacy) return [];

  const path = join(localStateRoot, legacy.file);
  const action: LocalStateMigrationAction = {
    file: legacy.file,
    from: 'legacy-unversioned',
    to: 'openslack.agent_runtime.v1',
    applied: false,
  };
  if (!options.apply) return [action];

  const original = readFileSync(path, 'utf-8');
  const parsed = JSON.parse(original) as Record<string, unknown>;
  const timestamp = (options.now ?? (() => new Date()))()
    .toISOString()
    .replace(/[:.]/g, '-');
  const backupDir = join(localStateRoot, 'backups', 'state-migrations', timestamp);
  const backupPath = join(backupDir, basename(path));
  mkdirSync(backupDir, { recursive: true });
  copyFileSync(path, backupPath, constants.COPYFILE_EXCL);

  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const current = readFileSync(path, 'utf-8');
    if (hash(current) !== hash(original)) {
      throw new LocalStateCompatibilityError({
        compatible: false,
        checks: [
          {
            file: legacy.file,
            status: 'incompatible',
            detail: 'State changed after backup; migration was not applied.',
          },
        ],
      });
    }
    writeFileSync(
      temporary,
      `${JSON.stringify({ schema: 'openslack.agent_runtime.v1', ...parsed }, null, 2)}\n`,
      { encoding: 'utf-8', flag: 'wx', mode: 0o600 },
    );
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  return [{ ...action, applied: true, backupPath }];
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
