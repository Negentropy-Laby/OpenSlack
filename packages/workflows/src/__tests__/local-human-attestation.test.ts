import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bindLocalHumanSubjectForTest,
  createLocalHumanAttestationProviderForTest,
  getLocalHumanAttestationStatusForTest,
  LOCAL_HUMAN_SUBJECTS_SCHEMA,
  type LocalHumanAttestationDependencies,
  type LocalHumanAttestationRequest,
} from '../local-human-attestation.js';

const roots: string[] = [];
const SUBJECT = 'test-os-subject:uid-1000';
const HUMAN = 'human.interviewer';

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'openslack-local-human-attestation-'));
  roots.push(root);
  return resolve(root);
}

function dependencies(
  options: {
    readonly subject?: string;
    readonly resolveSubject?: LocalHumanAttestationDependencies['resolveSubject'];
    readonly tty?: boolean;
    readonly answer?: string;
    readonly prompt?: LocalHumanAttestationDependencies['promptTty'];
  } = {},
): LocalHumanAttestationDependencies {
  return Object.freeze({
    platform: process.platform,
    now: () => new Date().toISOString(),
    resolveSubject:
      options.resolveSubject ?? (() => Object.freeze({ canonical: options.subject ?? SUBJECT })),
    assertOwnedPath: () => undefined,
    hardenPath: (path: string, directory: boolean) => {
      if (process.platform !== 'win32') chmodSync(path, directory ? 0o700 : 0o600);
    },
    probeTty: () => {
      if (options.tty === false) throw new Error('no tty');
    },
    promptTty:
      options.prompt ??
      (async () => {
        return options.answer ?? 'APPROVE';
      }),
  });
}

function bind(root: string, deps: LocalHumanAttestationDependencies): void {
  bindLocalHumanSubjectForTest(
    {
      workspaceRoot: root,
      humanPrincipalId: HUMAN,
      confirmed: true,
    },
    deps,
  );
}

function request(
  decision: 'approved' | 'rejected' = 'approved',
  signal: AbortSignal = new AbortController().signal,
): LocalHumanAttestationRequest {
  const reason = decision === 'approved' ? 'Reviewed locally.' : 'Rejected locally.';
  return Object.freeze({
    runId: 'run-001',
    approvalId: 'approval-001',
    decision,
    reason,
    reasonHash: createHash('sha256').update(reason, 'utf8').digest('hex'),
    requiredCapability: 'workflow.effect.decide',
    correlationId: 'correlation-001',
    approvalExpiresAt: new Date(Date.now() + 120_000).toISOString(),
    signal,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('credential-free local human attestation', () => {
  it('binds only the current subject hash and reports sanitized readiness', () => {
    const root = workspace();
    const deps = dependencies();
    const status = bindLocalHumanSubjectForTest(
      {
        workspaceRoot: root,
        humanPrincipalId: HUMAN,
        confirmed: true,
      },
      deps,
    );
    expect(status).toEqual({
      schema: 'openslack.local_human_attestation_status.v1',
      state: 'ready',
      version: 1,
      humanPrincipalId: HUMAN,
      ttyAvailable: true,
    });
    expect(Object.isFrozen(status)).toBe(true);

    const source = readFileSync(
      join(root, '.openslack.local', 'mcp', 'human-subjects.json'),
      'utf8',
    );
    const document = JSON.parse(source) as {
      schema: string;
      subjects: { subjectHash: string; humanPrincipalId: string }[];
    };
    expect(document.schema).toBe(LOCAL_HUMAN_SUBJECTS_SCHEMA);
    expect(document.subjects).toHaveLength(1);
    expect(document.subjects[0]).toMatchObject({
      subjectHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      humanPrincipalId: HUMAN,
    });
    expect(source).not.toContain(SUBJECT);
    expect(source).not.toMatch(/sid|username|credential|secret/i);
    expect(getLocalHumanAttestationStatusForTest(root, deps)).toEqual(status);
  });

  it('requires explicit binding confirmation and a matching mapped principal', () => {
    const root = workspace();
    const deps = dependencies();
    expect(() =>
      bindLocalHumanSubjectForTest(
        {
          workspaceRoot: root,
          humanPrincipalId: HUMAN,
          confirmed: false,
        } as never,
        deps,
      ),
    ).toThrowError(expect.objectContaining({ code: 'LOCAL_HUMAN_ATTESTATION_INPUT_INVALID' }));
    bind(root, deps);
    expect(() =>
      createLocalHumanAttestationProviderForTest(
        {
          workspaceRoot: root,
          workspaceId: 'workspace-main',
          humanPrincipalAssertion: 'human.someone-else',
        },
        deps,
      ),
    ).toThrowError(expect.objectContaining({ code: 'LOCAL_HUMAN_ATTESTATION_PRINCIPAL_MISMATCH' }));
  });

  it('atomically replaces an existing binding for the same current subject', () => {
    const root = workspace();
    const deps = dependencies();
    bind(root, deps);
    const status = bindLocalHumanSubjectForTest(
      {
        workspaceRoot: root,
        humanPrincipalId: 'human.reviewer-two',
        confirmed: true,
      },
      deps,
    );
    expect(status).toMatchObject({
      state: 'ready',
      humanPrincipalId: 'human.reviewer-two',
    });
    const document = JSON.parse(
      readFileSync(join(root, '.openslack.local', 'mcp', 'human-subjects.json'), 'utf8'),
    ) as { subjects: unknown[] };
    expect(document.subjects).toHaveLength(1);
  });

  it('fails the requested profile at startup when no controlling TTY is available', () => {
    const root = workspace();
    const bindDeps = dependencies();
    bind(root, bindDeps);
    expect(() =>
      createLocalHumanAttestationProviderForTest(
        {
          workspaceRoot: root,
          workspaceId: 'workspace-main',
          humanPrincipalAssertion: HUMAN,
        },
        dependencies({ tty: false }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'LOCAL_HUMAN_ATTESTATION_TTY_UNAVAILABLE' }));
  });

  it.each([
    { decision: 'approved' as const, token: 'APPROVE' },
    { decision: 'rejected' as const, token: 'REJECT' },
  ])(
    'issues one nominal $decision binding scoped to every approval field',
    async ({ decision, token }) => {
      const root = workspace();
      let prompt = '';
      const deps = dependencies({
        prompt: async (value) => {
          prompt = value;
          return token;
        },
      });
      bind(root, deps);
      const provider = createLocalHumanAttestationProviderForTest(
        {
          workspaceRoot: root,
          workspaceId: 'workspace-main',
          humanPrincipalAssertion: HUMAN,
        },
        deps,
      );
      const input = request(decision);
      const binding = await provider.attest(input);
      expect(binding).toMatchObject({
        principalId: HUMAN,
        workspaceId: 'workspace-main',
        capability: input.requiredCapability,
        runId: input.runId,
        approvalId: input.approvalId,
        correlationId: input.correlationId,
        approvalExpiresAt: input.approvalExpiresAt,
        decision,
        reasonHash: input.reasonHash,
      });
      expect(Date.parse(binding.expiresAt)).toBeLessThanOrEqual(
        Date.parse(input.approvalExpiresAt),
      );
      expect(prompt).toContain(`Type ${token} to attest this exact decision`);
      expect(prompt).toContain(`Reason SHA-256: ${input.reasonHash}`);
      expect(Object.isFrozen(binding)).toBe(true);
    },
  );

  it('rejects confirmation mismatch, abort, and an insufficient decision lifetime', async () => {
    const root = workspace();
    const mismatch = dependencies({ answer: 'APPROVE' });
    bind(root, mismatch);
    const provider = createLocalHumanAttestationProviderForTest(
      {
        workspaceRoot: root,
        workspaceId: 'workspace-main',
        humanPrincipalAssertion: HUMAN,
      },
      mismatch,
    );
    await expect(provider.attest(request('rejected'))).rejects.toMatchObject({
      code: 'LOCAL_HUMAN_ATTESTATION_CONFIRMATION_MISMATCH',
    });
    const whitespaceProvider = createLocalHumanAttestationProviderForTest(
      {
        workspaceRoot: root,
        workspaceId: 'workspace-main',
        humanPrincipalAssertion: HUMAN,
      },
      dependencies({ answer: ' APPROVE ' }),
    );
    await expect(whitespaceProvider.attest(request())).rejects.toMatchObject({
      code: 'LOCAL_HUMAN_ATTESTATION_CONFIRMATION_MISMATCH',
    });

    const controller = new AbortController();
    controller.abort();
    await expect(provider.attest(request('approved', controller.signal))).rejects.toMatchObject({
      code: 'LOCAL_HUMAN_ATTESTATION_ABORTED',
    });
    await expect(
      provider.attest({
        ...request(),
        deadlineAt: new Date(Date.now() + 500).toISOString(),
      }),
    ).rejects.toMatchObject({ code: 'LOCAL_HUMAN_ATTESTATION_EXPIRED' });
  });

  it('detects local OS subject drift before prompting', async () => {
    const root = workspace();
    let subject = SUBJECT;
    const deps = dependencies({
      resolveSubject: () => Object.freeze({ canonical: subject }),
    });
    bind(root, deps);
    const provider = createLocalHumanAttestationProviderForTest(
      {
        workspaceRoot: root,
        workspaceId: 'workspace-main',
        humanPrincipalAssertion: HUMAN,
      },
      deps,
    );
    subject = 'test-os-subject:uid-2000';
    await expect(provider.attest(request())).rejects.toMatchObject({
      code: 'LOCAL_HUMAN_ATTESTATION_PRINCIPAL_MISMATCH',
    });
  });

  it('detects a same-byte mapping replacement before issuing a binding', async () => {
    const root = workspace();
    const target = join(root, '.openslack.local', 'mcp', 'human-subjects.json');
    const deps = dependencies({
      prompt: async () => {
        const replacement = `${target}.replacement`;
        writeFileSync(replacement, readFileSync(target));
        if (process.platform !== 'win32') chmodSync(replacement, 0o600);
        rmSync(target);
        renameSync(replacement, target);
        return 'APPROVE';
      },
    });
    bind(root, deps);
    const provider = createLocalHumanAttestationProviderForTest(
      {
        workspaceRoot: root,
        workspaceId: 'workspace-main',
        humanPrincipalAssertion: HUMAN,
      },
      deps,
    );
    await expect(provider.attest(request())).rejects.toMatchObject({
      code: 'LOCAL_HUMAN_ATTESTATION_MAPPING_CHANGED',
    });
  });

  it.skipIf(process.platform === 'win32')('rejects a symlinked mapping source', () => {
    const root = workspace();
    const deps = dependencies();
    bind(root, deps);
    const target = join(root, '.openslack.local', 'mcp', 'human-subjects.json');
    const backup = `${target}.backup`;
    renameSync(target, backup);
    symlinkSync(backup, target);
    expect(() => getLocalHumanAttestationStatusForTest(root, deps)).toThrowError(
      expect.objectContaining({ code: 'LOCAL_HUMAN_ATTESTATION_MAPPING_INVALID' }),
    );
  });

  it('keeps production prompting on the controlling TTY instead of MCP stdio', () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'local-human-attestation.ts'),
      'utf8',
    );
    expect(source).not.toContain('process.stdin');
    expect(source).not.toContain('process.stdout');
    expect(source).toContain("const POSIX_TTY_DEVICE = '/dev/tty'");
    expect(source).toContain("const WINDOWS_TTY_INPUT = 'CONIN$'");
    expect(source).toContain("const WINDOWS_TTY_OUTPUT = 'CONOUT$'");
    expect(source).toContain('openSync(WINDOWS_TTY_INPUT, fsConstants.O_RDONLY | NO_FOLLOW)');
    expect(source).toContain('openSync(WINDOWS_TTY_OUTPUT, fsConstants.O_WRONLY | NO_FOLLOW)');
    expect(source).not.toContain("openSync('CON'");
    expect(source).toContain('readline?.close()');
    expect(source).toContain('closeProductionTty(handles)');
  });
});
