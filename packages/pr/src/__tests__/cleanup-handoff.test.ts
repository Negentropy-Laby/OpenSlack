import { createHash } from 'node:crypto';
import type * as Crypto from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import {
  cpSync,
  chmodSync,
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
  CleanupHandoffError,
  prepareCleanupHandoffDraft,
  verifyCleanupHandoffPackage,
} from '../cleanup-handoff.js';
import { prepareCleanupTargetUpgradePlan } from '../cleanup-target-upgrade.js';
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

describe('R18-12 per-build tool proof', () => {
  /** Switch both build reports to the current schema and bind real tool bytes. */
  async function v2Fixture() {
    const f = await fixture();
    for (const id of ['a', 'b'] as const) {
      const build = f.input.builds[id === 'a' ? 0 : 1];
      const verifier = f.put(`build-${id}/verify-handoff.mjs`, 'fixture offline verifier\n');
      const client = f.put(`build-${id}/cleanup-client.mjs`, 'fixture client\n');
      const adminTool = f.put(`build-${id}/admin-upgrade.mjs`, 'fixture admin tool\n');
      const report = JSON.parse(readFileSync(build.reportPath, 'utf8')) as Record<string, unknown>;
      report.schema = 'openslack.cleanup_handoff_build_report.v2';
      report.verifier = {
        sha256: digest(readFileSync(verifier)),
        bytes: readFileSync(verifier).length,
      };
      report.client = { sha256: digest(readFileSync(client)), bytes: readFileSync(client).length };
      report.adminTool = {
        sha256: digest(readFileSync(adminTool)),
        bytes: readFileSync(adminTool).length,
      };
      writeFileSync(build.reportPath, JSON.stringify(report));
      Object.assign(build, {
        verifierPath: verifier,
        clientPath: client,
        adminToolPath: adminTool,
      });
    }
    // The top-level paths still select the v2 profile; the artifact bytes come
    // from the builds above, which is the point of R18-12.
    f.input.verifierPath = f.input.builds[0].verifierPath!;
    f.input.clientPath = f.input.builds[0].clientPath!;
    f.input.adminToolPath = f.input.builds[0].adminToolPath!;
    f.input.clientDocPath = f.put('client.md', '# client\n');
    return f;
  }

  it('H4 rejects v2 profile with legacy reports even when top-level tools exist', async () => {
    const f = await fixture();
    f.input.clientPath = f.put('client.mjs', 'client');
    f.input.adminToolPath = f.put('admin.mjs', 'admin');
    f.input.clientDocPath = f.put('client.md', '# client');
    expect(() => prepareCleanupHandoffDraft(f.input)).toThrow(CleanupHandoffError);
  });

  it.each(['downgraded-report', 'empty-verifier'])(
    'H4/H5 independently refuses %s in a self-consistent package',
    async (mode) => {
      const f = await v2Fixture(),
        result = prepareCleanupHandoffDraft(f.input);
      const directory = result.packageDirectory;
      if (mode === 'empty-verifier') writeFileSync(join(directory, 'tools/verify-handoff.mjs'), '');
      for (const id of ['a', 'b']) {
        const path = join(directory, `evidence/build-report-${id}.json`);
        const report = JSON.parse(readFileSync(path, 'utf8'));
        if (mode === 'downgraded-report')
          report.schema = 'openslack.cleanup_handoff_build_report.v1';
        else report.verifier = { sha256: digest(''), bytes: 0 };
        writeFileSync(path, JSON.stringify(report));
      }
      const manifest = join(directory, 'SHA256SUMS');
      const sums = readFileSync(manifest, 'utf8')
        .split('\n')
        .map((line) => {
          if (!line) return line;
          const name = line.slice(68);
          return `${digest(readFileSync(join(directory, name)))}  ./${name}`;
        })
        .join('\n');
      writeFileSync(manifest, sums);
      result.manifestSHA256 = digest(sums);
      expect(verify(result).valid).toBe(false);
    },
  );

  it('accepts a v2 pair whose reports bind all three tools', async () => {
    const f = await v2Fixture();
    const result = prepareCleanupHandoffDraft(f.input);
    expect(result.packageDirectory).toBeTruthy();
    // The tools inside the package are the ones the builds proved.
    const client = readFileSync(join(result.packageDirectory, 'tools', 'cleanup-client.mjs'));
    expect(client.toString('utf8')).toBe('fixture client\n');
  });

  it.each(['verifier', 'client', 'adminTool'])(
    'rejects a v2 report that omits the %s proof',
    async (tool) => {
      const f = await v2Fixture();
      for (const index of [0, 1]) {
        const report = JSON.parse(
          readFileSync(f.input.builds[index]!.reportPath, 'utf8'),
        ) as Record<string, unknown>;
        delete report[tool];
        writeFileSync(f.input.builds[index]!.reportPath, JSON.stringify(report));
      }
      expect(() => prepareCleanupHandoffDraft(f.input)).toThrow(CleanupHandoffError);
    },
  );

  it.each(['verifier', 'client', 'adminTool'])(
    'rejects a v2 report whose %s digest does not match the actual file',
    async (tool) => {
      const f = await v2Fixture();
      const report = JSON.parse(readFileSync(f.input.builds[0]!.reportPath, 'utf8')) as Record<
        string,
        unknown
      >;
      // Claim a digest for bytes no build produced.
      report[tool] = { sha256: digest('not the real tool'), bytes: 17 };
      writeFileSync(f.input.builds[0]!.reportPath, JSON.stringify(report));
      expect(() => prepareCleanupHandoffDraft(f.input)).toThrow(CleanupHandoffError);
    },
  );

  it('rejects a v2 pair whose builds disagree about a tool', async () => {
    const f = await v2Fixture();
    // Build b proves a different client than build a.
    const other = f.put('build-b/other-client.mjs', 'a different client\n');
    const report = JSON.parse(readFileSync(f.input.builds[1]!.reportPath, 'utf8')) as Record<
      string,
      unknown
    >;
    report.client = { sha256: digest(readFileSync(other)), bytes: readFileSync(other).length };
    writeFileSync(f.input.builds[1]!.reportPath, JSON.stringify(report));
    f.input.builds[1]!.clientPath = other;
    expect(() => prepareCleanupHandoffDraft(f.input)).toThrow(CleanupHandoffError);
  });

  it('does not let a separately supplied file satisfy a v2 tool proof', async () => {
    const f = await v2Fixture();
    // All three top-level paths are supplied, but the builds bind nothing for
    // the client, so the package cannot be completed by that arbitrary file.
    delete f.input.builds[0]!.clientPath;
    delete f.input.builds[1]!.clientPath;
    expect(() => prepareCleanupHandoffDraft(f.input)).toThrow(CleanupHandoffError);
  });

  it.each(['verifierPath', 'clientPath', 'adminToolPath'] as const)(
    'uses top-level %s only to cross-check the per-build proof',
    async (field) => {
      const f = await v2Fixture();
      f.input[field] = f.put(`different-${field}.mjs`, 'unproven tool');
      expect(() => prepareCleanupHandoffDraft(f.input)).toThrow(CleanupHandoffError);
    },
  );
  it('refuses a partially requested v2 profile instead of silently selecting v1', async () => {
    const f = await v2Fixture();
    delete f.input.clientDocPath;
    expect(() => prepareCleanupHandoffDraft(f.input)).toThrow(CleanupHandoffError);
  });

  it('refuses a zero-byte tool artifact supplied at the top level', async () => {
    // D7: no digest check can catch an empty artifact when the report honestly
    // describes it, so emptiness must be rejected outright.
    const f = await fixture();
    const empty = join(f.root, 'empty-verifier.mjs');
    writeFileSync(empty, '');
    f.input.verifierPath = empty;
    expect(() => prepareCleanupHandoffDraft(f.input)).toThrow(CleanupHandoffError);
  });

  it('refuses a zero-byte per-build tool artifact under a v2 report', async () => {
    const f = await fixture();
    for (const id of ['a', 'b'] as const) {
      const build = f.input.builds[id === 'a' ? 0 : 1];
      const empty = f.put(`build-${id}/empty-verifier.mjs`, '');
      const report = JSON.parse(readFileSync(build.reportPath, 'utf8')) as Record<string, unknown>;
      report.schema = 'openslack.cleanup_handoff_build_report.v2';
      // An honestly self-consistent report describing an empty artifact.
      report.verifier = { sha256: digest(''), bytes: 0 };
      report.client = { sha256: digest(''), bytes: 0 };
      report.adminTool = { sha256: digest(''), bytes: 0 };
      writeFileSync(build.reportPath, JSON.stringify(report));
      Object.assign(build, {
        verifierPath: empty,
        clientPath: empty,
        adminToolPath: empty,
      });
    }
    expect(() => prepareCleanupHandoffDraft(f.input)).toThrow(CleanupHandoffError);
  });
  it('packages the supplied verifier bytes rather than an empty placeholder', async () => {
    // D6: the packaged verifier is the artifact an administrator runs against the
    // package itself. A package that verifies while shipping a zero-byte verifier
    // is a silent integrity failure.
    const f = await fixture();
    const supplied = readFileSync(f.input.verifierPath);
    expect(supplied.length).toBeGreaterThan(0);
    const result = prepareCleanupHandoffDraft(f.input);
    const packaged = readFileSync(join(result.packageDirectory, 'tools', 'verify-handoff.mjs'));
    expect(packaged.length).toBe(supplied.length);
    expect(packaged.equals(supplied)).toBe(true);
  });

  it('refuses to build when no verifier source is supplied at all', async () => {
    const f = await fixture();
    // Neither the per-build path nor the top-level path: refuse rather than
    // silently ship an empty verifier.
    delete (f.input as { verifierPath?: string }).verifierPath;
    expect(() => prepareCleanupHandoffDraft(f.input)).toThrow(CleanupHandoffError);
  });
  it('still verifies a report under the pre-existing schema that binds only broker and executor', async () => {
    // The shape real packages built before tool proofs carry: the v1 schema with
    // no verifier/client/adminTool fields. Requiring tool proofs under this
    // schema would retroactively invalidate every such package.
    const f = await fixture();
    for (const id of ['a', 'b'] as const) {
      const build = f.input.builds[id === 'a' ? 0 : 1];
      const report = JSON.parse(readFileSync(build.reportPath, 'utf8')) as Record<string, unknown>;
      report.schema = 'openslack.cleanup_handoff_build_report.v1';
      delete report.verifier;
      delete report.client;
      delete report.adminTool;
      writeFileSync(build.reportPath, JSON.stringify(report));
    }
    const result = prepareCleanupHandoffDraft(f.input);
    const verified = verifyCleanupHandoffPackage({
      packageDirectory: result.packageDirectory,
      candidateHead: result.candidateHead,
      manifestSHA256: result.manifestSHA256,
      now: new Date(timestamp),
    });
    expect(verified.valid).toBe(true);
  });
  it('keeps a real v1 package readable', async () => {
    // The default fixture is the legacy schema and carries no per-build tools.
    const f = await fixture();
    const result = prepareCleanupHandoffDraft(f.input);
    const verified = verifyCleanupHandoffPackage({
      packageDirectory: result.packageDirectory,
      candidateHead: result.candidateHead,
      manifestSHA256: result.manifestSHA256,
      now: new Date(timestamp),
    });
    expect(verified.valid).toBe(true);
  });
});

describe('standalone package integrity contract', () => {
  it('exits 2 for an intact expired package in a real Node subprocess', async () => {
    const { input, root } = await fixture();
    const bundle = join(root, 'expired-verifier.mjs');
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
      { cwd: join(import.meta.dirname, '../../../..'), stdio: 'pipe' },
    );
    input.verifierPath = bundle;
    const result = prepareCleanupHandoffDraft(input);
    try {
      execFileSync(
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
        { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, PATH: '', Path: '' } },
      );
      expect.fail('Expired package verification must refuse.');
    } catch (error) {
      const failure = error as { status: number; stdout: string };
      expect(failure.status).toBe(2);
      const checked = JSON.parse(failure.stdout);
      expect(checked.valid).toBe(true);
      expect(checked.validityIssues).toContain('TASK_EVIDENCE_EXPIRED');
    }
  });
  it('runs the bundled Node verifier outside the checkout with no Git, modules or network', async () => {
    const { input, root } = await fixture();
    input.now = new Date();
    const freshTask = JSON.parse(readFileSync(input.targetEvidence.taskViewPath, 'utf8'));
    freshTask.notBefore = new Date(Date.now() - 60_000).toISOString();
    freshTask.expiresAt = new Date(Date.now() + 3600_000).toISOString();
    const freshRaw = JSON.stringify(freshTask);
    writeFileSync(input.targetEvidence.taskViewPath, freshRaw);
    writeFileSync(
      input.targetEvidence.taskAttestationPath,
      JSON.stringify({ task_view_sha256: digest(freshRaw) }),
    );
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
    // Outstanding authorization gates are informational: intact fresh bytes
    // exit 0 without claiming installation or execution authorization.
    let output = '';
    let failure: { status?: number; stderr?: string } | undefined;
    try {
      output = execFileSync(
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
    } catch (error) {
      const thrown = error as { status?: number; stdout?: string; stderr?: string };
      failure = thrown;
      output = thrown.stdout ?? '';
    }
    const checked = JSON.parse(output);
    expect(checked.valid).toBe(true);
    // Integrity holds, so the exit status must come from the gate list.
    expect(failure).toBeUndefined();
    expect(checked.validityIssues).toEqual([]);
    expect(checked.outstandingGates.length).toBeGreaterThan(0);
    expect(checked.unmetGates.length).toBeGreaterThan(0);
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

  it.each(['principal_id', 'broker_uid', 'target_distro', 'extraObject'])(
    'rejects selected %s drift despite a self-consistent manifest',
    async (field) => {
      const { input } = await fixture(),
        result = prepareCleanupHandoffDraft(input);
      const path = join(result.packageDirectory, 'draft/inputs.DRAFT.json');
      const draft = JSON.parse(readFileSync(path, 'utf8'));
      draft.selected[field] = field === 'extraObject' ? { value: 'not a string' } : 'changed';
      writeFileSync(path, JSON.stringify(draft));
      const manifest = join(result.packageDirectory, 'SHA256SUMS');
      writeFileSync(
        manifest,
        readFileSync(manifest, 'utf8')
          .split('\n')
          .map((line) =>
            line.endsWith('  ./draft/inputs.DRAFT.json')
              ? `${digest(readFileSync(path))}  ./draft/inputs.DRAFT.json`
              : line,
          )
          .join('\n'),
      );
      result.manifestSHA256 = digest(readFileSync(manifest));
      expect(verify(result).errors).toEqual(['HANDOFF_EVIDENCE_INVALID']);
    },
  );

  it('reports expired evidence as an unmet gate even when package bytes are intact', async () => {
    const { input } = await fixture();
    const result = prepareCleanupHandoffDraft(input);
    const checked = verify(result, new Date('2026-10-10T00:00:00Z'));
    expect(checked.valid).toBe(true);
    expect(checked.unmetGates).toContain('TASK_EVIDENCE_EXPIRED');
  });
});

async function upgradeFixture(now = new Date(timestamp)) {
  const f = await fixture();
  f.input.now = now;
  const task = JSON.parse(readFileSync(f.input.targetEvidence.taskViewPath, 'utf8'));
  task.notBefore = new Date(now.getTime() - 30 * 60_000).toISOString();
  task.expiresAt = new Date(now.getTime() + 23.5 * 3600_000).toISOString();
  writeFileSync(f.input.targetEvidence.taskViewPath, JSON.stringify(task));
  writeFileSync(
    f.input.targetEvidence.taskAttestationPath,
    JSON.stringify({ task_view_sha256: digest(JSON.stringify(task)) }),
  );
  const pkg = prepareCleanupHandoffDraft(f.input);
  const selected = JSON.parse(
    readFileSync(join(pkg.packageDirectory, 'draft/inputs.DRAFT.json'), 'utf8'),
  ).selected;
  const common = {
    target: selected.target_distro,
    workspaceId: selected.workspace_id,
    repository: 'fixture/qualification',
    repositoryId: '12345',
    recordedAt: task.notBefore,
    expiresAt: task.expiresAt,
  };
  const identities = {
    broker: { uid: 44180, gid: 44180 },
    agent: { uid: 44181, gid: 44181 },
    principalId: 'principal:fixture_agent',
    runtimeUid: 'fixture_agent',
    runId: 'fixture-run',
  };
  const write = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value));
  const evidence = f.input.targetEvidence;
  write(evidence.taskAttestationPath, {
    ...common,
    schema: 'openslack.cleanup_task_attestation.v1',
    task_view_sha256: digest(readFileSync(evidence.taskViewPath)),
    complete: true,
  });
  write(evidence.appScopePath, {
    ...common,
    schema: 'openslack.cleanup_app_scope_evidence.v1',
    appId: 123,
    installationId: 456,
    selectedRepositories: [{ repository: common.repository, repositoryId: common.repositoryId }],
    permissions: { contents: 'write', metadata: 'read', issues: 'read', pull_requests: 'read' },
  });
  write(evidence.networkPath, {
    ...common,
    schema: 'openslack.cleanup_network_evidence.v1',
    httpsProxy: '',
    noProxy: '',
    ownerAccount: 'fixture-admin',
    executablePath: '/fixture/proxy',
    executableSHA256: digest('proxy'),
    administratorConfirmed: true,
  });
  write(evidence.identityPath, {
    ...common,
    schema: 'openslack.cleanup_identity_evidence.v1',
    agentId: 'fixture_agent',
    brokerId: 'fixture-broker',
    identities,
  });
  write(evidence.dependencyInventoryPath, {
    ...common,
    schema: 'openslack.cleanup_dependency_inventory.v1',
    files: [
      { path: '/usr/lib/fixture.so', sha256: digest('library'), uid: 0, gid: 0, mode: '0644' },
    ],
  });
  const adminInputPath = f.put(
    'inputs/admin-upgrade.json',
    JSON.stringify({
      ...common,
      schema: 'openslack.cleanup_upgrade_inputs.v1',
      candidateHead: pkg.candidateHead,
      manifestSHA256: pkg.manifestSHA256,
      selected,
      approvalStatus: 'DRAFT',
      approvedBy: null,
      approvedAt: null,
    }),
  );
  const hostInspectionPath = f.put(
    'inputs/host.json',
    JSON.stringify({
      ...common,
      schema: 'openslack.cleanup_host_inspection.v1',
      candidateHead: pkg.candidateHead,
      manifestSHA256: pkg.manifestSHA256,
      identities,
      files: [
        'cleanup-broker',
        'executor.mjs',
        'node',
        'git',
        'sh',
        'git-core/git-remote-https',
      ].map((name) => ({
        path: '/usr/lib/openslack-cleanup/' + name,
        state: 'missing',
        sha256: null,
        uid: null,
        gid: null,
        mode: null,
      })),
      process: { state: 'stopped', pid: null },
      persistentState: {
        state: 'inspected',
        ledgerSHA256: digest('ledger'),
        journalSHA256: digest('journal'),
        consistentBackupVerified: false,
      },
      evidenceSHA256: Object.fromEntries(
        Object.entries(evidence).map(([role, path]) => [role, digest(readFileSync(path))]),
      ),
    }),
  );
  const input = {
    packageDirectory: pkg.packageDirectory,
    candidateHead: pkg.candidateHead,
    manifestSHA256: pkg.manifestSHA256,
    targetEvidence: evidence,
    adminInputPath,
    hostInspectionPath,
    now,
  };
  return { f, input, write, pkg };
}

function onUpgradePlatform<A extends unknown[]>(run: (...args: A) => void | Promise<void>) {
  return async (...args: A) => {
    if (process.platform === 'linux') return run(...args);
    const { input } = await upgradeFixture();
    const plan = prepareCleanupTargetUpgradePlan(input);
    expect(plan.packageVerified).toBe(true);
    expect(plan.unmetGates).toContain('TARGET_FILE_BOUNDARY_UNSUPPORTED');
    expect(plan.steps.find((step) => step.id === 'controlled-upgrade')!.commands).toEqual([]);
  };
}

describe('H1/H2/H6/H7 upgrade acceptance with a verified positive package', () => {
  it('runs the actual Node administrator tool outside the checkout without installing anything', async () => {
    const { input, f } = await upgradeFixture(new Date());
    const bundle = join(f.root, 'admin.mjs'),
      cwd = join(f.root, 'empty command directory');
    mkdirSync(cwd);
    execFileSync(
      'bun',
      [
        'build',
        'scripts/cleanup-broker/admin-upgrade.ts',
        '--target=node',
        '--format=esm',
        '--outfile',
        bundle,
      ],
      { cwd: join(import.meta.dirname, '../../../..'), stdio: 'pipe' },
    );
    const args = [
      bundle,
      '--package',
      input.packageDirectory,
      '--candidate',
      input.candidateHead,
      '--manifest-sha256',
      input.manifestSHA256,
      '--admin-inputs',
      input.adminInputPath,
      '--host-inspection',
      input.hostInspectionPath,
    ];
    const flags = [
      '--install-manifest',
      '--task-view',
      '--task-attestation',
      '--app-scope',
      '--network',
      '--identity',
      '--dependency-inventory',
    ];
    Object.values(input.targetEvidence).forEach((path, index) => args.push(flags[index]!, path));
    const env = { ...process.env, PATH: '', Path: '', GH_TOKEN: '', GITHUB_TOKEN: '' };
    let output = '',
      status = 0;
    try {
      output = execFileSync(process.execPath, args, { cwd, env, encoding: 'utf8', stdio: 'pipe' });
    } catch (error) {
      const failure = error as { status: number; stdout: string };
      status = failure.status;
      output = failure.stdout;
    }
    const plan = JSON.parse(output.split('\nPlan only.')[0]!);
    expect(plan.packageVerified).toBe(true);
    expect(plan.installationPerformed).toBe(false);
    expect(plan.executionAuthorized).toBe(false);
    expect(readdirSync(cwd)).toEqual([]);
    expect(status).toBe(process.platform === 'linux' ? 0 : 2);
    expect(
      plan.steps.find((step: { id: string }) => step.id === 'controlled-upgrade').commands,
    ).toHaveLength(process.platform === 'linux' ? 6 : 0);
  });
  it(
    'plans six artifacts only from a verified candidate and complete current evidence',
    onUpgradePlatform(async () => {
      const { input } = await upgradeFixture();
      const plan = prepareCleanupTargetUpgradePlan(input);
      expect(plan.packageVerified).toBe(true);
      expect(plan.steps.find((step) => step.id === 'controlled-upgrade')!.commands).toHaveLength(6);
    }),
  );
  it.each([
    'installationManifestPath',
    'taskViewPath',
    'taskAttestationPath',
    'appScopePath',
    'networkPath',
    'identityPath',
    'dependencyInventoryPath',
  ] as const)(
    'refuses missing %s even with a verified package',
    onUpgradePlatform(async (role) => {
      const { input } = await upgradeFixture();
      delete (input.targetEvidence as Partial<typeof input.targetEvidence>)[role];
      const plan = prepareCleanupTargetUpgradePlan(input);
      expect(plan.packageVerified).toBe(true);
      expect(plan.steps.find((step) => step.id === 'controlled-upgrade')!.commands).toEqual([]);
      expect(plan.unmetGates).toContain('TARGET_EVIDENCE_INCOMPLETE');
    }),
  );
  it.each(['malformed', 'directory', 'unknown-key', 'duplicate-key', 'expired', 'wrong-identity'])(
    'refuses %s evidence without concealing the valid candidate',
    onUpgradePlatform(async (mode) => {
      const { input, write } = await upgradeFixture();
      const path =
        mode === 'wrong-identity' ? input.hostInspectionPath : input.targetEvidence.taskViewPath;
      const value = JSON.parse(readFileSync(path, 'utf8'));
      if (mode === 'malformed') writeFileSync(path, '{');
      if (mode === 'directory') {
        rmSync(path);
        mkdirSync(path);
      }
      if (mode === 'unknown-key') write(path, { ...value, extra: true });
      if (mode === 'duplicate-key')
        writeFileSync(path, JSON.stringify(value).replace('{', '{"schema":"duplicate",'));
      if (mode === 'expired') write(path, { ...value, expiresAt: '2026-10-07T00:00:00Z' });
      if (mode === 'wrong-identity')
        write(path, { ...value, identities: { ...value.identities, runId: 'WRONG' } });
      const plan = prepareCleanupTargetUpgradePlan(input);
      expect(plan.packageVerified).toBe(true);
      expect(plan.steps.find((step) => step.id === 'controlled-upgrade')!.commands).toEqual([]);
    }),
  );
  it(
    'preserves package expiry as a validity failure and emits no install commands',
    onUpgradePlatform(async () => {
      const { input } = await upgradeFixture();
      input.now = new Date('2026-10-10T00:00:00Z');
      const plan = prepareCleanupTargetUpgradePlan(input);
      expect(plan.unmetGates).toContain('TASK_EVIDENCE_EXPIRED');
      expect(plan.steps.find((step) => step.id === 'controlled-upgrade')!.commands).toEqual([]);
    }),
  );
  it(
    'governance preparation consumes a nonce without requiring its own activation output',
    onUpgradePlatform(async () => {
      const { input } = await upgradeFixture();
      const plan = prepareCleanupTargetUpgradePlan(input),
        governance = plan.steps.find((step) => step.id === 'prepare-governance-pr')!;
      expect(governance.blockedBy).not.toContain('BROKER_ACTIVATION_REQUIRED');
      expect(governance).toHaveProperty('dependsOn', ['start-unactivated']);
    }),
  );
  it.each([
    'host-hash',
    'host-mode',
    'host-state',
    'journal-hash',
    'inventory-hash',
    'inventory-mode',
    'manifest-hash',
    'proxy-hash',
    'task-state',
  ])(
    'rejects array-valued %s rather than coercing strict evidence',
    onUpgradePlatform(async (kind) => {
      const { input, write } = await upgradeFixture();
      const host = JSON.parse(readFileSync(input.hostInspectionPath, 'utf8'));
      let role: keyof typeof input.targetEvidence | undefined;
      if (kind.startsWith('host-')) {
        host.files[0] = {
          ...host.files[0],
          state: 'present',
          sha256: digest('file'),
          uid: 0,
          gid: 0,
          mode: '0755',
        };
        if (kind === 'host-hash') host.files[0].sha256 = [host.files[0].sha256];
        if (kind === 'host-mode') host.files[0].mode = ['0755'];
        if (kind === 'host-state')
          host.files[0] = {
            ...host.files[0],
            state: ['missing'],
            sha256: null,
            uid: null,
            gid: null,
            mode: null,
          };
      } else if (kind === 'journal-hash') host.persistentState.journalSHA256 = [digest('journal')];
      else {
        role = kind.startsWith('inventory-')
          ? 'dependencyInventoryPath'
          : kind === 'manifest-hash'
            ? 'installationManifestPath'
            : kind === 'proxy-hash'
              ? 'networkPath'
              : 'taskViewPath';
        const value = JSON.parse(readFileSync(input.targetEvidence[role], 'utf8'));
        if (kind === 'inventory-hash' || kind === 'manifest-hash')
          value.files[0].sha256 = [value.files[0].sha256];
        if (kind === 'inventory-mode') value.files[0].mode = ['0644'];
        if (kind === 'proxy-hash') value.executableSHA256 = [value.executableSHA256];
        if (kind === 'task-state')
          value.tasks = [{ taskId: 'TASK-1', issueNumber: 1, state: ['pending'] }];
        write(input.targetEvidence[role], value);
        host.evidenceSHA256[role] = digest(readFileSync(input.targetEvidence[role]));
        if (role === 'taskViewPath') {
          const attestation = JSON.parse(
            readFileSync(input.targetEvidence.taskAttestationPath, 'utf8'),
          );
          attestation.task_view_sha256 = host.evidenceSHA256.taskViewPath;
          write(input.targetEvidence.taskAttestationPath, attestation);
          host.evidenceSHA256.taskAttestationPath = digest(
            readFileSync(input.targetEvidence.taskAttestationPath),
          );
        }
      }
      write(input.hostInspectionPath, host);
      const plan = prepareCleanupTargetUpgradePlan(input);
      expect(plan.unmetGates).toContain('TARGET_EVIDENCE_INVALID');
      expect(plan.steps.find((step) => step.id === 'controlled-upgrade')!.commands).toEqual([]);
    }),
  );
  it(
    'compares validated identities independently of JSON field order',
    onUpgradePlatform(async () => {
      const { input, write } = await upgradeFixture();
      const identity = JSON.parse(readFileSync(input.targetEvidence.identityPath, 'utf8'));
      identity.identities = Object.fromEntries(Object.entries(identity.identities).reverse());
      write(input.targetEvidence.identityPath, identity);
      const host = JSON.parse(readFileSync(input.hostInspectionPath, 'utf8'));
      host.evidenceSHA256.identityPath = digest(readFileSync(input.targetEvidence.identityPath));
      write(input.hostInspectionPath, host);
      const plan = prepareCleanupTargetUpgradePlan(input);
      expect(plan.steps.find((step) => step.id === 'controlled-upgrade')!.commands).toHaveLength(6);
    }),
  );
  it(
    'returns stages in dependency order',
    onUpgradePlatform(async () => {
      const { input } = await upgradeFixture();
      const plan = prepareCleanupTargetUpgradePlan(input),
        preceding = new Set<string>();
      for (const step of plan.steps) {
        expect(step.dependsOn.every((id) => preceding.has(id))).toBe(true);
        preceding.add(step.id);
      }
    }),
  );
  it.each(['nul-library', 'nul-manifest', 'relative-proxy'])(
    'refuses impossible host paths: %s',
    onUpgradePlatform(async (kind) => {
      const { input, write } = await upgradeFixture();
      const role =
        kind === 'nul-library'
          ? 'dependencyInventoryPath'
          : kind === 'nul-manifest'
            ? 'installationManifestPath'
            : 'networkPath';
      const value = JSON.parse(readFileSync(input.targetEvidence[role], 'utf8'));
      if (kind === 'relative-proxy') value.executablePath = 'relative-program';
      else value.files[0].path = '/usr/lib/impossible\u0000file';
      write(input.targetEvidence[role], value);
      const host = JSON.parse(readFileSync(input.hostInspectionPath, 'utf8'));
      host.evidenceSHA256[role] = digest(readFileSync(input.targetEvidence[role]));
      write(input.hostInspectionPath, host);
      const plan = prepareCleanupTargetUpgradePlan(input);
      expect(plan.unmetGates).toContain('TARGET_EVIDENCE_INVALID');
      expect(plan.steps.find((step) => step.id === 'controlled-upgrade')!.commands).toEqual([]);
    }),
  );
  it.each(['symlink', 'hardlink', 'writable', 'fifo', 'oversize'])(
    'refuses unsafe evidence file %s before producing installation instructions',
    onUpgradePlatform(async (kind) => {
      const { input, f } = await upgradeFixture();
      const path = input.targetEvidence.networkPath;
      if (kind === 'symlink' || kind === 'hardlink') {
        const copy = f.put('inputs/link-target.json', readFileSync(path, 'utf8'));
        rmSync(path);
        if (kind === 'symlink') symlinkSync(copy, path);
        else linkSync(copy, path);
      }
      if (kind === 'writable') chmodSync(path, 0o666);
      if (kind === 'fifo') {
        rmSync(path);
        execFileSync('mkfifo', [path]);
      }
      if (kind === 'oversize') writeFileSync(path, Buffer.alloc(1024 * 1024 + 1));
      const plan = prepareCleanupTargetUpgradePlan(input);
      expect(plan.evidenceIssues.length).toBeGreaterThan(0);
      expect(plan.steps.find((step) => step.id === 'controlled-upgrade')!.commands).toEqual([]);
    }),
  );
  it(
    'attributes a corrupt installation manifest to its role',
    onUpgradePlatform(async () => {
      const { input, write } = await upgradeFixture();
      writeFileSync(input.targetEvidence.installationManifestPath, '{');
      const host = JSON.parse(readFileSync(input.hostInspectionPath, 'utf8'));
      host.evidenceSHA256.installationManifestPath = digest(
        readFileSync(input.targetEvidence.installationManifestPath),
      );
      write(input.hostInspectionPath, host);
      const plan = prepareCleanupTargetUpgradePlan(input);
      expect(plan.evidenceIssues).toContainEqual({
        role: 'installationManifestPath',
        reason: 'EVIDENCE_INVALID',
      });
      expect(plan.unmetGates).toContain('INSTALLATION_MANIFEST_UNREADABLE');
      expect(plan.steps.find((step) => step.id === 'controlled-upgrade')!.commands).toEqual([]);
    }),
  );
  it.each([
    'installationManifestPath',
    'taskViewPath',
    'taskAttestationPath',
    'appScopePath',
    'networkPath',
    'identityPath',
    'dependencyInventoryPath',
  ] as const)(
    'strictly validates %s after matching its actual byte digest',
    onUpgradePlatform(async (role) => {
      const { input, write } = await upgradeFixture();
      const value = JSON.parse(readFileSync(input.targetEvidence[role], 'utf8'));
      write(input.targetEvidence[role], { ...value, unexpected: true });
      const host = JSON.parse(readFileSync(input.hostInspectionPath, 'utf8'));
      host.evidenceSHA256[role] = digest(readFileSync(input.targetEvidence[role]));
      write(input.hostInspectionPath, host);
      const plan = prepareCleanupTargetUpgradePlan(input);
      expect(plan.evidenceIssues).toContainEqual({ role, reason: 'EVIDENCE_INVALID' });
      expect(plan.steps.find((step) => step.id === 'controlled-upgrade')!.commands).toEqual([]);
    }),
  );
});
