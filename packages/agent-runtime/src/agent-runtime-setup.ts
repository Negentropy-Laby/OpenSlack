import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type {
  AgentRuntimeDoctorCheck,
  AgentRuntimeDoctorCheckStatus,
  AgentRuntimeReadiness,
  AbyRuntimeDoctorReport,
  DiagnoseAbyRuntimeOptions,
} from './agent-runtime-doctor.js';
import { diagnoseAbyRuntime } from './agent-runtime-doctor.js';
import { auditBridgeEnv } from './bridge-env.js';
import {
  AGENT_RUNTIME_CONFIG_SCHEMA,
  readRuntimeConfigForMerge,
  writeRuntimeConfigAtomic,
} from './runtime-config-file.js';

export type AbyRuntimeSetupStatus = 'PASS' | 'FAIL';
export type AbyRuntimeSetupMode = 'dry-run' | 'write';

export interface SetupAbyRuntimeOptions {
  rootDir?: string;
  root: string;
  command?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  bridgeEnv?: Record<string, string>;
  configPath?: string;
  write?: boolean;
  checkCommandAvailable?: (command: string) => boolean;
  diagnose?: (options: DiagnoseAbyRuntimeOptions) => AbyRuntimeDoctorReport;
}

export interface AbyRuntimeSetupConfigPreview {
  aby: {
    root: string;
    command: string;
    timeoutMs: number;
    env?: {
      allowedKeys: string[];
      rejectedKeys: string[];
    };
  };
}

export interface AbyRuntimeSetupReport {
  provider: 'aby';
  mode: AbyRuntimeSetupMode;
  status: AbyRuntimeSetupStatus;
  readiness: AgentRuntimeReadiness;
  root: string;
  resolvedRoot: string;
  configPath: string;
  command: string;
  timeoutMs: number;
  wroteConfig: boolean;
  env: {
    allowedKeys: string[];
    rejectedKeys: string[];
  };
  configPreview: AbyRuntimeSetupConfigPreview;
  checks: AgentRuntimeDoctorCheck[];
  remediations: string[];
  doctor?: AbyRuntimeDoctorReport;
}

export function setupAbyRuntime(options: SetupAbyRuntimeOptions): AbyRuntimeSetupReport {
  const rootDir = options.rootDir ?? process.cwd();
  const root = options.root.trim();
  const resolvedRoot = root ? (isAbsolute(root) ? resolve(root) : resolve(rootDir, root)) : rootDir;
  const command = options.command ?? 'bun';
  const timeoutMs = options.timeoutMs ?? 120_000;
  const configPath = options.configPath ?? join(rootDir, '.openslack.local', 'agent-runtime.json');
  const envAudit = auditBridgeEnv(options.bridgeEnv);
  const runEntrypoint = join(resolvedRoot, 'src', 'sidecar', 'entrypoints', 'runEntrypoint.ts');
  const agentRunBridge = join(resolvedRoot, 'src', 'sidecar', 'entrypoints', 'agentRunBridge.ts');

  const checks: AgentRuntimeDoctorCheck[] = [
    {
      name: 'aby-root',
      status: root && existsSync(resolvedRoot) ? 'PASS' : 'FAIL',
      detail: root
        ? existsSync(resolvedRoot)
          ? resolvedRoot
          : `Path does not exist: ${resolvedRoot}`
        : 'Missing Aby root',
    },
    {
      name: 'runEntrypoint.ts',
      status: existsSync(runEntrypoint) ? 'PASS' : 'FAIL',
      detail: existsSync(runEntrypoint) ? runEntrypoint : `Missing ${runEntrypoint}`,
    },
    {
      name: 'agentRunBridge.ts',
      status: existsSync(agentRunBridge) ? 'PASS' : 'FAIL',
      detail: existsSync(agentRunBridge) ? agentRunBridge : `Missing ${agentRunBridge}`,
    },
    {
      name: 'command',
      status: commandAvailable(command, options.checkCommandAvailable) ? 'PASS' : 'FAIL',
      detail: command,
    },
    {
      name: 'safe-env',
      status: envAudit.rejectedKeys.length === 0 ? 'PASS' : 'FAIL',
      detail:
        envAudit.rejectedKeys.length === 0
          ? `Allowed keys: ${envAudit.allowedKeys.join(', ') || '(none)'}`
          : `Rejected unsafe keys: ${envAudit.rejectedKeys.join(', ')}`,
    },
  ];

  let status: AbyRuntimeSetupStatus = checks.some((check) => check.status === 'FAIL')
    ? 'FAIL'
    : 'PASS';
  const mode: AbyRuntimeSetupMode = options.write ? 'write' : 'dry-run';
  const configPreview = buildConfigPreview(root, command, timeoutMs, envAudit);
  let wroteConfig = false;
  let doctor: AbyRuntimeDoctorReport | undefined;

  if (options.write && status === 'PASS') {
    try {
      const existing = readRuntimeConfigForMerge(configPath);
      writeRuntimeConfigAtomic(configPath, {
        ...existing,
        ...buildWritableConfig(root, command, timeoutMs, envAudit.safeEnv),
      });
      wroteConfig = true;
      doctor = (options.diagnose ?? diagnoseAbyRuntime)({
        rootDir,
        env: options.env ?? process.env,
        configPath,
      });
    } catch {
      checks.push({
        name: 'write',
        status: 'FAIL',
        detail: 'Existing runtime config could not be safely merged.',
      });
    }
  }

  if (doctor) {
    checks.push({
      name: 'doctor',
      status: doctor.status as AgentRuntimeDoctorCheckStatus,
      detail: `Aby runtime doctor ${doctor.status}`,
    });
  }
  status = checks.some((check) => check.status === 'FAIL') ? 'FAIL' : 'PASS';

  const readiness: AgentRuntimeReadiness =
    doctor?.readiness ??
    (!root
      ? 'not_configured'
      : checks.some((check) => check.name === 'command' && check.status === 'FAIL') &&
          checks.every((check) => check.name === 'command' || check.status !== 'FAIL')
        ? 'unavailable'
        : status === 'FAIL'
          ? 'misconfigured'
          : wroteConfig
            ? 'ready'
            : 'not_configured');

  return {
    provider: 'aby',
    mode,
    status: doctor?.status ?? status,
    readiness,
    root,
    resolvedRoot,
    configPath,
    command,
    timeoutMs,
    wroteConfig,
    env: {
      allowedKeys: envAudit.allowedKeys,
      rejectedKeys: envAudit.rejectedKeys,
    },
    configPreview,
    checks,
    remediations: remediationForSetup(checks, wroteConfig),
    doctor,
  };
}

function commandAvailable(
  command: string,
  checkCommandAvailable?: (command: string) => boolean,
): boolean {
  if (!command.trim()) return false;
  if (checkCommandAvailable) return checkCommandAvailable(command);
  const result = spawnSync(command, ['--version'], { encoding: 'utf-8', stdio: 'pipe' });
  return !result.error && result.status === 0;
}

function buildConfigPreview(
  root: string,
  command: string,
  timeoutMs: number,
  envAudit: ReturnType<typeof auditBridgeEnv>,
): AbyRuntimeSetupConfigPreview {
  const preview: AbyRuntimeSetupConfigPreview = {
    aby: { root, command, timeoutMs },
  };
  if (envAudit.allowedKeys.length > 0 || envAudit.rejectedKeys.length > 0) {
    preview.aby.env = {
      allowedKeys: envAudit.allowedKeys,
      rejectedKeys: envAudit.rejectedKeys,
    };
  }
  return preview;
}

function buildWritableConfig(
  root: string,
  command: string,
  timeoutMs: number,
  safeEnv: Record<string, string>,
): Record<string, unknown> {
  const aby: Record<string, unknown> = { root, command, timeoutMs };
  if (Object.keys(safeEnv).length > 0) aby.env = safeEnv;
  return { schema: AGENT_RUNTIME_CONFIG_SCHEMA, aby };
}

function remediationForSetup(checks: AgentRuntimeDoctorCheck[], wroteConfig: boolean): string[] {
  const failed = checks.filter((check) => check.status === 'FAIL');
  if (failed.length === 0) {
    return wroteConfig
      ? [
          'Configuration written. Run openslack agent-runtime doctor --provider aby to verify again.',
        ]
      : ['Dry run passed. Re-run with --write to save .openslack.local/agent-runtime.json.'];
  }

  const remediations = failed.map((check) => {
    switch (check.name) {
      case 'aby-root':
        return 'Pass --root <path> pointing at a local Aby checkout.';
      case 'runEntrypoint.ts':
        return 'Use a bridge-capable Aby checkout that contains src/sidecar/entrypoints/runEntrypoint.ts.';
      case 'agentRunBridge.ts':
        return 'Use a bridge-capable Aby checkout that contains src/sidecar/entrypoints/agentRunBridge.ts.';
      case 'command':
        return 'Install bun or pass a bridge command that is available on PATH.';
      case 'safe-env':
        return 'Remove unsafe env keys; only AGENT_RUN_BRIDGE_RUNNER and AGENT_RUN_SAFE_* are allowed.';
      case 'doctor':
        return 'Fix the failed doctor checks and rerun openslack agent-runtime setup aby --write.';
      default:
        return 'Fix the failed setup check and rerun agent-runtime setup.';
    }
  });
  return [...new Set(remediations)];
}
