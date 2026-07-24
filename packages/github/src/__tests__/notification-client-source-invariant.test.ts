import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const githubSource = join(repositoryRoot, 'packages/github/src');
const forbiddenModules = [
  'notification-service-client',
  'notification-blob-store',
  'notification-receipt-store',
];

describe('notification handoff G3 source invariant', () => {
  it('limits handoff composition to the v2 daemon and route worker', () => {
    const compositionFiles = [
      join(githubSource, 'watch-delivery-router.ts'),
      join(githubSource, 'workspace-watch.ts'),
      join(githubSource, 'notification-sinks.ts'),
      ...typescriptFiles(join(repositoryRoot, 'apps/cli/src')),
    ];
    for (const path of compositionFiles) {
      const source = readFileSync(path, 'utf8');
      for (const moduleName of forbiddenModules) {
        expect(source, `${path} must not reference ${moduleName}`).not.toContain(moduleName);
      }
      expect(source, `${path} must not instantiate NotificationServiceClient`).not.toContain(
        'NotificationServiceClient',
      );
      expect(source, `${path} must not instantiate NotificationBlobStore`).not.toContain(
        'NotificationBlobStore',
      );
      expect(source, `${path} must not instantiate NotificationReceiptStore`).not.toContain(
        'NotificationReceiptStore',
      );
    }

    const daemon = readFileSync(join(githubSource, 'watch-daemon.ts'), 'utf8');
    expect(daemon).toContain('new NotificationServiceClient');
    expect(daemon).toContain('new NotificationBlobStore');
    expect(daemon).toContain('new NotificationReceiptStore');
    expect(daemon).toContain('parseNotificationServiceAdmission');

    const v2Router = readFileSync(join(githubSource, 'watch-delivery-router-v2.ts'), 'utf8');
    expect(v2Router).toContain('notificationClient.handoff');
    expect(v2Router).not.toContain('implements NotificationSink');
    expect(v2Router).not.toContain("type: 'notification.sent'");
  });

  it('keeps read-only reconciliation out of daemon and sender composition', () => {
    for (const path of [
      join(githubSource, 'watch-daemon.ts'),
      join(githubSource, 'watch-delivery-router.ts'),
      join(githubSource, 'watch-delivery-router-v2.ts'),
      join(githubSource, 'notification-sinks.ts'),
    ]) {
      const source = readFileSync(path, 'utf8');
      expect(source, `${path} must not instantiate the ops client`).not.toContain(
        'NotificationServiceOpsClient',
      );
      expect(source, `${path} must not instantiate reconciliation`).not.toContain(
        'NotificationDeliveryReconciler',
      );
    }

    const operations = readFileSync(
      join(githubSource, 'notification-delivery-operations.ts'),
      'utf8',
    );
    expect(operations).toContain('new NotificationServiceOpsClient');
    expect(operations).toContain('new NotificationDeliveryReconciler');
  });

  it('keeps the controlled fault harness out of production composition', () => {
    for (const path of [
      join(githubSource, 'watch-daemon.ts'),
      join(githubSource, 'watch-delivery-router.ts'),
      join(githubSource, 'watch-delivery-router-v2.ts'),
      join(githubSource, 'notification-sinks.ts'),
      ...typescriptFiles(join(repositoryRoot, 'apps/cli/src')),
    ]) {
      const source = readFileSync(path, 'utf8');
      expect(source, `${path} must not instantiate the fault proxy`).not.toContain(
        'NotificationFaultProxy',
      );
      expect(source, `${path} must not run the fault harness`).not.toContain(
        'runNotificationFaultHarness',
      );
      expect(source, `${path} must not import the fault proxy module`).not.toContain(
        'notification-fault-proxy',
      );
      expect(source, `${path} must not import the fault-run module`).not.toContain(
        'notification-fault-run',
      );
    }
  });

  it('keeps import-qualification sealing out of production composition', () => {
    for (const path of [
      join(githubSource, 'watch-daemon.ts'),
      join(githubSource, 'watch-delivery-router.ts'),
      join(githubSource, 'watch-delivery-router-v2.ts'),
      join(githubSource, 'notification-sinks.ts'),
      ...typescriptFiles(join(repositoryRoot, 'apps/cli/src')),
    ]) {
      const source = readFileSync(path, 'utf8');
      expect(source, `${path} must not verify qualification evidence`).not.toContain(
        'verifyNotificationQualification',
      );
      expect(source, `${path} must not import the qualification verifier`).not.toContain(
        'notification-import-qualification-verifier',
      );
    }
  });
});

function typescriptFiles(root: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...typescriptFiles(path));
    else if (entry.isFile() && /\.tsx?$/u.test(entry.name)) result.push(path);
  }
  return result;
}
