import type { GitHubAuthPreference, GitHubClient, GitHubClientOptions } from '@openslack/github';

export interface PRDoctorEvidenceUnavailableError {
  message: string;
  operation: string;
  prNumber?: number;
  status?: number;
}

const AUTH_CHOICES: GitHubAuthPreference[] = ['auto', 'app', 'token', 'dry-run'];

export interface PRDoctorEvidenceOptions {
  auth?: string;
  dryRun?: boolean;
  repo?: string;
}

export function normalizePRDoctorAuth(options: PRDoctorEvidenceOptions): GitHubAuthPreference {
  if (options.dryRun) return 'dry-run';
  if (!options.auth) return 'auto';
  if (AUTH_CHOICES.includes(options.auth as GitHubAuthPreference)) {
    return options.auth as GitHubAuthPreference;
  }
  throw new Error(`Invalid --auth "${options.auth}". Expected one of: ${AUTH_CHOICES.join(', ')}`);
}

export function buildPRDoctorClientOptions(options: PRDoctorEvidenceOptions): GitHubClientOptions {
  const auth = normalizePRDoctorAuth(options);
  return {
    repoFullName: options.repo,
    auth,
    requireLive: auth !== 'dry-run',
    strictEvidence: auth !== 'dry-run',
  };
}

export function renderDoctorEvidenceBanner(client: GitHubClient): string {
  return [
    `GitHub evidence: ${client.isDryRun ? 'DRY-RUN' : 'LIVE'}`,
    `Repo: ${client.owner}/${client.repo}`,
    `Auth: ${client.authMode}`,
  ].join('\n');
}

export function renderDoctorDryRunReport(prNumber: number, client: GitHubClient): string {
  return [
    '## PR Governance Doctor Report',
    '',
    renderDoctorEvidenceBanner(client),
    '',
    'Decision: NOT_EVALUATED',
    '',
    `PR #${prNumber} was not fetched from GitHub because --dry-run or --auth dry-run was used.`,
    'No merge readiness, policy blocker, approval, check, CODEOWNERS, workflow, or profile-sync gate result is available.',
    '',
    'Next action:',
    `- Re-run with live credentials: powershell -ExecutionPolicy Bypass -File scripts\\openslack-bot.ps1 pr doctor ${prNumber}`,
    `- Or keep simulation explicit: bun run openslack pr doctor ${prNumber} --dry-run`,
  ].join('\n');
}

export function renderAuthRequiredMessage(prNumber: number, error: Error): string {
  return [
    error.message.startsWith('AUTH_REQUIRED') ? error.message : `AUTH_REQUIRED: ${error.message}`,
    '',
    'pr doctor cannot produce a governance decision without live GitHub evidence.',
    '',
    'Try:',
    `  powershell -ExecutionPolicy Bypass -File scripts\\openslack-bot.ps1 pr doctor ${prNumber}`,
    `  bun run openslack pr doctor ${prNumber} --dry-run`,
  ].join('\n');
}

export function renderEvidenceUnavailableMessage(
  client: GitHubClient,
  error: PRDoctorEvidenceUnavailableError,
): string {
  return [
    error.message,
    '',
    renderDoctorEvidenceBanner(client),
    `Operation: ${error.operation}`,
    error.prNumber === undefined ? undefined : `PR: #${error.prNumber}`,
    error.status === undefined ? undefined : `Status: ${error.status}`,
    '',
    'No merge readiness, policy blocker, approval, check, CODEOWNERS, workflow, or profile-sync gate result is available.',
    'Retry after GitHub API recovery or use --dry-run for an explicit simulation.',
  ].filter((line): line is string => typeof line === 'string').join('\n');
}
