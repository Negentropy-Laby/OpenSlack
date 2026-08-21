// Package checkpointcontract owns the cross-field semantics shared by the
// checkpoint shadow and adjacent runner authority binding contracts.
package checkpointcontract

import "fmt"

const (
	MaxSafeInteger    = int64(9007199254740991)
	MaxSourceSequence = MaxSafeInteger - 1
)

type Checkpoint struct {
	PhaseID           string
	PhaseIndex        int64
	CommittedRevision int64
	ResumeGeneration  int64
}

type Observation struct {
	Revision         int64
	ResumeGeneration int64
	Checkpoint       *Checkpoint
	PriorCheckpoint  *Checkpoint
	NextPhaseID      *string
	NextPhaseIndex   *int64
}

type Envelope struct {
	SourceSequence int64
	Operation      string
	Observation    Observation
}

// Error is deliberately independent of either consumer's public error codes.
// Consumers preserve their existing error surfaces while sharing one semantic
// decision and one precise contract path.
type Error struct {
	Path    string
	Message string
}

func (e *Error) Error() string { return e.Message }

func ValidateEnvelope(value Envelope, path string) error {
	if value.SourceSequence < 1 || value.SourceSequence > MaxSourceSequence || value.Observation.Revision != value.SourceSequence+1 {
		return &Error{Path: path + "/sourceSequence", Message: "Envelope sequence does not match observation revision."}
	}

	observationPath := path + "/observation"
	observation := value.Observation
	if observation.Checkpoint != nil {
		if err := ValidateCheckpoint(*observation.Checkpoint, observationPath+"/checkpoint"); err != nil {
			return err
		}
	}
	if observation.PriorCheckpoint != nil {
		if err := ValidateCheckpoint(*observation.PriorCheckpoint, observationPath+"/priorCheckpoint"); err != nil {
			return err
		}
	}
	if observation.NextPhaseID != nil && observation.NextPhaseIndex != nil && *observation.NextPhaseID != phaseID(*observation.NextPhaseIndex) {
		return &Error{Path: observationPath + "/nextPhaseId", Message: "Resume phase identity is invalid."}
	}

	switch value.Operation {
	case "checkpoint_commit":
		checkpoint := observation.Checkpoint
		valid := checkpoint != nil && observation.PriorCheckpoint == nil && observation.NextPhaseID == nil && observation.NextPhaseIndex == nil &&
			checkpoint.CommittedRevision == observation.Revision && checkpoint.ResumeGeneration == observation.ResumeGeneration
		if !valid {
			return &Error{Path: observationPath + "/checkpoint", Message: "Observation variant is invalid."}
		}
	case "resume_advance":
		if observation.Checkpoint != nil || observation.NextPhaseID == nil || observation.NextPhaseIndex == nil {
			return &Error{Path: observationPath + "/checkpoint", Message: "Observation variant is invalid."}
		}
		initialResume := observation.PriorCheckpoint == nil && *observation.NextPhaseID == "phase-0" && *observation.NextPhaseIndex == 0 && observation.Revision > 1 && observation.ResumeGeneration > 0
		checkpointResume := observation.PriorCheckpoint != nil &&
			*observation.NextPhaseIndex == observation.PriorCheckpoint.PhaseIndex+1 &&
			observation.Revision > observation.PriorCheckpoint.CommittedRevision &&
			observation.ResumeGeneration > observation.PriorCheckpoint.ResumeGeneration
		if !initialResume && !checkpointResume {
			return &Error{Path: observationPath + "/checkpoint", Message: "Observation variant is invalid."}
		}
	default:
		return &Error{Path: path + "/operation", Message: "Envelope operation does not match observation variant."}
	}
	return nil
}

func ValidateCheckpoint(value Checkpoint, path string) error {
	if value.PhaseID != phaseID(value.PhaseIndex) {
		return &Error{Path: path + "/phaseId", Message: "Checkpoint phase identity is invalid."}
	}
	return nil
}

func phaseID(index int64) string { return fmt.Sprintf("phase-%d", index) }
