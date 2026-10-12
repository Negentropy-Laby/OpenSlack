import { cleanupEvidenceTimestamp, cleanupEvidenceWindow } from './internal/cleanup-time.js';
import {
  parseCleanupSelectedBindings,
  CleanupSelectedBindingsError,
} from './internal/cleanup-selected-bindings.js';
import { decodeStrictJSON } from '@openslack/core';
import {
  cleanupDocumentBytes as jsonBytes,
  cleanupByteDigest as hash,
} from './internal/cleanup-document-bytes.js';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import {
  verifyCleanupHandoffPackage,
  evaluateCleanupHandoffVerification,
  verifiedCleanupHandoffSnapshot,
  type CleanupHandoffTargetEvidence,
} from './cleanup-handoff.js';
import { CLEANUP_INSTALL_LAYOUT } from './cleanup-target-upgrade.js';
import {
  assertCleanupDescriptorSupport,
  CleanupDirectoryAnchor,
  CleanupCapturedFile,
  CleanupFileBoundaryError,
  inodeIdentity,
  readCleanupArtifactFile,
  readCleanupBoundedFile,
} from './internal/cleanup-file-boundary.js';
import {
  CLEANUP_HEAD,
  CLEANUP_IDENTIFIER,
  CLEANUP_SHA256,
  cleanupExactKeys,
  cleanupObject,
  isSensitiveCleanupInput,
} from './internal/cleanup-validation.js';
import {
  UPGRADE_EVIDENCE_ROLES,
  UPGRADE_EVIDENCE_SCHEMAS,
  UpgradeEvidenceError,
  validateCapturedUpgradeEvidence,
} from './internal/cleanup-upgrade-evidence.js';

export const CLEANUP_ADMIN_EVIDENCE_INPUT_SCHEMA = 'openslack.cleanup_admin_evidence_input.v1';
export interface CleanupEvidenceSource {
  path: string;
  sha256: string;
}
export interface CleanupEvidenceTargetSources {
  selectedBindings: CleanupEvidenceSource;
  observation: CleanupEvidenceSource;
  dependencyObservation: CleanupEvidenceSource;
  dependencyInventory: CleanupEvidenceSource;
  appScope?: CleanupEvidenceSource;
  network?: CleanupEvidenceSource;
  taskView?: CleanupEvidenceSource;
  taskAttestation?: CleanupEvidenceSource;
}
export interface PrepareCleanupTargetEvidenceDraftInput {
  schema: typeof CLEANUP_ADMIN_EVIDENCE_INPUT_SCHEMA;
  phase: 'target';
  candidateHead: string;
  outputDirectory: string;
  sources: CleanupEvidenceTargetSources;
  artifacts: readonly { artifact: string; source: CleanupEvidenceSource }[];
}
export interface PrepareCleanupPackageEvidenceDraftInput {
  schema: typeof CLEANUP_ADMIN_EVIDENCE_INPUT_SCHEMA;
  phase: 'package';
  candidateHead: string;
  outputDirectory: string;
  targetDraft: CleanupEvidenceSource;
  packageDirectory: string;
  /** SHA-256 of package SHA256SUMS, not of installation-manifest.DRAFT.json. */
  manifestSHA256: string;
}
export type PrepareCleanupEvidenceDraftInput =
  | PrepareCleanupTargetEvidenceDraftInput
  | PrepareCleanupPackageEvidenceDraftInput;
export interface CleanupEvidenceBlockingIssue {
  code: string;
  role: string;
}
export interface PrepareCleanupEvidenceDraftResult {
  schema: 'openslack.cleanup_admin_evidence_result.v1';
  phase: 'target' | 'package' | 'invalid';
  candidateHead: string;
  published: boolean;
  targetDraft?: CleanupEvidenceSource;
  targetEvidence?: CleanupHandoffTargetEvidence;
  adminInputPath?: string;
  hostInspectionPath?: string;
  sourceIndexPath?: string;
  installationManifestSHA256?: string;
  packageManifestSHA256?: string;
  blockingIssues: CleanupEvidenceBlockingIssue[];
  missingAdministratorDecisions: string[];
  approvalStatus: 'DRAFT';
  installationAuthorized: false;
  executionAuthorized: false;
}
type ObjectValue = Record<string, unknown>;
const MAX_EVIDENCE = 1024 * 1024;
const COMMON = [
  'schema',
  'target',
  'workspaceId',
  'repository',
  'repositoryId',
  'recordedAt',
  'expiresAt',
];
const METADATA = [
  'path',
  'state',
  'kind',
  'uid',
  'gid',
  'mode',
  'bytes',
  'nlink',
  'dev',
  'ino',
  'sha256',
  'reason',
];
const OBSERVATION_KEYS = [
  ...COMMON,
  'targetLabelSource',
  'bindingSource',
  'host',
  'observer',
  'identities',
  'directories',
  'files',
  'installedManifest',
  'process',
  'persistentState',
  'runtime',
  'locks',
  'neverStartedOfflineUpgrade',
  'dependencyInventory',
  'candidateBytesRead',
  'credentialContentsRead',
  'historyContentsRead',
  'manifestProduced',
  'approvalRecorded',
  'brokerStarted',
  'installationPerformed',
];
const DEPENDENCY_KEYS = [
  ...COMMON,
  'targetObservationSHA256',
  'frozenHelperSHA256',
  'scope',
  'installed',
  'brokerELF',
  'lddTool',
  'lddShell',
  'lddCalls',
  'aliases',
  'libraries',
  'count',
  'closureVerified',
  'productionInventory',
  'blockingReasons',
  'installationPerformed',
  'credentialContentsRead',
  'brokerStarted',
  'executorStarted',
  'approvalRecorded',
  'permitIssued',
  'targetBefore',
  'targetAfter',
];
const SOURCE_KEYS = [
  'selectedBindings',
  'observation',
  'dependencyObservation',
  'dependencyInventory',
  'appScope',
  'network',
  'taskView',
  'taskAttestation',
];
const ROLE_FILES = Object.freeze({
  installationManifestPath: 'installation-manifest.DRAFT.json',
  taskViewPath: 'task-view.json',
  taskAttestationPath: 'task-attestation.json',
  appScopePath: 'app-scope.json',
  networkPath: 'network.json',
  identityPath: 'identity.json',
  dependencyInventoryPath: 'dependency-inventory.json',
});
class EvidencePreparationFailure extends Error {
  constructor(
    readonly code: string,
    readonly role: string,
  ) {
    super(`${code} (${role}): stop; preserve existing evidence.`);
  }
}
function insist(condition: unknown, code: string, role: string): asserts condition {
  if (!condition) throw new EvidencePreparationFailure(code, role);
}
function exact(value: unknown, keys: readonly string[], role: string): ObjectValue {
  insist(cleanupObject(value) && cleanupExactKeys(value, keys), 'EVIDENCE_SCHEMA_INVALID', role);
  return value;
}
function list(value: unknown, role: string, max = 4096): unknown[] {
  insist(Array.isArray(value) && value.length <= max, 'EVIDENCE_SCHEMA_INVALID', role);
  return value;
}
function time(value: unknown, role: string): number {
  const parsed = cleanupEvidenceTimestamp(value);
  insist(parsed !== undefined, 'EVIDENCE_TIME_INVALID', role);
  return parsed;
}

function window(value: ObjectValue, now: number, role: string): { start: number; end: number } {
  const start = time(value.recordedAt ?? value.notBefore, role),
    end = time(value.expiresAt, role);
  insist(cleanupEvidenceWindow(start, end, now), 'EVIDENCE_EXPIRED', role);
  return { start, end };
}
function safePath(value: unknown, role: string): string {
  insist(
    typeof value === 'string' &&
      isAbsolute(value) &&
      !/[\u0000-\u001f\u007f]/.test(value) &&
      !value.split('/').includes('..') &&
      !isSensitiveCleanupInput(value) &&
      !/^\/(?:etc|run|proc|sys|dev)(?:\/|$)/.test(value) &&
      !/^\/(?:usr\/lib|var\/lib)\/openslack-cleanup(?:\/|$)/.test(value),
    'EVIDENCE_PATH_UNSAFE',
    role,
  );
  return resolve(value);
}
function source(value: unknown, role: string): CleanupEvidenceSource {
  const v = exact(value, ['path', 'sha256'], role);
  const path = safePath(v.path, role);
  insist(
    typeof v.sha256 === 'string' && CLEANUP_SHA256.test(v.sha256),
    'EVIDENCE_INPUT_INVALID',
    role,
  );
  return { path, sha256: v.sha256 };
}
function decode(raw: Buffer, role: string): ObjectValue {
  try {
    const v: unknown = decodeStrictJSON(raw, MAX_EVIDENCE);
    insist(cleanupObject(v), 'EVIDENCE_SCHEMA_INVALID', role);
    return v;
  } catch (error) {
    if (error instanceof EvidencePreparationFailure) throw error;
    throw new EvidencePreparationFailure('EVIDENCE_JSON_INVALID', role);
  }
}
class EvidenceCaptures {
  private readonly entries = new Map<
    string,
    { file: CleanupCapturedFile; raw?: Buffer; sha256?: string }
  >();
  private held(ref: CleanupEvidenceSource, role: string, bound = MAX_EVIDENCE, artifact = false) {
    const path = safePath(ref.path, role),
      key = `${artifact}:${bound}:${path}`;
    let entry = this.entries.get(key);
    if (!entry) {
      const file = CleanupCapturedFile.open(
        path,
        bound,
        artifact ? 'artifact' : 'runtime-evidence',
      );
      entry = { file };
      this.entries.set(key, entry);
    }
    entry.file.verify();
    return entry;
  }
  read(ref: CleanupEvidenceSource, role: string): Buffer {
    const entry = this.held(ref, role);
    const raw = (entry.raw ??= entry.file.read());
    const digest = (entry.sha256 ??= hash(raw));
    insist(digest === ref.sha256, 'EVIDENCE_DIGEST_MISMATCH', role);
    return raw;
  }
  artifact(ref: CleanupEvidenceSource, role: string, bound: number): string {
    const entry = this.held(ref, role, bound, true);
    const digest = (entry.sha256 ??= entry.file.digest().sha256);
    insist(digest === ref.sha256, 'EVIDENCE_DIGEST_MISMATCH', role);
    return digest;
  }
  verify(): void {
    for (const entry of this.entries.values()) entry.file.verify();
  }
  close(primary?: unknown): void {
    let failure: unknown;
    for (const entry of [...this.entries.values()].reverse()) {
      try {
        entry.file.close(primary);
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) throw failure;
  }
}

function parseRecipe(value: unknown): PrepareCleanupEvidenceDraftInput {
  insist(cleanupObject(value), 'EVIDENCE_INPUT_INVALID', 'input');
  const keys =
    value.phase === 'target'
      ? ['schema', 'phase', 'candidateHead', 'outputDirectory', 'sources', 'artifacts']
      : [
          'schema',
          'phase',
          'candidateHead',
          'outputDirectory',
          'targetDraft',
          'packageDirectory',
          'manifestSHA256',
        ];
  insist(
    cleanupExactKeys(value, keys) &&
      value.schema === CLEANUP_ADMIN_EVIDENCE_INPUT_SCHEMA &&
      (value.phase === 'target' || value.phase === 'package') &&
      typeof value.candidateHead === 'string' &&
      CLEANUP_HEAD.test(value.candidateHead),
    'EVIDENCE_INPUT_INVALID',
    'input',
  );
  safePath(value.outputDirectory, 'outputDirectory');
  if (value.phase === 'target') {
    insist(
      cleanupObject(value.sources) &&
        Object.keys(value.sources).every((v) => SOURCE_KEYS.includes(v)),
      'EVIDENCE_INPUT_INVALID',
      'sources',
    );
    for (const [key, ref] of Object.entries(value.sources)) source(ref, key);
    const artifacts = list(value.artifacts, 'artifacts', CLEANUP_INSTALL_LAYOUT.length);
    const seen = new Set<string>();
    for (const raw of artifacts) {
      const entry = exact(raw, ['artifact', 'source'], 'artifacts');
      insist(
        typeof entry.artifact === 'string' &&
          CLEANUP_INSTALL_LAYOUT.some((v) => v.artifact === entry.artifact) &&
          !seen.has(entry.artifact),
        'EVIDENCE_INPUT_INVALID',
        'artifacts',
      );
      seen.add(entry.artifact);
      source(entry.source, entry.artifact);
    }
    insist(seen.size === CLEANUP_INSTALL_LAYOUT.length, 'EVIDENCE_INPUT_INVALID', 'artifacts');
  } else {
    source(value.targetDraft, 'targetDraft');
    safePath(value.packageDirectory, 'packageDirectory');
    insist(
      typeof value.manifestSHA256 === 'string' && CLEANUP_SHA256.test(value.manifestSHA256),
      'EVIDENCE_INPUT_INVALID',
      'manifestSHA256',
    );
  }
  return value as unknown as PrepareCleanupEvidenceDraftInput;
}
/** Strict recipe capture. The clock is always the real process clock. */
export function readCleanupEvidenceDraftInput(path: string): PrepareCleanupEvidenceDraftInput {
  return parseRecipe(
    decode(readCleanupBoundedFile(safePath(path, 'input'), MAX_EVIDENCE), 'input'),
  );
}
function selection(raw: Buffer, head: string): Readonly<Record<string, string>> {
  let chosen: Readonly<Record<string, string>>;
  try {
    chosen = parseCleanupSelectedBindings(raw, MAX_EVIDENCE, head).selected;
  } catch (error) {
    const code =
      error instanceof CleanupSelectedBindingsError
        ? {
            JSON: 'EVIDENCE_JSON_INVALID',
            SCHEMA: 'EVIDENCE_SCHEMA_INVALID',
            PRIOR: 'EVIDENCE_PRIOR_APPROVAL_INVALID',
            SELECTED: 'EVIDENCE_SELECTED_INVALID',
            CANDIDATE: 'EVIDENCE_CANDIDATE_MISMATCH',
          }[error.reason]
        : 'EVIDENCE_SCHEMA_INVALID';
    throw new EvidencePreparationFailure(code, 'selectedBindings');
  }
  for (const key of [
    'target_distro',
    'agent_id',
    'broker_id',
    'principal_id',
    'runtime_uid_claim',
    'run_id',
    'issuer_trust_domain',
    'workspace_id',
    'allowed_git_remote_name',
    'qualification_repository_owner',
    'qualification_repository_name',
    'qualification_repository_numeric_id',
    'qualification_repository_default_branch',
    'automatic_branch_deletion',
    'deletion_app_id',
    'deletion_app_installation_id',
    'approved_https_proxy',
    'approved_no_proxy',
    'broker_uid',
    'broker_gid',
    'agent_uid',
    'agent_gid',
  ])
    insist(
      typeof chosen[key] === 'string' &&
        (chosen[key] !== '' || key === 'approved_no_proxy') &&
        !/^REQUIRED(?:_|$)/.test(chosen[key]!),
      'EVIDENCE_BINDING_MISSING',
      key,
    );
  for (const key of ['agent_id', 'broker_id', 'run_id', 'workspace_id', 'allowed_git_remote_name'])
    insist(CLEANUP_IDENTIFIER.test(chosen[key]!), 'EVIDENCE_BINDING_INVALID', key);
  for (const key of [
    'broker_uid',
    'broker_gid',
    'agent_uid',
    'agent_gid',
    'qualification_repository_numeric_id',
    'deletion_app_id',
    'deletion_app_installation_id',
  ])
    insist(
      /^[1-9][0-9]*$/.test(chosen[key]!) && Number.isSafeInteger(Number(chosen[key])),
      'EVIDENCE_BINDING_INVALID',
      key,
    );
  insist(
    chosen.qualification_repository_default_branch === 'main' &&
      chosen.automatic_branch_deletion === 'false' &&
      chosen.broker_uid !== chosen.agent_uid,
    'EVIDENCE_BINDING_INVALID',
    'selectedBindings',
  );
  const normalized = {
    ...chosen,
    candidate_head: head,
    approval_status: 'DRAFT',
    approved_by: 'REQUIRED',
    approved_at_utc: 'REQUIRED',
  };
  delete (normalized as Record<string, string>).package_manifest_sha256;
  return Object.freeze(normalized);
}
function bound(
  v: ObjectValue,
  selected: Readonly<Record<string, string>>,
  now: number,
  role: string,
): { start: number; end: number } {
  insist(
    v.target === selected.target_distro &&
      v.workspaceId === selected.workspace_id &&
      v.repository ===
        `${selected.qualification_repository_owner}/${selected.qualification_repository_name}` &&
      v.repositoryId === selected.qualification_repository_numeric_id,
    'EVIDENCE_BINDING_MISMATCH',
    role,
  );
  return window(v, now, role);
}
function metadata(raw: unknown, role: string): ObjectValue {
  return exact(raw, METADATA, role);
}
function equal(a: unknown, b: unknown): boolean {
  if (cleanupObject(a) && cleanupObject(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((k) => Object.hasOwn(b, k) && equal(a[k], b[k]))
    );
  }
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((v, i) => equal(v, b[i]));
  return a === b;
}
function observedIdentities(
  raw: unknown,
  selected: Readonly<Record<string, string>>,
  role: string,
): ObjectValue {
  const identities = exact(raw, ['broker', 'agent'], role);
  for (const key of ['broker', 'agent'] as const) {
    const v = exact(identities[key], ['state', 'name', 'uid', 'gid', 'shell', 'groupIds'], role);
    insist(
      v.state === 'present' &&
        v.uid === Number(selected[`${key}_uid`]) &&
        v.gid === Number(selected[`${key}_gid`]) &&
        typeof v.name === 'string' &&
        v.name.length > 0 &&
        v.shell === '/usr/sbin/nologin' &&
        equal(v.groupIds, [v.gid]),
      'EVIDENCE_IDENTITY_MISMATCH',
      role,
    );
  }
  return identities;
}
function stoppedProcess(raw: unknown, role: string): ObjectValue {
  const v = exact(
    raw,
    ['state', 'pid', 'pids', 'uninspectableCount', 'argumentsRead', 'environmentRead'],
    role,
  );
  insist(
    v.state === 'stopped' &&
      v.pid === null &&
      equal(v.pids, []) &&
      v.uninspectableCount === 0 &&
      v.argumentsRead === false &&
      v.environmentRead === false,
    'EVIDENCE_PROCESS_UNVERIFIED',
    role,
  );
  return v;
}
function noLocks(raw: unknown, role: string): ObjectValue {
  const v = exact(raw, ['state', 'matchedLocks', 'scope'], role);
  insist(
    v.state === 'none-observed' && equal(v.matchedLocks, []) && typeof v.scope === 'string',
    'EVIDENCE_LOCKS_UNVERIFIED',
    role,
  );
  return v;
}
function missingMetadata(raw: unknown, path: string, role: string): void {
  const v = metadata(raw, role);
  insist(
    v.path === path &&
      v.state === 'missing' &&
      ['kind', 'uid', 'gid', 'mode', 'bytes', 'nlink', 'dev', 'ino', 'sha256'].every(
        (k) => v[k] === null,
      ) &&
      v.reason === 'ENOENT',
    'EVIDENCE_HISTORY_REQUIRES_REVIEW',
    role,
  );
}
function observation(
  raw: Buffer,
  selected: Readonly<Record<string, string>>,
  now: number,
): ObjectValue {
  const role = 'observation',
    v = exact(decode(raw, role), OBSERVATION_KEYS, role);
  insist(
    v.schema === 'openslack.cleanup_target_observation.v1' &&
      typeof v.targetLabelSource === 'string' &&
      typeof v.bindingSource === 'string',
    'EVIDENCE_SCHEMA_INVALID',
    role,
  );
  bound(v, selected, now, role);
  const host = exact(v.host, ['hostname', 'kernel', 'arch', 'system'], role),
    observer = exact(v.observer, ['uid', 'gid'], role);
  insist(
    host.system === 'Linux' &&
      host.arch === 'x86_64' &&
      typeof host.hostname === 'string' &&
      typeof host.kernel === 'string' &&
      observer.uid === 0 &&
      observer.gid === 0,
    'EVIDENCE_HOST_UNVERIFIED',
    role,
  );
  observedIdentities(v.identities, selected, role);
  stoppedProcess(v.process, role);
  noLocks(v.locks, role);
  const files = list(v.files, role, 6);
  insist(files.length === 6, 'EVIDENCE_FILE_SET_INVALID', role);
  const seen = new Set<string>();
  for (const rawFile of files) {
    const f = metadata(rawFile, role);
    insist(
      typeof f.path === 'string' &&
        CLEANUP_INSTALL_LAYOUT.some((e) => e.path === f.path) &&
        !seen.has(f.path) &&
        f.state === 'present' &&
        f.kind === 'regular' &&
        f.uid === 0 &&
        f.gid === 0 &&
        f.nlink === 1 &&
        Number.isSafeInteger(f.bytes) &&
        Number(f.bytes) > 0 &&
        typeof f.mode === 'string' &&
        /^0[0-7]{3}$/.test(f.mode) &&
        (parseInt(f.mode, 8) & 0o022) === 0 &&
        typeof f.sha256 === 'string' &&
        CLEANUP_SHA256.test(f.sha256) &&
        typeof f.dev === 'string' &&
        typeof f.ino === 'string' &&
        f.reason === null,
      'EVIDENCE_INSTALLED_FILE_UNVERIFIED',
      role,
    );
    seen.add(f.path);
  }
  const dirs = list(v.directories, role, 5);
  const expectedDirs = [
    '/etc/openslack-cleanup',
    '/etc/openslack-cleanup/credentials',
    '/usr/lib/openslack-cleanup',
    '/run/openslack-cleanup',
    '/var/lib/openslack-cleanup',
  ];
  insist(dirs.length === expectedDirs.length, 'EVIDENCE_DIRECTORY_UNVERIFIED', role);
  const checked = new Set<string>();
  for (const item of dirs) {
    const d = metadata(item, role);
    insist(
      typeof d.path === 'string' && expectedDirs.includes(d.path) && !checked.has(d.path),
      'EVIDENCE_DIRECTORY_UNVERIFIED',
      role,
    );
    checked.add(d.path);
    if (d.path === '/run/openslack-cleanup' && d.state === 'missing') {
      missingMetadata(d, d.path, role);
      continue;
    }
    const broker = d.path === '/var/lib/openslack-cleanup' || d.path === '/run/openslack-cleanup';
    const mode = d.path.startsWith('/etc/')
      ? '0750'
      : d.path === '/var/lib/openslack-cleanup'
        ? '0700'
        : '0755';
    insist(
      d.state === 'present' &&
        d.kind === 'directory' &&
        d.uid === (broker ? Number(selected.broker_uid) : 0) &&
        d.gid === (d.path === '/usr/lib/openslack-cleanup' ? 0 : Number(selected.broker_gid)) &&
        d.mode === mode &&
        d.sha256 === null,
      'EVIDENCE_DIRECTORY_UNVERIFIED',
      role,
    );
  }
  const manifest = exact(v.installedManifest, ['observation', 'contentsRead', 'scope'], role);
  insist(
    manifest.contentsRead === false && typeof manifest.scope === 'string',
    'EVIDENCE_SCHEMA_INVALID',
    role,
  );
  metadata(manifest.observation, role);
  const history = exact(
    v.persistentState,
    ['state', 'objects', 'directoryEntryCount', 'ledgerSHA256', 'journalSHA256', 'contentsRead'],
    role,
  );
  insist(
    history.state === 'absent' &&
      history.directoryEntryCount === 0 &&
      history.ledgerSHA256 === null &&
      history.journalSHA256 === null &&
      history.contentsRead === false,
    'EVIDENCE_HISTORY_REQUIRES_REVIEW',
    role,
  );
  const objects = list(history.objects, role, 3);
  insist(objects.length === 3, 'EVIDENCE_HISTORY_REQUIRES_REVIEW', role);
  const historyPaths = ['ledger.jsonl', 'workers.jsonl', 'instance.json'].map(
    (p) => '/var/lib/openslack-cleanup/' + p,
  );
  for (const path of historyPaths) {
    const item = objects.find((o) => cleanupObject(o) && o.path === path);
    missingMetadata(item, path, role);
  }
  const runtime = exact(v.runtime, ['socket', 'directoryEntryCount'], role);
  insist(runtime.directoryEntryCount === 0, 'EVIDENCE_RUNTIME_UNVERIFIED', role);
  missingMetadata(runtime.socket, '/run/openslack-cleanup/broker.sock', role);
  const offline = exact(
    v.neverStartedOfflineUpgrade,
    ['eligible', 'blockingReasons', 'scope'],
    role,
  );
  insist(
    offline.eligible === true &&
      equal(offline.blockingReasons, []) &&
      typeof offline.scope === 'string',
    'EVIDENCE_HOST_UNVERIFIED',
    role,
  );
  exact(v.dependencyInventory, ['state', 'files', 'count', 'closureVerified'], role);
  for (const field of [
    'candidateBytesRead',
    'credentialContentsRead',
    'historyContentsRead',
    'manifestProduced',
    'approvalRecorded',
    'brokerStarted',
    'installationPerformed',
  ])
    insist(v[field] === false, 'EVIDENCE_SOURCE_SIDE_EFFECTS', role);
  return v;
}
function elf(raw: unknown, role: string): ObjectValue {
  const v = exact(raw, ['kind', 'interpreter', 'needed', 'soname', 'elfClass', 'machine'], role);
  insist(
    v.elfClass === 64 &&
      v.machine === 62 &&
      (v.kind === 'static' || v.kind === 'dynamic') &&
      (v.interpreter === null || typeof v.interpreter === 'string') &&
      (v.soname === null || typeof v.soname === 'string') &&
      list(v.needed, role).every((n) => typeof n === 'string'),
    'EVIDENCE_DEPENDENCY_PROVENANCE_INVALID',
    role,
  );
  return v;
}
function aliasLink(raw: unknown, role: string): ObjectValue {
  const v = exact(
    raw,
    ['path', 'target', 'dev', 'ino', 'uid', 'gid', 'mode', 'mtimeNs', 'ctimeNs'],
    role,
  );
  insist(
    typeof v.path === 'string' &&
      v.path.startsWith('/') &&
      typeof v.target === 'string' &&
      v.target.length > 0 &&
      !/[\u0000-\u0020\u007f]/.test(v.target) &&
      v.uid === 0 &&
      v.gid === 0 &&
      typeof v.dev === 'string' &&
      typeof v.ino === 'string' &&
      typeof v.mode === 'string' &&
      /^0[0-7]{3}$/.test(v.mode) &&
      typeof v.mtimeNs === 'number' &&
      Number.isInteger(v.mtimeNs) &&
      v.mtimeNs >= 0 &&
      typeof v.ctimeNs === 'number' &&
      Number.isInteger(v.ctimeNs) &&
      v.ctimeNs >= 0,
    'EVIDENCE_DEPENDENCY_PROVENANCE_INVALID',
    role,
  );
  return v;
}
function aliasResolution(raw: unknown, role: string): ObjectValue {
  const v = exact(raw, ['alias', 'canonicalPath', 'links'], role);
  insist(
    typeof v.alias === 'string' &&
      v.alias.startsWith('/') &&
      typeof v.canonicalPath === 'string' &&
      v.canonicalPath.startsWith('/usr/lib/') &&
      !v.canonicalPath.split('/').includes('..'),
    'EVIDENCE_DEPENDENCY_PROVENANCE_INVALID',
    role,
  );
  for (const link of list(v.links, role, 40)) aliasLink(link, role);
  return v;
}
function dependencyProof(
  raw: Buffer,
  inventoryRaw: Buffer,
  host: ObjectValue,
  hostHash: string,
  selected: Readonly<Record<string, string>>,
  now: number,
  inventory: ObjectValue,
): ObjectValue {
  const role = 'dependencyObservation',
    v = exact(decode(raw, role), DEPENDENCY_KEYS, role);
  insist(
    v.schema === 'openslack.cleanup_installed_dependency_observation.v1',
    'EVIDENCE_SCHEMA_INVALID',
    role,
  );
  bound(v, selected, now, role);
  exact(inventory, [...COMMON, 'files'], 'dependencyInventory');
  bound(inventory, selected, now, 'dependencyInventory');
  const proof = exact(v.productionInventory, ['schema', 'sha256', 'bytes', 'fileCount'], role);
  const files = list(inventory.files, role);
  insist(
    v.targetObservationSHA256 === hostHash &&
      typeof v.frozenHelperSHA256 === 'string' &&
      CLEANUP_SHA256.test(v.frozenHelperSHA256) &&
      typeof v.scope === 'string' &&
      v.closureVerified === true &&
      equal(v.blockingReasons, []) &&
      proof.schema === UPGRADE_EVIDENCE_SCHEMAS.dependencies &&
      proof.sha256 === hash(inventoryRaw) &&
      proof.bytes === inventoryRaw.length &&
      proof.fileCount === files.length &&
      v.count === files.length &&
      files.length > 0 &&
      v.recordedAt === inventory.recordedAt &&
      v.expiresAt === inventory.expiresAt,
    'EVIDENCE_DEPENDENCY_PROVENANCE_INVALID',
    role,
  );
  for (const k of [
    'installationPerformed',
    'credentialContentsRead',
    'brokerStarted',
    'executorStarted',
    'approvalRecorded',
    'permitIssued',
  ])
    insist(v[k] === false, 'EVIDENCE_SOURCE_SIDE_EFFECTS', role);
  const broker = elf(v.brokerELF, role);
  insist(
    broker.kind === 'static' && broker.interpreter === null && equal(broker.needed, []),
    'EVIDENCE_DEPENDENCY_PROVENANCE_INVALID',
    role,
  );
  const installed = list(v.installed, role, 6);
  insist(installed.length === 6, 'EVIDENCE_DEPENDENCY_PROVENANCE_INVALID', role);
  const seen = new Set<string>();
  for (const item of installed) {
    const pair = exact(item, ['before', 'after'], role),
      before = metadata(pair.before, role);
    metadata(pair.after, role);
    const expected = (host.files as ObjectValue[]).find((f) => f.path === before.path);
    insist(
      expected &&
        typeof before.path === 'string' &&
        !seen.has(before.path) &&
        equal(pair.before, pair.after) &&
        equal(pair.before, expected),
      'EVIDENCE_INSTALLED_BINDING_MISMATCH',
      role,
    );
    seen.add(before.path);
  }
  const libraries = list(v.libraries, role);
  insist(libraries.length === files.length, 'EVIDENCE_DEPENDENCY_PROVENANCE_INVALID', role);
  const libraryPaths = new Set<string>();
  for (const item of libraries) {
    const pair = exact(item, ['before', 'after', 'elf'], role),
      after = metadata(pair.after, role);
    metadata(pair.before, role);
    elf(pair.elf, role);
    const file = files.find((f) => cleanupObject(f) && f.path === after.path);
    insist(
      typeof after.path === 'string' &&
        !libraryPaths.has(after.path) &&
        equal(pair.before, pair.after) &&
        after.state === 'present' &&
        after.kind === 'regular' &&
        after.nlink === 1 &&
        after.reason === null &&
        cleanupObject(file) &&
        equal(file, {
          path: after.path,
          sha256: after.sha256,
          uid: after.uid,
          gid: after.gid,
          mode: after.mode,
        }),
      'EVIDENCE_DEPENDENCY_PROVENANCE_INVALID',
      role,
    );
    libraryPaths.add(after.path);
  }
  const ldd = exact(v.lddTool, ['before', 'after'], role);
  const lddFile = metadata(ldd.before, role);
  metadata(ldd.after, role);
  insist(
    equal(ldd.before, ldd.after) &&
      lddFile.path === '/usr/bin/ldd' &&
      lddFile.uid === 0 &&
      lddFile.gid === 0 &&
      lddFile.state === 'present' &&
      lddFile.kind === 'regular' &&
      lddFile.nlink === 1,
    'EVIDENCE_DEPENDENCY_PROVENANCE_INVALID',
    role,
  );
  const shell = exact(
    v.lddShell,
    ['resolution', 'before', 'after', 'elf', 'interpreterResolution'],
    role,
  );
  const shellFile = metadata(shell.before, role);
  metadata(shell.after, role);
  elf(shell.elf, role);
  insist(
    equal(shell.before, shell.after) &&
      shellFile.path === '/usr/bin/bash' &&
      shellFile.uid === 0 &&
      shellFile.gid === 0 &&
      shellFile.state === 'present' &&
      shellFile.kind === 'regular' &&
      shellFile.nlink === 1,
    'EVIDENCE_DEPENDENCY_PROVENANCE_INVALID',
    role,
  );
  const shellResolution = exact(shell.resolution, ['shebang', 'canonicalPath', 'alias'], role);
  insist(
    (shellResolution.shebang === '/bin/bash' || shellResolution.shebang === '/usr/bin/bash') &&
      shellResolution.canonicalPath === '/usr/bin/bash',
    'EVIDENCE_DEPENDENCY_PROVENANCE_INVALID',
    role,
  );
  if (shellResolution.alias !== null) aliasLink(shellResolution.alias, role);
  aliasResolution(shell.interpreterResolution, role);
  for (const resolution of list(v.aliases, role)) aliasResolution(resolution, role);
  const calls = list(v.lddCalls, role, 4),
    inputs = CLEANUP_INSTALL_LAYOUT.filter((f) =>
      ['node', 'git', 'sh', 'git-remote-https'].includes(f.artifact),
    ).map((f) => f.path);
  insist(calls.length === 4, 'EVIDENCE_DEPENDENCY_PROVENANCE_INVALID', role);
  const called = new Set<string>();
  for (const call of calls) {
    const c = exact(
      call,
      [
        'input',
        'installedSHA256',
        'elf',
        'argv',
        'environment',
        'cwd',
        'status',
        'signal',
        'timedOut',
        'truncated',
        'spawnError',
        'commandError',
        'encodingValid',
        'stdout',
        'stderr',
        'stdoutHex',
        'stderrHex',
        'elapsedMs',
      ],
      role,
    );
    elf(c.elf, role);
    insist(
      typeof c.input === 'string' &&
        (inputs as readonly string[]).includes(c.input) &&
        !called.has(c.input) &&
        c.installedSHA256 ===
          (host.files as ObjectValue[]).find((f) => f.path === c.input)?.sha256 &&
        equal(c.argv, ['/usr/bin/ldd', '--', c.input]) &&
        equal(c.environment, { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }) &&
        c.cwd === '/' &&
        c.status === 0 &&
        c.signal === null &&
        c.timedOut === false &&
        c.truncated === false &&
        c.encodingValid === true &&
        c.stderr === '' &&
        c.stderrHex === '' &&
        c.spawnError === null &&
        c.commandError === null &&
        typeof c.stdout === 'string' &&
        c.stdoutHex === Buffer.from(c.stdout, 'utf8').toString('hex') &&
        typeof c.elapsedMs === 'number' &&
        Number.isFinite(c.elapsedMs) &&
        c.elapsedMs >= 0,
      'EVIDENCE_DEPENDENCY_PROVENANCE_INVALID',
      role,
    );
    called.add(c.input);
  }
  const before = exact(
      v.targetBefore,
      ['identities', 'process', 'history', 'entryCounts', 'locks'],
      role,
    ),
    after = exact(
      v.targetAfter,
      ['identities', 'process', 'history', 'entryCounts', 'locks'],
      role,
    );
  insist(
    equal(before, after) &&
      equal(before.identities, host.identities) &&
      equal(before.process, host.process) &&
      equal(before.history, (host.persistentState as ObjectValue).objects) &&
      equal(before.entryCounts, { '/var/lib/openslack-cleanup': 0, '/run/openslack-cleanup': 0 }) &&
      equal(before.locks, host.locks),
    'EVIDENCE_TARGET_CHANGED',
    role,
  );
  return v;
}
interface TargetCapture {
  input: PrepareCleanupTargetEvidenceDraftInput;
  selected: Readonly<Record<string, string>>;
  host: ObjectValue;
  evidence: ReadonlyMap<string, Buffer>;
  recordedAt: string;
  expiresAt: string;
  sourceDigests: Readonly<Record<string, string>>;
}
function normalizedIdentities(selected: Readonly<Record<string, string>>) {
  return {
    broker: { uid: Number(selected.broker_uid), gid: Number(selected.broker_gid) },
    agent: { uid: Number(selected.agent_uid), gid: Number(selected.agent_gid) },
    principalId: selected.principal_id,
    runtimeUid: selected.runtime_uid_claim,
    runId: selected.run_id,
  };
}
function common(selected: Readonly<Record<string, string>>, recordedAt: string, expiresAt: string) {
  return {
    target: selected.target_distro,
    workspaceId: selected.workspace_id,
    repository: `${selected.qualification_repository_owner}/${selected.qualification_repository_name}`,
    repositoryId: selected.qualification_repository_numeric_id,
    recordedAt,
    expiresAt,
  };
}
function adminAndHost(captured: TargetCapture, packageDigest: string) {
  const c = common(captured.selected, captured.recordedAt, captured.expiresAt);
  const admin = {
    schema: UPGRADE_EVIDENCE_SCHEMAS.admin,
    ...c,
    candidateHead: captured.input.candidateHead,
    manifestSHA256: packageDigest,
    selected: captured.selected,
    approvalStatus: 'DRAFT',
    approvedBy: null,
    approvedAt: null,
  };
  const host = {
    schema: UPGRADE_EVIDENCE_SCHEMAS.host,
    ...c,
    candidateHead: captured.input.candidateHead,
    manifestSHA256: packageDigest,
    identities: normalizedIdentities(captured.selected),
    files: (captured.host.files as ObjectValue[]).map((f) => ({
      path: f.path,
      state: f.state,
      sha256: f.sha256,
      uid: f.uid,
      gid: f.gid,
      mode: f.mode,
    })),
    process: { state: 'stopped', pid: null },
    persistentState: {
      state: 'absent',
      ledgerSHA256: null,
      journalSHA256: null,
      consistentBackupVerified: false,
    },
    evidenceSHA256: Object.fromEntries(
      [...captured.evidence].map(([role, raw]) => [role, hash(raw)]),
    ),
  };
  return { admin, host };
}
function validatePrepared(captured: TargetCapture, packageDigest: string, now: number) {
  const { admin, host } = adminAndHost(captured, packageDigest);
  const targetEvidence = Object.fromEntries(
    UPGRADE_EVIDENCE_ROLES.map((role) => [role, role]),
  ) as unknown as CleanupHandoffTargetEvidence;
  const bytes = new Map(captured.evidence);
  bytes.set('admin', jsonBytes(admin));
  bytes.set('host', jsonBytes(host));
  validateCapturedUpgradeEvidence(
    {
      adminInputPath: 'admin',
      hostInspectionPath: 'host',
      targetEvidence,
      candidateHead: captured.input.candidateHead,
      manifestSHA256: packageDigest,
      now,
      selected: captured.selected,
      layout: CLEANUP_INSTALL_LAYOUT,
    },
    bytes,
  );
  return { admin, host };
}
function captureTarget(
  input: PrepareCleanupTargetEvidenceDraftInput,
  now: number,
  context: EvidenceCaptures,
): TargetCapture {
  const sources = input.sources as unknown as Record<string, CleanupEvidenceSource | undefined>,
    captured = new Map<string, Buffer>();
  for (const role of SOURCE_KEYS) {
    const ref = sources[role];
    insist(ref !== undefined, 'EVIDENCE_SOURCE_MISSING', role);
    captured.set(role, context.read(source(ref, role), role));
  }
  const selected = selection(captured.get('selectedBindings')!, input.candidateHead),
    host = observation(captured.get('observation')!, selected, now),
    inventory = decode(captured.get('dependencyInventory')!, 'dependencyInventory');
  const dependency = dependencyProof(
    captured.get('dependencyObservation')!,
    captured.get('dependencyInventory')!,
    host,
    hash(captured.get('observation')!),
    selected,
    now,
    inventory,
  );
  const times = [
    bound(host, selected, now, 'observation'),
    bound(dependency, selected, now, 'dependencyObservation'),
  ];
  for (const role of ['appScope', 'network', 'taskAttestation'])
    times.push(bound(decode(captured.get(role)!, role), selected, now, role));
  const task = decode(captured.get('taskView')!, 'taskView');
  times.push(window(task, now, 'taskView'));
  times.push(bound(inventory, selected, now, 'dependencyInventory'));
  const recordedAt = new Date(Math.max(...times.map((t) => t.start))).toISOString(),
    expiresAt = new Date(Math.min(...times.map((t) => t.end))).toISOString();
  const files = list(inventory.files, 'dependencyInventory').map((f) =>
    exact(f, ['path', 'sha256', 'uid', 'gid', 'mode'], 'dependencyInventory'),
  );
  const destinations = new Set<string>(CLEANUP_INSTALL_LAYOUT.map((e) => e.path));
  const plannedFiles: { path: string; sha256: string }[] = [];
  for (const entry of CLEANUP_INSTALL_LAYOUT) {
    const artifact = input.artifacts.find((v) => v.artifact === entry.artifact)!;
    const digest = context.artifact(
      source(artifact.source, entry.artifact),
      entry.artifact,
      entry.maxBytes,
    );
    plannedFiles.push({ path: entry.path, sha256: digest });
  }
  for (const file of files) {
    insist(
      typeof file.path === 'string' && !destinations.has(file.path),
      'EVIDENCE_FILE_SET_INVALID',
      'dependencyInventory',
    );
    destinations.add(file.path);
    plannedFiles.push({ path: file.path, sha256: String(file.sha256) });
  }
  const network = decode(captured.get('network')!, 'network');
  const manifest = {
    schema: 'openslack.cleanup_installation.v1',
    files: plannedFiles,
    network: { httpsProxy: network.httpsProxy, noProxy: network.noProxy },
  };
  const identity = {
    schema: UPGRADE_EVIDENCE_SCHEMAS.identity,
    ...common(selected, recordedAt, expiresAt),
    agentId: selected.agent_id,
    brokerId: selected.broker_id,
    identities: normalizedIdentities(selected),
  };
  const evidence = new Map<string, Buffer>([
    ['installationManifestPath', jsonBytes(manifest)],
    ['taskViewPath', captured.get('taskView')!],
    ['taskAttestationPath', captured.get('taskAttestation')!],
    ['appScopePath', captured.get('appScope')!],
    ['networkPath', captured.get('network')!],
    ['identityPath', jsonBytes(identity)],
    ['dependencyInventoryPath', captured.get('dependencyInventory')!],
  ]);
  const result: TargetCapture = {
    input,
    selected,
    host,
    evidence,
    recordedAt,
    expiresAt,
    sourceDigests: Object.fromEntries([...captured].map(([role, raw]) => [role, hash(raw)])),
  };
  return result;
}
function publish(output: string, files: ReadonlyMap<string, Buffer>): void {
  const safe = safePath(output, 'outputDirectory'),
    parent = CleanupDirectoryAnchor.open(dirname(safe));
  let anchor: CleanupDirectoryAnchor | undefined;
  try {
    const parentStamp = lstatSync(parent.absolute);
    insist(
      parentStamp.uid === process.getuid!() && (parentStamp.mode & 0o7777) === 0o700,
      'EVIDENCE_OUTPUT_UNSAFE',
      'outputDirectory',
    );
    parent.verify();
    try {
      mkdirSync(parent.path(basename(safe)), { mode: 0o700 });
    } catch (error) {
      throw new EvidencePreparationFailure(
        (error as NodeJS.ErrnoException).code === 'EEXIST'
          ? 'EVIDENCE_OUTPUT_EXISTS'
          : 'EVIDENCE_PUBLICATION_FAILED',
        'outputDirectory',
      );
    }
    parent.sync();
    anchor = CleanupDirectoryAnchor.open(safe, dirname(safe));
    for (const [name, raw] of files) {
      anchor.verify();
      const fd = openSync(
        anchor.path(name),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        const initial = fstatSync(fd);
        let offset = 0;
        while (offset < raw.length) {
          const count = writeSync(fd, raw, offset, raw.length - offset, offset);
          insist(
            Number.isSafeInteger(count) && count > 0 && count <= raw.length - offset,
            'EVIDENCE_WRITE_NO_PROGRESS',
            name,
          );
          offset += count;
        }
        fsyncSync(fd);
        const final = fstatSync(fd),
          entry = lstatSync(anchor.path(name));
        insist(
          final.isFile() &&
            final.nlink === 1 &&
            final.size === raw.length &&
            inodeIdentity(initial) === inodeIdentity(final) &&
            inodeIdentity(final) === inodeIdentity(entry),
          'EVIDENCE_PUBLICATION_CHANGED',
          name,
        );
        anchor.verify();
      } finally {
        closeSync(fd);
      }
      anchor.sync();
    }
    anchor.sync();
    parent.sync();
  } finally {
    anchor?.close();
    parent.close();
  }
}
function evidencePaths(output: string): CleanupHandoffTargetEvidence {
  return Object.fromEntries(
    UPGRADE_EVIDENCE_ROLES.map((role) => [role, join(output, ROLE_FILES[role])]),
  ) as unknown as CleanupHandoffTargetEvidence;
}
function targetPhase(
  input: PrepareCleanupTargetEvidenceDraftInput,
  now: number,
  result: PrepareCleanupEvidenceDraftResult,
  context: EvidenceCaptures,
): void {
  const missing = SOURCE_KEYS.filter((role) => !(input.sources as unknown as ObjectValue)[role]);
  for (const role of missing) {
    result.blockingIssues.push({ code: 'EVIDENCE_SOURCE_MISSING', role });
    if (['appScope', 'network', 'taskAttestation'].includes(role))
      result.missingAdministratorDecisions.push(role);
  }
  if (missing.length) return;
  const captured = captureTarget(input, now, context),
    targetEvidence = evidencePaths(input.outputDirectory),
    files = new Map<string, Buffer>();
  for (const [role, raw] of captured.evidence)
    files.set(ROLE_FILES[role as keyof typeof ROLE_FILES], raw);
  // Target-stage scaffolding is validated once here; the package phase instead
  // validates its real digest after independently recapturing the sources.
  validatePrepared(captured, '0'.repeat(64), now);
  const index = {
    schema: 'openslack.cleanup_target_evidence_draft.v1',
    candidateHead: input.candidateHead,
    recordedAt: captured.recordedAt,
    expiresAt: captured.expiresAt,
    recipe: input,
    selected: captured.selected,
    evidence: Object.fromEntries(
      UPGRADE_EVIDENCE_ROLES.map((role) => [
        role,
        { path: targetEvidence[role], sha256: hash(captured.evidence.get(role)!) },
      ]),
    ),
    sourceDigests: captured.sourceDigests,
    installedFiles: captured.host.files,
    installedManifest: metadata(
      (captured.host.installedManifest as ObjectValue).observation,
      'observation',
    ),
    runtimeIdentity: { state: 'NOT_OBSERVED' },
    approvalStatus: 'DRAFT',
    installationAuthorized: false,
    executionAuthorized: false,
  };
  const indexRaw = jsonBytes(index);
  files.set('target-evidence-index.json', indexRaw);
  window(
    { recordedAt: captured.recordedAt, expiresAt: captured.expiresAt },
    Date.now(),
    'publication',
  );
  context.verify();
  publish(input.outputDirectory, files);
  result.published = true;
  result.targetEvidence = targetEvidence;
  result.targetDraft = {
    path: join(input.outputDirectory, 'target-evidence-index.json'),
    sha256: hash(indexRaw),
  };
  result.installationManifestSHA256 = hash(captured.evidence.get('installationManifestPath')!);
}
function packagePhase(
  input: PrepareCleanupPackageEvidenceDraftInput,
  now: number,
  result: PrepareCleanupEvidenceDraftResult,
  context: EvidenceCaptures,
): void {
  const indexRaw = context.read(source(input.targetDraft, 'targetDraft'), 'targetDraft'),
    index = exact(
      decode(indexRaw, 'targetDraft'),
      [
        'schema',
        'candidateHead',
        'recordedAt',
        'expiresAt',
        'recipe',
        'selected',
        'evidence',
        'sourceDigests',
        'installedFiles',
        'installedManifest',
        'runtimeIdentity',
        'approvalStatus',
        'installationAuthorized',
        'executionAuthorized',
      ],
      'targetDraft',
    );
  insist(
    index.schema === 'openslack.cleanup_target_evidence_draft.v1' &&
      index.candidateHead === input.candidateHead &&
      index.approvalStatus === 'DRAFT' &&
      index.installationAuthorized === false &&
      index.executionAuthorized === false &&
      equal(index.runtimeIdentity, { state: 'NOT_OBSERVED' }),
    'EVIDENCE_BINDING_MISMATCH',
    'targetDraft',
  );
  window(index, now, 'targetDraft');
  const recipe = parseRecipe(index.recipe);
  insist(
    recipe.phase === 'target' && recipe.candidateHead === input.candidateHead,
    'EVIDENCE_BINDING_MISMATCH',
    'targetDraft',
  );
  const captured = captureTarget(recipe, now, context);
  insist(
    equal(index.selected, captured.selected) &&
      equal(index.sourceDigests, captured.sourceDigests) &&
      equal(index.installedFiles, captured.host.files) &&
      equal(
        index.installedManifest,
        (captured.host.installedManifest as ObjectValue).observation,
      ) &&
      index.recordedAt === captured.recordedAt &&
      index.expiresAt === captured.expiresAt,
    'EVIDENCE_BINDING_MISMATCH',
    'targetDraft',
  );
  const evidence = exact(index.evidence, UPGRADE_EVIDENCE_ROLES, 'targetDraft');
  const targetEvidence = evidencePaths(recipe.outputDirectory);
  for (const role of UPGRADE_EVIDENCE_ROLES) {
    const ref = source(evidence[role], role);
    insist(
      ref.path === targetEvidence[role] &&
        hash(context.read(ref, role)) === hash(captured.evidence.get(role)!),
      'EVIDENCE_BINDING_MISMATCH',
      role,
    );
  }
  const sums = readCleanupArtifactFile(
    join(safePath(input.packageDirectory, 'packageDirectory'), 'SHA256SUMS'),
    MAX_EVIDENCE,
  );
  insist(hash(sums) === input.manifestSHA256, 'EVIDENCE_DIGEST_MISMATCH', 'packageManifest');
  const verification = verifyCleanupHandoffPackage({
    packageDirectory: input.packageDirectory,
    candidateHead: input.candidateHead,
    manifestSHA256: input.manifestSHA256,
  });
  insist(
    evaluateCleanupHandoffVerification(verification) === 0,
    'EVIDENCE_PACKAGE_INVALID',
    'package',
  );
  const snapshot = verifiedCleanupHandoffSnapshot(verification);
  insist(
    snapshot && equal(snapshot.selected, captured.selected),
    'EVIDENCE_BINDING_MISMATCH',
    'packageSelection',
  );
  const planned = decode(
    captured.evidence.get('installationManifestPath')!,
    'installationManifestPath',
  );
  for (const entry of CLEANUP_INSTALL_LAYOUT) {
    const digest = (planned.files as ObjectValue[]).find((f) => f.path === entry.path)?.sha256;
    insist(
      digest === snapshot.artifactDigests[entry.artifact],
      'EVIDENCE_BINDING_MISMATCH',
      'packageArtifacts',
    );
  }
  const packagedManifest = readCleanupArtifactFile(
      join(input.packageDirectory, 'draft/install-manifest.DRAFT.json'),
      MAX_EVIDENCE,
    ),
    packagedTask = readCleanupArtifactFile(
      join(input.packageDirectory, 'draft/task-dependencies.DRAFT.json'),
      65536,
    );
  insist(
    hash(packagedManifest) === hash(captured.evidence.get('installationManifestPath')!) &&
      hash(packagedTask) === hash(captured.evidence.get('taskViewPath')!),
    'EVIDENCE_BINDING_MISMATCH',
    'packageEvidence',
  );
  const { admin, host } = validatePrepared(captured, input.manifestSHA256, now);
  const sourceIndex = {
    schema: 'openslack.cleanup_package_evidence_draft.v1',
    candidateHead: input.candidateHead,
    recordedAt: captured.recordedAt,
    expiresAt: captured.expiresAt,
    packageDirectory: input.packageDirectory,
    packageManifestSHA256: input.manifestSHA256,
    installationManifestSHA256: hash(packagedManifest),
    targetDraft: input.targetDraft,
    targetEvidence,
    evidenceSHA256: host.evidenceSHA256,
    sourceDigests: captured.sourceDigests,
    installedManifest: index.installedManifest,
    runtimeIdentity: index.runtimeIdentity,
    approvalStatus: 'DRAFT',
    installationAuthorized: false,
    executionAuthorized: false,
  };
  window(
    { recordedAt: captured.recordedAt, expiresAt: captured.expiresAt },
    Date.now(),
    'publication',
  );
  context.verify();
  publish(
    input.outputDirectory,
    new Map([
      ['upgrade-inputs.DRAFT.json', jsonBytes(admin)],
      ['host-inspection.json', jsonBytes(host)],
      ['source-index.json', jsonBytes(sourceIndex)],
    ]),
  );
  result.published = true;
  result.targetEvidence = targetEvidence;
  result.adminInputPath = join(input.outputDirectory, 'upgrade-inputs.DRAFT.json');
  result.hostInspectionPath = join(input.outputDirectory, 'host-inspection.json');
  result.sourceIndexPath = join(input.outputDirectory, 'source-index.json');
  result.packageManifestSHA256 = input.manifestSHA256;
  result.installationManifestSHA256 = hash(packagedManifest);
}
/** Local, non-sensitive preparation only. Success never authorizes deployment or execution. */
export function prepareCleanupEvidenceDraft(
  input: PrepareCleanupEvidenceDraftInput,
): PrepareCleanupEvidenceDraftResult {
  const result: PrepareCleanupEvidenceDraftResult = {
    schema: 'openslack.cleanup_admin_evidence_result.v1',
    phase: 'invalid',
    candidateHead: '',
    published: false,
    blockingIssues: [],
    missingAdministratorDecisions: [],
    approvalStatus: 'DRAFT',
    installationAuthorized: false,
    executionAuthorized: false,
  };
  try {
    const recipe = parseRecipe(input);
    result.phase = recipe.phase;
    result.candidateHead = recipe.candidateHead;
    assertCleanupDescriptorSupport();
    const now = Date.now();
    const context = new EvidenceCaptures();
    let failure: unknown;
    try {
      if (recipe.phase === 'target') targetPhase(recipe, now, result, context);
      else packagePhase(recipe, now, result, context);
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      context.close(failure);
    }
  } catch (error) {
    const issue =
      error instanceof EvidencePreparationFailure
        ? { code: error.code, role: error.role }
        : error instanceof UpgradeEvidenceError
          ? { code: error.reason, role: error.role }
          : error instanceof CleanupFileBoundaryError
            ? { code: `EVIDENCE_${error.code}`, role: 'fileBoundary' }
            : { code: 'EVIDENCE_PREPARATION_FAILED', role: 'publication' };
    result.blockingIssues.push(issue);
    const decisionRoles: Record<string, string> = {
      appScope: 'appScope',
      appScopePath: 'appScope',
      network: 'network',
      networkPath: 'network',
      taskAttestation: 'taskAttestation',
      taskAttestationPath: 'taskAttestation',
    };
    const decision = decisionRoles[issue.role];
    if (decision && !result.missingAdministratorDecisions.includes(decision))
      result.missingAdministratorDecisions.push(decision);
  }
  return result;
}
