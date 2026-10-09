import { existsSync, readFileSync, statSync } from 'node:fs';
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

export interface CleanupTargetUpgradeFileAction {
  /** Path recorded in the installation manifest. */
  path: string;
  /** Artifact inside the candidate package that supplies this path. */
  artifact: string;
  action: 'install' | 'replace' | 'current';
  installedSHA256: string | null;
  candidateSHA256: string;
}

export interface CleanupTargetUpgradeStep {
  id: string;
  summary: string;
  /** Every step is performed by the administrator; none is automatic. */
  actor: 'administrator';
  commands: string[];
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
  installationMissing: 'INSTALLATION_MANIFEST_MISSING',
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

  // 2. Target evidence must all be present.
  const missingEvidence = Object.entries(evidence ?? {})
    .filter(([, path]) => typeof path !== 'string' || !existsSync(path))
    .map(([name]) => name);
  if (missingEvidence.length > 0) {
    unmetGates.push(CLEANUP_TARGET_UPGRADE_GATES.evidenceIncomplete);
  }

  // 3. Compare the installed files against the candidate artifacts.
  const files: CleanupTargetUpgradeFileAction[] = [];
  const manifestPath = evidence?.installationManifestPath;
  if (typeof manifestPath !== 'string' || !existsSync(manifestPath)) {
    unmetGates.push(CLEANUP_TARGET_UPGRADE_GATES.installationMissing);
  } else {
    for (const installed of installationFiles(manifestPath)) {
      const artifact = basename(installed.path);
      const candidate = artifacts.get(artifact);
      if (candidate === undefined) continue;
      files.push({
        path: installed.path,
        artifact,
        action:
          installed.sha256 === null ? 'install' : installed.sha256 === candidate ? 'current' : 'replace',
        installedSHA256: installed.sha256,
        candidateSHA256: candidate,
      });
    }
  }

  const replace = files.filter((file) => file.action !== 'current');
  const verifiedGate = CLEANUP_TARGET_UPGRADE_GATES.packageUnverified;
  const evidenceGate = CLEANUP_TARGET_UPGRADE_GATES.evidenceIncomplete;
  const installGate = CLEANUP_TARGET_UPGRADE_GATES.installationMissing;

  steps.push({
    id: 'verify-candidate',
    summary:
      'Independently verify the candidate package against the candidate commit and manifest digest.',
    actor: 'administrator',
    commands: [
      `node ${join(input.packageDirectory, 'tools', 'verify-handoff.mjs')} --candidate-head ${input.candidateHead} --manifest-sha256 ${input.manifestSHA256}`,
    ],
    blockedBy: [],
  });
  steps.push({
    id: 'refresh-target-evidence',
    summary:
      'Pre-create this batch qualification targets and refresh App, network and full task evidence.',
    actor: 'administrator',
    commands: [],
    blockedBy: [CLEANUP_TARGET_UPGRADE_GATES.qualificationTargets],
  });
  steps.push({
    id: 'controlled-upgrade',
    summary:
      `Replace ${replace.length} installed file(s) from the verified package. Preserve the existing ` +
      'ledger, journal and consistent backup; do not rebuild accounts or clear state.',
    actor: 'administrator',
    commands: replace.map(
      (file) =>
        `install -m 0755 ${join(input.packageDirectory, 'artifacts', file.artifact)} ${file.path}`,
    ),
    blockedBy: [verifiedGate, evidenceGate, installGate, CLEANUP_TARGET_UPGRADE_GATES.adminApproval],
  });
  steps.push({
    id: 'credentials-and-identity',
    summary:
      'Configure broker credentials and the fixed runtime identity. The agent does not perform this step.',
    actor: 'administrator',
    commands: [],
    blockedBy: [CLEANUP_TARGET_UPGRADE_GATES.adminApproval],
  });
  steps.push({
    id: 'start-unactivated',
    summary: 'Start the broker unactivated and record the real boot nonce it reports.',
    actor: 'administrator',
    commands: [],
    blockedBy: [CLEANUP_TARGET_UPGRADE_GATES.brokerActivation],
  });
  steps.push({
    id: 'prepare-governance-pr',
    summary:
      'Prepare the governance PR. Registry, policy and Permit must come from the same authority ' +
      'commit and the same stable governance repository ID; verify the target repository ID separately.',
    actor: 'administrator',
    commands: [],
    blockedBy: [CLEANUP_TARGET_UPGRADE_GATES.governanceAuthority],
  });
  steps.push({
    id: 'qualification-matrix',
    summary:
      'After governance approval and release, run the qualification matrix and record state and ' +
      'evidence per stage. Never hot-swap the task view: a refresh needs supervised shutdown, a new ' +
      'boot, a new activation and a new Permit.',
    actor: 'administrator',
    commands: [],
    blockedBy: [
      CLEANUP_TARGET_UPGRADE_GATES.governanceAuthority,
      CLEANUP_TARGET_UPGRADE_GATES.brokerActivation,
    ],
  });

  // Approval is always outstanding: a plan can never approve itself.
  unmetGates.push(CLEANUP_TARGET_UPGRADE_GATES.adminApproval);
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
    administratorCommands: steps.flatMap((step) => step.commands),
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
