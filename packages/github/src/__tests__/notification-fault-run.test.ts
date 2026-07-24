import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ensureNotificationFaultRun,
  runNotificationFaultHarness,
  type NotificationFaultRunManifest,
} from '../notification-fault-run.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('notification fault run evidence', () => {
  it('publishes a closed schema for the metadata-only manifest', () => {
    const schema = JSON.parse(
      readFileSync(new URL('../notification-fault-run.schema.json', import.meta.url), 'utf8'),
    ) as object;
    const validate = new Ajv2020({ strict: false, validateFormats: false }).compile(schema);
    expect(validate(manifest())).toBe(true);
    expect(validate({ ...manifest(), payload: 'forbidden' })).toBe(false);
    expect(
      validate({
        ...manifest(),
        checks: [{ ...manifest().checks[0], response_body: 'forbidden' }],
      }),
    ).toBe(false);
  });

  it('creates a byte-stable metadata-only manifest and checksum exactly once', () => {
    const root = temporaryRoot();
    const first = ensureNotificationFaultRun(root, manifest());
    const second = ensureNotificationFaultRun(root, manifest());
    const bytes = readFileSync(first.manifestPath, 'utf8');

    expect(first.created).toBe(true);
    expect(second).toMatchObject({ created: false, sha256: first.sha256 });
    expect(readFileSync(first.checksumPath, 'utf8')).toBe(
      `${first.sha256}  response-loss-1.json\n`,
    );
    expect(bytes).not.toContain('payload');
    expect(bytes).not.toContain('token');
    expect(bytes).not.toContain('endpoint');
    expect(bytes).not.toContain('response_body');
  });

  it('rejects conflicting reruns and status/check disagreement', () => {
    const root = temporaryRoot();
    ensureNotificationFaultRun(root, manifest());
    expect(() =>
      ensureNotificationFaultRun(root, {
        ...manifest(),
        correlation_id: 'different-correlation',
      }),
    ).toThrow('FAULT_RUN_CONFLICT');
    expect(() =>
      ensureNotificationFaultRun(root, {
        ...manifest(),
        status: 'FAIL',
      }),
    ).toThrow(TypeError);
  });

  it('runs explicit fault steps and seals thrown failures without error prose', async () => {
    const root = temporaryRoot();
    const result = await runNotificationFaultHarness({
      rootPath: root,
      identity: {
        run_id: 'process-restart-1',
        correlation_id: 'canary-2026-07-23',
        fault_case: 'process_restart',
        openslack_commit: 'a'.repeat(40),
        openslack_tree: 'b'.repeat(40),
        service_commit: 'c'.repeat(40),
        service_tree: 'd'.repeat(40),
        service_deployment_digest: `sha256:${'e'.repeat(64)}`,
        watch_config_digest: `sha256:${'f'.repeat(64)}`,
        repository: 'negentropy-laby/openslack-notification-canary-a',
        route_id: 'webhook-primary',
        routing_epoch: 1,
        vendor_id: 'openslack-webhook',
      },
      steps: [
        {
          name: 'restart-service',
          execute: async () => {
            throw new Error('host endpoint and secret must not persist');
          },
        },
      ],
      now: () => new Date('2026-07-23T00:00:00Z'),
    });

    expect(result.manifest).toMatchObject({
      status: 'FAIL',
      checks: [{ passed: false, code: 'FAULT_STEP_FAILED' }],
    });
    expect(readFileSync(result.evidence.manifestPath, 'utf8')).not.toContain('host endpoint');
    expect(readFileSync(result.evidence.manifestPath, 'utf8')).not.toContain('secret');
  });

  it('validates identity and create-only run ownership before executing fault steps', async () => {
    const root = temporaryRoot();
    let executions = 0;
    const step = {
      name: 'restart-service',
      execute: async () => {
        executions += 1;
        return { passed: true, code: 'SERVICE_RESTARTED' };
      },
    };
    const identity = {
      run_id: 'process-restart-preflight',
      correlation_id: 'canary-2026-07-23',
      fault_case: 'process_restart' as const,
      openslack_commit: 'a'.repeat(40),
      openslack_tree: 'b'.repeat(40),
      service_commit: 'c'.repeat(40),
      service_tree: 'd'.repeat(40),
      service_deployment_digest: `sha256:${'e'.repeat(64)}` as const,
      watch_config_digest: `sha256:${'f'.repeat(64)}` as const,
      repository: 'negentropy-laby/openslack-notification-canary-a',
      route_id: 'webhook-primary',
      routing_epoch: 1,
      vendor_id: 'openslack-webhook',
    };

    await expect(
      runNotificationFaultHarness({
        rootPath: root,
        identity: { ...identity, service_commit: 'invalid' },
        steps: [step],
      }),
    ).rejects.toThrow(TypeError);
    expect(executions).toBe(0);

    await expect(
      runNotificationFaultHarness({
        rootPath: root,
        identity,
        steps: [step],
        now: () => new Date('2026-07-23T00:00:00Z'),
      }),
    ).resolves.toMatchObject({ manifest: { status: 'PASS' } });
    expect(executions).toBe(1);

    await expect(
      runNotificationFaultHarness({
        rootPath: root,
        identity,
        steps: [step],
        now: () => new Date('2026-07-23T00:00:00Z'),
      }),
    ).rejects.toThrow('FAULT_RUN_ALREADY_SEALED');
    expect(executions).toBe(1);
  });

  it('seals invalid adapter result shapes as closed failure codes', async () => {
    const root = temporaryRoot();
    const result = await runNotificationFaultHarness({
      rootPath: root,
      identity: {
        run_id: 'invalid-step-result',
        correlation_id: 'canary-2026-07-23',
        fault_case: 'disk_boundary',
        openslack_commit: 'a'.repeat(40),
        openslack_tree: 'b'.repeat(40),
        service_commit: 'c'.repeat(40),
        service_tree: 'd'.repeat(40),
        service_deployment_digest: `sha256:${'e'.repeat(64)}`,
        watch_config_digest: `sha256:${'f'.repeat(64)}`,
        repository: 'negentropy-laby/openslack-notification-canary-a',
        route_id: 'webhook-primary',
        routing_epoch: 1,
        vendor_id: 'openslack-webhook',
      },
      steps: [
        {
          name: 'disk-checkpoint',
          execute: async () => ({ passed: true, code: 'invalid prose' }),
        },
      ],
      now: () => new Date('2026-07-23T00:00:00Z'),
    });

    expect(result.manifest).toMatchObject({
      status: 'FAIL',
      checks: [{ passed: false, code: 'FAULT_STEP_RESULT_INVALID' }],
    });
  });

  it.skipIf(process.platform === 'win32')('fails closed on permissive evidence files', () => {
    const root = temporaryRoot();
    const written = ensureNotificationFaultRun(root, manifest());
    chmodSync(written.manifestPath, 0o644);
    expect(() => ensureNotificationFaultRun(root, manifest())).toThrow('FAULT_RUN_FILE_UNSAFE');
  });
});

function manifest(): NotificationFaultRunManifest {
  return {
    schema: 'openslack.notification_fault_run.v1',
    run_id: 'response-loss-1',
    correlation_id: 'canary-2026-07-23',
    fault_case: 'response_loss_after_upstream',
    status: 'PASS',
    started_at: '2026-07-23T00:00:00Z',
    completed_at: '2026-07-23T00:01:00Z',
    openslack_commit: 'a'.repeat(40),
    openslack_tree: 'b'.repeat(40),
    service_commit: 'c'.repeat(40),
    service_tree: 'd'.repeat(40),
    service_deployment_digest: `sha256:${'e'.repeat(64)}`,
    watch_config_digest: `sha256:${'f'.repeat(64)}`,
    repository: 'negentropy-laby/openslack-notification-canary-a',
    route_id: 'webhook-primary',
    routing_epoch: 1,
    vendor_id: 'openslack-webhook',
    checks: [
      {
        name: 'same-key-replayed',
        passed: true,
        code: 'SAME_KEY_REPLAYED',
        recorded_at: '2026-07-23T00:01:00Z',
      },
    ],
  };
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'openslack-fault-run-'));
  roots.push(root);
  return root;
}
