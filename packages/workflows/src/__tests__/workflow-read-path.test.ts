import { lstat, mkdtemp, mkdir, realpath, rename, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { WorkflowReadPathContext } from '../internal/workflow-read-path.js';
import { listWorkflowRuns } from '../workflow-runs.js';
import { WorkflowRunReadContext } from '../workflow-run-projection.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function root() {
  // /var and /tmp may be aliases on macOS; evidence paths retain no-link rules.
  const path = await mkdtemp(join(await realpath(tmpdir()), 'workflow-path-'));
  roots.push(path);
  return path;
}

it('compares filesystem objects when the volume folds case', async () => {
  const base = await root(),
    mixed = join(base, 'MixedCase'),
    alias = join(base, 'mixedcase');
  await mkdir(mixed);
  const folded = await lstat(alias).then(
    () => true,
    () => false,
  );
  // The dedicated macOS job must exercise a real case-insensitive APFS volume.
  if (process.platform === 'darwin') expect(folded).toBe(true);
  const paths = new WorkflowReadPathContext();
  const original = await paths.directory(mixed, { scope: 'workspace' });
  if (folded) {
    const alternate = await paths.directory(alias, { scope: 'workspace' });
    expect([alternate.dev, alternate.ino]).toEqual([original.dev, original.ino]);
    await expect(new WorkflowRunReadContext(mixed).assertRoot(alias)).resolves.toBeUndefined();
  } else {
    await mkdir(alias);
    const different = await paths.directory(alias, { scope: 'workspace' });
    expect([different.dev, different.ino]).not.toEqual([original.dev, original.ino]);
    await expect(new WorkflowRunReadContext(mixed).assertRoot(alias)).rejects.toThrow(
      'workspace mismatch',
    );
  }
});

it('rejects directory replacement and native link aliases', async () => {
  const base = await root(),
    evidence = join(base, 'run');
  await mkdir(evidence);
  const paths = new WorkflowReadPathContext(),
    proof = await paths.directory(evidence, { scope: 'run', runId: 'run' });
  await rename(evidence, evidence + '.old');
  await mkdir(evidence);
  await expect(paths.verify(proof, { scope: 'run', runId: 'run' })).rejects.toMatchObject({
    code: 'WORKFLOW_RUN_EVIDENCE_PATH_INVALID',
  });
  const link = join(base, 'alias');
  await symlink(evidence, link, process.platform === 'win32' ? 'junction' : 'dir');
  await expect(paths.directory(link, { scope: 'workspace' })).rejects.toMatchObject({
    code: 'WORKFLOW_RUN_EVIDENCE_PATH_INVALID',
  });
});

it('awaits public list workspace validation before accessing cached evidence', async () => {
  const first = await root(),
    second = await root();
  await expect(
    listWorkflowRuns({ rootDir: second, readContext: new WorkflowRunReadContext(first) }),
  ).rejects.toThrow('workspace mismatch');
});
