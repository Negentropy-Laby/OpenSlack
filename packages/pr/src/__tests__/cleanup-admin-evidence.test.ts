import { createHash } from 'node:crypto';
import { declareLinuxCleanupTests } from './helpers/cleanup-platform-qualification.js';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  createReadStream,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import type * as FileSystem from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { testExecutable } from '../../../../scripts/testing/process-fixture.mjs';
import {
  prepareCleanupEvidenceDraft,
  readCleanupEvidenceDraftInput,
} from '../cleanup-admin-evidence.js';
import { CLEANUP_INSTALL_LAYOUT } from '../cleanup-target-upgrade.js';
import {
  CLEANUP_HANDOFF_PROFILES,
  evaluateCleanupHandoffVerification,
  verifyCleanupHandoffPackage,
} from '../cleanup-handoff.js';

const roots: string[] = [];
const fault = vi.hoisted(() => ({
  fsync: false,
  zeroWrite: false,
  shortWrite: false,
  syncedFiles: 0,
  syncedDirectories: 0,
  openedFiles: 0,
}));
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof FileSystem>();
  return {
    ...fs,
    openSync: ((...args: Parameters<typeof fs.openSync>) => {
      fault.openedFiles++;
      return fs.openSync(...args);
    }) as typeof fs.openSync,
    fsyncSync: (fd: number) => {
      if (fault.fsync) throw new Error('fixture fsync failure');
      if (fs.fstatSync(fd).isDirectory()) fault.syncedDirectories++;
      else fault.syncedFiles++;
      return fs.fsyncSync(fd);
    },
    writeSync: ((fd: number, value: Buffer, offset: number, length: number, position: number) => {
      if (fault.zeroWrite) return 0;
      return fs.writeSync(
        fd,
        value,
        offset,
        fault.shortWrite ? Math.min(length, 7) : length,
        position,
      );
    }) as typeof fs.writeSync,
  };
});
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const bytes = (v: unknown) => Buffer.from(JSON.stringify(v, null, 2) + '\n');
const head = '4'.repeat(40);
// Structural ELF/Go build-info bytes, never an executable or installation proof.
function fixtureBroker(): Buffer {
  const module = Buffer.concat([
    Buffer.alloc(16),
    Buffer.from(
      `path\tgithub.com/Negentropy-Laby/OpenSlack/services/cleanup-broker/cmd/cleanup-broker\nbuild\tvcs.revision=${head}\nbuild\tvcs.modified=false\nbuild\t-trimpath=true\nbuild\tCGO_ENABLED=0\nbuild\tGOOS=linux\nbuild\tGOARCH=amd64\nbuild\tvcs=git\n`,
    ),
    Buffer.alloc(16),
  ]);
  const frame = (value: Buffer) => {
    let n = value.length;
    const prefix: number[] = [];
    do {
      const b = n % 128;
      n = Math.floor(n / 128);
      prefix.push(b | (n ? 128 : 0));
    } while (n);
    return Buffer.concat([Buffer.from(prefix), value]);
  };
  const header = Buffer.alloc(32);
  Buffer.from('\xff Go buildinf:', 'latin1').copy(header);
  header[14] = 8;
  header[15] = 2;
  const info = Buffer.concat([header, frame(Buffer.from('go1.26.5')), frame(module)]);
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
function fixture() {
  const root = mkdtempSync('/var/tmp/cleanup-admin-fixture-');
  chmodSync(root, 0o700);
  roots.push(root);
  const now = Date.now();
  const common = {
    target: 'fixture-target',
    workspaceId: 'fixture-workspace',
    repository: 'Fixture/qualification',
    repositoryId: '123',
    recordedAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 3_600_000).toISOString(),
  };
  const selected = {
    approval_status: 'DRAFT',
    target_distro: common.target,
    broker_uid: '44180',
    broker_gid: '44180',
    agent_uid: '44181',
    agent_gid: '44181',
    agent_id: 'fixture_agent',
    broker_id: 'fixture-broker',
    principal_id: 'principal:fixture_agent',
    runtime_uid_claim: 'fixture_agent',
    run_id: 'fixture-run',
    issuer_trust_domain: 'Fixture:admin',
    workspace_id: common.workspaceId,
    allowed_git_remote_name: 'origin',
    qualification_repository_owner: 'Fixture',
    qualification_repository_name: 'qualification',
    qualification_repository_numeric_id: '123',
    qualification_repository_default_branch: 'main',
    automatic_branch_deletion: 'false',
    deletion_app_id: '10',
    deletion_app_installation_id: '20',
    approved_https_proxy: 'http://127.0.0.1:7890',
    approved_no_proxy: '""',
  };
  const put = (name: string, value: unknown) => {
    const path = join(root, name);
    const raw = Buffer.isBuffer(value) ? value : bytes(value);
    writeFileSync(path, raw, { mode: 0o600 });
    return { path, sha256: sha(raw) };
  };
  const stamp = (path: string, state = 'present') => ({
    path,
    state,
    kind: state === 'present' ? 'regular' : null,
    uid: state === 'present' ? 0 : null,
    gid: state === 'present' ? 0 : null,
    mode: state === 'present' ? '0755' : null,
    bytes: state === 'present' ? 100 : null,
    nlink: state === 'present' ? 1 : null,
    dev: state === 'present' ? '1' : null,
    ino: state === 'present' ? path : null,
    sha256: state === 'present' ? sha('installed ' + path) : null,
    reason: state === 'present' ? null : 'ENOENT',
  });
  const files = CLEANUP_INSTALL_LAYOUT.map((v) => stamp(v.path));
  files[1]!.mode = '0644';
  const identity = (uid: number) => ({
    state: 'present',
    name: 'fixture-' + uid,
    uid,
    gid: uid,
    shell: '/usr/sbin/nologin',
    groupIds: [uid],
  });
  const host = {
    schema: 'openslack.cleanup_target_observation.v1',
    ...common,
    targetLabelSource: 'fixture-only',
    bindingSource: 'fixture-only',
    host: { hostname: 'fixture', kernel: 'fixture', arch: 'x86_64', system: 'Linux' },
    observer: { uid: 0, gid: 0 },
    identities: { broker: identity(44180), agent: identity(44181) },
    directories: [
      {
        ...stamp('/etc/openslack-cleanup'),
        kind: 'directory',
        gid: 44180,
        mode: '0750',
        sha256: null,
      },
      {
        ...stamp('/etc/openslack-cleanup/credentials'),
        kind: 'directory',
        gid: 44180,
        mode: '0750',
        sha256: null,
      },
      { ...stamp('/usr/lib/openslack-cleanup'), kind: 'directory', mode: '0755', sha256: null },
      stamp('/run/openslack-cleanup', 'missing'),
      {
        ...stamp('/var/lib/openslack-cleanup'),
        kind: 'directory',
        uid: 44180,
        gid: 44180,
        mode: '0700',
        sha256: null,
      },
    ],
    files,
    installedManifest: {
      observation: stamp('/usr/lib/openslack-cleanup/install-manifest.json', 'missing'),
      contentsRead: false,
      scope: 'metadata only',
    },
    process: {
      state: 'stopped',
      pid: null,
      pids: [],
      uninspectableCount: 0,
      argumentsRead: false,
      environmentRead: false,
    },
    persistentState: {
      state: 'absent',
      objects: ['ledger.jsonl', 'workers.jsonl', 'instance.json'].map((v) =>
        stamp('/var/lib/openslack-cleanup/' + v, 'missing'),
      ),
      directoryEntryCount: 0,
      ledgerSHA256: null,
      journalSHA256: null,
      contentsRead: false,
    },
    runtime: {
      socket: stamp('/run/openslack-cleanup/broker.sock', 'missing'),
      directoryEntryCount: 0,
    },
    locks: { state: 'none-observed', matchedLocks: [], scope: 'momentary metadata' },
    neverStartedOfflineUpgrade: { eligible: true, blockingReasons: [], scope: 'fixture-only' },
    dependencyInventory: { state: 'NOT_COLLECTED', files: [], count: 0, closureVerified: false },
    candidateBytesRead: false,
    credentialContentsRead: false,
    historyContentsRead: false,
    manifestProduced: false,
    approvalRecorded: false,
    brokerStarted: false,
    installationPerformed: false,
  };
  const observation = put('observation.json', host);
  const library = { ...stamp('/usr/lib/fixture-library.so'), mode: '0644' };
  const inventory = {
    schema: 'openslack.cleanup_dependency_inventory.v1',
    ...common,
    files: [{ path: library.path, sha256: library.sha256, uid: 0, gid: 0, mode: library.mode }],
  };
  const dependencyInventory = put('dependencies.json', inventory);
  const metadata = (v: ReturnType<typeof stamp>) => ({ ...v });
  const targetState = {
    identities: host.identities,
    process: host.process,
    history: host.persistentState.objects,
    entryCounts: { '/var/lib/openslack-cleanup': 0, '/run/openslack-cleanup': 0 },
    locks: host.locks,
  };
  const dep = {
    schema: 'openslack.cleanup_installed_dependency_observation.v1',
    ...common,
    targetObservationSHA256: observation.sha256,
    frozenHelperSHA256: '6'.repeat(64),
    scope: 'ELF DT_NEEDED load-time closure; fixture-only',
    installed: files.map((v) => ({ before: metadata(v), after: metadata(v) })),
    brokerELF: {
      kind: 'static',
      interpreter: null,
      needed: [],
      soname: null,
      elfClass: 64,
      machine: 62,
    },
    lddTool: {
      before: metadata({ ...library, path: '/usr/bin/ldd' }),
      after: metadata({ ...library, path: '/usr/bin/ldd' }),
    },
    lddShell: {
      before: metadata({ ...library, path: '/usr/bin/bash' }),
      after: metadata({ ...library, path: '/usr/bin/bash' }),
      elf: {
        kind: 'dynamic',
        interpreter: '/usr/lib/fixture-library.so',
        needed: [],
        soname: null,
        elfClass: 64,
        machine: 62,
      },
      resolution: { shebang: '/usr/bin/bash', canonicalPath: '/usr/bin/bash', alias: null },
      interpreterResolution: { alias: library.path, canonicalPath: library.path, links: [] },
    },
    lddCalls: CLEANUP_INSTALL_LAYOUT.filter((v) =>
      ['node', 'git', 'sh', 'git-remote-https'].includes(v.artifact),
    ).map((v) => ({
      input: v.path,
      installedSHA256: files.find((f) => f.path === v.path)!.sha256,
      argv: ['/usr/bin/ldd', '--', v.path],
      environment: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      cwd: '/',
      status: 0,
      signal: null,
      timedOut: false,
      truncated: false,
      encodingValid: true,
      stdout: 'fixture',
      stderr: '',
      stdoutHex: '66697874757265',
      stderrHex: '',
      spawnError: null,
      commandError: null,
      elapsedMs: 1,
      elf: {
        kind: 'dynamic',
        interpreter: library.path,
        needed: [],
        soname: null,
        elfClass: 64,
        machine: 62,
      },
    })),
    aliases: [],
    libraries: [
      {
        before: metadata(library),
        after: metadata(library),
        elf: {
          kind: 'dynamic',
          interpreter: null,
          needed: [],
          soname: null,
          elfClass: 64,
          machine: 62,
        },
      },
    ],
    count: 1,
    closureVerified: true,
    productionInventory: {
      schema: inventory.schema,
      sha256: dependencyInventory.sha256,
      bytes: bytes(inventory).length,
      fileCount: 1,
    },
    blockingReasons: [],
    installationPerformed: false,
    credentialContentsRead: false,
    brokerStarted: false,
    executorStarted: false,
    approvalRecorded: false,
    permitIssued: false,
    targetBefore: targetState,
    targetAfter: targetState,
  };
  const task = {
    schema: 'openslack.cleanup_task_view.v1',
    workspaceId: common.workspaceId,
    repository: common.repository,
    repositoryId: common.repositoryId,
    notBefore: common.recordedAt,
    expiresAt: common.expiresAt,
    tasks: [{ taskId: 'fixture-task', issueNumber: 1, state: 'pending' }],
  };
  const taskView = put('task.json', task);
  const input = {
    schema: 'openslack.cleanup_admin_evidence_input.v1' as const,
    phase: 'target' as const,
    candidateHead: head,
    outputDirectory: join(root, 'published evidence'),
    sources: {
      selectedBindings: put('selected.json', {
        schema: 'openslack.cleanup_admin_selected_bindings.v1',
        selected,
        priorInput: {
          source: 'historical fixture selection',
          sha256: 'a'.repeat(64),
          approvalNotInherited: true,
        },
      }),
      observation,
      dependencyObservation: put('dependency-observation.json', dep),
      dependencyInventory,
      appScope: put('app.json', {
        schema: 'openslack.cleanup_app_scope_evidence.v1',
        ...common,
        appId: 10,
        installationId: 20,
        selectedRepositories: [
          { repository: common.repository, repositoryId: common.repositoryId },
        ],
        permissions: { contents: 'write', metadata: 'read', issues: 'read', pull_requests: 'read' },
      }),
      network: put('network.json', {
        schema: 'openslack.cleanup_network_evidence.v1',
        ...common,
        httpsProxy: selected.approved_https_proxy,
        noProxy: '',
        ownerAccount: 'fixture-admin',
        executablePath: '/fixture/proxy',
        executableSHA256: 'e'.repeat(64),
        administratorConfirmed: true,
      }),
      taskView,
      taskAttestation: put('attestation.json', {
        schema: 'openslack.cleanup_task_attestation.v1',
        ...common,
        task_view_sha256: taskView.sha256,
        complete: true,
      }),
    },
    artifacts: CLEANUP_INSTALL_LAYOUT.map((v) => ({
      artifact: v.artifact,
      source: put(
        v.artifact + '.candidate',
        v.artifact === 'cleanup-broker' ? fixtureBroker() : Buffer.from('candidate ' + v.artifact),
      ),
    })),
  };
  return { root, common, selected, host, dep, inventory, input, put };
}
function packageFixture(
  f: ReturnType<typeof fixture>,
  targetEvidence: NonNullable<ReturnType<typeof prepareCleanupEvidenceDraft>['targetEvidence']>,
) {
  const root = join(f.root, 'complete v1 package');
  mkdirSync(root, { mode: 0o700 });
  const files = new Map(
    CLEANUP_HANDOFF_PROFILES.v1.map((name) => [name, Buffer.from('ordinary fixture ' + name)]),
  );
  for (const artifact of f.input.artifacts)
    files.set('artifacts/' + artifact.artifact, readFileSync(artifact.source.path));
  const selected = {
    ...f.selected,
    candidate_head: head,
    approval_status: 'DRAFT',
    approved_by: 'REQUIRED',
    approved_at_utc: 'REQUIRED',
  };
  const prior = Buffer.from(
    Object.entries(f.selected)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n') + '\n',
  );
  files.set('evidence/prior-admin-inputs.md', prior);
  const manifest = readFileSync(targetEvidence.installationManifestPath),
    task = readFileSync(targetEvidence.taskViewPath);
  files.set('draft/install-manifest.DRAFT.json', manifest);
  files.set('draft/task-dependencies.DRAFT.json', task);
  files.set('evidence/task-attestation.json', readFileSync(targetEvidence.taskAttestationPath));
  files.set(
    'draft/inputs.DRAFT.json',
    bytes({
      schema: 'openslack.cleanup_handoff_draft.v1',
      candidateHead: head,
      approvalStatus: 'DRAFT',
      selected,
      priorInput: { source: 'fixture', sha256: sha(prior), approvalNotInherited: true },
      installationAuthorized: false,
      executionAuthorized: false,
    }),
  );
  files.set(
    'evidence/qualification-index.json',
    bytes({
      schema: 'openslack.cleanup_handoff_evidence_index.v1',
      candidateHead: head,
      approvalStatus: 'DRAFT',
      qualification: 'NOT_RUN',
      unmetGates: [],
    }),
  );
  const lock = 'a'.repeat(64),
    go = 'b'.repeat(64),
    tools = { bun: '1.4.0', go: 'go version go1.26.5 linux/amd64', node: 'v24.18.1' };
  files.set(
    'evidence/source-locks.json',
    bytes({ candidateHead: head, lockfileSHA256: lock, goModuleSHA256: go, toolchain: tools }),
  );
  const artifactProof = (name: string) => {
    const raw = files.get('artifacts/' + name)!;
    return { sha256: sha(raw), bytes: raw.length };
  };
  for (const id of ['a', 'b'])
    files.set(
      `evidence/build-report-${id}.json`,
      bytes({
        schema: 'openslack.cleanup_handoff_build_report.v1',
        candidateHead: head,
        checkoutCleanAfterBuild: true,
        independentCloneNoHardlinks: true,
        checkout: 'fixture-' + id,
        lockfileSHA256: lock,
        goModuleSHA256: go,
        tools,
        broker: artifactProof('cleanup-broker'),
        executor: artifactProof('executor.mjs'),
        commands: ['structural fixture; not executed'],
      }),
    );
  files.set(
    'draft/broker.DRAFT.json',
    bytes({
      schema: 'openslack.cleanup_broker_config.v2',
      brokerId: f.selected.broker_id,
      workspaceId: f.selected.workspace_id,
      uid: 44180,
      gid: 44180,
      artifacts: {
        nodeSHA256: artifactProof('node').sha256,
        executorSHA256: artifactProof('executor.mjs').sha256,
        gitSHA256: artifactProof('git').sha256,
        installManifestSHA256: sha(manifest),
      },
      peerBindings: [
        {
          uid: 44181,
          agentId: f.selected.agent_id,
          subject: {
            principalId: f.selected.principal_id,
            runtimeUid: f.selected.runtime_uid_claim,
            runId: f.selected.run_id,
          },
        },
      ],
      githubApp: { appId: 10, installationId: 20, owner: 'Fixture', repo: 'qualification' },
    }),
  );
  for (const [name, raw] of files) {
    const full = join(root, name);
    mkdirSync(join(full, '..'), { recursive: true, mode: 0o700 });
    writeFileSync(full, raw, { mode: 0o600 });
  }
  const sums = Buffer.from(
    [...files]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, raw]) => `${sha(raw)}  ./${name}`)
      .join('\n') + '\n',
  );
  writeFileSync(join(root, 'SHA256SUMS'), sums, { mode: 0o600 });
  return { packageDirectory: root, manifestSHA256: sha(sums) };
}
afterEach(() => {
  Object.assign(fault, {
    fsync: false,
    zeroWrite: false,
    shortWrite: false,
    syncedFiles: 0,
    syncedDirectories: 0,
    openedFiles: 0,
  });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('cleanup evidence preparation', () => {
  it('rejects unknown options including a caller-controlled clock before file access', () => {
    const result = prepareCleanupEvidenceDraft({
      schema: 'openslack.cleanup_admin_evidence_input.v1',
      phase: 'target',
      now: '2099-01-01T00:00:00Z',
    } as never);
    expect(result.published).toBe(false);
    expect(result.blockingIssues[0]?.code).toBe('EVIDENCE_INPUT_INVALID');
  });
  it.each(['win32', 'darwin'])('rejects %s before opening any file', (platform) => {
    vi.stubGlobal('process', { ...process, platform });
    const ref = { path: '/var/tmp/never-read.json', sha256: 'a'.repeat(64) };
    const result = prepareCleanupEvidenceDraft({
      schema: 'openslack.cleanup_admin_evidence_input.v1',
      phase: 'target',
      candidateHead: head,
      outputDirectory: '/tmp/never-create',
      sources: {
        selectedBindings: ref,
        observation: ref,
        dependencyObservation: ref,
        dependencyInventory: ref,
        appScope: ref,
        network: ref,
        taskView: ref,
        taskAttestation: ref,
      },
      artifacts: CLEANUP_INSTALL_LAYOUT.map((v) => ({ artifact: v.artifact, source: ref })),
    });
    expect(result.published).toBe(false);
    expect(result.blockingIssues[0]?.code).toBe('EVIDENCE_UNSUPPORTED_PLATFORM');
    expect(fault.openedFiles).toBe(0);
  });
  if (declareLinuxCleanupTests) {
    it('captures a Node artifact above 256 MiB through the 512 MiB streaming contract', async () => {
      const f = fixture(),
        node = f.input.artifacts.find((entry) => entry.artifact === 'node')!;
      truncateSync(node.source.path, 257 * 1024 * 1024);
      const expected = createHash('sha256');
      // Read all real bytes for the independent expected digest, without
      // thousands of default 64 KiB async I/O callbacks inside the test budget.
      for await (const block of createReadStream(node.source.path, { highWaterMark: 1024 * 1024 }))
        expected.update(block);
      node.source.sha256 = expected.digest('hex');
      const result = prepareCleanupEvidenceDraft(f.input);
      expect(result.blockingIssues).toEqual([]);
      expect(result.published).toBe(true);
      const manifest = JSON.parse(
        readFileSync(result.targetEvidence!.installationManifestPath, 'utf8'),
      );
      expect(
        manifest.files.find((entry: { path: string }) => entry.path.endsWith('/node')).sha256,
      ).toBe(node.source.sha256);
    });
    it('rejects Node above 512 MiB before publication', () => {
      const f = fixture(),
        node = f.input.artifacts.find((entry) => entry.artifact === 'node')!;
      truncateSync(node.source.path, 512 * 1024 * 1024 + 1);
      const result = prepareCleanupEvidenceDraft(f.input);
      expect(result.published).toBe(false);
      expect(result.blockingIssues[0]?.code).toBe('EVIDENCE_TOO_LARGE');
      expect(existsSync(f.input.outputDirectory)).toBe(false);
    });
    it('refuses a candidate-bound DRAFT from another candidate before publication', () => {
      const f = fixture();
      f.input.sources.selectedBindings = f.put('selected.json', {
        schema: 'openslack.cleanup_handoff_draft.v1',
        candidateHead: '5'.repeat(40),
        approvalStatus: 'DRAFT',
        selected: f.selected,
        priorInput: { source: 'fixture', sha256: 'a'.repeat(64), approvalNotInherited: true },
        installationAuthorized: false,
        executionAuthorized: false,
      });
      const result = prepareCleanupEvidenceDraft(f.input);
      expect(result.blockingIssues).toContainEqual({
        code: 'EVIDENCE_CANDIDATE_MISMATCH',
        role: 'selectedBindings',
      });
      expect(result.published).toBe(false);
      expect(existsSync(f.input.outputDirectory)).toBe(false);
    });
    it('reports missing automatic branch deletion by its field name before publication', () => {
      const f = fixture();
      const { automatic_branch_deletion: omitted, ...selected } = f.selected;
      expect(omitted).toBe('false');
      f.input.sources.selectedBindings = f.put('selected.json', {
        schema: 'openslack.cleanup_admin_selected_bindings.v1',
        selected,
        priorInput: { source: 'fixture', sha256: 'a'.repeat(64), approvalNotInherited: true },
      });
      const result = prepareCleanupEvidenceDraft(f.input);
      expect(result.blockingIssues).toContainEqual({
        code: 'EVIDENCE_BINDING_MISSING',
        role: 'automatic_branch_deletion',
      });
      expect(existsSync(f.input.outputDirectory)).toBe(false);
    });
    it('completes short writes with file and directory fsync', () => {
      const f = fixture();
      fault.shortWrite = true;
      const result = prepareCleanupEvidenceDraft(f.input);
      expect(result.published).toBe(true);
      expect(readFileSync(result.targetEvidence!.networkPath)).toEqual(
        readFileSync(f.input.sources.network.path),
      );
      expect(fault.syncedFiles).toBe(8);
      expect(fault.syncedDirectories).toBeGreaterThan(8);
    });
    it.each(['zeroWrite', 'fsync'] as const)(
      'does not report publication success after %s failure',
      (kind) => {
        const f = fixture();
        fault[kind] = true;
        const result = prepareCleanupEvidenceDraft(f.input);
        expect(result.published).toBe(false);
        expect(result.targetDraft).toBeUndefined();
        expect(result.targetEvidence).toBeUndefined();
        expect(result.blockingIssues.length).toBeGreaterThan(0);
        expect(result.installationAuthorized).toBe(false);
      },
    );
    it.each(['', '""'])('preserves the selected empty noProxy representation %s', (noProxy) => {
      const f = fixture();
      f.selected.approved_no_proxy = noProxy;
      f.input.sources.selectedBindings = f.put('selected.json', {
        schema: 'openslack.cleanup_admin_selected_bindings.v1',
        selected: f.selected,
        priorInput: { source: 'fixture', sha256: 'a'.repeat(64), approvalNotInherited: true },
      });
      const result = prepareCleanupEvidenceDraft(f.input);
      expect(result.blockingIssues).toEqual([]);
      expect(result.published).toBe(true);
      const index = JSON.parse(readFileSync(result.targetDraft!.path, 'utf8'));
      expect(index.selected.approved_no_proxy).toBe(noProxy);
    });
    it('publishes seven source-bound drafts while preserving actual installed hashes and runtime unknown state', () => {
      const f = fixture();
      const result = prepareCleanupEvidenceDraft(f.input);
      expect(result.blockingIssues).toEqual([]);
      expect(result.published).toBe(true);
      const index = JSON.parse(readFileSync(result.targetDraft!.path, 'utf8'));
      expect(index.runtimeIdentity).toEqual({ state: 'NOT_OBSERVED' });
      expect(index.installedManifest.state).toBe('missing');
      expect(index.installedFiles[1].mode).toBe('0644');
      const planned = JSON.parse(
        readFileSync(result.targetEvidence!.installationManifestPath, 'utf8'),
      );
      expect(
        planned.files.find((v: { path: string }) => v.path === CLEANUP_INSTALL_LAYOUT[1]!.path)
          .sha256,
      ).not.toBe(f.host.files[1]!.sha256);
      expect(JSON.parse(readFileSync(result.targetEvidence!.networkPath, 'utf8'))).toEqual(
        JSON.parse(readFileSync(f.input.sources.network.path, 'utf8')),
      );
    });
    it.each(['appScope', 'network', 'taskAttestation'] as const)(
      'reports missing %s without producing formal evidence',
      (role) => {
        const f = fixture();
        const input = { ...f.input, sources: { ...f.input.sources, [role]: undefined } };
        delete input.sources[role];
        const result = prepareCleanupEvidenceDraft(input);
        expect(result.published).toBe(false);
        expect(result.missingAdministratorDecisions).toContain(role);
        expect(existsSync(f.input.outputDirectory)).toBe(false);
      },
    );
    it.each(['closure', 'hostDigest', 'inventoryDigest', 'observedState', 'expiry'] as const)(
      'refuses dependency provenance defect %s with zero evidence',
      (kind) => {
        const f = fixture();
        if (kind === 'closure') f.dep.closureVerified = false;
        if (kind === 'hostDigest') f.dep.targetObservationSHA256 = '0'.repeat(64);
        if (kind === 'inventoryDigest') f.dep.productionInventory.sha256 = '0'.repeat(64);
        if (kind === 'observedState')
          f.dep.targetAfter = {
            ...f.dep.targetAfter,
            process: { ...f.dep.targetAfter.process, state: 'running' },
          };
        if (kind === 'expiry') f.dep.expiresAt = new Date(Date.now() - 1).toISOString();
        f.input.sources.dependencyObservation = f.put('dependency-observation.json', f.dep);
        expect(prepareCleanupEvidenceDraft(f.input).published).toBe(false);
        expect(existsSync(f.input.outputDirectory)).toBe(false);
      },
    );
    it('does not turn false administrator confirmation into true', () => {
      const f = fixture();
      const n = JSON.parse(readFileSync(f.input.sources.network.path, 'utf8'));
      n.administratorConfirmed = false;
      f.input.sources.network = f.put('network.json', n);
      expect(prepareCleanupEvidenceDraft(f.input).published).toBe(false);
      expect(existsSync(f.input.outputDirectory)).toBe(false);
    });
    it('does not claim complete when a task attestation is incomplete', () => {
      const f = fixture();
      const n = JSON.parse(readFileSync(f.input.sources.taskAttestation.path, 'utf8'));
      n.complete = false;
      f.input.sources.taskAttestation = f.put('attestation.json', n);
      expect(prepareCleanupEvidenceDraft(f.input).published).toBe(false);
    });
    it.each([
      'networkUnknown',
      'identity',
      'history',
      'sourcePermission',
      'artifactDigest',
      'taskFloat',
    ] as const)('refuses target-phase defect %s before publication', (kind) => {
      const f = fixture();
      if (kind === 'networkUnknown') {
        const n = JSON.parse(readFileSync(f.input.sources.network.path, 'utf8'));
        n.unapproved = 'value';
        f.input.sources.network = f.put('network.json', n);
      }
      if (kind === 'identity') {
        f.host.identities.agent.uid = 44180;
        f.input.sources.observation = f.put('observation.json', f.host);
      }
      if (kind === 'history') {
        f.host.persistentState.state = 'inspected';
        f.input.sources.observation = f.put('observation.json', f.host);
      }
      if (kind === 'sourcePermission') chmodSync(f.input.sources.network.path, 0o666);
      if (kind === 'artifactDigest')
        writeFileSync(f.input.artifacts[0]!.source.path, 'changed artifact');
      if (kind === 'taskFloat') {
        const raw = readFileSync(f.input.sources.taskView.path, 'utf8').replace(
          '"issueNumber": 1',
          '"issueNumber": 1.0',
        );
        f.input.sources.taskView = f.put('task.json', Buffer.from(raw));
        const att = JSON.parse(readFileSync(f.input.sources.taskAttestation.path, 'utf8'));
        att.task_view_sha256 = f.input.sources.taskView.sha256;
        f.input.sources.taskAttestation = f.put('attestation.json', att);
      }
      expect(prepareCleanupEvidenceDraft(f.input).published).toBe(false);
      expect(existsSync(f.input.outputDirectory)).toBe(false);
    });
    it('refuses sensitive source names before attempting a read', () => {
      const f = fixture();
      f.input.sources.network.path = join(f.root, 'credentials', 'network.json');
      const result = prepareCleanupEvidenceDraft(f.input);
      expect(result.blockingIssues[0]?.code).toBe('EVIDENCE_PATH_UNSAFE');
      expect(existsSync(f.input.outputDirectory)).toBe(false);
    });
    it('keeps a shorter original expiry instead of starting a new evidence lifetime', () => {
      const f = fixture(),
        n = JSON.parse(readFileSync(f.input.sources.network.path, 'utf8'));
      n.expiresAt = new Date(Date.now() + 120_000).toISOString();
      f.input.sources.network = f.put('network.json', n);
      const result = prepareCleanupEvidenceDraft(f.input);
      expect(result.published).toBe(true);
      const index = JSON.parse(readFileSync(result.targetDraft!.path, 'utf8'));
      expect(index.expiresAt).toBe(n.expiresAt);
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 180_000);
      const pkg = packageFixture(f, result.targetEvidence!);
      const final = prepareCleanupEvidenceDraft({
        schema: 'openslack.cleanup_admin_evidence_input.v1',
        phase: 'package',
        candidateHead: head,
        outputDirectory: join(f.root, 'expired package'),
        targetDraft: result.targetDraft!,
        ...pkg,
      });
      expect(final.published).toBe(false);
      expect(final.blockingIssues[0]?.code).toBe('EVIDENCE_EXPIRED');
    });
    it('normalizes historical approval to a new DRAFT without inheriting decision fields', () => {
      const f = fixture();
      f.selected.approval_status = 'APPROVED';
      f.input.sources.selectedBindings = f.put('selected.json', {
        schema: 'openslack.cleanup_admin_selected_bindings.v1',
        selected: {
          ...f.selected,
          approved_by: 'github:fixture',
          approved_at_utc: f.common.recordedAt,
        },
        priorInput: {
          source: 'historical approved selection',
          sha256: 'a'.repeat(64),
          approvalNotInherited: true,
        },
      });
      const result = prepareCleanupEvidenceDraft(f.input);
      expect(result.published).toBe(true);
      const index = JSON.parse(readFileSync(result.targetDraft!.path, 'utf8'));
      expect(index.selected.approval_status).toBe('DRAFT');
      expect(index.selected.approved_by).toBe('REQUIRED');
      expect(index.installationAuthorized).toBe(false);
    });
    it.each(['symlink', 'hardlink', 'parentlink', 'fifo', 'digest'] as const)(
      'rejects unsafe source %s before any publication',
      (kind) => {
        const f = fixture();
        const path = f.input.sources.network.path;
        if (kind === 'digest') writeFileSync(path, bytes({ replaced: true }));
        else if (kind === 'hardlink') linkSync(path, join(f.root, 'second-link'));
        else if (kind === 'symlink') {
          const alias = join(f.root, 'alias');
          symlinkSync(path, alias);
          f.input.sources.network.path = alias;
        } else if (kind === 'parentlink') {
          const alias = join(f.root, 'parent-alias');
          symlinkSync(f.root, alias);
          f.input.sources.network.path = join(alias, 'network.json');
        } else {
          rmSync(path);
          execFileSync('mkfifo', [path]);
        }
        expect(prepareCleanupEvidenceDraft(f.input).published).toBe(false);
        expect(existsSync(f.input.outputDirectory)).toBe(false);
      },
    );
    it('refuses existing output and preserves its contents', () => {
      const f = fixture();
      mkdirSync(f.input.outputDirectory, { mode: 0o700 });
      writeFileSync(join(f.input.outputDirectory, 'keep'), 'historical');
      const result = prepareCleanupEvidenceDraft(f.input);
      expect(result.blockingIssues.map((v) => v.code)).toContain('EVIDENCE_OUTPUT_EXISTS');
      expect(readFileSync(join(f.input.outputDirectory, 'keep'), 'utf8')).toBe('historical');
    });
    it('refuses duplicate keys in recipe and source JSON', () => {
      const f = fixture();
      const path = join(f.root, 'recipe.json');
      writeFileSync(path, '{"schema":"one","schema":"two"}');
      expect(() => readCleanupEvidenceDraftInput(path)).toThrow();
      const raw = Buffer.from('{"schema":"one","schema":"two"}');
      f.input.sources.network = f.put('network.json', raw);
      expect(prepareCleanupEvidenceDraft(f.input).published).toBe(false);
    });
    it('binds package evidence to a genuinely verified v1 package and preserves actual old destination facts', () => {
      const f = fixture(),
        target = prepareCleanupEvidenceDraft(f.input);
      expect(target.published).toBe(true);
      const pkg = packageFixture(f, target.targetEvidence!);
      expect(
        evaluateCleanupHandoffVerification(
          verifyCleanupHandoffPackage({ ...pkg, candidateHead: head }),
        ),
      ).toBe(0);
      const result = prepareCleanupEvidenceDraft({
        schema: 'openslack.cleanup_admin_evidence_input.v1',
        phase: 'package',
        candidateHead: head,
        outputDirectory: join(f.root, 'package evidence'),
        targetDraft: target.targetDraft!,
        ...pkg,
      });
      expect(result.blockingIssues).toEqual([]);
      expect(result.published).toBe(true);
      const admin = JSON.parse(readFileSync(result.adminInputPath!, 'utf8')),
        host = JSON.parse(readFileSync(result.hostInspectionPath!, 'utf8'));
      expect(admin.approvalStatus).toBe('DRAFT');
      expect(admin.approvedBy).toBeNull();
      expect(admin.approvedAt).toBeNull();
      expect(host.files[1].sha256).toBe(f.host.files[1]!.sha256);
      expect(host.files[1].mode).toBe('0644');
      expect(host.persistentState.consistentBackupVerified).toBe(false);
      expect(host.manifestSHA256).toBe(pkg.manifestSHA256);
      expect(result.installationManifestSHA256).not.toBe(pkg.manifestSHA256);
    });
    it.each(['targetSource', 'targetIndex', 'packageBytes', 'expiry', 'packageSelection'] as const)(
      'refuses package-phase conflict %s before publication',
      (kind) => {
        const f = fixture(),
          target = prepareCleanupEvidenceDraft(f.input);
        expect(target.published).toBe(true);
        const pkg = packageFixture(f, target.targetEvidence!);
        if (kind === 'targetSource')
          writeFileSync(f.input.sources.network.path, bytes({ changed: true }));
        if (kind === 'targetIndex') {
          const index = JSON.parse(readFileSync(target.targetDraft!.path, 'utf8'));
          index.selected.run_id = 'changed';
          const raw = bytes(index);
          writeFileSync(target.targetDraft!.path, raw);
          target.targetDraft!.sha256 = sha(raw);
        }
        if (kind === 'packageBytes')
          writeFileSync(join(pkg.packageDirectory, 'README.md'), 'tampered');
        if (kind === 'expiry') vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 7_200_000);
        if (kind === 'packageSelection') {
          f.selected.run_id = 'wrong-run';
          const other = join(f.root, 'other');
          mkdirSync(other);
          const rebuilt = packageFixture({ ...f, root: other }, target.targetEvidence!);
          Object.assign(pkg, rebuilt);
        }
        const outputDirectory = join(f.root, 'never package publish');
        const result = prepareCleanupEvidenceDraft({
          schema: 'openslack.cleanup_admin_evidence_input.v1',
          phase: 'package',
          candidateHead: head,
          outputDirectory,
          targetDraft: target.targetDraft!,
          ...pkg,
        });
        expect(result.published).toBe(false);
        expect(existsSync(outputDirectory)).toBe(false);
      },
    );
    it('runs the actual standalone Node preparation entry with no checkout requirement after bundling', () => {
      const f = fixture(),
        recipe = f.put('recipe.json', f.input),
        tool = join(f.root, 'prepare-evidence.mjs');
      const entry = fileURLToPath(
        new URL(
          '../../../../scripts/cleanup-broker/administration/prepare-evidence.ts',
          import.meta.url,
        ),
      );
      execFileSync(testExecutable('bun'), ['build', entry, '--target=node', '--outfile=' + tool], {
        cwd: f.root,
        stdio: 'pipe',
      });
      const result = spawnSync(process.execPath, [tool, '--input', recipe.path], {
        cwd: f.root,
        encoding: 'utf8',
      });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).published).toBe(true);
      const refused = spawnSync(
        process.execPath,
        [tool, '--input', recipe.path, '--now', '2099-01-01'],
        { cwd: f.root, encoding: 'utf8' },
      );
      expect(refused.status).toBe(2);
      expect(refused.stderr).toContain('EVIDENCE_INPUT_INVALID');
    });
  }
});
