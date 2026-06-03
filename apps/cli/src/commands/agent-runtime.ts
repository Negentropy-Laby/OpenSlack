import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Command } from 'commander';
import type {
  AbyRuntimeDoctorReport,
  AbyRuntimeSetupReport,
  AgentRuntimeMcpStatusReport,
  AbyRuntimeSmokeReport,
  DiagnoseAbyRuntimeOptions,
  SetupAbyRuntimeOptions,
  RunAbyRuntimeSmokeOptions,
  AgentRuntimeMcpStatusOptions,
} from '@openslack/agent-runtime';

interface AgentRuntimeCommandDependencies {
  diagnoseAbyRuntime?: (options: DiagnoseAbyRuntimeOptions) => AbyRuntimeDoctorReport;
  setupAbyRuntime?: (options: SetupAbyRuntimeOptions) => AbyRuntimeSetupReport;
  runAbyRuntimeSmoke?: (options: RunAbyRuntimeSmokeOptions) => Promise<AbyRuntimeSmokeReport>;
  getAgentRuntimeMcpStatus?: (options: AgentRuntimeMcpStatusOptions) => AgentRuntimeMcpStatusReport;
}

type DoctorFormat = 'plain' | 'json' | 'tui';

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
    .option('--format <format>', 'Output format: plain, json, or tui', 'plain')
    .action(async (options) => {
      const provider = normalizeProvider(options.provider);
      const format = normalizeDoctorFormat(options.format);
      const rootDir = findRepoRoot();
      const diagnoseAbyRuntime =
        dependencies.diagnoseAbyRuntime ??
        (await import('@openslack/agent-runtime')).diagnoseAbyRuntime;
      const report = diagnoseAbyRuntime({ rootDir, env: process.env });

      if (format === 'json') {
        console.log(renderAbyRuntimeDoctorJson(report));
      } else if (format === 'tui') {
        const { mapAbyRuntimeDoctorToViewModel, renderAgentRuntimeDiagnosticsTui } =
          await import('@openslack/tui');
        await renderAgentRuntimeDiagnosticsTui(
          mapAbyRuntimeDoctorToViewModel(report, { rootDir }),
        );
      } else {
        console.log(renderAbyRuntimeDoctorReport(report));
      }

      if (provider !== 'aby' || report.status === 'FAIL') process.exit(1);
    });

  const setup = cmd
    .command('setup')
    .description('Configure external agent runtime providers');

  setup
    .command('aby')
    .description('Create a local Aby runtime bridge configuration')
    .requiredOption('--root <path>', 'Local Aby checkout path')
    .option('--dry-run', 'Preview the config without writing it')
    .option('--write', 'Write .openslack.local/agent-runtime.json')
    .option('--command <command>', 'Bridge command to launch', 'bun')
    .option('--timeout-ms <ms>', 'Bridge timeout in milliseconds', '120000')
    .action(async (options) => {
      const rootDir = findRepoRoot();
      const write = Boolean(options.write);
      if (options.dryRun && write) {
        console.error('Choose either --dry-run or --write, not both.');
        process.exit(1);
      }

      const setupAbyRuntime =
        dependencies.setupAbyRuntime ??
        (await import('@openslack/agent-runtime')).setupAbyRuntime;
      const report = setupAbyRuntime({
        rootDir,
        root: String(options.root),
        command: String(options.command ?? 'bun'),
        timeoutMs: Number.parseInt(String(options.timeoutMs ?? '120000'), 10),
        env: process.env,
        write,
      });
      console.log(renderAbyRuntimeSetupReport(report));
      if (report.status === 'FAIL') process.exit(1);
    });

  cmd
    .command('smoke')
    .description('Run a read-only external runtime bridge smoke test')
    .option('--provider <provider>', 'Runtime provider to smoke test', 'aby')
    .option('--agent <agentId>', 'Agent id to run', 'anthropic_architect_aby')
    .action(async (options) => {
      normalizeProvider(options.provider);
      const runAbyRuntimeSmoke =
        dependencies.runAbyRuntimeSmoke ??
        (await import('@openslack/agent-runtime')).runAbyRuntimeSmoke;
      const report = await runAbyRuntimeSmoke({
        rootDir: findRepoRoot(),
        env: process.env,
        agentId: String(options.agent ?? 'anthropic_architect_aby'),
      });
      console.log(renderAbyRuntimeSmokeReport(report));
      if (report.status === 'FAIL') process.exit(1);
    });

  const mcp = cmd
    .command('mcp')
    .description('Inspect agent runtime MCP descriptor and transcript evidence');

  mcp
    .command('status')
    .description('Show MCP status for an agent or run')
    .option('--provider <provider>', 'Runtime provider to inspect', 'aby')
    .option('--agent <agentId>', 'Agent id to inspect')
    .option('--run <runId>', 'Run id to inspect')
    .option('--available <servers>', 'Comma-separated available server override')
    .action(async (options) => {
      normalizeProvider(options.provider);
      const agentId = readString(options.agent);
      const runId = readString(options.run);
      if (!agentId && !runId) {
        console.error('Pass --agent <agentId> or --run <runId> to inspect MCP status.');
        process.exit(1);
      }
      const getAgentRuntimeMcpStatus =
        dependencies.getAgentRuntimeMcpStatus ??
        (await import('@openslack/agent-runtime')).getAgentRuntimeMcpStatus;
      const report = getAgentRuntimeMcpStatus({
        rootDir: findRepoRoot(),
        provider: 'aby',
        agentId,
        runId,
        availableServers: readCsv(options.available),
      });
      console.log(renderAgentRuntimeMcpStatusReport(report));
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
  lines.push('Remediation:');
  for (const line of remediations(report)) {
    lines.push(`  - ${line}`);
  }
  lines.push('');
  lines.push('Copy-paste fix:');
  for (const line of copyPasteFixes(report)) {
    lines.push(`  ${line}`);
  }
  return lines.join('\n');
}

export function renderAbyRuntimeDoctorJson(report: AbyRuntimeDoctorReport): string {
  return JSON.stringify(
    {
      provider: report.provider,
      status: report.status,
      configSource: report.configSource,
      configPath: report.configPath,
      root: report.root,
      resolvedRoot: report.resolvedRoot,
      command: report.command,
      args: report.args,
      timeoutMs: report.timeoutMs,
      safeEnv: {
        allowedKeys: report.env.allowedKeys,
        rejectedKeys: report.env.rejectedKeys,
      },
      checks: report.checks,
      remediations: remediations(report),
    },
    null,
    2,
  );
}

export function renderAbyRuntimeSetupReport(report: AbyRuntimeSetupReport): string {
  const lines: string[] = [];
  lines.push('Agent Runtime Setup');
  lines.push(`Provider: ${report.provider}`);
  lines.push(`Mode: ${report.mode}`);
  lines.push(`Status: ${report.status}`);
  lines.push(`Aby root: ${report.resolvedRoot}`);
  lines.push(`Config path: ${report.configPath}`);
  lines.push(`Config written: ${report.wroteConfig ? 'yes' : 'no'}`);
  lines.push('');
  lines.push('Config preview:');
  lines.push(JSON.stringify(report.configPreview, null, 2));
  lines.push('');
  lines.push('Checks:');
  for (const check of report.checks) {
    lines.push(`  [${check.status}] ${check.name}: ${check.detail}`);
  }
  lines.push('');
  lines.push('Remediation:');
  for (const line of report.remediations) {
    lines.push(`  - ${line}`);
  }
  return lines.join('\n');
}

export function renderAbyRuntimeSmokeReport(report: AbyRuntimeSmokeReport): string {
  const lines: string[] = [];
  lines.push('Aby Runtime Smoke');
  lines.push(`Provider: ${report.provider}`);
  lines.push(`Status: ${report.status}`);
  lines.push(`Agent: ${report.agentId}`);
  if (report.runId) lines.push(`Run ID: ${report.runId}`);
  lines.push(`Terminal reason: ${report.terminalReason}`);
  if (report.errorKind) lines.push(`Bridge error kind: ${report.errorKind}`);
  if (report.errorMessage) lines.push(`Error: ${report.errorMessage}`);
  if (report.stderrSummary) lines.push(`stderr summary: ${report.stderrSummary}`);
  lines.push('');
  lines.push('Checks:');
  for (const check of report.checks) {
    lines.push(`  [${check.status}] ${check.name}: ${check.detail}`);
  }
  lines.push('');
  lines.push('Evidence:');
  lines.push(`  run.json: ${report.evidence.runJson ?? '(not recorded)'}`);
  lines.push(`  metadata.json: ${report.evidence.metadataJson ?? '(not recorded)'}`);
  lines.push(`  transcript.jsonl: ${report.evidence.transcriptJsonl ?? '(not recorded)'}`);
  return lines.join('\n');
}

export function renderAgentRuntimeMcpStatusReport(report: AgentRuntimeMcpStatusReport): string {
  const lines: string[] = [];
  lines.push('Agent Runtime MCP Status');
  lines.push(`Provider: ${report.provider}`);
  lines.push(`Status: ${report.status}`);
  if (report.agentId) lines.push(`Agent: ${report.agentId}`);
  if (report.runId) lines.push(`Run: ${report.runId}`);
  lines.push(report.scopeNote);
  lines.push('');
  lines.push(`Required servers: ${report.requiredServers.join(', ') || '(none)'}`);
  lines.push(`Available servers: ${report.availableServers.join(', ') || '(none)'}`);
  lines.push(`Missing required: ${report.missingRequiredServers.join(', ') || '(none)'}`);
  lines.push('');
  lines.push('Descriptors:');
  for (const descriptor of report.descriptors) {
    lines.push(`  - ${descriptor.name} (${descriptor.required ? 'required' : 'optional'})`);
  }
  if (report.descriptors.length === 0) lines.push('  (none)');
  lines.push('');
  lines.push('MCP tool evidence:');
  for (const event of report.toolEvidence) {
    lines.push(`  - ${event.type}: ${event.normalizedToolName} (${event.timestamp})`);
  }
  if (report.toolEvidence.length === 0) lines.push('  (none)');
  if (report.invalidTools.length > 0) {
    lines.push('');
    lines.push('Invalid tools:');
    for (const invalid of report.invalidTools) {
      lines.push(`  [FAIL] ${invalid.tool}: ${invalid.reason}`);
    }
  }
  lines.push('');
  lines.push('Remediation:');
  for (const line of report.remediations) lines.push(`  - ${line}`);
  return lines.join('\n');
}

function normalizeProvider(provider: unknown): 'aby' {
  const value = String(provider ?? 'aby').toLowerCase();
  if (value !== 'aby') {
    console.error(`Unsupported agent runtime provider: ${String(provider)}`);
    process.exit(1);
  }
  return 'aby';
}

function normalizeDoctorFormat(format: unknown): DoctorFormat {
  const value = String(format ?? 'plain').toLowerCase();
  if (value !== 'plain' && value !== 'json' && value !== 'tui') {
    console.error(`Unsupported agent-runtime doctor format: ${String(format)}`);
    process.exit(1);
  }
  return value;
}

function remediations(report: AbyRuntimeDoctorReport): string[] {
  return report.remediations.length > 0
    ? report.remediations
    : report.remediation.split('\n').filter((line) => line.trim());
}

function copyPasteFixes(report: AbyRuntimeDoctorReport): string[] {
  if (report.status === 'PASS') {
    return ['openslack agent-runtime smoke --provider aby'];
  }
  if (report.configSource === 'none') {
    return [
      '$env:OPENSLACK_ABY_ROOT="D:\\path\\to\\Aby"',
      'bun run openslack agent-runtime doctor --provider aby',
    ];
  }
  return ['bun run openslack agent-runtime doctor --provider aby'];
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readCsv(value: unknown): string[] | undefined {
  const raw = readString(value);
  if (!raw) return undefined;
  return raw.split(',').map((item) => item.trim()).filter(Boolean);
}
