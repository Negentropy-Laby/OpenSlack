import { readFileSync } from 'node:fs';

export interface ManifestFixtureCase {
  readonly name: string;
  readonly valid: boolean;
  readonly value: unknown;
}

const FIXTURES = [
  ['valid/action-alias.json', true],
  ['valid/workflow-alias.json', true],
  ['valid/mixed-aliases.json', true],
  ['valid/unicode-boundary.json', true],
  ['invalid/provider-kind.json', false],
  ['invalid/executable-entry.json', false],
  ['invalid/approval-capability.json', false],
  ['invalid/direct-merge.json', false],
  ['invalid/raw-command-mapping.json', false],
  ['invalid/object-constant.json', false],
  ['invalid/unknown-contribution.json', false],
  ['invalid/reserved-id.json', false],
  ['invalid/reserved-root-id.json', false],
  ['invalid/missing-action-capability.json', false],
  ['invalid/negentropy-authority.json', false],
  ['invalid/lifecycle-spoof.json', false],
  ['invalid/unknown-target-field.json', false],
  ['invalid/duplicate-capability.json', false],
  ['invalid/gate-bypass.json', false],
  ['invalid/invalid-semver.json', false],
  ['invalid/invalid-range.json', false],
] as const;

export function loadManifestFixtureCases(): ManifestFixtureCase[] {
  return FIXTURES.map(([name, valid]) => ({
    name,
    valid,
    value: JSON.parse(
      readFileSync(new URL(`../__fixtures__/manifests/${name}`, import.meta.url), 'utf8'),
    ) as unknown,
  }));
}
