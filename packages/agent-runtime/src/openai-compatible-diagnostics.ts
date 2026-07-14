import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseSecretReference, type CredentialStore } from '@openslack/credentials';
import type {
  AgentRuntimeDoctorCheck,
  AgentRuntimeDoctorStatus,
  AgentRuntimeReadiness,
} from './agent-runtime-doctor.js';
import {
  loadOpenAICompatibleRuntimeConfig,
  resolveRuntimeCredential,
} from './openai-compatible-runtime.js';
import { createOpenSlackAgentLauncher } from './launcher.js';
import { createRunStore } from './run-store.js';
import { readTranscript } from './transcript.js';
import {
  AGENT_RUNTIME_CONFIG_SCHEMA,
  readRuntimeConfigForMerge,
  writeRuntimeConfigAtomic,
} from './runtime-config-file.js';

export interface DiagnoseOpenAICompatibleRuntimeOptions {
  rootDir?: string;
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  probeEndpoint?: boolean;
  credentialStore?: CredentialStore;
}

export interface OpenAICompatibleRuntimeDoctorReport {
  provider: 'openai-compatible';
  status: AgentRuntimeDoctorStatus;
  readiness: AgentRuntimeReadiness;
  configSource: '.openslack.local/agent-runtime.json' | 'environment' | 'none';
  configPath: string;
  baseUrl?: string;
  model?: string;
  credentialRef?: string;
  timeoutMs?: number;
  checks: AgentRuntimeDoctorCheck[];
  remediations: string[];
}

export async function diagnoseOpenAICompatibleRuntime(
  options: DiagnoseOpenAICompatibleRuntimeOptions = {},
): Promise<OpenAICompatibleRuntimeDoctorReport> {
  const rootDir = options.rootDir ?? process.cwd();
  const configPath = options.configPath ?? join(rootDir, '.openslack.local', 'agent-runtime.json');
  const env = options.env ?? process.env;
  const configSource = existsSync(configPath)
    ? '.openslack.local/agent-runtime.json'
    : env.OPENSLACK_LLM_PROVIDER
      ? 'environment'
      : 'none';
  let config;
  try {
    config = loadOpenAICompatibleRuntimeConfig({ rootDir, configPath, env });
  } catch {
    return doctorFailure({
      configPath,
      configSource,
      readiness: 'misconfigured',
      detail: 'OpenAI-compatible runtime configuration is invalid.',
      remediation: 'Fix the non-secret provider configuration and credentialRef.',
    });
  }
  if (!config) {
    return doctorFailure({
      configPath,
      configSource: 'none',
      readiness: 'not_configured',
      detail: 'OpenAI-compatible runtime is not configured.',
      remediation: 'Run openslack agent-runtime setup openai-compatible in preview mode.',
    });
  }

  const checks: AgentRuntimeDoctorCheck[] = [
    { name: 'config', status: 'PASS', detail: `Using ${configSource}` },
    { name: 'base-url', status: 'PASS', detail: config.baseUrl },
    { name: 'model', status: 'PASS', detail: config.model },
    { name: 'credential-ref', status: 'PASS', detail: config.credentialRef },
  ];
  let credential: string;
  try {
    credential = resolveRuntimeCredential(config.credentialRef, env, options.credentialStore);
    checks.push({
      name: 'credential-resolution',
      status: 'PASS',
      detail: 'Credential reference resolves at the transport boundary.',
    });
  } catch {
    checks.push({
      name: 'credential-resolution',
      status: 'FAIL',
      detail: 'Credential reference does not resolve.',
    });
    return reportFromChecks(config, configPath, configSource, 'misconfigured', checks, [
      'Make the configured credential reference available through its env or native keychain backend.',
    ]);
  }

  if (options.probeEndpoint === false) {
    checks.push({
      name: 'endpoint',
      status: 'WARN',
      detail: 'Endpoint probe skipped; run agent-runtime smoke for live evidence.',
    });
    return reportFromChecks(config, configPath, configSource, 'ready', checks, []);
  }

  const probe = await probeModelsEndpoint(
    options.fetchImpl ?? fetch,
    config.baseUrl,
    credential,
    Math.min(config.timeoutMs, 10_000),
  );
  checks.push({ name: 'endpoint', status: probe.status, detail: probe.detail });
  const readiness: AgentRuntimeReadiness =
    probe.kind === 'ready'
      ? 'ready'
      : probe.kind === 'credential'
        ? 'misconfigured'
        : 'unavailable';
  return reportFromChecks(config, configPath, configSource, readiness, checks, [
    ...(probe.kind === 'ready'
      ? []
      : probe.kind === 'credential'
        ? ['Verify that the referenced provider credential is valid for this endpoint.']
        : ['Verify endpoint availability, TLS, proxy, and network access, then retry.']),
  ]);
}

export interface SetupOpenAICompatibleRuntimeOptions {
  rootDir?: string;
  configPath?: string;
  baseUrl: string;
  model: string;
  credentialRef: string;
  timeoutMs?: number;
  maxTurns?: number;
  maxToolCalls?: number;
  maxOutputTokens?: number;
  maxResponseBytes?: number;
  maxToolResultBytes?: number;
  write?: boolean;
  env?: NodeJS.ProcessEnv;
  credentialStore?: CredentialStore;
}

export interface OpenAICompatibleRuntimeSetupReport {
  provider: 'openai-compatible';
  mode: 'dry-run' | 'write';
  status: 'PASS' | 'FAIL';
  readiness: AgentRuntimeReadiness;
  configPath: string;
  wroteConfig: boolean;
  configPreview: { providers: { 'openai-compatible': Record<string, unknown> } };
  checks: AgentRuntimeDoctorCheck[];
  remediations: string[];
}

export function setupOpenAICompatibleRuntime(
  options: SetupOpenAICompatibleRuntimeOptions,
): OpenAICompatibleRuntimeSetupReport {
  const rootDir = options.rootDir ?? process.cwd();
  const configPath = options.configPath ?? join(rootDir, '.openslack.local', 'agent-runtime.json');
  const config = compactObject({
    baseUrl: options.baseUrl.trim(),
    model: options.model.trim(),
    credentialRef: options.credentialRef.trim(),
    timeoutMs: options.timeoutMs ?? 60_000,
    maxTurns: options.maxTurns,
    maxToolCalls: options.maxToolCalls,
    maxOutputTokens: options.maxOutputTokens,
    maxResponseBytes: options.maxResponseBytes,
    maxToolResultBytes: options.maxToolResultBytes,
  });
  const checks = validateSetupConfig(config);
  const configPreview = { providers: { 'openai-compatible': config } };
  let wroteConfig = false;
  if (options.write && checks.every((check) => check.status !== 'FAIL')) {
    try {
      const existing = readRuntimeConfigForMerge(configPath);
      const providers = readRecord(existing.providers) ?? {};
      const merged = {
        ...existing,
        schema: AGENT_RUNTIME_CONFIG_SCHEMA,
        providers: { ...providers, 'openai-compatible': config },
      };
      writeRuntimeConfigAtomic(configPath, merged);
      wroteConfig = true;
    } catch {
      checks.push({
        name: 'write',
        status: 'FAIL',
        detail: 'Existing runtime config could not be safely merged.',
      });
    }
  }
  const status = checks.some((check) => check.status === 'FAIL') ? 'FAIL' : 'PASS';
  let readiness: AgentRuntimeReadiness = status === 'PASS' ? 'not_configured' : 'misconfigured';
  if (wroteConfig) {
    try {
      const loaded = loadOpenAICompatibleRuntimeConfig({
        rootDir,
        configPath,
        env: options.env ?? process.env,
      });
      if (!loaded) throw new Error('config unavailable');
      resolveRuntimeCredential(
        loaded.credentialRef,
        options.env ?? process.env,
        options.credentialStore,
      );
      readiness = 'ready';
    } catch {
      readiness = 'misconfigured';
    }
  }
  return {
    provider: 'openai-compatible',
    mode: options.write ? 'write' : 'dry-run',
    status,
    readiness,
    configPath,
    wroteConfig,
    configPreview,
    checks,
    remediations:
      status === 'FAIL'
        ? ['Fix the failed non-secret configuration checks and rerun setup.']
        : wroteConfig && readiness !== 'ready'
          ? [
              'Configuration written. Make the referenced credential available, then run agent-runtime doctor.',
            ]
          : wroteConfig
            ? ['Configuration and credential reference are ready. Run agent-runtime smoke.']
            : ['Preview passed. Re-run with --write to save the non-secret configuration.'],
  };
}

export interface RunOpenAICompatibleRuntimeSmokeOptions {
  rootDir?: string;
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  prompt?: string;
  credentialStore?: CredentialStore;
}

export interface OpenAICompatibleRuntimeSmokeReport {
  provider: 'openai-compatible';
  status: 'PASS' | 'FAIL';
  doctor: OpenAICompatibleRuntimeDoctorReport;
  runId?: string;
  terminalReason: 'completed' | 'failed' | 'doctor_failed';
  failureCode?: string;
  evidence: { runJson?: string; metadataJson?: string; transcriptJsonl?: string };
  checks: Array<{ name: string; status: 'PASS' | 'FAIL'; detail: string }>;
}

export async function runOpenAICompatibleRuntimeSmoke(
  options: RunOpenAICompatibleRuntimeSmokeOptions = {},
): Promise<OpenAICompatibleRuntimeSmokeReport> {
  const rootDir = options.rootDir ?? process.cwd();
  const doctor = await diagnoseOpenAICompatibleRuntime({
    ...options,
    rootDir,
    probeEndpoint: false,
  });
  if (doctor.status === 'FAIL') {
    return {
      provider: 'openai-compatible',
      status: 'FAIL',
      doctor,
      terminalReason: 'doctor_failed',
      evidence: {},
      checks: [{ name: 'doctor', status: 'FAIL', detail: `Runtime is ${doctor.readiness}` }],
    };
  }
  const store = createRunStore(rootDir);
  const launcher = createOpenSlackAgentLauncher({
    runStore: store,
    rootDir,
    openAICompatible: {
      configPath: options.configPath,
      env: options.env,
      fetchImpl: options.fetchImpl,
      credentialStore: options.credentialStore,
    },
  });
  let runId: string | undefined;
  try {
    const result = await launcher(
      options.prompt ??
        'Return JSON with a short summary confirming read-only runtime connectivity.',
      {
        label: 'openai-compatible-smoke',
        phase: 'agent-runtime-smoke',
        budget: { tokens: 512 },
        schema: {
          type: 'object',
          properties: { summary: { type: 'string' } },
          required: ['summary'],
        },
        resolvedAgentConfig: {
          agentId: 'openai-compatible-smoke',
          source: 'agent-runtime-smoke',
          runtimeProvider: 'openai-compatible',
          permissionMode: 'plan',
        },
      },
    );
    runId = result.runId;
    return buildOpenAISmokeReport(rootDir, doctor, runId, 'PASS', 'completed');
  } catch (error) {
    runId = store.listRuns().at(0)?.runId;
    return buildOpenAISmokeReport(
      rootDir,
      doctor,
      runId,
      'FAIL',
      'failed',
      error && typeof error === 'object' && 'code' in error
        ? String((error as { code: unknown }).code)
        : 'EXECUTION_FAILED',
    );
  }
}

function buildOpenAISmokeReport(
  rootDir: string,
  doctor: OpenAICompatibleRuntimeDoctorReport,
  runId: string | undefined,
  status: 'PASS' | 'FAIL',
  terminalReason: 'completed' | 'failed',
  failureCode?: string,
): OpenAICompatibleRuntimeSmokeReport {
  const runDir = runId ? join(rootDir, '.openslack.local', 'agents', 'runs', runId) : undefined;
  const evidence = runDir
    ? {
        runJson: join(runDir, 'run.json'),
        metadataJson: join(runDir, 'metadata.json'),
        transcriptJsonl: join(runDir, 'transcript.jsonl'),
      }
    : {};
  const transcript = runId ? readTranscript(runId, rootDir) : [];
  return {
    provider: 'openai-compatible',
    status,
    doctor,
    runId,
    terminalReason,
    failureCode,
    evidence,
    checks: [
      { name: 'doctor', status: doctor.status, detail: `Runtime is ${doctor.readiness}` },
      {
        name: 'terminal-event',
        status: transcript.some((event) => event.type === 'complete' || event.type === 'fail')
          ? 'PASS'
          : 'FAIL',
        detail: 'Run transcript contains terminal evidence.',
      },
      {
        name: 'evidence-files',
        status:
          evidence.runJson &&
          evidence.metadataJson &&
          evidence.transcriptJsonl &&
          existsSync(evidence.runJson) &&
          existsSync(evidence.metadataJson) &&
          existsSync(evidence.transcriptJsonl)
            ? 'PASS'
            : 'FAIL',
        detail: runId ? `Run evidence recorded for ${runId}.` : 'No run evidence recorded.',
      },
    ],
  };
}

async function probeModelsEndpoint(
  fetchImpl: typeof fetch,
  baseUrl: string,
  credential: string,
  timeoutMs: number,
): Promise<{
  kind: 'ready' | 'credential' | 'unavailable';
  status: 'PASS' | 'FAIL' | 'WARN';
  detail: string;
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const root = baseUrl.endsWith('/chat/completions')
      ? baseUrl.slice(0, -'/chat/completions'.length)
      : baseUrl;
    const response = await fetchImpl(`${root}/models`, {
      method: 'GET',
      headers: { authorization: `Bearer ${credential}` },
      signal: controller.signal,
    });
    try {
      await response.body?.cancel();
    } catch {
      // The status code is sufficient diagnostic evidence.
    }
    if (response.ok) return { kind: 'ready', status: 'PASS', detail: 'Endpoint is reachable.' };
    if (response.status === 404 || response.status === 405) {
      return {
        kind: 'ready',
        status: 'WARN',
        detail:
          'Endpoint is reachable but does not expose /models; run smoke for execution evidence.',
      };
    }
    if (response.status === 401 || response.status === 403) {
      return { kind: 'credential', status: 'FAIL', detail: 'Endpoint rejected the credential.' };
    }
    return {
      kind: 'unavailable',
      status: 'FAIL',
      detail: `Endpoint returned HTTP ${response.status}.`,
    };
  } catch {
    return { kind: 'unavailable', status: 'FAIL', detail: 'Endpoint probe failed or timed out.' };
  } finally {
    clearTimeout(timer);
  }
}

function doctorFailure(input: {
  configPath: string;
  configSource: OpenAICompatibleRuntimeDoctorReport['configSource'];
  readiness: AgentRuntimeReadiness;
  detail: string;
  remediation: string;
}): OpenAICompatibleRuntimeDoctorReport {
  return {
    provider: 'openai-compatible',
    status: 'FAIL',
    readiness: input.readiness,
    configSource: input.configSource,
    configPath: input.configPath,
    checks: [{ name: 'config', status: 'FAIL', detail: input.detail }],
    remediations: [input.remediation],
  };
}

function reportFromChecks(
  config: NonNullable<ReturnType<typeof loadOpenAICompatibleRuntimeConfig>>,
  configPath: string,
  configSource: OpenAICompatibleRuntimeDoctorReport['configSource'],
  readiness: AgentRuntimeReadiness,
  checks: AgentRuntimeDoctorCheck[],
  remediations: string[],
): OpenAICompatibleRuntimeDoctorReport {
  return {
    provider: 'openai-compatible',
    status: readiness === 'ready' ? 'PASS' : 'FAIL',
    readiness,
    configSource,
    configPath,
    baseUrl: config.baseUrl,
    model: config.model,
    credentialRef: config.credentialRef,
    timeoutMs: config.timeoutMs,
    checks,
    remediations,
  };
}

function validateSetupConfig(config: Record<string, unknown>): AgentRuntimeDoctorCheck[] {
  const checks: AgentRuntimeDoctorCheck[] = [];
  let baseUrlValid = false;
  try {
    const parsed = new URL(String(config.baseUrl ?? ''));
    const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
    baseUrlValid =
      !parsed.username &&
      !parsed.password &&
      (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && loopback));
  } catch {
    baseUrlValid = false;
  }
  checks.push({
    name: 'base-url',
    status: baseUrlValid ? 'PASS' : 'FAIL',
    detail: baseUrlValid
      ? String(config.baseUrl)
      : 'Use HTTPS, or loopback HTTP, without URL credentials.',
  });
  const modelValid =
    typeof config.model === 'string' && config.model.length > 0 && config.model.length <= 200;
  checks.push({
    name: 'model',
    status: modelValid ? 'PASS' : 'FAIL',
    detail: modelValid ? String(config.model) : 'Model is required.',
  });
  const credentialRef = typeof config.credentialRef === 'string' ? config.credentialRef : '';
  let canonicalCredentialRef: string | undefined;
  try {
    canonicalCredentialRef = parseSecretReference(credentialRef).canonical;
  } catch {
    canonicalCredentialRef = undefined;
  }
  checks.push({
    name: 'credential-ref',
    status: canonicalCredentialRef ? 'PASS' : 'FAIL',
    detail:
      canonicalCredentialRef ??
      'Use an env:NAME or keychain:SERVICE/ACCOUNT reference; raw credentials are forbidden.',
  });
  const limits: Array<[string, number, number]> = [
    ['timeoutMs', 100, 600_000],
    ['maxTurns', 1, 32],
    ['maxToolCalls', 1, 128],
    ['maxOutputTokens', 1, 128_000],
    ['maxResponseBytes', 1, 16 * 1024 * 1024],
    ['maxToolResultBytes', 256, 2 * 1024 * 1024],
  ];
  for (const [key, minimum, maximum] of limits) {
    if (!(key in config)) continue;
    const value = config[key];
    const valid =
      Number.isInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
    checks.push({
      name: key,
      status: valid ? 'PASS' : 'FAIL',
      detail: valid ? String(value) : `${key} must be an integer from ${minimum} to ${maximum}.`,
    });
  }
  return checks;
}

function compactObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
