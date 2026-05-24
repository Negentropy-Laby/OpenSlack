import { describe, it, expect } from 'vitest';
import { parseIntent } from '../intent.js';

describe('parseIntent', () => {
  describe('diagnostics', () => {
    it('parses status check', () => {
      const i = parseIntent('check status');
      expect(i.kind).toBe('status');
      expect(i.confidence).toBeGreaterThan(0.5);
    });

    it('parses doctor', () => {
      const i = parseIntent('doctor');
      expect(i.kind).toBe('doctor');
    });

    it('parses governance audit', () => {
      const i = parseIntent('run governance audit');
      expect(i.kind).toBe('governance_audit');
    });
  });

  describe('PRMS', () => {
    it('parses PR status', () => {
      const i = parseIntent('PR #12 status');
      expect(i.kind).toBe('pr_status');
      expect(i.slots.prNumber).toBe(12);
    });

    it('parses PR doctor', () => {
      const i = parseIntent('doctor PR #12');
      expect(i.kind).toBe('pr_doctor');
      expect(i.slots.prNumber).toBe(12);
    });

    it('parses PR review', () => {
      const i = parseIntent('review PR 12');
      expect(i.kind).toBe('pr_review');
      expect(i.slots.prNumber).toBe(12);
    });

    it('parses PR merge', () => {
      const i = parseIntent('merge PR #12');
      expect(i.kind).toBe('pr_merge');
      expect(i.slots.prNumber).toBe(12);
    });

    it('parses PR watch', () => {
      const i = parseIntent('watch PR 12');
      expect(i.kind).toBe('pr_watch');
      expect(i.slots.prNumber).toBe(12);
    });

    it('parses PR queue', () => {
      const i = parseIntent('show PR queue');
      expect(i.kind).toBe('pr_queue');
    });

    it('defaults ambiguous PR query to doctor', () => {
      const i = parseIntent('PR 12');
      expect(i.kind).toBe('pr_doctor');
    });

    it('parses Chinese PR query', () => {
      const i = parseIntent('PR #12 为什么不能合并');
      expect(i.kind).toBe('pr_doctor');
      expect(i.slots.prNumber).toBe(12);
    });
  });

  describe('tasks', () => {
    it('parses checkout with issue and agent', () => {
      const i = parseIntent('checkout issue #42 for agent claude_001');
      expect(i.kind).toBe('checkout_task');
      expect(i.slots.issueNumber).toBe(42);
      expect(i.slots.agentId).toBe('claude_001');
    });

    it('parses sync with paths', () => {
      const i = parseIntent('sync issue #42 --agent-id claude_001 --paths "packages/foo/**"');
      expect(i.kind).toBe('sync_task');
      expect(i.slots.issueNumber).toBe(42);
      expect(i.slots.agentId).toBe('claude_001');
      expect(i.slots.paths).toBe('packages/foo/**');
    });

    it('parses issue done', () => {
      const i = parseIntent('mark issue #99 done');
      expect(i.kind).toBe('issue_done');
      expect(i.slots.issueNumber).toBe(99);
    });

    it('parses claim task', () => {
      const i = parseIntent('claim a task for agent claude_001');
      expect(i.kind).toBe('claim_task');
      expect(i.slots.agentId).toBe('claude_001');
    });

    it('parses task creation title from quotes', () => {
      const i = parseIntent('create task "Investigate flaky setup"');
      expect(i.kind).toBe('create_task');
      expect(i.slots.title).toBe('Investigate flaky setup');
    });
  });

  describe('unknown', () => {
    it('returns unknown for unrecognized input', () => {
      const i = parseIntent('do something completely random');
      expect(i.kind).toBe('unknown');
    });
  });
});
