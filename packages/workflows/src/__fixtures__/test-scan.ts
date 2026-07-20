import type { WorkflowMeta, WorkflowRuntime, PreviewResult, RunResult } from '../types.js';

export const meta: WorkflowMeta = {
  name: 'test-scan',
  description: 'Minimal test workflow for integration tests',
  phases: [
    { title: 'Scan', detail: 'Single dimension scan' },
    { title: 'Verify', detail: 'Single verifier' },
  ],
  permissions: { github: ['issues:read'] },
  risk: 'low',
};

export async function preview(
  ctx: WorkflowRuntime,
  args: Record<string, unknown>,
): Promise<PreviewResult> {
  ctx.phase('Scan');
  ctx.log('Test scan starting');
  const result = await ctx.agent('Scan for test findings', {
    label: 'scan:test',
    phase: 'Scan',
    schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
  });
  return { preview: true, result };
}

export async function run(ctx: WorkflowRuntime, args: Record<string, unknown>): Promise<RunResult> {
  const previewResult = await preview(ctx, args);
  ctx.phase('Verify');
  return { status: 'complete', ...previewResult };
}
