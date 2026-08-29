BEGIN;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM workflow_runner_authority_bindings)
       OR EXISTS (SELECT 1 FROM workflow_runner_authority_control_acks)
       OR EXISTS (SELECT 1 FROM workflow_runner_authority_reconciliations)
       OR EXISTS (SELECT 1 FROM workflow_runner_v2_runtime_admissions)
       OR EXISTS (SELECT 1 FROM workflow_runner_v2_event_inbox WHERE kind='effect_outcome')
       OR EXISTS (SELECT 1 FROM workflow_runner_control_messages WHERE delivery_state='awaiting_ack')
       OR EXISTS (SELECT 1 FROM workflow_runner_v2_attempt_bindings WHERE last_authority_operation='effect_complete') THEN
        RAISE EXCEPTION 'cannot remove Workflow Runner authority-binding delivery while schema-8 evidence exists';
    END IF;
END
$$;

DROP INDEX workflow_runner_authority_reconciliations_job_idx;
DROP INDEX workflow_runner_authority_control_acks_binding_idx;
DROP INDEX workflow_runner_authority_bindings_attempt_idx;
DROP INDEX workflow_runner_authority_bindings_recovery_idx;
DROP TRIGGER workflow_runner_authority_reconciliations_immutable ON workflow_runner_authority_reconciliations;
DROP TRIGGER workflow_runner_authority_control_acks_immutable ON workflow_runner_authority_control_acks;
DROP TRIGGER workflow_runner_authority_control_acks_insert ON workflow_runner_authority_control_acks;
DROP TRIGGER workflow_runner_authority_bindings_no_delete ON workflow_runner_authority_bindings;
DROP TRIGGER workflow_runner_authority_bindings_transition ON workflow_runner_authority_bindings;
DROP FUNCTION workflow_runner_authority_control_ack_insert();
DROP FUNCTION workflow_runner_authority_binding_transition();

-- Break the circular binding/reconciliation reference before either table is
-- dropped. The schema-8 emptiness guard above makes this non-destructive.
ALTER TABLE workflow_runner_authority_bindings
    DROP CONSTRAINT workflow_runner_authority_bindings_reconciliation_fk;
DROP TABLE workflow_runner_authority_control_acks;
DROP TABLE workflow_runner_authority_reconciliations;
DROP TABLE workflow_runner_authority_bindings;

ALTER TABLE workflow_runner_v2_attempt_bindings
    DROP CONSTRAINT workflow_runner_v2_attempt_binding_admission_fk,
    DROP CONSTRAINT workflow_runner_v2_attempt_binding_admission_check,
    DROP COLUMN admission_disposition,
    DROP COLUMN admission_job_spec_hash;
DROP TRIGGER workflow_runner_v2_runtime_admissions_guard ON workflow_runner_v2_runtime_admissions;
DROP FUNCTION workflow_runner_v2_runtime_admission_guard();
DROP TABLE workflow_runner_v2_runtime_admissions;

DROP TRIGGER workflow_runner_v2_event_inbox_transition_f2b ON workflow_runner_v2_event_inbox;
DROP FUNCTION workflow_runner_v2_event_inbox_transition_f2b();

ALTER TABLE workflow_runner_control_messages
    DROP CONSTRAINT workflow_runner_control_messages_delivery_phase_check,
    DROP CONSTRAINT workflow_runner_control_messages_delivery_state_check;
ALTER TABLE workflow_runner_control_messages
    ADD CONSTRAINT workflow_runner_control_messages_delivery_state_check CHECK (
        delivery_state IN ('pending','delivering','delivered','abandoned','reconciliation_required')
    ),
    ADD CONSTRAINT workflow_runner_control_messages_delivery_phase_check CHECK (
        (delivery_state='pending' AND delivery_started_at IS NULL AND delivered_at IS NULL)
        OR (delivery_state IN ('delivering','reconciliation_required')
            AND delivery_started_at IS NOT NULL AND delivered_at IS NULL)
        OR (delivery_state='delivered' AND delivered_at IS NOT NULL)
        OR (delivery_state='abandoned' AND delivered_at IS NULL)
    );

ALTER TABLE workflow_runner_v2_event_inbox
    DROP CONSTRAINT workflow_runner_v2_event_inbox_kind_check;
ALTER TABLE workflow_runner_v2_event_inbox
    ADD CONSTRAINT workflow_runner_v2_event_inbox_kind_check CHECK (kind IN (
        'lease_accept','effect_intent','checkpoint_commit','budget_reserve_request','budget_usage_report'
    ));

CREATE OR REPLACE FUNCTION workflow_runner_v2_attempt_binding_transition()
RETURNS trigger AS $$
BEGIN
    IF OLD.attempt_id <> NEW.attempt_id OR OLD.workspace_id <> NEW.workspace_id OR OLD.job_id <> NEW.job_id
       OR OLD.authority_backend <> NEW.authority_backend OR OLD.workflow_authority <> NEW.workflow_authority
       OR OLD.routing_epoch <> NEW.routing_epoch OR OLD.authority_build_hash <> NEW.authority_build_hash
       OR OLD.initial_run_revision <> NEW.initial_run_revision
       OR OLD.initial_resume_generation <> NEW.initial_resume_generation
       OR OLD.required_capabilities <> NEW.required_capabilities OR OLD.created_at <> NEW.created_at
       OR NEW.last_authority_operation IS NULL OR NEW.last_authority_event_id IS NULL
       OR NEW.last_authority_event_id IS NOT DISTINCT FROM OLD.last_authority_event_id
       OR NOT (
          (NEW.last_authority_operation IN ('checkpoint_commit','effect_authorize')
             AND NEW.current_run_revision=OLD.current_run_revision
             AND NEW.current_resume_generation=OLD.current_resume_generation)
          OR (NEW.last_authority_operation IN ('budget_reserve','budget_settle')
             AND NEW.current_run_revision=OLD.current_run_revision+1
             AND NEW.current_resume_generation=OLD.current_resume_generation)
          OR (NEW.last_authority_operation='resume_advance'
             AND NEW.current_run_revision=OLD.current_run_revision+1
             AND NEW.current_resume_generation=OLD.current_resume_generation+1)
       ) THEN
        RAISE EXCEPTION 'workflow runner v2 attempt binding transition is invalid';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER TABLE workflow_runner_v2_attempt_bindings
    DROP CONSTRAINT workflow_runner_v2_attempt_bindi_last_authority_operation_check;
ALTER TABLE workflow_runner_v2_attempt_bindings
    ADD CONSTRAINT workflow_runner_v2_attempt_bindi_last_authority_operation_check CHECK (
        last_authority_operation IS NULL OR last_authority_operation IN (
            'checkpoint_commit','effect_authorize','budget_reserve','budget_settle','resume_advance'
        )
    );
COMMIT;
