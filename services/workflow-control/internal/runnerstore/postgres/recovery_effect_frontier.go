package postgres

import (
	"context"
	"encoding/hex"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerstore"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/runnerbindingcontract"
	"github.com/jackc/pgx/v5"
)

type recoveryEffectIdentity struct {
	attempt, occurrence, effect, effectHash, execution, claim string
}
type recoveryEffectBoundary struct{ attempt, event string }
type recoveryEffectConclusion struct{ effect, effectHash, status, outcomeHash string }

func recoveryEffectKey(attempt string, evidence runnerbindingcontract.Record) recoveryEffectIdentity {
	return recoveryEffectIdentity{attempt, bindingString(evidence, "occurrenceId"), bindingString(evidence, "effectId"),
		bindingString(evidence, "effectHash"), bindingString(evidence, "executionId"), bindingString(evidence, "claimHash")}
}

// Source completion is distinct from delivery of the old outcome/ACK. Project
// exact, closed evidence without changing a historical boundary or fabricating
// delivery. In particular a denied approval never created an execution claim.
func verifyRecoveryEffectFrontier(ctx context.Context, tx pgx.Tx, workspace, run string) error {
	unknown := func() error {
		return runnerstore.Failure(runnerstore.ErrorReconciliation, "run has an unresolved or conflicting effect outcome", nil)
	}
	rows, err := tx.Query(ctx, `SELECT `+authorityBindingViewColumns+` FROM workflow_runner_authority_bindings
 WHERE workspace_id=$1 AND run_id=$2 AND operation IN ('effect_authorize','effect_complete') ORDER BY binding_id`, workspace, run)
	if err != nil {
		return databaseFailure("read effect recovery evidence", err)
	}
	views := []runnerstore.V2AuthorityBindingView{}
	for rows.Next() {
		v, e := scanAuthorityBindingView(rows)
		if e != nil {
			rows.Close()
			return databaseFailure("scan effect recovery evidence", e)
		}
		views = append(views, v)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return databaseFailure("iterate effect recovery evidence", err)
	}
	authorizations := map[recoveryEffectIdentity]recoveryEffectBoundary{}
	completions := map[recoveryEffectIdentity]recoveryEffectConclusion{}
	closed := map[recoveryEffectBoundary]recoveryEffectConclusion{}
	for _, v := range views {
		if err := validateRecoveredBinding(v); err != nil {
			return err
		}
		if len(v.ExactResolutionBytes) == 0 {
			return unknown()
		}
		if v.State != "completed" {
			var raw []byte
			if err := tx.QueryRow(ctx, `SELECT exact_receipt_bytes FROM workflow_runner_binding_settlements WHERE binding_id=$1`, v.BindingID).Scan(&raw); err != nil {
				return unknown()
			}
			receipt, err := validateBindingSettlement(raw, v)
			if err != nil || receipt.Outcome != "committed" || receipt.ProofKind != "resolution" {
				return unknown()
			}
		}
		resolution, err := runnerbindingcontract.ParseResolutionBytes(v.ExactResolutionBytes)
		if err != nil {
			return unknown()
		}
		evidence := bindingRecord(resolution, "evidence")
		if bindingString(bindingRecord(evidence, "sourceAuthority"), "evidenceState") != "committed" {
			return unknown()
		}
		key := recoveryEffectKey(v.AttemptID, evidence)
		if v.Operation == runnerbindingcontract.OperationEffectAuthorize {
			boundary := recoveryEffectBoundary{v.AttemptID, v.TargetEventID}
			if bindingString(evidence, "approvalStatus") != "approved" {
				closed[boundary] = recoveryEffectConclusion{key.effect, key.effectHash, "denied", ""}
			} else {
				if _, duplicate := authorizations[key]; duplicate {
					return unknown()
				}
				authorizations[key] = boundary
			}
		} else {
			status := bindingString(evidence, "status")
			if status != "executed" && status != "failed" {
				return unknown()
			}
			if _, duplicate := completions[key]; duplicate {
				return unknown()
			}
			completions[key] = recoveryEffectConclusion{key.effect, key.effectHash, status, bindingString(evidence, "outcomeHash")}
		}
	}
	for key, boundary := range authorizations {
		conclusion, ok := completions[key]
		if !ok {
			return unknown()
		}
		closed[boundary] = conclusion
		delete(completions, key)
	}
	if len(completions) != 0 {
		return unknown()
	}
	rows, err = tx.Query(ctx, `SELECT e.attempt_id,e.intent_event_id,e.effect_id,e.intent_hash,e.outcome_status,e.outcome_hash
 FROM workflow_runner_effect_boundaries e JOIN workflow_runner_attempts a USING(attempt_id)
 JOIN workflow_runner_jobs j ON j.workspace_id=a.workspace_id AND j.job_id=a.job_id WHERE j.workspace_id=$1 AND j.workflow_run_id=$2`, workspace, run)
	if err != nil {
		return databaseFailure("read historical effect boundaries", err)
	}
	defer rows.Close()
	for rows.Next() {
		var attempt, event, effect string
		var hash, outcomeHash []byte
		var status *string
		if err := rows.Scan(&attempt, &event, &effect, &hash, &status, &outcomeHash); err != nil {
			return databaseFailure("scan historical effect boundary", err)
		}
		conclusion, hasProof := closed[recoveryEffectBoundary{attempt, event}]
		if status != nil && *status == "reconciliation_required" {
			return unknown()
		}
		if hasProof {
			if conclusion.effect != effect || conclusion.effectHash != hex.EncodeToString(hash) ||
				(status != nil && (*status != conclusion.status || hex.EncodeToString(outcomeHash) != conclusion.outcomeHash)) {
				return unknown()
			}
		} else if status == nil || (*status != "executed" && *status != "failed") {
			return unknown()
		}
	}
	if err := rows.Err(); err != nil {
		return databaseFailure("iterate historical effect boundaries", err)
	}
	return nil
}
