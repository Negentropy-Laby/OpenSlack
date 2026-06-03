import type { BridgeSessionConfig } from './bridge-contract.js';
import { BRIDGE_PROTOCOL_VERSION } from './bridge-contract.js';

const OS_ENV_ALLOWLIST = [
  'PATH',
  'Path',
  'PATHEXT',
  'SystemRoot',
  'WINDIR',
  'TEMP',
  'TMP',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'COMSPEC',
] as const;

export interface BridgeEnvAudit {
  allowedKeys: string[];
  rejectedKeys: string[];
  safeEnv: Record<string, string>;
}

export function isSafeBridgeEnvKey(key: string): boolean {
  if (!/^[A-Z0-9_]+$/.test(key)) return false;
  if (/(TOKEN|SECRET|PASSWORD|PRIVATE|PEM|CREDENTIAL|KEY)/.test(key)) return false;
  return key === 'AGENT_RUN_BRIDGE_RUNNER' || key.startsWith('AGENT_RUN_SAFE_');
}

export function auditBridgeEnv(input?: Record<string, string>): BridgeEnvAudit {
  const safeEnv: Record<string, string> = {};
  const allowedKeys: string[] = [];
  const rejectedKeys: string[] = [];

  for (const [key, value] of Object.entries(input ?? {})) {
    if (isSafeBridgeEnvKey(key)) {
      safeEnv[key] = value;
      allowedKeys.push(key);
    } else {
      rejectedKeys.push(key);
    }
  }

  return {
    allowedKeys: allowedKeys.sort(),
    rejectedKeys: rejectedKeys.sort(),
    safeEnv,
  };
}

export function buildSafeBridgeEnv(input?: Record<string, string>): Record<string, string> | undefined {
  const audit = auditBridgeEnv(input);
  return Object.keys(audit.safeEnv).length > 0 ? audit.safeEnv : undefined;
}

export function buildBridgeProcessEnv(
  config: Pick<BridgeSessionConfig, 'runId' | 'agentId'>,
  extraEnv?: Record<string, string>,
  sourceEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};

  for (const key of OS_ENV_ALLOWLIST) {
    const value = sourceEnv[key];
    if (typeof value === 'string') env[key] = value;
  }

  env.AGENT_RUN_ID = config.runId;
  env.AGENT_ID = config.agentId;
  env.AGENT_RUN_BRIDGE_PROTOCOL_VERSION = BRIDGE_PROTOCOL_VERSION;

  const audit = auditBridgeEnv(extraEnv);
  for (const [key, value] of Object.entries(audit.safeEnv)) {
    env[key] = value;
  }

  return env;
}
