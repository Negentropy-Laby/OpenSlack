import { describe, expect, it } from 'vitest';
import { checkpointEvidence } from '../internal/workflow-runner-checkpoint-evidence.js';
import {
  checkpointState,
  recoveryFrame,
  recoveryHead,
  recoveryView,
  resumeIntentFixture,
} from './workflow-recovery-fixtures.js';
import { validateWorkflowCheckpointShadowEnvelope } from '../workflow-checkpoint-shadow-contract.js';

function replayFixture() {
  const { intent, frame } = resumeIntentFixture();
  const original = recoveryFrame(intent.prior, 'checkpoint_commit');
  const view = {
    ...recoveryView([original, frame]),
    activeAttempts: [intent.next.activeBinding.attemptId],
  };
  const baseHead = recoveryHead(intent.next);
  const head = {
    ...baseHead,
    state: 'running' as const,
    record: { ...baseHead.record, state: 'running' as const },
  };
  return {
    state: intent.next,
    original,
    proof: { view, head, binding: intent.next.activeBinding },
  };
}

describe('sealed checkpoint replay evidence', () => {
  it('refuses to re-mint an old checkpoint at the current resume generation', () => {
    const { intent } = resumeIntentFixture();
    expect(() => checkpointEvidence(intent.next, '1'.repeat(64), 0)).toThrow(
      /original.*evidence|recovery/i,
    );
  });

  it('keeps a genuinely new checkpoint envelope valid', () => {
    const state = checkpointState();
    const evidence = checkpointEvidence(state, '1'.repeat(64), 0);
    expect(validateWorkflowCheckpointShadowEnvelope(evidence.envelope)).toEqual(evidence.envelope);
  });

  it('returns the exact original evidence without promoting its revision or generation', () => {
    const { state, original, proof } = replayFixture();
    const before = JSON.stringify(proof.view);
    const evidence = checkpointEvidence(state, '1'.repeat(64), 0, proof);
    expect(evidence).toEqual(JSON.parse(original.resolution!).evidence);
    expect(evidence.sourceAuthority).toMatchObject({
      acceptedRevision: 2,
      acceptedResumeGeneration: 0,
    });
    expect(validateWorkflowCheckpointShadowEnvelope(evidence.envelope)).toEqual(evidence.envelope);
    expect(JSON.stringify(proof.view)).toBe(before);
  });

  it.each(['missing', 'partial', 'competing', 'binding', 'head', 'attempt', 'receipt'] as const)(
    'rejects %s original authority evidence',
    (fault) => {
      const { state, proof } = replayFixture();
      if (fault === 'missing') proof.view.bindings = [];
      if (fault === 'partial') proof.view.complete = false;
      if (fault === 'competing')
        proof.view.unfinished = [
          { bindingId: 'foreign', operation: 'checkpoint_commit', state: 'staged' },
        ];
      if (fault === 'binding') proof.binding = { ...proof.binding, leaseId: 'lease.foreign' };
      if (fault === 'head') proof.head = { ...proof.head, resumeGeneration: 0 };
      if (fault === 'attempt') proof.view.activeAttempts = ['attempt.foreign'];
      if (fault === 'receipt')
        proof.view.bindings = proof.view.bindings.map((x, i) =>
          i ? x : { ...x, stageReceipt: x.stageReceipt.replace('accepted', 'rejected') },
        );
      expect(() => checkpointEvidence(state, '1'.repeat(64), 0, proof)).toThrow();
    },
  );
});
