BEGIN;

DROP TRIGGER IF EXISTS workflow_runner_reconciliations_immutable ON workflow_runner_reconciliations;
DROP TRIGGER IF EXISTS workflow_runner_effect_boundaries_no_delete ON workflow_runner_effect_boundaries;
DROP TRIGGER IF EXISTS workflow_runner_event_receipts_immutable ON workflow_runner_event_receipts;
DROP TRIGGER IF EXISTS workflow_runner_worker_events_immutable ON workflow_runner_worker_events;
DROP TRIGGER IF EXISTS workflow_runner_job_receipts_immutable ON workflow_runner_job_receipts;

DROP TABLE IF EXISTS workflow_runner_reconciliations;
DROP TABLE IF EXISTS workflow_runner_effect_boundaries;
DROP TABLE IF EXISTS workflow_runner_cancel_controls;
DROP TABLE IF EXISTS workflow_runner_event_receipts;
DROP TABLE IF EXISTS workflow_runner_control_messages;
DROP TABLE IF EXISTS workflow_runner_worker_events;
DROP TABLE IF EXISTS workflow_runner_process_sessions;
DROP TABLE IF EXISTS workflow_runner_leases;
ALTER TABLE IF EXISTS workflow_runner_jobs DROP CONSTRAINT IF EXISTS workflow_runner_jobs_current_attempt_fk;
DROP TABLE IF EXISTS workflow_runner_attempts;
DROP TABLE IF EXISTS workflow_runner_job_receipts;
DROP TABLE IF EXISTS workflow_runner_jobs;
DROP FUNCTION IF EXISTS workflow_runner_reject_immutable_mutation();

COMMIT;
