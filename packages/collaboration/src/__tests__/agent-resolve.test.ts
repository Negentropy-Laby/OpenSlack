import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveAgentDisplayName, clearNameCache } from '../agent-resolve.js';

const TMP_ROOT = join(process.cwd(), '.test-agent-resolve');

beforeEach(() => {
  clearNameCache();
  if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true });
});

afterEach(() => {
  clearNameCache();
  if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true });
});

describe('resolveAgentDisplayName', () => {
  it('returns actor.id for human actors', () => {
    expect(resolveAgentDisplayName({ id: 'wsman', kind: 'human' })).toBe('wsman');
  });

  it('returns System for system actors', () => {
    expect(resolveAgentDisplayName({ id: 'workflow', kind: 'system' })).toBe('System');
  });

  it('returns actor.id when no registry exists', () => {
    expect(resolveAgentDisplayName({ id: 'unknown_agent', kind: 'agent' }, TMP_ROOT)).toBe('unknown_agent');
  });

  it('resolves display_name from registry YAML', () => {
    const dir = join(TMP_ROOT, '.openslack', 'agents', 'registry');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'test_agent.yaml'), [
      'agent_id: test_agent',
      'display_name: Test Agent Bot',
    ].join('\n'), 'utf-8');

    clearNameCache();
    const result = resolveAgentDisplayName({ id: 'test_agent', kind: 'agent' }, TMP_ROOT);
    expect(result).toBe('Test Agent Bot');
  });

  it('caches results across calls', () => {
    const dir = join(TMP_ROOT, '.openslack', 'agents', 'registry');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'cached.yaml'), [
      'agent_id: cached',
      'display_name: Cached Agent',
    ].join('\n'), 'utf-8');

    clearNameCache();
    const first = resolveAgentDisplayName({ id: 'cached', kind: 'agent' }, TMP_ROOT);
    // Delete the file — cache should still resolve
    rmSync(join(dir, 'cached.yaml'));
    const second = resolveAgentDisplayName({ id: 'cached', kind: 'agent' }, TMP_ROOT);
    expect(first).toBe('Cached Agent');
    expect(second).toBe('Cached Agent');
  });

  it('handles chat and github actor kinds with id fallback', () => {
    expect(resolveAgentDisplayName({ id: 'U12345', kind: 'chat' })).toBe('U12345');
    expect(resolveAgentDisplayName({ id: 'github_app', kind: 'github' })).toBe('github_app');
  });
});
