import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

import { checkPlugin } from '../checker.js';
import { PLUGIN_CHECK_IDS } from '../checks.js';

interface PluginEvalScenario {
  readonly fixture: string;
  readonly readiness: 'READY_TO_REGISTER' | 'BLOCKED';
  readonly finding_codes: readonly string[];
}

interface PluginEvalContract {
  readonly schema: string;
  readonly id: string;
  readonly checks: readonly string[];
  readonly scenarios: readonly PluginEvalScenario[];
}

describe('EV-PLUGIN-001', () => {
  it('executes the versioned scenario contract against the production checker', async () => {
    const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
    const fixtures = path.join(repositoryRoot, 'packages', 'plugin-testkit', 'src', '__fixtures__');
    const evalPath = path.join(
      repositoryRoot,
      '.openslack',
      'self',
      'eval_suites',
      'plugin',
      'EV-PLUGIN-001.yaml',
    );
    const contract = parseYaml(await readFile(evalPath, 'utf8')) as PluginEvalContract;

    expect(contract.schema).toBe('openslack.plugin_eval.v1');
    expect(contract.id).toBe('EV-PLUGIN-001');
    expect(contract.checks).toEqual(PLUGIN_CHECK_IDS);
    for (const scenario of contract.scenarios) {
      const report = await checkPlugin(path.join(fixtures, scenario.fixture), {
        workspaceRoot: repositoryRoot,
        openslackVersion: '0.1.1',
      });
      expect(report.readiness, scenario.fixture).toBe(scenario.readiness);
      expect(
        report.findings.map((finding) => finding.code),
        scenario.fixture,
      ).toEqual(expect.arrayContaining([...scenario.finding_codes]));
      expect(report.authorizationNotice).toBe('HOST_REAUTHORIZATION_REQUIRED');
    }
  });
});
