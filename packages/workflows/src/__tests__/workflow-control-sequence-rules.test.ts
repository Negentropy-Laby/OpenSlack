import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
  WORKFLOW_CONTROL_SEQUENCES,
  workflowControlCompanionSequence,
} from '../internal/workflow-control-sequences.generated.js';
import { prepareWorkflowControlAuthorityMessage } from '../workflow-control-authority-contract.js';
import {
  validateWorkflowRunnerAuthorityBindingReceipt,
  validateWorkflowRunnerAuthorityControlDeliveryReceiptForMessage,
} from '../workflow-runner-authority-binding-contract.js';

const expected = {
  event_receipt: 3,
  budget_authorization: 4,
  effect_authorization: 4,
  resume_offer: 4,
  cancel_request: 4,
} as const;

describe('control companion sequence rules', () => {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const states = ['missing', 'stale', 'invalid'] as const;
  const source =
    'packages/workflows/contracts/workflow-runner-authority-binding/control-sequences.json';
  const projection = 'packages/workflows/src/internal/workflow-control-sequences.generated.ts';
  const goProjection =
    'services/workflow-control/runnerbindingcontract/control_sequences_generated.go';
  const api = 'services/workflow-control/docs/api/runner-openapi.yaml';
  let fixture: string;
  const prepared = new Map<
    (typeof states)[number],
    {
      input: string;
      output: string;
      originalAPI: Buffer;
      result: ReturnType<typeof spawnSync>;
    }
  >();
  // Compilation is preparation, independently bounded from the five-second
  // assertions. Each case owns its input; a timed-out case cannot restore files
  // over another case's deliberately invalid source.
  beforeAll(async () => {
    fixture = await mkdtemp(join(tmpdir(), 'openslack-sequence-bootstrap-'));
    for (const state of states) {
      const input = join(fixture, 'input-' + state);
      const output = join(fixture, 'output-' + state);
      for (const path of [
        'scripts/workflow-runner-authority-binding-contracts',
        'packages/workflows/src',
        'packages/workflows/contracts',
        'packages/workflows/package.json',
        'services/workflow-control/migrations',
        'services/workflow-control/docs/api/runner-openapi.yaml',
      ]) {
        await mkdir(dirname(join(input, path)), { recursive: true });
        await cp(join(root, path), join(input, path), {
          recursive: true,
          filter: (entry) => !/[\\/]__tests__(?:[\\/]|$)/.test(entry),
        });
      }
      await symlink(
        resolve(root, 'node_modules'),
        join(input, 'node_modules'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      const originalAPI = await readFile(join(input, api));
      if (state === 'missing') await rm(join(input, projection));
      if (state === 'stale')
        await writeFile(
          join(input, projection),
          'throw new Error("stale projection must not load");',
        );
      if (state === 'invalid') {
        await writeFile(join(input, source), JSON.stringify({ event_receipt: 5 }));
        await mkdir(dirname(join(output, projection)), { recursive: true });
        await writeFile(join(output, projection), 'existing output');
      }
      const result = spawnSync(
        'bun',
        [join(input, 'scripts/workflow-runner-authority-binding-contracts/index.ts'), '--generate'],
        {
          cwd: input,
          encoding: 'utf8',
          env: { ...process.env, OPENSLACK_WORKFLOW_RUNNER_AUTHORITY_BINDING_OUTPUT_ROOT: output },
        },
      );
      prepared.set(state, { input, output, originalAPI, result });
    }
  }, 30_000);
  afterAll(async () => {
    if (fixture) await rm(fixture, { recursive: true, force: true });
  });
  it.each(states)('isolates generator output with %s input', async (state) => {
    const { input, output, originalAPI, result } = prepared.get(state)!;
    const expectedProjection = await readFile(join(root, projection));
    if (state === 'invalid') {
      expect(result.status).not.toBe(0);
      expect(await readFile(join(output, projection), 'utf8')).toBe('existing output');
      await expect(readFile(join(output, api))).rejects.toMatchObject({ code: 'ENOENT' });
    } else {
      expect(result.status, result.stderr?.toString()).toBe(0);
      expect(await readFile(join(output, projection))).toEqual(expectedProjection);
      expect(await readFile(join(output, goProjection))).toEqual(
        await readFile(join(root, goProjection)),
      );
      if (state === 'missing')
        await expect(readFile(join(input, projection))).rejects.toMatchObject({ code: 'ENOENT' });
      else
        expect(await readFile(join(input, projection), 'utf8')).toContain(
          'stale projection must not load',
        );
    }
    expect(await readFile(join(input, api))).toEqual(originalAPI);
  });

  it('projects the reviewed rule matrix and rejects inconsistent generator samples', async () => {
    const script = fileURLToPath(
      new URL(
        '../../../../scripts/workflow-runner-authority-binding-contracts/control-sequences.ts',
        import.meta.url,
      ),
    );
    const { controlSequenceSchema, validateControlSequences } = await import(
      /* @vite-ignore */ script
    );
    const source = JSON.parse(
      await readFile(
        new URL(
          '../../contracts/workflow-runner-authority-binding/control-sequences.json',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    expect(validateControlSequences(source)).toEqual(expected);
    expect(WORKFLOW_CONTROL_SEQUENCES).toEqual(expected);
    for (const [kind, sequence] of Object.entries(expected)) {
      expect(workflowControlCompanionSequence(kind as keyof typeof expected)).toBe(sequence);
      expect(controlSequenceSchema(source, kind, sequence)).toEqual(
        sequence === 3
          ? { const: 'event_receipt' }
          : {
              enum: [
                'budget_authorization',
                'effect_authorization',
                'resume_offer',
                'cancel_request',
              ],
            },
      );
      for (const bad of [2, 5, 3.5, undefined, sequence === 3 ? 4 : 3])
        expect(() => controlSequenceSchema(source, kind, bad)).toThrow('disagree');
    }
    expect(() => controlSequenceSchema(source, 'unknown', 4)).toThrow('disagree');
    for (const bad of [null, {}, { ...source, alien: 4 }, { ...source, event_receipt: 5 }])
      expect(() => validateControlSequences(bad)).toThrow();
  });

  it('preserves a deep revision-ordering rejection after valid standalone decoding', async () => {
    const golden = JSON.parse(
      await readFile(
        new URL(
          '../../contracts/workflow-runner-authority-binding/v1/golden-vectors.json',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    const vector = golden.negative.find(
      (item: { id: string }) => item.id === 'control-decision-ordering-drift',
    );
    const { receipt, message, ...context } = vector.input;
    expect(receipt.companionSequence).toBe(4);
    expect(context.stage.runnerAuthority.expectedGlobalRunRevision).toBe(30);
    expect(context.stage.runnerAuthority.acceptedGlobalRunRevision).toBe(31);
    expect(message.runRevision).toBe(30);
    expect(prepareWorkflowControlAuthorityMessage(message).messageDigest).toBe(
      receipt.messageDigest,
    );
    expect(() => validateWorkflowRunnerAuthorityBindingReceipt(receipt)).not.toThrow();
    expect(() =>
      validateWorkflowRunnerAuthorityControlDeliveryReceiptForMessage(receipt, message, context),
    ).toThrow(
      expect.objectContaining({
        code: 'WORKFLOW_RUNNER_AUTHORITY_BINDING_IDENTITY_MISMATCH',
        path: '$',
      }),
    );
    const repaired = { ...message, runRevision: 31 };
    const repairedReceipt = {
      ...receipt,
      messageDigest: prepareWorkflowControlAuthorityMessage(repaired).messageDigest,
    };
    expect(() =>
      validateWorkflowRunnerAuthorityControlDeliveryReceiptForMessage(
        repairedReceipt,
        repaired,
        context,
      ),
    ).not.toThrow();
  });
});
