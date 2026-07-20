// Fixture: Uses Claude budget API.
// Has meta, then uses budget.total, budget.spent(), budget.remaining() at top level.
// analyzeStaticMeta should parse the meta successfully.

export const meta = {
  name: 'ambient-budget',
  description: 'Budget API ambient claude workflow',
  phases: [
    { title: 'Plan', detail: 'Plan budget allocation' },
    { title: 'Execute', detail: 'Execute within budget' },
  ],
};

phase('Plan');
log('Checking budget before execution');
log('Tokens used: ' + budget.tokensUsed);
log(
  'Tokens remaining: ' + (budget.tokensRemaining !== null ? budget.tokensRemaining : 'unlimited'),
);
log('Agent calls so far: ' + budget.agentCalls);

phase('Execute');
log('Executing agent call');

const result = await agent('Analyze code quality within budget', {
  label: 'exec:quality',
  phase: 'Execute',
});

log('Post-execution tokens used: ' + budget.tokensUsed);
log('Post-execution agent calls: ' + budget.agentCalls);
