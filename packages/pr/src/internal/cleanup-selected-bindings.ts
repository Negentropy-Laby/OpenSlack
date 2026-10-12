import { decodeStrictJSON } from '@openslack/core';
import {
  CLEANUP_HEAD,
  CLEANUP_SHA256,
  cleanupExactKeys,
  cleanupObject,
} from './cleanup-validation.js';

export class CleanupSelectedBindingsError extends Error {
  constructor(readonly reason: 'JSON' | 'SCHEMA' | 'PRIOR' | 'SELECTED' | 'CANDIDATE') {
    super(reason);
  }
}
/** Envelope and nonsecret text rules only; consumers retain their binding policy. */
export function parseCleanupSelectedBindings(
  raw: Buffer,
  maxBytes: number,
  candidateHead?: string,
) {
  const fail = (reason: CleanupSelectedBindingsError['reason']): never => {
    throw new CleanupSelectedBindingsError(reason);
  };
  let value: unknown;
  try {
    value = decodeStrictJSON(raw, maxBytes);
  } catch {
    return fail('JSON');
  }
  if (!cleanupObject(value)) return fail('SCHEMA');
  if (value.schema === 'openslack.cleanup_admin_selected_bindings.v1') {
    if (!cleanupExactKeys(value, ['schema', 'selected', 'priorInput'])) return fail('SCHEMA');
  } else {
    if (
      !cleanupExactKeys(value, [
        'schema',
        'candidateHead',
        'approvalStatus',
        'priorInput',
        'selected',
        'installationAuthorized',
        'executionAuthorized',
      ]) ||
      value.schema !== 'openslack.cleanup_handoff_draft.v1' ||
      value.approvalStatus !== 'DRAFT' ||
      value.installationAuthorized !== false ||
      value.executionAuthorized !== false ||
      typeof value.candidateHead !== 'string' ||
      !CLEANUP_HEAD.test(value.candidateHead)
    )
      return fail('SCHEMA');
    if (candidateHead !== undefined && candidateHead !== value.candidateHead)
      return fail('CANDIDATE');
  }
  const prior = value.priorInput;
  if (
    !cleanupObject(prior) ||
    !cleanupExactKeys(prior, ['source', 'sha256', 'approvalNotInherited']) ||
    typeof prior.source !== 'string' ||
    !prior.source.length ||
    prior.source.length > 4096 ||
    typeof prior.sha256 !== 'string' ||
    !CLEANUP_SHA256.test(prior.sha256) ||
    prior.approvalNotInherited !== true
  )
    return fail('PRIOR');
  if (!cleanupObject(value.selected) || Object.keys(value.selected).length > 128)
    return fail('SELECTED');
  const selected: Record<string, string> = {};
  for (const [key, text] of Object.entries(value.selected)) {
    const statusOnly =
      /^(?:governance_read_credential_provisioned|deletion_app_key_provisioned)$/.test(key) &&
      (text === 'yes' || text === 'no');
    if (
      !/^[a-z][a-z0-9_]{0,127}$/.test(key) ||
      typeof text !== 'string' ||
      text.length > 8192 ||
      /[\u0000-\u001f\u007f]/.test(text) ||
      (/(?:password|private_key|token|credential)/i.test(key) && !statusOnly)
    )
      return fail('SELECTED');
    selected[key] = text;
  }
  return Object.freeze({ selected: Object.freeze(selected), priorInputSHA256: prior.sha256 });
}
