import type { Intent, MissingParam } from './types.js';

const MAX_CLARIFICATION_ROUNDS = 3;

const REQUIRED_PARAMS: Record<
  string,
  Array<{ name: string; type: 'string' | 'number' | 'string[]'; description: string }>
> = {
  pr_merge: [{ name: 'prNumber', type: 'number', description: 'Pull request number to merge' }],
  pr_doctor: [{ name: 'prNumber', type: 'number', description: 'Pull request number to diagnose' }],
  pr_review: [{ name: 'prNumber', type: 'number', description: 'Pull request number to review' }],
  pr_watch: [{ name: 'prNumber', type: 'number', description: 'Pull request number to watch' }],
  pr_status: [
    { name: 'prNumber', type: 'number', description: 'Pull request number to check status' },
  ],
  checkout_task: [
    { name: 'issueNumber', type: 'number', description: 'Issue number to checkout' },
    { name: 'agentId', type: 'string', description: 'Agent ID (e.g., claude_code_001)' },
  ],
  sync_task: [
    { name: 'issueNumber', type: 'number', description: 'Issue number to sync' },
    { name: 'agentId', type: 'string', description: 'Agent ID' },
    { name: 'paths', type: 'string[]', description: 'Paths to include in sync (glob patterns)' },
  ],
  issue_done: [{ name: 'issueNumber', type: 'number', description: 'Issue number to mark done' }],
  claim_task: [{ name: 'agentId', type: 'string', description: 'Agent ID' }],
  create_task: [
    {
      name: 'title',
      type: 'string',
      description: 'Task title, e.g. --title "Fix failing validation"',
    },
  ],
};

export function identifyMissingParams(intent: Intent): MissingParam[] {
  const required = REQUIRED_PARAMS[intent.kind];
  if (!required) return [];

  const missing: MissingParam[] = [];
  for (const param of required) {
    const value = intent.slots[param.name];
    if (
      value === undefined ||
      value === null ||
      value === '' ||
      (Array.isArray(value) && value.length === 0)
    ) {
      missing.push({ ...param, required: true });
    }
  }
  return missing;
}

export function buildClarificationQuestion(
  missing: MissingParam[],
  round: number = 0,
  intentKind?: string,
): string {
  if (missing.length === 0) return '';

  const items = missing.map((m) => m.description).join(', ');

  if (round === 0) {
    return missing.length === 1
      ? `I need more information: ${missing[0].description}.`
      : `I need more information: ${items}.`;
  }

  if (round === 1) {
    const hints = missing
      .map((m) => {
        if (m.type === 'number') return `${m.name}: just say the number, like "#42"`;
        if (m.type === 'string') return `${m.name}: type the value directly`;
        return `${m.name}: provide a list`;
      })
      .join('. ');
    return `Still need: ${items}. Tip: ${hints}`;
  }

  // Round 2+: suggest direct CLI alternative
  const altCommand = buildDirectAlternative(intentKind, missing);
  return `Still missing: ${items}. Max clarification rounds reached.${altCommand}`;
}

function buildDirectAlternative(intentKind?: string, missing?: MissingParam[]): string {
  if (!intentKind || !missing) return '';
  const commandMap: Record<string, string> = {
    pr_merge: 'openslack pr merge <NUMBER>',
    pr_doctor: 'openslack pr doctor <NUMBER>',
    pr_review: 'openslack pr review <NUMBER>',
    pr_watch: 'openslack pr watch <NUMBER>',
    pr_status: 'openslack pr status <NUMBER>',
    checkout_task: 'openslack task checkout <NUMBER> --agent-id <ID>',
    create_task: 'openslack task create --title "<TITLE>"',
    issue_done: 'openslack task done <NUMBER>',
  };
  const cmd = commandMap[intentKind];
  return cmd ? ` You can run it directly: ${cmd}` : '';
}

export { MAX_CLARIFICATION_ROUNDS };
