import { createHash } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import {
  createNotificationImportQualificationReport,
  ensureNotificationImportQualificationReport,
  type NotificationImportQualificationInput,
} from '../../packages/github/src/index.js';
import { assertNoDuplicateJsonKeys } from '../../packages/github/src/notification-service-client.js';

void main().catch(() => {
  process.stderr.write('NOTIFICATION_IMPORT_QUALIFICATION_FAILED\n');
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const { inputPath, evidenceRoot } = parseArguments(process.argv.slice(2));
  const input = readInput(inputPath);
  const report = createNotificationImportQualificationReport(input);
  verifyEvidenceDigest(
    join(evidenceRoot, 'receipt-reconciliation.json'),
    report.receipt_reconciliation_sha256,
  );
  verifyEvidenceDigest(join(evidenceRoot, 'security-review.json'), report.security_review_sha256);
  for (const drill of report.drills) {
    verifyEvidenceDigest(
      join(evidenceRoot, 'fault-runs', `${drill.kind}.json`),
      drill.evidence_sha256,
    );
  }

  const written = ensureNotificationImportQualificationReport(evidenceRoot, report);
  process.stdout.write(
    `${JSON.stringify({
      schema: 'openslack.notification_import_qualification_command.v1',
      status: report.status,
      correlation_id: report.correlation_id,
      sha256: written.sha256,
      created: written.created,
    })}\n`,
  );
  if (report.status !== 'PASS') process.exitCode = 1;
}

function parseArguments(args: string[]): { inputPath: string; evidenceRoot: string } {
  if (
    args.length !== 5 ||
    args[0] !== 'seal' ||
    args[1] !== '--input' ||
    args[3] !== '--evidence-root'
  ) {
    throw new Error('QUALIFICATION_ARGUMENTS_INVALID');
  }
  const inputPath = requiredAbsolute(args[2]);
  const evidenceRoot = requiredAbsolute(args[4]);
  return { inputPath, evidenceRoot };
}

function requiredAbsolute(value: string | undefined): string {
  if (!value || !isAbsolute(value)) throw new Error('QUALIFICATION_PATH_INVALID');
  return resolve(value);
}

function readInput(path: string): NotificationImportQualificationInput {
  const bytes = readSafeFile(path, 1024 * 1024);
  try {
    const text = bytes.toString('utf8');
    assertNoDuplicateJsonKeys(text);
    return JSON.parse(text) as NotificationImportQualificationInput;
  } catch {
    throw new Error('QUALIFICATION_INPUT_INVALID');
  }
}

function verifyEvidenceDigest(path: string, expected: `sha256:${string}`): void {
  const bytes = readSafeFile(path, 4 * 1024 * 1024);
  const actual = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (actual !== expected) throw new Error('QUALIFICATION_EVIDENCE_DIGEST_MISMATCH');
}

function readSafeFile(path: string, maximumBytes: number): Buffer {
  const status = lstatSync(path, { bigint: true });
  if (
    status.isSymbolicLink() ||
    !status.isFile() ||
    status.size < 1n ||
    status.size > BigInt(maximumBytes) ||
    (process.platform !== 'win32' && (Number(status.mode) & 0o777) !== 0o600)
  ) {
    throw new Error('QUALIFICATION_EVIDENCE_FILE_UNSAFE');
  }
  const descriptor = openSync(path, 'r');
  try {
    const before = fstatSync(descriptor, { bigint: true });
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    if (
      before.dev !== status.dev ||
      before.ino !== status.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      BigInt(bytes.length) !== status.size
    ) {
      throw new Error('QUALIFICATION_EVIDENCE_READ_RACE');
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}
