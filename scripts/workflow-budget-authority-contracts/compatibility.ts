import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { format } from 'prettier';

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
  const oldTS = await readFile(resolve(root, tsRelative), 'utf8').catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    },
  );
  const oldAccepted =
    /WORKFLOW_BUDGET_ACCEPTED_MANIFEST_SHA256 = Object\.freeze\(\s*(\[[\s\S]*?\])/u.exec(
      oldTS,
    )?.[1];
  if (oldTS !== '' && !oldAccepted)
    throw new Error('Existing budget compatibility projection has no readable acceptance set.');
  const previous = oldAccepted
    ? (JSON.parse(oldAccepted.replace(/'/g, '"').replace(/,\s*]/g, ']')) as string[])
    : [];
  const ledger = validateBudgetManifestCompatibility(
    JSON.parse(await readFile(ledgerPath, 'utf8')),
    previous,
  );
  if (ledger.current !== currentManifest)
    throw new Error(
      'Budget manifest changed; explicitly append its reviewed digest to compatibility.json before generating.',
    );
  const ts = await format(
    `// Generated from workflow-budget-authority/compatibility.json. Do not edit.\nexport const WORKFLOW_BUDGET_CURRENT_MANIFEST_SHA256 = ${JSON.stringify(ledger.current)} as const;\n// Original pre-source-lock manifest retained for historical fixtures and callers.\nexport const WORKFLOW_BUDGET_PREVIOUS_MANIFEST_SHA256 = ${JSON.stringify(ledger.accepted[0])} as const;\nexport const WORKFLOW_BUDGET_ACCEPTED_MANIFEST_SHA256 = Object.freeze(${JSON.stringify(ledger.accepted)} as const);\nexport function isAcceptedWorkflowBudgetManifest(value: unknown): value is string { return typeof value === 'string' && (WORKFLOW_BUDGET_ACCEPTED_MANIFEST_SHA256 as readonly string[]).includes(value); }\n`,
    { parser: 'typescript', singleQuote: true, printWidth: 96 },
  );
  const go = `// Code generated from workflow-budget-authority/compatibility.json; DO NOT EDIT.\npackage budgetcontract\n\nconst CurrentManifestSHA256 = ${JSON.stringify(ledger.current)}\nconst PreviousManifestSHA256 = ${JSON.stringify(ledger.accepted[0])}\n\nfunc AcceptedManifestSHA256() []string {\n\treturn []string{${ledger.accepted.map((hash) => JSON.stringify(hash)).join(', ')}}\n}\n\nfunc AcceptsManifestSHA256(value string) bool {\n\tswitch value {\n\tcase ${ledger.accepted.map((hash) => JSON.stringify(hash)).join(', ')}:\n\t\treturn true\n\tdefault:\n\t\treturn false\n\t}\n}\n`;
  const openAPI = await readFile(resolve(root, apiRelative), 'utf8');
  const enumPattern = /contractManifestSha256:\s*\{\s*enum:\s*\[[^\]]*\]\s*\}/gu;
  if ([...openAPI.matchAll(enumPattern)].length !== 7)
    throw new Error('Budget durable OpenAPI manifest inventory changed.');
  const projected = openAPI.replace(
    enumPattern,
    `contractManifestSha256:\n            { enum: [${[...ledger.accepted].reverse().join(', ')}] }`,
  );
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
