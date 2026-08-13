import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, constants as fsConstants, type BigIntStats } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { types as nodeTypes } from 'node:util';
import {
  canonicalWorkflowControlJson,
  hashWorkflowControlValue,
  projectWorkflowControlReadModel,
  validateWorkflowControlObservation,
  type WorkflowControlObservation,
  type WorkflowControlReadModel,
} from './workflow-control-contract.js';
import {
  WorkflowControlObservationError,
  type BuildWorkflowControlObservationOptions,
} from './workflow-control-observation.js';
import { enqueueByKey } from './internal/keyed-serial-queue.js';
import { safeInteger } from './internal/strict-data.js';

export const WORKFLOW_CONTROL_SHADOW_OBSERVATION_SCHEMA =
  'openslack.workflow_control_shadow_observation.v1' as const;
export const WORKFLOW_CONTROL_SHADOW_RECEIPT_SCHEMA =
  'openslack.workflow_control_shadow_receipt.v1' as const;
export const WORKFLOW_CONTROL_SHADOW_ROUTE = '/v1/shadow/workflow-control/observations' as const;
export const WORKFLOW_CONTROL_SHADOW_IDEMPOTENCY_PREFIX =
  'openslack.workflow-control-shadow.v1.' as const;

export const WORKFLOW_CONTROL_SHADOW_POLICY = Object.freeze({
  maxEnvelopeBytes: 512 * 1024,
  maxReceiptBytes: 64 * 1024,
  defaultTimeoutMs: 2_000,
  maxTimeoutMs: 30_000,
  orderingRetryAttempts: 16,
  defaultOrderingRetryDelayMs: 25,
  maxOrderingRetryDelayMs: 1_000,
  maxJournalEntries: 16_384,
  maxJournalBytes: 512 * 1024 * 1024,
  maxJournalFileBytes: 1024 * 1024,
  maxDiagnosticCodeBytes: 256,
} as const);

export interface WorkflowControlShadowSource {
  readonly runId: string;
  readonly sourceSequence: number;
  readonly workspaceId: string;
}

export interface WorkflowControlShadowEnvelope {
  readonly authority: 'typescript';
  readonly observation: WorkflowControlObservation;
  readonly projection: WorkflowControlReadModel;
  readonly schema: typeof WORKFLOW_CONTROL_SHADOW_OBSERVATION_SCHEMA;
  readonly source: WorkflowControlShadowSource;
}

export interface WorkflowControlShadowReceipt {
  readonly schema: typeof WORKFLOW_CONTROL_SHADOW_RECEIPT_SCHEMA;
  readonly operation: 'observation_ingest';
  readonly status: 'accepted' | 'duplicate' | 'reconciliation_required';
  readonly parity: 'matched' | 'mismatched' | 'unknown';
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly workspaceId: string;
  readonly runId: string;
  readonly sourceSequence: number;
  readonly observationDigest: string;
  readonly observationHash?: string;
  readonly mismatchCode?: string;
  readonly committedAt?: string;
  readonly reconciliationToken?: string;
}

export interface WorkflowControlShadowPreparedRequest {
  readonly body: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
}

export interface WorkflowControlShadowPublisherPort {
  publish(envelope: WorkflowControlShadowEnvelope): Promise<WorkflowControlShadowReceipt>;
}

export interface WorkflowControlObservationPort {
  /** Fire-and-forget and fail-open relative to the TypeScript authority. */
  observeRun(runId: string): void;
  /** Replays durable unacknowledged entries. Shadow failures never throw to callers. */
  replay(): Promise<void>;
  /** Test/qualification seam; waits for currently scheduled shadow work only. */
  flush(): Promise<void>;
}

export type WorkflowControlShadowDiagnosticOutcome =
  | 'accepted'
  | 'duplicate'
  | 'mismatched'
  | 'unavailable'
  | 'journal_incomplete'
  | 'journal_invalid'
  | 'observation_invalid'
  | 'legacy_manifest_skipped';

export interface WorkflowControlShadowDiagnostic {
  readonly schema: 'openslack.workflow_control_shadow_diagnostic.v1';
  readonly outcome: WorkflowControlShadowDiagnosticOutcome;
  readonly workspaceIdHash: string;
  readonly runIdHash: string;
  readonly sourceSequence?: number;
  readonly code?: string;
}

export type WorkflowControlShadowDiagnosticSink = (
  diagnostic: WorkflowControlShadowDiagnostic,
) => void | Promise<void>;

export interface CreateWorkflowControlObservationPortOptions {
  readonly enabled?: boolean;
  readonly workspaceId?: string;
  readonly journalRoot?: string;
  readonly publisher?: WorkflowControlShadowPublisherPort;
  readonly buildObservation?: (
    runId: string,
  ) => Promise<WorkflowControlObservation> | WorkflowControlObservation;
  readonly diagnosticSink?: WorkflowControlShadowDiagnosticSink;
}

export interface WorkflowControlShadowJournalSecurityDependencies {
  readonly platform: NodeJS.Platform;
  readonly currentWindowsSid: () => string;
  readonly readWindowsPathSecurity: (path: string, identity: string, cacheable: boolean) => unknown;
  readonly hardenPath: (path: string, directory: boolean) => void;
  /** @internal Deterministic lock qualification hooks. */
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly processId?: number;
  readonly processSessionId?: string;
  readonly probeProcess?: (pid: number) => void;
}

type JsonRecord = Readonly<Record<string, unknown>>;

interface JournalDirectories {
  readonly root: string;
  readonly entries: string;
  readonly states: string;
  readonly locks: string;
  readonly security: WorkflowControlShadowJournalSecurityDependencies;
}

interface JournalState {
  readonly schema: 'openslack.workflow_control_shadow_journal_state.v1';
  readonly workspaceId: string;
  readonly runId: string;
  readonly lastSequence: number;
  readonly ackedSequence: number;
  readonly lastObservationHash: string | null;
  readonly incomplete: boolean;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const RECEIPT_CODE = /^[a-z0-9][a-z0-9._:-]{0,255}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;
const STATE_NAME = /^([0-9a-f]{64})\.json$/u;
const ENTRY_NAME = /^([0-9a-f]{64})\.([0-9]{16})\.([0-9a-f]{64})\.json$/u;
const WINDOWS_SID = /^S-\d(?:-\d+)+$/u;
const LOCK_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const WINDOWS_SYSTEM_SID = 'S-1-5-18';
const WINDOWS_SECURITY_CACHE_LIMIT = 2_048;
const WINDOWS_SECURITY_MODULE_IMPORT =
  'Import-Module -Name (Join-Path $PSHOME "Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1") -ErrorAction Stop';
// Hosted Windows runners can exceed five seconds while loading the security module.
// Keep ACL inspection and hardening bounded without treating normal cold starts as failures.
const WINDOWS_SECURITY_COMMAND_TIMEOUT_MS = 20_000;
const JOURNAL_LOCK_SCHEMA = 'openslack.workflow_control_shadow_journal_lock.v1' as const;
const PROCESS_SESSION_ID = randomUUID();
const JOURNAL_CAPACITY_LOCK_HASH = sha256('openslack.workflow-control-shadow.journal-capacity.v1');
const NO_FOLLOW = process.platform === 'win32' ? 0 : (fsConstants.O_NOFOLLOW ?? 0);
let productionWindowsSid: string | undefined;
const productionWindowsSecurityCache = new Map<
  string,
  Readonly<{ identity: string; value: unknown }>
>();
const PUBLISHERS = new WeakSet<object>();
const PORTS = new WeakSet<object>();
const streamTails = new Map<string, Promise<void>>();

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function exactKeys(
  value: JsonRecord,
  required: readonly string[],
  optional: readonly string[] = [],
) {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function plainObject(value: unknown, label: string): JsonRecord {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value) as never)
  ) {
    throw new TypeError(`${label} must be an inert object.`);
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== 'string' ||
      !descriptor ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, 'value')
    ) {
      throw new TypeError(`${label} must contain only enumerable data fields.`);
    }
  }
  return value as JsonRecord;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw new TypeError(`${label} must be a bounded identifier.`);
  }
  return value;
}

function immutable<T>(value: T): T {
  if (Array.isArray(value)) value.forEach(immutable);
  else if (typeof value === 'object' && value !== null) Object.values(value).forEach(immutable);
  return Object.freeze(value);
}

export function validateWorkflowControlShadowEnvelope(
  value: unknown,
): WorkflowControlShadowEnvelope {
  const canonical = JSON.parse(canonicalWorkflowControlJson(value)) as unknown;
  const root = plainObject(canonical, 'Workflow Control shadow envelope');
  if (
    !exactKeys(root, ['authority', 'observation', 'projection', 'schema', 'source']) ||
    root.schema !== WORKFLOW_CONTROL_SHADOW_OBSERVATION_SCHEMA ||
    root.authority !== 'typescript'
  ) {
    throw new TypeError('Workflow Control shadow envelope uses an invalid closed contract.');
  }
  const sourceObject = plainObject(root.source, 'Workflow Control shadow source');
  if (!exactKeys(sourceObject, ['runId', 'sourceSequence', 'workspaceId'])) {
    throw new TypeError('Workflow Control shadow source is not closed.');
  }
  const source = immutable({
    runId: identifier(sourceObject.runId, 'source.runId'),
    sourceSequence: safeInteger(sourceObject.sourceSequence, 'source.sourceSequence', 1),
    workspaceId: identifier(sourceObject.workspaceId, 'source.workspaceId'),
  });
  const observation = validateWorkflowControlObservation(root.observation);
  const projection = projectWorkflowControlReadModel(observation);
  if (
    observation.runId !== source.runId ||
    canonicalWorkflowControlJson(root.projection) !== canonicalWorkflowControlJson(projection)
  ) {
    throw new TypeError('Workflow Control shadow projection or source binding does not match.');
  }
  return immutable({
    authority: 'typescript' as const,
    observation,
    projection,
    schema: WORKFLOW_CONTROL_SHADOW_OBSERVATION_SCHEMA,
    source,
  });
}

export function prepareWorkflowControlShadowRequest(
  envelopeValue: WorkflowControlShadowEnvelope,
): WorkflowControlShadowPreparedRequest {
  const envelope = validateWorkflowControlShadowEnvelope(envelopeValue);
  const body = `${canonicalWorkflowControlJson(envelope)}\n`;
  if (Buffer.byteLength(body, 'utf8') > WORKFLOW_CONTROL_SHADOW_POLICY.maxEnvelopeBytes) {
    throw new TypeError('Workflow Control shadow envelope exceeds its byte limit.');
  }
  const digest = sha256(body);
  const binding = [
    envelope.authority,
    envelope.source.workspaceId,
    envelope.source.runId,
    String(envelope.source.sourceSequence),
  ].join('/');
  return immutable({
    body,
    idempotencyKey: `${WORKFLOW_CONTROL_SHADOW_IDEMPOTENCY_PREFIX}${digest}`,
    requestFingerprint: `sha256:${sha256(
      `POST\n${WORKFLOW_CONTROL_SHADOW_ROUTE}\n${binding}\n${body}`,
    )}`,
  });
}

export function validateWorkflowControlShadowReceipt(
  value: unknown,
  envelopeValue: WorkflowControlShadowEnvelope,
): WorkflowControlShadowReceipt {
  const envelope = validateWorkflowControlShadowEnvelope(envelopeValue);
  const request = prepareWorkflowControlShadowRequest(envelope);
  const object = plainObject(value, 'Workflow Control shadow receipt');
  const required = [
    'schema',
    'operation',
    'status',
    'parity',
    'idempotencyKey',
    'requestFingerprint',
    'workspaceId',
    'runId',
    'sourceSequence',
    'observationDigest',
  ];
  const optional = ['observationHash', 'mismatchCode', 'committedAt', 'reconciliationToken'];
  const observationDigest = sha256(request.body);
  if (
    !exactKeys(object, required, optional) ||
    object.schema !== WORKFLOW_CONTROL_SHADOW_RECEIPT_SCHEMA ||
    object.operation !== 'observation_ingest' ||
    !['accepted', 'duplicate', 'reconciliation_required'].includes(String(object.status)) ||
    !['matched', 'mismatched', 'unknown'].includes(String(object.parity)) ||
    object.idempotencyKey !== request.idempotencyKey ||
    object.requestFingerprint !== request.requestFingerprint ||
    object.workspaceId !== envelope.source.workspaceId ||
    object.runId !== envelope.source.runId ||
    object.sourceSequence !== envelope.source.sourceSequence ||
    object.observationDigest !== observationDigest
  ) {
    throw new TypeError('Workflow Control shadow receipt does not bind the exact request.');
  }
  const reconciles = object.status === 'reconciliation_required';
  const mismatched = object.parity === 'mismatched';
  if (
    reconciles
      ? object.parity !== 'unknown' ||
        object.mismatchCode !== undefined ||
        typeof object.reconciliationToken !== 'string' ||
        object.reconciliationToken.length === 0 ||
        object.observationHash !== undefined ||
        object.committedAt !== undefined
      : (object.parity !== 'matched' && !mismatched) ||
        object.observationHash !== envelope.projection.observationHash ||
        (mismatched
          ? typeof object.mismatchCode !== 'string' || !RECEIPT_CODE.test(object.mismatchCode)
          : object.mismatchCode !== undefined) ||
        typeof object.committedAt !== 'string' ||
        object.reconciliationToken !== undefined
  ) {
    throw new TypeError('Workflow Control shadow receipt state is inconsistent.');
  }
  if (
    typeof object.committedAt === 'string' &&
    (!TIMESTAMP.test(object.committedAt) || !Number.isFinite(Date.parse(object.committedAt)))
  ) {
    throw new TypeError('Workflow Control shadow receipt timestamp is invalid.');
  }
  return immutable({
    schema: WORKFLOW_CONTROL_SHADOW_RECEIPT_SCHEMA,
    operation: 'observation_ingest' as const,
    status: object.status as WorkflowControlShadowReceipt['status'],
    parity: object.parity as WorkflowControlShadowReceipt['parity'],
    idempotencyKey: request.idempotencyKey,
    requestFingerprint: request.requestFingerprint,
    workspaceId: envelope.source.workspaceId,
    runId: envelope.source.runId,
    sourceSequence: envelope.source.sourceSequence,
    observationDigest,
    ...(object.observationHash === undefined
      ? {}
      : { observationHash: object.observationHash as string }),
    ...(object.mismatchCode === undefined ? {} : { mismatchCode: object.mismatchCode as string }),
    ...(object.committedAt === undefined ? {} : { committedAt: object.committedAt as string }),
    ...(object.reconciliationToken === undefined
      ? {}
      : { reconciliationToken: object.reconciliationToken as string }),
  });
}

export function createWorkflowControlShadowPublisherPort(
  publish: WorkflowControlShadowPublisherPort['publish'],
): WorkflowControlShadowPublisherPort {
  if (typeof publish !== 'function' || nodeTypes.isProxy(publish)) {
    throw new TypeError('Workflow Control shadow publisher must be an inert host function.');
  }
  const publisher = Object.freeze({
    async publish(envelopeValue: WorkflowControlShadowEnvelope) {
      const envelope = validateWorkflowControlShadowEnvelope(envelopeValue);
      return validateWorkflowControlShadowReceipt(await publish(envelope), envelope);
    },
  });
  PUBLISHERS.add(publisher);
  return publisher;
}

export function isWorkflowControlShadowPublisherPort(
  value: unknown,
): value is WorkflowControlShadowPublisherPort {
  return Boolean(
    value && typeof value === 'object' && !nodeTypes.isProxy(value) && PUBLISHERS.has(value),
  );
}

function containedCanonicalPath(
  root: string,
  candidate: string,
  security: WorkflowControlShadowJournalSecurityDependencies,
): boolean {
  const normalize = (value: string) =>
    security.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
  const value = relative(normalize(root), normalize(candidate));
  return value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

function sameCanonicalPath(
  left: string,
  right: string,
  security: WorkflowControlShadowJournalSecurityDependencies,
): boolean {
  const normalize = (value: string) =>
    security.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
  return normalize(left) === normalize(right);
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function securityIdentity(path: string, stat: BigIntStats): string {
  const canonicalPath = process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
  return [canonicalPath, stat.dev, stat.ino, stat.birthtimeNs, stat.ctimeNs, stat.mode].join(':');
}

interface WindowsPathSecurity {
  readonly owner: string;
  readonly protected: boolean;
  readonly reparse: boolean;
  readonly rules: readonly {
    readonly sid: string;
    readonly type: 'Allow' | 'Deny';
  }[];
}

function parseWindowsPathSecurity(value: unknown): WindowsPathSecurity {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      throw new TypeError('Workflow Control shadow journal Windows ACL is invalid.');
    }
  }
  const object = plainObject(parsed, 'Workflow Control shadow journal Windows ACL');
  if (
    !exactKeys(object, ['owner', 'protected', 'reparse', 'rules']) ||
    typeof object.owner !== 'string' ||
    !WINDOWS_SID.test(object.owner.toUpperCase()) ||
    typeof object.protected !== 'boolean' ||
    typeof object.reparse !== 'boolean' ||
    !Array.isArray(object.rules)
  ) {
    throw new TypeError('Workflow Control shadow journal Windows ACL is invalid.');
  }
  const rules = object.rules.map((ruleValue) => {
    const rule = plainObject(ruleValue, 'Workflow Control shadow journal Windows ACL rule');
    if (
      !exactKeys(rule, ['sid', 'type']) ||
      typeof rule.sid !== 'string' ||
      !WINDOWS_SID.test(rule.sid.toUpperCase()) ||
      (rule.type !== 'Allow' && rule.type !== 'Deny')
    ) {
      throw new TypeError('Workflow Control shadow journal Windows ACL is invalid.');
    }
    return Object.freeze({
      sid: rule.sid.toUpperCase(),
      type: rule.type,
    });
  });
  return Object.freeze({
    owner: object.owner.toUpperCase(),
    protected: object.protected,
    reparse: object.reparse,
    rules: Object.freeze(rules),
  });
}

function assertOwnerOnlyPath(
  path: string,
  stat: BigIntStats,
  security: WorkflowControlShadowJournalSecurityDependencies,
): void {
  if (security.platform !== 'win32') {
    if ((Number(stat.mode) & 0o077) !== 0) {
      throw new TypeError('Workflow Control shadow journal path must be owner-only.');
    }
    return;
  }
  const sid = security.currentWindowsSid().toUpperCase();
  if (!WINDOWS_SID.test(sid)) {
    throw new TypeError('Workflow Control shadow journal Windows SID is invalid.');
  }
  // The stable identity includes ctime. Directory entry and DACL mutations
  // advance that identity on the supported Windows qualification profiles, so
  // unchanged owner-only directories can share the same bounded cache as files.
  const cacheable = true;
  const acl = parseWindowsPathSecurity(
    security.readWindowsPathSecurity(path, securityIdentity(path, stat), cacheable),
  );
  const allowed = new Set([sid, WINDOWS_SYSTEM_SID]);
  const failure = acl.reparse
    ? 'reparse point'
    : acl.owner !== sid
      ? 'owner mismatch'
      : !acl.protected
        ? 'inherited access'
        : acl.rules.some((rule) => rule.type === 'Allow' && !allowed.has(rule.sid))
          ? 'foreign allow rule'
          : !acl.rules.some((rule) => rule.type === 'Allow' && rule.sid === sid)
            ? 'owner allow rule missing'
            : undefined;
  if (failure !== undefined) {
    throw new TypeError(
      `Workflow Control shadow journal Windows ACL is not owner-only: ${failure}.`,
    );
  }
}

export function productionJournalSecurity(): WorkflowControlShadowJournalSecurityDependencies {
  const currentWindowsSid = () => {
    if (productionWindowsSid !== undefined) return productionWindowsSid;
    const output = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5_000,
      maxBuffer: 16 * 1024,
    }).trim();
    const match = /^"(?:""|[^"])*","(S-\d(?:-\d+)+)"$/iu.exec(output);
    if (!match || !WINDOWS_SID.test(match[1]!.toUpperCase())) {
      throw new TypeError('Workflow Control shadow journal Windows SID is unavailable.');
    }
    productionWindowsSid = match[1]!.toUpperCase();
    return productionWindowsSid;
  };
  return Object.freeze({
    platform: process.platform,
    currentWindowsSid,
    readWindowsPathSecurity(path: string, identity: string, cacheable: boolean) {
      const cacheKey = resolve(path).toLowerCase();
      if (cacheable) {
        const cached = productionWindowsSecurityCache.get(cacheKey);
        if (cached?.identity === identity) return cached.value;
      }
      const script = [
        WINDOWS_SECURITY_MODULE_IMPORT,
        '$item = Get-Item -Force -LiteralPath $env:OPENSLACK_WORKFLOW_SHADOW_PATH',
        '$acl = Get-Acl -LiteralPath $env:OPENSLACK_WORKFLOW_SHADOW_PATH',
        '$owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value',
        '$reparse = [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)',
        '$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object { [pscustomobject]@{ sid = $_.IdentityReference.Value; type = $_.AccessControlType.ToString() } })',
        '[pscustomobject]@{ owner = $owner; protected = $acl.AreAccessRulesProtected; reparse = $reparse; rules = $rules } | ConvertTo-Json -Compress -Depth 4',
      ].join('; ');
      const value = execFileSync(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
        {
          encoding: 'utf8',
          windowsHide: true,
          timeout: WINDOWS_SECURITY_COMMAND_TIMEOUT_MS,
          maxBuffer: 64 * 1024,
          env: { ...process.env, OPENSLACK_WORKFLOW_SHADOW_PATH: path },
        },
      );
      if (cacheable) {
        if (productionWindowsSecurityCache.size >= WINDOWS_SECURITY_CACHE_LIMIT) {
          productionWindowsSecurityCache.delete(
            productionWindowsSecurityCache.keys().next().value!,
          );
        }
        productionWindowsSecurityCache.set(cacheKey, Object.freeze({ identity, value }));
      }
      return value;
    },
    hardenPath(path: string, directory: boolean) {
      if (process.platform !== 'win32') {
        chmodSync(path, directory ? 0o700 : 0o600);
        return;
      }
      productionWindowsSecurityCache.delete(resolve(path).toLowerCase());
      const sid = currentWindowsSid();
      const script = [
        WINDOWS_SECURITY_MODULE_IMPORT,
        '$owner = [System.Security.Principal.SecurityIdentifier]::new($env:OPENSLACK_WORKFLOW_SHADOW_SID)',
        `$system = [System.Security.Principal.SecurityIdentifier]::new('${WINDOWS_SYSTEM_SID}')`,
        '$acl = Get-Acl -LiteralPath $env:OPENSLACK_WORKFLOW_SHADOW_PATH',
        '$acl.SetOwner($owner)',
        '$acl.SetAccessRuleProtection($true, $false)',
        'foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($rule) }',
        '$rights = [System.Security.AccessControl.FileSystemRights]::FullControl',
        directory
          ? '$inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit'
          : '$inheritance = [System.Security.AccessControl.InheritanceFlags]::None',
        '$propagation = [System.Security.AccessControl.PropagationFlags]::None',
        '$type = [System.Security.AccessControl.AccessControlType]::Allow',
        '$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($owner, $rights, $inheritance, $propagation, $type))',
        '$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($system, $rights, $inheritance, $propagation, $type))',
        'Set-Acl -LiteralPath $env:OPENSLACK_WORKFLOW_SHADOW_PATH -AclObject $acl',
      ].join('; ');
      execFileSync(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
        {
          encoding: 'utf8',
          windowsHide: true,
          timeout: WINDOWS_SECURITY_COMMAND_TIMEOUT_MS,
          maxBuffer: 64 * 1024,
          env: {
            ...process.env,
            OPENSLACK_WORKFLOW_SHADOW_PATH: path,
            OPENSLACK_WORKFLOW_SHADOW_SID: sid,
          },
        },
      );
    },
  });
}

export async function ensureOwnerDirectory(
  path: string,
  security: WorkflowControlShadowJournalSecurityDependencies,
  parent?: string,
): Promise<string> {
  let created = false;
  try {
    const firstCreated = await mkdir(path, { recursive: parent === undefined, mode: 0o700 });
    created = parent === undefined ? firstCreated !== undefined : true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  if (created) security.hardenPath(path, true);
  const before = await lstat(path, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new TypeError('Workflow Control shadow journal directory must be owner-only.');
  }
  assertOwnerOnlyPath(path, before, security);
  const canonical = await realpath(path);
  if (
    !sameCanonicalPath(canonical, path, security) ||
    (parent !== undefined && !containedCanonicalPath(parent, canonical, security))
  ) {
    throw new TypeError('Workflow Control shadow journal directory is non-canonical.');
  }
  const after = await lstat(path, { bigint: true });
  if (!sameIdentity(before, after)) {
    throw new TypeError('Workflow Control shadow journal directory changed during validation.');
  }
  return canonical;
}

/** Verify an existing owner-only directory without coupling its identity to child-entry churn. */
export async function assertOwnerDirectory(
  path: string,
  security: WorkflowControlShadowJournalSecurityDependencies,
  parent?: string,
): Promise<string> {
  const stat = await lstat(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new TypeError('Workflow Control shadow journal directory must be owner-only.');
  }
  assertOwnerOnlyPath(path, stat, security);
  const canonical = await realpath(path);
  if (
    !sameCanonicalPath(canonical, path, security) ||
    (parent !== undefined && !containedCanonicalPath(parent, canonical, security))
  ) {
    throw new TypeError('Workflow Control shadow journal directory is non-canonical.');
  }
  return canonical;
}

async function initializeJournal(
  rootValue: string,
  security: WorkflowControlShadowJournalSecurityDependencies,
): Promise<JournalDirectories> {
  if (!isAbsolute(rootValue) || resolve(rootValue) !== rootValue || rootValue.includes('\0')) {
    throw new TypeError('Workflow Control shadow journal root must be normalized and absolute.');
  }
  const root = await ensureOwnerDirectory(rootValue, security);
  const rootEntries = await readdir(root, { withFileTypes: true });
  if (
    rootEntries.some(
      (entry) =>
        !['entries', 'locks', 'states'].includes(entry.name) ||
        !entry.isDirectory() ||
        entry.isSymbolicLink(),
    )
  ) {
    throw new TypeError('Workflow Control shadow journal root contains an unknown entry.');
  }
  const entries = await ensureOwnerDirectory(join(root, 'entries'), security, root);
  const locks = await ensureOwnerDirectory(join(root, 'locks'), security, root);
  const states = await ensureOwnerDirectory(join(root, 'states'), security, root);
  return Object.freeze({ root, entries, locks, states, security });
}

export async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(path, fsConstants.O_RDONLY | NO_FOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function assertOwnerFile(
  path: string,
  security: WorkflowControlShadowJournalSecurityDependencies,
): Promise<BigIntStats> {
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new TypeError('Workflow Control shadow journal file is unsafe.');
  }
  assertOwnerOnlyPath(path, before, security);
  const canonical = await realpath(path);
  if (!sameCanonicalPath(canonical, path, security)) {
    throw new TypeError('Workflow Control shadow journal file is non-canonical.');
  }
  const after = await lstat(path, { bigint: true });
  if (!sameIdentity(before, after)) {
    throw new TypeError('Workflow Control shadow journal file changed during validation.');
  }
  return after;
}

/**
 * Read an owner-only regular file through a no-follow handle while proving the
 * path and opened handle retain one identity for the complete bounded read.
 */
export async function readOwnerFile(
  path: string,
  security: WorkflowControlShadowJournalSecurityDependencies,
  maxBytes: number,
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError('Owner-only file read bound is invalid.');
  }
  const before = await assertOwnerFile(path, security);
  if (before.size > BigInt(maxBytes)) {
    throw new TypeError('Owner-only file exceeds its byte limit.');
  }
  const handle = await open(path, fsConstants.O_RDONLY | NO_FOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameIdentity(before, opened)) {
      throw new TypeError('Owner-only file identity changed before read.');
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const repeated = await lstat(path, { bigint: true });
    if (
      bytes.byteLength > maxBytes ||
      !sameIdentity(opened, after) ||
      !sameIdentity(after, repeated)
    ) {
      throw new TypeError('Owner-only file changed during read.');
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } finally {
    await handle.close();
  }
}

async function writeExclusiveWithIdentity(
  path: string,
  body: string,
  security: WorkflowControlShadowJournalSecurityDependencies,
): Promise<BigIntStats> {
  const handle = await open(
    path,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NO_FOLLOW,
    0o600,
  );
  let complete = false;
  let opened: BigIntStats | undefined;
  try {
    security.hardenPath(path, false);
    const linked = await assertOwnerFile(path, security);
    opened = await handle.stat({ bigint: true });
    if (!sameIdentity(linked, opened)) {
      throw new TypeError('Workflow Control shadow journal file identity changed.');
    }
    await handle.writeFile(body, 'utf8');
    await handle.sync();
    complete = true;
  } finally {
    await handle.close();
    if (!complete) await rm(path, { force: true }).catch(() => undefined);
  }
  return opened!;
}

export async function writeExclusive(
  path: string,
  body: string,
  security: WorkflowControlShadowJournalSecurityDependencies,
): Promise<void> {
  await writeExclusiveWithIdentity(path, body, security);
}

export async function atomicWrite(
  path: string,
  body: string,
  security: WorkflowControlShadowJournalSecurityDependencies,
): Promise<void> {
  const temporary = join(dirname(path), `.${sha256(path)}.${process.pid}.${randomUUID()}.tmp`);
  await writeExclusive(temporary, body, security);
  try {
    await rename(temporary, path);
    await assertOwnerFile(path, security);
    await syncDirectory(dirname(path));
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function readCanonical(
  path: string,
  security: WorkflowControlShadowJournalSecurityDependencies,
): Promise<unknown> {
  const text = await readOwnerFile(
    path,
    security,
    WORKFLOW_CONTROL_SHADOW_POLICY.maxJournalFileBytes,
  );
  const value = JSON.parse(text) as unknown;
  if (`${canonicalWorkflowControlJson(value)}\n` !== text) {
    throw new TypeError('Journal bytes are not exact canonical JSON.');
  }
  return value;
}

function streamHash(workspaceId: string, runId: string): string {
  return sha256(`${workspaceId}\0${runId}`);
}

function defaultState(workspaceId: string, runId: string): JournalState {
  return Object.freeze({
    schema: 'openslack.workflow_control_shadow_journal_state.v1' as const,
    workspaceId,
    runId,
    lastSequence: 0,
    ackedSequence: 0,
    lastObservationHash: null,
    incomplete: false,
  });
}

function validateState(value: unknown, workspaceId: string, runId: string): JournalState {
  const object = plainObject(value, 'Workflow Control shadow journal state');
  if (
    !exactKeys(object, [
      'schema',
      'workspaceId',
      'runId',
      'lastSequence',
      'ackedSequence',
      'lastObservationHash',
      'incomplete',
    ]) ||
    object.schema !== 'openslack.workflow_control_shadow_journal_state.v1' ||
    object.workspaceId !== workspaceId ||
    object.runId !== runId ||
    typeof object.incomplete !== 'boolean' ||
    (object.lastObservationHash !== null &&
      (typeof object.lastObservationHash !== 'string' || !HASH.test(object.lastObservationHash)))
  ) {
    throw new TypeError('Workflow Control shadow journal state is invalid.');
  }
  const lastSequence = safeInteger(object.lastSequence, 'state.lastSequence');
  const ackedSequence = safeInteger(object.ackedSequence, 'state.ackedSequence');
  if (ackedSequence > lastSequence)
    throw new TypeError('Journal acknowledgement exceeds sequence.');
  return immutable({
    schema: 'openslack.workflow_control_shadow_journal_state.v1' as const,
    workspaceId,
    runId,
    lastSequence,
    ackedSequence,
    lastObservationHash: object.lastObservationHash as string | null,
    incomplete: object.incomplete,
  });
}

async function loadState(
  directories: JournalDirectories,
  workspaceId: string,
  runId: string,
): Promise<JournalState> {
  const path = join(directories.states, `${streamHash(workspaceId, runId)}.json`);
  try {
    return validateState(await readCanonical(path, directories.security), workspaceId, runId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultState(workspaceId, runId);
    throw error;
  }
}

async function persistState(directories: JournalDirectories, state: JournalState): Promise<void> {
  await atomicWrite(
    join(directories.states, `${streamHash(state.workspaceId, state.runId)}.json`),
    `${canonicalWorkflowControlJson(validateState(state, state.workspaceId, state.runId))}\n`,
    directories.security,
  );
}

async function acquireStreamLock(
  directories: JournalDirectories,
  hashValue: string,
): Promise<() => Promise<void>> {
  const path = join(directories.locks, `${hashValue}.lock`);
  const now = directories.security.now ?? Date.now;
  const sleep =
    directories.security.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolvePromise) => setTimeout(resolvePromise, milliseconds)));
  const processId = directories.security.processId ?? process.pid;
  const processSessionId = directories.security.processSessionId ?? PROCESS_SESSION_ID;
  const probeProcess = directories.security.probeProcess ?? ((pid: number) => process.kill(pid, 0));
  const deadline = now() + WORKFLOW_CONTROL_SHADOW_POLICY.maxTimeoutMs;
  while (now() <= deadline) {
    try {
      const body = `${canonicalWorkflowControlJson({
        schema: JOURNAL_LOCK_SCHEMA,
        pid: processId,
        sessionId: processSessionId,
        createdAt: new Date(now()).toISOString(),
      })}\n`;
      let created: BigIntStats | undefined;
      let handle: FileHandle | undefined;
      try {
        await writeExclusiveWithIdentity(path, body, directories.security);
        created = await lstat(path, { bigint: true });
        await syncDirectory(directories.locks);
        handle = await open(path, fsConstants.O_RDONLY | NO_FOLLOW);
        const acquired = await handle.stat({ bigint: true });
        const linked = await lstat(path, { bigint: true });
        if (!sameIdentity(acquired, linked)) {
          throw new TypeError(
            'Workflow Control shadow journal lock identity changed after acquire.',
          );
        }
        created = linked;
        const ownedHandle = handle;
        return async () => {
          let releaseError: unknown;
          try {
            const opened = await ownedHandle.stat({ bigint: true });
            const current = await lstat(path, { bigint: true });
            if (!sameIdentity(acquired, opened) || !sameIdentity(opened, current)) {
              throw new TypeError('Workflow Control shadow journal lock changed before release.');
            }
          } catch (error) {
            releaseError = error;
          } finally {
            await ownedHandle.close().catch((error) => {
              releaseError ??= error;
            });
          }
          if (releaseError !== undefined) throw releaseError;
          await unlink(path);
          await syncDirectory(directories.locks);
        };
      } catch (creationError) {
        if ((creationError as NodeJS.ErrnoException).code === 'EEXIST') throw creationError;
        const cleanupErrors: unknown[] = [];
        if (handle) await handle.close().catch((error) => cleanupErrors.push(error));
        if (created) {
          try {
            const current = await lstat(path, { bigint: true });
            if (sameIdentity(created, current)) {
              await unlink(path);
              await syncDirectory(directories.locks);
            }
          } catch (cleanupError) {
            if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
              cleanupErrors.push(cleanupError);
            }
          }
        }
        if (cleanupErrors.length > 0) {
          throw new AggregateError(
            [creationError, ...cleanupErrors],
            'Workflow Control shadow journal lock creation and cleanup both failed.',
          );
        }
        throw creationError;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let before: BigIntStats | undefined;
      let lock: JsonRecord;
      try {
        before = await lstat(path, { bigint: true });
        lock = plainObject(
          await readCanonical(path, directories.security),
          'Workflow Control shadow journal lock',
        );
      } catch (inspectionError) {
        if ((inspectionError as NodeJS.ErrnoException).code === 'ENOENT') continue;
        // O_EXCL publishes the directory entry before the creator has finished
        // hardening and syncing it. Only retry an inspection failure when the
        // path identity demonstrably changed during that construction window;
        // stable malformed or unsafe locks remain fail-closed.
        if (before !== undefined) {
          try {
            const repeated = await lstat(path, { bigint: true });
            if (!sameIdentity(before, repeated)) {
              await sleep(WORKFLOW_CONTROL_SHADOW_POLICY.defaultOrderingRetryDelayMs);
              continue;
            }
          } catch (repeatError) {
            if ((repeatError as NodeJS.ErrnoException).code === 'ENOENT') continue;
            throw repeatError;
          }
        }
        throw inspectionError;
      }
      if (
        !exactKeys(lock, ['schema', 'pid', 'sessionId', 'createdAt']) ||
        lock.schema !== JOURNAL_LOCK_SCHEMA ||
        typeof lock.sessionId !== 'string' ||
        !LOCK_SESSION_ID.test(lock.sessionId) ||
        typeof lock.createdAt !== 'string' ||
        !TIMESTAMP.test(lock.createdAt) ||
        !Number.isFinite(Date.parse(lock.createdAt))
      ) {
        throw new TypeError('Workflow Control shadow journal lock is invalid.');
      }
      const pid = safeInteger(lock.pid, 'lock.pid', 1);
      let live = true;
      if (pid === processId && lock.sessionId !== processSessionId) {
        // A lock from this PID but another process session proves PID reuse.
        live = false;
      } else {
        try {
          probeProcess(pid);
        } catch (probeError) {
          const code = (probeError as NodeJS.ErrnoException).code;
          if (code === 'ESRCH') live = false;
          else if (code !== 'EPERM') throw probeError;
        }
      }
      if (!live) {
        try {
          const repeated = await lstat(path, { bigint: true });
          if (sameIdentity(before, repeated)) {
            await unlink(path);
            await syncDirectory(directories.locks);
            continue;
          }
        } catch (reclaimError) {
          if ((reclaimError as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw reclaimError;
        }
      }
      await sleep(WORKFLOW_CONTROL_SHADOW_POLICY.defaultOrderingRetryDelayMs);
    }
  }
  throw new TypeError('Workflow Control shadow journal lock deadline exceeded.');
}

/** Shared owner-safe crash-recovering lock primitive for sibling local journals. */
export async function acquireOwnerJournalLock(
  locksDirectory: string,
  lockHash: string,
  security: WorkflowControlShadowJournalSecurityDependencies,
): Promise<() => Promise<void>> {
  return acquireStreamLock(
    {
      root: locksDirectory,
      entries: locksDirectory,
      states: locksDirectory,
      locks: locksDirectory,
      security,
    },
    lockHash,
  );
}

async function streamEntries(directories: JournalDirectories, hashValue: string) {
  const result: { path: string; sequence: number }[] = [];
  for (const name of await readdir(directories.entries)) {
    if (!name.startsWith(`${hashValue}.`)) continue;
    const match = ENTRY_NAME.exec(name);
    if (!match || match[1] !== hashValue) throw new TypeError('Journal entry name is invalid.');
    result.push({ path: join(directories.entries, name), sequence: Number(match[2]) });
  }
  return result.sort((left, right) => left.sequence - right.sequence);
}

async function assertJournalCapacity(directories: JournalDirectories, addedBytes: number) {
  let entries = 0;
  let bytes = 0;
  for (const directory of [directories.entries, directories.states]) {
    for (const name of await readdir(directory)) {
      const path = join(directory, name);
      const value = await assertOwnerFile(path, directories.security);
      entries += 1;
      bytes += Number(value.size);
    }
  }
  if (
    entries + 2 > WORKFLOW_CONTROL_SHADOW_POLICY.maxJournalEntries ||
    bytes + addedBytes > WORKFLOW_CONTROL_SHADOW_POLICY.maxJournalBytes
  ) {
    throw new TypeError('Workflow Control shadow journal capacity is exceeded.');
  }
}

class WorkflowControlObservationPortImpl implements WorkflowControlObservationPort {
  readonly #workspaceId: string;
  readonly #directories: JournalDirectories;
  readonly #publisher: WorkflowControlShadowPublisherPort;
  readonly #buildObservation: (runId: string) => Promise<WorkflowControlObservation>;
  readonly #diagnosticSink?: WorkflowControlShadowDiagnosticSink;
  readonly #scheduled = new Set<Promise<void>>();

  constructor(
    workspaceId: string,
    directories: JournalDirectories,
    publisher: WorkflowControlShadowPublisherPort,
    buildObservation: CreateWorkflowControlObservationPortOptions['buildObservation'],
    diagnosticSink?: WorkflowControlShadowDiagnosticSink,
  ) {
    this.#workspaceId = workspaceId;
    this.#directories = directories;
    this.#publisher = publisher;
    this.#buildObservation = async (runId) =>
      validateWorkflowControlObservation(await buildObservation!(runId));
    this.#diagnosticSink = diagnosticSink;
  }

  observeRun(runIdValue: string): void {
    try {
      const runId = identifier(runIdValue, 'runId');
      this.#track(
        this.#enqueue(runId, async () => {
          let observation: WorkflowControlObservation;
          try {
            observation = await this.#buildObservation(runId);
          } catch (error) {
            this.#diagnose(
              error instanceof WorkflowControlObservationError &&
                error.code === 'WORKFLOW_CONTROL_OBSERVATION_LEGACY_MANIFEST_HASH'
                ? 'legacy_manifest_skipped'
                : 'observation_invalid',
              runId,
              undefined,
              error instanceof WorkflowControlObservationError ? error.code.toLowerCase() : 'build',
            );
            return;
          }
          await this.#append(observation);
          await this.#drain(runId);
        }),
      );
    } catch {
      // Shadow observation is fail-open relative to the TypeScript authority.
    }
  }

  async replay(): Promise<void> {
    try {
      const work: Promise<void>[] = [];
      const stateHashes = new Set<string>();
      for (const name of await readdir(this.#directories.states)) {
        const match = STATE_NAME.exec(name);
        if (!match) throw new TypeError('Workflow Control shadow state name is invalid.');
        const hashValue = match[1]!;
        stateHashes.add(hashValue);
        const object = plainObject(
          await readCanonical(join(this.#directories.states, name), this.#directories.security),
          'Workflow Control shadow state',
        );
        const workspaceId = identifier(object.workspaceId, 'state.workspaceId');
        const runId = identifier(object.runId, 'state.runId');
        if (workspaceId !== this.#workspaceId || streamHash(workspaceId, runId) !== hashValue) {
          throw new TypeError('Workflow Control shadow state binding is invalid.');
        }
        let state = validateState(object, workspaceId, runId);
        const entries = await streamEntries(this.#directories, hashValue);
        let expected = state.ackedSequence + 1;
        let markedIncomplete = false;
        for (const entry of entries.filter((item) => item.sequence > state.ackedSequence)) {
          const envelope = validateWorkflowControlShadowEnvelope(
            await readCanonical(entry.path, this.#directories.security),
          );
          if (
            envelope.source.workspaceId !== workspaceId ||
            envelope.source.runId !== runId ||
            envelope.source.sourceSequence !== entry.sequence
          ) {
            throw new TypeError('Workflow Control shadow replay binding is invalid.');
          }
          if (entry.sequence !== expected) {
            await this.#markIncomplete(state, expected);
            markedIncomplete = true;
            break;
          }
          expected += 1;
        }
        const maximumEntry = entries.at(-1);
        if (maximumEntry && maximumEntry.sequence > state.lastSequence) {
          const envelope = validateWorkflowControlShadowEnvelope(
            await readCanonical(maximumEntry.path, this.#directories.security),
          );
          state = immutable({
            ...state,
            lastSequence: maximumEntry.sequence,
            lastObservationHash: hashWorkflowControlValue(envelope.observation),
          });
          await persistState(this.#directories, state);
        }
        if (!markedIncomplete && expected <= state.lastSequence) {
          await this.#markIncomplete(state, expected);
        }
        work.push(this.#enqueue(runId, () => this.#drain(runId)));
      }

      const orphanHashes = new Set<string>();
      for (const name of await readdir(this.#directories.entries)) {
        const match = ENTRY_NAME.exec(name);
        if (!match) throw new TypeError('Workflow Control shadow entry name is invalid.');
        if (!stateHashes.has(match[1]!)) orphanHashes.add(match[1]!);
      }
      for (const hashValue of orphanHashes) {
        const entries = await streamEntries(this.#directories, hashValue);
        const first = entries[0];
        if (!first) continue;
        const firstEnvelope = validateWorkflowControlShadowEnvelope(
          await readCanonical(first.path, this.#directories.security),
        );
        const { workspaceId, runId } = firstEnvelope.source;
        if (workspaceId !== this.#workspaceId || streamHash(workspaceId, runId) !== hashValue) {
          throw new TypeError('Workflow Control shadow orphan binding is invalid.');
        }
        let expected = 1;
        let incomplete = false;
        let lastObservationHash = hashWorkflowControlValue(firstEnvelope.observation);
        for (const entry of entries) {
          const envelope = validateWorkflowControlShadowEnvelope(
            await readCanonical(entry.path, this.#directories.security),
          );
          if (
            envelope.source.workspaceId !== workspaceId ||
            envelope.source.runId !== runId ||
            envelope.source.sourceSequence !== entry.sequence
          ) {
            throw new TypeError('Workflow Control shadow orphan entry is inconsistent.');
          }
          if (entry.sequence !== expected) incomplete = true;
          expected = entry.sequence + 1;
          lastObservationHash = hashWorkflowControlValue(envelope.observation);
        }
        const state = immutable({
          ...defaultState(workspaceId, runId),
          lastSequence: entries.at(-1)!.sequence,
          lastObservationHash,
          incomplete,
        });
        await persistState(this.#directories, state);
        if (incomplete) this.#diagnose('journal_incomplete', runId, 1, 'orphan_gap');
        work.push(this.#enqueue(runId, () => this.#drain(runId)));
      }
      await Promise.allSettled(work);
    } catch {
      this.#diagnose('journal_invalid', 'invalid', undefined, 'replay');
    }
  }

  async flush(): Promise<void> {
    await Promise.allSettled([...this.#scheduled]);
  }

  #track(promise: Promise<void>): void {
    this.#scheduled.add(promise);
    void promise.finally(() => this.#scheduled.delete(promise)).catch(() => undefined);
  }

  #enqueue(runId: string, operation: () => Promise<void>): Promise<void> {
    const hashValue = streamHash(this.#workspaceId, runId);
    const key = `${this.#directories.root}\0${hashValue}`;
    const current = enqueueByKey(streamTails, key, operation);
    return current.catch(() => {
      this.#diagnose('journal_invalid', runId, undefined, 'append');
    });
  }

  async #append(observation: WorkflowControlObservation): Promise<void> {
    const runId = observation.runId;
    const hashValue = streamHash(this.#workspaceId, runId);
    const releaseCapacity = await acquireStreamLock(this.#directories, JOURNAL_CAPACITY_LOCK_HASH);
    try {
      const releaseStream = await acquireStreamLock(this.#directories, hashValue);
      try {
        let state = await loadState(this.#directories, this.#workspaceId, runId);
        const observationHash = hashWorkflowControlValue(observation);
        if (state.lastObservationHash === observationHash) return;
        const sourceSequence = state.lastSequence + 1;
        const envelope = validateWorkflowControlShadowEnvelope({
          authority: 'typescript',
          observation,
          projection: projectWorkflowControlReadModel(observation),
          schema: WORKFLOW_CONTROL_SHADOW_OBSERVATION_SCHEMA,
          source: { runId, sourceSequence, workspaceId: this.#workspaceId },
        });
        const body = `${canonicalWorkflowControlJson(envelope)}\n`;
        const digest = sha256(body);
        const path = join(
          this.#directories.entries,
          `${hashValue}.${String(sourceSequence).padStart(16, '0')}.${digest}.json`,
        );
        state = immutable({
          ...state,
          lastSequence: sourceSequence,
          lastObservationHash: observationHash,
        });
        const stateBody = `${canonicalWorkflowControlJson(state)}\n`;
        await assertJournalCapacity(
          this.#directories,
          Buffer.byteLength(body, 'utf8') + Buffer.byteLength(stateBody, 'utf8'),
        );
        await writeExclusive(path, body, this.#directories.security);
        await syncDirectory(this.#directories.entries);
        await persistState(this.#directories, state);
      } finally {
        await releaseStream();
      }
    } finally {
      await releaseCapacity();
    }
  }

  async #drain(runId: string): Promise<void> {
    const hashValue = streamHash(this.#workspaceId, runId);
    let state = await loadState(this.#directories, this.#workspaceId, runId);
    for (const entry of await streamEntries(this.#directories, hashValue)) {
      if (entry.sequence <= state.ackedSequence) {
        await assertOwnerFile(entry.path, this.#directories.security);
        await rm(entry.path, { force: true });
        continue;
      }
      if (entry.sequence !== state.ackedSequence + 1) {
        await this.#markIncomplete(state, entry.sequence);
        return;
      }
      const envelope = validateWorkflowControlShadowEnvelope(
        await readCanonical(entry.path, this.#directories.security),
      );
      if (
        envelope.source.workspaceId !== this.#workspaceId ||
        envelope.source.runId !== runId ||
        envelope.source.sourceSequence !== entry.sequence
      ) {
        await this.#markIncomplete(state, entry.sequence);
        return;
      }
      let receipt: WorkflowControlShadowReceipt;
      try {
        receipt = await this.#publisher.publish(envelope);
      } catch {
        this.#diagnose('unavailable', runId, entry.sequence, 'publish');
        return;
      }
      if (receipt.status === 'reconciliation_required') {
        this.#diagnose('unavailable', runId, entry.sequence, 'reconciliation_required');
        return;
      }
      const release = await acquireStreamLock(this.#directories, hashValue);
      try {
        state = await loadState(this.#directories, this.#workspaceId, runId);
        if (state.ackedSequence + 1 !== entry.sequence) return;
        state = immutable({ ...state, ackedSequence: entry.sequence });
        await persistState(this.#directories, state);
        await rm(entry.path, { force: true });
        await syncDirectory(this.#directories.entries);
      } finally {
        await release();
      }
      this.#diagnose(
        receipt.parity === 'mismatched' ? 'mismatched' : receipt.status,
        runId,
        entry.sequence,
        receipt.mismatchCode,
      );
    }
  }

  async #markIncomplete(state: JournalState, sequence: number): Promise<void> {
    const hashValue = streamHash(state.workspaceId, state.runId);
    const release = await acquireStreamLock(this.#directories, hashValue);
    try {
      const current = await loadState(this.#directories, state.workspaceId, state.runId);
      await persistState(this.#directories, immutable({ ...current, incomplete: true }));
    } finally {
      await release();
    }
    this.#diagnose('journal_incomplete', state.runId, sequence, 'gap');
  }

  #diagnose(
    outcome: WorkflowControlShadowDiagnosticOutcome,
    runId: string,
    sourceSequence?: number,
    code?: string,
  ): void {
    if (!this.#diagnosticSink) return;
    const safeCode =
      code !== undefined &&
      RECEIPT_CODE.test(code) &&
      Buffer.byteLength(code, 'utf8') <= WORKFLOW_CONTROL_SHADOW_POLICY.maxDiagnosticCodeBytes
        ? code
        : undefined;
    const diagnostic = immutable({
      schema: 'openslack.workflow_control_shadow_diagnostic.v1' as const,
      outcome,
      workspaceIdHash: sha256(this.#workspaceId),
      runIdHash: sha256(runId),
      ...(sourceSequence === undefined ? {} : { sourceSequence }),
      ...(safeCode === undefined ? {} : { code: safeCode }),
    });
    try {
      void Promise.resolve(this.#diagnosticSink(diagnostic)).catch(() => undefined);
    } catch {
      // Diagnostics cannot affect either authority or shadow delivery.
    }
  }
}

const NOOP_PORT: WorkflowControlObservationPort = Object.freeze({
  observeRun() {},
  async replay() {},
  async flush() {},
});
PORTS.add(NOOP_PORT);

function validateJournalSecurityDependencies(
  value: WorkflowControlShadowJournalSecurityDependencies,
): WorkflowControlShadowJournalSecurityDependencies {
  const object = plainObject(value, 'Workflow Control shadow journal security dependencies');
  if (
    !exactKeys(
      object,
      ['platform', 'currentWindowsSid', 'readWindowsPathSecurity', 'hardenPath'],
      ['now', 'sleep', 'processId', 'processSessionId', 'probeProcess'],
    ) ||
    typeof object.platform !== 'string' ||
    typeof object.currentWindowsSid !== 'function' ||
    nodeTypes.isProxy(object.currentWindowsSid) ||
    typeof object.readWindowsPathSecurity !== 'function' ||
    nodeTypes.isProxy(object.readWindowsPathSecurity) ||
    typeof object.hardenPath !== 'function' ||
    nodeTypes.isProxy(object.hardenPath) ||
    (object.now !== undefined &&
      (typeof object.now !== 'function' || nodeTypes.isProxy(object.now))) ||
    (object.sleep !== undefined &&
      (typeof object.sleep !== 'function' || nodeTypes.isProxy(object.sleep))) ||
    (object.processId !== undefined &&
      (!Number.isSafeInteger(object.processId) || (object.processId as number) < 1)) ||
    (object.processSessionId !== undefined &&
      (typeof object.processSessionId !== 'string' ||
        !LOCK_SESSION_ID.test(object.processSessionId))) ||
    (object.probeProcess !== undefined &&
      (typeof object.probeProcess !== 'function' || nodeTypes.isProxy(object.probeProcess)))
  ) {
    throw new TypeError('Workflow Control shadow journal security dependencies are invalid.');
  }
  return value;
}

async function createWorkflowControlObservationPortWithSecurity(
  options: CreateWorkflowControlObservationPortOptions,
  securityValue: WorkflowControlShadowJournalSecurityDependencies,
): Promise<WorkflowControlObservationPort> {
  const object = plainObject(options, 'Workflow Control observation port options');
  if (object.enabled !== true) {
    if (
      !exactKeys(object, [], ['enabled']) ||
      (object.enabled !== undefined && object.enabled !== false)
    ) {
      throw new TypeError('Disabled Workflow Control shadow options are not closed.');
    }
    return NOOP_PORT;
  }
  if (
    !exactKeys(
      object,
      ['enabled', 'workspaceId', 'journalRoot', 'publisher', 'buildObservation'],
      ['diagnosticSink'],
    ) ||
    !isWorkflowControlShadowPublisherPort(object.publisher) ||
    typeof object.buildObservation !== 'function' ||
    nodeTypes.isProxy(object.buildObservation) ||
    (object.diagnosticSink !== undefined &&
      (typeof object.diagnosticSink !== 'function' || nodeTypes.isProxy(object.diagnosticSink)))
  ) {
    throw new TypeError('Enabled Workflow Control shadow options are invalid or incomplete.');
  }
  const workspaceId = identifier(object.workspaceId, 'workspaceId');
  const security = validateJournalSecurityDependencies(securityValue);
  const directories = await initializeJournal(object.journalRoot as string, security);
  const port = Object.freeze(
    new WorkflowControlObservationPortImpl(
      workspaceId,
      directories,
      object.publisher as WorkflowControlShadowPublisherPort,
      object.buildObservation as CreateWorkflowControlObservationPortOptions['buildObservation'],
      object.diagnosticSink as WorkflowControlShadowDiagnosticSink | undefined,
    ),
  );
  PORTS.add(port);
  await port.replay();
  return port;
}

/** Default-off composition. Enabling requires every host-owned shadow dependency. */
export async function createWorkflowControlObservationPort(
  options: CreateWorkflowControlObservationPortOptions = {},
): Promise<WorkflowControlObservationPort> {
  return createWorkflowControlObservationPortWithSecurity(options, productionJournalSecurity());
}

/** Qualification seam for platform ACL checks; production always uses host-derived security. */
export async function createWorkflowControlObservationPortForTest(
  options: CreateWorkflowControlObservationPortOptions,
  security: WorkflowControlShadowJournalSecurityDependencies,
): Promise<WorkflowControlObservationPort> {
  return createWorkflowControlObservationPortWithSecurity(options, security);
}

export function isWorkflowControlObservationPort(
  value: unknown,
): value is WorkflowControlObservationPort {
  return Boolean(
    value && typeof value === 'object' && !nodeTypes.isProxy(value) && PORTS.has(value),
  );
}

/** Convenience type guard input for host builders; it has no I/O behavior. */
export type WorkflowControlObservationBuilderOptions = BuildWorkflowControlObservationOptions;
