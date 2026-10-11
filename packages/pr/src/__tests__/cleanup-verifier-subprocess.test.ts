import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

// This is a structural, non-executable v1 fixture. It contains no real target,
// credentials, installation proof or qualification result; production parsing
// still validates every packaged byte and relation. Unlike prepare(), offline
// verification does not require Linux execution trust.
const seed = JSON.parse(
  readFileSync(new URL('./fixtures/cleanup-handoff-v1.json', import.meta.url), 'utf8'),
) as {
  candidateHead: string;
  files: Record<string, string>;
};
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const roots: string[] = [];
let toolRoot = '',
  verifier = '';
beforeAll(() => {
  toolRoot = mkdtempSync(join(tmpdir(), 'offline verifier tool '));
  verifier = join(toolRoot, 'verify.mjs');
  execFileSync(
    'bun',
    [
      'build',
      'scripts/cleanup-broker/verify-handoff.ts',
      '--target=node',
      '--format=esm',
      '--outfile',
      verifier,
    ],
    {
      cwd: resolve(import.meta.dirname, '../../../..'),
      stdio: 'pipe',
    },
  );
});
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
afterAll(() => rmSync(toolRoot, { recursive: true, force: true }));

function fixture(expired = false) {
  const root = mkdtempSync(join(tmpdir(), 'portable package fixture '));
  roots.push(root);
  const cwd = join(root, 'empty working directory'),
    pkg = join(root, 'package');
  mkdirSync(cwd);
  mkdirSync(pkg);
  const files = new Map(
    Object.entries(seed.files)
      .filter(([name]) => name !== 'SHA256SUMS')
      .map(([name, encoded]) => [name, Buffer.from(encoded, 'base64')]),
  );
  const taskPath = 'draft/task-dependencies.DRAFT.json';
  const task = JSON.parse(files.get(taskPath)!.toString());
  task.notBefore = new Date(Date.now() - 3600_000).toISOString();
  task.expiresAt = new Date(Date.now() + (expired ? -60_000 : 3600_000)).toISOString();
  const raw = Buffer.from(JSON.stringify(task));
  files.set(taskPath, raw);
  const attestation = JSON.parse(files.get('evidence/task-attestation.json')!.toString());
  attestation.task_view_sha256 = sha(raw);
  files.set('evidence/task-attestation.json', Buffer.from(JSON.stringify(attestation)));
  const seal = () => {
    for (const [name, bytes] of files) {
      const path = join(pkg, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes);
    }
    const sums = [...files]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, bytes]) => `${sha(bytes)}  ./${name}\n`)
      .join('');
    writeFileSync(join(pkg, 'SHA256SUMS'), sums);
    return sha(sums);
  };
  return { pkg, cwd, files, seal };
}
function run(f: ReturnType<typeof fixture>) {
  return spawnSync(
    process.execPath,
    [
      verifier,
      '--package',
      f.pkg,
      '--candidate',
      seed.candidateHead,
      '--manifest-sha256',
      f.seal(),
    ],
    {
      cwd: f.cwd,
      env: { ...process.env, PATH: '', Path: '', GH_TOKEN: '', GITHUB_TOKEN: '' },
      encoding: 'utf8',
    },
  );
}
describe('portable offline verifier through real Node on every OS', () => {
  it('accepts a fresh intact v1 fixture outside the checkout with no execution authorization', () => {
    const f = fixture(),
      result = run(f);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      valid: true,
      installationAuthorized: false,
      executionAuthorized: false,
    });
    expect(readdirSync(f.cwd)).toEqual([]);
  });
  it('returns 2 for expiry while preserving intact bytes and historical gates', () => {
    const result = run(fixture(true));
    expect(result.status, result.stderr).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      valid: true,
      unmetGates: expect.arrayContaining(['TASK_EVIDENCE_EXPIRED']),
    });
  });
  it('refuses an unknown gate without treating it as a legacy gate', () => {
    const f = fixture(),
      key = 'evidence/qualification-index.json',
      index = JSON.parse(f.files.get(key)!.toString());
    index.unmetGates.push('EXTERNAL_UNRECOGNIZED');
    f.files.set(key, Buffer.from(JSON.stringify(index)));
    const result = run(f);
    expect(result.status, result.stderr).toBe(2);
    const checked = JSON.parse(result.stdout);
    expect(checked.unknownGates).toContain('EXTERNAL_UNRECOGNIZED');
    expect(checked.unmetGates).not.toContain('EXTERNAL_UNRECOGNIZED');
  });
  it('refuses a corrupt report body even with a self-consistent manifest', () => {
    const f = fixture();
    f.files.set('evidence/build-report-a.json', Buffer.from('{"schema":'));
    const result = run(f);
    expect(result.status, result.stderr).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      valid: false,
      errors: ['HANDOFF_BUILD_MISMATCH'],
    });
  });
});
