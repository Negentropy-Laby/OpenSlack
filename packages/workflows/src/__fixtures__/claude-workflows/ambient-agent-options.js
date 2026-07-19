// Fixture: Uses agent() with model and agentType options.
// Has meta, then uses agent(prompt, { label, phase, model, agentType }) at top level.
// analyzeStaticMeta should parse the meta successfully.

export const meta = {
  name: 'ambient-agent-options',
  description: 'Agent options ambient claude workflow',
  phases: [
    { title: 'Explore', detail: 'Explore codebase' },
    { title: 'Analyze', detail: 'Analyze findings' },
  ],
};

phase('Explore');
log('Starting exploration with sonnet model');

const explored = await agent('Explore the codebase structure and patterns', {
  label: 'explore:structure',
  phase: 'Explore',
  model: 'sonnet',
  agentType: 'Explore',
});

log('Exploration complete');

phase('Analyze');
log('Starting analysis with sonnet model');

const analyzed = await agent('Analyze the explored data for insights', {
  label: 'analyze:insights',
  phase: 'Analyze',
  model: 'sonnet',
  agentType: 'Analyze',
});

log('Analysis complete');
