#!/usr/bin/env node
import {
  runWorkflowRunnerV2QualificationWorker,
  runWorkflowRunnerWorker,
  WORKFLOW_RUNNER_V2_QUALIFICATION_ENABLED_ENV,
} from './workflow-runner-worker.js';

const run =
  process.env[WORKFLOW_RUNNER_V2_QUALIFICATION_ENABLED_ENV] === '1'
    ? runWorkflowRunnerV2QualificationWorker
    : runWorkflowRunnerWorker;

run().catch((error: unknown) => {
  const name = error instanceof Error ? error.name : 'Error';
  process.stderr.write(`[WORKFLOW_RUNNER_WORKER_START_FAILED] ${name.slice(0, 128)}\n`);
  process.exitCode = 1;
});
