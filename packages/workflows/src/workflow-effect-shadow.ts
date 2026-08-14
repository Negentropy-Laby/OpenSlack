import { createHash } from 'node:crypto';
import { lstat, readdir, rename, unlink } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { types as nodeTypes } from 'node:util';
import {
  WORKFLOW_EFFECT_CONTROL_ENVELOPE_SCHEMA,
  WORKFLOW_EFFECT_CONTROL_LIMITS,
  WORKFLOW_EFFECT_CONTROL_ROUTE,
  hashWorkflowEffectControlDomain,
  hashWorkflowEffectControlObservation,
  parseWorkflowEffectControlEnvelopeBytes,
  prepareWorkflowEffectControlEnvelope,
  validateWorkflowEffectControlEnvelope,
  type WorkflowEffectControlEnvelope,
  type WorkflowEffectControlObservation,
} from './workflow-effect-control-contract.js';
import {
  recoverWorkflowEffectAuthorityObservationPrefix,
  scanWorkflowEffectAuthorityObservationPrefixes,
  workflowEffectAuthorityObservationRevisionToken,
  type WorkflowEffectAuthorityObservationRecordIdentity,
} from './workflow-effect-authority-store.js';
import {
  WORKFLOW_EFFECT_SHADOW_MAX_RECEIPT_BYTES,
  WORKFLOW_EFFECT_SHADOW_MAX_ERROR_BYTES,
  WORKFLOW_EFFECT_SHADOW_RECONCILIATION_RESOLVE_ROUTE_PREFIX,
  WORKFLOW_EFFECT_SHADOW_RECONCILIATION_RESOLVE_ROUTE_SUFFIX,
  validateWorkflowEffectShadowReceipt,
  validateWorkflowEffectShadowError,
  type WorkflowEffectShadowReceipt,
} from './workflow-effect-shadow-contract.js';
import {
  isWorkflowEffectShadowObservationPort,
  registerWorkflowEffectShadowObservationPort,
  type WorkflowEffectShadowObservationPort,
  type WorkflowEffectShadowObservationScope,
} from './internal/workflow-effect-shadow-port.js';
import {
  validateWorkflowLocalShadowEndpoint,
  validateWorkflowLocalShadowJournalRoot,
} from './internal/workflow-local-shadow-config.js';
import {
  acquireOwnerJournalLock,
  assertOwnerFile,
  ensureOwnerDirectory,
  productionJournalSecurity,
  readOwnerFile,
  syncDirectory,
  writeExclusive,
  WORKFLOW_CONTROL_SHADOW_POLICY,
  type WorkflowControlShadowJournalSecurityDependencies,
} from './workflow-control-shadow.js';

export interface WorkflowEffectShadowPublisherPort {
  publish(
    envelope: WorkflowEffectControlEnvelope,
    prepared?: PreparedEffectDelivery,
  ): Promise<WorkflowEffectShadowReceipt>;
}

export interface WorkflowEffectShadowDiagnostic {
  readonly outcome: 'journaled' | 'delivered' | 'failed';
  readonly runIdHash: string;
  readonly approvalIdHash: string;
  readonly observationHash: string | null;
  readonly code?: string;
}

export interface CreateWorkflowEffectShadowObservationPortOptions {
  readonly enabled?: boolean;
  readonly workspaceRoot?: string;
  readonly journalRoot?: string;
  readonly publisher?: WorkflowEffectShadowPublisherPort;
  readonly diagnosticSink?: (diagnostic: WorkflowEffectShadowDiagnostic) => void | Promise<void>;
}

export interface CreateWorkflowEffectShadowHttpPublisherOptions {
  readonly endpoint: string;
  readonly bearerToken: string;
  readonly callerId: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

type DiagnosticSink = CreateWorkflowEffectShadowObservationPortOptions['diagnosticSink'];
type PreparedEffectDelivery = ReturnType<typeof prepareWorkflowEffectControlEnvelope>;

const PUBLISHERS = new WeakSet<object>();
const JOURNAL_FILE = /^([1-3])-([0-9a-f]{64})\.json$/u;
const MAX_RETRY_DELAY_MS = 30_000;
const DEFAULT_EFFECT_SHADOW_TIMEOUT_MS = 15_000;
const MAX_RETRY_EXPONENT = 17;

export class WorkflowEffectShadowRuntimeError extends Error {
  constructor(
    readonly code:
      | 'WORKFLOW_EFFECT_SHADOW_CONFIG_INVALID'
      | 'WORKFLOW_EFFECT_SHADOW_JOURNAL_CAPACITY'
      | 'WORKFLOW_EFFECT_SHADOW_JOURNAL_INVALID'
      | 'WORKFLOW_EFFECT_SHADOW_RECONCILIATION_REQUIRED'
      | 'WORKFLOW_EFFECT_SHADOW_TRANSPORT_INVALID',
    message: string,
    options?: ErrorOptions,
    readonly remoteCode?: string,
    readonly retryable = false,
  ) {
    super(message, options);
    this.name = 'WorkflowEffectShadowRuntimeError';
  }
}

function failure(
  code: WorkflowEffectShadowRuntimeError['code'],
  message: string,
  cause?: unknown,
  remoteCode?: string,
  retryable = false,
): WorkflowEffectShadowRuntimeError {
  return new WorkflowEffectShadowRuntimeError(
    code,
    message,
    cause === undefined ? undefined : { cause },
    remoteCode,
    retryable,
  );
}

function errorCode(error: unknown): string {
  if (
    error &&
    typeof error === 'object' &&
    typeof (error as { readonly remoteCode?: unknown }).remoteCode === 'string'
  ) {
    return String((error as { readonly remoteCode: string }).remoteCode).slice(0, 128);
  }
  if (
    error &&
    typeof error === 'object' &&
    typeof (error as { readonly code?: unknown }).code === 'string'
  ) {
    return String((error as { readonly code: string }).code).slice(0, 128);
  }
  return 'WORKFLOW_EFFECT_SHADOW_FAILED';
}

function diagnosticHash(domain: string, value: string): string {
  return hashWorkflowEffectControlDomain(`shadow-diagnostic-${domain}`, value);
}

function hashText(value: unknown): string {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

async function readBoundedResponse(
  response: Response,
  signal: AbortSignal,
  byteLimit: number,
): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    if (signal.aborted) throw signal.reason;
    const item = await reader.read();
    if (item.done) break;
    length += item.value.byteLength;
    if (length > byteLimit) {
      await reader.cancel();
      throw failure(
        'WORKFLOW_EFFECT_SHADOW_TRANSPORT_INVALID',
        'Workflow effect shadow receipt exceeds its byte limit.',
      );
    }
    chunks.push(item.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw failure(
      'WORKFLOW_EFFECT_SHADOW_TRANSPORT_INVALID',
      'Workflow effect shadow response is not valid UTF-8.',
      error,
    );
  }
}

async function readJournalEnvelope(
  path: string,
  security: WorkflowControlShadowJournalSecurityDependencies,
): Promise<WorkflowEffectControlEnvelope> {
  try {
    const raw = await readOwnerFile(
      path,
      security,
      WORKFLOW_EFFECT_CONTROL_LIMITS.maxEnvelopeBytes,
    );
    const envelope = parseWorkflowEffectControlEnvelopeBytes(Buffer.from(raw, 'utf8'));
    if (prepareWorkflowEffectControlEnvelope(envelope).body !== raw) {
      throw new TypeError('Effect shadow journal bytes are not exact canonical framing.');
    }
    return envelope;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error;
    if (
      error instanceof WorkflowEffectShadowRuntimeError &&
      error.code === 'WORKFLOW_EFFECT_SHADOW_JOURNAL_INVALID'
    ) {
      throw error;
    }
    throw failure(
      'WORKFLOW_EFFECT_SHADOW_JOURNAL_INVALID',
      'Workflow effect shadow journal entry is invalid.',
      error,
    );
  }
}

class ObservationPort implements WorkflowEffectShadowObservationPort {
  readonly #approvalRoot: string;
  readonly #entries: string;
  readonly #locks: string;
  readonly #quarantine: string;
  readonly #publisher: WorkflowEffectShadowPublisherPort;
  readonly #diagnostic?: DiagnosticSink;
  readonly #security: WorkflowControlShadowJournalSecurityDependencies;
  #journalTail: Promise<void> = Promise.resolve();
  #deliveryTail: Promise<void> = Promise.resolve();
  readonly #retryAttempts = new Map<string, number>();
  readonly #retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #queuedDeliveries = new Set<string>();
  readonly #parked = new Set<string>();
  readonly #prepared = new Map<string, PreparedEffectDelivery>();
  readonly #diagnosticScopes = new Map<
    string,
    { readonly runId: string; readonly approvalId: string; readonly observationHash: string }
  >();
  #authorityIdentity: string | undefined;
  #authorityRecordIndex = new Map<string, WorkflowEffectAuthorityObservationRecordIdentity>();
  #inventory:
    | { identity: string; readonly entries: Map<string, number>; bytes: number }
    | undefined;

  constructor(
    approvalRoot: string,
    entries: string,
    locks: string,
    quarantine: string,
    publisher: WorkflowEffectShadowPublisherPort,
    security: WorkflowControlShadowJournalSecurityDependencies,
    diagnostic?: DiagnosticSink,
  ) {
    this.#approvalRoot = approvalRoot;
    this.#entries = entries;
    this.#locks = locks;
    this.#quarantine = quarantine;
    this.#publisher = publisher;
    this.#security = security;
    this.#diagnostic = diagnostic;
  }

  observeAuthority(scope: WorkflowEffectShadowObservationScope): void {
    const task = this.#enqueueJournal(async () => {
      const prefix = await recoverWorkflowEffectAuthorityObservationPrefix(
        this.#approvalRoot,
        scope.runId,
        scope.approvalId,
        scope.evaluationIndex,
      );
      for (const observation of prefix) {
        const path = await this.#journal(observation);
        this.#queueDelivery(path, observation);
      }
    });
    void task.catch((error) =>
      this.#report('failed', scope.runId, scope.approvalId, null, errorCode(error)),
    );
  }

  async synchronize(): Promise<void> {
    const task = this.#enqueueJournal(async () => {
      const identity = await workflowEffectAuthorityObservationRevisionToken(this.#approvalRoot);
      if (identity === this.#authorityIdentity) return;
      const scan = await scanWorkflowEffectAuthorityObservationPrefixes(
        this.#approvalRoot,
        this.#authorityRecordIndex,
      );
      for (const failureValue of scan.failures) {
        await this.#report(
          'failed',
          'unavailable',
          'unavailable',
          failureValue.recordHash,
          failureValue.code,
        );
      }
      for (const prefix of scan.prefixes) {
        for (const observation of prefix.observations) {
          const path = await this.#journal(observation);
          this.#queueDelivery(path, observation);
        }
      }
      this.#authorityRecordIndex = new Map(scan.recordIndex);
      this.#authorityIdentity = identity;
    });
    await task;
  }

  async replay(): Promise<void> {
    const paths = await this.#enqueueJournal(async () => {
      const result: string[] = [];
      for (const entry of (await readdir(this.#entries, { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        const path = join(this.#entries, entry.name);
        if (entry.isFile() && !entry.isSymbolicLink() && JOURNAL_FILE.test(entry.name)) {
          result.push(path);
        } else {
          await this.#quarantineEntry(path, 'WORKFLOW_EFFECT_SHADOW_JOURNAL_INVALID');
        }
      }
      return result;
    });
    await Promise.all(paths.map((path) => this.#queueDelivery(path)));
  }

  #enqueueJournal<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.#journalTail.then(operation);
    this.#journalTail = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  async flush(): Promise<void> {
    await this.#journalTail;
    await this.#deliveryTail;
  }

  async #journal(observationValue: WorkflowEffectControlObservation): Promise<string> {
    const observation = observationValue;
    const envelope = validateWorkflowEffectControlEnvelope({
      schema: WORKFLOW_EFFECT_CONTROL_ENVELOPE_SCHEMA,
      contractVersion: 'v1',
      authority: 'typescript',
      goRole: 'observer_only',
      authorityClaim: 'NO_AUTHORITY',
      nonAuthorizingObservation: true,
      sourceSequence: observation.approvalRevision + 1,
      operation: observation.operation,
      observation,
      observationHash: hashWorkflowEffectControlObservation(observation),
    });
    const prepared = prepareWorkflowEffectControlEnvelope(envelope);
    const fileName = `${envelope.sourceSequence}-${prepared.bodyHash}.json`;
    const path = join(this.#entries, fileName);
    let release: () => Promise<void>;
    try {
      release = await acquireOwnerJournalLock(
        this.#locks,
        hashText('workflow-effect-shadow-capacity'),
        this.#security,
      );
    } catch (error) {
      throw failure(
        'WORKFLOW_EFFECT_SHADOW_JOURNAL_INVALID',
        'Workflow effect shadow journal lock is invalid.',
        error,
      );
    }
    try {
      const inventory = await this.#loadInventory();
      const exists = inventory.entries.has(path);
      if (
        !exists &&
        (inventory.entries.size >= WORKFLOW_CONTROL_SHADOW_POLICY.maxJournalEntries ||
          inventory.bytes + Buffer.byteLength(prepared.body, 'utf8') >
            WORKFLOW_CONTROL_SHADOW_POLICY.maxJournalBytes)
      ) {
        throw failure(
          'WORKFLOW_EFFECT_SHADOW_JOURNAL_CAPACITY',
          'Workflow effect shadow journal capacity is exceeded.',
        );
      }
      if (!exists) {
        await writeExclusive(path, prepared.body, this.#security);
        await syncDirectory(this.#entries);
        const size = Buffer.byteLength(prepared.body, 'utf8');
        inventory.entries.set(path, size);
        inventory.bytes += size;
        inventory.identity = await this.#inventoryIdentity();
      } else {
        const prior = await readJournalEnvelope(path, this.#security);
        if (prepareWorkflowEffectControlEnvelope(prior).body !== prepared.body) {
          throw failure(
            'WORKFLOW_EFFECT_SHADOW_JOURNAL_INVALID',
            'Workflow effect shadow journal replay binding is mismatched.',
          );
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        const prior = await readJournalEnvelope(path, this.#security);
        if (prepareWorkflowEffectControlEnvelope(prior).body !== prepared.body) {
          throw failure(
            'WORKFLOW_EFFECT_SHADOW_JOURNAL_INVALID',
            'Workflow effect shadow concurrent replay is mismatched.',
            error,
          );
        }
        this.#inventory = undefined;
      } else if (error instanceof WorkflowEffectShadowRuntimeError) {
        throw error;
      } else {
        throw failure(
          'WORKFLOW_EFFECT_SHADOW_JOURNAL_INVALID',
          'Workflow effect shadow journal persistence failed.',
          error,
        );
      }
    } finally {
      await release();
    }
    this.#prepared.set(path, prepared);
    this.#diagnosticScopes.set(path, {
      runId: observation.runId,
      approvalId: observation.approvalId,
      observationHash: envelope.observationHash,
    });
    await this.#report(
      'journaled',
      observation.runId,
      observation.approvalId,
      envelope.observationHash,
    );
    return path;
  }

  #queueDelivery(path: string, observation?: WorkflowEffectControlObservation): Promise<void> {
    if (this.#parked.has(path) || this.#queuedDeliveries.has(path)) return Promise.resolve();
    this.#queuedDeliveries.add(path);
    const task = this.#deliveryTail.then(() => this.#deliverFile(path));
    this.#deliveryTail = task.then(
      () => undefined,
      () => undefined,
    );
    const result = task
      .catch(async (error) => {
        const scope = observation
          ? {
              runId: observation.runId,
              approvalId: observation.approvalId,
              observationHash: hashWorkflowEffectControlObservation(observation),
            }
          : this.#diagnosticScopes.get(path);
        if (scope) {
          await this.#report(
            'failed',
            scope.runId,
            scope.approvalId,
            scope.observationHash,
            errorCode(error),
          );
        } else {
          await this.#reportUnreadable(path, errorCode(error));
        }
        if (error instanceof WorkflowEffectShadowRuntimeError && error.retryable) {
          this.#scheduleRetry(path);
        } else if (
          error instanceof WorkflowEffectShadowRuntimeError &&
          error.code === 'WORKFLOW_EFFECT_SHADOW_TRANSPORT_INVALID'
        ) {
          this.#parked.add(path);
        } else if (
          error instanceof WorkflowEffectShadowRuntimeError &&
          error.code === 'WORKFLOW_EFFECT_SHADOW_JOURNAL_INVALID'
        ) {
          await this.#quarantineEntry(path, error.code);
        }
        throw error;
      })
      .finally(() => this.#queuedDeliveries.delete(path));
    void result.catch(() => undefined);
    return result;
  }

  #scheduleRetry(path: string): void {
    if (this.#retryTimers.has(path)) return;
    const attempt = (this.#retryAttempts.get(path) ?? 0) + 1;
    const saturated = Math.min(attempt, MAX_RETRY_EXPONENT);
    this.#retryAttempts.set(path, saturated);
    const delay = Math.min(MAX_RETRY_DELAY_MS, 250 * 2 ** (saturated - 1));
    const timer = setTimeout(() => {
      this.#retryTimers.delete(path);
      this.#queueDelivery(path);
    }, delay);
    timer.unref?.();
    this.#retryTimers.set(path, timer);
  }

  #clearRetry(path: string): void {
    const timer = this.#retryTimers.get(path);
    if (timer) clearTimeout(timer);
    this.#retryTimers.delete(path);
    this.#retryAttempts.delete(path);
    this.#parked.delete(path);
  }

  async #deliverFile(path: string): Promise<void> {
    let envelope: WorkflowEffectControlEnvelope;
    let prepared = this.#prepared.get(path);
    try {
      if (prepared) {
        envelope = prepared.envelope;
      } else {
        const recovered = await readJournalEnvelope(path, this.#security);
        prepared = prepareWorkflowEffectControlEnvelope(recovered);
        envelope = prepared.envelope;
        this.#prepared.set(path, prepared);
      }
      this.#diagnosticScopes.set(path, {
        runId: envelope.observation.runId,
        approvalId: envelope.observation.approvalId,
        observationHash: envelope.observationHash,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.#clearRetry(path);
        this.#prepared.delete(path);
        this.#diagnosticScopes.delete(path);
        return;
      }
      throw error;
    }
    const receipt = await this.#publisher.publish(envelope, prepared);
    if (
      receipt.idempotencyKey !== prepared.idempotencyKey ||
      receipt.workspaceId !== envelope.observation.workspaceId ||
      receipt.runId !== envelope.observation.runId ||
      receipt.occurrenceId !== envelope.observation.occurrenceId ||
      receipt.approvalId !== envelope.observation.approvalId ||
      receipt.sourceSequence !== envelope.sourceSequence ||
      receipt.operation !== envelope.operation ||
      receipt.envelopeHash !== prepared.bodyHash ||
      receipt.observationHash !== envelope.observationHash
    ) {
      throw failure(
        'WORKFLOW_EFFECT_SHADOW_TRANSPORT_INVALID',
        'Workflow effect shadow receipt is mismatched.',
      );
    }
    if (receipt.status === 'reconciliation_required')
      throw failure(
        'WORKFLOW_EFFECT_SHADOW_RECONCILIATION_REQUIRED',
        'Workflow effect shadow reconciliation remains open.',
        undefined,
        undefined,
        true,
      );
    await this.#removeJournal(path);
    this.#clearRetry(path);
    this.#prepared.delete(path);
    this.#diagnosticScopes.delete(path);
    await this.#report(
      'delivered',
      envelope.observation.runId,
      envelope.observation.approvalId,
      envelope.observationHash,
    );
  }

  async #loadInventory(): Promise<{
    identity: string;
    readonly entries: Map<string, number>;
    bytes: number;
  }> {
    const identity = await this.#inventoryIdentity();
    if (this.#inventory?.identity === identity) return this.#inventory;
    const entries = new Map<string, number>();
    let bytes = 0;
    for (const directory of [this.#entries, this.#quarantine]) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!entry.isFile() || entry.isSymbolicLink()) continue;
        const path = join(directory, entry.name);
        const size = Number((await assertOwnerFile(path, this.#security)).size);
        entries.set(path, size);
        bytes += size;
      }
    }
    this.#inventory = { identity, entries, bytes };
    return this.#inventory;
  }

  async #inventoryIdentity(): Promise<string> {
    const [entriesStat, quarantineStat] = await Promise.all([
      lstat(this.#entries),
      lstat(this.#quarantine),
    ]);
    return [
      entriesStat.dev,
      entriesStat.ino,
      entriesStat.size,
      entriesStat.mtimeMs,
      entriesStat.ctimeMs,
      quarantineStat.dev,
      quarantineStat.ino,
      quarantineStat.size,
      quarantineStat.mtimeMs,
      quarantineStat.ctimeMs,
    ].join(':');
  }

  async #removeJournal(path: string): Promise<void> {
    let release: (() => Promise<void>) | undefined;
    try {
      release = await acquireOwnerJournalLock(
        this.#locks,
        hashText('workflow-effect-shadow-capacity'),
        this.#security,
      );
      const inventory = await this.#loadInventory();
      const size = inventory.entries.get(path);
      await unlink(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
      if (size !== undefined) {
        inventory.entries.delete(path);
        inventory.bytes -= size;
      }
      await syncDirectory(this.#entries);
      inventory.identity = await this.#inventoryIdentity();
    } catch (error) {
      throw failure(
        'WORKFLOW_EFFECT_SHADOW_JOURNAL_INVALID',
        'Workflow effect shadow journal removal failed.',
        error,
        undefined,
        true,
      );
    } finally {
      await release?.();
    }
  }

  async #quarantineEntry(path: string, code: string): Promise<void> {
    let release: (() => Promise<void>) | undefined;
    try {
      release = await acquireOwnerJournalLock(
        this.#locks,
        hashText('workflow-effect-shadow-capacity'),
        this.#security,
      );
      const stat = await lstat(path, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink()) {
        await this.#reportUnreadable(path, code);
        return;
      }
      await assertOwnerFile(path, this.#security);
      const target = join(
        this.#quarantine,
        `${hashText([basename(path), stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':'))}.json`,
      );
      const inventory = await this.#loadInventory();
      await rename(path, target);
      await Promise.all([syncDirectory(this.#entries), syncDirectory(this.#quarantine)]);
      const size = inventory.entries.get(path) ?? Number(stat.size);
      inventory.entries.delete(path);
      inventory.entries.set(target, size);
      inventory.identity = await this.#inventoryIdentity();
      this.#prepared.delete(path);
      this.#diagnosticScopes.delete(path);
      this.#clearRetry(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        await this.#reportUnreadable(path, errorCode(error));
      }
    } finally {
      await release?.();
    }
  }

  async #report(
    outcome: WorkflowEffectShadowDiagnostic['outcome'],
    runId: string,
    approvalId: string,
    observationHash: string | null,
    code?: string,
  ): Promise<void> {
    try {
      await this.#diagnostic?.({
        outcome,
        runIdHash: diagnosticHash('run', runId),
        approvalIdHash: diagnosticHash('approval', approvalId),
        observationHash,
        ...(code ? { code } : {}),
      });
    } catch {
      // Diagnostics are observation-only.
    }
  }

  async #reportUnreadable(path: string, code: string): Promise<void> {
    const match = JOURNAL_FILE.exec(basename(path));
    await this.#report('failed', 'unavailable', 'unavailable', match?.[2] ?? null, code);
  }
}

const NOOP_PORT = registerWorkflowEffectShadowObservationPort({
  observeAuthority() {},
  async synchronize() {},
  async replay() {},
  async flush() {},
});

export async function createWorkflowEffectShadowObservationPort(
  options: CreateWorkflowEffectShadowObservationPortOptions = {},
): Promise<WorkflowEffectShadowObservationPort> {
  if (options.enabled !== true) return NOOP_PORT;
  if (
    typeof options.workspaceRoot !== 'string' ||
    !isAbsolute(options.workspaceRoot) ||
    resolve(options.workspaceRoot) !== options.workspaceRoot ||
    typeof options.journalRoot !== 'string' ||
    !isAbsolute(options.journalRoot) ||
    resolve(options.journalRoot) !== options.journalRoot ||
    !isWorkflowEffectShadowPublisherPort(options.publisher) ||
    (options.diagnosticSink !== undefined &&
      (typeof options.diagnosticSink !== 'function' || nodeTypes.isProxy(options.diagnosticSink)))
  ) {
    throw failure(
      'WORKFLOW_EFFECT_SHADOW_CONFIG_INVALID',
      'Workflow effect shadow observation composition is invalid.',
    );
  }
  const localRoot = join(options.workspaceRoot, '.openslack.local');
  try {
    validateWorkflowLocalShadowJournalRoot({
      workspaceRoot: options.workspaceRoot,
      journalRoot: options.journalRoot,
      protectedRelativeRoots: [
        join('workflows', 'effect-approvals'),
        join('workflows', 'effect-authority'),
      ],
    });
  } catch (error) {
    throw failure(
      'WORKFLOW_EFFECT_SHADOW_CONFIG_INVALID',
      'Workflow effect shadow journal must be workspace-local.',
      error,
    );
  }
  const security = productionJournalSecurity();
  const root = await ensureOwnerDirectory(options.journalRoot, security);
  const entries = await ensureOwnerDirectory(join(root, 'entries'), security, root);
  const locks = await ensureOwnerDirectory(join(root, 'locks'), security, root);
  const quarantine = await ensureOwnerDirectory(join(root, 'quarantine'), security, root);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (
      !['entries', 'locks', 'quarantine'].includes(entry.name) ||
      !entry.isDirectory() ||
      entry.isSymbolicLink()
    ) {
      throw failure(
        'WORKFLOW_EFFECT_SHADOW_JOURNAL_INVALID',
        'Workflow effect shadow journal root contains an unknown entry.',
      );
    }
  }
  return registerWorkflowEffectShadowObservationPort(
    new ObservationPort(
      join(localRoot, 'workflows', 'effect-approvals'),
      entries,
      locks,
      quarantine,
      options.publisher!,
      security,
      options.diagnosticSink,
    ),
  );
}

export function isWorkflowEffectShadowPublisherPort(
  value: unknown,
): value is WorkflowEffectShadowPublisherPort {
  return Boolean(
    value && typeof value === 'object' && !nodeTypes.isProxy(value) && PUBLISHERS.has(value),
  );
}

export function createWorkflowEffectShadowHttpPublisher(
  options: CreateWorkflowEffectShadowHttpPublisherOptions,
): WorkflowEffectShadowPublisherPort {
  let endpoint: URL;
  try {
    endpoint = validateWorkflowLocalShadowEndpoint(options.endpoint, [
      WORKFLOW_EFFECT_CONTROL_ROUTE,
    ]);
  } catch (error) {
    throw failure(
      'WORKFLOW_EFFECT_SHADOW_CONFIG_INVALID',
      'Workflow effect shadow endpoint is invalid.',
      error,
    );
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_EFFECT_SHADOW_TIMEOUT_MS;
  if (
    typeof options.bearerToken !== 'string' ||
    options.bearerToken.length < 32 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u.test(options.callerId) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > WORKFLOW_CONTROL_SHADOW_POLICY.maxTimeoutMs ||
    (options.fetchImpl !== undefined && typeof options.fetchImpl !== 'function')
  ) {
    throw failure(
      'WORKFLOW_EFFECT_SHADOW_CONFIG_INVALID',
      'Workflow effect shadow publisher configuration is invalid.',
    );
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const publisher: WorkflowEffectShadowPublisherPort = Object.freeze({
    async publish(
      envelopeValue: WorkflowEffectControlEnvelope,
      preparedValue?: PreparedEffectDelivery,
    ) {
      if (preparedValue && preparedValue.envelope !== envelopeValue) {
        throw failure(
          'WORKFLOW_EFFECT_SHADOW_TRANSPORT_INVALID',
          'Workflow effect shadow prepared delivery is mismatched.',
        );
      }
      const envelope =
        preparedValue?.envelope ?? validateWorkflowEffectControlEnvelope(envelopeValue);
      const prepared = preparedValue ?? prepareWorkflowEffectControlEnvelope(envelope);
      try {
        const send = async (target: URL, resolving: boolean) => {
          const controller = new AbortController();
          const timer = setTimeout(
            () =>
              controller.abort(
                failure(
                  'WORKFLOW_EFFECT_SHADOW_TRANSPORT_INVALID',
                  'Workflow effect shadow request timed out.',
                  undefined,
                  undefined,
                  true,
                ),
              ),
            timeoutMs,
          );
          try {
            const response = await fetchImpl(target, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${options.bearerToken}`,
                'Content-Type': 'application/json',
                'Idempotency-Key': prepared.idempotencyKey,
                'X-OpenSlack-Caller-ID': options.callerId,
                'X-OpenSlack-Workspace-ID': envelope.observation.workspaceId,
              },
              body: prepared.body,
              signal: controller.signal,
            });
            const acceptedStatuses = resolving ? [200, 201] : [200, 201, 202];
            const retryableStatus =
              [408, 425, 429].includes(response.status) || response.status >= 500;
            const body = await readBoundedResponse(
              response,
              controller.signal,
              acceptedStatuses.includes(response.status)
                ? WORKFLOW_EFFECT_SHADOW_MAX_RECEIPT_BYTES
                : WORKFLOW_EFFECT_SHADOW_MAX_ERROR_BYTES,
            );
            if (
              !/^application\/json(?:\s*;.*)?$/iu.test(response.headers.get('content-type') ?? '')
            ) {
              throw failure(
                'WORKFLOW_EFFECT_SHADOW_TRANSPORT_INVALID',
                'Workflow effect shadow response content type is invalid.',
                undefined,
                undefined,
                retryableStatus,
              );
            }
            let parsed: unknown;
            try {
              parsed = JSON.parse(body);
            } catch (error) {
              throw failure(
                'WORKFLOW_EFFECT_SHADOW_TRANSPORT_INVALID',
                'Workflow effect shadow response is not JSON.',
                error,
                undefined,
                retryableStatus,
              );
            }
            if (!acceptedStatuses.includes(response.status)) {
              let problem;
              try {
                problem = validateWorkflowEffectShadowError(parsed);
              } catch (error) {
                throw failure(
                  'WORKFLOW_EFFECT_SHADOW_TRANSPORT_INVALID',
                  'Workflow effect shadow error response is invalid.',
                  error,
                  undefined,
                  retryableStatus,
                );
              }
              const retryableCode = ['WORKFLOW_EFFECT_SHADOW_REQUEST_TIMEOUT'].includes(
                problem.code,
              );
              throw failure(
                'WORKFLOW_EFFECT_SHADOW_TRANSPORT_INVALID',
                `Workflow effect shadow returned HTTP ${response.status}.`,
                undefined,
                problem.code,
                retryableStatus || retryableCode,
              );
            }
            let receipt: WorkflowEffectShadowReceipt;
            try {
              receipt = validateWorkflowEffectShadowReceipt(parsed, envelope);
            } catch (error) {
              throw failure(
                'WORKFLOW_EFFECT_SHADOW_TRANSPORT_INVALID',
                'Workflow effect shadow receipt is invalid.',
                error,
              );
            }
            const replay = response.headers.get('Idempotency-Replayed');
            if (
              (response.status === 200 && (receipt.status !== 'accepted' || replay !== 'true')) ||
              (response.status === 201 && (receipt.status !== 'accepted' || replay !== null)) ||
              (!resolving &&
                response.status === 202 &&
                receipt.status !== 'reconciliation_required') ||
              (!resolving && response.status === 202 && replay !== null && replay !== 'true')
            ) {
              throw failure(
                'WORKFLOW_EFFECT_SHADOW_TRANSPORT_INVALID',
                'Workflow effect shadow status and replay metadata disagree.',
              );
            }
            return receipt;
          } finally {
            clearTimeout(timer);
          }
        };
        const receipt = await send(endpoint, false);
        if (receipt.status !== 'reconciliation_required') return receipt;
        const token = receipt.reconciliationToken!;
        const resolveEndpoint = new URL(
          `${WORKFLOW_EFFECT_SHADOW_RECONCILIATION_RESOLVE_ROUTE_PREFIX}${encodeURIComponent(token)}${WORKFLOW_EFFECT_SHADOW_RECONCILIATION_RESOLVE_ROUTE_SUFFIX}`,
          endpoint.origin,
        );
        return await send(resolveEndpoint, true);
      } catch (error) {
        if (error instanceof WorkflowEffectShadowRuntimeError) throw error;
        throw failure(
          'WORKFLOW_EFFECT_SHADOW_TRANSPORT_INVALID',
          'Workflow effect shadow request failed.',
          error,
          undefined,
          true,
        );
      }
    },
  });
  PUBLISHERS.add(publisher);
  return publisher;
}

export { isWorkflowEffectShadowObservationPort };
export type { WorkflowEffectShadowObservationPort };
