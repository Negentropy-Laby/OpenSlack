import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  UPGRADE_EVIDENCE_ROLES,
  UPGRADE_EVIDENCE_SCHEMAS,
  validateCapturedUpgradeEvidence,
  type UpgradeEvidenceInput,
} from '../internal/cleanup-upgrade-evidence.js';

const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
/** Immutable, non-sensitive observed facts. These fixtures never assert a real installation. */
function fixture() {
  const selected = {
    target_distro: 'fixture-target',
    workspace_id: 'fixture-workspace',
    qualification_repository_owner: 'fixture',
    qualification_repository_name: 'qualification',
    qualification_repository_numeric_id: '12345',
    approved_https_proxy: '""',
    approved_no_proxy: '""',
    deletion_app_id: '123',
    deletion_app_installation_id: '456',
    agent_id: 'fixture_agent',
    broker_id: 'fixture-broker',
    broker_uid: '44180',
    broker_gid: '44180',
    agent_uid: '44181',
    agent_gid: '44181',
    principal_id: 'principal:fixture_agent',
    runtime_uid_claim: 'fixture_agent',
    run_id: 'fixture-run',
  };
  const common = {
    target: selected.target_distro,
    workspaceId: selected.workspace_id,
    repository: 'fixture/qualification',
    repositoryId: '12345',
    recordedAt: '2026-10-08T12:00:00Z',
    expiresAt: '2026-10-09T12:00:00Z',
  };
  const identities = {
    broker: { uid: 44180, gid: 44180 },
    agent: { uid: 44181, gid: 44181 },
    principalId: selected.principal_id,
    runtimeUid: selected.runtime_uid_claim,
    runId: selected.run_id,
  };
  const targetEvidence: UpgradeEvidenceInput['targetEvidence'] = {
    installationManifestPath: 'installationManifestPath',
    taskViewPath: 'taskViewPath',
    taskAttestationPath: 'taskAttestationPath',
    appScopePath: 'appScopePath',
    networkPath: 'networkPath',
    identityPath: 'identityPath',
    dependencyInventoryPath: 'dependencyInventoryPath',
  };
  const input: UpgradeEvidenceInput = {
    adminInputPath: 'admin',
    hostInspectionPath: 'host',
    targetEvidence,
    candidateHead: 'a'.repeat(40),
    manifestSHA256: 'b'.repeat(64),
    now: Date.parse('2026-10-08T12:30:00Z'),
    selected,
    layout: [{ path: '/usr/lib/openslack-cleanup/node', mode: '0755' }],
  };
  const bytes = new Map<string, Buffer>();
  const write = (path: string, value: unknown) =>
    bytes.set(path, Buffer.from(JSON.stringify(value)));
  write('installationManifestPath', {
    schema: 'openslack.cleanup_installation.v1',
    files: [],
    network: { httpsProxy: '', noProxy: '' },
  });
  write('taskViewPath', {
    schema: 'openslack.cleanup_task_view.v1',
    workspaceId: common.workspaceId,
    repository: common.repository,
    repositoryId: common.repositoryId,
    notBefore: common.recordedAt,
    expiresAt: common.expiresAt,
    tasks: [],
  });
  write('taskAttestationPath', {
    ...common,
    schema: UPGRADE_EVIDENCE_SCHEMAS.taskAttestation,
    complete: true,
    task_view_sha256: sha(bytes.get('taskViewPath')!),
  });
  write('appScopePath', {
    ...common,
    schema: UPGRADE_EVIDENCE_SCHEMAS.appScope,
    appId: 123,
    installationId: 456,
    selectedRepositories: [{ repository: common.repository, repositoryId: common.repositoryId }],
    permissions: { contents: 'write', metadata: 'read', issues: 'read', pull_requests: 'read' },
  });
  write('networkPath', {
    ...common,
    schema: UPGRADE_EVIDENCE_SCHEMAS.network,
    httpsProxy: '',
    noProxy: '',
    ownerAccount: 'fixture-admin',
    executablePath: '/fixture/proxy',
    executableSHA256: sha('fixture-proxy'),
    administratorConfirmed: true,
  });
  write('identityPath', {
    ...common,
    schema: UPGRADE_EVIDENCE_SCHEMAS.identity,
    agentId: selected.agent_id,
    brokerId: selected.broker_id,
    identities,
  });
  write('dependencyInventoryPath', {
    ...common,
    schema: UPGRADE_EVIDENCE_SCHEMAS.dependencies,
    files: [
      { path: '/usr/lib/fixture.so', sha256: sha('fixture-library'), uid: 0, gid: 0, mode: '0644' },
    ],
  });
  write('admin', {
    ...common,
    schema: UPGRADE_EVIDENCE_SCHEMAS.admin,
    candidateHead: input.candidateHead,
    manifestSHA256: input.manifestSHA256,
    selected,
    approvalStatus: 'DRAFT',
    approvedBy: null,
    approvedAt: null,
  });
  const seal = () =>
    write('host', {
      ...common,
      schema: UPGRADE_EVIDENCE_SCHEMAS.host,
      candidateHead: input.candidateHead,
      manifestSHA256: input.manifestSHA256,
      identities,
      files: [
        {
          path: input.layout[0]!.path,
          state: 'missing',
          sha256: null,
          uid: null,
          gid: null,
          mode: null,
        },
      ],
      process: { state: 'stopped', pid: null },
      persistentState: {
        state: 'inspected',
        ledgerSHA256: sha('ledger'),
        journalSHA256: sha('journal'),
        consistentBackupVerified: false,
      },
      evidenceSHA256: Object.fromEntries(
        UPGRADE_EVIDENCE_ROLES.map((role) => [role, sha(bytes.get(role) ?? Buffer.alloc(0))]),
      ),
    });
  seal();
  return { input, bytes, write, seal };
}

function taskFixture(tasks: unknown[]) {
  const f = fixture();
  const view = JSON.parse(f.bytes.get('taskViewPath')!.toString()) as Record<string, unknown>;
  f.write('taskViewPath', { ...view, tasks });
  const attestation = JSON.parse(f.bytes.get('taskAttestationPath')!.toString()) as Record<
    string,
    unknown
  >;
  f.write('taskAttestationPath', {
    ...attestation,
    task_view_sha256: sha(f.bytes.get('taskViewPath')!),
  });
  f.seal();
  return f;
}

function replaceTaskBytes(f: ReturnType<typeof fixture>, raw: Buffer) {
  f.bytes.set('taskViewPath', raw);
  const attestation = JSON.parse(f.bytes.get('taskAttestationPath')!.toString()) as Record<
    string,
    unknown
  >;
  f.write('taskAttestationPath', { ...attestation, task_view_sha256: sha(raw) });
  f.seal();
}

describe('upgrade task evidence matches the Broker task contract', () => {
  it.each(['1.0', '1e0', '1E+0', '9007199254740991.1'])(
    'refuses the non-uint64 JSON Issue token %s',
    (literal) => {
      const f = taskFixture([{ taskId: 'TASK-1', issueNumber: 1, state: 'pending' }]);
      const raw = f.bytes.get('taskViewPath')!.toString();
      replaceTaskBytes(f, Buffer.from(raw.replace('"issueNumber":1', `"issueNumber":${literal}`)));
      expect(() => validateCapturedUpgradeEvidence(f.input, f.bytes)).toThrowError(
        expect.objectContaining({ role: 'taskViewPath', reason: 'EVIDENCE_INVALID' }),
      );
    },
  );

  it.each(['1', '1e0'])('checks escaped Issue keys with token %s', (literal) => {
    const f = taskFixture([{ taskId: 'TASK-1', issueNumber: 1, state: 'pending' }]);
    const raw = f.bytes.get('taskViewPath')!.toString();
    replaceTaskBytes(
      f,
      Buffer.from(raw.replace('"issueNumber":1', `"issue\\u004eumber":${literal}`)),
    );
    if (literal === '1')
      expect(() => validateCapturedUpgradeEvidence(f.input, f.bytes)).not.toThrow();
    else
      expect(() => validateCapturedUpgradeEvidence(f.input, f.bytes)).toThrowError(
        expect.objectContaining({ role: 'taskViewPath', reason: 'EVIDENCE_INVALID' }),
      );
  });

  it.each(['pending', 'claimed', 'in-progress', 'completed', 'released'])(
    'accepts the production state %s',
    (state) => {
      const { input, bytes } = taskFixture([{ taskId: 'TASK-1', issueNumber: 1, state }]);
      expect(() => validateCapturedUpgradeEvidence(input, bytes)).not.toThrow();
    },
  );

  it.each(['active', 'blocked', 'done', 'cancelled'])(
    'refuses the non-production state %s even with matching evidence hashes',
    (state) => {
      const { input, bytes } = taskFixture([{ taskId: 'TASK-1', issueNumber: 1, state }]);
      expect(() => validateCapturedUpgradeEvidence(input, bytes)).toThrowError(
        expect.objectContaining({ role: 'taskViewPath', reason: 'EVIDENCE_INVALID' }),
      );
    },
  );

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1', null])(
    'refuses the invalid Issue number %j',
    (issueNumber) => {
      const { input, bytes } = taskFixture([{ taskId: 'TASK-1', issueNumber, state: 'pending' }]);
      expect(() => validateCapturedUpgradeEvidence(input, bytes)).toThrowError(
        expect.objectContaining({ role: 'taskViewPath', reason: 'EVIDENCE_INVALID' }),
      );
    },
  );

  it('accepts the largest safe positive Issue number', () => {
    const { input, bytes } = taskFixture([
      { taskId: 'TASK-1', issueNumber: Number.MAX_SAFE_INTEGER, state: 'pending' },
    ]);
    expect(() => validateCapturedUpgradeEvidence(input, bytes)).not.toThrow();
  });

  it.each([1024, 4096, 4097])('preserves production limits at %i entries', (count) => {
    const { input, bytes } = taskFixture(
      Array.from({ length: count }, (_, i) => ({
        taskId: `T${i}`,
        issueNumber: i + 1,
        state: 'pending',
      })),
    );
    // Go permit.Decode's 64 KiB limit also applies to task views. The count
    // ceiling does not promise that a 4096-entry representation fits that limit.
    if (count === 1024) expect(() => validateCapturedUpgradeEvidence(input, bytes)).not.toThrow();
    else
      expect(() => validateCapturedUpgradeEvidence(input, bytes)).toThrowError(
        expect.objectContaining({ role: 'taskViewPath', reason: 'EVIDENCE_INVALID' }),
      );
  });

  it.each([65536, 65537])('uses the production task-view byte bound at %i bytes', (size) => {
    const f = taskFixture([{ taskId: 'TASK-1', issueNumber: 1, state: 'pending' }]);
    const raw = f.bytes.get('taskViewPath')!;
    f.bytes.set('taskViewPath', Buffer.concat([raw, Buffer.alloc(size - raw.length, ' ')]));
    const attestation = JSON.parse(f.bytes.get('taskAttestationPath')!.toString()) as Record<
      string,
      unknown
    >;
    f.write('taskAttestationPath', {
      ...attestation,
      task_view_sha256: sha(f.bytes.get('taskViewPath')!),
    });
    f.seal();
    if (size === 65536)
      expect(() => validateCapturedUpgradeEvidence(f.input, f.bytes)).not.toThrow();
    else
      expect(() => validateCapturedUpgradeEvidence(f.input, f.bytes)).toThrowError(
        expect.objectContaining({ role: 'taskViewPath', reason: 'EVIDENCE_INVALID' }),
      );
  });

  it.each(['', '../TASK-1', 'TASK/1', 'TASK:1', 'T'.repeat(129)])(
    'preserves the selected strict task identifier rule for %j',
    (taskId) => {
      const { input, bytes } = taskFixture([{ taskId, issueNumber: 1, state: 'pending' }]);
      expect(() => validateCapturedUpgradeEvidence(input, bytes)).toThrowError(
        expect.objectContaining({ role: 'taskViewPath', reason: 'EVIDENCE_INVALID' }),
      );
    },
  );

  it('continues to refuse duplicate task identities', () => {
    const task = { taskId: 'TASK-1', issueNumber: 1, state: 'pending' };
    const { input, bytes } = taskFixture([task, { ...task, issueNumber: 2 }]);
    expect(() => validateCapturedUpgradeEvidence(input, bytes)).toThrowError(
      expect.objectContaining({ role: 'taskViewPath', reason: 'EVIDENCE_INVALID' }),
    );
  });

  it('continues to refuse unknown fields in individual tasks', () => {
    const { input, bytes } = taskFixture([
      { taskId: 'TASK-1', issueNumber: 1, state: 'pending', unexpected: true },
    ]);
    expect(() => validateCapturedUpgradeEvidence(input, bytes)).toThrowError(
      expect.objectContaining({ role: 'taskViewPath', reason: 'EVIDENCE_INVALID' }),
    );
  });
});

describe('captured upgrade evidence parsing on every platform', () => {
  it('validates complete captured facts without asserting deployment or touching files', () => {
    const { input, bytes } = fixture();
    expect(validateCapturedUpgradeEvidence(input, bytes).files[0]!.state).toBe('missing');
  });
  it.each(UPGRADE_EVIDENCE_ROLES)('rejects missing %s', (role) => {
    const { input, bytes } = fixture();
    bytes.delete(role);
    expect(() => validateCapturedUpgradeEvidence(input, bytes)).toThrowError(
      expect.objectContaining({ role, reason: 'EVIDENCE_MISSING' }),
    );
  });
  it.each(UPGRADE_EVIDENCE_ROLES)(
    'rejects unknown keys in %s even after its digest matches',
    (role) => {
      const { input, bytes, write, seal } = fixture();
      write(role, { ...JSON.parse(bytes.get(role)!.toString()), unexpected: true });
      seal();
      expect(() => validateCapturedUpgradeEvidence(input, bytes)).toThrowError(
        expect.objectContaining({ role, reason: 'EVIDENCE_INVALID' }),
      );
    },
  );
  it.each(UPGRADE_EVIDENCE_ROLES)('rejects escaped duplicate keys in %s', (role) => {
    const { input, bytes, seal } = fixture();
    const raw = bytes.get(role)!.toString();
    bytes.set(role, Buffer.from(raw.replace('{', '{"sch\\u0065ma":"duplicate",')));
    seal();
    expect(() => validateCapturedUpgradeEvidence(input, bytes)).toThrowError(
      expect.objectContaining({ role, reason: 'EVIDENCE_INVALID' }),
    );
  });
  it.each([
    'networkPath',
    'identityPath',
    'appScopePath',
    'dependencyInventoryPath',
    'taskAttestationPath',
  ] as const)('rejects stale %s', (role) => {
    const { input, bytes, write, seal } = fixture();
    write(role, { ...JSON.parse(bytes.get(role)!.toString()), expiresAt: '2026-10-08T12:01:00Z' });
    seal();
    expect(() => validateCapturedUpgradeEvidence(input, bytes)).toThrowError(
      expect.objectContaining({ role, reason: 'EVIDENCE_EXPIRED' }),
    );
  });
});
