import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { BridgeRuntimeResolverOptions } from './bridge-runtime-resolver.js';
import { loadAbyBridgeRuntimeConfig } from './bridge-runtime-resolver.js';
import { auditBridgeEnv } from './bridge-env.js';

export type AgentRuntimeDoctorProvider = 'aby';
export type AgentRuntimeDoctorStatus = 'PASS' | 'FAIL';
export type AgentRuntimeDoctorCheckStatus = 'PASS' | 'FAIL' | 'WARN';
export type AbyRuntimeConfigSource =
  | 'OPENSLACK_ABY_ROOT'
  | '.openslack.local/agent-runtime.json'
  | 'none';

export interface AgentRuntimeDoctorCheck {
  name: string;
  status: AgentRuntimeDoctorCheckStatus;
  detail: string;
}

export interface AgentRuntimeEnvAudit {
  allowedKeys: string[];
  rejectedKeys: string[];
}

export interface AbyRuntimeDoctorReport {
  provider: AgentRuntimeDoctorProvider;
  status: AgentRuntimeDoctorStatus;
  configSource: AbyRuntimeConfigSource;
  configPath: string;
  root?: string;
  resolvedRoot?: string;
  command?: string;
  args: string[];
  timeoutMs?: number;
  env: AgentRuntimeEnvAudit;
  checks: AgentRuntimeDoctorCheck[];
  remediations: string[];
  remediation: string;
}

export type DiagnoseAbyRuntimeOptions = BridgeRuntimeResolverOptions;

export function diagnoseAbyRuntime(
  options: DiagnoseAbyRuntimeOptions = {},
): AbyRuntimeDoctorReport {
  const env = options.env ?? process.env;
  const configPath =
    options.configPath ??
    join(options.rootDir ?? process.cwd(), '.openslack.local', 'agent-runtime.json');

  let loaded;
  try {
    loaded = loadAbyBridgeRuntimeConfig(options);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      provider: 'aby',
      status: 'FAIL',
      configSource: 'none',
      configPath,
      args: [],
      env: { allowedKeys: [], rejectedKeys: [] },
      checks: [{ name: 'config', status: 'FAIL', detail: message }],
      remediations: ['Fix .openslack.local/agent-runtime.json so it is valid JSON.'],
      remediation: 'Fix .openslack.local/agent-runtime.json so it is valid JSON.',
    };
  }

  const rootFromEnv = readString(env.OPENSLACK_ABY_ROOT);
  const configSource: AbyRuntimeConfigSource = rootFromEnv
    ? 'OPENSLACK_ABY_ROOT'
    : loaded.root
      ? '.openslack.local/agent-runtime.json'
      : 'none';
  const root = loaded.root;
  const resolvedRoot = root ? resolveConfiguredPath(root, options.rootDir) : undefined;
  const runEntrypoint = resolvedRoot
    ? join(resolvedRoot, 'src', 'sidecar', 'entrypoints', 'runEntrypoint.ts')
    : undefined;
  const agentRunBridge = resolvedRoot
    ? join(resolvedRoot, 'src', 'sidecar', 'entrypoints', 'agentRunBridge.ts')
    : undefined;
  const envAudit = auditBridgeEnv(loaded.env);
  const command = loaded.command ?? 'bun';
  const args = runEntrypoint && agentRunBridge ? [runEntrypoint, agentRunBridge] : [];

  const checks: AgentRuntimeDoctorCheck[] = [];
  checks.push({
    name: 'config-source',
    status: configSource === 'none' ? 'FAIL' : 'PASS',
    detail: configSource === 'none'
      ? 'No Aby root configured'
      : `Using ${configSource}`,
  });
  checks.push({
    name: 'aby-root',
    status: resolvedRoot && existsSync(resolvedRoot) ? 'PASS' : 'FAIL',
    detail: resolvedRoot
      ? existsSync(resolvedRoot)
        ? resolvedRoot
        : `Path does not exist: ${resolvedRoot}`
      : 'Missing Aby root',
  });
  checks.push({
    name: 'runEntrypoint.ts',
    status: runEntrypoint && existsSync(runEntrypoint) ? 'PASS' : 'FAIL',
    detail: runEntrypoint
      ? existsSync(runEntrypoint)
        ? runEntrypoint
        : `Missing ${runEntrypoint}`
      : 'Not checked because Aby root is missing',
  });
  checks.push({
    name: 'agentRunBridge.ts',
    status: agentRunBridge && existsSync(agentRunBridge) ? 'PASS' : 'FAIL',
    detail: agentRunBridge
      ? existsSync(agentRunBridge)
        ? agentRunBridge
        : `Missing ${agentRunBridge}`
      : 'Not checked because Aby root is missing',
  });
  checks.push({
    name: 'command',
    status: command ? 'PASS' : 'FAIL',
    detail: command ? command : 'Missing bridge command',
  });
  checks.push({
    name: 'safe-env',
    status: envAudit.rejectedKeys.length === 0 ? 'PASS' : 'FAIL',
    detail: envAudit.rejectedKeys.length === 0
      ? `Allowed keys: ${envAudit.allowedKeys.join(', ') || '(none)'}`
      : `Rejected unsafe keys: ${envAudit.rejectedKeys.join(', ')}`,
  });

  const status: AgentRuntimeDoctorStatus = checks.some((check) => check.status === 'FAIL')
    ? 'FAIL'
    : 'PASS';
  const remediations = remediationsFor(checks);

  return {
    provider: 'aby',
    status,
    configSource,
    configPath,
    root,
    resolvedRoot,
    command,
    args,
    timeoutMs: loaded.timeoutMs,
    env: {
      allowedKeys: envAudit.allowedKeys,
      rejectedKeys: envAudit.rejectedKeys,
    },
    checks,
    remediations,
    remediation: remediations.join('\n'),
  };
}

function remediationsFor(checks: AgentRuntimeDoctorCheck[]): string[] {
  const failed = checks.filter((check) => check.status === 'FAIL');
  if (failed.length === 0) return ['Aby bridge runtime is configured and ready.'];

  const remediations = failed.map(remediationForFailedCheck);
  return [...new Set(remediations)];
}

function remediationForFailedCheck(check: AgentRuntimeDoctorCheck): string {
  switch (check.name) {
    case 'config-source':
      return 'Set OPENSLACK_ABY_ROOT or add .openslack.local/agent-runtime.json with an aby.root value.';
    case 'aby-root':
      return 'Point OPENSLACK_ABY_ROOT or aby.root at a local Aby checkout.';
    case 'runEntrypoint.ts':
      return 'Update Aby to a bridge-capable checkout that contains src/sidecar/entrypoints/runEntrypoint.ts.';
    case 'agentRunBridge.ts':
      return 'Update Aby to a bridge-capable checkout that contains src/sidecar/entrypoints/agentRunBridge.ts.';
    case 'safe-env':
      return 'Remove unsafe env keys from .openslack.local/agent-runtime.json; task content and secrets must not cross the bridge through env.';
    default:
      return 'Fix the failed check and run openslack agent-runtime doctor --provider aby again.';
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function resolveConfiguredPath(pathValue: string, rootDir?: string): string {
  if (isAbsolute(pathValue)) return resolve(pathValue);
  return resolve(rootDir ?? process.cwd(), pathValue);
}
