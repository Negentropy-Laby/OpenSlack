import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { format } from 'prettier';

export const sequenceSource =
  'packages/workflows/contracts/workflow-runner-authority-binding/control-sequences.json';
export const sequenceTS = 'packages/workflows/src/internal/workflow-control-sequences.generated.ts';
export const sequenceGo =
  'services/workflow-control/runnerbindingcontract/control_sequences_generated.go';

export function validateControlSequences(value: unknown): Readonly<Record<string, 3 | 4>> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('Control sequence rules must be an object.');
  const expected = [
    'event_receipt',
    'budget_authorization',
    'effect_authorization',
    'resume_offer',
    'cancel_request',
  ];
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== expected.length ||
    expected.some((kind) => !Object.hasOwn(record, kind))
  )
    throw new TypeError('Control sequence rules must cover every control kind exactly.');
  if (Object.values(record).some((sequence) => sequence !== 3 && sequence !== 4))
    throw new TypeError('Control sequence rule is invalid.');
  return Object.freeze({ ...record }) as Readonly<Record<string, 3 | 4>>;
}

export function controlSequenceSchema(
  rules: Readonly<Record<string, 3 | 4>>,
  kind: unknown,
  sequence: unknown,
) {
  if (typeof kind !== 'string' || !Object.hasOwn(rules, kind) || rules[kind] !== sequence)
    throw new TypeError('Control sample kind and companion sequence disagree.');
  const kinds = Object.keys(rules).filter((candidate) => rules[candidate] === rules[kind]);
  return kinds.length === 1 ? { const: kinds[0] } : { enum: kinds };
}

export async function controlSequenceOutputs(root: string): Promise<Map<string, Buffer>> {
  const rules = validateControlSequences(
    JSON.parse(await readFile(resolve(root, sequenceSource), 'utf8')),
  );
  const ts = await format(
    '// Generated from control-sequences.json. Do not edit.\n' +
      'export const WORKFLOW_CONTROL_SEQUENCES = Object.freeze(' +
      JSON.stringify(rules) +
      ' as const);\n' +
      'export function workflowControlCompanionSequence(kind: keyof typeof WORKFLOW_CONTROL_SEQUENCES): 3 | 4 { return WORKFLOW_CONTROL_SEQUENCES[kind]; }\n',
    { parser: 'typescript', singleQuote: true, printWidth: 100, trailingComma: 'all' },
  );
  const go =
    '// Code generated from control-sequences.json. DO NOT EDIT.\npackage runnerbindingcontract\n\n' +
    'func controlCompanionSequence(kind string) int64 {\n\tswitch kind {\n' +
    Object.entries(rules)
      .map(([kind, sequence]) => '\tcase "' + kind + '":\n\t\treturn ' + sequence + '\n')
      .join('') +
    '\tdefault:\n\t\treturn 0\n\t}\n}\n';
  return new Map([
    [sequenceTS, Buffer.from(ts)],
    [sequenceGo, Buffer.from(go)],
  ]);
}
