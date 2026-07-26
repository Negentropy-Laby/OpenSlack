import { resolve } from 'node:path';
import { verifyNotificationDocs } from './lib.js';

const repositoryRoot = resolve(import.meta.dirname, '..', '..');
const result = verifyNotificationDocs(repositoryRoot);

if (result.ok) {
  for (const check of result.checks) process.stdout.write(`[✓] ${check}\n`);
  process.stdout.write('Notification delivery documentation verification passed.\n');
} else {
  for (const error of result.errors) process.stderr.write(`${error.code} ${error.path}\n`);
  process.exitCode = 1;
}
