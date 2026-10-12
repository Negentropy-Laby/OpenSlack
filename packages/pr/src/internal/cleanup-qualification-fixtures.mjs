#!/usr/bin/env node
import {
  CLEANUP_ADMIN_BINDINGS,
  CLEANUP_FIXTURE_OPERATOR,
} from './cleanup-administration-contract.js';
/** Administrator-only qualification fixture preparation. Never invoked by the qualification Agent. */
import * as fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  cleanupByteDigest as HASH,
  cleanupDocumentBytes as JSON_BYTES,
} from './cleanup-document-bytes.js';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import {
  decodeStrictJSON,
  readStableDescriptor,
  stableFileIdentity,
  createProcessResolver,
  normalizeProcessEnvironment,
  capturePortableDirectoryChain,
} from '@openslack/core';
import { isSensitiveCleanupInput, cleanupExactKeys, cleanupObject } from './cleanup-validation.js';
import { CleanupDirectoryAnchor, CleanupCapturedFile } from './cleanup-file-boundary.js';

export const BINDINGS = Object.freeze({
  host: CLEANUP_FIXTURE_OPERATOR.host,
  repository: CLEANUP_ADMIN_BINDINGS.repository,
  repositoryId: Number(CLEANUP_ADMIN_BINDINGS.repositoryId),
  defaultBranch: CLEANUP_FIXTURE_OPERATOR.defaultBranch,
  login: CLEANUP_FIXTURE_OPERATOR.login,
  userId: CLEANUP_FIXTURE_OPERATOR.userId,
});
const REPO = BINDINGS.repository;
const API = `repos/${REPO}`;
const SHA = /^[a-f0-9]{40}$/;
const PLAN_SCHEMA = 'openslack.cleanup_fixture_plan.v1';
const MANIFEST_SCHEMA = 'openslack.cleanup_fixture_manifest.v1';
const refusal = (code, detail) => Object.assign(new Error(`${code}: ${detail}`), { code });
const required = (value, code, detail) => {
  if (!value) throw refusal(code, detail);
};
const closed = (value, keys) => cleanupObject(value) && cleanupExactKeys(value, keys);
const closedOptional = (value, requiredKeys, optionalKeys = []) =>
  cleanupObject(value) && cleanupExactKeys(value, requiredKeys, optionalKeys);

// Linux writes remain pinned to our actual private directory throughout human
// confirmation and remote awaits. Other platforms retain only the declared local
// fixture persistence guarantee; they never participate in Broker execution.
function fixtureDirectory(directory, create = false) {
  const absolute = path.resolve(directory);
  required(
    !directory.split(/[\\/]/).includes('..'),
    'FIXTURE_DIRECTORY_INVALID',
    'path aliases are refused',
  );
  if (process.platform === 'linux') {
    let existing = absolute;
    while (!fs.existsSync(existing)) {
      const parent = path.dirname(existing);
      required(parent !== existing, 'FIXTURE_DIRECTORY_INVALID', 'an existing parent is required');
      existing = parent;
    }
    const anchor = CleanupDirectoryAnchor.open(
      absolute,
      create ? existing : path.dirname(absolute),
    );
    return {
      path: (name) => anchor.path(name),
      verify: () => anchor.verify(),
      sync: () => anchor.sync(),
      close: () => anchor.close(),
    };
  }
  const parents = [];
  const pending = [];
  let current = absolute;
  while (!fs.existsSync(current)) {
    required(create, 'FIXTURE_DIRECTORY_INVALID', 'the batch must already exist');
    pending.unshift(current);
    current = path.dirname(current);
  }
  try {
    parents.push(capturePortableDirectoryChain(current));
  } catch {
    throw refusal('FIXTURE_DIRECTORY_INVALID', 'real parent directories are required');
  }
  const verify = () => {
    try {
      for (const parent of parents) parent.verify();
    } catch {
      throw refusal(
        'FIXTURE_DIRECTORY_CHANGED',
        'preserve the original batch; a directory changed',
      );
    }
  };
  for (const directory of pending) {
    verify();
    fs.mkdirSync(directory, { mode: 0o700 });
    parents.push(capturePortableDirectoryChain(directory));
    verify();
  }
  return {
    path: (name) => {
      verify();
      return path.join(absolute, name);
    },
    verify,
    sync: () => {
      verify();
      syncDirectory(absolute);
      verify();
    },
    close: () => {},
  };
}

function syncDirectory(directory) {
  // Windows does not expose directory fsync through Node. Do not claim that it does.
  if (process.platform === 'win32') return 'FILE_FSYNC_ONLY_WINDOWS';
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  return 'FILE_AND_DIRECTORY_FSYNC';
}
function exclusiveWrite(file, bytes, directory) {
  directory?.verify();
  const internal = directory ? directory.path(path.basename(file)) : file;
  const descriptor = fs.openSync(internal, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  if (directory) directory.sync();
  else syncDirectory(path.dirname(file));
}
function readLocal(file, directory) {
  if (process.platform === 'linux') {
    let capture;
    try {
      capture = CleanupCapturedFile.open(file, 1024 * 1024);
      const bytes = capture.read(),
        value = decodeStrictJSON(bytes, 1024 * 1024);
      capture.verify();
      directory?.verify();
      return { value, sha256: HASH(bytes) };
    } catch {
      throw refusal(
        'FIXTURE_LOCAL_RECORD_INVALID',
        'a stable, bounded, strictly decoded local record is required',
      );
    } finally {
      capture?.close();
    }
  }
  let descriptor;
  try {
    const parents = capturePortableDirectoryChain(path.dirname(file));
    const metadata = fs.lstatSync(file);
    required(
      metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1,
      'FIXTURE_LOCAL_RECORD_INVALID',
      'a bounded single-link regular plan/manifest is required',
    );
    directory?.verify();
    descriptor = fs.openSync(
      directory ? directory.path(path.basename(file)) : file,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0),
    );
    const opened = fs.fstatSync(descriptor);
    required(
      stableFileIdentity(opened) === stableFileIdentity(metadata),
      'FIXTURE_LOCAL_RECORD_INVALID',
      'the opened file differs from the observed file',
    );
    const bytes = readStableDescriptor(descriptor, 1024 * 1024, false);
    const value = decodeStrictJSON(bytes, 1024 * 1024);
    required(
      stableFileIdentity(fs.lstatSync(file)) === stableFileIdentity(opened),
      'FIXTURE_LOCAL_RECORD_INVALID',
      'local evidence changed while reading',
    );
    parents.verify();
    directory?.verify();
    return { value, sha256: HASH(bytes) };
  } catch {
    throw refusal(
      'FIXTURE_LOCAL_RECORD_INVALID',
      'a stable, bounded, strictly decoded local record is required',
    );
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}
function updateManifest(file, value, expectedHash, directory) {
  required(
    readLocal(file, directory).sha256 === expectedHash,
    'FIXTURE_LOCAL_RECORD_CHANGED',
    'manifest changed during this phase',
  );
  const temporary = `${file}.owned-${randomBytes(8).toString('hex')}.tmp`;
  exclusiveWrite(temporary, JSON_BYTES(value), directory);
  // This replaces our own manifest under the exclusive phase lock; remote refs never use an overwriting publish.
  directory?.verify();
  fs.renameSync(
    directory ? directory.path(path.basename(temporary)) : temporary,
    directory ? directory.path(path.basename(file)) : file,
  );
  if (directory) directory.sync();
  else syncDirectory(path.dirname(file));
  return readLocal(file, directory).sha256;
}
function appendJournal(directory, object, anchor) {
  anchor?.verify();
  const descriptor = fs.openSync(
    anchor ? anchor.path('execution-log.jsonl') : path.join(directory, 'execution-log.jsonl'),
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_APPEND |
      (fs.constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(object)}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  if (anchor) anchor.sync();
  else syncDirectory(directory);
}
function lockPhase(directory, anchor) {
  anchor?.verify();
  const file = anchor ? anchor.path('mutation.lock') : path.join(directory, 'mutation.lock');
  const descriptor = fs.openSync(file, 'wx', 0o600);
  let owned;
  try {
    owned = fs.fstatSync(descriptor);
    fs.writeFileSync(
      descriptor,
      JSON_BYTES({ schema: 'openslack.cleanup_fixture_lock.v1', pid: process.pid }),
    );
    fs.fsyncSync(descriptor);
    if (anchor) anchor.sync();
    else syncDirectory(directory);
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
  return (preserve = false) => {
    try {
      if (preserve) return;
      anchor?.verify();
      const current = fs.lstatSync(file);
      required(
        current.dev === owned.dev && current.ino === owned.ino && current.isFile(),
        'FIXTURE_LOCK_REPLACED',
        'phase lock was replaced; preserve it for review',
      );
      fs.unlinkSync(file);
      if (anchor) anchor.sync();
      else syncDirectory(directory);
    } finally {
      fs.closeSync(descriptor);
    }
  };
}

export function humanGhEnvironment(parent = process.env) {
  const result = {
    ...normalizeProcessEnvironment(parent),
    GH_PROMPT_DISABLED: '1',
    GH_PAGER: 'cat',
    GH_NO_UPDATE_NOTIFIER: '1',
  };
  // The existing human gh login is checked through /user. Never fall back to supplied bot/PAT environment tokens.
  for (const key of Object.keys(result)) {
    if (
      ['gh_token', 'github_token', 'gh_enterprise_token', 'github_enterprise_token'].includes(
        key.toLowerCase(),
      )
    )
      delete result[key];
  }
  return result;
}
export function fixtureCommandDiagnostic(result) {
  const redacted = String(result.stderr ?? '')
    .replace(/(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)/g, '[REDACTED]')
    .replace(
      /\b(?:authorization|password|access[_-]?token|client[_-]?secret)\s*[:=]\s*[^\r\n]+/gi,
      '[REDACTED]',
    )
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]');
  // Bound persisted UTF-8 bytes, not JS code units.
  const raw = Buffer.from(redacted);
  let end = Math.min(raw.length, 32 * 1024);
  while (end < raw.length && (raw[end] & 0xc0) === 0x80) end--;
  return {
    status: result.status ?? null,
    signal: result.signal ?? null,
    error: result.error?.code ?? result.error ?? null,
    stderr: raw.subarray(0, end).toString('utf8'),
  };
}
function createRealRunner() {
  const resolver = createProcessResolver(humanGhEnvironment());
  return (args, input) => {
    const result = spawnSync(resolver.executable('gh'), args, {
      input,
      encoding: 'utf8',
      env: resolver.env,
      shell: false,
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: fixtureCommandDiagnostic(result).stderr,
      signal: result.signal,
      error: result.error?.code,
    };
  };
}

async function realConfirmation(phrase, explanation) {
  required(
    process.stdin.isTTY && process.stdout.isTTY,
    'FIXTURE_HUMAN_TTY_REQUIRED',
    'mutations require an interactive administrator terminal',
  );
  console.log(explanation);
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (
      (await readline.question(
        `Type exactly ${phrase} to authorise this fixture-only action, or Enter to stop: `,
      )) === phrase
    );
  } finally {
    readline.close();
  }
}
function createRuntime(dependencies) {
  const runCommand = dependencies.runCommand ?? createRealRunner();
  const runtime = {
    now: dependencies.now ?? (() => new Date().toISOString()),
    log: dependencies.log ?? console.log,
    confirm: dependencies.confirm ?? realConfirmation,
    async gh(args, payload) {
      runtime.directory?.verify();
      const result = await runCommand(
        args,
        payload === undefined ? undefined : JSON.stringify(payload),
      );
      runtime.lastCommand = fixtureCommandDiagnostic(result);
      runtime.directory?.verify();
      if (result.status !== 0 || result.signal || result.error)
        throw Object.assign(
          refusal(
            'FIXTURE_GH_FAILED',
            `gh failed or its result is unknown (exit ${result.status ?? 'unknown'}); no automatic retry; inspect saved intent`,
          ),
          { commandResult: runtime.lastCommand },
        );
      return result.stdout;
    },
    async api(method, endpoint, payload) {
      const args = ['api', '--hostname', BINDINGS.host, '--method', method, endpoint];
      if (payload !== undefined) args.push('--input', '-');
      const output = await runtime.gh(args, payload);
      try {
        return JSON.parse(output);
      } catch {
        throw refusal(
          'FIXTURE_GH_RESPONSE_INVALID',
          'the completed API call did not return expected JSON; inspect saved intent',
        );
      }
    },
  };
  return runtime;
}
export async function preflight(runtime) {
  const user = await runtime.api('GET', 'user');
  required(
    user.type === 'User' && user.login === BINDINGS.login && user.id === BINDINGS.userId,
    'FIXTURE_HUMAN_IDENTITY_REQUIRED',
    'current gh identity must be User wsman (21962212), never a bot or the qualification Agent',
  );
  const repository = await runtime.api('GET', API);
  required(
    repository.id === BINDINGS.repositoryId &&
      repository.full_name === REPO &&
      repository.private === true,
    'FIXTURE_REPOSITORY_MISMATCH',
    'only the fixed private qualification repository is allowed',
  );
  required(
    repository.default_branch === 'main',
    'FIXTURE_DEFAULT_BRANCH_MISMATCH',
    'default branch must remain main',
  );
  required(
    repository.delete_branch_on_merge === false,
    'FIXTURE_AUTO_DELETION_ENABLED',
    'automatic branch deletion must already be false; this tool does not change repository settings',
  );
  required(
    repository.permissions?.push === true,
    'FIXTURE_PUSH_PERMISSION_REQUIRED',
    'the independent human identity must have push access',
  );
  const main = await runtime.api('GET', `${API}/git/ref/heads/main`);
  required(
    main.ref === 'refs/heads/main' && SHA.test(main.object?.sha),
    'FIXTURE_MAIN_EVIDENCE_INVALID',
    'main ref is not a full observed SHA',
  );
  return {
    user: { login: user.login, id: user.id, type: user.type },
    mainSha: main.object.sha,
    observedAt: runtime.now(),
  };
}
export function fixtureCases(batchId) {
  const prefix = `cleanup-qualification/${batchId}`;
  const branch = (suffix) => `${prefix}/${suffix}`;
  return [
    {
      id: 'open-unmerged',
      head: branch('open-unmerged'),
      base: 'main',
      parent: 'main',
      disposition: 'keep-open',
    },
    {
      id: 'closed-unmerged',
      head: branch('closed-unmerged'),
      base: 'main',
      parent: 'main',
      disposition: 'close-without-merge',
    },
    {
      id: 'success',
      head: branch('success'),
      base: 'main',
      parent: 'main',
      disposition: 'human-merge',
    },
    {
      id: 'drift',
      head: branch('drift'),
      base: 'main',
      parent: 'main',
      disposition: 'human-merge-then-separate-authorised-drift',
    },
    {
      id: 'head-dependency-target',
      head: branch('head-dependency-target'),
      base: 'main',
      parent: 'main',
      disposition: 'human-merge',
    },
    {
      id: 'base-dependency-target',
      head: branch('base-dependency-target'),
      base: 'main',
      parent: 'main',
      disposition: 'human-merge',
    },
    {
      id: 'reserved-ref',
      head: `openslack/probes/cleanup-qualification-${batchId}`,
      base: 'main',
      parent: 'main',
      disposition: 'human-merge',
    },
    {
      id: 'head-dependency-base',
      head: branch('head-dependency-base'),
      base: null,
      parent: 'main',
      disposition: 'branch-only',
    },
    {
      id: 'base-dependency-blocker',
      head: branch('base-dependency-blocker'),
      base: branch('base-dependency-target'),
      parent: 'base-dependency-target',
      disposition: 'keep-open',
    },
    {
      id: 'head-dependency-blocker',
      head: branch('head-dependency-target'),
      base: branch('head-dependency-base'),
      parent: null,
      disposition: 'existing-head-open-pr',
    },
  ];
}
function validatePlan(plan) {
  required(
    closed(plan, [
      'schema',
      'batchId',
      'createdAt',
      'bindings',
      'initialMainSha',
      'cases',
      'authority',
      'localPersistence',
    ]) &&
      plan.schema === PLAN_SCHEMA &&
      /^batch-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$/.test(plan.batchId) &&
      SHA.test(plan.initialMainSha) &&
      JSON.stringify(plan.bindings) === JSON.stringify(BINDINGS) &&
      JSON.stringify(plan.cases) === JSON.stringify(fixtureCases(plan.batchId)) &&
      plan.authority === 'ADMINISTRATOR_FIXTURES_ONLY_NO_DEPLOYMENT_OR_PERMIT_AUTHORITY',
    'FIXTURE_PLAN_INVALID',
    'plan changed, is malformed, or has a foreign repository/ref',
  );
}
function validateManifest(value, plan, planHash) {
  required(
    closedOptional(
      value,
      [
        'schema',
        'batchId',
        'planSHA256',
        'repository',
        'repositoryId',
        'createdAt',
        'administrator',
        'phase',
        'confirmations',
        'fixtures',
        'mainRefObservation',
        'fork',
        'taskScopeAttested',
        'permitIssued',
        'qualificationRun',
      ],
      ['failure'],
    ) &&
      value.schema === MANIFEST_SCHEMA &&
      value.planSHA256 === planHash &&
      value.batchId === plan.batchId &&
      value.repository === REPO &&
      value.repositoryId === BINDINGS.repositoryId &&
      Array.isArray(value.fixtures) &&
      value.fixtures.length === plan.cases.length &&
      value.taskScopeAttested === false &&
      value.permitIssued === false &&
      value.qualificationRun === false &&
      value.administrator?.type === 'User' &&
      value.administrator.login === BINDINGS.login &&
      value.administrator.id === BINDINGS.userId &&
      [
        'PLANNED_READ_ONLY',
        'CREATED',
        'CLOSED_CASE',
        'MERGE_TARGETS_PARTIAL',
        'MERGED_TARGETS',
        'DRIFT_APPLIED',
        'FAILED_RECONCILE_REQUIRED',
      ].includes(value.phase),
    'FIXTURE_MANIFEST_INVALID',
    'manifest does not match its exact reviewed plan',
  );
  for (let i = 0; i < plan.cases.length; i++) {
    required(
      closedOptional(
        value.fixtures[i],
        [...Object.keys(plan.cases[i]), 'branchPublished', 'pr'],
        ['intendedSha', 'publishedSha', 'intendedPRNumber', 'drift'],
      ) && Object.keys(plan.cases[i]).every((key) => value.fixtures[i][key] === plan.cases[i][key]),
      'FIXTURE_MANIFEST_INVALID',
      'fixture ref/base was changed in local evidence',
    );
  }
}
function paths(root) {
  const resolved = path.resolve(root);
  return {
    directory: resolved,
    plan: path.join(resolved, 'plan.json'),
    manifest: path.join(resolved, 'manifest.json'),
  };
}
function loadBatch(root, anchor) {
  const p = paths(root);
  const planRecord = readLocal(p.plan, anchor);
  validatePlan(planRecord.value);
  const manifestRecord = readLocal(p.manifest, anchor);
  validateManifest(manifestRecord.value, planRecord.value, planRecord.sha256);
  return {
    ...p,
    anchor,
    planPath: p.plan,
    manifestPath: p.manifest,
    plan: planRecord.value,
    planHash: planRecord.sha256,
    manifest: manifestRecord.value,
    manifestHash: manifestRecord.sha256,
  };
}
function saveBatch(batch) {
  batch.manifestHash = updateManifest(
    batch.manifestPath,
    batch.manifest,
    batch.manifestHash,
    batch.anchor,
  );
}
async function authorisedPhase(runtime, batch, name, phrase, explanation, body) {
  required(
    await runtime.confirm(phrase, explanation),
    'FIXTURE_CONFIRMATION_DECLINED',
    'no mutation authorised',
  );
  return lockedPhase(runtime, batch, name, body, { phrase });
}
async function lockedPhase(runtime, batch, name, body, { phrase, retainOnFailure = false } = {}) {
  const release = lockPhase(batch.directory, batch.anchor);
  let preserveLock = false;
  batch.manifestPath = path.join(batch.directory, 'manifest.json');
  try {
    // Re-read after acquiring the lock: stale in-memory manifests cannot overwrite another completed phase.
    required(
      readLocal(batch.manifestPath, batch.anchor).sha256 === batch.manifestHash,
      'FIXTURE_LOCAL_RECORD_CHANGED',
      'reload after another phase',
    );
    required(
      batch.manifest.phase !== 'FAILED_RECONCILE_REQUIRED',
      'FIXTURE_RECOVERY_REQUIRED',
      'inspect the partial batch; do not re-run mutation',
    );
    if (phrase !== undefined) {
      batch.manifest.confirmations.push({
        phase: name,
        phrase,
        actor: BINDINGS.login,
        observedAt: runtime.now(),
      });
      saveBatch(batch);
    }
    await body();
    batch.manifest.phase = name;
    saveBatch(batch);
  } catch (error) {
    preserveLock = retainOnFailure;
    batch.manifest.phase = 'FAILED_RECONCILE_REQUIRED';
    batch.manifest.failure = {
      code: error.code ?? 'FIXTURE_LOCAL_OR_REMOTE_FAILURE',
      observedAt: runtime.now(),
    };
    try {
      saveBatch(batch);
    } catch (persistenceError) {
      // An uncertain remote result must never become replayable because the
      // failure manifest itself could not be committed. Preserve the durable
      // exclusive lock; only independently reviewed recovery may remove it.
      preserveLock = true;
      error.persistenceFailure = persistenceError.code ?? 'FIXTURE_STATE_PERSISTENCE_FAILED';
      error.message += `; persistence refused (${error.persistenceFailure}); preserve the phase lock and inspect`;
    }
    throw error;
  } finally {
    release(preserveLock);
  }
}
async function mutate(runtime, batch, kind, args, payload, callback) {
  appendJournal(
    batch.directory,
    {
      schema: 'openslack.cleanup_fixture_action.v1',
      stage: 'INTENT',
      kind,
      observedAt: runtime.now(),
      args,
      payload: payload ?? null,
    },
    batch.anchor,
  );
  let result;
  try {
    result = await callback();
  } catch (error) {
    appendJournal(
      batch.directory,
      {
        schema: 'openslack.cleanup_fixture_action.v1',
        stage: 'RESPONSE',
        kind,
        observedAt: runtime.now(),
        result: error.commandResult ?? { error: error.code ?? 'FIXTURE_FAILED' },
      },
      batch.anchor,
    );
    throw error;
  }
  appendJournal(
    batch.directory,
    {
      schema: 'openslack.cleanup_fixture_action.v1',
      stage: 'RESPONSE',
      kind,
      observedAt: runtime.now(),
      result,
      command: runtime.lastCommand,
    },
    batch.anchor,
  );
  return result;
}
async function mutationApi(runtime, batch, kind, method, endpoint, payload) {
  required(
    endpoint.startsWith(`${API}/`) && method !== 'DELETE',
    'FIXTURE_MUTATION_SCOPE_INVALID',
    'foreign mutation or deletion is prohibited',
  );
  return mutate(
    runtime,
    batch,
    kind,
    ['api', '--hostname', BINDINGS.host, '--method', method, endpoint],
    payload,
    () => runtime.api(method, endpoint, payload),
  );
}
async function prObservation(runtime, number) {
  required(
    Number.isSafeInteger(number) && number > 0,
    'FIXTURE_PR_INVALID',
    'PR must be a positive safe integer',
  );
  const pr = await runtime.api('GET', `${API}/pulls/${number}`);
  required(
    pr.number === number &&
      typeof pr.node_id === 'string' &&
      pr.node_id.length > 0 &&
      pr.base?.repo?.id === BINDINGS.repositoryId &&
      pr.base.repo.full_name === REPO &&
      SHA.test(pr.head?.sha) &&
      ['open', 'closed'].includes(pr.state) &&
      typeof pr.merged === 'boolean',
    'FIXTURE_PR_EVIDENCE_INVALID',
    'PR resource evidence is incomplete or foreign',
  );
  return {
    prNumber: pr.number,
    prNodeId: pr.node_id,
    url: `https://github.com/${REPO}/pull/${pr.number}`,
    state: pr.state,
    merged: pr.merged,
    mergedAt: pr.merged_at ?? null,
    head: pr.head.ref,
    headRef: `refs/heads/${pr.head.ref}`,
    headSha: pr.head.sha,
    headRepository: pr.head.repo?.full_name ?? null,
    headRepositoryId: pr.head.repo?.id ?? null,
    base: pr.base.ref,
    baseRef: `refs/heads/${pr.base.ref}`,
    observedAt: runtime.now(),
  };
}
async function refObservation(runtime, branch) {
  const ref = await runtime.api(
    'GET',
    `${API}/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`,
  );
  required(
    ref.ref === `refs/heads/${branch}` && SHA.test(ref.object?.sha),
    'FIXTURE_REF_EVIDENCE_INVALID',
    'head ref changed or is unreadable',
  );
  return ref.object.sha;
}

async function planBatch(runtime, scratchRoot) {
  const observed = await preflight(runtime);
  const stamp = runtime
    .now()
    .replace(/[-:]/g, '')
    .replace(/\.[0-9]{3}Z$/, 'Z');
  required(
    /^[0-9]{8}T[0-9]{6}Z$/.test(stamp),
    'FIXTURE_TIME_INVALID',
    'expected actual UTC ISO timestamp',
  );
  const batchId = `batch-${stamp}-${randomBytes(6).toString('hex')}`;
  const directory = path.join(path.resolve(scratchRoot), batchId);
  const anchor = fixtureDirectory(directory, true);
  try {
    const plan = {
      schema: PLAN_SCHEMA,
      batchId,
      createdAt: runtime.now(),
      bindings: BINDINGS,
      initialMainSha: observed.mainSha,
      cases: fixtureCases(batchId),
      authority: 'ADMINISTRATOR_FIXTURES_ONLY_NO_DEPLOYMENT_OR_PERMIT_AUTHORITY',
      localPersistence:
        process.platform === 'win32' ? 'FILE_FSYNC_ONLY_WINDOWS' : 'FILE_AND_DIRECTORY_FSYNC',
    };
    validatePlan(plan);
    const bytes = JSON_BYTES(plan);
    exclusiveWrite(path.join(directory, 'plan.json'), bytes, anchor);
    exclusiveWrite(
      path.join(directory, 'manifest.json'),
      JSON_BYTES({
        schema: MANIFEST_SCHEMA,
        batchId,
        planSHA256: HASH(bytes),
        repository: REPO,
        repositoryId: BINDINGS.repositoryId,
        createdAt: runtime.now(),
        administrator: observed.user,
        phase: 'PLANNED_READ_ONLY',
        confirmations: [],
        fixtures: plan.cases.map((item) => ({ ...item, branchPublished: false, pr: null })),
        mainRefObservation: {
          ref: 'refs/heads/main',
          sha: observed.mainSha,
          meaning: 'READ_ONLY_NO_FORGED_PR_TARGET',
        },
        fork: { state: 'BLOCKED_SEPARATE_FORK_AUTHORIZATION_REQUIRED', observedPR: null },
        taskScopeAttested: false,
        permitIssued: false,
        qualificationRun: false,
      }),
      anchor,
    );
    runtime.log(
      JSON.stringify(
        {
          state: 'PLAN_READY_NO_REMOTE_MUTATION',
          batchDirectory: directory,
          planSHA256: HASH(bytes),
          repository: REPO,
          repositoryId: BINDINGS.repositoryId,
          refs: plan.cases.map((item) => item.head),
        },
        null,
        2,
      ),
    );
    return directory;
  } finally {
    anchor.close();
  }
}
async function createBatch(runtime, batch) {
  required(
    batch.manifest.phase === 'PLANNED_READ_ONLY',
    'FIXTURE_CREATION_ALREADY_ATTEMPTED',
    'use inspect for partial or existing batches; never replay create',
  );
  const observed = await preflight(runtime);
  required(
    observed.mainSha === batch.plan.initialMainSha,
    'FIXTURE_BASE_CHANGED',
    'prepare a new exclusive batch after reviewing main movement',
  );
  const phrase = `CREATE ${batch.plan.batchId} REPOSITORY ${BINDINGS.repositoryId} PLAN ${batch.planHash}`;
  await authorisedPhase(
    runtime,
    batch,
    'CREATED',
    phrase,
    `Human-only creation in ${REPO}. Review plan.json: nine exclusive branches and nine PRs; no merge, close, approval, deletion, Permit or deployment.`,
    async () => {
      for (const item of batch.manifest.fixtures) {
        const current = await preflight(runtime);
        required(
          current.mainSha === batch.plan.initialMainSha,
          'FIXTURE_BASE_CHANGED',
          'main moved during fixture creation; preserve the partial batch',
        );
        if (item.disposition !== 'existing-head-open-pr') {
          const parent =
            item.parent === 'main'
              ? batch.plan.initialMainSha
              : batch.manifest.fixtures.find((previous) => previous.id === item.parent)
                  ?.publishedSha;
          required(
            SHA.test(parent),
            'FIXTURE_PARENT_NOT_OBSERVED',
            "parent must be this batch's actual published commit",
          );
          const commit = await runtime.api('GET', `${API}/git/commits/${parent}`);
          required(
            SHA.test(commit.tree?.sha),
            'FIXTURE_PARENT_TREE_INVALID',
            'parent tree evidence missing',
          );
          const tree = await mutationApi(
            runtime,
            batch,
            `tree:${item.id}`,
            'POST',
            `${API}/git/trees`,
            {
              base_tree: commit.tree.sha,
              tree: [
                {
                  path: `cleanup-fixtures/${batch.plan.batchId}/${item.id}.txt`,
                  mode: '100644',
                  type: 'blob',
                  content: `Administrator fixture ${item.id} for ${batch.plan.batchId}. No execution authorisation.\n`,
                },
              ],
            },
          );
          required(SHA.test(tree.sha), 'FIXTURE_TREE_INVALID', 'new tree SHA missing');
          const created = await mutationApi(
            runtime,
            batch,
            `commit:${item.id}`,
            'POST',
            `${API}/git/commits`,
            {
              message: `fixture: prepare ${item.id} for ${batch.plan.batchId}`,
              tree: tree.sha,
              parents: [parent],
            },
          );
          required(SHA.test(created.sha), 'FIXTURE_COMMIT_INVALID', 'new commit SHA missing');
          item.intendedSha = created.sha;
          saveBatch(batch);
          const published = await mutationApi(
            runtime,
            batch,
            `publish:${item.id}`,
            'POST',
            `${API}/git/refs`,
            {
              ref: `refs/heads/${item.head}`,
              sha: created.sha,
            },
          );
          required(
            published.ref === `refs/heads/${item.head}` && published.object?.sha === created.sha,
            'FIXTURE_REF_PUBLISH_INVALID',
            'exclusive publication response does not match the intended branch',
          );
          item.publishedSha = await refObservation(runtime, item.head);
          required(
            item.publishedSha === created.sha,
            'FIXTURE_REF_CHANGED',
            'newly published branch changed',
          );
          item.branchPublished = true;
          saveBatch(batch);
        } else {
          const original = batch.manifest.fixtures.find(
            (previous) => previous.id === 'head-dependency-target',
          );
          item.publishedSha = original.publishedSha;
          item.branchPublished = true;
        }
        if (item.base !== null) {
          const opened = await mutationApi(
            runtime,
            batch,
            `pull:${item.id}`,
            'POST',
            `${API}/pulls`,
            {
              title: `fixture: ${item.id} (${batch.plan.batchId})`,
              head: item.head,
              base: item.base,
              draft: false,
              body: `Administrator-only cleanup qualification fixture. Batch ${batch.plan.batchId}.\nDisposition: ${item.disposition}.\nNo task claim, Permit or execution authorisation is asserted. Do not delete the source branch.`,
            },
          );
          item.intendedPRNumber = opened.number;
          saveBatch(batch);
          item.pr = await prObservation(runtime, opened.number);
          required(
            item.pr.headRepositoryId === BINDINGS.repositoryId &&
              item.pr.head === item.head &&
              item.pr.base === item.base &&
              item.pr.headSha === item.publishedSha &&
              !item.pr.merged &&
              item.pr.state === 'open',
            'FIXTURE_PR_BINDING_MISMATCH',
            'created PR does not match the exact fixture plan',
          );
          saveBatch(batch);
        }
      }
    },
  );
}
async function closeCase(runtime, batch) {
  required(
    batch.manifest.phase === 'CREATED',
    'FIXTURE_PHASE_INVALID',
    'creation must be complete before closing its selected PR',
  );
  const item = batch.manifest.fixtures.find((fixture) => fixture.id === 'closed-unmerged');
  await preflight(runtime);
  const observed = await prObservation(runtime, item.pr.prNumber);
  required(
    observed.state === 'open' &&
      !observed.merged &&
      observed.headRepositoryId === BINDINGS.repositoryId &&
      observed.base === item.base &&
      observed.head === item.head &&
      observed.headSha === item.publishedSha,
    'FIXTURE_CLOSE_TARGET_CHANGED',
    'selected PR is no longer the intended open fixture',
  );
  const phrase = `CLOSE PR ${observed.prNumber} WITHOUT MERGE SHA ${observed.headSha}`;
  await authorisedPhase(
    runtime,
    batch,
    'CLOSED_CASE',
    phrase,
    `Close only ${observed.url}, without merge or branch deletion. Existing open dependency fixtures stay open.`,
    async () => {
      await preflight(runtime);
      const latest = await prObservation(runtime, observed.prNumber);
      required(
        latest.state === 'open' &&
          !latest.merged &&
          latest.headSha === observed.headSha &&
          latest.head === observed.head &&
          latest.base === observed.base,
        'FIXTURE_CLOSE_TARGET_CHANGED',
        'PR changed while waiting for the human decision',
      );
      const args = [
        'pr',
        'close',
        String(observed.prNumber),
        '--repo',
        `https://github.com/${REPO}`,
      ];
      await mutate(runtime, batch, `close:${item.id}`, args, undefined, () => runtime.gh(args));
      item.pr = await prObservation(runtime, observed.prNumber);
      required(
        item.pr.state === 'closed' && !item.pr.merged,
        'FIXTURE_CLOSE_NOT_OBSERVED',
        'PR was not observed closed and unmerged',
      );
      required(
        (await refObservation(runtime, item.head)) === item.publishedSha,
        'FIXTURE_BRANCH_LOST',
        'closed fixture branch is absent or changed',
      );
    },
  );
}
async function mergeTargets(runtime, batch) {
  required(
    ['CLOSED_CASE', 'MERGE_TARGETS_PARTIAL', 'MERGED_TARGETS'].includes(batch.manifest.phase),
    'FIXTURE_PHASE_INVALID',
    'close the dedicated unmerged case before normal human merges',
  );
  await preflight(runtime);
  for (const item of batch.manifest.fixtures.filter((fixture) =>
    fixture.disposition.startsWith('human-merge'),
  )) {
    if (item.pr.merged === true) continue;
    const observed = await prObservation(runtime, item.pr.prNumber);
    required(
      !observed.merged &&
        observed.state === 'open' &&
        observed.headRepositoryId === BINDINGS.repositoryId &&
        observed.head === item.head &&
        observed.base === 'main' &&
        observed.headSha === item.publishedSha,
      'FIXTURE_MERGE_TARGET_CHANGED',
      'exact human merge target moved or was externally altered',
    );
    const phrase = `MERGE PR ${observed.prNumber} HEAD ${observed.head} SHA ${observed.headSha}`;
    await authorisedPhase(
      runtime,
      batch,
      'MERGE_TARGETS_PARTIAL',
      phrase,
      `You are deciding whether to merge ${observed.url}. Inspect its checks and applicable repository rules. The normal gh merge path must enforce them. No --admin, auto-merge, approval review or branch deletion.`,
      async () => {
        await preflight(runtime);
        const latest = await prObservation(runtime, observed.prNumber);
        required(
          latest.state === 'open' &&
            !latest.merged &&
            latest.headSha === observed.headSha &&
            latest.head === observed.head &&
            latest.base === observed.base,
          'FIXTURE_MERGE_TARGET_CHANGED',
          'PR changed while waiting for the human decision',
        );
        const args = [
          'pr',
          'merge',
          String(observed.prNumber),
          '--repo',
          `https://github.com/${REPO}`,
          '--merge',
        ];
        await mutate(runtime, batch, `merge:${item.id}`, args, undefined, () => runtime.gh(args));
        item.pr = await prObservation(runtime, observed.prNumber);
        required(
          item.pr.merged === true && item.pr.state === 'closed',
          'FIXTURE_MERGE_NOT_OBSERVED',
          'normal merge did not produce an observed merged PR; do not fake or retry an unknown result',
        );
        required(
          (await refObservation(runtime, item.head)) === item.publishedSha,
          'FIXTURE_BRANCH_LOST',
          'the merged source branch was deleted or changed; stop before qualification',
        );
      },
    );
  }
  await lockedPhase(runtime, batch, 'MERGED_TARGETS', async () => {}, { retainOnFailure: true });
}
async function* pullPages(runtime, endpoint, invalidCode, incompleteCode) {
  for (let page = 1; page <= 100; page++) {
    const rows = await runtime.api('GET', `${endpoint}&page=${page}`);
    required(
      Array.isArray(rows) && rows.every((row) => cleanupObject(row)),
      invalidCode,
      'complete structured PR pagination required',
    );
    yield rows;
    if (rows.length < 100) return;
    required(
      page !== 100,
      incompleteCode,
      'pagination cap reached; incomplete evidence is refused',
    );
  }
}
async function inspectBatch(runtime, batch) {
  const preflightResult = await preflight(runtime);
  const observations = [];
  for (const item of batch.manifest.fixtures) {
    const observation = {
      id: item.id,
      head: item.head,
      base: item.base,
      plannedDisposition: item.disposition,
      localRecordedSha: item.publishedSha ?? null,
      actualRefSha: null,
      pr: null,
      issue: null,
    };
    try {
      if (item.intendedSha || item.branchPublished)
        observation.actualRefSha = await refObservation(runtime, item.head);
      const number = item.pr?.prNumber ?? item.intendedPRNumber;
      if (number) observation.pr = await prObservation(runtime, number);
      else if (item.base !== null && observation.actualRefSha) {
        // A completed PR creation can lose its acknowledgement. Discover it read-only, never retry the POST.
        const matches = [];
        const head = encodeURIComponent(`${REPO.split('/')[0]}:${item.head}`),
          base = encodeURIComponent(item.base);
        for await (const rows of pullPages(
          runtime,
          `${API}/pulls?state=all&head=${head}&base=${base}&per_page=100`,
          'FIXTURE_PARTIAL_DISCOVERY_INVALID',
          'FIXTURE_PARTIAL_DISCOVERY_INCOMPLETE',
        )) {
          for (const row of rows) {
            if (
              row.head?.repo?.id === BINDINGS.repositoryId &&
              row.head.ref === item.head &&
              row.base?.repo?.id === BINDINGS.repositoryId &&
              row.base.ref === item.base
            )
              matches.push(row.number);
          }
        }
        required(
          matches.length < 2,
          'FIXTURE_PARTIAL_PR_AMBIGUOUS',
          'multiple PRs match; preserve them and do not guess',
        );
        if (matches.length === 1) observation.pr = await prObservation(runtime, matches[0]);
      }
    } catch (error) {
      observation.issue = error.code ?? 'FIXTURE_OBSERVATION_FAILED';
    }
    observations.push(observation);
  }
  const report = {
    schema: 'openslack.cleanup_fixture_observation.v1',
    observedAt: runtime.now(),
    repository: REPO,
    repositoryId: BINDINGS.repositoryId,
    batchId: batch.plan.batchId,
    currentMainSha: preflightResult.mainSha,
    phase: batch.manifest.phase,
    fixtures: observations,
    taskScopeAttested: false,
    permitIssued: false,
    qualificationRun: false,
    warning:
      'Read-only observation; not a task-scope attestation, authority or qualification result.',
  };
  const file = path.join(
    batch.directory,
    `observation-${runtime.now().replace(/[^0-9TZ]/g, '')}-${randomBytes(4).toString('hex')}.json`,
  );
  exclusiveWrite(file, JSON_BYTES(report), batch.anchor);
  runtime.log(
    JSON.stringify(
      {
        state: 'OBSERVED_READ_ONLY',
        report: file,
        manifest: path.join(batch.directory, 'manifest.json'),
      },
      null,
      2,
    ),
  );
  return report;
}
async function advanceDrift(runtime, batch, permitId, approvedSha) {
  required(
    batch.manifest.phase === 'MERGED_TARGETS',
    'FIXTURE_PHASE_INVALID',
    'only the intact completed initial fixture batch can be advanced',
  );
  required(
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(permitId) && SHA.test(approvedSha),
    'FIXTURE_DRIFT_INPUT_INVALID',
    'a concrete Permit reference and 40-hex approval snapshot SHA are required',
  );
  const item = batch.manifest.fixtures.find((fixture) => fixture.id === 'drift');
  required(
    !item.drift && item.publishedSha === approvedSha,
    'FIXTURE_APPROVED_SHA_MISMATCH',
    'the Permit snapshot must be the original drift fixture SHA',
  );
  await preflight(runtime);
  const current = await prObservation(runtime, item.pr.prNumber);
  required(
    current.merged === true &&
      current.head === item.head &&
      (await refObservation(runtime, item.head)) === approvedSha,
    'FIXTURE_DRIFT_TARGET_CHANGED',
    'the initial merged drift branch must still equal the referenced snapshot',
  );
  const phrase = `ADVANCE DRIFT PR ${current.prNumber} REF refs/heads/${item.head} FROM ${approvedSha} PERMIT ${permitId}`;
  await authorisedPhase(
    runtime,
    batch,
    'DRIFT_APPLIED',
    phrase,
    'This separate administrator decision changes only this drift fixture AFTER its exact Permit snapshot was reviewed. This script does not validate, issue, consume or execute the Permit. It creates a forward commit, never a force reset or ABA restore. The changed target stops the corresponding destructive batch. Re-observe it; refreshing a task view requires controlled stop, a new boot, activation and Permit, never hot replacement.',
    async () => {
      await preflight(runtime);
      required(
        (await refObservation(runtime, item.head)) === approvedSha,
        'FIXTURE_DRIFT_TARGET_CHANGED',
        'drift ref changed during the human decision',
      );
      const previous = await runtime.api('GET', `${API}/git/commits/${approvedSha}`);
      const tree = await mutationApi(runtime, batch, 'drift:tree', 'POST', `${API}/git/trees`, {
        base_tree: previous.tree.sha,
        tree: [
          {
            path: `cleanup-fixtures/${batch.plan.batchId}/later-drift.txt`,
            mode: '100644',
            type: 'blob',
            content: 'Separately human-authorised forward SHA drift.\n',
          },
        ],
      });
      const commit = await mutationApi(
        runtime,
        batch,
        'drift:commit',
        'POST',
        `${API}/git/commits`,
        {
          message: `fixture: advance authorised drift for ${batch.plan.batchId}`,
          tree: tree.sha,
          parents: [approvedSha],
        },
      );
      required(
        SHA.test(commit.sha),
        'FIXTURE_DRIFT_COMMIT_INVALID',
        'observed new commit SHA is missing',
      );
      item.drift = {
        originalSnapshotSha: approvedSha,
        permitReference: permitId,
        intendedSha: commit.sha,
        observedSha: null,
        observedAt: runtime.now(),
      };
      saveBatch(batch);
      await mutationApi(
        runtime,
        batch,
        'drift:update-forward-only',
        'PATCH',
        `${API}/git/refs/heads/${item.head}`,
        { sha: commit.sha, force: false },
      );
      item.drift.observedSha = await refObservation(runtime, item.head);
      required(
        item.drift.observedSha === commit.sha,
        'FIXTURE_DRIFT_NOT_OBSERVED',
        'ref did not match the forward commit',
      );
    },
  );
}
async function registerFork(runtime, batch) {
  await preflight(runtime);
  const candidates = [];
  for await (const rows of pullPages(
    runtime,
    `${API}/pulls?state=all&per_page=100`,
    'FIXTURE_FORK_LIST_INVALID',
    'FIXTURE_FORK_LIST_INCOMPLETE',
  )) {
    for (const row of rows) {
      if (
        row.merged_at &&
        row.head?.repo?.id &&
        row.head.repo.id !== BINDINGS.repositoryId &&
        row.base?.repo?.id === BINDINGS.repositoryId &&
        row.base.ref === 'main'
      )
        candidates.push(row.number);
    }
  }
  if (candidates.length === 0) {
    runtime.log(
      'FORK_BLOCKED: no existing merged canonical-base fork PR observed. Creating/mutating another repository needs separate administrator scope; nothing created.',
    );
    return;
  }
  required(
    candidates.length === 1,
    'FIXTURE_FORK_SELECTION_REQUIRED',
    'multiple existing fork PRs require a separately reviewed exact selection; nothing changed',
  );
  const actual = await prObservation(runtime, candidates[0]);
  required(
    actual.merged && actual.base === 'main' && actual.headRepositoryId !== BINDINGS.repositoryId,
    'FIXTURE_FORK_EVIDENCE_INVALID',
    'observed fork candidate does not isolate the fork refusal',
  );
  required(
    await runtime.confirm(
      `RECORD EXISTING FORK PR ${actual.prNumber} NODE ${actual.prNodeId}`,
      `Read-only external fixture: ${actual.url}. No fork repository or branch will be created, changed or deleted.`,
    ),
    'FIXTURE_CONFIRMATION_DECLINED',
    'fork evidence was not selected',
  );
  await lockedPhase(
    runtime,
    batch,
    batch.manifest.phase,
    async () => {
      await preflight(runtime);
      const latest = await prObservation(runtime, actual.prNumber);
      // Collection times advance even when the GitHub resource is unchanged.
      // Compare private copies; retain the new timestamp in published evidence.
      const currentResource = { ...latest },
        previousResource = { ...actual };
      delete currentResource.observedAt;
      delete previousResource.observedAt;
      required(
        JSON_BYTES(currentResource).equals(JSON_BYTES(previousResource)),
        'FIXTURE_FORK_TARGET_CHANGED',
        'fork resource changed during confirmation; do not publish stale qualification evidence',
      );
      batch.manifest.fork = { state: 'OBSERVED_EXISTING_MERGED_FORK', observedPR: latest };
    },
    { retainOnFailure: true },
  );
}

export async function main(argv, dependencies = {}) {
  const [command, ...rest] = argv;
  const allowed = {
    plan: ['scratch-root'],
    create: ['batch'],
    'close-case': ['batch'],
    'merge-targets': ['batch'],
    inspect: ['batch'],
    'advance-drift': ['batch', 'permit-id', 'approved-sha'],
    'register-existing-fork': ['batch'],
  };
  required(
    Object.hasOwn(allowed, command ?? '') && rest.length % 2 === 0,
    'FIXTURE_ARGUMENT_INVALID',
    'choose a documented closed command with complete option pairs',
  );
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i].startsWith('--') ? rest[i].slice(2) : '';
    required(
      allowed[command].includes(key) &&
        !Object.hasOwn(options, key) &&
        typeof rest[i + 1] === 'string' &&
        rest[i + 1].length > 0 &&
        !/[\u0000-\u001f\u007f]/.test(rest[i + 1]),
      'FIXTURE_ARGUMENT_INVALID',
      'unknown, repeated, empty or control-character option',
    );
    options[key] = rest[i + 1];
  }
  required(
    allowed[command].every((key) => Object.hasOwn(options, key)),
    'FIXTURE_ARGUMENT_INVALID',
    'all documented arguments are required',
  );
  for (const key of ['scratch-root', 'batch']) {
    if (Object.hasOwn(options, key))
      required(
        !isSensitiveCleanupInput(options[key]) &&
          !isSensitiveCleanupInput(path.resolve(options[key])),
        'FIXTURE_ARGUMENT_INVALID',
        'credential and secret paths are not fixture inputs or outputs',
      );
    if (Object.hasOwn(options, key))
      required(
        !options[key].split(/[\\/]/).includes('..'),
        'FIXTURE_ARGUMENT_INVALID',
        'path traversal is not a fixture path',
      );
  }
  const runtime = createRuntime(dependencies);
  if (command === 'plan') return planBatch(runtime, options['scratch-root']);
  const anchor = fixtureDirectory(options.batch);
  runtime.directory = anchor;
  try {
    const batch = loadBatch(options.batch, anchor);
    if (command === 'create') await createBatch(runtime, batch);
    if (command === 'close-case') await closeCase(runtime, batch);
    if (command === 'merge-targets') await mergeTargets(runtime, batch);
    if (command === 'inspect') return await inspectBatch(runtime, batch);
    if (command === 'advance-drift')
      await advanceDrift(runtime, batch, options['permit-id'], options['approved-sha']);
    if (command === 'register-existing-fork') await registerFork(runtime, batch);
    runtime.log(
      JSON.stringify(
        {
          state: batch.manifest.phase,
          manifest: path.join(batch.directory, 'manifest.json'),
          repository: REPO,
          permitIssued: false,
          qualificationRun: false,
        },
        null,
        2,
      ),
    );
  } finally {
    anchor.close();
  }
}
