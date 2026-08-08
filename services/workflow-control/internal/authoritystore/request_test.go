package authoritystore

import (
	"strings"
	"testing"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/authoritycontract"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/canonicaljson"
)

func TestPrepareRequestBindsCanonicalAccept(t *testing.T) {
	envelope := testEnvelope(OperationAccept, nil, authoritycontract.RunCreated, 0)
	body := testCanonicalBody(t, envelope)
	prepared, err := PrepareRequest(body, "caller-test", envelope.WorkspaceID, "7", strings.Repeat("d", 64))
	if err != nil {
		t.Fatalf("prepare accept: %v", err)
	}
	if prepared.Envelope.Operation != OperationAccept || prepared.RecordHash == "" || prepared.RequestHash == "" ||
		ExpectedIdempotencyKey(body) == "" || RequestFingerprint("POST", RequestPath(OperationAccept, envelope.RunID), prepared) == "" {
		t.Fatalf("unexpected prepared request: %#v", prepared)
	}
}

func TestPrepareRequestRejectsNonCanonicalAndInvalidTransition(t *testing.T) {
	envelope := testEnvelope(OperationAccept, nil, authoritycontract.RunCreated, 0)
	body := testCanonicalBody(t, envelope)
	if _, err := PrepareRequest(body[:len(body)-1], "caller-test", envelope.WorkspaceID, "7", strings.Repeat("d", 64)); !IsCode(err, ErrorContentInvalid) {
		t.Fatalf("non-canonical body err=%v", err)
	}

	from := authoritycontract.RunCompleted
	invalid := testEnvelope(OperationTransition, &from, authoritycontract.RunRunning, 1)
	if _, err := PrepareRequest(testCanonicalBody(t, invalid), "caller-test", invalid.WorkspaceID, "7", strings.Repeat("d", 64)); !IsCode(err, ErrorConflict) {
		t.Fatalf("invalid transition err=%v", err)
	}
	created := authoritycontract.RunCreated
	skipped := testEnvelope(OperationTransition, &created, authoritycontract.RunCompleted, 1)
	if _, err := PrepareRequest(testCanonicalBody(t, skipped), "caller-test", skipped.WorkspaceID, "7", strings.Repeat("d", 64)); !IsCode(err, ErrorConflict) {
		t.Fatalf("created-to-completed transition err=%v", err)
	}
}

func testEnvelope(operation Operation, from *RunState, to RunState, expectedRevision int64) RequestEnvelope {
	route := Route{Backend: Backend, Authority: Authority, RoutingEpoch: 7, AuthorityBuildHash: strings.Repeat("d", 64)}
	return RequestEnvelope{
		Schema: schemaForTest(operation), Operation: operation, WorkspaceID: "workspace-test", RunID: "run-test",
		Expected: ExpectedBinding{Revision: expectedRevision, State: from, ResumeGeneration: 0},
		Route:    route, CorrelationID: "correlation-test",
		Record: RunRecord{
			Schema: RunRecordSchema, WorkspaceID: "workspace-test", RunID: "run-test",
			WorkflowID: "workflow-test", WorkflowVersion: "1.0.0",
			WorkflowSourceHash: strings.Repeat("a", 64), ManifestHash: strings.Repeat("b", 64),
			InputHash: strings.Repeat("c", 64), Route: route, State: to,
			Revision: expectedRevision + 1, ResumeGeneration: 0,
		},
	}
}

func schemaForTest(operation Operation) string {
	if operation == OperationAccept {
		return AcceptSchema
	}
	return TransitionSchema
}

func testCanonicalBody(t testing.TB, envelope RequestEnvelope) []byte {
	t.Helper()
	body, err := canonicaljson.Encode(envelope)
	if err != nil {
		t.Fatal(err)
	}
	return append(body, '\n')
}
