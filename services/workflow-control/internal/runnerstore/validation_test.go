package runnerstore

import (
	"bytes"
	"testing"
	"time"
)

func validSpec() JobSpec {
	return JobSpec{
		Schema: JobSpecSchema, WorkspaceID: "workspace-1", JobID: "job-1",
		WorkflowRunID: "run-1", CorrelationID: "correlation-1",
		ExecutionDescriptorRef: "descriptor-1", ExecutionDescriptorHash: repeated("a"),
		WorkflowID: "workflow-1", WorkflowVersion: "1.0.0", WorkflowSourceHash: repeated("b"),
		ManifestHash: repeated("c"), InputHash: repeated("d"), WholeTimeoutMS: 60_000,
		SubmittedAt: "2026-08-04T00:00:00.000Z",
	}
}

func repeated(value string) string { return string(bytes.Repeat([]byte(value), 64)) }

func TestPrepareJobSpecFreezesCanonicalFullHashBindings(t *testing.T) {
	prepared, err := PrepareJobSpec(validSpec())
	if err != nil {
		t.Fatal(err)
	}
	if len(prepared.JobSpecHash) != 64 || len(prepared.ExactBody) == 0 {
		t.Fatalf("unexpected prepared specification: %+v", prepared)
	}
	parsed, err := ParseJobSpec(prepared.ExactBody)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.JobSpecHash != prepared.JobSpecHash || !bytes.Equal(parsed.ExactBody, prepared.ExactBody) {
		t.Fatal("job specification did not round-trip exact canonical bytes")
	}
	key, fingerprint := SubmissionBindings(prepared)
	if err := ValidateSubmitInput(SubmitInput{Prepared: prepared, IdempotencyKey: key, RequestFingerprint: fingerprint}); err != nil {
		t.Fatal(err)
	}
	conflict := SubmitInput{Prepared: prepared, IdempotencyKey: key, RequestFingerprint: "sha256:" + repeated("e")}
	if err := ValidateSubmitInput(conflict); !IsCode(err, ErrorHashMismatch) {
		t.Fatalf("wrong fingerprint = %v", err)
	}
}

func TestJobSpecRejectsExecutableAndGS9Fields(t *testing.T) {
	prepared, err := PrepareJobSpec(validSpec())
	if err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"command", "modulePath", "args", "approvalDecision", "budget", "checkpoint", "resumeCursor"} {
		body := append([]byte(nil), prepared.ExactBody[:len(prepared.ExactBody)-1]...)
		body = append(body, []byte(`,"`+field+`":"forbidden"}`)...)
		if _, err := ParseJobSpec(body); !IsCode(err, ErrorInputInvalid) {
			t.Fatalf("field %s was not rejected: %v", field, err)
		}
	}
}

func TestJobSpecLimitsAndCanonicalTimestamp(t *testing.T) {
	value := validSpec()
	value.WholeTimeoutMS = MaxWholeTimeout.Milliseconds() + 1
	if _, err := PrepareJobSpec(value); !IsCode(err, ErrorLimitExceeded) {
		t.Fatalf("timeout = %v", err)
	}
	if got := CanonicalTimestamp(time.Date(2026, 8, 4, 1, 2, 3, 999999999, time.FixedZone("offset", 3600))); got != "2026-08-04T00:02:03.999Z" {
		t.Fatalf("timestamp = %s", got)
	}
}
