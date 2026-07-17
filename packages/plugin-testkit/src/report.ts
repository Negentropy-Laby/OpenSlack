import type { PluginDiagnosticFinding } from '@openslack/plugin-api';

import { PLUGIN_CHECK_IDS, PLUGIN_CHECK_TITLES, type PluginCheckId } from './checks.js';

export const PLUGIN_CHECK_REPORT_SCHEMA = 'openslack.plugin_check_report.v1' as const;
export const PLUGIN_CHECK_READINESS = Object.freeze(['READY_TO_REGISTER', 'BLOCKED'] as const);
export type PluginCheckReadiness = (typeof PLUGIN_CHECK_READINESS)[number];
export type PluginCheckState = 'PASS' | 'FAIL' | 'SKIP';

export interface PluginCheckResult {
  readonly id: PluginCheckId;
  readonly title: string;
  readonly state: PluginCheckState;
  readonly findingCodes: readonly PluginDiagnosticFinding['code'][];
}

export interface PluginCheckReport {
  readonly schema: typeof PLUGIN_CHECK_REPORT_SCHEMA;
  readonly readiness: PluginCheckReadiness;
  readonly manifestSha256?: string;
  readonly plugin?: {
    readonly id: string;
    readonly version: string;
    readonly requestedGateMode: 'SHADOW' | 'ENFORCE';
  };
  readonly integrityVerified: boolean;
  readonly checks: readonly PluginCheckResult[];
  readonly findings: readonly PluginDiagnosticFinding[];
  readonly authorizationNotice: 'HOST_REAUTHORIZATION_REQUIRED';
}

export function createPluginCheckResults(
  findingsByCheck: ReadonlyMap<PluginCheckId, readonly PluginDiagnosticFinding[]>,
  skipped: ReadonlySet<PluginCheckId> = new Set(),
): readonly PluginCheckResult[] {
  return Object.freeze(
    PLUGIN_CHECK_IDS.map((id) => {
      const findings = findingsByCheck.get(id) ?? [];
      return Object.freeze({
        id,
        title: PLUGIN_CHECK_TITLES[id],
        state: skipped.has(id) ? 'SKIP' : findings.length > 0 ? 'FAIL' : 'PASS',
        findingCodes: Object.freeze(findings.map((finding) => finding.code)),
      });
    }),
  );
}

export function renderPluginCheckPlain(report: PluginCheckReport): string {
  const lines = [
    `Plugin check: ${report.readiness}`,
    `Integrity: ${report.integrityVerified ? 'VERIFIED' : 'NOT_REQUESTED'}`,
  ];
  if (report.plugin) lines.push(`Plugin: ${report.plugin.id}@${report.plugin.version}`);
  for (const check of report.checks) {
    const suffix = check.findingCodes.length > 0 ? ` (${check.findingCodes.join(', ')})` : '';
    lines.push(`[${check.state}] ${check.id} ${check.title}${suffix}`);
  }
  lines.push('Authorization: HOST_REAUTHORIZATION_REQUIRED');
  return lines.join('\n');
}
