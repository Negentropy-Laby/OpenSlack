import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, type Stats } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  type FileHandle,
} from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { types as utilTypes } from 'node:util';
import {
  canonicalGovernedJson,
  validateGovernedPlanRecord,
  type GovernedPlanExecution,
  type GovernedPlanRecord,
} from './governed-plan.js';
import {
  canGovernedPlanStateTransition,
  isGovernedPlanStore,
  registerGovernedPlanStore,
  type GovernedPlanStore,
} from './governed-plan-store.js';
import type { GovernedPlanAuditEvent, GovernedPlanAuditSink } from './governed-plan-service.js';

export type GovernanceAuthorityBackend = 'go' | 'ts-local';
export type GovernanceAuthorityOwner = 'governance-control' | 'typescript';

export interface GovernedPlanAuthorityRoute {
  readonly backend: GovernanceAuthorityBackend;
  readonly routingEpoch: number;
  readonly authority: GovernanceAuthorityOwner;
}

export interface PersistedGovernedPlanAuthorityRoute extends GovernedPlanAuthorityRoute {
  readonly schema: 'openslack.governed_plan_authority_route.v1';
  readonly planId: string;
  readonly createdAt: string;
}

export interface GovernedPlanAuthorityPolicy extends GovernedPlanAuthorityRoute {
  readonly schema: 'openslack.governed_plan_authority_policy.v1';
  /** Bounded epochs that may still own Go records after a route-index loss. */
  readonly goRoutingEpochs: readonly number[];
  readonly updatedAt: string;
}

export type GovernanceAuthorityTransitionOperation =
  | 'claim_execution'
  | 'complete_execution'
  | 'cancel'
  | 'expire'
  | 'require_reconciliation';

export type GovernanceAuthorityMutationOperation =
  | 'accept'
  | GovernanceAuthorityTransitionOperation;

export interface GovernanceAuthorityPendingAudit {
  readonly operation: GovernanceAuthorityMutationOperation;
  readonly recordHash: string;
}

export interface GovernanceAuthorityGoPort {
  accept(
    record: GovernedPlanRecord,
    route: GovernedPlanAuthorityRoute,
  ): Promise<GovernedPlanRecord>;
  load(planId: string, route: GovernedPlanAuthorityRoute): Promise<GovernedPlanRecord | null>;
  transition(
    operation: GovernanceAuthorityTransitionOperation,
    target: GovernedPlanRecord,
    expectedRevision: number,
    route: GovernedPlanAuthorityRoute,
  ): Promise<GovernedPlanRecord>;
  pendingAudit(
    planId: string,
    revision: number,
    route: GovernedPlanAuthorityRoute,
  ): Promise<GovernanceAuthorityPendingAudit | null>;
  recordAudit(event: GovernedPlanAuditEvent, route: GovernedPlanAuthorityRoute): Promise<void>;
}

export interface CreateRoutedGovernedPlanStoreOptions {
  readonly routeRoot: string;
  readonly localStore: GovernedPlanStore;
  readonly backend: GovernanceAuthorityBackend;
  readonly routingEpoch: number;
  readonly go?: GovernanceAuthorityGoPort;
  readonly now?: () => Date;
}

const ROUTE_SCHEMA = 'openslack.governed_plan_authority_route.v1';
const POLICY_SCHEMA = 'openslack.governed_plan_authority_policy.v1';
const AUDIT_JOURNAL_SCHEMA = 'openslack.governed_plan_authority_audit_journal.v1';
const PLAN_ID = /^GPLAN-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const AUDIT_EVENT_ID =
  /^GAUDIT-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ROUTE_FILE = /^[0-9a-f]{64}\.json$/u;
const TEMP_FILE = /^\.[0-9a-f]{64}\.[0-9a-f-]{36}\.tmp$/u;
const JOURNAL_FILE = /^[0-9a-f]{64}\.json$/u;
const JOURNAL_TEMP = /^\.[0-9a-f]{64}\.[0-9a-f-]{36}\.tmp$/u;
const POLICY_TEMP = /^\.policy\.[0-9a-f-]{36}\.tmp$/u;
const POLICY_LOCK = 'policy.lock';
const MAX_ROUTE_BYTES = 8 * 1024;
const MAX_JOURNAL_BYTES = 128 * 1024;
const MAX_JOURNAL_FILES = 4_096;
const MAX_ROUTE_FILES = 4_096;
const MAX_GO_ROUTING_EPOCHS = 128;
const NO_FOLLOW = process.platform === 'win32' ? 0 : (fsConstants.O_NOFOLLOW ?? 0);
const GO_PORTS = new WeakSet<object>();

interface PreparedAuthorityRoot {
  readonly root: string;
  readonly rootReal: string;
  readonly rootStat: Stats;
  readonly routes: string;
  readonly routesReal: string;
  readonly routesStat: Stats;
  readonly journal: string;
  readonly journalReal: string;
  readonly journalStat: Stats;
}

interface AuditJournalEntry {
  readonly schema: typeof AUDIT_JOURNAL_SCHEMA;
  readonly state: 'prepared' | 'collaboration_recorded';
  readonly event: GovernedPlanAuditEvent;
  readonly route: GovernedPlanAuthorityRoute;
  readonly preparedAt: string;
  readonly collaborationRecordedAt?: string;
}

export class GovernedPlanAuthorityStoreError extends Error {
  constructor(
    readonly code:
      | 'GOVERNED_PLAN_AUTHORITY_POLICY_INVALID'
      | 'GOVERNED_PLAN_AUTHORITY_ROUTE_UNSAFE'
      | 'GOVERNED_PLAN_AUTHORITY_ROUTE_CONFLICT'
      | 'GOVERNED_PLAN_AUTHORITY_TRANSPORT_UNAVAILABLE'
      | 'GOVERNED_PLAN_AUTHORITY_TRANSITION_INVALID',
    message: string,
  ) {
    super(message);
    this.name = 'GovernedPlanAuthorityStoreError';
  }
}

function fail(code: GovernedPlanAuthorityStoreError['code'], message: string): never {
  throw new GovernedPlanAuthorityStoreError(code, message);
}

function exactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function routeFor(
  backend: GovernanceAuthorityBackend,
  routingEpoch: number,
): GovernedPlanAuthorityRoute {
  if (!Number.isSafeInteger(routingEpoch) || routingEpoch < 1) {
    return fail(
      'GOVERNED_PLAN_AUTHORITY_POLICY_INVALID',
      'Governance authority routing epoch must be a positive safe integer.',
    );
  }
  return Object.freeze({
    backend,
    routingEpoch,
    authority: backend === 'go' ? 'governance-control' : 'typescript',
  });
}

function safeDate(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    return fail(
      'GOVERNED_PLAN_AUTHORITY_POLICY_INVALID',
      'Governance authority clock returned an invalid date.',
    );
  }
  return value.toISOString();
}

function contained(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) =>
    process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
  return normalize(left) === normalize(right);
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function stableIdentity(left: Stats, right: Stats): boolean {
  return (
    sameIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

async function lstatIfPresent(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function realDirectory(
  path: string,
): Promise<{ readonly real: string; readonly stat: Stats }> {
  const stat = await lstatIfPresent(path);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
    return fail(
      'GOVERNED_PLAN_AUTHORITY_ROUTE_UNSAFE',
      'Governance authority route path must be a real directory.',
    );
  }
  const actual = await realpath(path);
  if (!samePath(path, actual)) {
    return fail(
      'GOVERNED_PLAN_AUTHORITY_ROUTE_UNSAFE',
      'Governance authority route path cannot traverse a symlink or reparse point.',
    );
  }
  return Object.freeze({ real: actual, stat });
}

async function ensureDirectory(
  parentReal: string,
  path: string,
): Promise<{ readonly real: string; readonly stat: Stats }> {
  if (!(await lstatIfPresent(path))) await mkdir(path, { recursive: false, mode: 0o700 });
  const directory = await realDirectory(path);
  if (!contained(parentReal, directory.real)) {
    return fail(
      'GOVERNED_PLAN_AUTHORITY_ROUTE_UNSAFE',
      'Governance authority child directory escapes its root.',
    );
  }
  return directory;
}

async function scanFiles(
  directory: string,
  names: readonly RegExp[],
  maximumFiles: number,
  maximumBytes: number,
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length > maximumFiles) {
    return fail(
      'GOVERNED_PLAN_AUTHORITY_ROUTE_UNSAFE',
      'Governance authority directory exceeds its bounded entry limit.',
    );
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    const stat = await lstat(path);
    if (
      entry.isSymbolicLink() ||
      stat.isSymbolicLink() ||
      !entry.isFile() ||
      !stat.isFile() ||
      !names.some((pattern) => pattern.test(entry.name)) ||
      stat.size < 1 ||
      stat.size > maximumBytes
    ) {
      return fail(
        'GOVERNED_PLAN_AUTHORITY_ROUTE_UNSAFE',
        'Governance authority directory contains an unknown or unsafe entry.',
      );
    }
  }
}

async function initializeRoot(configuredRoot: string): Promise<PreparedAuthorityRoot> {
  if (!isAbsolute(configuredRoot) || resolve(configuredRoot) !== configuredRoot) {
    return fail(
      'GOVERNED_PLAN_AUTHORITY_ROUTE_UNSAFE',
      'Governance authority route root must be absolute and normalized.',
    );
  }
  await mkdir(configuredRoot, { recursive: true, mode: 0o700 });
  const root = await realDirectory(configuredRoot);
  const routes = await ensureDirectory(root.real, join(root.real, 'routes'));
  const journal = await ensureDirectory(root.real, join(root.real, 'audit-journal'));
  for (const entry of await readdir(root.real, { withFileTypes: true })) {
    if (
      (entry.name === 'routes' && entry.isDirectory() && !entry.isSymbolicLink()) ||
      (entry.name === 'audit-journal' && entry.isDirectory() && !entry.isSymbolicLink()) ||
      (entry.name === 'policy.json' && entry.isFile() && !entry.isSymbolicLink()) ||
      (entry.name === POLICY_LOCK && entry.isFile() && !entry.isSymbolicLink()) ||
      (POLICY_TEMP.test(entry.name) && entry.isFile() && !entry.isSymbolicLink())
    ) {
      continue;
    }
    return fail(
      'GOVERNED_PLAN_AUTHORITY_ROUTE_UNSAFE',
      'Governance authority route root contains an unknown entry.',
    );
  }
  await scanFiles(routes.real, [ROUTE_FILE, TEMP_FILE], MAX_JOURNAL_FILES * 2, MAX_ROUTE_BYTES);
  await scanFiles(
    journal.real,
    [JOURNAL_FILE, JOURNAL_TEMP],
    MAX_JOURNAL_FILES * 2,
    MAX_JOURNAL_BYTES,
  );
  return Object.freeze({
    root: configuredRoot,
    rootReal: root.real,
    rootStat: root.stat,
    routes: join(root.real, 'routes'),
    routesReal: routes.real,
    routesStat: routes.stat,
    journal: join(root.real, 'audit-journal'),
    journalReal: journal.real,
    journalStat: journal.stat,
  });
}

async function assertDirectoryIdentity(prepared: PreparedAuthorityRoot): Promise<void> {
  const checks = [
    [prepared.root, prepared.rootReal, prepared.rootStat],
    [prepared.routes, prepared.routesReal, prepared.routesStat],
    [prepared.journal, prepared.journalReal, prepared.journalStat],
  ] as const;
  for (const [path, expectedReal, expectedStat] of checks) {
    const observed = await lstatIfPresent(path);
    if (
      !observed ||
      !observed.isDirectory() ||
      observed.isSymbolicLink() ||
      !sameIdentity(expectedStat, observed) ||
      !samePath(expectedReal, await realpath(path))
    ) {
      return fail(
        'GOVERNED_PLAN_AUTHORITY_ROUTE_UNSAFE',
        'Governance authority directory identity changed after initialization.',
      );
    }
  }
}

function routeFile(routes: string, planId: string): string {
  return join(routes, `${createHash('sha256').update(planId, 'utf8').digest('hex')}.json`);
}

async function readCanonical(
  path: string,
  parentReal: string,
  maximumBytes = MAX_ROUTE_BYTES,
): Promise<unknown | undefined> {
  const stat = await lstatIfPresent(path);
  if (!stat) return undefined;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > maximumBytes) {
    return fail(
      'GOVERNED_PLAN_AUTHORITY_ROUTE_UNSAFE',
      'Governance authority route file is unsafe.',
    );
  }
  const actual = await realpath(path);
  if (!samePath(path, actual) || !contained(parentReal, actual)) {
    return fail(
      'GOVERNED_PLAN_AUTHORITY_ROUTE_UNSAFE',
      'Governance authority file escapes its bound directory.',
    );
  }
  const handle = await open(path, fsConstants.O_RDONLY | NO_FOLLOW);
  let bytes: Buffer;
  try {
    const opened = await handle.stat();
    if (!stableIdentity(stat, opened)) {
      return fail(
        'GOVERNED_PLAN_AUTHORITY_ROUTE_UNSAFE',
        'Governance authority file changed before bounded read.',
      );
    }
    bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const after = await handle.stat();
    const named = await lstat(path);
    if (
      offset !== bytes.length ||
      !stableIdentity(opened, after) ||
      !stableIdentity(after, named)
    ) {
      return fail(
        'GOVERNED_PLAN_AUTHORITY_ROUTE_UNSAFE',
        'Governance authority file changed during bounded read.',
      );
    }
  } finally {
    await handle.close();
  }
  if (bytes.at(-1) !== 0x0a) {
    return fail(
      'GOVERNED_PLAN_AUTHORITY_ROUTE_UNSAFE',
      'Governance authority route file is not canonical.',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return fail(
      'GOVERNED_PLAN_AUTHORITY_ROUTE_UNSAFE',
      'Governance authority route file is invalid JSON.',
    );
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    `${canonicalGovernedJson(parsed as never)}\n` !== bytes.toString('utf8')
  ) {
    return fail(
      'GOVERNED_PLAN_AUTHORITY_ROUTE_UNSAFE',
      'Governance authority route file is not exact canonical JSON.',
    );
  }
  return parsed;
}

function parseRoute(value: unknown, planId: string): PersistedGovernedPlanAuthorityRoute {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return fail('GOVERNED_PLAN_AUTHORITY_ROUTE_UNSAFE', 'Governance authority route is invalid.');
  }
  const object = value as Readonly<Record<string, unknown>>;
  if (
    !exactKeys(object, ['schema', 'planId', 'backend', 'routingEpoch', 'authority', 'createdAt']) ||
    object.schema !== ROUTE_SCHEMA ||
    object.planId !== planId ||
    !PLAN_ID.test(planId) ||
    (object.backend !== 'go' && object.backend !== 'ts-local') ||
    !Number.isSafeInteger(object.routingEpoch) ||
    (object.routingEpoch as number) < 1 ||
    object.authority !== (object.backend === 'go' ? 'governance-control' : 'typescript') ||
    typeof object.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(object.createdAt)) ||
    new Date(Date.parse(object.createdAt)).toISOString() !== object.createdAt
  ) {
    return fail('GOVERNED_PLAN_AUTHORITY_ROUTE_UNSAFE', 'Governance authority route is invalid.');
  }
  return Object.freeze(object as unknown as PersistedGovernedPlanAuthorityRoute);
}

function parsePolicy(value: unknown): GovernedPlanAuthorityPolicy {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return fail('GOVERNED_PLAN_AUTHORITY_ROUTE_UNSAFE', 'Governance authority policy is invalid.');
  }
  const object = value as Readonly<Record<string, unknown>>;
  if (
    !exactKeys(object, [
      'schema',
      'backend',
      'routingEpoch',
      'authority',
      'goRoutingEpochs',
      'updatedAt',
    ]) ||
    object.schema !== POLICY_SCHEMA ||
    (object.backend !== 'go' && object.backend !== 'ts-local') ||
    !Number.isSafeInteger(object.routingEpoch) ||
    (object.routingEpoch as number) < 1 ||
    object.authority !== (object.backend === 'go' ? 'governance-control' : 'typescript') ||
    !Array.isArray(object.goRoutingEpochs) ||
    object.goRoutingEpochs.length > MAX_GO_ROUTING_EPOCHS ||
    object.goRoutingEpochs.some(
      (epoch, index) =>
        !Number.isSafeInteger(epoch) ||
        (epoch as number) < 1 ||
        (epoch as number) > (object.routingEpoch as number) ||
        (index > 0 && (object.goRoutingEpochs as number[])[index - 1]! >= (epoch as number)),
    ) ||
    (object.backend === 'go' &&
      !(object.goRoutingEpochs as number[]).includes(object.routingEpoch as number)) ||
    typeof object.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(object.updatedAt)) ||
    new Date(Date.parse(object.updatedAt)).toISOString() !== object.updatedAt
  ) {
    return fail('GOVERNED_PLAN_AUTHORITY_ROUTE_UNSAFE', 'Governance authority policy is invalid.');
  }
  return Object.freeze({
    ...(object as unknown as GovernedPlanAuthorityPolicy),
    goRoutingEpochs: Object.freeze([...(object.goRoutingEpochs as number[])]),
  });
}

const AUDIT_TYPES = new Set([
  'plan.previewed',
  'plan.confirmed',
  'plan.confirmation_rejected',
  'plan.cancelled',
  'plan.expired',
  'plan.execution_started',
  'plan.execution_completed',
  'plan.execution_blocked',
  'plan.execution_failed',
  'plan.reconciliation_required',
  'workflow.approval_decided',
]);
const PLAN_STATES = new Set([
  'pending',
  'executing',
  'succeeded',
  'blocked',
  'failed',
  'reconciliation_required',
  'cancelled',
  'expired',
]);

function canonicalTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    new Date(Date.parse(value)).toISOString() === value
  );
}

export function validateGovernanceAuthorityAuditEvent(value: unknown): GovernedPlanAuditEvent {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return fail(
      'GOVERNED_PLAN_AUTHORITY_ROUTE_UNSAFE',
      'Governance authority audit event is invalid.',
    );
  }
  const event = value as unknown as GovernedPlanAuditEvent;
  const object = value as Readonly<Record<string, unknown>>;
  const keys = [
    'schema',
    'eventId',
    'type',
    'occurredAt',
    'planId',
    'kind',
    'actorId',
    'workspaceId',
    'correlationId',
    'state',
    'revision',
    'evidenceRefs',
    ...(Object.hasOwn(object, 'details') ? ['details'] : []),
  ];
  const boundedText = (field: unknown, maximum = 512): field is string =>
    typeof field === 'string' && field.length > 0 && field.length <= maximum;
  if (
    !exactKeys(object, keys) ||
    event.schema !== 'openslack.governed_plan_audit.v1' ||
    !AUDIT_EVENT_ID.test(event.eventId) ||
    !AUDIT_TYPES.has(event.type) ||
    !canonicalTimestamp(event.occurredAt) ||
    !PLAN_ID.test(event.planId) ||
    !boundedText(event.kind) ||
    !boundedText(event.actorId, 256) ||
    !boundedText(event.workspaceId, 256) ||
    !boundedText(event.correlationId, 256) ||
    !PLAN_STATES.has(event.state) ||
    !Number.isSafeInteger(event.revision) ||
    event.revision < 1 ||
    !Array.isArray(event.evidenceRefs) ||
    event.evidenceRefs.length > 256 ||
    event.evidenceRefs.some((reference) => !boundedText(reference, 1_024))
  ) {
    return fail(
      'GOVERNED_PLAN_AUTHORITY_ROUTE_UNSAFE',
      'Governance authority audit event is invalid.',
    );
  }
  return Object.freeze(event);
}

function parseAuditJournal(value: unknown): AuditJournalEntry {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return fail(
      'GOVERNED_PLAN_AUTHORITY_ROUTE_UNSAFE',
      'Governance authority audit journal entry is invalid.',
    );
  }
  const object = value as Readonly<Record<string, unknown>>;
  const state = object.state;
  if (
    (state !== 'prepared' && state !== 'collaboration_recorded') ||
    !exactKeys(object, [
      'schema',
      'state',
      'event',
      'route',
      'preparedAt',
      ...(state === 'collaboration_recorded' ? ['collaborationRecordedAt'] : []),
    ]) ||
    object.schema !== AUDIT_JOURNAL_SCHEMA ||
    !canonicalTimestamp(object.preparedAt) ||
    (state === 'collaboration_recorded' && !canonicalTimestamp(object.collaborationRecordedAt))
  ) {
    return fail(
      'GOVERNED_PLAN_AUTHORITY_ROUTE_UNSAFE',
      'Governance authority audit journal entry is invalid.',
    );
  }
  const event = validateGovernanceAuthorityAuditEvent(object.event);
  const route = object.route as GovernedPlanAuthorityRoute;
  if (
    !route ||
    typeof route !== 'object' ||
    !exactKeys(route as unknown as Readonly<Record<string, unknown>>, [
      'backend',
      'routingEpoch',
      'authority',
    ]) ||
    route.backend !== 'go' ||
    route.authority !== 'governance-control' ||
    !Number.isSafeInteger(route.routingEpoch) ||
    route.routingEpoch < 1
  ) {
    return fail(
      'GOVERNED_PLAN_AUTHORITY_ROUTE_UNSAFE',
      'Governance authority audit journal route is invalid.',
    );
  }
  return Object.freeze({
    schema: AUDIT_JOURNAL_SCHEMA,
    state,
    event,
    route: Object.freeze({ ...route }),
    preparedAt: object.preparedAt,
    ...(state === 'collaboration_recorded'
      ? { collaborationRecordedAt: object.collaborationRecordedAt as string }
      : {}),
  });
}

function journalFile(journal: string, eventId: string): string {
  return join(journal, `${createHash('sha256').update(eventId, 'utf8').digest('hex')}.json`);
}

async function writeFileAtomic(
  path: string,
  temporary: string,
  bytes: string,
  parentReal: string,
  maximumBytes: number,
): Promise<void> {
  if (Buffer.byteLength(bytes, 'utf8') > maximumBytes) {
    return fail(
      'GOVERNED_PLAN_AUTHORITY_ROUTE_UNSAFE',
      'Governance authority file exceeds its bounded byte limit.',
    );
  }
  const handle = await open(
    temporary,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NO_FOLLOW,
    0o600,
  );
  let trusted: Stats;
  try {
    await handle.writeFile(bytes, 'utf8');
    await handle.sync();
    trusted = await handle.stat();
    const named = await lstat(temporary);
    if (!stableIdentity(trusted, named)) {
      return fail(
        'GOVERNED_PLAN_AUTHORITY_ROUTE_UNSAFE',
        'Governance authority temporary file identity changed.',
      );
    }
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    await syncDirectory(parentReal);
    const published = await lstat(path);
    if (!sameIdentity(trusted!, published) || !published.isFile() || published.isSymbolicLink()) {
      return fail(
        'GOVERNED_PLAN_AUTHORITY_ROUTE_UNSAFE',
        'Governance authority file identity changed during publication.',
      );
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

async function syncDirectory(path: string): Promise<void> {
  const initial = await lstatIfPresent(path);
  if (!initial || !initial.isDirectory() || initial.isSymbolicLink()) {
    return fail(
      'GOVERNED_PLAN_AUTHORITY_ROUTE_UNSAFE',
      'Governance authority directory is unsafe before durable synchronization.',
    );
  }
  const handle = await open(path, fsConstants.O_RDONLY | NO_FOLLOW);
  try {
    const opened = await handle.stat();
    if (!sameIdentity(initial, opened)) {
      return fail(
        'GOVERNED_PLAN_AUTHORITY_ROUTE_UNSAFE',
        'Governance authority directory changed before durable synchronization.',
      );
    }
    try {
      await handle.sync();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        process.platform === 'win32' &&
        (code === 'EPERM' || code === 'EINVAL' || code === 'ENOTSUP' || code === 'ENOSYS')
      ) {
        // The file itself was fsynced; Windows may reject directory metadata
        // fsync, but the bound directory identity is still checked below.
      } else {
        throw error;
      }
    }
    const named = await lstat(path);
    if (!sameIdentity(opened, named)) {
      return fail(
        'GOVERNED_PLAN_AUTHORITY_ROUTE_UNSAFE',
        'Governance authority directory changed during durable synchronization.',
      );
    }
  } finally {
    await handle.close();
  }
}

async function readPolicyLock(
  path: string,
  rootReal: string,
): Promise<{
  readonly owner: number;
  readonly stat: Stats;
}> {
  const initial = await lstatIfPresent(path);
  if (!initial || !initial.isFile() || initial.isSymbolicLink() || initial.size > 32) {
    return fail(
      'GOVERNED_PLAN_AUTHORITY_ROUTE_CONFLICT',
      'Governance authority policy lock is unsafe.',
    );
  }
  const actual = await realpath(path);
  if (!samePath(path, actual) || !contained(rootReal, actual)) {
    return fail(
      'GOVERNED_PLAN_AUTHORITY_ROUTE_CONFLICT',
      'Governance authority policy lock escaped its root.',
    );
  }
  const handle = await open(path, fsConstants.O_RDONLY | NO_FOLLOW);
  try {
    const opened = await handle.stat();
    if (!stableIdentity(initial, opened)) {
      return fail(
        'GOVERNED_PLAN_AUTHORITY_ROUTE_CONFLICT',
        'Governance authority policy lock changed before read.',
      );
    }
    const bytes = Buffer.alloc(opened.size);
    const result = await handle.read(bytes, 0, bytes.length, 0);
    const after = await handle.stat();
    const named = await lstat(path);
    const text = bytes.toString('utf8');
    if (
      result.bytesRead !== bytes.length ||
      !stableIdentity(opened, after) ||
      !stableIdentity(after, named) ||
      !/^([1-9]\d*)\n$/u.test(text)
    ) {
      return fail(
        'GOVERNED_PLAN_AUTHORITY_ROUTE_CONFLICT',
        'Governance authority policy lock is invalid or changed.',
      );
    }
    return Object.freeze({ owner: Number(text.trim()), stat: named });
  } finally {
    await handle.close();
  }
}

async function withPolicyLock<T>(
  prepared: PreparedAuthorityRoot,
  operation: () => Promise<T>,
): Promise<T> {
  const path = join(prepared.rootReal, POLICY_LOCK);
  const bytes = `${process.pid}\n`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assertDirectoryIdentity(prepared);
    let handle: FileHandle | undefined;
    try {
      handle = await open(
        path,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NO_FOLLOW,
        0o600,
      );
      await handle.writeFile(bytes, 'utf8');
      await handle.sync();
      const trusted = await handle.stat();
      const named = await lstat(path);
      if (!stableIdentity(trusted, named)) {
        return fail(
          'GOVERNED_PLAN_AUTHORITY_ROUTE_CONFLICT',
          'Governance authority policy lock changed during acquisition.',
        );
      }
      await syncDirectory(prepared.rootReal);
      try {
        return await operation();
      } finally {
        await handle.close();
        handle = undefined;
        const current = await lstat(path);
        if (!sameIdentity(trusted, current)) {
          return fail(
            'GOVERNED_PLAN_AUTHORITY_ROUTE_CONFLICT',
            'Governance authority policy lock changed before release.',
          );
        }
        await rm(path);
        await syncDirectory(prepared.rootReal);
      }
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let observed: Awaited<ReturnType<typeof readPolicyLock>>;
      try {
        observed = await readPolicyLock(path, prepared.rootReal);
      } catch {
        return fail(
          'GOVERNED_PLAN_AUTHORITY_ROUTE_CONFLICT',
          'Governance authority policy is locked by a live or unverifiable owner.',
        );
      }
      const owner = observed.owner;
      if (!Number.isSafeInteger(owner) || owner < 1 || owner === process.pid) {
        return fail(
          'GOVERNED_PLAN_AUTHORITY_ROUTE_CONFLICT',
          'Governance authority policy is locked by a live or unverifiable owner.',
        );
      }
      try {
        process.kill(owner, 0);
        return fail(
          'GOVERNED_PLAN_AUTHORITY_ROUTE_CONFLICT',
          'Governance authority policy is locked by a live owner.',
        );
      } catch (ownerError) {
        if ((ownerError as NodeJS.ErrnoException).code !== 'ESRCH') {
          return fail(
            'GOVERNED_PLAN_AUTHORITY_ROUTE_CONFLICT',
            'Governance authority policy lock owner cannot be verified.',
          );
        }
      }
      const current = await lstat(path);
      if (!stableIdentity(observed.stat, current)) {
        return fail(
          'GOVERNED_PLAN_AUTHORITY_ROUTE_CONFLICT',
          'Governance authority policy lock changed before stale-owner recovery.',
        );
      }
      await rm(path);
      await syncDirectory(prepared.rootReal);
    }
  }
  return fail(
    'GOVERNED_PLAN_AUTHORITY_ROUTE_CONFLICT',
    'Governance authority policy lock could not be acquired.',
  );
}

async function bindPolicy(
  prepared: PreparedAuthorityRoot,
  route: GovernedPlanAuthorityRoute,
  now: () => Date,
  hasGoTransport: boolean,
): Promise<GovernedPlanAuthorityPolicy> {
  return withPolicyLock(prepared, async () => {
    await assertDirectoryIdentity(prepared);
    const path = join(prepared.rootReal, 'policy.json');
    const existingValue = await readCanonical(path, prepared.rootReal);
    const existing = existingValue === undefined ? undefined : parsePolicy(existingValue);
    if (existing && route.routingEpoch < existing.routingEpoch) {
      return fail(
        'GOVERNED_PLAN_AUTHORITY_ROUTE_CONFLICT',
        'Governance authority policy epoch cannot move backwards.',
      );
    }
    if (existing && route.routingEpoch === existing.routingEpoch) {
      if (existing.backend !== route.backend || existing.authority !== route.authority) {
        return fail(
          'GOVERNED_PLAN_AUTHORITY_ROUTE_CONFLICT',
          'Governance authority policy cannot change within one routing epoch.',
        );
      }
      if (existing.goRoutingEpochs.length > 0 && !hasGoTransport) {
        return fail(
          'GOVERNED_PLAN_AUTHORITY_TRANSPORT_UNAVAILABLE',
          'Governance authority policy history requires a complete governance-control transport.',
        );
      }
      return existing;
    }
    const policy = Object.freeze({
      schema: POLICY_SCHEMA,
      ...route,
      goRoutingEpochs: Object.freeze(
        [
          ...(existing?.goRoutingEpochs ?? []),
          ...(route.backend === 'go' ? [route.routingEpoch] : []),
        ]
          .filter((epoch, index, values) => values.indexOf(epoch) === index)
          .sort((left, right) => left - right),
      ),
      updatedAt: safeDate(now),
    }) satisfies GovernedPlanAuthorityPolicy;
    if (policy.goRoutingEpochs.length > MAX_GO_ROUTING_EPOCHS) {
      return fail(
        'GOVERNED_PLAN_AUTHORITY_ROUTE_CONFLICT',
        'Governance authority Go epoch history exceeds its bounded policy capacity.',
      );
    }
    if (policy.goRoutingEpochs.length > 0 && !hasGoTransport) {
      return fail(
        'GOVERNED_PLAN_AUTHORITY_TRANSPORT_UNAVAILABLE',
        'Governance authority policy history requires a complete governance-control transport.',
      );
    }
    await writeFileAtomic(
      path,
      join(prepared.rootReal, `.policy.${randomUUID()}.tmp`),
      `${canonicalGovernedJson(policy)}\n`,
      prepared.rootReal,
      MAX_ROUTE_BYTES,
    );
    const readback = parsePolicy(await readCanonical(path, prepared.rootReal));
    if (
      readback.backend !== policy.backend ||
      readback.routingEpoch !== policy.routingEpoch ||
      readback.authority !== policy.authority ||
      canonicalGovernedJson(readback.goRoutingEpochs) !==
        canonicalGovernedJson(policy.goRoutingEpochs)
    ) {
      return fail(
        'GOVERNED_PLAN_AUTHORITY_ROUTE_CONFLICT',
        'Governance authority policy readback does not match the selected epoch.',
      );
    }
    return readback;
  });
}

function nextRecord(
  current: GovernedPlanRecord,
  patch: Partial<GovernedPlanRecord>,
): GovernedPlanRecord {
  return validateGovernedPlanRecord({ ...current, ...patch, revision: current.revision + 1 });
}

function governedRecordHash(record: GovernedPlanRecord): string {
  return createHash('sha256')
    .update(`${canonicalGovernedJson(validateGovernedPlanRecord(record))}\n`, 'utf8')
    .digest('hex');
}

function recoveryAuditEvent(
  record: GovernedPlanRecord,
  pending: GovernanceAuthorityPendingAudit,
  now: () => Date,
): GovernedPlanAuditEvent {
  let type: GovernedPlanAuditEvent['type'];
  let details: GovernedPlanAuditEvent['details'];
  switch (pending.operation) {
    case 'accept':
      if (record.revision !== 1 || record.state !== 'pending') {
        return fail(
          'GOVERNED_PLAN_AUTHORITY_ROUTE_CONFLICT',
          'Pending accept audit does not bind a pending revision-one record.',
        );
      }
      type = 'plan.previewed';
      details = {
        planHash: record.bindings.planHash,
        actionCount: record.canonicalPlan.actions.length,
        effectCount: record.canonicalPlan.effects.length,
      };
      break;
    case 'claim_execution':
      if (record.state !== 'executing' || !record.execution?.executionId) {
        return fail(
          'GOVERNED_PLAN_AUTHORITY_ROUTE_CONFLICT',
          'Pending claim audit does not bind an executing record.',
        );
      }
      type = 'plan.confirmed';
      details = { executionId: record.execution.executionId };
      break;
    case 'complete_execution':
      if (record.state === 'succeeded') type = 'plan.execution_completed';
      else if (record.state === 'blocked') type = 'plan.execution_blocked';
      else if (record.state === 'failed') type = 'plan.execution_failed';
      else {
        return fail(
          'GOVERNED_PLAN_AUTHORITY_ROUTE_CONFLICT',
          'Pending completion audit does not bind a terminal completion record.',
        );
      }
      break;
    case 'cancel':
      if (record.state !== 'cancelled') {
        return fail(
          'GOVERNED_PLAN_AUTHORITY_ROUTE_CONFLICT',
          'Pending cancellation audit does not bind a cancelled record.',
        );
      }
      type = 'plan.cancelled';
      break;
    case 'expire':
      if (record.state !== 'expired') {
        return fail(
          'GOVERNED_PLAN_AUTHORITY_ROUTE_CONFLICT',
          'Pending expiry audit does not bind an expired record.',
        );
      }
      type = 'plan.expired';
      break;
    case 'require_reconciliation':
      if (record.state !== 'reconciliation_required') {
        return fail(
          'GOVERNED_PLAN_AUTHORITY_ROUTE_CONFLICT',
          'Pending reconciliation audit does not bind a reconciliation record.',
        );
      }
      type = 'plan.reconciliation_required';
      break;
  }
  return validateGovernanceAuthorityAuditEvent({
    schema: 'openslack.governed_plan_audit.v1',
    eventId: `GAUDIT-${randomUUID()}`,
    type,
    occurredAt: safeDate(now),
    planId: record.planId,
    kind: record.canonicalPlan.kind,
    actorId: record.bindings.actorId,
    workspaceId: record.bindings.workspaceId,
    correlationId: record.bindings.correlationId,
    state: record.state,
    revision: record.revision,
    evidenceRefs: Object.freeze(
      record.execution?.outcomes.flatMap((outcome) => [...outcome.evidenceRefs]) ?? [],
    ),
    ...(details === undefined ? {} : { details }),
  });
}

async function publishImmutable(
  path: string,
  temporary: string,
  bytes: string,
  parentReal: string,
  maximumBytes: number,
): Promise<void> {
  if (Buffer.byteLength(bytes, 'utf8') > maximumBytes) {
    return fail(
      'GOVERNED_PLAN_AUTHORITY_ROUTE_UNSAFE',
      'Governance authority immutable file exceeds its bounded byte limit.',
    );
  }
  const handle = await open(
    temporary,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NO_FOLLOW,
    0o600,
  );
  let trusted: Stats;
  let linked = false;
  try {
    await handle.writeFile(bytes, 'utf8');
    await handle.sync();
    trusted = await handle.stat();
    const named = await lstat(temporary);
    if (!stableIdentity(trusted, named)) {
      return fail(
        'GOVERNED_PLAN_AUTHORITY_ROUTE_UNSAFE',
        'Governance authority temporary identity changed before publication.',
      );
    }
    try {
      await link(temporary, path);
      linked = true;
      await syncDirectory(parentReal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (linked) {
      const published = await lstat(path);
      if (!sameIdentity(trusted, published)) {
        return fail(
          'GOVERNED_PLAN_AUTHORITY_ROUTE_UNSAFE',
          'Governance authority immutable identity changed during publication.',
        );
      }
    }
  } finally {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true });
  }
}

export function registerGovernanceAuthorityGoPort<T extends GovernanceAuthorityGoPort>(port: T): T {
  GO_PORTS.add(port);
  return port;
}

class RoutedGovernedPlanStore implements GovernedPlanStore {
  readonly #prepared: PreparedAuthorityRoot;
  readonly #local: GovernedPlanStore;
  readonly #policy: GovernedPlanAuthorityPolicy;
  readonly #go: GovernanceAuthorityGoPort | undefined;
  readonly #now: () => Date;

  constructor(input: {
    readonly prepared: PreparedAuthorityRoot;
    readonly local: GovernedPlanStore;
    readonly policy: GovernedPlanAuthorityPolicy;
    readonly go?: GovernanceAuthorityGoPort;
    readonly now: () => Date;
  }) {
    this.#prepared = input.prepared;
    this.#local = input.local;
    this.#policy = input.policy;
    this.#go = input.go;
    this.#now = input.now;
    registerGovernedPlanStore(this);
    Object.freeze(this);
  }

  async #assertPrepared(): Promise<void> {
    await assertDirectoryIdentity(this.#prepared);
    for (const entry of await readdir(this.#prepared.rootReal, { withFileTypes: true })) {
      const stat = await lstat(join(this.#prepared.rootReal, entry.name));
      const safeDirectory =
        (entry.name === 'routes' || entry.name === 'audit-journal') &&
        entry.isDirectory() &&
        stat.isDirectory() &&
        !entry.isSymbolicLink() &&
        !stat.isSymbolicLink();
      const safeFile =
        (entry.name === 'policy.json' ||
          entry.name === POLICY_LOCK ||
          POLICY_TEMP.test(entry.name)) &&
        entry.isFile() &&
        stat.isFile() &&
        !entry.isSymbolicLink() &&
        !stat.isSymbolicLink();
      if (!safeDirectory && !safeFile) {
        return fail(
          'GOVERNED_PLAN_AUTHORITY_ROUTE_UNSAFE',
          'Governance authority root contains an unknown or unsafe entry.',
        );
      }
    }
    const policyValue = await readCanonical(
      join(this.#prepared.rootReal, 'policy.json'),
      this.#prepared.rootReal,
    );
    if (
      policyValue === undefined ||
      canonicalGovernedJson(parsePolicy(policyValue)) !== canonicalGovernedJson(this.#policy)
    ) {
      return fail(
        'GOVERNED_PLAN_AUTHORITY_ROUTE_CONFLICT',
        'Governance authority policy changed after process binding.',
      );
    }
    await scanFiles(
      this.#prepared.routesReal,
      [ROUTE_FILE, TEMP_FILE],
      MAX_JOURNAL_FILES * 2,
      MAX_ROUTE_BYTES,
    );
    await scanFiles(
      this.#prepared.journalReal,
      [JOURNAL_FILE, JOURNAL_TEMP],
      MAX_JOURNAL_FILES * 2,
      MAX_JOURNAL_BYTES,
    );
  }

  async #storedRoute(planId: string): Promise<PersistedGovernedPlanAuthorityRoute | undefined> {
    await this.#assertPrepared();
    const value = await readCanonical(
      routeFile(this.#prepared.routesReal, planId),
      this.#prepared.routesReal,
    );
    return value === undefined ? undefined : parseRoute(value, planId);
  }

  async #route(planId: string): Promise<GovernedPlanAuthorityRoute | undefined> {
    const stored = await this.#storedRoute(planId);
    if (stored) return routeFor(stored.backend, stored.routingEpoch);
    const recovered = await this.#recoverMissingGoRoute(planId);
    if (recovered) return recovered;
    // A route-less local record can only be a pre-GS6 TypeScript record after
    // every historically enabled Go epoch has returned an exact point miss.
    return (await this.#local.load(planId)) === null ? undefined : routeFor('ts-local', 1);
  }

  async #freezeRoute(
    planId: string,
    selected: GovernedPlanAuthorityRoute,
  ): Promise<PersistedGovernedPlanAuthorityRoute> {
    const existing = await this.#storedRoute(planId);
    if (existing) return existing;
    const route = Object.freeze({
      schema: ROUTE_SCHEMA,
      planId,
      ...selected,
      createdAt: safeDate(this.#now),
    }) satisfies PersistedGovernedPlanAuthorityRoute;
    const path = routeFile(this.#prepared.routesReal, planId);
    const temporary = join(
      this.#prepared.routesReal,
      `.${createHash('sha256').update(planId, 'utf8').digest('hex')}.${randomUUID()}.tmp`,
    );
    await publishImmutable(
      path,
      temporary,
      `${canonicalGovernedJson(route)}\n`,
      this.#prepared.routesReal,
      MAX_ROUTE_BYTES,
    );
    const published = parseRoute(await readCanonical(path, this.#prepared.routesReal), planId);
    if (
      published.backend !== route.backend ||
      published.routingEpoch !== route.routingEpoch ||
      published.authority !== route.authority
    ) {
      return fail(
        'GOVERNED_PLAN_AUTHORITY_ROUTE_CONFLICT',
        'Governed plan authority route was already frozen differently.',
      );
    }
    return published;
  }

  async #freezeNewRoute(planId: string): Promise<PersistedGovernedPlanAuthorityRoute> {
    return this.#freezeRoute(planId, routeFor(this.#policy.backend, this.#policy.routingEpoch));
  }

  #goPort(): GovernanceAuthorityGoPort {
    if (!this.#go) {
      return fail(
        'GOVERNED_PLAN_AUTHORITY_TRANSPORT_UNAVAILABLE',
        'A Go-routed governed plan has no bound governance-control transport.',
      );
    }
    return this.#go;
  }

  async #recoverMissingGoRoute(planId: string): Promise<GovernedPlanAuthorityRoute | undefined> {
    let discovered: GovernedPlanAuthorityRoute | undefined;
    for (const routingEpoch of this.#policy.goRoutingEpochs) {
      const existing = await this.#goPort().load(planId, routeFor('go', routingEpoch));
      if (existing !== null) {
        const record = validateGovernedPlanRecord(existing);
        if (record.planId !== planId || discovered !== undefined) {
          return fail(
            'GOVERNED_PLAN_AUTHORITY_ROUTE_CONFLICT',
            'A route-less governed plan has invalid or multiple Go authority owners.',
          );
        }
        discovered = routeFor('go', routingEpoch);
      }
    }
    if (!discovered) return undefined;
    if ((await this.#local.load(planId)) !== null) {
      return fail(
        'GOVERNED_PLAN_AUTHORITY_ROUTE_CONFLICT',
        'A route-less Go governed plan also exists in the local authority store.',
      );
    }
    const recovered = await this.#freezeRoute(planId, discovered);
    if (
      recovered.backend !== discovered.backend ||
      recovered.routingEpoch !== discovered.routingEpoch ||
      recovered.authority !== discovered.authority
    ) {
      return fail(
        'GOVERNED_PLAN_AUTHORITY_ROUTE_CONFLICT',
        'A governed plan route changed during atomic Go sidecar recovery.',
      );
    }
    return discovered;
  }

  async create(recordValue: GovernedPlanRecord): Promise<GovernedPlanRecord> {
    const record = validateGovernedPlanRecord(recordValue);
    const occupied = await this.#route(record.planId);
    if (occupied !== undefined) {
      return fail(
        'GOVERNED_PLAN_AUTHORITY_ROUTE_CONFLICT',
        'A governed plan already occupies this immutable plan identity.',
      );
    }
    const route = await this.#freezeNewRoute(record.planId);
    return route.backend === 'go'
      ? this.#goPort().accept(record, routeFor(route.backend, route.routingEpoch))
      : this.#local.create(record);
  }

  async load(planId: string): Promise<GovernedPlanRecord | null> {
    const route = await this.#route(planId);
    if (!route) return null;
    if (route.backend === 'go' && (await this.#local.load(planId)) !== null) {
      return fail(
        'GOVERNED_PLAN_AUTHORITY_ROUTE_CONFLICT',
        'A Go-routed governed plan also exists in the local authority store.',
      );
    }
    return route.backend === 'go' ? this.#goPort().load(planId, route) : this.#local.load(planId);
  }

  async list(): Promise<readonly GovernedPlanRecord[]> {
    // The v1 authority API intentionally has no unbounded list route. Local and
    // legacy records remain inspectable; Go records are addressed by immutable ID.
    await this.#assertPrepared();
    return this.#local.list();
  }

  async #transition(
    planId: string,
    expectedRevision: number,
    operation: GovernanceAuthorityTransitionOperation,
    createTarget: (current: GovernedPlanRecord) => GovernedPlanRecord,
    local: () => Promise<GovernedPlanRecord>,
  ): Promise<GovernedPlanRecord> {
    const route = await this.#route(planId);
    if (!route) {
      return fail('GOVERNED_PLAN_AUTHORITY_TRANSITION_INVALID', 'Governed plan was not found.');
    }
    if (route.backend === 'go' && (await this.#local.load(planId)) !== null) {
      return fail(
        'GOVERNED_PLAN_AUTHORITY_ROUTE_CONFLICT',
        'A Go-routed governed plan also exists in the local authority store.',
      );
    }
    if (route.backend === 'ts-local') return local();
    const current = await this.#goPort().load(planId, route);
    if (!current || current.revision !== expectedRevision) {
      return fail(
        'GOVERNED_PLAN_AUTHORITY_TRANSITION_INVALID',
        'Governed plan revision changed before the authority transition.',
      );
    }
    return this.#goPort().transition(operation, createTarget(current), expectedRevision, route);
  }

  async claimExecution(params: {
    readonly planId: string;
    readonly expectedRevision: number;
    readonly executionId: string;
    readonly ownerPid: number;
    readonly startedAt: string;
  }): Promise<GovernedPlanRecord> {
    return this.#transition(
      params.planId,
      params.expectedRevision,
      'claim_execution',
      (record) => {
        if (!canGovernedPlanStateTransition(record.state, 'executing')) {
          return fail(
            'GOVERNED_PLAN_AUTHORITY_TRANSITION_INVALID',
            `Cannot claim governed plan from ${record.state}.`,
          );
        }
        return nextRecord(record, {
          state: 'executing',
          updatedAt: params.startedAt,
          execution: {
            executionId: params.executionId,
            ownerPid: params.ownerPid,
            startedAt: params.startedAt,
            outcomes: [],
          },
        });
      },
      () => this.#local.claimExecution(params),
    );
  }

  async completeExecution(params: {
    readonly planId: string;
    readonly expectedRevision: number;
    readonly executionId: string;
    readonly state: 'succeeded' | 'blocked' | 'failed' | 'reconciliation_required';
    readonly completedAt: string;
    readonly outcomes: GovernedPlanExecution['outcomes'];
    readonly blocker?: string;
    readonly failure?: string;
  }): Promise<GovernedPlanRecord> {
    const operation =
      params.state === 'reconciliation_required'
        ? ('require_reconciliation' as const)
        : ('complete_execution' as const);
    return this.#transition(
      params.planId,
      params.expectedRevision,
      operation,
      (record) => {
        if (
          !canGovernedPlanStateTransition(record.state, params.state) ||
          record.execution?.executionId !== params.executionId
        ) {
          return fail(
            'GOVERNED_PLAN_AUTHORITY_TRANSITION_INVALID',
            'Only the claimed execution may complete a governed plan.',
          );
        }
        return nextRecord(record, {
          state: params.state,
          updatedAt: params.completedAt,
          execution: {
            ...record.execution,
            completedAt: params.completedAt,
            outcomes: params.outcomes,
            ...(params.blocker === undefined ? {} : { blocker: params.blocker }),
            ...(params.failure === undefined ? {} : { failure: params.failure }),
          },
        });
      },
      () => this.#local.completeExecution(params),
    );
  }

  async cancel(params: {
    readonly planId: string;
    readonly expectedRevision: number;
    readonly updatedAt: string;
  }): Promise<GovernedPlanRecord> {
    return this.#transition(
      params.planId,
      params.expectedRevision,
      'cancel',
      (record) => {
        if (!canGovernedPlanStateTransition(record.state, 'cancelled')) {
          return fail(
            'GOVERNED_PLAN_AUTHORITY_TRANSITION_INVALID',
            `Cannot cancel governed plan from ${record.state}.`,
          );
        }
        return nextRecord(record, { state: 'cancelled', updatedAt: params.updatedAt });
      },
      () => this.#local.cancel(params),
    );
  }

  async expire(params: {
    readonly planId: string;
    readonly expectedRevision: number;
    readonly updatedAt: string;
  }): Promise<GovernedPlanRecord> {
    return this.#transition(
      params.planId,
      params.expectedRevision,
      'expire',
      (record) => {
        if (
          !canGovernedPlanStateTransition(record.state, 'expired') ||
          Date.parse(record.expiresAt) > Date.parse(params.updatedAt)
        ) {
          return fail(
            'GOVERNED_PLAN_AUTHORITY_TRANSITION_INVALID',
            'Governed plan cannot expire from its current state or time binding.',
          );
        }
        return nextRecord(record, { state: 'expired', updatedAt: params.updatedAt });
      },
      () => this.#local.expire(params),
    );
  }

  async requireReconciliation(params: {
    readonly planId: string;
    readonly expectedRevision: number;
    readonly executionId: string;
    readonly completedAt: string;
    readonly failure: string;
  }): Promise<GovernedPlanRecord> {
    return this.completeExecution({
      ...params,
      state: 'reconciliation_required',
      outcomes: [],
    });
  }

  async #readJournal(eventId: string): Promise<AuditJournalEntry | undefined> {
    if (!AUDIT_EVENT_ID.test(eventId)) {
      return fail(
        'GOVERNED_PLAN_AUTHORITY_ROUTE_UNSAFE',
        'Governance authority audit event identity is invalid.',
      );
    }
    await this.#assertPrepared();
    const value = await readCanonical(
      journalFile(this.#prepared.journalReal, eventId),
      this.#prepared.journalReal,
      MAX_JOURNAL_BYTES,
    );
    if (value === undefined) return undefined;
    const entry = parseAuditJournal(value);
    if (entry.event.eventId !== eventId) {
      return fail(
        'GOVERNED_PLAN_AUTHORITY_ROUTE_UNSAFE',
        'Governance authority audit journal filename does not match its event identity.',
      );
    }
    return entry;
  }

  async #publishJournal(entry: AuditJournalEntry): Promise<AuditJournalEntry> {
    await this.#assertPrepared();
    const names = await readdir(this.#prepared.journalReal);
    if (names.filter((name) => JOURNAL_FILE.test(name)).length >= MAX_JOURNAL_FILES) {
      return fail(
        'GOVERNED_PLAN_AUTHORITY_ROUTE_UNSAFE',
        'Governance authority audit journal reached its bounded entry limit.',
      );
    }
    const hash = createHash('sha256').update(entry.event.eventId, 'utf8').digest('hex');
    const path = journalFile(this.#prepared.journalReal, entry.event.eventId);
    await publishImmutable(
      path,
      join(this.#prepared.journalReal, `.${hash}.${randomUUID()}.tmp`),
      `${canonicalGovernedJson(entry)}\n`,
      this.#prepared.journalReal,
      MAX_JOURNAL_BYTES,
    );
    const published = await this.#readJournal(entry.event.eventId);
    if (
      !published ||
      canonicalGovernedJson(published.event) !== canonicalGovernedJson(entry.event) ||
      canonicalGovernedJson(published.route) !== canonicalGovernedJson(entry.route)
    ) {
      return fail(
        'GOVERNED_PLAN_AUTHORITY_ROUTE_CONFLICT',
        'Governance authority audit event identity was already prepared differently.',
      );
    }
    return published;
  }

  async #markCollaborationRecorded(entry: AuditJournalEntry): Promise<AuditJournalEntry> {
    if (entry.state === 'collaboration_recorded') return entry;
    await this.#assertPrepared();
    const next = Object.freeze({
      ...entry,
      state: 'collaboration_recorded' as const,
      collaborationRecordedAt: safeDate(this.#now),
    });
    const hash = createHash('sha256').update(entry.event.eventId, 'utf8').digest('hex');
    const path = journalFile(this.#prepared.journalReal, entry.event.eventId);
    await writeFileAtomic(
      path,
      join(this.#prepared.journalReal, `.${hash}.${randomUUID()}.tmp`),
      `${canonicalGovernedJson(next)}\n`,
      this.#prepared.journalReal,
      MAX_JOURNAL_BYTES,
    );
    const written = await this.#readJournal(entry.event.eventId);
    if (
      !written ||
      written.state !== 'collaboration_recorded' ||
      canonicalGovernedJson(written.event) !== canonicalGovernedJson(entry.event) ||
      canonicalGovernedJson(written.route) !== canonicalGovernedJson(entry.route)
    ) {
      return fail(
        'GOVERNED_PLAN_AUTHORITY_ROUTE_CONFLICT',
        'Governance authority audit journal changed during durable phase transition.',
      );
    }
    return written;
  }

  async #acknowledgeJournal(entry: AuditJournalEntry): Promise<void> {
    const route = await this.#route(entry.event.planId);
    if (
      !route ||
      route.backend !== 'go' ||
      canonicalGovernedJson(route) !== canonicalGovernedJson(entry.route)
    ) {
      return fail(
        'GOVERNED_PLAN_AUTHORITY_ROUTE_CONFLICT',
        'Governance authority audit journal route no longer has one Go owner.',
      );
    }
    await this.#goPort().recordAudit(entry.event, route);
    const current = await this.#readJournal(entry.event.eventId);
    if (
      !current ||
      current.state !== 'collaboration_recorded' ||
      canonicalGovernedJson(current) !== canonicalGovernedJson(entry)
    ) {
      return fail(
        'GOVERNED_PLAN_AUTHORITY_ROUTE_CONFLICT',
        'Governance authority audit journal changed before acknowledged retirement.',
      );
    }
    await rm(journalFile(this.#prepared.journalReal, entry.event.eventId));
    await syncDirectory(this.#prepared.journalReal);
  }

  async prepareAudit(eventValue: GovernedPlanAuditEvent): Promise<void> {
    const event = validateGovernanceAuthorityAuditEvent(eventValue);
    const route = await this.#route(event.planId);
    if (!route) {
      return fail(
        'GOVERNED_PLAN_AUTHORITY_TRANSITION_INVALID',
        'Governance authority audit plan was not found.',
      );
    }
    if (route.backend === 'ts-local') return;
    const existing = await this.#readJournal(event.eventId);
    if (existing) {
      if (
        canonicalGovernedJson(existing.event) !== canonicalGovernedJson(event) ||
        canonicalGovernedJson(existing.route) !== canonicalGovernedJson(route)
      ) {
        return fail(
          'GOVERNED_PLAN_AUTHORITY_ROUTE_CONFLICT',
          'Governance authority audit event identity was reused with different bytes.',
        );
      }
      return;
    }
    await this.#publishJournal(
      Object.freeze({
        schema: AUDIT_JOURNAL_SCHEMA,
        state: 'prepared',
        event,
        route,
        preparedAt: safeDate(this.#now),
      }),
    );
  }

  async recordAudit(eventValue: GovernedPlanAuditEvent): Promise<void> {
    const event = validateGovernanceAuthorityAuditEvent(eventValue);
    const route = await this.#route(event.planId);
    if (!route || route.backend === 'ts-local') return;
    const entry = await this.#readJournal(event.eventId);
    if (!entry || canonicalGovernedJson(entry.event) !== canonicalGovernedJson(event)) {
      return fail(
        'GOVERNED_PLAN_AUTHORITY_ROUTE_CONFLICT',
        'Governance authority audit acknowledgement has no matching durable prepare.',
      );
    }
    if (canonicalGovernedJson(entry.route) !== canonicalGovernedJson(route)) {
      return fail(
        'GOVERNED_PLAN_AUTHORITY_ROUTE_CONFLICT',
        'Governance authority audit route changed after durable prepare.',
      );
    }
    await this.#acknowledgeJournal(await this.#markCollaborationRecorded(entry));
  }

  async #recoverUnjournaledGoAudits(auditSink: GovernedPlanAuditSink): Promise<void> {
    await this.#assertPrepared();
    const names = (await readdir(this.#prepared.routesReal))
      .filter((name) => ROUTE_FILE.test(name))
      .sort();
    if (names.length > MAX_ROUTE_FILES) {
      return fail(
        'GOVERNED_PLAN_AUTHORITY_ROUTE_UNSAFE',
        'Governance authority sidecar scan exceeds its bounded recovery limit.',
      );
    }
    for (const name of names) {
      const value = await readCanonical(
        join(this.#prepared.routesReal, name),
        this.#prepared.routesReal,
      );
      if (
        value === undefined ||
        value === null ||
        typeof value !== 'object' ||
        Array.isArray(value)
      ) {
        return fail(
          'GOVERNED_PLAN_AUTHORITY_ROUTE_UNSAFE',
          'Governance authority sidecar disappeared or is invalid during recovery.',
        );
      }
      const planId = (value as Readonly<Record<string, unknown>>).planId;
      if (typeof planId !== 'string' || !PLAN_ID.test(planId)) {
        return fail(
          'GOVERNED_PLAN_AUTHORITY_ROUTE_UNSAFE',
          'Governance authority sidecar plan identity is invalid.',
        );
      }
      const persisted = parseRoute(value, planId);
      if (`${createHash('sha256').update(planId, 'utf8').digest('hex')}.json` !== name) {
        return fail(
          'GOVERNED_PLAN_AUTHORITY_ROUTE_UNSAFE',
          'Governance authority sidecar filename does not match its plan identity.',
        );
      }
      if (persisted.backend === 'ts-local') continue;
      const route = routeFor('go', persisted.routingEpoch);
      if ((await this.#local.load(planId)) !== null) {
        return fail(
          'GOVERNED_PLAN_AUTHORITY_ROUTE_CONFLICT',
          'A Go-routed governed plan also exists in the local authority store.',
        );
      }
      const record = await this.#goPort().load(planId, route);
      if (record === null) continue;
      const validated = validateGovernedPlanRecord(record);
      if (validated.planId !== planId) {
        return fail(
          'GOVERNED_PLAN_AUTHORITY_ROUTE_CONFLICT',
          'Governance authority sidecar read returned another plan identity.',
        );
      }
      const pending = await this.#goPort().pendingAudit(planId, validated.revision, route);
      if (pending === null) continue;
      if (pending.recordHash !== governedRecordHash(validated)) {
        return fail(
          'GOVERNED_PLAN_AUTHORITY_ROUTE_CONFLICT',
          'Governance authority pending audit does not bind the current record bytes.',
        );
      }
      const event = recoveryAuditEvent(validated, pending, this.#now);
      await this.prepareAudit(event);
      await auditSink(event);
      await this.recordAudit(event);
    }
  }

  async recoverAudits(auditSink: GovernedPlanAuditSink): Promise<void> {
    if (typeof auditSink !== 'function') {
      return fail(
        'GOVERNED_PLAN_AUTHORITY_POLICY_INVALID',
        'Governance authority audit recovery requires a collaboration sink.',
      );
    }
    await this.#assertPrepared();
    const names = (await readdir(this.#prepared.journalReal))
      .filter((name) => JOURNAL_FILE.test(name))
      .sort();
    if (names.length > MAX_JOURNAL_FILES) {
      return fail(
        'GOVERNED_PLAN_AUTHORITY_ROUTE_UNSAFE',
        'Governance authority audit journal exceeds its bounded recovery limit.',
      );
    }
    for (const name of names) {
      const value = await readCanonical(
        join(this.#prepared.journalReal, name),
        this.#prepared.journalReal,
        MAX_JOURNAL_BYTES,
      );
      if (value === undefined) continue;
      let entry = parseAuditJournal(value);
      if (
        `${createHash('sha256').update(entry.event.eventId, 'utf8').digest('hex')}.json` !== name
      ) {
        return fail(
          'GOVERNED_PLAN_AUTHORITY_ROUTE_UNSAFE',
          'Governance authority audit journal filename is invalid.',
        );
      }
      const route = await this.#route(entry.event.planId);
      if (!route || canonicalGovernedJson(route) !== canonicalGovernedJson(entry.route)) {
        return fail(
          'GOVERNED_PLAN_AUTHORITY_ROUTE_CONFLICT',
          'Governance authority audit recovery could not bind one Go route.',
        );
      }
      if (entry.state === 'prepared') {
        await auditSink(entry.event);
        entry = await this.#markCollaborationRecorded(entry);
      }
      await this.#acknowledgeJournal(entry);
    }
    await this.#recoverUnjournaledGoAudits(auditSink);
  }
}

export async function createRoutedGovernedPlanStore(
  options: CreateRoutedGovernedPlanStoreOptions,
): Promise<GovernedPlanStore> {
  if (!options || typeof options !== 'object' || utilTypes.isProxy(options)) {
    return fail(
      'GOVERNED_PLAN_AUTHORITY_POLICY_INVALID',
      'Governance authority store options must be host-owned.',
    );
  }
  if (!isGovernedPlanStore(options.localStore)) {
    return fail(
      'GOVERNED_PLAN_AUTHORITY_POLICY_INVALID',
      'Governance authority local store must be host-created.',
    );
  }
  if (options.backend !== 'go' && options.backend !== 'ts-local') {
    return fail(
      'GOVERNED_PLAN_AUTHORITY_POLICY_INVALID',
      'Governance authority backend is invalid.',
    );
  }
  if (
    options.go !== undefined &&
    (!options.go || typeof options.go !== 'object' || !GO_PORTS.has(options.go))
  ) {
    return fail(
      'GOVERNED_PLAN_AUTHORITY_POLICY_INVALID',
      'Governance authority Go port must be host-created.',
    );
  }
  if (options.backend === 'go' && options.go === undefined) {
    return fail(
      'GOVERNED_PLAN_AUTHORITY_TRANSPORT_UNAVAILABLE',
      'Go authority routing requires a governance-control transport.',
    );
  }
  const now = options.now ?? (() => new Date());
  const root = await initializeRoot(options.routeRoot);
  const policy = await bindPolicy(
    root,
    routeFor(options.backend, options.routingEpoch),
    now,
    options.go !== undefined,
  );
  if (policy.goRoutingEpochs.length > 0 && options.go === undefined) {
    return fail(
      'GOVERNED_PLAN_AUTHORITY_TRANSPORT_UNAVAILABLE',
      'Governance authority policy history requires a complete governance-control transport.',
    );
  }
  return new RoutedGovernedPlanStore({
    prepared: root,
    local: options.localStore,
    policy,
    ...(options.go === undefined ? {} : { go: options.go }),
    now,
  });
}

export function governedPlanAuthorityRoot(workspaceRoot: string): string {
  return join(workspaceRoot, '.openslack.local', 'operator', 'governed-plan-authority');
}
