import { createHash } from 'node:crypto';
/** Document encoding only; the separately specified Broker wire digest is unchanged. */
export const cleanupDocumentBytes = (value: unknown): Buffer =>
  Buffer.from(JSON.stringify(value, null, 2) + '\n');
export const cleanupByteDigest = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');
