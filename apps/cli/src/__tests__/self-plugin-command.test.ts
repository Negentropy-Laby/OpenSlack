import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import type {
  PluginActionRunnerPort,
  PluginActionRunResult,
} from '../boot/plugin-action-runner.js';
import { selfCommands } from '../commands/self.js';
import { getBuildInfo } from '../release/build-info.js';

async function runSelfPlugin(
  runner: PluginActionRunnerPort,
  pluginId = 'fixture',
  actionId = 'ready-count',
): Promise<void> {
  await selfCommands(runner).parseAsync(['node', 'self', 'plugin', 'run', pluginId, actionId], {
    from: 'node',
  });
}

describe('self plugin command', () => {
  it('emits a JSON-only registration preflight report with all G1-G17 checks', async () => {
    const runner: PluginActionRunnerPort = {
      run: vi.fn(async () => {
        throw new Error('not used');
      }),
    };
    const fixture = fileURLToPath(
      new URL('../../../../packages/plugin-testkit/src/__fixtures__/valid/', import.meta.url),
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const previousExitCode = process.exitCode;
    try {
      process.exitCode = undefined;
      await selfCommands(runner, {
        workspaceRoot: process.cwd(),
        openslackVersion: '0.1.1',
      }).parseAsync(['node', 'self', 'plugin', 'check', fixture, '--format', 'json'], {
        from: 'node',
      });

      expect(error).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledTimes(1);
      const report = JSON.parse(String(log.mock.calls[0]?.[0])) as {
        readiness: string;
        checks: Array<{ id: string }>;
      };
      expect(report.readiness).toBe('READY_TO_REGISTER');
      expect(report.checks.map((check) => check.id)).toEqual(
        Array.from({ length: 17 }, (_, index) => `G${index + 1}`),
      );
      expect(process.exitCode).toBeUndefined();
    } finally {
      process.exitCode = previousExitCode;
      error.mockRestore();
      log.mockRestore();
    }
  });

  it('returns exit 1 and a stable blocking code for an executable manifest', async () => {
    const runner: PluginActionRunnerPort = {
      run: vi.fn(async () => {
        throw new Error('not used');
      }),
    };
    const fixture = fileURLToPath(
      new URL(
        '../../../../packages/plugin-testkit/src/__fixtures__/executable-entry/',
        import.meta.url,
      ),
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const previousExitCode = process.exitCode;
    try {
      process.exitCode = undefined;
      await selfCommands(runner, {
        workspaceRoot: process.cwd(),
        openslackVersion: '0.1.1',
      }).parseAsync(['node', 'self', 'plugin', 'check', fixture, '--format', 'json'], {
        from: 'node',
      });

      const report = JSON.parse(String(log.mock.calls[0]?.[0])) as {
        readiness: string;
        findings: Array<{ code: string }>;
      };
      expect(report.readiness).toBe('BLOCKED');
      expect(report.findings.map((finding) => finding.code)).toContain(
        'PLUGIN_MANIFEST_EXECUTABLE_FIELD_FORBIDDEN',
      );
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
      log.mockRestore();
    }
  });

  it('surfaces a bounded single-line message for an unexpected checker failure', async () => {
    const runner: PluginActionRunnerPort = {
      run: vi.fn(async () => {
        throw new Error('not used');
      }),
    };
    const checkOptions = Object.defineProperty(
      { openslackVersion: getBuildInfo().version },
      'workingDirectory',
      {
        enumerable: true,
        get: () => {
          throw new Error('filesystem unavailable\nretry later');
        },
      },
    ) as { workspaceRoot: string; openslackVersion: string };
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const previousExitCode = process.exitCode;
    try {
      process.exitCode = undefined;
      await selfCommands(runner, checkOptions).parseAsync(
        ['node', 'self', 'plugin', 'check', 'fixture'],
        { from: 'node' },
      );

      expect(error).toHaveBeenCalledExactlyOnceWith(
        'Plugin check failed: PLUGIN_CHECK_FAILED: filesystem unavailable retry later',
      );
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
      error.mockRestore();
    }
  });

  it('uses the build version for the standalone checker default', async () => {
    const runner: PluginActionRunnerPort = {
      run: vi.fn(async () => {
        throw new Error('not used');
      }),
    };
    const root = mkdtempSync(join(tmpdir(), 'openslack-plugin-cli-version-'));
    const source = fileURLToPath(
      new URL(
        '../../../../packages/plugin-testkit/src/__fixtures__/valid/plugin.json',
        import.meta.url,
      ),
    );
    const manifest = JSON.parse(readFileSync(source, 'utf8')) as {
      requires: { openslack: string };
    };
    manifest.requires.openslack = getBuildInfo().version;
    writeFileSync(join(root, 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const previousExitCode = process.exitCode;
    try {
      process.exitCode = undefined;
      await selfCommands(runner).parseAsync(
        ['node', 'self', 'plugin', 'check', root, '--format', 'json'],
        { from: 'node' },
      );

      const report = JSON.parse(String(log.mock.calls[0]?.[0])) as { readiness: string };
      expect(report.readiness).toBe('READY_TO_REGISTER');
      expect(error).not.toHaveBeenCalled();
      expect(process.exitCode).toBeUndefined();
    } finally {
      process.exitCode = previousExitCode;
      error.mockRestore();
      log.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('adds the nested check and run commands and renders SHADOW visibility', async () => {
    const runner: PluginActionRunnerPort = {
      run: vi.fn(
        async (): Promise<PluginActionRunResult> => ({
          outcome: 'shadowed',
          contributedActionId: 'plugin:metrics-shadow:ready-count',
          targetActionId: 'github.metrics',
          executable: false,
        }),
      ),
    };
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const self = selfCommands(runner);
      const plugin = self.commands.find((command) => command.name() === 'plugin');
      expect(plugin?.commands.map((command) => command.name())).toEqual(['check', 'run']);

      await self.parseAsync(['node', 'self', 'plugin', 'run', 'metrics-shadow', 'ready-count'], {
        from: 'node',
      });
      expect(log.mock.calls).toEqual([
        ['Plugin action visibility: SHADOW'],
        ['Contribution: plugin:metrics-shadow:ready-count'],
        ['Target: github.metrics'],
        ['Executed: no'],
      ]);
    } finally {
      log.mockRestore();
    }
  });

  it('renders only successful audited target output for ENFORCE routing', async () => {
    const runner: PluginActionRunnerPort = {
      run: vi.fn(
        async (): Promise<PluginActionRunResult> => ({
          outcome: 'executed',
          contributedActionId: 'plugin:metrics-enforce:ready-count',
          targetActionId: 'github.metrics',
          executable: true,
          execution: {
            planId: 'PLAN-P2-PR3',
            status: 'success',
            steps: [
              {
                stepId: 'metrics-enforce.ready-count',
                status: 'success',
                output: 'Ready: 3\n',
                exitCode: 0,
              },
            ],
            summary: 'Completed.',
            nextActions: [],
          },
        }),
      ),
    };
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runSelfPlugin(runner);
      expect(log.mock.calls).toEqual([
        ['Plugin action routing: ENFORCE'],
        ['Contribution: plugin:metrics-enforce:ready-count'],
        ['Target: github.metrics'],
        ['Ready: 3'],
      ]);
    } finally {
      log.mockRestore();
    }
  });

  it('fails with fixed prose and does not forward failed execution output', async () => {
    const runner: PluginActionRunnerPort = {
      run: vi.fn(
        async (): Promise<PluginActionRunResult> => ({
          outcome: 'executed',
          contributedActionId: 'plugin:metrics-enforce:ready-count',
          targetActionId: 'github.metrics',
          executable: true,
          execution: {
            planId: 'PLAN-P2-PR3',
            status: 'failed',
            steps: [
              {
                stepId: 'metrics-enforce.ready-count',
                status: 'failed',
                output: 'credential=/private/sentinel.key token=secret-value',
                exitCode: 1,
              },
            ],
            summary: 'Failed.',
            nextActions: [],
          },
        }),
      ),
    };
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const previousExitCode = process.exitCode;
    try {
      process.exitCode = undefined;
      await runSelfPlugin(runner);
      expect(error).toHaveBeenCalledExactlyOnceWith('Plugin action execution failed: failed.');
      expect(JSON.stringify([...log.mock.calls, ...error.mock.calls])).not.toContain('sentinel');
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
      error.mockRestore();
      log.mockRestore();
    }
  });

  it('redacts unexpected runner failures', async () => {
    const runner: PluginActionRunnerPort = {
      run: vi.fn(async () => {
        throw new Error('credential=/private/sentinel.key token=secret-value');
      }),
    };
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const previousExitCode = process.exitCode;
    try {
      process.exitCode = undefined;
      await runSelfPlugin(runner);
      expect(error).toHaveBeenCalledExactlyOnceWith(
        'Plugin action failed: PLUGIN_ACTION_RUN_FAILED.',
      );
      expect(JSON.stringify(error.mock.calls)).not.toContain('sentinel');
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
      error.mockRestore();
    }
  });

  it('preserves top-level help bytes while extending only the self subtree', () => {
    const entry = fileURLToPath(new URL('../index.ts', import.meta.url));
    const tsxImport = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
    const root = spawnSync(process.execPath, ['--import', tsxImport, entry, '--help']);
    const self = spawnSync(process.execPath, ['--import', tsxImport, entry, 'self', '--help']);

    expect(root.status).toBe(0);
    expect(root.stdout.byteLength).toBe(1681);
    expect(createHash('sha256').update(root.stdout).digest('hex')).toBe(
      '502bf57583812ac44f9c93376adf4540e21988b9c116adac8dac0c52b7764711',
    );
    expect(self.status).toBe(0);
    expect(self.stdout.toString('utf8')).toContain('plugin');

    const workspaceRoot = mkdtempSync(join(tmpdir(), 'openslack-p2-pr3-malformed-lock-'));
    try {
      mkdirSync(join(workspaceRoot, '.openslack'), { recursive: true });
      writeFileSync(
        join(workspaceRoot, '.openslack', 'plugins.lock'),
        '{"sentinel":"private-path-marker"',
      );

      const help = spawnSync(
        process.execPath,
        ['--import', tsxImport, entry, 'self', 'plugin', 'run', '--help'],
        { cwd: workspaceRoot },
      );
      expect(help.status).toBe(0);
      expect(help.stdout.toString('utf8')).toContain('run [options] <plugin-id> <action-id>');

      const malformed = spawnSync(
        process.execPath,
        ['--import', tsxImport, entry, 'self', 'plugin', 'run', 'fixture', 'ready-count'],
        { cwd: workspaceRoot },
      );
      const stderr = malformed.stderr.toString('utf8');
      expect(malformed.status).toBe(1);
      expect(stderr.trim()).toBe('Plugin action failed: PLUGIN_ACTION_WORKSPACE_LOAD_FAILED.');
      expect(stderr).not.toContain(workspaceRoot);
      expect(stderr).not.toContain('private-path-marker');
      expect(stderr).not.toContain(' at ');
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  }, 20_000);
});
