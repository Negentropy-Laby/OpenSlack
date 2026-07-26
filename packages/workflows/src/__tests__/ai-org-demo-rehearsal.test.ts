import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const repositoryRoot = resolve(process.cwd());
const scriptPath = join(repositoryRoot, 'scripts', 'demo-ai-org-rehearse.ts');
const temporaryRoots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'openslack-ai-org-fixture-test-'));
  temporaryRoots.push(root);
  return root;
}

async function loadRehearsalModule(): Promise<{
  parseRehearsalArgs(
    args: string[],
    cwd?: string,
  ): { mode: 'fixture' | 'live'; outDir: string; repo?: string; execute: boolean };
  runFixtureRehearsal(
    options: {
      mode: 'fixture' | 'live';
      outDir: string;
      repo?: string;
      execute: boolean;
    },
    recordedRunRoot?: string,
  ): {
    status: string;
    mode: string;
    evidenceLevel: string;
  };
  assertWorkflowResult(value: unknown): void;
  assertLiveRepositoryTarget(
    origin: { owner: string; repo: string } | null,
    explicit: { owner: string; repo: string } | null,
  ): void;
  resolveAndAssertOriginPushTarget(options: {
    explicitRepo: string;
    runGit(args: string[]): string;
    parseRepository(spec: string): { owner: string; repo: string } | null;
  }): { owner: string; repo: string };
  assertLiveMainSynchronized(localMain: string, remoteMain: string): void;
  assertDeliveryHeadSynchronized(
    branchSha: string | undefined,
    prHeadSha: string | undefined,
    expectedHead?: string,
  ): { branchSha: string; prHeadSha: string };
}> {
  return import(/* @vite-ignore */ pathToFileURL(scriptPath).href) as never;
}

function fileDigest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('AI organization rehearsal script', () => {
  it('renders a deterministic fixture without subprocess or network availability', async () => {
    const root = temporaryRoot();
    const first = join(root, 'first');
    const second = join(root, 'second');
    const rehearsal = await loadRehearsalModule();

    for (const out of [first, second]) {
      const result = rehearsal.runFixtureRehearsal({
        mode: 'fixture',
        outDir: out,
        execute: false,
      });
      expect(result).toMatchObject({
        status: 'completed',
        mode: 'fixture',
        evidenceLevel: 'LOCAL_PASS',
      });
    }

    const expectedFiles = [
      'manifest.json',
      'projection.json',
      'rehearsal-result.json',
      'artifacts',
    ];
    expect(readdirSync(first).sort()).toEqual(expectedFiles.sort());
    expect(readdirSync(join(first, 'artifacts')).sort()).toEqual(
      [
        'executive-summary.md',
        'opportunity-matrix.md',
        'data-system-map.md',
        'roi-model.md',
        'target-architecture.md',
        'risk-register.md',
        '90-day-plan.md',
      ].sort(),
    );
    for (const filename of ['manifest.json', 'projection.json']) {
      expect(fileDigest(join(first, filename))).toBe(fileDigest(join(second, filename)));
    }
    for (const filename of readdirSync(join(first, 'artifacts'))) {
      expect(fileDigest(join(first, 'artifacts', filename))).toBe(
        fileDigest(join(second, 'artifacts', filename)),
      );
    }
  });

  it('validates every recorded fixture source before creating output or claiming LOCAL_PASS', async () => {
    const rehearsal = await loadRehearsalModule();
    const sourceRoot = join(repositoryRoot, 'examples', 'ai-organization-demo', 'recorded-run');
    const corruptions: Array<{
      name: string;
      apply(root: string): void;
      error: RegExp;
    }> = [
      {
        name: 'GitHub token in artifact',
        apply(root) {
          writeFileSync(
            join(root, 'artifacts', 'executive-summary.md'),
            '# Unsafe\n\nghp_abcdefghijklmnopqrstuvwxyz1234567890\n',
            'utf8',
          );
        },
        error: /credential-like/,
      },
      {
        name: 'private key in artifact',
        apply(root) {
          writeFileSync(
            join(root, 'artifacts', 'risk-register.md'),
            '-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n',
            'utf8',
          );
        },
        error: /credential-like/,
      },
      {
        name: 'Slack token in artifact',
        apply(root) {
          writeFileSync(
            join(root, 'artifacts', 'target-architecture.md'),
            '# Unsafe\n\nxoxb-123456789012-abcdefghijklmnop\n',
            'utf8',
          );
        },
        error: /credential-like/,
      },
      {
        name: 'client secret field in manifest',
        apply(root) {
          const path = join(root, 'manifest.json');
          const manifest = JSON.parse(readFileSync(path, 'utf8'));
          manifest.client_secret = 'not-a-real-secret';
          writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
        },
        error: /credential/,
      },
      {
        name: 'extra artifact',
        apply(root) {
          writeFileSync(join(root, 'artifacts', 'extra.md'), '# Extra\n', 'utf8');
        },
        error: /exactly the canonical seven files/,
      },
      {
        name: 'out-of-range projection',
        apply(root) {
          const path = join(root, 'projection.json');
          const projection = JSON.parse(readFileSync(path, 'utf8'));
          projection.outcomes.cycleHours.target = -1;
          writeFileSync(path, `${JSON.stringify(projection, null, 2)}\n`, 'utf8');
        },
        error: /closed schema/,
      },
    ];

    for (const corruption of corruptions) {
      const root = temporaryRoot();
      const recordedRoot = join(root, 'recorded-run');
      const outDir = join(root, 'output');
      cpSync(sourceRoot, recordedRoot, { recursive: true });
      corruption.apply(recordedRoot);

      expect(
        () =>
          rehearsal.runFixtureRehearsal({ mode: 'fixture', outDir, execute: false }, recordedRoot),
        corruption.name,
      ).toThrow(corruption.error);
      expect(existsSync(outDir), `${corruption.name} must not create output`).toBe(false);
    }
  });

  it('fails closed before live work unless repo and execute are both explicit', async () => {
    const root = temporaryRoot();
    const rehearsal = await loadRehearsalModule();
    expect(() =>
      rehearsal.parseRehearsalArgs(
        ['--mode', 'live', '--repo', 'acme/rehearsal', '--out', join(root, 'out')],
        repositoryRoot,
      ),
    ).toThrow('explicit --execute flag');
    expect(readdirSync(root)).toEqual([]);
  });

  it('runs repository, main, and PR head guards before their injected write continuations', async () => {
    const rehearsal = await loadRehearsalModule();
    const expected = 'a'.repeat(40);
    const stale = 'b'.repeat(40);
    const cases = [
      () =>
        rehearsal.assertLiveRepositoryTarget(
          { owner: 'acme', repo: 'origin' },
          { owner: 'acme', repo: 'other' },
        ),
      () => rehearsal.assertLiveMainSynchronized(stale, expected),
      () => rehearsal.assertDeliveryHeadSynchronized(expected, stale, expected),
    ];

    for (const guard of cases) {
      const write = vi.fn();
      expect(() => {
        guard();
        write();
      }).toThrow();
      expect(write).not.toHaveBeenCalled();
    }
  });

  it('uses the single normalized origin push target and blocks pushurl ambiguity before delivery', async () => {
    const rehearsal = await loadRehearsalModule();
    const { parseGitHubRepoSpec } = await import('@openslack/github');
    const expectedArgs = ['remote', 'get-url', '--push', '--all', 'origin'];
    const failures = [
      'git@github.com:acme/other.git',
      'git@github.com:acme/openslack.git\nhttps://github.com/acme/openslack.git',
      '',
    ];

    for (const output of failures) {
      const runGit = vi.fn(() => output);
      const delivery = vi.fn();
      expect(() => {
        rehearsal.resolveAndAssertOriginPushTarget({
          explicitRepo: 'acme/openslack',
          runGit,
          parseRepository: parseGitHubRepoSpec,
        });
        delivery();
      }).toThrow();
      expect(runGit).toHaveBeenCalledWith(expectedArgs);
      expect(delivery).not.toHaveBeenCalled();
    }

    const runGit = vi.fn(() => 'git@github.com:ACME/OpenSlack.git');
    const target = rehearsal.resolveAndAssertOriginPushTarget({
      explicitRepo: 'acme/openslack',
      runGit,
      parseRepository: parseGitHubRepoSpec,
    });
    expect(target).toEqual({ owner: 'ACME', repo: 'OpenSlack' });
    expect(runGit).toHaveBeenCalledWith(expectedArgs);
  });

  it('exercises preview and dry-run through the real CLI with fail-closed exit codes', () => {
    const runCli = (args: string[]) =>
      spawnSync(
        process.execPath,
        ['--import', 'tsx', 'apps/cli/src/index.ts', 'collaboration', 'workflow', ...args],
        {
          cwd: repositoryRoot,
          encoding: 'utf8',
          timeout: 60_000,
          env: { ...process.env, OPENSLACK_DISABLE_WORKFLOWS: '0' },
        },
      );

    const preview = runCli(['preview-js', 'ai-org-transformation']);
    expect(preview.status, String(preview.error ?? preview.stderr)).toBe(0);
    expect(preview.stdout).toContain('"schema": "openslack.ai_org_demo_preview.v1"');
    expect(preview.stdout).toContain('"agentCalls": 0');

    const dryRun = runCli(['dry-run', 'ai-org-transformation']);
    expect(dryRun.status, dryRun.stderr).toBe(0);
    expect(dryRun.stdout).toContain('"schema": "openslack.ai_org_demo_workflow_result.v1"');
    expect(dryRun.stdout).not.toContain('Errors:');

    const rejected = runCli(['dry-run', 'ai-org-transformation', '--input', 'durationDays=91']);
    expect(rejected.status).toBe(1);
    expect(rejected.stdout).toContain('Errors:');
    expect(rejected.stdout).toContain('durationDays must be an integer from 1 through 90');
  }, 15_000);

  it('blocks sensitive, oversized, and additional workflow result data before materialization', async () => {
    const workflowPath = resolve(
      repositoryRoot,
      '.openslack',
      'workflows',
      'ai-org-transformation.ts',
    );
    const workflow = await import(/* @vite-ignore */ pathToFileURL(workflowPath).href);
    const fixtureRoot = join(
      repositoryRoot,
      'examples',
      'ai-organization-demo',
      'fixtures',
      'agent-results',
    );
    const { createRuntime } = await import('@openslack/workflows');
    const runtime = createRuntime({
      runId: 'materialization-contract',
      mode: 'execute',
      manifest: workflow.meta,
      budget: { tokens: 64_000, costUsd: 1 },
      agentLauncher: async (_prompt, options) => ({
        data: JSON.parse(
          readFileSync(join(fixtureRoot, `${String(options.agentType)}.json`), 'utf8'),
        ),
        tokenUsage: 10,
      }),
      onConfirm: async () => false,
    });
    const base = { ...(await workflow.run(runtime, {})), runId: 'materialization-contract' };
    const rehearsal = await loadRehearsalModule();

    expect(() => rehearsal.assertWorkflowResult(base)).not.toThrow();
    expect(() =>
      rehearsal.assertWorkflowResult({
        ...structuredClone(base),
        unexpected: true,
      }),
    ).toThrow('closed workflow result schema');
    expect(() =>
      rehearsal.assertWorkflowResult({
        ...structuredClone(base),
        client_secret: 'not-a-real-secret',
      }),
    ).toThrow('credential field');
    for (const sensitiveValue of [
      'Authorization: Bearer abcdefghijklmnop',
      'ghp_abcdefghijklmnopqrstuvwxyz1234567890',
      'github_pat_abcdefghijklmnopqrstuvwxyz1234567890',
      'xoxp-123456789012-abcdefghijklmnop',
      '-----BEGIN RSA PRIVATE KEY-----\nnot-a-real-key',
      'password=not-a-real-password',
      'client_secret: not-a-real-secret',
    ]) {
      const sensitive = structuredClone(base) as {
        artifacts: Array<{ content: string }>;
      };
      sensitive.artifacts[0].content = sensitiveValue;
      expect(() => rehearsal.assertWorkflowResult(sensitive)).toThrow('credential-like');
    }
    const oversized = structuredClone(base) as {
      artifacts: Array<{ content: string }>;
    };
    oversized.artifacts[0].content = 'x'.repeat(8_001);
    expect(() => rehearsal.assertWorkflowResult(oversized)).toThrow('oversized string');
  }, 15_000);

  it('keeps raw GitHub PR creation and credential material out of the script', () => {
    const source = readFileSync(scriptPath, 'utf8');
    expect(source).not.toContain('gh pr create');
    expect(source).not.toMatch(/readFileSync\([^)]*(?:\\.pem|\\.key|\\.env)/);
    expect(source).toContain('bot-gh-pr-create');
    expect(source).toContain("auth: 'app'");
    expect(source).toContain("branch === 'main'");
    expect(source).toContain("ref: 'heads/main'");
    expect(source).toContain("'LOCAL_MAIN_STALE'");
  });

  it('validates the fixed input, sanitized recorded run, and read-only projection', () => {
    const schemaRoot = join(repositoryRoot, 'examples', 'ai-organization-demo', 'schemas');
    const exampleRoot = join(repositoryRoot, 'examples', 'ai-organization-demo');
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    const inputSchema = JSON.parse(readFileSync(join(schemaRoot, 'input.schema.json'), 'utf8'));
    const recordedSchema = JSON.parse(
      readFileSync(join(schemaRoot, 'recorded-run.schema.json'), 'utf8'),
    );
    const projectionSchema = JSON.parse(
      readFileSync(join(schemaRoot, 'projection.schema.json'), 'utf8'),
    );
    const input = JSON.parse(
      readFileSync(join(exampleRoot, 'input', 'manufacturing-90-day.json'), 'utf8'),
    );
    const recorded = JSON.parse(
      readFileSync(join(exampleRoot, 'recorded-run', 'manifest.json'), 'utf8'),
    );
    const projection = JSON.parse(
      readFileSync(join(exampleRoot, 'recorded-run', 'projection.json'), 'utf8'),
    );
    const assumptions = readFileSync(
      join(exampleRoot, 'input', 'outcome-assumptions.yaml'),
      'utf8',
    );

    const validateInput = ajv.compile(inputSchema);
    const validateRecorded = ajv.compile(recordedSchema);
    const validateProjection = ajv.compile(projectionSchema);
    expect(validateInput(input)).toBe(true);
    expect(validateRecorded(recorded)).toBe(true);
    expect(validateProjection(projection)).toBe(true);
    expect(assumptions).toContain("version: '2026-07-26.2'");
    expect(assumptions).toContain('annualValueCny:');
    expect(assumptions).toContain('value: 3840000');
    expect(assumptions).toContain('simpleAnnualRoiRate:');
    expect(assumptions).toContain('value: 6.68');
    expect(projection.outcomes.annualValueCny.value).toBe(3_840_000);
    expect(projection.evidenceRefs).toContain(
      'assumption:input/outcome-assumptions.yaml@2026-07-26.2#annualValueCny',
    );
    expect(projection.evidenceRefs).toContain(
      'assumption:input/outcome-assumptions.yaml@2026-07-26.2#simpleAnnualRoiRate',
    );

    const invalidInput = structuredClone(input);
    invalidInput.successCriteria[0].target = -1;
    expect(validateInput(invalidInput)).toBe(false);
    const fractionalBudgetInput = structuredClone(input);
    fractionalBudgetInput.budgetCny = 500000.5;
    expect(validateInput(fractionalBudgetInput)).toBe(false);

    for (const invalidAnnualValue of [-1, 3.5, 1_000_000_001]) {
      const invalidProjection = structuredClone(projection);
      invalidProjection.outcomes.annualValueCny.value = invalidAnnualValue;
      expect(validateProjection(invalidProjection)).toBe(false);
    }

    for (const invalidId of [0, 1.5, 2_147_483_648]) {
      const invalidRecorded = structuredClone(recorded);
      invalidRecorded.github.parentIssue = invalidId;
      expect(validateRecorded(invalidRecorded)).toBe(false);
    }
  });
});
