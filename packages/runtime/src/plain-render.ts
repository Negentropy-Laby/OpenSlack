export interface PlainFinding {
  status:
    | 'PASS'
    | 'WARN'
    | 'FAIL'
    | 'ok'
    | 'fixable_by_command'
    | 'requires_github_admin'
    | 'requires_human_approval'
    | 'informational';
  title: string;
  detail: string;
  nextAction?: string;
  command?: string;
}

const STATUS_MAP: Record<string, { label: string; verb: string }> = {
  PASS: { label: 'OK', verb: 'looks good' },
  WARN: { label: 'Attention', verb: 'needs attention' },
  FAIL: { label: 'Action needed', verb: 'requires action' },
  ok: { label: 'OK', verb: 'looks good' },
  fixable_by_command: { label: 'Fix available', verb: 'can be fixed automatically' },
  requires_github_admin: { label: 'Needs admin', verb: 'requires GitHub admin access' },
  informational: { label: 'Note', verb: 'for your information' },
  requires_human_approval: { label: 'Needs approval', verb: 'requires human approval' },
};

export function renderFindingPlain(finding: PlainFinding): string {
  const mapped = STATUS_MAP[finding.status] ?? { label: finding.status, verb: finding.detail };
  const lines: string[] = [];
  lines.push(`${mapped.label}: ${finding.title}`);
  lines.push(`  ${finding.detail}`);
  if (finding.nextAction) lines.push(`  How to fix: ${finding.nextAction}`);
  if (finding.command) lines.push(`  Run: ${finding.command}`);
  return lines.join('\n');
}

export function renderFindingsPlain(findings: PlainFinding[]): string {
  return findings.map(renderFindingPlain).join('\n\n');
}
