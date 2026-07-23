import { createHash } from 'node:crypto';
import { NotificationBlobStore } from '../notification-blob-store.js';
import {
  NotificationReceiptStore,
  type NotificationAcceptanceReceiptV1,
} from '../notification-receipt-store.js';

const [mode, rootPath, encoded, option] = process.argv.slice(2);
if (!mode || !rootPath || !encoded) throw new Error('Missing notification storage worker input.');

if (mode === 'blob-put') {
  const bytes = Buffer.from(encoded, 'base64');
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}` as const;
  const store = new NotificationBlobStore({ rootPath, maxBytes: Number(option) });
  const result = store.put({ bytes, digest, size: bytes.byteLength });
  process.stdout.write(JSON.stringify({ ok: true, created: result.created, digest }));
} else if (mode === 'blob-read-loop') {
  const store = new NotificationBlobStore({ rootPath, maxBytes: Number(option) });
  let reads = 0;
  let missing = 0;
  for (let index = 0; index < 30; index += 1) {
    try {
      store.read(encoded);
      reads += 1;
    } catch (error) {
      if ((error as { code?: unknown }).code !== 'BLOB_NOT_FOUND') throw error;
      missing += 1;
    }
  }
  process.stdout.write(JSON.stringify({ ok: true, reads, missing }));
} else if (mode === 'blob-gc') {
  const store = new NotificationBlobStore({ rootPath, maxBytes: Number(option) });
  const result = store.collectGarbage({
    activeDigests: new Set(),
    eligibleDigests: new Set([encoded]),
  });
  process.stdout.write(JSON.stringify({ ok: true, removed: result.removedDigests.length }));
} else if (mode === 'receipt-ensure') {
  const receipt = JSON.parse(
    Buffer.from(encoded, 'base64').toString('utf8'),
  ) as NotificationAcceptanceReceiptV1;
  const result = new NotificationReceiptStore({ rootPath }).ensureFromEmbeddedReceipt(receipt);
  process.stdout.write(JSON.stringify({ ok: true, created: result.created }));
} else {
  throw new Error(`Unknown notification storage worker mode: ${mode}`);
}
