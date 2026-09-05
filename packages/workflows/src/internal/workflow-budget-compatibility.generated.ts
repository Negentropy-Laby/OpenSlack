// Generated from workflow-budget-authority/compatibility.json. Do not edit.
export const WORKFLOW_BUDGET_CURRENT_MANIFEST_SHA256 =
  '83e5f88e01cbeb5e301004c34ed7cad446b98a59812771a9bf3be562a0509b3b' as const;
// Original pre-source-lock manifest retained for historical fixtures and callers.
export const WORKFLOW_BUDGET_PREVIOUS_MANIFEST_SHA256 =
  '662fdb7237d9225593f1988fc2069e15230482da26c46fac5db73e4ee2604548' as const;
export const WORKFLOW_BUDGET_ACCEPTED_MANIFEST_SHA256 = Object.freeze([
  '662fdb7237d9225593f1988fc2069e15230482da26c46fac5db73e4ee2604548',
  '83e5f88e01cbeb5e301004c34ed7cad446b98a59812771a9bf3be562a0509b3b',
] as const);
export function isAcceptedWorkflowBudgetManifest(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    (WORKFLOW_BUDGET_ACCEPTED_MANIFEST_SHA256 as readonly string[]).includes(value)
  );
}
