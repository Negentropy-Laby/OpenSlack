import { it as test, onTestFinished, afterEach, vi } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
  testExecutable,
  testProcessEnvironment,
} from '../../../../scripts/testing/process-fixture.mjs';
import {
  BINDINGS,
  main,
  humanGhEnvironment,
  fixtureCommandDiagnostic,
} from '../internal/cleanup-qualification-fixtures.mjs';

const NOW = '2026-10-11T12:34:56.000Z';
const API = `repos/${BINDINGS.repository}`;
const sha = (number) => number.toString(16).padStart(40, '0');
const load = (directory) =>
  JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
const write = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
test('loads an existing v1 fixture plan with its original binding field order without migration', async () => {
  const f = fixture(),
    batch = await f.plan(),
    planPath = path.join(batch, 'plan.json');
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  plan.bindings = {
    host: BINDINGS.host,
    repository: BINDINGS.repository,
    repositoryId: BINDINGS.repositoryId,
    defaultBranch: BINDINGS.defaultBranch,
    login: BINDINGS.login,
    userId: BINDINGS.userId,
  };
  write(planPath, plan);
  const record = load(batch);
  record.planSHA256 = createHash('sha256').update(fs.readFileSync(planPath)).digest('hex');
  write(path.join(batch, 'manifest.json'), record);
  const planBefore = fs.readFileSync(planPath),
    manifestBefore = fs.readFileSync(path.join(batch, 'manifest.json'));
  await f.run('inspect', batch);
  assert.deepEqual(f.state.mutations, []);
  assert(fs.readFileSync(planPath).equals(planBefore));
  assert(fs.readFileSync(path.join(batch, 'manifest.json')).equals(manifestBefore));
});
test('command diagnostics preserve status, signal and actual error while bounding redacted UTF-8 bytes', () => {
  const stderr =
    'failed: ghp_fixtureSecret123\nAuthorization: Bearer fixture-secret\n' + 'é'.repeat(40_000);
  const result = fixtureCommandDiagnostic({
    status: null,
    signal: 'SIGTERM',
    error: { code: 'EIO' },
    stderr,
  });
  assert.equal(result.status, null);
  assert.equal(result.signal, 'SIGTERM');
  assert.equal(result.error, 'EIO');
  assert(Buffer.byteLength(result.stderr) <= 32 * 1024);
  assert(!result.stderr.includes('fixtureSecret') && !result.stderr.includes('fixture-secret'));
  assert(!result.stderr.includes('\uFFFD'));
});
const publicationFault = vi.hoisted(() => ({
  active: false,
  lockFstat: false,
  lockPublicationSync: false,
  terminalLockRequired: false,
  terminalFailure: false,
  concurrentTerminalObservation: false,
  lockFds: new Set(),
}));
vi.mock('node:fs', async (original) => {
  const actual = await original();
  return {
    ...actual,
    openSync: (...args) => {
      if (
        publicationFault.concurrentTerminalObservation &&
        /[\\/]mutation\.lock$/.test(String(args[0]))
      ) {
        const directory = path.dirname(String(args[0]));
        const recordPath = path.join(directory, 'manifest.json');
        if (actual.existsSync(recordPath)) {
          const record = JSON.parse(actual.readFileSync(recordPath, 'utf8'));
          if (
            record.phase === 'MERGE_TARGETS_PARTIAL' &&
            record.fixtures
              .filter((item) => item.disposition.startsWith('human-merge'))
              .every((item) => item.pr.merged)
          ) {
            record.fork = {
              state: 'BLOCKED_SEPARATE_FORK_AUTHORIZATION_REQUIRED',
              concurrentObservation: true,
            };
            actual.writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n');
            publicationFault.concurrentTerminalObservation = false;
          }
        }
      }
      const fd = actual.openSync(...args);
      if (/[\\/]mutation\.lock$/.test(String(args[0]))) publicationFault.lockFds.add(fd);
      return fd;
    },
    closeSync: (fd) => {
      publicationFault.lockFds.delete(fd);
      return actual.closeSync(fd);
    },
    fstatSync: (...args) => {
      if (publicationFault.lockFstat && publicationFault.lockFds.has(args[0]))
        throw Object.assign(new Error('fixture lock fstat failed'), { code: 'EIO' });
      return actual.fstatSync(...args);
    },
    fsyncSync: (fd) => {
      if (
        publicationFault.lockPublicationSync &&
        publicationFault.lockFds.size &&
        (actual.fstatSync(fd).isDirectory() ||
          (process.platform === 'win32' && publicationFault.lockFds.has(fd)))
      )
        throw Object.assign(new Error('fixture lock directory sync failed'), { code: 'EIO' });
      return actual.fsyncSync(fd);
    },
    renameSync: (source, target) => {
      if (/manifest\.json\.owned-/.test(String(source))) {
        const record = JSON.parse(actual.readFileSync(source, 'utf8'));
        if (record.phase === 'MERGED_TARGETS' && publicationFault.terminalLockRequired)
          assert.equal(
            publicationFault.lockFds.size,
            1,
            'terminal publication requires an owned lock',
          );
        if (record.phase === 'MERGED_TARGETS' && publicationFault.terminalFailure)
          throw Object.assign(new Error('terminal publication failed'), { code: 'EIO' });
      }
      if (publicationFault.active && /manifest\.json\.owned-/.test(String(source)))
        throw Object.assign(new Error('fixture terminal-state publication failed'), {
          code: 'EIO',
        });
      return actual.renameSync(source, target);
    },
  };
});
afterEach(() => {
  publicationFault.active = false;
  publicationFault.lockFstat = false;
  publicationFault.lockPublicationSync = false;
  publicationFault.terminalLockRequired = false;
  publicationFault.terminalFailure = false;
  publicationFault.concurrentTerminalObservation = false;
  for (const fd of publicationFault.lockFds) fs.closeSync(fd);
});

test('terminal merge bookkeeping is locked without an extra remote mutation or confirmation', async () => {
  const f = fixture();
  const batch = await f.plan();
  await f.run('create', batch);
  await f.run('close-case', batch);
  f.state.calls.length = 0;
  publicationFault.terminalLockRequired = true;
  await f.run('merge-targets', batch);
  assert.equal(load(batch).phase, 'MERGED_TARGETS');
  assert.equal(f.state.mutations.filter((x) => x.args?.[1] === 'merge').length, 5);
  // One initial identity/repository/main observation, plus one fresh admission
  // after each of the five human confirmations; none is treated as permanent.
  assert.equal(f.state.calls.filter((x) => x.args.at(-1) === 'user').length, 6);
  assert.equal(f.state.calls.filter((x) => x.args.at(-1) === API).length, 6);
});

test('terminal bookkeeping publication failure retains recovery lock', async () => {
  const f = fixture();
  const batch = await f.plan();
  await f.run('create', batch);
  await f.run('close-case', batch);
  publicationFault.terminalFailure = true;
  await assert.rejects(f.run('merge-targets', batch), { code: 'EIO' });
  assert.equal(fs.existsSync(path.join(batch, 'mutation.lock')), true);
  assert.equal(f.state.mutations.filter((x) => x.args?.[1] === 'merge').length, 5);
});

test('terminal bookkeeping refuses a concurrently recorded observation instead of overwriting it', async () => {
  const f = fixture();
  const batch = await f.plan();
  await f.run('create', batch);
  await f.run('close-case', batch);
  publicationFault.concurrentTerminalObservation = true;
  await assert.rejects(f.run('merge-targets', batch), { code: 'FIXTURE_LOCAL_RECORD_CHANGED' });
  assert.equal(load(batch).fork.concurrentObservation, true);
  assert.equal(f.state.mutations.filter((x) => x.args?.[1] === 'merge').length, 5);
  assert.equal(fs.existsSync(path.join(batch, 'mutation.lock')), true);
});

test.each(['lockFstat', 'lockPublicationSync'])(
  'phase lock %s failure closes every acquired lock descriptor without mutation',
  async (fault) => {
    const f = fixture();
    const batch = await f.plan();
    publicationFault[fault] = true;
    await assert.rejects(f.run('create', batch), { code: 'EIO' });
    assert.equal(publicationFault.lockFds.size, 0);
    assert.deepEqual(f.state.mutations, []);
    assert.equal(fs.existsSync(path.join(batch, 'mutation.lock')), true);
  },
);

test.each(['parent', 'disposition', 'unknown-top-level'])(
  'manifest %s drift refuses before confirmation or remote calls',
  async (field) => {
    const f = fixture();
    const batch = await f.plan();
    const record = load(batch);
    if (field === 'unknown-top-level') record.unreviewed = true;
    else record.fixtures[0][field] = field === 'parent' ? 'foreign-parent' : 'human-merge';
    write(path.join(batch, 'manifest.json'), record);
    f.state.calls.length = 0;
    f.dependencies.confirm = async () => {
      throw new Error('unexpected confirmation');
    };
    await assert.rejects(f.run('create', batch), { code: 'FIXTURE_MANIFEST_INVALID' });
    assert.deepEqual(f.state.calls, []);
  },
);

test('unknown mutation plus terminal publication failure retains the durable lock and cannot resend', async () => {
  const f = fixture();
  const batch = await f.plan();
  f.state.mutationFailure = () => {
    publicationFault.active = true;
    return true;
  };
  await assert.rejects(
    f.run('create', batch),
    (error) => error.code === 'FIXTURE_GH_FAILED' && error.persistenceFailure === 'EIO',
  );
  assert.equal(fs.existsSync(path.join(batch, 'mutation.lock')), true);
  assert.equal(f.state.mutations.length, 1);
  publicationFault.active = false;
  await assert.rejects(f.run('create', batch));
  assert.equal(f.state.mutations.length, 1);
  assert.equal(load(batch).phase, 'PLANNED_READ_ONLY');
  assert.match(fs.readFileSync(path.join(batch, 'execution-log.jsonl'), 'utf8'), /INTENT/);
});

test('planning refuses a parent-directory link before creating any outside evidence', async (t) => {
  const f = fixture(t);
  const outside = path.join(f.root, 'outside');
  fs.mkdirSync(outside);
  const alias = path.join(f.root, 'linked-parent');
  fs.symlinkSync(outside, alias, 'junction');
  await assert.rejects(main(['plan', '--scratch-root', path.join(alias, 'new')], f.dependencies));
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.deepEqual(f.state.mutations, []);
});

test('directory replacement during confirmation refuses every remote mutation and outside write', async (t) => {
  const f = fixture(t);
  const batch = await f.plan();
  const outside = path.join(f.root, 'outside');
  fs.mkdirSync(outside);
  f.dependencies.confirm = async () => {
    fs.renameSync(batch, batch + '.preserved');
    fs.symlinkSync(outside, batch, 'junction');
    return true;
  };
  await assert.rejects(f.run('create', batch));
  assert.deepEqual(f.state.mutations, []);
  assert.deepEqual(fs.readdirSync(outside), []);
});

function fixture(t, changes = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup fixture with spaces-'));
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  let counter = 10;
  const state = {
    calls: [],
    mutations: [],
    confirmations: [],
    denied: false,
    mutationFailure: null,
    main: sha(1),
    user: { type: 'User', login: 'wsman', id: 21962212 },
    repository: {
      id: 1380965476,
      full_name: BINDINGS.repository,
      private: true,
      default_branch: 'main',
      delete_branch_on_merge: false,
      permissions: { push: true },
    },
    refs: new Map([['main', sha(1)]]),
    commits: new Map([[sha(1), { sha: sha(1), tree: { sha: sha(2) } }]]),
    prs: new Map(),
    ...changes,
  };
  const response = (object) => ({ status: 0, stdout: JSON.stringify(object) });
  const failure = () => ({
    status: 1,
    stdout: '',
    stderr: 'stub failure; never copied into evidence',
  });
  const dependencies = {
    now: () => NOW,
    log: () => {},
    confirm: async (phrase, explanation) => {
      state.confirmations.push({ phrase, explanation });
      return !state.denied;
    },
    runCommand: async (args, input) => {
      state.calls.push({ args, input });
      assert.equal(args.includes('--admin'), false);
      assert.equal(args.includes('--auto'), false);
      assert.equal(
        args.some((arg) => arg.startsWith('--delete-branch')),
        false,
      );
      assert.equal(args.includes('--approve'), false);
      if (args[0] === 'pr') {
        assert.equal(args[3], '--repo');
        assert.equal(args[4], `https://github.com/${BINDINGS.repository}`);
        assert(['merge', 'close'].includes(args[1]));
        state.mutations.push({ args });
        if (state.mutationFailure?.(args)) return failure();
        const pr = state.prs.get(Number(args[2]));
        assert(pr);
        if (args[1] === 'close') {
          pr.state = 'closed';
          pr.merged = false;
        }
        if (args[1] === 'merge') {
          assert.deepEqual(args.slice(5), ['--merge']);
          pr.state = 'closed';
          pr.merged = true;
          pr.merged_at = NOW;
          state.main = sha(counter++);
          state.refs.set('main', state.main);
          state.commits.set(state.main, { sha: state.main, tree: { sha: sha(counter++) } });
        }
        return { status: 0, stdout: 'human fixture result' };
      }
      assert.deepEqual(args.slice(0, 5), ['api', '--hostname', 'github.com', '--method', args[4]]);
      const method = args[4];
      const endpoint = args[5];
      assert(method !== 'DELETE');
      assert(endpoint === 'user' || endpoint === API || endpoint.startsWith(`${API}/`));
      const payload = input === undefined ? null : JSON.parse(input);
      if (method !== 'GET') {
        state.mutations.push({ method, endpoint, payload });
        if (state.mutationFailure?.(args, payload)) return failure();
      }
      if (endpoint === 'user') return response(state.user);
      if (endpoint === API) return response(state.repository);
      if (endpoint.startsWith(`${API}/git/ref/heads/`)) {
        const branch = decodeURIComponent(endpoint.slice(`${API}/git/ref/heads/`.length));
        return state.refs.has(branch)
          ? response({ ref: `refs/heads/${branch}`, object: { sha: state.refs.get(branch) } })
          : failure();
      }
      if (method === 'GET' && endpoint.startsWith(`${API}/git/commits/`))
        return response(state.commits.get(endpoint.split('/').at(-1)));
      if (method === 'POST' && endpoint === `${API}/git/trees`)
        return response({ sha: sha(counter++) });
      if (method === 'POST' && endpoint === `${API}/git/commits`) {
        const commit = {
          sha: sha(counter++),
          tree: { sha: payload.tree },
          parents: payload.parents,
        };
        state.commits.set(commit.sha, commit);
        return response(commit);
      }
      if (method === 'POST' && endpoint === `${API}/git/refs`) {
        const branch = payload.ref.slice('refs/heads/'.length);
        if (state.refs.has(branch)) return failure();
        state.refs.set(branch, payload.sha);
        return response({ ref: payload.ref, object: { sha: payload.sha } });
      }
      if (method === 'PATCH' && endpoint.startsWith(`${API}/git/refs/heads/`)) {
        assert.equal(payload.force, false);
        const branch = endpoint.slice(`${API}/git/refs/heads/`.length);
        const commit = state.commits.get(payload.sha);
        if (!commit.parents.includes(state.refs.get(branch))) return failure();
        state.refs.set(branch, payload.sha);
        return response({ ref: `refs/heads/${branch}`, object: { sha: payload.sha } });
      }
      if (method === 'POST' && endpoint === `${API}/pulls`) {
        const number = state.prs.size + 101;
        const pr = {
          number,
          node_id: `PR_fixture_${number}`,
          state: 'open',
          merged: false,
          merged_at: null,
          head: {
            ref: payload.head,
            sha: state.refs.get(payload.head),
            repo: { id: 1380965476, full_name: BINDINGS.repository },
          },
          base: { ref: payload.base, repo: { id: 1380965476, full_name: BINDINGS.repository } },
        };
        state.prs.set(number, pr);
        return response(pr);
      }
      if (method === 'GET' && endpoint.startsWith(`${API}/pulls?`))
        return response([...state.prs.values()]);
      if (method === 'GET' && endpoint.startsWith(`${API}/pulls/`))
        return response(state.prs.get(Number(endpoint.split('/').at(-1))));
      throw new Error(`Unexpected fixture stub call ${method} ${endpoint}`);
    },
  };
  return {
    root,
    state,
    dependencies,
    async plan() {
      return main(['plan', '--scratch-root', path.join(root, 'human batches')], dependencies);
    },
    async run(command, batch, extra = []) {
      return main([command, '--batch', batch, ...extra], dependencies);
    },
  };
}

test('read-only plan uses fixed User/repository checks, a unique batch, and no remote mutation', async (t) => {
  const f = fixture(t);
  const first = await f.plan();
  const second = await f.plan();
  assert.notEqual(first, second);
  assert.match(first, /with spaces/);
  assert.equal(f.state.mutations.length, 0);
  const manifest = load(first);
  assert.equal(manifest.phase, 'PLANNED_READ_ONLY');
  assert.equal(manifest.permitIssued, false);
  assert.equal(manifest.qualificationRun, false);
  assert.equal(manifest.fixtures.length, 10);
  assert.equal(new Set(manifest.fixtures.map((x) => x.head)).size, 9);
});
for (const [name, change, code] of [
  [
    'bot identity',
    { user: { type: 'Bot', login: 'wsman', id: 21962212 } },
    'FIXTURE_HUMAN_IDENTITY_REQUIRED',
  ],
  [
    'wrong human id',
    { user: { type: 'User', login: 'wsman', id: 1 } },
    'FIXTURE_HUMAN_IDENTITY_REQUIRED',
  ],
  ['wrong repository id', { repository: { id: 1 } }, 'FIXTURE_REPOSITORY_MISMATCH'],
  ['automatic deletion enabled', { delete_branch_on_merge: true }, 'FIXTURE_AUTO_DELETION_ENABLED'],
  ['wrong default branch', { default_branch: 'master' }, 'FIXTURE_DEFAULT_BRANCH_MISMATCH'],
  ['public target', { private: false }, 'FIXTURE_REPOSITORY_MISMATCH'],
  ['no human push access', { permissions: { push: false } }, 'FIXTURE_PUSH_PERMISSION_REQUIRED'],
]) {
  test(`preflight refuses ${name} with zero remote mutation and no scratch batch`, async (t) => {
    const f = fixture(t);
    if (Object.hasOwn(change, 'user')) f.state.user = change.user;
    else if (Object.hasOwn(change, 'repository')) f.state.repository = change.repository;
    else Object.assign(f.state.repository, change);
    await assert.rejects(f.plan(), (error) => error.code === code);
    assert.equal(f.state.mutations.length, 0);
    assert.equal(fs.existsSync(path.join(f.root, 'human batches')), false);
  });
}
test('creation requires exact plan confirmation and creates nothing on decline', async (t) => {
  const f = fixture(t);
  const batch = await f.plan();
  f.state.denied = true;
  await assert.rejects(
    f.run('create', batch),
    (error) => error.code === 'FIXTURE_CONFIRMATION_DECLINED',
  );
  assert.equal(f.state.mutations.length, 0);
  assert.equal(load(batch).phase, 'PLANNED_READ_ONLY');
  assert.match(f.state.confirmations[0].phrase, /REPOSITORY 1380965476 PLAN [a-f0-9]{64}$/);
});
test('plan tampering refuses a foreign branch before even a read-only API call', async (t) => {
  const f = fixture(t);
  const batch = await f.plan();
  const file = path.join(batch, 'plan.json');
  const plan = JSON.parse(fs.readFileSync(file));
  plan.cases[0].head = 'main';
  write(file, plan);
  const count = f.state.calls.length;
  await assert.rejects(f.run('create', batch), (error) => error.code === 'FIXTURE_PLAN_INVALID');
  assert.equal(f.state.calls.length, count);
  assert.equal(f.state.mutations.length, 0);
});
test('normal creation exclusively publishes nine refs and records nine observed open PRs', async (t) => {
  const f = fixture(t);
  const batch = await f.plan();
  await f.run('create', batch);
  const manifest = load(batch);
  assert.equal(manifest.phase, 'CREATED');
  assert.equal(manifest.fixtures.filter((x) => x.pr).length, 9);
  assert.equal(f.state.mutations.filter((x) => x.endpoint === `${API}/git/refs`).length, 9);
  for (const item of manifest.fixtures) {
    assert.equal(item.branchPublished, true);
    assert.match(item.publishedSha, /^[a-f0-9]{40}$/);
    if (item.pr) {
      assert.equal(item.pr.state, 'open');
      assert.equal(item.pr.merged, false);
      assert.equal(item.pr.headSha, item.publishedSha);
    }
  }
  assert.equal(fs.existsSync(path.join(batch, 'mutation.lock')), false);
  assert(fs.readFileSync(path.join(batch, 'execution-log.jsonl'), 'utf8').includes('INTENT'));
  const count = f.state.calls.length;
  await assert.rejects(
    f.run('create', batch),
    (error) => error.code === 'FIXTURE_CREATION_ALREADY_ATTEMPTED',
  );
  assert.equal(f.state.calls.length, count);
});
test('exclusive ref collision stops and preserves the foreign branch and partial evidence', async (t) => {
  const f = fixture(t);
  const batch = await f.plan();
  const branch = load(batch).fixtures[0].head;
  f.state.refs.set(branch, sha(900));
  await assert.rejects(f.run('create', batch), (error) => error.code === 'FIXTURE_GH_FAILED');
  assert.equal(f.state.refs.get(branch), sha(900));
  assert.equal(load(batch).phase, 'FAILED_RECONCILE_REQUIRED');
  assert.match(load(batch).fixtures[0].intendedSha, /^[a-f0-9]{40}$/);
  assert.equal(
    f.state.mutations.some((x) => x.method === 'DELETE' || x.method === 'PATCH'),
    false,
  );
  const mutations = f.state.mutations.length;
  await assert.rejects(
    f.run('create', batch),
    (error) => error.code === 'FIXTURE_CREATION_ALREADY_ATTEMPTED',
  );
  assert.equal(f.state.mutations.length, mutations);
  const inspected = await f.run('inspect', batch);
  assert.equal(inspected.fixtures[0].actualRefSha, sha(900));
});
test('main moving after the plan stops creation before remote writes', async (t) => {
  const f = fixture(t);
  const batch = await f.plan();
  f.state.refs.set('main', sha(900));
  await assert.rejects(f.run('create', batch), (error) => error.code === 'FIXTURE_BASE_CHANGED');
  assert.equal(f.state.mutations.length, 0);
});
test('lost PR acknowledgement stops mutation and discovers the actual partial PR through read-only inspection', async (t) => {
  const f = fixture(t);
  const batch = await f.plan();
  const original = f.dependencies.runCommand;
  let lost = false;
  f.dependencies.runCommand = async (args, input) => {
    const result = await original(args, input);
    if (!lost && args[0] === 'api' && args[4] === 'POST' && args[5] === `${API}/pulls`) {
      lost = true;
      return { status: 0, stdout: 'malformed acknowledged response' };
    }
    return result;
  };
  await assert.rejects(
    f.run('create', batch),
    (error) => error.code === 'FIXTURE_GH_RESPONSE_INVALID',
  );
  assert.equal(load(batch).phase, 'FAILED_RECONCILE_REQUIRED');
  assert.equal(f.state.prs.size, 1);
  const mutations = f.state.mutations.length;
  const report = await f.run('inspect', batch);
  assert.equal(report.fixtures[0].pr.prNumber, 101);
  assert.equal(f.state.mutations.length, mutations);
});
test('close and each merge require observed PR-number confirmation and preserve source refs', async (t) => {
  const f = fixture(t);
  const batch = await f.plan();
  await f.run('create', batch);
  await f.run('close-case', batch);
  await f.run('merge-targets', batch);
  const manifest = load(batch);
  assert.equal(manifest.phase, 'MERGED_TARGETS');
  const closed = manifest.fixtures.find((x) => x.id === 'closed-unmerged');
  assert.equal(closed.pr.state, 'closed');
  assert.equal(closed.pr.merged, false);
  const merged = manifest.fixtures.filter((x) => x.disposition.startsWith('human-merge'));
  assert.equal(merged.length, 5);
  assert(merged.every((x) => x.pr.merged));
  for (const item of merged) assert.equal(f.state.refs.get(item.head), item.publishedSha);
  assert.equal(
    f.state.confirmations.filter((x) => /^MERGE PR \d+ HEAD .+ SHA [a-f0-9]{40}$/.test(x.phrase))
      .length,
    5,
  );
  assert.equal(
    f.state.confirmations.filter((x) => /^CLOSE PR \d+ WITHOUT MERGE SHA /.test(x.phrase)).length,
    1,
  );
  const head = manifest.fixtures.find((x) => x.id === 'head-dependency-blocker');
  const base = manifest.fixtures.find((x) => x.id === 'base-dependency-blocker');
  assert.equal(head.pr.state, 'open');
  assert.equal(base.pr.state, 'open');
  assert.equal(head.head, manifest.fixtures.find((x) => x.id === 'head-dependency-target').head);
  assert.equal(base.base, manifest.fixtures.find((x) => x.id === 'base-dependency-target').head);
  assert.equal(
    f.state.mutations.some((x) => x.args?.[1] === 'review'),
    false,
  );
});
test('normal fixture merge failure is not bypassed or re-tried', async (t) => {
  const f = fixture(t);
  const batch = await f.plan();
  await f.run('create', batch);
  await f.run('close-case', batch);
  f.state.mutationFailure = (args) => args[0] === 'pr' && args[1] === 'merge';
  await assert.rejects(
    f.run('merge-targets', batch),
    (error) => error.code === 'FIXTURE_GH_FAILED',
  );
  assert.equal(load(batch).phase, 'FAILED_RECONCILE_REQUIRED');
  assert.equal(f.state.mutations.filter((x) => x.args?.[1] === 'merge').length, 1);
  assert.equal(f.state.refs.size, 10);
});
test('a changed repository setting during human merge confirmation blocks the normal merge call', async (t) => {
  const f = fixture(t);
  const batch = await f.plan();
  await f.run('create', batch);
  await f.run('close-case', batch);
  const confirm = f.dependencies.confirm;
  f.dependencies.confirm = async (phrase, explanation) => {
    const decision = await confirm(phrase, explanation);
    if (/^MERGE/.test(phrase)) f.state.repository.delete_branch_on_merge = true;
    return decision;
  };
  await assert.rejects(
    f.run('merge-targets', batch),
    (error) => error.code === 'FIXTURE_AUTO_DELETION_ENABLED',
  );
  assert.equal(f.state.mutations.filter((x) => x.args?.[1] === 'merge').length, 0);
});
test('a missing source ref after an observed merge stops later merges and preserves the partial actual PR state', async (t) => {
  const f = fixture(t);
  const batch = await f.plan();
  await f.run('create', batch);
  await f.run('close-case', batch);
  const original = f.dependencies.runCommand;
  f.dependencies.runCommand = async (args, input) => {
    const result = await original(args, input);
    if (args[0] === 'pr' && args[1] === 'merge')
      f.state.refs.delete(f.state.prs.get(Number(args[2])).head.ref);
    return result;
  };
  await assert.rejects(
    f.run('merge-targets', batch),
    (error) => error.code === 'FIXTURE_GH_FAILED',
  );
  assert.equal(f.state.mutations.filter((x) => x.args?.[1] === 'merge').length, 1);
  assert.equal(load(batch).phase, 'FAILED_RECONCILE_REQUIRED');
  assert.equal(load(batch).fixtures.find((x) => x.id === 'success').pr.merged, true);
});
test('an interrupted exclusive phase lock is preserved and blocks creation without deleting or publishing refs', async (t) => {
  const f = fixture(t);
  const batch = await f.plan();
  const lock = path.join(batch, 'mutation.lock');
  fs.writeFileSync(lock, 'preserved interrupted owner');
  await assert.rejects(f.run('create', batch), (error) => error.code === 'EEXIST');
  assert.equal(fs.readFileSync(lock, 'utf8'), 'preserved interrupted owner');
  assert.equal(f.state.mutations.length, 0);
});
test('a declined later merge preserves earlier confirmed work for a later explicit continuation', async (t) => {
  const f = fixture(t);
  const batch = await f.plan();
  await f.run('create', batch);
  await f.run('close-case', batch);
  const original = f.dependencies.confirm;
  let merges = 0;
  f.dependencies.confirm = async (phrase, explanation) =>
    /^MERGE/.test(phrase) && ++merges === 2 ? false : original(phrase, explanation);
  await assert.rejects(
    f.run('merge-targets', batch),
    (error) => error.code === 'FIXTURE_CONFIRMATION_DECLINED',
  );
  assert.equal(load(batch).phase, 'MERGE_TARGETS_PARTIAL');
  f.dependencies.confirm = original;
  await f.run('merge-targets', batch);
  assert.equal(load(batch).phase, 'MERGED_TARGETS');
  assert.equal(f.state.mutations.filter((x) => x.args?.[1] === 'merge').length, 5);
});
test('later drift refuses an invented approval snapshot before any mutation', async (t) => {
  const f = fixture(t);
  const batch = await f.plan();
  await f.run('create', batch);
  await f.run('close-case', batch);
  await f.run('merge-targets', batch);
  const count = f.state.mutations.length;
  await assert.rejects(
    f.run('advance-drift', batch, ['--permit-id', 'cleanup-drift-1', '--approved-sha', sha(999)]),
    (error) => error.code === 'FIXTURE_APPROVED_SHA_MISMATCH',
  );
  assert.equal(f.state.mutations.length, count);
});
test('later human-authorised drift is forward-only and preserves its initial Permit snapshot separately', async (t) => {
  const f = fixture(t);
  const batch = await f.plan();
  await f.run('create', batch);
  await f.run('close-case', batch);
  await f.run('merge-targets', batch);
  const initial = load(batch).fixtures.find((x) => x.id === 'drift').publishedSha;
  await f.run('advance-drift', batch, [
    '--permit-id',
    'cleanup-drift-1',
    '--approved-sha',
    initial,
  ]);
  const record = load(batch).fixtures.find((x) => x.id === 'drift');
  assert.equal(record.publishedSha, initial);
  assert.equal(record.drift.originalSnapshotSha, initial);
  assert.notEqual(record.drift.observedSha, initial);
  assert.equal(record.drift.permitReference, 'cleanup-drift-1');
  assert.equal(f.state.mutations.filter((x) => x.method === 'PATCH').length, 1);
  assert.equal(f.state.mutations.find((x) => x.method === 'PATCH').payload.force, false);
  assert.equal(load(batch).permitIssued, false);
  assert.equal(load(batch).qualificationRun, false);
});
test.each(['operator', 'repository', 'target'])(
  'fork registration revalidates %s after confirmation before recording evidence',
  async (kind) => {
    const f = fixture(),
      batch = await f.plan();
    f.state.prs.set(999, {
      number: 999,
      node_id: 'PR_existing_fork',
      state: 'closed',
      merged: true,
      merged_at: NOW,
      head: {
        ref: 'human-existing-fork',
        sha: sha(888),
        repo: { id: 888, full_name: 'wsman/independently-authorised-fork' },
      },
      base: {
        ref: 'main',
        repo: {
          id: BINDINGS.repositoryId,
          full_name: BINDINGS.repository,
        },
      },
    });
    f.dependencies.confirm = async () => {
      if (kind === 'operator') f.state.user.login = 'foreign-human';
      if (kind === 'repository') f.state.repository.delete_branch_on_merge = true;
      if (kind === 'target') f.state.prs.get(999).head.sha = sha(777);
      return true;
    };
    const code = {
      operator: 'FIXTURE_HUMAN_IDENTITY_REQUIRED',
      repository: 'FIXTURE_AUTO_DELETION_ENABLED',
      target: 'FIXTURE_FORK_TARGET_CHANGED',
    }[kind];
    await assert.rejects(f.run('register-existing-fork', batch), { code });
    assert.deepEqual(f.state.mutations, []);
    assert.equal(load(batch).fork.state, 'BLOCKED_SEPARATE_FORK_AUTHORIZATION_REQUIRED');
  },
);

test('fork registration leaves missing cross-repository preparation blocked without mutation', async (t) => {
  const f = fixture(t);
  const batch = await f.plan();
  await f.run('register-existing-fork', batch);
  assert.equal(f.state.mutations.length, 0);
  assert.equal(load(batch).fork.state, 'BLOCKED_SEPARATE_FORK_AUTHORIZATION_REQUIRED');
});
test('only an actually observed merged canonical-base fork PR can be recorded read-only', async (t) => {
  const f = fixture(t);
  const batch = await f.plan();
  f.state.prs.set(999, {
    number: 999,
    node_id: 'PR_real_observed_fixture',
    state: 'closed',
    merged: true,
    merged_at: NOW,
    head: {
      ref: 'human-existing-fork',
      sha: sha(555),
      repo: { id: 888, full_name: 'wsman/independently-authorised-fork' },
    },
    base: { ref: 'main', repo: { id: 1380965476, full_name: BINDINGS.repository } },
  });
  await f.run('register-existing-fork', batch);
  assert.equal(load(batch).fork.observedPR.prNumber, 999);
  assert.equal(f.state.mutations.length, 0);
});
test('case-insensitive token environment keys are removed without output or credential refresh', () => {
  const environment = humanGhEnvironment({
    PATH: '/fixture tools',
    GH_TOKEN: 'not-real',
    github_token: 'not-real',
    Gh_Enterprise_Token: 'not-real',
    OTHER: 'ordinary',
  });
  assert.equal(environment.PATH, '/fixture tools');
  assert.equal(environment.OTHER, 'ordinary');
  assert.equal(
    Object.keys(environment).some((key) => /token/i.test(key)),
    false,
  );
});
test('closed options reject duplicate or unknown arguments before invoking the command stub', async () => {
  const dependencies = {
    runCommand: () => {
      throw new Error('must not run');
    },
  };
  await assert.rejects(
    main(['plan', '--scratch-root', '/ordinary', '--repo', 'other/repo'], dependencies),
    (error) => error.code === 'FIXTURE_ARGUMENT_INVALID',
  );
  await assert.rejects(
    main(['plan', '--scratch-root', '/ordinary', '--scratch-root', '/other'], dependencies),
    (error) => error.code === 'FIXTURE_ARGUMENT_INVALID',
  );
  await assert.rejects(
    main(['plan', '--scratch-root', '/ordinary\nother'], dependencies),
    (error) => error.code === 'FIXTURE_ARGUMENT_INVALID',
  );
});
test('real Node pipeline returns complete non-sensitive invalid-input diagnostics without gh', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-fixture-pipeline-'));
  const entry = fileURLToPath(
    new URL(
      '../../../../scripts/cleanup-broker/administration/qualification-fixtures.mjs',
      import.meta.url,
    ),
  );
  const script = path.join(temporary, 'qualification-fixtures.mjs');
  try {
    const built = spawnSync(
      testExecutable('bun'),
      ['build', entry, '--target=node', '--format=esm', '--outfile', script],
      { encoding: 'utf8', env: testProcessEnvironment() },
    );
    assert.equal(built.status, 0, built.stderr);
    const result = spawnSync(process.execPath, [script, 'plan', '--unknown', 'value'], {
      encoding: 'utf8',
      env: { PATH: '' },
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /FIXTURE_ARGUMENT_INVALID/);
    assert.equal(result.stdout, '');
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('duplicate and escaped duplicate keys in a local plan refuse before GitHub calls', async (t) => {
  const f = fixture(t);
  const batch = await f.plan();
  const file = path.join(batch, 'plan.json');
  const original = fs.readFileSync(file, 'utf8');
  for (const key of ['schema', '\\u0073chema']) {
    fs.writeFileSync(file, original.replace('{', `{"${key}": "ignored",`));
    const manifest = load(batch);
    manifest.planSHA256 = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    write(path.join(batch, 'manifest.json'), manifest);
    const calls = f.state.calls.length;
    await assert.rejects(
      f.run('create', batch),
      (error) => error.code === 'FIXTURE_LOCAL_RECORD_INVALID',
    );
    assert.equal(f.state.calls.length, calls);
    assert.equal(f.state.mutations.length, 0);
  }
});

test.each(['oversized', 'hardlink', 'directory'])(
  'local %s records refuse before GitHub calls',
  async (kind, t) => {
    const f = fixture(t);
    const batch = await f.plan();
    const file = path.join(batch, 'plan.json');
    if (kind === 'oversized') fs.writeFileSync(file, Buffer.alloc(1024 * 1024 + 1, 32));
    if (kind === 'hardlink') fs.linkSync(file, path.join(batch, 'plan-linked.json'));
    if (kind === 'directory') {
      fs.unlinkSync(file);
      fs.mkdirSync(file);
    }
    const calls = f.state.calls.length;
    await assert.rejects(
      f.run('inspect', batch),
      (error) => error.code === 'FIXTURE_LOCAL_RECORD_INVALID',
    );
    assert.equal(f.state.calls.length, calls);
    assert.equal(f.state.mutations.length, 0);
  },
);

test('sensitive batch paths refuse before source access or GitHub calls', async () => {
  const dependencies = {
    runCommand: () => {
      throw new Error('must not run');
    },
  };
  await assert.rejects(
    main(['create', '--batch', path.resolve('credentials', 'never-open')], dependencies),
    (error) => error.code === 'FIXTURE_ARGUMENT_INVALID',
  );
});
