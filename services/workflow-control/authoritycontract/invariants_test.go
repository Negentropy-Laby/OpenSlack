package authoritycontract

import (
	"errors"
	"testing"
)

func TestClosedDecodersRejectUnknownFields(t *testing.T) {
	vectors := loadGoldenVectors(t)
	state := mustStrictObject(t, vectors.Positive.State)
	state["futureAuthority"] = true
	assertContractFailure(t, func() error {
		_, err := ValidateState(state)
		return err
	}(), ErrorUnknownField, "$/futureAuthority")

	message := goldenMessageObject(t, KindHeartbeat)
	message["futureAuthority"] = true
	assertContractFailure(t, func() error {
		_, err := ValidateMessage(message)
		return err
	}(), ErrorUnknownField, "$/futureAuthority")

	var receiptObject map[string]any
	receiptObject = mustStrictObject(t, vectors.Positive.Receipts[0])
	receiptObject["futureAuthority"] = true
	assertContractFailure(t, func() error {
		_, err := ValidateReceipt(receiptObject)
		return err
	}(), ErrorUnknownField, "$/futureAuthority")
}

func TestHandshakeBoundsAndClosedCapabilityVocabulary(t *testing.T) {
	base := goldenMessageObject(t, KindHello)
	tests := []struct {
		name string
		edit func(*testing.T, map[string]any)
		code ErrorCode
		path string
	}{
		{"runtime", func(t *testing.T, message map[string]any) {
			mustObjectField(t, message, "payload")["runtimeName"] = "python"
		}, ErrorInvalid, "$/payload/runtimeName"},
		{"semver", func(t *testing.T, message map[string]any) {
			mustObjectField(t, message, "payload")["runtimeVersion"] = "latest"
		}, ErrorInvalid, "$/payload/runtimeVersion"},
		{"capability-unknown", func(t *testing.T, message map[string]any) {
			mustObjectField(t, message, "payload")["capabilities"] = []any{"shell"}
		}, ErrorInvalid, "$/payload/capabilities"},
		{"capability-duplicate", func(t *testing.T, message map[string]any) {
			mustObjectField(t, message, "payload")["capabilities"] = []any{"cancel_ack", "cancel_ack"}
		}, ErrorInvalid, "$/payload/capabilities"},
		{"concurrency", func(t *testing.T, message map[string]any) {
			mustObjectField(t, message, "payload")["maxConcurrentJobs"] = int64(1_025)
		}, ErrorLimitExceeded, "$/payload/maxConcurrentJobs"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			message := cloneObject(t, base)
			test.edit(t, message)
			_, err := ValidateMessage(message)
			assertContractFailure(t, err, test.code, test.path)
		})
	}

	helloAck := cloneObject(t, base)
	helloAck["kind"] = string(KindHelloAck)
	helloAck["eventId"] = "event-hello_ack"
	helloAck["payload"] = map[string]any{
		"controlBuildHash":        "44575cf5b28512d75644bf54a517dcef304ff809fd511747621b4d64f19aac66",
		"selectedProtocolVersion": ProtocolVersion,
		"heartbeatIntervalMs":     int64(250),
		"leaseOfferTimeoutMs":     int64(1),
	}
	if _, err := ValidateMessage(helloAck); err != nil {
		t.Fatalf("minimum handshake timing should pass: %v", err)
	}
	for _, test := range []struct {
		field string
		value int64
		code  ErrorCode
		path  string
	}{
		{"heartbeatIntervalMs", 249, ErrorInvalid, "$/payload/heartbeatIntervalMs"},
		{"heartbeatIntervalMs", 300_001, ErrorLimitExceeded, "$/payload"},
		{"leaseOfferTimeoutMs", 0, ErrorInvalid, "$/payload/leaseOfferTimeoutMs"},
		{"leaseOfferTimeoutMs", 86_400_001, ErrorLimitExceeded, "$/payload"},
	} {
		message := cloneObject(t, helloAck)
		mustObjectField(t, message, "payload")[test.field] = test.value
		_, err := ValidateMessage(message)
		assertContractFailure(t, err, test.code, test.path)
	}
}

func TestCrossFieldAuthorityBindingsFailClosed(t *testing.T) {
	state := mustStrictObject(t, loadGoldenVectors(t).Positive.State)
	state["resumeGeneration"] = int64(2)
	if _, err := ValidateState(state); err != nil {
		t.Fatalf("a resumed run must retain the last checkpoint from an older generation: %v", err)
	}
	mustObjectField(t, state, "checkpointHead")["resumeGeneration"] = int64(3)
	_, err := ValidateState(state)
	assertContractFailure(t, err, ErrorStaleRevision, "$/checkpointHead")

	effect := goldenMessageObject(t, KindEffectAuthorization)
	mustObjectField(t, effect, "payload")["expiresAt"] = effect["sentAt"]
	_, err = ValidateMessage(effect)
	assertContractFailure(t, err, ErrorInvalid, "$/payload/expiresAt")

	resume := goldenMessageObject(t, KindResumeOffer)
	mustObjectField(t, resume, "payload")["newResumeGeneration"] = resume["resumeGeneration"]
	_, err = ValidateMessage(resume)
	assertContractFailure(t, err, ErrorStaleResumeGeneration, "$/payload/newResumeGeneration")

	resume = goldenMessageObject(t, KindResumeOffer)
	mustObjectField(t, resume, "payload")["newAttemptId"] = resume["attemptId"]
	_, err = ValidateMessage(resume)
	assertContractFailure(t, err, ErrorIdentityMismatch, "$/payload/newAttemptId")

	budget := goldenMessageObject(t, KindBudgetAuthorization)
	budgetPayload := mustObjectField(t, budget, "payload")
	runnerRevision := mustInt64Field(t, budget, "runRevision")
	if _, err = ValidateMessage(budget); err != nil {
		t.Fatalf("golden budget authorization must validate: %v", err)
	}
	equalPlanes := cloneObject(t, budget)
	mustObjectField(t, equalPlanes, "payload")["committedRunRevision"] = runnerRevision
	if _, err = ValidateMessage(equalPlanes); err != nil {
		t.Fatalf("equal budget and runner revisions must validate: %v", err)
	}
	unequalPlanes := cloneObject(t, budget)
	mustObjectField(t, unequalPlanes, "payload")["committedRunRevision"] = runnerRevision + 1
	if _, err = ValidateMessage(unequalPlanes); err != nil {
		t.Fatalf("unequal budget and runner revisions must validate: %v", err)
	}

	budgetPayload["status"] = "rejected"
	_, err = ValidateMessage(budget)
	assertContractFailure(t, err, ErrorInvalid, "$/payload")

	receipt := goldenMessageObject(t, KindHeartbeat)
	receipt["kind"] = string(KindEventReceipt)
	receipt["eventId"] = "event-receipt"
	receipt["payload"] = map[string]any{
		"receivedEventId":        "event-heartbeat",
		"receivedKind":           string(KindHeartbeat),
		"receivedSequence":       int64(11),
		"receivedDigest":         "219289a2a39de6ab43b74a2a4d5861a7fcee67ea711a0651769313f4b1c97578",
		"receivedIdempotencyKey": IdempotencyPrefix + "219289a2a39de6ab43b74a2a4d5861a7fcee67ea711a0651769313f4b1c97578",
		"receivedFingerprint":    "sha256:c055200844e9bde1e065e4a1a05e83cc37ec34fb52b6544d7ed02b691a040a2f",
		"status":                 string(ReceiptAccepted),
		"controlBuildHash":       "44575cf5b28512d75644bf54a517dcef304ff809fd511747621b4d64f19aac66",
		"committedAt":            "2026-08-04T03:01:01.000Z",
		"errorCode":              nil,
	}
	_, err = ValidateMessage(receipt)
	assertContractFailure(t, err, ErrorIdentityMismatch, "$/payload/committedAt")
}

func goldenMessageObject(t *testing.T, kind Kind) map[string]any {
	t.Helper()
	for _, vector := range loadGoldenVectors(t).Positive.Messages {
		if vector.Kind == string(kind) {
			return mustStrictObject(t, vector.Input)
		}
	}
	t.Fatalf("missing golden message %s", kind)
	return nil
}

func mustStrictObject(t *testing.T, input []byte) map[string]any {
	t.Helper()
	value, err := parseStrictJSON(input, MaxJSONDepth, MaxJSONNodes, MaxStringBytes)
	if err != nil {
		t.Fatal(err)
	}
	object, ok := value.(map[string]any)
	if !ok {
		t.Fatal("value is not an object")
	}
	return object
}

func cloneObject(t *testing.T, value map[string]any) map[string]any {
	t.Helper()
	encoded, err := CanonicalJSON(value)
	if err != nil {
		t.Fatal(err)
	}
	return mustStrictObject(t, encoded)
}

func mustObjectField(t *testing.T, value map[string]any, key string) map[string]any {
	t.Helper()
	field, ok := value[key].(map[string]any)
	if !ok {
		t.Fatalf("%s is not an object", key)
	}
	return field
}

func mustInt64Field(t *testing.T, value map[string]any, key string) int64 {
	t.Helper()
	field, ok := value[key].(int64)
	if !ok {
		t.Fatalf("%s is not an int64", key)
	}
	return field
}

func assertContractFailure(t *testing.T, err error, code ErrorCode, path string) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected %s at %s", code, path)
	}
	var contractError *ContractError
	if !errors.As(err, &contractError) {
		t.Fatalf("expected ContractError, got %T %v", err, err)
	}
	if contractError.Code != code || contractError.Path != path {
		t.Fatalf("unexpected failure: got %s at %s, want %s at %s", contractError.Code, contractError.Path, code, path)
	}
}
