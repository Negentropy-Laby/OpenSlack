import { readdir, unlink } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { types as nodeTypes } from 'node:util';
import {
  WORKFLOW_CHECKPOINT_SHADOW_ENVELOPE_SCHEMA,
  WORKFLOW_CHECKPOINT_SHADOW_IDEMPOTENCY_PREFIX,
  WORKFLOW_CHECKPOINT_SHADOW_ROUTE,
  validateWorkflowCheckpointShadowEnvelope,
  validateWorkflowCheckpointShadowObservation,
  validateWorkflowCheckpointShadowReceipt,
  workflowCheckpointCanonicalJson,
  workflowCheckpointError,
  workflowCheckpointHash,
  WorkflowCheckpointError,
  type WorkflowCheckpointShadowEnvelope,
  type WorkflowCheckpointShadowObservation,
  type WorkflowCheckpointShadowReceipt,
} from './workflow-checkpoint-shadow-contract.js';
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
import { validateWorkflowLocalShadowEndpoint } from './internal/workflow-local-shadow-config.js';

export interface WorkflowCheckpointShadowPublisherPort {
  publish(envelope: WorkflowCheckpointShadowEnvelope): Promise<WorkflowCheckpointShadowReceipt>;
}

export interface WorkflowCheckpointObservationPort {
  /** Resolves after local journal durability; remote delivery failure remains fail-open. */
  journalObservation(
    sourceSequence: number,
    operation: 'checkpoint_commit' | 'resume_advance',
    observation: WorkflowCheckpointShadowObservation,
  ): Promise<void>;
  replay(): Promise<void>;
  flush(): Promise<void>;
}

export interface WorkflowCheckpointShadowDiagnostic {
  readonly outcome: 'journaled' | 'delivered' | 'failed';
  readonly runIdHash: string;
  readonly observationHash: string;
  readonly code?: string;
}

export interface CreateWorkflowCheckpointObservationPortOptions {
  readonly enabled?: boolean;
  readonly journalRoot?: string;
  readonly publisher?: WorkflowCheckpointShadowPublisherPort;
  readonly diagnosticSink?: (
    diagnostic: WorkflowCheckpointShadowDiagnostic,
  ) => void | Promise<void>;
}

const PORTS = new WeakSet<object>();
const PUBLISHERS = new WeakSet<object>();
const JOURNAL_FILE = /^([0-9]{1,16})-([0-9a-f]{64})\.json$/u;

async function readBoundedResponse(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    if (signal.aborted) throw signal.reason;
    const item = await reader.read();
    if (item.done) break;
    length += item.value.byteLength;
    if (length > WORKFLOW_CONTROL_SHADOW_POLICY.maxReceiptBytes) {
      await reader.cancel();
      throw workflowCheckpointError(
        'WORKFLOW_CHECKPOINT_TRANSPORT_INVALID',
        'Workflow checkpoint shadow receipt is too large.',
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

function code(error: unknown): string {
  if (
    error &&
    typeof error === 'object' &&
    typeof (error as { code?: unknown }).code === 'string'
  ) {
    return String((error as { code: string }).code).slice(0, 128);
  }
  return 'WORKFLOW_CHECKPOINT_SHADOW_FAILED';
}

async function readJournalEnvelope(
  path: string,
  security: WorkflowControlShadowJournalSecurityDependencies,
): Promise<WorkflowCheckpointShadowEnvelope> {
  try {
    const raw = await readOwnerFile(
      path,
      security,
      WORKFLOW_CONTROL_SHADOW_POLICY.maxJournalFileBytes,
    );
    const envelope = validateWorkflowCheckpointShadowEnvelope(JSON.parse(raw));
    if (workflowCheckpointCanonicalJson(envelope) !== raw) {
      throw new TypeError('Checkpoint journal file must be canonical.');
    }
    return envelope;
  } catch (error) {
    if (
      error instanceof WorkflowCheckpointError &&
      error.code === 'WORKFLOW_CHECKPOINT_JOURNAL_INVALID'
    ) {
      throw error;
    }
    throw workflowCheckpointError(
      'WORKFLOW_CHECKPOINT_JOURNAL_INVALID',
      'Checkpoint journal file is invalid.',
      error,
    );
  }
}

class ObservationPort implements WorkflowCheckpointObservationPort {
  readonly #entries: string;
  readonly #locks: string;
  readonly #publisher: WorkflowCheckpointShadowPublisherPort;
  readonly #diagnostic?: CreateWorkflowCheckpointObservationPortOptions['diagnosticSink'];
  readonly #security: WorkflowControlShadowJournalSecurityDependencies;
  #journalTail: Promise<void> = Promise.resolve();
  #deliveryTail: Promise<void> = Promise.resolve();

  constructor(
    entries: string,
    locks: string,
    publisher: WorkflowCheckpointShadowPublisherPort,
    security: WorkflowControlShadowJournalSecurityDependencies,
    diagnostic?: CreateWorkflowCheckpointObservationPortOptions['diagnosticSink'],
  ) {
    this.#entries = entries;
    this.#locks = locks;
    this.#publisher = publisher;
    this.#security = security;
    this.#diagnostic = diagnostic;
  }

  async journalObservation(
    sourceSequence: number,
    operation: 'checkpoint_commit' | 'resume_advance',
    value: WorkflowCheckpointShadowObservation,
  ): Promise<void> {
    const observation = validateWorkflowCheckpointShadowObservation(value);
    const task = this.#journalTail.then(() =>
      this.#journal(sourceSequence, operation, observation),
    );
    this.#journalTail = task
      .then(() => undefined)
      .catch((error) => this.#report('failed', observation, code(error)));
    const path = await task;
    this.#queueDelivery(path, observation);
  }

  async replay(): Promise<void> {
    const scan = this.#journalTail.then(() => readdir(this.#entries));
    this.#journalTail = scan.then(() => undefined);
    for (const name of (await scan).sort()) {
      if (!JOURNAL_FILE.test(name)) {
        throw workflowCheckpointError(
          'WORKFLOW_CHECKPOINT_JOURNAL_INVALID',
          'Checkpoint journal entry is invalid.',
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

  async #journal(
    sourceSequence: number,
    operation: 'checkpoint_commit' | 'resume_advance',
    observation: WorkflowCheckpointShadowObservation,
  ): Promise<string> {
    const observationHash = workflowCheckpointHash(observation);
    const envelope = validateWorkflowCheckpointShadowEnvelope({
      schema: WORKFLOW_CHECKPOINT_SHADOW_ENVELOPE_SCHEMA,
      goRole: 'observer_only',
      sourceSequence,
      operation,
      observation,
      observationHash,
    });
    const fileName = `${String(envelope.sourceSequence).padStart(16, '0')}-${observationHash}.json`;
    const path = join(this.#entries, fileName);
    const body = workflowCheckpointCanonicalJson(envelope);
    if (Buffer.byteLength(body, 'utf8') > WORKFLOW_CONTROL_SHADOW_POLICY.maxJournalFileBytes) {
      throw workflowCheckpointError(
        'WORKFLOW_CHECKPOINT_JOURNAL_INVALID',
        'Checkpoint journal entry exceeds the frozen bound.',
      );
    }
    let release: () => Promise<void>;
    try {
      release = await acquireOwnerJournalLock(
        this.#locks,
        workflowCheckpointHash('checkpoint-shadow-capacity'),
        this.#security,
      );
    } catch (error) {
      throw workflowCheckpointError(
        'WORKFLOW_CHECKPOINT_JOURNAL_INVALID',
        'Checkpoint journal lock is invalid.',
        error,
      );
    }
    try {
      const entries = await readdir(this.#entries);
      let bytes = 0;
      for (const name of entries) {
        if (!JOURNAL_FILE.test(name)) {
          throw workflowCheckpointError(
            'WORKFLOW_CHECKPOINT_JOURNAL_INVALID',
            'Checkpoint journal entry is invalid.',
          );
        }
        bytes += Number((await assertOwnerFile(join(this.#entries, name), this.#security)).size);
      }
      if (
        !entries.includes(fileName) &&
        (entries.length >= WORKFLOW_CONTROL_SHADOW_POLICY.maxJournalEntries ||
          bytes + Buffer.byteLength(body) > WORKFLOW_CONTROL_SHADOW_POLICY.maxJournalBytes)
      ) {
        throw workflowCheckpointError(
          'WORKFLOW_CHECKPOINT_JOURNAL_CAPACITY',
          'Checkpoint journal capacity is exceeded.',
        );
      }
      if (!entries.includes(fileName)) {
        await writeExclusive(path, body, this.#security);
        await syncDirectory(this.#entries);
      } else {
        const prior = await readJournalEnvelope(path, this.#security);
        if (workflowCheckpointCanonicalJson(prior) !== body) {
          throw workflowCheckpointError(
            'WORKFLOW_CHECKPOINT_JOURNAL_INVALID',
            'Checkpoint journal replay binding is mismatched.',
          );
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        const prior = await readJournalEnvelope(path, this.#security);
        if (workflowCheckpointCanonicalJson(prior) !== workflowCheckpointCanonicalJson(envelope)) {
          throw workflowCheckpointError(
            'WORKFLOW_CHECKPOINT_JOURNAL_INVALID',
            'Checkpoint journal replay binding is mismatched.',
          );
        }
      } else if (error instanceof WorkflowCheckpointError) {
        throw error;
      } else {
        throw workflowCheckpointError(
          'WORKFLOW_CHECKPOINT_JOURNAL_INVALID',
          'Checkpoint journal persistence failed.',
          error,
        );
      }
    } finally {
      await release();
    }
    await this.#report('journaled', observation);
    return path;
  }

  #queueDelivery(path: string, observation?: WorkflowCheckpointShadowObservation): void {
    this.#deliveryTail = this.#deliveryTail
      .then(() => this.#deliverFile(path))
      .catch(async (error) => {
        if (observation) await this.#report('failed', observation, code(error));
        else await this.#reportUnreadable(path, code(error));
      });
  }

  async #deliverFile(path: string): Promise<void> {
    const envelope = await readJournalEnvelope(path, this.#security);
    const receipt = await this.#publisher.publish(envelope);
    const expectedKey = WORKFLOW_CHECKPOINT_SHADOW_IDEMPOTENCY_PREFIX + envelope.observationHash;
    if (
      receipt.idempotencyKey !== expectedKey ||
      receipt.workspaceId !== envelope.observation.runner.workspaceId ||
      receipt.runId !== envelope.observation.runId ||
      receipt.sourceSequence !== envelope.sourceSequence ||
      receipt.operation !== envelope.operation ||
      receipt.envelopeHash !== workflowCheckpointHash(envelope) ||
      receipt.observationHash !== envelope.observationHash
    ) {
      throw workflowCheckpointError(
        'WORKFLOW_CHECKPOINT_TRANSPORT_INVALID',
        'Checkpoint shadow receipt is mismatched.',
      );
    }
    if (receipt.status === 'reconciliation_required') {
      await this.#report(
        'failed',
        envelope.observation,
        'WORKFLOW_CHECKPOINT_RECONCILIATION_REQUIRED',
      );
      return;
    }
    await unlink(path);
    await this.#report('delivered', envelope.observation);
  }

  async #report(
    outcome: WorkflowCheckpointShadowDiagnostic['outcome'],
    observation: WorkflowCheckpointShadowObservation,
    failureCode?: string,
  ): Promise<void> {
    try {
      await this.#diagnostic?.({
        outcome,
        runIdHash: workflowCheckpointHash(observation.runId),
        observationHash: workflowCheckpointHash(observation),
        ...(failureCode ? { code: failureCode } : {}),
      });
    } catch {
      // Diagnostics are also observation-only.
    }
  }

  async #reportUnreadable(path: string, failureCode: string): Promise<void> {
    try {
      const match = JOURNAL_FILE.exec(basename(path));
      await this.#diagnostic?.({
        outcome: 'failed',
        runIdHash: workflowCheckpointHash('checkpoint-journal-run-unavailable'),
        observationHash: match?.[2] ?? workflowCheckpointHash('checkpoint-journal-invalid'),
        code: failureCode,
      });
    } catch {
      // Diagnostics are observation-only and contain no journal bytes or paths.
    }
  }
}

const NOOP_PORT = Object.freeze<WorkflowCheckpointObservationPort>({
  async journalObservation() {},
  async replay() {},
  async flush() {},
});
PORTS.add(NOOP_PORT);

export async function createWorkflowCheckpointObservationPort(
  options: CreateWorkflowCheckpointObservationPortOptions = {},
): Promise<WorkflowCheckpointObservationPort> {
  if (options.enabled !== true) return NOOP_PORT;
  if (
    typeof options.journalRoot !== 'string' ||
    !isAbsolute(options.journalRoot) ||
    resolve(options.journalRoot) !== options.journalRoot ||
    !isWorkflowCheckpointShadowPublisherPort(options.publisher) ||
    (options.diagnosticSink !== undefined &&
      (typeof options.diagnosticSink !== 'function' || nodeTypes.isProxy(options.diagnosticSink)))
  ) {
    throw workflowCheckpointError(
      'WORKFLOW_CHECKPOINT_OBSERVER_CONFIG_INVALID',
      'Enabled Workflow checkpoint shadow options are invalid.',
    );
  }
  const entries = join(options.journalRoot, 'entries');
  const locks = join(options.journalRoot, 'locks');
  const security = productionJournalSecurity();
  const root = await ensureOwnerDirectory(options.journalRoot, security);
  await ensureOwnerDirectory(entries, security, root);
  await ensureOwnerDirectory(locks, security, root);
  const port = Object.freeze(
    new ObservationPort(entries, locks, options.publisher, security, options.diagnosticSink),
  );
  PORTS.add(port);
  void port.replay().catch(async () => {
    try {
      await options.diagnosticSink?.({
        outcome: 'failed',
        runIdHash: workflowCheckpointHash('checkpoint-journal-run-unavailable'),
        observationHash: workflowCheckpointHash('checkpoint-journal-replay-unavailable'),
        code: 'WORKFLOW_CHECKPOINT_JOURNAL_REPLAY_FAILED',
      });
    } catch {
      // Startup replay and its diagnostics are observation-only.
    }
  });
  return port;
}

export function isWorkflowCheckpointObservationPort(
  value: unknown,
): value is WorkflowCheckpointObservationPort {
  return Boolean(
    value && typeof value === 'object' && !nodeTypes.isProxy(value) && PORTS.has(value),
  );
}

/** @internal Allows deterministic RunStore qualification without a filesystem journal. */
export function createWorkflowCheckpointObservationPortForTest(
  implementation: WorkflowCheckpointObservationPort,
): WorkflowCheckpointObservationPort {
  if (
    !implementation ||
    typeof implementation !== 'object' ||
    nodeTypes.isProxy(implementation) ||
    typeof implementation.journalObservation !== 'function' ||
    typeof implementation.replay !== 'function' ||
    typeof implementation.flush !== 'function'
  ) {
    throw new TypeError('Workflow checkpoint observation test port is invalid.');
  }
  const port = Object.freeze(implementation);
  PORTS.add(port);
  return port;
}

export function isWorkflowCheckpointShadowPublisherPort(
  value: unknown,
): value is WorkflowCheckpointShadowPublisherPort {
  return Boolean(
    value && typeof value === 'object' && !nodeTypes.isProxy(value) && PUBLISHERS.has(value),
  );
}

export function createWorkflowCheckpointShadowHttpPublisher(options: {
  readonly endpoint: string;
  readonly bearerToken: string;
  readonly callerId: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}): WorkflowCheckpointShadowPublisherPort {
  let endpoint: URL;
  try {
    endpoint = validateWorkflowLocalShadowEndpoint(options.endpoint, [
      '/',
      WORKFLOW_CHECKPOINT_SHADOW_ROUTE,
    ]);
  } catch (error) {
    throw workflowCheckpointError(
      'WORKFLOW_CHECKPOINT_OBSERVER_CONFIG_INVALID',
      'Workflow checkpoint shadow HTTP options are invalid.',
      error,
    );
  }
  if (
    typeof options.bearerToken !== 'string' ||
    options.bearerToken.length < 32 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u.test(options.callerId) ||
    (options.timeoutMs !== undefined &&
      (!Number.isSafeInteger(options.timeoutMs) ||
        options.timeoutMs < 1 ||
        options.timeoutMs > 30_000))
  ) {
    throw workflowCheckpointError(
      'WORKFLOW_CHECKPOINT_OBSERVER_CONFIG_INVALID',
      'Workflow checkpoint shadow HTTP options are invalid.',
    );
  }
  const fetcher = options.fetch ?? globalThis.fetch;
  const target = new URL(WORKFLOW_CHECKPOINT_SHADOW_ROUTE, endpoint);
  const port = Object.freeze<WorkflowCheckpointShadowPublisherPort>({
    async publish(value) {
      const envelope = validateWorkflowCheckpointShadowEnvelope(value);
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(new Error('Workflow checkpoint shadow request timed out.')),
        options.timeoutMs ?? 2_000,
      );
      try {
        const response = await fetcher(target, {
          method: 'POST',
          redirect: 'error',
          signal: controller.signal,
          headers: {
            authorization: `Bearer ${options.bearerToken}`,
            'content-type': 'application/json',
            'idempotency-key':
              WORKFLOW_CHECKPOINT_SHADOW_IDEMPOTENCY_PREFIX + envelope.observationHash,
            'x-openslack-workspace-id': envelope.observation.runner.workspaceId,
            'x-openslack-caller-id': options.callerId,
          },
          body: workflowCheckpointCanonicalJson(envelope),
        });
        if (![200, 201, 202].includes(response.status)) {
          throw workflowCheckpointError(
            'WORKFLOW_CHECKPOINT_TRANSPORT_INVALID',
            'Workflow checkpoint shadow endpoint rejected observation.',
          );
        }
        if (response.headers.get('content-type')?.split(';', 1)[0]?.trim() !== 'application/json') {
          throw workflowCheckpointError(
            'WORKFLOW_CHECKPOINT_TRANSPORT_INVALID',
            'Workflow checkpoint shadow receipt content type is invalid.',
          );
        }
        const raw = await readBoundedResponse(response, controller.signal);
        const receipt = validateWorkflowCheckpointShadowReceipt(JSON.parse(raw));
        if (workflowCheckpointCanonicalJson(receipt) !== raw) {
          throw workflowCheckpointError(
            'WORKFLOW_CHECKPOINT_TRANSPORT_INVALID',
            'Workflow checkpoint shadow receipt bytes are not canonical.',
          );
        }
        if (
          (response.status === 200 &&
            (response.headers.get('idempotency-replayed') !== 'true' ||
              receipt.status !== 'accepted')) ||
          (response.status === 201 && receipt.status !== 'accepted') ||
          (response.status === 202 && receipt.status !== 'reconciliation_required')
        ) {
          throw workflowCheckpointError(
            'WORKFLOW_CHECKPOINT_TRANSPORT_INVALID',
            'Workflow checkpoint shadow receipt status is mismatched.',
          );
        }
        return receipt;
      } catch (error) {
        if (error instanceof WorkflowCheckpointError) throw error;
        throw workflowCheckpointError(
          'WORKFLOW_CHECKPOINT_TRANSPORT_INVALID',
          'Workflow checkpoint shadow transport failed.',
          error,
        );
      } finally {
        clearTimeout(timeout);
      }
    },
  });
  PUBLISHERS.add(port);
  return port;
}
