import { describe, it, expect } from 'vitest';
import { parseIssueTaskManifest, renderIssueTaskManifest, extractTaskBlock } from '../manifest.js';

const validBlock = [
  '```openslack-task',
  'schema: openslack.github_issue_task.v1',
  'task_id: TASK-2026-000001',
  'title: Test valid manifest',
  'agent_type: codex',
  'risk_level: low',
  'required_capabilities:',
  '  - typescript',
  'allowed_paths:',
  '  - packages/**',
  'forbidden_paths:',
  '  - .github/**',
  'output_contract:',
  '  - draft_pr',
  '```',
].join('\n');

describe('parseIssueTaskManifest', () => {
  it('parses valid openslack-task block', () => {
    const result = parseIssueTaskManifest(validBlock);
    expect(result.valid).toBe(true);
    expect(result.manifest?.task_id).toBe('TASK-2026-000001');
    expect(result.manifest?.title).toBe('Test valid manifest');
    expect(result.manifest?.agent_type).toBe('codex');
    expect(result.manifest?.risk_level).toBe('low');
    expect(result.manifest?.required_capabilities).toEqual(['typescript']);
    expect(result.manifest?.allowed_paths).toEqual(['packages/**']);
    expect(result.manifest?.forbidden_paths).toEqual(['.github/**']);
  });

  it('rejects missing task_id', () => {
    const body =
      '```openslack-task\nschema: openslack.github_issue_task.v1\ntitle: No task_id\nagent_type: codex\nrisk_level: low\n```';
    const result = parseIssueTaskManifest(body);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('task_id'))).toBe(true);
  });

  it('rejects invalid risk_level', () => {
    const body =
      '```openslack-task\nschema: openslack.github_issue_task.v1\ntask_id: TASK-2026-000002\ntitle: Bad risk\nagent_type: codex\nrisk_level: extreme\n```';
    const result = parseIssueTaskManifest(body);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('risk_level'))).toBe(true);
  });

  it('rejects Red Zone allowed_paths without human_approval', () => {
    const body =
      '```openslack-task\nschema: openslack.github_issue_task.v1\ntask_id: TASK-2026-000003\ntitle: Red zone\nagent_type: codex\nrisk_level: low\nallowed_paths:\n  - .github/workflows/test.yml\n```';
    const result = parseIssueTaskManifest(body);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('Red Zone'))).toBe(true);
  });

  it('rejects conflicting allowed/forbidden paths', () => {
    const body =
      '```openslack-task\nschema: openslack.github_issue_task.v1\ntask_id: TASK-2026-000004\ntitle: Conflict\nagent_type: codex\nrisk_level: low\nallowed_paths:\n  - packages/core/**\nforbidden_paths:\n  - packages/core/**\n```';
    const result = parseIssueTaskManifest(body);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('conflict'))).toBe(true);
  });

  it('rejects missing openslack-task block', () => {
    const result = parseIssueTaskManifest('Just some text, no code block.');
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('No openslack-task block');
  });

  it('rejects invalid YAML', () => {
    const result = parseIssueTaskManifest('```openslack-task\nthis: [invalid yaml\n```');
    expect(result.valid).toBe(false);
  });
});

describe('renderIssueTaskManifest', () => {
  it('round-trips correctly', () => {
    const parseResult = parseIssueTaskManifest(validBlock);
    expect(parseResult.manifest).toBeDefined();
    const rendered = renderIssueTaskManifest(parseResult.manifest!);
    expect(rendered).toContain('```openslack-task');
    expect(rendered).toContain('schema: openslack.github_issue_task.v1');
    expect(rendered).toContain('task_id: TASK-2026-000001');
    expect(rendered).toContain('allowed_paths:');
    expect(rendered).toContain('forbidden_paths:');
  });
});

describe('extractTaskBlock', () => {
  it('extracts openslack-task block from body', () => {
    const body =
      'Some description.\n\n```openslack-task\nschema: openslack.github_issue_task.v1\ntask_id: TASK-2026-000005\ntitle: Extract test\nagent_type: codex\nrisk_level: low\n```\n\nMore text.';
    const block = extractTaskBlock(body);
    expect(block).toBeTruthy();
    expect(block).toContain('task_id: TASK-2026-000005');
  });

  it('returns null when no openslack-task block present', () => {
    expect(extractTaskBlock('No task here.')).toBeNull();
    expect(extractTaskBlock('```yaml\nnot a task\n```')).toBeNull();
  });
});
