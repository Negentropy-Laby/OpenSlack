import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { SubagentDefinition, PermissionMode } from '@openslack/kernel';

/**
 * Parse a subagent markdown file with YAML frontmatter into a SubagentDefinition.
 *
 * The file format is:
 *   ---
 *   name: Agent Name
 *   description: Agent description
 *   model: sonnet
 *   tools:
 *     - Read
 *     - Grep
 *   ---
 *   The markdown body after the closing --- is the prompt.
 *
 * FAIL CLOSED: throws if name or description is missing, or if YAML is unparseable.
 */
export function parseSubagentMarkdown(content: string, filePath: string): SubagentDefinition {
  const lines = content.split('\n');

  // Find opening ---
  let openIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === '---') {
      openIdx = i;
      break;
    }
    // Non-whitespace, non-comment before first --- means no frontmatter
    if (trimmed.length > 0) {
      throw new Error(`Subagent file "${filePath}" has no YAML frontmatter delimiter (---)`);
    }
  }

  if (openIdx === -1) {
    throw new Error(`Subagent file "${filePath}" has no YAML frontmatter delimiter (---)`);
  }

  // Find closing ---
  let closeIdx = -1;
  for (let i = openIdx + 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      closeIdx = i;
      break;
    }
  }

  if (closeIdx === -1) {
    throw new Error(
      `Subagent file "${filePath}" has unclosed YAML frontmatter (missing closing ---)`,
    );
  }

  const yamlBlock = lines.slice(openIdx + 1, closeIdx).join('\n');

  let data: Record<string, unknown>;
  try {
    data = parseYaml(yamlBlock) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `Subagent file "${filePath}" has unparseable YAML frontmatter: ${(err as Error).message}`,
    );
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`Subagent file "${filePath}" YAML frontmatter did not produce an object`);
  }

  const name = data.name as string | undefined;
  const description = data.description as string | undefined;

  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    throw new Error(`Subagent file "${filePath}" missing required "name" field in frontmatter`);
  }

  if (!description || typeof description !== 'string' || description.trim().length === 0) {
    throw new Error(
      `Subagent file "${filePath}" missing required "description" field in frontmatter`,
    );
  }

  const promptBody = lines
    .slice(closeIdx + 1)
    .join('\n')
    .trim();

  const filename = basename(filePath, '.md');
  const source = inferSource(filePath);

  const def: SubagentDefinition = {
    id: filename,
    source,
    name: name.trim(),
    description: description.trim(),
    prompt: promptBody,
    rawPath: filePath,
  };

  // Optional fields — only set if present, with runtime type validation
  if (data.tools !== undefined) {
    if (!Array.isArray(data.tools))
      throw new Error(`Subagent file "${filePath}" field "tools" must be an array`);
    if (!(data.tools as unknown[]).every((v): v is string => typeof v === 'string'))
      throw new Error(`Subagent file "${filePath}" field "tools" must contain only strings`);
    def.tools = data.tools as string[];
  }
  if (data.disallowedTools !== undefined) {
    if (!Array.isArray(data.disallowedTools))
      throw new Error(`Subagent file "${filePath}" field "disallowedTools" must be an array`);
    if (!(data.disallowedTools as unknown[]).every((v): v is string => typeof v === 'string'))
      throw new Error(
        `Subagent file "${filePath}" field "disallowedTools" must contain only strings`,
      );
    def.disallowedTools = data.disallowedTools as string[];
  }
  if (data.model !== undefined) def.model = String(data.model);
  if (data.permissionMode !== undefined) {
    const VALID_PERMISSION_MODES: readonly string[] = ['plan', 'acceptEdits', 'default', 'strict'];
    const mode = String(data.permissionMode);
    if (!VALID_PERMISSION_MODES.includes(mode)) {
      throw new Error(
        `Subagent file "${filePath}" has invalid permissionMode "${mode}". Must be one of: ${VALID_PERMISSION_MODES.join(', ')}`,
      );
    }
    def.permissionMode = mode as PermissionMode;
  }
  if (data.maxTurns !== undefined) {
    if (typeof data.maxTurns !== 'number')
      throw new Error(`Subagent file "${filePath}" field "maxTurns" must be a number`);
    def.maxTurns = data.maxTurns;
  }
  if (data.skills !== undefined) {
    if (!Array.isArray(data.skills))
      throw new Error(`Subagent file "${filePath}" field "skills" must be an array`);
    if (!(data.skills as unknown[]).every((v): v is string => typeof v === 'string'))
      throw new Error(`Subagent file "${filePath}" field "skills" must contain only strings`);
    def.skills = data.skills as string[];
  }
  if (data.mcpServers !== undefined) {
    if (!Array.isArray(data.mcpServers))
      throw new Error(`Subagent file "${filePath}" field "mcpServers" must be an array`);
    if (
      !(data.mcpServers as unknown[]).every(
        (v): v is string | Record<string, unknown> =>
          typeof v === 'string' || (typeof v === 'object' && v !== null && !Array.isArray(v)),
      )
    )
      throw new Error(
        `Subagent file "${filePath}" field "mcpServers" must contain only strings or objects`,
      );
    def.mcpServers = data.mcpServers as Array<string | Record<string, unknown>>;
  }
  if (data.memory !== undefined) {
    const validMemory = ['user', 'project', 'local', 'none'];
    const mem = String(data.memory);
    if (!validMemory.includes(mem))
      throw new Error(
        `Subagent file "${filePath}" has invalid memory "${mem}". Must be one of: ${validMemory.join(', ')}`,
      );
    def.memory = mem as 'user' | 'project' | 'local' | 'none';
  }
  if (data.isolation !== undefined) {
    const validIsolation = ['none', 'worktree'];
    const iso = String(data.isolation);
    if (!validIsolation.includes(iso))
      throw new Error(
        `Subagent file "${filePath}" has invalid isolation "${iso}". Must be one of: ${validIsolation.join(', ')}`,
      );
    def.isolation = iso as 'none' | 'worktree';
  }
  if (data.color !== undefined) def.color = String(data.color);

  // Phase AR — Agent Runtime Hardening extensions
  if (data.effort !== undefined) {
    const validEffort = ['low', 'medium', 'high'];
    const effort = String(data.effort);
    if (!validEffort.includes(effort))
      throw new Error(
        `Subagent file "${filePath}" has invalid effort "${effort}". Must be one of: ${validEffort.join(', ')}`,
      );
    def.effort = effort as 'low' | 'medium' | 'high';
  }
  if (data.hooks !== undefined) {
    if (typeof data.hooks !== 'object' || data.hooks === null || Array.isArray(data.hooks)) {
      throw new Error(`Subagent file "${filePath}" field "hooks" must be an object`);
    }
    const hooksObj = data.hooks as Record<string, unknown>;
    const hooks: { before?: string; after?: string } = {};
    if (hooksObj.before !== undefined) {
      if (typeof hooksObj.before !== 'string')
        throw new Error(`Subagent file "${filePath}" field "hooks.before" must be a string`);
      hooks.before = hooksObj.before;
    }
    if (hooksObj.after !== undefined) {
      if (typeof hooksObj.after !== 'string')
        throw new Error(`Subagent file "${filePath}" field "hooks.after" must be a string`);
      hooks.after = hooksObj.after;
    }
    def.hooks = hooks;
  }
  if (data.initialPrompt !== undefined) {
    if (typeof data.initialPrompt !== 'string')
      throw new Error(`Subagent file "${filePath}" field "initialPrompt" must be a string`);
    def.initialPrompt = data.initialPrompt;
  }
  if (data.background !== undefined) {
    if (typeof data.background !== 'boolean')
      throw new Error(`Subagent file "${filePath}" field "background" must be a boolean`);
    def.background = data.background;
  }
  if (data.requiredMcpServers !== undefined) {
    if (!Array.isArray(data.requiredMcpServers))
      throw new Error(`Subagent file "${filePath}" field "requiredMcpServers" must be an array`);
    if (!(data.requiredMcpServers as unknown[]).every((v): v is string => typeof v === 'string'))
      throw new Error(
        `Subagent file "${filePath}" field "requiredMcpServers" must contain only strings`,
      );
    def.requiredMcpServers = data.requiredMcpServers as string[];
  }
  if (data.criticalSystemReminder !== undefined) {
    if (typeof data.criticalSystemReminder !== 'string')
      throw new Error(
        `Subagent file "${filePath}" field "criticalSystemReminder" must be a string`,
      );
    def.criticalSystemReminder = data.criticalSystemReminder;
  }
  if (data.remote !== undefined) {
    if (typeof data.remote !== 'boolean')
      throw new Error(`Subagent file "${filePath}" field "remote" must be a boolean`);
    def.remote = data.remote;
  }

  return def;
}

/**
 * Infer the source kind from the file path.
 *
 * Checks user-level first (more specific: exact HOME prefix) then project-level.
 */
function inferSource(filePath: string): SubagentDefinition['source'] {
  const normalized = filePath.replace(/\\/g, '/');

  // User-level: ~/.claude/agents/ (check first — more specific)
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (home) {
    const homeNormalized = home.replace(/\\/g, '/').replace(/\/+$/, '');
    if (normalized.startsWith(homeNormalized + '/.claude/agents/')) {
      return 'claude-user';
    }
  }

  // Project-level: any path containing /.claude/agents/
  if (normalized.includes('/.claude/agents/')) {
    return 'claude-project';
  }

  return 'runtime';
}

/**
 * Discover all subagent definitions from project and user agent directories.
 *
 * Scans:
 *   - <rootDir>/.claude/agents/*.md  (project-level, source: claude-project)
 *   - $HOME/.claude/agents/*.md      (user-level, source: claude-user)
 */
export function discoverSubagents(rootDir: string): SubagentDefinition[] {
  const results: SubagentDefinition[] = [];

  // Project-level agents
  const projectAgentsDir = join(rootDir, '.claude', 'agents');
  if (existsSync(projectAgentsDir)) {
    const files = readMdFiles(projectAgentsDir);
    for (const file of files) {
      const fullPath = join(projectAgentsDir, file);
      const content = readFileSync(fullPath, 'utf-8');
      results.push(parseSubagentMarkdown(content, fullPath));
    }
  }

  // User-level agents
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (home) {
    const userAgentsDir = join(home, '.claude', 'agents');
    if (existsSync(userAgentsDir)) {
      const files = readMdFiles(userAgentsDir);
      for (const file of files) {
        const fullPath = join(userAgentsDir, file);
        const content = readFileSync(fullPath, 'utf-8');
        results.push(parseSubagentMarkdown(content, fullPath));
      }
    }
  }

  return results;
}

/**
 * Resolve a single subagent by ID with priority: claude-project > claude-user.
 * Returns null if the agentId is not found.
 */
export function resolveSubagent(agentId: string, rootDir: string): SubagentDefinition | null {
  const all = discoverSubagents(rootDir);

  const projectMatch = all.find((d) => d.id === agentId && d.source === 'claude-project');
  if (projectMatch) return projectMatch;

  const userMatch = all.find((d) => d.id === agentId && d.source === 'claude-user');
  if (userMatch) return userMatch;

  return null;
}

/**
 * Read .md filenames from a directory (non-recursive).
 */
function readMdFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    return [];
  }
}
