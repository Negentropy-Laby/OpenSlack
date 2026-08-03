package testsupport

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	governance "github.com/Negentropy-Laby/OpenSlack/services/governance-control"
	"github.com/Negentropy-Laby/OpenSlack/services/governance-control/internal/authoritystore"
	"github.com/Negentropy-Laby/OpenSlack/services/governance-control/internal/canonicaljson"
	"github.com/Negentropy-Laby/OpenSlack/services/governance-control/internal/shadowstore"
)

const (
	WorkspaceID = "workspace.demo"
	PlanID      = "GPLAN-123e4567-e89b-42d3-a456-426614174000"
)

func PendingObservation(t testing.TB, sourceSequence int64) (shadowstore.PreparedObservation, shadowstore.ObserveInput) {
	return PendingObservationExpected(t, sourceSequence, 0)
}

func AuthorityRequest(t testing.TB, operation authoritystore.Operation, recordID string, expectedRevision, routingEpoch int64) (authoritystore.PreparedRequest, authoritystore.MutateInput) {
	return AuthorityRequestForPlan(t, operation, recordID, expectedRevision, routingEpoch, PlanID, "")
}

func AuthorityRequestForPlan(t testing.TB, operation authoritystore.Operation, recordID string, expectedRevision, routingEpoch int64, planID, updatedAt string) (authoritystore.PreparedRequest, authoritystore.MutateInput) {
	t.Helper()
	record := GoldenRecord(t, recordID)
	recordObject := parseObject(t, record)
	recordObject["planId"] = planID
	if operation == authoritystore.OperationExpire && updatedAt == "" {
		updatedAt, _ = recordObject["expiresAt"].(string)
	}
	if updatedAt != "" {
		recordObject["updatedAt"] = updatedAt
	}
	schema := authoritystore.TransitionSchema
	if operation == authoritystore.OperationAccept {
		schema = authoritystore.AcceptSchema
	}
	bodyObject := canonicaljson.Object{
		"schema": schema, "operation": string(operation), "workspaceId": WorkspaceID, "planId": planID,
		"expectedRevision": float64(expectedRevision),
		"route":            canonicaljson.Object{"backend": authoritystore.Backend, "authority": authoritystore.Authority, "routingEpoch": float64(routingEpoch)},
		"record":           recordObject,
	}
	body, err := canonicaljson.Encode(bodyObject)
	if err != nil {
		t.Fatal(err)
	}
	body = append(body, '\n')
	const caller = "typescript:qoder-mcp"
	const build = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	prepared, err := authoritystore.PrepareRequest(body, caller, WorkspaceID, fmt.Sprint(routingEpoch), build)
	if err != nil {
		t.Fatal(err)
	}
	path := authoritystore.RequestPath(operation, planID)
	fingerprint := authoritystore.RequestFingerprint("POST", path, prepared)
	return prepared, authoritystore.MutateInput{Prepared: prepared,
		IdempotencyKey: authoritystore.ExpectedIdempotencyKey(body), RequestFingerprint: fingerprint, ServiceBuildSHA: build}
}

func AuthorityAudit(t testing.TB, eventType string, state governance.State, revision, routingEpoch int64) (authoritystore.PreparedAudit, authoritystore.AuditInput) {
	return AuthorityAuditForPlan(t, eventType, state, revision, routingEpoch, PlanID)
}

func AuthorityAuditForPlan(t testing.TB, eventType string, state governance.State, revision, routingEpoch int64, planID string) (authoritystore.PreparedAudit, authoritystore.AuditInput) {
	t.Helper()
	value := canonicaljson.Object{
		"schema": "openslack.governed_plan_audit.v1", "eventId": fmt.Sprintf("audit:authority:%d", revision),
		"type": eventType, "occurredAt": "2026-08-02T06:00:00.000Z", "planId": planID,
		"kind": "scenario.instantiate", "actorId": "qoder.local", "workspaceId": WorkspaceID,
		"correlationId": "CORR-123e4567-e89b-42d3-a456-426614174000", "state": string(state),
		"revision": float64(revision), "evidenceRefs": canonicaljson.Array{},
	}
	if eventType == "plan.previewed" {
		record, err := governance.ValidateCanonicalRecordBytes(GoldenRecord(t, "pending-record-validation-and-read-model"))
		if err != nil {
			t.Fatal(err)
		}
		projection, err := governance.Project(record)
		if err != nil {
			t.Fatal(err)
		}
		value["details"] = canonicaljson.Object{"planHash": projection.PlanHash, "actionCount": float64(projection.ActionCount), "effectCount": float64(projection.EffectCount)}
	} else if eventType == "plan.confirmed" {
		value["details"] = canonicaljson.Object{"executionId": "GEXEC-123e4567-e89b-42d3-a456-426614174000"}
	}
	body, err := canonicaljson.Encode(value)
	if err != nil {
		t.Fatal(err)
	}
	body = append(body, '\n')
	const caller = "typescript:qoder-mcp"
	const build = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	prepared, err := authoritystore.PrepareAudit(body, caller, WorkspaceID, planID, fmt.Sprint(revision), fmt.Sprint(routingEpoch), build)
	if err != nil {
		t.Fatal(err)
	}
	path := authoritystore.AuditRequestPath(planID, revision)
	return prepared, authoritystore.AuditInput{Prepared: prepared, IdempotencyKey: authoritystore.ExpectedAuditIdempotencyKey(body),
		RequestFingerprint: authoritystore.AuditRequestFingerprint("POST", path, prepared), ServiceBuildSHA: build}
}

func PendingObservationExpected(t testing.TB, sourceSequence, expectedRevision int64) (shadowstore.PreparedObservation, shadowstore.ObserveInput) {
	t.Helper()
	record := GoldenRecord(t, "pending-record-validation-and-read-model")
	recordObject := parseObject(t, record)
	envelope := canonicaljson.Object{
		"schema": shadowstore.ObservationSchema, "authority": shadowstore.Authority,
		"source":      canonicaljson.Object{"workspaceId": WorkspaceID, "planId": PlanID, "sourceSequence": float64(sourceSequence)},
		"observation": canonicaljson.Object{"kind": "record", "expectedRevision": float64(expectedRevision), "record": recordObject},
	}
	body, err := canonicaljson.Encode(envelope)
	if err != nil {
		t.Fatal(err)
	}
	body = append(body, '\n')
	prepared, err := shadowstore.PrepareObservation(body)
	if err != nil {
		t.Fatal(err)
	}
	input := shadowstore.ObserveInput{IdempotencyKey: shadowstore.ExpectedIdempotencyKey(prepared), RequestFingerprint: shadowstore.RequestFingerprint(prepared), ExactBody: body}
	return prepared, input
}

func GoldenRecord(t testing.TB, id string) []byte {
	t.Helper()
	_, filename, _, _ := runtime.Caller(0)
	path := filepath.Join(filepath.Dir(filename), "..", "contractmirror", "generated", "v1", "golden-vectors.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		Cases []struct {
			ID       string `json:"id"`
			Expected struct {
				CanonicalRecord string `json:"canonicalRecord"`
			} `json:"expected"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &file); err != nil {
		t.Fatal(err)
	}
	for _, item := range file.Cases {
		if item.ID == id {
			return []byte(item.Expected.CanonicalRecord)
		}
	}
	t.Fatalf("golden record %q not found", id)
	return nil
}

func parseObject(t testing.TB, raw []byte) canonicaljson.Object {
	t.Helper()
	value, err := canonicaljson.Parse(raw, canonicaljson.Limits{MaxDepth: 20, MaxNodes: 20000, MaxStringLength: governance.MaxStringBytes})
	if err != nil {
		t.Fatal(err)
	}
	object, ok := value.(canonicaljson.Object)
	if !ok {
		t.Fatal("record is not object")
	}
	return object
}
