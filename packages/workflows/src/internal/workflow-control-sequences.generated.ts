// Generated from control-sequences.json. Do not edit.
export const WORKFLOW_CONTROL_SEQUENCES = Object.freeze({
  event_receipt: 3,
  budget_authorization: 4,
  effect_authorization: 4,
  resume_offer: 4,
  cancel_request: 4,
} as const);
export function workflowControlCompanionSequence(
  kind: keyof typeof WORKFLOW_CONTROL_SEQUENCES,
): 3 | 4 {
  return WORKFLOW_CONTROL_SEQUENCES[kind];
}
