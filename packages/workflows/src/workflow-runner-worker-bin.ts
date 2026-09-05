#!/usr/bin/env node
import { runWorkflowRunnerV2Worker } from './workflow-runner-worker-public.js';

runWorkflowRunnerV2Worker().catch((error: unknown) => {
  const name = error instanceof Error ? error.name : 'Error';
  process.stderr.write(`[WORKFLOW_RUNNER_WORKER_START_FAILED] ${name.slice(0, 128)}\n`);
  process.exitCode = 1;
});
