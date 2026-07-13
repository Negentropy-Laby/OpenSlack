import { describe, expect, it, vi } from 'vitest';
import { versionCommand } from '../commands/version.js';

describe('version command', () => {
  it('renders machine-readable build and compatibility information', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await versionCommand().parseAsync(['node', 'version', '--format', 'json'], { from: 'node' });
      const parsed = JSON.parse(String(log.mock.calls[0]?.[0])) as Record<string, unknown>;
      expect(parsed).toMatchObject({
        schema: 'openslack.build_info.v1',
        version: '0.1.0',
        channel: 'source',
        artifactFormat: 'source',
        workspaceSchemaCompatibility: { min: 1, max: 1 },
      });
      expect(parsed.stateSchemaCompatibility).toContain('openslack.onboarding.v1');
    } finally {
      log.mockRestore();
    }
  });
});
