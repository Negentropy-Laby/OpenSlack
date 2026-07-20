// Fixture: Full lifecycle ambient workflow with parallel, pipeline, multiple phases.
// Has meta with 3 phases (Scan, Verify, Report), then ambient body using
// args, phase, parallel, agent, pipeline, budget, log.
// analyzeStaticMeta should parse the meta successfully.

export const meta = {
  name: 'ambient-full-lifecycle',
  description: 'Full lifecycle ambient claude workflow',
  phases: [
    { title: 'Scan', detail: 'Scan phase' },
    { title: 'Verify', detail: 'Verify findings' },
    { title: 'Report', detail: 'Report results' },
  ],
};

const targetPath = args.targetPath || '.';

phase('Scan');
log('Scanning target: ' + targetPath);

const scanResults = await parallel([
  () => agent('Scan for security issues', { label: 'scan:security', phase: 'Scan' }),
  () => agent('Scan for performance issues', { label: 'scan:perf', phase: 'Scan' }),
]);

log('Parallel scan complete: ' + scanResults.length + ' result sets');

phase('Verify');
log('Verifying findings with pipeline');

const verifiedItems = ['security', 'performance', 'style'];
const verified = await pipeline(verifiedItems, (item, idx) => {
  return agent('Verify ' + item + ' findings', {
    label: 'verify:' + item,
    phase: 'Verify',
  });
});

log('Pipeline verification complete');

phase('Report');
log('Budget used: ' + budget.tokensUsed);
log(
  'Budget remaining: ' + (budget.tokensRemaining !== null ? budget.tokensRemaining : 'unlimited'),
);
log('Report generation complete');
