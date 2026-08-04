#!/usr/bin/env node
import { runWorkflowRunnerWorker } from './workflow-runner-worker.js';

runWorkflowRunnerWorker().catch((error: unknown) => {
  const name = error instanceof Error ? error.name : 'Error';
  process.stderr.write(`[WORKFLOW_RUNNER_WORKER_START_FAILED] ${name.slice(0, 128)}\n`);
  process.exitCode = 1;
});
