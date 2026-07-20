// Fixture: Claude ambient DSL using phase/log/agent at top level after meta export.
// Body uses phase(), log(), and await agent() at top level (no named handler exports).
// analyzeStaticMeta should parse the meta successfully.

export const meta = {
  name: 'ambient-basic',
  description: 'Basic ambient DSL claude workflow',
  phases: [
    { title: 'Scan', detail: 'Scan phase' },
    { title: 'Report', detail: 'Report findings' },
  ],
};

phase('Scan');
log('Starting ambient scan');

const findings = await agent('Scan the codebase for issues', {
  label: 'scan:basic',
  phase: 'Scan',
});

log('Scan complete, found issues');

phase('Report');
log('Reporting findings');
