package postgres

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"
	"unicode/utf8"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/authoritycontract"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/authoritystore"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/canonicaljson"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runlock"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerstore"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/storageproof"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/runnerbindingcontract"
	"github.com/jackc/pgx/v5"
)

func (repository *Repository) WithReconciliationWriter(writer storageproof.ChallengeWriter, caller string) *Repository {
	repository.reconciliationWriter, repository.reconciliationCaller = writer, caller
	return repository
}

// The only lock held across the network challenge is a fresh transaction
// advisory lock. In particular no run, job, lease, or checkpoint lock is held.
func (repository *Repository) reconciliationTx(ctx context.Context, workspace, run string) (pgx.Tx, error) {
	if repository.schemaVersion < 10 || !repository.v2RuntimeDelivery || repository.reconciliationWriter == nil {
		return nil, runnerstore.Failure(runnerstore.ErrorAuthorityUnavailable, "reconciliation requires the schema 10 source writer capability", nil)
	}
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return nil, databaseFailure("begin reconciliation proof", err)
	}
	ok := false
	defer func() {
		if !ok {
			_ = tx.Rollback(context.Background())
		}
	}()
	var epoch int64
	if err = tx.QueryRow(ctx, `SELECT routing_epoch FROM workflow_control_runs WHERE workspace_id=$1 AND run_id=$2`, workspace, run).Scan(&epoch); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, runnerstore.Failure(runnerstore.ErrorNotFound, "reconciliation run was not found", nil)
		}
		return nil, databaseFailure("read reconciliation route", err)
	}
	challenge, err := storageproof.Hold(ctx, tx)
	if err != nil {
		return nil, databaseFailure("hold source writer challenge", err)
	}
	local, err := storageproof.Inspect(ctx, tx, challenge)
	if err != nil {
		return nil, runnerstore.Failure(runnerstore.ErrorAuthorityUnavailable, "reconciliation storage capability is unavailable", err)
	}
	source, err := repository.reconciliationWriter(ctx, challenge, epoch)
	if err != nil {
		return nil, runnerstore.Failure(runnerstore.ErrorAuthorityUnavailable, "source writer identity is temporarily unavailable", err)
	}
	if !storageproof.SameWriter(local, source) {
		return nil, runnerstore.Failure(runnerstore.ErrorReconciliation, "reconciliation requires one verified writable database and schema", nil)
	}
	ok = true
	return tx, nil
}

func reconciliationBinding(ctx context.Context, tx pgx.Tx, workspace, run, id string, lock bool) (runnerstore.V2AuthorityBindingView, error) {
	sql := `SELECT ` + authorityBindingViewColumns + ` FROM workflow_runner_authority_bindings WHERE workspace_id=$1 AND run_id=$2 AND binding_id=$3`
	if lock {
		sql += ` FOR UPDATE NOWAIT`
	}
	v, err := scanAuthorityBindingView(tx.QueryRow(ctx, sql, workspace, run, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return v, runnerstore.Failure(runnerstore.ErrorNotFound, "binding was not found in this workspace and run", nil)
	}
	if err != nil {
		return v, databaseFailure("read reconciliation binding", err)
	}
	return v, validateRecoveredBinding(v)
}

// Try-locks avoid inverting source run locks against an in-flight runner job
// transaction. Contention rolls back; it never waits while retaining row locks.
func lockReconciliationRun(ctx context.Context, tx pgx.Tx, workspace, run string) error {
	var locked bool
	if err := tx.QueryRow(ctx, `SELECT pg_try_advisory_xact_lock(hashtextextended($1,$2))`, runlock.Key(workspace, run), runlock.AdvisorySalt).Scan(&locked); err != nil {
		return databaseFailure("lock reconciliation run", err)
	}
	if !locked {
		return runnerstore.Failure(runnerstore.ErrorAuthorityUnavailable, "run reconciliation is busy; retry the original operation", nil)
	}
	rows, err := tx.Query(ctx, `SELECT l.lease_id FROM workflow_runner_leases l JOIN workflow_runner_jobs j ON j.workspace_id=l.workspace_id AND j.job_id=l.job_id
 WHERE j.workspace_id=$1 AND j.workflow_run_id=$2 ORDER BY l.lease_id FOR UPDATE OF l NOWAIT`, workspace, run)
	if err != nil {
		return databaseFailure("lock reconciliation leases", err)
	}
	for rows.Next() {
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return databaseFailure("lock reconciliation leases", err)
	}
	return nil
}

// Validate the immutable closure against the original binding before using it
// to suppress unfinished work. This does not grant a current execution lease.
func validateBindingSettlement(raw []byte, v runnerstore.V2AuthorityBindingView) (runnerstore.BindingSettlementReceipt, error) {
	r, err := runnerstore.ParseBindingSettlement(raw)
	if err != nil {
		return r, err
	}
	bad := func() (runnerstore.BindingSettlementReceipt, error) {
		return r, runnerstore.Failure(runnerstore.ErrorReconciliation, "settlement differs from its exact original binding", nil)
	}
	if err = validateRecoveredBinding(v); err != nil {
		return r, err
	}
	stage, err := runnerbindingcontract.ParseStageBytes(v.ExactStageBytes)
	if err != nil {
		return bad()
	}
	hash, err := runnerbindingcontract.HashStage(stage)
	if err != nil || r.WorkspaceID != v.WorkspaceID || r.RunID != v.RunID || r.BindingID != v.BindingID || r.StageHash != hash {
		return bad()
	}
	switch r.ProofKind {
	case "resolution":
		if v.Operation == runnerbindingcontract.OperationBudgetReserve || v.Operation == runnerbindingcontract.OperationBudgetSettle || !bytes.Equal([]byte(r.Proof), v.ExactResolutionBytes) {
			return bad()
		}
		resolution, err := runnerbindingcontract.ParseResolutionBytes(v.ExactResolutionBytes)
		if err != nil || bindingString(bindingRecord(bindingRecord(resolution, "evidence"), "sourceAuthority"), "evidenceState") != "committed" {
			return bad()
		}
	case "budget_source_result":
		var proof struct {
			Schema       string `json:"schema"`
			Resolution   string `json:"resolution"`
			SourceResult string `json:"sourceResult"`
		}
		if json.Unmarshal([]byte(r.Proof), &proof) != nil {
			return bad()
		}
		exact, err := canonicaljson.Encode(proof)
		if err != nil || string(append(exact, '\n')) != r.Proof || proof.Schema != "openslack.workflow_runner_budget_settlement_proof.v1" || !bytes.Equal([]byte(proof.Resolution), v.ExactResolutionBytes) || proof.SourceResult == "" ||
			(v.Operation != runnerbindingcontract.OperationBudgetReserve && v.Operation != runnerbindingcontract.OperationBudgetSettle) {
			return bad()
		}
		if len(v.ExactSourceResult) > 0 && string(v.ExactSourceResult) != proof.SourceResult {
			return bad()
		}
		v.ExactSourceResult = []byte(proof.SourceResult)
		digest := sha256.Sum256(v.ExactSourceResult)
		v.SourceResultHash = digest[:]
		if err = validateRecoveredBinding(v); err != nil {
			return r, err
		}
	case "source_receipt":
		source, err := authoritycontract.DecodeReceiptJSON([]byte(r.Proof))
		route := bindingRecord(stage, "route")
		if err != nil || v.Operation != runnerbindingcontract.OperationResumeAdvance || source.Operation != authoritycontract.ReceiptRunTransition || source.Status != authoritycontract.ReceiptAccepted ||
			source.WorkspaceID != v.WorkspaceID || source.RunID != v.RunID || source.CorrelationID != "resume."+hash || source.ResumeGeneration != v.AcceptedGeneration ||
			source.AcceptedRevision == nil || *source.AcceptedRevision != source.ExpectedRevision+1 ||
			source.Route.RoutingEpoch != bindingInt(route, "routingEpoch") || source.Route.AuthorityBuildHash != bindingString(route, "authorityBuildHash") {
			return bad()
		}
	case "source_fence":
		expected, err := canonicaljson.Encode(map[string]any{"schema": "openslack.workflow_control_source_fence.v1", "bindingId": v.BindingID, "stageHash": hash, "workspaceId": v.WorkspaceID, "runId": v.RunID, "correlationId": "resume." + hash, "expectedResumeGeneration": v.ExpectedGeneration})
		if err != nil || v.Operation != runnerbindingcontract.OperationResumeAdvance || string(append(expected, '\n')) != r.Proof {
			return bad()
		}
	default:
		return bad()
	}
	return r, nil
}

type settlementProof struct {
	outcome, kind string
	exact         []byte
}

// Budget resolution is prepared intent, not source commit proof. Point-read the
// immutable result before taking business locks and retain it only in the new
// settlement. The original binding remains byte-for-byte unchanged.
func (repository *Repository) reconciliationSourceResult(ctx context.Context, v runnerstore.V2AuthorityBindingView) (runnerstore.V2AuthorityBindingView, error) {
	if (v.Operation != runnerbindingcontract.OperationBudgetReserve && v.Operation != runnerbindingcontract.OperationBudgetSettle) ||
		len(v.ExactResolutionBytes) == 0 || len(v.ExactSourceResult) > 0 {
		return v, nil
	}
	exact, hash, err := repository.readRuntimeBudgetSource(ctx, v)
	if err != nil {
		return v, err
	}
	v.ExactSourceResult, v.SourceResultHash = exact, hash
	return v, validateRecoveredBinding(v)
}

func readSettlementProof(ctx context.Context, tx pgx.Tx, v runnerstore.V2AuthorityBindingView) (settlementProof, error) {
	stage, err := runnerbindingcontract.ParseStageBytes(v.ExactStageBytes)
	if err != nil {
		return settlementProof{}, bindingContractFailure("invalid reconciliation stage", err)
	}
	hash, err := runnerbindingcontract.HashStage(stage)
	if err != nil {
		return settlementProof{}, err
	}
	var active bool
	if err = tx.QueryRow(ctx, `SELECT state IN ('offered','active','cancelling') AND lease_expires_at>clock_timestamp() FROM workflow_runner_leases WHERE lease_id=$1`, v.LeaseID).Scan(&active); err != nil {
		return settlementProof{}, databaseFailure("read reconciliation lease", err)
	}
	if active {
		return settlementProof{}, runnerstore.Failure(runnerstore.ErrorConflict, "an active lease still owns this binding", nil)
	}
	if v.Operation == runnerbindingcontract.OperationResumeAdvance {
		rows, err := tx.Query(ctx, `SELECT r.exact_receipt_bytes,e.canonical_record_bytes,e.record_hash FROM workflow_control_transition_receipts r
   JOIN workflow_control_transition_events e ON e.receipt_id=r.receipt_id AND e.workspace_id=r.workspace_id AND e.run_id=r.run_id
    AND e.to_revision=r.accepted_revision AND e.request_hash=r.request_hash AND e.record_hash=r.record_hash
   WHERE r.workspace_id=$1 AND r.run_id=$2 AND r.correlation_id=$3 AND r.status='accepted'`, v.WorkspaceID, v.RunID, "resume."+hash)
		if err != nil {
			return settlementProof{}, databaseFailure("read exact resume receipt", err)
		}
		var proof []byte
		count := 0
		for rows.Next() {
			var raw, record, recordHash []byte
			if err = rows.Scan(&raw, &record, &recordHash); err != nil {
				rows.Close()
				return settlementProof{}, databaseFailure("scan exact resume proof", err)
			}
			receipt, e := authoritycontract.DecodeReceiptJSON(raw)
			digest := sha256.Sum256(record)
			route := bindingRecord(stage, "route")
			var sourceRecord authoritystore.RunRecord
			recordErr := json.Unmarshal(record, &sourceRecord)
			canonicalRecord, canonicalErr := canonicaljson.Encode(sourceRecord)
			if e != nil || receipt.WorkspaceID != v.WorkspaceID || receipt.RunID != v.RunID || receipt.CorrelationID != "resume."+hash ||
				receipt.Operation != authoritycontract.ReceiptRunTransition || receipt.Status != authoritycontract.ReceiptAccepted || receipt.ResumeGeneration != v.AcceptedGeneration || receipt.AcceptedRevision == nil ||
				!utf8.Valid(record) || recordErr != nil || canonicalErr != nil || !bytes.Equal(append(canonicalRecord, '\n'), record) ||
				sourceRecord.WorkspaceID != v.WorkspaceID || sourceRecord.RunID != v.RunID || sourceRecord.State != "resuming" ||
				sourceRecord.ResumeGeneration != v.AcceptedGeneration || sourceRecord.ResumeGeneration != v.ExpectedGeneration+1 ||
				sourceRecord.Revision != *receipt.AcceptedRevision || sourceRecord.Revision != receipt.ExpectedRevision+1 || sourceRecord.Route != receipt.Route ||
				receipt.Route.RoutingEpoch != bindingInt(route, "routingEpoch") || receipt.Route.AuthorityBuildHash != bindingString(route, "authorityBuildHash") ||
				!bytes.Equal(digest[:], recordHash) || receipt.RecordHash == nil || *receipt.RecordHash != hex.EncodeToString(recordHash) {
				rows.Close()
				return settlementProof{}, runnerstore.Failure(runnerstore.ErrorReconciliation, "source receipt is not an exact binding proof", e)
			}
			proof = raw
			count++
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return settlementProof{}, databaseFailure("iterate source proof", err)
		}
		if count > 1 {
			return settlementProof{}, runnerstore.Failure(runnerstore.ErrorReconciliation, "multiple source commits match this operation", nil)
		}
		if count == 1 {
			return settlementProof{"committed", "source_receipt", proof}, nil
		}
		// The caller may turn this absence into proof only by installing a durable
		// source fence while holding the same run arbitration lock as source CAS.
		if len(v.ExactResolutionBytes) > 0 {
			return settlementProof{}, runnerstore.Failure(runnerstore.ErrorReconciliation, "resume resolution has no matching source commit", nil)
		}
		return settlementProof{"not_committed", "source_fence", nil}, nil
	}
	if len(v.ExactResolutionBytes) > 0 {
		resolution, err := runnerbindingcontract.ParseResolutionBytes(v.ExactResolutionBytes)
		if err != nil {
			return settlementProof{}, err
		}
		evidence := bindingRecord(resolution, "evidence")
		if bindingString(bindingRecord(evidence, "sourceAuthority"), "evidenceState") != "committed" &&
			v.Operation != runnerbindingcontract.OperationBudgetReserve && v.Operation != runnerbindingcontract.OperationBudgetSettle {
			return settlementProof{}, runnerstore.Failure(runnerstore.ErrorReconciliation, "source outcome remains unknown", nil)
		}
		// Budget intent resolution precedes its source mutation. Only an exact
		// durable budget result can prove that later mutation has happened.
		if v.Operation == runnerbindingcontract.OperationBudgetReserve || v.Operation == runnerbindingcontract.OperationBudgetSettle {
			if len(v.ExactSourceResult) == 0 {
				return settlementProof{}, runnerstore.Failure(runnerstore.ErrorReconciliation, "budget source result is still unresolved", nil)
			}
			if err := validateRecoveredBinding(v); err != nil {
				return settlementProof{}, err
			}
			exact, err := canonicaljson.Encode(map[string]any{"schema": "openslack.workflow_runner_budget_settlement_proof.v1", "resolution": string(v.ExactResolutionBytes), "sourceResult": string(v.ExactSourceResult)})
			if err != nil {
				return settlementProof{}, err
			}
			return settlementProof{"committed", "budget_source_result", append(exact, '\n')}, nil
		}
		return settlementProof{"committed", "resolution", v.ExactResolutionBytes}, nil
	}
	return settlementProof{}, runnerstore.Failure(runnerstore.ErrorReconciliation, "no precise source proof or supported source fence is available", nil)
}

func (repository *Repository) PreviewBindingReconciliation(ctx context.Context, workspace, run, binding, after string) (runnerstore.BindingReconciliationPreview, error) {
	result := runnerstore.BindingReconciliationPreview{Schema: "openslack.workflow_runner_binding_reconciliation_preview.v1", WorkspaceID: workspace, RunID: run, Items: []runnerstore.BindingReconciliationItem{}}
	tx, err := repository.reconciliationTx(ctx, workspace, run)
	if err != nil {
		return result, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	rows, err := tx.Query(ctx, `SELECT binding_id FROM workflow_runner_authority_bindings WHERE workspace_id=$1 AND run_id=$2 AND ($3='' OR binding_id=$3) AND binding_id>$4 ORDER BY binding_id`, workspace, run, binding, after)
	if err != nil {
		return result, databaseFailure("list reconciliation bindings", err)
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			break
		}
		ids = append(ids, id)
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err != nil {
		return result, databaseFailure("scan reconciliation identities", err)
	}
	for _, id := range ids {
		v, err := reconciliationBinding(ctx, tx, workspace, run, id, false)
		if err != nil {
			return result, err
		}
		stage, _ := runnerbindingcontract.ParseStageBytes(v.ExactStageBytes)
		hash, _ := runnerbindingcontract.HashStage(stage)
		item := runnerstore.BindingReconciliationItem{BindingID: id, StageHash: hash, Outcome: "unknown", Code: "WORKFLOW_RUNNER_RECONCILIATION_REQUIRED"}
		var raw []byte
		err = tx.QueryRow(ctx, `SELECT exact_receipt_bytes FROM workflow_runner_binding_settlements WHERE binding_id=$1`, id).Scan(&raw)
		if err == nil {
			r, e := validateBindingSettlement(raw, v)
			if e != nil {
				return result, e
			}
			s := string(raw)
			item.Receipt = &s
			item.Outcome = r.Outcome
			item.ProofKind = r.ProofKind
			item.Code = "WORKFLOW_RUNNER_BINDING_SETTLED"
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return result, databaseFailure("read existing settlement", err)
		} else if source, e := repository.reconciliationSourceResult(ctx, v); e == nil {
			if proof, e := readSettlementProof(ctx, tx, source); e == nil {
				item.Outcome = proof.outcome
				item.ProofKind = proof.kind
				item.Code = "WORKFLOW_RUNNER_BINDING_RECONCILABLE"
			}
		}
		candidate := result
		candidate.Items = append(append([]runnerstore.BindingReconciliationItem(nil), result.Items...), item)
		cursor := item.BindingID
		candidate.NextCursor = &cursor
		encoded, e := canonicaljson.Encode(candidate)
		if e != nil {
			return result, e
		}
		if len(encoded)+1 > runnerstore.RecoveryEvidenceMaxResponseBytes {
			if len(result.Items) == 0 {
				return result, runnerstore.Failure(runnerstore.ErrorLimitExceeded, "one reconciliation item exceeds the response contract", nil)
			}
			last := result.Items[len(result.Items)-1].BindingID
			result.NextCursor = &last
			break
		}
		result.Items = candidate.Items
	}
	if binding != "" && len(result.Items) == 0 {
		return result, runnerstore.Failure(runnerstore.ErrorNotFound, "binding was not found", nil)
	}
	return result, nil
}

func (repository *Repository) ReadBindingSettlementReceipt(ctx context.Context, workspace, run, key string) ([]byte, error) {
	var raw []byte
	err := repository.pool.QueryRow(ctx, `SELECT exact_receipt_bytes FROM workflow_runner_binding_settlements WHERE workspace_id=$1 AND run_id=$2 AND idempotency_key=$3`, workspace, run, key).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, runnerstore.Failure(runnerstore.ErrorNotFound, "settlement receipt was not found", nil)
	}
	if err != nil {
		return nil, databaseFailure("read settlement receipt", err)
	}
	r, err := runnerstore.ParseBindingSettlement(raw)
	if err != nil {
		return nil, err
	}
	if r.WorkspaceID != workspace || r.RunID != run || r.IdempotencyKey != key {
		return nil, runnerstore.Failure(runnerstore.ErrorReconciliation, "settlement receipt identity differs", nil)
	}
	v, err := scanAuthorityBindingView(repository.pool.QueryRow(ctx, `SELECT `+authorityBindingViewColumns+` FROM workflow_runner_authority_bindings WHERE workspace_id=$1 AND run_id=$2 AND binding_id=$3`, workspace, run, r.BindingID))
	if err != nil {
		return nil, databaseFailure("read original settlement binding", err)
	}
	if _, err = validateBindingSettlement(raw, v); err != nil {
		return nil, err
	}
	return raw, nil
}

func (repository *Repository) ApplyBindingReconciliation(ctx context.Context, input runnerstore.PreparedBindingReconciliation) ([]byte, error) {
	prepared, err := runnerstore.ParseBindingReconciliation(input.ExactBytes)
	if err != nil {
		return nil, err
	}
	v := prepared.Value
	if repository.schemaVersion < 10 || !repository.v2RuntimeDelivery {
		return nil, runnerstore.Failure(runnerstore.ErrorAuthorityUnavailable, "reconciliation requires the schema 10 runtime capability", nil)
	}
	// An exact committed retry must not depend on a currently reachable source.
	var priorRequest []byte
	err = repository.pool.QueryRow(ctx, `SELECT exact_request_bytes FROM workflow_runner_binding_settlements WHERE binding_id=$1 AND workspace_id=$2 AND run_id=$3`, v.BindingID, v.WorkspaceID, v.RunID).Scan(&priorRequest)
	if err == nil {
		if !bytes.Equal(priorRequest, prepared.ExactBytes) {
			return nil, runnerstore.Failure(runnerstore.ErrorIdempotencyConflict, "binding already has another terminal conclusion", nil)
		}
		return repository.ReadBindingSettlementReceipt(ctx, v.WorkspaceID, v.RunID, prepared.IdempotencyKey)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, databaseFailure("read prior settlement", err)
	}
	tx, err := repository.reconciliationTx(ctx, v.WorkspaceID, v.RunID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	original, err := reconciliationBinding(ctx, tx, v.WorkspaceID, v.RunID, v.BindingID, false)
	if err != nil {
		return nil, err
	}
	source, err := repository.reconciliationSourceResult(ctx, original)
	if err != nil {
		return nil, err
	}
	if err = lockReconciliationRun(ctx, tx, v.WorkspaceID, v.RunID); err != nil {
		return nil, err
	}
	binding, err := reconciliationBinding(ctx, tx, v.WorkspaceID, v.RunID, v.BindingID, true)
	if err != nil {
		return nil, err
	}
	var request, receipt []byte
	err = tx.QueryRow(ctx, `SELECT exact_request_bytes,exact_receipt_bytes FROM workflow_runner_binding_settlements WHERE binding_id=$1`, v.BindingID).Scan(&request, &receipt)
	if err == nil {
		if !bytes.Equal(request, prepared.ExactBytes) {
			return nil, runnerstore.Failure(runnerstore.ErrorIdempotencyConflict, "binding already has another terminal conclusion", nil)
		}
		if _, e := validateBindingSettlement(receipt, binding); e != nil {
			return nil, e
		}
		return receipt, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, databaseFailure("read idempotent settlement", err)
	}
	stage, _ := runnerbindingcontract.ParseStageBytes(binding.ExactStageBytes)
	hash, _ := runnerbindingcontract.HashStage(stage)
	if hash != v.StageHash {
		return nil, runnerstore.Failure(runnerstore.ErrorReconciliation, "reconciliation stage changed", nil)
	}
	if !bytes.Equal(binding.ExactStageBytes, original.ExactStageBytes) || !bytes.Equal(binding.ExactResolutionBytes, original.ExactResolutionBytes) ||
		(len(binding.ExactSourceResult) > 0 && !bytes.Equal(binding.ExactSourceResult, source.ExactSourceResult)) {
		return nil, runnerstore.Failure(runnerstore.ErrorConflict, "binding changed during source receipt lookup", nil)
	}
	binding.ExactSourceResult, binding.SourceResultHash = source.ExactSourceResult, source.SourceResultHash
	proof, err := readSettlementProof(ctx, tx, binding)
	if err != nil {
		return nil, err
	}
	if proof.outcome != v.Outcome {
		return nil, runnerstore.Failure(runnerstore.ErrorConflict, "source outcome changed; repeat the diagnostic preview", nil)
	}
	stageHash, _ := hex.DecodeString(hash)
	if proof.kind == "source_fence" {
		_, err = tx.Exec(ctx, `INSERT INTO workflow_control_source_fences(binding_id,workspace_id,run_id,stage_hash,correlation_id,expected_resume_generation) VALUES($1,$2,$3,$4,$5,$6)`, v.BindingID, v.WorkspaceID, v.RunID, stageHash, "resume."+hash, binding.ExpectedGeneration)
		if err != nil {
			return nil, databaseFailure("install durable source fence", err)
		}
		proof.exact, err = canonicaljson.Encode(map[string]any{"schema": "openslack.workflow_control_source_fence.v1", "bindingId": v.BindingID, "stageHash": hash, "workspaceId": v.WorkspaceID, "runId": v.RunID, "correlationId": "resume." + hash, "expectedResumeGeneration": binding.ExpectedGeneration})
		if err != nil {
			return nil, err
		}
		proof.exact = append(proof.exact, '\n')
	}
	var at time.Time
	if err = tx.QueryRow(ctx, `SELECT date_trunc('milliseconds',clock_timestamp())`).Scan(&at); err != nil {
		return nil, databaseFailure("read settlement timestamp", err)
	}
	r := runnerstore.BindingSettlementReceipt{Schema: runnerstore.BindingSettlementSchema, WorkspaceID: v.WorkspaceID, RunID: v.RunID, BindingID: v.BindingID, StageHash: hash,
		Outcome: proof.outcome, ProofKind: proof.kind, Proof: string(proof.exact), IdempotencyKey: prepared.IdempotencyKey, RequestHash: hex.EncodeToString(prepared.Hash), CallerID: repository.reconciliationCaller, RulesVersion: 1, CommittedAt: runnerstore.CanonicalTimestamp(at)}
	receipt, err = canonicaljson.Encode(r)
	if err != nil {
		return nil, err
	}
	receipt = append(receipt, '\n')
	if len(receipt) > runnerstore.RecoveryEvidenceMaxResponseBytes {
		return nil, runnerstore.Failure(runnerstore.ErrorLimitExceeded, "exact settlement receipt exceeds the response contract", nil)
	}
	if _, err = validateBindingSettlement(receipt, binding); err != nil {
		return nil, err
	}
	digest := sha256.Sum256(receipt)
	_, err = tx.Exec(ctx, `INSERT INTO workflow_runner_binding_settlements(binding_id,workspace_id,run_id,stage_hash,outcome,proof_kind,exact_proof_bytes,idempotency_key,exact_request_bytes,request_hash,exact_receipt_bytes,receipt_hash,caller_id,rules_version,committed_at)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,1,$14)`, v.BindingID, v.WorkspaceID, v.RunID, stageHash, proof.outcome, proof.kind, proof.exact, prepared.IdempotencyKey, prepared.ExactBytes, prepared.Hash, receipt, digest[:], repository.reconciliationCaller, at)
	if err != nil {
		return nil, databaseFailure("save binding settlement", err)
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, runnerstore.Failure(runnerstore.ErrorAuthorityUnavailable, "settlement commit outcome is unknown; query its exact receipt before retrying", err)
	}
	return receipt, nil
}
