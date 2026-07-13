import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { isAbsolute, join, posix } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { WorkspaceContext } from './workspace-context.js';

export type ModuleLifecycleStatus = 'planned' | 'early' | 'active' | 'retired';
export type ModuleMaturity =
  | 'planned'
  | 'implemented'
  | 'local_ready'
  | 'live_verified'
  | 'production_ready';

export interface ProductComponent {
  id: string;
  name: string;
  maturity: ModuleMaturity;
  operatorConfigured: boolean;
  externalBlockers: string[];
  evidenceRefs: string[];
}

export interface ProductModule {
  id: string;
  name: string;
  status: ModuleLifecycleStatus;
  maturity: ModuleMaturity;
  operatorConfigured: boolean;
  externalBlockers: string[];
  evidenceRefs: string[];
  phase: string;
  cli?: string[];
  packages?: string[];
  tests?: number;
  test_files?: number;
  golden_evals?: number;
  notes?: string;
  components?: ProductComponent[];
}

export interface ProductModuleV1 {
  id: string;
  name: string;
  status: ModuleLifecycleStatus;
  phase: string;
  cli?: string[];
  packages?: string[];
  tests?: number;
  test_files?: number;
  golden_evals?: number;
  notes?: string;
}

export interface DeferredWorkItem {
  id: string;
  name: string;
  status: 'deferred';
  maturity: ModuleMaturity;
  countedTowardStandalone: false;
  branch?: string;
  evidenceRefs: string[];
  notes?: string;
}

interface RegistryCounts {
  vitest_tests?: number;
  vitest_files?: number;
}

export interface ModulesRegistryV1 extends RegistryCounts {
  schema: 'openslack.modules.v1';
  modules: ProductModuleV1[];
}

export interface ModulesRegistryV2 extends RegistryCounts {
  schema: 'openslack.modules.v2';
  modules: ProductModule[];
  deferredWork?: DeferredWorkItem[];
}

export type RawModulesRegistry = ModulesRegistryV1 | ModulesRegistryV2;

export interface ModulesRegistry extends ModulesRegistryV2 {
  sourceSchema?: 'openslack.modules.v1' | 'openslack.modules.v2';
}

export interface LiveEvidenceV1 {
  schema: 'openslack.live_evidence.v1';
  ownerId: string;
  testedCommit: string;
  outcome: 'pass' | 'fail';
  environment: string;
  observedAt: string;
  expiresAt: string;
  correlationId: string;
  revision: string;
  evidenceRefs: string[];
}

export interface RegistryValidationResult {
  valid: boolean;
  errors: string[];
  registry?: ModulesRegistry;
}

const REQUIRED_FIELDS = [
  'id',
  'name',
  'status',
  'maturity',
  'operatorConfigured',
  'externalBlockers',
  'evidenceRefs',
  'phase',
] as const;
const LIFECYCLE_VALUES = new Set<ModuleLifecycleStatus>(['planned', 'early', 'active', 'retired']);
const MATURITY_VALUES = new Set<ModuleMaturity>([
  'planned',
  'implemented',
  'local_ready',
  'live_verified',
  'production_ready',
]);
const MATURITY_RANK: Record<ModuleMaturity, number> = {
  planned: 0,
  implemented: 1,
  local_ready: 2,
  live_verified: 3,
  production_ready: 4,
};
const LIVE_EVIDENCE_CLOCK_SKEW_MS = 5 * 60 * 1000;
const LIVE_EVIDENCE_MAX_VALIDITY_MS = 30 * 24 * 60 * 60 * 1000;

export function readModules(rootPath: string): ModulesRegistry {
  const yamlPath = join(rootPath, '.openslack', 'modules.yaml');
  return readModulesFile(yamlPath);
}

export function readProductModules(
  context: Pick<WorkspaceContext, 'productHome' | 'sourceCheckout' | 'workspaceRoot'>,
): ModulesRegistry {
  const yamlPath = context.sourceCheckout
    ? join(context.workspaceRoot, '.openslack', 'modules.yaml')
    : join(context.productHome, 'assets', 'product', 'modules.yaml');
  return readModulesFile(yamlPath);
}

function readModulesFile(yamlPath: string): ModulesRegistry {
  if (!existsSync(yamlPath)) {
    throw new Error(`modules.yaml not found at ${yamlPath}`);
  }
  const raw = readFileSync(yamlPath, 'utf-8');
  const parsed = parseYaml(raw) as unknown;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('modules.yaml is empty or invalid');
  }
  const schema = (parsed as { schema?: unknown }).schema;
  if (schema !== 'openslack.modules.v1' && schema !== 'openslack.modules.v2') {
    throw new Error(
      `Expected schema "openslack.modules.v1" or "openslack.modules.v2", got "${String(schema)}"`,
    );
  }
  const registry = parsed as RawModulesRegistry;
  if (!Array.isArray(registry.modules)) {
    throw new Error('modules.yaml must contain a "modules" array');
  }
  return { ...migrateModulesRegistry(registry), sourceSchema: registry.schema };
}

export interface RegistryValidationOptions {
  rootPath?: string;
}

interface RegistryValidationContext extends RegistryValidationOptions {
  gitEvidence?: GitEvidenceInspector;
}

class GitEvidenceInspector {
  private trackedPaths?: Set<string>;
  private branchRefs?: Set<string>;
  private readonly commitHistory = new Map<string, boolean>();
  private readonly commitTrees = new Map<string, Set<string>>();
  private readonly ancestorPairs = new Map<string, boolean>();
  private readonly commitTimes = new Map<string, number>();
  private readonly productChanges = new Map<string, string[]>();
  private readonly fileContents = new Map<string, string>();

  constructor(readonly rootPath: string) {}

  isCommitInHeadHistory(commit: string): boolean {
    const cached = this.commitHistory.get(commit);
    if (cached !== undefined) return cached;
    let valid = false;
    try {
      execFileSync('git', ['cat-file', '-e', `${commit}^{commit}`], {
        cwd: this.rootPath,
        stdio: 'ignore',
      });
      execFileSync('git', ['merge-base', '--is-ancestor', commit, 'HEAD'], {
        cwd: this.rootPath,
        stdio: 'ignore',
      });
      valid = true;
    } catch {
      valid = false;
    }
    this.commitHistory.set(commit, valid);
    return valid;
  }

  isTrackedPath(path: string): boolean {
    if (!this.trackedPaths) {
      try {
        const output = execFileSync('git', ['ls-files', '-z'], {
          cwd: this.rootPath,
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
          maxBuffer: 16 * 1024 * 1024,
        });
        this.trackedPaths = new Set(output.split('\0').filter(Boolean));
      } catch {
        this.trackedPaths = new Set();
      }
    }
    return hasGitTreePath(this.trackedPaths, path);
  }

  hasPathAtCommit(commit: string, path: string): boolean {
    let tree = this.commitTrees.get(commit);
    if (!tree) {
      const output = execFileSync('git', ['ls-tree', '-r', '-z', '--name-only', commit], {
        cwd: this.rootPath,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 16 * 1024 * 1024,
      });
      tree = new Set(output.split('\0').filter(Boolean));
      this.commitTrees.set(commit, tree);
    }
    return hasGitTreePath(tree, path);
  }

  branchExists(branch: string): boolean {
    if (!this.branchRefs) {
      try {
        const output = execFileSync(
          'git',
          ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes/origin'],
          {
            cwd: this.rootPath,
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'ignore'],
          },
        );
        this.branchRefs = new Set(output.split(/\r?\n/).filter(Boolean));
      } catch {
        this.branchRefs = new Set();
      }
    }
    const refs = branch.startsWith('refs/')
      ? [branch]
      : [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`];
    return refs.some((ref) => this.branchRefs?.has(ref));
  }

  readFileAtCommit(commit: string, path: string): string {
    const key = `${commit}\0${path}`;
    const cached = this.fileContents.get(key);
    if (cached !== undefined) return cached;
    const content = execFileSync('git', ['show', `${commit}:${path}`], {
      cwd: this.rootPath,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 4 * 1024 * 1024,
    });
    this.fileContents.set(key, content);
    return content;
  }

  isAncestor(ancestor: string, descendant: string): boolean {
    const key = `${ancestor}\0${descendant}`;
    const cached = this.ancestorPairs.get(key);
    if (cached !== undefined) return cached;
    let valid = false;
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
        cwd: this.rootPath,
        stdio: 'ignore',
      });
      valid = true;
    } catch {
      valid = false;
    }
    this.ancestorPairs.set(key, valid);
    return valid;
  }

  commitTimestamp(commit: string): number {
    const cached = this.commitTimes.get(commit);
    if (cached !== undefined) return cached;
    const seconds = Number(
      execFileSync('git', ['show', '-s', '--format=%ct', commit], {
        cwd: this.rootPath,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim(),
    );
    if (!Number.isFinite(seconds)) throw new Error('Commit timestamp is invalid.');
    const timestamp = seconds * 1000;
    this.commitTimes.set(commit, timestamp);
    return timestamp;
  }

  productPathsChangedSince(testedCommit: string): string[] {
    const cached = this.productChanges.get(testedCommit);
    if (cached !== undefined) return cached;
    if (!this.isCommitInHeadHistory(testedCommit)) {
      throw new Error('Tested commit is not an ancestor of current HEAD.');
    }
    const changedPaths = execFileSync(
      'git',
      ['diff', '--name-only', '--diff-filter=ACDMRTUXB', testedCommit, 'HEAD', '--'],
      {
        cwd: this.rootPath,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 16 * 1024 * 1024,
      },
    )
      .split(/\r?\n/)
      .map((path) => path.trim())
      .filter(Boolean)
      .filter((path) => !isLiveEvidenceMetadataPath(path));
    this.productChanges.set(testedCommit, changedPaths);
    return changedPaths;
  }
}

function hasGitTreePath(paths: Set<string>, path: string): boolean {
  if (paths.has(path)) return true;
  const directoryPrefix = path.endsWith('/') ? path : `${path}/`;
  for (const candidate of paths) {
    if (candidate.startsWith(directoryPrefix)) return true;
  }
  return false;
}

export function validateModules(
  registry: RawModulesRegistry,
  options: RegistryValidationOptions = {},
): RegistryValidationResult {
  const schema = (registry as { schema?: unknown }).schema;
  if (schema !== 'openslack.modules.v1' && schema !== 'openslack.modules.v2') {
    return {
      valid: false,
      errors: [`Unsupported registry schema: ${String(schema)}`],
    };
  }
  const normalized = migrateModulesRegistry(registry);
  const errors: string[] = [];
  const context: RegistryValidationContext = {
    ...options,
    gitEvidence: options.rootPath ? new GitEvidenceInspector(options.rootPath) : undefined,
  };

  if (normalized.schema !== 'openslack.modules.v2') {
    errors.push(`Unsupported normalized registry schema: ${normalized.schema}`);
  }
  validateCount(normalized.vitest_tests, 'vitest_tests', errors);
  validateCount(normalized.vitest_files, 'vitest_files', errors);

  for (const mod of normalized.modules) {
    if (!mod || typeof mod !== 'object') {
      errors.push('Module entry is not an object');
      continue;
    }
    for (const field of REQUIRED_FIELDS) {
      if (mod[field] === undefined || mod[field] === null || mod[field] === '') {
        errors.push(`Module "${mod.id || 'unknown'}" missing required field: ${field}`);
      }
    }
    if (!LIFECYCLE_VALUES.has(mod.status)) {
      errors.push(`Module "${mod.id}" has invalid lifecycle status: ${String(mod.status)}`);
    }
    validateMaturityOwner(mod, `Module "${mod.id}"`, errors, context, mod.id);
    validateCount(mod.tests, `Module "${mod.id}" tests`, errors);
    validateCount(mod.test_files, `Module "${mod.id}" test_files`, errors);
    validateCount(mod.golden_evals, `Module "${mod.id}" golden_evals`, errors);
    if (mod.components !== undefined && !Array.isArray(mod.components)) {
      errors.push(`Module "${mod.id}" components must be an array`);
    } else if (mod.components) {
      validateUniqueIds(mod.components, `Module "${mod.id}" component`, errors);
      for (const component of mod.components) {
        if (!component || typeof component !== 'object') {
          errors.push(`Module "${mod.id}" component is not an object`);
          continue;
        }
        if (!component.id || !component.name) {
          errors.push(`Module "${mod.id}" component must have id and name`);
          continue;
        }
        validateMaturityOwner(
          component,
          `Component "${component.id}"`,
          errors,
          context,
          component.id,
        );
        if (
          MATURITY_VALUES.has(mod.maturity) &&
          MATURITY_VALUES.has(component.maturity) &&
          MATURITY_RANK[mod.maturity] > MATURITY_RANK[component.maturity]
        ) {
          errors.push(
            `Module "${mod.id}" maturity ${mod.maturity} exceeds component "${component.id}" maturity ${component.maturity}`,
          );
        }
      }
    }
  }

  // Check for duplicate IDs
  validateUniqueIds(normalized.modules, 'module', errors);

  if (normalized.deferredWork !== undefined && !Array.isArray(normalized.deferredWork)) {
    errors.push('deferredWork must be an array');
  } else if (normalized.deferredWork) {
    validateUniqueIds(normalized.deferredWork, 'deferred work', errors);
    for (const item of normalized.deferredWork) {
      if (!item || typeof item !== 'object') {
        errors.push('Deferred work entry is not an object');
        continue;
      }
      if (!item.id || !item.name) {
        errors.push('Deferred work entries must have id and name');
      }
      if (item.status !== 'deferred' || item.countedTowardStandalone !== false) {
        errors.push(
          `Deferred work "${item.id}" must remain deferred and excluded from standalone completion`,
        );
      }
      if (!MATURITY_VALUES.has(item.maturity)) {
        errors.push(`Deferred work "${item.id}" has invalid maturity: ${String(item.maturity)}`);
      }
      if (
        MATURITY_VALUES.has(item.maturity) &&
        MATURITY_RANK[item.maturity] > MATURITY_RANK.local_ready
      ) {
        errors.push(`Deferred work "${item.id}" cannot claim live or production maturity`);
      }
      if (!isStringArray(item.evidenceRefs)) {
        errors.push(`Deferred work "${item.id}" evidenceRefs must be non-empty strings`);
      } else {
        for (const reference of item.evidenceRefs) {
          validateEvidenceReference(reference, `Deferred work "${item.id}"`, errors, context);
        }
        const branchEvidence = item.evidenceRefs
          .filter((reference) => reference.startsWith('branch:'))
          .map((reference) => reference.slice('branch:'.length));
        if (branchEvidence.length > 0 && (!item.branch || !branchEvidence.includes(item.branch))) {
          errors.push(`Deferred work "${item.id}" branch evidence must match its branch field`);
        }
        if (
          item.maturity !== 'planned' &&
          !item.evidenceRefs.some((reference) => reference.startsWith('commit:'))
        ) {
          errors.push(
            `Deferred work "${item.id}" cannot claim ${item.maturity} without a declared evidence commit`,
          );
        }
        if (
          item.maturity !== 'planned' &&
          !item.evidenceRefs.some((reference) => /^(test|repo):/.test(reference))
        ) {
          errors.push(
            `Deferred work "${item.id}" cannot claim ${item.maturity} without test or repository evidence`,
          );
        }
        if (item.maturity !== 'planned' && context.gitEvidence) {
          validateEvidencePathsAtDeclaredCommits(
            item.evidenceRefs,
            `Deferred work "${item.id}"`,
            errors,
            context.gitEvidence,
          );
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    registry: errors.length === 0 ? normalized : undefined,
  };
}

export function migrateModulesRegistry(registry: RawModulesRegistry): ModulesRegistry {
  if (registry.schema === 'openslack.modules.v2') return registry;
  if ((registry as { schema?: unknown }).schema !== 'openslack.modules.v1') {
    throw new Error(
      `Unsupported registry schema: ${String((registry as { schema?: unknown }).schema)}`,
    );
  }
  return {
    ...registry,
    schema: 'openslack.modules.v2',
    modules: registry.modules.map((mod) => ({
      ...mod,
      maturity: 'planned',
      operatorConfigured: false,
      externalBlockers: ['maturity_evidence_not_audited'],
      evidenceRefs: [],
    })),
  };
}

export function getModuleById(registry: ModulesRegistry, id: string): ProductModule | undefined {
  return registry.modules.find((m) => m.id === id);
}

export function getTotalTests(registry: ModulesRegistry): number {
  return registry.modules.reduce((sum, m) => sum + (m.tests || 0), 0);
}

export function getTotalTestFiles(registry: ModulesRegistry): number {
  return registry.modules.reduce((sum, m) => sum + (m.test_files || 0), 0);
}

interface MaturityOwner {
  maturity: ModuleMaturity;
  operatorConfigured: boolean;
  externalBlockers: string[];
  evidenceRefs: string[];
}

function validateMaturityOwner(
  owner: MaturityOwner,
  label: string,
  errors: string[],
  context: RegistryValidationContext,
  ownerId: string,
): void {
  if (!MATURITY_VALUES.has(owner.maturity)) {
    errors.push(`${label} has invalid maturity: ${String(owner.maturity)}`);
  }
  if (typeof owner.operatorConfigured !== 'boolean') {
    errors.push(`${label} operatorConfigured must be a boolean`);
  }
  if (!isStringArray(owner.externalBlockers)) {
    errors.push(`${label} externalBlockers must be non-empty strings`);
  }
  if (!isStringArray(owner.evidenceRefs)) {
    errors.push(`${label} evidenceRefs must be non-empty strings`);
  }
  const evidenceRefs = Array.isArray(owner.evidenceRefs) ? owner.evidenceRefs : [];
  const externalBlockers = Array.isArray(owner.externalBlockers) ? owner.externalBlockers : [];
  for (const reference of evidenceRefs) {
    validateEvidenceReference(reference, label, errors, context);
  }
  if (owner.maturity !== 'planned' && evidenceRefs.length === 0) {
    errors.push(`${label} cannot claim ${owner.maturity} without evidenceRefs`);
  }
  if (
    owner.maturity !== 'planned' &&
    !evidenceRefs.some((reference) => reference.startsWith('commit:'))
  ) {
    errors.push(`${label} cannot claim ${owner.maturity} without a declared evidence commit`);
  }
  if (
    owner.maturity !== 'planned' &&
    !evidenceRefs.some((reference) => /^(test|repo):/.test(reference))
  ) {
    errors.push(`${label} cannot claim ${owner.maturity} without test or repository evidence`);
  }
  if (owner.maturity !== 'planned' && context.gitEvidence) {
    validateEvidencePathsAtDeclaredCommits(evidenceRefs, label, errors, context.gitEvidence);
  }
  if (
    (owner.maturity === 'live_verified' || owner.maturity === 'production_ready') &&
    !evidenceRefs.some((reference) => reference.startsWith('commit:'))
  ) {
    errors.push(`${label} cannot claim ${owner.maturity} without committed evidence`);
  }
  if (owner.maturity === 'live_verified' || owner.maturity === 'production_ready') {
    if (!evidenceRefs.some(isLiveEvidenceReference)) {
      errors.push(`${label} cannot claim ${owner.maturity} without structured live evidence`);
    }
    if (context.gitEvidence) {
      validateStructuredLiveEvidence(ownerId, evidenceRefs, label, errors, context.gitEvidence);
    }
  }
  if (
    owner.maturity === 'production_ready' &&
    (!owner.operatorConfigured || externalBlockers.length > 0)
  ) {
    errors.push(`${label} cannot claim production_ready while unconfigured or externally blocked`);
  }
}

function validateEvidenceReference(
  reference: string,
  label: string,
  errors: string[],
  context: RegistryValidationContext,
): void {
  const [kind, value] = reference.split(/:(.*)/s, 2);
  if (!value || !['commit', 'test', 'repo', 'branch'].includes(kind)) {
    errors.push(`${label} has unsupported evidence reference: ${reference}`);
    return;
  }
  if (kind === 'commit') {
    if (!/^[a-f0-9]{7,40}$/i.test(value)) {
      errors.push(`${label} has invalid commit evidence reference: ${reference}`);
      return;
    }
    if (context.gitEvidence && !context.gitEvidence.isCommitInHeadHistory(value)) {
      errors.push(`${label} commit evidence is not an ancestor of current HEAD: ${reference}`);
    }
    return;
  }
  if (kind === 'branch') {
    if (!/^[A-Za-z0-9._/-]+$/.test(value) || value.includes('..')) {
      errors.push(`${label} has invalid branch evidence reference: ${reference}`);
      return;
    }
    if (context.gitEvidence && !context.gitEvidence.branchExists(value)) {
      errors.push(`${label} branch evidence does not resolve: ${reference}`);
    }
    return;
  }
  const gitPath = normalizeEvidencePath(value);
  if (!gitPath) {
    errors.push(`${label} has unsafe repository evidence path: ${reference}`);
    return;
  }
  if (context.rootPath && !existsSync(join(context.rootPath, gitPath))) {
    errors.push(`${label} repository evidence path is missing: ${reference}`);
    return;
  }
  if (context.gitEvidence && !context.gitEvidence.isTrackedPath(gitPath)) {
    errors.push(`${label} repository evidence is not committed: ${reference}`);
  }
}

function normalizeEvidencePath(value: string): string | undefined {
  if (/[\u0000\r\n]/.test(value)) return undefined;
  const slashPath = value.replace(/\\/g, '/');
  const normalized = posix.normalize(slashPath);
  if (
    isAbsolute(value) ||
    posix.isAbsolute(normalized) ||
    /^[A-Za-z]:\//.test(slashPath) ||
    slashPath.startsWith('//') ||
    normalized === '..' ||
    normalized.startsWith('../')
  ) {
    return undefined;
  }
  return normalized.replace(/^\.\//, '');
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === 'string' && item.trim().length > 0)
  );
}

function validateCount(value: unknown, label: string, errors: string[]): void {
  if (value !== undefined && (!Number.isInteger(value) || Number(value) < 0)) {
    errors.push(`${label} must be a non-negative integer`);
  }
}

function validateUniqueIds(items: unknown[], label: string, errors: string[]): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const id = (item as { id?: unknown }).id;
    if (typeof id !== 'string' || id.length === 0) continue;
    if (seen.has(id)) errors.push(`Duplicate ${label} id: ${id}`);
    seen.add(id);
  }
}

function isLiveEvidenceReference(reference: string): boolean {
  return /^repo:\.openslack\/evidence\/live\/[^/]+\.json$/.test(reference);
}

function validateEvidencePathsAtDeclaredCommits(
  evidenceRefs: string[],
  label: string,
  errors: string[],
  gitEvidence: GitEvidenceInspector,
): void {
  const commits = evidenceRefs
    .filter((reference) => reference.startsWith('commit:'))
    .map((reference) => reference.slice('commit:'.length));
  for (const reference of evidenceRefs.filter((item) => /^(test|repo):/.test(item))) {
    const gitPath = normalizeEvidencePath(reference.slice(reference.indexOf(':') + 1));
    if (!gitPath) continue;
    const committed = commits.some((commit) => {
      try {
        return gitEvidence.hasPathAtCommit(commit, gitPath);
      } catch {
        return false;
      }
    });
    if (!committed) {
      errors.push(`${label} evidence path is not present at a declared commit: ${reference}`);
    }
  }
}

function validateStructuredLiveEvidence(
  ownerId: string,
  evidenceRefs: string[],
  label: string,
  errors: string[],
  gitEvidence: GitEvidenceInspector,
): void {
  const commits = evidenceRefs
    .filter((reference) => reference.startsWith('commit:'))
    .map((reference) => reference.slice('commit:'.length));
  for (const reference of evidenceRefs.filter(isLiveEvidenceReference)) {
    const gitPath = normalizeEvidencePath(reference.slice('repo:'.length));
    if (!gitPath) continue;
    let accepted = false;
    const rejectionReasons = new Set<string>();
    for (const commit of commits) {
      let content: string;
      try {
        content = gitEvidence.readFileAtCommit(commit, gitPath);
      } catch {
        rejectionReasons.add('evidence path is not present at the declared commit');
        continue;
      }
      let evidence: Partial<LiveEvidenceV1>;
      try {
        evidence = JSON.parse(content) as Partial<LiveEvidenceV1>;
      } catch {
        rejectionReasons.add('evidence JSON is invalid');
        continue;
      }
      try {
        const observedAt = Date.parse(String(evidence.observedAt ?? ''));
        const expiresAt = Date.parse(String(evidence.expiresAt ?? ''));
        const testedCommit = String(evidence.testedCommit ?? '');
        const revision = String(evidence.revision ?? '');
        if (
          evidence.schema !== 'openslack.live_evidence.v1' ||
          evidence.ownerId !== ownerId ||
          evidence.outcome !== 'pass' ||
          !isBoundedEvidenceText(evidence.environment) ||
          !isBoundedEvidenceText(evidence.correlationId) ||
          !isRedactedEvidenceRefs(evidence.evidenceRefs) ||
          !/^[a-f0-9]{7,40}$/i.test(testedCommit) ||
          !/^[a-f0-9]{7,40}$/i.test(revision) ||
          !Number.isFinite(observedAt) ||
          !Number.isFinite(expiresAt)
        ) {
          rejectionReasons.add('schema or required fields are invalid');
          continue;
        }
        if (revision !== testedCommit) {
          rejectionReasons.add('evidence revision does not match the tested product revision');
          continue;
        }
        const now = Date.now();
        if (observedAt > now + LIVE_EVIDENCE_CLOCK_SKEW_MS) {
          rejectionReasons.add('observation time exceeds the allowed clock skew');
          continue;
        }
        let testedCommitTime: number;
        try {
          testedCommitTime = gitEvidence.commitTimestamp(testedCommit);
        } catch {
          rejectionReasons.add('tested commit timestamp is unavailable');
          continue;
        }
        if (observedAt + LIVE_EVIDENCE_CLOCK_SKEW_MS < testedCommitTime) {
          rejectionReasons.add('observation predates the tested commit beyond allowed clock skew');
          continue;
        }
        if (expiresAt <= observedAt || expiresAt <= now) {
          rejectionReasons.add('evidence is expired or has an invalid expiry time');
          continue;
        }
        if (expiresAt - observedAt > LIVE_EVIDENCE_MAX_VALIDITY_MS) {
          rejectionReasons.add('evidence validity exceeds 30 days');
          continue;
        }
        if (!gitEvidence.isAncestor(testedCommit, commit)) {
          rejectionReasons.add('declared evidence commit predates the tested commit');
          continue;
        }
        let changedProductPaths: string[];
        try {
          changedProductPaths = gitEvidence.productPathsChangedSince(testedCommit);
        } catch {
          rejectionReasons.add('tested commit cannot be compared with current product paths');
          continue;
        }
        if (changedProductPaths.length > 0) {
          rejectionReasons.add(
            `tested commit is stale; product paths changed: ${changedProductPaths.join(', ')}`,
          );
          continue;
        }
        accepted = true;
        break;
      } catch {
        rejectionReasons.add('live evidence validation failed unexpectedly');
      }
    }
    if (!accepted) {
      const detail = [...rejectionReasons].join('; ') || 'no declared evidence commit contains it';
      errors.push(`${label} has invalid live evidence: ${reference} (${detail})`);
    }
  }
}

function isBoundedEvidenceText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= 512 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function isRedactedEvidenceRefs(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every(
    (reference) =>
      isBoundedEvidenceText(reference) &&
      !/(?:sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/.test(
        reference,
      ) &&
      !/(?:access[_-]?token|api[_-]?key|password|secret|credential)\s*[:=]\s*\S+/i.test(
        reference,
      ) &&
      !/:\/\/[^/\s:@]+:[^@\s]+@/.test(reference),
  );
}

function isLiveEvidenceMetadataPath(path: string): boolean {
  return (
    path === '.openslack/modules.yaml' ||
    path === 'docs/status/current.md' ||
    /^\.openslack\/evidence\/live\/[^/]+\.json$/.test(path)
  );
}
