BEGIN;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM workflow_runner_jobs WHERE required_protocol_version='openslack.workflow_runner.v2')
       OR EXISTS (SELECT 1 FROM workflow_runner_process_sessions WHERE protocol_version='openslack.workflow_runner.v2')
       OR EXISTS (SELECT 1 FROM workflow_runner_v2_attempt_bindings)
       OR EXISTS (SELECT 1 FROM workflow_runner_v2_event_inbox)
       OR EXISTS (SELECT 1 FROM workflow_runner_v2_decision_bindings)
       OR EXISTS (SELECT 1 FROM workflow_runner_v2_cancel_bindings)
       OR EXISTS (SELECT 1 FROM workflow_runner_worker_events WHERE kind IN ('checkpoint_commit','budget_reserve_request','budget_usage_report'))
       OR EXISTS (SELECT 1 FROM workflow_runner_control_messages WHERE kind IN ('budget_authorization','effect_authorization','resume_offer')) THEN
        RAISE EXCEPTION 'cannot remove Workflow Runner v2 integration while v2 evidence exists';
    END IF;
END
$$;

DROP INDEX workflow_runner_jobs_protocol_dispatch_idx;
DROP INDEX workflow_runner_v2_inbox_state_idx;
DROP TABLE workflow_runner_v2_cancel_bindings;
DROP TABLE workflow_runner_v2_decision_bindings;
DROP TABLE workflow_runner_v2_event_inbox;
DROP TABLE workflow_runner_v2_attempt_bindings;
DROP FUNCTION workflow_runner_v2_attempt_binding_transition();

ALTER TABLE workflow_runner_control_messages
    DROP CONSTRAINT workflow_runner_control_messages_delivery_phase_check,
    DROP CONSTRAINT workflow_runner_control_messages_delivery_state_check,
    DROP CONSTRAINT workflow_runner_control_messages_kind_check,
    DROP COLUMN delivery_started_at,
    ADD CONSTRAINT workflow_runner_control_messages_kind_check CHECK (kind IN ('hello_ack','lease_offer','cancel_request','event_receipt')),
    ADD CONSTRAINT workflow_runner_control_messages_delivery_state_check CHECK (delivery_state IN ('pending','delivered','abandoned'));

ALTER TABLE workflow_runner_worker_events DROP CONSTRAINT workflow_runner_worker_events_kind_check;
ALTER TABLE workflow_runner_worker_events ADD CONSTRAINT workflow_runner_worker_events_kind_check CHECK (kind IN (
    'lease_accept','lease_reject','heartbeat','effect_intent','effect_outcome','cancel_ack','terminal'
));

ALTER TABLE workflow_runner_process_sessions
    DROP CONSTRAINT workflow_runner_process_sessions_protocol_version_check,
    DROP CONSTRAINT workflow_runner_process_sessions_capabilities_check,
    ADD CONSTRAINT workflow_runner_process_sessions_protocol_version_check CHECK (protocol_version='openslack.workflow_runner.v1'),
    ADD CONSTRAINT workflow_runner_process_sessions_capabilities_check CHECK (capabilities=ARRAY['cancel_ack','effect_receipts','lease_heartbeat']::TEXT[]);

DROP TRIGGER workflow_runner_jobs_binding_immutable ON workflow_runner_jobs;
DROP FUNCTION workflow_runner_reject_binding_mutation();
ALTER TABLE workflow_runner_jobs
    DROP CONSTRAINT workflow_runner_jobs_required_capabilities_check,
    DROP CONSTRAINT workflow_runner_jobs_protocol_binding_check,
    DROP COLUMN required_resume_generation,
    DROP COLUMN required_run_revision,
    DROP COLUMN authority_build_hash,
    DROP COLUMN routing_epoch,
    DROP COLUMN workflow_authority,
    DROP COLUMN authority_backend,
    DROP COLUMN required_capabilities,
    DROP COLUMN required_protocol_version;

COMMIT;
