import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSubagentMarkdown, discoverSubagents, resolveSubagent } from '../subagent-parser.js';

let fixtureRoot: string;

function agentsDir(base: string): string {
  return join(base, '.claude', 'agents');
}

function writeAgent(base: string, filename: string, content: string): void {
  const dir = agentsDir(base);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), content, 'utf-8');
}

beforeEach(() => {
  fixtureRoot = join(
    tmpdir(),
    `openslack-subagent-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(fixtureRoot, { recursive: true });
});

afterEach(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('parseSubagentMarkdown', () => {
  it('parses valid frontmatter with all fields', () => {
    const content = `---
name: Full Agent
description: A fully-specified agent
model: opus
tools:
  - Read
  - Write
  - Bash
disallowedTools:
  - Edit
permissionMode: strict
maxTurns: 10
skills:
  - code-review
mcpServers:
  - name: test
memory: project
isolation: worktree
color: blue
effort: high
hooks:
  before: scripts/before.sh
  after: scripts/after.sh
initialPrompt: Start here
background: true
requiredMcpServers:
  - github
  - slack
criticalSystemReminder: Do not expose secrets
remote: true
---
You are a fully specified agent.`;

    const result = parseSubagentMarkdown(content, '/fake/full-agent.md');
    expect(result.id).toBe('full-agent');
    expect(result.name).toBe('Full Agent');
    expect(result.description).toBe('A fully-specified agent');
    expect(result.prompt).toBe('You are a fully specified agent.');
    expect(result.model).toBe('opus');
    expect(result.tools).toEqual(['Read', 'Write', 'Bash']);
    expect(result.disallowedTools).toEqual(['Edit']);
    expect(result.permissionMode).toBe('strict');
    expect(result.maxTurns).toBe(10);
    expect(result.skills).toEqual(['code-review']);
    expect(result.mcpServers).toEqual([{ name: 'test' }]);
    expect(result.memory).toBe('project');
    expect(result.isolation).toBe('worktree');
    expect(result.color).toBe('blue');
    expect(result.rawPath).toBe('/fake/full-agent.md');
    // Phase AR extensions
    expect(result.effort).toBe('high');
    expect(result.hooks).toEqual({ before: 'scripts/before.sh', after: 'scripts/after.sh' });
    expect(result.initialPrompt).toBe('Start here');
    expect(result.background).toBe(true);
    expect(result.requiredMcpServers).toEqual(['github', 'slack']);
    expect(result.criticalSystemReminder).toBe('Do not expose secrets');
    expect(result.remote).toBe(true);
  });

  it('accepts Aby-style mcpServers string references', () => {
    const content = `---
name: MCP Agent
description: Uses named MCP servers
mcpServers:
  - github
  - slack
---
Use MCP tools.`;

    const result = parseSubagentMarkdown(content, '/fake/mcp-agent.md');
    expect(result.mcpServers).toEqual(['github', 'slack']);
  });

  it('parses valid frontmatter with only required fields', () => {
    const content = `---
name: Minimal Agent
description: Minimal description
---
Do the thing.`;

    const result = parseSubagentMarkdown(content, '/fake/minimal-agent.md');
    expect(result.id).toBe('minimal-agent');
    expect(result.name).toBe('Minimal Agent');
    expect(result.description).toBe('Minimal description');
    expect(result.prompt).toBe('Do the thing.');
    expect(result.tools).toBeUndefined();
    expect(result.model).toBeUndefined();
    expect(result.maxTurns).toBeUndefined();
    expect(result.memory).toBeUndefined();
  });

  it('fails on missing name', () => {
    const content = `---
description: Has description but no name
---
Do the thing.`;

    expect(() => parseSubagentMarkdown(content, '/fake/no-name.md')).toThrow(
      /missing required "name" field/,
    );
  });

  it('fails on missing description', () => {
    const content = `---
name: Has Name
---
Do the thing.`;

    expect(() => parseSubagentMarkdown(content, '/fake/no-desc.md')).toThrow(
      /missing required "description" field/,
    );
  });

  it('fails on unparseable YAML', () => {
    const content = `---
name: [
description: broken yaml
---
Do the thing.`;

    expect(() => parseSubagentMarkdown(content, '/fake/bad-yaml.md')).toThrow(
      /unparseable YAML frontmatter/,
    );
  });

  it('fails when no frontmatter delimiter is present', () => {
    const content = `This is just plain text with no frontmatter at all.`;

    expect(() => parseSubagentMarkdown(content, '/fake/no-frontmatter.md')).toThrow(
      /no YAML frontmatter delimiter/,
    );
  });

  it('fails when frontmatter is unclosed', () => {
    const content = `---
name: Agent
description: No closing delimiter`;

    expect(() => parseSubagentMarkdown(content, '/fake/unclosed.md')).toThrow(
      /unclosed YAML frontmatter/,
    );
  });

  // --- M5: permissionMode validation tests ---

  it('rejects bypassPermissions permissionMode', () => {
    const content = `---
name: Dangerous Agent
description: Tries to bypass permissions
permissionMode: bypassPermissions
---
Dangerous.`;

    expect(() => parseSubagentMarkdown(content, '/fake/dangerous.md')).toThrow(
      /invalid permissionMode "bypassPermissions"/,
    );
  });

  it('rejects unknown permissionMode value', () => {
    const content = `---
name: Super Agent
description: Has super powers
permissionMode: superadmin
---
Super.`;

    expect(() => parseSubagentMarkdown(content, '/fake/super.md')).toThrow(
      /invalid permissionMode "superadmin"/,
    );
  });

  it('accepts valid permissionMode: plan', () => {
    const content = `---
name: Planner
description: Plan only
permissionMode: plan
---
Plan.`;

    const result = parseSubagentMarkdown(content, '/fake/planner.md');
    expect(result.permissionMode).toBe('plan');
  });

  it('accepts valid permissionMode: acceptEdits', () => {
    const content = `---
name: Editor
description: Can edit
permissionMode: acceptEdits
---
Edit.`;

    const result = parseSubagentMarkdown(content, '/fake/editor.md');
    expect(result.permissionMode).toBe('acceptEdits');
  });

  it('accepts valid permissionMode: default', () => {
    const content = `---
name: Default
description: Default mode
permissionMode: default
---
Default.`;

    const result = parseSubagentMarkdown(content, '/fake/default-agent.md');
    expect(result.permissionMode).toBe('default');
  });

  // --- R3: Runtime type validation tests ---

  it('rejects non-array tools field', () => {
    const content = `---
name: Bad Tools
description: Tools is not an array
tools: "not-an-array"
---
Bad.`;

    expect(() => parseSubagentMarkdown(content, '/fake/bad-tools.md')).toThrow(
      /field "tools" must be an array/,
    );
  });

  it('rejects non-number maxTurns field', () => {
    const content = `---
name: Bad Turns
description: MaxTurns is not a number
maxTurns: abc
---
Bad.`;

    expect(() => parseSubagentMarkdown(content, '/fake/bad-turns.md')).toThrow(
      /field "maxTurns" must be a number/,
    );
  });

  it('rejects invalid memory value', () => {
    const content = `---
name: Bad Memory
description: Invalid memory value
memory: invalid
---
Bad.`;

    expect(() => parseSubagentMarkdown(content, '/fake/bad-memory.md')).toThrow(
      /invalid memory "invalid"/,
    );
  });

  it('rejects invalid isolation value', () => {
    const content = `---
name: Bad Isolation
description: Invalid isolation value
isolation: docker
---
Bad.`;

    expect(() => parseSubagentMarkdown(content, '/fake/bad-isolation.md')).toThrow(
      /invalid isolation "docker"/,
    );
  });

  // L3: Array item type validation

  it('rejects tools array with non-string items', () => {
    const content = `---
name: Bad Tools Items
description: Tools contains a number
tools:
  - Read
  - 42
---
Bad.`;

    expect(() => parseSubagentMarkdown(content, '/fake/bad-tools-items.md')).toThrow(
      /must contain only strings/,
    );
  });

  it('rejects skills array with non-string items', () => {
    const content = `---
name: Bad Skills
description: Skills contains null
skills:
  - code-review
  - null
---
Bad.`;

    expect(() => parseSubagentMarkdown(content, '/fake/bad-skills-items.md')).toThrow(
      /must contain only strings/,
    );
  });

  // Phase AR — Agent Runtime Hardening extension validation tests

  it('rejects invalid effort value', () => {
    const content = `---
name: Bad Effort
description: Invalid effort value
effort: extreme
---
Bad.`;

    expect(() => parseSubagentMarkdown(content, '/fake/bad-effort.md')).toThrow(
      /invalid effort "extreme"/,
    );
  });

  it('rejects non-object hooks field', () => {
    const content = `---
name: Bad Hooks
description: Hooks is not an object
hooks: "before.sh"
---
Bad.`;

    expect(() => parseSubagentMarkdown(content, '/fake/bad-hooks.md')).toThrow(
      /field "hooks" must be an object/,
    );
  });

  it('rejects non-string hooks.before field', () => {
    const content = `---
name: Bad Hook Before
description: hooks.before is not a string
hooks:
  before: 42
---
Bad.`;

    expect(() => parseSubagentMarkdown(content, '/fake/bad-hook-before.md')).toThrow(
      /field "hooks.before" must be a string/,
    );
  });

  it('rejects non-boolean background field', () => {
    const content = `---
name: Bad Background
description: background is not a boolean
background: "yes"
---
Bad.`;

    expect(() => parseSubagentMarkdown(content, '/fake/bad-background.md')).toThrow(
      /field "background" must be a boolean/,
    );
  });

  it('rejects non-array requiredMcpServers field', () => {
    const content = `---
name: Bad MCP
description: requiredMcpServers is not an array
requiredMcpServers: "github"
---
Bad.`;

    expect(() => parseSubagentMarkdown(content, '/fake/bad-mcp.md')).toThrow(
      /field "requiredMcpServers" must be an array/,
    );
  });

  it('rejects requiredMcpServers array with non-string items', () => {
    const content = `---
name: Bad MCP Items
description: requiredMcpServers contains a number
requiredMcpServers:
  - github
  - 42
---
Bad.`;

    expect(() => parseSubagentMarkdown(content, '/fake/bad-mcp-items.md')).toThrow(
      /field "requiredMcpServers" must contain only strings/,
    );
  });

  it('rejects non-boolean remote field', () => {
    const content = `---
name: Bad Remote
description: remote is not a boolean
remote: "yes"
---
Bad.`;

    expect(() => parseSubagentMarkdown(content, '/fake/bad-remote.md')).toThrow(
      /field "remote" must be a boolean/,
    );
  });

  it('parses minimal Phase AR fields correctly', () => {
    const content = `---
name: Minimal AR
description: Minimal AR agent
effort: low
background: false
remote: false
---
Do the thing.`;

    const result = parseSubagentMarkdown(content, '/fake/minimal-ar.md');
    expect(result.effort).toBe('low');
    expect(result.background).toBe(false);
    expect(result.remote).toBe(false);
    expect(result.hooks).toBeUndefined();
    expect(result.initialPrompt).toBeUndefined();
    expect(result.requiredMcpServers).toBeUndefined();
    expect(result.criticalSystemReminder).toBeUndefined();
  });
});

describe('discoverSubagents', () => {
  it('discovers agents from project directory', () => {
    writeAgent(
      fixtureRoot,
      'reviewer.md',
      `---
name: Reviewer
description: Reviews code
---
Review carefully.`,
    );

    writeAgent(
      fixtureRoot,
      'builder.md',
      `---
name: Builder
description: Builds things
---
Build well.`,
    );

    const results = discoverSubagents(fixtureRoot);
    expect(results.length).toBeGreaterThanOrEqual(2);

    const names = results.map((r) => r.name);
    expect(names).toContain('Reviewer');
    expect(names).toContain('Builder');

    // Project agents should have claude-project source
    const reviewer = results.find((r) => r.id === 'reviewer');
    expect(reviewer?.source).toBe('claude-project');
  });

  it('discovers agents from user directory when HOME is set', () => {
    const fakeHome = join(fixtureRoot, 'home');
    mkdirSync(join(fakeHome, '.claude', 'agents'), { recursive: true });
    writeFileSync(
      join(fakeHome, '.claude', 'agents', 'user-agent.md'),
      `---
name: User Agent
description: A user-level agent
---
User-level work.`,
      'utf-8',
    );

    const originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      const results = discoverSubagents(fixtureRoot);
      const user = results.find((r) => r.id === 'user-agent');
      expect(user).toBeDefined();
      expect(user!.source).toBe('claude-user');
      expect(user!.name).toBe('User Agent');
    } finally {
      process.env.HOME = originalHome;
    }
  });

  it('returns empty array when no agent directories exist', () => {
    const results = discoverSubagents(fixtureRoot);
    // May still pick up user-level agents, so filter to project-only
    const projectResults = results.filter((r) => r.source === 'claude-project');
    expect(projectResults).toEqual([]);
  });
});

describe('resolveSubagent', () => {
  it('resolves with project-over-user priority', () => {
    // Write project-level agent
    writeAgent(
      fixtureRoot,
      'shared.md',
      `---
name: Shared Project
description: Project version
---
Project prompt.`,
    );

    // Write user-level agent with same id
    const fakeHome = join(fixtureRoot, 'home');
    mkdirSync(join(fakeHome, '.claude', 'agents'), { recursive: true });
    writeFileSync(
      join(fakeHome, '.claude', 'agents', 'shared.md'),
      `---
name: Shared User
description: User version
---
User prompt.`,
      'utf-8',
    );

    const originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      const result = resolveSubagent('shared', fixtureRoot);
      expect(result).not.toBeNull();
      expect(result!.source).toBe('claude-project');
      expect(result!.name).toBe('Shared Project');
    } finally {
      process.env.HOME = originalHome;
    }
  });

  it('returns null for unknown agentId', () => {
    const result = resolveSubagent('nonexistent_agent_xyz', fixtureRoot);
    expect(result).toBeNull();
  });
});

// --- R4: HOME trailing slash test ---

describe('inferSource', () => {
  it('classifies user-level agent correctly when HOME has trailing slash', () => {
    // Set HOME with trailing slash and create a user-level agent
    const fakeHome = join(fixtureRoot, 'home-trailing');
    mkdirSync(join(fakeHome, '.claude', 'agents'), { recursive: true });
    writeFileSync(
      join(fakeHome, '.claude', 'agents', 'trailing-home.md'),
      `---
name: Trailing Home Agent
description: Agent when HOME has trailing slash
---
User-level work.`,
      'utf-8',
    );

    const originalHome = process.env.HOME;
    // Set HOME with trailing slash(es)
    process.env.HOME = fakeHome + '/';
    try {
      const results = discoverSubagents(fixtureRoot);
      const user = results.find((r) => r.id === 'trailing-home');
      expect(user).toBeDefined();
      expect(user!.source).toBe('claude-user');
    } finally {
      process.env.HOME = originalHome;
    }
  });
});
