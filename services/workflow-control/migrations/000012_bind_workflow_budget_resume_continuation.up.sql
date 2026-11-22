BEGIN;

ALTER TABLE workflow_control_budget_accounts ADD COLUMN resume_run_revision_delta BIGINT NOT NULL DEFAULT 0
    CHECK (resume_run_revision_delta BETWEEN 0 AND 9007199254740990);

CREATE TABLE workflow_control_budget_resume_continuations (
    workspace_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    account_revision BIGINT NOT NULL CHECK (account_revision BETWEEN 2 AND 9007199254740991),
    previous_run_revision BIGINT NOT NULL CHECK (previous_run_revision BETWEEN 1 AND 9007199254740989),
    expected_run_revision BIGINT NOT NULL CHECK (expected_run_revision BETWEEN previous_run_revision + 1 AND 9007199254740990),
    previous_account_hash BYTEA NOT NULL CHECK (octet_length(previous_account_hash)=32),
    binding_id TEXT NOT NULL UNIQUE REFERENCES workflow_runner_authority_bindings(binding_id),
    request_hash BYTEA NOT NULL CHECK (octet_length(request_hash)=32),
    run_record_hash BYTEA NOT NULL CHECK (octet_length(run_record_hash)=32),
    PRIMARY KEY (workspace_id, run_id, account_revision),
    FOREIGN KEY (workspace_id, run_id, account_revision)
        REFERENCES workflow_control_budget_ledger(workspace_id, run_id, account_revision)
);

CREATE TRIGGER workflow_control_budget_resume_continuations_immutable
BEFORE UPDATE OR DELETE ON workflow_control_budget_resume_continuations
FOR EACH ROW EXECUTE FUNCTION workflow_control_budget_reject_immutable_mutation();

CREATE INDEX workflow_runner_resumed_budget_request_idx
ON workflow_runner_authority_bindings (workspace_id, run_id, operation, source_request_hash)
WHERE state='resolved' AND source_expected_resume_generation=1
  AND operation IN ('budget_reserve','budget_settle');

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
       OR OLD.resume_run_revision_delta <> NEW.resume_run_revision_delta
       OR NEW.account_revision <> OLD.account_revision + 1
       OR NEW.updated_at < OLD.updated_at THEN
        RAISE EXCEPTION 'workflow budget account update violates immutable identity or monotonic revision';
    END IF;
    IF NEW.run_revision <> OLD.run_revision + 1 THEN
        IF NOT EXISTS (
            SELECT 1
            FROM workflow_control_budget_resume_continuations w
            JOIN workflow_control_runs r USING (workspace_id, run_id)
            JOIN workflow_runner_authority_bindings f ON f.binding_id=w.binding_id
            WHERE w.workspace_id=OLD.workspace_id AND w.run_id=OLD.run_id AND w.account_id=OLD.account_id
              AND w.account_revision=NEW.account_revision AND w.previous_run_revision=OLD.run_revision
              AND w.previous_account_hash=OLD.account_hash AND w.expected_run_revision+1=NEW.run_revision
              AND r.state='running' AND r.resume_generation=1 AND r.revision=w.expected_run_revision
              AND r.record_hash=w.run_record_hash
              AND f.workspace_id=w.workspace_id AND f.run_id=w.run_id AND f.operation='budget_reserve'
              AND f.state='resolved' AND f.source_evidence_state='prepared'
              AND f.source_expected_revision=OLD.account_revision AND f.source_request_hash=w.request_hash
              AND f.source_expected_resume_generation=1 AND f.source_accepted_resume_generation=1
        ) THEN
            RAISE EXCEPTION 'workflow budget account run revision gap lacks a resume continuation';
        END IF;
        NEW.resume_run_revision_delta := OLD.resume_run_revision_delta + (NEW.run_revision - OLD.run_revision - 1);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMIT;
