package postgres

const (
	receiptByKeySQL = `
SELECT receipt_id, operation, status, idempotency_key, request_fingerprint,
       request_hash, workspace_id, run_id, account_id, reservation_id, call_id,
       expected_account_revision, accepted_account_revision,
       expected_run_revision, accepted_run_revision, record_hash,
       ledger_entry_hash, correlation_id, service_build_hash, committed_at,
       reconciliation_token, exact_receipt_bytes, exact_response_bytes, recorded_at
FROM workflow_control_budget_receipts
WHERE idempotency_key=$1`

	receiptByWorkspaceKeySQL = receiptByKeySQL + ` AND workspace_id=$2`

	ledgerByHashSQL = `
SELECT entry_id, kind, workspace_id, run_id, account_id, reservation_id, call_id,
       provider_attempt, account_revision, run_revision, previous_account_hash,
       account_hash, decision_hash, ledger_hash, canonical_ledger_bytes, recorded_at
FROM workflow_control_budget_ledger
WHERE ledger_hash=$1`

	reconciliationByTokenSQL = `
SELECT reconciliation_token, receipt_id, evidence_type, reason_code,
       idempotency_key, request_fingerprint, request_hash, evidence_hash,
       workspace_id, run_id, account_id, reservation_id, call_id,
       account_hash, reservation_hash, exact_reconciliation_bytes, status, observed_at
FROM workflow_control_budget_reconciliations
WHERE reconciliation_token=$1`

	runForUpdateSQL = `
SELECT workflow_id, workflow_version, workflow_source_hash, manifest_hash, input_hash,
       backend, authority, routing_epoch, authority_build_hash, state, revision,
       current_phase_id, current_phase_index, resume_generation, record_hash,
       canonical_record_bytes, updated_at
FROM workflow_control_runs
WHERE workspace_id=$1 AND run_id=$2
FOR UPDATE`

	openDatabaseReconciliationSQL = `
SELECT EXISTS (
    SELECT 1 FROM workflow_control_budget_reconciliations
    WHERE workspace_id=$1 AND run_id=$2 AND evidence_type='database_commit' AND status='open'
)`

	accountForUpdateSQL = `
SELECT account_id, policy_hash, backend, authority, routing_epoch,
       authority_build_hash, account_revision, run_revision,
       limit_tokens, limit_nano_usd, limit_calls,
       reserved_tokens, reserved_nano_usd, reserved_calls,
       settled_tokens, settled_nano_usd, settled_calls,
       genesis_account_hash, canonical_genesis_account_bytes,
       account_hash, canonical_account_bytes, updated_at
FROM workflow_control_budget_accounts
WHERE workspace_id=$1 AND run_id=$2
FOR UPDATE`

	reservationForUpdateSQL = `
SELECT account_id, reservation_id, call_id, provider_attempt,
       expected_provider_hash, expected_model_hash, expected_provider_run_hash,
       policy_hash, backend, authority, routing_epoch, authority_build_hash,
       rate_nano_usd_per_token, reserved_tokens, reserved_nano_usd, reserved_calls,
       reserve_decision_hash, opened_account_revision, opened_run_revision,
       reservation_hash, canonical_reservation_bytes, status,
       terminal_ledger_entry_id, opened_at, closed_at
FROM workflow_control_budget_reservations
WHERE workspace_id=$1 AND run_id=$2 AND reservation_id=$3
FOR UPDATE`

	accountInsertSQL = `
INSERT INTO workflow_control_budget_accounts (
    workspace_id, run_id, account_id, policy_hash, backend, authority,
    routing_epoch, authority_build_hash, account_revision, run_revision,
    limit_tokens, limit_nano_usd, limit_calls, reserved_tokens,
    reserved_nano_usd, reserved_calls, settled_tokens, settled_nano_usd,
    settled_calls, genesis_account_hash, canonical_genesis_account_bytes,
    account_hash, canonical_account_bytes, updated_at
) VALUES (
    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24
)`

	accountCASUpdateSQL = `
UPDATE workflow_control_budget_accounts
SET account_revision=$7, run_revision=$8,
    reserved_tokens=$9, reserved_nano_usd=$10, reserved_calls=$11,
    settled_tokens=$12, settled_nano_usd=$13, settled_calls=$14,
    account_hash=$15, canonical_account_bytes=$16, updated_at=$17
WHERE workspace_id=$1 AND run_id=$2 AND account_id=$3
  AND account_revision=$4 AND run_revision=$5 AND account_hash=$6`

	reservationInsertSQL = `
INSERT INTO workflow_control_budget_reservations (
    workspace_id, run_id, account_id, reservation_id, call_id, provider_attempt,
    expected_provider_hash, expected_model_hash, expected_provider_run_hash,
    policy_hash, backend, authority, routing_epoch, authority_build_hash,
    rate_nano_usd_per_token, reserved_tokens, reserved_nano_usd, reserved_calls,
    reserve_decision_hash, opened_account_revision, opened_run_revision,
    reservation_hash, canonical_reservation_bytes, status, opened_at
) VALUES (
    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,'open',$24
)`

	reservationTerminalSQL = `
UPDATE workflow_control_budget_reservations
SET status=$5, terminal_ledger_entry_id=$6, closed_at=$7
WHERE workspace_id=$1 AND run_id=$2 AND reservation_id=$3 AND status=$4`

	ledgerInsertSQL = `
INSERT INTO workflow_control_budget_ledger (
    entry_id, kind, workspace_id, run_id, account_id, reservation_id, call_id, provider_attempt,
    account_revision, run_revision, previous_account_hash, account_hash,
    decision_hash, ledger_hash, canonical_ledger_bytes, recorded_at
) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`

	runCASUpdateSQL = `
UPDATE workflow_control_runs
SET state=$6, revision=$7, record_hash=$8, canonical_record_bytes=$9, updated_at=$10
WHERE workspace_id=$1 AND run_id=$2 AND revision=$3 AND state=$4 AND record_hash=$5`

	receiptInsertSQL = `
INSERT INTO workflow_control_budget_receipts (
    receipt_id, operation, status, idempotency_key, request_fingerprint,
    request_hash, workspace_id, run_id, account_id, reservation_id, call_id,
    expected_account_revision, accepted_account_revision,
    expected_run_revision, accepted_run_revision, record_hash,
    ledger_entry_hash, correlation_id, service_build_hash, committed_at,
    reconciliation_token, exact_receipt_bytes, exact_response_bytes
) VALUES (
    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23
) RETURNING recorded_at`

	reconciliationInsertSQL = `
INSERT INTO workflow_control_budget_reconciliations (
    reconciliation_token, receipt_id, evidence_type, reason_code,
    idempotency_key, request_fingerprint, request_hash, evidence_hash,
    workspace_id, run_id, account_id, reservation_id, call_id,
    account_hash, reservation_hash, exact_reconciliation_bytes, observed_at
) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`

	accountReadSQL = `
SELECT account_id, policy_hash, backend, authority, routing_epoch,
       authority_build_hash, account_revision, run_revision,
       limit_tokens, limit_nano_usd, limit_calls,
       reserved_tokens, reserved_nano_usd, reserved_calls,
       settled_tokens, settled_nano_usd, settled_calls,
       genesis_account_hash, canonical_genesis_account_bytes,
       account_hash, canonical_account_bytes, updated_at
FROM workflow_control_budget_accounts
WHERE workspace_id=$1 AND run_id=$2`

	ledgerRebuildSQL = `
SELECT ledger.entry_id, ledger.kind, ledger.workspace_id, ledger.run_id,
       ledger.account_id, ledger.reservation_id, ledger.call_id,
       ledger.provider_attempt, ledger.account_revision, ledger.run_revision,
       ledger.previous_account_hash, ledger.account_hash, ledger.decision_hash,
       ledger.ledger_hash, ledger.canonical_ledger_bytes, ledger.recorded_at,
	   receipt.idempotency_key, receipt.operation, receipt.status,
	   receipt.account_id, receipt.reservation_id, receipt.call_id,
	   receipt.accepted_account_revision, receipt.accepted_run_revision,
	   receipt.record_hash, receipt.committed_at,
	   receipt.exact_receipt_bytes, receipt.exact_response_bytes,
	   reconciliation.exact_reconciliation_bytes
FROM workflow_control_budget_ledger AS ledger
JOIN workflow_control_budget_receipts AS receipt
  ON receipt.workspace_id=ledger.workspace_id
 AND receipt.run_id=ledger.run_id
 AND receipt.ledger_entry_hash=ledger.ledger_hash
LEFT JOIN workflow_control_budget_reconciliations AS reconciliation
  ON reconciliation.receipt_id=receipt.receipt_id
WHERE ledger.workspace_id=$1 AND ledger.run_id=$2
ORDER BY ledger.account_revision ASC`

	reservationReadSQL = `
SELECT account_id, reservation_id, call_id, provider_attempt,
       expected_provider_hash, expected_model_hash, expected_provider_run_hash,
       policy_hash, backend, authority, routing_epoch, authority_build_hash,
       rate_nano_usd_per_token, reserved_tokens, reserved_nano_usd, reserved_calls,
       reserve_decision_hash, opened_account_revision, opened_run_revision,
       reservation_hash, canonical_reservation_bytes, status,
       terminal_ledger_entry_id, opened_at, closed_at
FROM workflow_control_budget_reservations
WHERE workspace_id=$1 AND run_id=$2 AND reservation_id=$3`

	readinessSQL = `SELECT 1`

	statisticsSQL = `
SELECT
    (SELECT count(*) FROM workflow_control_budget_accounts),
    (SELECT count(*) FROM workflow_control_budget_reservations),
    (SELECT count(*) FROM workflow_control_budget_reservations WHERE status='open'),
    (SELECT count(*) FROM workflow_control_budget_ledger),
    (SELECT count(*) FROM workflow_control_budget_receipts),
    (SELECT count(*) FROM workflow_control_budget_reconciliations WHERE evidence_type='database_commit' AND status='open'),
    (SELECT count(*) FROM workflow_control_budget_reconciliations WHERE evidence_type='provider_outcome')`
)
