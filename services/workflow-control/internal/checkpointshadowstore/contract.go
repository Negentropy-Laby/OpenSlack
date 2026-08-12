package checkpointshadowstore

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"reflect"
	"regexp"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/canonicaljson"
)

var safeID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$`)
var safeRef = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$`)
var hash64 = regexp.MustCompile(`^[0-9a-f]{64}$`)

func PrepareObservation(body []byte) (PreparedObservation, error) {
	if len(body) < 1 || len(body) > MaxRequestBytes {
		return PreparedObservation{}, Failure(ErrorContentInvalid, "checkpoint envelope size is invalid", nil)
	}
	if err := rejectDuplicateKeys(body); err != nil {
		return PreparedObservation{}, Failure(ErrorContentInvalid, "checkpoint envelope framing is invalid", err)
	}
	var envelope Envelope
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&envelope); err != nil {
		return PreparedObservation{}, Failure(ErrorContentInvalid, "decode checkpoint envelope", err)
	}
	if err := requireEOF(decoder); err != nil {
		return PreparedObservation{}, Failure(ErrorContentInvalid, "checkpoint envelope contains trailing data", err)
	}
	if err := validateEnvelope(envelope); err != nil {
		return PreparedObservation{}, err
	}
	canonical, err := canonicaljson.Encode(envelope)
	if err != nil {
		return PreparedObservation{}, Failure(ErrorContentInvalid, "canonicalize checkpoint envelope", err)
	}
	if !bytes.Equal(canonical, body) {
		return PreparedObservation{}, Failure(ErrorContentInvalid, "checkpoint envelope is not exact canonical JSON", nil)
	}
	observationBytes, err := canonicaljson.Encode(envelope.Observation)
	if err != nil {
		return PreparedObservation{}, Failure(ErrorContentInvalid, "canonicalize checkpoint observation", err)
	}
	observationDigest := sha256.Sum256(observationBytes)
	if envelope.ObservationHash != hex.EncodeToString(observationDigest[:]) {
		return PreparedObservation{}, Failure(ErrorContentInvalid, "checkpoint observation hash is mismatched", nil)
	}
	envelopeDigest := sha256.Sum256(body)
	return PreparedObservation{Envelope: envelope, ExactBody: append([]byte(nil), body...), EnvelopeHash: hex.EncodeToString(envelopeDigest[:]), ObservationBytes: observationBytes}, nil
}

func validateEnvelope(value Envelope) error {
	if value.Schema != EnvelopeSchema || value.GoRole != "observer_only" || value.SourceSequence < 1 || value.SourceSequence > MaxSourceSequence || value.Observation.Revision != value.SourceSequence+1 {
		return Failure(ErrorInputInvalid, "checkpoint envelope identity is invalid", nil)
	}
	if value.Operation != OperationCheckpointCommit && value.Operation != OperationResumeAdvance {
		return Failure(ErrorInputInvalid, "checkpoint operation is invalid", nil)
	}
	o := value.Observation
	if o.Schema != ObservationSchema || o.Authority != "typescript" || o.GoRole != "observer_only" || !safeID.MatchString(o.RunID) || o.Revision < 1 || o.Revision > MaxSafeInteger || o.ResumeGeneration < 0 || o.ResumeGeneration > MaxSafeInteger {
		return Failure(ErrorInputInvalid, "checkpoint observation identity is invalid", nil)
	}
	if !hash64.MatchString(o.WorkflowSourceHash) || !hash64.MatchString(o.ManifestHash) || !hash64.MatchString(o.InputHash) {
		return Failure(ErrorInputInvalid, "checkpoint observation digest is invalid", nil)
	}
	r := o.Runner
	if !safeID.MatchString(r.WorkspaceID) || !safeID.MatchString(r.JobID) || !safeID.MatchString(r.AttemptID) || !safeID.MatchString(r.LeaseID) || !safeID.MatchString(r.CorrelationID) || r.FencingToken < 1 || r.FencingToken > MaxSafeInteger || !hash64.MatchString(r.RunnerBuildHash) {
		return Failure(ErrorInputInvalid, "checkpoint runner binding is invalid", nil)
	}
	if value.Operation == OperationCheckpointCommit {
		if o.Checkpoint == nil || o.PriorCheckpoint != nil || o.NextPhaseID != nil || o.NextPhaseIndex != nil || o.Checkpoint.CommittedRevision != o.Revision || o.Checkpoint.ResumeGeneration != o.ResumeGeneration {
			return Failure(ErrorInputInvalid, "checkpoint commit variant is invalid", nil)
		}
		if err := validateCheckpoint(*o.Checkpoint); err != nil {
			return err
		}
	} else {
		if o.Checkpoint != nil || o.NextPhaseID == nil || o.NextPhaseIndex == nil || !safeID.MatchString(*o.NextPhaseID) || *o.NextPhaseID != phaseID(*o.NextPhaseIndex) || *o.NextPhaseIndex < 0 || *o.NextPhaseIndex > MaxSafeInteger {
			return Failure(ErrorInputInvalid, "resume advance variant is invalid", nil)
		}
		if o.PriorCheckpoint == nil {
			if *o.NextPhaseIndex != 0 || o.Revision <= 1 || o.ResumeGeneration <= 0 {
				return Failure(ErrorInputInvalid, "resume advance variant is invalid", nil)
			}
		} else {
			if *o.NextPhaseIndex != o.PriorCheckpoint.PhaseIndex+1 || o.Revision <= o.PriorCheckpoint.CommittedRevision || o.ResumeGeneration <= o.PriorCheckpoint.ResumeGeneration {
				return Failure(ErrorInputInvalid, "resume advance variant is invalid", nil)
			}
			if err := validateCheckpoint(*o.PriorCheckpoint); err != nil {
				return err
			}
		}
	}
	if !hash64.MatchString(value.ObservationHash) {
		return Failure(ErrorInputInvalid, "checkpoint observation hash is invalid", nil)
	}
	return nil
}

func validateCheckpoint(c Checkpoint) error {
	if !safeID.MatchString(c.CheckpointID) || !safeID.MatchString(c.PhaseID) || c.PhaseIndex < 0 || c.PhaseIndex > MaxSafeInteger || c.PhaseID != phaseID(c.PhaseIndex) || c.CommitPoint != "after_phase_work" || !safeRef.MatchString(c.ArtifactRef) || !hash64.MatchString(c.ArtifactHash) || !nullableHash(c.ResultHash) || !nullableHash(c.CacheKeyHash) || c.CommittedRevision < 1 || c.CommittedRevision > MaxSafeInteger || c.ResumeGeneration < 0 || c.ResumeGeneration > MaxSafeInteger {
		return Failure(ErrorInputInvalid, "checkpoint record is invalid", nil)
	}
	parsed, err := time.Parse("2006-01-02T15:04:05.000Z", c.CommittedAt)
	if err != nil || parsed.Format("2006-01-02T15:04:05.000Z") != c.CommittedAt {
		return Failure(ErrorInputInvalid, "checkpoint committedAt is not canonical UTC", err)
	}
	return nil
}

func phaseID(index int64) string { return fmt.Sprintf("phase-%d", index) }

func nullableHash(value *string) bool { return value == nil || hash64.MatchString(*value) }

func ValidateReceiptValue(value ReceiptValue) error {
	if value.Schema != ReceiptSchema || !validIdempotency(value.IdempotencyKey) || !safeID.MatchString(value.ReceiptID) || !safeID.MatchString(value.WorkspaceID) || !safeID.MatchString(value.RunID) || value.SourceSequence < 1 || value.SourceSequence > MaxSourceSequence || (value.Operation != OperationCheckpointCommit && value.Operation != OperationResumeAdvance) || !hash64.MatchString(value.EnvelopeHash) || !hash64.MatchString(value.ObservationHash) || !hash64.MatchString(value.ServiceBuildHash) {
		return Failure(ErrorContentInvalid, "checkpoint receipt identity is invalid", nil)
	}
	accepted := value.Status == "accepted" && (value.Parity == "matched" || value.Parity == "mismatched") && value.ObservationID != nil && safeID.MatchString(*value.ObservationID) && value.CommittedAt != nil && value.ReconciliationToken == nil && ((value.Parity == "matched") == (value.MismatchCode == nil))
	if accepted && value.MismatchCode != nil && !safeID.MatchString(*value.MismatchCode) {
		accepted = false
	}
	if accepted {
		parsed, err := time.Parse("2006-01-02T15:04:05.000Z", *value.CommittedAt)
		accepted = err == nil && parsed.Format("2006-01-02T15:04:05.000Z") == *value.CommittedAt
	}
	reconciliation := value.Status == "reconciliation_required" && value.Parity == "unknown" && value.ObservationID == nil && value.CommittedAt == nil && value.MismatchCode == nil && value.ReconciliationToken != nil && safeID.MatchString(*value.ReconciliationToken)
	if !accepted && !reconciliation {
		return Failure(ErrorContentInvalid, "checkpoint receipt variant is invalid", nil)
	}
	return nil
}

func ValidateStoredObservation(operation Operation, sourceSequence int64, observation Observation, observationHash string) error {
	return validateEnvelope(Envelope{Schema: EnvelopeSchema, GoRole: "observer_only", SourceSequence: sourceSequence, Operation: operation, Observation: observation, ObservationHash: observationHash})
}

func Fingerprint(method, path, key string, body []byte) string {
	digest := sha256.New()
	_, _ = fmt.Fprintf(digest, "%s\n%s\n%s\n", method, path, key)
	_, _ = digest.Write(body)
	return hex.EncodeToString(digest.Sum(nil))
}

// Compare classifies the next TypeScript observation without ever becoming an
// authority. A mismatch advances only the observed source sequence and latches.
func Compare(next Envelope, previous *Head) (string, string) {
	if previous != nil && previous.MismatchLatched {
		return "mismatched", "prior_mismatch_latched"
	}
	current := next.Observation
	if previous == nil {
		initialCheckpoint := next.Operation == OperationCheckpointCommit && current.Checkpoint != nil && current.Checkpoint.PhaseIndex == 0 && current.ResumeGeneration == 0
		initialResume := next.Operation == OperationResumeAdvance && current.PriorCheckpoint == nil && current.NextPhaseID != nil && *current.NextPhaseID == phaseID(0) && current.NextPhaseIndex != nil && *current.NextPhaseIndex == 0 && current.ResumeGeneration == 1
		if next.SourceSequence != 1 || (!initialCheckpoint && !initialResume) {
			return "mismatched", "initial_sequence_mismatch"
		}
		return "matched", ""
	}
	if next.SourceSequence != previous.SourceSequence+1 || previous.Observation == nil {
		return "mismatched", "source_sequence_mismatch"
	}
	prior := *previous.Observation
	if current.RunID != prior.RunID || current.Runner.WorkspaceID != prior.Runner.WorkspaceID || current.WorkflowSourceHash != prior.WorkflowSourceHash || current.ManifestHash != prior.ManifestHash || current.InputHash != prior.InputHash || current.Revision != prior.Revision+1 {
		return "mismatched", "checkpoint_head_drift"
	}
	if next.Operation == OperationResumeAdvance {
		if current.NextPhaseID == nil || current.NextPhaseIndex == nil {
			return "mismatched", "resume_binding_missing"
		}
		if current.PriorCheckpoint == nil {
			validPreCheckpointReentry := previous.Operation == OperationResumeAdvance && prior.PriorCheckpoint == nil && prior.NextPhaseID != nil && *prior.NextPhaseID == phaseID(0) && prior.NextPhaseIndex != nil && *prior.NextPhaseIndex == 0 && *current.NextPhaseID == phaseID(0) && *current.NextPhaseIndex == 0
			if !validPreCheckpointReentry || current.ResumeGeneration != prior.ResumeGeneration+1 || current.Runner.AttemptID == prior.Runner.AttemptID || current.Runner.LeaseID == prior.Runner.LeaseID || current.Runner.FencingToken <= prior.Runner.FencingToken {
				return "mismatched", "stale_resume_fence"
			}
			return "matched", ""
		}
		var checkpoint *Checkpoint
		var nextPhaseID string
		var nextPhaseIndex int64
		if previous.Operation == OperationCheckpointCommit && prior.Checkpoint != nil {
			checkpoint = prior.Checkpoint
			nextPhaseIndex = checkpoint.PhaseIndex + 1
			nextPhaseID = phaseID(nextPhaseIndex)
		} else if previous.Operation == OperationResumeAdvance && prior.PriorCheckpoint != nil && prior.NextPhaseID != nil && prior.NextPhaseIndex != nil {
			checkpoint = prior.PriorCheckpoint
			nextPhaseID = *prior.NextPhaseID
			nextPhaseIndex = *prior.NextPhaseIndex
		}
		if checkpoint == nil || !reflect.DeepEqual(*current.PriorCheckpoint, *checkpoint) || *current.NextPhaseID != nextPhaseID || *current.NextPhaseIndex != nextPhaseIndex || current.ResumeGeneration != prior.ResumeGeneration+1 || current.Runner.AttemptID == prior.Runner.AttemptID || current.Runner.LeaseID == prior.Runner.LeaseID || current.Runner.FencingToken <= prior.Runner.FencingToken {
			return "mismatched", "stale_resume_fence"
		}
		return "matched", ""
	}
	if current.Checkpoint == nil || current.ResumeGeneration != prior.ResumeGeneration || current.Runner.JobID != prior.Runner.JobID || current.Runner.AttemptID != prior.Runner.AttemptID || current.Runner.LeaseID != prior.Runner.LeaseID || current.Runner.FencingToken != prior.Runner.FencingToken {
		return "mismatched", "same_generation_binding_drift"
	}
	if previous.Operation == OperationCheckpointCommit {
		if prior.Checkpoint == nil || current.Checkpoint.PhaseIndex != prior.Checkpoint.PhaseIndex+1 {
			return "mismatched", "checkpoint_phase_mismatch"
		}
	} else if prior.NextPhaseID == nil || prior.NextPhaseIndex == nil || current.Checkpoint.PhaseID != *prior.NextPhaseID || current.Checkpoint.PhaseIndex != *prior.NextPhaseIndex {
		return "mismatched", "checkpoint_phase_mismatch"
	}
	return "matched", ""
}

func validIdempotency(value string) bool {
	return len(value) == len(IdempotencyPrefix)+64 && len(value) > 64 && value[:len(IdempotencyPrefix)] == IdempotencyPrefix && hash64.MatchString(value[len(IdempotencyPrefix):])
}

func requireEOF(decoder *json.Decoder) error {
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			return fmt.Errorf("multiple JSON values")
		}
		return err
	}
	return nil
}

func rejectDuplicateKeys(body []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	var parse func(int) error
	parse = func(depth int) error {
		if depth > 64 {
			return fmt.Errorf("JSON depth exceeded")
		}
		token, err := decoder.Token()
		if err != nil {
			return err
		}
		delim, ok := token.(json.Delim)
		if !ok {
			return nil
		}
		switch delim {
		case '{':
			seen := map[string]struct{}{}
			for decoder.More() {
				keyToken, err := decoder.Token()
				if err != nil {
					return err
				}
				key, ok := keyToken.(string)
				if !ok {
					return fmt.Errorf("object key is invalid")
				}
				if _, exists := seen[key]; exists {
					return fmt.Errorf("duplicate key %q", key)
				}
				seen[key] = struct{}{}
				if err := parse(depth + 1); err != nil {
					return err
				}
			}
			_, err = decoder.Token()
			return err
		case '[':
			for decoder.More() {
				if err := parse(depth + 1); err != nil {
					return err
				}
			}
			_, err = decoder.Token()
			return err
		default:
			return fmt.Errorf("unexpected delimiter")
		}
	}
	if err := parse(0); err != nil {
		return err
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		return fmt.Errorf("trailing JSON")
	}
	return nil
}
