import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, posix, relative, resolve, sep } from 'node:path';

import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { ValidateFunction } from 'ajv';
import { parse as parseYaml } from 'yaml';

const SCHEMA_ROOT = 'docs/reference/schemas/documentation';
const MIGRATION_MANIFEST = 'docs/reference/document-path-migration-v1.yaml';
const PROJECT_STATE = 'memory_bank/t0_core/project_state.yaml';
const RELEASE_STATE = 'memory_bank/t0_core/release_state.yaml';
const WORK_ASSIGNMENTS = 'memory_bank/t2_execution/work_assignments.yaml';
const DOCUMENT_MAP = 'memory_bank/document_map.yaml';

const PRODUCT_MODULES = new Set([
  'self-evolution',
  'github-task-loop',
  'operator',
  'pr-review-merge',
  'collaboration',
]);

const WORKSTREAMS = new Set([
  'notification-delivery',
  'plugin-platform',
  'agent-runtime-and-aby',
  'workflow-runtime',
  'organization-graph',
  'scenario-runtime',
  'qoder-work',
  'negentropy-integration',
  'profile-sync',
  'tui-productization',
]);

const ASSIGNMENT_STATUSES = new Set([
  'planned',
  'ready',
  'claimed',
  'running',
  'review',
  'blocked',
  'reconciliation_required',
  'done',
  'cancelled',
]);

const EXECUTING_ASSIGNMENT_STATUSES = new Set(['claimed', 'running', 'review', 'done']);

const TEXT_SCAN_EXCLUDED_NAMES = new Set([
  '.aby',
  '.claude',
  '.git',
  '.worktrees',
  'coverage',
  'dist',
  'node_modules',
]);

// These repository subtrees have their own authority or contain local-only
// evidence. The root migration scan must not reinterpret their path history.
const TEXT_SCAN_EXCLUDED_PATHS = new Set(['.openslack.local', 'services/notification-delivery']);

type GeneratedTarget =
  | 'memory_bank/t0_core/current_state.md'
  | 'memory_bank/t0_core/release_state.md'
  | 'memory_bank/t2_execution/current_roadmap.md'
  | 'production/project-roadmap.md';

const schemaValidatorCache = new Map<string, ValidateFunction>();

type JsonObject = Record<string, unknown>;

export interface MigrationEntry {
  id: string;
  old_path: string;
  new_path: string;
  document_id: string;
  migration_type: 'retained' | 'moved' | 'archived' | 'replaced' | 'generated';
}

interface MigrationManifest {
  schema: string;
  phase: 'planning' | 'migrated';
  baseline_document_count: number;
  entries: MigrationEntry[];
  reference_exceptions?: string[];
}

interface DocumentRecord {
  id: string;
  path: string;
  status: 'active' | 'generated' | 'index' | 'archived';
}

interface DocumentMap {
  schema: string;
  authorities: Array<{
    fact: string;
    canonical: string;
    projections?: string[];
    indexes?: string[];
    archives?: string[];
  }>;
  documents: DocumentRecord[];
}

export interface VerificationResult {
  schemas: number;
  documents: number;
  generated: number;
}

function asObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as JsonObject;
}

function readYaml(root: string, repositoryPath: string): unknown {
  return parseYaml(readFileSync(join(root, repositoryPath), 'utf8')) as unknown;
}

function schemaPaths(root: string): string[] {
  const directory = join(root, SCHEMA_ROOT);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith('.schema.json'))
    .sort()
    .map((name) => `${SCHEMA_ROOT}/${name}`);
}

function createAjv(): Ajv2020 {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv;
}

function loadSchema(root: string, file: string): JsonObject {
  return asObject(JSON.parse(readFileSync(join(root, file), 'utf8')) as unknown, file);
}

function compileSchema(root: string, file: string): ValidateFunction {
  const absolutePath = resolve(root, file);
  const cached = schemaValidatorCache.get(absolutePath);
  if (cached) return cached;
  const validate = createAjv().compile(loadSchema(root, file));
  schemaValidatorCache.set(absolutePath, validate);
  return validate;
}

function validateWithSchema(root: string, data: unknown, schemaFile: string, label: string): void {
  const validate = compileSchema(root, `${SCHEMA_ROOT}/${schemaFile}`);
  if (!validate(data)) {
    const details = (validate.errors ?? [])
      .map((error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`)
      .join('; ');
    throw new Error(`${label} does not match ${schemaFile}: ${details}`);
  }
}

export function validateRepositoryPath(value: string, label = 'path'): void {
  if (!value || isAbsolute(value) || value.includes('\\') || value.includes('\0')) {
    throw new Error(`${label} must be a non-empty repository-relative POSIX path.`);
  }
  const normalized = posix.normalize(value);
  if (normalized !== value || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`${label} escapes or is not normalized: ${value}`);
  }
}

function ensureUnique(values: string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`Duplicate ${label}: ${value}`);
    seen.add(value);
  }
}

export function validateDocumentMetadata(metadata: unknown): void {
  const value = asObject(metadata, 'document metadata');
  const required = [
    'schema',
    'id',
    'status',
    'authority',
    'audience',
    'owner',
    'updated',
    'sources',
  ];
  for (const key of required) {
    if (!(key in value)) throw new Error(`Document metadata is missing ${key}.`);
  }
  if (value.schema !== 'openslack.document.v1') {
    throw new Error('Document metadata schema must be openslack.document.v1.');
  }
  if (typeof value.owner !== 'string' || value.owner.trim() === '') {
    throw new Error('Document metadata owner must be a non-empty string.');
  }
  if (!Array.isArray(value.sources)) throw new Error('Document metadata sources must be an array.');
}

export function validateProjectStateObject(value: unknown): void {
  const state = asObject(value, 'project state');
  if (state.schema !== 'openslack.project_state.v1') {
    throw new Error('Project state schema must be openslack.project_state.v1.');
  }
  const modules = state.modules;
  if (!Array.isArray(modules)) throw new Error('Project state modules must be an array.');
  ensureUnique(
    modules.map((entry) => String(asObject(entry, 'module').id)),
    'project module id',
  );
  for (const raw of modules) {
    const module = asObject(raw, 'module');
    const id = String(module.id);
    if (!PRODUCT_MODULES.has(id)) throw new Error(`Unknown project module: ${id}`);
    requirePromotionEvidence(module, `module ${id}`);
  }
  const workstreams = state.workstreams;
  if (!Array.isArray(workstreams)) throw new Error('Project state workstreams must be an array.');
  ensureUnique(
    workstreams.map((entry) => String(asObject(entry, 'workstream').id)),
    'workstream id',
  );
  for (const raw of workstreams) {
    const workstream = asObject(raw, 'workstream');
    const id = String(workstream.id);
    if (!WORKSTREAMS.has(id)) throw new Error(`Unknown workstream: ${id}`);
    requirePromotionEvidence(workstream, `workstream ${id}`);
  }
}

function requirePromotionEvidence(value: JsonObject, label: string): void {
  const maturity = String(value.maturity ?? '');
  const evidence = Array.isArray(value.evidence) ? value.evidence : [];
  if (['live_verified', 'production_ready'].includes(maturity) && evidence.length === 0) {
    throw new Error(`${label} cannot be promoted to ${maturity} without evidence.`);
  }
}

export function validateWorkAssignmentsObject(value: unknown): void {
  const assignments = asObject(value, 'work assignments');
  if (assignments.schema !== 'openslack.work_assignments.v1') {
    throw new Error('Work assignments schema must be openslack.work_assignments.v1.');
  }
  const items = assignments.assignments;
  if (!Array.isArray(items)) throw new Error('Work assignments assignments must be an array.');
  ensureUnique(
    items.map((entry) => String(asObject(entry, 'assignment').id)),
    'assignment id',
  );
  for (const raw of items) {
    const item = asObject(raw, 'assignment');
    if (!ASSIGNMENT_STATUSES.has(String(item.status))) {
      throw new Error(`Invalid work assignment status: ${String(item.status)}`);
    }
    if (typeof item.planned_owner !== 'string' || item.planned_owner.trim() === '') {
      throw new Error(`Assignment ${String(item.id)} must declare planned_owner or unassigned.`);
    }
    if (EXECUTING_ASSIGNMENT_STATUSES.has(String(item.status))) {
      const execution = asObject(
        item.execution,
        `assignment ${String(item.id)} execution authority`,
      );
      if (typeof execution.agent_id !== 'string' || execution.agent_id.trim() === '') {
        throw new Error(
          `Assignment ${String(item.id)} with status ${String(item.status)} requires execution.agent_id.`,
        );
      }
      if (typeof execution.claim_ref !== 'string' || execution.claim_ref.trim() === '') {
        throw new Error(
          `Assignment ${String(item.id)} with status ${String(item.status)} requires execution.claim_ref.`,
        );
      }
    }
    if (item.github_issue !== null && item.github_issue !== undefined) {
      const issue = asObject(item.github_issue, `assignment ${String(item.id)} github_issue`);
      if (
        !Number.isInteger(issue.number) ||
        Number(issue.number) < 1 ||
        typeof issue.url !== 'string' ||
        !/^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/[1-9]\d*$/.test(issue.url)
      ) {
        throw new Error(`Assignment ${String(item.id)} has an invalid GitHub Issue.`);
      }
    }
    if (item.pull_request !== null && item.pull_request !== undefined) {
      const pullRequest = asObject(item.pull_request, `assignment ${String(item.id)} pull_request`);
      if (
        !Number.isInteger(pullRequest.number) ||
        Number(pullRequest.number) < 1 ||
        typeof pullRequest.url !== 'string' ||
        !/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/[1-9]\d*$/.test(pullRequest.url)
      ) {
        throw new Error(`Assignment ${String(item.id)} has an invalid pull request.`);
      }
    }
  }
}

function parseFrontmatter(markdown: string, path: string): JsonObject {
  if (!markdown.startsWith('---\n')) throw new Error(`${path} is missing YAML frontmatter.`);
  const end = markdown.indexOf('\n---\n', 4);
  if (end === -1) throw new Error(`${path} has unterminated YAML frontmatter.`);
  return asObject(parseYaml(markdown.slice(4, end)), `${path} frontmatter`);
}

function validateDocumentMap(root: string, value: unknown): number {
  validateWithSchema(root, value, 'document-map.schema.json', DOCUMENT_MAP);
  const map = value as DocumentMap;
  ensureUnique(
    map.authorities.map((entry) => entry.fact),
    'authority fact',
  );
  ensureUnique(
    map.authorities.map((entry) => entry.canonical),
    'canonical authority path',
  );
  ensureUnique(
    map.documents.map((entry) => entry.id),
    'document id',
  );
  ensureUnique(
    map.documents.map((entry) => entry.path),
    'active document path',
  );
  for (const authority of map.authorities) {
    validateRepositoryPath(authority.canonical, `authority ${authority.fact}`);
    if (!existsSync(join(root, authority.canonical))) {
      throw new Error(`Authority ${authority.fact} is missing: ${authority.canonical}`);
    }
  }
  let active = 0;
  for (const document of map.documents) {
    validateRepositoryPath(document.path, `document ${document.id}`);
    const fullPath = join(root, document.path);
    if (!existsSync(fullPath)) throw new Error(`Registered document is missing: ${document.path}`);
    if (document.status === 'active' || document.status === 'index') {
      const metadata = parseFrontmatter(readFileSync(fullPath, 'utf8'), document.path);
      validateWithSchema(root, metadata, 'document-metadata.schema.json', document.path);
      validateDocumentMetadata(metadata);
      if (metadata.id !== document.id) {
        throw new Error(`${document.path} frontmatter id does not match document_map.yaml.`);
      }
      active += 1;
    }
  }
  return active;
}

function validateModuleTelemetryBoundary(root: string): void {
  const path = join(root, '.openslack/modules.yaml');
  if (!existsSync(path)) return;
  const value = readYaml(root, '.openslack/modules.yaml');
  const forbidden = new Set([
    'portfolio_stage',
    'planned_owner',
    'release_approval',
    'task_status',
    'human_approval',
  ]);
  const visit = (input: unknown): void => {
    if (Array.isArray(input)) {
      for (const item of input) visit(item);
      return;
    }
    if (!input || typeof input !== 'object') return;
    for (const [key, item] of Object.entries(input as JsonObject)) {
      if (forbidden.has(key)) {
        throw new Error(`.openslack/modules.yaml cannot own project-governance field ${key}.`);
      }
      visit(item);
    }
  };
  visit(value);
}

function loadCanonical(root: string): {
  project: JsonObject;
  release: JsonObject;
  assignments: JsonObject;
} | null {
  if (
    ![PROJECT_STATE, RELEASE_STATE, WORK_ASSIGNMENTS].every((path) => existsSync(join(root, path)))
  ) {
    return null;
  }
  const project = asObject(readYaml(root, PROJECT_STATE), PROJECT_STATE);
  const release = asObject(readYaml(root, RELEASE_STATE), RELEASE_STATE);
  const assignments = asObject(readYaml(root, WORK_ASSIGNMENTS), WORK_ASSIGNMENTS);
  validateWithSchema(root, project, 'project-state.schema.json', PROJECT_STATE);
  validateWithSchema(root, release, 'release-state.schema.json', RELEASE_STATE);
  validateWithSchema(root, assignments, 'work-assignments.schema.json', WORK_ASSIGNMENTS);
  validateProjectStateObject(project);
  validateWorkAssignmentsObject(assignments);
  return { project, release, assignments };
}

function markdownMetadata(id: string, owner: string, source: string, updated: string): string {
  return `---\nschema: openslack.document.v1\nid: ${id}\nstatus: Generated\nauthority: projection\naudience:\n  - contributors\nowner: ${owner}\nupdated: ${updated}\nsources:\n  - ${source}\ngenerated: true\n---\n\n`;
}

function renderProjectState(project: JsonObject): string {
  const modules = project.modules as JsonObject[];
  const workstreams = project.workstreams as JsonObject[];
  const updated = String(project.updated);
  const rows = modules
    .map(
      (module) =>
        `| ${String(module.name)} | ${String(module.stage)} | ${String(module.maturity)} | ${formatList(module.blockers)} |`,
    )
    .join('\n');
  const workstreamRows = workstreams
    .map(
      (stream) =>
        `| ${String(stream.name)} | ${String(stream.stage)} | ${String(stream.maturity)} | ${formatList(stream.blockers)} |`,
    )
    .join('\n');
  return `${markdownMetadata('state-current', 'project-governance', PROJECT_STATE, updated)}# Current Project State\n\n> Generated by \`bun run docs:generate\`. Do not edit this projection directly.\n\n- Portfolio status: **${String(project.portfolio_status)}**\n- Release train: **${String(project.release_train)}**\n- Last verified: **${String(project.last_verified)}**\n\n## Product Modules\n\n<!-- prettier-ignore -->\n| Module | Stage | Maturity | Blockers |\n| --- | --- | --- | --- |\n${rows}\n\n## Workstreams\n\n<!-- prettier-ignore -->\n| Workstream | Stage | Maturity | Blockers |\n| --- | --- | --- | --- |\n${workstreamRows}\n`;
}

function formatList(value: unknown): string {
  return Array.isArray(value) && value.length > 0 ? value.map(String).join('<br>') : 'None';
}

function renderReleaseState(release: JsonObject): string {
  const gates = release.gates as JsonObject[];
  const updated = String(release.updated);
  const rows = gates
    .map(
      (gate) =>
        `| ${String(gate.id)} | ${String(gate.status)} | ${formatList(gate.evidence)} | ${String(gate.notes ?? '')} |`,
    )
    .join('\n');
  return `${markdownMetadata('release-current', 'release-governance', RELEASE_STATE, updated)}# Current Release State\n\n> Generated by \`bun run docs:generate\`. Release gates are independent claims.\n\n- Train: **${String(release.train)}**\n- Overall status: **${String(release.status)}**\n- Human approval: **${String(release.human_approval)}**\n\n<!-- prettier-ignore -->\n| Gate | Status | Evidence | Notes |\n| --- | --- | --- | --- |\n${rows}\n`;
}

function renderRoadmap(
  project: JsonObject,
  assignments: JsonObject,
  memoryMirror: boolean,
): string {
  const updated = String(assignments.updated);
  const items = assignments.assignments as JsonObject[];
  const rows = items
    .map(
      (item) =>
        `| ${String(item.id)} | ${String(item.title)} | ${String(item.status)} | ${String(item.planned_owner)} | ${String(item.module_or_workstream)} | ${formatList(item.blockers)} |`,
    )
    .join('\n');
  const mirror = memoryMirror
    ? '> Governance memory mirror. Team-facing projection: `production/project-roadmap.md`.\n\n'
    : '> Team-facing projection. Governance source: `memory_bank/t2_execution/work_assignments.yaml`.\n\n';
  return `${markdownMetadata(memoryMirror ? 'roadmap-memory-current' : 'roadmap-production-current', 'project-governance', WORK_ASSIGNMENTS, updated)}# OpenSlack Project Roadmap\n\n${mirror}- Portfolio status: **${String(project.portfolio_status)}**\n- Release train: **${String(project.release_train)}**\n- Generated from structured assignments: **${items.length} items**\n\n<!-- prettier-ignore -->\n| Work item | Title | Status | Planned owner | Scope | Blockers |\n| --- | --- | --- | --- | --- | --- |\n${rows}\n`;
}

export function renderGeneratedDocuments(
  project: JsonObject,
  release: JsonObject,
  assignments: JsonObject,
): Record<GeneratedTarget, string> {
  return {
    'memory_bank/t0_core/current_state.md': renderProjectState(project),
    'memory_bank/t0_core/release_state.md': renderReleaseState(release),
    'memory_bank/t2_execution/current_roadmap.md': renderRoadmap(project, assignments, true),
    'production/project-roadmap.md': renderRoadmap(project, assignments, false),
  };
}

export function generateDocumentation(root: string): string[] {
  const canonical = loadCanonical(root);
  if (!canonical) {
    throw new Error(
      'Canonical Memory Bank YAML is missing; generation is unavailable in planning mode.',
    );
  }
  const rendered = renderGeneratedDocuments(
    canonical.project,
    canonical.release,
    canonical.assignments,
  );
  for (const [repositoryPath, content] of Object.entries(rendered)) {
    writeFileSync(join(root, repositoryPath), content, 'utf8');
  }
  return Object.keys(rendered).sort();
}

function verifyGenerated(
  root: string,
  canonical: NonNullable<ReturnType<typeof loadCanonical>>,
): number {
  const expected = renderGeneratedDocuments(
    canonical.project,
    canonical.release,
    canonical.assignments,
  );
  for (const [repositoryPath, content] of Object.entries(expected)) {
    const fullPath = join(root, repositoryPath);
    if (!existsSync(fullPath))
      throw new Error(`Generated projection is missing: ${repositoryPath}`);
    if (readFileSync(fullPath, 'utf8') !== content) {
      throw new Error(
        `Generated projection is stale or hand-edited: ${repositoryPath}. Run bun run docs:generate.`,
      );
    }
  }
  return Object.keys(expected).length;
}

function collectMarkdownFiles(root: string, records: DocumentRecord[]): string[] {
  return records
    .filter((record) => ['active', 'index', 'generated'].includes(record.status))
    .map((record) => record.path)
    .filter((path) => path.endsWith('.md') && existsSync(join(root, path)));
}

function githubSlug(heading: string): string {
  return heading
    .replace(/\s+#+\s*$/u, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function markdownHeadingSlugs(markdown: string): string[] {
  const counts = new Map<string, number>();
  return markdown
    .split(/\r?\n/)
    .filter((line) => /^#{1,6}\s+/.test(line))
    .map((line) => githubSlug(line.replace(/^#{1,6}\s+/, '')))
    .filter(Boolean)
    .map((slug) => {
      const count = counts.get(slug) ?? 0;
      counts.set(slug, count + 1);
      return count === 0 ? slug : `${slug}-${count}`;
    });
}

function markdownLinkDestination(rawTarget: string): string {
  const value = rawTarget.trim();
  if (value.startsWith('<')) {
    const end = value.indexOf('>');
    return end === -1 ? value : value.slice(1, end);
  }
  return value.match(/^(?:\\.|[^\s])+/u)?.[0] ?? '';
}

function validateLinks(root: string, files: string[]): void {
  const errors: string[] = [];
  for (const repositoryPath of files) {
    const content = readFileSync(join(root, repositoryPath), 'utf8');
    const linkPattern = /(?<!!)\[[^\]]*]\(([^)]+)\)/g;
    for (const match of content.matchAll(linkPattern)) {
      const rawTarget = markdownLinkDestination(match[1] ?? '');
      // Inline regular expressions such as `[a-z](?:...)` resemble Markdown
      // links to this deliberately small parser; `?:` identifies that
      // non-capturing-group form rather than a repository path.
      if (!rawTarget || rawTarget.startsWith('?:') || /^(?:https?:|mailto:)/.test(rawTarget)) {
        continue;
      }
      const [targetPath, anchor] = rawTarget.split('#', 2);
      let decoded: string;
      try {
        decoded = decodeURIComponent(targetPath ?? '');
      } catch {
        errors.push(`Malformed Markdown link in ${repositoryPath}: ${rawTarget}`);
        continue;
      }
      const resolvedPath = decoded
        ? posix.normalize(posix.join(posix.dirname(repositoryPath), decoded))
        : repositoryPath;
      try {
        validateRepositoryPath(resolvedPath, `link in ${repositoryPath}`);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
        continue;
      }
      const fullTarget = join(root, resolvedPath);
      if (!existsSync(fullTarget)) {
        errors.push(`Broken Markdown link in ${repositoryPath}: ${rawTarget}`);
        continue;
      }
      if (anchor && resolvedPath.endsWith('.md')) {
        const headings = markdownHeadingSlugs(readFileSync(fullTarget, 'utf8'));
        let decodedAnchor: string;
        try {
          decodedAnchor = decodeURIComponent(anchor).toLowerCase();
        } catch {
          errors.push(`Malformed Markdown link in ${repositoryPath}: ${rawTarget}`);
          continue;
        }
        if (!headings.includes(decodedAnchor)) {
          errors.push(`Broken Markdown anchor in ${repositoryPath}: ${rawTarget}`);
        }
      }
    }
  }
  if (errors.length > 0) {
    throw new Error(`Markdown link validation failed:\n${errors.slice(0, 100).join('\n')}`);
  }
}

function walkTextFiles(root: string, current = ''): string[] {
  const full = join(root, current);
  const result: string[] = [];
  for (const name of readdirSync(full).sort()) {
    if (TEXT_SCAN_EXCLUDED_NAMES.has(name)) continue;
    const child = current ? `${current}/${name}` : name;
    if (
      [...TEXT_SCAN_EXCLUDED_PATHS].some(
        (excludedPath) => child === excludedPath || child.startsWith(`${excludedPath}/`),
      )
    ) {
      continue;
    }
    const stats = statSync(join(root, child));
    if (stats.isDirectory()) result.push(...walkTextFiles(root, child));
    else if (
      /\.(?:md|ya?ml|json|jsonc|ts|tsx|js|mjs|cjs|sh|ps1)$/.test(name) ||
      ['AGENTS.md', 'CLAUDE.md', 'README.md', 'CHANGELOG.md'].includes(name)
    ) {
      result.push(child);
    }
  }
  return result;
}

function containsLegacyPathReference(content: string, repositoryPath: string): boolean {
  const escaped = repositoryPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pathCharacter = '\\p{L}\\p{N}._/-';
  const trailingBoundary = `(?=$|[^${pathCharacter}]|\\.+(?=$|[^${pathCharacter}]))`;
  return new RegExp(`(?:^|[^${pathCharacter}])${escaped}${trailingBoundary}`, 'imu').test(content);
}

function migrationManifest(root: string): MigrationManifest {
  const value = readYaml(root, MIGRATION_MANIFEST);
  validateWithSchema(root, value, 'document-path-migration.schema.json', MIGRATION_MANIFEST);
  return value as MigrationManifest;
}

export function verifyMigration(root: string): { phase: string; entries: number } {
  const manifest = migrationManifest(root);
  if (manifest.entries.length !== manifest.baseline_document_count) {
    throw new Error(
      `Migration manifest has ${manifest.entries.length} entries; expected ${manifest.baseline_document_count}.`,
    );
  }
  ensureUnique(
    manifest.entries.map((entry) => entry.id),
    'migration entry id',
  );
  ensureUnique(
    manifest.entries.map((entry) => entry.old_path),
    'migration old path',
  );
  ensureUnique(
    manifest.entries.map((entry) => entry.document_id),
    'migration document id',
  );
  for (const entry of manifest.entries) {
    validateRepositoryPath(entry.old_path, `migration ${entry.id} old_path`);
    validateRepositoryPath(entry.new_path, `migration ${entry.id} new_path`);
    if (manifest.phase === 'planning') {
      if (!existsSync(join(root, entry.old_path))) {
        throw new Error(`Planning source is missing: ${entry.old_path}`);
      }
    } else {
      if (!existsSync(join(root, entry.new_path))) {
        throw new Error(`Migrated target is missing: ${entry.new_path}`);
      }
      if (entry.old_path !== entry.new_path && existsSync(join(root, entry.old_path))) {
        throw new Error(`Legacy migration source still exists: ${entry.old_path}`);
      }
    }
  }
  if (manifest.phase === 'migrated') {
    const exceptions = new Set([MIGRATION_MANIFEST, ...(manifest.reference_exceptions ?? [])]);
    const movedOldPaths = manifest.entries
      .filter((entry) => entry.old_path !== entry.new_path)
      .map((entry) => entry.old_path);
    for (const file of walkTextFiles(root)) {
      if (exceptions.has(file)) continue;
      const content = readFileSync(join(root, file), 'utf8');
      const legacy = movedOldPaths.find((path) => containsLegacyPathReference(content, path));
      if (legacy) throw new Error(`Legacy path reference ${legacy} remains in ${file}.`);
    }
  }
  return { phase: manifest.phase, entries: manifest.entries.length };
}

export function verifyDocumentation(root: string): VerificationResult {
  const schemas = schemaPaths(root);
  for (const schema of schemas) compileSchema(root, schema);
  verifyMigration(root);
  validateModuleTelemetryBoundary(root);
  const canonical = loadCanonical(root);
  let documents = 0;
  let generated = 0;
  if (existsSync(join(root, DOCUMENT_MAP))) {
    const mapValue = readYaml(root, DOCUMENT_MAP);
    documents = validateDocumentMap(root, mapValue);
    const map = mapValue as DocumentMap;
    validateLinks(root, collectMarkdownFiles(root, map.documents));
  }
  if (canonical) generated = verifyGenerated(root, canonical);
  return { schemas: schemas.length, documents, generated };
}

export function repositoryPathFromAbsolute(root: string, absolutePath: string): string {
  const value = relative(root, resolve(absolutePath)).split(sep).join('/');
  validateRepositoryPath(value);
  return value;
}
