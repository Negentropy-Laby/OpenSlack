import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collaborationCommands } from '../commands/collaboration.js';
import type { CollaborationEvent } from '@openslack/collaboration';
import { validateBusinessOutcomeProjection } from '@openslack/collaboration';

const NOW = new Date('2026-07-26T12:00:00.000Z');

function makeEvent(
  id: string,
  type: CollaborationEvent['type'],
  scenarioId: string,
): CollaborationEvent {
  return {
    id,
    schema: 'openslack.collaboration_event.v1',
    timestamp: '2026-07-26T06:00:00.000Z',
    type,
    actor: { id: 'operator', kind: 'system', provider: 'cli' },
    object: { kind: 'issue', id: '1' },
    source: { kind: 'openslack', ref: id },
    summary: type,
    visibility: 'local',
    redacted: false,
    containsSensitiveData: false,
    metadata: { scenarioId },
  };
}

describe('collaboration business-outcomes command', () => {
  let rootDir: string;
  let originalCwd: string;
  let stdout: ReturnType<typeof vi.spyOn>;
  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'openslack-business-outcomes-'));
    originalCwd = process.cwd();
    writeFileSync(join(rootDir, 'openslack.yaml'), 'schema: openslack.workspace.v1\n', 'utf-8');
    process.chdir(rootDir);
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(rootDir, { recursive: true, force: true });
    vi.useRealTimers();
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  function writeEvents(events: CollaborationEvent[]): void {
    const dir = join(rootDir, '.openslack.local', 'collaboration');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'events.jsonl'),
      events.map((event) => JSON.stringify(event)).join('\n') + '\n',
      'utf-8',
    );
  }

  it('renders schema-pinned JSON and filters by scenario', async () => {
    writeEvents([
      makeEvent('wanted', 'task.created', 'manufacturing-90-day'),
      makeEvent('other', 'task.created', 'other-scenario'),
    ]);

    await collaborationCommands().parseAsync(
      [
        'business-outcomes',
        '--since-hours',
        '24',
        '--scenario',
        'manufacturing-90-day',
        '--format',
        'json',
      ],
      { from: 'user' },
    );

    const output = stdout.mock.calls.map(([value]) => String(value)).join('\n');
    const projection = JSON.parse(output) as Record<string, unknown>;
    expect(projection.schema).toBe('openslack.business_outcome.v1');
    expect(projection.generatedAt).toBe(NOW.toISOString());
    expect(projection.scenario).toBe('manufacturing-90-day');
    expect((projection.work as { created: { value: number } }).created.value).toBe(1);
    expect((projection.notifications as { accepted: { basis: string } }).accepted.basis).toBe(
      'unknown',
    );
    expect(projection.evidenceRefs).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          new RegExp(
            `^query:collaboration-events:sha256:${createHash('sha256')
              .update(
                readFileSync(join(rootDir, '.openslack.local', 'collaboration', 'events.jsonl')),
              )
              .digest('hex')}#bytes=\\d+&records=2&from=`,
          ),
        ),
      ]),
    );
    expect(validateBusinessOutcomeProjection(projection)).toEqual({ valid: true, errors: [] });
  });

  it('loads only matching versioned scenario assumptions as configured estimates', async () => {
    writeEvents([
      makeEvent('created', 'task.created', 'manufacturing-90-day'),
      makeEvent('done', 'task.done', 'manufacturing-90-day'),
    ]);
    const assumptionsDir = join(rootDir, 'examples', 'ai-organization-demo', 'input');
    mkdirSync(assumptionsDir, { recursive: true });
    writeFileSync(
      join(assumptionsDir, 'outcome-assumptions.yaml'),
      [
        'schema: openslack.business_outcome_assumptions.v1',
        'scenario: manufacturing-90-day',
        'version: "2026-07-26"',
        'assumptions:',
        '  estimatedManualHours:',
        '    value: 120',
        '    unit: hours',
      ].join('\n'),
      'utf-8',
    );

    await collaborationCommands().parseAsync(
      ['business-outcomes', '--scenario', 'manufacturing-90-day', '--format', 'json'],
      { from: 'user' },
    );

    const output = stdout.mock.calls.map(([value]) => String(value)).join('\n');
    const projection = JSON.parse(output) as {
      economics: { estimatedManualHours: { value: number; basis: string; evidenceRefs: string[] } };
    };
    expect(projection.economics.estimatedManualHours.value).toBe(120);
    expect(projection.economics.estimatedManualHours.basis).toBe('configured_estimate');
    expect(projection.economics.estimatedManualHours.evidenceRefs[0]).toContain('@2026-07-26');
  });

  it('renders plain and markdown formats with explicit basis', async () => {
    writeEvents([]);
    await collaborationCommands().parseAsync(['business-outcomes', '--format', 'plain'], {
      from: 'user',
    });
    expect(stdout.mock.calls.map(([value]) => String(value)).join('\n')).toContain(
      'OpenSlack Business Outcomes',
    );
    expect(stdout.mock.calls.map(([value]) => String(value)).join('\n')).toContain('[unknown]');

    stdout.mockClear();
    await collaborationCommands().parseAsync(['business-outcomes', '--format', 'markdown'], {
      from: 'user',
    });
    expect(stdout.mock.calls.map(([value]) => String(value)).join('\n')).toContain(
      '| Metric | Value | Basis | Evidence |',
    );
  });

  it('does not create a missing collaboration event store while reading', async () => {
    expect(existsSync(join(rootDir, '.openslack.local'))).toBe(false);
    await collaborationCommands().parseAsync(['business-outcomes', '--format', 'json'], {
      from: 'user',
    });
    expect(existsSync(join(rootDir, '.openslack.local'))).toBe(false);
    const projection = JSON.parse(stdout.mock.calls.map(([value]) => String(value)).join('\n')) as {
      evidenceRefs: string[];
    };
    expect(projection.evidenceRefs).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^query:collaboration-events:missing#bytes=0&records=0&from=/),
      ]),
    );
  });

  it('blocks malformed, invalid, and oversized event sources instead of reporting zeroes', async () => {
    const eventsDir = join(rootDir, '.openslack.local', 'collaboration');
    const eventsPath = join(eventsDir, 'events.jsonl');
    mkdirSync(eventsDir, { recursive: true });

    writeFileSync(eventsPath, '{"schema":\n', 'utf-8');
    await collaborationCommands().parseAsync(['business-outcomes', '--format', 'json'], {
      from: 'user',
    });
    expect(stderr).toHaveBeenLastCalledWith(
      'Business outcomes blocked: collaboration event source has malformed JSON at line 1',
    );
    expect(process.exitCode).toBe(1);
    expect(stdout).not.toHaveBeenCalled();

    process.exitCode = undefined;
    stderr.mockClear();
    writeFileSync(
      eventsPath,
      `${JSON.stringify({ ...makeEvent('bad', 'task.created', 'manufacturing-90-day'), schema: 'openslack.collaboration_event.v2' })}\n`,
      'utf-8',
    );
    await collaborationCommands().parseAsync(['business-outcomes', '--format', 'json'], {
      from: 'user',
    });
    expect(stderr.mock.calls.map(([value]) => String(value)).join('\n')).toContain(
      'Business outcomes blocked: collaboration event source has an invalid record at line 1',
    );
    expect(process.exitCode).toBe(1);
    expect(stdout).not.toHaveBeenCalled();

    process.exitCode = undefined;
    stderr.mockClear();
    truncateSync(eventsPath, 8 * 1024 * 1024 + 1);
    await collaborationCommands().parseAsync(['business-outcomes', '--format', 'json'], {
      from: 'user',
    });
    expect(stderr).toHaveBeenLastCalledWith(
      'Business outcomes blocked: collaboration event source exceeds 8388608 bytes',
    );
    expect(process.exitCode).toBe(1);
    expect(stdout).not.toHaveBeenCalled();
  });

  it('blocks invalid UTF-8 or ambiguous trailing records', async () => {
    const eventsDir = join(rootDir, '.openslack.local', 'collaboration');
    const eventsPath = join(eventsDir, 'events.jsonl');
    mkdirSync(eventsDir, { recursive: true });
    const validRecord = JSON.stringify(makeEvent('valid', 'task.created', 'manufacturing-90-day'));

    writeFileSync(eventsPath, Buffer.from([0xc3, 0x28]));
    await collaborationCommands().parseAsync(['business-outcomes', '--format', 'json'], {
      from: 'user',
    });
    expect(stderr).toHaveBeenLastCalledWith(
      'Business outcomes blocked: collaboration event source is not valid UTF-8',
    );
    expect(process.exitCode).toBe(1);
    expect(stdout).not.toHaveBeenCalled();

    process.exitCode = undefined;
    stderr.mockClear();
    writeFileSync(eventsPath, `${validRecord}\n\n`, 'utf-8');
    await collaborationCommands().parseAsync(['business-outcomes', '--format', 'json'], {
      from: 'user',
    });
    expect(stderr).toHaveBeenLastCalledWith(
      'Business outcomes blocked: collaboration event source has more than one terminating newline',
    );
    expect(process.exitCode).toBe(1);
    expect(stdout).not.toHaveBeenCalled();

    process.exitCode = undefined;
    stderr.mockClear();
    writeFileSync(eventsPath, `${validRecord}\n  \n`, 'utf-8');
    await collaborationCommands().parseAsync(['business-outcomes', '--format', 'json'], {
      from: 'user',
    });
    expect(stderr).toHaveBeenLastCalledWith(
      'Business outcomes blocked: collaboration event source has a blank record at line 2',
    );
    expect(process.exitCode).toBe(1);
    expect(stdout).not.toHaveBeenCalled();
  });

  it('fails closed for invalid window and format arguments', async () => {
    await collaborationCommands().parseAsync(['business-outcomes', '--since-hours', '0'], {
      from: 'user',
    });
    expect(stderr).toHaveBeenCalledWith('--since-hours must be an integer between 1 and 87600.');
    expect(process.exitCode).toBe(1);

    process.exitCode = undefined;
    stderr.mockClear();
    await collaborationCommands().parseAsync(['business-outcomes', '--format', 'html'], {
      from: 'user',
    });
    expect(stderr).toHaveBeenCalledWith('--format must be one of: json, markdown, plain.');
    expect(process.exitCode).toBe(1);
  });
});
