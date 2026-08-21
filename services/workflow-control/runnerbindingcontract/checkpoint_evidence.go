package runnerbindingcontract

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/checkpointcontract"
)

func validateCheckpointEvidence(value any, operation Operation, path string) (Record, error) {
	record, err := closedRecord(value, []string{"schema", "sourceAuthority", "envelope", "envelopeHash"}, path)
	if err != nil {
		return nil, err
	}
	envelope, err := validateCheckpointEnvelopeForBinding(record["envelope"], path+"/envelope")
	if err != nil {
		return nil, err
	}
	envelopeHash, err := hashValue(record["envelopeHash"], path+"/envelopeHash")
	if err != nil {
		return nil, err
	}
	calculatedEnvelopeHash, err := canonicalHash(envelope)
	if err != nil {
		return nil, err
	}
	if envelope["operation"] != "checkpoint_commit" || calculatedEnvelopeHash != envelopeHash {
		return nil, failure(ErrorHashMismatch, path+"/envelopeHash", "Checkpoint envelope binding drifted.")
	}
	source, err := validateSourceAuthority(record["sourceAuthority"], operation, path+"/sourceAuthority")
	if err != nil {
		return nil, err
	}
	observation := envelope["observation"].(Record)
	if !nullableIntEquals(source["acceptedRevision"], observation["revision"].(int64)) ||
		source["acceptedResumeGeneration"] != observation["resumeGeneration"] ||
		source["requestHash"] != envelopeHash || source["recordHash"] != envelope["observationHash"] {
		return nil, failure(ErrorAuthorityPlaneMismatch, path, "Checkpoint source receipt does not bind the exact envelope.")
	}
	schema, err := literalString(record["schema"], "openslack.workflow_runner_checkpoint_authority_evidence.v1", path+"/schema")
	if err != nil {
		return nil, err
	}
	return Record{"schema": schema, "sourceAuthority": source, "envelope": envelope, "envelopeHash": envelopeHash}, nil
}

func validateResumeEvidence(value any, operation Operation, path string) (Record, error) {
	record, err := closedRecord(value, []string{
		"schema", "sourceAuthority", "envelope", "envelopeHash", "priorCheckpointId", "priorCheckpointHash",
		"nextPhaseId", "nextPhaseIndex", "logicalResumeAttemptId", "expiresAt",
	}, path)
	if err != nil {
		return nil, err
	}
	source, err := validateSourceAuthority(record["sourceAuthority"], operation, path+"/sourceAuthority")
	if err != nil {
		return nil, err
	}
	envelope, err := validateCheckpointEnvelopeForBinding(record["envelope"], path+"/envelope")
	if err != nil {
		return nil, err
	}
	envelopeHash, err := hashValue(record["envelopeHash"], path+"/envelopeHash")
	if err != nil {
		return nil, err
	}
	priorCheckpointID, err := nullableText(record["priorCheckpointId"], path+"/priorCheckpointId", identifier)
	if err != nil {
		return nil, err
	}
	priorCheckpointHash, err := nullableText(record["priorCheckpointHash"], path+"/priorCheckpointHash", hashValue)
	if err != nil {
		return nil, err
	}
	observation := envelope["observation"].(Record)
	var observedPriorID any
	var observedPriorHash any
	if prior, ok := observation["priorCheckpoint"].(Record); ok {
		observedPriorID = prior["checkpointId"]
		calculated, hashErr := canonicalHash(prior)
		if hashErr != nil {
			return nil, hashErr
		}
		observedPriorHash = calculated
	}
	calculatedEnvelopeHash, err := canonicalHash(envelope)
	if err != nil {
		return nil, err
	}
	if envelope["operation"] != "resume_advance" || calculatedEnvelopeHash != envelopeHash ||
		observation["nextPhaseId"] != record["nextPhaseId"] || !sameCanonical(observation["nextPhaseIndex"], record["nextPhaseIndex"]) ||
		observedPriorID != nullableStringValue(priorCheckpointID) || observedPriorHash != nullableStringValue(priorCheckpointHash) ||
		source["requestHash"] != envelopeHash || !nullableIntEquals(source["acceptedRevision"], observation["revision"].(int64)) ||
		source["acceptedResumeGeneration"] != observation["resumeGeneration"] || source["recordHash"] != envelope["observationHash"] {
		return nil, failure(ErrorAuthorityPlaneMismatch, path, "Resume evidence differs from the exact checkpoint head transition.")
	}
	result := Record{
		"sourceAuthority":     source,
		"envelope":            envelope,
		"envelopeHash":        envelopeHash,
		"priorCheckpointId":   nullableStringValue(priorCheckpointID),
		"priorCheckpointHash": nullableStringValue(priorCheckpointHash),
	}
	if result["schema"], err = literalString(record["schema"], "openslack.workflow_runner_resume_authority_evidence.v1", path+"/schema"); err != nil {
		return nil, err
	}
	if result["nextPhaseId"], err = identifier(record["nextPhaseId"], path+"/nextPhaseId"); err != nil {
		return nil, err
	}
	if result["nextPhaseIndex"], err = integerValue(record["nextPhaseIndex"], path+"/nextPhaseIndex", 0); err != nil {
		return nil, err
	}
	if result["logicalResumeAttemptId"], err = identifier(record["logicalResumeAttemptId"], path+"/logicalResumeAttemptId"); err != nil {
		return nil, err
	}
	if result["expiresAt"], err = timestampValue(record["expiresAt"], path+"/expiresAt"); err != nil {
		return nil, err
	}
	return result, nil
}

func validateCheckpointEnvelopeForBinding(value any, path string) (Record, error) {
	envelope, err := validateCheckpointEnvelope(value, path)
	if err == nil {
		return envelope, nil
	}
	var contractErr *ContractError
	if errors.As(err, &contractErr) {
		nestedPath := contractErr.Path
		observationPath := path + "/observation"
		if strings.HasPrefix(nestedPath, observationPath+"/") {
			nestedPath = path + strings.TrimPrefix(nestedPath, observationPath)
		}
		if contractErr.Code == ErrorUnknownField && strings.HasPrefix(nestedPath, path+"/") {
			if separator := strings.LastIndex(nestedPath, "/"); separator >= len(path) {
				nestedPath = nestedPath[:separator]
			}
		}
		return nil, failure(ErrorInvalid, nestedPath, "Embedded checkpoint evidence is invalid.")
	}
	return nil, err
}

func validateCheckpointEnvelope(value any, path string) (Record, error) {
	record, err := closedRecord(value, []string{"schema", "goRole", "sourceSequence", "operation", "observation", "observationHash"}, path)
	if err != nil {
		return nil, err
	}
	schema, err := literalString(record["schema"], "openslack.workflow_checkpoint_shadow_envelope.v1", path+"/schema")
	if err != nil {
		return nil, err
	}
	goRole, err := literalString(record["goRole"], "observer_only", path+"/goRole")
	if err != nil {
		return nil, err
	}
	operation, err := enumString(record["operation"], []string{"checkpoint_commit", "resume_advance"}, path+"/operation")
	if err != nil {
		return nil, err
	}
	observation, err := validateCheckpointObservation(record["observation"], path+"/observation")
	if err != nil {
		return nil, err
	}
	sourceSequence, err := integerValue(record["sourceSequence"], path+"/sourceSequence", 1)
	if err != nil {
		return nil, err
	}
	if err := checkpointcontract.ValidateEnvelope(checkpointSemanticEnvelope(sourceSequence, operation, observation), path); err != nil {
		var semanticErr *checkpointcontract.Error
		if errors.As(err, &semanticErr) {
			return nil, failure(ErrorInvalid, semanticErr.Path, semanticErr.Message)
		}
		return nil, err
	}
	observationHash, err := hashValue(record["observationHash"], path+"/observationHash")
	if err != nil {
		return nil, err
	}
	calculated, err := canonicalHash(observation)
	if err != nil {
		return nil, err
	}
	if calculated != observationHash {
		return nil, failure(ErrorHashMismatch, path+"/observationHash", "Observation hash is mismatched.")
	}
	return Record{
		"schema":          schema,
		"goRole":          goRole,
		"sourceSequence":  sourceSequence,
		"operation":       operation,
		"observation":     observation,
		"observationHash": observationHash,
	}, nil
}

func validateCheckpointObservation(value any, path string) (Record, error) {
	record, err := closedRecord(value, []string{
		"schema", "authority", "goRole", "runId", "revision", "resumeGeneration", "workflowSourceHash", "manifestHash",
		"inputHash", "runner", "checkpoint", "priorCheckpoint", "nextPhaseId", "nextPhaseIndex",
	}, path)
	if err != nil {
		return nil, err
	}
	result := Record{}
	for _, field := range []struct {
		name     string
		expected string
	}{
		{"schema", "openslack.workflow_checkpoint_shadow_observation.v1"},
		{"authority", "typescript"},
		{"goRole", "observer_only"},
	} {
		result[field.name], err = literalString(record[field.name], field.expected, path+"/"+field.name)
		if err != nil {
			return nil, err
		}
	}
	if result["runId"], err = identifier(record["runId"], path+"/runId"); err != nil {
		return nil, err
	}
	if result["revision"], err = integerValue(record["revision"], path+"/revision", 1); err != nil {
		return nil, err
	}
	if result["resumeGeneration"], err = integerValue(record["resumeGeneration"], path+"/resumeGeneration", 0); err != nil {
		return nil, err
	}
	checkpoint, err := nullableCheckpoint(record["checkpoint"], path+"/checkpoint")
	if err != nil {
		return nil, err
	}
	prior, err := nullableCheckpoint(record["priorCheckpoint"], path+"/priorCheckpoint")
	if err != nil {
		return nil, err
	}
	nextPhaseID, err := nullableText(record["nextPhaseId"], path+"/nextPhaseId", identifier)
	if err != nil {
		return nil, err
	}
	nextPhaseIndex, err := nullableInteger(record["nextPhaseIndex"], path+"/nextPhaseIndex", 0)
	if err != nil {
		return nil, err
	}
	result["checkpoint"] = nullableRecordValue(checkpoint)
	result["priorCheckpoint"] = nullableRecordValue(prior)
	result["nextPhaseId"] = nullableStringValue(nextPhaseID)
	result["nextPhaseIndex"] = nullableIntegerValue(nextPhaseIndex)
	for _, field := range []string{"workflowSourceHash", "manifestHash", "inputHash"} {
		if result[field], err = hashValue(record[field], path+"/"+field); err != nil {
			return nil, err
		}
	}
	runner, err := validateCheckpointRunner(record["runner"], path+"/runner")
	if err != nil {
		return nil, err
	}
	result["runner"] = runner
	return result, nil
}

func validateCheckpointRunner(value any, path string) (Record, error) {
	record, err := closedRecord(value, []string{"workspaceId", "jobId", "attemptId", "leaseId", "fencingToken", "correlationId", "runnerBuildHash"}, path)
	if err != nil {
		return nil, err
	}
	result := Record{}
	for _, field := range []string{"workspaceId", "jobId", "attemptId", "leaseId", "correlationId"} {
		if result[field], err = identifier(record[field], path+"/"+field); err != nil {
			return nil, err
		}
	}
	if result["fencingToken"], err = integerValue(record["fencingToken"], path+"/fencingToken", 1); err != nil {
		return nil, err
	}
	if result["runnerBuildHash"], err = hashValue(record["runnerBuildHash"], path+"/runnerBuildHash"); err != nil {
		return nil, err
	}
	return result, nil
}

func nullableCheckpoint(value any, path string) (Record, error) {
	if value == nil {
		return nil, nil
	}
	return validateCheckpoint(value, path)
}

func validateCheckpoint(value any, path string) (Record, error) {
	record, err := closedRecord(value, []string{
		"checkpointId", "phaseId", "phaseIndex", "commitPoint", "artifactRef", "artifactHash", "resultHash", "cacheKeyHash",
		"committedRevision", "resumeGeneration", "committedAt",
	}, path)
	if err != nil {
		return nil, err
	}
	phaseID, err := identifier(record["phaseId"], path+"/phaseId")
	if err != nil {
		return nil, err
	}
	phaseIndex, err := integerValue(record["phaseIndex"], path+"/phaseIndex", 0)
	if err != nil {
		return nil, err
	}
	resultHash, err := nullableText(record["resultHash"], path+"/resultHash", hashValue)
	if err != nil {
		return nil, err
	}
	cacheKeyHash, err := nullableText(record["cacheKeyHash"], path+"/cacheKeyHash", hashValue)
	if err != nil {
		return nil, err
	}
	result := Record{
		"phaseId":      phaseID,
		"phaseIndex":   phaseIndex,
		"resultHash":   nullableStringValue(resultHash),
		"cacheKeyHash": nullableStringValue(cacheKeyHash),
	}
	if result["checkpointId"], err = identifier(record["checkpointId"], path+"/checkpointId"); err != nil {
		return nil, err
	}
	if result["commitPoint"], err = literalString(record["commitPoint"], "after_phase_work", path+"/commitPoint"); err != nil {
		return nil, err
	}
	if result["artifactRef"], err = reference(record["artifactRef"], path+"/artifactRef"); err != nil {
		return nil, err
	}
	if result["artifactHash"], err = hashValue(record["artifactHash"], path+"/artifactHash"); err != nil {
		return nil, err
	}
	if result["committedRevision"], err = integerValue(record["committedRevision"], path+"/committedRevision", 1); err != nil {
		return nil, err
	}
	if result["resumeGeneration"], err = integerValue(record["resumeGeneration"], path+"/resumeGeneration", 0); err != nil {
		return nil, err
	}
	if result["committedAt"], err = timestampValue(record["committedAt"], path+"/committedAt"); err != nil {
		return nil, err
	}
	return result, nil
}

func checkpointSemanticEnvelope(sourceSequence int64, operation string, observation Record) checkpointcontract.Envelope {
	return checkpointcontract.Envelope{
		SourceSequence: sourceSequence,
		Operation:      operation,
		Observation: checkpointcontract.Observation{
			Revision:         observation["revision"].(int64),
			ResumeGeneration: observation["resumeGeneration"].(int64),
			Checkpoint:       checkpointSemanticValue(observation["checkpoint"]),
			PriorCheckpoint:  checkpointSemanticValue(observation["priorCheckpoint"]),
			NextPhaseID:      nullableStringPointer(observation["nextPhaseId"]),
			NextPhaseIndex:   nullableIntPointer(observation["nextPhaseIndex"]),
		},
	}
}

func checkpointSemanticValue(value any) *checkpointcontract.Checkpoint {
	record, ok := value.(Record)
	if !ok {
		return nil
	}
	return &checkpointcontract.Checkpoint{
		PhaseID:           record["phaseId"].(string),
		PhaseIndex:        record["phaseIndex"].(int64),
		CommittedRevision: record["committedRevision"].(int64),
		ResumeGeneration:  record["resumeGeneration"].(int64),
	}
}

func nullableStringPointer(value any) *string {
	text, ok := value.(string)
	if !ok {
		return nil
	}
	return &text
}

func nullableIntPointer(value any) *int64 {
	integer, ok := value.(int64)
	if !ok {
		return nil
	}
	return &integer
}

func canonicalHash(value any) (string, error) {
	canonical, err := canonicalJSON(value)
	if err != nil {
		return "", failure(ErrorInvalid, "$", err.Error())
	}
	digest := sha256.Sum256(canonical)
	return hex.EncodeToString(digest[:]), nil
}

func nullableRecordValue(value Record) any {
	if value == nil {
		return nil
	}
	return value
}

func nullableIntEquals(value any, expected int64) bool {
	integer, ok := value.(int64)
	return ok && integer == expected
}
