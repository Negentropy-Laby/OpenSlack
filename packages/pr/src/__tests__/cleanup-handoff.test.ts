import { createHash } from 'node:crypto';
import type * as Crypto from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import {
  cpSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { platformTestTimeout } from '../../../../scripts/testing/process-fixture.mjs';
import {
  assertCleanupHandoffRuntime,
  prepareCleanupHandoffDraft,
  verifyCleanupHandoffPackage,
} from '../cleanup-handoff.js';
import type { PrepareCleanupHandoffDraftInput } from '../cleanup-handoff.js';

const digestWork = vi.hoisted(() => [] as Buffer[]);
vi.mock('node:crypto', async (original) => {
  const crypto = await original<typeof Crypto>();
  return {
    ...crypto,
    createHash: (...args: Parameters<typeof crypto.createHash>) => {
      const hash = crypto.createHash(...args),
        update = hash.update.bind(hash);
      hash.update = ((...args: Parameters<typeof hash.update>) => {
        if (Buffer.isBuffer(args[0])) digestWork.push(args[0]);
        return update(...args);
      }) as typeof hash.update;
      return hash;
    },
  };
});
const roots: string[] = [];
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const timestamp = '2026-10-08T12:30:00.000Z';
// A small structural ELF/Go build-info fixture. It is never executed or claimed
// to be a compiled Broker; real Broker bytes are verified during clean builds.
function fixtureBroker(head: string): Buffer {
  const frame = Buffer.concat([
    Buffer.alloc(16),
    Buffer.from(
      `path\tgithub.com/Negentropy-Laby/OpenSlack/services/cleanup-broker/cmd/cleanup-broker\nbuild\tvcs.revision=${head}\nbuild\tvcs.modified=false\nbuild\t-trimpath=true\nbuild\tCGO_ENABLED=0\nbuild\tGOOS=linux\nbuild\tGOARCH=amd64\nbuild\tvcs=git\n`,
    ),
    Buffer.alloc(16),
  ]);
  const inline = (raw: Buffer) => {
    let length = raw.length;
    const bytes: number[] = [];
    do {
      const byte = length % 128;
      length = Math.floor(length / 128);
      bytes.push(byte | (length ? 128 : 0));
    } while (length);
    return Buffer.concat([Buffer.from(bytes), raw]);
  };
  const header = Buffer.alloc(32);
  Buffer.from('\xff Go buildinf:', 'latin1').copy(header);
  header[14] = 8;
  header[15] = 2;
  const info = Buffer.concat([header, inline(Buffer.from('go1.26.5')), inline(frame)]);
  const raw = Buffer.alloc(288 + info.length),
    names = Buffer.from('\0.shstrtab\0.go.buildinfo\0');
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]).copy(raw);
  raw.writeUInt16LE(62, 18);
  raw.writeBigUInt64LE(64n, 40);
  raw.writeUInt16LE(64, 58);
  raw.writeUInt16LE(3, 60);
  raw.writeUInt16LE(1, 62);
  raw.writeUInt32LE(1, 128);
  raw.writeBigUInt64LE(256n, 152);
  raw.writeBigUInt64LE(BigInt(names.length), 160);
  raw.writeUInt32LE(11, 192);
  raw.writeBigUInt64LE(288n, 216);
  raw.writeBigUInt64LE(BigInt(info.length), 224);
  names.copy(raw, 256);
  info.copy(raw, 288);
  return raw;
}
afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'cleanup handoff '));
  roots.push(root);
  const source = join(root, 'source');
  mkdirSync(source);
  const put = (path: string, bytes: string | Buffer) => {
    const full = join(root, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, bytes);
    return full;
  };
  put('source/package.json', JSON.stringify({ devDependencies: { 'bun-types': '1.4.0' } }));
  put('source/bun.lock', 'fixture lock');
  put('source/LICENSE', 'fixture source license\n');
  put('source/services/cleanup-broker/go.mod', 'module fixture\ngo 1.26.5\n');
  put('source/services/cleanup-broker/handoff.md', '# Fixture procedure\n');
  put('source/services/cleanup-broker/README.md', '# Fixture README\n');
  for (const name of ['broker', 'install-manifest', 'task-dependencies'])
    put(`source/services/cleanup-broker/handoff/${name}.template.json`, '{}\n');
  put(
    'source/.openslack/agents/registry/fixture_agent.yaml',
    JSON.stringify({
      schema: 'openslack.agent_registry.v2',
      agent_id: 'fixture_agent',
      identity: { uid: 'fixture_agent', principal_id: 'principal:fixture_agent' },
      permissions: {
        max_risk_zone: 'yellow',
        actions: { 'pr.cleanup_branch_scoped.v1': 'allow', 'pr.cleanup_branch': 'deny' },
      },
    }),
  );
  const run = promisify(execFile);
  const git = async (...args: string[]) =>
    (
      await run('git', args, {
        cwd: source,
        encoding: 'utf8',
        timeout: 4_000,
      })
    ).stdout.trim();
  await git('init', '-q');
  await git('add', '.');
  await git(
    '-c',
    'user.name=fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'fixture',
  );
  const candidateHead = await git('rev-parse', 'HEAD');
  const broker = fixtureBroker(candidateHead);
  for (const id of ['a', 'b']) cpSync(source, join(root, `checkout-${id}`), { recursive: true });
  const executor = Buffer.from('fixture executor');
  const makeBuild = (id: string) => ({
    brokerPath: put(`build-${id}/cleanup-broker`, broker),
    executorPath: put(`build-${id}/executor.mjs`, executor),
    reportPath: put(
      `build-${id}/report.json`,
      JSON.stringify({
        schema: 'openslack.pr418.clean-build-report.v1',
        candidateHead,
        checkout: join(root, `checkout-${id}`),
        checkoutCleanAfterBuild: true,
        independentCloneNoHardlinks: true,
        tools: { bun: '1.4.0', go: 'go version go1.26.5 linux/amd64', node: 'v24.18.1' },
        broker: { sha256: digest(broker), bytes: broker.length },
        executor: { sha256: digest(executor), bytes: executor.length },
        lockfileSHA256: digest('fixture lock'),
        goModuleSHA256: digest('module fixture\ngo 1.26.5\n'),
        commands: ['CGO_ENABLED=0 go build -trimpath -buildvcs=true'],
      }),
    ),
  });
  const builds: PrepareCleanupHandoffDraftInput['builds'] = [makeBuild('a'), makeBuild('b')];
  const runtimeDirectory = join(root, 'runtime');
  for (const name of ['node', 'git', 'sh', 'git-remote-https'])
    put(`runtime/${name}`, `fixture ${name}`);
  const nodeChecksumPath = put('evidence/node-SHASUMS256.txt', 'fixture official list\n');
  const nodeLicensePath = put('evidence/node-LICENSE', 'fixture license\n');
  const runtimeLicensePaths = [put('evidence/git-copyright', 'fixture runtime license\n')];
  const installationManifestPath = put(
    'inputs/install-manifest.REVIEW.json',
    JSON.stringify({
      schema: 'openslack.cleanup_installation.v1',
      network: { httpsProxy: '', noProxy: '' },
      files: ['node', 'executor.mjs', 'git', 'sh']
        .map((name) => ({
          path: `/usr/lib/openslack-cleanup/${name}`,
          sha256: digest(name === 'executor.mjs' ? 'old executor.mjs' : `fixture ${name}`),
        }))
        .concat([
          {
            path: '/usr/lib/openslack-cleanup/git-core/git-remote-https',
            sha256: digest('fixture git-remote-https'),
          },
        ]),
    }),
  );
  const task = {
    schema: 'openslack.cleanup_task_view.v1',
    workspaceId: 'fixture-workspace',
    repository: 'fixture/qualification',
    repositoryId: '12345',
    notBefore: '2026-10-08T12:00:00.000Z',
    expiresAt: '2026-10-09T12:00:00.000Z',
    tasks: [],
  };
  const taskViewPath = put('inputs/task-view.REVIEW.json', JSON.stringify(task));
  const taskAttestationPath = put(
    'inputs/task-view-attestation.json',
    JSON.stringify({ task_view_sha256: digest(JSON.stringify(task)) }),
  );
  const appScopePath = put('inputs/app-scope.json', '{}\n');
  const networkPath = put('inputs/network.json', '{}\n');
  const identityPath = put('inputs/identity.json', '{}\n');
  const dependencyInventoryPath = put('inputs/dependency-inventory.json', '{}\n');
  const priorInputPath = put(
    'inputs/admin-inputs.APPROVED.md',
    [
      '# Historical non-secret administrator input\n',
      'approval_status: APPROVED',
      'approved_by: github:fixture',
      `approved_at_utc: ${timestamp}`,
      `candidate_head: ${'a'.repeat(40)}`,
      `package_manifest_sha256: ${'b'.repeat(64)}`,
      'agent_id: fixture_agent',
      'broker_id: fixture-broker',
      'workspace_id: fixture-workspace',
      'principal_id: principal:fixture_agent',
      'runtime_uid_claim: fixture_agent',
      'run_id: fixture-run',
      'issuer_trust_domain: fixture:cleanup-admin',
      'target_distro: Fixture-WSL',
      'broker_uid: 44180',
      'broker_gid: 44180',
      'agent_uid: 44181',
      'agent_gid: 44181',
      'allowed_git_remote_name: origin',
      'qualification_repository_owner: fixture',
      'qualification_repository_name: qualification',
      'qualification_repository_numeric_id: 12345',
      'qualification_repository_default_branch: main',
      'automatic_branch_deletion: false',
      'deletion_app_id: 123',
      'deletion_app_installation_id: 456',
      'approved_https_proxy: ""',
      'approved_no_proxy: ""',
    ].join('\n') + '\n',
  );
  const verifierPath = put('verify-handoff.mjs', 'fixture offline verifier\n');
  const input: PrepareCleanupHandoffDraftInput = {
    sourceRoot: source,
    candidateHead,
    outputDirectory: join(root, 'new candidate output'),
    builds,
    runtimeDirectory,
    nodeChecksumPath,
    nodeLicensePath,
    runtimeLicensePaths,
    priorInputPath,
    verifierPath,
    targetEvidence: {
      installationManifestPath,
      taskViewPath,
      taskAttestationPath,
      appScopePath,
      networkPath,
      identityPath,
      dependencyInventoryPath,
    },
    now: new Date(timestamp),
  };
  return { root, put, input, git, task, taskViewPath, priorInputPath };
}

function verify(result: ReturnType<typeof prepareCleanupHandoffDraft>, now = new Date(timestamp)) {
  return verifyCleanupHandoffPackage({
    packageDirectory: result.packageDirectory,
    candidateHead: result.candidateHead,
    manifestSHA256: result.manifestSHA256,
    now,
  });
}

describe('offline cleanup handoff preparation', () => {
  describe('real Git preparation responsiveness', () => {
    let respondedAtPreparationEnd = false;
    let candidateHead: string;
    beforeAll(async () => {
      let responded = false;
      setImmediate(() => {
        responded = true;
      });
      const prepared = await fixture();
      // Capture here: a synchronous fixture must not pass merely because
      // Vitest yields between preparation and the assertion callback.
      respondedAtPreparationEnd = responded;
      candidateHead = prepared.input.candidateHead;
    }, platformTestTimeout(30_000));
    it('keeps real Git fixture preparation responsive to worker task updates', () => {
      expect(respondedAtPreparationEnd).toBe(true);
      expect(candidateHead).toMatch(/^[a-f0-9]{40}$/);
    });
  });

  it('preserves selected bindings, recalculates actual hashes, and never inherits old approval', async () => {
    const { input, priorInputPath } = await fixture();
    const original = readFileSync(priorInputPath);
    const network = vi.fn(() => {
      throw new Error('network forbidden');
    });
    vi.stubGlobal('fetch', network);
    const result = prepareCleanupHandoffDraft(input);
    expect(result.approvalStatus).toBe('DRAFT');
    expect(result.priorInputSHA256).toBe(digest(original));
    expect(readFileSync(priorInputPath)).toEqual(original);
    expect(network).not.toHaveBeenCalled();
    const draft = readFileSync(result.adminInputPath, 'utf8');
    expect(draft).toContain('approval_status: DRAFT');
    expect(draft).toContain('approved_by: REQUIRED');
    expect(draft).toContain(`package_manifest_sha256: ${result.manifestSHA256}`);
    const selected = JSON.parse(
      readFileSync(join(result.packageDirectory, 'draft/inputs.DRAFT.json'), 'utf8'),
    ).selected;
    expect(selected.candidate_head).toBe(result.candidateHead);
    expect(selected).not.toHaveProperty('package_manifest_sha256');
    const config = JSON.parse(
      readFileSync(join(result.packageDirectory, 'draft/broker.DRAFT.json'), 'utf8'),
    );
    expect(config.peerBindings[0].subject.runId).toBe('fixture-run');
    expect(config.githubApp).toEqual({
      appId: 123,
      installationId: 456,
      owner: 'fixture',
      repo: 'qualification',
    });
    expect(config.artifacts.nodeSHA256).toBe(digest('fixture node'));
    const checked = verify(result);
    expect(checked.valid).toBe(true);
    expect(checked.installationAuthorized).toBe(false);
    expect(checked.executionAuthorized).toBe(false);
    expect(checked.unmetGates).toContain('REGISTRY_MAIN_DEPLOYMENT_NOT_VERIFIED');
    expect(checked.unmetGates).toContain('NEW_INPUT_REVIEW_REQUIRED');
    expect(readdirSync(input.sourceRoot).sort()).toEqual([
      '.git',
      '.openslack',
      'LICENSE',
      'bun.lock',
      'package.json',
      'services',
    ]);
  });

  it.each(['dirty', 'drift', 'candidate'])(
    'refuses %s source before creating output',
    async (mode) => {
      const { input, put } = await fixture();
      if (mode === 'dirty') put('source/untracked.txt', 'dirty');
      if (mode === 'drift') put('source/bun.lock', 'changed');
      if (mode === 'candidate') input.candidateHead = 'f'.repeat(40);
      expect(() => prepareCleanupHandoffDraft(input)).toThrowError(
        expect.objectContaining({
          code: mode === 'candidate' ? 'HANDOFF_CANDIDATE_MISMATCH' : 'HANDOFF_SOURCE_DIRTY',
        }),
      );
      expect(readdirSync(join(input.outputDirectory, '..'))).not.toContain('new candidate output');
    },
  );

  it('hashes each safely read large artifact once per verification and accepts historical schemas', async () => {
    const { input } = await fixture();
    const result = prepareCleanupHandoffDraft(input);
    digestWork.length = 0;
    expect(
      verifyCleanupHandoffPackage({
        packageDirectory: result.packageDirectory,
        candidateHead: result.candidateHead,
        manifestSHA256: result.manifestSHA256,
      }).valid,
    ).toBe(true);
    for (const name of ['cleanup-broker', 'executor.mjs', 'node']) {
      const bytes = readFileSync(join(result.packageDirectory, 'artifacts', name));
      expect(
        digestWork.filter((work) => work.equals(bytes)),
        name,
      ).toHaveLength(1);
    }
    const indexPath = join(result.packageDirectory, 'evidence/qualification-index.json');
    const index = JSON.parse(readFileSync(indexPath, 'utf8'));
    expect(index.schema).toBe('openslack.cleanup_handoff_evidence_index.v1');
    index.schema = 'openslack.pr418.qualification-evidence-index.v1';
    writeFileSync(indexPath, JSON.stringify(index));
    const sumPath = join(result.packageDirectory, 'SHA256SUMS');
    const sums = readFileSync(sumPath, 'utf8').replace(
      /^([a-f0-9]{64})(  \.\/evidence\/qualification-index\.json)$/m,
      digest(readFileSync(indexPath)) + '$2',
    );
    writeFileSync(sumPath, sums);
    const legacy = verifyCleanupHandoffPackage({
      packageDirectory: result.packageDirectory,
      candidateHead: result.candidateHead,
      manifestSHA256: digest(Buffer.from(sums)),
    });
    expect(legacy.valid).toBe(true);
    expect(legacy.executionAuthorized).toBe(false);
  });
  it.each(['candidate', 'digest', 'revision', 'tools'])(
    'refuses a %s build report mismatch',
    async (mode) => {
      const { input } = await fixture();
      const report = JSON.parse(readFileSync(input.builds[0].reportPath, 'utf8'));
      if (mode === 'candidate') report.candidateHead = 'f'.repeat(40);
      if (mode === 'digest') report.broker.sha256 = 'f'.repeat(64);
      if (mode === 'tools') report.tools.node = 'v22.0.0';
      if (mode === 'revision') writeFileSync(input.builds[0].brokerPath, 'wrong revision');
      writeFileSync(input.builds[0].reportPath, JSON.stringify(report));
      expect(() => prepareCleanupHandoffDraft(input)).toThrowError(
        expect.objectContaining({ code: 'HANDOFF_BUILD_MISMATCH' }),
      );
    },
  );

  it.each(['independence', 'plaintext', 'missing-checkout'])(
    'rejects false %s build evidence',
    async (mode) => {
      const { input } = await fixture();
      const build = input.builds[0],
        report = JSON.parse(readFileSync(build.reportPath, 'utf8'));
      if (mode === 'independence') report.independentCloneNoHardlinks = false;
      if (mode === 'missing-checkout') report.checkout += '-missing';
      if (mode === 'plaintext') {
        const bytes = Buffer.from(
          `vcs.revision=${input.candidateHead}\nvcs.modified=false\n-trimpath=true\nCGO_ENABLED=0\n`,
        );
        writeFileSync(build.brokerPath, bytes);
        report.broker = { sha256: digest(bytes), bytes: bytes.length };
      }
      writeFileSync(build.reportPath, JSON.stringify(report));
      expect(() => prepareCleanupHandoffDraft(input)).toThrowError(
        expect.objectContaining({
          code: 'HANDOFF_BUILD_MISMATCH',
        }),
      );
    },
  );

  it.each(['revision', 'version', 'bounds'])(
    'rejects structurally invalid %s Go build identity',
    async (mode) => {
      const { input } = await fixture();
      let bytes = fixtureBroker(mode === 'revision' ? 'f'.repeat(40) : input.candidateHead);
      if (mode === 'version')
        bytes = Buffer.from(bytes.toString('latin1').replace('go1.26.5', 'go1.26.6'), 'latin1');
      if (mode === 'bounds') bytes.writeBigUInt64LE(BigInt(bytes.length + 100), 40);
      for (const build of input.builds) {
        writeFileSync(build.brokerPath, bytes);
        const report = JSON.parse(readFileSync(build.reportPath, 'utf8'));
        report.broker = { bytes: bytes.length, sha256: digest(bytes) };
        writeFileSync(build.reportPath, JSON.stringify(report));
      }
      expect(() => prepareCleanupHandoffDraft(input)).toThrowError(
        expect.objectContaining({ code: 'HANDOFF_BUILD_MISMATCH' }),
      );
    },
  );

  it.each(['hardlink', 'alternates'])(
    'rejects %s object sharing between build checkouts',
    async (mode) => {
      const { input } = await fixture();
      const a = JSON.parse(readFileSync(input.builds[0].reportPath, 'utf8')).checkout;
      const b = JSON.parse(readFileSync(input.builds[1].reportPath, 'utf8')).checkout;
      if (mode === 'alternates')
        writeFileSync(join(a, '.git/objects/info/alternates'), join(b, '.git/objects') + '\n');
      else {
        const objects = join(a, '.git/objects');
        const directory = readdirSync(objects).find((name) => /^[a-f0-9]{2}$/.test(name))!;
        const name = readdirSync(join(objects, directory))[0]!;
        const target = join(b, '.git/objects', directory, name);
        rmSync(target);
        linkSync(join(objects, directory, name), target);
      }
      expect(() => prepareCleanupHandoffDraft(input)).toThrowError(
        expect.objectContaining({ code: 'HANDOFF_BUILD_MISMATCH' }),
      );
    },
  );

  it.each(['.git', '.git/objects'])(
    'rejects a symlinked %s root before inspecting build checkouts',
    async (directory) => {
      const { input } = await fixture();
      const a = JSON.parse(readFileSync(input.builds[0].reportPath, 'utf8')).checkout;
      const b = JSON.parse(readFileSync(input.builds[1].reportPath, 'utf8')).checkout;
      rmSync(join(a, directory), { recursive: true });
      symlinkSync(
        join(b, directory),
        join(a, directory),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      expect(() => prepareCleanupHandoffDraft(input)).toThrowError(
        expect.objectContaining({ code: 'HANDOFF_PATH_UNSAFE' }),
      );
    },
  );

  it('detects source bytes hidden by an assume-unchanged index entry', async () => {
    const { input, git, put } = await fixture();
    await git('update-index', '--assume-unchanged', 'bun.lock');
    put('source/package.json', JSON.stringify({ devDependencies: { 'bun-types': '1.4.0' } }));
    put('source/bun.lock', 'hidden drift');
    expect(() => prepareCleanupHandoffDraft(input)).toThrowError(
      expect.objectContaining({ code: 'HANDOFF_SOURCE_CHANGED' }),
    );
  });

  it('rejects symlink ancestors without reading through them', async () => {
    const { input, root } = await fixture();
    const alias = join(root, 'runtime alias');
    symlinkSync(input.runtimeDirectory, alias, process.platform === 'win32' ? 'junction' : 'dir');
    input.runtimeDirectory = alias;
    expect(() => prepareCleanupHandoffDraft(input)).toThrowError(
      expect.objectContaining({ code: 'HANDOFF_PATH_UNSAFE' }),
    );
  });

  it('rejects expired task evidence without extending its window', async () => {
    const { input } = await fixture();
    input.now = new Date('2026-10-10T00:00:00Z');
    expect(() => prepareCleanupHandoffDraft(input)).toThrowError(
      expect.objectContaining({ code: 'HANDOFF_TASK_EVIDENCE_EXPIRED' }),
    );
  });

  it('does not overwrite an existing output directory', async () => {
    const { input } = await fixture();
    mkdirSync(input.outputDirectory);
    writeFileSync(join(input.outputDirectory, 'human.txt'), 'preserve');
    expect(() => prepareCleanupHandoffDraft(input)).toThrowError(
      expect.objectContaining({ code: 'HANDOFF_OUTPUT_EXISTS' }),
    );
    expect(readFileSync(join(input.outputDirectory, 'human.txt'), 'utf8')).toBe('preserve');
  });

  it('refuses credential input paths and active installation output paths', async () => {
    const { input, put } = await fixture();
    input.priorInputPath = put('credentials/admin-inputs.md', 'not to be read');
    expect(() => prepareCleanupHandoffDraft(input)).toThrowError(
      expect.objectContaining({ code: 'HANDOFF_PATH_UNSAFE' }),
    );
    input.priorInputPath = join(input.outputDirectory, '..', 'inputs/admin-inputs.APPROVED.md');
    input.outputDirectory = '/etc/openslack-cleanup/new-draft';
    expect(() => prepareCleanupHandoffDraft(input)).toThrowError(
      expect.objectContaining({ code: 'HANDOFF_PATH_UNSAFE' }),
    );
  });
});

describe('runtime preflight before tool execution', () => {
  it('selects only the ordinary runtime matching the previous reviewed manifest', async () => {
    const { input } = await fixture();
    expect(assertCleanupHandoffRuntime(input)).toBe(join(input.runtimeDirectory, 'node'));
  });

  it('binds a relative runtime directory to the validated absolute executable, avoiding PATH lookup', async () => {
    const { input } = await fixture();
    const reviewedNode = join(input.runtimeDirectory, 'node');
    input.runtimeDirectory = relative(process.cwd(), input.runtimeDirectory);
    expect(assertCleanupHandoffRuntime(input)).toBe(reviewedNode);
  });

  it.each(['tamper', 'symlink', 'credentials'])(
    'rejects %s before returning an executable path',
    async (mode) => {
      const { input, put } = await fixture();
      const path = join(input.runtimeDirectory, 'node');
      if (mode === 'tamper') writeFileSync(path, 'unreviewed executable');
      if (mode === 'symlink') {
        rmSync(path);
        symlinkSync(join(input.runtimeDirectory, 'git'), path);
      }
      if (mode === 'credentials') {
        put('credentials/node', 'must not read');
        input.runtimeDirectory = join(input.runtimeDirectory, '..', 'credentials');
      }
      expect(() => assertCleanupHandoffRuntime(input)).toThrowError(
        expect.objectContaining({
          code: mode === 'tamper' ? 'HANDOFF_BUILD_MISMATCH' : 'HANDOFF_PATH_UNSAFE',
        }),
      );
    },
  );
});

describe('standalone package integrity contract', () => {
  it('runs the bundled Node verifier outside the checkout with no Git, modules or network', async () => {
    const { input, root } = await fixture();
    const bundle = join(root, 'offline-verifier.mjs');
    execFileSync(
      'bun',
      [
        'build',
        'scripts/cleanup-broker/verify-handoff.ts',
        '--target=node',
        '--format=esm',
        '--outfile',
        bundle,
      ],
      {
        cwd: join(import.meta.dirname, '../../../..'),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    input.verifierPath = bundle;
    const result = prepareCleanupHandoffDraft(input);
    const cwd = join(root, 'empty launch directory');
    mkdirSync(cwd);
    const env = { ...process.env, PATH: '', Path: '', GH_TOKEN: '', GITHUB_TOKEN: '' };
    const output = execFileSync(
      process.execPath,
      [
        bundle,
        '--package',
        result.packageDirectory,
        '--candidate',
        result.candidateHead,
        '--manifest-sha256',
        result.manifestSHA256,
      ],
      { cwd, env, encoding: 'utf8' },
    );
    const checked = JSON.parse(output);
    expect(checked.valid).toBe(true);
    expect(checked.installationAuthorized).toBe(false);
    expect(checked.executionAuthorized).toBe(false);
    expect(readdirSync(cwd)).toEqual([]);
    const duplicate = () =>
      execFileSync(
        process.execPath,
        [bundle, '--candidate', result.candidateHead, '--candidate', result.candidateHead],
        { cwd, env, stdio: 'pipe' },
      );
    expect(duplicate).toThrowError(expect.objectContaining({ status: 2 }));
  });

  it.each(['broker', 'task', 'approval'])(
    'rejects internally inconsistent %s evidence even with a new manifest digest',
    async (mode) => {
      const { input } = await fixture();
      const result = prepareCleanupHandoffDraft(input);
      const name =
        mode === 'broker'
          ? 'draft/broker.DRAFT.json'
          : mode === 'task'
            ? 'evidence/task-attestation.json'
            : 'draft/inputs.DRAFT.json';
      const path = join(result.packageDirectory, name);
      const data = JSON.parse(readFileSync(path, 'utf8'));
      if (mode === 'broker') data.artifacts.nodeSHA256 = 'f'.repeat(64);
      if (mode === 'task') data.task_view_sha256 = 'f'.repeat(64);
      if (mode === 'approval') data.approvalStatus = 'APPROVED';
      writeFileSync(path, JSON.stringify(data));
      const manifest = join(result.packageDirectory, 'SHA256SUMS');
      const text = readFileSync(manifest, 'utf8')
        .split('\n')
        .map((line) =>
          line.endsWith(`  ./${name}`) ? `${digest(readFileSync(path))}  ./${name}` : line,
        )
        .join('\n');
      writeFileSync(manifest, text);
      result.manifestSHA256 = digest(text);
      expect(verify(result).errors).toEqual(['HANDOFF_EVIDENCE_INVALID']);
    },
  );

  it.each([
    'digest',
    'missing',
    'extra',
    'traversal',
    'duplicate',
    'symlink',
    'candidate',
    'manifest',
  ])('rejects %s package evidence', async (mode) => {
    const { input } = await fixture();
    const result = prepareCleanupHandoffDraft(input);
    const file = join(result.packageDirectory, 'artifacts/executor.mjs');
    const manifest = join(result.packageDirectory, 'SHA256SUMS');
    if (mode === 'digest') writeFileSync(file, 'tampered');
    if (mode === 'missing') rmSync(file);
    if (mode === 'extra') writeFileSync(join(result.packageDirectory, 'unexpected.txt'), 'extra');
    if (mode === 'symlink') {
      rmSync(file);
      symlinkSync(join(input.runtimeDirectory, 'node'), file);
    }
    if (mode === 'candidate') result.candidateHead = 'f'.repeat(40);
    if (mode === 'manifest') result.manifestSHA256 = 'f'.repeat(64);
    if (mode === 'duplicate' || mode === 'traversal') {
      const text = readFileSync(manifest, 'utf8');
      writeFileSync(
        manifest,
        mode === 'duplicate'
          ? text + text.split('\n')[0] + '\n'
          : text.replace('./README.md', '../README.md'),
      );
      result.manifestSHA256 = digest(readFileSync(manifest));
    }
    expect(verify(result).valid).toBe(false);
    expect(verify(result).executionAuthorized).toBe(false);
  });

  it('reports expired evidence as an unmet gate even when package bytes are intact', async () => {
    const { input } = await fixture();
    const result = prepareCleanupHandoffDraft(input);
    const checked = verify(result, new Date('2026-10-10T00:00:00Z'));
    expect(checked.valid).toBe(true);
    expect(checked.unmetGates).toContain('TASK_EVIDENCE_EXPIRED');
  });
});
