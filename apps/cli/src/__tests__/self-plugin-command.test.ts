import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  it('adds only the nested self -> plugin -> run command and renders SHADOW visibility', async () => {
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
      expect(plugin?.commands.map((command) => command.name())).toEqual(['run']);

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
  });
});
