import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

describe('notification import qualification deployment', () => {
  it('keeps the protected workflow single-run and bounded to sixty minutes', () => {
    const source = readFileSync(
      new URL(
        '../../../../.github/workflows/notification-import-qualification.yml',
        import.meta.url,
      ),
      'utf8',
    );
    const workflow = parse(source) as {
      on: Record<string, unknown>;
      concurrency: { 'cancel-in-progress': boolean };
      jobs: {
        qualification: {
          environment: string;
          'timeout-minutes': number;
          steps: Array<{ run?: string; uses?: string }>;
        };
      };
    };

    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
    expect(workflow.concurrency['cancel-in-progress']).toBe(false);
    expect(workflow.jobs.qualification.environment).toBe('notification-canary');
    expect(workflow.jobs.qualification['timeout-minutes']).toBe(60);
    const serialized = JSON.stringify(workflow);
    expect(serialized).toContain('timeout --signal=TERM --kill-after=30s 50m');
    expect(serialized).toContain('notification:qualification');
    expect(serialized).not.toMatch(/336|14\s*day|sleep\s+[1-9][0-9]{3,}/iu);
  });

  it('publishes a closed pending-external environment manifest', () => {
    const manifest = JSON.parse(
      readFileSync(
        new URL(
          '../../../../deploy/notification-import-qualification/environment-manifest.v1.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as object;
    const schema = JSON.parse(
      readFileSync(
        new URL(
          '../../../../deploy/notification-import-qualification/environment-manifest.schema.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as object;
    const validate = new Ajv2020({ strict: false, validateFormats: false }).compile(schema);

    expect(validate(manifest), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...manifest, secret_value: 'forbidden' })).toBe(false);
    expect(manifest).toMatchObject({
      status: 'PENDING_EXTERNAL',
      timeout_minutes: 60,
      does_not_claim: expect.arrayContaining(['LIVE_VERIFIED', 'IB7_CUTOVER']),
    });
  });
});
