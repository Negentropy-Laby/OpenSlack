import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AbyRuntimeDoctorReport, AgentRunState } from '@openslack/agent-runtime';

export interface AgentRuntimeDiagnosticsCheckViewModel {
  name: string;
  status: 'PASS' | 'FAIL' | 'WARN';
  detail: string;
}

export interface AgentRuntimeSmokeSummaryViewModel {
  runId: string;
  status: string;
  startedAt: string;
  runJson: string;
  metadataJson: string;
  transcriptJsonl: string;
}

export interface AgentRuntimeDiagnosticsViewModel {
  provider: string;
  status: 'PASS' | 'FAIL';
  readiness?: 'not_configured' | 'misconfigured' | 'unavailable' | 'ready';
  configSource: string;
  configPath: string;
  root: string;
  command: string;
  args: string[];
  timeoutMs: string;
  safeEnvAllowed: string[];
  safeEnvRejected: string[];
  checks: AgentRuntimeDiagnosticsCheckViewModel[];
  remediations: string[];
  lastSmokeRun?: AgentRuntimeSmokeSummaryViewModel;
}

export function mapAbyRuntimeDoctorToViewModel(
  report: AbyRuntimeDoctorReport,
  options: { rootDir?: string; smokeAgentId?: string } = {},
): AgentRuntimeDiagnosticsViewModel {
  return {
    provider: report.provider,
    status: report.status,
    readiness: report.readiness,
    configSource: report.configSource,
    configPath: report.configPath,
    root: report.resolvedRoot ?? report.root ?? 'not configured',
    command: report.command ?? 'not configured',
    args: report.args,
    timeoutMs: report.timeoutMs !== undefined ? `${report.timeoutMs}ms` : 'not recorded',
    safeEnvAllowed: report.env.allowedKeys,
    safeEnvRejected: report.env.rejectedKeys,
    checks: report.checks,
    remediations: report.remediations.length > 0
      ? report.remediations
      : report.remediation.split('\n').filter((line) => line.trim()),
    lastSmokeRun: options.rootDir
      ? findLastSmokeRun(options.rootDir, options.smokeAgentId ?? 'anthropic_architect_aby')
      : undefined,
  };
}

function findLastSmokeRun(
  rootDir: string,
  agentId: string,
): AgentRuntimeSmokeSummaryViewModel | undefined {
  for (const run of listRuns(rootDir).filter((item) => item.agentId === agentId)) {
    if (!isSmokeRun(rootDir, run)) continue;
    const runDir = join(rootDir, '.openslack.local', 'agents', 'runs', run.runId);
    return {
      runId: run.runId,
      status: run.status,
      startedAt: run.startedAt,
      runJson: join(runDir, 'run.json'),
      metadataJson: join(runDir, 'metadata.json'),
      transcriptJsonl: join(runDir, 'transcript.jsonl'),
    };
  }
  return undefined;
}

function listRuns(rootDir: string): AgentRunState[] {
  const runsDir = join(rootDir, '.openslack.local', 'agents', 'runs');
  if (!existsSync(runsDir)) return [];
  const runs: AgentRunState[] = [];
  for (const entry of readdirSync(runsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('RUN-')) continue;
    const runPath = join(runsDir, entry.name, 'run.json');
    if (!existsSync(runPath)) continue;
    try {
      const parsed = JSON.parse(readFileSync(runPath, 'utf-8')) as AgentRunState;
      if (parsed.runId === entry.name) runs.push(parsed);
    } catch {
      // Ignore corrupted local run evidence in the diagnostics view.
    }
  }
  return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

function isSmokeRun(rootDir: string, run: AgentRunState): boolean {
  const metadataPath = join(rootDir, '.openslack.local', 'agents', 'runs', run.runId, 'metadata.json');
  if (!existsSync(metadataPath)) return false;
  try {
    const parsed = JSON.parse(readFileSync(metadataPath, 'utf-8')) as {
      resolvedConfig?: { source?: string };
    };
    return parsed.resolvedConfig?.source === 'agent-runtime-smoke';
  } catch {
    return false;
  }
}
