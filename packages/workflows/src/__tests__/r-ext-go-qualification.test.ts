import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadWorkflowFile } from '../internal/workflow-file-loader.js';
import * as workflowLoader from '../internal/workflow-file-loader.js';
import { assertWorkflowRunnerSourceIsSelfContained } from '../workflow-runner-source-policy.js';
import { checkpointEvidence } from '../internal/workflow-runner-checkpoint-evidence.js';
import { validateWorkflowCheckpointShadowEnvelope } from '../workflow-checkpoint-shadow-contract.js';
import { executeGoAuthorityRun } from '../execute.js';
import { createWorkflowCheckpointLeaseAuthority } from '../internal/workflow-checkpoint-lease-authority.js';
import { bindGoWorkflowResumeIdentity, validateGoWorkflowResumeContext } from '../resume.js';
import {
  workflowRunnerV2DescriptorFixture,
  workflowRunnerGoAuthorityFixture,
} from './workflow-runner-v2-test-fixture.js';
import { platformTestTimeout } from '../../../../scripts/testing/process-fixture.mjs';
import { RunStore } from '../run-store.js';
import { createWorkflowRunnerV2EffectAuthorizationPort } from '../workflow-runner-v2-effect-authorization.js';
import { WorkflowEffectApprovalPendingError } from '../internal/workflow-effect-authorization-contract.js';
import type { WorkflowRunnerV2ExecutionContext } from '../workflow-runner-v2-session.js';
import { computeAgentCacheKey } from '../agent-shim.js';
import type { AgentOptions } from '../types.js';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const preparation = (name: string) =>
  import(pathToFileURL(join(root, 'scripts/r-ext-go-qualification', `${name}.ts`)).href);
const temporaryRoots: string[] = [];

function drainedSnapshot() {
  return {
    admissionClosed: true,
    activeRuns: 0,
    pendingEffects: 0,
    openReservations: 0,
    reconciliationRequired: 0,
    authorityConsistent: true,
  };
}

function observationClock() {
  let now = 0;
  const epoch = Date.parse('2026-11-05T00:00:00.000Z');
  const timers = new Map<symbol, { deadline: number; callback: () => void }>();
  const advance = (ms: number) => {
    now += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.deadline <= now) {
        timers.delete(id);
        timer.callback();
      }
    }
  };
  return {
    now: () => now,
    wallNow: () => new Date(epoch + now).toISOString(),
    sleep: async (ms: number) => advance(ms),
    schedule(deadline: number, callback: () => void) {
      const id = Symbol('observation deadline');
      timers.set(id, { deadline, callback });
      return () => {
        timers.delete(id);
      };
    },
    advance,
    activeTimers: () => timers.size,
  };
}

async function preparationCheckout() {
  const directory = await mkdtemp(join(tmpdir(), 'rext-preflight-'));
  temporaryRoots.push(directory);
  await mkdir(join(directory, '.openslack/workflows'), { recursive: true });
  await writeFile(
    join(directory, '.openslack/workflows/r-ext-go-qualification.mjs'),
    await readFile(join(root, '.openslack/workflows/r-ext-go-qualification.mjs')),
  );
  await writeFile(join(directory, 'bun.lock'), 'fixture lock bytes\n');
  await writeFile(join(directory, 'README.md'), 'tracked fixture\n');
  const git = (...args: string[]) =>
    execFileSync(
      process.platform === 'win32' ? 'git.exe' : 'git',
      [
        '-c',
        'core.hooksPath=' + join(directory, '.git/disabled-hooks'),
        '-c',
        'commit.gpgsign=false',
        '-c',
        'user.name=Qualification Fixture',
        '-c',
        'user.email=qualification@example.invalid',
        ...args,
      ],
      { cwd: directory, encoding: 'utf8', timeout: 10_000, windowsHide: true },
    ).trim();
  git('init', '--quiet');
  git('config', 'core.autocrlf', 'false');
  git('add', '.');
  git('commit', '--quiet', '-m', 'fixture: freeze preparation bytes');
  return { directory, git, head: () => git('rev-parse', 'HEAD') };
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('R-EXT credential-free preparation', () => {
  it('rejects persisted campaign prefixes that consume the reserved main-chain slots', async () => {
    const { newCampaign, validateCampaign, readCampaignFile } = await preparation('campaign');
    const campaign = newCampaign({
      candidate: 'b'.repeat(40),
      runId: 'run.forged-prefix',
      createdAt: '2026-11-05T00:00:00.000Z',
    });
    campaign.attempts = Array.from({ length: 4 }, (_, index) => ({
      id: 'preflight.' + index,
      purpose: 'preflight',
      startedAt: '2026-11-05T00:00:01.000Z',
      reservedTokens: 8192,
      settlement: { outcome: 'reported', totalTokens: 8192, receiptHash: 'a'.repeat(64) },
    }));
    expect(() => validateCampaign(campaign)).toThrow();
    const directory = await mkdtemp(join(tmpdir(), 'rext-forged-prefix-'));
    temporaryRoots.push(directory);
    const path = join(directory, 'campaign.json');
    await writeFile(path, JSON.stringify(campaign));
    await expect(readCampaignFile(path)).rejects.toThrow();
  });

  it('rejects a not-sent settlement carrying a usage receipt without changing the open attempt', async () => {
    const { newCampaign, beginAttempt, settleAttempt } = await preparation('campaign');
    const campaign = beginAttempt(
      newCampaign({
        candidate: 'b'.repeat(40),
        runId: 'run.not-sent-receipt',
        createdAt: '2026-11-05T00:00:00.000Z',
      }),
      'preflight.1',
      'preflight',
      '2026-11-05T00:00:01.000Z',
    );
    expect(() =>
      settleAttempt(campaign, 'preflight.1', {
        outcome: 'not_sent',
        totalTokens: 0,
        receiptHash: 'a'.repeat(64),
      }),
    ).toThrow();
    expect(campaign.attempts[0].settlement).toBeUndefined();
  });

  it.each(['+010000-01-01T00:00:00.000Z', '-000001-01-01T00:00:00.000Z'])(
    'rejects timestamps outside the shared four-digit UTC contract: %s',
    async (value) => {
      const { timestamp } = await preparation('evidence');
      expect(() => timestamp(value)).toThrow();
    },
  );

  it.each(['symbol', 'prototype', 'getter', 'proxy'])(
    'rejects non-inert evidence before invoking user code: %s',
    async (kind) => {
      const { exactKeys } = await preparation('evidence');
      const touched = vi.fn();
      let value: object = { a: 1 };
      if (kind === 'symbol') value = { a: 1, [Symbol('extra')]: true };
      if (kind === 'prototype') value = Object.assign(Object.create({ extra: true }), { a: 1 });
      if (kind === 'getter') {
        value = Object.defineProperty({}, 'a', { enumerable: true, get: touched });
      }
      if (kind === 'proxy') {
        value = new Proxy(value, {
          getOwnPropertyDescriptor(target, property) {
            touched();
            return Reflect.getOwnPropertyDescriptor(target, property);
          },
        });
      }
      expect(() => exactKeys(value, ['a'])).toThrow();
      expect(touched).not.toHaveBeenCalled();
    },
  );

  it('fails promptly when sleep resolves without advancing the observation clock', async () => {
    const { observeDrain } = await preparation('observe');
    let sleeps = 0;
    const clock = {
      ...observationClock(),
      sleep: async () => {
        // Keep the old implementation bounded while exposing its missing guard.
        if (++sleeps > 1) throw new Error('stalled-clock regression guard');
      },
    };
    await expect(observeDrain(async () => drainedSnapshot(), clock)).resolves.toMatchObject({
      status: 'FAIL',
      reason: 'clock_stalled',
      samples: [],
    });
    expect(sleeps).toBe(1);
  });

  it('uses the supplied deadline scheduler rather than a different native timebase', async () => {
    const { observeDrain } = await preparation('observe');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const clock = observationClock();
    let settleFirst!: (value: ReturnType<typeof drainedSnapshot>) => void;
    let calls = 0;
    const pending = observeDrain(async () => {
      if (++calls === 1) {
        return new Promise<ReturnType<typeof drainedSnapshot>>((resolve) => {
          settleFirst = resolve;
        });
      }
      return drainedSnapshot();
    }, clock);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    try {
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(settled).toBe(false);
    } finally {
      settleFirst(drainedSnapshot());
    }
    expect(await pending).toMatchObject({ status: 'PASS' });
    expect(clock.activeTimers()).toBe(0);
  });

  it('distinguishes malformed authority evidence from a failed read without archiving it', async () => {
    const { observeDrain } = await preparation('observe');
    const malformed = await observeDrain(
      async () => ({ ...drainedSnapshot(), activeRuns: 'secret sentinel' }),
      observationClock(),
    );
    expect(malformed).toMatchObject({
      status: 'FAIL',
      samples: [{ valid: false, reason: 'authority_snapshot_invalid' }],
    });
    expect(JSON.stringify(malformed)).not.toContain('secret sentinel');
  });

  it.each(['worktree', 'index', 'lock', 'untracked-target'])(
    'refuses a candidate whose frozen inputs differ from HEAD: %s',
    async (change) => {
      const { inspectPreparation } = await preparation('preflight');
      const checkout = await preparationCheckout();
      const path = join(checkout.directory, '.openslack/workflows/r-ext-go-qualification.mjs');
      if (change === 'untracked-target') {
        checkout.git('rm', '--cached', '.openslack/workflows/r-ext-go-qualification.mjs');
        checkout.git('commit', '--quiet', '-m', 'fixture: remove workflow from candidate');
      } else {
        await inspectPreparation(checkout.directory, checkout.head());
        await appendFile(
          change === 'lock' ? join(checkout.directory, 'bun.lock') : path,
          '\n// candidate drift\n',
        );
        if (change === 'index')
          checkout.git('add', '.openslack/workflows/r-ext-go-qualification.mjs');
      }
      await expect(inspectPreparation(checkout.directory, checkout.head())).rejects.toThrow();
    },
  );

  it('accepts unrelated untracked files without counting them as frozen candidate content', async () => {
    const { inspectPreparation } = await preparation('preflight');
    const checkout = await preparationCheckout();
    await writeFile(join(checkout.directory, 'unrelated.tmp'), 'not a candidate input');
    expect(await inspectPreparation(checkout.directory, checkout.head())).toMatchObject({
      candidate: checkout.head(),
      clean: true,
      liveExecutionEnabled: false,
    });
  });

  it.each(['HEAD', 'lock', 'workflow'])(
    'refuses candidate drift during the real loader boundary: %s',
    async (change) => {
      const { inspectPreparation } = await preparation('preflight');
      const checkout = await preparationCheckout();
      const expected = checkout.head();
      const load = workflowLoader.loadWorkflowFile;
      vi.spyOn(workflowLoader, 'loadWorkflowFile').mockImplementationOnce(async (...args) => {
        const workflow = await load(...args);
        if (change === 'HEAD') {
          checkout.git('commit', '--quiet', '--allow-empty', '-m', 'fixture: move candidate');
        } else {
          await appendFile(
            join(
              checkout.directory,
              change === 'lock' ? 'bun.lock' : '.openslack/workflows/r-ext-go-qualification.mjs',
            ),
            '\n// inspection drift\n',
          );
        }
        return workflow;
      });
      await expect(inspectPreparation(checkout.directory, expected)).rejects.toThrow();
    },
  );

  it('loads a dedicated fixed-identity fixture without running a provider', async () => {
    const workflow = await loadWorkflowFile(
      join(root, '.openslack/workflows/r-ext-go-qualification.mjs'),
    );
    expect(workflow.meta.name).toBe('r-ext-go-qualification');
    expect(workflow.meta.phases.map((phase) => phase.title)).toEqual([
      'FirstCall',
      'Approval',
      'SecondCall',
      'Complete',
    ]);
    expect(workflow.sourceSnapshot).toBeDefined();
    expect(workflow.meta.budgetPolicy?.tokenBudget).toBe(16_384);
    expect(workflow.meta.isolationPolicy).toEqual({ codex_qualification_rext: 'none' });
    expect(await workflow.preview!({ phase() {} } as never, {})).toMatchObject({
      preview: true,
      agentId: 'codex_qualification_rext',
      providerCalls: 0,
    });
    const { preparationStatus } = await preparation('evidence');
    const { CAMPAIGN_LIMITS, MAIN_CHAIN_PURPOSES } = await preparation('campaign');
    expect(await workflow.preview!({ phase() {} } as never, {})).toMatchObject({
      preparationBlocker: preparationStatus().blocker,
    });
    expect(workflow.meta.whenToUse).toContain(preparationStatus().blocker);
    expect(workflow.meta.budgetPolicy?.maxAgents).toBe(MAIN_CHAIN_PURPOSES.length);
    expect(workflow.meta.budgetPolicy?.tokenBudget).toBe(
      CAMPAIGN_LIMITS.tokensPerAttempt * MAIN_CHAIN_PURPOSES.length,
    );
  });

  it.each(['campaign:local', 'a'.repeat(160), 'a'.repeat(161), 'campaign@wire', ''])(
    'keeps the sealed campaign alphabet aligned without asserting registration: %s',
    async (campaignId) => {
      const workflow = await loadWorkflowFile(
        join(root, '.openslack/workflows/r-ext-go-qualification.mjs'),
      );
      const { SAFE_ID } = await preparation('evidence');
      const agent = vi.fn(async (): Promise<never> => {
        throw new Error('correlation reached the deterministic launcher');
      });
      await expect(
        workflow.run!({ args: { campaignId }, phase() {}, checkpoint: {}, agent } as never, {}),
      ).rejects.toThrow(
        SAFE_ID.test(campaignId) ? /deterministic launcher/ : /well-formed campaignId/,
      );
      expect(agent).toHaveBeenCalledTimes(SAFE_ID.test(campaignId) ? 1 : 0);
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 30_000])(
    'rejects invalid or already-missed clock readings before asking the authority: %s',
    async (next) => {
      const { observeDrain } = await preparation('observe');
      let reads = 0;
      const clock = { ...observationClock(), now: () => (++reads === 1 ? 0 : next) };
      const authority = vi.fn(async () => drainedSnapshot());
      expect(await observeDrain(authority, clock)).toMatchObject({
        status: 'FAIL',
        samples: [],
      });
      expect(authority).not.toHaveBeenCalled();
    },
  );

  it('rejects a broken deadline scheduler without starting a read or leaking rejection text', async () => {
    const { observeDrain } = await preparation('observe');
    const authority = vi.fn(async () => drainedSnapshot());
    const result = await observeDrain(authority, {
      ...observationClock(),
      schedule() {
        throw new Error('scheduler secret sentinel');
      },
    });
    expect(result).toMatchObject({ status: 'FAIL', reason: 'clock_invalid', samples: [] });
    expect(authority).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('scheduler secret sentinel');
  });

  it('does not amend a timed-out observation when the old read later completes', async () => {
    const { observeDrain } = await preparation('observe');
    const clock = observationClock();
    let finish!: (value: ReturnType<typeof drainedSnapshot>) => void;
    const read = vi.fn(
      () =>
        new Promise<ReturnType<typeof drainedSnapshot>>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = observeDrain(read, clock);
    await Promise.resolve();
    clock.advance(15_000);
    const failed = await pending;
    const bytes = JSON.stringify(failed);
    expect(failed).toMatchObject({
      status: 'FAIL',
      samples: [{ valid: false, reason: 'authority_read_timeout' }],
    });
    finish(drainedSnapshot());
    await Promise.resolve();
    expect(JSON.stringify(await pending)).toBe(bytes);
    expect(read).toHaveBeenCalledTimes(1);
    expect(clock.activeTimers()).toBe(0);
  });

  it('uses the production approval identifier grammar without inventing a pending approval', async () => {
    const { inspectPendingApproval } = await preparation('approval');
    const directory = await mkdtemp(join(tmpdir(), 'rext-wire-id-'));
    temporaryRoots.push(directory);
    await expect(
      inspectPendingApproval(directory, 'run@wire', 'approval@wire', '2026-11-05T00:00:00.000Z'),
    ).rejects.toMatchObject({ code: 'WORKFLOW_EFFECT_APPROVAL_STORE_NOT_FOUND' });
  });

  it('keeps CLI candidate failure distinct from the blocked preparation exit', async () => {
    const checkout = await preparationCheckout();
    const invoke = () =>
      spawnSync(
        process.platform === 'win32' ? 'bun.exe' : 'bun',
        [join(root, 'scripts/r-ext-go-qualification/preflight.ts'), '--candidate', checkout.head()],
        { cwd: checkout.directory, encoding: 'utf8', timeout: 10_000, windowsHide: true },
      );
    const clean = invoke();
    expect(clean.status, clean.stderr).toBe(2);
    expect(JSON.parse(clean.stdout)).toMatchObject({ clean: true, liveExecutionEnabled: false });
    await appendFile(
      join(checkout.directory, '.openslack/workflows/r-ext-go-qualification.mjs'),
      '\n// unsafe candidate sentinel\n',
    );
    const dirty = invoke();
    expect(dirty.status).toBe(1);
    expect(dirty.stdout).toBe('');
    expect(dirty.stderr).not.toContain('unsafe candidate sentinel');
  });

  it('passes the actual sealed source-admission policy on the exact fixture bytes', async () => {
    const source = await readFile(join(root, '.openslack/workflows/r-ext-go-qualification.mjs'));
    expect(() => assertWorkflowRunnerSourceIsSelfContained(source)).not.toThrow();
  });

  it('counts failed and unknown attempts, preserves the main-chain slots, and never resets', async () => {
    const { newCampaign, beginAttempt, settleAttempt, validateCampaign } =
      await preparation('campaign');
    let campaign = newCampaign({
      candidate: 'b'.repeat(40),
      runId: 'run.rext.local',
      createdAt: '2026-11-03T09:00:00.000Z',
    });
    campaign = beginAttempt(campaign, 'preflight.1', 'preflight', '2026-11-03T09:00:01.000Z');
    campaign = settleAttempt(campaign, 'preflight.1', {
      outcome: 'failed',
      totalTokens: 1,
      receiptHash: 'a'.repeat(64),
    });
    campaign = beginAttempt(campaign, 'preflight.2', 'preflight', '2026-11-03T09:00:02.000Z');
    campaign = settleAttempt(campaign, 'preflight.2', {
      outcome: 'not_sent',
      totalTokens: 0,
    });
    expect(() =>
      beginAttempt(campaign, 'preflight.3', 'preflight', '2026-11-03T09:00:03.000Z'),
    ).toThrow(/main-chain/);
    campaign = beginAttempt(campaign, 'initial.1', 'initial', '2026-11-03T09:00:04.000Z');
    campaign = settleAttempt(campaign, 'initial.1', { outcome: 'unknown' });
    expect(() => beginAttempt(campaign, 'resume.1', 'resume', '2026-11-03T09:00:05.000Z')).toThrow(
      /reconciliation/,
    );
    expect(validateCampaign(JSON.parse(JSON.stringify(campaign))).attempts).toHaveLength(3);
    expect(() => validateCampaign({ ...campaign, limits: { attempts: 10 } })).toThrow();
  });

  it.each(['purpose', 'outcome'] as const)(
    'rejects persisted array-valued %s instead of coercing it into a budget grant',
    async (field) => {
      const { newCampaign, beginAttempt, settleAttempt, validateCampaign, readCampaignFile } =
        await preparation('campaign');
      const fresh = newCampaign({
        candidate: 'c'.repeat(40),
        runId: 'run.invalid-enum',
        createdAt: '2026-11-03T09:00:00.000Z',
      });
      const started = beginAttempt(fresh, 'initial.1', 'initial', '2026-11-03T09:00:01.000Z');
      const malformed = settleAttempt(started, 'initial.1', {
        outcome: 'reported',
        totalTokens: 0,
        receiptHash: 'a'.repeat(64),
      });
      if (field === 'purpose') malformed.attempts[0].purpose = ['initial'];
      else malformed.attempts[0].settlement.outcome = ['unknown'];
      // JSON serialization preserves the hostile data type; no custom getter
      // or mock parser is needed to reproduce the persisted-input boundary.
      const raw = JSON.stringify(malformed);
      expect(() => validateCampaign(JSON.parse(raw))).toThrow(/Invalid/);
      expect(() =>
        beginAttempt(JSON.parse(raw), 'resume.1', 'resume', '2026-11-03T09:00:02.000Z'),
      ).toThrow();
      const directory = await mkdtemp(join(tmpdir(), 'rext-invalid-enum-'));
      temporaryRoots.push(directory);
      const path = join(directory, 'campaign.json');
      await writeFile(path, raw);
      await expect(readCampaignFile(path)).rejects.toThrow(/Invalid/);
    },
  );

  it('counts all four attempts and rejects a fifth attempt or a second settlement', async () => {
    const { newCampaign, beginAttempt, settleAttempt } = await preparation('campaign');
    let campaign = newCampaign({
      candidate: 'c'.repeat(40),
      runId: 'run.limit',
      createdAt: '2026-11-03T09:00:00.000Z',
    });
    for (const [index, purpose] of ['initial', 'resume', 'preflight', 'preflight'].entries()) {
      const id = `${purpose}.${index}`;
      campaign = beginAttempt(campaign, id, purpose, '2026-11-03T09:00:01.000Z');
      campaign = settleAttempt(campaign, id, {
        outcome: 'reported',
        totalTokens: 8192,
        receiptHash: 'a'.repeat(64),
      });
    }
    expect(campaign.attempts).toHaveLength(4);
    expect(() =>
      settleAttempt(campaign, 'initial.0', { outcome: 'not_sent', totalTokens: 0 }),
    ).toThrow();
    expect(() =>
      beginAttempt(campaign, 'fifth', 'replacement', '2026-11-03T09:00:02.000Z'),
    ).toThrow();
  });

  it('retains measured overage and freezes every subsequent attempt', async () => {
    const { newCampaign, beginAttempt, settleAttempt } = await preparation('campaign');
    const started = beginAttempt(
      newCampaign({
        candidate: 'c'.repeat(40),
        runId: 'run.overage',
        createdAt: '2026-11-05T00:00:00.000Z',
      }),
      'initial.1',
      'initial',
      '2026-11-05T00:00:01.000Z',
    );
    const exceeded = settleAttempt(started, 'initial.1', {
      outcome: 'reported',
      totalTokens: 8193,
      receiptHash: 'a'.repeat(64),
    });
    expect(exceeded.attempts[0].settlement.totalTokens).toBe(8193);
    expect(() =>
      beginAttempt(exceeded, 'after-overage', 'preflight', '2026-11-05T00:00:02.000Z'),
    ).toThrow(/reconciliation/);
  });

  it('allows a replacement only for an exact confirmed not-sent predecessor', async () => {
    const { newCampaign, beginAttempt, settleAttempt } = await preparation('campaign');
    let campaign = newCampaign({
      candidate: 'e'.repeat(40),
      runId: 'run.replacement',
      createdAt: '2026-11-03T09:00:00.000Z',
    });
    expect(() =>
      beginAttempt(campaign, 'replacement.1', 'replacement', '2026-11-03T09:00:01.000Z'),
    ).toThrow(/not-sent/);
    campaign = beginAttempt(campaign, 'preflight.1', 'preflight', '2026-11-03T09:00:01.000Z');
    campaign = settleAttempt(campaign, 'preflight.1', { outcome: 'not_sent', totalTokens: 0 });
    campaign = beginAttempt(
      campaign,
      'replacement.1',
      'replacement',
      '2026-11-03T09:00:02.000Z',
      'preflight.1',
    );
    expect(campaign.attempts[1].replacementOf).toBe('preflight.1');
  });

  it('never overwrites campaign evidence or treats corrupted evidence as a new allowance', async () => {
    const { newCampaign, createCampaignFile, readCampaignFile } = await preparation('campaign');
    const directory = await mkdtemp(join(tmpdir(), 'rext-campaign-'));
    temporaryRoots.push(directory);
    const path = join(directory, 'campaign.json');
    const campaign = newCampaign({
      candidate: 'd'.repeat(40),
      runId: 'run.files',
      createdAt: '2026-11-03T09:00:00.000Z',
    });
    await createCampaignFile(path, campaign);
    await expect(createCampaignFile(path, campaign)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readCampaignFile(path)).toEqual(campaign);
    await writeFile(path, '{"schema":');
    await expect(readCampaignFile(path)).rejects.toThrow();
    await writeFile(
      path,
      JSON.stringify(campaign).replace(
        '"candidate":',
        '"candidate":"' + '0'.repeat(40) + '","candidate":',
      ),
    );
    await expect(readCampaignFile(path)).rejects.toThrow();
  });

  it('fails before a provider when checkpoint or campaign correlation is missing', async () => {
    const workflow = await loadWorkflowFile(
      join(root, '.openslack/workflows/r-ext-go-qualification.mjs'),
    );
    const agent = vi.fn();
    await expect(
      workflow.run!({ args: { campaignId: 'local' }, agent } as never, {}),
    ).rejects.toThrow(/checkpoint/);
    await expect(workflow.run!({ args: {}, checkpoint: {}, agent } as never, {})).rejects.toThrow(
      /campaignId/,
    );
    expect(agent).not.toHaveBeenCalled();
  });

  it(
    'initializes normally, persists the first call/checkpoint, and naturally pauses before any audit effect',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'rext-initial-'));
      temporaryRoots.push(directory);
      const workflowPath = join(root, '.openslack/workflows/r-ext-go-qualification.mjs');
      const workflow = await loadWorkflowFile(workflowPath);
      const sourceBytes = await readFile(workflowPath);
      const createdAt = new Date().toISOString();
      const expiresAt = new Date(Date.parse(createdAt) + 60 * 60_000).toISOString();
      const descriptor = workflowRunnerV2DescriptorFixture({
        workflowSourceBytes: sourceBytes,
        manifest: workflow.meta,
        input: { campaignId: 'campaign.local.normal' },
        budgetPolicy: {
          accountId: 'budget.rext.local',
          policyHash: 'b'.repeat(64),
          rateNanoUsdPerToken: '10',
          tokenLimit: '16384',
          costLimitNanoUsd: '163840',
          callLimit: '2',
        },
        authorityRoute: {
          backend: 'go',
          authority: 'workflow-control',
          routingEpoch: 9,
          authorityBuildHash: 'a'.repeat(64),
        },
        createdAt,
        expiresAt,
      });
      const { route, baseDir, store, binding } = workflowRunnerGoAuthorityFixture({
        rootDir: directory,
        descriptor,
        qualificationEnvironmentId: 'rext.local.test',
        runner: {
          jobId: 'job.rext.local',
          attemptId: 'attempt.rext.local',
          leaseId: 'lease.rext.local',
          fencingToken: 1,
        },
      });
      const effects = await createWorkflowRunnerV2EffectAuthorizationPort({
        workspaceRoot: directory,
        descriptor,
        context: { resumeGeneration: 0 } as WorkflowRunnerV2ExecutionContext,
      });
      const checkpointAuthority = createWorkflowCheckpointLeaseAuthority(binding);
      const launcher = vi.fn(async (_prompt: string, _options: AgentOptions) => ({
        data: { ok: true, stage: 'first' },
        tokenUsage: 7,
      }));
      let pending: WorkflowEffectApprovalPendingError | undefined;
      try {
        await executeGoAuthorityRun(
          bindGoWorkflowResumeIdentity(
            validateGoWorkflowResumeContext(
              descriptor.workflowRunId,
              route,
              descriptor.workspaceId,
            ),
            workflow,
            sourceBytes,
          ),
          {
            runId: descriptor.workflowRunId,
            manifest: workflow.meta,
            rootDir: directory,
            args: { campaignId: 'campaign.local.normal' },
            // Deterministic fixture rate, not a real provider pricing claim.
            budget: { tokens: 16_384, costUsd: 0.00016384 },
            allowUnattended: true,
            agentLauncher: launcher,
          },
          store,
          checkpointAuthority,
          effects,
        );
        throw new Error('The normal initial path must wait for exact approval.');
      } catch (error) {
        if (!(error instanceof WorkflowEffectApprovalPendingError)) throw error;
        pending = error;
      }
      expect(launcher).toHaveBeenCalledTimes(1);
      const [prompt, options] = launcher.mock.calls[0]!;
      expect(options).toMatchObject({
        agentType: 'codex_qualification_rext',
        label: 'r-ext:first',
        budget: { tokens: 8192 },
      });
      const reader = new RunStore({ baseDir, access: 'read-only' });
      expect(await reader.loadStatus(descriptor.workflowRunId)).toMatchObject({
        status: 'paused_waiting_approval',
      });
      expect(
        (await reader.loadCheckpointControl(descriptor.workflowRunId))?.checkpoints,
      ).toHaveLength(1);
      expect(await reader.loadBudgetSnapshot(descriptor.workflowRunId)).toMatchObject({
        usage: { agentCalls: 1, tokensUsed: 7 },
      });
      expect(await reader.readAuditRecords(descriptor.workflowRunId)).toHaveLength(0);
      expect(
        await reader.loadAgentResult(
          descriptor.workflowRunId,
          computeAgentCacheKey(workflow.meta.name, options.phase, options.label, prompt),
        ),
      ).toMatchObject({ data: { ok: true, stage: 'first' }, tokenUsage: 7 });
      const { inspectPendingApproval } = await preparation('approval');
      expect(
        await inspectPendingApproval(
          directory,
          descriptor.workflowRunId,
          pending!.approvalId,
          new Date().toISOString(),
        ),
      ).toMatchObject({
        runId: descriptor.workflowRunId,
        approvalId: pending!.approvalId,
        humanDecisionRequired: true,
        executionAllowed: false,
        blocker: '#433',
      });
      // Deliberately stop here: no test decision, seeded status or fake resume
      // obscures the separately reproduced sealed-worker checkpoint replay defect.
    },
    platformTestTimeout(5_000),
  );

  it('takes exactly forty fixed-deadline observations and does not fabricate missed slots', async () => {
    const { observeDrain } = await preparation('observe');
    const clock = observationClock();
    const good = async () => ({
      admissionClosed: true,
      activeRuns: 0,
      pendingEffects: 0,
      openReservations: 0,
      reconciliationRequired: 0,
      authorityConsistent: true,
    });
    const complete = await observeDrain(good, clock);
    expect(complete.status).toBe('PASS');
    expect(complete.samples).toHaveLength(40);
    expect(complete.samples[0].scheduledOffsetMs).toBe(15_000);
    expect(complete.samples[39].actualOffsetMs).toBe(600_000);
    expect(clock.activeTimers()).toBe(0);
    const missedClock = observationClock();
    let reads = 0;
    const missed = await observeDrain(async () => {
      reads += 1;
      if (reads === 2) missedClock.advance(30_000);
      return good();
    }, missedClock);
    expect(missed.status).toBe('FAIL');
    expect(missed.samples.length).toBeLessThan(40);
    expect(missed.samples.some((sample: { valid: boolean }) => !sample.valid)).toBe(true);
    expect(missedClock.activeTimers()).toBe(0);
  });

  it('rejects a failing authority read, open admission and backwards observation time', async () => {
    const { observeDrain } = await preparation('observe');
    const good = {
      admissionClosed: true,
      activeRuns: 0,
      pendingEffects: 0,
      openReservations: 0,
      reconciliationRequired: 0,
      authorityConsistent: true,
    };
    const failedRead = await observeDrain(async () => {
      throw new Error('not archived');
    }, observationClock());
    expect(failedRead).toMatchObject({
      status: 'FAIL',
      samples: [{ valid: false, reason: 'authority_read_failed' }],
    });
    expect(
      await observeDrain(async () => ({ ...good, admissionClosed: false }), observationClock()),
    ).toMatchObject({ status: 'FAIL' });
    const unsafe = await observeDrain(
      async () => ({ ...good, unapprovedPayload: 'must not be archived' }),
      observationClock(),
    );
    expect(unsafe.status).toBe('FAIL');
    expect(JSON.stringify(unsafe)).not.toContain('must not be archived');
    let backwards = false;
    const monotonic = observationClock();
    const clock = {
      ...monotonic,
      wallNow: () => (backwards ? '2026-11-04T23:59:59.999Z' : monotonic.wallNow()),
    };
    expect(
      await observeDrain(async () => {
        backwards = true;
        return good;
      }, clock),
    ).toMatchObject({ status: 'FAIL' });
  });

  it('bounds an authority read that never completes and does not fabricate its sample', async () => {
    const { observeDrain } = await preparation('observe');
    let started = false;
    const clock = observationClock();
    const pending = observeDrain(async () => {
      started = true;
      return new Promise<never>(() => {});
    }, clock);
    await Promise.resolve();
    expect(started).toBe(true);
    clock.advance(15_000);
    expect(await pending).toMatchObject({
      status: 'FAIL',
      samples: [{ valid: false, reason: 'authority_read_timeout' }],
    });
    expect(clock.activeTimers()).toBe(0);
  });

  it('does not infer live readiness or accept a different candidate in preflight', async () => {
    const { inspectPreparation } = await preparation('preflight');
    const checkout = await preparationCheckout();
    await expect(inspectPreparation(root, 'not-a-commit')).rejects.toThrow(/full candidate/);
    await expect(inspectPreparation(checkout.directory, '0'.repeat(40))).rejects.toThrow(
      /Candidate changed/,
    );
  });

  it('retains #433 as a reproduced runtime blocker rather than claiming resume passed', async () => {
    const golden = JSON.parse(
      await readFile(
        join(
          root,
          'packages/workflows/contracts/workflow-checkpoint-shadow/v1/golden-vectors.json',
        ),
        'utf8',
      ),
    );
    const initial = golden.vectors.checkpointCommit.value.observation;
    const resumed = golden.vectors.resumeAdvance.value.observation;
    const state = {
      runId: resumed.runId,
      revision: resumed.revision,
      resumeGeneration: resumed.resumeGeneration,
      activeBinding: {
        ...resumed.runner,
        workflowRunId: resumed.runId,
        workflowSourceHash: resumed.workflowSourceHash,
        manifestHash: resumed.manifestHash,
        inputHash: resumed.inputHash,
      },
      checkpoints: [initial.checkpoint],
    };
    const evidence = checkpointEvidence(state as never, resumed.runner.runnerBuildHash, 0);
    expect(() => validateWorkflowCheckpointShadowEnvelope(evidence.envelope)).toThrow(
      'Observation variant is invalid',
    );
    const { preparationStatus } = await preparation('evidence');
    expect(preparationStatus()).toMatchObject({
      fullSealedResume: 'BLOCKED',
      blocker: '#433',
      realProvider: 'NOT_RUN',
    });
  });
});
