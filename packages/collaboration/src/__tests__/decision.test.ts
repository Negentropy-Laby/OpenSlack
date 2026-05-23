import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  recordDecision,
  listDecisions,
  getDecision,
  supersedeDecision,
  renderDecisionList,
  renderDecision,
} from '../decision.js';

describe('decision', () => {
  let origCwd: string;
  let tmpDir: string;

  beforeEach(() => {
    origCwd = process.cwd();
    tmpDir = mkdtempSync(join(tmpdir(), 'openslack-decision-test-'));
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('records a decision', () => {
    const d = recordDecision({
      topic: 'Use TypeScript',
      decision: 'Migrate to TypeScript',
      rationale: 'Better type safety',
      decidedBy: 'claude',
      tags: ['typescript', 'migration'],
    });

    expect(d.schema).toBe('openslack.decision.v1');
    expect(d.id.startsWith('DEC-')).toBe(true);
    expect(d.status).toBe('active');
    expect(d.topic).toBe('Use TypeScript');
    expect(d.decision).toBe('Migrate to TypeScript');
    expect(d.rationale).toBe('Better type safety');
    expect(d.decidedBy).toBe('claude');
    expect(d.tags).toEqual(['typescript', 'migration']);
  });

  it('lists decisions', () => {
    recordDecision({ topic: 'A', decision: 'Do A', rationale: 'Because', decidedBy: 'x' });
    recordDecision({ topic: 'B', decision: 'Do B', rationale: 'Because', decidedBy: 'y' });

    const list = listDecisions();
    expect(list.length).toBe(2);
  });

  it('gets a decision by id', () => {
    const created = recordDecision({ topic: 'X', decision: 'Do X', rationale: 'Because', decidedBy: 'z' });
    const fetched = getDecision(created.id);

    expect(fetched).toBeDefined();
    expect(fetched!.id).toBe(created.id);
  });

  it('returns undefined for unknown decision', () => {
    expect(getDecision('DEC-NOTFOUND')).toBeUndefined();
  });

  it('supersedes an active decision', () => {
    const old = recordDecision({ topic: 'Old', decision: 'Do old', rationale: 'Because', decidedBy: 'a' });
    const updated = supersedeDecision(old.id, 'DEC-NEW');

    expect(updated).toBeDefined();
    expect(updated!.status).toBe('superseded');
    expect(updated!.supersededBy).toBe('DEC-NEW');
  });

  it('fails to supersede a non-active decision', () => {
    const d = recordDecision({ topic: 'Old', decision: 'Do old', rationale: 'Because', decidedBy: 'a' });
    supersedeDecision(d.id, 'DEC-NEW');

    const second = supersedeDecision(d.id, 'DEC-OTHER');
    expect(second).toBeUndefined();
  });

  it('renders decision list', () => {
    recordDecision({ topic: 'Use TypeScript', decision: 'Migrate', rationale: 'Types', decidedBy: 'claude' });
    const output = renderDecisionList(listDecisions());

    expect(output).toContain('Decisions');
    expect(output).toContain('Use TypeScript');
    expect(output).toContain('Migrate');
  });

  it('renders empty decision list', () => {
    const output = renderDecisionList([]);
    expect(output).toContain('No decisions found');
  });

  it('renders a single decision', () => {
    const d = recordDecision({
      topic: 'Architecture',
      decision: 'Use monorepo',
      rationale: 'Shared code',
      alternatives: ['Multi-repo', 'Submodules'],
      consequences: ['Complex tooling', 'Shared dependencies'],
      decidedBy: 'team',
      tags: ['architecture'],
    });

    const output = renderDecision(d);
    expect(output).toContain('DEC-');
    expect(output).toContain('Architecture');
    expect(output).toContain('Use monorepo');
    expect(output).toContain('Shared code');
    expect(output).toContain('Multi-repo');
    expect(output).toContain('Complex tooling');
    expect(output).toContain('architecture');
  });

  it('sorts list by createdAt descending', async () => {
    const d1 = recordDecision({ topic: 'First', decision: 'Do 1', rationale: 'Because', decidedBy: 'a' });
    await new Promise((r) => setTimeout(r, 50));
    const d2 = recordDecision({ topic: 'Second', decision: 'Do 2', rationale: 'Because', decidedBy: 'b' });

    const list = listDecisions();
    expect(list.map((d) => d.id)).toContain(d1.id);
    expect(list.map((d) => d.id)).toContain(d2.id);
    expect(list[0].createdAt >= list[1].createdAt).toBe(true);
  });
});
