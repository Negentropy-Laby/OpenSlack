import { describe, it, expect } from 'vitest';
import { KNOWN_INTENTS } from '../intent-kinds.js';

describe('intent-kinds', () => {
  const expectedKinds: string[] = [
    'status',
    'doctor',
    'create_task',
    'claim_task',
    'checkout_task',
    'sync_task',
    'issue_done',
    'pr_status',
    'pr_doctor',
    'pr_review',
    'pr_queue',
    'pr_watch',
    'pr_merge',
    'github_repair_labels',
    'github_repair_claims',
    'task_repair_worktrees',
    'governance_audit',
    'workflow_recommended',
    'workflow_not_needed',
    'workflow_draft_required',
    'profile_sync',
    'unknown',
  ];

  it('KNOWN_INTENTS covers all IntentKind values', () => {
    for (const kind of expectedKinds) {
      expect(KNOWN_INTENTS).toContain(kind);
    }
  });

  it('no duplicate entries in KNOWN_INTENTS', () => {
    expect(new Set(KNOWN_INTENTS).size).toBe(KNOWN_INTENTS.length);
  });

  it('unknown is the last entry', () => {
    expect(KNOWN_INTENTS[KNOWN_INTENTS.length - 1]).toBe('unknown');
  });
});
