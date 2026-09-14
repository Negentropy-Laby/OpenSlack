import * as fs from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return {
    ...actual,
    linkSync: vi.fn(actual.linkSync),
    rmdirSync: vi.fn(actual.rmdirSync),
    writeFileSync: vi.fn(actual.writeFileSync),
  };
});
import { digest, publishOnboarding } from '../onboarding-publication.js';
const roots: string[] = [];
const docs = [
  { name: 'START_HERE.md', content: 'start' },
  { name: 'prompt.md', content: 'prompt' },
];
const registry = 'registry fixture';
let actual: typeof fs;
beforeEach(async () => {
  actual = await vi.importActual('node:fs');
});
afterEach(() => {
  vi.mocked(fs.linkSync).mockImplementation(actual.linkSync);
  vi.mocked(fs.rmdirSync).mockImplementation(actual.rmdirSync);
  vi.mocked(fs.writeFileSync).mockImplementation(actual.writeFileSync);
  for (const root of roots.splice(0)) actual.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), 'publish onboarding '));
  roots.push(root);
  return root;
}
function paths(root: string) {
  return {
    txn: join(root, '.openslack/agents/onboarding/.hire-safe'),
    target: join(root, '.openslack/agents/onboarding/safe'),
    registry: join(root, '.openslack/agents/registry/safe.yaml'),
  };
}
function stage(root: string, dead = true) {
  const { txn } = paths(root);
  fs.mkdirSync(txn, { recursive: true });
  for (const doc of docs) fs.writeFileSync(join(txn, doc.name), doc.content);
  fs.writeFileSync(join(txn, 'registry.yaml'), registry);
  const pid = dead ? spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid : process.pid;
  fs.writeFileSync(
    join(txn, 'journal.json'),
    JSON.stringify({
      schema: 1,
      agentId: 'safe',
      inputHash: 'input',
      owner: { pid, host: hostname() },
      hashes: Object.fromEntries(
        [...docs, { name: 'registry.yaml', content: registry }].map((d) => [
          d.name,
          digest(d.content),
        ]),
      ),
    }),
  );
}
const publish = (root: string, inputHash = 'input') =>
  publishOnboarding(root, 'safe', inputHash, docs, registry);

describe('recoverable onboarding publication', () => {
  it('publishes complete documents before the registry commit marker', () => {
    const root = fixture();
    const { target, registry: destination, txn } = paths(root);
    vi.mocked(fs.linkSync).mockImplementation((source, dest) => {
      if (dest === destination)
        for (const doc of docs)
          expect(fs.readFileSync(join(target, doc.name), 'utf8')).toBe(doc.content);
      actual.linkSync(source, dest);
    });
    publish(root);
    expect(fs.readFileSync(destination, 'utf8')).toBe(registry);
    expect(fs.existsSync(txn)).toBe(false);
  });
  it('cleans a staging write failure and allows a retry', () => {
    const root = fixture();
    vi.mocked(fs.writeFileSync).mockImplementationOnce(() => {
      throw new Error('ENOSPC absolute private path');
    });
    expect(() => publish(root)).toThrow('AGENT_HIRE_IO_FAILED');
    expect(fs.existsSync(paths(root).txn)).toBe(false);
    publish(root);
    expect(fs.existsSync(paths(root).registry)).toBe(true);
  });
  it('rolls back only its publications after a later link fails, then retries successfully', () => {
    const root = fixture();
    let calls = 0;
    vi.mocked(fs.linkSync).mockImplementation((source, dest) => {
      if (++calls === 2) throw new Error('EBUSY machine-path');
      actual.linkSync(source, dest);
    });
    expect(() => publish(root)).toThrow('AGENT_HIRE_IO_FAILED');
    expect(fs.existsSync(paths(root).target)).toBe(false);
    expect(fs.existsSync(paths(root).registry)).toBe(false);
    vi.mocked(fs.linkSync).mockImplementation(actual.linkSync);
    publish(root);
  });
  it('preserves a manually modified hard link and its evidence on failure', () => {
    const root = fixture();
    const { target, txn } = paths(root);
    let calls = 0;
    vi.mocked(fs.linkSync).mockImplementation((source, dest) => {
      if (++calls === 2) {
        fs.writeFileSync(join(target, docs[0].name), 'manual edit');
        throw new Error('failure');
      }
      actual.linkSync(source, dest);
    });
    expect(() => publish(root)).toThrow('AGENT_HIRE_IO_FAILED');
    expect(fs.readFileSync(join(target, docs[0].name), 'utf8')).toBe('manual edit');
    expect(fs.existsSync(txn)).toBe(true);
  });
  it('rejects a concurrent live writer without changing its journal', () => {
    const root = fixture();
    stage(root, false);
    const path = join(paths(root).txn, 'journal.json');
    const before = fs.readFileSync(path, 'utf8');
    expect(() => publish(root)).toThrow('AGENT_HIRE_BUSY');
    expect(fs.readFileSync(path, 'utf8')).toBe(before);
    expect(fs.existsSync(paths(root).registry)).toBe(false);
  });
  it.each(['staged', 'partial', 'committed'])(
    'recovers a dead writer at phase %s without rewriting historical registry bytes',
    (phase) => {
      const root = fixture();
      stage(root);
      const { txn, target, registry: destination } = paths(root);
      if (phase !== 'staged') {
        fs.mkdirSync(target);
        fs.linkSync(join(txn, docs[0].name), join(target, docs[0].name));
      }
      if (phase === 'committed') {
        fs.linkSync(join(txn, docs[1].name), join(target, docs[1].name));
        fs.mkdirSync(join(root, '.openslack/agents/registry'));
        fs.linkSync(join(txn, 'registry.yaml'), destination);
      }
      publish(root);
      expect(fs.readFileSync(destination, 'utf8')).toBe(registry);
      expect(fs.existsSync(txn)).toBe(false);
    },
  );
  it('rejects changed stable generation input while preserving recovery evidence', () => {
    const root = fixture();
    stage(root);
    expect(() => publish(root, 'changed-registry-semantics')).toThrow(
      'AGENT_HIRE_RECOVERY_REQUIRED',
    );
    expect(fs.existsSync(paths(root).txn)).toBe(true);
  });
  it.each(['unknown', 'manual', 'staged-corrupt', 'recovery-interrupted', 'unknown-file'])(
    'refuses unsafe recovery state %s',
    (state) => {
      const root = fixture();
      const { txn, target } = paths(root);
      if (state === 'unknown') fs.mkdirSync(txn, { recursive: true });
      else {
        stage(root);
        if (state === 'manual') {
          fs.mkdirSync(target);
          fs.writeFileSync(join(target, 'START_HERE.md'), 'manual');
        }
        if (state === 'staged-corrupt') fs.writeFileSync(join(txn, 'START_HERE.md'), 'corrupt');
        if (state === 'unknown-file') fs.writeFileSync(join(txn, 'manual-notes.md'), 'preserve');
        if (state === 'recovery-interrupted')
          fs.writeFileSync(join(txn, 'recovery.lock'), 'interrupted');
      }
      expect(() => publish(root)).toThrow('AGENT_HIRE_RECOVERY_REQUIRED');
      expect(fs.existsSync(paths(root).registry)).toBe(false);
      expect(fs.existsSync(txn)).toBe(true);
    },
  );
  it('does not overwrite an existing identity or unrecognized onboarding directory', () => {
    const root = fixture();
    publish(root);
    const before = fs.readFileSync(paths(root).registry);
    expect(() => publish(root)).toThrow('AGENT_HIRE_EXISTS');
    expect(fs.readFileSync(paths(root).registry)).toEqual(before);
    const other = fixture();
    fs.mkdirSync(paths(other).target, { recursive: true });
    expect(() => publish(other)).toThrow('AGENT_HIRE_EXISTS');
  });
  it('preserves an unknown file added during final cleanup', () => {
    const root = fixture();
    const { txn, registry: destination } = paths(root);
    vi.mocked(fs.rmdirSync).mockImplementation((path) => {
      if (path === txn) fs.writeFileSync(join(txn, 'late-notes.md'), 'manual');
      actual.rmdirSync(path);
    });
    expect(() => publish(root)).toThrow('AGENT_HIRE_CLEANUP_REQUIRED');
    expect(fs.readFileSync(join(txn, 'late-notes.md'), 'utf8')).toBe('manual');
    expect(fs.existsSync(destination)).toBe(true);
  });
  it.each([false, true])(
    'wraps cleanup failures without leaking paths (committed=%s)',
    (committed) => {
      const root = fixture();
      if (!committed)
        vi.mocked(fs.linkSync).mockImplementation(() => {
          throw new Error('disk failure');
        });
      vi.mocked(fs.rmdirSync).mockImplementation((path) => {
        if (path === paths(root).txn) throw new Error(`EPERM ${root}`);
        actual.rmdirSync(path);
      });
      try {
        publish(root);
        throw new Error('expected failure');
      } catch (error) {
        expect(String(error)).toContain('AGENT_HIRE_CLEANUP_REQUIRED');
        expect(String(error)).not.toContain(root);
        if (committed) expect(String(error)).toContain('publication completed');
      }
      expect(fs.existsSync(paths(root).registry)).toBe(committed);
    },
  );
});
