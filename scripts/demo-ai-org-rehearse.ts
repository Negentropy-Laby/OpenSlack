import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { GitHubClient } from '../packages/github/src/index.js';

const REPOSITORY_ROOT = resolve(import.meta.dirname, '..');
const EXAMPLE_ROOT = join(REPOSITORY_ROOT, 'examples', 'ai-organization-demo');
const RECORDED_RUN_ROOT = join(EXAMPLE_ROOT, 'recorded-run');
const WORKFLOW_PATH = join(REPOSITORY_ROOT, '.openslack', 'workflows', 'ai-org-transformation.ts');
const WORKFLOW_RESULT_SCHEMA_PATH = join(EXAMPLE_ROOT, 'schemas', 'workflow-result.schema.json');
const MAX_WORKFLOW_RESULT_BYTES = 256 * 1024;
const MAX_WORKFLOW_STRING_LENGTH = 8_000;
const MAX_WORKFLOW_ARRAY_ITEMS = 32;
const MAX_WORKFLOW_OBJECT_KEYS = 32;
const MAX_WORKFLOW_DEPTH = 10;
const MAX_FIXTURE_JSON_BYTES = 64 * 1024;
const MAX_FIXTURE_ARTIFACT_BYTES = 8 * 1024;
const ANNUAL_VALUE_CNY = 3_840_000;
const SIMPLE_ANNUAL_ROI_RATE = 6.68;
const OUTCOME_ASSUMPTION_REFS = [
  'assumption:input/outcome-assumptions.yaml@2026-07-26.2#annualValueCny',
  'assumption:input/outcome-assumptions.yaml@2026-07-26.2#simpleAnnualRoiRate',
] as const;

export const REHEARSAL_ARTIFACT_FILES = [
  'executive-summary.md',
  'opportunity-matrix.md',
  'data-system-map.md',
  'roi-model.md',
  'target-architecture.md',
  'risk-register.md',
  '90-day-plan.md',
] as const;

const LIVE_AGENT_TYPES = [
  'business-discovery-agent',
  'data-inventory-agent',
  'solution-architect-agent',
  'roi-analyst-agent',
  'risk-reviewer-agent',
  'delivery-planner-agent',
] as const;

const CHILD_TASKS = [
  ['组织流程盘点', 'business-discovery-agent'],
  ['数据系统盘点', 'data-inventory-agent'],
  ['场景价值评估', 'roi-analyst-agent'],
  ['ROI 基线', 'roi-analyst-agent'],
  ['技术方案', 'solution-architect-agent'],
  ['风险与合规', 'risk-reviewer-agent'],
  ['90 天交付计划', 'delivery-planner-agent'],
] as const;

export interface RehearsalOptions {
  mode: 'fixture' | 'live';
  outDir: string;
  repo?: string;
  execute: boolean;
}

export interface FixtureRehearsalResult {
  schema: 'openslack.ai_org_demo_rehearsal.v1';
  status: 'completed';
  mode: 'fixture';
  evidenceLevel: 'LOCAL_PASS';
  outputDirectory: string;
  artifactFiles: string[];
}

export interface LiveRehearsalResult {
  schema: 'openslack.ai_org_demo_rehearsal.v1';
  status: 'completed';
  mode: 'live';
  evidenceLevel: 'GITHUB_REHEARSED';
  repository: string;
  workflowRunId: string;
  branch: string;
  headCommit: string;
  parentIssue: number;
  childIssues: number[];
  draftPullRequest: number;
  artifactFiles: string[];
}

export class RehearsalBlockedError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'RehearsalBlockedError';
    this.code = code;
  }
}

export function parseRehearsalArgs(args: string[], cwd = process.cwd()): RehearsalOptions {
  let mode: 'fixture' | 'live' | undefined;
  let outDir: string | undefined;
  let repo: string | undefined;
  let execute = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--execute') {
      execute = true;
      continue;
    }
    if (arg === '--mode' || arg === '--out' || arg === '--repo') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        throw new RehearsalBlockedError('ARGUMENT_VALUE_REQUIRED', `${arg} requires a value.`);
      }
      if (arg === '--mode') {
        if (value !== 'fixture' && value !== 'live') {
          throw new RehearsalBlockedError('MODE_INVALID', '--mode must be fixture or live.');
        }
        mode = value;
      } else if (arg === '--out') {
        outDir = resolve(cwd, value);
      } else {
        repo = value;
      }
      index += 1;
      continue;
    }
    throw new RehearsalBlockedError('ARGUMENT_UNKNOWN', `Unknown argument: ${arg}`);
  }

  if (!mode) {
    throw new RehearsalBlockedError('MODE_REQUIRED', '--mode fixture|live is required.');
  }
  if (!outDir) {
    throw new RehearsalBlockedError('OUTPUT_REQUIRED', '--out <directory> is required.');
  }
  if (mode === 'fixture' && (repo || execute)) {
    throw new RehearsalBlockedError(
      'FIXTURE_SIDE_EFFECT_ARGUMENT',
      'Fixture mode rejects --repo and --execute.',
    );
  }
  if (mode === 'live') {
    if (!repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
      throw new RehearsalBlockedError(
        'LIVE_REPOSITORY_REQUIRED',
        'Live mode requires --repo owner/name.',
      );
    }
    if (!execute) {
      throw new RehearsalBlockedError(
        'LIVE_EXECUTE_REQUIRED',
        'Live mode requires the explicit --execute flag.',
      );
    }
  }

  return { mode, outDir, repo, execute };
}

function prepareEmptyOutputDirectory(outDir: string): void {
  if (existsSync(outDir)) {
    if (readdirSync(outDir).length > 0) {
      throw new RehearsalBlockedError(
        'OUTPUT_NOT_EMPTY',
        'The rehearsal output directory must be empty.',
      );
    }
  } else {
    mkdirSync(outDir, { recursive: true });
  }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function runFixtureRehearsal(
  options: RehearsalOptions,
  recordedRunRoot = RECORDED_RUN_ROOT,
): FixtureRehearsalResult {
  if (options.mode !== 'fixture') {
    throw new RehearsalBlockedError('FIXTURE_MODE_REQUIRED', 'Expected fixture mode.');
  }
  const fixture = loadAndValidateRecordedFixture(recordedRunRoot);
  prepareEmptyOutputDirectory(options.outDir);
  const artifactOut = join(options.outDir, 'artifacts');
  mkdirSync(artifactOut, { recursive: true });

  for (const filename of REHEARSAL_ARTIFACT_FILES) {
    writeFileSync(join(artifactOut, filename), fixture.artifacts.get(filename)!, 'utf8');
  }
  writeFileSync(join(options.outDir, 'manifest.json'), fixture.manifestText, 'utf8');
  writeFileSync(join(options.outDir, 'projection.json'), fixture.projectionText, 'utf8');

  const result: FixtureRehearsalResult = {
    schema: 'openslack.ai_org_demo_rehearsal.v1',
    status: 'completed',
    mode: 'fixture',
    evidenceLevel: 'LOCAL_PASS',
    outputDirectory: options.outDir,
    artifactFiles: [...REHEARSAL_ARTIFACT_FILES],
  };
  writeJson(join(options.outDir, 'rehearsal-result.json'), result);
  return result;
}

interface CommandResult {
  stdout: string;
}

interface RepositoryTarget {
  owner: string;
  repo: string;
}

export function resolveAndAssertOriginPushTarget(options: {
  explicitRepo: string;
  runGit(args: string[]): string;
  parseRepository(spec: string): RepositoryTarget | null;
}): RepositoryTarget {
  const output = options.runGit(['remote', 'get-url', '--push', '--all', 'origin']);
  const pushUrls = output
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (pushUrls.length !== 1) {
    throw new RehearsalBlockedError(
      'DELIVERY_PUSH_TARGET_COUNT_INVALID',
      'Live rehearsal requires exactly one configured origin push URL.',
    );
  }
  const pushTarget = options.parseRepository(pushUrls[0]);
  const explicitTarget = options.parseRepository(options.explicitRepo);
  assertLiveRepositoryTarget(pushTarget, explicitTarget);
  return pushTarget!;
}

export function assertLiveRepositoryTarget(
  origin: RepositoryTarget | null,
  explicit: RepositoryTarget | null,
): void {
  if (
    !origin ||
    !explicit ||
    origin.owner.toLowerCase() !== explicit.owner.toLowerCase() ||
    origin.repo.toLowerCase() !== explicit.repo.toLowerCase()
  ) {
    throw new RehearsalBlockedError(
      'DELIVERY_TARGET_MISMATCH',
      'The explicit rehearsal repository must match the origin push target.',
    );
  }
}

export function assertLiveMainSynchronized(localMain: string, remoteMain: string): void {
  if (!/^[0-9a-f]{40}$/.test(remoteMain) || localMain !== remoteMain) {
    throw new RehearsalBlockedError(
      'LOCAL_MAIN_STALE',
      'Local main must match the named repository current main before live rehearsal.',
    );
  }
}

export function assertDeliveryHeadSynchronized(
  branchSha: string | undefined,
  prHeadSha: string | undefined,
  expectedHead?: string,
): { branchSha: string; prHeadSha: string } {
  if (
    !branchSha ||
    !prHeadSha ||
    !/^[0-9a-f]{40}$/.test(branchSha) ||
    !/^[0-9a-f]{40}$/.test(prHeadSha) ||
    branchSha !== prHeadSha ||
    (expectedHead !== undefined && branchSha !== expectedHead)
  ) {
    throw new RehearsalBlockedError(
      expectedHead === undefined ? 'DELIVERY_EVIDENCE_INVALID' : 'DELIVERY_HEAD_STALE',
      expectedHead === undefined
        ? 'Governed delivery did not return synchronized PR head evidence.'
        : 'The governed draft PR head does not match the rehearsal commit.',
    );
  }
  return { branchSha, prHeadSha };
}

function runCommand(command: string, args: string[], cwd = REPOSITORY_ROOT): CommandResult {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new RehearsalBlockedError(
      'COMMAND_FAILED',
      `A governed rehearsal command failed: ${basename(command)}.`,
    );
  }
  return { stdout: String(result.stdout ?? '').trim() };
}

function assertLiveAgentRegistry(): void {
  const registryRoot = join(REPOSITORY_ROOT, '.openslack', 'agents', 'registry');
  for (const agentType of LIVE_AGENT_TYPES) {
    const registryPath = join(registryRoot, `${agentType}.yaml`);
    if (!existsSync(registryPath)) {
      throw new RehearsalBlockedError(
        'LIVE_AGENT_REGISTRY_MISSING',
        `Live rehearsal requires the separately reviewed agent registry entry: ${agentType}.`,
      );
    }
  }
}

function loadScenario(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(EXAMPLE_ROOT, 'input', 'manufacturing-90-day.json'), 'utf8'),
  ) as Record<string, unknown>;
}

function assertSafeStructuredValue(value: unknown, label: string): void {
  let serialized: string;
  try {
    const json = JSON.stringify(value);
    if (typeof json !== 'string') throw new Error('not serializable');
    serialized = json;
  } catch {
    throw new RehearsalBlockedError(
      'WORKFLOW_RESULT_NOT_SERIALIZABLE',
      `${label} is not JSON serializable.`,
    );
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_WORKFLOW_RESULT_BYTES) {
    throw new RehearsalBlockedError(
      'WORKFLOW_RESULT_TOO_LARGE',
      `${label} exceeds the materialization size boundary.`,
    );
  }
  const sensitivePatterns = [
    /\bbearer\s+[a-z0-9._~+/=-]{8,}/i,
    /\bbasic\s+[a-z0-9+/=]{8,}/i,
    /\b(?:ghp_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,})\b/i,
    /\bxox[a-z]-[a-z0-9-]{10,}\b/i,
    /-----BEGIN (?:(?:RSA|EC|DSA|OPENSSH|ENCRYPTED) )?PRIVATE KEY-----/i,
    /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|set-cookie|password|passwd|client[_-]?secret)\b["']?\s*[:=]\s*[^\s,;]+/i,
  ];
  const sensitiveFieldPattern =
    /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|set-cookie|password|passwd|client[_-]?secret)$/i;
  const visit = (candidate: unknown, depth: number): void => {
    if (depth > MAX_WORKFLOW_DEPTH) {
      throw new RehearsalBlockedError(
        'WORKFLOW_RESULT_TOO_DEEP',
        `${label} exceeds the materialization depth boundary.`,
      );
    }
    if (typeof candidate === 'string') {
      if (candidate.length > MAX_WORKFLOW_STRING_LENGTH) {
        throw new RehearsalBlockedError(
          'WORKFLOW_RESULT_STRING_TOO_LONG',
          `${label} contains an oversized string.`,
        );
      }
      if (sensitivePatterns.some((pattern) => pattern.test(candidate))) {
        throw new RehearsalBlockedError(
          'WORKFLOW_RESULT_SENSITIVE',
          `${label} contains blocked credential-like material.`,
        );
      }
      return;
    }
    if (Array.isArray(candidate)) {
      if (candidate.length > MAX_WORKFLOW_ARRAY_ITEMS) {
        throw new RehearsalBlockedError(
          'WORKFLOW_RESULT_ARRAY_TOO_LARGE',
          `${label} contains an oversized array.`,
        );
      }
      candidate.forEach((item) => visit(item, depth + 1));
      return;
    }
    if (candidate !== null && typeof candidate === 'object') {
      const entries = Object.entries(candidate as Record<string, unknown>);
      if (entries.length > MAX_WORKFLOW_OBJECT_KEYS) {
        throw new RehearsalBlockedError(
          'WORKFLOW_RESULT_OBJECT_TOO_LARGE',
          `${label} contains too many object fields.`,
        );
      }
      for (const [key, item] of entries) {
        if (sensitiveFieldPattern.test(key)) {
          throw new RehearsalBlockedError(
            'WORKFLOW_RESULT_SENSITIVE',
            `${label} contains a blocked credential field.`,
          );
        }
        visit(item, depth + 1);
      }
    }
  };
  visit(value, 0);
}

interface ValidatedRecordedFixture {
  manifestText: string;
  projectionText: string;
  artifacts: Map<string, string>;
}

function readBoundedFixtureFile(path: string, maxBytes: number, label: string): string {
  let size: number;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) throw new Error('not a file');
    size = stat.size;
  } catch {
    throw new RehearsalBlockedError(
      'FIXTURE_SOURCE_INVALID',
      `${label} is missing or is not a regular file.`,
    );
  }
  if (size < 1 || size > maxBytes) {
    throw new RehearsalBlockedError(
      'FIXTURE_SOURCE_BOUNDS',
      `${label} must contain 1 through ${maxBytes} bytes.`,
    );
  }
  return readFileSync(path, 'utf8');
}

function parseFixtureJson(text: string, label: string): unknown {
  assertSafeStructuredValue(text, `${label} source`);
  try {
    const value = JSON.parse(text);
    assertSafeStructuredValue(value, label);
    return value;
  } catch (error) {
    if (error instanceof RehearsalBlockedError) throw error;
    throw new RehearsalBlockedError('FIXTURE_JSON_INVALID', `${label} is not valid JSON.`);
  }
}

export function loadAndValidateRecordedFixture(
  recordedRunRoot = RECORDED_RUN_ROOT,
): ValidatedRecordedFixture {
  const manifestText = readBoundedFixtureFile(
    join(recordedRunRoot, 'manifest.json'),
    MAX_FIXTURE_JSON_BYTES,
    'Recorded manifest',
  );
  const projectionText = readBoundedFixtureFile(
    join(recordedRunRoot, 'projection.json'),
    MAX_FIXTURE_JSON_BYTES,
    'Recorded projection',
  );
  const manifest = parseFixtureJson(manifestText, 'Recorded manifest') as Record<string, unknown>;
  const projection = parseFixtureJson(projectionText, 'Recorded projection') as Record<
    string,
    unknown
  >;
  const schemaRoot = join(EXAMPLE_ROOT, 'schemas');
  const recordedSchema = JSON.parse(
    readBoundedFixtureFile(
      join(schemaRoot, 'recorded-run.schema.json'),
      MAX_FIXTURE_JSON_BYTES,
      'Recorded manifest schema',
    ),
  );
  const projectionSchema = JSON.parse(
    readBoundedFixtureFile(
      join(schemaRoot, 'projection.schema.json'),
      MAX_FIXTURE_JSON_BYTES,
      'Recorded projection schema',
    ),
  );
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  const validateManifest = ajv.compile(recordedSchema);
  const validateProjection = ajv.compile(projectionSchema);
  if (!validateManifest(manifest)) {
    throw new RehearsalBlockedError(
      'FIXTURE_MANIFEST_SCHEMA_MISMATCH',
      'Recorded manifest does not match its closed schema.',
    );
  }
  if (!validateProjection(projection)) {
    throw new RehearsalBlockedError(
      'FIXTURE_PROJECTION_SCHEMA_MISMATCH',
      'Recorded projection does not match its closed schema.',
    );
  }
  if (manifest.mode !== 'fixture' || manifest.status !== 'completed') {
    throw new RehearsalBlockedError(
      'FIXTURE_MANIFEST_NOT_COMPLETED',
      'Recorded fixture manifest must be a completed fixture run.',
    );
  }
  if (projection.status !== 'completed' || projection.evidenceLevel !== 'LOCAL_PASS') {
    throw new RehearsalBlockedError(
      'FIXTURE_PROJECTION_NOT_LOCAL_PASS',
      'Recorded fixture projection must contain completed LOCAL_PASS evidence.',
    );
  }
  if (
    JSON.stringify(manifest.artifactFiles) !== JSON.stringify(REHEARSAL_ARTIFACT_FILES) ||
    JSON.stringify(projection.artifacts) !== JSON.stringify(REHEARSAL_ARTIFACT_FILES)
  ) {
    throw new RehearsalBlockedError(
      'FIXTURE_ARTIFACT_CONTRACT_MISMATCH',
      'Recorded fixture must lock the canonical seven artifact files and order.',
    );
  }
  const projectionOutcomes =
    projection.outcomes && typeof projection.outcomes === 'object'
      ? (projection.outcomes as Record<string, unknown>)
      : {};
  const annualValue =
    projectionOutcomes.annualValueCny && typeof projectionOutcomes.annualValueCny === 'object'
      ? (projectionOutcomes.annualValueCny as Record<string, unknown>).value
      : undefined;
  const manifestEvidence = Array.isArray(manifest.evidenceRefs) ? manifest.evidenceRefs : [];
  const projectionEvidence = Array.isArray(projection.evidenceRefs) ? projection.evidenceRefs : [];
  if (
    annualValue !== ANNUAL_VALUE_CNY ||
    !OUTCOME_ASSUMPTION_REFS.every(
      (reference) => manifestEvidence.includes(reference) && projectionEvidence.includes(reference),
    )
  ) {
    throw new RehearsalBlockedError(
      'FIXTURE_OUTCOME_CONTRACT_MISMATCH',
      `Recorded fixture must cite the versioned annual value and ${SIMPLE_ANNUAL_ROI_RATE} ROI assumptions.`,
    );
  }

  const artifactRoot = join(recordedRunRoot, 'artifacts');
  let actualArtifactFiles: string[];
  try {
    actualArtifactFiles = readdirSync(artifactRoot).sort();
  } catch {
    throw new RehearsalBlockedError(
      'FIXTURE_ARTIFACT_DIRECTORY_INVALID',
      'Recorded fixture artifact directory is missing.',
    );
  }
  const expectedSorted = [...REHEARSAL_ARTIFACT_FILES].sort();
  if (JSON.stringify(actualArtifactFiles) !== JSON.stringify(expectedSorted)) {
    throw new RehearsalBlockedError(
      'FIXTURE_ARTIFACT_SET_MISMATCH',
      'Recorded fixture artifact directory must contain exactly the canonical seven files.',
    );
  }
  const artifacts = new Map<string, string>();
  for (const filename of REHEARSAL_ARTIFACT_FILES) {
    const content = readBoundedFixtureFile(
      join(artifactRoot, filename),
      MAX_FIXTURE_ARTIFACT_BYTES,
      `Recorded artifact ${filename}`,
    );
    assertSafeStructuredValue(content, `Recorded artifact ${filename}`);
    artifacts.set(filename, content);
  }
  const roiArtifact = artifacts.get('roi-model.md')!;
  if (
    !roiArtifact.includes('CNY 3,840,000') ||
    !roiArtifact.includes(String(SIMPLE_ANNUAL_ROI_RATE)) ||
    !OUTCOME_ASSUMPTION_REFS.every((reference) => roiArtifact.includes(reference))
  ) {
    throw new RehearsalBlockedError(
      'FIXTURE_ROI_ARTIFACT_MISMATCH',
      'Recorded ROI artifact must match and cite the versioned annual value assumptions.',
    );
  }
  return { manifestText, projectionText, artifacts };
}

export function assertWorkflowResult(value: unknown): asserts value is {
  runId: string;
  artifacts: Array<{ filename: string; content: string }>;
} {
  if (!value || typeof value !== 'object') {
    throw new RehearsalBlockedError(
      'WORKFLOW_RESULT_INVALID',
      'The live workflow did not return a structured result.',
    );
  }
  assertSafeStructuredValue(value, 'The live workflow result');
  const workflowResultSchema = JSON.parse(readFileSync(WORKFLOW_RESULT_SCHEMA_PATH, 'utf8'));
  const validate = new Ajv2020({ strict: false }).compile(workflowResultSchema);
  if (!validate(value)) {
    throw new RehearsalBlockedError(
      'WORKFLOW_RESULT_SCHEMA_MISMATCH',
      'The live workflow result does not match the closed workflow result schema.',
    );
  }
  const result = value as Record<string, unknown>;
  const artifacts = result.artifacts;
  if (
    typeof result.runId !== 'string' ||
    !Array.isArray(artifacts) ||
    artifacts.length !== REHEARSAL_ARTIFACT_FILES.length
  ) {
    throw new RehearsalBlockedError(
      'WORKFLOW_RESULT_INVALID',
      'The live workflow result is missing its run ID or seven artifacts.',
    );
  }
  const filenames = artifacts.map((item) =>
    item && typeof item === 'object' ? String((item as Record<string, unknown>).filename) : '',
  );
  const contentIsValid = artifacts.every(
    (item) =>
      item !== null &&
      typeof item === 'object' &&
      typeof (item as Record<string, unknown>).content === 'string',
  );
  if (JSON.stringify(filenames) !== JSON.stringify(REHEARSAL_ARTIFACT_FILES) || !contentIsValid) {
    throw new RehearsalBlockedError(
      'WORKFLOW_ARTIFACT_CONTRACT_MISMATCH',
      'The live workflow returned an unexpected artifact set.',
    );
  }
}

async function createTaskIssue(
  client: GitHubClient,
  title: string,
  description: string,
  agentType: string,
  availableLabels: Set<string>,
): Promise<{ number: number; url: string; body: string }> {
  const { previewTaskCreation } = await import('../packages/github/src/index.js');
  const preview = previewTaskCreation({
    template: 'docs',
    title,
    description,
    agentType,
    allowedPaths: ['docs/demos/ai-organization/**'],
    requiredCapabilities: ['documentation', 'evidence-analysis'],
    outputContract: ['draft_pr'],
    successCriteria: ['Artifact is traceable to the fixed workflow run'],
  });
  if (preview.errors.length > 0) {
    throw new RehearsalBlockedError(
      'TASK_PREVIEW_INVALID',
      'A rehearsal task did not pass OpenSlack task preview validation.',
    );
  }
  const labels = preview.labels.filter((label) => availableLabels.has(label));
  for (const required of ['openslack:task', 'openslack:ready']) {
    if (!labels.includes(required)) {
      throw new RehearsalBlockedError(
        'TASK_LABELS_MISSING',
        `The rehearsal repository is missing required label ${required}.`,
      );
    }
  }
  const { data } = await client.octokit.issues.create({
    owner: client.owner,
    repo: client.repo,
    title: preview.issueTitle,
    body: preview.body,
    labels,
  });
  return { number: data.number, url: data.html_url, body: preview.body };
}

async function runConfiguredWorkflow(): Promise<{
  runId: string;
  artifacts: Array<{ filename: string; content: string }>;
}> {
  const { executeRun, loadWorkflow } = await import('../packages/workflows/src/index.js');
  const workflow = await loadWorkflow(WORKFLOW_PATH);
  const scenario = loadScenario();
  const result = await executeRun(workflow, {
    manifest: workflow.meta,
    args: {
      organization: scenario.organization,
      objective: scenario.objective,
      durationDays: scenario.durationDays,
      budgetCny: scenario.budgetCny,
    },
    budget: { tokens: 64000, costUsd: 2.5 },
    rootDir: REPOSITORY_ROOT,
    onConfirm: async () => false,
  });
  assertWorkflowResult(result);
  return result;
}

function createArtifactBranch(
  workflowResult: {
    runId: string;
    artifacts: Array<{ filename: string; content: string }>;
  },
  tempRoot: string,
): { worktree: string; branch: string; headCommit: string } {
  const suffix = workflowResult.runId.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  const branch = `demo/ai-org-${suffix}`;
  if (branch === 'main' || !/^demo\/ai-org-[a-z0-9-]+$/.test(branch)) {
    throw new RehearsalBlockedError('BRANCH_INVALID', 'Could not derive a safe demo branch.');
  }
  const worktree = join(tempRoot, 'worktree');
  runCommand('git', ['worktree', 'add', '-b', branch, worktree, 'main']);
  const artifactRoot = join(
    worktree,
    'docs',
    'demos',
    'ai-organization',
    'rehearsals',
    workflowResult.runId,
  );
  mkdirSync(artifactRoot, { recursive: true });
  for (const artifact of workflowResult.artifacts) {
    writeFileSync(join(artifactRoot, artifact.filename), artifact.content, 'utf8');
  }
  runCommand(
    'git',
    ['add', '--', `docs/demos/ai-organization/rehearsals/${workflowResult.runId}`],
    worktree,
  );
  runCommand('git', ['commit', '-m', 'docs: record AI organization rehearsal artifacts'], worktree);
  const headCommit = runCommand('git', ['rev-parse', 'HEAD'], worktree).stdout;
  if (!/^[0-9a-f]{40}$/.test(headCommit)) {
    throw new RehearsalBlockedError(
      'HEAD_COMMIT_INVALID',
      'The rehearsal branch did not produce an exact commit ID.',
    );
  }
  return { worktree, branch, headCommit };
}

function publishDraftPullRequest(options: {
  worktree: string;
  repo: string;
  branch: string;
  parentIssue: number;
  childIssues: number[];
}): { number: number; url: string; branchSha: string; prHeadSha: string } {
  const body = [
    '## AI organization rehearsal',
    '',
    `Parent Issue: #${options.parentIssue}`,
    `Child Issues: ${options.childIssues.map((number) => `#${number}`).join(', ')}`,
    '',
    'Module: Collaboration Layer',
    'Risk zone: Yellow',
    'Validation: fixed workflow contract and fixture validation',
    'Rollback: close the draft PR and remove the demo branch',
    'Human approval required: yes; the automation cannot approve this PR',
  ].join('\n');
  const commonArgs = [
    '--draft',
    '--title',
    'docs: rehearse manufacturing AI transformation pilot',
    '--body',
    body,
    '--base',
    'main',
    '--head',
    options.branch,
    '--repo',
    options.repo,
  ];
  const command =
    process.platform === 'win32'
      ? {
          executable: 'powershell',
          args: [
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            join(REPOSITORY_ROOT, 'scripts', 'bot-gh-pr-create.ps1'),
            ...commonArgs,
          ],
        }
      : {
          executable: 'bash',
          args: [join(REPOSITORY_ROOT, 'scripts', 'bot-gh-pr-create.sh'), ...commonArgs],
        };
  const output = runCommand(command.executable, command.args, options.worktree).stdout;
  const pr = output.match(/^PR: #(\d+) (https:\/\/github\.com\/[^\s]+)$/m);
  const branchSha = output.match(/^Branch SHA: ([0-9a-f]{40})$/m)?.[1];
  const prHeadSha = output.match(/^PR head SHA: ([0-9a-f]{40})$/m)?.[1];
  if (!pr) {
    throw new RehearsalBlockedError(
      'DELIVERY_EVIDENCE_INVALID',
      'Governed delivery did not return draft PR evidence.',
    );
  }
  const synchronizedHead = assertDeliveryHeadSynchronized(branchSha, prHeadSha);
  return {
    number: Number(pr[1]),
    url: pr[2],
    branchSha: synchronizedHead.branchSha,
    prHeadSha: synchronizedHead.prHeadSha,
  };
}

export async function runLiveRehearsal(options: RehearsalOptions): Promise<LiveRehearsalResult> {
  if (options.mode !== 'live' || !options.repo || !options.execute) {
    throw new RehearsalBlockedError(
      'LIVE_CONFIRMATION_REQUIRED',
      'Live rehearsal requires mode, repository, and explicit execution.',
    );
  }
  prepareEmptyOutputDirectory(options.outDir);
  assertLiveAgentRegistry();

  const github = await import('../packages/github/src/index.js');
  resolveAndAssertOriginPushTarget({
    explicitRepo: options.repo,
    runGit: (args) => runCommand('git', args).stdout,
    parseRepository: github.parseGitHubRepoSpec,
  });

  const identity = await github.getAuthenticatedIdentity({
    repoFullName: options.repo,
    auth: 'app',
    requireLive: true,
    cwd: REPOSITORY_ROOT,
  });
  if (!identity.isBot || identity.authMode !== 'github_app_installation') {
    throw new RehearsalBlockedError(
      'BOT_IDENTITY_REQUIRED',
      'Live rehearsal requires the configured GitHub App bot identity.',
    );
  }
  const client = await github.getClient({
    repoFullName: options.repo,
    auth: 'app',
    requireLive: true,
    cwd: REPOSITORY_ROOT,
  });
  const repository = await client.octokit.repos.get({
    owner: client.owner,
    repo: client.repo,
  });
  if (repository.data.default_branch !== 'main') {
    throw new RehearsalBlockedError(
      'CANONICAL_MAIN_REQUIRED',
      'The rehearsal repository default branch must be main.',
    );
  }
  const remoteMain = await client.octokit.git.getRef({
    owner: client.owner,
    repo: client.repo,
    ref: 'heads/main',
  });
  const localMain = runCommand('git', ['rev-parse', 'main']).stdout;
  assertLiveMainSynchronized(localMain, remoteMain.data.object.sha);
  const labelsResponse = await client.octokit.paginate(client.octokit.issues.listLabelsForRepo, {
    owner: client.owner,
    repo: client.repo,
    per_page: 100,
  });
  const availableLabels = new Set<string>(
    labelsResponse.map((label: { name: string }) => label.name),
  );
  for (const label of ['openslack:task', 'openslack:ready']) {
    if (!availableLabels.has(label)) {
      throw new RehearsalBlockedError(
        'TASK_LABELS_MISSING',
        `The rehearsal repository is missing required label ${label}.`,
      );
    }
  }

  const workflowResult = await runConfiguredWorkflow();
  const tempRoot = mkdtempSync(join(tmpdir(), 'openslack-ai-org-rehearsal-'));
  let worktree: string | undefined;
  try {
    const branchEvidence = createArtifactBranch(workflowResult, tempRoot);
    worktree = branchEvidence.worktree;

    const parent = await createTaskIssue(
      client,
      '制造企业 AI 转型试点',
      'Parent task for the fixed 90-day manufacturing AI transformation rehearsal.',
      'delivery-planner-agent',
      availableLabels,
    );
    const children: Array<{ number: number; url: string }> = [];
    for (const [title, agentType] of CHILD_TASKS) {
      children.push(
        await createTaskIssue(
          client,
          title,
          `Child task of #${parent.number} for the fixed manufacturing rehearsal.`,
          agentType,
          availableLabels,
        ),
      );
    }
    const childChecklist = children.map((child) => `- [ ] #${child.number}`).join('\n');
    await client.octokit.issues.update({
      owner: client.owner,
      repo: client.repo,
      issue_number: parent.number,
      body: `${parent.body}\n\n## Child Issues\n\n${childChecklist}\n`,
    });

    const draftPr = publishDraftPullRequest({
      worktree,
      repo: options.repo,
      branch: branchEvidence.branch,
      parentIssue: parent.number,
      childIssues: children.map((child) => child.number),
    });
    assertDeliveryHeadSynchronized(draftPr.branchSha, draftPr.prHeadSha, branchEvidence.headCommit);

    const result: LiveRehearsalResult = {
      schema: 'openslack.ai_org_demo_rehearsal.v1',
      status: 'completed',
      mode: 'live',
      evidenceLevel: 'GITHUB_REHEARSED',
      repository: options.repo,
      workflowRunId: workflowResult.runId,
      branch: branchEvidence.branch,
      headCommit: branchEvidence.headCommit,
      parentIssue: parent.number,
      childIssues: children.map((child) => child.number),
      draftPullRequest: draftPr.number,
      artifactFiles: [...REHEARSAL_ARTIFACT_FILES],
    };
    writeJson(join(options.outDir, 'rehearsal-result.json'), result);
    return result;
  } finally {
    if (worktree) {
      try {
        runCommand('git', ['worktree', 'remove', '--force', worktree]);
      } catch {
        // The path is a dedicated temporary rehearsal worktree; final cleanup below is bounded.
      }
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  try {
    const options = parseRehearsalArgs(process.argv.slice(2));
    const result =
      options.mode === 'fixture' ? runFixtureRehearsal(options) : await runLiveRehearsal(options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    const blocked =
      error instanceof RehearsalBlockedError
        ? error
        : new RehearsalBlockedError(
            'REHEARSAL_FAILED',
            'The rehearsal failed without producing completion evidence.',
          );
    process.stderr.write(
      `${JSON.stringify({
        schema: 'openslack.ai_org_demo_rehearsal.v1',
        status: 'blocked',
        code: blocked.code,
        summary: blocked.message,
      })}\n`,
    );
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
