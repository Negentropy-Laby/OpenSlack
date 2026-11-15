import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, unlink, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type {
  ProviderAttemptPort,
  ProviderAttemptReservation,
  ProviderUsageReceipt,
} from '@openslack/agent-runtime';
import {
  assertProviderUsageReceipt,
  buildProviderUsageIdentityHashes,
} from '@openslack/agent-runtime';
import {
  bindProviderSendAdmission,
  bindProviderSendPreparation,
  providerUsageRequestHash,
  type ProviderSendRequest,
} from '@openslack/agent-runtime/internal/provider-send-admission';
import { readWorkflowEvidenceText, assertWorkflowEvidencePath } from './workflow-evidence-file.js';
import { createWorkflowRunnerDescriptorPathSecurity } from '../workflow-runner-descriptor-store.js';
import { parseWorkflowEffectJson } from '../workflow-effect-json.js';
import {
  canonicalWorkflowControlAuthorityJson as canonical,
  type WorkflowControlAuthorityRoute,
} from '../workflow-control-authority-contract.js';
import type { WorkflowControlAuthorityPort } from '../workflow-control-authority-client.js';
import { closedDataRecord as assertClosed } from './contract-validation.js';
import { types as nodeTypes } from 'node:util';

import { WORKFLOW_SEND_LIMITS, WORKFLOW_SEND_MAIN_CHAIN } from './workflow-send-policy.js';
export const SEND_LIMITS = WORKFLOW_SEND_LIMITS;
const MAX_BYTES = 64 * 1024;
const HASH = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const NOFOLLOW = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export interface SendCampaignBinding {
  readonly schema: 'openslack.workflow_send_campaign.v1';
  readonly campaignId: string;
  readonly candidate: string;
  readonly workflowSourceHash: string;
  readonly workerHash: string;
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  readonly runId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly route: WorkflowControlAuthorityRoute;
  readonly limits: typeof SEND_LIMITS;
}
type Purpose = 'initial' | 'resume' | 'preflight' | 'replacement';
type Fact =
  | {
      kind: 'slot';
      id: string;
      purpose: Purpose;
      providerRunId: string;
      providerAttempt: string;
      replacementOf?: string;
    }
  | { kind: 'reserved'; id: string; reservation: ProviderAttemptReservation }
  | {
      kind: 'admitted';
      id: string;
      requestHash: string;
      providerRequestHash: string;
      constraintHash: string;
    }
  | { kind: 'refused'; id: string; reason: 'total_token_unverified' }
  | { kind: 'response'; id: string; receiptHash: string; totalTokens: string | null }
  | {
      kind: 'settled';
      id: string;
      receiptHash: string;
      totalTokens: number;
      outcome: 'reported' | 'failed';
      goReceiptHash: string;
      goRequestHash: string;
    }
  | { kind: 'not_sent'; id: string }
  | { kind: 'cache'; id: string; cacheKeyHash: string; resultHash: string };
interface Entry {
  sequence: number;
  previousHash: string;
  fact: Fact;
  hash: string;
}
interface State {
  binding: SendCampaignBinding;
  bindingHash: string;
  entries: Entry[];
}
export interface WorkflowSendGoFrontier {
  reservedCalls: string;
  settledCalls: string;
  settledTokens: string;
}
export async function assertWorkflowSendGoFrontier(
  root: string,
  runId: string,
  bindingHash: string,
  readGo: () => Promise<WorkflowSendGoFrontier>,
): Promise<void> {
  const state = await readWorkflowSendCampaign(root, runId, bindingHash);
  const go = await readGo();
  if (Object.values(go).some((v) => typeof v !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(v)))
    return deny('SEND_ADMISSION_FROZEN');
  const reserved = state.entries.filter((e) => e.fact.kind === 'reserved').length;
  const settled = state.entries.flatMap((e) => (e.fact.kind === 'settled' ? [e.fact] : []));
  if (
    BigInt(go.reservedCalls) !== BigInt(reserved) ||
    BigInt(go.settledCalls) !== BigInt(settled.length) ||
    BigInt(go.settledTokens) !== settled.reduce((n, e) => n + BigInt(e.totalTokens), 0n)
  )
    return deny('SEND_ADMISSION_FROZEN');
}
export const WORKFLOW_SEND_ADMISSION_CODES = Object.freeze([
  'SEND_ADMISSION_INVALID',
  'SEND_ADMISSION_BUSY',
  'SEND_ADMISSION_FROZEN',
  'SEND_ADMISSION_LIMIT',
  'SEND_TOTAL_TOKEN_UNVERIFIED',
  'SEND_ADMISSION_INDETERMINATE',
] as const);
export class WorkflowSendAdmissionError extends Error {
  constructor(readonly code: (typeof WORKFLOW_SEND_ADMISSION_CODES)[number]) {
    super(code);
    this.name = 'WorkflowSendAdmissionError';
  }
}
const deny = (code: ConstructorParameters<typeof WorkflowSendAdmissionError>[0]): never => {
  throw new WorkflowSendAdmissionError(code);
};
function closedDataRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || nodeTypes.isProxy(value))
    return deny('SEND_ADMISSION_INVALID');
  const keys = Reflect.ownKeys(value);
  if (keys.some((k) => typeof k !== 'string')) return deny('SEND_ADMISSION_INVALID');
  const invalid = () => deny('SEND_ADMISSION_INVALID');
  return assertClosed(value, keys as string[], 'send-admission', {
    inert: invalid,
    missing: invalid,
    unknown: invalid,
    dataField: invalid,
  });
}
function binding(value: unknown): SendCampaignBinding {
  const v = closedDataRecord(value);
  const keys = [
    'schema',
    'campaignId',
    'candidate',
    'workflowSourceHash',
    'workerHash',
    'workspaceId',
    'workspaceRoot',
    'runId',
    'providerId',
    'modelId',
    'route',
    'limits',
  ];
  if (Object.keys(v).length !== keys.length || keys.some((k) => !Object.hasOwn(v, k)))
    return deny('SEND_ADMISSION_INVALID');
  const limits = closedDataRecord(v.limits);
  if (
    v.schema !== 'openslack.workflow_send_campaign.v1' ||
    !['campaignId', 'workspaceId', 'runId', 'providerId', 'modelId'].every(
      (k) => typeof v[k] === 'string' && ID.test(v[k] as string),
    ) ||
    typeof v.candidate !== 'string' ||
    !/^[a-f0-9]{40}$/u.test(v.candidate) ||
    !['workflowSourceHash', 'workerHash'].every(
      (k) => typeof v[k] === 'string' && HASH.test(v[k] as string),
    ) ||
    typeof v.workspaceRoot !== 'string' ||
    v.workspaceRoot.includes('\0') ||
    resolve(v.workspaceRoot) !== v.workspaceRoot ||
    Object.keys(limits).length !== 3 ||
    Object.entries(SEND_LIMITS).some(([k, n]) => limits[k] !== n)
  )
    return deny('SEND_ADMISSION_INVALID');
  const r = closedDataRecord(v.route);
  if (
    Object.keys(r).length !== 4 ||
    r.backend !== 'go' ||
    r.authority !== 'workflow-control' ||
    !Number.isSafeInteger(r.routingEpoch) ||
    Number(r.routingEpoch) < 1 ||
    typeof r.authorityBuildHash !== 'string' ||
    !HASH.test(r.authorityBuildHash)
  )
    return deny('SEND_ADMISSION_INVALID');
  return structuredClone(v) as unknown as SendCampaignBinding;
}
function location(root: string, runId: string): string {
  if (!ID.test(runId) || resolve(root) !== root) return deny('SEND_ADMISSION_INVALID');
  return join(root, '.openslack.local', 'workflows', 'send-admission', hash(runId));
}
let pathSecurity: ReturnType<typeof createWorkflowRunnerDescriptorPathSecurity> | undefined;
const security = () => (pathSecurity ??= createWorkflowRunnerDescriptorPathSecurity());
async function privatePath(path: string, directory: boolean): Promise<void> {
  await assertWorkflowEvidencePath(path);
  const s = await lstat(path, { bigint: true });
  if (!directory && s.nlink !== 1n) return deny('SEND_ADMISSION_INVALID');
  await security().assertOwnerOnly(path, directory, s);
}
async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return; // Windows publication uses FlushFileBuffers on the file.
  const fd = await open(path, constants.O_RDONLY | NOFOLLOW);
  try {
    await fd.sync();
  } finally {
    await fd.close();
  }
}
/** Explicit host registration only. Existing Go runs and directories cannot regain allowance. */
export async function registerWorkflowSendCampaign(
  value: SendCampaignBinding,
  authority: Pick<WorkflowControlAuthorityPort, 'readIfExists'>,
): Promise<string> {
  const b = binding(value);
  if (
    (await realpath(b.workspaceRoot)) !== b.workspaceRoot ||
    (await authority.readIfExists(b.runId, b.route)) !== null
  )
    return deny('SEND_ADMISSION_INVALID');
  const path = location(b.workspaceRoot, b.runId);
  const parent = dirname(path);
  // Harden only directories this call creates; never repair existing history or ACLs.
  let current = b.workspaceRoot;
  for (const part of ['.openslack.local', 'workflows', 'send-admission']) {
    current = join(current, part);
    try {
      await mkdir(current, { mode: 0o700 });
      await security().harden(current, true);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    await privatePath(current, true);
  }
  await mkdir(path, { mode: 0o700 });
  await security().harden(path, true);
  await mkdir(join(path, 'facts'), { mode: 0o700 });
  await security().harden(join(path, 'facts'), true);
  // A failure leaves the exclusive directory as an uncertainty tombstone.
  if ((await authority.readIfExists(b.runId, b.route)) !== null)
    return deny('SEND_ADMISSION_INVALID');
  const fd = await open(
    join(path, 'journal.jsonl'),
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
    0o600,
  );
  try {
    await security().harden(join(path, 'journal.jsonl'), false);
    await fd.writeFile(canonical({ binding: b, bindingHash: hash(b) }) + '\n');
    await fd.sync();
  } finally {
    await fd.close();
  }
  await syncDirectory(path);
  await syncDirectory(parent);
  return hash(b);
}
function inspect(state: State): Map<string, Fact[]> {
  const attempts = new Map<string, Fact[]>();
  let previous = state.bindingHash,
    total = 0;
  let frozen = false;
  const main = new Set<string>();
  const replacements = new Set<string>();
  for (const [index, e] of state.entries.entries()) {
    const raw = closedDataRecord(e);
    if (Object.keys(raw).sort().join(',') !== 'fact,hash,previousHash,sequence')
      return deny('SEND_ADMISSION_INVALID');
    if (
      e.sequence !== index + 1 ||
      e.previousHash !== previous ||
      e.hash !== hash({ sequence: e.sequence, previousHash: e.previousHash, fact: e.fact })
    )
      return deny('SEND_ADMISSION_INVALID');
    previous = e.hash;
    const f = closedDataRecord(e.fact) as unknown as Fact;
    if (typeof f.id !== 'string' || !ID.test(f.id)) return deny('SEND_ADMISSION_INVALID');
    const chain = attempts.get(f.id);
    const fields: Record<Fact['kind'], string[]> = {
      slot: ['kind', 'id', 'purpose', 'providerRunId', 'providerAttempt'],
      reserved: ['kind', 'id', 'reservation'],
      admitted: ['kind', 'id', 'requestHash', 'providerRequestHash', 'constraintHash'],
      refused: ['kind', 'id', 'reason'],
      response: ['kind', 'id', 'receiptHash', 'totalTokens'],
      settled: [
        'kind',
        'id',
        'receiptHash',
        'totalTokens',
        'outcome',
        'goReceiptHash',
        'goRequestHash',
      ],
      not_sent: ['kind', 'id'],
      cache: ['kind', 'id', 'cacheKeyHash', 'resultHash'],
    };
    if (
      !Object.hasOwn(fields, f.kind) ||
      Object.keys(f).sort().join(',') !==
        [
          ...fields[f.kind],
          ...(f.kind === 'slot' && Object.hasOwn(f, 'replacementOf') ? ['replacementOf'] : []),
        ]
          .sort()
          .join(',')
    )
      return deny('SEND_ADMISSION_INVALID');
    if (f.kind === 'slot') {
      if (f.purpose === 'replacement') {
        if (
          typeof f.replacementOf !== 'string' ||
          attempts.get(f.replacementOf)?.at(-1)?.kind !== 'not_sent' ||
          replacements.has(f.replacementOf)
        )
          return deny('SEND_ADMISSION_INVALID');
        replacements.add(f.replacementOf);
      } else if (f.replacementOf !== undefined) return deny('SEND_ADMISSION_INVALID');
      if (
        frozen ||
        chain ||
        attempts.size >= SEND_LIMITS.attempts ||
        !['initial', 'resume', 'preflight', 'replacement'].includes(f.purpose) ||
        !ID.test(f.providerRunId) ||
        !ID.test(f.providerAttempt)
      )
        return deny('SEND_ADMISSION_INVALID');
      if (f.purpose === 'initial' || f.purpose === 'resume') {
        if (main.has(f.purpose)) return deny('SEND_ADMISSION_INVALID');
        main.add(f.purpose);
      } else if (
        attempts.size + 1 + (WORKFLOW_SEND_MAIN_CHAIN.length - main.size) >
        SEND_LIMITS.attempts
      )
        return deny('SEND_ADMISSION_INVALID');
      attempts.set(f.id, [f]);
      frozen = true;
    } else {
      if (!chain) return deny('SEND_ADMISSION_INVALID');
      const last = chain.at(-1)!;
      if (f.kind === 'reserved') {
        const r = closedDataRecord(f.reservation);
        if (
          last.kind !== 'slot' ||
          Object.keys(r).length !== 3 ||
          typeof r.reservationId !== 'string' ||
          !ID.test(r.reservationId) ||
          typeof r.callId !== 'string' ||
          !ID.test(r.callId) ||
          typeof r.authorizedTokens !== 'string' ||
          !/^[1-9][0-9]*$/u.test(r.authorizedTokens) ||
          BigInt(r.authorizedTokens) > BigInt(SEND_LIMITS.tokensPerAttempt)
        )
          return deny('SEND_ADMISSION_INVALID');
      } else if (f.kind === 'refused') {
        if (last.kind !== 'reserved' || f.reason !== 'total_token_unverified')
          return deny('SEND_ADMISSION_INVALID');
      } else if (f.kind === 'admitted') {
        if (
          last.kind !== 'reserved' ||
          !HASH.test(f.requestHash) ||
          !HASH.test(f.providerRequestHash) ||
          !HASH.test(f.constraintHash)
        )
          return deny('SEND_ADMISSION_INVALID');
      } else if (f.kind === 'response') {
        if (
          last.kind !== 'admitted' ||
          !HASH.test(f.receiptHash) ||
          (f.totalTokens !== null &&
            (typeof f.totalTokens !== 'string' ||
              f.totalTokens.length > 32 ||
              !/^(0|[1-9][0-9]*)$/u.test(f.totalTokens)))
        )
          return deny('SEND_ADMISSION_INVALID');
      } else if (f.kind === 'settled') {
        if (
          last.kind !== 'response' ||
          last.receiptHash !== f.receiptHash ||
          last.totalTokens !== String(f.totalTokens) ||
          !HASH.test(f.goReceiptHash) ||
          !HASH.test(f.goRequestHash) ||
          !HASH.test(f.receiptHash) ||
          !Number.isSafeInteger(f.totalTokens) ||
          f.totalTokens < 0 ||
          !['reported', 'failed'].includes(f.outcome)
        )
          return deny('SEND_ADMISSION_INVALID');
        total += f.totalTokens;
        frozen = f.totalTokens > SEND_LIMITS.tokensPerAttempt || total > SEND_LIMITS.totalTokens;
      } else if (f.kind === 'cache') {
        if (last.kind !== 'settled' || !HASH.test(f.cacheKeyHash) || !HASH.test(f.resultHash))
          return deny('SEND_ADMISSION_INVALID');
      } else if (f.kind === 'not_sent') {
        // Only a slot with no possible Go reservation may be confirmed not sent.
        if (last.kind !== 'slot') return deny('SEND_ADMISSION_INVALID');
        frozen = false;
      } else return deny('SEND_ADMISSION_INVALID');
      chain.push(f);
    }
  }
  return attempts;
}
async function read(root: string, runId: string, expected: string): Promise<State> {
  const path = location(root, runId);
  await privatePath(path, true);
  await privatePath(join(path, 'journal.jsonl'), false);
  const directoryBefore = await lstat(path, { bigint: true });
  if (
    (await readdir(path))
      .filter((n) => n !== 'owner.lock')
      .sort()
      .join(',') !== 'facts,journal.jsonl'
  )
    return deny('SEND_ADMISSION_INVALID');
  const bytes = await readWorkflowEvidenceText(
    join(path, 'journal.jsonl'),
    MAX_BYTES,
    { scope: 'run', runId },
    { requireSingleLink: true },
  );
  if (!bytes.endsWith('\n')) return deny('SEND_ADMISSION_INVALID');
  const lines = bytes.slice(0, -1).split('\n');
  const first = closedDataRecord(parseWorkflowEffectJson(Buffer.from(lines.shift()!)));
  const b = binding(first.binding);
  if (
    Object.keys(first).length !== 2 ||
    first.bindingHash !== hash(b) ||
    first.bindingHash !== expected ||
    b.runId !== runId ||
    b.workspaceRoot !== root
  )
    return deny('SEND_ADMISSION_INVALID');
  const state = {
    binding: b,
    bindingHash: expected,
    entries: lines.map((l) => parseWorkflowEffectJson(Buffer.from(l)) as unknown as Entry),
  };
  inspect(state);
  await privatePath(join(path, 'facts'), true);
  const names = (await readdir(join(path, 'facts'))).sort();
  const expectedNames = state.entries
    .map((e) => `${String(e.sequence).padStart(3, '0')}.${e.hash}.json`)
    .sort();
  if (canonical(names) !== canonical(expectedNames)) return deny('SEND_ADMISSION_INVALID');
  for (const e of state.entries) {
    const factPath = join(path, 'facts', `${String(e.sequence).padStart(3, '0')}.${e.hash}.json`);
    await privatePath(factPath, false);
    if (
      (await readWorkflowEvidenceText(
        factPath,
        MAX_BYTES,
        { scope: 'run', runId },
        { requireSingleLink: true },
      )) !==
      canonical(e) + '\n'
    )
      return deny('SEND_ADMISSION_INVALID');
  }
  const directoryAfter = await lstat(path, { bigint: true });
  if (directoryBefore.dev !== directoryAfter.dev || directoryBefore.ino !== directoryAfter.ino)
    return deny('SEND_ADMISSION_INVALID');
  await privatePath(path, true);
  return state;
}
/** No creation, repair, lock stealing, or replay is performed by a worker. */
export async function readWorkflowSendCampaign(
  root: string,
  runId: string,
  expected: string,
): Promise<Readonly<State>> {
  try {
    await lstat(join(location(root, runId), 'owner.lock'));
    return deny('SEND_ADMISSION_BUSY');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const state = await read(root, runId, expected);
  try {
    await lstat(join(location(root, runId), 'owner.lock'));
    return deny('SEND_ADMISSION_BUSY');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  return state;
}
async function append(root: string, runId: string, expected: string, fact: Fact): Promise<void> {
  const path = location(root, runId);
  await privatePath(path, true);
  const lockPath = join(path, 'owner.lock');
  let lock;
  try {
    lock = await open(
      lockPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NOFOLLOW,
      0o600,
    );
  } catch {
    return deny('SEND_ADMISSION_BUSY');
  }
  let touched = false;
  try {
    await security().harden(lockPath, false);
    if ((await lock.stat({ bigint: true })).nlink !== 1n) return deny('SEND_ADMISSION_INVALID');
    const state = await read(root, runId, expected);
    const entry = {
      sequence: state.entries.length + 1,
      previousHash: state.entries.at(-1)?.hash ?? expected,
      fact,
    };
    const complete = { ...entry, hash: hash(entry) };
    inspect({ ...state, entries: [...state.entries, complete] });
    const factPath = join(
      path,
      'facts',
      `${String(complete.sequence).padStart(3, '0')}.${complete.hash}.json`,
    );
    // Immutable members independently detect a truncated but syntactically valid
    // journal prefix. An orphan member is uncertainty, never repaired on read.
    touched = true;
    const factFd = await open(
      factPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NOFOLLOW,
      0o600,
    );
    try {
      await security().harden(factPath, false);
      await factFd.writeFile(canonical(complete) + '\n');
      await factFd.sync();
    } finally {
      await factFd.close();
    }
    await syncDirectory(join(path, 'facts'));
    const target = join(path, 'journal.jsonl');
    const prior = await lstat(target, { bigint: true });
    const fd = await open(target, constants.O_WRONLY | constants.O_APPEND | NOFOLLOW);
    try {
      const before = await fd.stat({ bigint: true });
      if (
        before.ino !== prior.ino ||
        before.dev !== prior.dev ||
        before.nlink !== 1n ||
        before.size + BigInt(Buffer.byteLength(canonical(complete)) + 1) > BigInt(MAX_BYTES)
      )
        return deny('SEND_ADMISSION_INVALID');
      touched = true;
      await fd.writeFile(canonical(complete) + '\n');
      await fd.sync();
      const current = await lstat(target, { bigint: true });
      if (current.ino !== before.ino || current.dev !== before.dev || current.nlink !== 1n)
        return deny('SEND_ADMISSION_INDETERMINATE');
      await read(root, runId, expected);
    } finally {
      await fd.close();
    }
    touched = false;
  } catch (e) {
    if (touched) return deny('SEND_ADMISSION_INDETERMINATE');
    throw e;
  } finally {
    try {
      if (!touched) {
        const current = await lstat(lockPath, { bigint: true });
        const owned = await lock.stat({ bigint: true });
        if (
          current.ino !== owned.ino ||
          current.dev !== owned.dev ||
          current.nlink !== 1n ||
          owned.nlink !== 1n
        )
          return deny('SEND_ADMISSION_INDETERMINATE');
        await unlink(lockPath);
      }
    } finally {
      await lock.close();
    }
  }
}

/** No reviewed provider/model currently offers a verified <=8192 total-token cap.
 * Output-only max_tokens and caller-provided assertions never satisfy this check.
 * Adding a production contract requires a source-reviewed, provider-specific implementation. */
/** Content-only evidence; this function never admits a send. */
export function workflowSendRequestEvidence(requestBytes: string): {
  requestHash: string;
  providerRequestHash: string;
} {
  return {
    requestHash: createHash('sha256').update(requestBytes).digest('hex'),
    providerRequestHash: providerUsageRequestHash(requestBytes).slice('sha256:'.length),
  };
}

function totalConstraint(
  _request: ProviderSendRequest,
  _reservation: ProviderAttemptReservation,
): { constraintHash: string } {
  return deny('SEND_TOTAL_TOKEN_UNVERIFIED');
}

export async function createWorkflowSendAdmissionPort(input: {
  root: string;
  bindingHash: string;
  runId: string;
  workspaceId: string;
  sourceHash: string;
  workerHash: string;
  route: WorkflowControlAuthorityRoute;
  purpose: Purpose;
  replacementOf?: string;
  go: ProviderAttemptPort;
  goFrontier: () => Promise<WorkflowSendGoFrontier>;
  readGoSettlement: (
    reservation: ProviderAttemptReservation,
  ) => Promise<{ receiptHash: string; requestHash: string } | null>;
  noOpenGoReservations: () => Promise<boolean>;
  isDefiniteGoRejection: (error: unknown) => boolean;
}): Promise<ProviderAttemptPort> {
  const initial = await readWorkflowSendCampaign(input.root, input.runId, input.bindingHash);
  const b = initial.binding;
  if (
    b.workspaceId !== input.workspaceId ||
    b.workflowSourceHash !== input.sourceHash ||
    b.workerHash !== input.workerHash ||
    canonical(b.route) !== canonical(input.route)
  )
    return deny('SEND_ADMISSION_INVALID');
  const owned = new Map<ProviderAttemptReservation, string>();
  const settlements = new Map<
    ProviderAttemptReservation,
    { receiptHash: string; result: Promise<void> }
  >();
  const port: ProviderAttemptPort = {
    async reserve(request) {
      await assertWorkflowSendGoFrontier(
        input.root,
        input.runId,
        input.bindingHash,
        input.goFrontier,
      );
      const s = await readWorkflowSendCampaign(input.root, input.runId, input.bindingHash);
      const attempts = inspect(s);
      const last = [...attempts.values()].at(-1)?.at(-1);
      if (last && last.kind !== 'settled' && last.kind !== 'not_sent' && last.kind !== 'cache')
        return deny('SEND_ADMISSION_FROZEN');
      if (
        [...attempts.values()].some((a) =>
          a.some((f) => f.kind === 'settled' && f.totalTokens > SEND_LIMITS.tokensPerAttempt),
        )
      )
        return deny('SEND_ADMISSION_FROZEN');
      if (attempts.size >= SEND_LIMITS.attempts) return deny('SEND_ADMISSION_LIMIT');
      if (
        request.providerId !== b.providerId ||
        request.modelId !== b.modelId ||
        !/^[1-9][0-9]*$/u.test(request.requestedTokens) ||
        BigInt(request.requestedTokens) > BigInt(SEND_LIMITS.tokensPerAttempt)
      )
        return deny('SEND_ADMISSION_INVALID');
      // An unresolved slot is deliberately retained even if Go's response is lost.
      const id = `attempt-${attempts.size + 1}`;
      await append(input.root, input.runId, input.bindingHash, {
        kind: 'slot',
        id,
        purpose: input.purpose,
        providerRunId: request.providerRunId,
        providerAttempt: request.providerAttempt,
        ...(input.replacementOf === undefined ? {} : { replacementOf: input.replacementOf }),
      });
      let reservation: ProviderAttemptReservation;
      try {
        reservation = await input.go.reserve(request);
      } catch (e) {
        // This host has not entered transport. A fresh canonical Go account
        // must independently prove that no reservation is left open.
        if (input.isDefiniteGoRejection(e) && (await input.noOpenGoReservations()))
          await append(input.root, input.runId, input.bindingHash, { kind: 'not_sent', id });
        throw e;
      }
      await append(input.root, input.runId, input.bindingHash, {
        kind: 'reserved',
        id,
        reservation,
      });
      owned.set(reservation, id);
      return reservation;
    },
    async settle(reservation, usage: ProviderUsageReceipt) {
      assertProviderUsageReceipt(usage);
      const receiptHash = hash(usage);
      const repeated = settlements.get(reservation);
      if (repeated) {
        if (repeated.receiptHash !== receiptHash) return deny('SEND_ADMISSION_INVALID');
        return repeated.result;
      }
      const result = (async () => {
        const id = owned.get(reservation);
        if (!id) return deny('SEND_ADMISSION_INVALID');
        const state = await readWorkflowSendCampaign(input.root, input.runId, input.bindingHash);
        const chain = inspect(state).get(id)!;
        const prior = chain.at(-1)!;
        if (prior.kind === 'settled' || prior.kind === 'cache') {
          const settled = chain.find(
            (f): f is Extract<Fact, { kind: 'settled' }> => f.kind === 'settled',
          );
          if (settled?.receiptHash !== receiptHash) return deny('SEND_ADMISSION_INVALID');
          return;
        }
        if (prior.kind !== 'admitted') return deny('SEND_ADMISSION_FROZEN');
        const slot = chain[0] as Extract<Fact, { kind: 'slot' }>;
        const identities = buildProviderUsageIdentityHashes(
          b.providerId,
          b.modelId,
          slot.providerRunId,
        );
        if (
          usage.attempt !== slot.providerAttempt ||
          usage.providerHash !== identities.providerHash ||
          usage.modelHash !== identities.modelHash ||
          usage.runHash !== identities.runHash ||
          usage.requestHash !== 'sha256:' + prior.providerRequestHash
        )
          return deny('SEND_ADMISSION_INVALID');
        await append(input.root, input.runId, input.bindingHash, {
          kind: 'response',
          id,
          receiptHash,
          totalTokens:
            usage.totalTokens !== null && usage.totalTokens.length <= 32 ? usage.totalTokens : null,
        });
        await input.go.settle(reservation, usage);
        const proof = await input.readGoSettlement(reservation);
        if (!proof || !HASH.test(proof.receiptHash) || !HASH.test(proof.requestHash))
          return deny('SEND_ADMISSION_FROZEN');
        if (
          usage.status !== 'reported' ||
          typeof usage.totalTokens !== 'string' ||
          !/^(0|[1-9][0-9]*)$/u.test(usage.totalTokens) ||
          BigInt(usage.totalTokens) > BigInt(Number.MAX_SAFE_INTEGER)
        )
          return deny('SEND_ADMISSION_FROZEN');
        await append(input.root, input.runId, input.bindingHash, {
          kind: 'settled',
          id,
          receiptHash,
          totalTokens: Number(usage.totalTokens),
          outcome: 'reported',
          goReceiptHash: proof.receiptHash,
          goRequestHash: proof.requestHash,
        });
      })();
      settlements.set(reservation, { receiptHash, result });
      return result;
    },
  };
  bindProviderSendPreparation(port, async (request) => {
    if (request.providerId !== b.providerId || request.modelId !== b.modelId)
      return deny('SEND_ADMISSION_INVALID');
    request.signal?.throwIfAborted();
    // No enforceable gateway counting/transform/output/physical-attempt
    // contract is bound yet. Refuse without a Go call or campaign append.
    // Final post-reservation admission remains an independent mandatory gate.
    return deny('SEND_TOTAL_TOKEN_UNVERIFIED');
  });
  bindProviderSendAdmission(port, async (reservation, request) => {
    if (
      !owned.has(reservation) ||
      request.providerId !== b.providerId ||
      request.modelId !== b.modelId
    )
      return deny('SEND_ADMISSION_INVALID');
    request.signal?.throwIfAborted();
    await assertWorkflowSendGoFrontier(
      input.root,
      input.runId,
      input.bindingHash,
      input.goFrontier,
    );
    // Failure after reserve leaves an unresolved reservation and a frozen slot.
    // No synthetic zero-usage receipt or test capability can release it.
    let constraint: { constraintHash: string };
    try {
      constraint = totalConstraint(request, reservation);
    } catch (error) {
      await append(input.root, input.runId, input.bindingHash, {
        kind: 'refused',
        id: owned.get(reservation)!,
        reason: 'total_token_unverified',
      });
      throw error;
    }
    await append(input.root, input.runId, input.bindingHash, {
      kind: 'admitted',
      id: owned.get(reservation)!,
      ...workflowSendRequestEvidence(request.requestBytes),
      constraintHash: constraint.constraintHash,
    });
  });
  return Object.freeze(port);
}

/** Cache evidence is scoped to this private run binding, never inferred from a filename. */
export async function checkWorkflowSendCache(
  root: string,
  runId: string,
  bindingHash: string,
  key: string,
  result: unknown,
): Promise<void> {
  const s = await readWorkflowSendCampaign(root, runId, bindingHash);
  const keyHash = hash(key);
  const recorded = s.entries.filter(
    (e) => e.fact.kind === 'cache' && e.fact.cacheKeyHash === keyHash,
  );
  if (result !== null) {
    if (
      recorded.length !== 1 ||
      (recorded[0]!.fact as Extract<Fact, { kind: 'cache' }>).resultHash !== hash(result)
    )
      return deny('SEND_ADMISSION_FROZEN');
    return;
  }
  const purpose = key.startsWith('r-ext-go-qualification:FirstCall:')
    ? 'initial'
    : key.startsWith('r-ext-go-qualification:SecondCall:')
      ? 'resume'
      : undefined;
  if (
    !purpose ||
    recorded.length ||
    s.entries.some((e) => e.fact.kind === 'slot' && e.fact.purpose === purpose)
  )
    return deny('SEND_ADMISSION_FROZEN');
}
export async function recordWorkflowSendCache(
  root: string,
  runId: string,
  bindingHash: string,
  key: string,
  result: unknown,
): Promise<void> {
  const s = await readWorkflowSendCampaign(root, runId, bindingHash);
  const attempts = inspect(s);
  const chain = [...attempts.values()].at(-1);
  const last = chain?.at(-1);
  if (last?.kind !== 'settled') return deny('SEND_ADMISSION_FROZEN');
  await append(root, runId, bindingHash, {
    kind: 'cache',
    id: last.id,
    cacheKeyHash: hash(key),
    resultHash: hash(result),
  });
}
