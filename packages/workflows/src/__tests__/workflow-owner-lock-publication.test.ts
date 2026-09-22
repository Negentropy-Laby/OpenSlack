import { mkdirSync, renameSync, utimesSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  createPendingWorkflowEffectApproval,
  createWorkflowEffectDecisionAuthority,
} from '../workflow-effect-approval.js';
import type * as Shadow from '../workflow-control-shadow.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as FileSystem from 'node:fs/promises';

const faultDefaults = vi.hoisted(() => () => ({
  inventory: undefined as
    | undefined
    | { path: string; name: string; symlink: boolean; removeFinal: boolean },
  finalOpenFailure: false,
  closeChangesCtime: false,
  initialStatFailure: false,
  postLinkStatFailure: false,
  linkedTarget: '',
  directoryCtime: undefined as undefined | { path: string; value: bigint },
  beforeWrite: undefined as undefined | ((path: string) => Promise<void>),
  beforeLink: undefined as undefined | ((source: string, target: string) => Promise<void>),
}));
const faults = vi.hoisted(() => faultDefaults());
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof FileSystem>();
  return {
    ...fs,
    readdir: async (...args: Parameters<typeof fs.readdir>) => {
      const entries = await fs.readdir(...args);
      const inventory = faults.inventory;
      if (inventory && String(args[0]) === inventory.path) {
        faults.inventory = undefined;
        if (inventory.removeFinal) {
          await fs.unlink(join(inventory.path, 'authority.lock'));
          return entries;
        }
        return [
          ...entries,
          {
            name: inventory.name,
            isFile: () => !inventory.symlink,
            isSymbolicLink: () => inventory.symlink,
          },
        ];
      }
      return entries;
    },
    open: async (...args: Parameters<typeof fs.open>) => {
      if (faults.finalOpenFailure && String(args[0]) === faults.linkedTarget) {
        faults.finalOpenFailure = false;
        throw new Error('fixture final handle open failure');
      }
      const handle = await fs.open(...args);
      const close = handle.close.bind(handle);
      handle.close = async () => {
        await close();
        if (faults.closeChangesCtime && faults.linkedTarget && String(args[0]).endsWith('.tmp')) {
          faults.closeChangesCtime = false;
          await fs.chmod(faults.linkedTarget, (await fs.stat(faults.linkedTarget)).mode);
        }
      };
      const stat = handle.stat.bind(handle);
      handle.stat = ((...statArgs: Parameters<typeof stat>) => {
        if (faults.initialStatFailure) {
          faults.initialStatFailure = false;
          return Promise.reject(new Error('fixture initial stat failure'));
        }
        return stat(...statArgs);
      }) as typeof handle.stat;
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async (...writeArgs: Parameters<typeof write>) => {
        await faults.beforeWrite?.(String(args[0]));
        return write(...writeArgs);
      };
      return handle;
    },
    lstat: async (...args: Parameters<typeof fs.lstat>) => {
      if (faults.postLinkStatFailure && String(args[0]) === faults.linkedTarget) {
        faults.postLinkStatFailure = false;
        throw new Error('fixture post-link stat failure');
      }
      const stat = await fs.lstat(...args);
      if (faults.directoryCtime?.path === String(args[0])) {
        // Model a specific metadata transition, independently of host ctime
        // resolution. Keep the real directory identity and all other metadata.
        return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
          ctimeNs: faults.directoryCtime.value,
        });
      }
      return stat;
    },
    link: async (source: string, target: string) => {
      await faults.beforeLink?.(source, target);
      await fs.link(source, target);
      faults.linkedTarget = target;
    },
  };
});
vi.mock('../workflow-control-shadow.js', async (original) => ({
  ...(await original<typeof Shadow>()),
  productionJournalSecurity: () => security,
}));
import {
  acquireOwnerJournalLock,
  assertOwnerDirectory,
  ensureOwnerDirectory,
  isOwnerJournalLockTemporary,
  type WorkflowControlShadowJournalSecurityDependencies,
} from '../workflow-control-shadow.js';

const roots: string[] = [];
const security: WorkflowControlShadowJournalSecurityDependencies = {
  platform: 'win32',
  currentWindowsSid: () => 'S-1-5-21-1000-1001-1002-1003',
  hardenPath: () => undefined,
  readWindowsPathSecurity: () => ({
    owner: 'S-1-5-21-1000-1001-1002-1003',
    protected: true,
    reparse: false,
    rules: [{ sid: 'S-1-5-21-1000-1001-1002-1003', type: 'Allow' }],
  }),
};
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'owner-lock-publication-'));
  roots.push(root);
  const locks = join(root, 'locks');
  await mkdir(locks, { mode: 0o700 });
  return locks;
}
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(async () => {
  Object.assign(faults, faultDefaults());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('owner lock publication', () => {
  it('never exposes an unfinished lock to a competing owner', async () => {
    const root = await fixture();
    const writing = gate();
    const finish = gate();
    let held = false;
    faults.beforeWrite = async () => {
      if (held) return;
      held = true;
      writing.resolve();
      await finish.promise;
    };
    const first = acquireOwnerJournalLock(root, 'authority', security);
    // Observe rejection immediately, while retaining the original result below.
    void first.catch(() => undefined);
    let releaseSecond: (() => Promise<void>) | undefined;
    try {
      await writing.promise;
      releaseSecond = await acquireOwnerJournalLock(root, 'authority', security);
      const body = JSON.parse(await readFile(join(root, 'authority.lock'), 'utf8'));
      expect(body.schema).toBe('openslack.workflow_control_shadow_journal_lock.v1');
      await releaseSecond();
      releaseSecond = undefined;
    } finally {
      if (releaseSecond) await releaseSecond();
      finish.resolve();
      await (
        await first
      )();
    }
    expect(await readdir(root)).toEqual([]);
  });

  it('preserves a stable malformed incumbent rather than treating it as construction', async () => {
    const root = await fixture();
    const path = join(root, 'authority.lock');
    await writeFile(path, '', { mode: 0o600 });
    await expect(acquireOwnerJournalLock(root, 'authority', security)).rejects.toThrow();
    expect(await readFile(path, 'utf8')).toBe('');
    expect(await readdir(root)).toEqual(['authority.lock']);
  });

  it('refuses ownership of a replaced temporary and preserves its evidence', async () => {
    const root = await fixture();
    let replacement = '';
    faults.beforeLink = async (source) => {
      replacement = source;
      await rename(source, join(root, 'original-evidence'));
      await writeFile(source, 'foreign replacement', { mode: 0o600 });
    };
    await expect(acquireOwnerJournalLock(root, 'authority', security)).rejects.toThrow(
      /publication and cleanup failed/u,
    );
    expect(await readFile(replacement, 'utf8')).toBe('foreign replacement');
    expect(await readFile(join(root, 'original-evidence'), 'utf8')).toContain('journal_lock.v1');
    // A replacement raced the link syscall; fail closed and preserve its evidence.
    expect(await readFile(join(root, 'authority.lock'), 'utf8')).toBe('foreign replacement');
  });

  it('cleans its construction file when permission hardening fails', async () => {
    const root = await fixture();
    await expect(
      acquireOwnerJournalLock(root, 'authority', {
        ...security,
        hardenPath: () => {
          throw new Error('fixture hardening rejected');
        },
      }),
    ).rejects.toThrow('fixture hardening rejected');
    expect(await readdir(root)).toEqual([]);
  });

  it('closes the handle when its first identity read fails', async () => {
    const root = await fixture();
    faults.initialStatFailure = true;
    await expect(acquireOwnerJournalLock(root, 'authority', security)).rejects.toThrow();
    expect(await readdir(root)).toHaveLength(1);
    // No identity was captured: preserve the unknown temporary, but release its handle.
    await rm(root, { recursive: true });
  });

  it('removes its final lock after a post-link identity read fails', async () => {
    const root = await fixture();
    faults.postLinkStatFailure = true;
    await expect(acquireOwnerJournalLock(root, 'authority', security)).rejects.toThrow(
      'fixture post-link stat failure',
    );
    expect(await readdir(root)).toEqual([]);
  });

  it('removes its own lock when final ACL validation fails after temporary unlink', async () => {
    const root = await fixture();
    await expect(
      acquireOwnerJournalLock(root, 'authority', {
        ...security,
        readWindowsPathSecurity: (path, identity, cacheable) => {
          if (path.endsWith('authority.lock')) throw new Error('fixture final ACL failure');
          return security.readWindowsPathSecurity!(path, identity, cacheable);
        },
      }),
    ).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
  });

  it('keeps the post-close identity for caller initialization cleanup', async () => {
    const root = await fixture();
    faults.closeChangesCtime = true;
    faults.finalOpenFailure = true;
    await expect(acquireOwnerJournalLock(root, 'authority', security)).rejects.toThrow(
      'fixture final handle open failure',
    );
    expect(await readdir(root)).toEqual([]);
  });

  describe.each([
    ['assert', assertOwnerDirectory],
    ['ensure', ensureOwnerDirectory],
  ] as const)('%s directory during lock publication', (_name, validate) => {
    it('allows child churn and checks the refreshed ACL identity', async () => {
      const root = await fixture();
      faults.directoryCtime = { path: root, value: 1n };
      const identities: unknown[] = [];
      await expect(
        validate(root, {
          ...security,
          readWindowsPathSecurity: (path, identity, cacheable) => {
            identities.push(identity);
            if (identities.length === 1) {
              writeFileSync(join(root, 'child'), 'owned child');
              faults.directoryCtime!.value = 2n;
            }
            return security.readWindowsPathSecurity!(path, identity, cacheable);
          },
        }),
      ).resolves.toBe(root);
      expect(identities).toHaveLength(2);
      expect(identities[0]).not.toEqual(identities[1]);
    });

    it('rejects a replacement directory during ACL inspection', async () => {
      const root = await fixture();
      let replaced = false;
      await expect(
        validate(root, {
          ...security,
          readWindowsPathSecurity: (path, identity, cacheable) => {
            if (!replaced) {
              replaced = true;
              renameSync(root, root + '-evidence');
              mkdirSync(root, { mode: 0o700 });
            }
            return security.readWindowsPathSecurity!(path, identity, cacheable);
          },
        }),
      ).rejects.toThrow(/directory changed/u);
    });

    it('rejects a safe ACL snapshot invalidated during the refreshed read', async () => {
      const root = await fixture();
      let reads = 0;
      await expect(
        validate(root, {
          ...security,
          readWindowsPathSecurity: (path, identity, cacheable) => {
            reads += 1;
            if (reads <= 2) {
              // The first change forces refresh. The second models a safe Get-Acl
              // snapshot followed by a DACL mutation before that read returns.
              writeFileSync(join(root, `acl-identity-change-${reads}`), 'changed metadata');
              const timestamp = new Date(1_800_000_000_000 + reads * 1000);
              utimesSync(root, timestamp, timestamp);
              return security.readWindowsPathSecurity!(path, identity, cacheable);
            }
            return {
              owner: 'S-1-5-21-1000-1001-1002-1003',
              protected: false,
              reparse: false,
              rules: [],
            };
          },
        }),
      ).rejects.toThrow(/ACL is not owner-only/u);
      expect(reads).toBe(3);
    });

    it('fails closed when repeated metadata drift prevents stable ACL proof', async () => {
      const root = await fixture();
      let reads = 0;
      await expect(
        validate(root, {
          ...security,
          readWindowsPathSecurity: (path, identity, cacheable) => {
            reads += 1;
            writeFileSync(join(root, `child-${reads}`), 'changed metadata');
            const timestamp = new Date(1_800_000_000_000 + reads * 1000);
            utimesSync(root, timestamp, timestamp);
            return security.readWindowsPathSecurity!(path, identity, cacheable);
          },
        }),
      ).rejects.toThrow(/security identity did not stabilize/u);
      expect(reads).toBe(4); // Initial lookup plus three bounded refresh attempts.
    });

    it('rejects an unsafe ACL instead of accepting timestamp drift', async () => {
      const root = await fixture();
      let reads = 0;
      await expect(
        validate(root, {
          ...security,
          readWindowsPathSecurity: (path, identity, cacheable) => {
            reads += 1;
            if (reads === 1) {
              writeFileSync(join(root, 'child'), 'owned child');
              return security.readWindowsPathSecurity!(path, identity, cacheable);
            }
            return {
              owner: 'S-1-5-21-1000-1001-1002-1003',
              protected: false,
              reparse: false,
              rules: [],
            };
          },
        }),
      ).rejects.toThrow(/ACL is not owner-only/u);
      expect(reads).toBe(2);
    });
  });

  it.each([
    {
      kind: 'recognized temporary',
      name: `.authority.lock.123.${randomUUID()}.tmp`,
      symlink: false,
      removeFinal: false,
      accepted: true,
    },
    {
      kind: 'unknown entry',
      name: 'unknown.tmp',
      symlink: false,
      removeFinal: false,
      accepted: false,
    },
    {
      kind: 'symlink temporary',
      name: `.authority.lock.123.${randomUUID()}.tmp`,
      symlink: true,
      removeFinal: false,
      accepted: false,
    },
    {
      kind: 'held final lock',
      name: 'authority.lock',
      symlink: false,
      removeFinal: true,
      accepted: false,
    },
  ])(
    'authority scan handles a disappearing $kind',
    async ({ name, symlink, removeFinal, accepted }) => {
      const parent = dirname(await fixture());
      const authorityRoot = join(parent, 'effect-authority');
      await mkdir(authorityRoot, { mode: 0o700 });
      faults.inventory = { path: join(authorityRoot, 'locks'), name, symlink, removeFinal };
      const now = Date.now();
      const pending = createPendingWorkflowEffectApproval({
        runId: 'run-1',
        approvalId: 'approval-1',
        correlationId: 'correlation-1',
        workflowId: 'fixture.audit',
        workflowVersion: '1.0.0',
        workflowHash: 'a'.repeat(64),
        inputHash: 'b'.repeat(64),
        effectId: `workflow-effect:sha256:${'c'.repeat(64)}`,
        effectHash: 'c'.repeat(64),
        requiredCapability: 'workflow.effect.decide',
        createdAt: new Date(now - 1000).toISOString(),
        expiresAt: new Date(now + 60000).toISOString(),
      });
      const binding = createWorkflowEffectDecisionAuthority({
        workspaceId: 'workspace-fixture',
        humanPrincipalIds: ['fixture-reviewer'],
        capabilities: ['workflow.effect.decide'],
        maxBindingTtlMs: 60000,
      }).issueHumanDecisionBinding({
        principalId: 'fixture-reviewer',
        capability: 'workflow.effect.decide',
        runId: pending.runId,
        approvalId: pending.approvalId,
        correlationId: pending.correlationId,
        approvalExpiresAt: pending.expiresAt,
        decision: 'approved',
        reasonHash: 'd'.repeat(64),
        expiresAt: new Date(now + 30000).toISOString(),
      });
      const { prepareWorkflowEffectAuthorityDecision } =
        await import('../workflow-effect-authority-store.js');
      const operation = prepareWorkflowEffectAuthorityDecision(
        join(parent, 'effect-approvals'),
        pending,
        pending,
        binding,
      );
      if (accepted) await expect(operation).resolves.toEqual(pending);
      else await expect(operation).rejects.toThrow();
      expect(faults.inventory).toBeUndefined();
    },
  );

  it('accepts only bounded construction names for the specified lock', () => {
    const name = `.authority.lock.123.${randomUUID()}.tmp`;
    expect(isOwnerJournalLockTemporary(name, 'authority.lock')).toBe(true);
    for (const invalid of [
      name.replace('authority', 'other'),
      name + '.extra',
      '.authority.lock.tmp',
      name.replace('.123.', '.0.'),
      name.replace('.123.', '.4294967296.'),
      '../' + name,
    ]) {
      expect(isOwnerJournalLockTemporary(invalid, 'authority.lock')).toBe(false);
    }
  });
});
