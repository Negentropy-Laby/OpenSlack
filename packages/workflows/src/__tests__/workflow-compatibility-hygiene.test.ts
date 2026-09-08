import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { registerWorkflowRunnerAuthorityBindingSchemaFormats } from '../workflow-runner-authority-binding-schema.js';
import { isPortableWorkflowRunId, isWorkflowRunPathId } from '../internal/workflow-run-identity.js';
import { RunStore, type RunMeta } from '../run-store.js';
import { executeWorkflowThroughRunnerWithRuntime } from '../workflow-runner-execution-client.js';
import { createWorkflowRunStoreRecoveryAccess } from '../internal/workflow-run-store-recovery-access.js';
import { resumeIntentFixture } from './workflow-recovery-fixtures.js';
import {
  parseWorkflowResumeIntent,
  createWorkflowResumeIntent,
} from '../internal/workflow-resume-intent.js';
import { resumeCorrelationId } from '../internal/workflow-resume-correlation.js';
import { canonicalWorkflowControlAuthorityJson as canonical } from '../workflow-control-authority-contract.js';
import { applyBindingCorpus } from './helpers/binding-corpus.js';

describe('portable creation and legacy intent compatibility', () => {
  it.runIf(process.platform !== 'win32')(
    'retains real POSIX historical directories through resume transitions',
    async () => {
      class HistoricalProjection extends RunStore {
        restore(id: string, meta: RunMeta) {
          return this.initializeRunProjection(id, meta);
        }
      }
      const root = await mkdtemp(join(tmpdir(), 'openslack-posix-history-'));
      try {
        const store = new HistoricalProjection({
          baseDir: root,
          access: createWorkflowRunStoreRecoveryAccess(),
        });
        const runId = 'run:historical';
        await store.restore(runId, {
          runId,
          workflowName: 'fixture',
          mode: 'execute',
          startedAt: '2026-01-01T00:00:00.000Z',
          args: {},
          manifestHash: 'a'.repeat(64),
        } as RunMeta);
        expect((await store.loadMeta(runId))?.runId).toBe(runId);
        await store.transitionStatus(runId, 'paused');
        await store.transitionStatus(runId, 'resuming');
        expect((await store.loadStatus(runId))?.status).toBe('resuming');
        expect(store.runDir(runId)).toContain(runId);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
  it('rejects a nonportable new run before contacting the authority', async () => {
    let calls = 0;
    const authority = new Proxy(
      {},
      {
        get() {
          calls++;
          throw new Error('authority accessed');
        },
      },
    );
    await expect(
      executeWorkflowThroughRunnerWithRuntime({
        now: () => new Date('2026-01-01T00:00:00.000Z'),
        workflowRunId: 'run:legacy',
        confirmationPolicy: { runId: 'run:legacy' },
        config: { descriptorRoot: '/unused' },
        client: { descriptorRoot: '/unused' },
        routing: { journal: { locateReadOnly: async () => null }, authority },
      } as never),
    ).rejects.toMatchObject({ code: 'WORKFLOW_RUN_PROJECTION_ID_INVALID' });
    expect(calls).toBe(0);
  });
  it.each(['con', 'aux.txt', 'run:x', 'run.'])(
    'rejects new %s on every platform before writing',
    async (id) => {
      expect(isPortableWorkflowRunId(id)).toBe(false);
      expect(isWorkflowRunPathId(id, 'linux')).toBe(true);
      expect(isWorkflowRunPathId(id, 'win32')).toBe(false);
      const store = new RunStore({
        baseDir: '/unused',
        access: createWorkflowRunStoreRecoveryAccess(),
      });
      await expect(store.initRun(id, {} as never)).rejects.toMatchObject({
        code: 'WORKFLOW_RUN_PROJECTION_ID_INVALID',
      });
    },
  );
  it('reads full v2, historical compact v2 and v1 without losing operation identity', () => {
    const { intent, stage, target } = resumeIntentFixture();
    const compact: Omit<typeof intent, 'correlationId'> & { correlationId?: string } = {
      ...intent,
    };
    delete compact.correlationId;
    const legacy = Object.fromEntries(
      Object.entries(intent).filter(([key]) => !['prior', 'next', 'evidence'].includes(key)),
    ) as Omit<typeof intent, 'prior' | 'next' | 'evidence'>;
    const v1 = {
      ...legacy,
      schema: 'openslack.workflow_runner_resume_source_intent.v1',
      record: {
        ...legacy.record,
        currentPhaseId: legacy.expected.currentPhaseId,
        currentPhaseIndex: legacy.expected.currentPhaseIndex,
      },
    };
    const written = createWorkflowResumeIntent(compact);
    expect(written.correlationId).toBe(intent.correlationId);
    // The deployed reader requires exactly this v2 key set, including correlationId.
    expect(Object.keys(written).sort()).toEqual(Object.keys(intent).sort());
    for (const record of [written, intent, compact, v1]) {
      const parsed = parseWorkflowResumeIntent(canonical(record) + '\n', stage, target);
      expect(resumeCorrelationId(parsed.stageHash)).toBe(intent.correlationId);
    }
  });
});

describe('strict external schema use', () => {
  const schema = JSON.parse(
    readFileSync(
      new URL(
        '../../contracts/workflow-runner-authority-binding/v1/schemas/workflow-runner-authority-binding-error.v1.schema.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  it('requires explicit format registration and enforces UTF-8 byte boundaries', () => {
    expect(() => new Ajv2020({ strict: true }).compile(schema)).toThrow(/unknown format/);
    const ajv = registerWorkflowRunnerAuthorityBindingSchemaFormats(new Ajv2020({ strict: true }));
    const message = ajv.compile({ type: 'string', format: 'openslack-utf8-512' });
    expect(message('€'.repeat(170) + 'xx')).toBe(true);
    expect(message('€'.repeat(171))).toBe(false);
    const timestamp = ajv.compile({ type: 'string', format: 'date-time' });
    expect(timestamp('2026-01-01T00:00:00.000Z')).toBe(true);
    expect(timestamp('2026-02-30T00:00:00.000Z')).toBe(false);
    expect(() => ajv.compile(schema)).not.toThrow();
  });
  it.each(['/__proto__/x', '/constructor/x', 'target/x', '/target//x', '/target/', '/target/~1'])(
    'rejects invalid corpus path %s before mutation',
    (path) => {
      const value = { target: { x: 1 } };
      expect(() => applyBindingCorpus(value, { '/target/x': 2, [path]: 3 }, [])).toThrow();
      expect(value.target.x).toBe(1);
    },
  );
  it('projects enums by YAML structure and rejects undeclared consumers', async () => {
    const root = fileURLToPath(new URL('../../../../', import.meta.url));
    const { projectBudgetManifestEnums } = await import(
      /* @vite-ignore */ root + 'scripts/workflow-budget-authority-contracts/compatibility.ts'
    );
    const source = readFileSync(
      root + 'services/workflow-control/docs/api/budget-authority-openapi.yaml',
      'utf8',
    );
    const hashes = ['1'.repeat(64), '2'.repeat(64), '3'.repeat(64)];
    const projected = projectBudgetManifestEnums(source, hashes);
    expect(projectBudgetManifestEnums(projected, hashes)).toBe(projected);
    expect(() =>
      projectBudgetManifestEnums(
        source.replace('DurableRecordAccountBranch:', 'UnknownBranch:'),
        hashes,
      ),
    ).toThrow(/Missing/);
    expect(() =>
      projectBudgetManifestEnums(
        source + '\nx-unknown:\n  contractManifestSha256:\n    enum: [abc]\n',
        hashes,
      ),
    ).toThrow(/Undeclared/);
  });
});
