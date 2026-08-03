package shadowstore

import (
	"strings"
	"testing"

	workflowcontrol "github.com/Negentropy-Laby/OpenSlack/services/workflow-control"
)

func TestPrepareObservationBindsExactBytesKeyAndFingerprint(t *testing.T) {
	envelope := testEnvelope(t, 1, workflowcontrol.RunRunning)
	body, err := workflowcontrol.CanonicalShadowEnvelopeBytes(envelope)
	if err != nil {
		t.Fatal(err)
	}
	prepared, err := PrepareObservation(body)
	if err != nil {
		t.Fatal(err)
	}
	key := ExpectedIdempotencyKey(prepared)
	if !strings.HasPrefix(key, "openslack.workflow-control-shadow.v1.") {
		t.Fatalf("unexpected idempotency key: %s", key)
	}
	if err := ValidateObservationIdempotencyKey(prepared, key); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(RequestFingerprint(prepared), "sha256:") {
		t.Fatal("request fingerprint is not a sha256 binding")
	}
	if _, err := PrepareObservation(body[:len(body)-1]); err == nil {
		t.Fatal("expected missing canonical LF to fail")
	}
}

func TestEvaluateRecordsProjectionAndTransitionMismatches(t *testing.T) {
	first := preparedEnvelope(t, testEnvelope(t, 1, workflowcontrol.RunRunning))
	initial := Evaluate(first, nil)
	if initial.Parity != ParityMatched || initial.ObservationHash == "" || len(initial.ProjectionBytes) == 0 {
		t.Fatalf("unexpected initial evaluation: %+v", initial)
	}

	paused := preparedEnvelope(t, testEnvelope(t, 2, workflowcontrol.RunPaused))
	valid := Evaluate(paused, first.ExactBody)
	if valid.Parity != ParityMatched {
		t.Fatalf("expected running -> paused to match: %+v", valid)
	}

	invalid := testEnvelope(t, 2, workflowcontrol.RunCompleted)
	invalid.Observation.UpdatedAt = "2026-08-03T00:00:02.000Z"
	invalid.Projection, _ = workflowcontrol.ProjectReadModel(invalid.Observation)
	completed := preparedEnvelope(t, invalid)
	backToRunning := testEnvelope(t, 3, workflowcontrol.RunRunning)
	backToRunning.Observation.UpdatedAt = "2026-08-03T00:00:03.000Z"
	backToRunning.Projection, _ = workflowcontrol.ProjectReadModel(backToRunning.Observation)
	transition := Evaluate(preparedEnvelope(t, backToRunning), completed.ExactBody)
	if transition.Parity != ParityMismatched || transition.MismatchCode != "transition_invalid" {
		t.Fatalf("expected transition mismatch: %+v", transition)
	}

	drift := testEnvelope(t, 2, workflowcontrol.RunRunning)
	drift.Projection.Status = workflowcontrol.RunPaused
	projection := Evaluate(preparedEnvelope(t, drift), first.ExactBody)
	if projection.Parity != ParityMismatched || projection.MismatchCode != "projection_mismatch" {
		t.Fatalf("expected projection mismatch: %+v", projection)
	}
}

func preparedEnvelope(t *testing.T, envelope workflowcontrol.ShadowEnvelope) PreparedObservation {
	t.Helper()
	body, err := workflowcontrol.CanonicalShadowEnvelopeBytes(envelope)
	if err != nil {
		t.Fatal(err)
	}
	prepared, err := PrepareObservation(body)
	if err != nil {
		t.Fatal(err)
	}
	return prepared
}

func testEnvelope(t *testing.T, sequence int64, status workflowcontrol.RunState) workflowcontrol.ShadowEnvelope {
	t.Helper()
	observation := workflowcontrol.Observation{
		Schema:       workflowcontrol.ObservationSchema,
		Authority:    workflowcontrol.Authority,
		RunID:        "run-test",
		WorkflowName: "workflow.test",
		Mode:         workflowcontrol.ModeExecute,
		Status:       status,
		StartedAt:    "2026-08-03T00:00:00.000Z",
		UpdatedAt:    "2026-08-03T00:00:01.000Z",
		ManifestHash: strings.Repeat("a", 64),
		Phases:       []workflowcontrol.PhaseObservation{},
		Approvals: workflowcontrol.ApprovalObservation{
			LegacyRunGate: workflowcontrol.LegacyRunGateApproval{Plane: "legacy-run-gate", Semantics: "run-gate-only", Counts: workflowcontrol.ApprovalCounts{}},
			EffectV2:      workflowcontrol.EffectApprovalSummary{Plane: "workflow-effect-v2", Semantics: "effect-decision-only", Schema: workflowcontrol.EffectSchema, Counts: workflowcontrol.ApprovalCounts{}},
		},
		Budget: workflowcontrol.BudgetObservation{Configured: false, Warnings: []workflowcontrol.BudgetWarning{}},
	}
	projection, err := workflowcontrol.ProjectReadModel(observation)
	if err != nil {
		t.Fatal(err)
	}
	return workflowcontrol.ShadowEnvelope{
		Authority:   workflowcontrol.Authority,
		Observation: observation,
		Projection:  projection,
		Schema:      workflowcontrol.ShadowObservationSchema,
		Source:      workflowcontrol.ShadowSource{RunID: observation.RunID, SourceSequence: sequence, WorkspaceID: "workspace-test"},
	}
}
