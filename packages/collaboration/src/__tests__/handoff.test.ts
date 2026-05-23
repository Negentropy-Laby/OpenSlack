import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createHandoff,
  listHandoffs,
  getHandoff,
  acceptHandoff,
  closeHandoff,
  renderHandoffList,
  renderHandoff,
} from '../handoff.js';

describe('handoff', () => {
  let origCwd: string;
  let tmpDir: string;

  beforeEach(() => {
    origCwd = process.cwd();
    tmpDir = mkdtempSync(join(tmpdir(), 'openslack-handoff-test-'));
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a handoff', () => {
    const h = createHandoff({
      from: 'claude',
      to: 'codex',
      issueRef: '42',
      context: 'Implement feature X',
      nextSteps: ['Write tests', 'Update docs'],
    });

    expect(h.schema).toBe('openslack.handoff.v1');
    expect(h.id.startsWith('HANDOFF-')).toBe(true);
    expect(h.status).toBe('open');
    expect(h.from).toBe('claude');
    expect(h.to).toBe('codex');
    expect(h.issueRef).toBe('42');
    expect(h.context).toBe('Implement feature X');
    expect(h.nextSteps).toEqual(['Write tests', 'Update docs']);
  });

  it('lists handoffs', () => {
    createHandoff({ from: 'a', to: 'b', context: 'First' });
    createHandoff({ from: 'c', to: 'd', context: 'Second' });

    const list = listHandoffs();
    expect(list.length).toBe(2);
  });

  it('gets a handoff by id', () => {
    const created = createHandoff({ from: 'a', to: 'b', context: 'Test' });
    const fetched = getHandoff(created.id);

    expect(fetched).toBeDefined();
    expect(fetched!.id).toBe(created.id);
    expect(fetched!.context).toBe('Test');
  });

  it('returns undefined for unknown handoff', () => {
    expect(getHandoff('HANDOFF-NOTFOUND')).toBeUndefined();
  });

  it('accepts an open handoff', () => {
    const created = createHandoff({ from: 'a', to: 'b', context: 'Test' });
    const accepted = acceptHandoff(created.id);

    expect(accepted).toBeDefined();
    expect(accepted!.status).toBe('accepted');
    expect(accepted!.acceptedAt).toBeDefined();
  });

  it('fails to accept a non-open handoff', () => {
    const created = createHandoff({ from: 'a', to: 'b', context: 'Test' });
    acceptHandoff(created.id);

    const second = acceptHandoff(created.id);
    expect(second).toBeUndefined();
  });

  it('closes an open handoff', () => {
    const created = createHandoff({ from: 'a', to: 'b', context: 'Test' });
    const closed = closeHandoff(created.id);

    expect(closed).toBeDefined();
    expect(closed!.status).toBe('closed');
    expect(closed!.closedAt).toBeDefined();
  });

  it('closes an accepted handoff', () => {
    const created = createHandoff({ from: 'a', to: 'b', context: 'Test' });
    acceptHandoff(created.id);
    const closed = closeHandoff(created.id);

    expect(closed).toBeDefined();
    expect(closed!.status).toBe('closed');
  });

  it('fails to close an already closed handoff', () => {
    const created = createHandoff({ from: 'a', to: 'b', context: 'Test' });
    closeHandoff(created.id);

    const second = closeHandoff(created.id);
    expect(second).toBeUndefined();
  });

  it('renders handoff list', () => {
    createHandoff({ from: 'claude', to: 'codex', issueRef: '42', context: 'Fix bug' });
    const output = renderHandoffList(listHandoffs());

    expect(output).toContain('Handoffs');
    expect(output).toContain('claude → codex');
    expect(output).toContain('issue:42');
    expect(output).toContain('Fix bug');
  });

  it('renders empty handoff list', () => {
    const output = renderHandoffList([]);
    expect(output).toContain('No handoffs found');
  });

  it('renders a single handoff', () => {
    const h = createHandoff({
      from: 'claude',
      to: 'codex',
      issueRef: '42',
      context: 'Implement feature',
      nextSteps: ['Step 1', 'Step 2'],
      notes: 'Some notes',
    });

    const output = renderHandoff(h);
    expect(output).toContain('HANDOFF-');
    expect(output).toContain('claude');
    expect(output).toContain('codex');
    expect(output).toContain('Implement feature');
    expect(output).toContain('Step 1');
    expect(output).toContain('Some notes');
  });

  it('sorts list by createdAt descending', () => {
    const h1 = createHandoff({ from: 'a', to: 'b', context: 'First' });
    // Small delay to ensure different timestamps
    const h2 = createHandoff({ from: 'c', to: 'd', context: 'Second' });

    const list = listHandoffs();
    expect(list[0].id).toBe(h2.id);
    expect(list[1].id).toBe(h1.id);
  });
});
