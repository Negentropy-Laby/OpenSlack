import type { Dirent } from 'node:fs';
import { lstat, opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { ScenarioHostCatalog } from './catalog.js';
import {
  assertPreparedScenarioRootStable,
  isCanonicalScenarioPackId,
  loadScenarioPack,
  prepareScenarioRoot,
  ScenarioPackLoadError,
  type LoadedScenarioDefinition,
  type ScenarioPackLoadErrorCode,
} from './pack-loader.js';
import { SCENARIO_PACK_LIMITS, ScenarioPackSchemaError } from './pack-schema.js';

const BLOCKED_MESSAGE = 'Scenario Pack candidate did not satisfy the sealed discovery contract.';

export interface ScenarioPackDiscoveryDiagnostic {
  readonly scenarioId?: string;
  readonly code: ScenarioPackLoadErrorCode;
  readonly message: string;
}

export interface ScenarioPackDiscoveryResult {
  readonly accepted: readonly LoadedScenarioDefinition[];
  readonly blocked: readonly ScenarioPackDiscoveryDiagnostic[];
}

export interface DiscoverScenarioPacksOptions {
  readonly scenarioRoot: string;
  readonly catalog: ScenarioHostCatalog;
  readonly allowlist?: readonly string[];
  readonly maxDirectoryEntries?: number;
}

function sourceInvalid(message: string): never {
  throw new ScenarioPackLoadError('SCENARIO_PACK_SOURCE_INVALID', message);
}

function maxDirectoryEntries(value: number | undefined): number {
  if (value === undefined) return SCENARIO_PACK_LIMITS.maxDirectoryEntries;
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > SCENARIO_PACK_LIMITS.maxDirectoryEntries
  ) {
    return sourceInvalid('maxDirectoryEntries may lower but cannot raise its built-in ceiling.');
  }
  return value;
}

function normalizedAllowlist(
  value: readonly string[] | undefined,
): ReadonlySet<string> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > SCENARIO_PACK_LIMITS.maxDirectoryEntries) {
    return sourceInvalid('Scenario Pack discovery allowlist must be a bounded array.');
  }
  const result = new Set<string>();
  for (const item of value) {
    if (!isCanonicalScenarioPackId(item) || result.has(item)) {
      return sourceInvalid(
        'Scenario Pack discovery allowlist must contain unique canonical Pack IDs.',
      );
    }
    result.add(item);
  }
  return result;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function safeDiagnostic(
  code: ScenarioPackLoadErrorCode,
  scenarioId?: string,
): ScenarioPackDiscoveryDiagnostic {
  return Object.freeze({
    ...(scenarioId === undefined ? {} : { scenarioId }),
    code,
    message: BLOCKED_MESSAGE,
  });
}

function loaderErrorCode(error: unknown): ScenarioPackLoadErrorCode | undefined {
  if (error instanceof ScenarioPackLoadError || error instanceof ScenarioPackSchemaError) {
    return error.code;
  }
  return undefined;
}

async function enumerateRoot(scenarioRoot: string, ceiling: number): Promise<readonly Dirent[]> {
  let directory;
  try {
    directory = await opendir(scenarioRoot);
  } catch (error) {
    throw new ScenarioPackLoadError(
      'SCENARIO_PACK_FILE_UNSAFE',
      'Scenario root could not be opened for bounded discovery.',
      scenarioRoot,
      error,
    );
  }

  const entries: Dirent[] = [];
  try {
    while (true) {
      let entry: Dirent | null;
      try {
        entry = await directory.read();
      } catch (error) {
        throw new ScenarioPackLoadError(
          'SCENARIO_PACK_FILE_CHANGED',
          'Scenario root changed during bounded discovery.',
          scenarioRoot,
          error,
        );
      }
      if (entry === null) break;
      if (entries.length === ceiling) {
        throw new ScenarioPackLoadError(
          'SCENARIO_PACK_LIMIT_EXCEEDED',
          'Scenario root directory entry limit exceeded.',
          scenarioRoot,
        );
      }
      entries.push(entry);
    }
  } finally {
    await directory.close().catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ERR_DIR_CLOSED') throw error;
    });
  }
  return Object.freeze(entries.sort((left, right) => compareText(left.name, right.name)));
}

function isSafeEntryName(value: string): boolean {
  return (
    value.length > 0 &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.includes(':') &&
    !value.includes('\0')
  );
}

/**
 * Discovers declarative packs once from a trusted root. It never loads code and every accepted
 * candidate is independently verified by loadScenarioPack().
 */
export async function discoverScenarioPacks(
  options: DiscoverScenarioPacksOptions,
): Promise<ScenarioPackDiscoveryResult> {
  if (typeof options !== 'object' || options === null) {
    return sourceInvalid('Scenario Pack discovery options are required.');
  }
  const ceiling = maxDirectoryEntries(options.maxDirectoryEntries);
  const allowlist = normalizedAllowlist(options.allowlist);
  const prepared = await prepareScenarioRoot(options.scenarioRoot, options.catalog);
  const entries = await enumerateRoot(prepared.root, ceiling);
  await assertPreparedScenarioRootStable(prepared);

  const accepted: LoadedScenarioDefinition[] = [];
  const blocked: ScenarioPackDiscoveryDiagnostic[] = [];
  for (const entry of entries) {
    const canonicalId = isCanonicalScenarioPackId(entry.name) ? entry.name : undefined;
    if (!isSafeEntryName(entry.name)) {
      blocked.push(safeDiagnostic('SCENARIO_PACK_FILE_UNSAFE', canonicalId));
      continue;
    }

    const entryPath = join(prepared.root, entry.name);
    let stat;
    try {
      stat = await lstat(entryPath);
    } catch (error) {
      throw new ScenarioPackLoadError(
        'SCENARIO_PACK_FILE_CHANGED',
        'Scenario root entry changed during discovery.',
        prepared.root,
        error,
      );
    }
    if (entry.isSymbolicLink() || stat.isSymbolicLink()) {
      blocked.push(safeDiagnostic('SCENARIO_PACK_SOURCE_SYMLINK', canonicalId));
      continue;
    }
    if (!entry.isDirectory() || !stat.isDirectory()) {
      blocked.push(safeDiagnostic('SCENARIO_PACK_FILE_UNSAFE', canonicalId));
      continue;
    }
    if (canonicalId === undefined) {
      blocked.push(safeDiagnostic('SCENARIO_PACK_SOURCE_INVALID'));
      continue;
    }
    if (allowlist !== undefined && !allowlist.has(canonicalId)) {
      blocked.push(safeDiagnostic('SCENARIO_PACK_POLICY_DENIED', canonicalId));
      continue;
    }

    try {
      accepted.push(
        await loadScenarioPack({
          scenarioRoot: prepared.root,
          scenarioId: canonicalId,
          catalog: options.catalog,
        }),
      );
    } catch (error) {
      const code = loaderErrorCode(error);
      if (code === undefined) throw error;
      blocked.push(safeDiagnostic(code, canonicalId));
    }
  }
  await assertPreparedScenarioRootStable(prepared);

  accepted.sort((left, right) => compareText(left.manifest.id, right.manifest.id));
  blocked.sort(
    (left, right) =>
      compareText(left.scenarioId ?? '', right.scenarioId ?? '') ||
      compareText(left.code, right.code),
  );
  return Object.freeze({
    accepted: Object.freeze(accepted),
    blocked: Object.freeze(blocked),
  });
}
