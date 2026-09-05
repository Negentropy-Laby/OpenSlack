BEGIN;
CREATE INDEX workflow_runner_bindings_run_recovery_idx ON workflow_runner_authority_bindings
    (workspace_id, run_id, accepted_resume_generation, accepted_run_revision, target_sequence, binding_id);
COMMIT;
