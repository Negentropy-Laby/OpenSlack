import { prepareCleanupTargetUpgradePlan } from '../../packages/pr/src/cleanup-target-upgrade.js';
import type { CleanupHandoffTargetEvidence } from '../../packages/pr/src/cleanup-handoff.js';

/**
 * Administrator upgrade tooling for the installed target.
 *
 * It produces the controlled-upgrade plan and the exact commands the
 * administrator runs. It **performs no installation**: it writes no file
 * outside stdout, starts no service, and grants no authorization. Running the
 * plan is a separate, supervised administrator action.
 *
 * This entry is bundled with its offline package implementation and has no
 * checkout, node_modules, Git, auth or network dependency at planning time.
 */
const OPTIONS = [
  '--package',
  '--candidate',
  '--manifest-sha256',
  '--install-manifest',
  '--task-view',
  '--task-attestation',
  '--app-scope',
  '--network',
  '--identity',
  '--dependency-inventory',
] as const;

const args = process.argv.slice(2);
const options = new Map<string, string>();
for (let index = 0; index < args.length; index += 2) {
  const name = args[index];
  const value = args[index + 1];
  if (!name || !(OPTIONS as readonly string[]).includes(name) || !value || options.has(name)) {
    process.stderr.write(
      `UPGRADE_INPUT_INVALID: unexpected or repeated argument ${name ?? ''}.\n`,
    );
    process.stderr.write(
      'Usage: admin-upgrade.mjs --package <dir> --candidate <full SHA> --manifest-sha256 <reviewed SHA256> ' +
        '--install-manifest <path> --task-view <path> --task-attestation <path> --app-scope <path> ' +
        '--network <path> --identity <path> --dependency-inventory <path>\n',
    );
    process.exitCode = 2;
  } else {
    options.set(name, value);
  }
}

if (!process.exitCode) {
  const targetEvidence: CleanupHandoffTargetEvidence = {
    installationManifestPath: options.get('--install-manifest') ?? '',
    taskViewPath: options.get('--task-view') ?? '',
    taskAttestationPath: options.get('--task-attestation') ?? '',
    appScopePath: options.get('--app-scope') ?? '',
    networkPath: options.get('--network') ?? '',
    identityPath: options.get('--identity') ?? '',
    dependencyInventoryPath: options.get('--dependency-inventory') ?? '',
  };

  try {
    const plan = prepareCleanupTargetUpgradePlan({
      packageDirectory: options.get('--package') ?? '',
      candidateHead: options.get('--candidate') ?? '',
      manifestSHA256: options.get('--manifest-sha256') ?? '',
      targetEvidence,
    });
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    process.stdout.write(
      'Plan only. Nothing was installed, no service was started, and no deployment or execution is authorized.\n',
    );
    if (plan.unmetGates.length > 0) {
      process.stdout.write(`Unmet gates: ${plan.unmetGates.join(', ')}\n`);
    }
    // Diagnostics that would otherwise never reach the administrator: the
    // verifier's error codes, and destinations whose recorded manifest digest
    // contradicts the target. The manifest is not authoritative, so a
    // disagreement does not decide an action — but it must be visible before
    // files are replaced.
    if (plan.packageErrors.length > 0) {
      process.stdout.write(`Package errors: ${plan.packageErrors.join(', ')}\n`);
    }
    if (plan.manifestDisagreements.length > 0) {
      process.stdout.write(
        `Installation manifest disagrees with the target at: ${plan.manifestDisagreements.join(', ')}\n`,
      );
    }
    // An unverified candidate is a hard stop for the administrator; outstanding
    // gates are expected and do not by themselves make the plan unusable.
    if (!plan.packageVerified) process.exitCode = 2;
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'UPGRADE_INPUT_INVALID: the plan could not be produced.'}\n`,
    );
    process.exitCode = 2;
  }
}
