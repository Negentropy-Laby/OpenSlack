package shadowstore

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"

	governance "github.com/Negentropy-Laby/OpenSlack/services/governance-control"
	"github.com/Negentropy-Laby/OpenSlack/services/governance-control/internal/canonicaljson"
)

func goldenRecord(t *testing.T, id string) []byte {
	t.Helper()
	raw, err := os.ReadFile("../contractmirror/generated/v1/golden-vectors.json")
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

func objectFromBytes(t *testing.T, raw []byte) canonicaljson.Object {
	t.Helper()
	value, err := canonicaljson.Parse(raw, canonicaljson.Limits{MaxDepth: 20, MaxNodes: 20000, MaxStringLength: governance.MaxStringBytes})
	if err != nil {
		t.Fatal(err)
	}
	object, ok := value.(canonicaljson.Object)
	if !ok {
		t.Fatal("value is not object")
	}
	return object
}

func exactEnvelope(t *testing.T, sequence int64, observation canonicaljson.Object) []byte {
	t.Helper()
	value := canonicaljson.Object{
		"schema": ObservationSchema, "authority": Authority,
		"source":      canonicaljson.Object{"workspaceId": "workspace.demo", "planId": "GPLAN-123e4567-e89b-42d3-a456-426614174000", "sourceSequence": float64(sequence)},
		"observation": observation,
	}
	encoded, err := canonicaljson.Encode(value)
	if err != nil {
		t.Fatal(err)
	}
	return append(encoded, '\n')
}

func recordObservation(t *testing.T, sequence, expected int64, record []byte) PreparedObservation {
	t.Helper()
	prepared, err := PrepareObservation(exactEnvelope(t, sequence, canonicaljson.Object{
		"kind": "record", "expectedRevision": float64(expected), "record": objectFromBytes(t, record),
	}))
	if err != nil {
		t.Fatal(err)
	}
	return prepared
}

func TestRecordTransitionRecomputation(t *testing.T) {
	pending := goldenRecord(t, "pending-record-validation-and-read-model")
	executing := goldenRecord(t, "executing-record-validation-and-read-model")
	succeeded := goldenRecord(t, "succeeded-record-validation-and-read-model")
	if result := EvaluateRecord(recordObservation(t, 1, 0, pending), nil); result.Parity != ParityMatched {
		t.Fatalf("pending = %+v", result)
	}
	if result := EvaluateRecord(recordObservation(t, 2, 1, executing), pending); result.Parity != ParityMatched {
		t.Fatalf("executing = %+v", result)
	}
	if result := EvaluateRecord(recordObservation(t, 3, 2, succeeded), executing); result.Parity != ParityMatched {
		t.Fatalf("succeeded = %+v", result)
	}

	drifted := objectFromBytes(t, succeeded)
	execution := drifted["execution"].(canonicaljson.Object)
	execution["executionId"] = "GEXEC-223e4567-e89b-42d3-a456-426614174000"
	encoded, err := canonicaljson.Encode(drifted)
	if err != nil {
		t.Fatal(err)
	}
	result := EvaluateRecord(recordObservation(t, 4, 2, append(encoded, '\n')), executing)
	if result.Parity != ParityMismatched || result.MismatchCode != "record_execution_binding_drift" {
		t.Fatalf("execution drift = %+v", result)
	}
}

func TestConfirmationAuthorityCanDifferAndBindingsPresenceIsClosed(t *testing.T) {
	record := goldenRecord(t, "pending-record-validation-and-read-model")
	wrongHash := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	rejected, err := PrepareObservation(exactEnvelope(t, 2, canonicaljson.Object{
		"kind": "confirmation", "attemptId": "GCONF-123e4567-e89b-42d3-a456-426614174001", "recordRevision": float64(1),
		"attemptedAt": "2026-08-02T06:01:00.000Z", "actorId": "other.actor", "workspaceId": "other.workspace",
		"presentedTokenHash": wrongHash, "authorityOutcome": "confirmation_rejected",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if result := EvaluateConfirmation(rejected, record); result.Parity != ParityMatched {
		t.Fatalf("rejected = %+v", result)
	}

	eligible, err := PrepareObservation(exactEnvelope(t, 3, canonicaljson.Object{
		"kind": "confirmation", "attemptId": "GCONF-123e4567-e89b-42d3-a456-426614174002", "recordRevision": float64(1),
		"attemptedAt": "2026-08-02T06:01:00.000Z", "actorId": "qoder.local", "workspaceId": "workspace.demo",
		"presentedTokenHash": "f3bb471d1de53f67d0130236e4c9ab39b257567bc37b0a678a7772267333ebfe", "authorityOutcome": "claim_eligible",
	}))
	if err == nil {
		t.Fatalf("eligible without bindings prepared: %+v", eligible)
	}

	withUnexpectedBindings := canonicaljson.Object{
		"kind": "confirmation", "attemptId": "GCONF-123e4567-e89b-42d3-a456-426614174003", "recordRevision": float64(1),
		"attemptedAt": "2026-08-02T06:01:00.000Z", "actorId": "other.actor", "workspaceId": "other.workspace",
		"presentedTokenHash": wrongHash, "authorityOutcome": "confirmation_rejected",
		"currentBindings": canonicaljson.Object{
			"sourceVersionHash": wrongHash, "permissionSnapshotHash": wrongHash, "actionCatalogHash": wrongHash,
			"executorBindingHash": wrongHash, "buildNonceHash": wrongHash, "processNonceHash": wrongHash,
		},
	}
	if _, err := PrepareObservation(exactEnvelope(t, 4, withUnexpectedBindings)); err == nil {
		t.Fatal("confirmation_rejected with bindings prepared")
	}
}

func TestAuditDetailsAreSemanticallyBound(t *testing.T) {
	record := goldenRecord(t, "pending-record-validation-and-read-model")
	digest := sha256.Sum256(record)
	event := canonicaljson.Object{
		"schema": "openslack.governed_plan_audit.v1", "eventId": "GAUDIT-123e4567-e89b-42d3-a456-426614174000", "type": "plan.previewed",
		"occurredAt": "2026-08-02T06:00:00.001Z", "planId": "GPLAN-123e4567-e89b-42d3-a456-426614174000", "kind": "scenario.instantiate",
		"actorId": "qoder.local", "workspaceId": "workspace.demo", "correlationId": "CORR-123e4567-e89b-42d3-a456-426614174000",
		"state": "pending", "revision": float64(1), "evidenceRefs": canonicaljson.Array{},
		"details": canonicaljson.Object{"planHash": "7085340e3d93d7944104447321731b0d5e0c71a72873fc737a50023e93432000", "actionCount": float64(1), "effectCount": float64(1)},
	}
	prepare := func() PreparedObservation {
		value, err := PrepareObservation(exactEnvelope(t, 2, canonicaljson.Object{
			"kind": "audit", "recordRevision": float64(1), "recordHash": hex.EncodeToString(digest[:]), "event": event,
		}))
		if err != nil {
			t.Fatal(err)
		}
		return value
	}
	if result := EvaluateAudit(prepare(), record); result.Parity != ParityMatched {
		t.Fatalf("audit = %+v", result)
	}
	event["details"].(canonicaljson.Object)["actionCount"] = float64(2)
	if result := EvaluateAudit(prepare(), record); result.Parity != ParityMismatched {
		t.Fatalf("bad audit = %+v", result)
	}
}

func TestAuditRejectsUnexpectedNonObjectDetails(t *testing.T) {
	record := goldenRecord(t, "pending-record-validation-and-read-model")
	digest := sha256.Sum256(record)
	event := canonicaljson.Object{
		"schema": "openslack.governed_plan_audit.v1", "eventId": "GAUDIT-123e4567-e89b-42d3-a456-426614174000", "type": "plan.cancelled",
		"occurredAt": "2026-08-02T06:00:00.001Z", "planId": "GPLAN-123e4567-e89b-42d3-a456-426614174000", "kind": "scenario.instantiate",
		"actorId": "qoder.local", "workspaceId": "workspace.demo", "correlationId": "CORR-123e4567-e89b-42d3-a456-426614174000",
		"state": "pending", "revision": float64(1), "evidenceRefs": canonicaljson.Array{}, "details": "unexpected",
	}
	prepared, err := PrepareObservation(exactEnvelope(t, 2, canonicaljson.Object{
		"kind": "audit", "recordRevision": float64(1), "recordHash": hex.EncodeToString(digest[:]), "event": event,
	}))
	if err != nil {
		t.Fatal(err)
	}
	if result := EvaluateAudit(prepared, record); result.Parity != ParityMismatched {
		t.Fatalf("unexpected details = %+v", result)
	}
}

func TestECMAScriptTimestampNormalization(t *testing.T) {
	previous, ok := parseECMAScriptTimestamp("2026-02-31T24:00:00.000Z")
	if !ok {
		t.Fatal("authority-compatible overflow timestamp rejected")
	}
	current, ok := parseECMAScriptTimestamp("2026-03-04T00:00:00.000Z")
	if !ok || !previous.Equal(current) {
		t.Fatalf("normalized timestamps differ: %v %v", previous, current)
	}
	if validTimestamp("2026-01-01T24:00:00.001Z") {
		t.Fatal("invalid 24-hour timestamp accepted")
	}
}

func TestObservationRequiresExactCanonicalBytesAndFingerprintBinding(t *testing.T) {
	record := goldenRecord(t, "pending-record-validation-and-read-model")
	body := exactEnvelope(t, 1, canonicaljson.Object{"kind": "record", "expectedRevision": float64(0), "record": objectFromBytes(t, record)})
	prepared, err := PrepareObservation(body)
	if err != nil {
		t.Fatal(err)
	}
	if RequestFingerprint(prepared) == "" || SourceBinding(prepared.Source) != "typescript/workspace.demo/GPLAN-123e4567-e89b-42d3-a456-426614174000/1" {
		t.Fatal("binding drift")
	}
	if _, err := PrepareObservation(append([]byte(" "), body...)); err == nil {
		t.Fatal("noncanonical observation accepted")
	}
}

func TestProjectionIdentityUsesFrozenBounds(t *testing.T) {
	if err := ValidateProjectionIdentity("workspace.demo", "GPLAN-123e4567-e89b-42d3-a456-426614174000"); err != nil {
		t.Fatal(err)
	}
	for _, invalid := range []struct{ workspace, plan string }{
		{workspace: "workspace demo", plan: "GPLAN-123e4567-e89b-42d3-a456-426614174000"},
		{workspace: "workspace.demo", plan: "GPLAN-123e4567-e89b-12d3-a456-426614174000"},
	} {
		if err := ValidateProjectionIdentity(invalid.workspace, invalid.plan); err == nil {
			t.Fatalf("accepted workspace=%q plan=%q", invalid.workspace, invalid.plan)
		}
	}
}
