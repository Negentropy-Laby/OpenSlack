import { createHash } from 'node:crypto';
import { readdir, unlink } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
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
  recoverAllWorkflowEffectAuthorityObservationPrefixes,
  recoverWorkflowEffectAuthorityObservationPrefix,
} from './workflow-effect-authority-store.js';
import {
  WORKFLOW_EFFECT_SHADOW_MAX_RECEIPT_BYTES,
  WORKFLOW_EFFECT_SHADOW_MAX_ERROR_BYTES,
  validateWorkflowEffectShadowReceipt,
  validateWorkflowEffectShadowError,
  type WorkflowEffectShadowReceipt,
} from './workflow-effect-shadow-contract.js';
import {
  isWorkflowEffectShadowObservationPort,
  registerWorkflowEffectShadowObservationPort,
  type WorkflowEffectShadowObservationPort,
} from './internal/workflow-effect-shadow-port.js';
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
  publish(envelope: WorkflowEffectControlEnvelope): Promise<WorkflowEffectShadowReceipt>;
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

const PUBLISHERS = new WeakSet<object>();
const JOURNAL_FILE = /^([1-3])-([0-9a-f]{64})\.json$/u;
const MAX_DELIVERY_RETRIES = 8;
const MAX_RETRY_DELAY_MS = 30_000;

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
): WorkflowEffectShadowRuntimeError {
  return new WorkflowEffectShadowRuntimeError(
    code,
    message,
    cause === undefined ? undefined : { cause },
    remoteCode,
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
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
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
  readonly #publisher: WorkflowEffectShadowPublisherPort;
  readonly #diagnostic?: DiagnosticSink;
  readonly #security: WorkflowControlShadowJournalSecurityDependencies;
  #journalTail: Promise<void> = Promise.resolve();
  #deliveryTail: Promise<void> = Promise.resolve();
  readonly #retryAttempts = new Map<string, number>();
  readonly #retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    approvalRoot: string,
    entries: string,
    locks: string,
    publisher: WorkflowEffectShadowPublisherPort,
    security: WorkflowControlShadowJournalSecurityDependencies,
    diagnostic?: DiagnosticSink,
  ) {
    this.#approvalRoot = approvalRoot;
    this.#entries = entries;
    this.#locks = locks;
    this.#publisher = publisher;
    this.#security = security;
    this.#diagnostic = diagnostic;
  }

  observeAuthority(runId: string, approvalId: string): void {
    const task = this.#journalTail.then(async () => {
      const prefix = await recoverWorkflowEffectAuthorityObservationPrefix(
        this.#approvalRoot,
        runId,
        approvalId,
      );
      for (const observation of prefix) {
        const path = await this.#journal(observation);
        this.#queueDelivery(path, observation);
      }
    });
    this.#journalTail = task.catch((error) =>
      this.#report('failed', runId, approvalId, null, errorCode(error)),
    );
  }

  async synchronize(): Promise<void> {
    const task = this.#journalTail.then(async () => {
      for (const prefix of await recoverAllWorkflowEffectAuthorityObservationPrefixes(
        this.#approvalRoot,
      )) {
        for (const observation of prefix.observations) {
          const path = await this.#journal(observation);
          this.#queueDelivery(path, observation);
        }
      }
    });
    this.#journalTail = task.catch(() => undefined);
    await task;
  }

  async replay(): Promise<void> {
    const scan = this.#journalTail.then(() => readdir(this.#entries));
    this.#journalTail = scan.then(() => undefined);
    for (const name of (await scan).sort()) {
      if (!JOURNAL_FILE.test(name)) {
        throw failure(
          'WORKFLOW_EFFECT_SHADOW_JOURNAL_INVALID',
          'Workflow effect shadow journal inventory is invalid.',
        );
      }
      this.#queueDelivery(join(this.#entries, name));
    }
    await this.#deliveryTail;
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
      const entries = await readdir(this.#entries);
      let bytes = 0;
      for (const name of entries) {
        if (!JOURNAL_FILE.test(name)) {
          throw failure(
            'WORKFLOW_EFFECT_SHADOW_JOURNAL_INVALID',
            'Workflow effect shadow journal entry name is invalid.',
          );
        }
        bytes += Number((await assertOwnerFile(join(this.#entries, name), this.#security)).size);
      }
      if (
        !entries.includes(fileName) &&
        (entries.length >= WORKFLOW_CONTROL_SHADOW_POLICY.maxJournalEntries ||
          bytes + Buffer.byteLength(prepared.body, 'utf8') >
            WORKFLOW_CONTROL_SHADOW_POLICY.maxJournalBytes)
      ) {
        throw failure(
          'WORKFLOW_EFFECT_SHADOW_JOURNAL_CAPACITY',
          'Workflow effect shadow journal capacity is exceeded.',
        );
      }
      if (!entries.includes(fileName)) {
        await writeExclusive(path, prepared.body, this.#security);
        await syncDirectory(this.#entries);
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
    await this.#report(
      'journaled',
      observation.runId,
      observation.approvalId,
      envelope.observationHash,
    );
    return path;
  }

  #queueDelivery(path: string, observation?: WorkflowEffectControlObservation): void {
    this.#deliveryTail = this.#deliveryTail
      .then(() => this.#deliverFile(path))
      .catch(async (error) => {
        if (observation) {
          await this.#report(
            'failed',
            observation.runId,
            observation.approvalId,
            hashWorkflowEffectControlObservation(observation),
            errorCode(error),
          );
        } else {
          await this.#reportUnreadable(path, errorCode(error));
        }
        if (
          error instanceof WorkflowEffectShadowRuntimeError &&
          error.code === 'WORKFLOW_EFFECT_SHADOW_TRANSPORT_INVALID'
        ) {
          this.#scheduleRetry(path);
        }
      });
  }

  #scheduleRetry(path: string): void {
    if (this.#retryTimers.has(path)) return;
    const attempt = (this.#retryAttempts.get(path) ?? 0) + 1;
    this.#retryAttempts.set(path, attempt);
    if (attempt > MAX_DELIVERY_RETRIES) return;
    const delay = Math.min(MAX_RETRY_DELAY_MS, 250 * 2 ** (attempt - 1));
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
  }

  async #deliverFile(path: string): Promise<void> {
    let envelope: WorkflowEffectControlEnvelope;
    try {
      envelope = await readJournalEnvelope(path, this.#security);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.#clearRetry(path);
        return;
      }
      throw error;
    }
    const receipt = await this.#publisher.publish(envelope);
    const prepared = prepareWorkflowEffectControlEnvelope(envelope);
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
    if (receipt.status === 'reconciliation_required') {
      this.#clearRetry(path);
      await this.#report(
        'failed',
        envelope.observation.runId,
        envelope.observation.approvalId,
        envelope.observationHash,
        'WORKFLOW_EFFECT_SHADOW_RECONCILIATION_REQUIRED',
      );
      return;
    }
    await unlink(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    this.#clearRetry(path);
    await this.#report(
      'delivered',
      envelope.observation.runId,
      envelope.observation.approvalId,
      envelope.observationHash,
    );
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

function pathWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

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
  const journalRelative = relative(localRoot, options.journalRoot);
  const protectedRoots = [
    join(localRoot, 'workflows', 'effect-approvals'),
    join(localRoot, 'workflows', 'effect-authority'),
  ];
  if (
    journalRelative.length === 0 ||
    journalRelative.startsWith('..') ||
    isAbsolute(journalRelative) ||
    protectedRoots.some(
      (protectedRoot) =>
        pathWithin(protectedRoot, options.journalRoot!) ||
        pathWithin(options.journalRoot!, protectedRoot),
    )
  ) {
    throw failure(
      'WORKFLOW_EFFECT_SHADOW_CONFIG_INVALID',
      'Workflow effect shadow journal must be workspace-local.',
    );
  }
  const security = productionJournalSecurity();
  const root = await ensureOwnerDirectory(options.journalRoot, security);
  const entries = await ensureOwnerDirectory(join(root, 'entries'), security, root);
  const locks = await ensureOwnerDirectory(join(root, 'locks'), security, root);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (
      !['entries', 'locks'].includes(entry.name) ||
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
    endpoint = new URL(options.endpoint);
  } catch (error) {
    throw failure(
      'WORKFLOW_EFFECT_SHADOW_CONFIG_INVALID',
      'Workflow effect shadow endpoint is invalid.',
      error,
    );
  }
  const timeoutMs = options.timeoutMs ?? WORKFLOW_CONTROL_SHADOW_POLICY.defaultTimeoutMs;
  if (
    endpoint.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]'].includes(endpoint.hostname) ||
    endpoint.pathname !== WORKFLOW_EFFECT_CONTROL_ROUTE ||
    endpoint.username !== '' ||
    endpoint.password !== '' ||
    endpoint.search !== '' ||
    endpoint.hash !== '' ||
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
    async publish(envelopeValue: WorkflowEffectControlEnvelope) {
      const envelope = validateWorkflowEffectControlEnvelope(envelopeValue);
      const prepared = prepareWorkflowEffectControlEnvelope(envelope);
      const controller = new AbortController();
      const timer = setTimeout(
        () =>
          controller.abort(
            failure(
              'WORKFLOW_EFFECT_SHADOW_TRANSPORT_INVALID',
              'Workflow effect shadow request timed out.',
            ),
          ),
        timeoutMs,
      );
      try {
        const response = await fetchImpl(endpoint, {
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
        const body = await readBoundedResponse(
          response,
          controller.signal,
          [200, 201, 202].includes(response.status)
            ? WORKFLOW_EFFECT_SHADOW_MAX_RECEIPT_BYTES
            : WORKFLOW_EFFECT_SHADOW_MAX_ERROR_BYTES,
        );
        if (!/^application\/json(?:\s*;.*)?$/iu.test(response.headers.get('content-type') ?? '')) {
          throw failure(
            'WORKFLOW_EFFECT_SHADOW_TRANSPORT_INVALID',
            'Workflow effect shadow response content type is invalid.',
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
          );
        }
        if (![200, 201, 202].includes(response.status)) {
          let problem;
          try {
            problem = validateWorkflowEffectShadowError(parsed);
          } catch (error) {
            throw failure(
              'WORKFLOW_EFFECT_SHADOW_TRANSPORT_INVALID',
              'Workflow effect shadow error response is invalid.',
              error,
            );
          }
          throw failure(
            'WORKFLOW_EFFECT_SHADOW_TRANSPORT_INVALID',
            `Workflow effect shadow returned HTTP ${response.status}.`,
            undefined,
            problem.code,
          );
        }
        const receipt = validateWorkflowEffectShadowReceipt(parsed, envelope);
        const replay = response.headers.get('Idempotency-Replayed');
        if (
          (response.status === 200 && (receipt.status !== 'accepted' || replay !== 'true')) ||
          (response.status === 201 && (receipt.status !== 'accepted' || replay !== null)) ||
          (response.status === 202 && receipt.status !== 'reconciliation_required') ||
          (response.status === 202 && replay !== null && replay !== 'true')
        ) {
          throw failure(
            'WORKFLOW_EFFECT_SHADOW_TRANSPORT_INVALID',
            'Workflow effect shadow status and replay metadata disagree.',
          );
        }
        return receipt;
      } catch (error) {
        if (error instanceof WorkflowEffectShadowRuntimeError) throw error;
        throw failure(
          'WORKFLOW_EFFECT_SHADOW_TRANSPORT_INVALID',
          'Workflow effect shadow request failed.',
          error,
        );
      } finally {
        clearTimeout(timer);
      }
    },
  });
  PUBLISHERS.add(publisher);
  return publisher;
}

export { isWorkflowEffectShadowObservationPort };
export type { WorkflowEffectShadowObservationPort };
