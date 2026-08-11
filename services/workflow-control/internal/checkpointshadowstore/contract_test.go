package checkpointshadowstore

import (
	"crypto/sha256"
	"encoding/hex"
	"testing"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/canonicaljson"
)

func TestPrepareObservationAndResumeComparison(t *testing.T) {
	first := testEnvelope(t, 1, OperationCheckpointCommit, 2, 0, 0)
	body, err := canonicaljson.Encode(first)
	if err != nil {
		t.Fatal(err)
	}
	prepared, err := PrepareObservation(body)
	if err != nil {
		t.Fatal(err)
	}
	if prepared.EnvelopeHash == "" {
		t.Fatal("missing envelope hash")
	}
	matched := int64(1)
	head := &Head{SourceSequence: 1, MatchedSourceSequence: &matched, Operation: OperationCheckpointCommit, Observation: &prepared.Envelope.Observation}
	resume := testEnvelope(t, 2, OperationResumeAdvance, 3, 1, 0)
	resultHash := repeatHash("9")
	resultHashCopy := resultHash
	cacheKeyHash := repeatHash("8")
	cacheKeyHashCopy := cacheKeyHash
	first.Observation.Checkpoint.ResultHash = &resultHash
	first.Observation.Checkpoint.CacheKeyHash = &cacheKeyHash
	rehash(t, &first)
	head.Observation = &first.Observation
	resume.Observation.PriorCheckpoint.ResultHash = &resultHashCopy
	resume.Observation.PriorCheckpoint.CacheKeyHash = &cacheKeyHashCopy
	rehash(t, &resume)
	if parity, code := Compare(resume, head); parity != "matched" || code != "" {
		t.Fatalf("resume parity=%s code=%s", parity, code)
	}
	resume.Observation.Runner.FencingToken = 1
	rehash(t, &resume)
	if parity, code := Compare(resume, head); parity != "mismatched" || code != "stale_resume_fence" {
		t.Fatalf("stale parity=%s code=%s", parity, code)
	}
}

func TestCompareCheckpointDifferentialMatrix(t *testing.T) {
	first := testEnvelope(t, 1, OperationCheckpointCommit, 2, 0, 0)
	matched := int64(1)
	head := &Head{SourceSequence: 1, MatchedSourceSequence: &matched, Operation: OperationCheckpointCommit, Observation: &first.Observation}

	gap := testEnvelope(t, 3, OperationCheckpointCommit, 4, 0, 1)
	if parity, code := Compare(gap, head); parity != "mismatched" || code != "source_sequence_mismatch" {
		t.Fatalf("gap parity=%s code=%s", parity, code)
	}

	for name, mutate := range map[string]func(*Envelope){
		"workflow": func(value *Envelope) { value.Observation.WorkflowSourceHash = repeatHash("1") },
		"manifest": func(value *Envelope) { value.Observation.ManifestHash = repeatHash("2") },
		"input":    func(value *Envelope) { value.Observation.InputHash = repeatHash("3") },
	} {
		t.Run(name+" drift", func(t *testing.T) {
			value := testEnvelope(t, 2, OperationCheckpointCommit, 3, 0, 1)
			mutate(&value)
			rehash(t, &value)
			if parity, code := Compare(value, head); parity != "mismatched" || code != "checkpoint_head_drift" {
				t.Fatalf("parity=%s code=%s", parity, code)
			}
		})
	}

	resume := testEnvelope(t, 2, OperationResumeAdvance, 3, 1, 0)
	if parity, code := Compare(resume, head); parity != "matched" || code != "" {
		t.Fatalf("first resume parity=%s code=%s", parity, code)
	}
	resumeMatched := int64(2)
	resumeHead := &Head{SourceSequence: 2, MatchedSourceSequence: &resumeMatched, Operation: OperationResumeAdvance, Observation: &resume.Observation}
	repeated := testEnvelope(t, 3, OperationResumeAdvance, 4, 2, 0)
	prior := *resume.Observation.PriorCheckpoint
	repeated.Observation.PriorCheckpoint = &prior
	nextID, nextIndex := *resume.Observation.NextPhaseID, *resume.Observation.NextPhaseIndex
	repeated.Observation.NextPhaseID, repeated.Observation.NextPhaseIndex = &nextID, &nextIndex
	repeated.Observation.Runner.AttemptID = "attempt-2"
	repeated.Observation.Runner.LeaseID = "lease-2"
	repeated.Observation.Runner.FencingToken = 3
	rehash(t, &repeated)
	if parity, code := Compare(repeated, resumeHead); parity != "matched" || code != "" {
		t.Fatalf("repeated resume parity=%s code=%s", parity, code)
	}
	repeated.Observation.Runner.FencingToken = 2
	rehash(t, &repeated)
	if parity, code := Compare(repeated, resumeHead); parity != "mismatched" || code != "stale_resume_fence" {
		t.Fatalf("stale repeated resume parity=%s code=%s", parity, code)
	}

	latched := *head
	latched.MismatchLatched = true
	if parity, code := Compare(testEnvelope(t, 2, OperationCheckpointCommit, 3, 0, 1), &latched); parity != "mismatched" || code != "prior_mismatch_latched" {
		t.Fatalf("latched parity=%s code=%s", parity, code)
	}
}

func TestSourceSequenceSafeBoundary(t *testing.T) {
	value := testEnvelope(t, MaxSourceSequence, OperationCheckpointCommit, MaxSafeInteger, 0, 0)
	body, err := canonicaljson.Encode(value)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := PrepareObservation(body); err != nil {
		t.Fatalf("max source sequence: %v", err)
	}
	value.SourceSequence = MaxSourceSequence + 1
	rehash(t, &value)
	body, err = canonicaljson.Encode(value)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := PrepareObservation(body); !IsCode(err, ErrorInputInvalid) {
		t.Fatalf("unsafe source error=%v", err)
	}
}

func TestPrepareObservationRejectsNonCanonicalAndUnsafeIntegers(t *testing.T) {
	value := testEnvelope(t, 1, OperationCheckpointCommit, 2, 0, 0)
	body, err := canonicaljson.Encode(value)
	if err != nil {
		t.Fatal(err)
	}
	body = append(body, '\n')
	if _, err := PrepareObservation(body); !IsCode(err, ErrorContentInvalid) {
		t.Fatalf("noncanonical error=%v", err)
	}
	value.SourceSequence = MaxSafeInteger + 1
	body, err = canonicaljson.Encode(value)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := PrepareObservation(body); !IsCode(err, ErrorInputInvalid) {
		t.Fatalf("unsafe integer error=%v", err)
	}
}

func TestPhaseIdentifiersAreDerivedFromIndexes(t *testing.T) {
	value := testEnvelope(t, 1, OperationCheckpointCommit, 2, 0, 0)
	value.Observation.Checkpoint.PhaseID = "display-title"
	rehash(t, &value)
	body, err := canonicaljson.Encode(value)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := PrepareObservation(body); !IsCode(err, ErrorInputInvalid) {
		t.Fatalf("checkpoint phase error=%v", err)
	}
	resume := testEnvelope(t, 2, OperationResumeAdvance, 3, 1, 0)
	wrong := "display-title"
	resume.Observation.NextPhaseID = &wrong
	rehash(t, &resume)
	body, err = canonicaljson.Encode(resume)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := PrepareObservation(body); !IsCode(err, ErrorInputInvalid) {
		t.Fatalf("resume phase error=%v", err)
	}
}

func testEnvelope(t *testing.T, sequence int64, operation Operation, revision, generation, phase int64) Envelope {
	t.Helper()
	checkpoint := &Checkpoint{CheckpointID: "checkpoint-0", PhaseID: phaseID(phase), PhaseIndex: phase, CommitPoint: "after_phase_work", ArtifactRef: "artifacts/checkpoint-0.json", ArtifactHash: repeatHash("a"), CommittedRevision: revision, ResumeGeneration: generation, CommittedAt: "2026-08-12T00:00:00.000Z"}
	observation := Observation{Schema: ObservationSchema, Authority: "typescript", GoRole: "observer_only", RunID: "run-test", Revision: revision, ResumeGeneration: generation, WorkflowSourceHash: repeatHash("b"), ManifestHash: repeatHash("c"), InputHash: repeatHash("d"), Runner: RunnerBinding{WorkspaceID: "workspace-test", JobID: "job-test", AttemptID: "attempt-0", LeaseID: "lease-0", FencingToken: 1, CorrelationID: "correlation-test", RunnerBuildHash: repeatHash("e")}}
	if operation == OperationCheckpointCommit {
		observation.Checkpoint = checkpoint
	} else {
		checkpoint.CommittedRevision = revision - 1
		checkpoint.ResumeGeneration = generation - 1
		nextID := "phase-1"
		nextIndex := phase + 1
		observation.PriorCheckpoint = checkpoint
		observation.NextPhaseID = &nextID
		observation.NextPhaseIndex = &nextIndex
		observation.Runner.AttemptID = "attempt-1"
		observation.Runner.LeaseID = "lease-1"
		observation.Runner.FencingToken = 2
	}
	result := Envelope{Schema: EnvelopeSchema, GoRole: "observer_only", SourceSequence: sequence, Operation: operation, Observation: observation}
	rehash(t, &result)
	return result
}
func rehash(t *testing.T, value *Envelope) {
	t.Helper()
	body, err := canonicaljson.Encode(value.Observation)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(body)
	value.ObservationHash = hex.EncodeToString(digest[:])
}
func repeatHash(value string) string {
	result := ""
	for len(result) < 64 {
		result += value
	}
	return result
}
