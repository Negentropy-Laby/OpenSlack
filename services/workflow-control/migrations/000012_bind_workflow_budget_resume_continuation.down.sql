BEGIN;

LOCK TABLE workflow_control_budget_accounts, workflow_control_budget_resume_continuations IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM workflow_control_budget_resume_continuations) THEN
        RAISE EXCEPTION 'workflow budget resume continuations are required for ledger replay';
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION workflow_control_budget_account_transition()
RETURNS trigger AS $$
BEGIN
    IF OLD.workspace_id <> NEW.workspace_id
       OR OLD.run_id <> NEW.run_id
       OR OLD.account_id <> NEW.account_id
       OR OLD.policy_hash <> NEW.policy_hash
       OR OLD.backend <> NEW.backend
       OR OLD.authority <> NEW.authority
       OR OLD.routing_epoch <> NEW.routing_epoch
       OR OLD.authority_build_hash <> NEW.authority_build_hash
       OR OLD.genesis_account_hash <> NEW.genesis_account_hash
       OR OLD.canonical_genesis_account_bytes <> NEW.canonical_genesis_account_bytes
       OR OLD.limit_tokens <> NEW.limit_tokens
       OR OLD.limit_nano_usd <> NEW.limit_nano_usd
       OR OLD.limit_calls <> NEW.limit_calls
       OR OLD.created_at <> NEW.created_at
       OR NEW.account_revision <> OLD.account_revision + 1
       OR NEW.run_revision <> OLD.run_revision + 1
       OR NEW.updated_at < OLD.updated_at THEN
        RAISE EXCEPTION 'workflow budget account update violates immutable identity or monotonic revision';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP INDEX workflow_runner_resumed_budget_request_idx;
DROP TABLE workflow_control_budget_resume_continuations;
ALTER TABLE workflow_control_budget_accounts DROP COLUMN resume_run_revision_delta;

COMMIT;
