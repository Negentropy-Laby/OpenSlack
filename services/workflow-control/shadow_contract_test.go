package workflowcontrol

import (
	"bytes"
	"testing"
)

func TestShadowEnvelopeCanonicalRoundTripAndProjectionParity(t *testing.T) {
	observation := shadowTestObservation()
	projection, err := ProjectReadModel(observation)
	if err != nil {
		t.Fatal(err)
	}
	envelope := ShadowEnvelope{
		Authority:   Authority,
		Observation: observation,
		Projection:  projection,
		Schema:      ShadowObservationSchema,
		Source:      ShadowSource{RunID: observation.RunID, SourceSequence: 1, WorkspaceID: "workspace-test"},
	}
	encoded, err := CanonicalShadowEnvelopeBytes(envelope)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := ValidateCanonicalShadowEnvelopeBytes(encoded)
	if err != nil {
		t.Fatal(err)
	}
	recomputed, matched, err := CompareShadowProjection(decoded)
	if err != nil {
		t.Fatal(err)
	}
	if !matched || !ShadowProjectionEqual(recomputed, projection) {
		t.Fatal("expected exact TypeScript/Go shadow projection parity")
	}
	if !bytes.HasPrefix(encoded, []byte(`{"authority":"typescript","observation":`)) {
		t.Fatalf("unexpected canonical envelope prefix: %s", encoded)
	}
	if encoded[len(encoded)-1] != '\n' {
		t.Fatal("expected one canonical trailing LF")
	}
	if _, err := ValidateCanonicalShadowEnvelopeBytes(encoded[:len(encoded)-1]); err == nil {
		t.Fatal("expected missing canonical trailing LF to be rejected")
	}
}

func TestShadowEnvelopeRecordsProjectionDriftWithoutRejectingShape(t *testing.T) {
	observation := shadowTestObservation()
	projection, err := ProjectReadModel(observation)
	if err != nil {
		t.Fatal(err)
	}
	projection.Status = RunPaused
	envelope := ShadowEnvelope{
		Authority:   Authority,
		Observation: observation,
		Projection:  projection,
		Schema:      ShadowObservationSchema,
		Source:      ShadowSource{RunID: observation.RunID, SourceSequence: 2, WorkspaceID: "workspace-test"},
	}
	encoded, err := CanonicalShadowEnvelopeBytes(envelope)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := ValidateCanonicalShadowEnvelopeBytes(encoded)
	if err != nil {
		t.Fatal(err)
	}
	_, matched, err := CompareShadowProjection(decoded)
	if err != nil {
		t.Fatal(err)
	}
	if matched {
		t.Fatal("expected semantic projection drift to remain a recordable mismatch")
	}
}

func TestShadowEnvelopeRejectsSourceAndSensitiveFieldDrift(t *testing.T) {
	observation := shadowTestObservation()
	projection, err := ProjectReadModel(observation)
	if err != nil {
		t.Fatal(err)
	}
	envelope := ShadowEnvelope{
		Authority:   Authority,
		Observation: observation,
		Projection:  projection,
		Schema:      ShadowObservationSchema,
		Source:      ShadowSource{RunID: "another-run", SourceSequence: 1, WorkspaceID: "workspace-test"},
	}
	if _, err := CanonicalShadowEnvelopeBytes(envelope); err == nil {
		t.Fatal("expected source run binding drift to fail")
	}
	raw := []byte(`{"authority":"typescript","observation":{"token":"forbidden"},"projection":{},"schema":"openslack.workflow_control_shadow_observation.v1","source":{"runId":"run-test","sourceSequence":1,"workspaceId":"workspace-test"}}`)
	if _, err := ValidateShadowEnvelopeJSON(raw); err == nil {
		t.Fatal("expected raw sensitive field to fail")
	}
}

func shadowTestObservation() Observation {
	return Observation{
		Schema:       ObservationSchema,
		Authority:    Authority,
		RunID:        "run-test",
		WorkflowName: "workflow.test",
		Mode:         ModeExecute,
		Status:       RunRunning,
		StartedAt:    "2026-08-03T00:00:00.000Z",
		UpdatedAt:    "2026-08-03T00:00:01.000Z",
		ManifestHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		CurrentPhase: nil,
		Phases:       []PhaseObservation{},
		Approvals: ApprovalObservation{
			LegacyRunGate: LegacyRunGateApproval{Plane: "legacy-run-gate", Semantics: "run-gate-only", Counts: ApprovalCounts{}},
			EffectV2:      EffectApprovalSummary{Plane: "workflow-effect-v2", Semantics: "effect-decision-only", Schema: EffectSchema, Counts: ApprovalCounts{}},
		},
		Budget: BudgetObservation{Configured: false, TokensUsed: 0, AgentCalls: 0, Warnings: []BudgetWarning{}},
	}
}
