import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import {
  CleanupHandoffError,
  verifyCleanupHandoffPackage,
  type CleanupHandoffErrorCode,
  type CleanupHandoffTargetEvidence,
} from './cleanup-handoff.js';

/**
 * Plan a controlled upgrade of a partial cleanup installation onto a verified
 * candidate package.
 *
 * This function **plans only**. It installs nothing, starts nothing, and
 * authorizes nothing: every step names the administrator as its actor, and the
 * result states explicitly that installation was not performed, that deployment
 * is not authorized and that execution is not authorized. Running the plan is a
 * separate, supervised administrator action.
 */
export const CLEANUP_TARGET_UPGRADE_PLAN_SCHEMA = 'openslack.cleanup_target_upgrade_plan.v1';

/** Installation manifest schema written by the installed cleanup client. */
const INSTALLATION_SCHEMA = 'openslack.cleanup_installation.v1';
const HASH = /^[0-9a-f]{64}$/;
const HEAD = /^[0-9a-f]{40}$/;

/** Paths that must never be read as plan input. */
const sensitive = [
  /(^|[/\\])\.env(\.[^/\\]*)?$/i,
  /\.pem$/i,
  /\.key$/i,
  /(^|[/\\])secrets([/\\]|$)/i,
  /(^|[/\\])credentials([/\\]|$)/i,
];

export type CleanupTargetUpgradeErrorCode =
  | 'UPGRADE_INPUT_INVALID'
  | 'UPGRADE_PATH_SENSITIVE'
  | 'UPGRADE_INSTALLATION_UNREADABLE'
  | 'UPGRADE_PACKAGE_UNREADABLE';

export class CleanupTargetUpgradeError extends Error {
  constructor(public readonly code: CleanupTargetUpgradeErrorCode) {
    super(`${code}: stop; preserve existing state and review the upgrade inputs.`);
    this.name = 'CleanupTargetUpgradeError';
  }
}

export interface PrepareCleanupTargetUpgradePlanInput {
  /** Candidate package directory produced for this batch. Verified, never installed here. */
  packageDirectory: string;
  /** Candidate commit the package was built from; obtain it independently. */
  candidateHead: string;
  /** SHA-256 of the package SHA256SUMS; obtain it independently. */
  manifestSHA256: string;
  /** Current partial installation described by its installation manifest. */
  targetEvidence: CleanupHandoffTargetEvidence;
  now?: Date;
}

/**
 * The fixed installation layout.
 *
 * Destinations, modes and owners are constants. They are never taken from the
 * installation manifest or any other input, so a manifest entry cannot redirect
 * an install, add a destination, or smuggle a shell separator into a command.
 * The Broker is a member of the layout like any other artifact, so it is planned
 * whether or not an old manifest ever mentioned it.
 */
export const CLEANUP_INSTALL_LAYOUT = Object.freeze(
  [
    { artifact: 'cleanup-broker', path: '/usr/lib/openslack-cleanup/cleanup-broker' },
    { artifact: 'executor.mjs', path: '/usr/lib/openslack-cleanup/executor.mjs' },
    { artifact: 'node', path: '/usr/lib/openslack-cleanup/node' },
    { artifact: 'git', path: '/usr/lib/openslack-cleanup/git' },
    { artifact: 'sh', path: '/usr/lib/openslack-cleanup/sh' },
    {
      artifact: 'git-remote-https',
      path: '/usr/lib/openslack-cleanup/git-core/git-remote-https',
    },
  ].map((entry) => Object.freeze({ ...entry, mode: '0755', owner: 'root:root' })),
);

/** A command is built as a program plus arguments, never as a shell string. */
export interface CleanupUpgradeCommand {
  program: string;
  args: string[];
}

/**
 * Reject control characters. A newline, carriage return or NUL in an argument
 * or program name is never legitimate and is what turns a rendered command into
 * more than one command.
 */
function assertRenderable(value: string): void {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new CleanupTargetUpgradeError('UPGRADE_INPUT_INVALID');
  }
}

/**
 * Render one argument safely. Single-quoting preserves spaces and neutralises
 * every shell metacharacter, including `;`, `|`, `$`, backticks and `&&`.
 */
function quoteArgument(value: string): string {
  assertRenderable(value);
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Render a structured command into a single shell-safe line. */
export function renderUpgradeCommand(command: CleanupUpgradeCommand): string {
  assertRenderable(command.program);
  return [command.program, ...command.args].map(quoteArgument).join(' ');
}

/** What the target itself reports about a layout destination. */
type ObservedState = 'present' | 'missing' | 'unreadable';

interface ObservedFile {
  state: ObservedState;
  sha256: string | null;
}

/**
 * Observe a destination directly. The installation manifest is only a claim;
 * the current state of the target is read from the target.
 */
function observeFile(path: string): ObservedFile {
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(path);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { state: 'missing', sha256: null }
      : { state: 'unreadable', sha256: null };
  }
  if (!stats.isFile()) return { state: 'unreadable', sha256: null };
  try {
    return {
      state: 'present',
      sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
    };
  } catch {
    return { state: 'unreadable', sha256: null };
  }
}

export interface CleanupTargetUpgradeFileAction {
  /** Destination from the fixed layout, never from input. */
  path: string;
  /** Artifact inside the candidate package that supplies this path. */
  artifact: string;
  mode: string;
  owner: string;
  action: 'install' | 'replace' | 'current' | 'unverified';
  /** What the target itself reports. */
  observed: ObservedState;
  installedSHA256: string | null;
  candidateSHA256: string;
  /** Digest the installation manifest claims for this path, if it mentions it. */
  manifestClaimedSHA256: string | null;
  /** True when the manifest claim disagrees with the observed file. */
  claimDisagrees: boolean;
}

export interface CleanupTargetUpgradeStep {
  id: string;
  summary: string;
  /** Every step is performed by the administrator; none is automatic. */
  actor: 'administrator';
  /** Structured commands; render with `renderUpgradeCommand`. */
  commands: CleanupUpgradeCommand[];
  /** Working directory the administrator runs the step in. */
  workingDirectory: string;
  /** What a successful step produces. */
  expectedOutput: string;
  /** When to stop instead of continuing. */
  stopCondition: string;
  /** Gates that must be satisfied before this step may run. */
  blockedBy: string[];
}

export interface PrepareCleanupTargetUpgradePlanResult {
  schema: typeof CLEANUP_TARGET_UPGRADE_PLAN_SCHEMA;
  createdAt: string;
  candidateHead: string;
  manifestSHA256: string;
  packageVerified: boolean;
  packageErrors: CleanupHandoffErrorCode[];
  files: CleanupTargetUpgradeFileAction[];
  steps: CleanupTargetUpgradeStep[];
  administratorCommands: string[];
  unmetGates: string[];
  /** Planning is not installation. */
  installationPerformed: false;
  deploymentAuthorized: false;
  executionAuthorized: false;
  /**
   * The plan deliberately offers no direct human branch-deletion fallback:
   * deletion stays with the governed broker path only.
   */
  directHumanDeletionAvailable: false;
}

export const CLEANUP_TARGET_UPGRADE_GATES = Object.freeze({
  packageUnverified: 'CANDIDATE_PACKAGE_UNVERIFIED',
  evidenceIncomplete: 'TARGET_EVIDENCE_INCOMPLETE',
  evidenceUnreadable: 'TARGET_EVIDENCE_UNREADABLE',
  installationMissing: 'INSTALLATION_MANIFEST_MISSING',
  installationUnreadable: 'INSTALLATION_MANIFEST_UNREADABLE',
  destinationUnverified: 'DESTINATION_STATE_UNVERIFIED',
  adminApproval: 'ADMIN_APPROVAL_REQUIRED',
  qualificationTargets: 'QUALIFICATION_TARGETS_REQUIRED',
  governanceAuthority: 'GOVERNANCE_AUTHORITY_REQUIRED',
  brokerActivation: 'BROKER_ACTIVATION_REQUIRED',
});

function assertSafePath(path: string, what: string): void {
  if (typeof path !== 'string' || path.length === 0 || !isAbsolute(path)) {
    throw new CleanupTargetUpgradeError('UPGRADE_INPUT_INVALID');
  }
  if (sensitive.some((pattern) => pattern.test(path))) {
    throw new CleanupTargetUpgradeError('UPGRADE_PATH_SENSITIVE');
  }
  void what;
}

/** Read the candidate package's artifact digests from its own SHA256SUMS. */
function packageArtifacts(packageDirectory: string): Map<string, string> {
  let text: string;
  try {
    text = readFileSync(join(packageDirectory, 'SHA256SUMS'), 'utf8');
  } catch {
    throw new CleanupTargetUpgradeError('UPGRADE_PACKAGE_UNREADABLE');
  }
  const artifacts = new Map<string, string>();
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const match = /^([a-f0-9]{64})  \.\/([A-Za-z0-9._/-]+)$/.exec(line);
    if (!match) continue;
    const path = match[2]!;
    if (!path.startsWith('artifacts/')) continue;
    artifacts.set(basename(path), match[1]!);
  }
  return artifacts;
}

interface InstalledFile {
  path: string;
  sha256: string | null;
}

function installationFiles(path: string): InstalledFile[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new CleanupTargetUpgradeError('UPGRADE_INSTALLATION_UNREADABLE');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CleanupTargetUpgradeError('UPGRADE_INSTALLATION_UNREADABLE');
  }
  const manifest = parsed as { schema?: unknown; files?: unknown };
  if (manifest.schema !== INSTALLATION_SCHEMA || !Array.isArray(manifest.files)) {
    throw new CleanupTargetUpgradeError('UPGRADE_INSTALLATION_UNREADABLE');
  }
  return manifest.files.map((entry) => {
    const file = entry as { path?: unknown; sha256?: unknown };
    if (typeof file.path !== 'string' || file.path.length === 0) {
      throw new CleanupTargetUpgradeError('UPGRADE_INSTALLATION_UNREADABLE');
    }
    const digest = typeof file.sha256 === 'string' && HASH.test(file.sha256) ? file.sha256 : null;
    return { path: file.path, sha256: digest };
  });
}

/**
 * Build the upgrade plan. Every returned command is for the administrator to
 * run; none is executed by this function.
 */
export function prepareCleanupTargetUpgradePlan(
  input: PrepareCleanupTargetUpgradePlanInput,
): PrepareCleanupTargetUpgradePlanResult {
  if (
    !input ||
    !HEAD.test(input.candidateHead ?? '') ||
    !HASH.test(input.manifestSHA256 ?? '')
  ) {
    throw new CleanupTargetUpgradeError('UPGRADE_INPUT_INVALID');
  }
  assertSafePath(input.packageDirectory, 'packageDirectory');

  const evidence = input.targetEvidence;
  for (const path of Object.values(evidence ?? {})) {
    if (typeof path === 'string') assertSafePath(path, 'targetEvidence');
  }

  const unmetGates: string[] = [];
  const steps: CleanupTargetUpgradeStep[] = [];

  // 1. The package must verify against bindings obtained independently.
  let verified: ReturnType<typeof verifyCleanupHandoffPackage>;
  try {
    verified = verifyCleanupHandoffPackage({
      packageDirectory: input.packageDirectory,
      candidateHead: input.candidateHead,
      manifestSHA256: input.manifestSHA256,
      ...(input.now ? { now: input.now } : {}),
    });
  } catch (error) {
    if (!(error instanceof CleanupHandoffError)) throw error;
    verified = {
      valid: false,
      candidateHead: input.candidateHead,
      manifestSHA256: input.manifestSHA256,
      fileCount: 0,
      errors: [error.code],
      unmetGates: [],
      installationAuthorized: false,
      executionAuthorized: false,
    };
  }
  if (!verified.valid) unmetGates.push(CLEANUP_TARGET_UPGRADE_GATES.packageUnverified);

  const artifacts = packageArtifacts(input.packageDirectory);

  // 2. Target evidence must be present *and* readable. Missing and unreadable
  // are distinguished rather than collapsed into one "incomplete" state.
  const missingEvidence: string[] = [];
  const unreadableEvidence: string[] = [];
  for (const [name, path] of Object.entries(evidence ?? {})) {
    if (typeof path !== 'string' || path.length === 0 || !existsSync(path)) {
      missingEvidence.push(name);
      continue;
    }
    try {
      statSync(path);
    } catch {
      unreadableEvidence.push(name);
    }
  }
  if (missingEvidence.length > 0) {
    unmetGates.push(CLEANUP_TARGET_UPGRADE_GATES.evidenceIncomplete);
  }
  if (unreadableEvidence.length > 0) {
    unmetGates.push(CLEANUP_TARGET_UPGRADE_GATES.evidenceUnreadable);
  }

  // 3. Derive every action from the fixed layout, not from the installation
  // manifest. The manifest is a claim about a past install and cannot prove the
  // current state of the target; the destination itself is observed instead.
  // The manifest is still validated and cross-checked, so a corrupt or
  // disagreeing manifest is reported rather than silently trusted.
  const manifestPath = evidence?.installationManifestPath;
  let manifestClaim: Map<string, string | null> | null = null;
  if (typeof manifestPath !== 'string' || manifestPath.length === 0 || !existsSync(manifestPath)) {
    unmetGates.push(CLEANUP_TARGET_UPGRADE_GATES.installationMissing);
  } else {
    try {
      manifestClaim = new Map(
        installationFiles(manifestPath).map((file) => [file.path, file.sha256]),
      );
    } catch (error) {
      if (!(error instanceof CleanupTargetUpgradeError)) throw error;
      unmetGates.push(CLEANUP_TARGET_UPGRADE_GATES.installationUnreadable);
    }
  }

  const files: CleanupTargetUpgradeFileAction[] = CLEANUP_INSTALL_LAYOUT.map((entry) => {
    const candidate = artifacts.get(entry.artifact) ?? '';
    const observed = observeFile(entry.path);
    const action: CleanupTargetUpgradeFileAction['action'] =
      observed.state === 'unreadable'
        ? 'unverified'
        : observed.state === 'missing'
          ? 'install'
          : candidate !== '' && observed.sha256 === candidate
            ? 'current'
            : 'replace';
    const claimed = manifestClaim?.get(entry.path) ?? null;
    return {
      path: entry.path,
      artifact: entry.artifact,
      mode: entry.mode,
      owner: entry.owner,
      action,
      observed: observed.state,
      installedSHA256: observed.sha256,
      candidateSHA256: candidate,
      manifestClaimedSHA256: claimed,
      // A manifest that claims a digest the target contradicts is reported, not
      // used to decide the action.
      claimDisagrees:
        claimed !== null && observed.state === 'present' && claimed !== observed.sha256,
    };
  });
  if (files.some((file) => file.action === 'unverified' || file.candidateSHA256 === '')) {
    unmetGates.push(CLEANUP_TARGET_UPGRADE_GATES.destinationUnverified);
  }

  const replace = files.filter((file) => file.action !== 'current');
  const verifiedGate = CLEANUP_TARGET_UPGRADE_GATES.packageUnverified;
  const evidenceGate = CLEANUP_TARGET_UPGRADE_GATES.evidenceIncomplete;
  const installGate = CLEANUP_TARGET_UPGRADE_GATES.installationMissing;
  const destinationGate = CLEANUP_TARGET_UPGRADE_GATES.destinationUnverified;
  const approvalGate = CLEANUP_TARGET_UPGRADE_GATES.adminApproval;

  steps.push({
    id: 'verify-candidate',
    summary:
      'Independently verify the candidate package against the candidate commit and manifest digest.',
    actor: 'administrator',
    commands: [
      {
        program: 'node',
        args: [
          join(input.packageDirectory, 'tools', 'verify-handoff.mjs'),
          '--package',
          input.packageDirectory,
          '--candidate',
          input.candidateHead,
          '--manifest-sha256',
          input.manifestSHA256,
        ],
      },
    ],
    workingDirectory: input.packageDirectory,
    expectedOutput: 'The verifier reports the package valid and echoes the candidate head back.',
    stopCondition:
      'Any digest mismatch, unexpected file or non-zero exit: stop, and do not install anything.',
    blockedBy: [],
  });
  steps.push({
    id: 'refresh-target-evidence',
    summary:
      'Pre-create this batch qualification targets and refresh App, network and full task evidence.',
    actor: 'administrator',
    commands: [],
    workingDirectory: input.packageDirectory,
    expectedOutput: 'Fresh evidence for every required target, within its validity window.',
    stopCondition: 'Evidence cannot be refreshed, or a target differs from the approved mapping.',
    blockedBy: [CLEANUP_TARGET_UPGRADE_GATES.qualificationTargets],
  });
  steps.push({
    id: 'controlled-upgrade',
    summary:
      `Replace ${replace.length} layout destination(s) from the verified package. Preserve the ` +
      'existing ledger, journal and consistent backup; do not rebuild accounts or clear state.',
    actor: 'administrator',
    commands: replace.map((file) => ({
      program: 'install',
      args: [
        '-m',
        file.mode,
        '-o',
        file.owner.split(':')[0]!,
        '-g',
        file.owner.split(':')[1]!,
        join(input.packageDirectory, 'artifacts', file.artifact),
        file.path,
      ],
    })),
    workingDirectory: input.packageDirectory,
    expectedOutput: 'Every destination matches its candidate artifact digest and its fixed mode.',
    stopCondition:
      'A destination is unverified, a digest differs after install, or the backup is inconsistent.',
    blockedBy: [verifiedGate, evidenceGate, installGate, destinationGate, approvalGate],
  });
  steps.push({
    id: 'installation-isolation-verification',
    summary:
      'Verify the installed layout in isolation: digests, owner, mode, and that the broker starts ' +
      'against the candidate revision before it is activated.',
    actor: 'administrator',
    commands: [],
    workingDirectory: input.packageDirectory,
    expectedOutput: 'Installed digests, owner and mode match the fixed layout exactly.',
    stopCondition: 'Any digest, owner or mode mismatch: restore the consistent backup and stop.',
    blockedBy: [approvalGate, destinationGate],
  });
  steps.push({
    id: 'credentials-and-identity',
    summary:
      'Configure broker credentials and the fixed runtime identity. The agent does not perform this step.',
    actor: 'administrator',
    commands: [],
    workingDirectory: input.packageDirectory,
    expectedOutput: 'The broker authenticates its OS peer against the fixed identity.',
    stopCondition: 'The fixed identity or approved UID/GID mapping differs: stop, do not recreate it.',
    blockedBy: [approvalGate],
  });
  steps.push({
    id: 'start-unactivated',
    summary:
      'Start the broker unactivated and record the real boot nonce it reports. This step produces ' +
      'the nonce, so it is deliberately not blocked by activation.',
    actor: 'administrator',
    commands: [],
    workingDirectory: input.packageDirectory,
    expectedOutput: 'A real boot nonce from this boot, recorded verbatim.',
    stopCondition: 'The broker reports no nonce, or a nonce that was not produced by this boot.',
    blockedBy: [approvalGate],
  });
  steps.push({
    id: 'prepare-governance-pr',
    summary:
      'Prepare the governance PR, binding registry, policy and Permit to the same authority commit ' +
      'and the same stable governance repository ID, using the nonce from this boot. Verify the ' +
      'target repository ID separately.',
    actor: 'administrator',
    commands: [],
    workingDirectory: input.packageDirectory,
    expectedOutput: 'An activation bound to this boot nonce and one authority commit.',
    stopCondition: 'The nonce is stale, or a repository ID differs: stop and re-boot rather than swap.',
    blockedBy: [CLEANUP_TARGET_UPGRADE_GATES.brokerActivation, approvalGate],
  });
  steps.push({
    id: 'qualification-matrix',
    summary:
      'After governance approval and release, run the qualification matrix and record state and ' +
      'evidence per stage. Never hot-swap the task view: a refresh needs supervised shutdown, a new ' +
      'boot, a new activation and a new Permit.',
    actor: 'administrator',
    commands: [],
    workingDirectory: input.packageDirectory,
    expectedOutput: 'Each qualification item mapped to recorded evidence for this batch.',
    stopCondition: 'A stage expires, the target changes, or the Permit expires: stop immediately.',
    blockedBy: [
      CLEANUP_TARGET_UPGRADE_GATES.governanceAuthority,
      CLEANUP_TARGET_UPGRADE_GATES.brokerActivation,
    ],
  });

  // Approval is always outstanding: a plan can never approve itself.
  unmetGates.push(approvalGate);
  unmetGates.push(CLEANUP_TARGET_UPGRADE_GATES.qualificationTargets);
  unmetGates.push(CLEANUP_TARGET_UPGRADE_GATES.governanceAuthority);
  unmetGates.push(CLEANUP_TARGET_UPGRADE_GATES.brokerActivation);

  return {
    schema: CLEANUP_TARGET_UPGRADE_PLAN_SCHEMA,
    createdAt: (input.now ?? new Date()).toISOString(),
    candidateHead: input.candidateHead,
    manifestSHA256: input.manifestSHA256,
    packageVerified: verified.valid,
    packageErrors: verified.errors,
    files,
    steps,
    administratorCommands: steps.flatMap((step) =>
      step.commands.map((command) => renderUpgradeCommand(command)),
    ),
    unmetGates: [...new Set(unmetGates)],
    installationPerformed: false,
    deploymentAuthorized: false,
    executionAuthorized: false,
    directHumanDeletionAvailable: false,
  };
}

/** True when the directory exists and is a directory (used by callers, not the plan). */
export function isUpgradeTargetDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
