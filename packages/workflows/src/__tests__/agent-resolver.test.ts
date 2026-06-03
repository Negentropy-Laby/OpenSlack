import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveAgentType, clearSubagentCache } from '../agent-resolver.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function makeTempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'agent-resolver-test-'));
}

function cleanup(root: string) {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

describe('resolveAgentType', () => {
  beforeEach(() => {
    clearSubagentCache();
  });

  it('returns null for unknown agentType', () => {
    const root = makeTempRoot();
    try {
      const result = resolveAgentType('nonexistent-agent', root);
      expect(result).toBeNull();
    } finally {
      cleanup(root);
    }
  });

  it('returns config for valid agentType in OpenSlack registry', () => {
    const root = makeTempRoot();
    try {
      const registryDir = join(root, '.openslack', 'agents', 'registry');
      mkdirSync(registryDir, { recursive: true });
      writeFileSync(
        join(registryDir, 'test-agent.yaml'),
        [
          'schema: openslack.agent_registry.v1',
          'agent_id: "test-agent"',
          'display_name: "Test Agent"',
          'employee_type: ai_agent',
          'vendor:',
          '  provider: "anthropic"',
          '  runtime: "claude_code"',
          '  model: "sonnet"',
        ].join('\n'),
      );

      const result = resolveAgentType('test-agent', root);
      expect(result).not.toBeNull();
      expect(result!.agentId).toBe('test-agent');
      expect(result!.source).toBe('openslack-registry');
      expect(result!.model).toBe('sonnet');
    } finally {
      cleanup(root);
    }
  });

  it('returns config for valid agentType in .claude/agents/ (project-level)', () => {
    const root = makeTempRoot();
    try {
      const agentsDir = join(root, '.claude', 'agents');
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(
        join(agentsDir, 'my-subagent.md'),
        [
          '---',
          'name: My Subagent',
          'description: A test subagent',
          'model: haiku',
          'tools:',
          '  - Read',
          '  - Grep',
          '---',
          'You are a helpful subagent.',
        ].join('\n'),
      );

      const result = resolveAgentType('my-subagent', root);
      expect(result).not.toBeNull();
      expect(result!.agentId).toBe('my-subagent');
      expect(result!.source).toBe('claude-project');
      expect(result!.model).toBe('haiku');
      expect(result!.tools).toEqual(['Read', 'Grep']);
      expect(result!.prompt).toBe('You are a helpful subagent.');
    } finally {
      cleanup(root);
    }
  });

  it('prefers OpenSlack registry over .claude/agents/', () => {
    const root = makeTempRoot();
    try {
      // Create both registry and .claude/agents entry with same ID
      const registryDir = join(root, '.openslack', 'agents', 'registry');
      mkdirSync(registryDir, { recursive: true });
      writeFileSync(
        join(registryDir, 'shared-agent.yaml'),
        [
          'schema: openslack.agent_registry.v1',
          'agent_id: "shared-agent"',
          'display_name: "Registry Agent"',
          'employee_type: ai_agent',
          'vendor:',
          '  provider: "anthropic"',
          '  model: "opus"',
        ].join('\n'),
      );

      const agentsDir = join(root, '.claude', 'agents');
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(
        join(agentsDir, 'shared-agent.md'),
        [
          '---',
          'name: Shared Agent Claude',
          'description: A claude subagent',
          '---',
          'Claude prompt body.',
        ].join('\n'),
      );

      const result = resolveAgentType('shared-agent', root);
      expect(result).not.toBeNull();
      expect(result!.source).toBe('openslack-registry');
      expect(result!.model).toBe('opus');
    } finally {
      cleanup(root);
    }
  });

  it('handles missing .openslack directory gracefully', () => {
    const root = makeTempRoot();
    try {
      // No .openslack or .claude directories
      const result = resolveAgentType('anything', root);
      expect(result).toBeNull();
    } finally {
      cleanup(root);
    }
  });

  it('handles missing .claude directory gracefully', () => {
    const root = makeTempRoot();
    try {
      const registryDir = join(root, '.openslack', 'agents', 'registry');
      mkdirSync(registryDir, { recursive: true });
      // No .claude/agents directory
      const result = resolveAgentType('missing', root);
      expect(result).toBeNull();
    } finally {
      cleanup(root);
    }
  });

  it('returns model as undefined when registry model is "default"', () => {
    const root = makeTempRoot();
    try {
      const registryDir = join(root, '.openslack', 'agents', 'registry');
      mkdirSync(registryDir, { recursive: true });
      writeFileSync(
        join(registryDir, 'default-model.yaml'),
        [
          'schema: openslack.agent_registry.v1',
          'agent_id: "default-model"',
          'display_name: "Default Model Agent"',
          'employee_type: ai_agent',
          'vendor:',
          '  provider: "anthropic"',
          '  model: "default"',
        ].join('\n'),
      );

      const result = resolveAgentType('default-model', root);
      expect(result).not.toBeNull();
      expect(result!.model).toBeUndefined();
    } finally {
      cleanup(root);
    }
  });

  it('maps subagent isolation field to config', () => {
    const root = makeTempRoot();
    try {
      const agentsDir = join(root, '.claude', 'agents');
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(
        join(agentsDir, 'isolated-agent.md'),
        [
          '---',
          'name: Isolated Agent',
          'description: An agent with isolation',
          'isolation: worktree',
          'permissionMode: strict',
          '---',
          'Do work in isolation.',
        ].join('\n'),
      );

      const result = resolveAgentType('isolated-agent', root);
      expect(result).not.toBeNull();
      expect(result!.isolation).toBe('worktree');
      expect(result!.permissionMode).toBe('strict');
    } finally {
      cleanup(root);
    }
  });

  it('maps Phase AR extension fields to config', () => {
    const root = makeTempRoot();
    try {
      const agentsDir = join(root, '.claude', 'agents');
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(
        join(agentsDir, 'ar-agent.md'),
        [
          '---',
          'name: AR Agent',
          'description: An agent with Phase AR fields',
          'model: sonnet',
          'maxTurns: 8',
          'effort: high',
          'mcpServers:',
          '  - github',
          '  - slack:',
          '      command: should-not-forward',
          '  - name: sentry',
          '    env:',
          '      SECRET_TOKEN: should-not-forward',
          'hooks:',
          '  before: scripts/before.sh',
          '  after: scripts/after.sh',
          'initialPrompt: Start here',
          'background: true',
          'requiredMcpServers:',
          '  - github',
          '  - slack',
          'criticalSystemReminder: Do not expose secrets',
          'remote: true',
          '---',
          'Phase AR prompt.',
        ].join('\n'),
      );

      const result = resolveAgentType('ar-agent', root);
      expect(result).not.toBeNull();
      expect(result!.agentId).toBe('ar-agent');
      expect(result!.model).toBe('sonnet');
      expect(result!.maxTurns).toBe(8);
      expect(result!.effort).toBe('high');
      expect(result!.mcpServers).toEqual(['github', 'slack', 'sentry']);
      expect(result!.hooks).toEqual({ before: 'scripts/before.sh', after: 'scripts/after.sh' });
      expect(result!.initialPrompt).toBe('Start here');
      expect(result!.background).toBe(true);
      expect(result!.requiredMcpServers).toEqual(['github', 'slack']);
      expect(result!.criticalSystemReminder).toBe('Do not expose secrets');
      expect(result!.remote).toBe(true);
    } finally {
      cleanup(root);
    }
  });

  // R10: Cache test

  it('caches subagent discovery results within TTL', () => {
    const root = makeTempRoot();
    try {
      const agentsDir = join(root, '.claude', 'agents');
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(
        join(agentsDir, 'cached-agent.md'),
        ['---', 'name: Cached Agent', 'description: A cached agent', '---', 'Cached prompt.'].join(
          '\n',
        ),
      );

      // First call — populates cache
      const result1 = resolveAgentType('cached-agent', root);
      expect(result1).not.toBeNull();
      expect(result1!.agentId).toBe('cached-agent');

      // Add a new agent file — if cache is hit, it won't be discovered
      writeFileSync(
        join(agentsDir, 'after-cache.md'),
        [
          '---',
          'name: After Cache',
          'description: Added after first resolution',
          '---',
          'Late prompt.',
        ].join('\n'),
      );

      // Second call within TTL — should still only have the first agent
      const result2 = resolveAgentType('after-cache', root);
      expect(result2).toBeNull(); // not found because cache was hit

      // First agent should still resolve from cache
      const result3 = resolveAgentType('cached-agent', root);
      expect(result3).not.toBeNull();
    } finally {
      cleanup(root);
    }
  });

  // rootDir cache-bust test

  it('maps bridgeMode from registry vendor runtime=aby_assistant', () => {
    const root = makeTempRoot();
    try {
      const registryDir = join(root, '.openslack', 'agents', 'registry');
      mkdirSync(registryDir, { recursive: true });
      writeFileSync(
        join(registryDir, 'aby-agent.yaml'),
        [
          'schema: openslack.agent_registry.v1',
          'agent_id: "aby-agent"',
          'display_name: "Aby Agent"',
          'employee_type: ai_agent',
          'vendor:',
          '  provider: "aby"',
          '  runtime: "aby_assistant"',
          '  model: "sonnet"',
        ].join('\n'),
      );

      const result = resolveAgentType('aby-agent', root);
      expect(result).not.toBeNull();
      expect(result!.agentId).toBe('aby-agent');
      expect(result!.source).toBe('openslack-registry');
      expect(result!.runtime).toBe('aby_assistant');
      expect(result!.provider).toBe('aby');
      expect(result!.bridgeMode).toBe('process');
    } finally {
      cleanup(root);
    }
  });

  it('returns undefined bridgeMode for non-aby registry agents', () => {
    const root = makeTempRoot();
    try {
      const registryDir = join(root, '.openslack', 'agents', 'registry');
      mkdirSync(registryDir, { recursive: true });
      writeFileSync(
        join(registryDir, 'local-agent.yaml'),
        [
          'schema: openslack.agent_registry.v1',
          'agent_id: "local-agent"',
          'display_name: "Local Agent"',
          'employee_type: ai_agent',
          'vendor:',
          '  provider: "anthropic"',
          '  runtime: "claude_code"',
          '  model: "sonnet"',
        ].join('\n'),
      );

      const result = resolveAgentType('local-agent', root);
      expect(result).not.toBeNull();
      expect(result!.bridgeMode).toBeUndefined();
    } finally {
      cleanup(root);
    }
  });

  it('bypasses cache when rootDir changes', () => {
    const rootA = makeTempRoot();
    const rootB = makeTempRoot();
    try {
      // Populate rootA with agent-a
      const dirA = join(rootA, '.claude', 'agents');
      mkdirSync(dirA, { recursive: true });
      writeFileSync(
        join(dirA, 'agent-a.md'),
        ['---', 'name: Agent A', 'description: Agent in root A', '---', 'Prompt A.'].join('\n'),
      );

      // Populate rootB with agent-b
      const dirB = join(rootB, '.claude', 'agents');
      mkdirSync(dirB, { recursive: true });
      writeFileSync(
        join(dirB, 'agent-b.md'),
        ['---', 'name: Agent B', 'description: Agent in root B', '---', 'Prompt B.'].join('\n'),
      );

      // Resolve from rootA — populates cache for rootA
      const resultA = resolveAgentType('agent-a', rootA);
      expect(resultA).not.toBeNull();
      expect(resultA!.agentId).toBe('agent-a');

      // Resolve from rootB — must bypass rootA's cache and discover agent-b
      const resultB = resolveAgentType('agent-b', rootB);
      expect(resultB).not.toBeNull();
      expect(resultB!.agentId).toBe('agent-b');

      // rootA's agent should NOT be found in rootB
      const notFound = resolveAgentType('agent-a', rootB);
      expect(notFound).toBeNull();
    } finally {
      cleanup(rootA);
      cleanup(rootB);
    }
  });
});
