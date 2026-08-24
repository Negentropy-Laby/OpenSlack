package postgres

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/authoritycontract"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/budgetcontract"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/authoritystore"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/budgetstore"
	budgetpostgres "github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/budgetstore/postgres"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/canonicaljson"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerstore"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/runnerbindingcontract"
)

type gs9f2GoldenOperation struct {
	Stage struct {
		Value runnerbindingcontract.Record `json:"value"`
	} `json:"stage"`
	Resolution struct {
		Value runnerbindingcontract.Record `json:"value"`
	} `json:"resolution"`
	StageReceipt struct {
		Value runnerbindingcontract.Record `json:"value"`
	} `json:"stageReceipt"`
	ResolutionReceipt struct {
		Value runnerbindingcontract.Record `json:"value"`
	} `json:"resolutionReceipt"`
}

type gs9f2BudgetCase struct {
	prepared               budgetcontract.PreparedRequest
	payload                map[string]any
	providerUsageHash      any
	expectedAccount        int64
	expectedSourceAccepted int64
	commit                 func() budgetstore.MutationResult
}

func assertGS9F2BudgetDecisionUsesSourceRevision(t testing.TB) {
	t.Helper()
	contents, err := runnerbindingcontract.BundleFile("golden-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var bundle struct {
		Positive struct {
			Operations       map[string]gs9f2GoldenOperation `json:"operations"`
			SemanticVariants map[string]gs9f2GoldenOperation `json:"semanticVariants"`
			ControlDelivery  struct {
				Artifacts map[string]struct {
					BudgetSourceResult any `json:"budgetSourceResult"`
				} `json:"artifacts"`
			} `json:"controlDelivery"`
		} `json:"positive"`
	}
	decoder := json.NewDecoder(bytes.NewReader(contents))
	decoder.UseNumber()
	if err := decoder.Decode(&bundle); err != nil {
		t.Fatal(err)
	}
	operation := bundle.Positive.SemanticVariants["budgetReserveGoAuthority"]
	stage, err := runnerbindingcontract.PrepareStage(bindingTestNormalizeNumbers(t, operation.Stage.Value))
	if err != nil {
		t.Fatal(err)
	}
	stageReceipt, err := runnerbindingcontract.PrepareReceipt(bindingTestNormalizeNumbers(t, operation.StageReceipt.Value))
	if err != nil {
		t.Fatal(err)
	}
	resolution, err := runnerbindingcontract.PrepareResolution(bindingTestNormalizeNumbers(t, operation.Resolution.Value))
	if err != nil {
		t.Fatal(err)
	}
	resolutionReceipt, err := runnerbindingcontract.PrepareReceipt(bindingTestNormalizeNumbers(t, operation.ResolutionReceipt.Value))
	if err != nil {
		t.Fatal(err)
	}
	sourceResult := bindingTestNormalizeNumbers(t, bundle.Positive.ControlDelivery.Artifacts["kind:budget_authorization"].BudgetSourceResult)
	sourceCanonical, err := budgetcontract.CanonicalJSON(sourceResult)
	if err != nil {
		t.Fatal(err)
	}
	target := bindingTestRecord(t, stage.Value["target"])
	message, err := authoritycontract.DecodeMessageJSON([]byte(target["body"].(string)))
	if err != nil {
		t.Fatal(err)
	}
	const runnerAcceptedRevision int64 = 9
	decision, exact, err := buildRuntimeBindingDecision(message, 162, time.Now().UTC(), runnerstore.V2AuthorityBindingView{
		BindingID: "WFRUNNER-BINDING-source-plane-regression", Operation: runnerbindingcontract.OperationBudgetReserve,
		ExactStageBytes: []byte(stage.Body), ExactStageReceipt: []byte(stageReceipt.Body),
		ExactResolutionBytes: []byte(resolution.Body), ExactResolutionReceipt: []byte(resolutionReceipt.Body),
		ExactSourceResult: append([]byte(sourceCanonical), '\n'), AcceptedRunRevision: runnerAcceptedRevision,
	})
	if err != nil {
		t.Fatal(err)
	}
	if decision == nil || decision.RunRevision == nil || *decision.RunRevision != runnerAcceptedRevision ||
		decision.Payload["committedRunRevision"] != int64(5) || len(exact) == 0 {
		t.Fatalf("budget decision spliced source and runner revision planes: %+v", decision)
	}
}

func exerciseGS9F2BindingLifecycle(
	t testing.TB,
	repository *Repository,
	operation runnerbindingcontract.Operation,
	suffix string,
) runnerstore.V2AuthorityBindingView {
	t.Helper()
	return exerciseGS9F2BindingLifecycleUntil(t, repository, operation, suffix, nil, "completed", "")
}

func exerciseGS9F2BindingLifecycleWithLease(
	t testing.TB,
	repository *Repository,
	operation runnerbindingcontract.Operation,
	suffix string,
	existing *runnerstore.AttemptLease,
) runnerstore.V2AuthorityBindingView {
	t.Helper()
	return exerciseGS9F2BindingLifecycleUntil(t, repository, operation, suffix, existing, "completed", "")
}

func exerciseGS9F2BindingLifecycleUntil(
	t testing.TB,
	repository *Repository,
	operation runnerbindingcontract.Operation,
	suffix string,
	existing *runnerstore.AttemptLease,
	stopState string,
	workspaceID string,
) runnerstore.V2AuthorityBindingView {
	t.Helper()
	var lease runnerstore.AttemptLease
	if existing != nil {
		lease = *existing
	} else {
		input := v2JobInput(t, suffix, "go", "workflow-control")
		if operation == runnerbindingcontract.OperationBudgetSettle {
			input.Prepared.Spec.RunRevision = 2
			prepared, err := runnerstore.PrepareV2JobSpec(input.Prepared.Spec)
			if err != nil {
				t.Fatal(err)
			}
			input.Prepared = prepared
			input.IdempotencyKey, input.RequestFingerprint = runnerstore.V2SubmissionBindings(prepared)
		}
		if workspaceID != "" {
			input = v2JobInputForWorkspace(t, suffix, workspaceID, "go", "workflow-control")
		}
		lease = claimV2(t, repository, input)
		if operation == runnerbindingcontract.OperationResumeAdvance {
			sealRuntimeAdmission(t, repository, lease, "resume")
			negotiateV2Lease(t, repository, lease)
		} else {
			sealRuntimeAdmission(t, repository, lease, "initial")
			negotiateV2Lease(t, repository, lease)
			acceptedAt := canonicalNow()
			accept := v2LeasedEventAt(t, lease, authoritycontract.KindLeaseAccept, 1, "event-"+suffix+"-initial",
				lease.RunRevision, lease.ResumeGeneration, acceptedAt,
				map[string]any{"acceptedAt": acceptedAt, "leaseExpiresAt": runnerstore.CanonicalTimestamp(lease.LeaseExpiresAt)})
			accept.ControlBuildHash = lease.AuthorityRoute.AuthorityBuildHash
			recorded, err := repository.RecordV2Event(context.Background(), accept)
			if err != nil {
				t.Fatal(err)
			}
			deliverV2Control(t, repository, lease.AttemptID, recorded.Receipt.EventID, string(recorded.Receipt.Kind))
		}
	}
	if existing == nil && operation == runnerbindingcontract.OperationEffectComplete {
		exerciseGS9F2BindingLifecycleWithLease(t, repository, runnerbindingcontract.OperationEffectAuthorize, suffix+"-intent", &lease)
	}
	var workerSequence, expectedRunRevision, expectedGeneration int64
	if err := repository.pool.QueryRow(context.Background(), `SELECT a.worker_sequence,b.current_run_revision,b.current_resume_generation
FROM workflow_runner_attempts a JOIN workflow_runner_v2_attempt_bindings b ON b.attempt_id=a.attempt_id
WHERE a.attempt_id=$1`, lease.AttemptID).Scan(&workerSequence, &expectedRunRevision, &expectedGeneration); err != nil {
		t.Fatal(err)
	}

	vector := gs9f2GoldenForOperation(t, operation)
	templateTarget := bindingTestRecord(t, vector.Stage.Value["target"])
	templateMessage, err := authoritycontract.DecodeMessageJSON([]byte(templateTarget["body"].(string)))
	if err != nil {
		t.Fatal(err)
	}
	delta, err := runnerbindingcontract.RunnerHeadDelta(operation)
	if err != nil {
		t.Fatal(err)
	}
	kind, err := runnerbindingcontract.ExpectedKind(operation)
	if err != nil {
		t.Fatal(err)
	}
	sequence := workerSequence + 1
	sentAt := canonicalNow()
	payload := templateMessage.Payload
	if operation == runnerbindingcontract.OperationResumeAdvance {
		payload["acceptedAt"] = sentAt
		payload["leaseExpiresAt"] = runnerstore.CanonicalTimestamp(lease.LeaseExpiresAt)
	}
	var budgetCase *gs9f2BudgetCase
	if operation == runnerbindingcontract.OperationBudgetReserve || operation == runnerbindingcontract.OperationBudgetSettle {
		budgetCase = prepareGS9F2BudgetCase(t, repository, lease, operation, suffix, expectedRunRevision, expectedGeneration)
		payload = budgetCase.payload
	}
	event := v2LeasedEventAt(t, lease, kind, sequence, "event-"+suffix+"-authority",
		expectedRunRevision, expectedGeneration, sentAt, payload)
	event.ControlBuildHash = lease.AuthorityRoute.AuthorityBuildHash
	preparedTarget, err := prepareV2Message(event.Message)
	if err != nil {
		t.Fatal(err)
	}
	route := runnerbindingcontract.Record{
		"backend": lease.AuthorityRoute.Backend, "authority": lease.AuthorityRoute.Authority,
		"routingEpoch": lease.AuthorityRoute.RoutingEpoch, "authorityBuildHash": lease.AuthorityRoute.AuthorityBuildHash,
	}
	runnerHead := runnerbindingcontract.Record{
		"expectedGlobalRunRevision": expectedRunRevision, "acceptedGlobalRunRevision": expectedRunRevision + delta.Revision,
		"expectedResumeGeneration": expectedGeneration, "acceptedResumeGeneration": expectedGeneration + delta.Generation,
	}
	target := runnerbindingcontract.Record{
		"schema": authoritycontract.PreparedSchema, "eventId": event.Message.EventID, "kind": string(kind), "sequence": sequence,
		"body": preparedTarget.Body, "messageDigest": preparedTarget.MessageDigest,
		"idempotencyKey": preparedTarget.IdempotencyKey, "requestFingerprint": preparedTarget.RequestFingerprint,
	}
	bindingID, err := runnerbindingcontract.DeriveBindingID(runnerbindingcontract.Record{
		"operation": string(operation), "workspaceId": lease.WorkspaceID, "jobId": lease.JobID,
		"runId": lease.WorkflowRunID, "runnerAttemptId": lease.AttemptID, "leaseId": lease.LeaseID,
		"fencingToken": lease.FencingToken, "route": route, "runnerAuthority": runnerHead,
		"targetBodyHash": preparedTarget.MessageDigest, "targetEventId": event.Message.EventID,
		"targetIdempotencyKey":     preparedTarget.IdempotencyKey,
		"targetRequestFingerprint": preparedTarget.RequestFingerprint, "targetSequence": sequence,
	})
	if err != nil {
		t.Fatal(err)
	}
	stageValue := runnerbindingcontract.Record{
		"schema": runnerbindingcontract.StageSchema, "contractVersion": runnerbindingcontract.ContractVersion,
		"profile": runnerbindingcontract.FutureRuntimeProfile, "phase": "stage_event", "direction": "runner-to-control",
		"companionSequence": int64(1), "bindingId": bindingID, "operation": string(operation),
		"workspaceId": lease.WorkspaceID, "jobId": lease.JobID, "runId": lease.WorkflowRunID,
		"runnerAttemptId": lease.AttemptID, "leaseId": lease.LeaseID, "fencingToken": lease.FencingToken,
		"route": route, "runnerAuthority": runnerHead, "target": target,
		"correlationId": lease.CorrelationID, "sentAt": sentAt,
	}
	stage, err := runnerbindingcontract.PrepareStage(stageValue)
	if err != nil {
		t.Fatal(err)
	}
	stageReceipt, err := repository.StageAuthorityBinding(context.Background(), runnerstore.V2AuthorityBindingInput{
		WorkspaceID: lease.WorkspaceID, Prepared: stage,
		IdempotencyKey: stage.IdempotencyKey, RequestFingerprint: stage.RequestFingerprint,
	})
	if err != nil {
		t.Fatal(err)
	}
	stageReplay, err := repository.StageAuthorityBinding(context.Background(), runnerstore.V2AuthorityBindingInput{
		WorkspaceID: lease.WorkspaceID, Prepared: stage,
		IdempotencyKey: stage.IdempotencyKey, RequestFingerprint: stage.RequestFingerprint,
	})
	if err != nil || !stageReplay.Replay || !bytes.Equal(stageReplay.ExactBytes, stageReceipt.ExactBytes) {
		t.Fatalf("stage exact replay drifted: %+v %v", stageReplay, err)
	}
	if stopState == "staged" {
		view, err := repository.ReadAuthorityBindingForEvent(context.Background(), event.Message.EventID, event.ExactBytes)
		if err != nil || view.State != stopState {
			t.Fatalf("staged authority binding view drifted: %+v %v", view, err)
		}
		return view
	}

	evidence := bindingTestRecord(t, vector.Resolution.Value["evidence"])
	bindGS9F2Evidence(t, evidence, operation, lease, event.Message, sentAt, expectedGeneration)
	if budgetCase != nil {
		bindGS9F2BudgetEvidence(t, evidence, lease, expectedGeneration, *budgetCase)
	}
	evidenceHash, err := runnerbindingcontract.HashEvidence(evidence, operation)
	if err != nil {
		t.Fatal(err)
	}
	stageReceiptHash, err := runnerbindingcontract.HashReceipt(stageReceipt.Value)
	if err != nil {
		t.Fatal(err)
	}
	resolutionValue := runnerbindingcontract.Record{
		"schema": runnerbindingcontract.ResolutionSchema, "contractVersion": runnerbindingcontract.ContractVersion,
		"profile": runnerbindingcontract.FutureRuntimeProfile, "phase": "commit_authority", "direction": "runner-to-control",
		"companionSequence": int64(2), "bindingId": bindingID, "operation": string(operation),
		"stageHash": stage.BodyHash, "stageReceiptHash": stageReceiptHash, "targetBodyHash": preparedTarget.MessageDigest,
		"evidence": evidence, "evidenceHash": evidenceHash, "sentAt": bindingTestString(t, stageReceipt.Value, "committedAt"),
	}
	resolution, err := runnerbindingcontract.PrepareResolution(resolutionValue)
	if err != nil {
		t.Fatal(err)
	}
	resolutionReceipt, err := repository.ResolveAuthorityBinding(context.Background(), bindingID, runnerstore.V2AuthorityBindingInput{
		WorkspaceID: lease.WorkspaceID, Prepared: resolution,
		IdempotencyKey: resolution.IdempotencyKey, RequestFingerprint: resolution.RequestFingerprint,
	})
	if err != nil {
		t.Fatal(err)
	}
	resolutionReplay, err := repository.ResolveAuthorityBinding(context.Background(), bindingID, runnerstore.V2AuthorityBindingInput{
		WorkspaceID: lease.WorkspaceID, Prepared: resolution,
		IdempotencyKey: resolution.IdempotencyKey, RequestFingerprint: resolution.RequestFingerprint,
	})
	if err != nil || !resolutionReplay.Replay || !bytes.Equal(resolutionReplay.ExactBytes, resolutionReceipt.ExactBytes) {
		t.Fatalf("resolution exact replay drifted: %+v %v", resolutionReplay, err)
	}
	readReceipt, err := repository.ReadAuthorityBindingReceipt(context.Background(), lease.WorkspaceID, resolution.IdempotencyKey)
	if err != nil || !readReceipt.Replay || !bytes.Equal(readReceipt.ExactBytes, resolutionReceipt.ExactBytes) {
		t.Fatalf("resolution response-loss point-read drifted: %+v %v", readReceipt, err)
	}
	if stopState == "resolved" {
		view, err := repository.ReadAuthorityBindingForEvent(context.Background(), event.Message.EventID, event.ExactBytes)
		if err != nil || view.State != stopState {
			t.Fatalf("resolved authority binding view drifted: %+v %v", view, err)
		}
		return view
	}
	if budgetCase != nil {
		result := budgetCase.commit()
		if result.Receipt["acceptedRunRevision"] != budgetCase.expectedSourceAccepted {
			t.Fatalf("budget source revision drifted: receipt=%+v want=%d", result.Receipt, budgetCase.expectedSourceAccepted)
		}
	}

	recorded, err := repository.RecordV2Event(context.Background(), event)
	if err != nil {
		t.Fatal(err)
	}
	if recorded.AuthorityBindingID == nil || *recorded.AuthorityBindingID != bindingID ||
		recorded.Receipt.RunRevision == nil || *recorded.Receipt.RunRevision != expectedRunRevision+delta.Revision ||
		recorded.Receipt.ResumeGeneration == nil || *recorded.Receipt.ResumeGeneration != expectedGeneration+delta.Generation {
		t.Fatalf("runtime-bound event matrix drifted: %+v", recorded)
	}
	expectsDecision := operation == runnerbindingcontract.OperationEffectAuthorize || operation == runnerbindingcontract.OperationBudgetReserve || operation == runnerbindingcontract.OperationResumeAdvance
	if expectsDecision != (recorded.Decision != nil) {
		t.Fatalf("runtime-bound decision presence drifted for %s: %+v", operation, recorded.Decision)
	}
	if operation == runnerbindingcontract.OperationBudgetReserve {
		if recorded.Decision == nil || recorded.Decision.RunRevision == nil ||
			*recorded.Decision.RunRevision != expectedRunRevision+delta.Revision ||
			recorded.Decision.Payload["committedRunRevision"] != budgetCase.expectedSourceAccepted {
			t.Fatalf("budget decision did not preserve the exact source revision: %+v source=%d", recorded.Decision, budgetCase.expectedSourceAccepted)
		}
	}
	if stopState == "runner_committed" || stopState == "awaiting_ack" {
		if stopState == "awaiting_ack" {
			if err := repository.MarkV2ControlDeliveryStarted(context.Background(), lease.AttemptID, recorded.Receipt.EventID, string(recorded.Receipt.Kind), time.Now().UTC()); err != nil {
				t.Fatal(err)
			}
		}
		view, err := repository.ReadAuthorityBindingForEvent(context.Background(), event.Message.EventID, event.ExactBytes)
		if err != nil || view.State != "runner_committed" {
			t.Fatalf("%s authority binding view drifted: %+v %v", stopState, view, err)
		}
		return view
	}
	eventACK := acknowledgeGS9F2Control(t, repository, lease, bindingID, operation, recorded.Receipt, 3)
	if recorded.Decision != nil {
		acknowledgeGS9F2Control(t, repository, lease, bindingID, operation, *recorded.Decision, 4)
	}
	ackReplay, err := repository.AcknowledgeV2Control(context.Background(), eventACK)
	if err != nil || !ackReplay.Replay || !bytes.Equal(ackReplay.ExactBytes, []byte(eventACK.Prepared.Body)) {
		t.Fatalf("control ACK exact replay drifted: %+v %v", ackReplay, err)
	}
	ackPointRead, err := repository.ReadAuthorityBindingReceipt(context.Background(), lease.WorkspaceID, eventACK.IdempotencyKey)
	if err != nil || !ackPointRead.Replay || !bytes.Equal(ackPointRead.ExactBytes, []byte(eventACK.Prepared.Body)) {
		t.Fatalf("control ACK response-loss point-read drifted: %+v %v", ackPointRead, err)
	}
	view, err := repository.ReadAuthorityBindingForEvent(context.Background(), event.Message.EventID, event.ExactBytes)
	if err != nil || view.State != "completed" || len(view.ControlACKs) != 1+boolInt(recorded.Decision != nil) {
		t.Fatalf("completed authority binding view drifted: %+v %v", view, err)
	}
	return view
}

func acknowledgeGS9F2Control(
	t testing.TB,
	repository *Repository,
	lease runnerstore.AttemptLease,
	bindingID string,
	operation runnerbindingcontract.Operation,
	message authoritycontract.Message,
	companionSequence int64,
) runnerstore.V2ControlAcknowledgementInput {
	t.Helper()
	input := prepareGS9F2ControlACK(t, repository, lease, bindingID, operation, message, companionSequence)
	if _, err := repository.AcknowledgeV2Control(context.Background(), input); err != nil {
		var exact []byte
		_ = repository.pool.QueryRow(context.Background(), `SELECT exact_message_bytes FROM workflow_runner_control_messages WHERE control_event_id=$1`, message.EventID).Scan(&exact)
		t.Fatalf("acknowledge %s exact control %q: %v", message.Kind, exact, err)
	}
	return input
}

func prepareGS9F2ControlACK(
	t testing.TB,
	repository *Repository,
	lease runnerstore.AttemptLease,
	bindingID string,
	operation runnerbindingcontract.Operation,
	message authoritycontract.Message,
	companionSequence int64,
) runnerstore.V2ControlAcknowledgementInput {
	t.Helper()
	if err := repository.MarkV2ControlDeliveryStarted(context.Background(), lease.AttemptID, message.EventID, string(message.Kind), time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	if err := repository.MarkV2ControlDelivered(context.Background(), lease.AttemptID, message.EventID, string(message.Kind), time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	return buildGS9F2ControlACK(t, lease, bindingID, operation, message, companionSequence)
}

func buildGS9F2ControlACK(
	t testing.TB,
	lease runnerstore.AttemptLease,
	bindingID string,
	operation runnerbindingcontract.Operation,
	message authoritycontract.Message,
	companionSequence int64,
) runnerstore.V2ControlAcknowledgementInput {
	t.Helper()
	preparedMessage, err := prepareV2Message(message)
	if err != nil {
		t.Fatal(err)
	}
	// The frozen F2a companion binds processing to the durable control clock;
	// this also makes an immutable decision's sentAt contiguous with seq-3.
	processedAt := message.SentAt
	receiptValue := runnerbindingcontract.Record{
		"schema": runnerbindingcontract.ReceiptSchema, "contractVersion": runnerbindingcontract.ContractVersion,
		"profile": runnerbindingcontract.FutureRuntimeProfile, "direction": "runner-to-control", "phase": "control_delivery",
		"companionSequence": companionSequence, "bindingId": bindingID, "operation": string(operation), "status": "accepted",
		"controlBuildHash": lease.AuthorityRoute.AuthorityBuildHash, "committedAt": processedAt, "reconciliationToken": nil,
		"controlEventId": message.EventID, "controlKind": string(message.Kind), "controlSequence": *message.Sequence,
		"messageDigest": preparedMessage.MessageDigest, "runnerAttemptId": lease.AttemptID, "leaseId": lease.LeaseID,
		"fencingToken": lease.FencingToken, "processedAt": processedAt, "disposition": "accepted",
	}
	prepared, err := runnerbindingcontract.PrepareReceipt(receiptValue)
	if err != nil {
		t.Fatal(err)
	}
	input := runnerstore.V2ControlAcknowledgementInput{
		BindingID: bindingID, WorkspaceID: lease.WorkspaceID, Prepared: prepared,
		IdempotencyKey: prepared.IdempotencyKey, RequestFingerprint: prepared.RequestFingerprint,
	}
	return input
}

func gs9f2BoundControl(
	t testing.TB,
	repository *Repository,
	view runnerstore.V2AuthorityBindingView,
	decision bool,
) (runnerstore.AttemptLease, authoritycontract.Message) {
	t.Helper()
	query := `SELECT control.exact_message_bytes
FROM workflow_runner_authority_bindings binding
JOIN workflow_runner_event_receipts receipt ON receipt.received_event_id=binding.target_event_id
JOIN workflow_runner_control_messages control ON control.control_event_id=receipt.receipt_event_id
WHERE binding.binding_id=$1`
	if decision {
		query = `SELECT control.exact_message_bytes
FROM workflow_runner_authority_bindings binding
JOIN workflow_runner_v2_decision_bindings decision ON decision.received_event_id=binding.target_event_id
JOIN workflow_runner_control_messages control ON control.control_event_id=decision.decision_control_event_id
WHERE binding.binding_id=$1`
	}
	var exact []byte
	if err := repository.pool.QueryRow(context.Background(), query, view.BindingID).Scan(&exact); err != nil {
		t.Fatal(err)
	}
	message, err := authoritycontract.DecodeMessageJSON(exact)
	if err != nil || message.AuthorityBuildHash == nil {
		t.Fatal(err)
	}
	return runnerstore.AttemptLease{
		WorkspaceID: view.WorkspaceID, JobID: view.JobID, WorkflowRunID: view.RunID,
		AttemptID: view.AttemptID, LeaseID: view.LeaseID, FencingToken: view.FencingToken,
		AuthorityRoute: &authoritycontract.Route{AuthorityBuildHash: *message.AuthorityBuildHash},
	}, message
}

func insertGS9F2ControlACKRow(
	t testing.TB,
	repository *Repository,
	bindingID string,
	input runnerstore.V2ControlAcknowledgementInput,
	priorControlEventID any,
) error {
	t.Helper()
	receipt := input.Prepared.Value
	processedAt, err := time.Parse(time.RFC3339Nano, receipt["processedAt"].(string))
	if err != nil {
		t.Fatal(err)
	}
	fingerprint, err := hex.DecodeString(input.RequestFingerprint[len("sha256:"):])
	if err != nil {
		t.Fatal(err)
	}
	ackHash := sha256.Sum256([]byte(input.Prepared.Body))
	_, err = repository.pool.Exec(context.Background(), `INSERT INTO workflow_runner_authority_control_acks
(control_event_id,binding_id,control_kind,control_sequence,companion_sequence,message_digest,
 attempt_id,lease_id,fencing_token,disposition,ack_idempotency_key,ack_request_fingerprint,
 ack_hash,exact_ack_bytes,prior_control_event_id,processed_at)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
		receipt["controlEventId"], bindingID, receipt["controlKind"], receipt["controlSequence"],
		receipt["companionSequence"], bindingDigestBytes(receipt["messageDigest"].(string)), receipt["runnerAttemptId"],
		receipt["leaseId"], receipt["fencingToken"], receipt["disposition"], input.IdempotencyKey,
		fingerprint, ackHash[:], []byte(input.Prepared.Body), priorControlEventID, processedAt)
	return err
}

func bindGS9F2Evidence(
	t testing.TB,
	evidence runnerbindingcontract.Record,
	operation runnerbindingcontract.Operation,
	lease runnerstore.AttemptLease,
	message authoritycontract.Message,
	stageSentAt string,
	expectedGeneration int64,
) {
	t.Helper()
	source := bindingTestRecord(t, evidence["sourceAuthority"])
	source["authorityBuildHash"] = lease.AuthorityRoute.AuthorityBuildHash
	source["expectedResumeGeneration"] = expectedGeneration
	source["acceptedResumeGeneration"] = expectedGeneration
	if operation == runnerbindingcontract.OperationResumeAdvance {
		source["acceptedResumeGeneration"] = expectedGeneration + 1
	}
	switch operation {
	case runnerbindingcontract.OperationCheckpointCommit, runnerbindingcontract.OperationResumeAdvance:
		envelope := bindingTestRecord(t, evidence["envelope"])
		observation := bindingTestRecord(t, envelope["observation"])
		observation["runId"] = lease.WorkflowRunID
		observation["resumeGeneration"] = source["acceptedResumeGeneration"]
		runner := bindingTestRecord(t, observation["runner"])
		runner["workspaceId"], runner["jobId"], runner["attemptId"] = lease.WorkspaceID, lease.JobID, lease.AttemptID
		runner["leaseId"], runner["fencingToken"], runner["correlationId"] = lease.LeaseID, lease.FencingToken, lease.CorrelationID
		runner["runnerBuildHash"] = lease.AuthorityRoute.AuthorityBuildHash
		if operation == runnerbindingcontract.OperationResumeAdvance {
			evidence["expiresAt"] = message.Payload["leaseExpiresAt"]
			observation["resumeGeneration"] = expectedGeneration + 1
			prior := bindingTestRecord(t, observation["priorCheckpoint"])
			evidence["priorCheckpointHash"] = bindingTestCanonicalHash(t, prior)
		}
		observationHash := bindingTestCanonicalHash(t, observation)
		envelope["observationHash"] = observationHash
		envelopeHash := bindingTestCanonicalHash(t, envelope)
		evidence["envelopeHash"] = envelopeHash
		source["requestHash"], source["recordHash"] = envelopeHash, observationHash
	case runnerbindingcontract.OperationEffectAuthorize:
		evidence["expiresAt"] = runnerstore.CanonicalTimestamp(time.Now().UTC().Add(time.Hour))
	case runnerbindingcontract.OperationEffectComplete:
	}
	_ = stageSentAt
}

func prepareGS9F2BudgetCase(
	t testing.TB,
	repository *Repository,
	lease runnerstore.AttemptLease,
	operation runnerbindingcontract.Operation,
	suffix string,
	expectedRunRevision int64,
	expectedGeneration int64,
) *gs9f2BudgetCase {
	t.Helper()
	// The budget authority owns an independent source revision plane. Keep it
	// intentionally unequal to the runner head so this real PostgreSQL lifecycle
	// cannot pass by accidentally copying the runner revision into the decision.
	sourceRunRevision := expectedRunRevision + 10
	if operation == runnerbindingcontract.OperationBudgetSettle {
		sourceRunRevision--
	}
	buildHash := lease.AuthorityRoute.AuthorityBuildHash
	route := budgetcontract.Record{
		"backend": budgetstore.Backend, "authority": budgetstore.Authority,
		"routingEpoch": lease.AuthorityRoute.RoutingEpoch, "authorityBuildHash": buildHash,
	}
	run := authoritystore.RunRecord{
		Schema: authoritystore.RunRecordSchema, WorkspaceID: lease.WorkspaceID, RunID: lease.WorkflowRunID,
		WorkflowID: "workflow-budget-" + suffix, WorkflowVersion: "1.0.0",
		WorkflowSourceHash: strings.Repeat("a", 64), ManifestHash: strings.Repeat("b", 64), InputHash: strings.Repeat("c", 64),
		Route: authoritystore.Route{Backend: budgetstore.Backend, Authority: budgetstore.Authority,
			RoutingEpoch: lease.AuthorityRoute.RoutingEpoch, AuthorityBuildHash: buildHash},
		State: authoritycontract.RunRunning, Revision: sourceRunRevision, ResumeGeneration: expectedGeneration,
	}
	exactRun, err := canonicaljson.Encode(run)
	if err != nil {
		t.Fatal(err)
	}
	exactRun = append(exactRun, '\n')
	runHash := sha256.Sum256(exactRun)
	if _, err := repository.pool.Exec(context.Background(), `INSERT INTO workflow_control_authority_epochs
(workspace_id,routing_epoch,backend,authority,authority_build_hash) VALUES ($1,$2,'go','workflow-control',$3);
INSERT INTO workflow_control_runs
(workspace_id,run_id,workflow_id,workflow_version,workflow_source_hash,manifest_hash,input_hash,
 backend,authority,routing_epoch,authority_build_hash,state,revision,resume_generation,record_hash,canonical_record_bytes)
VALUES ($1,$4,$5,$6,$7,$8,$9,'go','workflow-control',$2,$3,'running',$10,$11,$12,$13)`,
		lease.WorkspaceID, lease.AuthorityRoute.RoutingEpoch, bindingDigestBytes(buildHash), lease.WorkflowRunID,
		run.WorkflowID, run.WorkflowVersion, bindingDigestBytes(run.WorkflowSourceHash), bindingDigestBytes(run.ManifestHash),
		bindingDigestBytes(run.InputHash), sourceRunRevision, expectedGeneration, runHash[:], exactRun); err != nil {
		t.Fatal(err)
	}
	seed := budgetstore.QualificationSeed{
		PolicyHash: strings.Repeat("7", 64),
		Limit:      budgetstore.Quantities{Tokens: "1000", NanoUSD: "10000", Calls: "3"},
	}
	budgetRepository := budgetpostgres.New(repository.pool)
	base := func(schema, accountID, reservationID, callID string, expectedAccount, expectedRun int64) budgetcontract.Record {
		return budgetcontract.Record{
			"schema": schema, "contractVersion": budgetcontract.ContractVersion, "authority": budgetcontract.Authority,
			"writer": budgetcontract.Writer, "goRole": budgetcontract.GoRole, "goAuthorityClaim": budgetcontract.GoAuthorityClaim,
			"goAuthorityEligible": false, "workspaceId": lease.WorkspaceID, "runId": lease.WorkflowRunID,
			"accountId": accountID, "reservationId": reservationID, "callId": callID, "providerAttempt": "1",
			"expectedProviderHash": "sha256:" + strings.Repeat("d", 64), "expectedModelHash": "sha256:" + strings.Repeat("e", 64),
			"expectedProviderRunHash": "sha256:" + strings.Repeat("f", 64), "correlationId": lease.CorrelationID,
			"policyHash": seed.PolicyHash, "route": route, "expectedAccountRevision": expectedAccount,
			"expectedRunRevision": expectedRun, "rateNanoUsdPerToken": "10",
		}
	}
	accountID, reservationID, callID := "account-"+suffix, "reservation-"+suffix, "call-"+suffix
	reserveRequest := base(budgetcontract.SchemaReserveRequest, accountID, reservationID, callID, 0, sourceRunRevision)
	reserveRequest["requested"] = budgetcontract.Record{"tokens": "600", "nanoUsd": "6000", "calls": "1"}
	reserveRequest["requestedAt"] = runnerstore.CanonicalTimestamp(time.Now().UTC())
	reservePrepared, err := budgetcontract.PrepareRequest("reserve", reserveRequest, "qualification-caller")
	if err != nil {
		t.Fatal(err)
	}
	reserveMutation := func() budgetstore.MutationResult {
		result, err := budgetRepository.Reserve(context.Background(), budgetstore.MutationInput{
			Prepared: reservePrepared, ServiceBuildHash: buildHash, Seed: seed,
		})
		if err != nil || result.Status != "reserved" {
			t.Fatalf("budget reserve source commit: %+v %v", result, err)
		}
		return result
	}
	if operation == runnerbindingcontract.OperationBudgetReserve {
		return &gs9f2BudgetCase{
			prepared: reservePrepared, expectedAccount: 0, expectedSourceAccepted: sourceRunRevision + 1,
			providerUsageHash: nil, commit: reserveMutation,
			payload: map[string]any{
				"reservationId": reservationID, "callId": callID, "policyHash": seed.PolicyHash,
				"requestedTokens": "600", "requestedCostNanoUsd": "6000", "requestedCalls": "1",
			},
		}
	}
	reserved := reserveMutation()
	settleRequest := base(budgetcontract.SchemaSettlementRequest, accountID, reservationID, callID, 1, sourceRunRevision+1)
	settleRequest["requestedAt"] = reserved.Receipt["committedAt"]
	settleRequest["usageEvidenceStatus"] = "trusted"
	settleRequest["usageReceiptHash"] = nil
	settleRequest["providerUsage"] = nil
	decisionHash, err := budgetcontract.HashValue("reserve-decision", reserved.Record)
	if err != nil {
		t.Fatal(err)
	}
	settleRequest["reserveDecisionHash"] = decisionHash
	usage := budgetcontract.Record{
		"schema": budgetcontract.SchemaProviderUsage, "providerHash": reserveRequest["expectedProviderHash"],
		"modelHash": reserveRequest["expectedModelHash"], "runHash": reserveRequest["expectedProviderRunHash"],
		"attempt": "1", "calls": "1", "status": "reported", "inputTokens": "100", "outputTokens": "0",
		"totalTokens": "100", "outcome": "provider_response_accepted", "requestHash": "sha256:" + strings.Repeat("1", 64),
		"outcomeHash": "sha256:" + strings.Repeat("2", 64),
	}
	usageCanonical, err := budgetcontract.CanonicalJSON(usage)
	if err != nil {
		t.Fatal(err)
	}
	usageDigest := sha256.Sum256([]byte("openslack.provider-usage-receipt.v1\x00" + usageCanonical))
	usage["receiptHash"] = "sha256:" + hex.EncodeToString(usageDigest[:])
	usage, err = budgetcontract.ValidateProviderUsage(usage)
	if err != nil {
		t.Fatal(err)
	}
	settleRequest["providerUsage"], settleRequest["usageReceiptHash"] = usage, usage["receiptHash"]
	settlePrepared, err := budgetcontract.PrepareRequest("settle", settleRequest, "qualification-caller")
	if err != nil {
		t.Fatal(err)
	}
	return &gs9f2BudgetCase{
		prepared: settlePrepared, expectedAccount: 1, expectedSourceAccepted: sourceRunRevision + 2,
		providerUsageHash: usage["receiptHash"],
		payload: map[string]any{
			"reservationId": reservationID, "callId": callID, "providerReceiptHash": strings.TrimPrefix(usage["receiptHash"].(string), "sha256:"),
			"actualTokens": "100", "actualCostNanoUsd": "1000", "actualCalls": "1", "settlementStatus": "settled",
		},
		commit: func() budgetstore.MutationResult {
			result, err := budgetRepository.Settle(context.Background(), budgetstore.MutationInput{
				Prepared: settlePrepared, ServiceBuildHash: buildHash, Seed: seed,
			})
			if err != nil || result.Status != "settled" {
				t.Fatalf("budget settle source commit: %+v %v", result, err)
			}
			return result
		},
	}
}

func bindGS9F2BudgetEvidence(
	t testing.TB,
	evidence runnerbindingcontract.Record,
	lease runnerstore.AttemptLease,
	expectedGeneration int64,
	budgetCase gs9f2BudgetCase,
) {
	t.Helper()
	_, request, err := budgetcontract.ValidatePreparedRequestRecord(budgetCase.prepared)
	if err != nil {
		t.Fatal(err)
	}
	source := bindingTestRecord(t, evidence["sourceAuthority"])
	source["plane"], source["evidenceState"] = "budget_account", "prepared"
	source["expectedRevision"], source["acceptedRevision"] = budgetCase.expectedAccount, nil
	source["expectedResumeGeneration"], source["acceptedResumeGeneration"] = expectedGeneration, expectedGeneration
	source["requestHash"], source["receiptSchema"], source["receiptHash"], source["recordHash"] = budgetCase.prepared.RequestHash, nil, nil, nil
	source["authorityBuildHash"] = lease.AuthorityRoute.AuthorityBuildHash
	evidence["preparedRequest"] = budgetCase.prepared
	evidence["providerHash"], evidence["modelHash"] = request["expectedProviderHash"], request["expectedModelHash"]
	evidence["providerRunHash"], evidence["providerAttempt"] = request["expectedProviderRunHash"], request["providerAttempt"]
	evidence["accountId"], evidence["policyHash"] = request["accountId"], request["policyHash"]
	evidence["rateNanoUsdPerToken"], evidence["providerUsageReceiptHash"] = request["rateNanoUsdPerToken"], budgetCase.providerUsageHash
}

func gs9f2GoldenForOperation(t testing.TB, operation runnerbindingcontract.Operation) gs9f2GoldenOperation {
	t.Helper()
	contents, err := runnerbindingcontract.BundleFile("golden-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var bundle struct {
		Positive struct {
			Operations map[string]gs9f2GoldenOperation `json:"operations"`
		} `json:"positive"`
	}
	decoder := json.NewDecoder(bytes.NewReader(contents))
	decoder.UseNumber()
	if err := decoder.Decode(&bundle); err != nil {
		t.Fatal(err)
	}
	vector, ok := bundle.Positive.Operations[string(operation)]
	if !ok {
		t.Fatalf("missing golden operation %s", operation)
	}
	stageValue := bindingTestNormalizeNumbers(t, vector.Stage.Value).(runnerbindingcontract.Record)
	resolutionValue := bindingTestNormalizeNumbers(t, vector.Resolution.Value).(runnerbindingcontract.Record)
	stage, err := runnerbindingcontract.PrepareStage(stageValue)
	if err != nil {
		t.Fatal(err)
	}
	resolution, err := runnerbindingcontract.PrepareResolution(resolutionValue)
	if err != nil {
		t.Fatal(err)
	}
	vector.Stage.Value, vector.Resolution.Value = stage.Value, resolution.Value
	vector.StageReceipt.Value = bindingTestNormalizeNumbers(t, vector.StageReceipt.Value).(runnerbindingcontract.Record)
	vector.ResolutionReceipt.Value = bindingTestNormalizeNumbers(t, vector.ResolutionReceipt.Value).(runnerbindingcontract.Record)
	return vector
}

func bindingTestRecord(t testing.TB, value any) runnerbindingcontract.Record {
	t.Helper()
	switch record := value.(type) {
	case runnerbindingcontract.Record:
		return record
	case map[string]any:
		return runnerbindingcontract.Record(record)
	default:
		t.Fatalf("binding value is %T, not a record", value)
		return nil
	}
}

func bindingTestString(t testing.TB, value runnerbindingcontract.Record, field string) string {
	t.Helper()
	text, ok := value[field].(string)
	if !ok {
		t.Fatalf("binding field %s is %T", field, value[field])
	}
	return text
}

func bindingTestCanonicalHash(t testing.TB, value any) string {
	t.Helper()
	canonical, err := canonicaljson.Encode(bindingTestNormalizeNumbers(t, value))
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(canonical)
	return hex.EncodeToString(digest[:])
}

func bindingTestNormalizeNumbers(t testing.TB, value any) any {
	t.Helper()
	switch current := value.(type) {
	case json.Number:
		integer, err := current.Int64()
		if err != nil {
			t.Fatal(err)
		}
		return integer
	case runnerbindingcontract.Record:
		result := runnerbindingcontract.Record{}
		for key, item := range current {
			result[key] = bindingTestNormalizeNumbers(t, item)
		}
		return result
	case map[string]any:
		result := map[string]any{}
		for key, item := range current {
			result[key] = bindingTestNormalizeNumbers(t, item)
		}
		return result
	case []any:
		result := make([]any, len(current))
		for index, item := range current {
			result[index] = bindingTestNormalizeNumbers(t, item)
		}
		return result
	default:
		return current
	}
}

func boolInt(value bool) int {
	if value {
		return 1
	}
	return 0
}
