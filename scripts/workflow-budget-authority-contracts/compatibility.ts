import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { format } from 'prettier';
import { parseDocument, isMap, isScalar, visit } from 'yaml';

export interface BudgetManifestCompatibility {
  readonly schema: 'openslack.workflow_budget_manifest_compatibility.v1';
  readonly current: string;
  /** Append-only, oldest first. Rotation never retires an accepted durable record. */
  readonly accepted: readonly string[];
}

export function validateBudgetManifestCompatibility(
  value: unknown,
  previouslyAccepted: readonly string[] = [],
): BudgetManifestCompatibility {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Budget compatibility ledger must be an object.');
  const record = value as Record<string, unknown>;
  const accepted = record.accepted;
  if (
    Object.keys(record).sort().join(',') !== 'accepted,current,schema' ||
    record.schema !== 'openslack.workflow_budget_manifest_compatibility.v1' ||
    !Array.isArray(accepted) ||
    accepted.length < 2 ||
    accepted.some((hash) => typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) ||
    new Set(accepted).size !== accepted.length ||
    record.current !== accepted.at(-1) ||
    previouslyAccepted.some((hash, index) => accepted[index] !== hash)
  ) {
    throw new Error(
      'Budget compatibility ledger is invalid or removed/reordered an accepted manifest.',
    );
  }
  return record as unknown as BudgetManifestCompatibility;
}

export function rotateBudgetManifestCompatibility(
  previous: BudgetManifestCompatibility,
  current: string,
): BudgetManifestCompatibility {
  const validated = validateBudgetManifestCompatibility(previous);
  if (current === validated.current) return validated;
  return validateBudgetManifestCompatibility(
    { ...validated, current, accepted: [...validated.accepted, current] },
    validated.accepted,
  );
}

export async function synchronizeBudgetCompatibility(
  root: string,
  currentManifest: string,
  check: boolean,
  outputRoot = root,
): Promise<void> {
  const ledgerPath = resolve(
    root,
    'packages/workflows/contracts/workflow-budget-authority/compatibility.json',
  );
  const tsRelative = 'packages/workflows/src/internal/workflow-budget-compatibility.generated.ts';
  const apiRelative = 'services/workflow-control/docs/api/budget-authority-openapi.yaml';
  const tsPath = resolve(outputRoot, tsRelative);
  const goPath = resolve(
    outputRoot,
    'services/workflow-control/budgetcontract/compatibility_generated.go',
  );
  const openAPIPath = resolve(outputRoot, apiRelative);
  const historyRelative =
    'packages/workflows/contracts/workflow-budget-authority/compatibility-history.json';
  const historyText = await readFile(resolve(root, historyRelative), 'utf8');
  const history = validateBudgetManifestCompatibility(JSON.parse(historyText));
  const ledgerText = await readFile(ledgerPath, 'utf8');
  const ledger = validateBudgetManifestCompatibility(JSON.parse(ledgerText), history.accepted);
  if (JSON.stringify(ledger) !== JSON.stringify(history))
    throw new Error(
      'Explicitly append the reviewed digest to both the ledger and its historical safety baseline.',
    );
  if (resolve(outputRoot) !== resolve(root)) {
    for (const [relative, expected] of [
      [historyRelative, historyText],
      ['packages/workflows/contracts/workflow-budget-authority/compatibility.json', ledgerText],
    ]) {
      const existing = await readFile(resolve(outputRoot, relative), 'utf8').catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return undefined;
          throw error;
        },
      );
      if (
        existing !== undefined &&
        JSON.stringify(JSON.parse(existing)) !== JSON.stringify(JSON.parse(expected))
      )
        throw new Error('Output tree contains conflicting budget compatibility input.');
    }
  }
  if (ledger.current !== currentManifest)
    throw new Error(
      'Budget manifest changed; explicitly append its reviewed digest to compatibility.json before generating.',
    );
  const ts = await format(
    `// Generated from workflow-budget-authority/compatibility.json. Do not edit.\nexport const WORKFLOW_BUDGET_CURRENT_MANIFEST_SHA256 = ${JSON.stringify(ledger.current)} as const;\n// Original pre-source-lock manifest retained for historical fixtures and callers.\nexport const WORKFLOW_BUDGET_ORIGINAL_MANIFEST_SHA256 = ${JSON.stringify(ledger.accepted[0])} as const;\nexport const WORKFLOW_BUDGET_PREVIOUS_MANIFEST_SHA256 = ${JSON.stringify(ledger.accepted.at(-2))} as const;\nexport const WORKFLOW_BUDGET_ACCEPTED_MANIFEST_SHA256 = Object.freeze(${JSON.stringify(ledger.accepted)} as const);\nexport function isAcceptedWorkflowBudgetManifest(value: unknown): value is string { return typeof value === 'string' && (WORKFLOW_BUDGET_ACCEPTED_MANIFEST_SHA256 as readonly string[]).includes(value); }\n`,
    { parser: 'typescript', singleQuote: true, printWidth: 96 },
  );
  const go = `// Code generated from workflow-budget-authority/compatibility.json; DO NOT EDIT.\npackage budgetcontract\n\nconst CurrentManifestSHA256 = ${JSON.stringify(ledger.current)}\nconst OriginalManifestSHA256 = ${JSON.stringify(ledger.accepted[0])}\nconst PreviousManifestSHA256 = ${JSON.stringify(ledger.accepted.at(-2))}\n\nfunc AcceptedManifestSHA256() []string {\n\treturn []string{${ledger.accepted.map((hash) => JSON.stringify(hash)).join(', ')}}\n}\n\nfunc AcceptsManifestSHA256(value string) bool {\n\tswitch value {\n\tcase ${ledger.accepted.map((hash) => JSON.stringify(hash)).join(', ')}:\n\t\treturn true\n\tdefault:\n\t\treturn false\n\t}\n}\n`;
  const openAPI = await readFile(resolve(root, apiRelative), 'utf8');
  const projected = projectBudgetManifestEnums(openAPI, ledger.accepted);
  for (const [path, expected] of [
    [tsPath, ts],
    [goPath, go],
    [openAPIPath, projected],
  ] as const) {
    if (check) {
      if ((await readFile(path, 'utf8')) !== expected)
        throw new Error(`Budget compatibility projection is stale: ${path}`);
    } else {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, expected, 'utf8');
    }
  }
}

export const BUDGET_MANIFEST_ENUM_SCHEMAS = Object.freeze([
  'DurableRecordAccountBranch',
  'DurableRecordReserveDecisionBranch',
  'DurableRecordReservationBranch',
  'DurableRecordSettlementBranch',
  'DurableRecordLedgerEntryBranch',
  'DurableRecordReceiptBranch',
  'DurableRecordReconciliationBranch',
]);

/** Project declared YAML nodes; reject undeclared consumers before producing output. */
export function projectBudgetManifestEnums(source: string, accepted: readonly string[]): string {
  const document = parseDocument(source);
  if (document.errors.length) throw new Error('Budget OpenAPI YAML is invalid.');
  const expected = new Set<unknown>();
  for (const name of BUDGET_MANIFEST_ENUM_SCHEMAS) {
    const path = ['components', 'schemas', name, 'properties', 'contractManifestSha256'];
    const node = document.getIn(path, true);
    if (!isMap(node) || !node.has('enum'))
      throw new Error(`Missing budget manifest enum: ${name}.`);
    expected.add(node);
  }
  visit(document, {
    Pair(_, pair) {
      if (
        isScalar(pair.key) &&
        pair.key.value === 'contractManifestSha256' &&
        isMap(pair.value) &&
        pair.value.has('enum') &&
        !expected.has(pair.value)
      )
        throw new Error('Undeclared budget manifest enum projection.');
    },
  });
  for (const name of BUDGET_MANIFEST_ENUM_SCHEMAS)
    document.setIn(
      ['components', 'schemas', name, 'properties', 'contractManifestSha256', 'enum'],
      [...accepted].reverse(),
    );
  return document.toString({ lineWidth: 96 });
}
