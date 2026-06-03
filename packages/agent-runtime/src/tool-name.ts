const CANONICAL_TOOL_NAMES: Record<string, string> = {
  bash: 'Bash',
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  grep: 'Grep',
  glob: 'Glob',
  find: 'Find',
};

export function normalizeToolName(toolName: string): string {
  const trimmed = toolName.trim();
  if (!trimmed) return trimmed;

  const lower = trimmed.toLowerCase();
  const canonical = CANONICAL_TOOL_NAMES[lower];
  if (canonical) return canonical;

  const mcpMatch = /^mcp__([^_]+)__(.+)$/i.exec(trimmed);
  if (mcpMatch) {
    return `mcp.${mcpMatch[1]}.${mcpMatch[2]}`;
  }

  if (/^(github|ruleset|secrets|workflow|agent)__/.test(lower)) {
    return lower.replace(/__/g, '.');
  }

  return trimmed;
}

export function normalizeToolNames(toolNames: string[]): string[] {
  return [...new Set(toolNames.map(normalizeToolName))];
}
