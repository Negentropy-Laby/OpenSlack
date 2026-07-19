import { describe, it, expect } from 'vitest';
import { mapSubagentToViewModel } from '../view-models/agent-detail.js';
import type { SubagentDefinition } from '@openslack/kernel';

function makeAgent(overrides?: Partial<SubagentDefinition>): SubagentDefinition {
  return {
    id: 'agent-1',
    source: 'openslack',
    name: 'TestAgent',
    description: 'A test agent',
    prompt: 'You are a helpful assistant.',
    tools: ['read_file', 'write_file'],
    disallowedTools: ['delete_file'],
    model: 'claude-sonnet-4-20250514',
    memory: 'project',
    isolation: 'worktree',
    maxTurns: 10,
    ...overrides,
  };
}

describe('mapSubagentToViewModel', () => {
  it('maps definition correctly', () => {
    const agent = makeAgent();
    const model = mapSubagentToViewModel(agent);

    expect(model.name).toBe('TestAgent');
    expect(model.source).toBe('openslack');
    expect(model.description).toBe('A test agent');
    expect(model.model).toBe('claude-sonnet-4-20250514');
    expect(model.tools).toEqual(['read_file', 'write_file']);
    expect(model.deniedTools).toEqual(['delete_file']);
    expect(model.memory).toBe('project');
    expect(model.isolation).toBe('worktree');
    expect(model.canSpawn).toBe(false);
    expect(model.maxTurns).toBe(10);
  });

  it('handles missing optional fields', () => {
    const agent = makeAgent({
      tools: undefined,
      disallowedTools: undefined,
      model: undefined,
      memory: undefined,
      isolation: undefined,
      maxTurns: undefined,
    });
    const model = mapSubagentToViewModel(agent);

    expect(model.tools).toEqual([]);
    expect(model.deniedTools).toEqual([]);
    expect(model.model).toBeUndefined();
    expect(model.memory).toBe('none');
    expect(model.isolation).toBe('none');
    expect(model.canSpawn).toBe(false);
    expect(model.maxTurns).toBeUndefined();
  });

  it('detects canSpawn from tools list', () => {
    const agent = makeAgent({ tools: ['read_file', 'spawn_subagent'] });
    const model = mapSubagentToViewModel(agent);

    expect(model.canSpawn).toBe(true);
  });

  it('detects canSpawn from Task tool', () => {
    const agent = makeAgent({ tools: ['Task'] });
    const model = mapSubagentToViewModel(agent);

    expect(model.canSpawn).toBe(true);
  });

  it('sanitizes escape sequences', () => {
    const agent = makeAgent({ name: 'Bad\x1b[31m inject' });
    const model = mapSubagentToViewModel(agent);

    expect(model.name).toBe('Bad inject');
  });
});
