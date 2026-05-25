import type { Intent, MissingParam } from './types.js';

const REQUIRED_PARAMS: Record<string, Array<{ name: string; type: 'string' | 'number' | 'string[]'; description: string }>> = {
  pr_merge: [{ name: 'prNumber', type: 'number', description: 'Pull request number to merge' }],
  pr_doctor: [{ name: 'prNumber', type: 'number', description: 'Pull request number to diagnose' }],
  pr_review: [{ name: 'prNumber', type: 'number', description: 'Pull request number to review' }],
  pr_watch: [{ name: 'prNumber', type: 'number', description: 'Pull request number to watch' }],
  pr_status: [{ name: 'prNumber', type: 'number', description: 'Pull request number to check status' }],
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
  create_task: [{ name: 'title', type: 'string', description: 'Task title, e.g. --title "Fix failing validation"' }],
};

export function identifyMissingParams(intent: Intent): MissingParam[] {
  const required = REQUIRED_PARAMS[intent.kind];
  if (!required) return [];

  const missing: MissingParam[] = [];
  for (const param of required) {
    const value = intent.slots[param.name];
    if (value === undefined || value === null || value === '' ||
        (Array.isArray(value) && value.length === 0)) {
      missing.push({ ...param, required: true });
    }
  }
  return missing;
}

export function buildClarificationQuestion(missing: MissingParam[]): string {
  if (missing.length === 0) return '';
  if (missing.length === 1) {
    return `I need more information: ${missing[0].description}.`;
  }
  const items = missing.map((m) => m.description).join(', ');
  return `I need more information: ${items}.`;
}
