import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createNotificationRouteRecordIdV2 } from '../notification-handoff-contracts.js';
import {
  NotificationReceiptStore,
  notificationReceiptStorePath,
  serializeNotificationAcceptanceReceipt,
  type NotificationAcceptanceReceiptV1,
} from '../notification-receipt-store.js';

const workerPath = fileURLToPath(
  new URL('../__fixtures__/notification-storage-worker.ts', import.meta.url),
);
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('NotificationReceiptStore', () => {
  it('creates fixed-order byte-stable receipts and verifies their identity', () => {
    const workspace = temporaryRoot();
    const store = new NotificationReceiptStore({
      rootPath: notificationReceiptStorePath(workspace),
    });
    const receipt = acceptedReceipt();

    const result = store.create(receipt);
    const bytes = readFileSync(result.path);

    expect(result.created).toBe(true);
    expect(bytes.equals(serializeNotificationAcceptanceReceipt(receipt))).toBe(true);
    expect(bytes.toString('utf8')).not.toMatch(/\n$/u);
    const offsets = fieldOffsets(bytes.toString('utf8'));
    expect(offsets.every((offset) => offset >= 0)).toBe(true);
    expect(offsets).toEqual([...offsets].sort((left, right) => left - right));
    expect(store.read(receipt.route_record_id)).toEqual(receipt);
    expect(store.verify(receipt)).toEqual(receipt);
    if (process.platform !== 'win32') {
      expect(lstatSync(store.rootPath).mode & 0o777).toBe(0o700);
      expect(lstatSync(result.path).mode & 0o777).toBe(0o600);
    }
  });

  it('is idempotent for identical bytes and rejects receipt conflicts', () => {
    const store = new NotificationReceiptStore({ rootPath: temporaryRoot() });
    const receipt = acceptedReceipt();
    expect(store.create(receipt).created).toBe(true);
    expect(store.create(receipt).created).toBe(false);
    expect(() =>
      store.create({ ...receipt, notification_id: 'notification-conflict' }),
    ).toThrowError(expect.objectContaining({ code: 'RECEIPT_CONFLICT' }));
    expect(() => store.verify({ ...receipt, remote_request_id: 'request-conflict' })).toThrowError(
      expect.objectContaining({ code: 'RECEIPT_CONFLICT' }),
    );
  });

  it('repairs a missing ledger from the embedded receipt without changing its bytes', () => {
    const store = new NotificationReceiptStore({ rootPath: temporaryRoot() });
    const receipt = acceptedReceipt();

    const repaired = store.ensureFromEmbeddedReceipt(receipt);
    const replay = store.ensureFromEmbeddedReceipt(receipt);

    expect(repaired.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(
      readFileSync(repaired.path).equals(serializeNotificationAcceptanceReceipt(receipt)),
    ).toBe(true);
  });

  it('rejects unknown fields, inconsistent derived identity and unsafe IDs', () => {
    const store = new NotificationReceiptStore({ rootPath: temporaryRoot() });
    const receipt = acceptedReceipt();
    expect(() => store.create({ ...receipt, payload: 'forbidden' } as never)).toThrowError(
      expect.objectContaining({ code: 'RECEIPT_INVALID' }),
    );
    expect(() => store.create({ ...receipt, route_record_id: 'a'.repeat(64) })).toThrowError(
      expect.objectContaining({ code: 'RECEIPT_INVALID' }),
    );
    expect(() => store.pathFor('../escape')).toThrowError(
      expect.objectContaining({ code: 'RECEIPT_INVALID' }),
    );
  });

  it('rejects reordered or reformatted receipt bytes', () => {
    const store = new NotificationReceiptStore({ rootPath: temporaryRoot() });
    const receipt = acceptedReceipt();
    const path = store.pathFor(receipt.route_record_id);
    const { notification_id, ...remainingFields } = receipt;
    writeFileSync(path, JSON.stringify({ notification_id, ...remainingFields }), {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    expect(() => store.read(receipt.route_record_id)).toThrowError(
      expect.objectContaining({ code: 'RECEIPT_NON_CANONICAL' }),
    );
  });

  it('rejects directory and symlink receipt targets', () => {
    const directoryStore = new NotificationReceiptStore({ rootPath: temporaryRoot() });
    const receipt = acceptedReceipt();
    mkdirSync(directoryStore.pathFor(receipt.route_record_id));
    expect(() => directoryStore.create(receipt)).toThrowError(
      expect.objectContaining({ code: 'RECEIPT_FILE_UNSAFE' }),
    );

    const symlinkStore = new NotificationReceiptStore({ rootPath: temporaryRoot() });
    const path = symlinkStore.pathFor(receipt.route_record_id);
    const outside = join(temporaryRoot(), 'outside.json');
    writeFileSync(outside, serializeNotificationAcceptanceReceipt(receipt));
    try {
      symlinkSync(outside, path, 'file');
    } catch {
      return;
    }
    expect(() => symlinkStore.create(receipt)).toThrowError(
      expect.objectContaining({ code: 'RECEIPT_FILE_UNSAFE' }),
    );
  });

  it('converges concurrent multi-process embedded-receipt repair', async () => {
    const root = temporaryRoot();
    const receipt = acceptedReceipt();
    const encoded = Buffer.from(JSON.stringify(receipt), 'utf8').toString('base64');

    const results = await Promise.all(
      Array.from({ length: 4 }, () => runWorker(['receipt-ensure', root, encoded])),
    );

    expect(
      results.every((result) => result.code === 0),
      JSON.stringify(results),
    ).toBe(true);
    const created = results.map((result) => JSON.parse(result.stdout) as { created: boolean });
    expect(created.filter((result) => result.created)).toHaveLength(1);
    expect(new NotificationReceiptStore({ rootPath: root }).read(receipt.route_record_id)).toEqual(
      receipt,
    );
    expect(existsSync(join(root, '.receipt-store.lock'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('fails closed for permissive receipt permissions', () => {
    const looseRoot = temporaryRoot();
    chmodSync(looseRoot, 0o755);
    expect(() => new NotificationReceiptStore({ rootPath: looseRoot })).toThrowError(
      expect.objectContaining({ code: 'RECEIPT_PATH_UNSAFE' }),
    );

    const store = new NotificationReceiptStore({ rootPath: temporaryRoot() });
    const receipt = acceptedReceipt();
    const result = store.create(receipt);
    chmodSync(result.path, 0o644);
    expect(() => store.read(receipt.route_record_id)).toThrowError(
      expect.objectContaining({ code: 'RECEIPT_FILE_UNSAFE' }),
    );
  });
});

function acceptedReceipt(): NotificationAcceptanceReceiptV1 {
  const canonicalRepository = 'negentropy-laby/openslack';
  const idempotencyKey = '480f3f0b-01e3-57fb-8f3a-6ffd3a16ecbe';
  return {
    schema: 'openslack.notification_acceptance.v1',
    route_record_id: createNotificationRouteRecordIdV2(canonicalRepository, idempotencyKey),
    canonical_repository: canonicalRepository,
    route_id: 'slack-primary',
    routing_epoch: 1,
    vendor_id: 'openslack-slack',
    idempotency_key: idempotencyKey,
    notification_id: 'notification-1',
    remote_request_id: 'request-1',
    accepted_at: '2026-07-23T00:00:00Z',
    idempotent_replay: false,
    deployment_digest: `sha256:${'a'.repeat(64)}`,
    watch_config_digest: `sha256:${'b'.repeat(64)}`,
    recorded_at: '2026-07-23T00:00:01Z',
  };
}

function fieldOffsets(body: string): number[] {
  return [
    'schema',
    'route_record_id',
    'canonical_repository',
    'route_id',
    'routing_epoch',
    'vendor_id',
    'idempotency_key',
    'notification_id',
    'remote_request_id',
    'accepted_at',
    'idempotent_replay',
    'deployment_digest',
    'watch_config_digest',
    'recorded_at',
  ].map((field) => body.indexOf(`"${field}":`));
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'openslack-notification-receipt-'));
  temporaryRoots.push(root);
  return root;
}

function runWorker(
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', workerPath, ...args], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
