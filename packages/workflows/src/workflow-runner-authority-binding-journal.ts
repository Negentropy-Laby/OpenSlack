import { createHash } from 'node:crypto';
import { lstat, readdir, rename, rmdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import {
  canonicalWorkflowControlAuthorityJson,
  parseWorkflowControlAuthorityMessageBytes,
  type WorkflowControlAuthorityMessage,
} from './workflow-control-authority-contract.js';
import {
  hashWorkflowRunnerAuthorityBindingEvidence,
  workflowRunnerAuthorityBindingCompletionControlKind,
  parseWorkflowRunnerAuthorityBindingReceiptBytes,
  parseWorkflowRunnerAuthorityBindingResolutionBytes,
  parseWorkflowRunnerAuthorityBindingStageBytes,
  validateWorkflowRunnerAuthorityBindingResolutionForStage,
  validateWorkflowRunnerAuthorityBindingResolutionReceipt,
  validateWorkflowRunnerAuthorityBindingStageReceipt,
  validateWorkflowRunnerAuthorityControlDeliveryReceiptForMessage,
  validateWorkflowRunnerBudgetSourceResult,
  type WorkflowRunnerAuthorityBindingOperation,
  type WorkflowRunnerAuthorityBindingResolution,
  type WorkflowRunnerAuthorityBindingStage,
  type WorkflowRunnerAuthorityControlDeliveryReceipt,
  type WorkflowRunnerAuthorityEvidence,
  type WorkflowRunnerAuthorityResolutionReceipt,
  type WorkflowRunnerAuthorityStageReceipt,
  type WorkflowRunnerBudgetSourceResult,
} from './workflow-runner-authority-binding-contract.js';
import {
  acquireOwnerJournalLock,
  assertOwnerDirectory,
  assertOwnerFile,
  ensureOwnerDirectory,
  productionJournalSecurity,
  readOwnerFile,
  syncDirectory,
  writeExclusive,
  type WorkflowControlShadowJournalSecurityDependencies,
} from './workflow-control-shadow.js';

export const WORKFLOW_RUNNER_AUTHORITY_BINDING_JOURNAL_SCHEMA =
  'openslack.workflow_runner_authority_binding_journal.v1' as const;

export interface WorkflowRunnerAuthorityControlDeliveryJournalEntry {
  readonly companionSequence: number;
  readonly message: WorkflowControlAuthorityMessage;
  readonly budgetSourceResult?: WorkflowRunnerBudgetSourceResult;
  readonly receipt?: WorkflowRunnerAuthorityControlDeliveryReceipt;
  readonly confirmedReceipt?: WorkflowRunnerAuthorityControlDeliveryReceipt;
}

export interface WorkflowRunnerAuthorityBindingJournalEntry {
  readonly stage: WorkflowRunnerAuthorityBindingStage;
  readonly stageReceipt?: WorkflowRunnerAuthorityStageReceipt;
  readonly sourceEvidence?: WorkflowRunnerAuthorityEvidence;
  readonly resolution?: WorkflowRunnerAuthorityBindingResolution;
  readonly resolutionReceipt?: WorkflowRunnerAuthorityResolutionReceipt;
  /** Exact E2 reserve result committed after the accepted resolution and before event delivery. */
  readonly budgetSourceResult?: WorkflowRunnerBudgetSourceResult;
  readonly controlDeliveries: readonly WorkflowRunnerAuthorityControlDeliveryJournalEntry[];
}

export class WorkflowRunnerAuthorityBindingJournalError extends Error {
  constructor(
    readonly code:
      | 'WORKFLOW_RUNNER_AUTHORITY_BINDING_JOURNAL_PATH_UNSAFE'
      | 'WORKFLOW_RUNNER_AUTHORITY_BINDING_JOURNAL_CORRUPT'
      | 'WORKFLOW_RUNNER_AUTHORITY_BINDING_JOURNAL_CONFLICT',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'WorkflowRunnerAuthorityBindingJournalError';
  }
}

const SAFE_DIRECTORY = /^[0-9a-f]{64}$/u;
const CONTROL_FILE = /^(message|budget-source-result|receipt|confirmed)-([0-9]{10})\.json$/u;
const MAX_SLOT_BYTES = 1_048_576;
const STATIC_FILES = new Set([
  'stage.json',
  'stage-receipt.json',
  'source-evidence.json',
  'resolution.json',
  'resolution-receipt.json',
  'budget-source-result.json',
]);
function fail(
  code: WorkflowRunnerAuthorityBindingJournalError['code'],
  message: string,
  cause?: unknown,
): never {
  throw new WorkflowRunnerAuthorityBindingJournalError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function bindingDirectoryName(bindingId: string): string {
  return sha256(`openslack.workflow-runner-authority-binding.journal.v1\0${bindingId}`);
}

function sequenceName(value: number): string {
  if (!Number.isSafeInteger(value) || value < 3 || value > 9_999_999_999) {
    return fail(
      'WORKFLOW_RUNNER_AUTHORITY_BINDING_JOURNAL_CORRUPT',
      'Control-delivery companion sequence is invalid.',
    );
  }
  return String(value).padStart(10, '0');
}

function canonical(value: unknown): string {
  return `${canonicalWorkflowControlAuthorityJson(value)}\n`;
}

function exactEqual(left: unknown, right: unknown): boolean {
  return (
    canonicalWorkflowControlAuthorityJson(left) === canonicalWorkflowControlAuthorityJson(right)
  );
}

function exactJson(bytes: string, label: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(bytes) as unknown;
  } catch (error) {
    return fail(
      'WORKFLOW_RUNNER_AUTHORITY_BINDING_JOURNAL_CORRUPT',
      `${label} is not JSON.`,
      error,
    );
  }
  if (canonical(value) !== bytes) {
    return fail(
      'WORKFLOW_RUNNER_AUTHORITY_BINDING_JOURNAL_CORRUPT',
      `${label} is not exact canonical JSON.`,
    );
  }
  return value;
}

function receipt(bytes: string, label: string) {
  try {
    return parseWorkflowRunnerAuthorityBindingReceiptBytes(Buffer.from(bytes, 'utf8'));
  } catch (error) {
    return fail(
      'WORKFLOW_RUNNER_AUTHORITY_BINDING_JOURNAL_CORRUPT',
      `${label} is not an exact F2a receipt.`,
      error,
    );
  }
}

function controlMessage(bytes: string, label: string): WorkflowControlAuthorityMessage {
  try {
    return parseWorkflowControlAuthorityMessageBytes(Buffer.from(bytes, 'utf8'));
  } catch (error) {
    return fail(
      'WORKFLOW_RUNNER_AUTHORITY_BINDING_JOURNAL_CORRUPT',
      `${label} is not an exact authority message.`,
      error,
    );
  }
}

async function present(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export function workflowRunnerAuthorityBindingJournalEntryClosed(
  entry: WorkflowRunnerAuthorityBindingJournalEntry,
): boolean {
  if (
    !entry.stageReceipt ||
    entry.stageReceipt.status !== 'accepted' ||
    !entry.resolutionReceipt ||
    entry.resolutionReceipt.status !== 'accepted'
  ) {
    return false;
  }
  const event = entry.controlDeliveries.find(
    (delivery) => delivery.message.kind === 'event_receipt',
  );
  if (
    !event?.confirmedReceipt ||
    event.confirmedReceipt.disposition !== 'accepted' ||
    event.confirmedReceipt.companionSequence !== 3
  ) {
    return false;
  }
  if (
    entry.controlDeliveries.some(
      (delivery, index) =>
        delivery.companionSequence !== index + 3 ||
        !delivery.receipt ||
        !delivery.confirmedReceipt ||
        delivery.confirmedReceipt.disposition !== 'accepted',
    )
  ) {
    return false;
  }
  const decisionKind = workflowRunnerAuthorityBindingCompletionControlKind(entry.stage.operation);
  if (decisionKind === 'event_receipt') return true;
  const decision = entry.controlDeliveries.find(
    (delivery) => delivery.message.kind === decisionKind,
  );
  return Boolean(
    decision?.confirmedReceipt &&
    decision.confirmedReceipt.disposition === 'accepted' &&
    decision.confirmedReceipt.companionSequence === 4,
  );
}

export class WorkflowRunnerAuthorityBindingJournal {
  #root: string;
  readonly #security: WorkflowControlShadowJournalSecurityDependencies;
  #active?: string;
  #closed?: string;
  #locks?: string;
  readonly #activeByRun = new Map<string, Set<string>>();
  readonly #entryCache = new Map<
    string,
    {
      readonly parent: string;
      readonly identity: string;
      readonly entry: WorkflowRunnerAuthorityBindingJournalEntry;
    }
  >();
  #activeDirectoryIdentity?: string;

  constructor(
    root: string,
    security: WorkflowControlShadowJournalSecurityDependencies = productionJournalSecurity(),
  ) {
    if (!isAbsolute(root) || resolve(root) !== root || root.includes('\0')) {
      fail(
        'WORKFLOW_RUNNER_AUTHORITY_BINDING_JOURNAL_PATH_UNSAFE',
        'Authority-binding journal root must be normalized and absolute.',
      );
    }
    this.#root = root;
    this.#security = security;
  }

  async initialize(): Promise<void> {
    const root = await ensureOwnerDirectory(this.#root, this.#security);
    this.#root = root;
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (
        !['active', 'bindings', 'closed', 'locks'].includes(entry.name) ||
        !entry.isDirectory() ||
        entry.isSymbolicLink()
      ) {
        fail(
          'WORKFLOW_RUNNER_AUTHORITY_BINDING_JOURNAL_PATH_UNSAFE',
          'Authority-binding journal root contains an unexpected entry.',
        );
      }
    }
    this.#active = await ensureOwnerDirectory(join(root, 'active'), this.#security, root);
    this.#closed = await ensureOwnerDirectory(join(root, 'closed'), this.#security, root);
    this.#locks = await ensureOwnerDirectory(join(root, 'locks'), this.#security, root);
    this.#activeByRun.clear();
    this.#entryCache.clear();
    const legacy = join(root, 'bindings');
    if (await present(legacy)) {
      await assertOwnerDirectory(legacy, this.#security, root);
      for (const directory of await readdir(legacy, { withFileTypes: true })) {
        if (
          !SAFE_DIRECTORY.test(directory.name) ||
          !directory.isDirectory() ||
          directory.isSymbolicLink()
        ) {
          return fail(
            'WORKFLOW_RUNNER_AUTHORITY_BINDING_JOURNAL_PATH_UNSAFE',
            'Legacy authority-binding journal contains an unsafe entry.',
          );
        }
        const source = join(legacy, directory.name);
        const entry = await this.#readBinding(source, directory.name, legacy);
        const destinationRoot = workflowRunnerAuthorityBindingJournalEntryClosed(entry)
          ? this.#closed
          : this.#active;
        await rename(source, join(destinationRoot, directory.name));
        await syncDirectory(destinationRoot);
      }
      await rmdir(legacy);
      await syncDirectory(root);
    }
    for (const [partition, expectedClosed] of [
      [this.#active, false],
      [this.#closed, true],
    ] as const) {
      for (const directory of await readdir(partition, { withFileTypes: true })) {
        if (
          !SAFE_DIRECTORY.test(directory.name) ||
          !directory.isDirectory() ||
          directory.isSymbolicLink()
        ) {
          return fail(
            'WORKFLOW_RUNNER_AUTHORITY_BINDING_JOURNAL_PATH_UNSAFE',
            'Authority-binding journal partition contains an unsafe entry.',
          );
        }
        const entry = await this.#readBinding(
          join(partition, directory.name),
          directory.name,
          partition,
        );
        if (workflowRunnerAuthorityBindingJournalEntryClosed(entry) !== expectedClosed) {
          return fail(
            'WORKFLOW_RUNNER_AUTHORITY_BINDING_JOURNAL_CORRUPT',
            'Authority-binding journal partition does not match its closure state.',
          );
        }
        if (!expectedClosed) this.#indexActive(entry);
      }
    }
    this.#activeDirectoryIdentity = await this.#pathIdentity(this.#active);
  }

  async runWorkflowExclusive<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const { locks } = this.#paths();
    const release = await acquireOwnerJournalLock(
      locks,
      sha256(`openslack.workflow-runner-authority-binding.run.v1\0${runId}`),
      this.#security,
    );
    try {
      return await operation();
    } finally {
      await release();
    }
  }

  async list(): Promise<readonly WorkflowRunnerAuthorityBindingJournalEntry[]> {
    const { active } = this.#paths();
    await assertOwnerDirectory(active, this.#security, this.#root);
    const result: WorkflowRunnerAuthorityBindingJournalEntry[] = [];
    this.#activeByRun.clear();
    for (const directory of await readdir(active, { withFileTypes: true })) {
      if (
        !SAFE_DIRECTORY.test(directory.name) ||
        !directory.isDirectory() ||
        directory.isSymbolicLink()
      ) {
        return fail(
          'WORKFLOW_RUNNER_AUTHORITY_BINDING_JOURNAL_PATH_UNSAFE',
          'Authority-binding journal contains an unsafe binding entry.',
        );
      }
      const entry = await this.#readBinding(join(active, directory.name), directory.name, active);
      result.push(entry);
      this.#indexActive(entry);
    }
    this.#activeDirectoryIdentity = await this.#pathIdentity(active);
    return Object.freeze(
      result.sort((left, right) => left.stage.bindingId.localeCompare(right.stage.bindingId)),
    );
  }

  async activeForRun(
    runId: string,
  ): Promise<readonly WorkflowRunnerAuthorityBindingJournalEntry[]> {
    await this.#refreshActiveIndexIfDrifted();
    const { active } = this.#paths();
    const names = [...(this.#activeByRun.get(runId) ?? [])].sort();
    const entries: WorkflowRunnerAuthorityBindingJournalEntry[] = [];
    for (const name of names) {
      const directory = join(active, name);
      if (!(await present(directory))) {
        await this.#refreshActiveIndex(true);
        return this.activeForRun(runId);
      }
      const entry = await this.#readBinding(directory, name, active);
      if (entry.stage.runId !== runId || workflowRunnerAuthorityBindingJournalEntryClosed(entry)) {
        await this.#refreshActiveIndex(true);
        return this.activeForRun(runId);
      }
      entries.push(entry);
    }
    return Object.freeze(entries);
  }

  async read(bindingId: string): Promise<WorkflowRunnerAuthorityBindingJournalEntry | null> {
    const name = bindingDirectoryName(bindingId);
    for (const parent of [this.#paths().active, this.#paths().closed]) {
      const directory = join(parent, name);
      if (!(await present(directory))) continue;
      const entry = await this.#readBinding(directory, name, parent);
      if (entry.stage.bindingId !== bindingId) {
        return fail(
          'WORKFLOW_RUNNER_AUTHORITY_BINDING_JOURNAL_CONFLICT',
          'Authority-binding journal directory was cross-spliced.',
        );
      }
      return entry;
    }
    return null;
  }

  async putStage(stage: WorkflowRunnerAuthorityBindingStage): Promise<void> {
    const { active } = this.#paths();
    const name = bindingDirectoryName(stage.bindingId);
    const directory = await ensureOwnerDirectory(join(active, name), this.#security, active);
    await this.#putSlot(join(directory, 'stage.json'), canonical(stage));
    this.#indexActive({ stage });
    this.#activeDirectoryIdentity = await this.#pathIdentity(active);
  }

  async putStageReceipt(
    bindingId: string,
    value: WorkflowRunnerAuthorityStageReceipt,
  ): Promise<void> {
    await this.#putBindingSlot(bindingId, 'stage-receipt.json', canonical(value));
  }

  async putSourceEvidence(
    bindingId: string,
    operation: WorkflowRunnerAuthorityBindingOperation,
    value: WorkflowRunnerAuthorityEvidence,
  ): Promise<void> {
    hashWorkflowRunnerAuthorityBindingEvidence(value, operation);
    await this.#putBindingSlot(bindingId, 'source-evidence.json', canonical(value));
  }

  async putResolution(
    bindingId: string,
    value: WorkflowRunnerAuthorityBindingResolution,
  ): Promise<void> {
    await this.#putBindingSlot(bindingId, 'resolution.json', canonical(value));
  }

  async putResolutionReceipt(
    bindingId: string,
    value: WorkflowRunnerAuthorityResolutionReceipt,
  ): Promise<void> {
    await this.#putBindingSlot(bindingId, 'resolution-receipt.json', canonical(value));
  }

  async putBudgetSourceResult(
    bindingId: string,
    value: WorkflowRunnerBudgetSourceResult,
  ): Promise<void> {
    await this.#putBindingSlot(bindingId, 'budget-source-result.json', canonical(value));
  }

  async putControlMessage(
    bindingId: string,
    companionSequence: number,
    message: WorkflowControlAuthorityMessage,
    budgetSourceResult?: WorkflowRunnerBudgetSourceResult,
  ): Promise<void> {
    const suffix = sequenceName(companionSequence);
    await this.#putBindingSlot(bindingId, `message-${suffix}.json`, canonical(message));
    if (budgetSourceResult !== undefined) {
      await this.#putBindingSlot(
        bindingId,
        `budget-source-result-${suffix}.json`,
        canonical(budgetSourceResult),
      );
    }
  }

  async putControlReceipt(
    bindingId: string,
    value: WorkflowRunnerAuthorityControlDeliveryReceipt,
  ): Promise<void> {
    await this.#putBindingSlot(
      bindingId,
      `receipt-${sequenceName(value.companionSequence)}.json`,
      canonical(value),
    );
  }

  async confirmControlReceipt(
    bindingId: string,
    value: WorkflowRunnerAuthorityControlDeliveryReceipt,
  ): Promise<void> {
    await this.#putBindingSlot(
      bindingId,
      `confirmed-${sequenceName(value.companionSequence)}.json`,
      canonical(value),
    );
    const entry = await this.read(bindingId);
    if (entry && workflowRunnerAuthorityBindingJournalEntryClosed(entry)) {
      await this.#archiveClosed(entry);
    }
  }

  #paths(): { active: string; closed: string; locks: string } {
    if (!this.#active || !this.#closed || !this.#locks) {
      return fail(
        'WORKFLOW_RUNNER_AUTHORITY_BINDING_JOURNAL_PATH_UNSAFE',
        'Authority-binding journal is not initialized.',
      );
    }
    return { active: this.#active, closed: this.#closed, locks: this.#locks };
  }

  async #putBindingSlot(bindingId: string, name: string, bytes: string): Promise<void> {
    const entry = await this.read(bindingId);
    if (!entry) {
      return fail(
        'WORKFLOW_RUNNER_AUTHORITY_BINDING_JOURNAL_CONFLICT',
        'Authority-binding stage is missing before a later journal slot.',
      );
    }
    const directory = join(this.#paths().active, bindingDirectoryName(bindingId));
    if (!(await present(directory))) {
      return fail(
        'WORKFLOW_RUNNER_AUTHORITY_BINDING_JOURNAL_CONFLICT',
        'A closed authority-binding journal entry cannot accept another slot.',
      );
    }
    await this.#putSlot(join(directory, name), bytes);
  }

  async #putSlot(path: string, bytes: string): Promise<void> {
    this.#invalidateDirectory(dirname(path));
    try {
      await writeExclusive(path, bytes, this.#security);
      await syncDirectory(resolve(path, '..'));
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const existing = await readOwnerFile(path, this.#security, MAX_SLOT_BYTES);
    if (existing !== bytes) {
      return fail(
        'WORKFLOW_RUNNER_AUTHORITY_BINDING_JOURNAL_CONFLICT',
        'Authority-binding append-only slot conflicts with durable bytes.',
      );
    }
  }

  async #readBinding(
    directory: string,
    expectedName: string,
    parent: string,
  ): Promise<WorkflowRunnerAuthorityBindingJournalEntry> {
    await assertOwnerDirectory(directory, this.#security, parent);
    const identity = await this.#pathIdentity(directory);
    const cached = this.#entryCache.get(expectedName);
    if (cached?.parent === parent && cached.identity === identity) return cached.entry;
    const files = await readdir(directory, { withFileTypes: true });
    const names = new Set<string>();
    for (const file of files) {
      if (
        !file.isFile() ||
        file.isSymbolicLink() ||
        (!STATIC_FILES.has(file.name) && !CONTROL_FILE.test(file.name))
      ) {
        return fail(
          'WORKFLOW_RUNNER_AUTHORITY_BINDING_JOURNAL_PATH_UNSAFE',
          'Authority-binding directory contains an unexpected or unsafe entry.',
        );
      }
      await assertOwnerFile(join(directory, file.name), this.#security);
      names.add(file.name);
    }
    if (!names.has('stage.json')) {
      return fail(
        'WORKFLOW_RUNNER_AUTHORITY_BINDING_JOURNAL_CORRUPT',
        'Authority-binding directory has no durable stage.',
      );
    }
    const read = (name: string) =>
      readOwnerFile(join(directory, name), this.#security, MAX_SLOT_BYTES);
    let stage: WorkflowRunnerAuthorityBindingStage;
    try {
      stage = parseWorkflowRunnerAuthorityBindingStageBytes(
        Buffer.from(await read('stage.json'), 'utf8'),
      );
    } catch (error) {
      return fail(
        'WORKFLOW_RUNNER_AUTHORITY_BINDING_JOURNAL_CORRUPT',
        'Authority-binding stage slot is invalid.',
        error,
      );
    }
    if (bindingDirectoryName(stage.bindingId) !== expectedName) {
      return fail(
        'WORKFLOW_RUNNER_AUTHORITY_BINDING_JOURNAL_CONFLICT',
        'Authority-binding stage was stored under a cross-spliced directory.',
      );
    }
    const phaseReceipt = async (name: string) => {
      if (!names.has(name)) return undefined;
      return receipt(await read(name), name);
    };
    const rawStageReceipt = await phaseReceipt('stage-receipt.json');
    const rawResolutionReceipt = await phaseReceipt('resolution-receipt.json');
    if (rawStageReceipt && rawStageReceipt.phase !== 'stage_event') {
      return fail(
        'WORKFLOW_RUNNER_AUTHORITY_BINDING_JOURNAL_CORRUPT',
        'Stage receipt phase drifted.',
      );
    }
    if (rawResolutionReceipt && rawResolutionReceipt.phase !== 'commit_authority') {
      return fail(
        'WORKFLOW_RUNNER_AUTHORITY_BINDING_JOURNAL_CORRUPT',
        'Resolution receipt phase drifted.',
      );
    }
    let sourceEvidence: WorkflowRunnerAuthorityEvidence | undefined;
    if (names.has('source-evidence.json')) {
      sourceEvidence = exactJson(
        await read('source-evidence.json'),
        'Source evidence',
      ) as WorkflowRunnerAuthorityEvidence;
      try {
        hashWorkflowRunnerAuthorityBindingEvidence(sourceEvidence, stage.operation);
      } catch (error) {
        return fail(
          'WORKFLOW_RUNNER_AUTHORITY_BINDING_JOURNAL_CORRUPT',
          'Source evidence is invalid.',
          error,
        );
      }
    }
    let resolution: WorkflowRunnerAuthorityBindingResolution | undefined;
    if (names.has('resolution.json')) {
      try {
        resolution = parseWorkflowRunnerAuthorityBindingResolutionBytes(
          Buffer.from(await read('resolution.json'), 'utf8'),
        );
      } catch (error) {
        return fail(
          'WORKFLOW_RUNNER_AUTHORITY_BINDING_JOURNAL_CORRUPT',
          'Authority-binding resolution slot is invalid.',
          error,
        );
      }
    }
    let budgetSourceResult: WorkflowRunnerBudgetSourceResult | undefined;
    if (names.has('budget-source-result.json')) {
      if (
        stage.operation !== 'budget_reserve' ||
        !resolution ||
        !rawResolutionReceipt ||
        resolution.evidence.schema !== 'openslack.workflow_runner_budget_authority_evidence.v1'
      ) {
        return fail(
          'WORKFLOW_RUNNER_AUTHORITY_BINDING_JOURNAL_CORRUPT',
          'Budget source result is not contiguous with an accepted reserve resolution.',
        );
      }
      try {
        budgetSourceResult = validateWorkflowRunnerBudgetSourceResult(
          exactJson(await read('budget-source-result.json'), 'Budget source result'),
          resolution.evidence.preparedRequest,
        );
      } catch (error) {
        return fail(
          'WORKFLOW_RUNNER_AUTHORITY_BINDING_JOURNAL_CORRUPT',
          'Budget source result is not bound to the exact prepared reserve.',
          error,
        );
      }
    }
    if (
      (rawStageReceipt && rawStageReceipt.bindingId !== stage.bindingId) ||
      (sourceEvidence && !rawStageReceipt) ||
      (resolution && (!sourceEvidence || !rawStageReceipt)) ||
      (rawResolutionReceipt && !resolution)
    ) {
      return fail(
        'WORKFLOW_RUNNER_AUTHORITY_BINDING_JOURNAL_CORRUPT',
        'Authority-binding journal slots are non-contiguous or cross-spliced.',
      );
    }
    type MutableControlEntry = {
      companionSequence: number;
      message?: WorkflowControlAuthorityMessage;
      budgetSourceResult?: WorkflowRunnerBudgetSourceResult;
      receipt?: WorkflowRunnerAuthorityControlDeliveryReceipt;
      confirmedReceipt?: WorkflowRunnerAuthorityControlDeliveryReceipt;
    };
    const controls = new Map<number, MutableControlEntry>();
    for (const name of names) {
      const match = CONTROL_FILE.exec(name);
      if (!match) continue;
      const kind = match[1]!;
      const sequence = Number(match[2]);
      if (sequence !== 3 && sequence !== 4) {
        return fail(
          'WORKFLOW_RUNNER_AUTHORITY_BINDING_JOURNAL_CORRUPT',
          'Control-delivery journal contains an illegal companion sequence.',
        );
      }
      const item = controls.get(sequence) ?? { companionSequence: sequence };
      const bytes = await read(name);
      if (kind === 'message') item.message = controlMessage(bytes, name);
      else if (kind === 'budget-source-result') {
        item.budgetSourceResult = exactJson(bytes, name) as WorkflowRunnerBudgetSourceResult;
      } else {
        const parsed = receipt(bytes, name);
        if (parsed.phase !== 'control_delivery' || parsed.companionSequence !== sequence) {
          return fail(
            'WORKFLOW_RUNNER_AUTHORITY_BINDING_JOURNAL_CORRUPT',
            'Control-delivery receipt phase or sequence drifted.',
          );
        }
        if (kind === 'receipt') item.receipt = parsed;
        else item.confirmedReceipt = parsed;
      }
      controls.set(sequence, item);
    }
    const controlDeliveries = [...controls.values()]
      .sort((left, right) => left.companionSequence! - right.companionSequence!)
      .map((item) => {
        if (
          !item.message ||
          (item.receipt && item.receipt.controlEventId !== item.message.eventId) ||
          (item.confirmedReceipt &&
            (!item.receipt || canonical(item.confirmedReceipt) !== canonical(item.receipt)))
        ) {
          return fail(
            'WORKFLOW_RUNNER_AUTHORITY_BINDING_JOURNAL_CORRUPT',
            'Control-delivery journal slots are incomplete or cross-spliced.',
          );
        }
        if (
          (item.budgetSourceResult !== undefined && item.message.kind !== 'budget_authorization') ||
          (item.receipt !== undefined &&
            item.message.kind === 'budget_authorization' &&
            item.budgetSourceResult === undefined)
        ) {
          return fail(
            'WORKFLOW_RUNNER_AUTHORITY_BINDING_JOURNAL_CORRUPT',
            'Budget source result is missing or attached to the wrong control kind.',
          );
        }
        return Object.freeze(item as WorkflowRunnerAuthorityControlDeliveryJournalEntry);
      });
    if (controlDeliveries.some((delivery, index) => delivery.companionSequence !== index + 3)) {
      return fail(
        'WORKFLOW_RUNNER_AUTHORITY_BINDING_JOURNAL_CORRUPT',
        'Control-delivery journal contains a sequence hole.',
      );
    }
    if (controlDeliveries.length > 0 && !rawResolutionReceipt) {
      return fail(
        'WORKFLOW_RUNNER_AUTHORITY_BINDING_JOURNAL_CORRUPT',
        'Control delivery exists before an accepted authority resolution.',
      );
    }
    let validatedStageReceipt: WorkflowRunnerAuthorityStageReceipt | undefined;
    let validatedResolution: WorkflowRunnerAuthorityBindingResolution | undefined;
    let validatedResolutionReceipt: WorkflowRunnerAuthorityResolutionReceipt | undefined;
    try {
      if (rawStageReceipt) {
        validatedStageReceipt = validateWorkflowRunnerAuthorityBindingStageReceipt(
          rawStageReceipt,
          stage,
        );
      }
      if (resolution) {
        validatedResolution = validateWorkflowRunnerAuthorityBindingResolutionForStage(
          resolution,
          stage,
          validatedStageReceipt,
        );
        if (!sourceEvidence || !exactEqual(sourceEvidence, validatedResolution.evidence)) {
          return fail(
            'WORKFLOW_RUNNER_AUTHORITY_BINDING_JOURNAL_CONFLICT',
            'Durable source evidence differs from the contextual resolution.',
          );
        }
      }
      if (rawResolutionReceipt) {
        validatedResolutionReceipt = validateWorkflowRunnerAuthorityBindingResolutionReceipt(
          rawResolutionReceipt,
          validatedResolution,
          stage,
          validatedStageReceipt,
        );
      }
      let priorEventDelivery: unknown = null;
      for (const delivery of controlDeliveries) {
        if (!delivery.receipt) continue;
        const validated = validateWorkflowRunnerAuthorityControlDeliveryReceiptForMessage(
          delivery.receipt,
          delivery.message,
          {
            stage,
            stageReceipt: validatedStageReceipt,
            resolution: validatedResolution,
            resolutionReceipt: validatedResolutionReceipt,
            priorEventDelivery,
            ...(delivery.budgetSourceResult === undefined
              ? {}
              : { budgetSourceResult: delivery.budgetSourceResult }),
          },
        );
        if (!exactEqual(validated, delivery.receipt)) {
          return fail(
            'WORKFLOW_RUNNER_AUTHORITY_BINDING_JOURNAL_CONFLICT',
            'Control-delivery receipt changed during contextual validation.',
          );
        }
        if (delivery.confirmedReceipt) {
          priorEventDelivery = { message: delivery.message, receipt: delivery.confirmedReceipt };
        }
      }
    } catch (error) {
      if (error instanceof WorkflowRunnerAuthorityBindingJournalError) throw error;
      return fail(
        'WORKFLOW_RUNNER_AUTHORITY_BINDING_JOURNAL_CORRUPT',
        'Authority-binding journal failed full frozen contextual validation.',
        error,
      );
    }
    const entry = Object.freeze({
      stage,
      ...(validatedStageReceipt ? { stageReceipt: validatedStageReceipt } : {}),
      ...(sourceEvidence ? { sourceEvidence } : {}),
      ...(validatedResolution ? { resolution: validatedResolution } : {}),
      ...(validatedResolutionReceipt ? { resolutionReceipt: validatedResolutionReceipt } : {}),
      ...(budgetSourceResult ? { budgetSourceResult } : {}),
      controlDeliveries: Object.freeze(controlDeliveries),
    });
    this.#entryCache.set(expectedName, { parent, identity, entry });
    return entry;
  }

  #indexActive(entry: Pick<WorkflowRunnerAuthorityBindingJournalEntry, 'stage'>): void {
    const name = bindingDirectoryName(entry.stage.bindingId);
    const bindings = this.#activeByRun.get(entry.stage.runId) ?? new Set<string>();
    bindings.add(name);
    this.#activeByRun.set(entry.stage.runId, bindings);
  }

  #unindexActive(entry: Pick<WorkflowRunnerAuthorityBindingJournalEntry, 'stage'>): void {
    const bindings = this.#activeByRun.get(entry.stage.runId);
    if (!bindings) return;
    bindings.delete(bindingDirectoryName(entry.stage.bindingId));
    if (bindings.size === 0) this.#activeByRun.delete(entry.stage.runId);
  }

  async #archiveClosed(entry: WorkflowRunnerAuthorityBindingJournalEntry): Promise<void> {
    const { active, closed } = this.#paths();
    const name = bindingDirectoryName(entry.stage.bindingId);
    const source = join(active, name);
    const destination = join(closed, name);
    if (!(await present(source))) return;
    if (await present(destination)) {
      return fail(
        'WORKFLOW_RUNNER_AUTHORITY_BINDING_JOURNAL_CONFLICT',
        'Authority-binding journal contains the same binding in both partitions.',
      );
    }
    await rename(source, destination);
    await syncDirectory(active);
    await syncDirectory(closed);
    this.#entryCache.delete(name);
    this.#unindexActive(entry);
    this.#activeDirectoryIdentity = await this.#pathIdentity(active);
  }

  async #refreshActiveIndexIfDrifted(): Promise<void> {
    const { active } = this.#paths();
    const identity = await this.#pathIdentity(active);
    if (identity !== this.#activeDirectoryIdentity) await this.#refreshActiveIndex(true);
  }

  async #refreshActiveIndex(force = false): Promise<void> {
    const { active } = this.#paths();
    const identity = await this.#pathIdentity(active);
    if (!force && identity === this.#activeDirectoryIdentity) return;
    await this.list();
  }

  #invalidateDirectory(directory: string): void {
    for (const [name, cached] of this.#entryCache) {
      if (join(cached.parent, name) === directory) this.#entryCache.delete(name);
    }
  }

  async #pathIdentity(path: string): Promise<string> {
    const stat = await lstat(path);
    return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.mode].join(':');
  }
}
