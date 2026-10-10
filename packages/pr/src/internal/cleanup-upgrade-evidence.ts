import { decodeStrictJSON } from '@openslack/core';
import { createHash } from 'node:crypto';
import { posix, win32 } from 'node:path';
import { CleanupFileBoundaryError, readCleanupBoundedFile } from './cleanup-file-boundary.js';
import type { CleanupHandoffTargetEvidence } from '../cleanup-handoff.js';

export const UPGRADE_EVIDENCE_SCHEMAS = Object.freeze({
  admin: 'openslack.cleanup_upgrade_inputs.v1',
  host: 'openslack.cleanup_host_inspection.v1',
  taskAttestation: 'openslack.cleanup_task_attestation.v1',
  appScope: 'openslack.cleanup_app_scope_evidence.v1',
  network: 'openslack.cleanup_network_evidence.v1',
  identity: 'openslack.cleanup_identity_evidence.v1',
  dependencies: 'openslack.cleanup_dependency_inventory.v1',
});
export const UPGRADE_EVIDENCE_ROLES = Object.freeze([
  'installationManifestPath',
  'taskViewPath',
  'taskAttestationPath',
  'appScopePath',
  'networkPath',
  'identityPath',
  'dependencyInventoryPath',
] as const);
const HASH = /^[a-f0-9]{64}$/;
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
type ObjectValue = Record<string, unknown>;
class EvidenceValidationFailure extends Error {}
export class UpgradeEvidenceError extends Error {
  constructor(
    readonly role: string,
    readonly reason: string,
  ) {
    super(`${role}: ${reason}`);
  }
}
function insist(value: unknown, reason = 'EVIDENCE_INVALID'): asserts value {
  if (!value) throw new EvidenceValidationFailure(reason);
}
const isHash = (value: unknown): value is string => typeof value === 'string' && HASH.test(value);
const isMode = (value: unknown): value is string =>
  typeof value === 'string' && /^0[0-7]{3}$/.test(value) && (parseInt(value, 8) & 0o022) === 0;
const isObservedOwner = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 4294967295;
const isObservedMode = (value: unknown): value is string =>
  typeof value === 'string' && /^0[0-7]{3}$/.test(value);
const absoluteFilePath = (value: unknown): value is string =>
  typeof value === 'string' &&
  !/[\u0000-\u001f\u007f]/.test(value) &&
  (posix.isAbsolute(value) || win32.isAbsolute(value)) &&
  !value.split(/[/\\]/).includes('..');
function object(value: unknown): ObjectValue {
  insist(value && typeof value === 'object' && !Array.isArray(value));
  return value as ObjectValue;
}
function exact(value: unknown, keys: readonly string[]): ObjectValue {
  const v = object(value);
  insist(Object.keys(v).length === keys.length && keys.every((key) => Object.hasOwn(v, key)));
  return v;
}
function time(value: unknown): number {
  insist(typeof value === 'string' && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value));
  const n = Date.parse(value as string);
  insist(Number.isFinite(n));
  return n;
}
function window(v: ObjectValue, now: number): void {
  const start = time(v.recordedAt),
    end = time(v.expiresAt);
  insist(end > start);
  insist(start <= now && now < end, 'EVIDENCE_EXPIRED');
}
function json(path: string): { bytes: Buffer; value: ObjectValue } {
  const bytes = readCleanupBoundedFile(path, 1024 * 1024);
  return { bytes, value: object(decodeStrictJSON(bytes, 1024 * 1024)) };
}
const common = [
  'schema',
  'target',
  'workspaceId',
  'repository',
  'repositoryId',
  'recordedAt',
  'expiresAt',
];
function bound(v: ObjectValue, selected: Readonly<Record<string, string>>, now: number): void {
  insist(
    v.target === selected.target_distro &&
      v.workspaceId === selected.workspace_id &&
      v.repository ===
        `${selected.qualification_repository_owner}/${selected.qualification_repository_name}` &&
      v.repositoryId === selected.qualification_repository_numeric_id,
    'EVIDENCE_BINDING_MISMATCH',
  );
  window(v, now);
}
function selectedText(value: string | undefined): string {
  insist(typeof value === 'string');
  const decoded: unknown = value!.startsWith('"') ? JSON.parse(value!) : value;
  insist(typeof decoded === 'string');
  return decoded;
}

export interface UpgradeHostFile {
  path: string;
  state: 'present' | 'missing' | 'unreadable' | 'unverified';
  sha256: string | null;
  uid: number | null;
  gid: number | null;
  mode: string | null;
}
export interface ValidatedUpgradeEvidence {
  files: readonly UpgradeHostFile[];
  manifest: ReadonlyMap<string, string>;
  hashes: Readonly<Record<string, string>>;
  recordedAt: string;
  expiresAt: string;
}

/** Strict, read-only capture. A historical installation manifest is never an observation. */
export function validateUpgradeEvidence(input: {
  adminInputPath: string;
  hostInspectionPath: string;
  targetEvidence: CleanupHandoffTargetEvidence;
  candidateHead: string;
  manifestSHA256: string;
  now: number;
  selected: Readonly<Record<string, string>>;
  layout: readonly { path: string; mode: string }[];
}): ValidatedUpgradeEvidence {
  const { selected, now } = input;
  let role = 'adminInputPath';
  try {
    const admin = exact(json(input.adminInputPath).value, [
      ...common,
      'candidateHead',
      'manifestSHA256',
      'selected',
      'approvalStatus',
      'approvedBy',
      'approvedAt',
    ]);
    insist(
      admin.schema === UPGRADE_EVIDENCE_SCHEMAS.admin &&
        admin.candidateHead === input.candidateHead &&
        admin.manifestSHA256 === input.manifestSHA256,
    );
    bound(admin, selected, now);
    const supplied = object(admin.selected);
    insist(
      Object.keys(supplied).length === Object.keys(selected).length &&
        Object.entries(selected).every(([k, v]) => supplied[k] === v),
    );
    insist(admin.approvalStatus === 'DRAFT' || admin.approvalStatus === 'APPROVED');
    if (admin.approvalStatus === 'DRAFT')
      insist(admin.approvedBy === null && admin.approvedAt === null);
    else {
      insist(
        typeof admin.approvedBy === 'string' && /^github:[A-Za-z0-9-]+$/.test(admin.approvedBy),
      );
      insist(time(admin.approvedAt) <= now);
    }

    role = 'hostInspectionPath';
    const host = exact(json(input.hostInspectionPath).value, [
      ...common,
      'candidateHead',
      'manifestSHA256',
      'identities',
      'files',
      'process',
      'persistentState',
      'evidenceSHA256',
    ]);
    insist(
      host.schema === UPGRADE_EVIDENCE_SCHEMAS.host &&
        host.candidateHead === input.candidateHead &&
        host.manifestSHA256 === input.manifestSHA256,
    );
    bound(host, selected, now);
    const identities = exact(host.identities, [
      'broker',
      'agent',
      'principalId',
      'runtimeUid',
      'runId',
    ]);
    for (const role of ['broker', 'agent']) {
      const identity = exact(identities[role], ['uid', 'gid']);
      insist(
        identity.uid === Number(selected[`${role}_uid`]) &&
          identity.gid === Number(selected[`${role}_gid`]) &&
          Number.isSafeInteger(identity.uid) &&
          Number(identity.uid) > 0 &&
          Number.isSafeInteger(identity.gid) &&
          Number(identity.gid) > 0,
      );
    }
    insist(
      identities.principalId === selected.principal_id &&
        identities.runtimeUid === selected.runtime_uid_claim &&
        identities.runId === selected.run_id,
    );
    const process = exact(host.process, ['state', 'pid']);
    insist(
      (process.state === 'stopped' && process.pid === null) ||
        (process.state === 'running' &&
          Number.isSafeInteger(process.pid) &&
          Number(process.pid) > 0),
    );
    const state = exact(host.persistentState, [
      'state',
      'ledgerSHA256',
      'journalSHA256',
      'consistentBackupVerified',
    ]);
    insist(typeof state.consistentBackupVerified === 'boolean');
    insist(
      (state.state === 'inspected' && isHash(state.ledgerSHA256) && isHash(state.journalSHA256)) ||
        (state.state === 'absent' &&
          process.state === 'stopped' &&
          state.ledgerSHA256 === null &&
          state.journalSHA256 === null),
    );
    insist(Array.isArray(host.files) && host.files.length === input.layout.length);
    const seen = new Set<string>();
    const files = (host.files as unknown[]).map((raw) => {
      const file = exact(raw, ['path', 'state', 'sha256', 'uid', 'gid', 'mode']);
      const entry = input.layout.find((e) => e.path === file.path);
      insist(entry && !seen.has(String(file.path)));
      seen.add(String(file.path));
      if (file.state === 'present')
        // These are observed destination facts, not the permissions of this
        // safely opened evidence file. Drift must remain visible for a planned
        // fixed-layout repair; the file reader enforces input ownership/mode.
        insist(
          isHash(file.sha256) &&
            isObservedOwner(file.uid) &&
            isObservedOwner(file.gid) &&
            isObservedMode(file.mode),
        );
      else
        insist(
          typeof file.state === 'string' &&
            ['missing', 'unreadable', 'unverified'].includes(file.state) &&
            file.sha256 === null &&
            file.uid === null &&
            file.gid === null &&
            file.mode === null,
        );
      return Object.freeze({ ...file }) as unknown as UpgradeHostFile;
    });
    const claimed = exact(host.evidenceSHA256, UPGRADE_EVIDENCE_ROLES),
      hashes: Record<string, string> = {};
    const proof = new Map<string, ObjectValue>();
    for (const key of UPGRADE_EVIDENCE_ROLES) {
      role = key;
      const captured = json(input.targetEvidence[key]);
      hashes[key] = hash(captured.bytes);
      insist(isHash(claimed[key]) && hashes[key] === claimed[key], 'EVIDENCE_BINDING_MISMATCH');
      proof.set(key, captured.value);
    }
    role = 'installationManifestPath';
    const install = exact(proof.get('installationManifestPath'), ['schema', 'files', 'network']);
    insist(install.schema === 'openslack.cleanup_installation.v1' && Array.isArray(install.files));
    const network = exact(install.network, ['httpsProxy', 'noProxy']);
    insist(
      network.httpsProxy === selectedText(selected.approved_https_proxy) &&
        network.noProxy === selectedText(selected.approved_no_proxy),
    );
    const manifest = new Map<string, string>();
    for (const raw of install.files as unknown[]) {
      const file = exact(raw, ['path', 'sha256']);
      insist(
        absoluteFilePath(file.path) &&
          file.path.startsWith('/usr/lib/') &&
          !file.path.split('/').includes('..') &&
          !manifest.has(file.path) &&
          isHash(file.sha256),
      );
      manifest.set(file.path, file.sha256);
    }
    role = 'taskViewPath';
    const task = exact(proof.get('taskViewPath'), [
      'schema',
      'workspaceId',
      'repository',
      'repositoryId',
      'notBefore',
      'expiresAt',
      'tasks',
    ]);
    insist(
      task.schema === 'openslack.cleanup_task_view.v1' &&
        task.workspaceId === selected.workspace_id &&
        task.repository ===
          `${selected.qualification_repository_owner}/${selected.qualification_repository_name}` &&
        task.repositoryId === selected.qualification_repository_numeric_id &&
        time(task.notBefore) <= now &&
        now < time(task.expiresAt) &&
        Array.isArray(task.tasks),
    );
    const tasks = new Set<string>();
    for (const raw of task.tasks as unknown[]) {
      const t = exact(raw, ['taskId', 'issueNumber', 'state']);
      insist(
        typeof t.taskId === 'string' &&
          /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(t.taskId) &&
          !tasks.has(t.taskId) &&
          Number.isSafeInteger(t.issueNumber) &&
          Number(t.issueNumber) >= 0 &&
          typeof t.state === 'string' &&
          ['pending', 'active', 'claimed', 'blocked', 'done', 'cancelled'].includes(t.state),
      );
      tasks.add(String(t.taskId));
    }
    role = 'taskAttestationPath';
    const attestation = exact(proof.get('taskAttestationPath'), [
      ...common,
      'task_view_sha256',
      'complete',
    ]);
    insist(
      attestation.schema === UPGRADE_EVIDENCE_SCHEMAS.taskAttestation &&
        attestation.complete === true &&
        attestation.task_view_sha256 === hashes.taskViewPath,
    );
    bound(attestation, selected, now);
    role = 'appScopePath';
    const app = exact(proof.get('appScopePath'), [
      ...common,
      'appId',
      'installationId',
      'selectedRepositories',
      'permissions',
    ]);
    insist(
      app.schema === UPGRADE_EVIDENCE_SCHEMAS.appScope &&
        app.appId === Number(selected.deletion_app_id) &&
        app.installationId === Number(selected.deletion_app_installation_id),
    );
    bound(app, selected, now);
    insist(Array.isArray(app.selectedRepositories) && app.selectedRepositories.length === 1);
    const repository = exact((app.selectedRepositories as unknown[])[0], [
      'repository',
      'repositoryId',
    ]);
    insist(
      repository.repository === app.repository && repository.repositoryId === app.repositoryId,
    );
    const permissions = exact(app.permissions, ['contents', 'metadata', 'issues', 'pull_requests']);
    insist(
      permissions.contents === 'write' &&
        permissions.metadata === 'read' &&
        permissions.issues === 'read' &&
        permissions.pull_requests === 'read',
    );
    role = 'networkPath';
    const proxy = exact(proof.get('networkPath'), [
      ...common,
      'httpsProxy',
      'noProxy',
      'ownerAccount',
      'executablePath',
      'executableSHA256',
      'administratorConfirmed',
    ]);
    insist(
      proxy.schema === UPGRADE_EVIDENCE_SCHEMAS.network &&
        proxy.httpsProxy === network.httpsProxy &&
        proxy.noProxy === network.noProxy &&
        proxy.administratorConfirmed === true &&
        typeof proxy.ownerAccount === 'string' &&
        proxy.ownerAccount.length > 0 &&
        absoluteFilePath(proxy.executablePath) &&
        isHash(proxy.executableSHA256),
    );
    bound(proxy, selected, now);
    role = 'identityPath';
    const identity = exact(proof.get('identityPath'), [
      ...common,
      'agentId',
      'brokerId',
      'identities',
    ]);
    insist(
      identity.schema === UPGRADE_EVIDENCE_SCHEMAS.identity &&
        identity.agentId === selected.agent_id &&
        identity.brokerId === selected.broker_id,
    );
    bound(identity, selected, now);
    const selectedIdentity = exact(identity.identities, [
      'broker',
      'agent',
      'principalId',
      'runtimeUid',
      'runId',
    ]);
    for (const role of ['broker', 'agent']) {
      const observed = exact(selectedIdentity[role], ['uid', 'gid']),
        expected = object(identities[role]);
      insist(observed.uid === expected.uid && observed.gid === expected.gid);
    }
    insist(
      ['principalId', 'runtimeUid', 'runId'].every(
        (field) => selectedIdentity[field] === identities[field],
      ),
    );
    role = 'dependencyInventoryPath';
    const inventory = exact(proof.get('dependencyInventoryPath'), [...common, 'files']);
    insist(
      inventory.schema === UPGRADE_EVIDENCE_SCHEMAS.dependencies &&
        Array.isArray(inventory.files) &&
        inventory.files.length > 0,
    );
    bound(inventory, selected, now);
    const libraries = new Set<string>();
    for (const raw of inventory.files as unknown[]) {
      const file = exact(raw, ['path', 'sha256', 'uid', 'gid', 'mode']);
      insist(
        absoluteFilePath(file.path) &&
          /^\/(?:usr\/)?lib\//.test(file.path) &&
          !file.path.split('/').includes('..') &&
          !libraries.has(file.path) &&
          isHash(file.sha256) &&
          file.uid === 0 &&
          file.gid === 0 &&
          isMode(file.mode),
      );
      libraries.add(String(file.path));
    }
    return Object.freeze({
      files: Object.freeze(files),
      manifest,
      hashes: Object.freeze(hashes),
      recordedAt: String(host.recordedAt),
      expiresAt: String(host.expiresAt),
    });
  } catch (error) {
    throw new UpgradeEvidenceError(
      role,
      error instanceof CleanupFileBoundaryError
        ? error.code
        : error instanceof EvidenceValidationFailure
          ? error.message
          : 'EVIDENCE_INVALID',
    );
  }
}
