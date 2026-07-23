import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadWatchRuntimeConfig } from '../commands/github.js';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function configFile(contents: string): string {
  const root = mkdtempSync(join(tmpdir(), 'openslack-watch-cli-v2-'));
  roots.push(root);
  const path = join(root, 'github-watch.yaml');
  writeFileSync(path, contents, 'utf8');
  return path;
}

describe('GitHub watch runtime config selection', () => {
  it('loads an explicitly selected v2 config without falling back to v1', () => {
    const result = loadWatchRuntimeConfig(
      configFile(`
schema: openslack.github_watch.v2
notification_service:
  endpoint: https://notifications.example.test
  credential_ref: env:OPENSLACK_NOTIFICATION_SERVICE_KEY
  expected_deployment_digest: sha256:${'a'.repeat(64)}
repositories:
  - owner: Negentropy-Laby
    repo: canary
    events: [issues.opened]
    routes:
      - id: webhook-primary
        sink: webhook
        delivery:
          backend: notification_service
          vendor_id: openslack-webhook
          routing_epoch: 1
`),
    );

    expect(result.valid).toBe(true);
    expect(result.config?.schema).toBe('openslack.github_watch.v2');
  });

  it('retains the legacy v1 loader for direct drain configurations', () => {
    const result = loadWatchRuntimeConfig(
      configFile(`
schema: openslack.github_watch.v1
repositories:
  - owner: Negentropy-Laby
    repo: legacy
    events: [issues.opened]
`),
    );

    expect(result.valid).toBe(true);
    expect(result.config?.schema).not.toBe('openslack.github_watch.v2');
  });

  it('fails closed with both parser diagnostics for an invalid config', () => {
    const result = loadWatchRuntimeConfig(configFile('repositories: not-an-array\n'));

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(1);
  });
});
