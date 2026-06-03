import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Command } from 'commander';
import type {
  AbyRuntimeDoctorReport,
  DiagnoseAbyRuntimeOptions,
} from '@openslack/agent-runtime';

interface AgentRuntimeCommandDependencies {
  diagnoseAbyRuntime?: (options: DiagnoseAbyRuntimeOptions) => AbyRuntimeDoctorReport;
}

function findRepoRoot(): string {
  let dir = resolve(process.cwd());
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'openslack.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export function agentRuntimeCommands(
  dependencies: AgentRuntimeCommandDependencies = {},
): Command {
  const cmd = new Command('agent-runtime').description('Agent runtime diagnostics');

  cmd
    .command('doctor')
    .description('Diagnose external agent runtime providers')
    .option('--provider <provider>', 'Runtime provider to diagnose', 'aby')
    .action(async (options) => {
      const provider = String(options.provider ?? 'aby').toLowerCase();
      if (provider !== 'aby') {
        console.error(`Unsupported agent runtime provider: ${String(options.provider)}`);
        process.exit(1);
      }

      const diagnoseAbyRuntime =
        dependencies.diagnoseAbyRuntime ??
        (await import('@openslack/agent-runtime')).diagnoseAbyRuntime;
      const report = diagnoseAbyRuntime({
        rootDir: findRepoRoot(),
        env: process.env,
      });
      console.log(renderAbyRuntimeDoctorReport(report));
      if (report.status === 'FAIL') process.exit(1);
    });

  return cmd;
}

export function renderAbyRuntimeDoctorReport(report: AbyRuntimeDoctorReport): string {
  const lines: string[] = [];
  lines.push('Agent Runtime Doctor');
  lines.push(`Provider: ${report.provider}`);
  lines.push(`Status: ${report.status}`);
  lines.push(`Config source: ${report.configSource}`);
  lines.push(`Config path: ${report.configPath}`);
  lines.push(`Aby root: ${report.resolvedRoot ?? report.root ?? '(not configured)'}`);
  lines.push(`Command: ${report.command ?? '(not configured)'}`);
  lines.push(`Args: ${report.args.length > 0 ? report.args.join(' ') : '(not available)'}`);
  if (report.timeoutMs !== undefined) lines.push(`Timeout: ${report.timeoutMs}ms`);
  lines.push(`Safe env allowed: ${report.env.allowedKeys.join(', ') || '(none)'}`);
  lines.push(`Safe env rejected: ${report.env.rejectedKeys.join(', ') || '(none)'}`);
  lines.push('');
  lines.push('Checks:');
  for (const check of report.checks) {
    lines.push(`  [${check.status}] ${check.name}: ${check.detail}`);
  }
  lines.push('');
  const remediationLines = report.remediation.split('\n').filter((line) => line.trim());
  if (remediationLines.length <= 1) {
    lines.push(`Remediation: ${report.remediation}`);
  } else {
    lines.push('Remediation:');
    for (const line of remediationLines) {
      lines.push(`  - ${line}`);
    }
  }
  return lines.join('\n');
}
