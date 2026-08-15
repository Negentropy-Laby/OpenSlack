-- GS9-E2 default-off Workflow budget qualification authority.
-- This namespace advances an existing GS9-B run head but does not activate
-- runner v2, production routing, or a Go Workflow writer cutover.
BEGIN;

CREATE OR REPLACE FUNCTION workflow_control_budget_reject_immutable_mutation()
RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'table % is immutable and does not allow UPDATE or DELETE', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

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

CREATE OR REPLACE FUNCTION workflow_control_budget_reservation_transition()
RETURNS trigger AS $$
BEGIN
    IF OLD.workspace_id <> NEW.workspace_id
       OR OLD.run_id <> NEW.run_id
       OR OLD.account_id <> NEW.account_id
       OR OLD.reservation_id <> NEW.reservation_id
       OR OLD.call_id <> NEW.call_id
       OR OLD.provider_attempt <> NEW.provider_attempt
       OR OLD.expected_provider_hash <> NEW.expected_provider_hash
       OR OLD.expected_model_hash <> NEW.expected_model_hash
       OR OLD.expected_provider_run_hash <> NEW.expected_provider_run_hash
       OR OLD.policy_hash <> NEW.policy_hash
       OR OLD.backend <> NEW.backend
       OR OLD.authority <> NEW.authority
       OR OLD.routing_epoch <> NEW.routing_epoch
       OR OLD.authority_build_hash <> NEW.authority_build_hash
       OR OLD.rate_nano_usd_per_token <> NEW.rate_nano_usd_per_token
       OR OLD.reserved_tokens <> NEW.reserved_tokens
       OR OLD.reserved_nano_usd <> NEW.reserved_nano_usd
       OR OLD.reserved_calls <> NEW.reserved_calls
       OR OLD.reserve_decision_hash <> NEW.reserve_decision_hash
       OR OLD.opened_account_revision <> NEW.opened_account_revision
       OR OLD.opened_run_revision <> NEW.opened_run_revision
       OR OLD.reservation_hash <> NEW.reservation_hash
       OR OLD.canonical_reservation_bytes <> NEW.canonical_reservation_bytes
       OR OLD.opened_at <> NEW.opened_at
       OR OLD.created_at <> NEW.created_at
       OR OLD.status <> 'open'
       OR NEW.status <> 'settled'
       OR NEW.terminal_ledger_entry_id IS NULL
       OR NEW.closed_at IS NULL
       OR NEW.closed_at < OLD.opened_at THEN
        RAISE EXCEPTION 'workflow budget reservation update violates immutable binding or terminal transition';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE workflow_control_budget_accounts (
    workspace_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    policy_hash BYTEA NOT NULL CHECK (octet_length(policy_hash) = 32),
    backend TEXT NOT NULL CHECK (backend = 'go'),
    authority TEXT NOT NULL CHECK (authority = 'workflow-control'),
    routing_epoch BIGINT NOT NULL CHECK (routing_epoch BETWEEN 1 AND 9007199254740991),
    authority_build_hash BYTEA NOT NULL CHECK (octet_length(authority_build_hash) = 32),
    account_revision BIGINT NOT NULL CHECK (account_revision BETWEEN 1 AND 9007199254740991),
    run_revision BIGINT NOT NULL CHECK (run_revision BETWEEN 1 AND 9007199254740991),
    limit_tokens BIGINT NOT NULL CHECK (limit_tokens >= 0),
    limit_nano_usd BIGINT NOT NULL CHECK (limit_nano_usd >= 0),
    limit_calls BIGINT NOT NULL CHECK (limit_calls >= 0),
    reserved_tokens BIGINT NOT NULL CHECK (reserved_tokens BETWEEN 0 AND limit_tokens),
    reserved_nano_usd BIGINT NOT NULL CHECK (reserved_nano_usd BETWEEN 0 AND limit_nano_usd),
    reserved_calls BIGINT NOT NULL CHECK (reserved_calls BETWEEN 0 AND limit_calls),
    settled_tokens BIGINT NOT NULL CHECK (settled_tokens BETWEEN 0 AND reserved_tokens),
    settled_nano_usd BIGINT NOT NULL CHECK (settled_nano_usd BETWEEN 0 AND reserved_nano_usd),
    settled_calls BIGINT NOT NULL CHECK (settled_calls BETWEEN 0 AND reserved_calls),
    genesis_account_hash BYTEA NOT NULL CHECK (octet_length(genesis_account_hash) = 32),
    canonical_genesis_account_bytes BYTEA NOT NULL CHECK (octet_length(canonical_genesis_account_bytes) BETWEEN 1 AND 131072),
    account_hash BYTEA NOT NULL CHECK (octet_length(account_hash) = 32),
    canonical_account_bytes BYTEA NOT NULL CHECK (octet_length(canonical_account_bytes) BETWEEN 1 AND 131072),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
	CONSTRAINT workflow_control_budget_accounts_pkey PRIMARY KEY (workspace_id, run_id),
	CONSTRAINT workflow_control_budget_accounts_workspace_account_key UNIQUE (workspace_id, account_id)
);

CREATE TABLE workflow_control_budget_reservations (
    workspace_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    reservation_id TEXT NOT NULL,
    call_id TEXT NOT NULL,
    provider_attempt BIGINT NOT NULL CHECK (provider_attempt BETWEEN 1 AND 9007199254740991),
    expected_provider_hash BYTEA NOT NULL CHECK (octet_length(expected_provider_hash) = 32),
    expected_model_hash BYTEA NOT NULL CHECK (octet_length(expected_model_hash) = 32),
    expected_provider_run_hash BYTEA NOT NULL CHECK (octet_length(expected_provider_run_hash) = 32),
    policy_hash BYTEA NOT NULL CHECK (octet_length(policy_hash) = 32),
    backend TEXT NOT NULL CHECK (backend = 'go'),
    authority TEXT NOT NULL CHECK (authority = 'workflow-control'),
    routing_epoch BIGINT NOT NULL CHECK (routing_epoch BETWEEN 1 AND 9007199254740991),
    authority_build_hash BYTEA NOT NULL CHECK (octet_length(authority_build_hash) = 32),
    rate_nano_usd_per_token TEXT NOT NULL CHECK (char_length(rate_nano_usd_per_token) BETWEEN 1 AND 64),
    reserved_tokens BIGINT NOT NULL CHECK (reserved_tokens >= 0),
    reserved_nano_usd BIGINT NOT NULL CHECK (reserved_nano_usd >= 0),
    reserved_calls BIGINT NOT NULL CHECK (reserved_calls = 1),
    reserve_decision_hash BYTEA NOT NULL CHECK (octet_length(reserve_decision_hash) = 32),
    opened_account_revision BIGINT NOT NULL CHECK (opened_account_revision BETWEEN 1 AND 9007199254740991),
    opened_run_revision BIGINT NOT NULL CHECK (opened_run_revision BETWEEN 1 AND 9007199254740991),
    reservation_hash BYTEA NOT NULL CHECK (octet_length(reservation_hash) = 32),
    canonical_reservation_bytes BYTEA NOT NULL CHECK (octet_length(canonical_reservation_bytes) BETWEEN 1 AND 524288),
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'settled')),
    terminal_ledger_entry_id TEXT,
    opened_at TIMESTAMPTZ NOT NULL,
    closed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
	CONSTRAINT workflow_control_budget_reservations_pkey PRIMARY KEY (workspace_id, run_id, reservation_id),
	CONSTRAINT workflow_control_budget_reservations_call_attempt_key UNIQUE (workspace_id, run_id, call_id, provider_attempt),
	CONSTRAINT workflow_control_budget_reservations_account_fk FOREIGN KEY (workspace_id, run_id)
		REFERENCES workflow_control_budget_accounts (workspace_id, run_id)
        DEFERRABLE INITIALLY DEFERRED,
    CHECK (
        (status = 'open' AND closed_at IS NULL AND terminal_ledger_entry_id IS NULL)
        OR
        (status = 'settled' AND closed_at IS NOT NULL AND terminal_ledger_entry_id IS NOT NULL)
    )
);

CREATE TABLE workflow_control_budget_ledger (
	entry_id TEXT CONSTRAINT workflow_control_budget_ledger_pkey PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN (
        'reserve_reserved', 'reserve_rejected', 'settlement_settled',
        'settlement_reconciliation_required'
    )),
    workspace_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    reservation_id TEXT NOT NULL,
    call_id TEXT NOT NULL,
    provider_attempt BIGINT NOT NULL CHECK (provider_attempt BETWEEN 1 AND 9007199254740991),
    account_revision BIGINT NOT NULL CHECK (account_revision BETWEEN 1 AND 9007199254740991),
    run_revision BIGINT NOT NULL CHECK (run_revision BETWEEN 1 AND 9007199254740991),
    previous_account_hash BYTEA NOT NULL CHECK (octet_length(previous_account_hash) = 32),
    account_hash BYTEA NOT NULL CHECK (octet_length(account_hash) = 32),
    decision_hash BYTEA NOT NULL CHECK (octet_length(decision_hash) = 32),
    ledger_hash BYTEA NOT NULL CHECK (octet_length(ledger_hash) = 32),
    canonical_ledger_bytes BYTEA NOT NULL CHECK (octet_length(canonical_ledger_bytes) BETWEEN 1 AND 524288),
    recorded_at TIMESTAMPTZ NOT NULL,
    inserted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
	CONSTRAINT workflow_control_budget_ledger_account_revision_key UNIQUE (workspace_id, run_id, account_revision),
	CONSTRAINT workflow_control_budget_ledger_run_revision_key UNIQUE (workspace_id, run_id, run_revision),
	CONSTRAINT workflow_control_budget_ledger_account_fk FOREIGN KEY (workspace_id, run_id)
		REFERENCES workflow_control_budget_accounts (workspace_id, run_id)
        DEFERRABLE INITIALLY DEFERRED
);

ALTER TABLE workflow_control_budget_reservations
    ADD CONSTRAINT workflow_control_budget_reservations_terminal_ledger_fk
    FOREIGN KEY (terminal_ledger_entry_id) REFERENCES workflow_control_budget_ledger (entry_id)
    DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE workflow_control_budget_receipts (
	receipt_id TEXT CONSTRAINT workflow_control_budget_receipts_pkey PRIMARY KEY,
    operation TEXT NOT NULL CHECK (operation IN ('reserve', 'settle')),
    status TEXT NOT NULL CHECK (status IN (
        'accepted', 'provider_reconciliation_required', 'database_reconciliation_required'
    )),
	idempotency_key TEXT NOT NULL CONSTRAINT workflow_control_budget_receipts_idempotency_key UNIQUE,
    request_fingerprint BYTEA NOT NULL CHECK (octet_length(request_fingerprint) = 32),
    request_hash BYTEA NOT NULL CHECK (octet_length(request_hash) = 32),
    workspace_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    reservation_id TEXT NOT NULL,
    call_id TEXT NOT NULL,
    expected_account_revision BIGINT NOT NULL CHECK (expected_account_revision BETWEEN 0 AND 9007199254740991),
    accepted_account_revision BIGINT CHECK (accepted_account_revision BETWEEN 1 AND 9007199254740991),
    expected_run_revision BIGINT NOT NULL CHECK (expected_run_revision BETWEEN 1 AND 9007199254740991),
    accepted_run_revision BIGINT CHECK (accepted_run_revision BETWEEN 1 AND 9007199254740991),
    record_hash BYTEA,
    ledger_entry_hash BYTEA,
    correlation_id TEXT NOT NULL,
    service_build_hash BYTEA NOT NULL CHECK (octet_length(service_build_hash) = 32),
    committed_at TIMESTAMPTZ,
    reconciliation_token TEXT,
    exact_receipt_bytes BYTEA NOT NULL CHECK (octet_length(exact_receipt_bytes) BETWEEN 1 AND 524288),
    exact_response_bytes BYTEA NOT NULL CHECK (octet_length(exact_response_bytes) BETWEEN 1 AND 1048576),
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CHECK (
        (status IN ('accepted', 'provider_reconciliation_required')
            AND accepted_account_revision IS NOT NULL
            AND accepted_run_revision IS NOT NULL
            AND accepted_account_revision = expected_account_revision + 1
            AND accepted_run_revision = expected_run_revision + 1
            AND record_hash IS NOT NULL AND octet_length(record_hash) = 32
            AND ledger_entry_hash IS NOT NULL AND octet_length(ledger_entry_hash) = 32
            AND committed_at IS NOT NULL
            AND ((status = 'accepted' AND reconciliation_token IS NULL)
                 OR (status = 'provider_reconciliation_required' AND reconciliation_token IS NOT NULL)))
        OR
        (status = 'database_reconciliation_required'
            AND accepted_account_revision IS NULL AND accepted_run_revision IS NULL
            AND record_hash IS NULL AND ledger_entry_hash IS NULL
            AND committed_at IS NULL AND reconciliation_token IS NOT NULL)
    )
);

CREATE TABLE workflow_control_budget_reconciliations (
	reconciliation_token TEXT CONSTRAINT workflow_control_budget_reconciliations_pkey PRIMARY KEY,
	receipt_id TEXT NOT NULL CONSTRAINT workflow_control_budget_reconciliations_receipt_key UNIQUE
		CONSTRAINT workflow_control_budget_reconciliations_receipt_fk REFERENCES workflow_control_budget_receipts (receipt_id)
        DEFERRABLE INITIALLY DEFERRED,
    evidence_type TEXT NOT NULL CHECK (evidence_type IN ('provider_outcome', 'database_commit')),
    reason_code TEXT NOT NULL CHECK (reason_code IN (
        'provider_outcome_unknown', 'usage_receipt_missing', 'usage_receipt_untrusted',
        'usage_overrun', 'database_commit_outcome_unknown'
    )),
	idempotency_key TEXT NOT NULL CONSTRAINT workflow_control_budget_reconciliations_idem_key UNIQUE,
    request_fingerprint BYTEA NOT NULL CHECK (octet_length(request_fingerprint) = 32),
    request_hash BYTEA NOT NULL CHECK (octet_length(request_hash) = 32),
    evidence_hash BYTEA NOT NULL CHECK (octet_length(evidence_hash) = 32),
    workspace_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    reservation_id TEXT NOT NULL,
    call_id TEXT NOT NULL,
    account_hash BYTEA NOT NULL CHECK (octet_length(account_hash) = 32),
    reservation_hash BYTEA NOT NULL CHECK (octet_length(reservation_hash) = 32),
    exact_reconciliation_bytes BYTEA NOT NULL CHECK (octet_length(exact_reconciliation_bytes) BETWEEN 1 AND 524288),
    status TEXT NOT NULL DEFAULT 'open' CHECK (status = 'open'),
    observed_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CHECK (
        (evidence_type = 'database_commit' AND reason_code = 'database_commit_outcome_unknown')
        OR
        (evidence_type = 'provider_outcome' AND reason_code <> 'database_commit_outcome_unknown')
    )
);

CREATE INDEX workflow_control_budget_receipts_run_idx
    ON workflow_control_budget_receipts (workspace_id, run_id, recorded_at);
CREATE INDEX workflow_control_budget_reservations_open_idx
    ON workflow_control_budget_reservations (workspace_id, run_id, opened_at) WHERE status = 'open';
CREATE INDEX workflow_control_budget_ledger_run_idx
    ON workflow_control_budget_ledger (workspace_id, run_id, run_revision);
CREATE UNIQUE INDEX workflow_control_budget_ledger_reserve_reservation_idx
    ON workflow_control_budget_ledger (workspace_id, run_id, reservation_id)
    WHERE kind IN ('reserve_reserved', 'reserve_rejected');
CREATE UNIQUE INDEX workflow_control_budget_ledger_reserve_call_attempt_idx
    ON workflow_control_budget_ledger (workspace_id, run_id, call_id, provider_attempt)
    WHERE kind IN ('reserve_reserved', 'reserve_rejected');
CREATE UNIQUE INDEX workflow_control_budget_ledger_settlement_reservation_idx
    ON workflow_control_budget_ledger (workspace_id, run_id, reservation_id)
    WHERE kind IN ('settlement_settled', 'settlement_reconciliation_required');
CREATE INDEX workflow_control_budget_reconciliations_run_idx
    ON workflow_control_budget_reconciliations (workspace_id, run_id, created_at);
CREATE UNIQUE INDEX workflow_control_budget_recon_one_open_db_run_idx
    ON workflow_control_budget_reconciliations (workspace_id, run_id)
    WHERE status = 'open' AND evidence_type = 'database_commit';

CREATE TRIGGER workflow_control_budget_accounts_transition
BEFORE UPDATE ON workflow_control_budget_accounts
FOR EACH ROW EXECUTE FUNCTION workflow_control_budget_account_transition();
CREATE TRIGGER workflow_control_budget_accounts_no_delete
BEFORE DELETE ON workflow_control_budget_accounts
FOR EACH ROW EXECUTE FUNCTION workflow_control_budget_reject_immutable_mutation();

CREATE TRIGGER workflow_control_budget_reservations_transition
BEFORE UPDATE ON workflow_control_budget_reservations
FOR EACH ROW EXECUTE FUNCTION workflow_control_budget_reservation_transition();
CREATE TRIGGER workflow_control_budget_reservations_no_delete
BEFORE DELETE ON workflow_control_budget_reservations
FOR EACH ROW EXECUTE FUNCTION workflow_control_budget_reject_immutable_mutation();

CREATE TRIGGER workflow_control_budget_ledger_immutable
BEFORE UPDATE OR DELETE ON workflow_control_budget_ledger
FOR EACH ROW EXECUTE FUNCTION workflow_control_budget_reject_immutable_mutation();
CREATE TRIGGER workflow_control_budget_receipts_immutable
BEFORE UPDATE OR DELETE ON workflow_control_budget_receipts
FOR EACH ROW EXECUTE FUNCTION workflow_control_budget_reject_immutable_mutation();
CREATE TRIGGER workflow_control_budget_reconciliations_immutable
BEFORE UPDATE OR DELETE ON workflow_control_budget_reconciliations
FOR EACH ROW EXECUTE FUNCTION workflow_control_budget_reject_immutable_mutation();

COMMIT;
