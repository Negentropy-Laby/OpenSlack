package testsupport

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	governance "github.com/Negentropy-Laby/OpenSlack/services/governance-control"
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
