import { readFile, rm, link, writeFile, readdir } from 'node:fs/promises';
import * as fsPromises from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import {
  testTemporaryDirectory,
  platformTestTimeout,
  testExecutable,
} from '../../../../scripts/testing/process-fixture.mjs';
import {
  registerWorkflowSendCampaign,
  readWorkflowSendCampaign,
  createWorkflowSendAdmissionPort,
  SEND_LIMITS,
  checkWorkflowSendCache,
  workflowSendRequestEvidence,
  type SendCampaignBinding,
} from '../internal/workflow-send-admission.js';
import { buildProviderUsageReceipt } from '@openslack/agent-runtime';
import {
  admitProviderSend,
  prepareProviderSend,
} from '@openslack/agent-runtime/internal/provider-send-admission';
import { canonicalWorkflowControlAuthorityJson as canonical } from '../workflow-control-authority-contract.js';
import { createWorkflowRunnerDescriptorPathSecurity } from '../workflow-runner-descriptor-store.js';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof fsPromises>();
  return { ...actual, open: vi.fn(actual.open) };
});

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  const actual = await vi.importActual<typeof fsPromises>('node:fs/promises');
  vi.mocked(fsPromises.open).mockReset().mockImplementation(actual.open);
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
it(
  'preserves an unconfirmed append lock and does not enter Go or repeat the transaction',
  async () => {
    const { port, go } = await fixture();
    const original = (await vi.importActual<typeof fsPromises>('node:fs/promises')).open;
    let forced = false;
    vi.mocked(fsPromises.open).mockImplementation(async (...args) => {
      const handle = await original(...args);
      if (
        String(args[0]).endsWith('journal.jsonl') &&
        typeof args[1] === 'number' &&
        (args[1] & constants.O_APPEND) !== 0 &&
        !forced
      ) {
        forced = true;
        vi.spyOn(handle, 'sync').mockRejectedValueOnce(new Error('private fsync sentinel'));
      }
      return handle;
    });
    const request = {
      providerId: 'openai-compatible',
      modelId: 'default',
      providerRunId: 'RUN-PHYSICAL',
      providerAttempt: '1',
      requestedTokens: '8192',
    };
    await expect(port.reserve(request)).rejects.toThrow('SEND_ADMISSION_INDETERMINATE');
    expect(forced).toBe(true);
    expect(go.reserve).not.toHaveBeenCalled();
    await expect(port.reserve(request)).rejects.toThrow('SEND_ADMISSION_BUSY');
    expect(go.reserve).not.toHaveBeenCalled();
  },
  platformTestTimeout(5_000),
);
function campaign(root: string): SendCampaignBinding {
  return {
    schema: 'openslack.workflow_send_campaign.v1',
    campaignId: 'campaign.test',
    candidate: '1'.repeat(40),
    workflowSourceHash: '2'.repeat(64),
    workerHash: '3'.repeat(64),
    workspaceId: 'workspace.test',
    workspaceRoot: root,
    runId: 'run.test',
    providerId: 'openai-compatible',
    modelId: 'default',
    route: {
      backend: 'go',
      authority: 'workflow-control',
      routingEpoch: 1,
      authorityBuildHash: '4'.repeat(64),
    },
    limits: SEND_LIMITS,
  };
}
async function fixture(
  proof: () => Promise<{ receiptHash: string; requestHash: string } | null> = async () => null,
) {
  const root = testTemporaryDirectory('send-admission-');
  roots.push(root);
  const b = campaign(root);
  const digest = await registerWorkflowSendCampaign(b, { readIfExists: async () => null });
  const go = {
    reserve: vi.fn(async () =>
      Object.freeze({
        reservationId: 'reservation.one',
        callId: 'call.one',
        authorizedTokens: '8192',
      }),
    ),
    settle: vi.fn(async () => {}),
  };
  const port = await createWorkflowSendAdmissionPort({
    root,
    bindingHash: digest,
    runId: b.runId,
    workspaceId: b.workspaceId,
    sourceHash: b.workflowSourceHash,
    workerHash: b.workerHash,
    route: b.route,
    purpose: 'initial',
    go,
    goFrontier: async () => ({
      reservedCalls: String(go.reserve.mock.calls.length),
      settledCalls: '0',
      settledTokens: '0',
    }),
    readGoSettlement: proof,
    noOpenGoReservations: async () => true,
    isDefiniteGoRejection: () => false,
  });
  return { root, b, digest, go, port };
}
it(
  'admits one of two independent processes without a second Go reservation or transport',
  async () => {
    const { root, b, digest } = await fixture();
    const run = promisify(execFile);
    const path = join(import.meta.dirname, 'workflow-send-admission-child.fixture.ts');
    const results = await Promise.all(
      [0, 1].map(() =>
        run(testExecutable('bun'), [path, JSON.stringify({ root, b, digest })], {
          timeout: platformTestTimeout(3_000),
          windowsHide: true,
          maxBuffer: 16 * 1024,
        }),
      ),
    );
    const outcomes = results.map(
      (r) => JSON.parse(r.stdout.trim()) as { status: string; calls: number },
    );
    expect(outcomes.filter((r) => r.status === 'RESERVED')).toHaveLength(1);
    expect(outcomes.reduce((n, r) => n + r.calls, 0)).toBe(1);
    expect(
      (await readWorkflowSendCampaign(root, b.runId, digest)).entries.map((e) => e.fact.kind),
    ).toEqual(['slot', 'reserved']);
  },
  platformTestTimeout(5_000),
);

// Synthetic fold fixtures never pass the production total-token refusal.
async function seed(
  root: string,
  b: SendCampaignBinding,
  digest: string,
  facts: Record<string, unknown>[],
) {
  const hash = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');
  const directory = join(root, '.openslack.local/workflows/send-admission', hash(b.runId));
  const header = (await readFile(join(directory, 'journal.jsonl'), 'utf8')).split('\n')[0]! + '\n';
  let previous = digest;
  const entries: Record<string, unknown>[] = [];
  const security = createWorkflowRunnerDescriptorPathSecurity();
  for (const [index, fact] of facts.entries()) {
    const entry = { sequence: index + 1, previousHash: previous, fact };
    const value = { ...entry, hash: hash(entry) };
    previous = value.hash;
    entries.push(value);
    const path = join(
      directory,
      'facts',
      `${String(value.sequence).padStart(3, '0')}.${value.hash}.json`,
    );
    try {
      await writeFile(path, canonical(value) + '\n', { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
        (await readFile(path, 'utf8')) !== canonical(value) + '\n'
      )
        throw error;
    }
    await security.harden(path, false);
  }
  await writeFile(
    join(directory, 'journal.jsonl'),
    header + entries.map((e) => canonical(e) + '\n').join(''),
  );
}
function settledFacts(id: string, purpose: string, tokens: number) {
  return [
    { kind: 'slot', id, purpose, providerRunId: 'RUN-PHYSICAL', providerAttempt: id },
    {
      kind: 'reserved',
      id,
      reservation: {
        reservationId: 'reservation.' + id,
        callId: 'call.' + id,
        authorizedTokens: '8192',
      },
    },
    {
      kind: 'admitted',
      id,
      requestHash: '5'.repeat(64),
      providerRequestHash: 'a'.repeat(64),
      constraintHash: '6'.repeat(64),
    },
    { kind: 'response', id, receiptHash: '7'.repeat(64), totalTokens: String(tokens) },
    {
      kind: 'settled',
      id,
      receiptHash: '7'.repeat(64),
      totalTokens: tokens,
      outcome: 'reported',
      goReceiptHash: '8'.repeat(64),
      goRequestHash: '9'.repeat(64),
    },
  ];
}
it(
  'enforces all four slots and preserves both main-chain reservations',
  async () => {
    const { root, b, digest, go } = await fixture();
    const facts = ['preflight', 'initial', 'preflight', 'resume'].flatMap((p, i) =>
      settledFacts(`attempt-${i + 1}`, p, 8192),
    );
    await seed(root, b, digest, facts);
    const port = await createWorkflowSendAdmissionPort({
      root,
      bindingHash: digest,
      runId: b.runId,
      workspaceId: b.workspaceId,
      sourceHash: b.workflowSourceHash,
      workerHash: b.workerHash,
      route: b.route,
      purpose: 'resume',
      go,
      goFrontier: async () => ({ reservedCalls: '4', settledCalls: '4', settledTokens: '32768' }),
      readGoSettlement: async () => null,
      noOpenGoReservations: async () => true,
      isDefiniteGoRejection: () => false,
    });
    await expect(
      port.reserve({
        providerId: b.providerId,
        modelId: b.modelId,
        providerRunId: 'RUN-NEXT',
        providerAttempt: '5',
        requestedTokens: '8192',
      }),
    ).rejects.toThrow('SEND_ADMISSION_LIMIT');
    expect(go.reserve).not.toHaveBeenCalled();
  },
  platformTestTimeout(5_000),
);
it(
  'preserves overage evidence and never regains a slot from it',
  async () => {
    const { root, b, digest } = await fixture();
    await seed(root, b, digest, settledFacts('attempt-1', 'initial', 8193));
    expect(
      (await readWorkflowSendCampaign(root, b.runId, digest)).entries.at(-1)?.fact,
    ).toMatchObject({ kind: 'settled', totalTokens: 8193 });
    await expect(
      checkWorkflowSendCache(
        root,
        b.runId,
        digest,
        'r-ext-go-qualification:FirstCall:r-ext:first:x',
        null,
      ),
    ).rejects.toThrow('SEND_ADMISSION_FROZEN');
  },
  platformTestTimeout(5_000),
);
it(
  'accepts only a matching run-bound cache and refuses cache gaps or changed results',
  async () => {
    const { root, b, digest, go } = await fixture();
    const key = 'r-ext-go-qualification:FirstCall:r-ext:first:x';
    const result = { data: { ok: true, stage: 'first' }, tokenUsage: 7 };
    const hash = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');
    await seed(root, b, digest, [
      ...settledFacts('attempt-1', 'initial', 7),
      { kind: 'cache', id: 'attempt-1', cacheKeyHash: hash(key), resultHash: hash(result) },
    ]);
    await expect(
      checkWorkflowSendCache(root, b.runId, digest, key, result),
    ).resolves.toBeUndefined();
    await expect(checkWorkflowSendCache(root, b.runId, digest, key, null)).rejects.toThrow(
      'SEND_ADMISSION_FROZEN',
    );
    await expect(
      checkWorkflowSendCache(root, b.runId, digest, key, { ...result, tokenUsage: 8 }),
    ).rejects.toThrow('SEND_ADMISSION_FROZEN');
    expect(go.reserve).not.toHaveBeenCalled();
    expect(go.settle).not.toHaveBeenCalled();
  },
  platformTestTimeout(5_000),
);
it('the qualification asset refuses missing registration before any logical provider call', async () => {
  const path = join(
    import.meta.dirname,
    '../../../../.openslack/workflows/r-ext-go-qualification.mjs',
  );
  const asset = (await import(pathToFileURL(path).href)) as {
    run: (ctx: unknown) => Promise<unknown>;
  };
  const agent = vi.fn(async () => ({ ok: true, stage: 'first' }));
  await expect(
    asset.run({
      args: { campaignId: 'campaign.test' },
      runId: 'run.test',
      checkpoint: { commit: vi.fn() },
      phase: vi.fn(),
      agent,
      openslack: { governance: { audit: async () => {} } },
    }),
  ).rejects.toThrow(/campaignBindingHash/);
  expect(agent).not.toHaveBeenCalled();
});
it(
  'registers exclusively and refuses re-registration for an existing Go run',
  async () => {
    const { root, b, digest } = await fixture();
    expect((await readWorkflowSendCampaign(root, b.runId, digest)).entries).toEqual([]);
    await expect(
      registerWorkflowSendCampaign(b, { readIfExists: async () => null }),
    ).rejects.toThrow();
    const other = { ...b, runId: 'run.existing' };
    await expect(
      registerWorkflowSendCampaign(other, { readIfExists: async () => ({}) as never }),
    ).rejects.toThrow('SEND_ADMISSION_INVALID');
  },
  platformTestTimeout(5_000),
);
it.each([
  ['default', 'SEND_TOTAL_TOKEN_UNVERIFIED'],
  ['unreviewed-model', 'SEND_ADMISSION_INVALID'],
])(
  'refuses preparation for %s without a Go reservation or a campaign mutation',
  async (modelId, code) => {
    const { root, b, digest, port, go } = await fixture();
    const before = await readWorkflowSendCampaign(root, b.runId, digest);
    const body = JSON.stringify({
      model: modelId,
      messages: [{ role: 'user', content: '检查🧪' }],
      tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }],
      max_tokens: 8192,
    });
    await expect(
      prepareProviderSend(port, {
        providerId: b.providerId,
        modelId,
        requestBytes: body,
      }),
    ).rejects.toThrow(code);
    expect(go.reserve).not.toHaveBeenCalled();
    expect(go.settle).not.toHaveBeenCalled();
    expect(await readWorkflowSendCampaign(root, b.runId, digest)).toEqual(before);
    expect(before.entries).toEqual([]);
  },
  platformTestTimeout(5_000),
);
it(
  'reserves with Go once, refuses output-only caps and freezes the unresolved attempt',
  async () => {
    const { root, b, digest, port, go } = await fixture();
    const request = {
      providerId: b.providerId,
      modelId: b.modelId,
      providerRunId: 'RUN-PHYSICAL',
      providerAttempt: '1',
      requestedTokens: '8192',
    };
    const reservation = await port.reserve(request);
    const transport = vi.fn();
    await expect(
      (async () => {
        await admitProviderSend(port, reservation, {
          providerId: b.providerId,
          modelId: b.modelId,
          requestBytes: JSON.stringify({ max_tokens: 8192 }),
        });
        transport();
      })(),
    ).rejects.toThrow('SEND_TOTAL_TOKEN_UNVERIFIED');
    expect(transport).not.toHaveBeenCalled();
    await expect(port.reserve(request)).rejects.toThrow('SEND_ADMISSION_FROZEN');
    expect(go.reserve).toHaveBeenCalledTimes(1);
    expect(go.settle).not.toHaveBeenCalled();
    expect(
      (await readWorkflowSendCampaign(root, b.runId, digest)).entries.map((e) => e.fact.kind),
    ).toEqual(['slot', 'reserved', 'refused']);
  },
  platformTestTimeout(5_000),
);
it(
  'has one nonblocking winner and never automatically retries an uncertain Go response',
  async () => {
    const { port, go } = await fixture();
    go.reserve.mockRejectedValueOnce(new Error('private sentinel'));
    const request = {
      providerId: 'openai-compatible',
      modelId: 'default',
      providerRunId: 'RUN-PHYSICAL',
      providerAttempt: '1',
      requestedTokens: '8192',
    };
    const results = await Promise.allSettled([port.reserve(request), port.reserve(request)]);
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(go.reserve).toHaveBeenCalledTimes(1);
    await expect(port.reserve(request)).rejects.toThrow(/SEND_ADMISSION_(FROZEN|BUSY)/);
  },
  platformTestTimeout(5_000),
);
it.each(['truncate', 'link', 'missing'] as const)(
  'cannot regain allowance from %s history',
  async (kind) => {
    const { root, b, digest } = await fixture();
    const s = await readWorkflowSendCampaign(root, b.runId, digest);
    const { createHash } = await import('node:crypto');
    const { canonicalWorkflowControlAuthorityJson: canonical } =
      await import('../workflow-control-authority-contract.js');
    const path = join(
      root,
      '.openslack.local/workflows/send-admission',
      createHash('sha256').update(canonical(b.runId)).digest('hex'),
      'journal.jsonl',
    );
    if (kind === 'truncate') await writeFile(path, (await readFile(path)).subarray(0, -1));
    if (kind === 'link') await link(path, join(root, 'alias'));
    if (kind === 'missing') await rm(path);
    await expect(readWorkflowSendCampaign(root, b.runId, digest)).rejects.toThrow();
    expect(s.entries).toHaveLength(0);
  },
  platformTestTimeout(5_000),
);
it(
  'rejects a complete newline-terminated older journal prefix and a rolled-back frontier',
  async () => {
    const { root, b, digest, port } = await fixture();
    await port.reserve({
      providerId: b.providerId,
      modelId: b.modelId,
      providerRunId: 'RUN-PHYSICAL',
      providerAttempt: '1',
      requestedTokens: '8192',
    });
    const { createHash } = await import('node:crypto');
    const { canonicalWorkflowControlAuthorityJson: canonical } =
      await import('../workflow-control-authority-contract.js');
    const directory = join(
      root,
      '.openslack.local/workflows/send-admission',
      createHash('sha256').update(canonical(b.runId)).digest('hex'),
    );
    const path = join(directory, 'journal.jsonl');
    const first = (await readFile(path, 'utf8')).split('\n')[0]! + '\n';
    await writeFile(path, first);
    await expect(readWorkflowSendCampaign(root, b.runId, digest)).rejects.toThrow(
      'SEND_ADMISSION_INVALID',
    );
    for (const name of await readdir(join(directory, 'facts')))
      await rm(join(directory, 'facts', name));
    // Even removal of the local immutable frontier cannot erase Go's reservation.
    await expect(
      port.reserve({
        providerId: b.providerId,
        modelId: b.modelId,
        providerRunId: 'RUN-PHYSICAL',
        providerAttempt: '2',
        requestedTokens: '8192',
      }),
    ).rejects.toThrow('SEND_ADMISSION_FROZEN');
  },
  platformTestTimeout(5_000),
);

it(
  'settles an observed response once against the exact provider request and Go receipt',
  async () => {
    const { root, b, digest, port, go } = await fixture(async () => ({
      receiptHash: 'b'.repeat(64),
      requestHash: 'c'.repeat(64),
    }));
    const reservation = await port.reserve({
      providerId: b.providerId,
      modelId: b.modelId,
      providerRunId: 'RUN-PHYSICAL',
      providerAttempt: '1',
      requestedTokens: '8192',
    });
    const requestBytes = JSON.stringify({
      messages: [{ role: 'user', content: 'fixture' }],
      max_tokens: 8,
    });
    const prior = await readWorkflowSendCampaign(root, b.runId, digest);
    // Fault fixture supplies already admitted evidence only. It grants no
    // production total-token capability and never invokes a transport.
    await seed(root, b, digest, [
      ...prior.entries.map((e) => e.fact),
      {
        kind: 'admitted',
        id: 'attempt-1',
        ...workflowSendRequestEvidence(requestBytes),
        constraintHash: 'a'.repeat(64),
      },
    ]);
    const usage = buildProviderUsageReceipt({
      providerId: b.providerId,
      modelId: b.modelId,
      runId: 'RUN-PHYSICAL',
      attempt: 1,
      status: 'reported',
      usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 },
      outcome: 'provider_response_accepted',
      requestBytes,
      outcomeBytes: 'fixture response',
    });
    await expect(port.settle(reservation, usage)).resolves.toBeUndefined();
    await expect(port.settle(reservation, usage)).resolves.toBeUndefined();
    expect(go.settle).toHaveBeenCalledTimes(1);
    expect(
      (await readWorkflowSendCampaign(root, b.runId, digest)).entries.at(-1)?.fact,
    ).toMatchObject({
      kind: 'settled',
      totalTokens: 8,
      goReceiptHash: 'b'.repeat(64),
      goRequestHash: 'c'.repeat(64),
    });
  },
  platformTestTimeout(5_000),
);

it.each(['unknown-go-response', 'missing-go-proof', 'unknown-usage', 'overage'] as const)(
  'preserves %s settlement evidence without retrying Go or regaining allowance',
  async (mode) => {
    const { root, b, digest, port, go } = await fixture(async () =>
      mode === 'missing-go-proof'
        ? null
        : { receiptHash: 'b'.repeat(64), requestHash: 'c'.repeat(64) },
    );
    const request = {
      providerId: b.providerId,
      modelId: b.modelId,
      providerRunId: 'RUN-PHYSICAL',
      providerAttempt: '1',
      requestedTokens: '8192',
    };
    const reservation = await port.reserve(request);
    const requestBytes = JSON.stringify({ max_tokens: 8 });
    const prior = await readWorkflowSendCampaign(root, b.runId, digest);
    await seed(root, b, digest, [
      ...prior.entries.map((e) => e.fact),
      {
        kind: 'admitted',
        id: 'attempt-1',
        ...workflowSendRequestEvidence(requestBytes),
        constraintHash: 'a'.repeat(64),
      },
    ]);
    const tokens = mode === 'overage' ? 8193 : 8;
    const usage = buildProviderUsageReceipt({
      providerId: b.providerId,
      modelId: b.modelId,
      runId: 'RUN-PHYSICAL',
      attempt: 1,
      status: mode === 'unknown-usage' ? 'unreported' : 'reported',
      usage:
        mode === 'unknown-usage'
          ? null
          : { inputTokens: 3, outputTokens: tokens - 3, totalTokens: tokens },
      outcome: 'provider_response_accepted',
      requestBytes,
      outcomeBytes: 'fixture response',
    });
    if (mode === 'unknown-go-response')
      go.settle.mockRejectedValueOnce(new Error('fixture Go result unknown'));
    if (mode === 'overage') await expect(port.settle(reservation, usage)).resolves.toBeUndefined();
    else await expect(port.settle(reservation, usage)).rejects.toThrow();
    const again = port.settle(reservation, usage);
    if (mode === 'overage') await expect(again).resolves.toBeUndefined();
    else await expect(again).rejects.toThrow();
    expect(go.settle).toHaveBeenCalledTimes(1);
    const observed = await readWorkflowSendCampaign(root, b.runId, digest);
    expect(observed.entries.some((e) => e.fact.kind === 'response')).toBe(true);
    if (mode === 'overage')
      expect(observed.entries.at(-1)?.fact).toMatchObject({ kind: 'settled', totalTokens: 8193 });
    await expect(port.reserve(request)).rejects.toThrow('SEND_ADMISSION_FROZEN');
    expect(go.reserve).toHaveBeenCalledTimes(1);
  },
  platformTestTimeout(5_000),
);
