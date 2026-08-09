import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseIssueTaskManifest, renderIssueTaskManifest, extractTaskBlock } from '../manifest.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

const validBlock = [
  '```openslack-task',
  'schema: openslack.github_issue_task.v1',
  'task_id: TASK-2026-000001',
  'title: Test valid manifest',
  'status: ready',
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
    expect(result.manifest?.status).toBe('ready');
    expect(result.manifest?.agent_type).toBe('codex');
    expect(result.manifest?.risk_level).toBe('low');
    expect(result.manifest?.required_capabilities).toEqual(['typescript']);
    expect(result.manifest?.allowed_paths).toEqual(['packages/**']);
    expect(result.manifest?.forbidden_paths).toEqual(['.github/**']);
  });

  it('rejects missing task_id', () => {
    const body =
      '```openslack-task\nschema: openslack.github_issue_task.v1\ntitle: No task_id\nstatus: ready\nagent_type: codex\nrisk_level: low\n```';
    const result = parseIssueTaskManifest(body);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('task_id'))).toBe(true);
  });

  it('rejects invalid risk_level', () => {
    const body =
      '```openslack-task\nschema: openslack.github_issue_task.v1\ntask_id: TASK-2026-000002\ntitle: Bad risk\nstatus: ready\nagent_type: codex\nrisk_level: extreme\n```';
    const result = parseIssueTaskManifest(body);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('risk_level'))).toBe(true);
  });

  it('rejects Red Zone allowed_paths without human_approval', () => {
    const body =
      '```openslack-task\nschema: openslack.github_issue_task.v1\ntask_id: TASK-2026-000003\ntitle: Red zone\nstatus: ready\nagent_type: codex\nrisk_level: low\nallowed_paths:\n  - .github/workflows/test.yml\n```';
    const result = parseIssueTaskManifest(body);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('Red Zone'))).toBe(true);
  });

  it('rejects conflicting allowed/forbidden paths', () => {
    const body =
      '```openslack-task\nschema: openslack.github_issue_task.v1\ntask_id: TASK-2026-000004\ntitle: Conflict\nstatus: ready\nagent_type: codex\nrisk_level: low\nallowed_paths:\n  - packages/core/**\nforbidden_paths:\n  - packages/core/**\n```';
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

  it('requires one supported status', () => {
    const missing = validBlock.replace('status: ready\n', '');
    expect(parseIssueTaskManifest(missing)).toMatchObject({ valid: false });
    const invalid = validBlock.replace('status: ready', 'status: queued');
    const result = parseIssueTaskManifest(invalid);
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes('status must be one of'))).toBe(true);
  });

  it.each([
    ['ttl zero', 'ttl_minutes: 0\n  heartbeat_minutes: 15', 'ttl_minutes'],
    ['ttl negative', 'ttl_minutes: -1\n  heartbeat_minutes: 15', 'ttl_minutes'],
    ['ttl fractional', 'ttl_minutes: 1.5\n  heartbeat_minutes: 15', 'ttl_minutes'],
    ['ttl too large', 'ttl_minutes: 481\n  heartbeat_minutes: 15', 'ttl_minutes'],
    ['heartbeat zero', 'ttl_minutes: 60\n  heartbeat_minutes: 0', 'heartbeat_minutes'],
    ['heartbeat fractional', 'ttl_minutes: 60\n  heartbeat_minutes: 1.5', 'heartbeat_minutes'],
    ['heartbeat too large', 'ttl_minutes: 60\n  heartbeat_minutes: 121', 'heartbeat_minutes'],
    ['missing ttl', 'heartbeat_minutes: 15', 'ttl_minutes'],
    ['missing heartbeat', 'ttl_minutes: 60', 'heartbeat_minutes'],
  ])('rejects invalid lease bounds: %s', (_name, lease, expected) => {
    const result = parseIssueTaskManifest(`${validBlock.slice(0, -3)}lease:\n  ${lease}\n\`\`\``);
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes(expected))).toBe(true);
  });

  it.each([
    [1, 1],
    [480, 120],
  ])('accepts inclusive lease bounds ttl=%s heartbeat=%s', (ttl, heartbeat) => {
    const result = parseIssueTaskManifest(
      `${validBlock.slice(0, -3)}lease:\n  ttl_minutes: ${ttl}\n  heartbeat_minutes: ${heartbeat}\n\`\`\``,
    );
    expect(result.valid).toBe(true);
    expect(result.manifest?.lease).toEqual({
      ttl_minutes: ttl,
      heartbeat_minutes: heartbeat,
    });
  });

  it('rejects lease properties outside the v1 schema', () => {
    const result = parseIssueTaskManifest(
      `${validBlock.slice(0, -3)}lease:\n  ttl_minutes: 60\n  heartbeat_minutes: 15\n  grace_minutes: 5\n\`\`\``,
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('lease contains unsupported properties: grace_minutes');
  });

  it('rejects non-array path declarations before filtering', () => {
    const body = validBlock.replace('forbidden_paths:\n  - .github/**', 'forbidden_paths: "(a+)+"');
    const result = parseIssueTaskManifest(body);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('forbidden_paths must be an array of strings');
  });

  it('keeps an entirely missing lease valid for the runtime default', () => {
    const result = parseIssueTaskManifest(validBlock);
    expect(result.valid).toBe(true);
    expect(result.manifest?.lease).toBeUndefined();
  });

  it('keeps the schema and checked documentation examples aligned', () => {
    const schema = JSON.parse(
      readFileSync(resolve(repoRoot, 'packages/github/src/task-manifest.schema.json'), 'utf8'),
    ) as { required: string[]; properties: { lease: { required: string[] } } };
    expect(schema.required).toContain('status');
    expect(schema.properties.lease.required).toEqual(['ttl_minutes', 'heartbeat_minutes']);

    for (const relativePath of ['README.md', 'docs/contributor/github-issues-loop.md']) {
      const result = parseIssueTaskManifest(readFileSync(resolve(repoRoot, relativePath), 'utf8'));
      expect(result.valid, relativePath).toBe(true);
      expect(result.manifest?.status, relativePath).toBe('ready');
    }
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
    expect(rendered).toContain('status: ready');
    expect(rendered).toContain('allowed_paths:');
    expect(rendered).toContain('forbidden_paths:');
  });
});

describe('extractTaskBlock', () => {
  it('extracts openslack-task block from body', () => {
    const body =
      'Some description.\n\n```openslack-task\nschema: openslack.github_issue_task.v1\ntask_id: TASK-2026-000005\ntitle: Extract test\nstatus: ready\nagent_type: codex\nrisk_level: low\n```\n\nMore text.';
    const block = extractTaskBlock(body);
    expect(block).toBeTruthy();
    expect(block).toContain('task_id: TASK-2026-000005');
  });

  it('returns null when no openslack-task block present', () => {
    expect(extractTaskBlock('No task here.')).toBeNull();
    expect(extractTaskBlock('```yaml\nnot a task\n```')).toBeNull();
  });
});
