import { lstatSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import {
  verifyCleanupHandoffPackage,
  evaluateCleanupHandoffVerification,
  verifiedCleanupHandoffSnapshot,
  type CleanupHandoffErrorCode,
  type CleanupHandoffTargetEvidence,
} from './cleanup-handoff.js';
import {
  validateUpgradeEvidence,
  UpgradeEvidenceError,
  UPGRADE_EVIDENCE_ROLES,
  type ValidatedUpgradeEvidence,
} from './internal/cleanup-upgrade-evidence.js';

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
  adminInputPath: string;
  hostInspectionPath: string;
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
type ObservedState = 'present' | 'missing' | 'unreadable' | 'unverified';

export interface ObservedFile {
  state: ObservedState;
  sha256: string | null;
}

/**
 * Decide the action for one destination.
 *
 * Separated from the filesystem walk so every branch — present, missing,
 * unreadable, matching, differing, and a disagreeing manifest claim — is
 * reachable in a test. The layout destinations are absolute, so a test that only
 * calls the planner can never observe anything but `missing`.
 */
export function classifyDestination(
  observed: ObservedFile,
  candidateSHA256: string,
  manifestClaimedSHA256: string | null,
): { action: 'install' | 'replace' | 'current' | 'unverified'; claimDisagrees: boolean } {
  const action: 'install' | 'replace' | 'current' | 'unverified' =
    observed.state === 'unreadable' || observed.state === 'unverified'
      ? 'unverified'
      : observed.state === 'missing'
        ? 'install'
        : candidateSHA256 !== '' && observed.sha256 === candidateSHA256
          ? 'current'
          : 'replace';
  return {
    action,
    // A manifest that claims a digest the target contradicts is reported, never
    // used to decide the action.
    claimDisagrees:
      manifestClaimedSHA256 !== null &&
      observed.state === 'present' &&
      manifestClaimedSHA256 !== observed.sha256,
  };
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
  dependsOn: string[];
}

export interface PrepareCleanupTargetUpgradePlanResult {
  schema: typeof CLEANUP_TARGET_UPGRADE_PLAN_SCHEMA;
  createdAt: string;
  candidateHead: string;
  manifestSHA256: string;
  packageVerified: boolean;
  packageErrors: CleanupHandoffErrorCode[];
  evidenceIssues: { role: string; reason: string }[];
  files: CleanupTargetUpgradeFileAction[];
  steps: CleanupTargetUpgradeStep[];
  administratorCommands: string[];
  /**
   * Destinations where the installation manifest contradicts the target.
   *
   * The manifest is not authoritative, so this does not decide an action — but
   * it is surfaced rather than silently discarded, because an administrator
   * about to replace files should know the recorded state is wrong.
   */
  manifestDisagreements: string[];
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
  evidenceInvalid: 'TARGET_EVIDENCE_INVALID',
  platformUnsupported: 'TARGET_FILE_BOUNDARY_UNSUPPORTED',
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

/**
 * Build the upgrade plan. Every returned command is for the administrator to
 * run; none is executed by this function.
 */
export function prepareCleanupTargetUpgradePlan(
  input: PrepareCleanupTargetUpgradePlanInput,
): PrepareCleanupTargetUpgradePlanResult {
  if (!input || !HEAD.test(input.candidateHead ?? '') || !HASH.test(input.manifestSHA256 ?? '')) {
    throw new CleanupTargetUpgradeError('UPGRADE_INPUT_INVALID');
  }
  assertSafePath(input.packageDirectory, 'packageDirectory');

  const evidence = input.targetEvidence;
  for (const path of Object.values(evidence ?? {})) {
    if (typeof path === 'string') assertSafePath(path, 'targetEvidence');
  }

  const unmetGates: string[] = [];
  const evidenceIssues: { role: string; reason: string }[] = [];
  const steps: CleanupTargetUpgradeStep[] = [];

  // The snapshot is created only by this verification; no unbound SHA256SUMS re-read.
  const verified = verifyCleanupHandoffPackage({
    packageDirectory: input.packageDirectory,
    candidateHead: input.candidateHead,
    manifestSHA256: input.manifestSHA256,
    now: input.now,
  });
  unmetGates.push(...verified.validityIssues);
  const snapshot = verifiedCleanupHandoffSnapshot(verified);
  if (evaluateCleanupHandoffVerification(verified) !== 0 || !snapshot)
    unmetGates.push(CLEANUP_TARGET_UPGRADE_GATES.packageUnverified);
  const artifacts = snapshot?.artifactDigests ?? {};
  const paths: Record<string, string | undefined> = {
    ...Object.fromEntries(UPGRADE_EVIDENCE_ROLES.map((role) => [role, evidence?.[role]])),
    adminInputPath: input.adminInputPath,
    hostInspectionPath: input.hostInspectionPath,
  };
  let evidenceUsable = true;
  for (const [role, path] of Object.entries(paths)) {
    if (!path) {
      evidenceIssues.push({ role, reason: 'MISSING' });
      evidenceUsable = false;
      unmetGates.push(CLEANUP_TARGET_UPGRADE_GATES.evidenceIncomplete);
      continue;
    }
    assertSafePath(path, role);
    try {
      const stamp = lstatSync(path);
      if (!stamp.isFile() || stamp.isSymbolicLink()) {
        evidenceIssues.push({ role, reason: 'NOT_REGULAR_FILE' });
        evidenceUsable = false;
        unmetGates.push(CLEANUP_TARGET_UPGRADE_GATES.evidenceUnreadable);
      }
    } catch (error) {
      evidenceIssues.push({
        role,
        reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'MISSING' : 'UNREADABLE',
      });
      evidenceUsable = false;
      unmetGates.push(
        (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? CLEANUP_TARGET_UPGRADE_GATES.evidenceIncomplete
          : CLEANUP_TARGET_UPGRADE_GATES.evidenceUnreadable,
      );
    }
  }
  if (!evidence?.installationManifestPath)
    unmetGates.push(CLEANUP_TARGET_UPGRADE_GATES.installationMissing);
  else {
    try {
      if (!lstatSync(evidence.installationManifestPath).isFile())
        unmetGates.push(CLEANUP_TARGET_UPGRADE_GATES.installationUnreadable);
    } catch (error) {
      unmetGates.push(
        (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? CLEANUP_TARGET_UPGRADE_GATES.installationMissing
          : CLEANUP_TARGET_UPGRADE_GATES.installationUnreadable,
      );
    }
  }
  let capture: ValidatedUpgradeEvidence | undefined;
  if (evidenceUsable && snapshot) {
    try {
      capture = validateUpgradeEvidence({
        ...input,
        selected: snapshot.selected,
        layout: CLEANUP_INSTALL_LAYOUT,
        now: (input.now ?? new Date()).getTime(),
      });
    } catch (error) {
      const issue =
        error instanceof UpgradeEvidenceError
          ? { role: error.role, reason: error.reason }
          : { role: 'targetEvidence', reason: 'EVIDENCE_INVALID' };
      evidenceIssues.push(issue);
      unmetGates.push(
        issue.reason === 'UNSUPPORTED_PLATFORM'
          ? CLEANUP_TARGET_UPGRADE_GATES.platformUnsupported
          : CLEANUP_TARGET_UPGRADE_GATES.evidenceInvalid,
      );
      if (issue.role === 'installationManifestPath')
        unmetGates.push(CLEANUP_TARGET_UPGRADE_GATES.installationUnreadable);
    }
  }
  const files: CleanupTargetUpgradeFileAction[] = CLEANUP_INSTALL_LAYOUT.map((entry) => {
    const candidate = artifacts[entry.artifact] ?? '';
    const current = capture?.files.find((file) => file.path === entry.path);
    const observed: ObservedFile = current
      ? { state: current.state, sha256: current.sha256 }
      : { state: 'unverified', sha256: null };
    const claimed = capture?.manifest.get(entry.path) ?? null;
    const classified = classifyDestination(observed, candidate, claimed);
    return {
      path: entry.path,
      artifact: entry.artifact,
      mode: entry.mode,
      owner: entry.owner,
      action:
        classified.action === 'current' && current?.mode !== entry.mode
          ? 'replace'
          : classified.action,
      observed: observed.state,
      installedSHA256: observed.sha256,
      candidateSHA256: candidate,
      manifestClaimedSHA256: claimed,
      claimDisagrees: classified.claimDisagrees,
    };
  });
  if (files.some((file) => file.action === 'unverified' || !file.candidateSHA256))
    unmetGates.push(CLEANUP_TARGET_UPGRADE_GATES.destinationUnverified);
  const installable =
    evaluateCleanupHandoffVerification(verified) === 0 &&
    capture !== undefined &&
    files.every((file) => file.action !== 'unverified' && HASH.test(file.candidateSHA256));
  const replace = files.filter((file) => file.action !== 'current');
  const verifiedGate = CLEANUP_TARGET_UPGRADE_GATES.packageUnverified;
  const evidenceGate = CLEANUP_TARGET_UPGRADE_GATES.evidenceIncomplete;
  const evidenceUnreadableGate = CLEANUP_TARGET_UPGRADE_GATES.evidenceUnreadable;
  const installGate = CLEANUP_TARGET_UPGRADE_GATES.installationMissing;
  const installUnreadableGate = CLEANUP_TARGET_UPGRADE_GATES.installationUnreadable;
  const destinationGate = CLEANUP_TARGET_UPGRADE_GATES.destinationUnverified;
  const approvalGate = CLEANUP_TARGET_UPGRADE_GATES.adminApproval;

  steps.push({
    id: 'verify-candidate',
    dependsOn: [],
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
    dependsOn: ['verify-candidate'],
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
    id: 'approve-new-inputs',
    summary: 'Review and approve these exact new inputs; old approval does not apply.',
    actor: 'administrator',
    commands: [],
    workingDirectory: input.packageDirectory,
    expectedOutput: 'Current administrator approval bound to this candidate and manifest.',
    stopCondition: 'Any binding differs or evidence expires.',
    blockedBy: [approvalGate],
    dependsOn: ['verify-candidate', 'refresh-target-evidence'],
  });
  steps.push({
    id: 'stop-and-consistent-backup',
    summary:
      'Use the verified supervisor to stop the broker and preserve one consistent ledger/journal backup; never clear consumption history.',
    actor: 'administrator',
    commands: [],
    workingDirectory: input.packageDirectory,
    expectedOutput: 'Stopped process and verified consistent backup.',
    stopCondition:
      'Unknown supervisor, process, locks or state: stop and request actual host evidence.',
    blockedBy: [approvalGate],
    dependsOn: ['approve-new-inputs'],
  });
  steps.push({
    id: 'controlled-upgrade',
    dependsOn: ['stop-and-consistent-backup'],
    summary:
      `Replace ${replace.length} layout destination(s) from the verified package. Preserve the ` +
      'existing ledger, journal and consistent backup; do not rebuild accounts or clear state.',
    actor: 'administrator',
    // No install instruction is generated while the package or its evidence is
    // invalid. The step remains as a blocked placeholder with no runnable
    // command, which is what "no install instructions" requires: a guarded but
    // runnable command is still an install instruction.
    commands: installable
      ? replace.map((file) => ({
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
        }))
      : [],
    workingDirectory: input.packageDirectory,
    expectedOutput: 'Every destination matches its candidate artifact digest and its fixed mode.',
    stopCondition:
      'A destination is unverified, a digest differs after install, or the backup is inconsistent.',
    blockedBy: [
      verifiedGate,
      evidenceGate,
      evidenceUnreadableGate,
      installGate,
      installUnreadableGate,
      destinationGate,
      approvalGate,
      CLEANUP_TARGET_UPGRADE_GATES.evidenceInvalid,
      CLEANUP_TARGET_UPGRADE_GATES.platformUnsupported,
      ...verified.validityIssues,
    ],
  });
  steps.push({
    id: 'credentials-and-identity',
    dependsOn: ['controlled-upgrade'],
    summary:
      'Configure broker credentials and the fixed runtime identity. The agent does not perform this step.',
    actor: 'administrator',
    commands: [],
    workingDirectory: input.packageDirectory,
    expectedOutput: 'The broker authenticates its OS peer against the fixed identity.',
    stopCondition:
      'The fixed identity or approved UID/GID mapping differs: stop, do not recreate it.',
    blockedBy: [approvalGate],
  });
  steps.push({
    id: 'installation-isolation-verification',
    dependsOn: ['credentials-and-identity'],
    summary:
      'Verify the installed layout in isolation: digests, owner, mode, and that the broker starts ' +
      'against the candidate revision before it is activated.',
    actor: 'administrator',
    commands: [],
    workingDirectory: input.packageDirectory,
    expectedOutput: 'Installed digests, owner and mode match the fixed layout exactly.',
    stopCondition: 'Any digest, owner or mode mismatch: restore the consistent backup and stop.',
    blockedBy: [approvalGate, destinationGate, installUnreadableGate],
  });
  steps.push({
    id: 'start-unactivated',
    dependsOn: ['installation-isolation-verification'],
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
    dependsOn: ['start-unactivated'],
    summary:
      'Prepare the governance PR, binding registry, policy and Permit to the same authority commit ' +
      'and the same stable governance repository ID, using the nonce from this boot. Verify the ' +
      'target repository ID separately.',
    actor: 'administrator',
    commands: [],
    workingDirectory: input.packageDirectory,
    expectedOutput: 'An activation bound to this boot nonce and one authority commit.',
    stopCondition:
      'The nonce is stale, or a repository ID differs: stop and re-boot rather than swap.',
    blockedBy: [approvalGate],
  });
  steps.push({
    id: 'qualification-matrix',
    dependsOn: ['prepare-governance-pr'],
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
    evidenceIssues,
    manifestDisagreements: files.filter((file) => file.claimDisagrees).map((file) => file.path),
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
