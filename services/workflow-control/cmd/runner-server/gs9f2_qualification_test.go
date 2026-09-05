package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/authoritycontract"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/canonicaljson"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerapp"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerstore"
	runnerpostgres "github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerstore/postgres"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/testsupport"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/runnerbindingcontract"
)

func TestGS9F2Qualification(t *testing.T) {
	marker, configured := os.LookupEnv("WORKFLOW_RUNNER_GS9F2_QUALIFICATION")
	if !configured {
		t.Skip("WORKFLOW_RUNNER_GS9F2_QUALIFICATION is not configured")
	}
	if marker != "1" {
		t.Fatalf("WORKFLOW_RUNNER_GS9F2_QUALIFICATION must be exactly 1, got %q", marker)
	}
	pool := testsupport.OpenPostgres(t)
	repository := runnerpostgres.NewForV2RuntimeDelivery(pool, runnerstore.V2AuthorityPorts{})
	workspace := "workspace.gs9f2.qualification"
	prepared, err := runnerstore.PrepareV2JobSpec(runnerstore.V2JobSpec{
		Schema: runnerstore.V2JobSpecSchema, WorkspaceID: workspace, JobID: "job.gs9f2.qualification",
		WorkflowRunID: "run.gs9f2.qualification", CorrelationID: "correlation.gs9f2.qualification",
		ExecutionDescriptorRef: "descriptor.gs9f2.qualification", ExecutionDescriptorHash: strings.Repeat("1", 64),
		WorkflowID: "workflow.gs9f2.qualification", WorkflowVersion: "1.0.0",
		WorkflowSourceHash: strings.Repeat("2", 64), ManifestHash: strings.Repeat("3", 64), InputHash: strings.Repeat("4", 64),
		WholeTimeoutMS: time.Hour.Milliseconds(), SubmittedAt: runnerstore.CanonicalTimestamp(time.Now().UTC()),
		RequiredProtocolVersion: authoritycontract.ProtocolVersion, RequiredCapabilities: runnerstore.V2RequiredCapabilities(),
		AuthorityRoute: authoritycontract.Route{Backend: "go", Authority: "workflow-control", RoutingEpoch: 1, AuthorityBuildHash: strings.Repeat("5", 64)},
		RunRevision:    1, ResumeGeneration: 0,
	})
	if err != nil {
		t.Fatal(err)
	}
	key, fingerprint := runnerstore.V2SubmissionBindings(prepared)
	if _, err := repository.SubmitV2(t.Context(), runnerstore.V2SubmitInput{Prepared: prepared, IdempotencyKey: key, RequestFingerprint: fingerprint}); err != nil {
		t.Fatal(err)
	}
	lease, err := repository.ClaimNext(t.Context(), runnerstore.ClaimInput{
		WorkspaceID: workspace, SupervisorInstanceID: "runner.gs9f2.qualification",
		LeaseOfferTimeout: 10 * time.Second, LeaseDuration: time.Minute,
		ProtocolVersions: []string{authoritycontract.ProtocolVersion},
	})
	if err != nil {
		t.Fatal(err)
	}
	admission, err := runnerstore.PrepareV2RuntimeAdmission(runnerstore.V2RuntimeAdmission{
		Schema: runnerstore.V2RuntimeAdmissionSchema, WorkspaceID: lease.WorkspaceID, JobID: lease.JobID,
		WorkflowRunID: lease.WorkflowRunID, AttemptID: lease.AttemptID, LeaseID: lease.LeaseID,
		FencingToken: lease.FencingToken, JobSpecHash: lease.JobSpecHash, Disposition: "initial",
	})
	if err != nil {
		t.Fatal(err)
	}
	token := strings.Repeat("q", 40)
	tokenHash := sha256.Sum256([]byte(token))
	service, err := runnerapp.New(runnerapp.Options{
		Store: repository, V2Store: repository, BindingStore: repository, AdmissionStore: repository,
		SchemaVersion: 8, BuildSHA: strings.Repeat("a", 64), WorkspaceID: workspace,
		BearerTokenSHA256:  hex.EncodeToString(tokenHash[:]),
		RunAuthorityOrigin: "http://127.0.0.1:8082", RunAuthorityCallerID: "workflow-runner-v2",
		RunAuthorityBuildSHA: strings.Repeat("5", 64), RunAuthorityTokenSHA256: strings.Repeat("6", 64),
	})
	if err != nil {
		t.Fatal(err)
	}
	post := func() *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodPost, runnerapp.RouteV2RuntimeAdmission, bytes.NewReader(admission.ExactBytes))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Authorization", "Bearer "+token)
		request.Header.Set(runnerapp.HeaderWorkspaceID, workspace)
		request.Header.Set("Idempotency-Key", admission.IdempotencyKey)
		request.Header.Set(runnerapp.HeaderRequestFingerprint, admission.RequestFingerprint)
		response := httptest.NewRecorder()
		service.Handler().ServeHTTP(response, request)
		return response
	}
	first, replay := post(), post()
	if first.Code != http.StatusCreated || replay.Code != http.StatusOK ||
		first.Body.String() != replay.Body.String() || replay.Header().Get(runnerapp.HeaderIdempotencyReplayed) != "true" {
		t.Fatalf("runtime admission HTTP exact replay drifted: first=%d %s replay=%d %s", first.Code, first.Body.String(), replay.Code, replay.Body.String())
	}
	qualifyGS9F2CheckpointHTTP(t, repository, service.Handler(), lease, token)
}

func qualifyGS9F2CheckpointHTTP(t *testing.T, repository *runnerpostgres.Repository, handler http.Handler, lease runnerstore.AttemptLease, token string) {
	t.Helper()
	hello := authoritycontract.Message{Schema: authoritycontract.MessageSchema, ProtocolVersion: authoritycontract.ProtocolVersion,
		Kind: authoritycontract.KindHello, WorkspaceID: lease.WorkspaceID, EventID: "hello-gs9f2-http",
		CorrelationID: lease.CorrelationID, SentAt: runnerstore.CanonicalTimestamp(time.Now().UTC()), Payload: map[string]any{
			"runtimeName": "node", "runtimeVersion": "22.14.0", "runnerBuildHash": strings.Repeat("e", 64),
			"supportedProtocolVersions": []any{authoritycontract.ProtocolVersion},
			"capabilities":              []any{"cancel_ack", "effect_receipts", "lease_heartbeat"}, "maxConcurrentJobs": int64(1),
		}}
	preparedHello := gs9f2HTTPPrepareMessage(t, hello)
	negotiation, err := repository.RecordV2Negotiation(t.Context(), runnerstore.V2NegotiationInput{
		Lease: lease, Hello: hello, ExactBytes: []byte(preparedHello.Body), ControlBuildHash: strings.Repeat("f", 64),
		ExpectedRunnerBuildHash: strings.Repeat("e", 64), HeartbeatInterval: time.Second,
		LeaseOfferTimeout: 10 * time.Second, Now: time.Now().UTC(),
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, control := range []authoritycontract.Message{negotiation.HelloAck, *lease.V2LeaseOffer} {
		if err := repository.MarkV2ControlDeliveryStarted(t.Context(), lease.AttemptID, control.EventID, string(control.Kind), time.Now().UTC()); err != nil {
			t.Fatal(err)
		}
		if err := repository.MarkV2ControlDelivered(t.Context(), lease.AttemptID, control.EventID, string(control.Kind), time.Now().UTC()); err != nil {
			t.Fatal(err)
		}
	}
	acceptedAt := runnerstore.CanonicalTimestamp(time.Now().UTC())
	accept := gs9f2HTTPEvent(t, lease, authoritycontract.KindLeaseAccept, 1, "event-gs9f2-http-accept", 1, 0,
		acceptedAt, map[string]any{"acceptedAt": acceptedAt, "leaseExpiresAt": runnerstore.CanonicalTimestamp(lease.LeaseExpiresAt)})
	accepted, err := repository.RecordV2Event(t.Context(), accept)
	if err != nil {
		t.Fatal(err)
	}
	if err := repository.MarkV2ControlDeliveryStarted(t.Context(), lease.AttemptID, accepted.Receipt.EventID, string(accepted.Receipt.Kind), time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	if err := repository.MarkV2ControlDelivered(t.Context(), lease.AttemptID, accepted.Receipt.EventID, string(accepted.Receipt.Kind), time.Now().UTC()); err != nil {
		t.Fatal(err)
	}

	vector := gs9f2HTTPCheckpointGolden(t)
	templateTarget := gs9f2HTTPRecord(t, vector.Stage.Value["target"])
	templateMessage, err := authoritycontract.DecodeMessageJSON([]byte(templateTarget["body"].(string)))
	if err != nil {
		t.Fatal(err)
	}
	sentAt := runnerstore.CanonicalTimestamp(time.Now().UTC())
	target := gs9f2HTTPEvent(t, lease, authoritycontract.KindCheckpointCommit, 2, "event-gs9f2-http-checkpoint",
		1, 0, sentAt, templateMessage.Payload)
	preparedTarget := gs9f2HTTPPrepareMessage(t, target.Message)
	route := runnerbindingcontract.Record{"backend": "go", "authority": "workflow-control",
		"routingEpoch": lease.AuthorityRoute.RoutingEpoch, "authorityBuildHash": lease.AuthorityRoute.AuthorityBuildHash}
	runnerHead := runnerbindingcontract.Record{"expectedGlobalRunRevision": int64(1), "acceptedGlobalRunRevision": int64(2),
		"expectedResumeGeneration": int64(0), "acceptedResumeGeneration": int64(0)}
	targetRecord := runnerbindingcontract.Record{"schema": authoritycontract.PreparedSchema, "eventId": target.Message.EventID,
		"kind": string(target.Message.Kind), "sequence": int64(2), "body": preparedTarget.Body,
		"messageDigest": preparedTarget.MessageDigest, "idempotencyKey": preparedTarget.IdempotencyKey,
		"requestFingerprint": preparedTarget.RequestFingerprint}
	bindingID, err := runnerbindingcontract.DeriveBindingID(runnerbindingcontract.Record{
		"operation": string(runnerbindingcontract.OperationCheckpointCommit), "workspaceId": lease.WorkspaceID,
		"jobId": lease.JobID, "runId": lease.WorkflowRunID, "runnerAttemptId": lease.AttemptID,
		"leaseId": lease.LeaseID, "fencingToken": lease.FencingToken, "route": route, "runnerAuthority": runnerHead,
		"targetBodyHash": preparedTarget.MessageDigest, "targetEventId": target.Message.EventID,
		"targetIdempotencyKey": preparedTarget.IdempotencyKey, "targetRequestFingerprint": preparedTarget.RequestFingerprint,
		"targetSequence": int64(2),
	})
	if err != nil {
		t.Fatal(err)
	}
	stage, err := runnerbindingcontract.PrepareStage(runnerbindingcontract.Record{
		"schema": runnerbindingcontract.StageSchema, "contractVersion": runnerbindingcontract.ContractVersion,
		"profile": runnerbindingcontract.FutureRuntimeProfile, "phase": "stage_event", "direction": "runner-to-control",
		"companionSequence": int64(1), "bindingId": bindingID, "operation": string(runnerbindingcontract.OperationCheckpointCommit),
		"workspaceId": lease.WorkspaceID, "jobId": lease.JobID, "runId": lease.WorkflowRunID,
		"runnerAttemptId": lease.AttemptID, "leaseId": lease.LeaseID, "fencingToken": lease.FencingToken,
		"route": route, "runnerAuthority": runnerHead, "target": targetRecord, "correlationId": lease.CorrelationID, "sentAt": sentAt,
	})
	if err != nil {
		t.Fatal(err)
	}
	stageResponse := gs9f2HTTPSealedPost(t, handler, token, lease.WorkspaceID, runnerapp.RouteAuthorityBindingStage,
		[]byte(stage.Body), stage.IdempotencyKey, stage.RequestFingerprint)
	stageReplay := gs9f2HTTPSealedPost(t, handler, token, lease.WorkspaceID, runnerapp.RouteAuthorityBindingStage,
		[]byte(stage.Body), stage.IdempotencyKey, stage.RequestFingerprint)
	if stageResponse.Code != http.StatusCreated || stageReplay.Code != http.StatusOK ||
		stageResponse.Body.String() != stageReplay.Body.String() || stageReplay.Header().Get(runnerapp.HeaderIdempotencyReplayed) != "true" {
		t.Fatalf("authority stage HTTP replay drifted: first=%d %s replay=%d %s", stageResponse.Code,
			stageResponse.Body.String(), stageReplay.Code, stageReplay.Body.String())
	}
	stageReceipt, err := runnerbindingcontract.ParseReceiptBytes(stageResponse.Body.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	evidence := gs9f2HTTPRecord(t, vector.Resolution.Value["evidence"])
	gs9f2HTTPBindCheckpointEvidence(t, evidence, lease)
	evidenceHash, err := runnerbindingcontract.HashEvidence(evidence, runnerbindingcontract.OperationCheckpointCommit)
	if err != nil {
		t.Fatal(err)
	}
	stageReceiptHash, err := runnerbindingcontract.HashReceipt(stageReceipt)
	if err != nil {
		t.Fatal(err)
	}
	resolution, err := runnerbindingcontract.PrepareResolution(runnerbindingcontract.Record{
		"schema": runnerbindingcontract.ResolutionSchema, "contractVersion": runnerbindingcontract.ContractVersion,
		"profile": runnerbindingcontract.FutureRuntimeProfile, "phase": "commit_authority", "direction": "runner-to-control",
		"companionSequence": int64(2), "bindingId": bindingID, "operation": string(runnerbindingcontract.OperationCheckpointCommit),
		"stageHash": stage.BodyHash, "stageReceiptHash": stageReceiptHash, "targetBodyHash": preparedTarget.MessageDigest,
		"evidence": evidence, "evidenceHash": evidenceHash, "sentAt": stageReceipt["committedAt"],
	})
	if err != nil {
		t.Fatal(err)
	}
	resolvePath := "/v2/runner/authority-bindings/" + bindingID + ":resolve"
	resolutionResponse := gs9f2HTTPSealedPost(t, handler, token, lease.WorkspaceID, resolvePath,
		[]byte(resolution.Body), resolution.IdempotencyKey, resolution.RequestFingerprint)
	resolutionReplay := gs9f2HTTPSealedPost(t, handler, token, lease.WorkspaceID, resolvePath,
		[]byte(resolution.Body), resolution.IdempotencyKey, resolution.RequestFingerprint)
	if resolutionResponse.Code != http.StatusCreated || resolutionReplay.Code != http.StatusOK ||
		resolutionResponse.Body.String() != resolutionReplay.Body.String() ||
		resolutionReplay.Header().Get(runnerapp.HeaderIdempotencyReplayed) != "true" {
		t.Fatalf("authority resolution HTTP replay drifted: first=%d %s replay=%d %s", resolutionResponse.Code,
			resolutionResponse.Body.String(), resolutionReplay.Code, resolutionReplay.Body.String())
	}
	recorded, err := repository.RecordV2Event(t.Context(), target)
	if err != nil || recorded.AuthorityBindingID == nil || *recorded.AuthorityBindingID != bindingID {
		t.Fatalf("HTTP-bound target event was not consumed exactly: %+v %v", recorded, err)
	}
	if err := repository.MarkV2ControlDeliveryStarted(t.Context(), lease.AttemptID, recorded.Receipt.EventID,
		string(recorded.Receipt.Kind), time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	preparedReceiptMessage := gs9f2HTTPPrepareMessage(t, recorded.Receipt)
	ackAt := recorded.Receipt.SentAt
	ack, err := runnerbindingcontract.PrepareReceipt(runnerbindingcontract.Record{
		"schema": runnerbindingcontract.ReceiptSchema, "contractVersion": runnerbindingcontract.ContractVersion,
		"profile": runnerbindingcontract.FutureRuntimeProfile, "direction": "runner-to-control", "phase": "control_delivery",
		"companionSequence": int64(3), "bindingId": bindingID, "operation": string(runnerbindingcontract.OperationCheckpointCommit),
		"status": "accepted", "controlBuildHash": lease.AuthorityRoute.AuthorityBuildHash, "committedAt": ackAt,
		"reconciliationToken": nil, "controlEventId": recorded.Receipt.EventID, "controlKind": string(recorded.Receipt.Kind),
		"controlSequence": *recorded.Receipt.Sequence, "messageDigest": preparedReceiptMessage.MessageDigest,
		"runnerAttemptId": lease.AttemptID, "leaseId": lease.LeaseID, "fencingToken": lease.FencingToken,
		"processedAt": ackAt, "disposition": "accepted",
	})
	if err != nil {
		t.Fatal(err)
	}
	ackPath := "/v2/runner/authority-bindings/" + bindingID + ":ack-control"
	ackResponse := gs9f2HTTPSealedPost(t, handler, token, lease.WorkspaceID, ackPath,
		[]byte(ack.Body), ack.IdempotencyKey, ack.RequestFingerprint)
	ackReplay := gs9f2HTTPSealedPost(t, handler, token, lease.WorkspaceID, ackPath,
		[]byte(ack.Body), ack.IdempotencyKey, ack.RequestFingerprint)
	if ackResponse.Code != http.StatusCreated || ackReplay.Code != http.StatusOK ||
		ackResponse.Body.String() != ackReplay.Body.String() ||
		ackReplay.Header().Get(runnerapp.HeaderIdempotencyReplayed) != "true" {
		t.Fatalf("authority control ACK HTTP replay drifted: first=%d %s replay=%d %s", ackResponse.Code,
			ackResponse.Body.String(), ackReplay.Code, ackReplay.Body.String())
	}
	readRequest := httptest.NewRequest(http.MethodGet,
		"/v2/runner/authority-bindings/receipts/"+ack.IdempotencyKey, nil)
	readRequest.Header.Set("Authorization", "Bearer "+token)
	readRequest.Header.Set(runnerapp.HeaderWorkspaceID, lease.WorkspaceID)
	readResponse := httptest.NewRecorder()
	handler.ServeHTTP(readResponse, readRequest)
	if readResponse.Code != http.StatusOK || readResponse.Body.String() != ackResponse.Body.String() {
		t.Fatalf("authority ACK response-loss point-read drifted: post=%d %s read=%d %s", ackResponse.Code,
			ackResponse.Body.String(), readResponse.Code, readResponse.Body.String())
	}
}

type gs9f2HTTPGoldenOperation struct {
	Stage struct {
		Value runnerbindingcontract.Record `json:"value"`
	} `json:"stage"`
	Resolution struct {
		Value runnerbindingcontract.Record `json:"value"`
	} `json:"resolution"`
}

func gs9f2HTTPCheckpointGolden(t testing.TB) gs9f2HTTPGoldenOperation {
	t.Helper()
	contents, err := runnerbindingcontract.BundleFile("golden-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var bundle struct {
		Positive struct {
			Operations map[string]gs9f2HTTPGoldenOperation `json:"operations"`
		} `json:"positive"`
	}
	decoder := json.NewDecoder(bytes.NewReader(contents))
	decoder.UseNumber()
	if err := decoder.Decode(&bundle); err != nil {
		t.Fatal(err)
	}
	value := bundle.Positive.Operations[string(runnerbindingcontract.OperationCheckpointCommit)]
	value.Stage.Value = gs9f2HTTPNormalize(t, value.Stage.Value).(runnerbindingcontract.Record)
	value.Resolution.Value = gs9f2HTTPNormalize(t, value.Resolution.Value).(runnerbindingcontract.Record)
	return value
}

func gs9f2HTTPBindCheckpointEvidence(t testing.TB, evidence runnerbindingcontract.Record, lease runnerstore.AttemptLease) {
	t.Helper()
	source := gs9f2HTTPRecord(t, evidence["sourceAuthority"])
	source["authorityBuildHash"] = lease.AuthorityRoute.AuthorityBuildHash
	source["expectedResumeGeneration"], source["acceptedResumeGeneration"] = int64(0), int64(0)
	envelope := gs9f2HTTPRecord(t, evidence["envelope"])
	observation := gs9f2HTTPRecord(t, envelope["observation"])
	observation["runId"], observation["resumeGeneration"] = lease.WorkflowRunID, int64(0)
	runner := gs9f2HTTPRecord(t, observation["runner"])
	runner["workspaceId"], runner["jobId"], runner["attemptId"] = lease.WorkspaceID, lease.JobID, lease.AttemptID
	runner["leaseId"], runner["fencingToken"], runner["correlationId"] = lease.LeaseID, lease.FencingToken, lease.CorrelationID
	runner["runnerBuildHash"] = lease.AuthorityRoute.AuthorityBuildHash
	observationHash := gs9f2HTTPCanonicalHash(t, observation)
	envelope["observationHash"] = observationHash
	envelopeHash := gs9f2HTTPCanonicalHash(t, envelope)
	evidence["envelopeHash"] = envelopeHash
	source["requestHash"], source["recordHash"] = envelopeHash, observationHash
}

func gs9f2HTTPEvent(t testing.TB, lease runnerstore.AttemptLease, kind authoritycontract.Kind, sequence int64,
	eventID string, revision, generation int64, sentAt string, payload map[string]any) runnerstore.V2RecordEventInput {
	t.Helper()
	jobID, runID, attemptID, leaseID, fence := lease.JobID, lease.WorkflowRunID, lease.AttemptID, lease.LeaseID, lease.FencingToken
	route := lease.AuthorityRoute
	message := authoritycontract.Message{Schema: authoritycontract.MessageSchema, ProtocolVersion: authoritycontract.ProtocolVersion,
		Kind: kind, WorkspaceID: lease.WorkspaceID, JobID: &jobID, WorkflowRunID: &runID, AttemptID: &attemptID,
		LeaseID: &leaseID, FencingToken: &fence, Sequence: &sequence, AuthorityBackend: &route.Backend,
		Authority: &route.Authority, RoutingEpoch: &route.RoutingEpoch, AuthorityBuildHash: &route.AuthorityBuildHash,
		RunRevision: &revision, ResumeGeneration: &generation, EventID: eventID, CorrelationID: lease.CorrelationID,
		SentAt: sentAt, Payload: payload}
	prepared := gs9f2HTTPPrepareMessage(t, message)
	return runnerstore.V2RecordEventInput{Message: message, ExactBytes: []byte(prepared.Body),
		ControlBuildHash: lease.AuthorityRoute.AuthorityBuildHash, Now: time.Now().UTC()}
}

func gs9f2HTTPPrepareMessage(t testing.TB, message authoritycontract.Message) authoritycontract.PreparedMessage {
	t.Helper()
	canonical, err := canonicaljson.Encode(message)
	if err != nil {
		t.Fatal(err)
	}
	decoder := json.NewDecoder(bytes.NewReader(canonical))
	decoder.UseNumber()
	var record map[string]any
	if err := decoder.Decode(&record); err != nil {
		t.Fatal(err)
	}
	prepared, err := authoritycontract.PrepareMessage(gs9f2HTTPPlainJSON(t, record))
	if err != nil {
		t.Fatal(err)
	}
	return prepared
}

func gs9f2HTTPPlainJSON(t testing.TB, value any) any {
	t.Helper()
	switch current := value.(type) {
	case json.Number:
		integer, err := current.Int64()
		if err != nil {
			t.Fatal(err)
		}
		return integer
	case map[string]any:
		normalized := make(map[string]any, len(current))
		for key, item := range current {
			normalized[key] = gs9f2HTTPPlainJSON(t, item)
		}
		return normalized
	case []any:
		for index, item := range current {
			current[index] = gs9f2HTTPPlainJSON(t, item)
		}
		return current
	default:
		return value
	}
}

func gs9f2HTTPSealedPost(t testing.TB, handler http.Handler, token, workspace, path string, body []byte,
	idempotencyKey, fingerprint string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set(runnerapp.HeaderWorkspaceID, workspace)
	request.Header.Set("Idempotency-Key", idempotencyKey)
	request.Header.Set(runnerapp.HeaderRequestFingerprint, fingerprint)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func gs9f2HTTPRecord(t testing.TB, value any) runnerbindingcontract.Record {
	t.Helper()
	switch record := value.(type) {
	case runnerbindingcontract.Record:
		return record
	case map[string]any:
		return runnerbindingcontract.Record(record)
	default:
		t.Fatalf("GS9-F2 HTTP binding value is %T", value)
		return nil
	}
}

func gs9f2HTTPCanonicalHash(t testing.TB, value any) string {
	t.Helper()
	canonical, err := canonicaljson.Encode(gs9f2HTTPNormalize(t, value))
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(canonical)
	return hex.EncodeToString(digest[:])
}

func gs9f2HTTPNormalize(t testing.TB, value any) any {
	t.Helper()
	switch current := value.(type) {
	case json.Number:
		integer, err := current.Int64()
		if err != nil {
			t.Fatal(err)
		}
		return integer
	case map[string]any:
		normalized := runnerbindingcontract.Record{}
		for key, item := range current {
			normalized[key] = gs9f2HTTPNormalize(t, item)
		}
		return normalized
	case runnerbindingcontract.Record:
		for key, item := range current {
			current[key] = gs9f2HTTPNormalize(t, item)
		}
		return current
	case []any:
		for index, item := range current {
			current[index] = gs9f2HTTPNormalize(t, item)
		}
		return current
	default:
		return value
	}
}
