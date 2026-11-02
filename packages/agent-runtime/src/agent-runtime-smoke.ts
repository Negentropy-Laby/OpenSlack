import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AbyRuntimeDoctorReport, DiagnoseAbyRuntimeOptions } from './agent-runtime-doctor.js';
import { diagnoseAbyRuntime } from './agent-runtime-doctor.js';
import { BridgeAdapterError } from './bridge-adapter.js';
import { createBridgeRuntimeResolver } from './bridge-runtime-resolver.js';
import { createOpenSlackAgentLauncher, readOwnedRunIdentity } from './launcher.js';
import { createRunStore, observeRun } from './run-store.js';
import { readTranscript } from './transcript.js';

export type AbyRuntimeSmokeStatus = 'PASS' | 'FAIL';

export interface RunAbyRuntimeSmokeOptions {
  rootDir?: string;
  env?: NodeJS.ProcessEnv;
  agentId?: string;
  prompt?: string;
  availableMcpServers?: string[];
  diagnose?: (options: DiagnoseAbyRuntimeOptions) => AbyRuntimeDoctorReport;
}

export interface AbyRuntimeSmokeReport {
  provider: 'aby';
  status: AbyRuntimeSmokeStatus;
  agentId: string;
  doctor: AbyRuntimeDoctorReport;
  runId?: string;
  terminalReason: 'completed' | 'failed' | 'doctor_failed';
  errorKind?: string;
  errorMessage?: string;
  stderrSummary?: string;
  evidence: {
    runJson?: string;
    metadataJson?: string;
    transcriptJsonl?: string;
  };
  checks: Array<{ name: string; status: 'PASS' | 'FAIL'; detail: string }>;
}

export async function runAbyRuntimeSmoke(
  options: RunAbyRuntimeSmokeOptions = {},
): Promise<AbyRuntimeSmokeReport> {
  const rootDir = options.rootDir ?? process.cwd();
  const env = options.env ?? process.env;
  const agentId = options.agentId ?? 'anthropic_architect_aby';
  const doctor = (options.diagnose ?? diagnoseAbyRuntime)({ rootDir, env });

  if (doctor.status === 'FAIL') {
    return {
      provider: 'aby',
      status: 'FAIL',
      agentId,
      doctor,
      terminalReason: 'doctor_failed',
      errorKind: 'doctor_failed',
      errorMessage: doctor.remediation,
      evidence: {},
      checks: [
        {
          name: 'doctor',
          status: 'FAIL',
          detail: 'Aby runtime doctor failed; smoke did not start a run',
        },
      ],
    };
  }

  const store = createRunStore(rootDir, { sweepOrphans: false });
  const launcher = createOpenSlackAgentLauncher({
    runStore: store,
    rootDir,
    availableMcpServers: options.availableMcpServers ?? [],
    bridgeRuntimeResolver: createBridgeRuntimeResolver({ rootDir, env }),
  });

  let runId: string | undefined;
  try {
    const result = await launcher<Record<string, unknown>>(
      options.prompt ?? 'OpenSlack Aby smoke: confirm bridge connectivity in read-only plan mode.',
      {
        label: agentId,
        phase: 'agent-runtime-smoke',
        resolvedAgentConfig: {
          agentId,
          source: 'agent-runtime-smoke',
          runtime: 'aby_assistant',
          bridgeMode: 'process',
          permissionMode: 'plan',
        },
        correlationId: 'agent-runtime-smoke',
      },
    );
    runId = result.runId;
    return buildSmokeReport({
      status: 'PASS',
      rootDir,
      agentId,
      doctor,
      runId,
      terminalReason: 'completed',
    });
  } catch (err) {
    const bridgeError = err instanceof BridgeAdapterError ? err : null;
    const rejectedRunId = readOwnedRunIdentity(err);
    runId = runId ?? rejectedRunId;
    return buildSmokeReport({
      status: 'FAIL',
      rootDir,
      agentId,
      doctor,
      runId,
      terminalReason: 'failed',
      errorKind: bridgeError?.kind ?? (err instanceof Error ? err.name : 'unknown'),
      errorMessage: err instanceof Error ? err.message : String(err),
      stderrSummary: readOptionalString((err as { stderrSummary?: unknown })?.stderrSummary),
    });
  }
}

function buildSmokeReport(input: {
  status: AbyRuntimeSmokeStatus;
  rootDir: string;
  agentId: string;
  doctor: AbyRuntimeDoctorReport;
  runId?: string;
  terminalReason: 'completed' | 'failed';
  errorKind?: string;
  errorMessage?: string;
  stderrSummary?: string;
}): AbyRuntimeSmokeReport {
  const evidence = input.runId ? buildEvidencePaths(input.rootDir, input.runId) : {};
  const observation = input.runId ? observeRun(input.runId, input.rootDir) : undefined;
  let transcript: ReturnType<typeof readTranscript> = [];
  let transcriptUnavailable = false;
  try { if (input.runId && observation?.kind === 'ready') transcript = readTranscript(input.runId, input.rootDir); }
  catch { transcriptUnavailable = true; }
  const checks = [
    ...(observation?.kind === 'unavailable' || observation?.kind === 'missing' || transcriptUnavailable ? [{ name: 'run-storage-availability', status: 'FAIL' as const,
      detail: `This run's evidence is unavailable: ${observation?.kind === 'unavailable' ? observation.reason : observation?.kind === 'missing' ? 'missing' : 'transcript-unavailable'}. Inspect without replay.` }] : []),
    {
      name: 'doctor',
      status: input.doctor.status,
      detail: `Aby runtime doctor ${input.doctor.status}`,
    },
    {
      name: 'bridge_session_started',
      status: transcript.some(
        (event) => event.type === 'progress' && event.data.step === 'bridge_session_started',
      )
        ? 'PASS'
        : 'FAIL',
      detail: 'Transcript contains bridge_session_started',
    },
    {
      name: 'terminal_event',
      status: transcript.some((event) => event.type === 'complete' || event.type === 'fail')
        ? 'PASS'
        : 'FAIL',
      detail: 'Transcript contains complete or fail event',
    },
    {
      name: 'evidence_files',
      status: evidenceFilesExist(evidence) ? 'PASS' : 'FAIL',
      detail: input.runId ? `Run evidence for ${input.runId}` : 'No run was created by this invocation',
    },
  ] as Array<{ name: string; status: 'PASS' | 'FAIL'; detail: string }>;

  return {
    provider: 'aby',
    status: input.status === 'PASS' && checks.every(check => check.status === 'PASS') ? 'PASS' : 'FAIL',
    agentId: input.agentId,
    doctor: input.doctor,
    runId: input.runId,
    terminalReason: input.terminalReason,
    errorKind: input.errorKind,
    errorMessage: input.errorMessage,
    stderrSummary: input.stderrSummary ?? 'not captured',
    evidence,
    checks,
  };
}

function buildEvidencePaths(
  rootDir: string,
  runId: string,
): Required<AbyRuntimeSmokeReport['evidence']> {
  const runDir = join(rootDir, '.openslack.local', 'agents', 'runs', runId);
  return {
    runJson: join(runDir, 'run.json'),
    metadataJson: join(runDir, 'metadata.json'),
    transcriptJsonl: join(runDir, 'transcript.jsonl'),
  };
}

function evidenceFilesExist(evidence: AbyRuntimeSmokeReport['evidence']): boolean {
  return Boolean(
    evidence.runJson &&
    evidence.metadataJson &&
    evidence.transcriptJsonl &&
    existsSync(evidence.runJson) &&
    existsSync(evidence.metadataJson) &&
    existsSync(evidence.transcriptJsonl),
  );
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
