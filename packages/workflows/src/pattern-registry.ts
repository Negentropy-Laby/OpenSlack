import type { WorkflowPatternManifest } from './types.js';

const PATTERNS: WorkflowPatternManifest[] = [
  {
    id: 'classify-and-act',
    name: 'Classify And Act',
    description: 'Classify each work item, then route it to the correct agent or workflow branch.',
    argsSchema: {
      type: 'object',
      properties: { items: { type: 'array' }, routes: { type: 'object' } },
    },
    defaultRisk: 'low',
    phases: [
      { title: 'Classify', detail: 'Classify each item into a route.' },
      { title: 'Act', detail: 'Run the selected action for each route.' },
      { title: 'Summarize', detail: 'Summarize routed outcomes.' },
    ],
    requiredCapabilities: ['classification', 'routing'],
    useCases: ['issue triage', 'PR queue triage', 'profile sync failure triage'],
  },
  {
    id: 'fanout-synthesize',
    name: 'Fan-Out And Synthesize',
    description:
      'Fan work out to independent agents, then synthesize structured results at a barrier.',
    argsSchema: {
      type: 'object',
      properties: { scope: { type: 'string' }, outputSchema: { type: 'object' } },
    },
    defaultRisk: 'low',
    phases: [
      { title: 'Partition', detail: 'Split the input set into independent work items.' },
      { title: 'Fanout', detail: 'Process items independently.' },
      { title: 'Synthesize', detail: 'Merge results into one structured output.' },
    ],
    requiredCapabilities: ['parallel agents', 'synthesis'],
    useCases: ['codebase audit', 'endpoint review', 'document verification'],
  },
  {
    id: 'adversarial-verification',
    name: 'Adversarial Verification',
    description:
      'Have independent verifier agents confirm, refute, or escalate candidate findings.',
    argsSchema: {
      type: 'object',
      properties: { candidates: { type: 'array' }, rubric: { type: 'string' } },
    },
    defaultRisk: 'low',
    phases: [
      { title: 'Generate', detail: 'Collect candidate findings or claims.' },
      { title: 'Verify', detail: 'Run independent verification against a rubric.' },
      { title: 'Decide', detail: 'Keep, drop, or escalate each candidate.' },
    ],
    requiredCapabilities: ['verification', 'rubric'],
    useCases: ['PR deep review', 'security analysis', 'claim validation'],
  },
  {
    id: 'generate-filter',
    name: 'Generate And Filter',
    description:
      'Generate many candidates, filter and dedupe them, then keep only the best outputs.',
    argsSchema: {
      type: 'object',
      properties: { topK: { type: 'number' }, dedupeBy: { type: 'string' } },
    },
    defaultRisk: 'low',
    phases: [
      { title: 'Generate', detail: 'Produce candidate alternatives.' },
      { title: 'Filter', detail: 'Apply rubric and dedupe rules.' },
      { title: 'Select', detail: 'Return the highest-quality candidates.' },
    ],
    requiredCapabilities: ['generation', 'filtering'],
    useCases: ['workflow design proposals', 'issue dedupe', 'architecture alternatives'],
  },
  {
    id: 'tournament',
    name: 'Tournament',
    description: 'Compare candidates pairwise until a winner or ranked shortlist emerges.',
    argsSchema: {
      type: 'object',
      properties: { contestants: { type: 'array' }, bracket: { enum: ['single-elimination'] } },
    },
    defaultRisk: 'low',
    phases: [
      { title: 'Seed', detail: 'Seed contestants into a bracket.' },
      { title: 'Judge', detail: 'Run pairwise comparisons.' },
      { title: 'Select', detail: 'Report the winner and bracket evidence.' },
    ],
    requiredCapabilities: ['judging', 'structured comparison'],
    useCases: ['naming', 'design alternatives', 'implementation strategy selection'],
  },
  {
    id: 'loop-until-done',
    name: 'Loop Until Done',
    description: 'Repeat a bounded workflow loop until a stop condition is satisfied.',
    argsSchema: {
      type: 'object',
      required: ['until', 'maxIterations'],
      properties: { until: { type: 'string' }, maxIterations: { type: 'number' } },
    },
    defaultRisk: 'medium',
    phases: [
      { title: 'Run Iteration', detail: 'Execute one bounded iteration.' },
      { title: 'Check Goal', detail: 'Evaluate the explicit stop condition.' },
      { title: 'Continue Or Stop', detail: 'Stop when done or when max iterations is reached.' },
    ],
    requiredCapabilities: ['goal checking', 'bounded loop'],
    useCases: ['no-new-finding sweeps', 'log triage', 'eval repair loops'],
  },
  {
    id: 'model-router',
    name: 'Model Router',
    description:
      'Route classification, verification, synthesis, and write tasks to suitable models and isolation modes.',
    argsSchema: { type: 'object', properties: { tasks: { type: 'array' } } },
    defaultRisk: 'low',
    phases: [
      { title: 'Classify Work', detail: 'Classify each task by purpose and write capability.' },
      { title: 'Route Model', detail: 'Choose cheap or strong model tier.' },
      { title: 'Route Isolation', detail: 'Require worktree isolation for write-capable tasks.' },
    ],
    requiredCapabilities: ['model routing', 'worktree policy'],
    useCases: ['large audits', 'migration planning', 'mixed-cost workflows'],
  },
];

export function listWorkflowPatterns(): WorkflowPatternManifest[] {
  return [...PATTERNS];
}

export function getWorkflowPattern(id: string): WorkflowPatternManifest | undefined {
  return PATTERNS.find((pattern) => pattern.id === id);
}

export function renderWorkflowPattern(pattern: WorkflowPatternManifest): string {
  const lines: string[] = [];
  lines.push(`Pattern: ${pattern.id}`);
  lines.push(`Name: ${pattern.name}`);
  lines.push(`Risk: ${pattern.defaultRisk}`);
  lines.push(`Description: ${pattern.description}`);
  lines.push('');
  lines.push('Phases:');
  for (const phase of pattern.phases) lines.push(`  - ${phase.title}: ${phase.detail}`);
  lines.push('');
  lines.push(`Capabilities: ${pattern.requiredCapabilities.join(', ')}`);
  lines.push(`Use cases: ${pattern.useCases.join(', ')}`);
  return lines.join('\n');
}
