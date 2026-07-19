import { parse as parseYaml } from 'yaml';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ProfileSyncConfig {
  schema: 'openslack.profile_sync.v1';
  source: {
    repo: string;
    branch: string;
    path: string;
  };
  target: {
    repo: string;
    branch: string;
    path: string;
    marker: string;
  };
  mode: 'manual' | 'watch' | 'auto-pr';
  max_posts: number;
  pr: {
    draft: boolean;
    labels: string[];
  };
  failure_issue: {
    enabled: boolean;
  };
  on_existing_pr?: 'skip' | 'update' | 'create_new';
}

export interface ProfileSyncConfigParseResult {
  valid: boolean;
  config?: ProfileSyncConfig;
  errors: string[];
}

// ── Defaults ──────────────────────────────────────────────────────────────────

export const DEFAULT_PROFILE_SYNC_CONFIG: ProfileSyncConfig = {
  schema: 'openslack.profile_sync.v1',
  source: {
    repo: 'Negentropy-Laby/whitepapers',
    branch: 'main',
    path: 'posts',
  },
  target: {
    repo: 'Negentropy-Laby/.github',
    branch: 'main',
    path: 'profile/README.md',
    marker: 'latest-insights',
  },
  mode: 'manual',
  max_posts: 5,
  pr: {
    draft: true,
    labels: ['profile:sync'],
  },
  failure_issue: {
    enabled: true,
  },
  on_existing_pr: 'skip',
};

const VALID_MODES = new Set(['manual', 'watch', 'auto-pr']);
const VALID_ON_EXISTING_PR = new Set(['skip', 'update', 'create_new']);

// ── Parse / Validate ──────────────────────────────────────────────────────────

export function parseProfileSyncConfig(yaml: string): ProfileSyncConfigParseResult {
  const errors: string[] = [];

  let parsed: unknown;
  try {
    parsed = parseYaml(yaml);
  } catch (e) {
    return { valid: false, errors: [`YAML parse error: ${(e as Error).message}`] };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { valid: false, errors: ['Parsed YAML is not an object'] };
  }

  const m = parsed as Record<string, unknown>;

  if (m.schema !== 'openslack.profile_sync.v1') {
    errors.push(`Invalid schema: "${String(m.schema)}". Expected "openslack.profile_sync.v1"`);
  }

  // source
  const sourceRepo = extractString(m.source, 'repo', 'source');
  const sourceBranch = extractString(m.source, 'branch', 'source', 'main');
  const sourcePath = extractString(m.source, 'path', 'source', 'posts');
  if (!sourceRepo) errors.push('source.repo is required');

  // target
  const targetRepo = extractString(m.target, 'repo', 'target');
  const targetBranch = extractString(m.target, 'branch', 'target', 'main');
  const targetPath = extractString(m.target, 'path', 'target', 'profile/README.md');
  const marker = extractString(m.target, 'marker', 'target', 'latest-insights');
  if (!targetRepo) errors.push('target.repo is required');

  // mode
  const mode = extractString(m, 'mode', undefined, 'manual');
  if (mode && !VALID_MODES.has(mode)) {
    errors.push(`Invalid mode: "${mode}". Must be one of: manual, watch, auto-pr`);
  }

  // max_posts
  const maxPosts = extractNumber(m, 'max_posts', 5);
  if (maxPosts < 1 || maxPosts > 20) {
    errors.push(`max_posts must be between 1 and 20, got ${maxPosts}`);
  }

  // pr
  const prDraft = extractBoolean(m.pr, 'draft', true);
  const prLabels = extractStringArray(m.pr, 'labels', ['profile:sync']);

  // failure_issue
  const failureEnabled = extractBoolean(m.failure_issue, 'enabled', true);

  // on_existing_pr
  const onExistingPr = extractString(m, 'on_existing_pr', undefined, 'skip');
  if (onExistingPr && !VALID_ON_EXISTING_PR.has(onExistingPr)) {
    errors.push(
      `Invalid on_existing_pr: "${onExistingPr}". Must be one of: skip, update, create_new`,
    );
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    config: {
      schema: 'openslack.profile_sync.v1',
      source: {
        repo: sourceRepo || DEFAULT_PROFILE_SYNC_CONFIG.source.repo,
        branch: sourceBranch,
        path: sourcePath,
      },
      target: {
        repo: targetRepo || DEFAULT_PROFILE_SYNC_CONFIG.target.repo,
        branch: targetBranch,
        path: targetPath,
        marker: marker,
      },
      mode: (mode as ProfileSyncConfig['mode']) || 'manual',
      max_posts: maxPosts,
      pr: {
        draft: prDraft,
        labels: prLabels,
      },
      failure_issue: {
        enabled: failureEnabled,
      },
      on_existing_pr: (onExistingPr as ProfileSyncConfig['on_existing_pr']) || 'skip',
    },
    errors: [],
  };
}

export function loadProfileSyncConfig(rootPath?: string): ProfileSyncConfig {
  const root = rootPath || process.cwd();
  const configPath = join(root, '.openslack', 'profile-sync.yaml');

  if (!existsSync(configPath)) {
    return { ...DEFAULT_PROFILE_SYNC_CONFIG };
  }

  try {
    const yaml = readFileSync(configPath, 'utf-8');
    const result = parseProfileSyncConfig(yaml);
    if (result.valid && result.config) {
      return result.config;
    }
    // If parse fails, fall back to defaults with a warning logged by caller
    return { ...DEFAULT_PROFILE_SYNC_CONFIG };
  } catch {
    return { ...DEFAULT_PROFILE_SYNC_CONFIG };
  }
}

export function validateProfileSyncConfig(config: unknown): { valid: boolean; errors: string[] } {
  if (!config || typeof config !== 'object') {
    return { valid: false, errors: ['Config must be an object'] };
  }

  const c = config as Record<string, unknown>;
  const errors: string[] = [];

  if (c.schema !== 'openslack.profile_sync.v1') {
    errors.push(`Invalid schema: "${String(c.schema)}"`);
  }

  const source = c.source as Record<string, unknown> | undefined;
  if (!source || typeof source !== 'object') {
    errors.push('source is required');
  } else {
    if (typeof source.repo !== 'string' || source.repo.length === 0)
      errors.push('source.repo is required');
    if (typeof source.branch !== 'string' || source.branch.length === 0)
      errors.push('source.branch is required');
    if (typeof source.path !== 'string' || source.path.length === 0)
      errors.push('source.path is required');
  }

  const target = c.target as Record<string, unknown> | undefined;
  if (!target || typeof target !== 'object') {
    errors.push('target is required');
  } else {
    if (typeof target.repo !== 'string' || target.repo.length === 0)
      errors.push('target.repo is required');
    if (typeof target.branch !== 'string' || target.branch.length === 0)
      errors.push('target.branch is required');
    if (typeof target.path !== 'string' || target.path.length === 0)
      errors.push('target.path is required');
    if (typeof target.marker !== 'string' || target.marker.length === 0)
      errors.push('target.marker is required');
  }

  if (typeof c.mode !== 'string' || !VALID_MODES.has(c.mode)) {
    errors.push(`mode must be one of: manual, watch, auto-pr`);
  }

  if (typeof c.max_posts !== 'number' || c.max_posts < 1 || c.max_posts > 20) {
    errors.push('max_posts must be a number between 1 and 20');
  }

  const pr = c.pr as Record<string, unknown> | undefined;
  if (pr && typeof pr === 'object') {
    if (typeof pr.draft !== 'boolean') errors.push('pr.draft must be a boolean');
    if (!Array.isArray(pr.labels)) errors.push('pr.labels must be an array of strings');
  }

  const failure = c.failure_issue as Record<string, unknown> | undefined;
  if (failure && typeof failure === 'object') {
    if (typeof failure.enabled !== 'boolean')
      errors.push('failure_issue.enabled must be a boolean');
  }

  return { valid: errors.length === 0, errors };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractString(
  parent: unknown,
  key: string,
  parentName?: string,
  defaultValue?: string,
): string {
  if (!parent || typeof parent !== 'object') return defaultValue || '';
  const p = parent as Record<string, unknown>;
  const val = p[key];
  if (typeof val === 'string') return val;
  return defaultValue || '';
}

function extractNumber(parent: unknown, key: string, defaultValue: number): number {
  if (!parent || typeof parent !== 'object') return defaultValue;
  const p = parent as Record<string, unknown>;
  const val = p[key];
  if (typeof val === 'number') return val;
  return defaultValue;
}

function extractBoolean(parent: unknown, key: string, defaultValue: boolean): boolean {
  if (!parent || typeof parent !== 'object') return defaultValue;
  const p = parent as Record<string, unknown>;
  const val = p[key];
  if (typeof val === 'boolean') return val;
  return defaultValue;
}

function extractStringArray(parent: unknown, key: string, defaultValue: string[]): string[] {
  if (!parent || typeof parent !== 'object') return defaultValue;
  const p = parent as Record<string, unknown>;
  const val = p[key];
  if (Array.isArray(val)) {
    return val.filter((s): s is string => typeof s === 'string');
  }
  return defaultValue;
}
