import { describe, it, expect } from 'vitest';
import { renderFindingPlain, renderFindingsPlain } from '../plain-render.js';

describe('renderFindingPlain', () => {
  it('maps PASS to OK', () => {
    const result = renderFindingPlain({ status: 'PASS', title: 'Test check', detail: 'All good' });
    expect(result).toContain('OK: Test check');
    expect(result).toContain('All good');
  });

  it('maps WARN to Attention', () => {
    const result = renderFindingPlain({ status: 'WARN', title: 'Auth', detail: 'No credentials' });
    expect(result).toContain('Attention: Auth');
  });

  it('maps FAIL to Action needed with fix guidance', () => {
    const result = renderFindingPlain({
      status: 'FAIL',
      title: 'Labels',
      detail: 'Missing 3 labels',
      nextAction: 'Run openslack github repair labels',
    });
    expect(result).toContain('Action needed: Labels');
    expect(result).toContain('How to fix: Run openslack github repair labels');
  });

  it('includes command when present', () => {
    const result = renderFindingPlain({
      status: 'fixable_by_command',
      title: 'Shell',
      detail: 'No Git Bash detected',
      command: 'bash scripts/genesis-validate.sh',
    });
    expect(result).toContain('Fix available: Shell');
    expect(result).toContain('Run: bash scripts/genesis-validate.sh');
  });

  it('maps informational to Note', () => {
    const result = renderFindingPlain({ status: 'informational', title: 'Info', detail: 'FYI' });
    expect(result).toContain('Note: Info');
  });

  it('maps requires_human_approval to Needs approval', () => {
    const result = renderFindingPlain({
      status: 'requires_human_approval',
      title: 'CODEOWNERS',
      detail: 'Human approval required',
    });
    expect(result).toContain('Needs approval: CODEOWNERS');
  });
});

describe('renderFindingsPlain', () => {
  it('renders multiple findings separated by blank line', () => {
    const result = renderFindingsPlain([
      { status: 'PASS', title: 'A', detail: 'a' },
      { status: 'FAIL', title: 'B', detail: 'b', nextAction: 'Fix it' },
    ]);
    expect(result).toContain('OK: A');
    expect(result).toContain('Action needed: B');
    expect(result.split('\n\n')).toHaveLength(2);
  });
});
