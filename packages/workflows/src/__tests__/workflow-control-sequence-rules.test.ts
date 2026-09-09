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
  let fixture: string;
  beforeAll(async () => {
    fixture = await mkdtemp(join(tmpdir(), 'openslack-sequence-bootstrap-'));
    const input = join(fixture, 'input');
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
  });
  afterAll(async () => {
    if (fixture) await rm(fixture, { recursive: true, force: true });
  });
  it.each(['missing', 'stale', 'invalid'] as const)(
    'isolates generator output with %s input',
    async (state) => {
      const input = join(fixture, 'input');
      const output = join(fixture, 'output-' + state);
      const source =
        'packages/workflows/contracts/workflow-runner-authority-binding/control-sequences.json';
      const projection = 'packages/workflows/src/internal/workflow-control-sequences.generated.ts';
      const goProjection =
        'services/workflow-control/runnerbindingcontract/control_sequences_generated.go';
      const api = 'services/workflow-control/docs/api/runner-openapi.yaml';
      const script = 'scripts/workflow-runner-authority-binding-contracts/index.ts';
      try {
        const originalAPI = await readFile(join(input, api));
        const expectedProjection = await readFile(join(root, projection));
        const run = () =>
          spawnSync('bun', [join(input, script), '--generate'], {
            cwd: input,
            encoding: 'utf8',
            env: {
              ...process.env,
              OPENSLACK_WORKFLOW_RUNNER_AUTHORITY_BINDING_OUTPUT_ROOT: output,
            },
          });
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
        const result = run();
        if (state === 'invalid') {
          expect(result.status).not.toBe(0);
          expect(await readFile(join(output, projection), 'utf8')).toBe('existing output');
          await expect(readFile(join(output, api))).rejects.toMatchObject({ code: 'ENOENT' });
        } else {
          expect(result.status, result.stderr).toBe(0);
          expect(await readFile(join(output, projection))).toEqual(expectedProjection);
          expect(await readFile(join(output, goProjection))).toEqual(
            await readFile(join(root, goProjection)),
          );
          if (state === 'missing')
            await expect(readFile(join(input, projection))).rejects.toMatchObject({
              code: 'ENOENT',
            });
          else
            expect(await readFile(join(input, projection), 'utf8')).toContain(
              'stale projection must not load',
            );
        }
        expect(await readFile(join(input, api))).toEqual(originalAPI);
      } finally {
        await writeFile(join(input, projection), await readFile(join(root, projection)));
        await writeFile(join(input, source), await readFile(join(root, source)));
      }
    },
  );

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
