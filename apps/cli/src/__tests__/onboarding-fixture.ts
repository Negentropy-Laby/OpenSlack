import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const obsoleteOnboarding =
  /\{\{[A-Z_]+\}\}|\/v1\/claims|--claim-one|--source (?:github-project|local-cron)|schedule.github-actions|local_cron|[A-Z]:[\\/]/;
export function onboardingFixture(roots: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'onboarding with spaces '));
  roots.push(root);
  writeFileSync(join(root, 'openslack.yaml'), 'schema: openslack.workspace.v1\n');
  mkdirSync(join(root, 'templates'), { recursive: true });
  cpSync(join(process.cwd(), 'templates', 'new-agent'), join(root, 'templates', 'new-agent'), {
    recursive: true,
  });
  return root;
}
