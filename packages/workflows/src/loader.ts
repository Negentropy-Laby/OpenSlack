import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { validateManifest } from './manifest.js';
import { getEmbeddedBuiltin, listEmbeddedBuiltins } from './embedded-builtins.js';
import type { WorkflowMeta, WorkflowFormat, WorkflowModule, WorkflowSource } from './types.js';
import { resolveWorkflowIdentityHash } from './internal/workflow-identity.js';
import {
  analyzeStaticMeta,
  detectFormat,
  detectFormatFromSource,
  loadWorkflowFile,
  type WorkflowLoadOptions,
} from './internal/workflow-file-loader.js';

export { analyzeStaticMeta, detectFormat, detectFormatFromSource };
export type { WorkflowLoadOptions };

/**
 * Ordered discovery paths for workflow files.
 * Later entries have lower priority (earlier match wins).
 */
export const DISCOVERY_PATHS = [
  '.openslack/workflows', // project-local TypeScript
  '.claude/workflows', // Anthropic-compatible legacy
] as const;

export interface WorkflowDiscoveryOptions {
  /**
   * Override the user home used for ~/.claude/workflows discovery.
   * Undefined preserves production behavior; null disables user-home discovery
   * for isolated callers such as tests.
   */
  userHomeDir?: string | null;
}

/**
 * Built-in workflows shipped with @openslack/workflows.
 */
const BUILTINS_DIR = join(import.meta.dirname, 'builtins');

export function resolveBuiltinTemplatesDir(): string | undefined {
  const candidates = [
    resolve(import.meta.dirname, '..', '..', '..', 'templates', 'workflows'),
    join(dirname(process.execPath), 'assets', 'workflows'),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

/**
 * Map a discovery directory to its WorkflowSource label.
 */
function sourceForDir(dir: string, cwd: string): WorkflowSource {
  if (dir === resolve(cwd, '.openslack/workflows')) return 'openslack-project';
  if (dir === resolve(cwd, '.claude/workflows')) return 'claude-project';
  if (dir === join(homedir(), '.claude', 'workflows')) return 'claude-user';
  if (dir === BUILTINS_DIR) return 'builtin';
  return 'builtin'; // fallback
}

/**
 * Check whether a filename has a supported workflow extension (.ts, .js, .mjs).
 */
function hasWorkflowExtension(entry: string): boolean {
  return entry.endsWith('.ts') || entry.endsWith('.js') || entry.endsWith('.mjs');
}

/**
 * Strip the workflow extension from a filename.
 */
function stripWorkflowExtension(entry: string): string {
  return entry.replace(/\.(ts|js|mjs)$/, '');
}

/**
 * Discover all available workflow names across discovery paths.
 * Returns an array of { name, path, source } objects, deduplicated by name
 * (first discovery path wins).
 */
export async function discoverWorkflows(
  cwd: string = process.cwd(),
  options: WorkflowDiscoveryOptions = {},
): Promise<Array<{ name: string; path: string; source: WorkflowSource }>> {
  const seen = new Set<string>();
  const results: Array<{ name: string; path: string; source: WorkflowSource }> = [];

  for (const relPath of DISCOVERY_PATHS) {
    const dir = resolve(cwd, relPath);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue; // directory doesn't exist, skip
    }

    for (const entry of entries) {
      if (!hasWorkflowExtension(entry)) continue;

      const name = stripWorkflowExtension(entry);
      if (seen.has(name)) continue;
      seen.add(name);

      results.push({ name, path: join(dir, entry), source: sourceForDir(dir, cwd) });
    }
  }

  // Discover user-home workflows (~/.claude/workflows)
  const userHomeDir = options.userHomeDir === undefined ? homedir() : options.userHomeDir;
  if (userHomeDir !== null) {
    const homeClaudeDir = join(userHomeDir, '.claude', 'workflows');
    try {
      const entries = await readdir(homeClaudeDir);
      for (const entry of entries) {
        if (!hasWorkflowExtension(entry)) continue;

        const name = stripWorkflowExtension(entry);
        if (seen.has(name)) continue;
        seen.add(name);

        results.push({ name, path: join(homeClaudeDir, entry), source: 'claude-user' });
      }
    } catch {
      // home workflows dir doesn't exist, that's fine
    }
  }

  // Also discover built-in workflows
  for (const builtin of listEmbeddedBuiltins()) {
    if (seen.has(builtin.name)) continue;
    seen.add(builtin.name);
    results.push({ name: builtin.name, path: builtin.path, source: 'builtin' });
  }

  // Source checkouts may contain additional development-only built-ins.
  try {
    const entries = await readdir(BUILTINS_DIR);
    for (const entry of entries) {
      if (!hasWorkflowExtension(entry)) continue;
      const name = stripWorkflowExtension(entry);
      if (seen.has(name)) continue;
      seen.add(name);
      results.push({ name, path: join(BUILTINS_DIR, entry), source: 'builtin' });
    }
  } catch {
    // builtins dir doesn't exist yet, that's fine
  }

  return results;
}

/**
 * Load a workflow module from an embedded builtin or a reviewed workflow file.
 * The sealed runner imports the file-only core directly so its bundle never
 * captures builtin or template checkout roots.
 */
export async function loadWorkflow(
  filePath: string,
  options: WorkflowLoadOptions = {},
): Promise<WorkflowModule> {
  if (options.moduleCacheKey !== undefined && !/^[0-9a-f]{64}$/u.test(options.moduleCacheKey)) {
    throw new Error('Workflow module cache key must be a full lowercase SHA-256.');
  }
  const embedded = getEmbeddedBuiltin(filePath);
  if (embedded) {
    const errors = validateManifest(embedded.meta);
    if (errors.length > 0) {
      throw new Error(`Invalid embedded workflow manifest in ${filePath}:\n${errors.join('\n')}`);
    }
    return {
      ...embedded,
      format: detectFormat(embedded as unknown as Record<string, unknown>),
      hash: resolveWorkflowIdentityHash(embedded),
    };
  }
  return loadWorkflowFile(filePath, options);
}

/**
 * Find a single workflow by name across discovery paths and builtins.
 * Returns the { name, path, source } entry or undefined if not found.
 */
export async function findWorkflow(
  name: string,
  cwd: string = process.cwd(),
  options: WorkflowDiscoveryOptions = {},
): Promise<{ name: string; path: string; source: WorkflowSource } | undefined> {
  const all = await discoverWorkflows(cwd, options);
  return all.find((w) => w.name === name);
}

/**
 * Categorized workflow summary for listing purposes.
 */
export interface WorkflowSummary {
  /** Workflow name / ID */
  name: string;
  /** Display name from manifest (JS modules) or template name (YAML) */
  displayName: string;
  /** Source type / where the workflow was discovered */
  source: 'yaml-template' | 'js-module' | import('./types.js').WorkflowSource;
  /** Number of phases */
  phases: number;
  /** Number of inputs (YAML templates) or 0 (JS modules) */
  inputs: number;
  /** File basename */
  file: string;
  /** Description (JS modules only) */
  description?: string;
  /** Format (JS modules only) */
  format?: WorkflowFormat;
}

/**
 * Discover all YAML workflow templates from a directory.
 * Used by the CLI to list built-in templates alongside JS modules.
 */
export async function discoverYamlTemplates(templatesDir: string): Promise<WorkflowSummary[]> {
  const results: WorkflowSummary[] = [];

  let entries: string[];
  try {
    entries = await readdir(templatesDir);
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (!entry.endsWith('.yaml') && !entry.endsWith('.yml')) continue;

    const filePath = join(templatesDir, entry);
    let content: string;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch {
      continue;
    }

    // Minimal parse to extract id, name, phases, inputs
    const template = parseYamlMinimal(content);
    if (!template) continue;

    results.push({
      name: template.id ?? entry.replace(/\.ya?ml$/, ''),
      displayName: template.name ?? template.id ?? entry,
      source: 'yaml-template',
      phases: Array.isArray(template.phases) ? template.phases.length : 0,
      inputs: Array.isArray(template.inputs) ? template.inputs.length : 0,
      file: entry,
    });
  }

  return results;
}

/**
 * Discover all JS/TS workflow modules and return categorized summaries.
 */
export async function discoverJsWorkflows(
  cwd: string = process.cwd(),
  options: WorkflowDiscoveryOptions = {},
): Promise<WorkflowSummary[]> {
  const discovered = await discoverWorkflows(cwd, options);
  const results: WorkflowSummary[] = [];

  for (const { name, path: filePath, source: wfSource } of discovered) {
    let meta: WorkflowMeta;
    let sourceText: string;
    try {
      const embedded = getEmbeddedBuiltin(filePath);
      if (embedded) {
        meta = embedded.meta;
        sourceText = '';
      } else {
        sourceText = await readFile(filePath, 'utf-8');
        meta = analyzeStaticMeta(sourceText);
      }
    } catch {
      // Skip modules that fail static analysis
      continue;
    }

    const embedded = getEmbeddedBuiltin(filePath);
    const format = embedded
      ? detectFormat(embedded as unknown as Record<string, unknown>)
      : detectFormatFromSource(sourceText);
    const ext = filePath.endsWith('.ts') ? '.ts' : filePath.endsWith('.mjs') ? '.mjs' : '.js';
    results.push({
      name,
      displayName: meta.name,
      source: wfSource,
      phases: meta.phases.length,
      inputs: Object.keys(meta.inputs ?? {}).length,
      file: `${name}${ext}`,
      description: meta.description,
      format,
    });
  }

  return results;
}

/**
 * Minimal YAML parse for workflow template listing.
 * Extracts id, name, phases count, inputs count without full validation.
 */
function parseYamlMinimal(content: string): {
  id?: string;
  name?: string;
  phases?: unknown[];
  inputs?: unknown[];
} | null {
  // Quick regex extraction to avoid a full YAML parser dependency
  // in the workflows package (which doesn't depend on 'yaml')
  const idMatch = content.match(/^id:\s*(.+)$/m);
  const nameMatch = content.match(/^name:\s*(.+)$/m);

  // Count phases by looking for "  - name:" patterns under phases:
  let phasesCount = 0;
  const phasesMatch = content.match(/^phases:\s*$/m);
  if (phasesMatch) {
    const phasesStart = phasesMatch.index! + phasesMatch[0].length;
    const phasesSection = content.slice(phasesStart);
    // Count top-level phase entries (lines starting with "  - name:")
    const phaseEntries = phasesSection.match(/^\s+- name:/gm);
    phasesCount = phaseEntries ? phaseEntries.length : 0;
  }

  // Count inputs
  let inputsCount = 0;
  const inputsMatch = content.match(/^inputs:\s*$/m);
  if (inputsMatch) {
    const inputsStart = inputsMatch.index! + inputsMatch[0].length;
    const inputsSection = content.slice(inputsStart);
    // Stop at next top-level key
    const nextKeyMatch = inputsSection.match(/^\w/m);
    const relevantSection = nextKeyMatch
      ? inputsSection.slice(0, nextKeyMatch.index)
      : inputsSection;
    const inputEntries = relevantSection.match(/^\s+- name:/gm);
    inputsCount = inputEntries ? inputEntries.length : 0;
  }

  return {
    id: idMatch?.[1]?.trim(),
    name: nameMatch?.[1]?.trim(),
    phases: Array.from({ length: phasesCount }),
    inputs: Array.from({ length: inputsCount }),
  };
}
