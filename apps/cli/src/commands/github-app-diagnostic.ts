import type { GitHubAppInstallationDiagnosticReport } from '@openslack/github';

export function renderGitHubAppInstallationDiagnostic(
  report: GitHubAppInstallationDiagnosticReport,
): string {
  const state = report.ready ? 'PASS' : 'FAIL';
  const lines = [
    'GitHub App Installation',
    ...report.codes.map((code) => `[${state}] ${code}`),
    `  Permissions expected: ${formatRecord(report.permissions.expected)}`,
    `  Permissions actual: ${formatRecord(report.permissions.actual)}`,
    `  Permissions missing: ${formatPermissionDifferences(report.permissions.missing)}`,
    `  Events expected: ${formatList(report.events.expected)}`,
    `  Events actual: ${formatList(report.events.actual)}`,
    `  Events missing: ${formatList(report.events.missing)}`,
    `  Repository expected: ${report.repository.fullName}`,
    `  Repository actual: selection=${report.repository.selection}, accessible=${report.repository.accessible ? 'yes' : 'no'}, complete=${report.repository.complete ? 'yes' : 'no'}`,
    `  Repository missing: ${
      report.repository.accessible && report.repository.complete
        ? 'none'
        : report.repository.fullName
    }`,
    `  Installation management: ${report.managementUrl}`,
  ];
  if (report.administratorAction)
    lines.push(`  Administrator action: ${report.administratorAction}`);
  return lines.join('\n');
}

function formatRecord(value: Readonly<Record<string, string>>): string {
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  return entries.length === 0
    ? 'none'
    : entries.map(([name, level]) => `${name}:${level}`).join(', ');
}

function formatPermissionDifferences(
  differences: GitHubAppInstallationDiagnosticReport['permissions']['missing'],
): string {
  return differences.length === 0
    ? 'none'
    : differences
        .map(
          (difference) =>
            `${difference.name}:${difference.expected} (actual:${difference.actual ?? 'none'})`,
        )
        .join(', ');
}

function formatList(values: readonly string[]): string {
  return values.length === 0 ? 'none' : values.join(', ');
}
