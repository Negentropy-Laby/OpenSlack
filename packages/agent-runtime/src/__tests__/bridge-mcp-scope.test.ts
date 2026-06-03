import { describe, it, expect } from 'vitest';
import {
  negotiateMcpServers,
  validateRequiredMcpServers,
  extractMcpToolsFromProfile,
  validateMcpToolNamespace,
  buildMcpServerDescriptors,
} from '../bridge-mcp-scope.js';
import { AgentUnavailableError } from '../types.js';

describe('negotiateMcpServers', () => {
  it('returns empty when no requested servers', () => {
    const result = negotiateMcpServers([], ['server1']);
    expect(result.available).toEqual([]);
    expect(result.missing).toEqual([]);
    expect(result.namespacedTools).toEqual([]);
  });

  it('returns available servers that match', () => {
    const result = negotiateMcpServers(
      [{ name: 'server1' }, { name: 'server2' }],
      ['server1'],
    );
    expect(result.available).toHaveLength(1);
    expect(result.available[0].name).toBe('server1');
    expect(result.missing).toHaveLength(1);
    expect(result.missing[0].name).toBe('server2');
  });

  it('generates namespaced tools for available servers', () => {
    const result = negotiateMcpServers(
      [{ name: 'filesystem', tools: ['read', 'write'] }],
      ['filesystem'],
    );
    expect(result.namespacedTools).toContain('mcp.filesystem.read');
    expect(result.namespacedTools).toContain('mcp.filesystem.write');
  });

  it('returns all missing when no available servers', () => {
    const result = negotiateMcpServers(
      [{ name: 'server1' }, { name: 'server2' }],
      [],
    );
    expect(result.available).toHaveLength(0);
    expect(result.missing).toHaveLength(2);
  });

  it('handles mixed available and missing', () => {
    const result = negotiateMcpServers(
      [
        { name: 'git', tools: ['status'] },
        { name: 'github', tools: ['pr'] },
        { name: 'missing', tools: ['tool'] },
      ],
      ['git', 'github'],
    );
    expect(result.available).toHaveLength(2);
    expect(result.missing).toHaveLength(1);
    expect(result.namespacedTools).toContain('mcp.git.status');
    expect(result.namespacedTools).toContain('mcp.github.pr');
  });
});

describe('validateRequiredMcpServers', () => {
  it('does not throw when all required servers available', () => {
    expect(() =>
      validateRequiredMcpServers(
        [{ name: 'server1' }, { name: 'server2' }],
        ['server1', 'server2'],
      ),
    ).not.toThrow();
  });

  it('throws AgentUnavailableError when required server missing', () => {
    expect(() =>
      validateRequiredMcpServers(
        [{ name: 'server1', required: true }],
        [],
      ),
    ).toThrow(AgentUnavailableError);
  });

  it('throws with missing server names', () => {
    try {
      validateRequiredMcpServers(
        [{ name: 'git' }, { name: 'github' }],
        ['git'],
      );
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AgentUnavailableError);
      expect((err as AgentUnavailableError).missingMcpServers).toContain('github');
    }
  });

  it('does not throw for optional missing servers', () => {
    expect(() =>
      validateRequiredMcpServers(
        [{ name: 'server1', required: false }],
        [],
      ),
    ).not.toThrow();
  });
});

describe('extractMcpToolsFromProfile', () => {
  it('separates MCP and non-MCP tools', () => {
    const result = extractMcpToolsFromProfile([
      'Read',
      'mcp.filesystem.read',
      'Edit',
      'mcp.git.status',
    ]);
    expect(result.mcpTools).toContain('mcp.filesystem.read');
    expect(result.mcpTools).toContain('mcp.git.status');
    expect(result.nonMcpTools).toContain('Read');
    expect(result.nonMcpTools).toContain('Edit');
  });

  it('returns empty when no MCP tools', () => {
    const result = extractMcpToolsFromProfile(['Read', 'Edit', 'Bash']);
    expect(result.mcpTools).toEqual([]);
    expect(result.nonMcpTools).toHaveLength(3);
  });

  it('returns empty when all MCP tools', () => {
    const result = extractMcpToolsFromProfile(['mcp.a.tool', 'mcp.b.tool']);
    expect(result.mcpTools).toHaveLength(2);
    expect(result.nonMcpTools).toEqual([]);
  });
});

describe('validateMcpToolNamespace', () => {
  it('validates tools with available servers', () => {
    const result = validateMcpToolNamespace(
      ['mcp.filesystem.read', 'mcp.git.status'],
      ['filesystem', 'git'],
    );
    expect(result.valid).toHaveLength(2);
    expect(result.invalid).toHaveLength(0);
  });

  it('flags tools with unavailable servers', () => {
    const result = validateMcpToolNamespace(
      ['mcp.filesystem.read', 'mcp.missing.tool'],
      ['filesystem'],
    );
    expect(result.valid).toHaveLength(1);
    expect(result.invalid).toHaveLength(1);
    expect(result.invalid[0].tool).toBe('mcp.missing.tool');
    expect(result.invalid[0].reason).toContain('missing');
  });

  it('flags malformed tool names', () => {
    const result = validateMcpToolNamespace(
      ['mcp.invalid', 'mcp.server.tool'],
      ['server'],
    );
    expect(result.valid).toHaveLength(1);
    expect(result.invalid).toHaveLength(1);
    expect(result.invalid[0].tool).toBe('mcp.invalid');
  });

  it('handles empty input', () => {
    const result = validateMcpToolNamespace([], ['server']);
    expect(result.valid).toEqual([]);
    expect(result.invalid).toEqual([]);
  });
});

describe('buildMcpServerDescriptors', () => {
  it('builds descriptors from names', () => {
    const result = buildMcpServerDescriptors(['git', 'github']);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('git');
    expect(result[0].required).toBe(true);
  });

  it('applies options', () => {
    const result = buildMcpServerDescriptors(['git'], {
      required: false,
      version: '1.0',
    });
    expect(result[0].required).toBe(false);
    expect(result[0].version).toBe('1.0');
  });
});
